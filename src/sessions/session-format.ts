import type { TerminalTheme } from "../cli/theme.js";
import { formatCommandPanel, formatProgressBar, type CommandPanel } from "../cli/command-layout.js";
import type { ContextStatus } from "../agent/context-types.js";
import type { Message } from "../agent/messages.js";
import type { SessionListEntry } from "./session-store.js";
import type { PersistedSessionV1, SessionUsage } from "./session-schema.js";

const TITLE_LIMIT = 48;
const WORKSPACE_LIMIT = 60;
const MESSAGE_PREVIEW_LIMIT = 240;
const TOOL_RESULT_LIMIT = 160;
const BAR_CELLS = 15;

export type TokenPricing = { inputPerMillion: number; outputPerMillion: number };

/** Truncates by code points without splitting surrogate pairs. */
function truncateText(text: string, maxCodePoints: number): string {
  const chars = [...text];
  if (chars.length <= maxCodePoints) {
    return text;
  }
  return `${chars.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}

/** Compact thousands rendering: 1400 -> 1.4k, 41952 -> 42.0k. */
function compactNumber(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function percentOf(value: number, maximum: number): number {
  if (!Number.isFinite(maximum) || maximum <= 0) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, value / maximum));
  return Math.round(ratio * 100);
}

export function formatUsageSummary(
  usage: SessionUsage,
  pricing?: TokenPricing,
): string {
  return `${usage.requests} requests · ` +
    `${compactNumber(usage.inputTokens)} input · ` +
    `${compactNumber(usage.outputTokens)} output tokens`;
}

function estimateDollars(usage: SessionUsage, pricing: TokenPricing): string {
  const dollars =
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

export function formatSessionList(options: {
  sessions: readonly SessionListEntry[];
  currentId: string;
  theme: TerminalTheme;
  columns?: number;
  totalCount?: number;
  truncated?: boolean;
}): string {
  const { sessions, currentId, theme } = options;
  const total = options.totalCount ?? sessions.length;

  if (options.columns !== undefined && theme.enabled) {
    const panel: CommandPanel = {
      symbol: "◇",
      title: `Sessions · ${total} total`,
      sections: [
        {
          rows: sessions.map((entry) => {
            const marker = entry.id === currentId ? "●" : " ";
            const title = truncateText(entry.title, TITLE_LIMIT);
            const workspace = truncateText(entry.workspaceRoot, WORKSPACE_LIMIT);
            return {
              value: `${marker} ${entry.id.slice(0, 8)}  ${title}  ${workspace}  ${entry.updatedAt}`,
            };
          }),
        },
      ],
    };
    if (options.truncated === true) {
      panel.footer = `… showing ${sessions.length} of ${total} · /sessions all for the full list`;
    }
    return formatCommandPanel(panel, { columns: options.columns, theme });
  }

  const rows = sessions.map((entry) => {
    const marker = entry.id === currentId ? theme.brandStrong("● ") : "  ";
    const title = truncateText(entry.title, TITLE_LIMIT);
    const workspace = truncateText(entry.workspaceRoot, WORKSPACE_LIMIT);
    return `${marker}${entry.id.slice(0, 8)}  ${title}  ${workspace}  ${entry.updatedAt}`;
  });
  const lines = [`Sessions (${total}):`, ...rows];
  if (options.truncated === true) {
    lines.push(`… showing ${sessions.length} of ${total} · /sessions all for the full list`);
  }
  return lines.join("\n");
}

export function formatSessionStatus(
  session: PersistedSessionV1,
  options: {
    dirty: boolean;
    theme: TerminalTheme;
    webSearchAvailable?: boolean;
    context?: ContextStatus;
    columns?: number;
    pricing?: TokenPricing;
    cwd?: string;
  },
): string {
  const { dirty, theme } = options;
  const planProgress = session.plan.items.length === 0
    ? "none"
    : `${session.plan.items.filter((item) => item.status === "completed").length}/${session.plan.items.length}`;
  const goalLine = session.goal === null
    ? "none"
    : session.goal.status === "verified"
      ? "verified"
      : "active";
  const webSearch = options.webSearchAvailable === true
    ? "available"
    : "unavailable (set TAVILY_API_KEY)";
  const usage = session.stats.usage;

  if (options.columns !== undefined && theme.enabled) {
    const workspace = options.cwd !== undefined && options.cwd === session.workspaceRoot
      ? "."
      : session.workspaceRoot;
    type PanelSection = CommandPanel["sections"][number];
    const sections: PanelSection[] = [
      {
        rows: [
          { label: "Model", value: session.modelId },
          { label: "Workspace", value: workspace },
          { label: "Permission", value: session.permissionMode },
          { label: "Session", value: `${session.id.slice(0, 8)} · ${dirty ? "dirty" : "clean"}` },
          { label: "Skill", value: `${session.activeSkill ?? "none"} · Web search ${webSearch}` },
          { label: "Goal", value: goalLine },
          { label: "Plan", value: planProgress },
        ],
      },
    ];
    if (options.context !== undefined) {
      const context = options.context;
      const bar = formatProgressBar(context.estimatedTokens, context.hardInputTokens, {
        cells: BAR_CELLS,
        theme,
      });
      sections.push({
        heading: "Context",
        rows: [
          {
            value: `${bar} ${compactNumber(context.estimatedTokens)} / ` +
              `${compactNumber(context.hardInputTokens)} · ` +
              `${percentOf(context.estimatedTokens, context.hardInputTokens)}%`,
          },
          {
            value: `Compact at ${compactNumber(context.thresholdTokens)} · ` +
              `${context.coveredMessageCount}/${context.totalMessageCount} messages covered`,
          },
        ],
      });
    }
    sections.push({
      heading: "Usage (this session)",
      rows: [
        { value: formatUsageSummary(usage) },
        {
          label: "Estimate",
          value: options.pricing === undefined
            ? "not configured"
            : estimateDollars(usage, options.pricing),
        },
      ],
    });
    const panel: CommandPanel = {
      symbol: "◆",
      title: "Session status",
      sections,
    };
    return formatCommandPanel(panel, { columns: options.columns, theme });
  }

  return [
    `Model: ${session.modelId}`,
    `Workspace: ${truncateText(session.workspaceRoot, WORKSPACE_LIMIT)}`,
    `Permission: ${session.permissionMode}`,
    `Skill: ${session.activeSkill ?? "none"}`,
    `Plan: ${planProgress}`,
    `Goal: ${goalLine}`,
    `Web search: ${webSearch}`,
    `Requests: ${usage.requests} · input ${usage.inputTokens} · output ${usage.outputTokens} tokens`,
    `Estimate: ${options.pricing === undefined ? "not configured" : "configured"}`,
    `Messages: ${session.messages.length}`,
    `Dirty: ${dirty ? "yes" : "no"}`,
    theme.muted(`/help for commands`),
  ].join("\n");
}

function previewMessage(message: Message, theme: TerminalTheme): string {
  if (message.role === "assistant") {
    const parts = message.content.map((block) => {
      if (block.type === "text") {
        return truncateText(block.text, MESSAGE_PREVIEW_LIMIT);
      }
      return theme.brandStrong(`→ tool: ${block.name} (${block.id})`);
    });
    return `assistant: ${parts.join(" | ") || "(no text)"}`;
  }
  const parts = message.content.map((block) => {
    if (block.type === "text") {
      return truncateText(block.text, MESSAGE_PREVIEW_LIMIT);
    }
    const status = block.isError ? theme.error("failed") : theme.success("ok");
    return `tool ${truncateText(block.toolCallId, 12)}: ${status} ${truncateText(block.content, TOOL_RESULT_LIMIT)}`;
  });
  return `user: ${parts.join(" | ")}`;
}

export function formatHistory(
  session: PersistedSessionV1,
  options: { theme: TerminalTheme; count?: number },
): string {
  const { theme } = options;
  const count = options.count ?? 20;
  const tail = session.messages.slice(-count);
  if (tail.length === 0) {
    return theme.muted("(no messages yet)");
  }
  return tail.map((message) => previewMessage(message, theme)).join("\n");
}

export function formatContextStatus(
  status: ContextStatus,
  theme: TerminalTheme,
  columns?: number,
): string {
  const number = (value: number) => value.toLocaleString("en-US");
  if (columns !== undefined && theme.enabled) {
    const bar = formatProgressBar(status.estimatedTokens, status.hardInputTokens, {
      cells: BAR_CELLS,
      theme,
    });
    const panel: CommandPanel = {
      symbol: "◇",
      title: "Context budget",
      sections: [
        {
          rows: [
            {
              value: `${bar} ${compactNumber(status.estimatedTokens)} / ` +
                `${compactNumber(status.hardInputTokens)} · ` +
                `${percentOf(status.estimatedTokens, status.hardInputTokens)}%`,
            },
            {
              value: `Compact at ${compactNumber(status.thresholdTokens)} · ` +
                `window ${compactNumber(status.contextWindowTokens)}`,
            },
            {
              value: `Summary ${status.coveredMessageCount}/${status.totalMessageCount} messages · ` +
                `${status.compactionCount} compactions`,
            },
            ...(status.lastInputTokens === undefined
              ? []
              : [{ value: `Last provider input ${compactNumber(status.lastInputTokens)} tokens` }]),
          ],
        },
      ],
    };
    return formatCommandPanel(panel, { columns, theme });
  }
  const lines = [
    theme.brandStrong("Context (estimated)"),
    `  input       ${number(status.estimatedTokens)} tokens`,
    `  compact at  ${number(status.thresholdTokens)}`,
    `  hard limit  ${number(status.hardInputTokens)}`,
    `  window      ${number(status.contextWindowTokens)}`,
    `  summary     ${status.coveredMessageCount}/${status.totalMessageCount} messages · ${status.compactionCount} compactions`,
  ];
  if (status.lastInputTokens !== undefined) {
    lines.push(`  last input  ${number(status.lastInputTokens)} tokens`);
  }
  return lines.join("\n");
}

export function formatSkillList(
  skills: readonly {
    name: string;
    description: string;
    source: string;
  }[],
  options: { activeName: string | null; theme: TerminalTheme; columns?: number },
): string {
  const { activeName, theme } = options;
  if (options.columns !== undefined && theme.enabled) {
    const panel: CommandPanel = {
      symbol: "◇",
      title: `Skills · ${skills.length} total`,
      sections: [
        {
          rows: skills.map((skill) => ({
            label: activeName === skill.name ? `● ${skill.name}` : `  ${skill.name}`,
            value: `${skill.source} · ${truncateText(skill.description, 120)}`,
          })),
        },
      ],
    };
    return formatCommandPanel(panel, { columns: options.columns, theme });
  }
  const rows = skills.map((skill) => {
    const marker = skill.name === activeName ? theme.brandStrong("● ") : "  ";
    return `${marker}${skill.name}  [${skill.source}]  ${truncateText(skill.description, 120)}`;
  });
  return `Skills (${skills.length}):\n${rows.join("\n")}`;
}

