---
"@frames-ag/tick": patch
---

probe-parse: prefer `message` over `error` when both are strings, and extract field names from "X is required" patterns

Observed in the first v0.4.4 probe run on layoffs-2026: Brave returned `{error: "Invalid request", message: "q is required"}` and the parser surfaced only "Invalid request" as the hint — losing the actionable field name. The LLM corrected anyway via the raw response excerpt, but the structured hint should carry the field. Now it does.

- Prefer `message` as the primary hint when both fields are strings; include `error` as a prefix only when distinct.
- New regex `^['"]?(\w+)['"]?\s+is\s+(required|missing)` extracts the field name, upgrades the hint kind to `missing_field`.
- 2 new unit tests covering the Brave shape and the "X is required" pattern.
