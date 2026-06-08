---
---

catalog-refresh: fix the commit step staging nothing (atomic `git add` failure on
absent staging/*-cache.json pathspecs), which silently no-op'd every refresh for
weeks and froze the catalog content. Stage content/ unconditionally; add optional
caches only when present.
