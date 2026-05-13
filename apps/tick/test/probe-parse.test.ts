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

  it("prefers `message` over `error` when both are strings (Brave/llm-context shape)", () => {
    // Real failure observed in production: agent called brave with `query` and
    // got back { error: "Invalid request", message: "q is required" }. The
    // actionable hint is `q is required`, not `Invalid request`.
    const r = parseProbeResponse(
      400,
      JSON.stringify({ error: "Invalid request", message: "q is required" }),
    );
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0].kind).toBe("missing_field");
    expect(r.hints[0].field).toBe("q");
    expect(r.hints[0].message).toContain("q is required");
    expect(r.hints[0].message).toContain("Invalid request");
  });

  it("extracts field name from 'X is required' patterns", () => {
    const r = parseProbeResponse(422, JSON.stringify({ message: "limit is required" }));
    expect(r.hints[0].kind).toBe("missing_field");
    expect(r.hints[0].field).toBe("limit");
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

  it("marks 402 as payment_unhandled and non-retryable", () => {
    // When 402 reaches the probe builder, paidFetch already tried to settle
    // and failed. Agent should pick a different descriptor with a different
    // payment.protocol/network — NOT retry the same one.
    const r = parseProbeResponse(
      402,
      JSON.stringify({
        type: "https://paymentauth.org/problems/payment-required",
        title: "Payment Required",
        status: 402,
        detail: "Payment is required (Locus MPP: brave/llm-context).",
        challengeId: "abc",
      }),
    );
    expect(r.hints[0].kind).toBe("payment_unhandled");
    expect(r.hints[0].message).toContain("Locus MPP");
    expect(r.retryable).toBe(false);
    expect(r.summary).toContain("different descriptor");
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
