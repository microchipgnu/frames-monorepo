// `refresh` op — runs verify's classifier, then converts findings into real
// frame mutations:
//
//   source_dead       → emit fact.deprecated { reason: "source returned <error>" }
//   excerpt_missing   → emit fact.deprecated { reason: "excerpt no longer present in source" }
//   value_drift       → emit fact.deprecated { reason: "value no longer substantiated by source" }
//   source_redirect   → emit evidence.attached with the redirected URL (informational; no deprecation)
//   verified          → no event
//
// Deprecation requires the per-field fact_id, surfaced by frames-cloud as of
// 2026-05-11. If a frame is served by an older frames-cloud that doesn't
// expose fact_ids, we record the candidates in `report.skipped_for_missing_fact_id`
// so the caller can act on them out-of-band.
//
// Note: refresh ONLY deprecates and attaches evidence. It does NOT set new
// values. New facts are curate's job.

import { randomUUID } from "node:crypto";
import type {
  FrameEvent,
} from "@frames-ag/tick-types";
import { FrameClient } from "../frame-client";
import type { Drift, OpOutcome } from "./types";
import { verify, type VerifyOptions } from "./verify";

export type RefreshOptions = VerifyOptions;

export interface DeprecationCandidate {
  entity_id: string;
  field: string;
  /** The fact_id of the now-suspect fact, if frames-cloud surfaced it. */
  fact_id: string | null;
  url: string;
  reason: string;
  /** When fact_id is null, the event below is undefined. */
  event?: FrameEvent;
}

export async function refresh(opts: RefreshOptions): Promise<OpOutcome> {
  // Reuse verify's iteration entirely. We re-fetch each (entity, field)'s
  // primary source and classify the result; the outcome is read-only.
  const verifyOutcome = await verify(opts);

  const drifts: Drift[] = (verifyOutcome.report?.drifts as Drift[]) ?? [];

  // We need the entities' fact_ids to emit deprecation events. The verify op
  // didn't capture them, so re-iterate (already cached upstream via ETags) to
  // collect them. This is cheap — no refetches, just a paginated GET against
  // frames-cloud which returns cached SHA-pinned projections.
  const client = opts.client ?? new FrameClient();
  const factIdMap = await collectFactIds(client, opts.frame_url);

  const events: FrameEvent[] = [...verifyOutcome.events];
  const candidates: DeprecationCandidate[] = [];
  const skippedForMissingFactId: DeprecationCandidate[] = [];

  let deprecatedCount = 0;
  let redirectsAttached = 0;

  for (const drift of drifts) {
    if (drift.kind === "verified") continue;

    const key = `${drift.entity_id}::${drift.field}`;
    const fact_id = factIdMap.get(key) ?? null;
    const reason = deprecationReason(drift);

    if (drift.kind === "source_redirect" && fact_id) {
      // Informational: attach the redirected URL as additional evidence.
      // Doesn't deprecate the original; the destination may still substantiate
      // the claim. Customer can manually deprecate later if review disagrees.
      const event: FrameEvent = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: "evidence.attached",
        agent: opts.agent,
        run_id: opts.run_id,
        payload: {
          fact_id,
          source: {
            url: drift.redirect_to ?? drift.url,
            retrieved_at: new Date().toISOString(),
            title: "Redirected destination (auto-attached by refresh)",
          },
        },
      };
      events.push(event);
      opts.onEvent?.(event);
      redirectsAttached++;
      candidates.push({ entity_id: drift.entity_id, field: drift.field, fact_id, url: drift.url, reason, event });
      continue;
    }

    // Otherwise it's a deprecation candidate.
    if (!fact_id) {
      skippedForMissingFactId.push({
        entity_id: drift.entity_id,
        field: drift.field,
        fact_id: null,
        url: drift.url,
        reason,
      });
      continue;
    }

    const event: FrameEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: "fact.deprecated",
      agent: opts.agent,
      run_id: opts.run_id,
      payload: { fact_id, reason },
    };
    events.push(event);
    opts.onEvent?.(event);
    deprecatedCount++;
    candidates.push({ entity_id: drift.entity_id, field: drift.field, fact_id, url: drift.url, reason, event });
  }

  const summary = `refresh · ${verifyOutcome.summary.replace(/^verify · /, "")} · ${deprecatedCount} deprecated, ${redirectsAttached} redirects attached${skippedForMissingFactId.length ? `, ${skippedForMissingFactId.length} skipped (no fact_id)` : ""}`;

  return {
    events,
    tool_log: verifyOutcome.tool_log,
    summary,
    report: {
      ...(verifyOutcome.report ?? {}),
      mutations: {
        deprecated: deprecatedCount,
        evidence_attached: redirectsAttached,
        skipped_for_missing_fact_id: skippedForMissingFactId,
      },
      candidates,
    },
  };
}

function deprecationReason(drift: Drift): string {
  switch (drift.kind) {
    case "source_dead":
      return `source returned ${drift.error ?? "error"}`;
    case "value_drift":
      return `value no longer substantiated by source`;
    case "excerpt_missing":
      return `recorded excerpt no longer present in source body`;
    case "source_redirect":
      return `source redirects to ${drift.redirect_to ?? "another url"}`;
    case "verified":
      return "still verified (informational)";
  }
}

/**
 * Iterate entities once (cheap — frames-cloud caches projections per SHA) and
 * collect every (entity_id, field) → fact_id mapping. Used by refresh to know
 * which fact_id to point fact.deprecated events at.
 */
async function collectFactIds(client: FrameClient, frame_url: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const ent of client.iterateEntities(frame_url, { include: "all" })) {
    if (!ent.fact_ids) continue;
    for (const [field, fact_id] of Object.entries(ent.fact_ids)) {
      map.set(`${ent.entity_id}::${field}`, fact_id);
    }
  }
  return map;
}
