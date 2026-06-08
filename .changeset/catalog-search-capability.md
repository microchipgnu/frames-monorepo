---
---

catalog: make `/catalog` capability a soft/ranked signal — over-specific intent
("fetch user timeline") now ranks across capability tags + merchant category
instead of returning 0 results. Deploy-only change to the private catalog-server
app; no published-package version bump.
