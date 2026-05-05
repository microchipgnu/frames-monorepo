# frames-cloud

GitHub-resolver runtime for frame datasets. Point at any public GitHub repo with a `schema.yml` at root and get a paginated REST API + projected state, with verbatim-source provenance per cell.

```
GET /api/v1/<user>/<repo>              → dataset metadata
GET /api/v1/<user>/<repo>/schema       → schema.yml as JSON
GET /api/v1/<user>/<repo>/readme       → README.md
GET /api/v1/<user>/<repo>/entities     → paginated list (cursor)
GET /api/v1/<user>/<repo>/entities/:id → single entity + all evidence
```

All endpoints accept `?ref=<sha|branch|tag>` (default: repo HEAD).

## Pagination

Cursor-based on `entity_id`. Stable across rebuilds because events are append-only.

```
?limit=50                  # default 50, max 1000
?cursor=<opaque>           # from previous response
?filter[hq_country]=DE,FR  # equality, comma = OR
?include=all               # include all evidence per fact (default: first source only)
```

`Link: <...>; rel="next"` header when more pages remain.

## Caching

`ETag: W/"<sha12>-<max_ts>"` on every response. Commit SHA cached 60s; dataset projection cached forever per SHA (immutable). `Cache-Control: public, s-maxage=60, stale-while-revalidate=600`.

## Run

```bash
bun install
bun run dev      # http://localhost:8787
bun run smoke    # projection sanity check on local example
```

## Status

v0 — read-only, in-memory cache, stateless. Next: D1/Turso projection cache, GitHub webhook for instant invalidation, MCP HTTP transport, write API via OAuth, x402-paid public reads.
