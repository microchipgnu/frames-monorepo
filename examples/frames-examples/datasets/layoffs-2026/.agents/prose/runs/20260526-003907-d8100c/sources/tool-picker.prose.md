---
name: tool-picker
kind: service
---

# Tool Picker

### Description

Inspect the pay catalog and the locked toolset; rank which paid search tools
to use for this run based on price, recall, and wallet readiness. Shared by
`layoffs-discover` and `layoffs-curate`.

### Shape

- `self`: read pay manifest + wallet status; rank tools; emit chosen_tools
- `prohibited`: any `pay_tool` invocation (this service is paid-call-free —
  it only chooses)

### Requires

- `frame`: path to the frame directory (used for context: schema.yml,
  README.md)

### Ensures

- `chosen_tools`: `workspace/tool-picker/chosen_tools.json`, a ranked list of
  tool descriptors with `{ rank, name, role, price_hint_usd, rails[], rationale }`
- the chosen set covers at least 2 distinct paid tools when possible
  (`two_tool_minimum_satisfied: true|false` in the output)
- every chosen tool is reachable: `mcp__pay__list_tools` confirms it's
  resolvable AND `mcp__pay__wallet_status` shows a configured wallet for
  one of its accept rails

### Errors

- `NoCatalogTool`: no candidate tool from the manifest is resolvable AND
  payable — abort the parent system

### Invariants

- never invoke `mcp__pay__pay_tool` (price discovery only; settlement is
  the searcher's job)
- prefer tools whose descriptors advertise multi-rail accepts when a
  matching wallet is configured
- reject tools whose only accept rail has no wallet configured

### Strategies

- when the schema description and README mention specific source types
  (news, social, semantic web, filings), bias the ranking toward tools that
  match those types
- when two tools have similar price hints but different rails, prefer the
  one whose accepts match the wallets pay currently holds — avoids
  rail-routing dispatch issues
- when a tool is locked but the descriptor was fetched more than 7 days ago,
  note the staleness; do not refuse to use it, but lower its rank slightly

### Tools

- `mcp:pay`: required — `list_tools`, `wallet_status`, `discover`
