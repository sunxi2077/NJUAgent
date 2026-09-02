import type { RunResult } from "../agent/result.js";
import type { ContextState, ContextStatus, PreparedContext } from "../agent/context-types.js";
import { ConversationHistory } from "../agent/history.js";
import type { Message } from "../agent/messages.js";
import type { Skill } from "../skills/skill.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { AppError } from "../errors/app-error.js";
import type { PermissionMode } from "../config.js";
import type { PlanManager } from "../planning/plan-manager.js";
import type { PlanState } from "../planning/plan.js";
import type { GoalState } from "../goals/goal.js";
import type { SessionStore } from "./session-store.js";
import {
  createEmptySession,
  deriveSessionTitle,
  type PersistedSessionV1,
} from "./session-schema.js";

export type ActiveRuntime = {
  session: PersistedSessionV1;
  history: ConversationHistory;
  planManager: PlanManager;
  run(text: string, signal: AbortSignal): Promise<RunResult>;
  contextState(): ContextState;
  contextStatus(): ContextStatus;
  compact(focus: string | undefined, signal: AbortSignal): Promise<PreparedContext>;
  setActiveSkill(skill: Skill | undefined): void;
  dispose?(): Promise<void> | void;
};

export type RuntimeFactory = (session: PersistedSessionV1) => Promise<ActiveRuntime>;

export type SessionStorePort = Pick<
  SessionStore,
  "save" | "load" | "list" | "resolveId"
>;

export type SessionManagerOptions = {
  initialRuntime: ActiveRuntime;
  store: SessionStorePort;
  runtimeFactory: RuntimeFactory;
  registry: SkillRegistry;
  clock?: () => Date;
  idFactory?: () => string;
};

/**
 * Owns the active in-memory runtime and the save-before-switch discipline.
 * Checkpoints are committed after a run; a failed save keeps the runtime
 * active and marks it dirty instead of losing state.
 */
export class SessionManager {
  readonly #store: SessionStorePort;
  readonly #runtimeFactory: RuntimeFactory;
  readonly #registry: SkillRegistry;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  #activeRuntime: ActiveRuntime;
  #dirty = false;

  constructor(options: SessionManagerOptions) {
    this.#store = options.store;
    this.#runtimeFactory = options.runtimeFactory;
    this.#registry = options.registry;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#activeRuntime = options.initialRuntime;
    this.#restoreActiveSkill();
  }

