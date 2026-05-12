// Bearer-token auth for closed-alpha customers.
//
// Why this exists: pre-Phase-B (no x402 billing yet), customers need a stable
// identity to land in `agent` so we can rate-limit + audit per-customer. The
// IP-hash fallback is too brittle (GitHub Actions runners rotate IPs). x402
// solves it cleanly but requires the facilitator + wallet. This bridges the
// gap.
//
// Wire format:
//   - Operator sets TICK_API_KEYS=key_abc:frames-runtime:0xCustomerA,key_def:frames-runtime:0xCustomerB
//   - Customer sends `Authorization: Bearer key_abc` (or `X-Tick-API-Key: key_abc`)
//   - Server maps the key → agent identifier, uses that identifier for the run
//
// **Security caveats:**
//   - Keys are stored raw in the Worker secret (encrypted at rest by Cloudflare).
//     This is fine for closed alpha with <10 keys; if scale grows, switch to
//     hashed storage with a salt.
//   - Compromised key = same blast radius as a stolen wallet seed (until
//     rotated). Operators should rotate immediately on suspicion.
//   - Phase B replaces this with x402 verify — the verified payer becomes
//     the stable identity, no shared secrets required.

export interface ApiKeyEntry {
  /** Opaque key the client carries. */
  key: string;
  /** Agent identifier this key authenticates as (e.g. `frames-runtime:0xCustomerA`). */
  agent: string;
}

export interface ApiKeyLookup {
  /** True when a Bearer header was present AND matched. */
  matched: boolean;
  /** Agent identifier from the matched entry (or undefined when not matched). */
  agent?: string;
  /** True when a Bearer header was present but didn't match — caller should 401. */
  unauthorized?: boolean;
  /** Reason string when unauthorized=true. */
  reason?: string;
}

/**
 * Parse the TICK_API_KEYS secret into structured entries.
 *
 * Format: `<key1>:<agent1>,<key2>:<agent2>,...`
 *
 * Whitespace around commas and colons is trimmed. Empty entries are dropped.
 * Entries without a colon are dropped (the format requires both halves).
 */
export function parseApiKeys(raw: string | undefined): ApiKeyEntry[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) return null;
      const key = entry.slice(0, colonIdx).trim();
      const agent = entry.slice(colonIdx + 1).trim();
      if (!key || !agent) return null;
      return { key, agent };
    })
    .filter((entry): entry is ApiKeyEntry => entry !== null);
}

/**
 * Extract the bearer token from a request. Accepts:
 *   - `Authorization: Bearer <key>` (RFC 6750, canonical)
 *   - `X-Tick-API-Key: <key>` (convenience for harnesses that swallow Auth)
 *
 * Returns null when neither header is present.
 */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  const xKey = req.headers.get("x-tick-api-key") ?? req.headers.get("X-Tick-API-Key");
  if (xKey) return xKey.trim();
  return null;
}

/**
 * Match a request's bearer token against the configured API keys.
 *
 * Returns:
 *   - `{ matched: false }` when no header was present (fall through to other auth)
 *   - `{ matched: true, agent }` when the header matched a configured key
 *   - `{ matched: false, unauthorized: true, reason }` when a header was present
 *     but didn't match a configured key (caller MUST 401, not fall through)
 *
 * The "header present but bad" → 401 semantic is deliberate: it prevents an
 * attacker from sending a junk key and silently getting IP-hash identity.
 */
export function lookupApiKey(req: Request, rawConfig: string | undefined): ApiKeyLookup {
  const token = extractBearerToken(req);
  if (!token) return { matched: false };

  const entries = parseApiKeys(rawConfig);
  if (entries.length === 0) {
    // Header present but no keys configured. Fail closed — don't pretend to authenticate.
    return {
      matched: false,
      unauthorized: true,
      reason: "Bearer token sent but TICK_API_KEYS is not configured",
    };
  }

  for (const entry of entries) {
    if (constantTimeEquals(entry.key, token)) {
      return { matched: true, agent: entry.agent };
    }
  }
  return {
    matched: false,
    unauthorized: true,
    reason: "Bearer token does not match any configured key",
  };
}

/**
 * Length-aware string equality that doesn't short-circuit on the first
 * mismatched byte. Resists naive timing attacks against the key store.
 *
 * Strings of different lengths fall back to false-without-comparison, which
 * leaks length but not content. For 32-char-plus opaque keys, length leak
 * is acceptable.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
