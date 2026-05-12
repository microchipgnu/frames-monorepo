# Migrating a frame from `opencode`-based curation to `tick`

This guide is for repos already running an `opencode` + raw-LLM curation step in
CI — the pattern used by [`microchipgnu/frames-examples`](https://github.com/microchipgnu/frames-examples)
and [`blindspot.news`](https://github.com/microchipgnu/blindspot.news). It
covers the GitHub Actions side; the frame format itself doesn't change.

The migration is non-breaking: your existing events.ndjson stays valid and
projects exactly the same way after the swap. The only differences are who's
spending budget (your wallet, not your OpenRouter key) and what's writing the
receipts (D1, not a free-form log file).

---

## Before (current setup)

`.github/workflows/curate.yml`:

```yaml
- name: Curate frame
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  run: |
    opencode run \
      --model anthropic/claude-sonnet-4 \
      --prompt prompt.md \
      --tools web_fetch \
      --output events.ndjson
```

Cost lands on your OpenRouter bill; tool calls are unaudited; budget is
LLM-spend only (web fetches are free-tier rate-limited).

---

## After (tick CLI)

`.github/workflows/curate.yml`:

```yaml
- name: Curate frame
  env:
    TICK_API_KEY: ${{ secrets.TICK_API_KEY }}
  run: |
    npx -y @frames-ag/tick curate \
      --frame "https://github.com/${{ github.repository }}" \
      --budget 0.50 \
      --out events.ndjson
```

That's the whole diff. Behind the scenes:

- `tick` resolves your frame via `frames-cloud` (so `schema.yml` + existing
  `events.ndjson` are read from this repo's `main`)
- LLM calls go through Cloudflare AI Gateway with full cost attribution
- Paid web fetches go through the agent's wallet — each one signs an x402
  receipt, surfaced in the events stream as `tool.invoked` events
- Budget is enforced as a single USDC ceiling covering LLM + tools

---

## Hosted alternative (no CLI in your CI)

If you don't want to give the CI runner a wallet, swap the `npx` invocation
for a POST to the hosted runtime:

```yaml
- name: Curate frame
  env:
    TICK_API_KEY: ${{ secrets.TICK_API_KEY }}
  run: |
    curl -sS -XPOST https://tick.frames.ag/run \
      -H "Authorization: Bearer $TICK_API_KEY" \
      -H content-type:application/json \
      -d '{
            "op": "curate",
            "frame": "https://github.com/${{ github.repository }}",
            "budget": "0.50"
          }' \
      | jq -r '.events | .[] | @json' >> events.ndjson
```

The customer's repo holds nothing beyond an API key. Spend is billed against
the wallet tied to that key.

---

## What changes in the repo

Nothing structural. Specifically:

| File                  | Action                                                              |
| --------------------- | ------------------------------------------------------------------- |
| `schema.yml`          | No change                                                           |
| `events.ndjson`       | New events appended; old events still valid (frame protocol v0.2.0) |
| `prompt.md` (if any)  | **Stays in place.** The CLI auto-discovers `<dataset>/prompt.md` from the frame URL and forwards it as the customer prompt. Override with `--prompt-file <path>` or skip with `--no-prompt`. |
| `.github/workflows/*` | Swap as shown above                                                 |

The agent emits a new `run_id` envelope field on every event (frame v0.2.0).
Older `events.ndjson` rows without `run_id` keep working — the projector
treats missing `run_id` as "pre-tick".

---

## Verifying the migration

After the first `curate` run lands, you should be able to:

1. Pull the receipt via `curl https://tick.frames.ag/runs/<run_id>` and see a
   populated `events` array plus per-tool cost breakdown
2. Join `events.ndjson` to that receipt by `run_id`
3. Filter `tool_log` rows by `descriptor_id` to see exactly which catalog
   tools the agent paid

If receipts don't show up, check that the workflow has `TICK_API_KEY` in
repo secrets and that the wallet has USDC on the chain your frame's spends
default to (usually Base).

---

## Rolling back

Both flows write the same `events.ndjson` shape. To roll back, revert the
workflow file — your previous `opencode`-based step will keep appending
events alongside the tick-emitted ones. No data migration is needed.

That said: tick-emitted events carry `run_id` and `agent: frames-runtime:<wallet>`;
opencode-emitted ones don't. If you grep events by `agent`, expect a mix
during a transition window.
