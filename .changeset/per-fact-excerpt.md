---
"@frames-ag/frame": patch
---

Bulk `set_facts` / `add_entity_with_facts` now accept an optional per-fact `excerpt`, overriding the batch `source.excerpt` for that field. Pass `""` to suppress the batch excerpt on fields the quote doesn't substantiate (e.g. timestamps). Fixes the bug where every field in a bulk write surfaced the same quote regardless of what it actually substantiated.
