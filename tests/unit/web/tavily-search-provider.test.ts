import { describe, expect, test } from "vitest";

import { TavilySearchProvider, type FetchPort } from "../../../src/web/tavily-search-provider.js";
import { WebSearchError } from "../../../src/web/web-search.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchPort {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {})) as unknown as FetchPort;
}

function provider(fetch: FetchPort) {
  return new TavilySearchProvider({
    apiKey: "tvly-super-secret",
    timeoutMs: 15_000,
    fetch,
  });
}

const validBody = {
  query: "TypeScript fetch timeout",
  max_results: 5,
  search_depth: "basic",
  include_raw_content: "markdown",
  include_domains: [],
  exclude_domains: [],
};

describe("TavilySearchProvider", () => {
  test("sends a Bearer POST to the search endpoint with a snake_case body and no key inside", async () => {
    let captured: RequestInit | undefined;
    const fetch = makeFetch(async (url, init) => {
      captured = init;
      return jsonResponse({ results: [] });
    });
    const providerInstance = provider(fetch);
    await providerInstance.search(
      { query: "TypeScript fetch timeout", maxResults: 5 },
      new AbortController().signal,
    );

    const body = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(body).toEqual(validBody);
    expect(body).not.toHaveProperty("api_key");
    expect(captured?.method).toBe("POST");
    expect((captured?.headers as Record<string, string>)?.["Authorization"]).toBe(
      "Bearer tvly-super-secret",
    );
    expect((captured?.headers as Record<string, string>)?.["Content-Type"]).toBe(
      "application/json",
    );
  });

  test("normalizes a successful response and tolerates unknown fields", async () => {
    const fetch = makeFetch(() =>
      jsonResponse({
        results: [
          {
            title: "AbortSignal - Node.js",
            url: "https://nodejs.org/api/abort.html",
            content: "plain text",
            raw_content: "ignored raw",
            score: 0.9,
            extra: "ignored",
          },
        ],
      }),
    );
    const results = await provider(fetch).search(
      { query: "q", maxResults: 3 },
      new AbortController().signal,
    );
    expect(results).toEqual([
      {
        title: "AbortSignal - Node.js",
        url: "https://nodejs.org/api/abort.html",
        snippet: "",
        content: "plain text",
      },
    ]);
  });

  test("zero results returns an empty array", async () => {
    const fetch = makeFetch(() => jsonResponse({ results: [] }));
    const results = await provider(fetch).search(
      { query: "nothing", maxResults: 5 },
      new AbortController().signal,
    );
    expect(results).toEqual([]);
  });

  test.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const fetch = makeFetch(() => new Response("oops", { status }));
    await expect(
      provider(fetch).search({ query: "q", maxResults: 5 }, new AbortController().signal),
    ).rejects.toMatchObject({ kind });
  });

  test("network failure maps to unavailable", async () => {
    const fetch = makeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      provider(fetch).search({ query: "q", maxResults: 5 }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  test("invalid JSON maps to invalid_response", async () => {
    const fetch = makeFetch(() => new Response("not json", { status: 200 }));
    await expect(
      provider(fetch).search({ query: "q", maxResults: 5 }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("missing or non-array results maps to invalid_response", async () => {
    const fetch = makeFetch(() => jsonResponse({}));
    await expect(
      provider(fetch).search({ query: "q", maxResults: 5 }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("caller cancellation maps to cancelled and never leaks the key", async () => {
    const controller = new AbortController();
    const fetch = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = provider(fetch).search({ query: "q", maxResults: 5 }, controller.signal);
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error).toMatchObject({ kind: "cancelled" });
    expect(String(error)).not.toContain("tvly-super-secret");
  });

  test("timeout maps to timeout when the upstream never answers", async () => {
    const fetch = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const providerInstance = new TavilySearchProvider({
      apiKey: "tvly-super-secret",
      timeoutMs: 20,
      fetch,
    });
    const error = await providerInstance
      .search({ query: "q", maxResults: 5 }, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error).toMatchObject({ kind: "timeout" });
  });

  test("errors never contain the key or raw response bodies", async () => {
    const fetch = makeFetch(() => new Response("secret-bits-and-key", { status: 401 }));
    const error = await provider(fetch)
      .search({ query: "q", maxResults: 5 }, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("tvly-super-secret");
    expect(String(error)).not.toContain("secret-bits-and-key");
  });
});