  active(): PersistedSessionV1 {
    return structuredClone(this.#activeRuntime.session);
  }

  /**
   * Read-only snapshot of the active session transcript for local commands.
   * Returns a defensive clone so callers can never mutate session internals.
   */
  messages(): readonly Message[] {
    return structuredClone(this.#activeRuntime.session.messages);
  }

  isDirty(): boolean {
    return this.#dirty;
  }

  async runTurn(text: string, signal: AbortSignal): Promise<RunResult> {
    const session = this.#activeRuntime.session;
    if (session.messages.length === 0 && text.trim() !== "") {
      session.title = deriveSessionTitle(text);
    }
    const result = await this.#activeRuntime.run(text, signal);
    await this.#checkpoint(result);
    return result;
  }

  async flush(): Promise<void> {
    if (!this.#dirty) {
      return;
    }
    await this.#store.save(this.#activeRuntime.session);
    this.#dirty = false;
  }

  async createNew(): Promise<PersistedSessionV1> {
    await this.flush();
    const session = createEmptySession({
      id: this.#idFactory(),
      now: this.#now(),
      workspaceRoot: this.#activeRuntime.session.workspaceRoot,
      modelId: this.#activeRuntime.session.modelId,
      permissionMode: this.#activeRuntime.session.permissionMode,
    });
    const runtime = await this.#runtimeFactory(session);
    await this.#store.save(session);
    await this.#replace(runtime);
    return session;
  }

  contextStatus(): ContextStatus {
    return this.#activeRuntime.contextStatus();
  }

  plan(): PlanState {
    return this.#activeRuntime.planManager.snapshot();
  }

  async clearPlan(): Promise<PlanState> {
    const plan = this.#activeRuntime.planManager.clear();
    this.#dirty = true;
    await this.flush();
    return plan;
  }

  goal(): GoalState | null {
    const goal = this.#activeRuntime.session.goal;
    return goal === null ? null : structuredClone(goal);
  }

  async setGoal(condition: string): Promise<GoalState> {
    const trimmed = condition.trim();
    const length = [...trimmed].length;
    if (length < 1 || length > 1000) {
      throw new AppError({
        code: "GOAL_INVALID",
        userMessage: "Goal condition must be 1-1000 characters.",
      });
    }
    const now = this.#now();
    const goal: GoalState = {
      condition: trimmed,
      status: "active",
      createdAt: now,
      updatedAt: now,
      automaticContinuations: 0,
    };
    this.#activeRuntime.session.goal = goal;
    this.#dirty = true;
    await this.flush();
    return structuredClone(goal);
  }

  async clearGoal(): Promise<void> {
    const session = this.#activeRuntime.session;
    if (session.goal !== null) {
      // Briefly cancelled (recorded decision) then removed entirely; the
      // externally visible and persisted result is null, matching "clear".
      session.goal = { ...session.goal, status: "cancelled", updatedAt: this.#now() };
    }
    session.goal = null;
    this.#dirty = true;
    await this.flush();
  }

  activeSkill(): Skill | undefined {
    const name = this.#activeRuntime.session.activeSkill;
    if (name === null) {
      return undefined;
    }
    return this.#registry.resolve(name);
  }

  async activateSkill(name: string): Promise<Skill> {
    const skill = this.#registry.resolve(name);
    if (skill === undefined) {
      throw new AppError({
        code: "SKILL_INVALID",
        userMessage: `Unknown skill "${name}". Type /skills to list available skills.`,
      });
    }
    this.#activeRuntime.setActiveSkill(skill);
    this.#activeRuntime.session.activeSkill = skill.name;
    this.#dirty = true;
    await this.flush();
    return skill;
  }

  async deactivateSkill(): Promise<void> {
    this.#activeRuntime.setActiveSkill(undefined);
    this.#activeRuntime.session.activeSkill = null;
    this.#dirty = true;
    await this.flush();
  }

  #restoreActiveSkill(): void {
    const name = this.#activeRuntime.session.activeSkill;
    if (name === null) {
      return;
    }
    const skill = this.#registry.resolve(name);
    if (skill === undefined) {
      // Missing or invalid persisted skill: disable it and repair.
      this.#activeRuntime.session.activeSkill = null;
      this.#activeRuntime.setActiveSkill(undefined);
      this.#dirty = true;
    } else {
      this.#activeRuntime.setActiveSkill(skill);
    }
  }

  /** Runs manual compaction and persists the updated context on success. */
  async compact(focus: string | undefined, signal: AbortSignal): Promise<PreparedContext> {
    const prepared = await this.#activeRuntime.compact(focus, signal);
    const session = this.#activeRuntime.session;
    session.context = this.#activeRuntime.contextState();
    session.updatedAt = this.#now();
    this.#dirty = true;
    await this.flush();
    return prepared;
  }

  async resume(prefix: string): Promise<PersistedSessionV1> {
    const id = await this.#store.resolveId(prefix);
    const session = await this.#store.load(id);
    await this.flush();
    const runtime = await this.#runtimeFactory(session);
    await this.#replace(runtime);
    this.#restoreActiveSkill();
    return session;
  }

  async reconfigure(options: {
    modelId: string;
    permissionMode: PermissionMode;
  }): Promise<PersistedSessionV1> {
    await this.flush();
    const session = this.active();
    session.modelId = options.modelId;
    session.permissionMode = options.permissionMode;
    session.updatedAt = this.#now();
    const runtime = await this.#runtimeFactory(session);
    try {
      await this.#store.save(session);
    } catch (error) {
      await runtime.dispose?.();
      throw error;
    }
    await this.#replace(runtime);
    this.#restoreActiveSkill();
    return this.active();
  }

  async #checkpoint(result: RunResult): Promise<void> {
    const session = this.#activeRuntime.session;
    session.messages = this.#activeRuntime.history.snapshot();
    session.context = this.#activeRuntime.contextState();
    session.updatedAt = this.#now();
    session.stats.turns += 1;
    session.stats.toolCalls += result.toolCalls;
    session.stats.lastRunStatus = result.status;
    this.#dirty = true;
    await this.flush();
  }

  async #replace(runtime: ActiveRuntime): Promise<void> {
    await this.#activeRuntime.dispose?.();
    this.#activeRuntime = runtime;
    this.#dirty = false;
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}
