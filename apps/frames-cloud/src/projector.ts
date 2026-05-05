import type { Entity, Fact, FrameEvent } from "./types";

export function parseEvents(ndjson: string): FrameEvent[] {
  if (!ndjson) return [];
  const out: FrameEvent[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as FrameEvent);
    } catch {
      // skip malformed lines — log later
    }
  }
  return out;
}

export function project(events: FrameEvent[]): {
  entities: Map<string, Entity>;
  max_ts: string;
} {
  const entities = new Map<string, Entity>();
  const factIndex = new Map<string, Fact>(); // fact_id → fact
  let max_ts = "";

  for (const ev of events) {
    if (ev.ts > max_ts) max_ts = ev.ts;

    switch (ev.type) {
      case "entity.created": {
        const id = ev.payload.entity_id;
        if (!entities.has(id)) {
          entities.set(id, {
            entity_id: id,
            fields: {},
            evidence: {},
            facts: {},
            history: {},
            removed: false,
          });
        }
        break;
      }

      case "entity.removed": {
        const ent = entities.get(ev.payload.entity_id);
        if (ent) ent.removed = true;
        break;
      }

      case "fact.set": {
        const { fact_id, entity_id, field, value, source, confidence, observed_at } = ev.payload;
        let ent = entities.get(entity_id);
        if (!ent) {
          ent = {
            entity_id,
            fields: {},
            evidence: {},
            facts: {},
            history: {},
            removed: false,
          };
          entities.set(entity_id, ent);
        }
        const fact: Fact = {
          fact_id,
          entity_id,
          field,
          value,
          source,
          evidence: [],
          ts: ev.ts,
          confidence,
          observed_at,
          deprecated: false,
        };
        factIndex.set(fact_id, fact);

        (ent.history[field] ??= []).push(fact);

        // last-write-wins per (entity_id, field) by ts among non-deprecated facts
        const existing = ent.facts[field];
        if (!existing || existing.ts <= ev.ts) {
          ent.facts[field] = fact;
          ent.fields[field] = value;
          ent.evidence[field] = source;
        }
        break;
      }

      case "fact.deprecated": {
        const fact = factIndex.get(ev.payload.fact_id);
        if (!fact) break;
        fact.deprecated = true;
        const ent = entities.get(fact.entity_id);
        if (!ent) break;
        // if this was the current fact for the field, fall back to most recent non-deprecated fact for the same field
        if (ent.facts[fact.field]?.fact_id === fact.fact_id) {
          let fallback: Fact | null = null;
          for (const f of factIndex.values()) {
            if (
              f.entity_id === fact.entity_id &&
              f.field === fact.field &&
              !f.deprecated &&
              f.fact_id !== fact.fact_id
            ) {
              if (!fallback || f.ts > fallback.ts) fallback = f;
            }
          }
          if (fallback) {
            ent.facts[fact.field] = fallback;
            ent.fields[fact.field] = fallback.value;
            ent.evidence[fact.field] = fallback.source;
          } else {
            delete ent.facts[fact.field];
            delete ent.fields[fact.field];
            delete ent.evidence[fact.field];
          }
        }
        break;
      }

      case "fact.evidence_added": {
        const fact = factIndex.get(ev.payload.fact_id);
        if (fact) fact.evidence.push(ev.payload.source);
        break;
      }
    }
  }

  return { entities, max_ts };
}
