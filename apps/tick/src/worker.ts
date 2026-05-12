// Cloudflare Workers entrypoint. wrangler.toml points main here.
// Bun dev uses src/index.ts instead; both load the same Hono app.

import app from "./app";

// Durable Object classes — must be exported from the Worker entrypoint so
// wrangler can bind them per wrangler.toml. EntityAgent runs each
// refresh_entity sub-loop in an isolated DO instance for true parallelism
// across entities (Phase C).
export { EntityAgent } from "./agents/entity-agent";

export default {
  fetch: app.fetch,
};
