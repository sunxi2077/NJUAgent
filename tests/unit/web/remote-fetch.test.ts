import { describe, expect, test } from "vitest";

import {
  RemoteFetchError,
  normalizeRemoteUrl,
} from "../../../src/web/remote-fetch.js";

function expectInvalid(raw: string): void {
  let error: unknown;
  try {
    normalizeRemoteUrl(raw);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RemoteFetchError);
  if (error instanceof RemoteFetchError) {
    expect(error.kind).toBe("invalid_url");
  }
}

describe("normalizeRemoteUrl validation", () => {
  test("accepts a plain https text URL", () => {
    expect(normalizeRemoteUrl("https://example.com/readme.md")).toEqual({
      mode: "direct",
      targetUrl: "https://example.com/readme.md",
    });
  });

  test.each([
    "http://example.com/readme.md",
    "file:///etc/passwd",
    "data:text/plain,hello",
    "javascript:alert(1)",
  ])("rejects an unsafe scheme: %s", (raw) => {
    expectInvalid(raw);
  });

  test("rejects a URL with embedded credentials", () => {
    expectInvalid("https://user:secret@example.com/file.md");
  });

  test("rejects a fragment-only value", () => {
    expectInvalid("#section");
  });

  test("strips a fragment from an otherwise valid URL", () => {
    expect(normalizeRemoteUrl("https://example.com/guide.md#intro")).toEqual({
      mode: "direct",
      targetUrl: "https://example.com/guide.md",
    });
  });

  test("rejects a URL longer than 2048 characters", () => {
    const long = `https://example.com/${"x".repeat(2050)}`;
    expectInvalid(long);
  });
});

describe("normalizeRemoteUrl GitHub adapter", () => {
  test("converts a blob URL to the GitHub Contents API", () => {
    expect(
      normalizeRemoteUrl("https://github.com/a/b/blob/main/docs/x.md"),
    ).toEqual({
      mode: "github-file",
      targetUrl: "https://api.github.com/repos/a/b/contents/docs/x.md?ref=main",
    });
  });

  test("converts a tree URL to a Contents API directory listing", () => {
    expect(
      normalizeRemoteUrl("https://github.com/a/b/tree/main/skills/frontend-design"),
    ).toEqual({
      mode: "github-directory",
      targetUrl:
        "https://api.github.com/repos/a/b/contents/skills/frontend-design?ref=main",
    });
  });

  test("converts a repository-root tree URL to the Contents API root", () => {
    expect(normalizeRemoteUrl("https://github.com/a/b/tree/main")).toEqual({
      mode: "github-directory",
      targetUrl: "https://api.github.com/repos/a/b/contents?ref=main",
    });
  });

  test("keeps a raw URL as a direct fetch", () => {
    expect(
      normalizeRemoteUrl("https://raw.githubusercontent.com/a/b/main/x.md"),
    ).toEqual({
      mode: "direct",
      targetUrl: "https://raw.githubusercontent.com/a/b/main/x.md",
    });
  });

  test("falls back to a direct fetch for malformed GitHub paths", () => {
    // blob with no file path is not a well-formed file reference.
    expect(
      normalizeRemoteUrl("https://github.com/a/b/blob/main"),
    ).toEqual({
      mode: "direct",
      targetUrl: "https://github.com/a/b/blob/main",
    });
    // A segment that decodes to a slash cannot be part of a Contents path.
    expect(
      normalizeRemoteUrl("https://github.com/a/b/blob/main/a%2Fb.md"),
    ).toEqual({
      mode: "direct",
      targetUrl: "https://github.com/a/b/blob/main/a%2Fb.md",
    });
    // A non github.com host with a blob-looking path stays direct.
    expect(
      normalizeRemoteUrl("https://example.com/a/b/blob/main/x.md"),
    ).toEqual({
      mode: "direct",
      targetUrl: "https://example.com/a/b/blob/main/x.md",
    });
  });

  test("percent-encodes path and ref segments for the Contents API", () => {
    const result = normalizeRemoteUrl(
      "https://github.com/acme/ui/blob/main/docs%20guide.md",
    );
    expect(result).toEqual({
      mode: "github-file",
      targetUrl:
        "https://api.github.com/repos/acme/ui/contents/docs%20guide.md?ref=main",
    });
  });
});

describe("RemoteFetchError", () => {
  test("carries only a stable kind and message", () => {
    const error = new RemoteFetchError("unavailable", "Remote fetch failed.");
    expect(error.kind).toBe("unavailable");
    expect(error.message).toBe("Remote fetch failed.");
    expect(error.name).toBe("RemoteFetchError");
  });
});
