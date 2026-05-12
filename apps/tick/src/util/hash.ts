// SHA-256 via WebCrypto — used everywhere we need a stable hash of an input.
//
// Replaces the non-cryptographic dbj2 hash that originally appeared in three
// places (refetcher / paid-refetcher / catalog-dispatch). dbj2 collides
// trivially under adversarial input; `input_hash` in tool_calls is used for
// receipt verification and idempotent replay, so it needs to be real.

const enc = new TextEncoder();

/**
 * SHA-256 of a UTF-8 string, returned as `sha256-<base64url>` (matching pay's
 * descriptor_id convention from packages/pay/SPEC.md).
 */
export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return `sha256-${base64url(new Uint8Array(digest))}`;
}

/**
 * Synchronous fallback for places where async isn't an option (e.g. inside
 * a synchronous dispatch path). Marked clearly as non-cryptographic; use
 * `sha256()` for anything load-bearing.
 */
export function fastNonCryptoHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return `dbj2-${h.toString(16).padStart(8, "0")}`;
}

function base64url(bytes: Uint8Array): string {
  // Workers + Node + Bun all expose btoa(). Convert bytes → binary string → btoa → URL-safe.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
