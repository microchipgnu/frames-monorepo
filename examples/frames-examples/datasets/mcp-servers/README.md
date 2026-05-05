# mcp-servers

A live catalog of Model Context Protocol servers published on GitHub. Recursive
on purpose: the dataset is built by an agent using MCP tools, and it tracks
the very protocol that the agent speaks.

## In scope

- Public GitHub repos that ship an MCP server (any language, any transport).
- Repos with >= 20 stars OR endorsed by an official MCP registry.
- Both first-party (Anthropic, model providers) and community servers.

## Out of scope

- MCP clients, IDE integrations, or harnesses that *use* MCP without serving it.
- Forks without meaningful divergence.
- Private/closed-source servers.

## Refresh policy

Daily. Each tick re-fetches stars and last commit; quarterly the discovery
loop re-runs to find new repos. Repos with no commits in 12 months are
deprecated, not deleted.
