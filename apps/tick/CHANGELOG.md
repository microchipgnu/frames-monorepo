# @frames-ag/tick

## 0.3.2 — 2026-05-13 (three small fixes from live-curate observations)

Three issues surfaced by the live curate runs of 2026-05-13 against
`microchipgnu/frames-examples/datasets/mcp-servers`. None block usage,
but each affects either cost or first-touch UX.

### Fixes

**1. `parseFrameUrl` normalizes GitHub web-UI URLs** (`src/frame-client.ts`).
Today's first live curl 404'd because we sent
`github.com/u/r/tree/main/datasets/mcp-servers` (the URL anyone copies
from their browser) and the parser forwarded it raw to frames-cloud,
which looked for a `schema.yml` at `u/r/tree/main/datasets/mcp-servers/`.
Now the parser strips `tree/<ref>/` and `blob/<ref>/` prefixes and
lifts `<ref>` into the ref field. Explicit `?ref=` still wins. Covers
the dominant customer paste pattern.

**2. Phase D cache hits on the budget-exhausted wrap-up call**
(`src/ops/curate.ts:131`). The force-summary call dropped `tools` from
the request body, which changed Anthropic's prefix order (`tools → system →
messages`) and busted the cached prefix built up over prior iters. Live
data confirmed iter-N+1 paid the full input rate on a 4-5K-token prefix
that should have hit the cache. Now passes `tools: CURATE_TOOLS`; the
user-message instruction "do not call any more tools" is reliable enough
to keep behavior unchanged while preserving the cache. Saves ~$0.005
per budget-exhausted run.

**3. Test coverage for Phase E.1 fetch dedup**
(`test/refresh-entity.test.ts`, new). The dedup cache exists since
v0.2.0 but no live run had exercised it — models never re-fetched the
same URL within one sub-loop in our test corpus. Added two focused
tests:
- Same URL fetched across iters → refetcher fires once, cache marker
  goes to the model on the second call.
- Same URL with different `entity_hint` → two cache keys, refetcher
  fires twice (the summary is hint-specific).

### What was NOT fixed

Discover convergence (the 13/17 v0.3.0 → 9/17 v0.3.1 failure rate) is
still mediocre — the iter-3 threshold bump in v0.3.1 unblocked some
sub-loops mechanically, but most that reach iter 3 still don't propose.
Needs deeper investigation (sub-loop message-history inspection) before
the next tuning pass. Tracked separately.

bumps: `@frames-ag/tick` 0.3.1 → 0.3.2

---

## 0.3.1 — 2026-05-13 (hotfix — raise discover-entity non-terminal streak threshold 2 → 3)

Live curate against `microchipgnu/frames-examples/datasets/mcp-servers`
(2026-05-13, $1.50 budget) surfaced that **13 of 17 `discover_entity`
sub-loops aborted before reaching their propose iter.** Every single
one stopped at iter 2 with `stop_reason: "no_progress"`.

### Root cause

`discover-entity.ts` borrowed its `nonTerminalStreak >= 2` early-stop
threshold from `refresh-entity.ts`. That threshold makes sense for
refresh — the sub-loop receives `entity_state` pre-loaded from the
parent, so one verifying fetch is usually enough before a terminal
`propose_facts` call.

Discover starts from a hypothesis with no pre-loaded state. The
typical convergence pattern is **fetch-seed → fetch-corroborator →
propose** — exactly 3 iters. With the threshold at 2, the early-stop
check at top-of-iter-3 fires before the model gets to propose.

### Fix

Bumped the discover sub-loop threshold from 2 to 3
(`src/ops/discover-entity.ts:202-205`). Refresh stays at 2 — its
pattern is different and that threshold is working as designed.

Sub-loop max_iters is still 5; with the threshold at 3 a model that
needs 4 fetches before deciding is now genuinely spinning and gets
caught. Threshold-of-3 + max_iters-of-5 leaves only 2 wasted iters
worst-case before the hard cap.

### Why this was missed pre-ship

The discover sub-loop tests in `test/discover-entity.test.ts` exercised
the happy paths (propose_new_entity / propose_match_existing / no_match)
with iter 1 directly emitting the terminal tool — no `web_fetch`
exploration. The one test that did fetch-then-stop matched the (wrong)
threshold of 2, so it passed without catching the conceptual mismatch.

Updated `test/discover-entity.test.ts` to assert the new (3) threshold
and rephrase the test description.

### Expected impact

On the same `mcp-servers` curate that triggered this finding:
- v0.3.0: 4 entity_added / 13 no_op-discover / 7 facts_set = 11 useful sub-runs
- v0.3.1: expected ~12-14 entity_added (the 8-10 that needed iter 3
  to converge) + 7 facts_set + small residual no_op = ~20 useful

Test it the same way:
```sh
curl -X POST https://tick.microchipgnu.workers.dev/run \
  -H "authorization: Bearer $TICK_API_KEY" \
  -d '{"op":"curate","frame":"https://github.com/microchipgnu/frames-examples/datasets/mcp-servers","budget":"1.50"}' \
  | jq '.sub_runs | group_by(.action) | map({(.[0].action): length}) | add'
