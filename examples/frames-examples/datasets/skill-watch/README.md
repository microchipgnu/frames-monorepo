# skill-watch

Live security audit dataset for top skills on [skills.sh](https://skills.sh), scanned with [agentsec](https://agentsec.sh) (OWASP Agentic Skills Top 10).

A [frame](https://github.com/frames-ag/frame): one entity per skill, every fact evidenced, refreshed on a schedule, queryable as JSON or SQL.

## What's in here

- `schema.yml` — entity shape (owner, repo, skill_path, score, grade, findings_critical/high/medium/low, top OWASP category, is_web3, …)
- `events.ndjson` — the append-only event log; each tick adds `fact.set` events with the scan outcome and links the finding as evidence.
- `scripts/` — `scrape.ts` (skills.sh top/trending/hot lists) and `scan.ts` (sparse-clone + agentsec).
- `.github/workflows/tick.yml` — two-job CI: scan in an isolated job with **no secrets**, fold + commit in a separate job that has write access.

## Querying

The frame is rendered live at:

- **HTML**: `https://frames-cloud.microchipgnu.workers.dev/microchipgnu/skill-watch`
- **JSON API**: `https://frames-cloud.microchipgnu.workers.dev/api/v1/microchipgnu/skill-watch/_frames`

Locally with [`@frames-ag/frame`](https://www.npmjs.com/package/@frames-ag/frame):

```bash
bunx -y @frames-ag/frame project .
bunx -y @frames-ag/frame query . --field has_vulnerabilities=true --with-sources
bunx -y @frames-ag/frame query . --sql \
  "SELECT owner, repo, skill_name, grade, findings_critical + findings_high AS severe \
   FROM rows WHERE severe > 0 ORDER BY severe DESC LIMIT 25"
```

## Safety model

The scan job runs untrusted skill source through agentsec. To make this safe in CI:

- **Two-job split.** The scan job has `permissions: contents: read` and **no repository secrets** in its env. The fold/commit job is the only one with write access. A hypothetical compromise of the scanner therefore exfiltrates nothing.
- **No code execution from skills.** Skills are pulled with `git clone --depth 1 --filter=blob:none --sparse` + `sparse-checkout`; we never `npm install` skill code. agentsec is a static (file-walking) analyzer.
- **Pinned + isolated tooling.** `agentsec@<exact-version>` installed with `--ignore-scripts` into its own `node_modules/` (the package itself has zero deps and zero install hooks — verified on the tarball).
- **Egress allowlist.** `step-security/harden-runner` blocks outbound traffic on the scan job to `api.github.com`, `github.com`, `registry.npmjs.org`, `skills.sh` only.

## Powered by

- [skills.sh](https://skills.sh) — discovery
- [agentsec](https://agentsec.sh) — auditing (Semiotic)
- [@frames-ag/frame](https://github.com/frames-ag/frame) — substrate
