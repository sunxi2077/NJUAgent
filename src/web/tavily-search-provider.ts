import type { WebSearchProvider, WebSearchQuery, WebSearchResult } from "./web-search.js";
import { WebSearchError } from "./web-search.js";

export type FetchPort = typeof fetch;

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

type TavilyRawResult = Record<string, unknown>;

/**
 * First and only `WebSearchProvider` implementation. Uses Node 20 native
 * `fetch` (no SDK), composes caller cancellation with a timeout via
 * `AbortSignal.any`, never retries, and normalizes every response into the
 * internal result type. Errors carry a stable kind and never include the key
 * or a raw response body.
 */
export class TavilySearchProvider implements WebSearchProvider {
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchPort;

  constructor(options: {
    apiKey: string;
    timeoutMs: number;
    fetch?: FetchPort;
  }) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  async search(
    query: WebSearchQuery,
    signal: AbortSignal,
  ): Promise<readonly WebSearchResult[]> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);
    let response: Response;
    try {
      response = await this.#fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.query,
          max_results: query.maxResults,
          search_depth: "basic",
          include_raw_content: "markdown",
          include_domains: query.includeDomains ?? [],
          exclude_domains: query.excludeDomains ?? [],
        }),
        signal: combined,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new WebSearchError("cancelled", "Web search was cancelled.");
      }
      if (combined.aborted) {
        throw new WebSearchError("timeout", "Web search timed out.");
      }
      throw new WebSearchError("unavailable", "Web search service is unavailable.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new WebSearchError("auth", "Web search authentication failed.");
    }
    if (response.status === 429) {
      throw new WebSearchError("rate_limit", "Web search rate limit exceeded.");
    }
    if (response.status >= 500 || !response.ok) {
      throw new WebSearchError("unavailable", "Web search service is unavailable.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WebSearchError("invalid_response", "Web search returned an invalid response.");
    }
    const results = (payload as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new WebSearchError("invalid_response", "Web search returned an invalid response.");
    }
    return results.map((raw) => normalizeResult(raw as TavilyRawResult));
  }
}

function normalizeResult(raw: TavilyRawResult): WebSearchResult {
  const title = typeof raw.title === "string" ? raw.title : "";
  const url = typeof raw.url === "string" ? raw.url : "";
  const snippet = typeof raw.snippet === "string" ? raw.snippet : "";
  const content = typeof raw.content === "string" && raw.content !== ""
    ? raw.content
    : undefined;
  const publishedAt = typeof raw.publishedAt === "string" && raw.publishedAt !== ""
    ? raw.publishedAt
    : undefined;
  return {
    title,
    url,
    snippet,
    ...(content === undefined ? {} : { content }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}