```

bumps: `@frames-ag/tick` 0.3.0 → 0.3.1

---

## 0.3.0 — 2026-05-13 (Phase F — discover_entity sub-agent + EXPAND/REFRESH framing)

Tick's curate op was *refresh-coded*. The system prompt told the agent
to operate on existing entities; the only sub-agent (`refresh_entity`)
took an existing `entity_id`; the Phase E (v0.2.0) early-stop heuristic
punished exploration. A curator that only verifies what it already knows
isn't a curator — it's a verifier. Phase F closes that gap.

### What's new

**`discover_entity` sub-agent tool.** Symmetric counterpart to
`refresh_entity` for EXPAND-mode work. The agent emits a hypothesis
("A biotech called Genomique, Paris, 2024") plus optional `seed_urls`
and `fields_to_find`. A bounded sub-loop (5 iters, ~$0.30 budget) runs
in its own Durable Object isolate and returns one of:

- `entity_proposed` — runtime auto-emits the `entity.created` +
  `facts.set_many` events. No follow-up tool call needed from the
  parent.
- `matched_existing` — investigation revealed the hypothesis was a dupe
  of a known entity_id. Nothing written. Parent skips.
- `no_match` — hypothesis can't be verified or is out of scope. Nothing
  written.

Sub-loop receives `known_entity_ids` (capped at 500) so it can detect
duplicates. The dispatcher fetches this list once per call from the
parent's frame_client. The sub-loop's `propose_new_entity` is hard-
guarded: proposing a known id returns a tool-error and the model is
forced to retry as `propose_match_existing`.

**Parallel dispatch extended.** Phase C's "all-`refresh_entity` turn →
`Promise.all`" optimization now triggers on any turn that's all-sub-
agents (mix of `refresh_entity` + `discover_entity` is fine — both
route to EntityAgent DOs with no shared state). A 13-entity curate
that mixes 8 refreshes + 5 discoveries in one turn now runs all 13 in
parallel isolates.

**System prompt rewrite (`src/llm/system.ts`).** Replaced the refresh-
coded "Loop strategy" stanza with two co-equal modes:

- **EXPAND** — find entities the dataset is missing. Use
  `discover_entity` per candidate. Fan out.
- **REFRESH** — verify and update entities already in the dataset. Use
  `refresh_entity` per existing entity. Fan out.

The agent picks per dataset state: empty-or-near-empty → mostly EXPAND;
mature → mostly REFRESH; typical → both. The `refresh_entity` tool
description no longer carries the "**Preferred path**" framing.

**Phase E early-stop dial-back.** The parent loop's 3-streak no-event
threshold (introduced in v0.2.0) punished legitimate EXPAND-mode
exploration that runs 3-4 catalog/search iters before its first write.
Two replacement triggers:

1. **Generous threshold** — bumped from 3 to **5 consecutive no-event
   iters** before forcing a wrap-up.
2. **Sharp spin detector** — if an iter's exact tool-call signature
   (sorted `(name, input)` pairs) matches the previous iter's AND
   both produced zero events, stop immediately. Catches tight loops
   on the same calls without waiting for the 5-streak. Varied
   exploration never trips this — different signatures each iter.

### Public API changes

- **New tool** in `CURATE_TOOLS`: `discover_entity(hypothesis,
  seed_urls?, fields_to_find?)`. Hosted runtimes expose it through the
  same Anthropic tool-spec surface as the other curate tools.
- **`SubRunSummary.action`** in `@frames-ag/tick-types` grew two
  variants: `entity_added`, `entity_matched_existing`. Existing
  variants unchanged. Consumers using exhaustive switches need to
  handle the new cases (or fall through to default).

### Migration

For a typical curate run the upgrade is silent — the model picks
EXPAND vs REFRESH and acts. To explicitly nudge:

```sh
# Frame whose prompt.md says "find every UK Series-A biotech of 2025"
# now genuinely expands instead of just refreshing what exists.
tick curate <frame-url> --budget 2.0
```

If your downstream tooling exhaustively switches on `sub_runs[].action`,
extend the switch with `entity_added` (proposed entity → runtime wrote
`entity.created` + `facts.set_many`) and `entity_matched_existing`
(dupe → no writes).

### bumps

- `@frames-ag/tick` 0.2.0 → 0.3.0
- `@frames-ag/tick-types` 0.0.4 → 0.0.5

---

## 0.2.0 — 2026-05-13 (Phase E — fetch dedup, evidence-aware early stop, CitationAgent)

Three quality + cost defenses landing together. Together they close the
last three gaps from the agent-swarm SOTA review against tick's
architecture: duplicate fetches inside a sub-loop, fetch-in-circles
without writing, and synthesizer-hallucinated citations.

### 1. Within-sub-agent fetch dedup (`refresh-entity.ts`)

Each `refreshEntity()` invocation now keeps a `Map<url+entity_hint,
summary>` over its 5-iter budget. A second `web_fetch` for the same URL
returns the cached summary with a `[cached fetch — already retrieved]`
marker and zero LLM/network cost. The model sees that it already pulled
the URL and moves on.

Why this scope (within-sub-agent, not cross-sub-agent): parallel
sub-agents work on **different entities**, so cross-agent URL overlap is
fundamentally lower than the Anthropic "N agents same question" case
that motivated their dedup recommendation. Within-sub-loop dedup catches
the dominant 80% (model forgets it pulled a URL or pulls once-to-scan,
once-to-verify) at near-zero implementation cost. Cross-DO dedup is
deferred until we have telemetry showing it matters.

### 2. Evidence-aware early stop (`refresh-entity.ts` + `curate.ts`)

Two new stop signals:

- **Sub-loop**: 2 consecutive iters that emit no terminal write
  (`propose_facts` / `propose_deprecations` / `no_change`) → stop with
  `stop_reason: "no_progress"`. Saves at most 2 sub-loop iters per call
  on entities that are spinning, which compounds across a parallel
  N-entity curate.
- **Parent curate loop**: 3 consecutive iters that emit no events at all
  → force a wrap-up summary call with `stop_reason: "no_progress"`. Much
  bigger win here — parent's `max_iters` is 30, so a stuck model could
  previously burn 25+ iters fetching without writing. Live-observed in
  the v0.0.10 curate post-mortem.

Different counters because parent and sub-loop have different "progress"
semantics. Parent counts emitted FrameEvents; sub-loop counts terminal
tool calls (which break the loop, so we count non-terminal iters in a
row instead).

### 3. CitationAgent post-pass (`src/ops/verify-citations.ts`)

After the curate loop finishes, every newly-written fact gets a Haiku-
tier verification pass: "Does the cited `source.excerpt` directly
support `field = value`?" Strict-JSON output. Unsupported claims get a
`fact.deprecated` event appended with `reason: "citation_unverified:
<judge's reason>"`. The original `facts.set_many` event stays in the
log for audit — dataset projection skips the deprecated facts but the
trail is preserved.

Cost shape: ~130 input + 30 output tokens per fact at Haiku rates
($1/$5 per 1M) = ~$0.0003 per fact. A 20-fact curate adds ~$0.006 to
the bill — under one third the cost of a single tool fetch.

Why this matters more than the +90% accuracy framing in Anthropic's
research-system writeup: tick is a *dataset curation* product. The
single most important quality signal is "does the cited quote actually
support the claim?" A synthesizer that writes claim AND citation in the
same call has every incentive to fabricate a plausible-sounding excerpt
for a plausible-sounding value. The CitationAgent runs with a different
role on a different model and only sees claim + excerpt — it has no way
to confabulate the relationship between them.

Skip the post-pass by passing `params: { verify_citations: false }` to
`POST /run` (bulk-import flows with external verification, etc.).

### What's NOT in this version

- **Cross-DO fetch dedup** — deferred. Needs measurement first.
- **Strict-mode CitationAgent** (re-fetch URL + check excerpt actually
  appears on the page) — also deferred. Today we trust the excerpt is
  real and only check that it supports the claim; fabricated excerpts
  are caught by the separate `verify` op on the next run, not here.
- **Single-entity inline heuristic** (skip sub-agent dispatch when only
  one entity is in scope) — re-examined, marginal cost difference,
  not worth special-casing.

### Migration

- The new `params.verify_citations` is opt-out, default `true`. Existing
  callers see ~$0.005-$0.02 added to curate runs and may see new
  `fact.deprecated` events on the same run as the `facts.set_many` that
  set them. Both pieces are loggable via the new `report.verify_citations`
  block.
- The internal `RefreshEntityResult.stop_reason` union grew a
  `"no_progress"` variant. Public `SubRunSummary.stop_reason` is typed
  as `string` in `tick-types` so no consumer break.

