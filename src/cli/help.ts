export const HELP_TEXT = `NJUAgent - a local command-line coding agent

Usage:
  npm start -- --workspace <path> [--permission-mode balanced|cautious] [--debug]
  nju-agent --workspace <path> [--permission-mode balanced|cautious] [--debug]

Options:
  --workspace <path>           Workspace root; defaults to the current directory
  --permission-mode <mode>     balanced (default) or cautious
  --debug                      Print sanitized startup diagnostics
  -h, --help                   Show this help without requiring API credentials

Required environment:
  ANTHROPIC_API_KEY
  ANTHROPIC_BASE_URL
  MODEL_ID

Interactive commands:
  /exit                        Exit the session
`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}
