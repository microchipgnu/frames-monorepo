// Local Bun dev entrypoint. The Hono app lives in src/app.ts so it can be
// imported by both Bun (here) and the Cloudflare Workers handler at src/worker.ts.

import app from "./app";

export default {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 8788,
  fetch: app.fetch,
};
