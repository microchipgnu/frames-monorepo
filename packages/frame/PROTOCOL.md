# frame protocol v0.0.1

First published version. The on-disk format and projection algorithm specified
below constitute the contract. Future minor versions add optional event types
and optional schema fields; older readers must skip unknowns.

A frame is a directory containing a curated, evidence-backed, version-controlled dataset.

This document specifies what bytes must be on disk for a directory to be a valid frame. It does not specify how those bytes get there — that's the [MCP curation surface](./MCP.md).

## Directory layout

```
my-frame/
├── README.md              prose specification of the dataset's purpose
├── schema.yml             the contract: types, descriptions, optional tests
├── events.ndjson          append-only canonical event log (the source of truth)
├── CHANGELOG.md           narrative record of significant changes
├── .gitattributes         registers union-merge for events.ndjson
├── .git/                  version history
└── .frame/                derived artifacts (gitignored)
    ├── dataset.db         SQLite index regenerated from events
    ├── rows.ndjson        current-state projection regenerated from events
    └── lock               present while a tick is in progress
```

## Invariants

1. `events.ndjson` is the source of truth. If derived artifacts disagree, events wins.
2. `events.ndjson` is append-only. Lines are never modified or removed.
3. Every fact names a source. No anonymous data.
4. Updates happen via supersession (new event with same `entity_id` + `field`), never mutation.
5. Removal happens via deprecation, not deletion. `fact.deprecated` events are first-class.
6. Events are written in monotonic timestamp order (within a single writer).
7. The frame directory is a git repository.

A consumer that violates any of these is non-conformant.

## Event envelope

Every line in `events.ndjson` is a JSON object with five required fields:

```json
{
  "id": "uuid-v4",
  "ts": "2026-04-30T14:22:11.000Z",
  "type": "fact.set",
  "agent": "claude:opus-4.7",
  "run_id": "run_a1b2c3",
  "payload": { "...": "type-specific" }
}
```

| field | type | required | description |
|---|---|---|---|
| `id` | UUID v4 | yes | unique event ID |
| `ts` | ISO 8601 | yes | when the event was recorded (UTC, millisecond precision) |
| `type` | string | yes | event type (see below) |
| `agent` | string | yes | who made this change. Format: `<kind>:<identifier>` (e.g. `claude:opus-4.7`, `human:luis@frames.ag`, `system:projector`, `frames-runtime:0xa1b2…`) |
| `run_id` | string | no (v0.2.0+) | optional correlation ID grouping events written during a single curation tick. Lets external runtimes join their tool log to the frame's events. Forward-compatible: older readers ignore. |
| `payload` | object | yes | type-specific fields |

Unknown event types must be skipped by the projector (forward compatibility).

Unknown top-level fields must be preserved when forwarded and ignored when not understood. `run_id` was added in v0.2.0.

## Event types

### `entity.created`

```json
{ "payload": { "entity_id": "acme-fi" } }
```

Establishes that an entity exists. `entity_id` is a stable, slug-shaped string (`[a-z0-9][a-z0-9_-]*`). Required before any `fact.set` for that entity.

### `fact.set`

```json
{
  "payload": {
    "fact_id": "uuid-v4",
    "entity_id": "acme-fi",
    "field": "founded_year",
    "value": 2024,
    "source": { "url": "...", "retrieved_at": "...", "excerpt": "..." },
    "confidence": 0.92,
    "observed_at": "2026-04-29T00:00:00Z"
  }
}
```

Sets the value of a field on an entity. Last-write-wins by `ts` for `(entity_id, field)`. `fact_id` is a fresh UUID v4 used to reference this fact later. `confidence` (0–1) and `observed_at` are optional.

### `facts.set_many` (v0.2.0+)

```json
{
  "payload": {
    "entity_id": "acme-fi",
    "facts": [
      {
        "fact_id": "uuid-v4",
        "field": "founded_year",
        "value": 2024,
        "source": { "url": "...", "retrieved_at": "...", "excerpt": "..." }
      },
      {
        "fact_id": "uuid-v4",
        "field": "hq_country",
        "value": "DE",
        "source": { "url": "...", "retrieved_at": "..." }
      }
    ]
  }
}
```

