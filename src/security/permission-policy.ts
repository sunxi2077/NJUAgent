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
