#!/usr/bin/env bun
// Read skills.json (from scrape.ts), sparse-clone each unique repo once, run
// agentsec against every skill, write scan-results.json.
//
// Per-repo clone cache:
//   - One `git clone --depth 1 --filter=blob:none --sparse --no-recurse-submodules`
//     per unique (owner, repo). Each skill's `skill_path` is added to the
//     sparse-checkout incrementally.
//   - Cache lives under $TMPDIR/skill-watch-clones (or RUNNER_TEMP in CI).
//
// Trust boundary:
//   - `git clone` does NOT execute hooks; submodules are explicitly disabled.
//   - We never `npm install` skill code, never run scripts from a skill.
//   - agentsec is a pinned static analyzer (verified zero deps + zero install
//     hooks on the tarball). It walks files as data, doesn't import them.
//
// Usage:
//   bun scripts/scan.ts skills.json scan-results.json
//
// Honors:
//   AGENTSEC_BIN  path to agentsec binary (default: tools/agentsec/node_modules/.bin/agentsec)
//   GITHUB_TOKEN  used to pin commit SHA per repo (single API call each)

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type SkillEntry = {
  owner: string;
  repo: string;
  skill_name: string;
  skill_path: string;
  install_count: number;
  install_count_str: string;
  ranks: { all_time?: number; trending?: number; hot?: number };
};

type ScanResult = SkillEntry & {
  // Commit pinning — every fact's source.url can deep-link to this exact tree.
  commit_sha: string;
  commit_url: string;
  // Core agentsec output, flattened to what fold.ts needs.
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
  // For evidence — rich JSON link to the full audit (uploaded as artifact).
  raw_path?: string;
};

type ScanError = {
  owner: string;
  repo: string;
  skill_name: string;
  skill_path: string;
  error: string;
};

const AGENTSEC_BIN =
  process.env.AGENTSEC_BIN ??
  resolve(process.cwd(), "tools/agentsec/node_modules/.bin/agentsec");

const CACHE_ROOT = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "skill-watch-"));

function run(cmd: string, args: string[], cwd?: string): { stdout: string; stderr: string; ok: boolean } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ok: r.status === 0,
  };
}

const cloneCache = new Map<string, { dir: string; sha: string }>();

async function ensureClone(owner: string, repo: string): Promise<{ dir: string; sha: string }> {
  const key = `${owner}/${repo}`;
  const cached = cloneCache.get(key);
  if (cached) return cached;

  const dir = join(CACHE_ROOT, owner, repo);
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/${owner}/${repo}.git`;

  // Init an empty repo with sparse-checkout so we can add paths incrementally.
  const init = run("git", [
    "clone",
    "--depth", "1",
    "--filter=blob:none",
    "--sparse",
    "--no-recurse-submodules",
    "--no-tags",
    "-c", "submodule.recurse=false",
    "-c", "core.hooksPath=/dev/null",
    url,
    dir,
  ]);
  if (!init.ok) throw new Error(`clone failed: ${init.stderr.trim().split("\n").pop()}`);

  // Resolve the cloned commit SHA for permanent linking.
  const sha = run("git", ["rev-parse", "HEAD"], dir).stdout.trim();
  if (!sha) throw new Error(`no HEAD sha in ${dir}`);

  const entry = { dir, sha };
  cloneCache.set(key, entry);
  return entry;
}

function addSparsePath(repoDir: string, path: string): void {
  // `add` (vs `set`) is incremental — keeps previously added paths.
  const r = run("git", ["sparse-checkout", "add", path], repoDir);
  if (!r.ok) throw new Error(`sparse-checkout add ${path}: ${r.stderr.trim()}`);
}

function getAgentsecVersion(): string {
  const r = run(AGENTSEC_BIN, ["--version"]);
  // Output is "agentsec v0.3.0" or similar; grab the v-prefixed token.
  const m = r.stdout.match(/v?([\d.]+(?:-[\w.]+)?)/);
  return m ? m[1] : "unknown";
}

function severityRank(sev: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[sev.toLowerCase()] ?? 0;
}

function scanOne(entry: SkillEntry, repoDir: string, sha: string, agentsecVersion: string): ScanResult {
  const skillDir = join(repoDir, entry.skill_path);
  if (!existsSync(skillDir)) {
    throw new Error(`skill folder missing after sparse-checkout: ${entry.skill_path}`);
  }

  const outFile = join(CACHE_ROOT, `scan-${entry.owner}-${entry.repo}-${entry.skill_name}.json`);
  const r = run(AGENTSEC_BIN, [
    "--path", skillDir,
    "--format", "json",
    "--no-reports",
    "--no-color",
    "-o", outFile,
  ]);
  if (!r.ok && !existsSync(outFile)) {
    throw new Error(`agentsec failed: ${r.stderr.trim().split("\n").pop()}`);
  }

  const audit = JSON.parse(readFileSync(outFile, "utf8"));
  const skill = audit.skills?.[0];
  if (!skill) throw new Error(`agentsec returned no skill in audit`);

  // Counts by severity.
  const findingsArr: any[] = skill.securityFindings ?? [];
  const counts = { critical: 0, high: 0, medium: 0, low: 0, total: findingsArr.length };
  for (const f of findingsArr) {
    const k = (f.severity ?? "").toLowerCase();
    if (k in counts) (counts as any)[k]++;
  }

  // Top (highest-severity) finding.
  const top = [...findingsArr].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];

  return {
    ...entry,
    commit_sha: sha,
    commit_url: `https://github.com/${entry.owner}/${entry.repo}/tree/${sha}/${entry.skill_path}`,
    agentsec_version: agentsecVersion,
    scan_id: audit.id,
    scan_ts: audit.timestamp,
    description: skill.skill?.manifest?.description,
    manifest_version: skill.skill?.manifest?.version,
    platform: skill.skill?.platform,
    score: {
      overall: skill.score?.overall ?? 0,
      security: skill.score?.security ?? 0,
      quality: skill.score?.quality ?? 0,
      maintenance: skill.score?.maintenance ?? 0,
      grade: skill.score?.grade ?? "F",
    },
    findings: counts,
    top_finding: top
      ? {
          rule: top.id ?? top.rule,
          severity: top.severity,
          owasp_id: top.owaspId ?? "",
          title: top.title ?? "",
          remediation: top.remediation ?? "",
        }
      : undefined,
    web3: {
      detected: skill.web3?.detected ?? false,
      confidence: skill.web3?.confidence ?? "no",
      signals: skill.web3?.signals ?? [],
    },
    quality: {
      hasReadme: skill.qualityMetrics?.hasReadme ?? false,
      hasLicense: skill.qualityMetrics?.hasLicense ?? false,
      hasTests: skill.qualityMetrics?.hasTests ?? false,
      hasTypes: skill.qualityMetrics?.hasTypes ?? false,
      linesOfCode: skill.qualityMetrics?.linesOfCode ?? 0,
    },
    raw_path: outFile,
  };
}

