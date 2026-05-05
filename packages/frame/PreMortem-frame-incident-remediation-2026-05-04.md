# Pre-Mortem: Frame Incident Remediation (v0.0.4 + workflow fix)

**Date:** 2026-05-04
**Subject:** The May 2 silent-work-loss incident on `frames-examples/ai-promises` is fully remediated by:
  1. `@frames-ag/frame@0.0.4` (engine fixes — shipped 2026-05-02)
  2. `frames-examples` workflow reorder + verify wiring (handoff brief delivered, status unverified)

**Failure scenario imagined:** It is 2026-05-18 (14 days from now). Another `ai-promises` tick has lost work. Operators are now actively avoiding the automation. We're writing a second post-mortem.

What went wrong?

---

## Tigers (Real Risks)

### T1. Workflow fix in `frames-examples` never landed [LAUNCH-BLOCKING]
The handoff brief was copied to clipboard for a separate agent session. I have no confirmation it was executed, no PR link, no merged commit. The engine fixes by themselves do **not** close the work-loss path — `frame project` failing still causes the workflow to skip the `events.ndjson` commit, which is the actual incident mechanism. Atomic projection means the *prior* `dataset.db` survives, but the new agent work is still gone if the workflow doesn't commit `events.ndjson` first.

**Why this is the dominant risk:** v0.0.4 by itself is necessary but not sufficient. Without workflow reorder, the next FK-style failure (or any projection error) reproduces the May 2 outcome.

### T2. The May 2 trigger is data-dependent and recurs on every `ai-promises` tick [LAUNCH-BLOCKING]
We never recovered the bad `events.ndjson` — runner state was wiped. We don't know what specifically caused the orphan `fact.set`. Possibilities: an agent wrote events.ndjson outside MCP; a partial-write corruption; a race between concurrent ticks; a known-bad agent prompt that produced malformed payloads. With `frame verify` now in place, recurrence is loud and debuggable — but until we see one and study the artifact, "fixed" is provisional.

### T3. Lock reclamation deadlock window in CI [LAUNCH-BLOCKING]
My new lock has a 10-minute staleness backstop and PID-liveness check. Failure mode: in containerized CI (GHA runners), PIDs recycle aggressively. Process A dies holding the lock. Runner B starts, is assigned a PID matching A's. New tick C tries to acquire, sees "live PID," doesn't reclaim, falls through to the 10-minute age check. If the lock was written < 10 min ago, the tick fails with `[Locked]` until 10 min elapse. On a tight schedule (every 6h or hourly), this could mean a tick fails and the next one also fails because the operation actually took > 6 min itself. Untested in CI. Was tested only with synthetic local PIDs.

### T4. Atomic rename `EXDEV` on GHA runner filesystem [FAST-FOLLOW]
`renameSync(dbTmp, dbPath)` is POSIX-atomic on same-FS. We write `.tmp` files in `.frame/dataset.db.tmp` and rename in-place — same directory, same FS. **Should** be safe on every runner. But if anyone configures `.frame/` as a tmpfs/symlink/separate volume (e.g. `actions/cache` mounting it elsewhere), `EXDEV` raises and the projection step fails with no useful message. Untested on actual GHA infrastructure.

### T5. `frames-examples` doesn't bump the dep [LAUNCH-BLOCKING]
The workflow brief calls for bumping `@frames-ag/frame` to `^0.0.4`. If they pin exact (`"0.0.3"`) or use `npx @frames-ag/frame` without a version, npm cache may serve old version, or pin doesn't update. The engine fix is on npm but consumption is on the consumer. Coordination risk.

