// `frame doctor [<name>]` — health check.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Frame } from "../frame.js";
import { readEvents } from "../events.js";
import { resolveFrameDir, splitPathAndFlags } from "./util.js";

export function doctor(args: string[]): void {
  const { path } = splitPathAndFlags(args);
  const dir = resolveFrameDir(path);
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  // schema.yml exists & parses
  try {
    const frame = new Frame(dir);
    const schema = frame.schema();
    checks.push({
      name: "schema.yml",
      ok: true,
      detail: `protocol ${schema.frame_protocol}, ${Object.keys(schema.fields).length} fields`,
    });
  } catch (e: any) {
    checks.push({ name: "schema.yml", ok: false, detail: e?.message ?? String(e) });
  }

  // events.ndjson exists & parses
  try {
    const events = readEvents(join(dir, "events.ndjson"));
    const size = statSync(join(dir, "events.ndjson")).size;
    // Per-type breakdown so paid calls (tool.invoked) are visible up front.
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const breakdown = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${n} ${t}`)
      .join(", ");
    checks.push({
      name: "events.ndjson",
      ok: true,
      detail: `${events.length} events, ${size} bytes  [${breakdown}]`,
    });

    // Paid-call summary, when present. Best-effort — we don't validate the
    // receipt signature here; the receipt is informational at audit time.
    if (counts["tool.invoked"]) {
      const acc: Record<string, number> = {};
      for (const e of events) {
        if (e.type !== "tool.invoked") continue;
        const r = (e.payload as any)?.receipt;
        if (!r) continue;
        const n = parseFloat(String(r.amount));
        if (!Number.isFinite(n)) continue;
        const c = String(r.currency || "?");
        acc[c] = (acc[c] ?? 0) + n;
      }
      const totals = Object.entries(acc)
        .map(([c, n]) => {
          let s = n.toFixed(6);
          if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
          return `${s} ${c}`;
        })
        .join(", ") || "—";
      checks.push({
        name: "paid calls",
        ok: true,
        detail: `${counts["tool.invoked"]} tool.invoked total; cost: ${totals}`,
      });
    }
  } catch (e: any) {
    checks.push({ name: "events.ndjson", ok: false, detail: e?.message ?? String(e) });
  }

  // .git exists
  checks.push({
    name: ".git",
    ok: existsSync(join(dir, ".git")),
    detail: existsSync(join(dir, ".git")) ? "present" : "missing — run `git init`",
  });

  // .gitattributes contains union merge for events
  const gaPath = join(dir, ".gitattributes");
  if (existsSync(gaPath)) {
    const ga = readFileSync(gaPath, "utf8");
    const ok = /events\.ndjson\s+merge=union/.test(ga);
    checks.push({
      name: ".gitattributes",
      ok,
      detail: ok ? "events.ndjson uses union merge" : "missing `events.ndjson merge=union`",
    });
  } else {
    checks.push({
      name: ".gitattributes",
      ok: false,
      detail: "missing — events.ndjson concurrent edits will conflict",
    });
  }

  // .frame/lock not stuck
  const lockPath = join(dir, ".frame", "lock");
  if (existsSync(lockPath)) {
    const stat = statSync(lockPath);
    const ageS = (Date.now() - stat.mtimeMs) / 1000;
    checks.push({
      name: ".frame/lock",
      ok: ageS < 600, // <10min suggests something might still be running
      detail: ageS < 600
        ? `held (${Math.round(ageS)}s) — operation likely in progress`
        : `stale (${Math.round(ageS)}s) — remove ${lockPath} if no operation is running`,
    });
  } else {
    checks.push({ name: ".frame/lock", ok: true, detail: "no lock held" });
  }

  // derived projection up to date?
  const dbPath = join(dir, ".frame", "dataset.db");
  if (existsSync(dbPath)) {
    const evMtime = statSync(join(dir, "events.ndjson")).mtimeMs;
    const dbMtime = statSync(dbPath).mtimeMs;
    checks.push({
      name: ".frame/dataset.db",
      ok: dbMtime >= evMtime,
      detail: dbMtime >= evMtime
        ? "current"
        : "stale — run `frame project` to regenerate",
    });
  } else {
    checks.push({
      name: ".frame/dataset.db",
      ok: false,
      detail: "not generated — run `frame project`",
    });
  }

  console.log(`◇ ${dir}`);
  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    console.log(`  ${icon} ${c.name.padEnd(20)} ${c.detail}`);
  }
  if (checks.some((c) => !c.ok)) process.exit(1);
}
