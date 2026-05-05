# blindspot-threads — daily tick

You connect **yesterday's** briefs into non-obvious threads. Schema and
scope in `datasets/blindspot-threads/schema.yml` and
`datasets/blindspot-threads/README.md`.

Tools:
- `frame-blindspot-threads` — write to this dataset
- `frame-blindspot-briefs` — read yesterday's briefs (read-only here)
- `analysis` skill — the framework for finding the connecting question

## Loop

1. **Resolve target date.** `target = today_utc - 1` formatted `YYYY-MM-DD`.

2. **Read briefs.** Call `frame-blindspot-briefs_query` mode=sql:
   `SELECT story_id, headline, topic, bottom_line, hidden_bet, who_pays
    FROM rows WHERE date = '<target>'`
   If fewer than 3 briefs exist for `target`, **stop** and print
   "insufficient briefs to thread (n=<count>)" — do not write anything.

3. **Check existing threads.** Query
   `SELECT headline FROM rows WHERE date = '<target>'` on the threads
   dataset to avoid restating what's already there.

4. **Find threads.** Read all briefs together and look for:
   - **cause-effect**: a fact in one brief is the upstream cause of an
     event in another that no one publicly linked.
   - **dependency-web**: 3+ actors connected through dependencies
     (supply, funding, regulation, attention) invisible in any single
     brief.
   - **tension-cluster**: 2+ briefs that are secretly about the same
     underlying question.
   Aim for **2–5** threads. Quality over count. If nothing non-obvious
   shows up, write fewer (or zero) — do not invent.

5. **Write.** For each thread call `add_entity_with_facts`:
   - `entity_id`: `<target>-<kind>-<headline-slug>` (e.g.
     `2026-05-02-cause-effect-tariff-iran-spain`)
   - `source.url`: the URL of the strongest single supporting brief's
     primary source (NOT a frames URL)
   - `source.retrieved_at`: now (ISO 8601)
   - `facts`:
     - `headline`: ≤ 12 words; takes a position on the connection.
     - `narrative`: 3–5 sentences. State the connection plainly. Name the
       briefs by their headlines, not their entity_ids.
     - `brief_ids`: newline-joined `story_id`s of the briefs being
       connected (≥ 2).
     - `signal_to_watch`: one sentence — the specific evidence that would
       confirm the thread next week.
     - `kind`, `date`.

6. **Stop.** Print: count added, kind histogram, target date.

## Constraints

- `date` MUST equal the resolved target. Never write threads dated in the
  future or for a date that has no briefs.
- A thread must reference **at least 2** distinct `brief_ids` from
  `target`. Single-brief threads are not threads.
- Never name a philosopher or label a framework. The angles are the
  engine, not the UI.
- Do not invent a connection to hit a count. Zero threads is a valid
  outcome on a quiet day.
- ≤ 5 entity additions per run.

## Done when

- 0–5 threads written for `target`, OR no non-obvious connections remain
  to surface.
- Summary printed.
