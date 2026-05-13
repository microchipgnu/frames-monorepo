// Tests for the parseFrameUrl helper. Exercise the regex boundaries
// because a misparse leaks into every op's first round-trip.

import { describe, expect, test } from "bun:test";
import { FrameClientError, parseFrameUrl } from "../src/frame-client.ts";

describe("parseFrameUrl", () => {
  test("bare user/repo", () => {
    const r = parseFrameUrl("https://github.com/microchipgnu/frames-examples");
    expect(r).toEqual({
      user: "microchipgnu",
      repo: "frames-examples",
      frame_path: "",
      ref: "HEAD",
    });
  });

  test("user/repo/frame_path", () => {
    const r = parseFrameUrl("https://github.com/microchipgnu/frames-examples/datasets/mcp-servers");
    expect(r.user).toBe("microchipgnu");
    expect(r.repo).toBe("frames-examples");
    expect(r.frame_path).toBe("datasets/mcp-servers");
    expect(r.ref).toBe("HEAD");
  });

  test("ref via query string", () => {
    const r = parseFrameUrl("https://github.com/u/r/path?ref=v0.4");
    expect(r.frame_path).toBe("path");
    expect(r.ref).toBe("v0.4");
  });

  test("strips trailing slash from frame_path", () => {
    const r = parseFrameUrl("https://github.com/u/r/datasets/foo/");
    expect(r.frame_path).toBe("datasets/foo");
  });

  test("rejects non-github URLs", () => {
    expect(() => parseFrameUrl("https://gitlab.com/u/r")).toThrow(FrameClientError);
    expect(() => parseFrameUrl("http://github.com/u/r")).toThrow(FrameClientError); // http, not https
  });

  test("rejects garbage", () => {
    expect(() => parseFrameUrl("not a url")).toThrow(FrameClientError);
    expect(() => parseFrameUrl("https://github.com/")).toThrow(FrameClientError);
  });

  // v0.3.2 — normalize GitHub web-UI URLs.
  describe("GitHub web-UI URL normalization (v0.3.2+)", () => {
    test("tree/<branch>/path → strips prefix, lifts branch into ref", () => {
      const r = parseFrameUrl(
        "https://github.com/microchipgnu/frames-examples/tree/main/datasets/mcp-servers",
      );
      expect(r.user).toBe("microchipgnu");
      expect(r.repo).toBe("frames-examples");
      expect(r.frame_path).toBe("datasets/mcp-servers");
      expect(r.ref).toBe("main");
    });

    test("blob/<branch>/path/file → keeps file, lifts branch", () => {
      const r = parseFrameUrl(
        "https://github.com/u/r/blob/v0.4/datasets/foo/schema.yml",
      );
      expect(r.frame_path).toBe("datasets/foo/schema.yml");
      expect(r.ref).toBe("v0.4");
    });

    test("explicit ?ref= wins over branch baked into tree/<ref>/", () => {
      const r = parseFrameUrl(
        "https://github.com/u/r/tree/main/path?ref=feature-branch",
      );
      expect(r.frame_path).toBe("path");
      expect(r.ref).toBe("feature-branch");
    });

    test("tree/<branch> with no path → empty frame_path", () => {
      const r = parseFrameUrl("https://github.com/u/r/tree/main");
      expect(r.frame_path).toBe("");
      expect(r.ref).toBe("main");
    });

    test("a path that legitimately starts with 'tree' but isn't tree/<ref>/", () => {
      // Edge case: user repo has a top-level directory literally named "tree".
      // Today our regex catches this — it'd interpret the next segment as
      // ref. We accept the mis-parse on this rare collision; document it.
      const r = parseFrameUrl("https://github.com/u/r/tree/data");
      // Will parse as ref=data, frame_path=""; not ideal but the alternative
      // (failing to normalize the common web-UI case) is worse.
      expect(r.ref).toBe("data");
    });
  });
});
