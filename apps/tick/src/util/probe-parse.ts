// Parse a paid-tool error response into structured hints the LLM agent can act on.
//
// Handles the JSON shapes that actually come up in the wild — FastAPI / Pydantic
// validation errors, plain `{error}`/`{message}`, RFC-7807 problem-details. Plain
// text and HTML bodies fall through to an "unknown" hint with the raw excerpt.

export type ProbeHintKind =
  | "missing_field"
  | "invalid_value"
  | "auth_required"
  | "rate_limited"
  | "not_found"
  | "server_error"
  | "unknown";

export interface ProbeHint {
  kind: ProbeHintKind;
  field?: string;
  message: string;
  suggested?: unknown;
}

export interface ProbeParseResult {
  hints: ProbeHint[];
  summary: string;
  retryable: boolean;
}

export function parseProbeResponse(status: number, body: string): ProbeParseResult {
  const retryable = status >= 400 && status < 500 && status !== 404;
  const baseKind = statusKind(status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      hints: [{ kind: baseKind, message: body.slice(0, 200) || `HTTP ${status}` }],
      summary: `HTTP ${status}: ${(body || "").slice(0, 120)}`,
      retryable,
    };
  }

  const hints: ProbeHint[] = [];

  if (Array.isArray((parsed as { detail?: unknown })?.detail)) {
    for (const d of (parsed as { detail: unknown[] }).detail) {
      if (!d || typeof d !== "object") continue;
      const e = d as { loc?: unknown[]; msg?: string; type?: string };
      const field = Array.isArray(e.loc) ? e.loc.filter((x) => typeof x === "string").join(".") : undefined;
      hints.push({
        kind: e.type?.startsWith("value_error.missing") ? "missing_field" : "invalid_value",
        field,
        message: e.msg ?? "validation error",
      });
    }
  }

  if (hints.length === 0) {
    const obj = parsed as Record<string, unknown>;
    const errVal = obj?.error;
    const msgVal = obj?.message;
    const errStr = typeof errVal === "string" ? errVal : undefined;
    const msgStr = typeof msgVal === "string" ? msgVal : undefined;
    if (errVal && typeof errVal === "object") {
      const e = errVal as { message?: string; code?: string; field?: string };
      hints.push({ kind: baseKind, field: e.field, message: e.message ?? e.code ?? "error" });
    } else if (errStr || msgStr) {
      // Brave-style: { error: "Invalid request", message: "q is required" }.
      // The actionable hint is in `message`; `error` is just the kind/title.
      // Prefer `message` and prefix `error` only when distinct + useful.
      const primary = msgStr ?? errStr ?? "error";
      const combined = errStr && msgStr && errStr !== msgStr ? `${errStr}: ${msgStr}` : primary;
      const fieldMatch = primary.match(/^['"]?(\w+)['"]?\s+is\s+(required|missing)/i);
      hints.push({
        kind: fieldMatch ? "missing_field" : baseKind,
        ...(fieldMatch ? { field: fieldMatch[1] } : {}),
        message: combined,
      });
    } else if (typeof obj?.detail === "string") {
      hints.push({ kind: baseKind, message: obj.detail as string });
    }
  }

  if (Array.isArray((parsed as { errors?: unknown })?.errors)) {
    for (const e of (parsed as { errors: unknown[] }).errors) {
      if (!e || typeof e !== "object") continue;
      const ex = e as { field?: string; message?: string; code?: string };
      hints.push({
        kind: ex.code === "required" || /missing|required/i.test(ex.message ?? "") ? "missing_field" : "invalid_value",
        field: ex.field,
        message: ex.message ?? ex.code ?? "error",
      });
    }
  }

  if (hints.length === 0) {
    hints.push({ kind: baseKind, message: JSON.stringify(parsed).slice(0, 200) });
  }

  const summary = summarize(status, hints);
  return { hints, summary, retryable };
}

function statusKind(status: number): ProbeHintKind {
  if (status === 401 || status === 403) return "auth_required";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "invalid_value";
}

function summarize(status: number, hints: ProbeHint[]): string {
  const missing = hints.filter((h) => h.kind === "missing_field" && h.field).map((h) => h.field);
  if (missing.length > 0) return `HTTP ${status}: missing required fields: ${missing.join(", ")}`;
  const invalid = hints.filter((h) => h.kind === "invalid_value" && h.field).map((h) => `${h.field}=${h.message}`);
  if (invalid.length > 0) return `HTTP ${status}: invalid: ${invalid.slice(0, 3).join("; ")}`;
  return `HTTP ${status}: ${hints[0]?.message ?? "error"}`;
}
