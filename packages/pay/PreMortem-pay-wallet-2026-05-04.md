# Pre-Mortem: pay wallet (Stage 0 + 1a + 1b)

**Date:** 2026-05-04
**Scope:** Building pay's library substrate + MCP server so any harness can plug pay in via 3 lines of `.mcp.json`. Imagined launch: 2026-05-18 (14 days).
**Failure scenario assumed:** First three external users try to add pay to their MCP config, hit a wall, churn silently. Repo gets archived in 6 weeks.

---

## Tigers (real risks)

### Launch-blocking

- **T1. No real x402 path has ever been exercised end-to-end.**
  Faremeter docs claim it works. We've trusted that without running a single real paid call through `wrap(fetch, …)` with an OWS wallet. First production call could expose a missing field, a wrong network normalization, or a faremeter API mismatch that's invisible from typecheck.

- **T2. OWS wallet bootstrap UX doesn't exist.**
  `@faremeter/wallet-ows` requires a pre-provisioned vault (`importWalletPrivateKey(...)` with passphrase). Users who add `pay-mcp` to `.mcp.json` and try `pay_tool("search.exa", ...)` hit "no wallet configured" with no obvious next step. The "3 lines and you're done" pitch dies on first contact.

- **T3. Ed25519 audit key has no provisioning story.**
  SPEC says receipts are signed; we never specified where the signing key comes from. First boot needs to generate one, persist it, and tell the user to back it up. Without this, every receipt fails to sign or every machine has a different key with no continuity.

- **T4. Frame `events.ndjson` stomping in directories that aren't pay-aware.**
  Pay writes `tool.invoked` events to cwd's `events.ndjson` if it looks like a frame dataset. A user running pay-mcp from a frame dir they didn't realize would silently start mutating that dataset's history. Real footgun.

- **T5. Faremeter version pinning + drift.**
  Faremeter is at v3-v4 across packages, with breaking changes between minor versions in the past quarter. Without exact-version pins and renovate alerts, a `bunx -y @frames-ag/pay-mcp` install in 6 months pulls a version that breaks the OWS wallet shape.

### Fast-follow (within 30 days post-launch)

- **T6. Catalog is 87% "unspecified" capability.**
  `discover(capability="search")` works for Twitter (141 tagged) but misses most of Bazaar's 5,000+ entries. Agents that try to filter the catalog meaningfully will give up and fall back to grep-via-q. Cosmetic but quickly noticed.

- **T7. ~10–20% of mirrored Bazaar entries probably don't actually settle.**
  We pull every entry that has an `accepts[]` array. Some sellers are dead, some return malformed 402s, some have wrong CAIP-2 network strings. First user who picks a tool by id and gets a faremeter error will assume pay is broken.

- **T8. Lock file size at scale.**
  10 tools × ~500 bytes inlined = 5KB. Fine. 100 tools = 50KB, still committable. But agents discovering tools dynamically and adding them to a long-lived manifest could grow the lock indefinitely. No purge story.

- **T9. npm publishing is a side quest we haven't done.**
  `bunx -y @frames-ag/pay-mcp` requires the package to be on the npm registry. We have zero published packages. Setting up changesets + access tokens + the @frames-ag scope is ~½ day of pure logistics.

### Track (post-launch, fix if it bites)

- **T10. No CLI-from-skill recipes.**
  Skill ships at Stage 3. Until then, Claude Code users have only the MCP. Workable, but the skill has been the unlock for `frame` adoption — pay without it is harder to teach.

---

## Paper Tigers (overblown concerns)

- **PT1. "Faremeter doesn't support every chain."**
  EVM + Solana = ~95% of real x402 traffic. Other chains land via per-chain signer packages on demand. Not v0.

- **PT2. "MPP only supports charge intent today."**
  Charge intent is exactly what tool calls need. Session/streaming MPP comes when faremeter ships them. Not a launch issue.

- **PT3. "Catalog has 5,797 entries — agent context will overflow."**
  Pay never returns the whole catalog to the agent. `discover()` is paginated, default 100. Agents see a tiny slice.

- **PT4. "Cloudflare Worker free tier will run out."**
  At zero users we're at zero traffic. Even viral adoption fits in free tier for months.

- **PT5. "Private catalog repo hurts discoverability."**
  Discoverability matters when pay actually works. Flip public on launch.

---

## Elephants (unspoken concerns to investigate)

