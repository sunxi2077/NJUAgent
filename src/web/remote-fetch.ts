import type {
  RemoteFetchErrorKind,
  RemoteFetchProvider,
  RemoteFetchRequest,
  RemoteFetchResult,
} from "./remote-fetch-types.js";

export type {
  RemoteFetchErrorKind,
  RemoteFetchProvider,
  RemoteFetchRequest,
  RemoteFetchResult,
} from "./remote-fetch-types.js";

/** Stable internal error for the remote fetcher; carries no raw response. */
export class RemoteFetchError extends Error {
  constructor(
    readonly kind: RemoteFetchErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RemoteFetchError";
  }
}

export type RemoteUrlMode = "direct" | "github-file" | "github-directory";

export type NormalizedRemoteUrl = {
  targetUrl: string;
  mode: RemoteUrlMode;
};

const MAX_URL_LENGTH = 2_048;

function invalidUrl(message: string): RemoteFetchError {
  return new RemoteFetchError("invalid_url", message);
}

function safeDecode(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** A decoded segment is safe for a Contents API path only when it stays a
 * single path component: no separators, no parent/self traversal. */
function isSafeSegment(decoded: string | undefined): boolean {
  if (decoded === undefined || decoded === "") {
    return false;
  }
  return decoded !== "." && decoded !== ".." && !/[\/\\]/u.test(decoded);
}

function encodeSegment(decoded: string): string {
  return encodeURIComponent(decoded);
}

/**
 * Recognizes `github.com/<owner>/<repo>/(blob|tree)/<ref>/<path...>` and
 * rewrites it to the public Contents API. Any malformed or unsafe GitHub path
 * falls back to a plain https fetch of the original URL rather than throwing,
 * so normalization never turns a bad path into a different host lookup.
 */
function githubContentsTarget(url: URL): NormalizedRemoteUrl | undefined {
  if (url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 4) {
    return undefined;
  }
  const [owner, repo, action, ref, ...pathSegments] = segments;
  if (action !== "blob" && action !== "tree") {
    return undefined;
  }
  const ownerDecoded = safeDecode(owner!);
  const repoDecoded = safeDecode(repo!);
  const refDecoded = safeDecode(ref!);
  if (!isSafeSegment(ownerDecoded) || !isSafeSegment(repoDecoded) || !isSafeSegment(refDecoded)) {
    return undefined;
  }
  const decodedPath: string[] = [];
  for (const segment of pathSegments) {
    const decoded = safeDecode(segment);
    if (!isSafeSegment(decoded)) {
      return undefined;
    }
    decodedPath.push(decoded!);
  }
  if (action === "blob" && decodedPath.length === 0) {
    return undefined;
  }
  const base =
    `https://api.github.com/repos/${encodeSegment(ownerDecoded!)}/` +
    `${encodeSegment(repoDecoded!)}/contents`;
  const pathSuffix =
    decodedPath.length === 0 ? "" : `/${decodedPath.map(encodeSegment).join("/")}`;
  const query = `?ref=${encodeSegment(refDecoded!)}`;
  return {
    mode: action === "blob" ? "github-file" : "github-directory",
    targetUrl: `${base}${pathSuffix}${query}`,
  };
}

/**
 * Validates and normalizes a user-supplied URL. Accepts only `https:`, never
 * credentials, never longer than 2048 characters, and drops the fragment.
 * Returns the fetch target plus a mode describing GitHub compatibility.
 */
export function normalizeRemoteUrl(raw: string): NormalizedRemoteUrl {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw invalidUrl("URL is empty");
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw invalidUrl("URL exceeds the 2048 character limit");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidUrl("URL is not valid");
  }
  if (url.protocol !== "https:") {
    throw invalidUrl("Only https: URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidUrl("URL must not contain credentials");
  }
  url.hash = "";
  const github = githubContentsTarget(url);
  if (github !== undefined) {
    return github;
  }
  return { mode: "direct", targetUrl: url.toString() };
}

export type RemoteFetchProviderOptions = {
  timeoutMs: number;
  fetch?: typeof fetch;
};

const MAX_REDIRECTS = 3;
const MAX_DIRECTORY_ITEMS = 100;

const TEXTUAL_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".toml",
  ".ini",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
]);

const ALLOWED_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/yaml",
  "application/x-yaml",
]);

function mediaTypeOf(response: Response): string | undefined {
  const raw = response.headers.get("content-type");
  if (raw === null) {
    return undefined;
  }
  const contentType = raw.split(";")[0]!.trim().toLowerCase();
  return contentType === "" ? undefined : contentType;
}

