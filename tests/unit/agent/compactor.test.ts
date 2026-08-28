import { describe, expect, test } from "vitest";

import { ModelCompactor } from "../../../src/agent/compactor.js";
import type { Message } from "../../../src/agent/messages.js";
import { AppError } from "../../../src/errors/app-error.js";
import type { ModelProvider, ModelRequest, ProviderEvent } from "../../../src/providers/provider.js";

const textUser = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const textAssistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

class RecordingProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly script: (request: ModelRequest) => AsyncIterable<ProviderEvent> | Iterable<ProviderEvent>,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    for await (const event of this.script(request)) {
      yield event;
    }
  }
}

function textEvents(...chunks: string[]): Array<ProviderEvent> {
  return [
    ...chunks.map((text) => ({ type: "text_delta" as const, text })),
    {
      type: "message_completed" as const,
      message: { role: "assistant", content: [{ type: "text", text: chunks.join("") }] },
      stopReason: "end_turn",
    },
  ];
}

function completedWithToolCall(): Array<ProviderEvent> {
  return [
    {
      type: "message_completed" as const,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "partial" },
          { type: "tool_call", id: "c1", name: "read_file", input: {} },
        ],
      },
      stopReason: "tool_use",
    },
  ];
}

describe("ModelCompactor", () => {
  test("sends one ordinary user message with the transcript and no tools", async () => {
    const huge = "z".repeat(5_000);
    const messages: Message[] = [
      textUser("fix the parser"),
      textAssistant("I will inspect it"),
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "read_file", input: { path: "src/a.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "c1", content: huge, isError: false }],
      },
    ];
    const snapshot = structuredClone(messages);
    const provider = new RecordingProvider(() => textEvents("summary here"));
    const compactor = new ModelCompactor(provider);

    const summary = await compactor.compact({
      messages,
      previousSummary: "earlier summary",
      focus: "make tests pass",
      signal: new AbortController().signal,
    });

    expect(summary).toBe("summary here");
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.tools).toEqual([]);
    expect(request.messages).toHaveLength(1);
    const userMessage = request.messages[0]!;
    expect(userMessage.role).toBe("user");
    const transcript = (userMessage.content[0] as { text: string }).text;
    expect(transcript).toContain("earlier summary");
    expect(transcript).toContain("make tests pass");
    expect(transcript).toContain("user: fix the parser");
    expect(transcript).toContain("assistant: I will inspect it");
    expect(transcript).toContain("read_file");
    expect(transcript).toContain("src/a.ts");
    // The bounded tool result never exceeds 2000 code points.
    expect([...transcript].length).toBeLessThan(transcript.length + 5_000);
    expect(messages).toEqual(snapshot);
  });

  test("rejects a blank summary", async () => {
    const provider = new RecordingProvider(() =>
      textEvents("   ", "\n"),
    );
    const compactor = new ModelCompactor(provider);
    await expect(
      compactor.compact({ messages: [textUser("hi")], signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "COMPACTION_FAILED" });
  });

  test("rejects a completed assistant message that contains a tool call", async () => {
    const provider = new RecordingProvider(() => completedWithToolCall());
    const compactor = new ModelCompactor(provider);
    await expect(
      compactor.compact({ messages: [textUser("hi")], signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "COMPACTION_FAILED" });
  });

  test("rejects a stream that ends without completion", async () => {
    const provider = new RecordingProvider(async function* () {
      yield { type: "text_delta", text: "partial" };
    });
    const compactor = new ModelCompactor(provider);
    await expect(
      compactor.compact({ messages: [textUser("hi")], signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "COMPACTION_FAILED" });
  });

  test("wraps a provider exception with a safe message and cause", async () => {
    const provider = new RecordingProvider(async function* () {
      throw new Error("socket reset");
    });
    const compactor = new ModelCompactor(provider);
    let error: unknown;
    try {
      await compactor.compact({ messages: [textUser("hi")], signal: new AbortController().signal });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "COMPACTION_FAILED" });
    expect((error as AppError).cause).toBeInstanceOf(Error);
  });

  test("an aborted signal becomes USER_CANCELLED", async () => {
    const controller = new AbortController();
    const provider = new RecordingProvider(async function* () {
      controller.abort();
      throw new Error("aborted downstream");
    });
    const compactor = new ModelCompactor(provider);
    await expect(
      compactor.compact({ messages: [textUser("hi")], signal: controller.signal }),
    ).rejects.toMatchObject({ code: "USER_CANCELLED" });
  });

  test("rejects a summary above 12000 code points", async () => {
    const provider = new RecordingProvider(() =>
      textEvents("x".repeat(12_001)),
    );
    const compactor = new ModelCompactor(provider);
    await expect(
      compactor.compact({ messages: [textUser("hi")], signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "COMPACTION_FAILED" });
  });
});
