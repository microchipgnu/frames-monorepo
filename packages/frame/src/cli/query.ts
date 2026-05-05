// `frame query [<path>] [--all|--entity <id>|--field <f>=<v>|--sql <sql>|--tool-invocations] [--with-sources] [--since <iso>] [--tool-id <id>] [--limit <n>]`

import { Frame } from "../frame.js";
import { resolveFrameDir, splitPathAndFlags } from "./util.js";

export function query(args: string[]): void {
  const { path, flags } = splitPathAndFlags(args);
  const dir = resolveFrameDir(path);
  const frame = new Frame(dir);

  const include_sources = flags.includes("--with-sources");
  // Strip the flag so positional parsing below isn't affected.
  let positional = flags.filter((a) => a !== "--with-sources");

  // ── Tool-invocations mode (paid-call audit) ─────────────────────────────
  if (positional[0] === "--tool-invocations") {
    const opts: { since?: string; tool_id?: string; limit?: number } = {};
    for (let i = 1; i < positional.length; i++) {
      const a = positional[i];
      const next = positional[i + 1];
      if (a === "--since" && next) {
        opts.since = next;
        i++;
      } else if (a === "--tool-id" && next) {
        opts.tool_id = next;
        i++;
      } else if (a === "--limit" && next) {
        opts.limit = parseInt(next, 10);
        i++;
      }
    }
    const r = frame.toolInvocations(opts);
    for (const row of r.rows) process.stdout.write(JSON.stringify(row) + "\n");
    const totalsStr = Object.entries(r.total_amount_by_currency)
      .map(([c, n]) => `${n} ${c}`)
      .join(", ") || "—";
    process.stderr.write(
      `◇ ${r.total} tool.invoked event${r.total === 1 ? "" : "s"}; total: ${totalsStr}\n`,
    );
    return;
  }

  let result;

  if (positional.includes("--all") || positional.length === 0) {
    result = frame.query({ mode: "all", include_sources });
  } else if (positional[0] === "--entity") {
    const id = positional[1];
    if (!id) {
      console.error("usage: frame query <name> --entity <id> [--with-sources]");
      process.exit(1);
    }
    result = frame.query({ mode: "entity", entity_id: id, include_sources });
  } else if (positional[0] === "--field") {
    const fv = positional[1];
    if (!fv) {
      console.error("usage: frame query <name> --field <field>[=<value>] [--with-sources]");
      process.exit(1);
    }
    const eq = fv.indexOf("=");
    if (eq === -1) {
      result = frame.query({ mode: "field", field: fv, include_sources });
    } else {
      result = frame.query({
        mode: "field",
        field: fv.slice(0, eq),
        value: fv.slice(eq + 1),
        include_sources,
      });
    }
  } else if (positional[0] === "--sql") {
    const sql = positional.slice(1).join(" ");
    if (!sql) {
      console.error("usage: frame query <name> --sql <statement>");
      process.exit(1);
    }
    result = frame.query({ mode: "sql", sql });
  } else {
    console.error(
      "usage: frame query <name> [--all|--entity <id>|--field <f>[=<v>]|--sql <sql>] [--with-sources]",
    );
    process.exit(1);
  }

  // emit one row per line — caller can pipe to jq
  for (const r of result.rows) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
  process.stderr.write(`◇ ${result.total} rows\n`);
}
