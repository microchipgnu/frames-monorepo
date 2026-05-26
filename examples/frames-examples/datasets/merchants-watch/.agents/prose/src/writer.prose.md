---
name: writer
kind: service
---

# Writer

### Description

Apply the namer / categorizer / recognizer / discoverer proposals to
the frame through the MCP server. For existing entities use
`set_facts`; for net-new discovery candidates use
`add_entity_with_facts`. Every fact carries a source. Enforces the
deterministic-field invariant (writer drops any proposal that names a
scraper-owned field).

### Shape

- `self`: `mcp__frame-merchants-watch__add_entity_with_facts` /
  `set_facts` / `attach_evidence`
- `prohibited`: any paid call; any write without `source`; any write
  to deterministic fields owned by `scripts/merge.ts`

### Requires

- `name_proposals`: from `namer`
- `category_proposals`: from `categorizer`
- `recognition_proposals`: from `recognizer`
- `new_candidates`: from `discoverer`
- `frame`: path to the frame directory

### Ensures

- `writes_applied`: `workspace/writer/writes_applied.json` shaped as
  `{ named: [{ entity_id, fact_ids[] }], categorized: [...], recognized: [...], added: [{ entity_id, fact_ids[] }], skipped: [{ entity_id, reason }] }`
- every `set_facts` and `add_entity_with_facts` call passes a
  `source` object: `{ url, retrieved_at, title? }`
- every new entity created via `add_entity_with_facts` has its
  `host` field set + at least `display_name` and `category` (when
  available from the discoverer)
- entity_id for new merchants follows
  `scripts/host.ts:entityIdFromHost` so the next scrape's fold sees
  the same id (no duplicates)

### Errors

- `MergeConflict`: a proposal targets an `entity_id` that the writer's
  read of current state shows already-existing for naming/recognition
  (race with another curate run) — the writer skips and logs to
  `skipped[]` with `reason: "race"`

### Invariants

- never `set_fact` or `add_entity_with_facts` without `source`
- never write any of: `host`, `networks_accepted`, `network_names`,
  `primary_network`, `network_count`, `network_tiers`, `on_bazaar`,
  `on_agentic_market`, `on_pay_sh`, `on_mppscan`,
  `bazaar_resource_count`, `bazaar_last_updated`, `tempo_tx_count`,
  `tempo_volume_usd`, `tempo_latest_tx`, `volume_usd_base`,
  `volume_usd_solana`, `tx_count_base`, `tx_count_solana`,
  `x402_tx_count_30d`, `x402_volume_usd_30d`, `x402_buyers_30d`,
  `x402_facilitators`, `is_active_14d`, `is_mass_lister`, `is_infra`,
  `min_price_usd`, `max_price_usd`, `listed_on_count`,
  `mpp_source`, `probe_status`, `probe_endpoint`, `advertises_mpp`,
  `advertises_x402`, `advertised_methods`, `advertised_networks`,
  `observed_at` (when the proposal is for an existing entity).
  EXCEPTION: discoverer-supplied probe fields on a NEW entity are
  allowed — they are the agent's own observation, not a clobber of
  the scraper's
- never `remove_entity`
- when a proposal carries `category` but it is not in the schema
  enum, drop it and record in `skipped[]` with reason
- when a recognition proposal flags `is_recognized = true`, the
  writer verifies the proposal's `sources[].length >= 2` and at
  least one source is off-host; otherwise drop with `reason:
  "insufficient-sources"`

### Strategies

- group writes by entity_id so each entity gets ONE `set_facts` call
  for all of (display_name, description, category, category_source,
  is_recognized) — atomic, less projection-rebuild work
- order writes: discoverer adds first (so naming/categorization of
  net-new merchants happens in the same batch), then existing-entity
  set_facts
- when the recognizer flagged `outcome = "infra-misclassified"`,
  the writer still writes nothing — the operator handles infra
  rules in `scripts/host.ts`. The writer surfaces the host list in
  `skipped[]` for the report
- when an existing entity already has `display_name != host` (some
  other source updated it between inventory and write), and the
  current proposal disagrees, the writer prefers existing — let the
  auditor decide whether to deprecate

### Tools

- `mcp:frame-merchants-watch`: required — `add_entity`,
  `add_entity_with_facts`, `set_facts`, `attach_evidence`,
  `query`