async function main() {
  const [, , skillsJsonPath, outPath] = process.argv;
  if (!skillsJsonPath || !outPath) {
    console.error("usage: bun scripts/scan.ts <skills.json> <scan-results.json>");
    process.exit(2);
  }
  if (!existsSync(AGENTSEC_BIN)) {
    console.error(`agentsec binary not found at ${AGENTSEC_BIN}\nset AGENTSEC_BIN to override`);
    process.exit(2);
  }

  const skills: SkillEntry[] = JSON.parse(readFileSync(skillsJsonPath, "utf8"));
  console.error(`◇ scanning ${skills.length} skills`);

  const agentsecVersion = getAgentsecVersion();
  console.error(`◇ agentsec ${agentsecVersion}`);

  const results: ScanResult[] = [];
  const errors: ScanError[] = [];
  const t0 = Date.now();

  for (const entry of skills) {
    try {
      const { dir, sha } = await ensureClone(entry.owner, entry.repo);
      addSparsePath(dir, entry.skill_path);
      const r = scanOne(entry, dir, sha, agentsecVersion);
      results.push(r);
      const flag = r.findings.critical + r.findings.high > 0 ? "✗" : "✓";
      const w3 = r.web3.detected ? " [web3]" : "";
      console.error(`  ${flag} ${entry.owner}/${entry.repo}/${entry.skill_name}: ${r.score.grade} ${r.score.overall}${w3} (${r.findings.total} findings)`);
    } catch (e: any) {
      errors.push({
        owner: entry.owner,
        repo: entry.repo,
        skill_name: entry.skill_name,
        skill_path: entry.skill_path,
        error: e?.message ?? String(e),
      });
      console.error(`  ! ${entry.owner}/${entry.repo}/${entry.skill_name}: ${e?.message ?? e}`);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`\n✓ ${results.length} scanned, ${errors.length} errors in ${dt}s`);

  // Lift the raw_path entries into a side artifact so the events.ndjson stays
  // small. We embed only summaries in scan-results.json — full per-skill
  // agentsec JSON is left in the cache dir and gets uploaded as a workflow
  // artifact (see tick.yml).
  writeFileSync(outPath, JSON.stringify({
    scanned_at: new Date().toISOString(),
    agentsec_version: agentsecVersion,
    results,
    errors,
  }, null, 2));
  console.error(`◇ wrote ${outPath}`);

  // Cleanup the clone cache — we no longer need source after the scan.
  // Keep the per-skill JSONs (raw_path) only if --keep-raw is passed.
  if (!process.argv.includes("--keep-raw")) {
    rmSync(CACHE_ROOT, { recursive: true, force: true });
  } else {
    console.error(`◇ raw scan JSONs kept under ${CACHE_ROOT}`);
  }
}

main().catch((e) => {
  console.error("scan failed:", e);
  process.exit(1);
});
