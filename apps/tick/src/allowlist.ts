// Agent allowlist for the hosted `/run` endpoint.
//
// Why this exists: v1 hosted ships without a facilitator. Without a payment
// gate, every `/run` call costs the operator LLM + tool money. Per-IP rate
// limits block casual abuse but not determined abuse. An allowlist gives
// operators a deterministic gate during the alpha — only explicitly-named
// agents can hit `/run` at all. Phase B replaces this with x402 payment
// verification (CDP or self-host Faremeter) and the allowlist becomes
// opt-out via `TICK_ALLOWED_AGENTS=*`.
//
// Safe defaults: when `TICK_ALLOWED_AGENTS` is unset, the hosted endpoint
// is **closed**. New deploys can't be abused before an operator configures
// it. CLI usage is unaffected — the allowlist only gates HTTP requests.
//
// Match semantics:
//   - `*` anywhere in the list → open mode (everyone allowed)
//   - exact string match against the resolved `agent` value
//   - trailing `*` is a prefix glob (`ip:7f1a*` matches `ip:7f1a4b2c...`)

export interface AllowlistDecision {
  /** True when this agent can proceed; false to 403. */
  allowed: boolean;
  /** True when the operator has explicitly opened the gate (entry contained `*`). */
  open: boolean;
  /** Number of distinct allowlist entries the operator configured. */
  entries: number;
  /** Reason string when allowed=false, surfaced in the 403 body. */
  reason?: string;
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function checkAllowlist(agent: string, rawAllowlist: string | undefined): AllowlistDecision {
  const entries = parseAllowlist(rawAllowlist);

  if (entries.length === 0) {
    return {
      allowed: false,
      open: false,
      entries: 0,
      reason: "Hosted /run is closed. Set TICK_ALLOWED_AGENTS to opt in callers (or `*` to open the gate).",
    };
  }

  // Open-gate sentinel — any `*` entry opens the endpoint.
  if (entries.includes("*")) {
    return { allowed: true, open: true, entries: entries.length };
  }

  for (const entry of entries) {
    if (entry === agent) {
      return { allowed: true, open: false, entries: entries.length };
    }
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (agent.startsWith(prefix)) {
        return { allowed: true, open: false, entries: entries.length };
      }
    }
  }

  return {
    allowed: false,
    open: false,
    entries: entries.length,
    reason: `agent ${agent} is not in TICK_ALLOWED_AGENTS (${entries.length} entries)`,
  };
}
