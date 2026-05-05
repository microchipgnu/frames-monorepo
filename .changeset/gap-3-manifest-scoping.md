---
"@frames-ag/pay": minor
---

`pay-mcp` now supports per-dataset manifest scoping.

New CLI flags on `pay-mcp`:
- `--manifest <path>` / `-m` — set `tools.yml` location explicitly
- `--lock <path>` — set `tools.lock` location explicitly
- `--dataset <path>` / `-d` — frame dataset directory; auto-derives `<path>/tools.yml`, `<path>/tools.lock`, AND sets the receipt destination so `tool.invoked` events land in `<path>/events.ndjson`

Equivalent env vars: `PAY_MANIFEST_PATH`, `PAY_LOCK_PATH`, `PAY_FRAME_DATASET`. Flags win over env when both are passed.

This unifies tool scoping with frame integration: `pay-mcp --dataset datasets/foo` is the single flag a multi-dataset repo needs to wire up bounded toolsets per frame.

Resolution precedence in `config.ts`:
1. `PAY_MANIFEST_PATH` / `PAY_LOCK_PATH` env (or matching CLI flags)
2. `PAY_FRAME_DATASET` env (auto-derives both)
3. `manifest_path` / `lock_path` in `~/.frames/pay/config.yaml`
4. Built-in defaults (`./tools.yml`, `./tools.lock`)

Closes the manifest-scoping gap — frames-examples can now declare per-dataset `tools.yml` files alongside `schema.yml`, and the dataset's `events.ndjson` becomes the canonical record of every paid call by that loop.
