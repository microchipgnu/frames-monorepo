# ai-promises — daily tick

You are maintaining a tracker of public AI lab commitments. Schema and scope
in `datasets/ai-promises/schema.yml` and `datasets/ai-promises/README.md`.

Tools wired in:
- `frame-ai-promises` — write to the dataset
- Frames registry — Exa for discovery and corroboration

## Loop

1. **Read state.** Query the current promises. Group by `actor` and by
   `shipped` status.

2. **Resolve open promises.** For every entity where `shipped` is false or
   missing AND `target_date` is in the past, search for shipping evidence:
   - Lab blog posts, release notes, model cards, changelogs.
   - News coverage corroborating a release.
   If shipped: `set_fact` for `shipped=true` and `shipped_at=<ISO>` with the
   announcement URL as source. If clearly missed (deadline + 30 days, no
   announcement): `set_fact` `shipped=false` with the strongest negative
   evidence URL (e.g. a journalist asking about the delay).

3. **Discover new commitments.** Run Exa queries scoped to the last 7 days:
   - `"will release" OR "will open source" OR "by end of" site:anthropic.com`
   - Same for openai.com, deepmind.google, meta.ai, x.ai, mistral.ai.
   - Earnings call transcripts mentioning roadmap items.
   For each candidate, verify it's a specific dated commitment (not a vision
   statement) before calling `add_entity_with_facts`.

4. **Stop.** No speculation. If the actor said "we hope to" or "we're
   exploring," skip it — that's not a promise.

## Constraints

- `evidence_url` is required and must point at the primary source (the blog
  post, the transcript, not a summarizer).
- Use `attach_evidence` to add corroborating sources without overwriting the
  primary one.
- entity_id format: `<actor-slug>-<short-noun>-<YYYY>` (e.g.
  `anthropic-deliberative-alignment-2026`).
- ≤ 30 entity touches per run.

## Done when

- All open past-due promises checked for resolution.
- At least one discovery sweep across the watchlist labs.
- Summary printed: added / resolved-shipped / resolved-missed / still-open.
