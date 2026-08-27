import { Ajv, type AnySchema, type ValidateFunction } from "ajv";

import type { ModelToolDefinition } from "../providers/provider.js";
import type { Tool } from "./tool.js";

export type RegisteredTool = {
  tool: Tool;
  validate: ValidateFunction;
};

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #ajv = new Ajv({ allErrors: true });

  register<TInput>(tool: Tool<TInput>): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }

    const validate = this.#ajv.compile(tool.inputSchema as AnySchema);
    this.#tools.set(tool.name, {
      tool: tool as Tool,
      validate,
    });
  }

  resolve(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  definitions(): ModelToolDefinition[] {
    return [...this.#tools.values()].map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
    }));
  }

  validationErrors(validate: ValidateFunction): string {
    return this.#ajv.errorsText(validate.errors, { separator: "; " });
  }
}
