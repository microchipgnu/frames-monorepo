// Cloudflare Worker entry. Mirrors api/index.ts (Vercel edge) — Hono is
// runtime-agnostic, so both adapters just hand off to app.fetch.
//
// Optional bindings declared on Env are wired through to the Hono app via
// per-request locals if/when the app starts using them. Today the app reads
// from GitHub directly with no auth (rate-limit OK at low volume); when we
// want auth, set GITHUB_TOKEN as a Worker secret and the app already has the
// hook to pick it up.

import app from "../../src/app";

export interface Env {
  /** Optional: bumps GitHub rate limit ceiling for raw + commits API. */
  GITHUB_TOKEN?: string;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // Hono accepts an Env object via app.fetch's third arg; types align.
    return app.fetch(req, env, ctx);
  },
};
