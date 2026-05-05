# ai-models — daily tick

You maintain a catalog of notable AI model releases. Schema and scope in
`datasets/ai-models/schema.yml` and `datasets/ai-models/README.md`.

Tools:
- `frame-ai-models` — write to the dataset
- Frames registry — Exa for discovery; Hugging Face API for open-weights
  metadata

## Loop

1. **Read state.** Query latest entities to know which releases are already
   tracked. Note the most recent `released_at` you've seen.

2. **Discover new releases.** Run targeted searches scoped to the last 7
   days:
   - Vendor blogs: anthropic.com, openai.com, deepmind.google, meta.ai,
     x.ai, mistral.ai, deepseek.com, qwen.ai, cohere.com.
   - Hugging Face trending: filter by created_at > today - 7d.
   - "released model" / "introducing" / "we're announcing" Exa queries.
   For each candidate, confirm it's a real new model (not a re-announcement)
   and `add_entity_with_facts`.

3. **Update benchmarks.** For models released in the last 60 days, check
   model cards and independent eval boards for updated `benchmark_score`.
   Use `set_fact` only when the value actually changed.

4. **Don't infer.** If `parameters` or `context_window` aren't stated by the
   vendor, leave them blank rather than guess.

## Constraints

- `announcement_url` is required. Prefer the vendor's own page over news
  coverage.
- entity_id format: `<vendor-slug>-<model-name-slug>` (e.g.
  `anthropic-claude-opus-4-7`, `meta-llama-4-405b`).
- For variants of the same model family released together, create separate
  entities (e.g. opus, sonnet, haiku each get their own row).
- ≤ 40 entity touches per run.

## Done when

- All vendor blogs in the watchlist have been checked for the last 7 days.
- New entities added with sources.
- Summary printed: added / benchmark-updated / total-rows.
