# frames-examples

A reference repo showing how to maintain **multiple live datasets** with
[frames](https://github.com/frames-ag) + an agent harness ([opencode](https://opencode.ai))
on a daily cron.

Inspired by the [blindspot.news](https://github.com/microchipgnu/blindspot.news)
pipeline — same pattern, but the writes happen through MCP tools instead of
JSON blobs, so every fact has a source, every change is an event, and the
git history doubles as an audit log.

## What's here

Datasets, each in its own directory under `datasets/`:

| Dataset | What it tracks |
|---|---|
| [`mcp-servers`](datasets/mcp-servers) | Every notable MCP server on GitHub. Recursive: frames cataloging the protocol it speaks. |
| [`ai-promises`](datasets/ai-promises) | Public roadmap commitments by AI labs, with a `shipped?` column. |
| [`ai-models`](datasets/ai-models) | Every notable model release, every vendor, every modality. |
| [`elon-tweets`](datasets/elon-tweets) | Recent posts from @elonmusk on X, classified by topic. |
| [`blindspot-briefs`](datasets/blindspot-briefs) | Daily 8-section analytical briefs on yesterday's news. |
| [`blindspot-threads`](datasets/blindspot-threads) | Non-obvious connections across each day's briefs. |
| [`agent-networks`](datasets/agent-networks) | Open questions on the agent / machine-network economy, with rolling evidence. |
| [`agent-wallets`](datasets/agent-wallets) | Live catalog of agent wallets, registries, and payment protocols + the services each one exposes. |

Each dataset is a self-contained frame: `schema.yml` (the contract),
`prompt.md` (the maintenance loop), `events.ndjson` (the append-only log),
and a regenerated SQLite index under `.frame/`.

## How it works

```
.github/workflows/tick.yml   # daily cron, matrix over datasets
opencode.json                # opencode config: provider + 3 frame MCP servers
.mcp.json                    # same MCP wiring for Claude Code / other clients
datasets/<name>/prompt.md    # per-dataset agent loop
datasets/<name>/schema.yml   # field contract
datasets/<name>/events.ndjson# append-only event log (the source of truth)
```

Every day:

1. GitHub Actions starts a job per dataset.
2. opencode boots with the dataset's frame MCP server attached, plus the
   frames registry for paid discovery APIs (Exa, GitHub, Hugging Face).
3. The agent reads `prompt.md`, queries current state, fetches sources,
   writes facts via `add_entity_with_facts` / `set_fact` / `attach_evidence`.
4. The index is regenerated; the commit is pushed.

No bespoke pipeline code — the loop logic lives in plain markdown prompts.

## Running locally

You need `OPENROUTER_API_KEY` and an agentwallet for the registry. Then:

```bash
# tick one dataset
opencode run "$(cat datasets/mcp-servers/prompt.md)"

# inspect any dataset
npx -y @frames-ag/frame query datasets/ai-models --all
```

Or attach Claude Code (it will pick up `.mcp.json` automatically) and ask:

> Read the schema and prompt under datasets/ai-promises and run one tick.

## Adding a new dataset

```bash
npx -y @frames-ag/frame init datasets/<name>
# edit datasets/<name>/{schema.yml,README.md,prompt.md}
npx -y @frames-ag/frame init-mcp     # rewrites .mcp.json
# add <name> to the matrix in .github/workflows/tick.yml
```

That's the whole authoring surface: a schema, a scope description, and a
loop prompt. The engine is the same.

## Credits

- [frames](https://github.com/frames-ag) — the protocol and CLI
- [opencode](https://opencode.ai) — the agent harness
- [blindspot.news](https://github.com/microchipgnu/blindspot.news) — the
  pipeline shape that inspired this layout
