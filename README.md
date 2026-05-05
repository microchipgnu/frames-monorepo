# frames-monorepo

The complete frames-ag stack in one workspace.

## Layout

```
packages/
  frame/      @frames-ag/frame      — dataset/loop protocol + CLI + per-dataset MCP server
  pay/        @frames-ag/pay        — buyer-side runtime: catalog + manifest + signed receipts; MCP for any harness
  catalog/    catalog (deployable)  — content-addressed tool descriptor publisher (Cloudflare Workers / Vercel)
examples/
  frames-examples/                  — downstream demo: 9 live datasets maintained by daily ticks
```

## How they compose

`frame` defines the dataset shape (schema + prompt + events.ndjson) and the per-dataset MCP server. `pay` lets a frame loop call paid tools by local name from a `tools.yml` manifest, with x402/MPP payments via faremeter. `catalog` publishes the content-addressed tool descriptors that `pay` resolves. `frames-examples` is the canonical downstream demonstrating the three together.

See each package's `README.md` and `SPEC.md` (where present) for the contract.

## Tooling

- **Bun** ≥ 1.1.30 — workspace-aware install, run, build, publish. Single tool for the codebase.
- **Changesets** — independent versioning + release notes per package.

## Development

```bash
bun install                         # install all workspace deps + hoist
bun run --cwd packages/pay smoke:dispatch
bun run --cwd packages/pay mcp      # spawn pay-mcp from the workspace
```

## Releasing

Independent versions per package. Changesets drives the flow:

```bash
bun run changeset                   # interactively pick changed packages, semver bump, write a markdown changeset
bun run version                     # apply pending changesets: bump versions in package.jsons, generate CHANGELOG entries
bun run release                     # publish each package whose version moved (uses bun publish under the hood)
```

A typical workflow:

1. Make changes across one or more packages.
2. `bun run changeset` — describe the change once per affected package.
3. Commit changesets alongside your PR.
4. On main after merge: `bun run version && git commit -am "chore: release"` then `bun run release`.

`catalog` is a deployable, not a library — it has its own Cloudflare/Vercel deploy workflow and doesn't `bun publish`. Its changesets drive its CHANGELOG and version tagging only.

## Source history

This monorepo was created on 2026-05-05 from four separate repos under `microchipgnu/*` on GitHub: `frame`, `pay`, `catalog`, `frames-examples`. Their commit history was preserved via `git subtree add`. The originals remain on GitHub as historical archives.
