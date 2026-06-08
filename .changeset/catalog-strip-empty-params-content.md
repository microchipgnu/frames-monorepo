---
---

catalog content: strip the empty `params_schema: {}` from the two descriptors
whose upstream OpenAPI declares no requestBody (twitter user-tweets, near-intents
quote), so the live /tools/:id stops shipping a misleading empty contract now.
Companion to the projection change (#28) that prevents it going forward.