function hasTextualExtension(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  for (const extension of TEXTUAL_EXTENSIONS) {
    if (pathname.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

/** `text/*`, the allowed application types, or (absent type) a textual URL
 * extension. Anything else is a blocked binary download. */
function isAllowedMedia(contentType: string | undefined, finalUrl: string): boolean {
  if (contentType !== undefined) {
    return (
      contentType.startsWith("text/") ||
      ALLOWED_APPLICATION_TYPES.has(contentType)
    );
  }
  return hasTextualExtension(finalUrl);
}

function assertHttpOk(response: Response): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  if (response.status === 404) {
    throw new RemoteFetchError("not_found", "Remote resource was not found.");
  }
  if (response.status === 429) {
    throw new RemoteFetchError("rate_limit", "Remote host rate limit exceeded.");
  }
  throw new RemoteFetchError("unavailable", "Remote fetch failed.");
}

/**
 * Native `fetch`-based text reader. Bounds bytes while streaming (never
 * `response.text()` on an unbounded body), follows at most three redirects by
 * hand with re-validation of every destination, enforces textual media types,
 * and decodes GitHub Contents API responses for blob and tree URLs.
 */
export class NativeRemoteFetchProvider implements RemoteFetchProvider {
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: RemoteFetchProviderOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  async fetch(
    request: RemoteFetchRequest,
    signal: AbortSignal,
  ): Promise<RemoteFetchResult> {
    const normalized = normalizeRemoteUrl(request.url);
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#timeoutMs),
    ]);
    try {
      if (normalized.mode === "direct") {
        return await this.#fetchDirect(normalized.targetUrl, request, combined);
      }
      return await this.#fetchGithub(normalized, request, combined);
    } catch (error) {
      if (signal.aborted) {
        throw new RemoteFetchError("cancelled", "Remote fetch was cancelled.");
      }
      if (combined.aborted) {
        throw new RemoteFetchError("timeout", "Remote fetch timed out.");
      }
      if (error instanceof RemoteFetchError) {
        throw error;
      }
      throw new RemoteFetchError("unavailable", "Remote fetch failed.");
    }
  }

  async #fetchDirect(
    targetUrl: string,
    request: RemoteFetchRequest,
    signal: AbortSignal,
  ): Promise<RemoteFetchResult> {
    const { response, finalUrl } = await this.#fetchLoop(targetUrl, signal);
    assertHttpOk(response);
    const contentType = mediaTypeOf(response);
    if (!isAllowedMedia(contentType, finalUrl)) {
      throw new RemoteFetchError(
        "blocked_content_type",
        "Remote content type is not allowed.",
      );
    }
    const text = await this.#readBodyBounded(response, request.maxBytes);
    return {
      sourceUrl: request.url,
      finalUrl,
      contentType,
      text,
    };
  }

  async #fetchGithub(
    normalized: NormalizedRemoteUrl,
    request: RemoteFetchRequest,
    signal: AbortSignal,
  ): Promise<RemoteFetchResult> {
    if (
      normalized.mode === "github-file" &&
      !hasTextualExtension(request.url)
    ) {
      throw new RemoteFetchError(
        "blocked_content_type",
        "Remote content type is not allowed.",
      );
    }
    const { response, finalUrl } = await this.#fetchLoop(normalized.targetUrl, signal);
    assertHttpOk(response);
    const raw = await this.#readBodyBounded(response, request.maxBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new RemoteFetchError(
        "invalid_response",
        "Remote response is not valid JSON.",
      );
    }
    if (normalized.mode === "github-directory") {
      if (!Array.isArray(parsed)) {
        throw new RemoteFetchError(
          "invalid_response",
          "Remote directory listing is invalid.",
        );
      }
      const items: Array<Record<string, string>> = [];
      for (const entry of parsed.slice(0, MAX_DIRECTORY_ITEMS)) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const { name, type, path: itemPath } = record;
        const url = record.download_url ?? record.html_url;
        if (
          typeof name !== "string" ||
          typeof type !== "string" ||
          typeof itemPath !== "string" ||
          typeof url !== "string"
        ) {
          continue;
        }
        items.push({ name, type, path: itemPath, url });
      }
      return {
        sourceUrl: request.url,
        finalUrl,
        contentType: "application/json",
        text: JSON.stringify(items),
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new RemoteFetchError(
        "invalid_response",
        "Remote file response is invalid.",
      );
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.type !== "file" ||
      record.encoding !== "base64" ||
      typeof record.content !== "string"
    ) {
      throw new RemoteFetchError(
        "invalid_response",
        "Remote file response is invalid.",
      );
    }
    const bytes = Buffer.from(record.content, "base64");
    if (bytes.byteLength > request.maxBytes) {
      throw new RemoteFetchError(
        "too_large",
        "Remote content exceeds the byte limit.",
      );
    }
    return {
      sourceUrl: request.url,
      finalUrl,
      contentType: undefined,
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    };
  }

  /** GET with `redirect: "manual"`, following at most three redirects. */
  async #fetchLoop(
    startUrl: string,
    signal: AbortSignal,
  ): Promise<{ response: Response; finalUrl: string }> {
    let current = startUrl;
    for (let redirects = 0; ; redirects += 1) {
      const response = await this.#fetch(current, {
        redirect: "manual",
        signal,
      });
      if (!isRedirectStatus(response.status)) {
        return { response, finalUrl: current };
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new RemoteFetchError(
          "invalid_response",
          "Too many redirects.",
        );
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new RemoteFetchError(
          "invalid_response",
          "Redirect response has no location.",
        );
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new RemoteFetchError(
          "invalid_response",
          "Redirect location is invalid.",
        );
      }
      // Re-validate scheme, credentials, and length after every redirect.
      try {
        normalizeRemoteUrl(next);
      } catch {
        throw new RemoteFetchError(
          "invalid_url",
          "Redirect target is not a safe https URL.",
        );
      }
      current = next;
    }
  }

  /** Reads a body chunk by chunk with a hard byte cap; never a partial result. */
  async #readBodyBounded(
    response: Response,
    maxBytes: number,
  ): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const parsed = Number(declared);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        throw new RemoteFetchError(
          "too_large",
          "Remote content exceeds the byte limit.",
        );
      }
    }
    const body = response.body;
    if (body === null) {
      throw new RemoteFetchError(
        "invalid_response",
        "Remote response has no body.",
      );
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RemoteFetchError(
          "too_large",
          "Remote content exceeds the byte limit.",
        );
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(
      Buffer.concat(chunks),
    );
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
