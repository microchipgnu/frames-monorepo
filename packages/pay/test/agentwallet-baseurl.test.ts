// Regression tests for the agentwallet baseUrl resolution path.
//
// Background: older agentwallet onboardings wrote ~/.agentwallet/config.json
// without a `baseUrl` field. The detector silently masked the omission (using
// `"frames.ag"` as a display-only label) while the loader strictly required
// the field and threw at first use. These tests pin the resolved behavior:
//
//   1. loader defaults `baseUrl` to `https://frames.ag` when no source provides it
//   2. `base_url` in the pay config stanza overrides everything
//   3. `AGENTWALLET_BASE_URL` env var is honored as a last resort before the default
//   4. `baseUrl` in ~/.agentwallet/config.json is preferred over the env + default
//   5. detector surfaces the synthesized default — does not silently mask it

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRuntimeConfig } from "../src/config.js";
import { detectAll } from "../src/cli/detect.js";

const TMP = "/tmp/pay-agentwallet-baseurl-test";

interface AgentwalletFile {
  username?: string;
  apiToken?: string;
  baseUrl?: string;
  evmAddress?: string;
  solanaAddress?: string;
}

function setupHome(file: AgentwalletFile): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".agentwallet"), { recursive: true });
  mkdirSync(join(TMP, ".frames", "pay"), { recursive: true });
  writeFileSync(
    join(TMP, ".agentwallet", "config.json"),
    JSON.stringify(file, null, 2),
  );
  return TMP;
}

function writePayConfig(yaml: string): string {
  const path = join(TMP, ".frames", "pay", "config.yaml");
  writeFileSync(path, yaml);
  return path;
}

const VALID_AGENTWALLET: AgentwalletFile = {
  username: "testuser",
  apiToken: "mf_fake_token_for_test",
  evmAddress: "0x4D4C140f5Af458Cb335B7a360E42f3b7E0370459",
};

let prevHome: string | undefined;
let prevEnvBaseUrl: string | undefined;

beforeEach(() => {
  prevHome = process.env["HOME"];
  prevEnvBaseUrl = process.env["AGENTWALLET_BASE_URL"];
  delete process.env["AGENTWALLET_BASE_URL"];
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevEnvBaseUrl === undefined) delete process.env["AGENTWALLET_BASE_URL"];
  else process.env["AGENTWALLET_BASE_URL"] = prevEnvBaseUrl;
  rmSync(TMP, { recursive: true, force: true });
});

