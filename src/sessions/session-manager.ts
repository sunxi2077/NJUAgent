import type { RunResult } from "../agent/result.js";
import { ConversationHistory } from "../agent/history.js";
import type { SessionStore } from "./session-store.js";
import {
  createEmptySession,
  deriveSessionTitle,
  type PersistedSessionV1,
} from "./session-schema.js";

export type ActiveRuntime = {
  session: PersistedSessionV1;
  history: ConversationHistory;
  run(text: string, signal: AbortSignal): Promise<RunResult>;
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
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  #activeRuntime: ActiveRuntime;
  #dirty = false;

  constructor(options: SessionManagerOptions) {
    this.#store = options.store;
    this.#runtimeFactory = options.runtimeFactory;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? crypto.randomUUID;
    this.#activeRuntime = options.initialRuntime;
  }

  active(): PersistedSessionV1 {
    return structuredClone(this.#activeRuntime.session);
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
    try {
      await this.#checkpoint(result);
    } catch {
      // The run itself completed; a failed checkpoint only marks dirty.
    }
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

  async resume(prefix: string): Promise<PersistedSessionV1> {
    const id = await this.#store.resolveId(prefix);
    const session = await this.#store.load(id);
    await this.flush();
    const runtime = await this.#runtimeFactory(session);
    await this.#replace(runtime);
    return session;
  }

  async #checkpoint(result: RunResult): Promise<void> {
    const session = this.#activeRuntime.session;
    session.messages = this.#activeRuntime.history.snapshot();
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
