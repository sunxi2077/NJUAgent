export const HELP_TEXT = `NJUAgent - a local command-line coding agent

Usage:
  npm start -- --workspace <path> [--permission-mode balanced|cautious|trusted] [--debug]
  njuagent [path] [--permission-mode balanced|cautious|trusted] [--debug]

Options:
  path, --workspace <path>     Workspace root; defaults to the current directory
  --permission-mode <mode>     balanced (default), cautious, or trusted
  --debug                      Print sanitized startup diagnostics
  -h, --help                   Show this help without requiring API credentials

Permission modes:
  cautious asks before writes and commands; balanced auto-allows safe
  workspace commands; trusted auto-allows any workspace-local command that
  passes the hard guard — fewer prompts for a workspace you trust.
  Outside-workspace and high-risk commands remain blocked in every mode;
  there is no "unrestricted" mode.

Environment:
  ANTHROPIC_API_KEY            API key; environment only, never stored on disk
  ANTHROPIC_BASE_URL           e.g. https://api.deepseek.com/anthropic
  MODEL_ID                     model name supported by the endpoint
  NJU_AGENT_HOME               application home (default ~/.nju-agent)
  NO_COLOR                     disable colors and cursor control when set
  TAVILY_API_KEY               optional; enables the permission-gated web_search tool
  WEB_SEARCH_TIMEOUT_MS        web search timeout in ms (default 15000)
  WEB_SEARCH_MAX_CONTENT_CHARS per-result content cap (default 6000)
  REMOTE_FETCH_TIMEOUT_MS      fetch_url timeout in ms (default 15000)
  REMOTE_FETCH_MAX_BYTES       fetch_url byte cap per resource (default 32768, 1024-65536)
  MODEL_INPUT_COST_PER_MTOKENS optional USD price per million input tokens
  MODEL_OUTPUT_COST_PER_MTOKENS optional USD price per million output tokens

Interactive commands:
  /help                        Show available commands
  /status                      Show current session status
  /sessions                    List saved sessions
  /resume <id>                 Resume a saved session
  /new                         Start a new session
  /history [1-100]             Show recent messages
  /tool <id>                   Show retained output for a tool call
  /plan [clear]                Show or clear the model-maintained plan
  /goal [clear|<condition>]    Set, show, or clear the explicit completion goal
  /exit                        Save the current session and exit

Any input starting with / is handled locally; use // to send literal text.
`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}
