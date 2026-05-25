#!/usr/bin/env bun
// Read scan-results.json and fold its rows into events.ndjson via the
// Frame engine. Direct in-process calls — no MCP, no LLM. The scan output
// is fully deterministic, so we can write straight to the engine.
//
// Diff semantics (the "only-emit-when-something-changed" half of the
// design): for each scanned skill we derive its canonical field map,
// query the frame for the current values, and emit `set_facts` only when
// non-volatile fields drift. Volatile fields (install_count, ranks,
// last_scanned_at, agentsec_version) are NOT considered when deciding
// whether to emit; this keeps git history meaningful (commits = real
// audit changes), but they DO get carried along when a stable change
// triggers an emit.
//
// New entities get `addEntityWithFacts` with the full snapshot.
//
// Usage:
//   bun scripts/fold.ts [<scan-results.json>]   default: ./scan-results.json

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Frame } from "@frames-ag/frame";

type ScanResult = {
  owner: string;
  repo: string;
  skill_name: string;
  skill_path: string;
  install_count: number;
  ranks: { all_time?: number; trending?: number; hot?: number };
  commit_sha: string;
  commit_url: string;
  agentsec_version: string;
  scan_id: string;
  scan_ts: string;
  description?: string;
  manifest_version?: string;
  platform?: string;
  score: { overall: number; security: number; quality: number; maintenance: number; grade: string };
  findings: { critical: number; high: number; medium: number; low: number; total: number };
  top_finding?: { rule: string; severity: string; owasp_id: string; title: string; remediation: string };
  web3: { detected: boolean; confidence: string; signals: string[] };
  quality: { hasReadme: boolean; hasLicense: boolean; hasTests: boolean; hasTypes: boolean; linesOfCode: number };
};

type ScanFile = { scanned_at: string; agentsec_version: string; results: ScanResult[]; errors: any[] };

// Frame entity_ids must match [a-z0-9][a-z0-9_-]*; we compose them from
// owner / repo / skill-folder. Folder leaf is unique within a (owner, repo).
function entityIdFor(r: ScanResult): string {
  const leaf = r.skill_path.split("/").filter(Boolean).pop()!;
  const raw = `${r.owner}_${r.repo}_${leaf}`.toLowerCase();
  // Replace any disallowed char with `-`, collapse runs, trim leading non-alnum.
  return raw.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^[^a-z0-9]+/, "");
}

// What we'd write into the frame for a given scan result.
function snapshotFor(r: ScanResult): Record<string, unknown> {
  const has_vulnerabilities = r.findings.critical > 0 || r.findings.high > 0;
  const out: Record<string, unknown> = {
    owner: r.owner,
    repo: r.repo,
    skill_path: r.skill_path,
    skill_name: r.skill_name,
    score_overall: r.score.overall,
    score_security: r.score.security,
    score_quality: r.score.quality,
    score_maintenance: r.score.maintenance,
    grade: r.score.grade,
    findings_critical: r.findings.critical,
    findings_high: r.findings.high,
    findings_medium: r.findings.medium,
    findings_low: r.findings.low,
    has_vulnerabilities,
    is_web3: r.web3.detected,
    web3_confidence: r.web3.confidence || "no",
    has_readme: r.quality.hasReadme,
    has_license: r.quality.hasLicense,
    has_tests: r.quality.hasTests,
    last_scanned_at: r.scan_ts,
    agentsec_version: r.agentsec_version,
    install_count: r.install_count,
  };
  if (r.description) out.description = r.description;
  if (r.top_finding) {
    out.top_finding_rule = r.top_finding.rule;
    if (r.top_finding.owasp_id) out.top_finding_owasp = r.top_finding.owasp_id;
  }
  if (r.ranks.trending !== undefined) out.trending_rank = r.ranks.trending;
  if (r.ranks.hot !== undefined) out.hot_rank = r.ranks.hot;
  return out;
}

// Fields whose change does NOT, on its own, justify an emit. They're
// considered noise unless something else (a real audit change) also moved.
const VOLATILE_FIELDS = new Set([
  "install_count",
  "trending_rank",
  "hot_rank",
  "last_scanned_at",
  "agentsec_version",
]);

function diff(current: Record<string, unknown>, target: Record<string, unknown>): {
  changed: Record<string, unknown>;
  stable_changed: boolean;
} {
  const changed: Record<string, unknown> = {};
  let stable_changed = false;
  for (const [k, v] of Object.entries(target)) {
    const cur = current[k];
    if (!equalish(cur, v)) {
      changed[k] = v;
      if (!VOLATILE_FIELDS.has(k)) stable_changed = true;
    }
  }
  return { changed, stable_changed };
}

function equalish(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  // Numbers stored as strings in projection rows? Coerce to JSON for comparison.
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const path = resolve(process.argv[2] ?? "scan-results.json");
  if (!existsSync(path)) {
    console.error(`scan results not found: ${path}`);
    process.exit(2);
  }

  const file: ScanFile = JSON.parse(readFileSync(path, "utf8"));
  console.error(`◇ ${file.results.length} scan results, ${file.errors.length} scan errors`);

  const frame = new Frame(process.cwd(), { agent: "system:skill-watch-bot" });

  let n_new = 0;
  let n_updated = 0;
  let n_unchanged = 0;
  let n_failed = 0;

  for (const r of file.results) {
    const entity_id = entityIdFor(r);
    const target = snapshotFor(r);
    const source = {
      url: r.commit_url,
      retrieved_at: r.scan_ts,
      title: `${r.owner}/${r.repo}/${r.skill_name} — agentsec ${r.agentsec_version} (${r.score.grade}, ${r.findings.total} findings)`,
      excerpt: r.top_finding ? `${r.top_finding.title}\n${r.top_finding.remediation}` : undefined,
    };

    let current: Record<string, unknown> | null = null;
    try {
      current = frame.query({ mode: "entity", entity_id }).rows[0]?.fields ?? null;
    } catch {
      current = null; // entity doesn't exist yet
    }

    if (!current) {
      try {
        frame.addEntityWithFacts({
          entity_id,
          source,
          facts: Object.entries(target).map(([field, value]) => ({ field, value })),
        });
        n_new++;
        console.error(`  + ${entity_id}: ${target.grade} ${target.score_overall} (${target.findings_critical}+${target.findings_high}+${target.findings_medium}+${target.findings_low} findings)`);
      } catch (e: any) {
        n_failed++;
        console.error(`  ! ${entity_id}: ${e?.message ?? e}`);
      }
      continue;
    }

    const { changed, stable_changed } = diff(current, target);
    if (Object.keys(changed).length === 0 || !stable_changed) {
      n_unchanged++;
      continue;
    }

    try {
      frame.setFacts({
        entity_id,
        source,
        facts: Object.entries(changed).map(([field, value]) => ({ field, value })),
      });
      n_updated++;
      const fieldList = Object.keys(changed).filter((k) => !VOLATILE_FIELDS.has(k)).join(", ");
      console.error(`  ~ ${entity_id}: ${fieldList}`);
    } catch (e: any) {
      n_failed++;
      console.error(`  ! ${entity_id}: ${e?.message ?? e}`);
    }
  }

  console.error(`\n✓ ${n_new} new, ${n_updated} updated, ${n_unchanged} unchanged, ${n_failed} failed`);
}

main().catch((e) => {
  console.error("fold failed:", e);
  process.exit(1);
});
