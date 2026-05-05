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

Independent versions per package. **Automated via `.github/workflows/release.yml`**: every push to `main` runs the [Changesets action](https://github.com/changesets/action), which either opens a "Version Packages" PR (when `.changeset/*.md` files exist) or publishes (when a package's local version is ahead of npm).

The flow:

1. Make code changes on a feature branch.
2. `bun run changeset` — describe the change once per affected package; commit the resulting `.changeset/<name>.md` alongside your code.
3. Open a PR to `main`. The PR's diff includes the changeset files.
4. On merge → the release action runs:
   - **If pending changesets**: opens or updates a single "Version Packages" PR that runs `bun run version` (bumps all changed packages' versions, generates `CHANGELOG.md` entries, deletes the consumed changeset files).
   - **If no pending changesets but versions moved**: runs `bun run release` (`bunx changeset publish` → `bun publish` per package), creates git tags, surfaces published packages in the run summary.
5. Merging the "Version Packages" PR triggers another action run that ships to npm.

Manual fallback (when bypassing CI):

```bash
bun run changeset    # write a changeset
bun run version      # apply pending changesets
bun run release      # publish (requires `npm login` or NPM_TOKEN)
```

`catalog` and `frames-examples` are private (`"private": true` + in changesets `ignore` list), so the action skips publishing them. Catalog ships content updates by being mirrored to https://catalog.microchipgnu.workers.dev (the Worker reads from the GitHub repo's main branch).

### One-time GitHub setup

1. Create npm automation token: https://www.npmjs.com/settings/<user>/tokens → "Generate New Token" → **Granular** → "Publish" + 30+ day expiry → set as **automation** (bypasses 2FA).
2. Add as GitHub Actions secret: repo → Settings → Secrets and variables → Actions → New repository secret → name `NPM_TOKEN`.
3. The `GITHUB_TOKEN` is automatically provided by Actions; make sure repo settings allow Actions to "Read and write" + "Create and approve pull requests" (Settings → Actions → General → Workflow permissions).

## Source history

This monorepo was created on 2026-05-05 from four separate repos under `microchipgnu/*` on GitHub: `frame`, `pay`, `catalog`, `frames-examples`. Their commit history was preserved via `git subtree add`. The originals remain on GitHub as historical archives.
