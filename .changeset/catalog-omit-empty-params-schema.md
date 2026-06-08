---
---

catalog: omit `invocation.params_schema` when the upstream OpenAPI declares an
empty/property-less schema (`{}` / `{type:object}`), instead of shipping a
misleading empty contract that reads as "no input needed". Stopgap for the few
registry endpoints (e.g. twitter /api/user-tweets) whose source spec is missing
its requestBody. Projection-script change to the private catalog app; no
published-package version bump.
