import type { ToolExecutionRequest } from "../tools/tool.js";

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

function commandText(request: ToolExecutionRequest): string | undefined {
  if (request.name !== "run_command" || typeof request.input !== "object" || request.input === null) {
    return undefined;
  }
  const command = Reflect.get(request.input, "command");
  return typeof command === "string" ? command.trim() : undefined;
}

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

  if (/[;&]|\|\||`|\$\(/u.test(command)) {
    return { action: "ask", reason: "Compound shell command requires confirmation" };
  }

  const confirmationRequired = [
    /^(?:rm|rmdir|unlink)\b/u,
    /^(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update|upgrade)\b/u,
    /^(?:curl|wget|ssh|scp|rsync)\b/u,
    /^git\s+(?:reset|clean|push|pull|checkout\s+--|restore\s+--source)\b/u,
  ];
  if (confirmationRequired.some((pattern) => pattern.test(normalized))) {
    return { action: "ask", reason: "Command may modify dependencies, remote state, or many files" };
  }

  const allowed = [
    /^(?:pwd|ls|rg|grep|find|cat|sed|head|tail|wc)\b/u,
    /^git\s+(?:status|diff|log|show|branch|rev-parse)\b/u,
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check))\b/u,
    /^(?:node|tsc|vitest|pytest|cargo\s+(?:test|check|build)|go\s+test)\b/u,
  ];
  if (allowed.some((pattern) => pattern.test(normalized))) {
    return { action: "allow" };
  }

  return { action: "ask", reason: "Unrecognized command requires confirmation" };
}

export class BalancedPermissionPolicy implements PermissionPolicy {
  decide(request: ToolExecutionRequest): PermissionDecision {
    if (readOnlyTools.has(request.name) || writeTools.has(request.name)) {
      return { action: "allow" };
    }
    const command = commandText(request);
    if (command !== undefined) {
      return classifyCommand(command);
    }
    return { action: "ask", reason: `Unrecognized tool requires confirmation: ${request.name}` };
  }
}

export class CautiousPermissionPolicy implements PermissionPolicy {
  decide(request: ToolExecutionRequest): PermissionDecision {
    if (readOnlyTools.has(request.name)) {
      return { action: "allow" };
    }
    const command = commandText(request);
    if (command !== undefined) {
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
