import { isVerificationCommand } from "./verification-command.js";
import type { EvidenceState, CommandEvidence } from "./goal.js";
import type { ToolExecutionRequest, ToolExecutionResult } from "../tools/tool.js";

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const MAX_COMMAND_EVIDENCE = 20;

/**
 * Observes final tool results and maintains session-owned EvidenceState.
 * Only the host classifies verification; malformed metadata is recorded with
 * conservative values so it can never look like successful evidence.
 */
export class EvidenceLedger {
  readonly #state: EvidenceState;
  readonly #clock: () => Date;

  constructor(options: { state: EvidenceState; clock?: () => Date }) {
    this.#state = options.state;
    this.#clock = options.clock ?? (() => new Date());
  }

  observe(call: ToolExecutionRequest, result: ToolExecutionResult): void {
    if (call.name === "run_command") {
      this.#observeCommand(call, result);
      return;
    }
    if (!result.isError && WRITE_TOOLS.has(call.name)) {
      const path = metadataString(result, "path");
      if (path !== undefined) {
        this.#state.workspaceRevision += 1;
        if (!this.#state.changedPaths.includes(path)) {
          this.#state.changedPaths.push(path);
        }
      }
    }
  }

  snapshot(): EvidenceState {
    return structuredClone(this.#state);
  }

  /**
   * A command is fresh, successful verification when it exited 0, did not
   * time out or get cancelled, was classified as verification by the host,
   * and ran at the current workspace revision.
   */
  hasFreshSuccessfulVerification(): boolean {
    return this.#state.commands.some((command) =>
      command.exitCode === 0 &&
      !command.timedOut &&
      !command.cancelled &&
      command.isVerification &&
      command.workspaceRevision === this.#state.workspaceRevision);
  }

  #observeCommand(call: ToolExecutionRequest, result: ToolExecutionResult): void {
    const command = typeof call.input === "object" && call.input !== null
      && typeof Reflect.get(call.input, "command") === "string"
      ? (Reflect.get(call.input, "command") as string)
      : "";
    const metadata = isRecord(result.metadata) ? result.metadata : {};
    const cancelled = metadata.cancelled === true;
    const entry: CommandEvidence = {
      command,
      exitCode: typeof metadata.exitCode === "number" ? metadata.exitCode : null,
      timedOut: metadata.timedOut === true,
      cancelled,
      isVerification: isVerificationCommand(command),
      workspaceRevision:
        typeof metadata.workspaceRevision === "number"
          ? metadata.workspaceRevision
          : this.#state.workspaceRevision,
      observedAt: this.#clock().toISOString(),
    };
    this.#state.commands.push(entry);
    if (this.#state.commands.length > MAX_COMMAND_EVIDENCE) {
      this.#state.commands = this.#state.commands.slice(-MAX_COMMAND_EVIDENCE);
    }
  }
}

function metadataString(
  result: ToolExecutionResult,
  key: string,
): string | undefined {
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const value = metadata[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
