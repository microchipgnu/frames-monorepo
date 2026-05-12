// `verify` op — read-only: re-fetch sources and report drift. No frame mutations.
//
// Emits only `tool.invoked` events (bookkeeping for paid re-fetches); no
// entity.created / fact.set / fact.deprecated / etc. The drift report rides
// in the `summary` and `report` fields of OpOutcome.
//
// Loop:
//   1. Load frame schema (validates frame URL resolves)
//   2. Iterate entities (paginated via FrameClient)
//   3. For each (entity, field), re-fetch source.url, compare against value/excerpt
//   4. Classify finding, append to drifts[]
//   5. Halt when remaining budget < safety_floor

import type { FrameEvent, ToolCall } from "@frames-ag/tick-types";
import { FrameClient } from "../frame-client";
import type { Drift, OpOutcome, Refetcher } from "./types";

export interface VerifyOptions {
  frame_url: string;
  budget: string;
  run_id: string;
  agent: string; // "frames-runtime:<wallet>"
  refetcher: Refetcher;
  client?: FrameClient;
  /** Below this remaining budget (USDC), stop scheduling new fetches. Default 0.01. */
  safety_floor?: string;
  /** Hard cap on entities scanned (defense against runaway loops). Default 1000. */
  max_entities?: number;
  /** Skip fields matching this predicate (e.g., timestamps that don't have a source value). */
  skip_field?: (field: string) => boolean;
  /** Optional progressive event callback (SSE response path). */
  onEvent?: (event: FrameEvent) => void;
}

export async function verify(opts: VerifyOptions): Promise<OpOutcome> {
  const client = opts.client ?? new FrameClient();
  const safetyFloor = Number(opts.safety_floor ?? "0.01");
  const maxEntities = opts.max_entities ?? 1000;
  let remaining = Number(opts.budget);

  // Load schema first to validate the frame is reachable + parseable. A bad
  // frame URL should fail fast, before we burn any budget.
  const schema = await client.getSchema(opts.frame_url);
  const meta = await client.getMeta(opts.frame_url);

  const drifts: Drift[] = [];
  const events: FrameEvent[] = [];
  const tool_log: ToolCall[] = [];

  let entitiesScanned = 0;
  let fieldsChecked = 0;
  let halted = false;

  outer: for await (const entity of client.iterateEntities(opts.frame_url, { include: "all" })) {
    if (entitiesScanned >= maxEntities) {
      halted = true;
      break;
    }
    entitiesScanned++;

    for (const [field, value] of Object.entries(entity.fields)) {
      if (opts.skip_field?.(field)) continue;
      if (remaining < safetyFloor) {
        halted = true;
        break outer;
      }
      // Primary source (first in the evidence array, if any).
      const sources = entity.evidence?.[field];
      const primary = sources?.[0];
      if (!primary?.url) continue;

      fieldsChecked++;
      const result = await opts.refetcher({
        url: primary.url,
        remaining_budget: remaining.toFixed(6),
        run_id: opts.run_id,
      });

      if (result.event) {
        events.push(result.event);
        opts.onEvent?.(result.event);
      }
      if (result.tool_call) {
        tool_log.push(result.tool_call);
        remaining -= Number(result.tool_call.cost);
      }

      // Classify
      if (!result.ok) {
        drifts.push({
          entity_id: entity.entity_id,
          field,
          kind: "source_dead",
          url: primary.url,
          current_value: value,
          error: result.error,
        });
        continue;
      }
      if (result.final_url && result.final_url !== primary.url) {
        drifts.push({
          entity_id: entity.entity_id,
          field,
          kind: "source_redirect",
          url: primary.url,
          current_value: value,
          redirect_to: result.final_url,
        });
        // Don't stop checking value — redirect is informational; the destination
        // may still substantiate the claim.
      }
      if (result.body && primary.excerpt) {
        const excerptOk = result.body.includes(primary.excerpt);
        if (!excerptOk) {
          drifts.push({
            entity_id: entity.entity_id,
            field,
            kind: "excerpt_missing",
            url: primary.url,
            current_value: value,
            original_excerpt: primary.excerpt,
          });
        }
      }
      if (result.body && !primary.excerpt && typeof value === "string") {
        // No recorded excerpt — fall back to a weak value-presence check.
        if (!result.body.toLowerCase().includes(String(value).toLowerCase())) {
          drifts.push({
            entity_id: entity.entity_id,
            field,
            kind: "value_drift",
            url: primary.url,
            current_value: value,
          });
        }
      }
    }
  }

  const verified = fieldsChecked - drifts.filter((d) => d.kind !== "verified").length;

  const summary = formatSummary({
    schema_name: schema.name,
    sha: meta.sha,
    entities_scanned: entitiesScanned,
    fields_checked: fieldsChecked,
    drifts_found: drifts.length,
    verified_count: verified,
    halted,
    remaining: remaining.toFixed(6),
  });

  return {
    events,
    tool_log,
    summary,
    report: {
      schema_name: schema.name,
      sha: meta.sha,
      stats: {
        entities_scanned: entitiesScanned,
        fields_checked: fieldsChecked,
        verified_count: verified,
        drift_count: drifts.length,
        budget_remaining: remaining.toFixed(6),
        halted_for_budget: halted,
      },
      drifts,
    },
  };
}

function formatSummary(args: {
  schema_name: string;
  sha: string;
  entities_scanned: number;
  fields_checked: number;
  drifts_found: number;
  verified_count: number;
  halted: boolean;
  remaining: string;
}): string {
  const parts = [
    `verify(${args.schema_name}@${args.sha.slice(0, 7)})`,
    `${args.entities_scanned} entities, ${args.fields_checked} fields checked`,
    `${args.verified_count} verified, ${args.drifts_found} drifts`,
  ];
  if (args.halted) parts.push("halted (budget)");
  parts.push(`$${args.remaining} remaining`);
  return parts.join(" · ");
}
