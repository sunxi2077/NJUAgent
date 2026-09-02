/**
 * Request/result types for the generic remote text fetcher. The types file
 * keeps the provider and tool contracts independent of Tool interfaces.
 */

export type RemoteFetchRequest = {
  url: string;
  maxBytes: number;
};

export type RemoteFetchResult = {
  /** The user-supplied source URL that produced this result. */
  sourceUrl: string;
  /** The final URL actually fetched (after GitHub normalization/redirects). */
  finalUrl: string;
  /** Lowercased media type without parameters, when one was present. */
  contentType: string | undefined;
  text: string;
};

export type RemoteFetchErrorKind =
  | "invalid_url"
  | "blocked_content_type"
  | "too_large"
  | "not_found"
  | "rate_limit"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "invalid_response";

export interface RemoteFetchProvider {
  fetch(
    request: RemoteFetchRequest,
    signal: AbortSignal,
  ): Promise<RemoteFetchResult>;
}
