// Vercel Edge runtime entrypoint. All paths route here via the rewrite in
// vercel.json; Hono dispatches based on the original URL.
import app from "../src/app";

export const config = { runtime: "edge" };

export default app.fetch;
