// JSON Canonicalization Scheme (RFC 8785).
// Sort object keys lexicographically, normalize numbers per ECMAScript,
// no insignificant whitespace, UTF-8 strings.
//
// Identical to catalog/server/src/canonical.ts — could be shared via
// a published @frames-ag/canonical package later, but copying for now
// to keep pay's library zero-dependency on the catalog server.

export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return serializeString(value);
  if (Array.isArray(value)) {
    return "[" + value.map(serialize).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => serializeString(k) + ":" + serialize(obj[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot canonicalize non-finite number ${n}`);
  }
  return n.toString();
}

function serializeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}
