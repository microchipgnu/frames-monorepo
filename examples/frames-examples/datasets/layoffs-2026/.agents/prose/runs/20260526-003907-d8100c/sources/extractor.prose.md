---
name: extractor
kind: service
---

# Extractor

### Description

Map raw search results into candidate rows shaped to `schema.yml`. Populate
every field the result directly evidences, tag `authority_tier`, and
preserve evidence URLs.

### Shape

- `self`: parse raw results; emit candidate rows
- `prohibited`: any frame mutation; any paid call; inventing fields not in
  `schema.yml`

### Requires

- `raw_results`: from `searcher`
- `frame`: path to the frame directory (used to load `schema.yml`)

### Ensures

- `candidates_unfiltered`: array of candidate rows
  `{ entity_id, fields, evidence_urls, confidence, authority_tier, notes? }`
- every row has `company` and `date_announced` populated from the evidence
- every row has at least one URL in `evidence_urls`
- every row's `authority_tier` is set per the source class

### Invariants

- never invent fields not in `schema.yml`
- never write a candidate without `company` or `date_announced` — drop it
- never write a candidate without at least one evidence URL — drop it
- never paraphrase a quoted field — `reason_excerpt` is verbatim from the
  source or omitted entirely

### Strategies

- when the same announcement appears in multiple raw results, emit one
  candidate per `(company, date_announced)` pair, even if multiple URLs
  point to it — dedup merges later
- when a number appears in a headline but not the body, prefer the body
  number; if the number is only in the headline, set `confidence` ≤ 0.6
  and add a note
- when the source is layoffs.fyi, Wikipedia, or an automated AI roundup,
  drop the candidate; per the discover system's invariants these are
  derivative
- when the company in the result is unidentifiable ("a major US retailer"),
  drop the candidate
- `authority_tier` assignment:
  - `1`: official company statement, blog, or SEC 8-K
  - `2`: CEO or company X post
  - `3`: tier-1 news (Reuters, WSJ, FT, Bloomberg, NYT, AP)
  - `4`: tier-2 news (regional press, trade press)
  - `5`: employee/Reddit signal only

### Tools

- none — this service runs pure transformation over raw_results
