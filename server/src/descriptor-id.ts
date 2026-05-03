import { canonicalize } from "./canonical.js";

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
