# Draft: `frames-examples` migration PR

> Ready-to-push PR text + workflow patch. Blocked on `npm publish` of
> `@frames-ag/tick@0.0.5` (flip `"private": false` in `apps/tick/package.json`,
> then `npm publish --access public`).
>
> **v0.0.5 update**: customer `prompt.md` files **stay in place**. The CLI
> auto-discovers them from the frame URL's path component. No repo migration
> script needed.

---

## PR title

```
ci(tick): migrate curation workflow from opencode → @frames-ag/tick
```

## PR body (HEREDOC for `gh pr create`)

```markdown
## Summary

- Replaces the `opencode`-based curation step with `npx -y @frames-ag/tick curate`
- Drops `OPENROUTER_API_KEY` + `AGENTWALLET_*` + 3 npx-skill installs from CI
- Single new secret: `TICK_API_KEY` (bearer token issued by frames.ag during closed alpha)
- Same `events.ndjson` shape lands on the same git ref; `frame verify` + `frame project` unchanged
- Behind the scenes: tick runs the curate op against `tick.frames.ag`, which uses Cloudflare AI Gateway (BYOK) for LLM, the federated catalog at `catalog.frames.ag` for tools, and signs every paid call's `tool.invoked` receipt with the operator audit key

## Why

The old setup mixed three concerns into the CI runner:
- LLM auth (OpenRouter key)
- Wallet identity (agentwallet creds)
- Frame protocol (frame CLI)

Each was a separate failure mode and a separate secret to rotate. tick collapses the first two into one bearer token; the third stays as the local `@frames-ag/frame` CLI for verify + project.

## Cost / billing

Closed-alpha during v0.0.x — no billing on the hosted endpoint. Once Phase B x402 billing ships (`tick.frames.ag` flips `FACILITATOR_URL=https://api.cdp.coinbase.com/v2/x402`), each `curate` call settles in USDC against the wallet the bearer token is mapped to.

## `prompt.md` handling (auto-discovery, v0.0.5)

The CLI auto-discovers `datasets/<dataset>/prompt.md` from the frame URL path
component. No file moves required. The contents land in the curate agent's
system prompt under a "Custom loop instructions (from prompt.md)" header,
preserving the same agent behavior as the prior opencode flow.

If you need to override (e.g. a different prompt path during testing):

```bash
npx -y @frames-ag/tick curate "<frame-url>" --prompt-file path/to/alt.md
```

If you want to disable for a specific run:

```bash
npx -y @frames-ag/tick curate "<frame-url>" --no-prompt
```

## Test plan