describe("agentwallet loader baseUrl resolution", () => {
  test("defaults to https://frames.ag when no source provides baseUrl", async () => {
    process.env["HOME"] = setupHome(VALID_AGENTWALLET);
    const payConfig = writePayConfig(`
agent: claude:opus-4.7
wallets:
  base:
    kind: agentwallet
    label: my-agentwallet
`);

    const cfg = await loadRuntimeConfig(payConfig);
    const entry = cfg.registry.forNetwork("base");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("delegated");
    if (entry!.kind !== "delegated") throw new Error("type guard");
    expect(entry!.provider).toBe("agentwallet");
    expect(entry!.baseUrl).toBe("https://frames.ag");
  });

  test("pay config base_url overrides the file and the default", async () => {
    process.env["HOME"] = setupHome({
      ...VALID_AGENTWALLET,
      baseUrl: "https://from-file.example",
    });
    const payConfig = writePayConfig(`
agent: claude:opus-4.7
wallets:
  base:
    kind: agentwallet
    label: my-agentwallet
    base_url: https://from-stanza.example
`);

    const cfg = await loadRuntimeConfig(payConfig);
    const entry = cfg.registry.forNetwork("base");
    if (!entry || entry.kind !== "delegated") throw new Error("expected delegated entry");
    expect(entry.baseUrl).toBe("https://from-stanza.example");
  });

  test("file baseUrl is used when no stanza override is set", async () => {
    process.env["HOME"] = setupHome({
      ...VALID_AGENTWALLET,
      baseUrl: "https://from-file.example",
    });
    const payConfig = writePayConfig(`
agent: claude:opus-4.7
wallets:
  base:
    kind: agentwallet
    label: my-agentwallet
`);

    const cfg = await loadRuntimeConfig(payConfig);
    const entry = cfg.registry.forNetwork("base");
    if (!entry || entry.kind !== "delegated") throw new Error("expected delegated entry");
    expect(entry.baseUrl).toBe("https://from-file.example");
  });

  test("AGENTWALLET_BASE_URL env var is honored when file lacks baseUrl and stanza has no override", async () => {
    process.env["HOME"] = setupHome(VALID_AGENTWALLET);
    process.env["AGENTWALLET_BASE_URL"] = "https://from-env.example";
    const payConfig = writePayConfig(`
agent: claude:opus-4.7
wallets:
  base:
    kind: agentwallet
    label: my-agentwallet
`);

    const cfg = await loadRuntimeConfig(payConfig);
    const entry = cfg.registry.forNetwork("base");
    if (!entry || entry.kind !== "delegated") throw new Error("expected delegated entry");
    expect(entry.baseUrl).toBe("https://from-env.example");
  });

  test("still rejects when apiToken is missing — that's a real misconfig", async () => {
    process.env["HOME"] = setupHome({
      username: "testuser",
      evmAddress: "0x4D4C140f5Af458Cb335B7a360E42f3b7E0370459",
      // apiToken intentionally omitted
    });
    const payConfig = writePayConfig(`
agent: claude:opus-4.7
wallets:
  base:
    kind: agentwallet
    label: my-agentwallet
`);

    await expect(loadRuntimeConfig(payConfig)).rejects.toThrow(/missing apiToken/);
  });

  test("still rejects when username is missing — that's a real misconfig", async () => {
    process.env["HOME"] = setupHome({
      apiToken: "mf_fake",
      evmAddress: "0x4D4C140f5Af458Cb335B7a360E42f3b7E0370459",
      // username intentionally omitted
    });
    const payConfig = writePayConfig(`
agent: claude:opus-4.7
wallets:
  base:
    kind: agentwallet
    label: my-agentwallet
`);

    await expect(loadRuntimeConfig(payConfig)).rejects.toThrow(/missing username/);
  });
});

describe("agentwallet detector — surfaces the synthesized default", () => {
  test("when baseUrl is in the file, label has no '(defaulted)' marker and yaml has no comment", () => {
    process.env["HOME"] = setupHome({
      ...VALID_AGENTWALLET,
      baseUrl: "https://from-file.example",
    });
    const found = detectAll().filter((d) => d.kind === "agentwallet");
    expect(found.length).toBe(1);
    const det = found[0]!;
    expect(det.label).toBe("agentwallet @ https://from-file.example");
    expect(det.label.includes("defaulted")).toBe(false);
    expect(det.yamlSnippet).toContain("base_url: https://from-file.example");
    expect(det.yamlSnippet).not.toContain("# defaulted");
  });

  test("when baseUrl is missing, label flags '(defaulted)' and yaml includes an inline comment", () => {
    process.env["HOME"] = setupHome(VALID_AGENTWALLET);
    const found = detectAll().filter((d) => d.kind === "agentwallet");
    expect(found.length).toBe(1);
    const det = found[0]!;
    expect(det.label).toBe("agentwallet @ https://frames.ag (defaulted)");
    expect(det.yamlSnippet).toContain("base_url: https://frames.ag");
    expect(det.yamlSnippet).toContain("# defaulted");
    // entries written by `init --auto` must carry base_url so the override
    // lands in the user's pay config and the file's missing baseUrl doesn't
    // surprise them again on the next load.
    const evm = det.entries.find((e) => e.network === "base");
    expect(evm).toBeDefined();
    expect((evm!.config as Record<string, unknown>)["base_url"]).toBe(
      "https://frames.ag",
    );
  });
});
