---
"@frames-ag/frame": patch
---

test: bump `deprecate_fact reverts to prior fact` timeout from 5s to 30s

CI flake. The test writes 3 events + a deprecate, hitting better-sqlite3 four times. Locally completes in <50ms. On cold CI runners under contention (Node 20 actions runner, parallel jobs) the native binding load can push it past the default 5s timeout — observed today.

Pure test infra change, no production code touched.
