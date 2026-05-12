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
});
