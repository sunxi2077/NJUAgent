import { describe, expect, test } from "vitest";

import {
  NativeRemoteFetchProvider,
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


describe("NativeRemoteFetchProvider", () => {
  type FakeRoute = {
    status: number;
    body?: string;
    headers?: Record<string, string>;
    location?: string;
  };

  function okResponse(route: FakeRoute): Response {
    const bytes = new TextEncoder().encode(route.body ?? "");
    const headers = new Headers(route.headers ?? {});
    if (route.location !== undefined) {
      headers.set("location", route.location);
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return new Response(body, {
      status: route.status,
      headers,
      // Native fetch is called with manual redirects; expose the raw body.
    }) as Response;
  }

  function fakeFetch(routes: Record<string, FakeRoute>): typeof fetch {
    return ((input: string | URL) => {
      const url = String(input);
      const route = routes[url];
      if (route === undefined) {
        return Promise.reject(new TypeError(`fetch failed: no route for ${url}`));
      }
      return Promise.resolve(okResponse(route));
    }) as typeof fetch;
  }

  function makeProvider(
    routes: Record<string, FakeRoute>,
    options: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {
    return new NativeRemoteFetchProvider({
      timeoutMs: options.timeoutMs ?? 5_000,
      fetch: options.fetch ?? fakeFetch(routes),
    });
  }

  const smallRequest = { maxBytes: 32_768 };

  test("fetches a small text/markdown response", async () => {
    const provider = makeProvider({
      "https://example.com/guide.md": {
        status: 200,
        body: "# Guide",
        headers: { "content-type": "text/markdown" },
      },
    });
    const result = await provider.fetch(
      { url: "https://example.com/guide.md", ...smallRequest },
      new AbortController().signal,
    );
    expect(result).toEqual({
      sourceUrl: "https://example.com/guide.md",
      finalUrl: "https://example.com/guide.md",
      contentType: "text/markdown",
      text: "# Guide",
    });
  });

  test("a declared content-length over the limit is rejected as too_large", async () => {
    const provider = makeProvider({
      "https://example.com/big.md": {
        status: 200,
        body: "# small",
        headers: { "content-type": "text/plain", "content-length": "500000" },
      },
    });
    await expect(
      provider.fetch(
        { url: "https://example.com/big.md", maxBytes: 1024 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  test("a chunked body crossing the limit while reading is rejected without a partial body", async () => {
    const chunkedFetch = (async () => {
      const chunk = new Uint8Array(200);
      chunk.fill(65);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider({}, { fetch: chunkedFetch });
    await expect(
      provider.fetch(
        { url: "https://example.com/chunked.txt", maxBytes: 300 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  test.each([
    ["application/pdf", "https://example.com/doc.pdf"],
    ["application/zip", "https://example.com/archive.zip"],
    ["image/png", "https://example.com/logo.png"],
    ["application/octet-stream", "https://example.com/readme.md"],
  ])("blocks %s media", async (contentType, url) => {
    const provider = makeProvider({
      [url]: { status: 200, body: "x", headers: { "content-type": contentType } },
    });
    await expect(
      provider.fetch({ url, ...smallRequest }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "blocked_content_type" });
  });

  test("absent content-type is allowed only for a textual extension", async () => {
    const provider = makeProvider({
      "https://example.com/data.txt": { status: 200, body: "plain" },
      "https://example.com/noext": { status: 200, body: "?" },
    });
    const ok = await provider.fetch(
      { url: "https://example.com/data.txt", ...smallRequest },
      new AbortController().signal,
    );
    expect(ok.text).toBe("plain");
    await expect(
      provider.fetch(
        { url: "https://example.com/noext", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "blocked_content_type" });
  });

  test("follows up to three redirects and reports the final URL", async () => {
    const provider = makeProvider({
      "https://example.com/start": { status: 302, location: "https://example.com/mid" },
      "https://example.com/mid": { status: 301, location: "https://example.com/end.md" },
      "https://example.com/end.md": {
        status: 200,
        body: "done",
        headers: { "content-type": "text/plain" },
      },
    });
    const result = await provider.fetch(
      { url: "https://example.com/start", ...smallRequest },
      new AbortController().signal,
    );
    expect(result.finalUrl).toBe("https://example.com/end.md");
    expect(result.text).toBe("done");
  });

  test("never follows a redirect to a non-https URL", async () => {
    const provider = makeProvider({
      "https://example.com/start": {
        status: 302,
        location: "http://evil.example/x",
      },
    });
    await expect(
      provider.fetch(
        { url: "https://example.com/start", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "invalid_url" });
  });

  test("a fourth redirect is rejected", async () => {
    const provider = makeProvider({
      "https://example.com/1": { status: 302, location: "https://example.com/2" },
      "https://example.com/2": { status: 302, location: "https://example.com/3" },
      "https://example.com/3": { status: 302, location: "https://example.com/4" },
      "https://example.com/4": { status: 302, location: "https://example.com/5" },
      "https://example.com/5": { status: 200, body: "x" },
    });
    await expect(
      provider.fetch(
        { url: "https://example.com/1", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test.each([
    [404, "not_found"],
    [429, "rate_limit"],
    [500, "unavailable"],
  ])("maps HTTP %s to %s", async (status, kind) => {
    const provider = makeProvider({
      "https://example.com/x.md": { status: status as number },
    });
    await expect(
      provider.fetch(
        { url: "https://example.com/x.md", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind });
  });

  test("a network error becomes unavailable", async () => {
    const provider = makeProvider({}, {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(
      provider.fetch(
        { url: "https://example.com/x.md", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  const apiFileUrl = "https://api.github.com/repos/a/b/contents/skills/x.md?ref=main";
  const fileJson = JSON.stringify({
    type: "file",
    encoding: "base64",
    content: Buffer.from("# Frontend\nDesign guide.\n").toString("base64"),
  });

  test("decodes a GitHub blob via the Contents API and keeps the user URL as source", async () => {
    const provider = makeProvider({
      [apiFileUrl]: {
        status: 200,
        body: fileJson,
        headers: { "content-type": "application/json" },
      },
    });
    const result = await provider.fetch(
      { url: "https://github.com/a/b/blob/main/skills/x.md", ...smallRequest },
      new AbortController().signal,
    );
    expect(result.sourceUrl).toBe("https://github.com/a/b/blob/main/skills/x.md");
    expect(result.finalUrl).toBe(apiFileUrl);
    expect(result.text).toBe("# Frontend\nDesign guide.\n");
  });

  test("a GitHub blob whose decoded content exceeds the limit is too_large", async () => {
    const provider = makeProvider({
      [apiFileUrl]: {
        status: 200,
        body: JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from("y".repeat(4000)).toString("base64"),
        }),
        headers: { "content-type": "application/json" },
      },
    });
    await expect(
      provider.fetch(
        { url: "https://github.com/a/b/blob/main/skills/x.md", maxBytes: 1024 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  test("a GitHub blob for a non-textual file is blocked", async () => {
    const provider = makeProvider({
      "https://api.github.com/repos/a/b/contents/logo.png?ref=main": {
        status: 200,
        body: JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from("PNG").toString("base64"),
        }),
        headers: { "content-type": "application/json" },
      },
    });
    await expect(
      provider.fetch(
        { url: "https://github.com/a/b/blob/main/logo.png", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "blocked_content_type" });
  });

  test("an invalid GitHub JSON shape is invalid_response", async () => {
    const provider = makeProvider({
      [apiFileUrl]: {
        status: 200,
        body: JSON.stringify({ type: "file", encoding: "plain", content: "x" }),
        headers: { "content-type": "application/json" },
      },
    });
    await expect(
      provider.fetch(
        { url: "https://github.com/a/b/blob/main/skills/x.md", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("a GitHub tree URL returns a bounded directory listing with only safe fields", async () => {
    const apiDirUrl =
      "https://api.github.com/repos/a/b/contents/skills/frontend-design?ref=main";
    const listing = Array.from({ length: 5 }, (_, index) => ({
      name: `file${index}.md`,
      type: index % 2 === 0 ? "file" : "dir",
      path: `skills/frontend-design/file${index}.md`,
      download_url: `https://raw.githubusercontent.com/a/b/main/skills/frontend-design/file${index}.md`,
      html_url: `https://github.com/a/b/blob/main/skills/frontend-design/file${index}.md`,
      sha: "secret-sha",
      size: 10,
      extra: "drop-me",
    }));
    const provider = makeProvider({
      [apiDirUrl]: {
        status: 200,
        body: JSON.stringify(listing),
        headers: { "content-type": "application/json" },
      },
    });
    const result = await provider.fetch(
      { url: "https://github.com/a/b/tree/main/skills/frontend-design", ...smallRequest },
      new AbortController().signal,
    );
    expect(result.contentType).toBe("application/json");
    const parsed = JSON.parse(result.text) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(5);
    for (const item of parsed) {
      expect(Object.keys(item).sort()).toEqual(["name", "path", "type", "url"]);
      expect(item).not.toHaveProperty("sha");
      expect(item).not.toHaveProperty("extra");
    }
  });

  test("a GitHub directory body that is not an array is invalid_response", async () => {
    const provider = makeProvider({
      "https://api.github.com/repos/a/b/contents/skills/x?ref=main": {
        status: 200,
        body: JSON.stringify({ not: "an array" }),
        headers: { "content-type": "application/json" },
      },
    });
    await expect(
      provider.fetch(
        { url: "https://github.com/a/b/tree/main/skills/x", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  function hangingFetch(): typeof fetch {
    return (async (_input: string | URL, init?: { signal?: AbortSignal }) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
  }

  test("a parent cancellation takes precedence and maps to cancelled", async () => {
    const controller = new AbortController();
    const provider = makeProvider({}, { timeoutMs: 60_000, fetch: hangingFetch() });
    setTimeout(() => controller.abort(), 20);
    await expect(
      provider.fetch(
        { url: "https://example.com/slow.txt", ...smallRequest },
        controller.signal,
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

  test("an independent timeout maps to timeout", async () => {
    const provider = makeProvider({}, { timeoutMs: 30, fetch: hangingFetch() });
    await expect(
      provider.fetch(
        { url: "https://example.com/slow.txt", ...smallRequest },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
