import { test, expect, describe } from "bun:test";
import { usefulParamsSchema } from "./write-projections.ts";

describe("usefulParamsSchema (#4 stopgap: omit empty/misleading params_schema)", () => {
  test("omits empty / property-less object schemas", () => {
    // The real-world bug: registry endpoints (twitter /api/user-tweets,
    // near-intents /api/quote) declare `{}` for an op that DOES take params.
    expect(usefulParamsSchema({})).toBeUndefined();
    expect(usefulParamsSchema({ type: "object" })).toBeUndefined();
    expect(usefulParamsSchema({ type: "object", properties: {} })).toBeUndefined();
    expect(usefulParamsSchema(undefined)).toBeUndefined();
    expect(usefulParamsSchema(null)).toBeUndefined();
    expect(usefulParamsSchema("nope")).toBeUndefined();
  });

  test("keeps schemas that actually declare a contract", () => {
    const obj = { type: "object", properties: { userName: { type: "string" } }, required: ["userName"] };
    expect(usefulParamsSchema(obj)).toBe(obj);
    expect(usefulParamsSchema({ $ref: "#/components/schemas/Foo" })).toBeTruthy();
    expect(usefulParamsSchema({ allOf: [{ type: "object" }] })).toBeTruthy();
    expect(usefulParamsSchema({ oneOf: [{}] })).toBeTruthy();
    expect(usefulParamsSchema({ type: "array", items: { type: "string" } })).toBeTruthy();
    expect(usefulParamsSchema({ type: "string", enum: ["a", "b"] })).toBeTruthy();
  });
});
