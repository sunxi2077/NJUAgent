import type { ToolExecutionRequest } from "../tools/tool.js";
import { guardWorkspaceCommand } from "./command-guard.js";

export type PermissionDecision =
  | { action: "allow" }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string };

export interface PermissionPolicy {
  decide(
    request: ToolExecutionRequest,
  ): PermissionDecision | Promise<PermissionDecision>;
}

export class AllowAllPermissionPolicy implements PermissionPolicy {
  decide(): PermissionDecision {
    return { action: "allow" };
  }
}

const readOnlyTools = new Set(["read_file", "list_files", "search_text"]);
const writeTools = new Set(["write_file", "edit_file"]);
// Session-metadata tools change no workspace state and never need approval.
const metadataTools = new Set(["plan_write"]);
// External-network tools always need approval because the query leaves the machine.
const externalTools = new Set(["web_search"]);
const WEB_SEARCH_REASON = "Web search sends the query to an external service";

function commandText(request: ToolExecutionRequest): string | undefined {
  if (request.name !== "run_command" || typeof request.input !== "object" || request.input === null) {
    return undefined;
  }
  const command = Reflect.get(request.input, "command");
  return typeof command === "string" ? command.trim() : undefined;
}

const shellSyntaxRequiringConfirmation = /[\n\r;&|`$<>(){}\[\]*?~]/u;
const explicitAbsolutePath = /(?:^|\s|=)\/(?!dev\/null(?:\s|$))/u;

function classifyCommand(command: string): PermissionDecision {
  const normalized = command.toLowerCase();
  const denied = [
    /(?:^|\s)(?:sudo|doas)(?:\s|$)/u,
    /(?:^|\s)(?:shutdown|reboot|halt)(?:\s|$)/u,
    /(?:^|\s)(?:mkfs(?:\.\w+)?|fdisk|diskutil\s+erase)(?:\s|$)/u,
    /(?:^|\s)dd\s+[^\n]*\bof=\/dev\//u,
    /(?:^|\s)rm\s+-[^\n]*r[^\n]*f[^\n]*\s+\/(?:\s|$)/u,
    /(?:^|\s)(?:\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/var\/|\/private\/|\/users\/|\/home\/|\.\.\/)/u,
  ];
  if (denied.some((pattern) => pattern.test(normalized))) {
    return { action: "deny", reason: "Command targets privileged or outside-workspace resources" };
  }

  // Conservative shell-syntax and absolute-path check runs before the
  // allowlist: pipelines, redirection, home expansion and absolute targets
  // always require a visible confirmation, even when the leading command
  // would otherwise look safe.
  if (
    shellSyntaxRequiringConfirmation.test(command) ||
    explicitAbsolutePath.test(command)
  ) {
    return {
      action: "ask",
      reason: "Shell syntax or an absolute path requires confirmation",
    };
  }

  const confirmationRequired = [
    /^(?:rm|rmdir|unlink)\b/u,
    /^(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update|upgrade)\b/u,
    /^(?:curl|wget|ssh|scp|rsync)\b/u,
    /^git\s+(?:reset|clean|push|pull|checkout\s+--|restore\s+--source|branch\s+-D|branch\s+--delete)\b/u,
  ];
  if (confirmationRequired.some((pattern) => pattern.test(normalized))) {
    return { action: "ask", reason: "Command may modify dependencies, remote state, or many files" };
  }

  const allowed = [
    /^(?:pwd|ls|rg|grep|cat|head|tail|wc)(?:\s|$)/u,
    /^git\s+(?:status|diff|log|show|rev-parse)(?:\s|$)/u,
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check))(?:\s|$)/u,
    /^(?:tsc|vitest|pytest)(?:\s|$)/u,
    /^cargo\s+(?:test|check|build)(?:\s|$)/u,
    /^go\s+test(?:\s|$)/u,
  ];
  if (allowed.some((pattern) => pattern.test(normalized))) {
    return { action: "allow" };
  }

  return { action: "ask", reason: "Unrecognized command requires confirmation" };
}

export class BalancedPermissionPolicy implements PermissionPolicy {
  decide(request: ToolExecutionRequest): PermissionDecision {
    if (readOnlyTools.has(request.name) || writeTools.has(request.name) || metadataTools.has(request.name)) {
      return { action: "allow" };
    }
    if (externalTools.has(request.name)) {
      return { action: "ask", reason: WEB_SEARCH_REASON };
    }
    const command = commandText(request);
    if (command !== undefined) {
      // The workspace guard runs before every other check: an obvious escape
      // is a hard deny in every mode and can never be approved interactively.
      const guarded = guardWorkspaceCommand(command);
      if (guarded.action === "deny") {
        return guarded;
      }
      return classifyCommand(command);
    }
    return { action: "ask", reason: `Unrecognized tool requires confirmation: ${request.name}` };
  }
}

export class CautiousPermissionPolicy implements PermissionPolicy {
  decide(request: ToolExecutionRequest): PermissionDecision {
    if (readOnlyTools.has(request.name) || metadataTools.has(request.name)) {
      return { action: "allow" };
    }
    if (externalTools.has(request.name)) {
      return { action: "ask", reason: WEB_SEARCH_REASON };
    }
    const command = commandText(request);
    if (command !== undefined) {
      const guarded = guardWorkspaceCommand(command);
      if (guarded.action === "deny") {
        return guarded;
      }
      const balanced = classifyCommand(command);
      if (balanced.action === "deny") {
        return balanced;
      }
    }
    if (writeTools.has(request.name) || request.name === "run_command") {
      return { action: "ask", reason: `${request.name} requires confirmation in cautious mode` };
    }
    return { action: "ask", reason: `Unrecognized tool requires confirmation: ${request.name}` };
  }
}
