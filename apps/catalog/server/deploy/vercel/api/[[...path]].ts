import { createHandler } from "../../../src/handler.js";
import { VercelKvCache } from "../../../src/adapters/vercel-kv.js";
import { defaultContent } from "../../../src/content.js";

const handler = createHandler({
  cache: new VercelKvCache(),
  content: { ...defaultContent, githubToken: process.env.GITHUB_TOKEN },
  webhookSecret: process.env.WEBHOOK_SECRET,
});

export const config = { runtime: "edge" };

export default function (req: Request) {
  return handler.fetch(req);
}
