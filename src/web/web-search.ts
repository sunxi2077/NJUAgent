export type WebSearchQuery = {
  query: string;
  maxResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type WebSearchToolInput = {
  query: string;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  publishedAt?: string;
};

export interface WebSearchProvider {
  search(
    query: WebSearchQuery,
    signal: AbortSignal,
  ): Promise<readonly WebSearchResult[]>;
}

export type WebSearchErrorKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "invalid_response";

/** Stable internal error that never carries a response body or API key. */
export class WebSearchError extends Error {
  constructor(readonly kind: WebSearchErrorKind, message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}