- **E1. Who is the actual first user?**
  PLAN doesn't name one. `mcp-servers/` in frames-examples is the obvious candidate, but the maintainer (you) hasn't said "yes, I'm switching that dataset to pay." Without a named first user, every Stage-1 design call is speculation.

- **E2. Legal posture of buyer-side payment routing.**
  Pay is non-custodial — keys stay with the user. But "software that signs USDC transfers on a user's behalf" probably hits some regulatory line in some jurisdictions. Nobody's looked. Worth a 1-hour read of state-by-state money-transmitter rules.

- **E3. Privacy: receipts in committed `events.ndjson` expose wallet addresses.**
  For a public dataset like frames-examples, every paid call leaks the curator's `wallet_address` and on-chain `tx_hash`. We noted "redacted view in v0.1" but didn't spec it. Curators publishing public datasets get unintentionally doxxed by their own wallet.

- **E4. Price drift between manifest install and use.**
  Lock has `price_hint: "0.005"`. Seller's 402 challenge is authoritative. Budget check uses the hint; actual spend uses the challenge. If seller changed price 5x, user gets silent overspend within their per-call cap. No warning, no log.

- **E5. Tool-selection confusion in agent prompts.**
  Claude Code already has `WebFetch`, `WebSearch`. Adding pay's `pay_tool("search.exa", …)` makes the agent choose between native (free, owned by harness) and pay-routed (paid, owned by user). The model's decision logic isn't obvious; the skill has to teach it. Untested.

- **E6. Concurrent sessions sharing one wallet.**
  Two Claude Code sessions, both with pay-mcp, both spending. Budget tracking is per-process — could double-spend the monthly cap. SPEC says "atomic decrement" but the implementation is process-local.

---

## Action Plans for Launch-Blocking Tigers

| # | Risk | Mitigation | Owner | Due |
|---|---|---|---|---|
| T1 | x402 path never exercised | Stage 0.5 smoke test: real call to `bazaar.api-exa-ai-search` with `@faremeter/wallet-ows` + funded testnet wallet → verify 402 → sign → 200 → receipt | claude (driving) | 2026-05-08 |
| T2 | OWS bootstrap UX missing | `pay wallet init` interactive command: prompts passphrase, generates OWS vault under `~/.frames/wallets/ows/`, optionally takes `--from-private-key` for migration; CLI dies with actionable message ("run `pay wallet init` first") if no wallet | luis | 2026-05-12 |
| T3 | Audit key provisioning unspecified | `pay wallet init` also generates Ed25519 keypair under `~/.frames/pay/audit-key.json`; receipt signer reads it; SPEC clarifies the shape; backup hint printed at init time | claude | 2026-05-10 |
| T4 | events.ndjson stomping | Default behavior: only write `tool.invoked` if `tools.yml` is co-located with `events.ndjson`. Otherwise fall back to `~/.frames/pay/events.ndjson` even if cwd is a frame dir. Explicit `--write-frame-events` flag to override | claude | 2026-05-14 |
| T5 | Faremeter version drift | Exact-version pins in `package.json` (no `^`); renovate.json with daily checks; SPEC adds "tested faremeter version" matrix; CI runs typecheck against pinned versions | claude | 2026-05-09 |

---

## Recommended ordering before code

1. **T1 first** (smoke test). Until a real x402 call works, every other Stage-1 line of code is speculative. Burn ~half a day proving the wire path before scaffolding the library.
2. T3 (audit key) and T5 (faremeter pins) come during Stage 0 — cheap, prevents whole categories of pain.
3. T2 + T4 come during Stage 1b alongside the MCP server. They're UX, not architecture.
4. **Don't start Stage 1a until E1 is answered.** Pick a concrete first user. Without one, the MCP tool surface (`pay_tool`, `add_tool`, `wallet_status`, `discover`) is designed against zero feedback.

## What I'd actually do today

1. Spend 30 minutes answering E1 — name the first user. Most likely: convert `frames-examples/datasets/mcp-servers/` to pay-driven.
2. Spend 4 hours on T1 — write a one-shot `examples/smoke/x402-roundtrip.ts` that funds a Base Sepolia wallet, picks one catalog tool, runs it through faremeter, prints the receipt. **If this fails, the whole PLAN is wrong and we learn now.**
3. Then start Stage 0 with T3 and T5 baked in.

If T1 succeeds, the rest of the PLAN is on solid ground. If it fails, the failure mode tells us exactly what to fix in the bridge.
