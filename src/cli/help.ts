export const HELP_TEXT = `NJUAgent - a local command-line coding agent

Usage:
  npm start -- --workspace <path> [--permission-mode balanced|cautious] [--debug]
  nju-agent --workspace <path> [--permission-mode balanced|cautious] [--debug]

Options:
  --workspace <path>           Workspace root; defaults to the current directory
  --permission-mode <mode>     balanced (default) or cautious
  --debug                      Print sanitized startup diagnostics
  -h, --help                   Show this help without requiring API credentials

Environment:
  ANTHROPIC_API_KEY            API key; environment only, never stored on disk
  ANTHROPIC_BASE_URL           e.g. https://api.deepseek.com/anthropic
  MODEL_ID                     model name supported by the endpoint
  NJU_AGENT_HOME               application home (default ~/.nju-agent)
  NO_COLOR                     disable colors and cursor control when set

Interactive commands:
  /exit                        Exit the session
`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}
