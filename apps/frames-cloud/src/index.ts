// Local Bun dev entrypoint. The actual Hono app lives in src/app.ts so it can
// be imported by both Bun (here) and the Vercel edge handler at api/index.ts.
import app from "./app";

export default {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 8787,
  fetch: app.fetch,
};
