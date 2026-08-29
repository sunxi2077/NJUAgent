import { ContextManager } from "../agent/context-manager.js";
import { ContextPolicy } from "../agent/context-policy.js";
import { ModelCompactor } from "../agent/compactor.js";
import { ConversationHistory } from "../agent/history.js";
import { AgentRunner } from "../agent/runner.js";
import { buildLayeredSystemPrompt } from "../skills/skill-prompt.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import type { Skill } from "../skills/skill.js";
import type { AgentEvent } from "../agent/events.js";
import type { ContextStatus } from "../agent/context-types.js";
import { formatPermissionQuestion, type Prompt } from "../cli/prompt.js";
import type { Renderer } from "../cli/renderer.js";
import type { AppConfig } from "../config.js";
import type { ModelProvider } from "../providers/provider.js";
import { AnthropicProvider } from "../providers/anthropic-provider.js";
import { PlanManager } from "../planning/plan-manager.js";
import { createPlanWriteTool } from "../planning/plan-tool.js";
import {
  BalancedPermissionPolicy,
  CautiousPermissionPolicy,
} from "../security/permission-policy.js";
import { Workspace } from "../security/workspace.js";
import type { ActiveRuntime } from "../sessions/session-manager.js";
import type { PersistedSessionV1 } from "../sessions/session-schema.js";
import { createRunCommandTool } from "../tools/command-tool.js";
import { ToolExecutor } from "../tools/executor.js";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "../tools/file-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  createListFilesTool,
  createSearchTextTool,
} from "../tools/search-tools.js";

export type CreateRuntimeDeps = {
  env: NodeJS.ProcessEnv;
  config: AppConfig;
  prompt: Pick<Prompt, "confirm">;
  renderer: Renderer;
  /** Test seam: inject a scripted provider instead of the real SDK client. */
  provider?: ModelProvider;
};

/**
 * Builds an `ActiveRuntime` for a session: canonical workspace, tools,
 * executor, provider, and runner. Workspaces are re-opened and the runner is
 * re-created on every resume so no closure retains a stale AgentRunner.
 */
export async function createRuntime(
  session: PersistedSessionV1,
  deps: CreateRuntimeDeps,
): Promise<ActiveRuntime> {
  const workspace = await Workspace.open(session.workspaceRoot);

  const registry = new ToolRegistry();
  registry.register(
    createReadFileTool({
      workspace,
      maxOutputBytes: deps.config.toolOutputMaxBytes,
    }),
  );
  registry.register(createWriteFileTool({ workspace }));
  registry.register(createEditFileTool({ workspace }));
  registry.register(
    createListFilesTool({
      workspace,
      maxOutputBytes: deps.config.toolOutputMaxBytes,
      maxResults: 200,
    }),
  );
  registry.register(
    createSearchTextTool({
      workspace,
      maxOutputBytes: deps.config.toolOutputMaxBytes,
      maxResults: 200,
      maxFileBytes: 1_000_000,
    }),
  );
  registry.register(
    createRunCommandTool({
      workspace,
      defaultTimeoutMs: deps.config.commandTimeoutMs,
      maxOutputBytes: deps.config.toolOutputMaxBytes,
      sourceEnvironment: deps.env,
    }),
  );

  const planManager = new PlanManager({
    state: session.plan,
    onChanged: (plan) =>
      deps.renderer.handle({ type: "plan_updated", plan }),
  });
  registry.register(createPlanWriteTool({ manager: planManager }));

  const permissionPolicy = session.permissionMode === "cautious"
    ? new CautiousPermissionPolicy()
    : new BalancedPermissionPolicy();
  const executor = new ToolExecutor({
    registry,
    permissionPolicy,
    confirm: (call, reason) =>
      deps.prompt.confirm(formatPermissionQuestion(call, reason)),
    onOutput: (call, stream, text) => deps.renderer.toolOutput(call, stream, text),
  });

  const provider = deps.provider ??
    new AnthropicProvider({
      model: session.modelId,
      maxTokens: deps.config.maxTokens,
      apiKey: deps.config.apiKey,
      baseURL: deps.config.baseURL,
    });

  const history = ConversationHistory.from(session.messages);
  let activeSkill: Skill | undefined;
  const systemPromptProvider = () =>
    buildLayeredSystemPrompt(
      activeSkill === undefined ? {} : { skill: activeSkill },
    );
  const contextManager = new ContextManager({
    policy: new ContextPolicy({
      contextWindowTokens: deps.config.contextWindowTokens,
      maxOutputTokens: deps.config.maxTokens,
      safetyTokens: deps.config.contextSafetyTokens,
      compactAtRatio: deps.config.contextCompactRatio,
      recentMessages: deps.config.contextRecentMessages,
      charsPerToken: 4,
    }),
    compactor: new ModelCompactor(provider),
    ...(session.context.checkpoint === undefined &&
    session.context.lastInputTokens === undefined &&
    session.context.compactionCount === 0
      ? {}
      : { initialState: session.context }),
    onEvent: (event) =>
      deps.renderer.handle(event as unknown as AgentEvent),
  });
  const runner = new AgentRunner({
    provider,
    history,
    tools: executor,
    maxSteps: deps.config.maxSteps,
    systemPrompt: buildSystemPrompt(),
    systemPromptProvider,
    contextManager,
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.25,
    },
    onEvent: (event) => deps.renderer.handle(event),
  });

  return {
    session,
    history,
    planManager,
    run: (text, signal) => runner.run(text, signal),
    contextState: () => contextManager.state(),
    contextStatus: (): ContextStatus =>
      contextManager.status({
        baseSystemPrompt: systemPromptProvider(),
        messages: history.snapshot(),
        tools: executor.definitions(),
      }),
    compact: (focus, signal) =>
      contextManager.compactNow({
        baseSystemPrompt: systemPromptProvider(),
        messages: history.snapshot(),
        tools: executor.definitions(),
        signal,
        ...(focus === undefined ? {} : { focus }),
      }),
    setActiveSkill: (skill) => {
      activeSkill = skill;
    },
  };
}
