import type { Tool } from "../tools/tool.js";
import {
  RemoteFetchError,
  type RemoteFetchErrorKind,
  type RemoteFetchProvider,
  type RemoteFetchResult,
} from "./remote-fetch.js";

const ERROR_MESSAGES: Record<RemoteFetchErrorKind, string> = {
  invalid_url: "That URL is not a safe public https text URL.",
  blocked_content_type: "That URL does not point to allowed text content.",
  too_large: "That remote file is too large to fetch.",
  not_found: "That URL was not found.",
  rate_limit: "The remote host is rate limiting requests.",
  unavailable: "The remote service is unavailable.",
  timeout: "The remote fetch timed out.",
  cancelled: "The remote fetch was cancelled.",
  invalid_response: "The remote response was invalid.",
};

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export type RemoteFetchToolInput = { url: string };

/**
 * Permission-gated `fetch_url` tool: reads one known public HTTPS text URL and
 * returns it framed as untrusted reference data. Read-only: it never writes a
 * file, runs a shell command, or uses git. Provider errors map by kind to
 * short user-facing sentences that never include the raw error, headers, or
 * response body.
 */
export function createRemoteFetchTool(options: {
  provider: RemoteFetchProvider;
  maxBytes: number;
}): Tool<RemoteFetchToolInput> {
  return {
    name: "fetch_url",
    description:
      "Fetch one known public HTTPS text URL and return its content as untrusted " +
      "reference text. GitHub blob and tree/directory URLs are supported through " +
      "the public Contents API. This tool never saves files: to persist content, " +
      "inspect it first and then use write_file with a workspace-relative path.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(input, context): Promise<{ content: string; isError?: boolean }> {
      const url = input.url.trim();
      if (url === "") {
        return { content: "url must not be blank.", isError: true };
      }
      let result: RemoteFetchResult;
      try {
        result = await options.provider.fetch(
          { url, maxBytes: options.maxBytes },
          context.signal,
        );
      } catch (error) {
        if (error instanceof RemoteFetchError) {
          return { content: ERROR_MESSAGES[error.kind], isError: true };
        }
        throw error;
      }
      const source = escapeXmlAttribute(result.sourceUrl);
      const contentType =
        result.contentType === undefined
          ? ""
          : ` content_type="${escapeXmlAttribute(result.contentType)}"`;
      const body = result.text.replace(
        /<\/untrusted_remote_text>/gu,
        "&lt;/untrusted_remote_text&gt;",
      );
      return {
        content:
          `<untrusted_remote_text source="${source}"${contentType}>\n` +
          `${body}\n` +
          `</untrusted_remote_text>`,
      };
    },
  };
}
