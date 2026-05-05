# blindspot-briefs

Daily analytical briefs on yesterday's news, modeled after the
[blindspot.news](https://blindspot.news) format. One entity per story.
Each brief is the raw material that the `blindspot-threads` dataset
connects across.

## In scope

- Stories from the previous UTC day across five topics: `tech`, `politics`,
  `geopolitics`, `economy`, `society`.
- The eight structured sections: what happened, bottom line, hidden bet,
  real disagreement, what no one is saying, who pays, scenarios, what would
  change this.
- 5–8 briefs per day. Topic breadth matters more than count.

## Out of scope

- Stories more than 48 hours old at first ingest.
- Predictions about events that have not yet occurred (those belong in
  `scenarios`, not as standalone briefs).
- Re-analyzing a brief after it ships. Edits are append-only via `set_fact`
  and require a stronger source.

## Refresh policy

Daily. Each tick analyzes `today - 1` (UTC). A story already covered for a
given date is not re-ingested. Engagement on the source articles is not
tracked.