### Verify (after deploy)

```sh
tick curate <frame-url> --budget 1.0
# Watch `report.verify_citations` — should show facts_checked,
# supported, unsupported. Any unsupported fact emits a fact.deprecated
# event in the same run.
```

To opt out for a single run:
```sh
tick curate <frame-url> --budget 1.0 --params '{"verify_citations": false}'
```

---

## 0.1.2 — 2026-05-13 (Phase D — Anthropic prompt caching on system+tools prefix)

Adds `cache_control: { type: "ephemeral" }` to the system prompt on every
Anthropic call. Cache prefix order is `tools → system`, so flagging the
system block also caches the (much larger) tools array immediately before
it. The cache lives 5 minutes per Anthropic's ephemeral semantics —
plenty for a 5-iter sub-loop or a multi-turn curate.

### What's new

- **`src/llm/client.ts`** — `callAnthropic` now wraps `system` as a
  cache-flagged content block. Cache-creation tokens billed at 1.25× the
  input rate; cache-read tokens at 0.10×. Cost calc updated. Same change
  mirrored in `callAiBinding`'s anthropic branch for consistency (dead
  code today but worth keeping in sync).
- **`LlmUsage`** — adds optional `cache_creation_input_tokens` and
  `cache_read_input_tokens` so callers can attribute the cache hit/miss
  per iter.
- **`IterationLogEntry`** in `@frames-ag/tick-types` — same two fields,
  surfaced through the public `RunResult.iteration_log`. Customers can
  now see exactly which iters paid cache-write vs. cache-read rates.
- **All four `iteration_log.push` call sites** (curate, discover,
  refresh-entity ×1 each, curate ×2) forward the cache fields.

### Why this matters

Phase B bounded the per-entity context but every sub-loop iter still
re-paid the input rate for the (constant) system prompt + the (constant)
tools array. With caching:

- **Iter 1**: pays 1.25× input rate on the cached prefix (one-time).
- **Iters 2-5**: pay 0.10× input rate on the same prefix.

For a 5-iter sub-loop with ~3K tokens of system+tools, that's a
**~60% cut to input-side spend** on the prefix portion of each
follow-up iter. On a 13-entity curate, this compounds across every
sub-loop run in parallel.

### What's NOT in this version

Recursive context compaction (mid-loop conversation summarization) was
on the Phase D plan but is **deferred to v0.1.3**. Honest assessment:
Phase B already capped sub-loop iters at 5 and tool-output size at
~500-2K tokens via Haiku summarization. The realistic per-sub-loop
context tops out around 8-15K tokens, well below any compaction
threshold worth the engineering. Compaction earns its keep on the
parent curate loop (which can run 30+ iters across dozens of tools);
that's where v0.1.3 will target it.

### Migration

None. The cache fields on `IterationLogEntry` are optional. Pre-0.1.2
clients that read `RunResult.iteration_log` will silently ignore them.

### Verify (after deploy, once gateway balance is back)

Run any curate against a real frame and inspect the `iteration_log` in
the response:
```json
{
  "iter": 2,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 2987
}
```
Iter 1 should show `cache_creation > 0, cache_read = 0`; iters 2+ should
flip to `cache_read > 0, cache_creation = 0` on the same prefix.

---

## 0.1.1 — 2026-05-13 (Phase C — EntityAgent Durable Objects + parallelism)

Promotes the refresh-entity sub-loop to a Durable Object so concurrent
entity refreshes run in **isolated DO instances** rather than serially
inside the parent Worker. Three-line win: bounded context (Phase B) +
parallel execution (Phase C) means a 13-entity frame refresh now runs in
roughly **N/P wall-clock time** where P is how many entities the agent
batches in one tool-use turn.

### What's new

- **`src/agents/entity-agent.ts`** — `EntityAgent` Durable Object class.
  Each instance hosts one `refreshEntity()` sub-loop with its own LlmClient
  + refetcher constructed from the DO's env. Named by `${run_id}:${entity_id}`
  for idempotency on retries.
- **`worker.ts`** exports `EntityAgent` (required by `wrangler.toml`'s DO
  binding).
- **`wrangler.toml`** — new `[[durable_objects.bindings]]` for `ENTITY_AGENT`
  + `[[migrations]]` with `new_sqlite_classes = ["EntityAgent"]`. First
  deploy after this version adds the DO class to the live Worker.
- **`env.ts`** — `ENTITY_AGENT?: DurableObjectNamespace<EntityAgent>` typing.
- **`dispatchRefreshEntity`** routes through the DO when the binding is
  present (production CF Worker); falls back to the in-process function
  for local Bun dev / smoketest.
- **Parallel dispatch in curate.ts** — when the LLM emits >1 tool_use
  block in a single turn AND every block is `refresh_entity`, we run
  them concurrently via `Promise.all`. Mixed-tool turns stay sequential
  (preserves write ordering when tools have side effects).

### Why this matters

Phase B (v0.1.0) capped each entity's work to its own ~$0.10 sub-loop.
But every sub-loop ran INSIDE the parent Worker's 30s CPU budget. A
13-entity frame doing sequential 10s sub-loops would blow the wall.

Phase C gives each entity its own DO isolate = its own 30s budget +
true parallelism. The agent can now `refresh_entity` 13 things at once
in a single tool-use turn and have them complete in ~10s wall-clock
instead of 130s.

### Cost story unchanged from Phase B

The DO doesn't change LLM cost — same sub-loop logic, same Haiku
summarization, same Anthropic flagship for write decisions. What changes
is **wall-clock** + the ceiling on a single run's work.

### Migration note

First deploy of v0.1.1 adds a Durable Object class to the live Worker.
That's a one-time wrangler migration with `tag = "v1"`. No data
migration needed (no persisted state in the DO yet — Phase D might add
some).

### What's still NOT in this release

- **Phase D** (v0.1.2) — Anthropic prompt-cache integration + recursive
  context compaction for long parent loops.
- **Persisted sub-loop state** — DOs could survive a 529 retry without
  losing iteration progress. Currently the DO just runs the sub-loop
  end-to-end in one invocation.

## 0.1.0 — 2026-05-12 (Phase B — sub-agents per entity)

The architectural piece. Parent curate loop can now delegate per-entity
research to bounded sub-loops via the new `refresh_entity` tool.

### The shape

Old curate (v0.0.13 and prior):
- ONE long conversation
- 13 entities × N fetches × M iters compounded in one context
- Agent over-explored when each call was cheap (30 iters, 4 events at $1.88)