Atomic bulk-write of multiple facts to a single entity in one event. Equivalent semantically to N `fact.set` events with the same `entity_id` and outer `ts`, but committed as a single envelope so partial failures aren't possible. Each item in `facts` carries the same fields as a `fact.set` payload (minus `entity_id`, which is hoisted to the outer payload). Last-write-wins by `(envelope.ts, array-order)` for `(entity_id, field)`.

Use cases: tick services that compute many fields from a single source page should emit one `facts.set_many` instead of N `fact.set` — keeps the audit log tidy, reduces I/O, and aligns the events with what was conceptually a single observation.

Forward-compatible: older readers see `type: "facts.set_many"` and skip it (the spec mandates skipping unknown types). For full backward compatibility during the v0.2.x window, writers MAY emit N `fact.set` events instead.

### `fact.deprecated`

```json
{ "payload": { "fact_id": "...", "reason": "Source retracted on 2026-04-25" } }
```

Marks a previously-set fact as no longer trusted. The projection treats the (entity_id, field) as if this fact never existed and reverts to the most recent non-deprecated `fact.set` for that pair, or unsets if none exists. `reason` is required.

### `evidence.attached`

```json
{ "payload": { "fact_id": "...", "source": { "url": "...", "retrieved_at": "..." } } }
```

Adds an additional source to an existing fact without changing the value. Used when a second source corroborates an existing claim.

### `entity.removed`

```json
{ "payload": { "entity_id": "acme-fi", "reason": "Disqualified — out of scope" } }
```

Removes an entity from the rows projection. Equivalent to deprecating all of its facts. `reason` is required. The entity's history remains in `events.ndjson` and can be inspected via `git log`.

### `tool.invoked` (runtime telemetry)

```json
{
  "payload": {
    "receipt": {
      "pay_protocol": "0.0.1",
      "id": "uuid-v4",
      "ts": "2026-04-30T14:22:11.000Z",
      "tool_id": "search.exa",
      "descriptor_id": "sha256-of-canonical-descriptor",
      "params_hash": "sha256-of-args",
      "protocol": "x402-v2",
      "wallet_id": "tick",
      "wallet_address": "0xa1b2...",
      "amount": "0.0050",
      "currency": "USDC",
      "network": "base",
      "agent": "frames-runtime:0xa1b2...",
      "signature": "..."
    },
    "tool": {
      "params": { "query": "..." },
      "response_excerpt": "...",
      "response_size_bytes": 14823
    }
  }
}
```

Emitted by `pay` (or any cost-bearing tool runner) when a paid tool call fires from inside a frame loop. Indexed into a `tool_invocations` table by the projector for audit and cost rollups. The `receipt.id` value is what `source.receipt_id` references when a fact is derived from a paid fetch — this links facts forward to the call that produced them.

Projection-side: indexed, does not affect rows. Frame projector deduplicates by outer event `id` so `frame verify`-style replays don't double-count.

### `catalog.probe` (runtime telemetry, v0.3.0+)

```json
{
  "payload": {
    "tool_id": "search.exa",
    "descriptor_id": "sha256-of-canonical-descriptor",
    "args": { "query": "" },
    "status": 422,
    "hints": [
      { "kind": "missing_field", "field": "body.query", "message": "field required" }
    ],
    "summary": "HTTP 422: missing required fields: body.query",
    "response_excerpt": "{\"detail\":[{\"loc\":[\"body\",\"query\"],\"msg\":\"field required\",\"type\":\"value_error.missing\"}]}",
    "retryable": true
  }
}
```

Emitted by a runtime when a catalog-mediated `tool_invoke` attempt fails. Carries the runtime's parsed hints from the seller's error body (FastAPI/Pydantic, RFC-7807, `{error}`, `{message}` shapes) plus a truncated response excerpt for cases where the parser couldn't extract structure.

