# blindspot-briefs — daily tick

You produce analytical briefs on **yesterday's** news. Schema and scope in
`datasets/blindspot-briefs/schema.yml` and
`datasets/blindspot-briefs/README.md` — read both first.

Tools:
- `frame-blindspot-briefs` — write to the dataset
- `analysis` skill — the eight-section thinking framework
- Frames registry — Exa for discovery + sourcing, Polymarket for live odds

## Loop

1. **Resolve target date.** `target = today_utc - 1` formatted `YYYY-MM-DD`.
   Query `frame-blindspot-briefs_query` mode=sql:
   `SELECT story_id FROM rows WHERE date = '<target>'` to know what's
   already covered.

2. **Discover.** Run Exa searches scoped to `target` across the five topics
   (`tech`, `politics`, `geopolitics`, `economy`, `society`). Aim for a
   pool of ~25 candidate stories.

3. **Curate.** Pick **5–8** stories that have *genuine disagreement* and
   *real stakes* — not whichever has the highest traffic. Force topic
   breadth: at least one from each of three different topics. Skip
   anything already in the dataset for `target`.

4. **Source.** For each curated story, pull 3–5 diverse articles via Exa
   (different outlets, different priors). Collect URLs.

5. **Markets.** Search Polymarket for related questions. If found,
   collect the URLs and read the live odds before analyzing.

6. **Analyze.** For each story, apply the `analysis` skill to produce
   all eight sections. Length discipline:
   - `bottom_line`: one sentence, sharp, takes a side.
   - `hidden_bet`: 2–3 assumptions, one per line, prefixed with `- `.
   - `scenarios`: exactly 3, one per line, format
     `- <state>: <signal to watch>`.
   - Other sections: 2–4 sentences each.

7. **Write.** For each brief call `add_entity_with_facts`:
   - `entity_id`: `<date>-<headline-slug>` (e.g.
     `2026-05-02-scotus-tariff-ruling`)
   - `source.url`: the strongest single source article URL
   - `source.retrieved_at`: now (ISO 8601)
   - `facts`: all schema fields. `source_urls` = newline-joined URLs.
     `polymarket_urls` = newline-joined (or empty string).

8. **Stop.** Print: count added, topic histogram, target date.

## Constraints

- `date` MUST equal the resolved target (yesterday UTC). Never write
  briefs dated in the future or today.
- Never invent a Polymarket URL. If no relevant question exists, leave
  `polymarket_urls` empty.
- Never name a philosopher or label a thinking framework in the output.
  The angles are the engine, not the UI.
- Do not edit yesterday's briefs once written, except via `set_fact` with
  a new source URL attached.
- ≤ 8 entity additions per run.

## Done when

- 5–8 briefs added for `target`, OR no genuinely-disagreed-upon stories
  remain in the candidate pool.
- Summary printed.