- [ ] Confirm `TICK_API_KEY` is set in repo secrets (Settings → Secrets → Actions)
- [ ] Manual `workflow_dispatch` run on the `mcp-servers` dataset (smallest, fastest signal)
- [ ] Inspect the run: tick step succeeded, `events.ndjson` committed, `frame verify` passed, `frame project` regenerated the index
- [ ] Cross-check the `events.ndjson` deltas vs the previous opencode run — entity counts and fact counts should be in the same ballpark (allow ~30% variance; agents aren't deterministic)
- [ ] Confirm `tick.frames.ag/runs/<run_id>` returns a valid receipt for at least one of the runs (run_id printed in the workflow log)
- [ ] Tail `wrangler tail tick` during a manual run — no `agent_not_allowlisted` 403s, no `invalid_api_key` 401s
- [ ] Schedule the daily cron run for a 24h soak; revert if any dataset's events count regresses by >50%
```

## Workflow patch (`/.github/workflows/tick.yml`)

Both `tick` and `tick-threads` jobs get the same treatment. Diff against the current file:

```diff
       - name: Install OpenCode
         run: curl -fsSL https://opencode.ai/install | bash

       - name: Install frame CLI
         # install once globally so better-sqlite3 native binding builds reliably
         # (npx -y can skip postinstall and leave the binding missing)
         run: npm i -g @frames-ag/frame@latest

-      - name: Install skills
-        run: |
-          npx skills add https://github.com/frames-engineering/skills --skill agentwallet -y
-          npx skills add https://github.com/frames-engineering/skills --skill registry -y
-          npx skills add https://github.com/microchipgnu/blindspot.news --skill analysis -y
-
-      - name: Setup credentials
-        env:
-          AGENTWALLET_USERNAME: ${{ secrets.AGENTWALLET_USERNAME }}
-          AGENTWALLET_API_TOKEN: ${{ secrets.AGENTWALLET_API_TOKEN }}
-        run: |
-          for secret in "$AGENTWALLET_USERNAME" "$AGENTWALLET_API_TOKEN"; do
-            if [ -n "$secret" ]; then
-              echo "::add-mask::$secret"
-            fi
-          done
-
-          mkdir -p ~/.agentwallet
-          printf '{"username":"%s","apiToken":"%s"}' "$AGENTWALLET_USERNAME" "$AGENTWALLET_API_TOKEN" > ~/.agentwallet/config.json
-          chmod 600 ~/.agentwallet/config.json
-
-          mkdir -p .agentwallet
-          cp ~/.agentwallet/config.json .agentwallet/config.json
-          chmod 600 .agentwallet/config.json
-
-          export FRAMES_API_KEY="${AGENTWALLET_USERNAME}:${AGENTWALLET_API_TOKEN}"
-          echo "FRAMES_API_KEY=$FRAMES_API_KEY" >> $GITHUB_ENV
-          echo "::add-mask::$FRAMES_API_KEY"
-
       - name: Configure git
         run: |
           git config user.name "frames-bot"
           git config user.email "frames-bot@users.noreply.github.com"

       - name: Tick ${{ matrix.dataset }}
         id: tick
         if: ${{ github.event.inputs.dataset == '' || github.event.inputs.dataset == 'all' || github.event.inputs.dataset == matrix.dataset }}
         env:
-          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
-          AGENTWALLET_USERNAME: ${{ secrets.AGENTWALLET_USERNAME }}
-          AGENTWALLET_API_TOKEN: ${{ secrets.AGENTWALLET_API_TOKEN }}
+          TICK_API_KEY: ${{ secrets.TICK_API_KEY }}
         timeout-minutes: 55
         run: |
-          opencode run --dangerously-skip-permissions --print-logs "$(cat datasets/${{ matrix.dataset }}/prompt.md)"
+          npx -y @frames-ag/tick curate \
+            "https://github.com/${{ github.repository }}/datasets/${{ matrix.dataset }}" \
+            --budget 1.50
```

The `Install OpenCode` step can also be deleted — nothing else in the workflow uses it.

```diff
-      - name: Install OpenCode
-        run: curl -fsSL https://opencode.ai/install | bash
-
       - name: Install frame CLI
```

## Repo prep before the PR merges

1. **Add the secret**: Settings → Secrets and variables → Actions → `TICK_API_KEY` = `<bearer-token-from-frames.ag-operator>`
2. No file moves needed — `prompt.md` stays where it is.

## Rollback

Both flows write the same `events.ndjson` shape. To revert: `git revert <merge-commit>` — the next scheduled run is back on opencode. `events.ndjson` from tick stays valid (tick-emitted rows just carry an extra `run_id` field; older opencode rows didn't, and the projector handles both per frame protocol v0.2.0).

---

## What I still need from you

1. **A bearer key**: pick one (`openssl rand -hex 32`). Add it to:
   - The operator's `TICK_API_KEYS` secret on `tick.frames.ag`: `<key>:frames-runtime:frames-examples`
   - The repo's GitHub secrets: `TICK_API_KEY=<key>`
2. **Allowlist entry**: add `frames-runtime:frames-examples` to `TICK_ALLOWED_AGENTS` on the deployed `tick`.
3. **Confirm `tick.frames.ag` is live** (or override with `TICK_API_URL` in the workflow env).
