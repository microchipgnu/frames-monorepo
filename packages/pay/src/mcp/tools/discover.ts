// discover — search the configured catalog (q + capability + pagination).

import type { RuntimeConfig } from "../../config.ts";

export const discoverSchema = {
  name: "discover",
  description:
    "Search the configured catalog. Supports q (free-text across id/title/description), " +
    "capability (tag filter), and limit. Returns a compact list.",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string" },
      capability: { type: "string" },
      limit: { type: "number" },
      cursor: { type: "string" },
    },
  },
};

export async function discoverHandler(args: unknown, config: RuntimeConfig) {
  const { q, capability, limit, cursor } = args as {
    q?: string;
    capability?: string;
    limit?: number;
    cursor?: string;
  };

  const filter: {
    q?: string;
    capability?: string;
    cursor?: string;
    limit?: number;
  } = {};
  if (q !== undefined) filter.q = q;
  if (capability !== undefined) filter.capability = capability;
  if (cursor !== undefined) filter.cursor = cursor;
  filter.limit = limit ?? 25;

  const result = await config.defaultCatalog.list(filter);

  const lines: string[] = [
    `${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}` +
      `${q ? ` matching q="${q}"` : ""}` +
      `${capability ? ` capability="${capability}"` : ""}:`,
    "",
  ];
  for (const t of result.tools) {
    const price = t.payment.price_hint ?? "?";
    const cur = t.payment.currency ?? "";
    const net = t.payment.network ?? "?";
    lines.push(
      `  ${t.id}  [${t.payment.protocol} on ${net}, ${price} ${cur}]`,
    );
    lines.push(`    ${t.title}`);
  }
  if (result.cursor) {
    lines.push("");
    lines.push(`  next cursor: ${result.cursor}`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
