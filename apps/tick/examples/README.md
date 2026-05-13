# tick examples

Drop-in templates for using the hosted tick runtime.

## `github-action.yml` — scheduled curate via GitHub Actions

The fastest way to keep a frame fresh. Calls the hosted tick runtime on
a weekly schedule and commits new events back to your repo.

### Setup

1. Get a `TICK_API_KEY` — currently this is operator-issued (closed
   alpha; no public signup yet). Reach out via the GitHub repo or
   email to get one. If you're operating your own tick deployment,
   set `TICK_API_KEYS` on your Worker (see
   [DEPLOY.md](../DEPLOY.md)).
2. Copy `github-action.yml` to `.github/workflows/tick-curate.yml` in
   the repo that contains your frame.
3. In your repo, add two secrets:
   - **Settings → Secrets and variables → Actions → New repository secret**
   - `TICK_API_KEY` = the key you got
   - `TICK_API_URL` *(optional)* = override the runtime URL; defaults
     to the current production endpoint
4. Edit the `FRAME_PATH` env var in the workflow file to point at your
   frame's directory (the one containing `schema.yml` and
   `events.ndjson`).
5. Commit + push.

### What runs

On each fire, the action:

1. POSTs your frame URL + budget to `tick.microchipgnu.workers.dev/run` with `op: curate`
2. tick reads your existing frame, runs the curate agent loop (EXPAND
   for missing entities, REFRESH for stale facts), verifies every new
   citation via a Haiku-tier judge
3. Returns new events
4. The action appends those events to your `events.ndjson` and pushes

### Cost

Bounded by the `budget` field. Tick refuses to overshoot. Typical
small frames (5-20 entities): $0.50-$2.00 per run. Workflow defaults
to `$1.50`; override via the manual-trigger input.

### Triggering manually

GitHub repo → Actions tab → `tick-curate` → "Run workflow". You can
override the budget for this run only.

### Inspecting a run

After each run, find the run summary in the Actions tab. The job
summary surfaces:

- Total events written, settled cost, stop reason
- Per-sub-agent breakdown (which entities got refreshed / which new
  entities got added)
- Citation verifier counts (supported vs deprecated)

Full JSON response is uploaded as a workflow artifact named
`tick-result-<run-id>` (kept 30 days).

### Failure modes

- **TICK_API_KEY not set** — workflow errors out early with an actionable message
- **schema.yml missing at FRAME_PATH** — same
- **Budget exhausted during curate** — workflow succeeds, events written,
  job summary shows `stop_reason: budget_exhausted`; raise the budget
  for next run or wait for next schedule
- **All facts deprecated by verifier** — exceptional. Inspect the
  artifact JSON's `report.verify_citations.unsupported` list to see
  what the verifier rejected. Usually means the source URLs aren't
  authoritative for the claims being made.

### Want CLI-mode (run locally without the hosted endpoint)?

The CLI mode (`npx -y @frames-ag/tick curate`) runs the same agent
locally using your own wallet for paid tool calls. Useful when you
don't want a hosted dependency. Documented separately.
