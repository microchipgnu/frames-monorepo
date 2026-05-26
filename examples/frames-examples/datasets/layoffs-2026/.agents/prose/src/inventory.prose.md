---
name: inventory
kind: service
---

# Inventory

### Description

Snapshot the current state of the frame: enumerate every entity and group
by `status`. Provides the existing `entity_id` set the discoverer will
dedup against and the refresh candidate set the refresher will consider.

### Shape

- `self`: read frame state via `mcp__frame-layoffs-2026__query` (mode=`all`)
- `prohibited`: any frame mutation, any paid call

### Requires

- `frame`: path to the frame directory

### Ensures

- `state`: `workspace/inventory/state.json` with
  `{ all_entities[], by_status: { announced: [], executed: [], … } }`

### Invariants

- read-only
- no `pay_tool` calls

### Tools

- `mcp:frame-layoffs-2026`: required — `query` (mode=all)