### T6. Lock-recovery silently allows concurrent writers [FAST-FOLLOW]
Old behavior: any existing lock → throw. Strict but predictable. New behavior: reclaim if PID dead/self/old. **Race window:** two writers A and B start simultaneously. Both hit `EEXIST` from a lock left by dead process X. Both call `tryReclaimStaleLock`, both see PID X is dead, both `rmSync` the lock, both `openSync('wx')` — and one of them succeeds creating the lock fresh, but the other's reclaim+open might happen in the right interleaving where both believe they hold the lock. The reclaim → re-`openSync('wx')` is not atomic as a unit. `O_EXCL` makes the open atomic, so only one will succeed at the open step — but both will have `rmSync`-ed the lock first, which means we're racing on the existence-check before the create. This is a real bug, not just a theoretical race. **Mitigation:** the second `openSync` will get `EEXIST` from the first writer's lock and the loop terminates throwing `Locked`. So the worst case is "one writer wins, the other gets a clear error" — which is correct behavior, not corruption. Re-classify as: actually safe under inspection, but the code path is subtle and untested. Track.

### T7. Schema-invalid rows in `frame verify` are warnings, not failures [TRACK]
I deliberately weakened verify to only fail on referential errors. Argument: schema-invalid rows are non-fatal in projection (they're surfaced as `r.invalid`), so blocking the commit on them would be a behavior change. Counter-argument: operators wiring verify into CI for the first time may **expect** it to enforce schema. They'll see "verified ✓" and miss the warning lines. Decision is defensible; documentation matters more than the choice.

---

## Paper Tigers (Overblown Concerns)

### P1. "v0.0.4 changes `fold` semantics — backwards-incompatible"
False. For any `events.ndjson` produced by Frame's normal write paths (engine MCP), the new validation never triggers — the engine already enforces these invariants at write time. The new validation only triggers on logs that would have crashed at SQLite-INSERT time anyway. The error message is now actionable instead of opaque. Strictly an improvement.

### P2. "Atomic rename breaks Windows"
The engine is cross-platform Node, but every actual Frame operator runs on Linux CI or macOS. Windows isn't a target. Not relevant.

### P3. "Orphan validation slows down `fold` at scale"
The added checks are `Map.has()` — O(1) hash lookups. At 100k events the overhead is below measurement noise. Not a real concern.

### P4. "Reclaiming self-owned locks masks programming bugs"
A lock with `pid == process.pid` means the same process is re-acquiring without releasing. Old code: throw. New code: reclaim. The reclaim path **does** fire if `Frame.acquireLock` is called twice on the same instance — but every public method has `try/finally release()`, so this should never happen unless something throws between `acquireLock` and the `try` (impossible in current code). If it does fire, recovery is the correct behavior, not concealment.

---

## Elephants (Unspoken Worries)

### E1. We don't know what produced the orphan event in the first place
The bad `events.ndjson` is gone. We assume an agent bypassed MCP, or a partial-write happened, or a concurrent edit produced it. **Until we capture and study a real one, every "fix" is reasoning by inference.** This is the elephant. The artifact-upload step in the new workflow is the instrument; if it never fires (because it never recurs) we have no signal that we fixed the right thing. If it fires once, study it immediately.

### E2. Other latent log-corruption modes nobody is testing for
We added validation for orphan references. We did not add validation for:
- Duplicate `fact_id` across events (would silently overwrite in fold)
- Future-timestamped events (`ts` from 2099) — would dominate supersession permanently
- Schema-incompatible value types vs. current `schema.yml` (only checked at row-validation, not append-time)
- Truncated last line of `events.ndjson` from a kill -9 mid-write
- BOM or encoding shifts after manual edits

`fold` would either crash, silently misbehave, or produce wrong projections in each case. Worth a hardening sweep.

### E3. Verify-vs-project parity
`frame verify` re-folds and exits 0 if fold succeeds. `frame project` folds and then writes SQLite. The SQLite write enforces FOREIGN KEY on `evidence.fact_id → facts.fact_id`, which `fold` does check, but also UNIQUE on `fact_id` PRIMARY KEY — which `fold` does **not** check. A duplicate `fact_id` would pass verify and crash project. We'd recurse the May 2 failure mode at the project step despite verify passing. Should add duplicate-id detection to fold.

### E4. Operator trust
Even if the technical fix is complete, anyone who saw work silently disappear once will doubt the automation. The next time a tick "succeeds with warnings" they'll suspect data loss. Communication matters: a brief CHANGELOG entry, an explicit "May 2 incident closed" status note in the README, and visibility on the next few successful ticks. Not engineering work, but launch-readiness work.

### E5. `frame doctor` is now slightly out of date
`doctor` checks `.frame/lock` mtime > 600s as "stale." That's fine. But it doesn't know about the new reclamation logic, so a held lock with PID=`process.pid` from a dead prior run would show as "held — operation likely in progress" when it's actually reclaimable. Minor, but worth aligning the doctor's mental model with reality.

---

## Action Plans for Launch-Blocking Tigers

### T1. `frames-examples` workflow fix
- **Risk:** Engine atomicity insufficient without workflow reorder; next projection failure reproduces May 2.
- **Mitigation:** Confirm via GitHub that the workflow PR was opened, reviewed, and merged. If not, escalate or open it ourselves.
- **Owner:** Luís (operator) — or whoever was handed the brief.
- **Due:** 2026-05-05 (before any 06:00 UTC scheduled run with potential to fail).

### T2. Capture a real bad `events.ndjson`
- **Risk:** Root cause unknown; "fix" is provisional.
- **Mitigation:** Workflow change includes `actions/upload-artifact` on failure. After workflow lands, monitor the next 5 ticks. If verify ever fails, download the artifact, study the orphan, retro the engine fixes against the actual cause.
- **Owner:** Luís + whoever curates `ai-promises`.
- **Due:** First failure, or 2026-05-18 declares "no recurrence in 14 days, downgrade to E1 watchlist."

### T3. CI lock-reclamation behavior
- **Risk:** PID recycling on GHA runners + the 10-min backstop could wedge ticks.
- **Mitigation:** Add an integration test that runs `frame addEntity` in two child processes back-to-back, with the second's PID potentially matching the first's freshly-released slot. Or: just shorten `LOCK_STALE_MS` to 2 min — typical GHA run lifetimes mean a 2-min backstop is enough headroom for any normal operation, and limits recycle-PID exposure to a 2-min window. Trade-off: the longer the timeout, the safer against false reclamation, but more brittle in CI.
- **Owner:** Engine.
- **Due:** 2026-05-09 — before more datasets adopt v0.0.4.

### T5. Confirm `frames-examples` actually consumes 0.0.4
- **Risk:** npm publish ≠ consumer running new code.
- **Mitigation:** Inspect `frames-examples/package.json` (or per-dataset package files) for the bumped dep. Check the workflow uses `npx @frames-ag/frame@0.0.4` explicitly OR has the bump in lockfile. If using `npx` unpinned, force a specific version.
- **Owner:** Luís.
- **Due:** Same as T1.

---

## Decision points for the next two weeks

- **2026-05-05:** Workflow change merged. If not, push or take ownership.
- **2026-05-09:** Lock CI test added; `LOCK_STALE_MS` decision (keep at 10m, or drop to 2m).
- **2026-05-12:** If verify has tripped at least once, root-cause is known and a 0.0.5 hardening pass is justified. If it hasn't tripped, `ai-promises` may have been a one-off — close the loop with a status note.
- **2026-05-18:** Pre-mortem revisit. Downgrade or escalate Tigers based on observed reality.

---

## What I'd add if we had unlimited time

- Duplicate-`fact_id` and future-`ts` checks in `fold` (closes E2/E3 fully).
- Verify parity test: a property test that any `events.ndjson` passing `frame verify` also projects successfully.
- `frame doctor` aware of the new reclamation logic (closes E5).
- A CHANGELOG.md and a note in README pointing at `v0.0.4` as the production-trustworthy line (closes E4).
- A `frames-examples`-side dashboard or webhook surfacing tick success/failure rates so operators don't have to read GH Actions logs to trust the system.

None of these are launch-blocking; all are within the next two minor versions if signal warrants.
