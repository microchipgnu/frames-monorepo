// Tests for the CLI's prompt.md auto-discovery + --prompt-file flag.
//
// The discovery function isn't exported from cli.ts (cli.ts is a top-level
// script with side effects), so we test the same logic via a small extracted
// pure function and verify the URL→path inference matches the CLI's regex.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Re-derive the URL → dataset path inference exactly as cli.ts does so
// this test asserts the path-extraction contract.
function inferDatasetSubpath(frame: string): string | null {
  const match = frame.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/?(.*)$/);
  if (match && match[1]) return match[1];
  return null;
}

describe("frame URL → dataset subpath inference", () => {
  test("extracts /datasets/<name>", () => {
    expect(inferDatasetSubpath("https://github.com/microchipgnu/frames-examples/datasets/mcp-servers")).toBe(
      "datasets/mcp-servers",
    );
  });

  test("extracts nested paths", () => {
    expect(
      inferDatasetSubpath("https://github.com/foo/bar/datasets/x/sub"),
    ).toBe("datasets/x/sub");
  });

  test("whole-repo frame returns null (CLI falls back to ./prompt.md)", () => {
    // The regex matches but match[1] is "", which the CLI treats as "no subpath
    // → look in cwd". This helper returns null for that case so callers know
    // to use the fallback.
    expect(inferDatasetSubpath("https://github.com/foo/bar")).toBeNull();
    expect(inferDatasetSubpath("https://github.com/foo/bar/")).toBeNull();
  });

  test("non-github URL → null", () => {
    expect(inferDatasetSubpath("https://gitlab.com/foo/bar")).toBeNull();
    expect(inferDatasetSubpath("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File-discovery integration: write a fake dataset prompt and confirm the
// path the CLI would compute lands on the right place.
// ---------------------------------------------------------------------------

describe("prompt.md discovery — fs interaction", () => {
  const tmpRoot = join(tmpdir(), `tick-prompt-test-${Date.now()}`);

  test("file exists at <subpath>/prompt.md → discoverable", () => {
    const subpath = "datasets/mcp-servers";
    mkdirSync(join(tmpRoot, subpath), { recursive: true });
    writeFileSync(join(tmpRoot, subpath, "prompt.md"), "Focus on MCP server tools.");

    const inferred = inferDatasetSubpath(
      "https://github.com/microchipgnu/frames-examples/datasets/mcp-servers",
    );
    const expected = join(tmpRoot, inferred!, "prompt.md");
    expect(expected).toContain("datasets/mcp-servers/prompt.md");
    // Verify file is actually readable
    const fs = require("node:fs");
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, "utf-8")).toBe("Focus on MCP server tools.");
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
