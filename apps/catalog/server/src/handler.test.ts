import { test, expect, describe } from "bun:test";
import { createHandler } from "./handler.js";
import type { CatalogCache, CachedEntry } from "./cache.js";
import type { ContentSource } from "./content.js";
import type { ToolDescriptor } from "./types.js";

// A cache that serves an in-memory index/merchant set so the handler never hits
// the content source — lets us exercise the /catalog search/ranking directly.
function fakeDeps(tools: ToolDescriptor[]) {
  const store = new Map<string, string>([
    ["index", JSON.stringify(tools)],
    ["index-longtail", JSON.stringify([])],
    ["merchant-index", JSON.stringify([])],
  ]);
  const cache: CatalogCache = {
    get: async (k): Promise<CachedEntry | null> =>
      store.has(k)
        ? { etag: "x", body: store.get(k)!, contentType: "application/json" }
        : null,
    set: async () => {},
    invalidate: async () => {},
    invalidateAll: async () => {},
  };
  return { cache, content: {} as unknown as ContentSource };
}

function tool(over: Partial<ToolDescriptor> & Pick<ToolDescriptor, "id">): ToolDescriptor {
  return {
    pay_protocol: "0.0.1",
    title: over.id,
    description: "",
    capabilities: ["unspecified"],
    invocation: { method: "POST", url: "https://x/" + over.id },
    payment: { protocol: "x402", network: "base" },
    host: over.id + ".example.com",
    _meta: { catalog: "frames-registry" },
    ...over,
  } as ToolDescriptor;
}

async function ids(app: ReturnType<typeof createHandler>, qs: string): Promise<string[]> {
  const res = await app.request("/catalog?" + qs);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tools: ToolDescriptor[] };
  return body.tools.map((t) => t.id);
}

describe("/catalog search (#5: capability is soft + tokens hit capabilities/category)", () => {
  const tools = [
    tool({
      id: "frames.twitter.user-tweets",
      title: "User Tweets",
      description: "Fetch a Twitter/X user's recent posts.",
      capabilities: ["user-timeline"],
    }),
    tool({ id: "bazaar.weather", title: "Weather", capabilities: ["weather"] }),
  ];

  test("over-specific capability phrase still finds the tool (was 0 results)", async () => {
    const app = createHandler(fakeDeps(tools));
    // "fetch user timeline" is NOT an exact capability tag — the old hard filter
    // returned []. Now it tokenizes + ranks against capabilities/title.
    const got = await ids(app, "capability=" + encodeURIComponent("fetch user timeline"));
    expect(got).toContain("frames.twitter.user-tweets");
    expect(got).not.toContain("bazaar.weather"); // weather doesn't match the tokens
  });

  test("exact capability tag still restricts + ranks", async () => {
    const app = createHandler(fakeDeps(tools));
    const got = await ids(app, "capability=user-timeline");
    expect(got).toEqual(["frames.twitter.user-tweets"]);
  });

  test("q matches capability tags now, not just title/description", async () => {
    const app = createHandler(fakeDeps(tools));
    const got = await ids(app, "q=timeline");
    expect(got).toContain("frames.twitter.user-tweets");
  });

  test("no q + no capability returns the full set (unchanged)", async () => {
    const app = createHandler(fakeDeps(tools));
    const got = await ids(app, "");
    expect(got.sort()).toEqual(["bazaar.weather", "frames.twitter.user-tweets"]);
  });
});
