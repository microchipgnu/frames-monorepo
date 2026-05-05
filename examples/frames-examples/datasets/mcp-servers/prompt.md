# mcp-servers — daily tick

You are maintaining a live dataset of Model Context Protocol servers on GitHub.
The schema and scope are defined in `datasets/mcp-servers/schema.yml` and
`datasets/mcp-servers/README.md`. Read both before doing anything.

You have two MCP servers wired in:
- `frame-mcp-servers` — write entities and facts to the dataset
- The frames registry — paid APIs for discovery (Exa for search, GitHub for
  repo metadata)

## Loop

1. **Inventory.** Use `mcp__frame-mcp-servers__query` (mode=all) to read the
   current state. Note which entities exist and the freshness of their facts.

2. **Refresh existing rows.** For each entity, hit GitHub's public API
   (`api.github.com/repos/<owner>/<repo>`) to refresh `stars`,
   `last_commit_at`, `language`, and `description`. Use `set_fact` per field
   with the GitHub API URL as the source. Skip fields where the value is
   unchanged.

3. **Discover new servers.** Use Exa search (via the registry) for queries
   like `"MCP server" site:github.com`, `model context protocol server stars:>20`,
   plus the official MCP registry pages. For every new candidate:
   - Verify it's a server (not a client / harness).
   - Confirm ≥ 20 stars OR registry endorsement.
   - Call `add_entity_with_facts` with name, repo_url, description, stars,
     language, category, transport, and the discovery URL as source.

4. **Deprecate.** If `last_commit_at` is older than 12 months, call
   `deprecate_fact` on the entity's primary fields with reason
   "no-activity-12mo". Do NOT remove the entity.

5. **Stop.** Do not write speculative fields. If you can't find a value with
   evidence, skip it.

## Constraints

- Every fact MUST have a source URL. Prefer the GitHub API URL or the repo's
  README over generic search results.
- Slug entity_ids: lowercase, hyphenated, owner-repo (e.g.
  `anthropic-mcp-fetch`).
- One pass per tick; do not loop indefinitely. Aim for ~50 entity touches
  max per run.

## Done when

- All existing entities have been considered for refresh.
- At least one discovery query has been run.
- A short summary of touches (added / refreshed / deprecated) is printed.
