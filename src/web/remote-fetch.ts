import type { RemoteFetchErrorKind } from "./remote-fetch-types.js";

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
