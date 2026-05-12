// Cloudflare Workers entrypoint. wrangler.toml points main here.
// Bun dev uses src/index.ts instead; both load the same Hono app.

import app from "./app";

export default {
  fetch: app.fetch,
};