Hint `kind` values: `missing_field`, `invalid_value`, `auth_required`, `rate_limited`, `not_found`, `server_error`, `unknown`. `retryable` is `false` for 404 / 5xx / auth-required and tells the agent to pick a different descriptor instead of retrying.

Projection-side: ignored (no row or table impact). The event log retains it so later analysis can answer questions like "which catalog entries have undocumented required fields" without re-running probes. This is the feedback signal that informs what richer metadata the catalog should ship — see the `tick` runtime's probe loop for the emission side.

`status: 0` indicates the request never reached the seller (network error, timeout).

## Source schema

A `source` is a JSON object:

```json
{
  "url": "https://techcrunch.com/...",
  "retrieved_at": "2026-04-29T15:30:00Z",
  "title": "Acme Financial raises Series A",
  "archive_url": "https://web.archive.org/...",
  "excerpt": "Acme, founded in 2024, raised a $12M Series A..."
}
```

| field | required | description |
|---|---|---|
| `url` | yes | the source URL |
| `retrieved_at` | yes | when the URL was fetched (ISO 8601) |
| `title` | no | human-readable title of the source |
| `archive_url` | no | Wayback or similar permanent archive |
| `excerpt` | no | verbatim text from the source supporting the claim. Strongly recommended for verifiability |

Bare strings are not valid sources. The minimum is `{ url, retrieved_at }`.

## schema.yml

```yaml
frame_protocol: "0.1.0"
name: ai_agent_wallets_eu
description: |
  AI agent wallet companies headquartered in Europe.
entity_type: company
fields:
  name:
    type: string
    required: true
  hq_country:
    type: string
    required: true
  founded_year:
    type: int
  category:
    type: enum
    values: [wallet, payment_infra, key_management, custody]
tests:
  - name: hq_must_be_eu
    field: hq_country
    rule: enum
    allowed: [DE, FR, UK, ES, IT, NL, SE, PL, PT, IE, AT, BE, DK, FI]
```

| field | description |
|---|---|
| `frame_protocol` | semver of the protocol the frame conforms to |
| `name` | matches the directory name |
| `description` | freeform; fed to agents as part of the contract |
| `entity_type` | what each row represents |
| `fields` | map of field name to `{type, required?, ...}`. Types: `string`, `int`, `float`, `bool`, `date`, `url`, `enum` |
| `tests` | list of named rules a value must satisfy. Implementations may extend the rule vocabulary |

## Projection

Given an `events.ndjson`, the canonical rows projection is computed by:

1. Read events in file order (already monotonic by `ts`).
2. Build a `Map<entity_id, Map<field, fact_id>>` mapping each (entity, field) to the most recent non-deprecated fact.
3. Drop entries whose `entity_id` has an `entity.removed` event after their last `fact.set`.
4. For each remaining entity, emit a row with all its current fields.
5. Validate each row against `schema.yml`. Rows failing validation are emitted with an `invalid: true` marker (not silently dropped — the projector's job is to materialize, not to filter).

The projection is deterministic: the same `events.ndjson` always produces identical rows. This means derived artifacts can be regenerated at any time and are not part of the canonical state.

## Versioning

The protocol uses semver. The `frame_protocol` field in `schema.yml` declares which version a frame conforms to.

- **Patch** changes (0.1.0 → 0.1.1): clarifications, bug fixes in the spec text. No on-disk format change.
- **Minor** changes (0.1.0 → 0.2.0): new optional event types, new optional schema fields. Older readers must skip unknowns.
- **Major** changes (0.x → 1.0): breaking format changes. Implementations refuse to operate on unknown major versions.

## Conformance

A conformant frame implementation:

1. Reads and writes the event envelope above.
2. Enforces every invariant when writing.
3. Implements the projection algorithm above (or a behaviorally equivalent one).
4. Validates `schema.yml` against the field vocabulary.
5. Initializes new frames with the directory layout above, including `.gitattributes` configured for `events.ndjson`.

A conformant *consumer* may skip writing — read-only tools (renderers, exporters) only need the projection algorithm.