New curate (v0.1.0):
- Parent reads schema + state (1-2 iters, ~$0.05)
- Parent dispatches `refresh_entity(id)` per target entity
- Each sub-agent has:
  - Bounded context (~15K tokens — schema + that entity's state)
  - Bounded iters (5 max)
  - Bounded budget ($0.30)
  - Stripped tool palette (`web_fetch` + 3 terminal write tools)
  - Hard "I'm done" state via terminal tool call
- Parent aggregates results, emits final `facts.set_many` events

Expected cost on the same 5-fetch / 4-write workload:
- v0.0.12: $3.13
- v0.0.13: $1.88
- v0.1.0: ~$0.40-$0.60 projected (parent ~$0.10 + 4 sub-agents × ~$0.10 each)

### What's in this release

- **`src/ops/refresh-entity.ts`** — `refreshEntity()` sub-loop with its
  own bounded LLM loop, 4 tool palette (`web_fetch`, `propose_facts`,
  `propose_deprecations`, `no_change`), terminal-stop semantics, and
  per-sub-run iteration_log.
- **New `refresh_entity` tool** added to `CURATE_TOOLS` — documented as the
  **preferred path** in the system prompt.
- **`dispatchRefreshEntity`** in `curate.ts` loads the entity's current
  state from frames-cloud, runs the sub-loop, and emits `facts.set_many`
  / `fact.deprecated` events directly on success.
- **`SubRun` / `SubRunSummary` types** — surfaced on `OpOutcome.sub_runs`
  and `RunResult.sub_runs`. Each sub-agent's iteration_log nests inside;
  customers can drill into individual entity research without losing the
  parent-level view.
- **System prompt rewritten** — agent is now instructed: "Use
  `refresh_entity` for the bulk of work. Reach for direct `web_fetch` +
  `set_facts` only for cross-entity reasoning."

### What's NOT in this release (queued)

- **Phase C** (v0.1.1) — promote sub-loops to `@cloudflare/agents` Durable
  Objects for true parallelism (concurrent entity refresh) + cross-request
  persistence
- **Phase D** (v0.1.2) — Anthropic prompt-cache integration + recursive
  compaction for long parent loops
- Auto-fan-out — currently the parent must explicitly call
  `refresh_entity(X)` per entity. Auto-batching from a single `query(all)`
  result lands with Phase C.

@frames-ag/tick-types bumped to v0.0.3 (`SubRunSummary` + `RunResult.sub_runs`).

## 0.0.13 — 2026-05-12 (Phase A — Haiku-summarized web fetches)

The biggest cost lever from the post-launch review. Web-fetch results
used to dump up to 64 KB of raw HTML into the agent's context, which
compounded across the loop — iter 4 of a real curate jumped from 13K
to 97K tokens in one shot, every subsequent call cost $0.40-$0.60 just
to feed the same HTML over and over.

### Change
- New `src/llm/summarize.ts` — `summarizeForContext()` runs a Haiku-tier
  call (via `agent: "title"` model routing) against the raw fetched body
  with the dataset schema as the extraction template. Output: ~500-2000
  tokens of structured per-field excerpts. The agent never sees raw HTML.
- `dispatchWebFetch` in both `curate.ts` and `discover.ts` now calls
  `summarizeForContext` and returns the summary as the `tool_result`.
  Total cost = fetch cost + summarizer LLM cost; reported in `tool_log`.
- `web_fetch` tool definitions updated with `entity_hint` param so the
  agent can tell the summarizer which entity the page is about — focuses
  the extraction.
- Falls back to a stripped-HTML excerpt when Haiku times out so the agent
  always gets something useful.

### Cost impact (projected)
On the same 5-fetch curate run we measured at v0.0.12:
- v0.0.12: ~$3.13 (9 iters × $0.30-$0.60 each due to compounding context)
- v0.0.13: ~$0.30-$0.50 expected (Haiku summarization is ~$0.005 per fetch;
  parent context stays under ~30K tokens through the loop)

Real numbers from the next live curate run will land in the CHANGELOG
note for v0.0.14.

### Model routing — already wired
`agent: "title"` was plumbed since v0.0.0 but never invoked at a real
call site. The summarizer is the first production caller. Title model
default: `anthropic/claude-haiku-4-5` (~$1/$5 per 1M tok, ~3x cheaper
than Sonnet 4.6 input / ~3x cheaper output).

### What's NOT in this release
- Phase B (per-entity sub-loops) — separate v0.1.0 release
- Phase C (sub-loops promoted to @cloudflare/agents DOs) — v0.1.1
- Phase D (prompt-cache + recursive compaction) — v0.1.2

## 0.0.12 — 2026-05-12 (privacy gates + iteration_log + budget pre-flight)

Three improvements from the post-launch review:

### Privacy gates on read endpoints
- **`GET /runs/:id`** now requires the caller's `Authorization: Bearer
  <key>` (via `TICK_API_KEYS`) to map to the same agent that created the
  run. Earlier "public by run_id possession" leaked frame URL, agent
  identity, source URLs, and the agent's narrative reasoning. 403 on
  mismatch.
- **`GET /history?address=`** same: caller agent must match the queried
  address.
- **`DELETE /history?address=`** adds bearer-token path alongside the
  existing x402-verify path. Either works (whichever is configured), and
  both require identity match.
- New helper `resolveCallerAgent(c)` centralizes the bearer lookup for
  read endpoints. Dev mode (no `TICK_API_KEYS` configured) bypasses the
  gate, consistent with closed-by-default on `/run`.

### `iteration_log` in `RunResult`
Top-level `result.iteration_log: IterationLogEntry[]` exposes one entry
per LLM call across the agent loop:
```ts
{ iter, model, input_tokens, output_tokens, cost, stop_reason }
```
Customers can see exactly where their budget went — which iter, which
model served the call (anthropic vs @cf), and what stopped each call.
Curate and discover both populate it. `LlmResponse.model` is now part of
the LlmClient surface; `IterationLogEntry` is exported from
`@frames-ag/tick-types@0.0.2`.

### Budget pre-flight check
When a caller passes an explicit `budget` to curate/discover that's
less than 50% of the calibrated default, `/run` returns 400 with a
`recommended_budget` hint instead of dispatching. Prevents the
"0 events" failure mode we hit live with a $0.50 curate that burned
$1.40 of Claude tokens.

@frames-ag/tick-types bumped to v0.0.2.

## 0.0.11 — 2026-05-12 (retry transient upstream errors)

Wraps `callAnthropic` in the existing `retry` helper. Real run hit
"Anthropic 529 (via AI Gateway): Overloaded" — upstream transient.
3 retries, 1s initial delay, exponential backoff. Default predicate
catches status >= 500 + network errors; 4xx fails-fast.

## 0.0.10 — 2026-05-12 (budget guard + narrative surfacing)

Three small changes from real-run learnings. Live `curate` against
`ai-agent-wallets-eu` (Claude Sonnet 4.6 via CF marketplace) blew $1.40
of LLM tokens against the prior $1.50 default ceiling and produced 0
events because the safety_floor guard only tracked tool spend.

### Default budgets bumped (`packages/tick-types`)
- `curate`:   $1.50 → **$3.00**
- `discover`: $0.50 → **$1.50**
- `refresh`:  $0.30 → **$0.50**
- `verify`:   $0.15 (unchanged — no LLM)

Flagship LLM tokens dominate the budget; the old numbers were
calibrated for cheaper models + tool-spend-only guards.

### LLM-cost-aware budget guard (`curate.ts` + `discover.ts`)
- Track `maxLlmCostSeen` across iterations.
- Before each new iter, project next LLM call as `1.2 × maxLlmCostSeen`.
- Halt early when `remaining < projected + safety_floor`.

Previously the agent could run a full iteration into a budget shortfall,
post-hoc detect it, then spend ANOTHER call asking for a wrap-up —
overrunning by 2×. The new projection halts BEFORE the overrun.

### `RunResult.narrative` (top-level)
The model's one-paragraph wrap-up (previously buried in
`report.llm_summary`) now also lives at `result.narrative`. It's the
single most human-readable output of any run and customers shouldn't
have to dig for it.

Example from a real run:
> *"This curate tick read the full current state of the
> ai_agent_wallets_eu dataset (13 entities) and performed live
> verification... Budget constraints prevented completing set_facts
> writes for Ovra's founded_year (2025, confirmed from structured
> data) and last_news_url/last_news_date updates for Wirex and other
> entities... Recommended follow-up actions for the next tick:..."*

That narrative is high-quality customer-facing output; promoting it
surfaces it in the response shape directly.

@frames-ag/tick-types bumped to v0.0.1 (RunResult.narrative addition).

## 0.0.9 — 2026-05-12 (live end-to-end via CF marketplace + cleanup)

First fully-live `curate` run against Claude Sonnet 4.6 via Cloudflare
marketplace billing — no Anthropic account, CF pays Anthropic from the
gateway's prepaid balance.

### Required gateway path: native Anthropic Messages API
Both `env.AI.run("anthropic/...")` AND `/compat/chat/completions` have
server-side bugs translating tool_use blocks for Anthropic models —
they strip or mis-map `tool_use.id` on the way to Anthropic's parser.
**The native `/anthropic/v1/messages` path works correctly** with marketplace
billing when called with `Authorization: Bearer <gateway-token>` (no
`x-api-key`, no BYOK alias).

### `callAnthropic` auth ladder (v0.0.9)
1. `byokAlias` set       → `cf-aig-byok-alias` header (gateway holds key)
2. `anthropicApiKey` set → `x-api-key` header (passthrough; your Anthropic bills)
3. `gatewayToken` only   → `Authorization: Bearer` (**marketplace; CF bills**)
4. else                  → error

The third case is the v1 happy path: set `AI_GATEWAY_URL` +
`AI_GATEWAY_TOKEN` + fund the gateway in the dashboard. Tick handles
the rest.

### Removed
- `callGatewayCompat` (broken for Anthropic — never landed as a customer path)
- The Anthropic branch of `callAiBinding` (same bug as compat)
- Debug logging from the binding path

### Live validation
```
curate · ai_agent_wallets_eu@e4f9cef · 5 iter · 1 events · 8 tool calls
```
End-to-end through tick.microchipgnu.workers.dev with bearer-token auth,
allowlist gate, service binding to frames-cloud, and Anthropic via
marketplace.

## 0.0.8 — 2026-05-12 (AI binding — CF bills for Anthropic via marketplace)

Adds support for CF's **Workers AI binding marketplace routing**:
`env.AI.run("anthropic/claude-sonnet-4-6", ...)` calls Anthropic's flagship
through Cloudflare's edge, with **Cloudflare billing you directly** — no
Anthropic account or API key needed.

This was the missing path: previous releases assumed Anthropic models
always required an external Anthropic account (BYOK or passthrough). CF's
marketplace handles billing for partnered third-party providers (Anthropic,
OpenAI, Google, etc.) when called through `env.AI.run`.

### Config
```toml
# wrangler.toml
[ai]
binding = "AI"
```

```bash
# Optional: route AI binding calls through your gateway for logging.
wrangler secret put AI_GATEWAY_SLUG    # → e.g. "frames-ai-gateway"
```

When the binding is present, `LlmClient` automatically routes
`anthropic/*` and `@cf/*` models through `env.AI.run()` — preferred over
HTTP paths because it stays inside CF's edge with no extra hop.

### Implementation
- `LlmClient.callAiBinding()` handles both shapes:
  - `anthropic/*` → Anthropic Messages API body, native response shape
  - `@cf/*` → OpenAI-compat body, translated back to Anthropic-shape via the existing helpers
- Optional `{ gateway: { id } }` routing for the gateway logging dashboard
- `/health.llm.ai_binding_present` + `ai_binding_gateway_slug` surface state

### Priority order in `LlmClient.call()`
1. **AI binding** (env.AI) — for `@cf/*` AND `anthropic/*` models. CF billing.
2. **Workers AI HTTP** — for `@cf/*` when no binding (e.g. Bun dev). CF billing.
3. **AI Gateway BYOK** — for `anthropic/*` when binding absent. Anthropic billing via your stored key.
4. **Direct Anthropic** — for `anthropic/*` with `ANTHROPIC_API_KEY` set. Anthropic billing.

The right default for v1 hosted is path 1 — flagship quality, CF billing,
no operator-side Anthropic account to manage.

110 tests still passing.

## 0.0.7 — 2026-05-12 (Workers AI mode — CF-hosted models, CF-billed)

Adds a third LLM auth path: **Workers AI**. Routes `@cf/*` models to
Cloudflare's hosted catalog (Llama 3.3 70B, Qwen QwQ-32B, Gemma, etc.).
Cloudflare bills you directly per-token — no Anthropic / OpenAI / Google
account required.

### Why
Customers who want to skip the provider-account dance can pay CF for
tokens. Tradeoff: Workers AI's catalog is open-weight only (no Claude /
GPT-4 / Gemini Pro). For agent loops with tool use, `llama-3.3-70b-
instruct-fp8-fast` is the recommended default — decent at function
calling, fast inference, low cost (~$0.29 / $2.25 per 1M tokens).

### Config (per `apps/tick/DEPLOY.md`)
```bash
wrangler secret put CF_ACCOUNT_ID         # 97c691...
wrangler secret put WORKERS_AI_TOKEN      # CF API token w/ Workers AI:Run scope
wrangler secret put WORKERS_AI_MODEL      # @cf/meta/llama-3.3-70b-instruct-fp8-fast
```

When all three are set, `LlmClient.call()` prefers Workers AI over the
Anthropic / BYOK paths regardless of per-agent model defaults.

### Implementation
- `LlmClient.callWorkersAi()` — POSTs to `api.cloudflare.com/.../ai/v1/chat/completions` (OpenAI-compat shape).
- **Shape translators** (`anthropicToOpenAiMessages`, `openAiFinishToAnthropicStop`) — translate Anthropic-style messages + tool_use blocks ↔ OpenAI-style messages + tool_calls. The ops (curate/discover) keep returning Anthropic-shape `LlmResponse` so they don't need to change.
- Per-token pricing for the common `@cf/*` models added to the `PRICES` table.
- `/health.llm.workers_ai_configured` surfaces config state.
- `missing_llm_auth` error message updated to include the new path.

110 tests still passing — the Workers AI path doesn't affect any existing test (Anthropic-shape goes through the same code paths it always did).

## 0.0.6 — 2026-05-12 (fix: rewrite workspace:* deps for npm install)

v0.0.5 published cleanly to npm but with `workspace:*` left in the
`dependencies` field for `@frames-ag/payment-tempo` and
`@frames-ag/tick-types`. `npm install`/`npx` can't resolve that protocol
(it's a bun/pnpm-only specifier), so `npx -y @frames-ag/tick@0.0.5` fails
with `EUNSUPPORTEDPROTOCOL`. `bun publish` (which the CI Release workflow
ended up using through `bunx changeset publish`) doesn't rewrite workspace
specifiers the way `npm publish` does.

Fix: replace `workspace:*` with the actual semver in tick's package.json.
Bun's local install still resolves the workspace members by name + version,
so `bun install` at the monorepo root is unaffected.

No code changes; just the install path for downstream consumers.

## 0.0.5 — 2026-05-12 (customer prompt auto-discovery)

Closes the `frames-examples` migration gap: customers keep their existing
`<dataset>/prompt.md` files in place. The CLI auto-discovers them from the
frame URL's path component (relative to cwd) and POSTs the contents as
`params.customer_prompt`. No migration script, no README-section convention
imposed.

### What changed
- **`src/cli.ts`** — `resolveCustomerPrompt()`: auto-discovers `prompt.md` from the path component of the frame URL (`https://github.com/<user>/<repo>/datasets/foo` → `./datasets/foo/prompt.md`). Falls back to `./prompt.md` for whole-repo frames. Flags: `--prompt-file <path>` (explicit override, errors if missing) and `--no-prompt` (skip discovery). Logs the resolved path to stderr so CI runs show which prompt was picked up.
- **`/run` handler** — extracts `body.params.customer_prompt`, validates it's a string, hard-caps at 32 KiB (DoS guard), forwards to `curate()` / `discover()` via `sharedLlmOpts.custom_prompt`. Logs `customer_prompt_attached` with byte count.
- **`CurateOptions.custom_prompt`** + **`DiscoverOptions.custom_prompt`** — both now formally declare the option (`buildCurateSystem` already consumed it; the field just wasn't wired in).
- **`buildDiscoverSystem`** — appends the customer prompt under a "Customer instructions (from prompt.md)" header, matching curate's pattern.
- **6 new tests** across `test/prompt-discovery.test.ts` (path inference) and `test/curate.test.ts` (system prompt contains the custom prompt verbatim). 110/110 green.

### Auth ladder summary (after v0.0.4 + v0.0.5)
1. `TICK_API_KEYS` Bearer token (v0.0.4) → stable customer identity
2. x402-verified payer (v0.0.3) → wallet identity when facilitator configured
3. IP-hashed fallback → dev/smoketest

### Migration for `frames-examples`
Per the updated `MIGRATION.md`: workflow-file change only. No `prompt.md` files need to move. The CLI picks them up automatically when invoked from the repo root. See `drafts/frames-examples-migration-pr.md` for the ready-to-push PR.

## 0.0.4 — 2026-05-12 (bearer-token mode for closed alpha)

Adds `TICK_API_KEYS` — a comma-separated list of `<key>:<agent-identifier>` pairs that maps Bearer tokens to stable agent identities. Lets closed-alpha customers authenticate before Phase B x402 billing ships, without depending on the brittle IP-hash fallback (GitHub Actions runners rotate IPs).

### Auth ladder, weakest first

1. **`TICK_API_KEYS` Bearer token** (v0.0.4) — stable customer identity via `Authorization: Bearer <key>` or `X-Tick-API-Key: <key>`. Server maps the key to a configured agent identifier (e.g. `frames-runtime:0xCustomerA`).
2. **x402 verified payer** (v0.0.3) — when the facilitator is configured, the verified wallet becomes the agent automatically. No shared secrets.
3. **IP-hashed fallback** — for unauthenticated dev / smoketest traffic.

A Bearer token that doesn't match a configured key returns **401 immediately** (does NOT fall through). Prevents an attacker from sending a junk key and silently getting IP-hash auth.

### What changed
- **`src/api-key.ts`** (new) — `parseApiKeys()`, `extractBearerToken()`, `lookupApiKey()`. Accepts both `Authorization: Bearer <key>` and `X-Tick-API-Key: <key>`. Constant-time comparison resists naive timing attacks.
- **`/run` handler** — bearer-token lookup happens before x402 verify; matched key → use mapped agent, no-header → fall through to x402/IP, bad header → 401 `invalid_api_key`.
- **`/health.hosted.api_key_count`** surfaces how many keys are configured (smoke check: is auth set up?).
- **20 new tests** (`test/api-key.test.ts`) — parsing (empty, malformed, colon-in-agent), header extraction (Authorization + X-Tick-API-Key + precedence), lookup (matched / unmatched / no-config-but-header-sent / constant-time). 104/104 green overall.

## 0.0.3 — 2026-05-12 (x402 v2 native + Phase B unblocked)

Rewrote inbound payment verify + settle to be **canonical x402 v2 native**
instead of the prior Faremeter-style custom shape. CDP and upstream Faremeter
(v0.21.0+, which negotiates to v2) now both work as facilitators with **no
adapter layer** — same client code, configurable endpoint.

### What changed
- **`src/payment/types.ts`** (new) — full TypeScript types for `PaymentRequirements`, `PaymentPayload`, `PaymentRequiredResponse`, `FacilitatorVerifyResponse`, `FacilitatorSettleResponse`. Field names match the [x402 v2 spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) exactly.
- **`src/payment/payment-requirements.ts`** (new) — `buildPaymentRequirements(env, op, budget)` constructs the spec-shaped `PaymentRequirements` from operator env (`TICK_PAY_TO_ADDRESS`, `TICK_PAY_NETWORK`, `TICK_PAY_ASSET`, `TICK_PAY_SCHEME`, `TICK_PAY_MAX_TIMEOUT_SECONDS`). Scheme defaults: `erc3009` on EVM-shaped networks, `spl-token` on Solana. Asset defaults to USDC on Base mainnet. `usdcToSmallestUnit()` helper converts decimal to 6-decimal integer string.
- **`src/payment/x402.ts`** rewritten:
  - Reads `PAYMENT-SIGNATURE` header (base64-encoded `PaymentPayload`)
  - POST `{ x402Version: 2, paymentPayload, paymentRequirements }` to facilitator `/verify` and `/settle`
  - Parses canonical responses (`isValid` / `invalidReason` / `payer` on verify; `success` / `errorReason` / `transaction` / `network` / `amount` on settle)
  - Trailing-slash normalization on facilitator URL
  - Optional `facilitatorAuthHeader` param for CDP API-key injection
  - `decodePaymentPayload()` exported for tests / external use; handles both standard base64 and base64url
- **`/run` handler** now emits **402 challenges** with `{ x402Version: 2, error, resource, accepts: [paymentRequirements] }` body when strict mode (FACILITATOR_URL + TICK_PAY_TO_ADDRESS set) sees a request without the header. Clients sign and retry with the header, exactly per spec.
- **`attemptSettle`** now passes the verified `paymentPayload` + `paymentRequirements` through to `settleX402` instead of synthesizing fields. Stamps the real `transaction` hash from the facilitator onto the run row.
- **`DELETE /history`** identity-gate uses a zero-amount `PaymentRequirements` as the proof-of-identity vehicle.
- **27 new x402 tests** (`test/x402.test.ts`) — `usdcToSmallestUnit`, `buildPaymentRequirements`, `decodePaymentPayload` (round-trip + malformed + missing fields), and the full verify/settle wire shapes (mocked global fetch). Asserts that the request body is spec-shaped (`x402Version` + `paymentPayload` + `paymentRequirements`) and explicitly NOT custom-shaped. 84/84 green overall.

### Phase B is now genuinely unblocked

Coinbase CDP integration drops to a few env vars instead of an adapter rewrite:

```bash
wrangler secret put FACILITATOR_URL          # https://api.cdp.coinbase.com/v2/x402
wrangler secret put TICK_PAY_TO_ADDRESS      # operator wallet
wrangler secret put TICK_PAY_NETWORK         # base (or solana-mainnet, etc.)
# Plus CDP API auth headers if/when CDP needs them — passed via the
# facilitatorAuthHeader param when calling verify/settle.
```

The 2026-05-12 finding that "CDP isn't drop-in" is now obsolete — it was true against our pre-rewrite custom-shape client; the rewrite removed that gap.

### Migration note for existing callers

If any code outside this repo calls `verifyInboundX402` or `settleX402` directly,
**signatures changed**:
- `verifyInboundX402(req, facilitatorUrl, body, opts)` → `verifyInboundX402(req, facilitatorUrl, paymentRequirements, opts)`
- `settleX402(req, facilitatorUrl, amount, payer, network)` → `settleX402(facilitatorUrl, paymentPayload, paymentRequirements, opts)`

Response field renames: `valid` → `isValid` (internal), `tx_hash` → `transaction`.

## 0.0.2 — 2026-05-12 (v1 hosted gating + npm pre-publish)

Closes the "hosted v1 = no facilitator" path. The hosted `/run` endpoint
now ships with a deterministic agent allowlist (`TICK_ALLOWED_AGENTS`)
that's **closed by default**. Fresh deploys 403 every call until an
operator explicitly opts in callers, preventing accidental open-endpoint
abuse before x402 billing is wired.

Plus full npm publish prereqs: MIT LICENSE at monorepo root + apps/tick,
license / repo / homepage / bugs / keywords / engines metadata in
package.json, trimmed npm tarball (341.6 kB → 119.8 kB packed, 1.7 MB →
564.4 kB unpacked) by dropping internal PLAN.md and the dist/cli.js source
map from the published files.

### Hosted gating
- **`src/allowlist.ts`** — `parseAllowlist` + `checkAllowlist` with exact-match, prefix-glob (`ip:7f1a*`), and `*` open-gate sentinel
- **`/run` middleware** — 403 + `agent_not_allowlisted` for un-whitelisted callers (`src/app.ts`)
- **`/health.hosted`** — surfaces `allowlist_entries`, `allowlist_open`, `closed_by_default`. The third flag is the smoke-check operators use to confirm the gate is configured
- **14 new allowlist tests** (`test/allowlist.test.ts`) — undefined env, empty env, exact match, prefix glob, wildcard, case-sensitivity. 57/57 green overall
- **Smoke test extended** — fresh `POST /run closed` case verifies the closed-by-default 403 behavior end-to-end

### Documentation
- **`DEPLOY.md` rewritten** to lead with the v1 happy path: no facilitator, allowlist-gated, CLI publish included. The facilitator path is demoted to "Phase B — when to add" with both CDP and self-host options documented
- **CLI publish step** (`npm publish --access public`) added as an explicit deploy stage
- **`/health` example** updated with the v1 hosted-mode shape (`facilitator_configured: false` is intentional, not a missed config)
- **`STRATEGY.md`** at monorepo root — value-capture options + current hosted-tick bet + the catalog correction

## 0.0.1 — 2026-05-11 (pre-alpha, hardening pass)

Built on top of v0.0.0; closes 10 remaining audit gaps end-to-end.

### Inbound payments
- **x402 verify wired into `/run`** (`src/payment/x402.ts`). Auto-strict when `FACILITATOR_URL` is configured: payment headers are required, the facilitator is authoritative, 401 on rejection. Falls back to optional mode when `FACILITATOR_URL` is unset (dev). Verified payer replaces the IP-hashed identity for the rest of the run.
- **Settle wired** — `attemptSettle()` runs after every successful op, calls `settleX402` against the facilitator, and stamps the returned `tx_hash` onto the run row via `persistFinalize`. Skips silently when no facilitator, no verified payer, or zero-cost run. Settle failures log but never fail the op.
- **Receipt signing** (`src/payment/audit-signer.ts`) — ed25519 over canonical JSON of every `tool.invoked` receipt. Key bootstrapped from `AUDIT_PRIVATE_KEY` (32-byte hex/base64url seed, PKCS8-wrapped for WebCrypto). When unset, receipts ship unsigned and `/health` surfaces `audit_key_configured: false`. 8 unit tests cover canonical-JSON determinism, key loading, and the signature-field-exclusion invariant.
- **`DELETE /history` hardened** — when `FACILITATOR_URL` is set, requires a verified x402 payment header AND the payer must match `?address=`. Third parties can no longer purge another wallet's runs even with knowledge of the address.

### Runtime
- **SSE streaming on `/run` — now progressive**. Opt-in via `Accept: text/event-stream`. Emits `started` immediately, `frame_event` for each frame event the moment the op produces it (no buffering), `heartbeat` every 5s, terminal `completed` (full RunResult) or `error`. Plumbed via an `onEvent` callback threaded through all four ops (curate / discover / verify / refresh).
- **discover latent bug fixed**: previously discarded `tool.invoked` receipts (and `r.event` from paid web_fetches). Now collects them into `OpOutcome.events` so spend is auditable and citable from the `propose_entity` review queue.
- **Batched D1 writes** in `persistFinalize` — single `db.batch()` collapses N tool_calls + N events + 1 run update into one round-trip. Sequential-write fallback on batch failure so partial receipts still land.
- **GDPR right-to-erasure** — `DELETE /history?address=<wallet>` purges runs (cascading to tool_calls + events).
- **Idempotency-Key support** on `POST /run` — replays terminal results, 409s on in-flight matches.

### Library surface
- **`@frames-ag/tick` programmatic entry** — `src/lib.ts` re-exports the four ops, the FrameClient, the CatalogClient, the LlmClient, and the payment helpers. `package.json` ships `types: dist/types/lib.d.ts` so embedders get full TS surface.
- **Build** now emits both `dist/cli.js` (Node shebang) and `dist/types/` (declarations) via `tsconfig.build.json`.

### Tests + docs
- **5 new curate-loop tests** (`test/curate.test.ts`) — end_turn, max_iters, max_tokens, unrecognized stop_reason, budget exhaustion, plus an onEvent progressive-callback assertion.
- **8 new audit-signer tests** (`test/audit-signer.test.ts`) — canonical-JSON determinism, hex seed loading, no-key fallback, signature stability across key permutations, signature-field exclusion. 43/43 green overall.
- **Smoke test extended** (`scripts/smoketest.ts`) — now covers `/history` + `DELETE /history` gating and live-validates the SSE response actually emits `event: started` in the first chunk.
- **README refreshed** — full endpoint table including `DELETE /runs/:id`, `DELETE /history`, `Idempotency-Key` and `Accept: text/event-stream` headers, the SSE frame protocol, and the `AUDIT_PRIVATE_KEY` secret. Links to `DEPLOY.md` + `MIGRATION.md`.
- **`DEPLOY.md`** — operator runbook from clone to live (facilitator + runtime + day-2 ops + failure modes).
- **`MIGRATION.md`** — guide for `frames-examples` / `blindspot.news` to swap from `opencode run` → `npx -y @frames-ag/tick curate` (or the hosted `POST /run`).
- **PreMortem document marked HISTORICAL** with a status block tracking which 2026-05-11 risks have shipped mitigations.

## 0.0.0 — 2026-05-11 (pre-alpha)

Initial development. All code shipped in a single intensive session; not yet on npm.

### Operations

- **`verify`** — read-only re-fetch of every fact's source URL. Classifies drift across five kinds: `source_dead` / `value_drift` / `excerpt_missing` / `source_redirect` / `verified`. No frame mutations.
- **`refresh`** — verify iteration + emits real frame events: `fact.deprecated` for dead/drifted sources, `evidence.attached` for redirects. Falls back to `report.skipped_for_missing_fact_id` when frames-cloud doesn't surface fact_ids.
- **`curate`** — full agent loop with 9 tools: `query` + 4 frame writes (`add_entity_with_facts`, `set_facts`, `deprecate_fact`, `attach_evidence`) + 3 catalog tools (`catalog_search`, `catalog_get`, `tool_invoke`) + `web_fetch` fallback. LLM-driven; budget enforced per-turn.
- **`discover`** — search-only candidate proposer. Same agent-loop shape as curate but mutation tools replaced with `propose_entity`; candidates land in `report.candidates[]` for human review queue rather than the frame.

### Architecture

- **Cloudflare Workers** runtime, Hono entrypoint, extends the `agents` SDK base
- **D1 persistence** — `runs` / `tool_calls` / `events` tables (3 + 8 indexes) keyed by `run_id`, fail-open writes, cascade-delete
- **Cloudflare AI Gateway (BYOK)** for LLM routing — gateway holds provider keys; tick references them by alias. Passthrough fallback for dev. Model strings prefixed `<provider>/<model-id>`.
- **`@faremeter/fetch wrap()`** for outbound paid HTTP — auto-negotiates x402 v1/v2 and MPP across Solana + Base + Tempo. Single fetch wrapper handles all three protocols transparently.
- **`@frames-ag/payment-tempo`** (in monorepo) plugs MPP-on-Tempo into the wallet stack — no Stripe dependency in tick's critical path.
- **Self-custody wallets** — env-loaded keys (`SOLANA_OUTBOUND_KEYPAIR_JSON`, `EVM_OUTBOUND_PRIVATE_KEY`). EVM key serves both Base x402 and Tempo MPP.
- **Catalog-mediated discovery** via [catalog.frames.ag](https://catalog.frames.ag) (5,797 ToolDescriptors). Pre-checks `payment.price_hint` against remaining budget before signing. Server-side filter on `quality.l30DaysTotalCalls > 0` (spam prevention).
- **Per-IP rate limits** — sliding-window check via D1 (60s + 3600s). Identity flips to wallet address when SIWX signature verification lands.

### Endpoints

- `POST /run` — dispatch the four ops; supports `verify` / `refresh` / `curate` / `discover`
- `GET /runs/:id` — full receipt (run + events with parsed payloads + tool_log)
- `GET /history?address=<wallet>` — list runs by agent
- `GET /balance` — wallet config summary
- `GET /health` — `{ ok, ts, db, wallets: { solana, evm } }`

### Distribution

- **MCP server** — `bun src/cli.ts mcp` runs the stdio MCP server exposing `runtime.curate / refresh / verify / discover` as tools for any MCP-aware harness (opencode, Claude Code, Codex CLI, Cursor)
- **Compiled CLI** — `bun run build` produces `dist/cli.js` (482 KB) with Node-compatible shebang; ready for `npx -y @frames-ag/tick` post-publish
- **SKILL package** — `apps/tick/skill/{SKILL.md, skill.json}` matching `frames-engineering/skills` format

### Testing

- **23 unit tests** across `test/{rate-limit, frame-client, verify}.test.ts` (Bun test, ~15ms)
- **Smoke** (`bun run smoke`) exercises `GET /`, `GET /health`, `POST /run verify` (gracefully skips when frames-cloud isn't reachable), bad-op rejection
- **Live-validated** against `microchipgnu/ai-agent-wallets-eu`: 13 entities, 65 fields checked, 36 verified, 29 drifts via local frames-cloud

### Frame protocol contribution

- Contributed `run_id` envelope field + `facts.set_many` event type upstream to `packages/frame` (v0.2.0). PROTOCOL.md + types.ts + projector.ts + CHANGELOG.md updated; typecheck clean.

### Open / external-auth blocked

- Real SIWX signature verification (replaces IP-hashed identity; verify now overrides agent when the facilitator returns a payer). Production settle is wired and fires after every successful run when the facilitator is deployed.
- Tempo MPP end-to-end against a real seller (requires funded Tempo wallet)
- Sub-agent routing via `@cloudflare/think` facets (currently `agent: title|build|explore` only picks model)
- Workers-native Faremeter facilitator fork (currently CF Containers via Path 1)

See [PLAN.md §9](./PLAN.md#9-build-plan--status-as-of-2026-05-11) for full status.
