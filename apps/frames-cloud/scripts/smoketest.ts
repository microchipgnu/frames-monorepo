import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { paginate, parseFilters } from "../src/pagination.ts";
import { parseEvents, project } from "../src/projector.ts";
import type { Schema } from "../src/types.ts";

const root = "/Users/luisfreitas/Desktop/personal/frames-engineering/frames.ag/frame/examples/ai-agent-wallets-eu";
const schema = parseYaml(readFileSync(`${root}/schema.yml`, "utf8")) as Schema;
const events = parseEvents(readFileSync(`${root}/events.ndjson`, "utf8"));

const { entities, max_ts } = project(events);

console.log("schema:", schema.name);
console.log("events:", events.length);
console.log("entities:", entities.size);
console.log("max_ts:", max_ts);
console.log();

const live = [...entities.values()].filter((e) => !e.removed);
console.log("live entities:", live.length);

console.log("\n=== entity rows ===");
for (const e of live.sort((a, b) => a.entity_id.localeCompare(b.entity_id))) {
  const fields = Object.entries(e.fields)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  console.log(`  ${e.entity_id}  ${fields}`);
}

console.log("\n=== pagination test (limit=3, no filters) ===");
const p1 = paginate(entities.values(), null, 3, {});
console.log("page1:", p1.rows.map((e) => e.entity_id));
console.log("next_cursor:", p1.next_cursor);
const p2 = paginate(entities.values(), Buffer.from(p1.rows[2]!.entity_id, "utf8").toString("base64url") ? p1.rows[2]!.entity_id : null, 3, {});
const decoded = p1.next_cursor ? Buffer.from(p1.next_cursor, "base64url").toString("utf8") : null;
console.log("decoded next cursor:", decoded);

console.log("\n=== filter test (hq_country=DE,FR) ===");
const filters = parseFilters(new URLSearchParams("filter[hq_country]=DE,FR"));
const filtered = paginate(entities.values(), null, 100, filters);
console.log("matches:", filtered.rows.map((e) => `${e.entity_id} (${e.fields.hq_country})`));

console.log("\n=== evidence sample ===");
const ovra = entities.get("ovra");
if (ovra) {
  console.log("ovra fields:", ovra.fields);
  console.log("ovra evidence (first source per field):");
  for (const [field, src] of Object.entries(ovra.evidence)) {
    console.log(`  ${field}: ${src.url}`);
    console.log(`    "${src.excerpt?.slice(0, 90)}..."`);
  }
}
