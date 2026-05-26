---
name: inventory
kind: service
---

# Inventory

### Description

Read the freshly-folded frame and emit the three work queues plus the
discovery dedup set. Pure read; no writes, no paid calls. The queues
are explicitly capped here so downstream services do not need to
re-check caps.

### Shape

- `self`: SQL queries against `mcp__frame-merchants-watch__query`
  (mode=`sql`); emit queues
- `prohibited`: any frame mutation; any paid call

### Requires

- `frame`: path to the frame directory
- `naming_cap`: cap for naming_gaps
- `category_cap`: cap for category_gaps
- `recognition_cap`: cap for recognition_gaps
- `recognition_volume_floor_usd`: minimum combined 30d volume to make a
  host eligible for the recognition queue

### Ensures

- `queues`: `workspace/inventory/queues.json` shaped as
  `{ naming_gaps[], category_gaps[], recognition_gaps[], existing_hosts[] }`
- each queue entry: `{ host, entity_id, display_name, category, x402_volume_usd_30d, tempo_volume_usd, is_recognized }`
- every queue excludes `is_infra = true` and `is_mass_lister = true`
- `naming_gaps` is sorted by descending `bazaar_resource_count` so the
  highest-impact hosts get named first
- `category_gaps` is sorted by descending combined volume
- `recognition_gaps` is sorted by descending combined volume
- `existing_hosts` is the unbounded set of every entity's `host` value
  — used by `discoverer` to skip duplicates

### Invariants

- read-only; no `pay_tool` calls
- the queues are mutually-non-disjoint by design — a host can need both
  naming AND categorization. Downstream services handle that without
  double-writing

### Strategies

- canonical SQL for naming_gaps:
  ```sql
  SELECT host, display_name, category, bazaar_resource_count, x402_volume_usd_30d, tempo_volume_usd, is_recognized
  FROM rows
  WHERE LOWER(display_name) = LOWER(host)
    AND is_infra = false
    AND is_mass_lister = false
  ORDER BY bazaar_resource_count DESC
  LIMIT :naming_cap
  ```
- canonical SQL for category_gaps:
  ```sql
  SELECT host, display_name, category, x402_volume_usd_30d, tempo_volume_usd, is_recognized
  FROM rows
  WHERE category = 'other'
    AND is_infra = false
    AND is_mass_lister = false
  ORDER BY (x402_volume_usd_30d + tempo_volume_usd) DESC
  LIMIT :category_cap
  ```
- canonical SQL for recognition_gaps:
  ```sql
  SELECT host, display_name, category, x402_volume_usd_30d, tempo_volume_usd
  FROM rows
  WHERE is_recognized = false
    AND is_infra = false
    AND is_mass_lister = false
    AND (x402_volume_usd_30d + tempo_volume_usd) >= :recognition_volume_floor_usd
  ORDER BY (x402_volume_usd_30d + tempo_volume_usd) DESC
  LIMIT :recognition_cap
  ```

### Tools

- `mcp:frame-merchants-watch`: required — `query` (mode=sql)
