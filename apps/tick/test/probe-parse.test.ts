import { describe, expect, it } from "bun:test";
import { parseProbeResponse } from "../src/util/probe-parse";

describe("parseProbeResponse", () => {
  it("parses FastAPI validation errors with loc/msg/type", () => {
    const body = JSON.stringify({
      detail: [
        { loc: ["body", "query"], msg: "field required", type: "value_error.missing" },
        { loc: ["body", "limit"], msg: "value is not a valid integer", type: "type_error.integer" },
      ],
    });
    const r = parseProbeResponse(422, body);
    expect(r.retryable).toBe(true);
    expect(r.hints).toHaveLength(2);
    expect(r.hints[0].kind).toBe("missing_field");
    expect(r.hints[0].field).toBe("body.query");
    expect(r.hints[1].kind).toBe("invalid_value");
    expect(r.hints[1].field).toBe("body.limit");
    expect(r.summary).toContain("missing required fields");
    expect(r.summary).toContain("body.query");
  });

  it("parses { error: 'string' } shape", () => {
    const r = parseProbeResponse(400, JSON.stringify({ error: "invalid api key format" }));
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0].message).toBe("invalid api key format");
    expect(r.retryable).toBe(true);
  });

  it("parses { error: { message, field } } shape", () => {
    const r = parseProbeResponse(
      400,
      JSON.stringify({ error: { message: "query too long", field: "query", code: "max_length" } }),
    );
    expect(r.hints[0].message).toBe("query too long");
    expect(r.hints[0].field).toBe("query");
  });

  it("parses RFC-7807-ish { errors: [...] }", () => {
    const r = parseProbeResponse(
      400,
      JSON.stringify({
        errors: [
          { field: "url", message: "missing", code: "required" },
          { field: "format", message: "not a valid choice" },
        ],
      }),
    );
    expect(r.hints).toHaveLength(2);
    expect(r.hints[0].kind).toBe("missing_field");
    expect(r.hints[0].field).toBe("url");
    expect(r.hints[1].kind).toBe("invalid_value");
  });

  it("marks 401/403 as auth_required, non-retryable status-wise", () => {
    const r = parseProbeResponse(401, JSON.stringify({ message: "missing bearer token" }));
    expect(r.hints[0].kind).toBe("auth_required");
    expect(r.retryable).toBe(true); // 401 is technically retryable by the rule (4xx, not 404), but the agent should pick a different descriptor
    expect(r.summary).toContain("missing bearer token");
  });

  it("marks 404 as not_found and non-retryable", () => {
    const r = parseProbeResponse(404, JSON.stringify({ error: "endpoint removed" }));
    expect(r.hints[0].kind).toBe("not_found");
    expect(r.retryable).toBe(false);
  });

  it("marks 429 as rate_limited", () => {
    const r = parseProbeResponse(429, JSON.stringify({ message: "slow down" }));
    expect(r.hints[0].kind).toBe("rate_limited");
  });

  it("marks 5xx as server_error and non-retryable", () => {
    const r = parseProbeResponse(503, JSON.stringify({ error: "unavailable" }));
    expect(r.hints[0].kind).toBe("server_error");
    expect(r.retryable).toBe(false);
  });

  it("falls through on non-JSON bodies (plain text)", () => {
    const r = parseProbeResponse(400, "Bad Request — query cannot be empty");
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0].message).toContain("query cannot be empty");
  });

  it("falls through on empty bodies", () => {
    const r = parseProbeResponse(500, "");
    expect(r.hints[0].kind).toBe("server_error");
    expect(r.summary).toContain("500");
  });
});
