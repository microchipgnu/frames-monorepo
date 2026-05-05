# blindspot-threads

Non-obvious connections across the previous day's `blindspot-briefs`.
One entity per thread. Three kinds:

- **cause-effect** — A → B → C, where A is in one brief and the
  consequence reaches into another that nobody linked publicly.
- **dependency-web** — actors connected through dependencies (supply,
  funding, regulation, attention) that are invisible in any single brief.
- **tension-cluster** — multiple stories secretly about the same
  underlying question.

## In scope

- Connections across briefs from the same date — i.e. `briefs.date ==
  threads.date`. Cross-day arcs are out of scope (for now).
- Threads must reference at least 2 brief entity_ids. Three or more is
  better.

## Out of scope

- Restating what one brief already said. A thread must surface something
  none of the constituent briefs surfaced on its own.
- Generic "AI is everywhere" connections. The bar is *non-obvious* — if a
  market commentator would already say it, skip it.

## Refresh policy

Daily. Each tick reads briefs where `date = today_utc - 1` and writes
threads dated the same day. A given (`date`, `headline`) is never
overwritten.
