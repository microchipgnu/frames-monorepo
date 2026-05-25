# scripts

- `scrape.ts` — fetch skills.sh top/trending/hot lists, output `skills.json`: `[{owner, repo, skill_path, install_count, trending_rank?, hot_rank?}]`
- `scan.ts` — for each entry: sparse-clone the skill subdirectory, run agentsec, output `scan-results.json`: `[{...skill_meta, audit: {...}}]`
- `fold.ts` — read `scan-results.json` and emit `set_facts` calls into `events.ndjson` via `@frames-ag/frame`.

The scan job runs `scrape.ts` then `scan.ts` and uploads `scan-results.json` as an artifact. The fold job downloads it and runs `fold.ts`.
