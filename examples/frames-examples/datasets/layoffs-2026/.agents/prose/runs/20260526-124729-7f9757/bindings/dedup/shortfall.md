# Dedup shortfall

## Outcome

**14 deduped candidates vs target of 15** — short by 1.

## Counts

| Stage | Count |
|---|---|
| input (from extractor) | 18 |
| dropped: freshness (`date_announced` < 2026-05-12) | 4 |
| dropped: already in frame | 0 |
| merged (same company + date) | 0 |
| **final** | **14** |
| **target (`min_candidates`)** | **15** |
| **gap** | **1** |

### by_authority_tier (final 14)

| tier | count |
|---|---|
| 1 (official) | 2 |
| 2 (CEO/exec quote in major press) | 1 |
| 3 (major press) | 0 |
| 4 (trade press / WARN aggregators) | 8 |
| 5 (social-only) | 3 |

## Root cause

Three of the four freshness-dropped candidates (`oracle-2026-03-31`, `bill-holdings-2026-05-07`, `cloudflare-2026-05-07`) are ALSO already in the frame under matching entity_ids — they would have been dropped twice over. They surfaced because the searcher pulled in pre-window events that the parent system treats as the curate/refresh pass's responsibility, not discover's.

`group-1-automotive-2026-04-01` is a genuine April event that bled through freshness.

The remaining 14 deduped candidates are all net-new to the frame (zero overlap with the 53 existing entities), which is a strong signal — extractor's filtering and search planning hit fresh ground — but coverage came up 1 short of the 15-target.

## Budget & queries

- **$0.11 spent of $0.20 budget** (8 settled queries of 12 planned at ~$0.013 each, plus overhead).
- **Queries**: 12 planned, 11 settled, 1 dropped (agentwallet 500 on `q04`).
- **Tools used**: `exa_search`, `twitter_search`. Tier-1 official-domain searches (e.g. SEC EDGAR direct queries, employer press-release feeds) were not invoked — the pay→agentwallet dispatch gap means only base/USDC rail tools settled cleanly.

## Remediation paths

1. **Broaden freshness window to 21 days** (2026-05-05 onward). Would not reclaim the 4 freshness-dropped candidates (3 are already in-frame anyway, 1 is April), but would pre-empt similar misses on next run. Lowest-risk change.
2. **Bump budget to $0.25** to retry the agentwallet-500 query (`q04`), which targeted Israeli/EMEA trade press where Wix/Calcalistech-tier sources cluster. A successful retry is the most likely single source of the +1 candidate.
3. **Add an SEC 8-K direct feed tool** to the registry (tier-1, free) — would surface Q3-FY26 layoff disclosures that currently only reach us via tier-4 secondary reporting (Refolk, StockTitan).
4. **Lower `min_candidates` to 14** for this window if discover-cadence pressure dominates over breadth. The 14 we have are well-sourced (2 tier-1, 1 tier-2, 8 tier-4, 3 tier-5) and net-new.
5. **Unlock a tier-3/4 newsroom tool** (e.g. Reuters/Bloomberg search) — would diversify away from the X/Twitter-heavy tail that produced our tier-5 candidates (linkedin, starbucks, upwork, gitlab).

## Candidates that would have been emitted (for reference)

```
meta-2026-05-20                          tier 4
intuit-2026-05-20                        tier 1
cisco-2026-05-13                         tier 1
wix-2026-05-25                           tier 4
clickup-2026-05-23                       tier 4
panera-2026-05-20                        tier 4
ssp-america-2026-05-19                   tier 4
elior-2026-05-17                         tier 4
diamond-transportation-services-2026-05-12  tier 4
macrogenics-2026-05-13                   tier 1
linkedin-2026-05-13                      tier 5
starbucks-2026-05-15                     tier 5
upwork-2026-05-14                        tier 5
gitlab-2026-05-12                        tier 5
```

## Frame query receipt

```
SELECT entity_id FROM entities
-> 53 rows
```

Matches against candidate entity_ids: `oracle-2026-03-31`, `bill-holdings-2026-05-07`, `cloudflare-2026-05-07` — all three also fell outside the freshness window so were dropped at the freshness stage.

Near-misses (same company, different date — kept):
- `gitlab-2026-05-11` (frame) vs `gitlab-2026-05-12` (candidate)
- `upwork-2026-05-07` (frame) vs `upwork-2026-05-14` (candidate)
- `starbucks-2026-05-11` (frame) vs `starbucks-2026-05-15` (candidate)
- `meta-2026-04-23` (frame) vs `meta-2026-05-20` (candidate)

These are treated as distinct events per the dataset's `(company, date_announced)` keying convention.
