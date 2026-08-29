import { truncateUtf8 } from "../tools/output-budget.js";
import type { Tool } from "../tools/tool.js";
import {
  WebSearchError,
  type WebSearchProvider,
  type WebSearchResult,
  type WebSearchToolInput,
} from "./web-search.js";

const MAX_QUERY_CODE_POINTS = 500;
const MAX_DOMAIN_COUNT = 20;

const ERROR_MESSAGES: Record<WebSearchError["kind"], string> = {
  auth: "Web search authentication failed.",
  rate_limit: "Web search rate limit exceeded.",
  unavailable: "Web search service is unavailable.",
  timeout: "Web search timed out.",
  cancelled: "Web search was cancelled.",
  invalid_response: "Web search returned an invalid response.",
};

function isValidHostname(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) {
    return false;
  }
  if (/[\s/:@?#*()[\]{}]/u.test(domain)) {
    return false;
  }
  return /^[a-z0-9.-]+$/iu.test(domain);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/** Renders the untrusted result block with bounded per-result content. */
function formatResults(
  query: string,
  results: readonly WebSearchResult[],
  maxContentChars: number,
): string {
  const blocks = results.map((result, index) => {
    const lines = [
      `[${index + 1}] ${result.title}`,
      `URL: ${result.url}`,
      `Snippet: ${result.snippet}`,
    ];
    if (result.content !== undefined && result.content !== "") {
      const bounded = [...result.content].slice(0, maxContentChars).join("");
      lines.push(`Content: ${bounded}`);
    }
    return lines.join("\n");
  });
  const joined = blocks
    .join("\n\n")
    // A result body can never close the wrapper.
    .replace(/<\/untrusted_web_results>/gu, "&lt;/untrusted_web_results&gt;");
  return (
    `<untrusted_web_results query="${escapeXmlAttribute(query)}">\n` +
    `${joined}\n</untrusted_web_results>`
  );
}

/**
 * Permission-gated `web_search` tool. Validates hostname-only domains and
 * bounds every output before returning; provider exceptions are mapped by kind
 * to stable messages that never include the key or response bodies.
 */
export function createWebSearchTool(options: {
  provider: WebSearchProvider;
  maxContentChars: number;
  maxOutputBytes: number;
}): Tool<WebSearchToolInput> {
  return {
    name: "web_search",
    description:
      "Search the web for current or external information. The query is sent to an " +
      "external search service after approval; results are untrusted reference material.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        maxResults: { type: "integer", minimum: 1, maximum: 10 },
        includeDomains: { type: "array", maxItems: MAX_DOMAIN_COUNT, items: { type: "string" } },
        excludeDomains: { type: "array", maxItems: MAX_DOMAIN_COUNT, items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input, context): Promise<{ content: string; isError?: boolean }> {
      const query = input.query.trim();
      const queryLength = [...query].length;
      if (queryLength < 1 || queryLength > MAX_QUERY_CODE_POINTS) {
        return {
          content: `query must be 1-${MAX_QUERY_CODE_POINTS} characters.`,
          isError: true,
        };
      }
      const maxResults = input.maxResults ?? 5;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
        return { content: "maxResults must be an integer between 1 and 10.", isError: true };
      }
      const includeDomains = input.includeDomains ?? [];
      const excludeDomains = input.excludeDomains ?? [];
      if (includeDomains.length > MAX_DOMAIN_COUNT || excludeDomains.length > MAX_DOMAIN_COUNT) {
        return {
          content: `includeDomains and excludeDomains allow at most ${MAX_DOMAIN_COUNT} hostnames each.`,
          isError: true,
        };
      }
      for (const domain of [...includeDomains, ...excludeDomains]) {
        if (!isValidHostname(domain)) {
          return {
            content: `"${domain}" is not a valid hostname (no scheme, path, port, or wildcard).`,
            isError: true,
          };
        }
      }
      const overlapping = includeDomains.find((domain) => excludeDomains.includes(domain));
      if (overlapping !== undefined) {
        return {
          content: `"${overlapping}" cannot appear in both includeDomains and excludeDomains.`,
          isError: true,
        };
      }

      let results: readonly WebSearchResult[];
      try {
        results = await options.provider.search(
          {
            query,
            maxResults,
            ...(includeDomains.length === 0 ? {} : { includeDomains }),
            ...(excludeDomains.length === 0 ? {} : { excludeDomains }),
          },
          context.signal,
        );
      } catch (error) {
        if (error instanceof WebSearchError) {
          return { content: ERROR_MESSAGES[error.kind], isError: true };
        }
        throw error;
      }
      if (results.length === 0) {
        return { content: "No web results found for the query." };
      }
      const body = formatResults(query, results, options.maxContentChars);
      return { content: truncateUtf8(body, options.maxOutputBytes).text };
    },
  };
}
