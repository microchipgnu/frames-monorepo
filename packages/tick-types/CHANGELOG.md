# @frames-ag/tick-types

## 0.0.7 — 2026-05-13

Mirrors the `catalog.probe` event type added in `@frames-ag/frame@0.3.0`. Additive — older consumers of the FrameEvent union still type-check against existing event types.

### Added

- `catalog.probe` variant in the `FrameEvent.type` discriminated union. Used by `@frames-ag/tick@^0.4.4` to emit structured failure telemetry from `tool_invoke` attempts.

## 0.0.6 and earlier

See git history. (No CHANGELOG was maintained prior to v0.0.7.)
