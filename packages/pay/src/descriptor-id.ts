import { canonicalize } from "./canonical.ts";

/**
 * Compute the content-addressed identity of a tool descriptor.
 * Per pay/SPEC.md: descriptor_id = "sha256-" + base64url(sha256(jcs(descriptor)))
 *
 * The `descriptor_id` field MUST NOT be present in the descriptor itself —
 * computing it requires hashing the canonical encoding without it.
 */
export async function descriptorId(descriptor: object): Promise<string> {
  const json = canonicalize(descriptor);
  const buf = new TextEncoder().encode(json);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return "sha256-" + base64url(new Uint8Array(hash));
}

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
