import { describe, expect, test } from "bun:test";

import type Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  MessageCountTokensParams,
  MessageCreateParamsNonStreaming,
  StopReason,
} from "@anthropic-ai/sdk/resources/messages";

import {
  AnthropicProvider,
  type AnthropicMessagesClient,
  DEFAULT_ANTHROPIC_MODEL,
  loadAnthropicClientConfig,
} from "../../src/agent/anthropic";
import type {
  ProviderMessage,
  ProviderStopReason,
} from "../../src/agent/provider";
import type { ToolDefinition } from "../../src/tools/definition";

const initialMessages: readonly ProviderMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Investigate checkout-api latency" }],
  },
];

const tools: readonly ToolDefinition[] = [
  {
    name: "get_pod_logs",
    description: "Read a bounded tail of pod logs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { pod: { type: "string" } },
      required: ["pod"],
    },
  },
];

function anthropicMessage(
  content: ContentBlock[],
  stopReason: StopReason | null = "end_turn",
): Message {
  return {
    id: "msg_01",
    container: null,
    content,
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 11,
      cache_read_input_tokens: 7,
      inference_geo: null,
      input_tokens: 101,
      output_tokens: 29,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

class FakeAnthropicMessagesClient implements AnthropicMessagesClient {
  readonly createRequests: MessageCreateParamsNonStreaming[] = [];
  readonly countRequests: MessageCountTokensParams[] = [];
  readonly createOptions: Array<Anthropic.RequestOptions | undefined> = [];
  readonly countOptions: Array<Anthropic.RequestOptions | undefined> = [];

  constructor(private readonly responses: Message[]) {}

  async create(
    params: MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Message> {
    this.createRequests.push(params);
    this.createOptions.push(options);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("fake Anthropic response queue is empty");
    }
    return response;
  }

  async countTokens(
    params: MessageCountTokensParams,
    options?: Anthropic.RequestOptions,
  ): Promise<{ input_tokens: number }> {
    this.countRequests.push(params);
    this.countOptions.push(options);
    return { input_tokens: 777 };
  }
}

function requestSchema(
  request: MessageCreateParamsNonStreaming | undefined,
): Readonly<Record<string, unknown>> {
  const format = request?.output_config?.format;
  if (format === undefined || format === null) {
    throw new Error("Anthropic request must include a structured output schema");
  }
  return format.schema;
}

describe("AnthropicProvider", () => {
  test("sends a strict read-only SRE request with the configured model and report schema", async () => {
    const client = new FakeAnthropicMessagesClient([
      anthropicMessage([
        { type: "text", text: "{}", citations: null },
      ]),
    ]);
    const provider = new AnthropicProvider({
      client,
      environment: {
        ANTHROPIC_MODEL: "claude-custom-model",
        AGENT_MAX_OUTPUT_TOKENS: "2048",
      },
    });

    await provider.complete(initialMessages, tools);

    const request = client.createRequests[0];
    expect(request).toBeDefined();
    expect(request).toMatchObject({
      model: "claude-custom-model",
      max_tokens: 2_048,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Investigate checkout-api latency" },
          ],
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      tools: [
        {
          name: "get_pod_logs",
          description: "Read a bounded tail of pod logs.",
          strict: true,
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: { pod: { type: "string" } },
            required: ["pod"],
          },
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "status",
              "probableCause",
              "evidence",
              "suggestions",
              "recentChanges",
              "uncertainties",
            ],
            anyOf: expect.any(Array),
          },
        },
      },
    });

    expect(request?.system).toContain("hypothesis");
    expect(request?.system).toContain("code-issued evidence call ID");
    expect(request?.system).toContain("uncertainty");
    expect(request?.system).toContain("never execute");
    expect(request?.system).toContain("suggestions only");
  });

  test("constrains each report status to the shape accepted by the runtime validator", async () => {
    const client = new FakeAnthropicMessagesClient([
      anthropicMessage([{ type: "text", text: "{}", citations: null }]),
    ]);
    const provider = new AnthropicProvider({ client, environment: {} });

    await provider.complete(initialMessages, []);

    expect(requestSchema(client.createRequests[0])).toMatchObject({
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", const: "diagnosed" },
            probableCause: {
              type: "object",
              additionalProperties: false,
              properties: {
                claim: { type: "string", minLength: 1, maxLength: 4_096 },
                evidenceCallIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  items: { type: "string", minLength: 1, maxLength: 4_096 },
                },
              },
            },
            evidence: { type: "array", minItems: 1, maxItems: 20 },
            suggestions: { type: "array", maxItems: 20 },
            recentChanges: { type: "array", maxItems: 20 },
            uncertainties: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 4_096 },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", const: "insufficient_data" },
            probableCause: { type: "null" },
            evidence: { type: "array", maxItems: 20 },
            suggestions: { type: "array", maxItems: 20 },
            recentChanges: { type: "array", maxItems: 20 },
            uncertainties: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 4_096 },
            },
          },
        },
      ],
    });
  });

  test("defaults to the current Claude model", async () => {
    const client = new FakeAnthropicMessagesClient([
      anthropicMessage([{ type: "text", text: "{}", citations: null }]),
    ]);
    const provider = new AnthropicProvider({ client, environment: {} });

    await provider.complete(initialMessages, []);

    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(client.createRequests[0]).toMatchObject({
      model: "claude-sonnet-5",
    });
    expect(client.createRequests[0]?.tools).toBeUndefined();
    expect(client.createRequests[0]?.tool_choice).toBeUndefined();
  });

  test("requires an API key before constructing the real SDK client", () => {
    expect(() => new AnthropicProvider({ environment: {} })).toThrow(
      "ANTHROPIC_API_KEY is required",
    );
  });

  test("loads bounded Anthropic request timeout and retry settings", () => {
    expect(loadAnthropicClientConfig({})).toEqual({
      timeoutMs: 15_000,
      maxRetries: 0,
    });
    expect(
      loadAnthropicClientConfig({
        ANTHROPIC_TIMEOUT_MS: "30000",
        ANTHROPIC_MAX_RETRIES: "2",
      }),
    ).toEqual({ timeoutMs: 30_000, maxRetries: 2 });
  });

  test("rejects unbounded or malformed Anthropic transport settings", () => {
    const invalidSettings: ReadonlyArray<
      readonly [Readonly<Record<string, string | undefined>>, string]
    > = [
      [{ ANTHROPIC_TIMEOUT_MS: "999" }, "ANTHROPIC_TIMEOUT_MS"],
      [{ ANTHROPIC_TIMEOUT_MS: "120001" }, "ANTHROPIC_TIMEOUT_MS"],
      [{ ANTHROPIC_TIMEOUT_MS: "fifteen seconds" }, "ANTHROPIC_TIMEOUT_MS"],
      [{ ANTHROPIC_MAX_RETRIES: "3" }, "ANTHROPIC_MAX_RETRIES"],
      [{ ANTHROPIC_MAX_RETRIES: "-1" }, "ANTHROPIC_MAX_RETRIES"],
    ];

    for (const [environment, expectedName] of invalidSettings) {
      expect(() => loadAnthropicClientConfig(environment)).toThrow(expectedName);
    }
  });

  test("exposes text and tool calls while preserving every raw assistant block for round-trip", async () => {
    const rawContent: ContentBlock[] = [
      {
        type: "thinking",
        thinking: "private analysis that must never enter the generic trace",
        signature: "signed-thinking",
      },
      { type: "redacted_thinking", data: "opaque-redacted-data" },
      { type: "text", text: "Checking the failing pod.", citations: null },
      {
        type: "tool_use",
        id: "toolu_01",
        name: "get_pod_logs",
        input: { pod: "checkout-api-abc" },
        caller: { type: "direct" },
      },
    ];
    const client = new FakeAnthropicMessagesClient([
      anthropicMessage(rawContent, "tool_use"),
      anthropicMessage([{ type: "text", text: "{}", citations: null }]),
    ]);
    const provider = new AnthropicProvider({ client, environment: {} });

    const firstTurn = await provider.complete(initialMessages, tools);

    expect(firstTurn).toEqual({
      role: "assistant",
      id: "msg_01",
      model: "claude-sonnet-5",
      stopReason: "tool_use",
      usage: {
        inputTokens: 101,
        cacheCreationInputTokens: 11,
        cacheReadInputTokens: 7,
        outputTokens: 29,
      },
      content: [
        { type: "text", text: "Checking the failing pod." },
        {
          type: "tool_call",
          id: "toolu_01",
          name: "get_pod_logs",
          input: { pod: "checkout-api-abc" },
        },
      ],
      providerState: { provider: "anthropic", value: rawContent },
    });

    await provider.complete(
      [
        ...initialMessages,
        firstTurn,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "toolu_01",
              content: '{"evidenceCallId":"call_001","result":"OOMKilled"}',
              isError: false,
            },
          ],
        },
      ],
      tools,
    );

    expect(client.createRequests[1]?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Investigate checkout-api latency" },
        ],
      },
      { role: "assistant", content: rawContent },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: '{"evidenceCallId":"call_001","result":"OOMKilled"}',
            is_error: false,
          },
        ],
      },
    ]);
  });

  test("isolates normalized tool input from the opaque Anthropic round-trip state", async () => {
    const rawContent: ContentBlock[] = [
      {
        type: "tool_use",
        id: "toolu_clone",
        name: "get_pod_logs",
        input: {
          pod: "checkout-api-abc",
          options: { lines: 200 },
        },
        caller: { type: "direct" },
      },
    ];
    const client = new FakeAnthropicMessagesClient([
      anthropicMessage(rawContent, "tool_use"),
      anthropicMessage([{ type: "text", text: "{}", citations: null }]),
    ]);
    const provider = new AnthropicProvider({ client, environment: {} });

    const turn = await provider.complete(initialMessages, tools);
    const toolCall = turn.content.find((block) => block.type === "tool_call");
    if (toolCall?.type !== "tool_call") {
      throw new Error("Anthropic response must expose the tool call");
    }
    const input = toolCall.input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("fixture tool input must be an object");
    }
    const mutableInput = input as Record<string, unknown>;
    mutableInput.pod = "mutated-by-registry";
    const options = mutableInput.options;
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new Error("fixture nested options must be an object");
    }
    (options as Record<string, unknown>).lines = 9_999;

    await provider.complete(
      [
        ...initialMessages,
        turn,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "toolu_clone",
              content: '{"evidenceCallId":"call_001"}',
              isError: false,
            },
          ],
        },
      ],
      tools,
    );

    expect(client.createRequests[1]?.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_clone",
          name: "get_pod_logs",
          input: {
            pod: "checkout-api-abc",
            options: { lines: 200 },
          },
          caller: { type: "direct" },
        },
      ],
    });
  });

  test("counts the exact system, message, schema, and tool context sent for completion", async () => {
    const client = new FakeAnthropicMessagesClient([]);
    const provider = new AnthropicProvider({
      client,
      environment: { ANTHROPIC_MODEL: "claude-counting-model" },
    });

    const count = await provider.countInputTokens(initialMessages, tools);

    expect(count).toBe(777);
    expect(client.countRequests[0]).toMatchObject({
      model: "claude-counting-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Investigate checkout-api latency" },
          ],
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      tools: [{ name: "get_pod_logs", strict: true }],
      output_config: { format: { type: "json_schema" } },
    });
    expect(client.countRequests[0]?.system).toContain("hypothesis");
  });

  test("forwards the overall run abort signal to completion and token counting", async () => {
    const client = new FakeAnthropicMessagesClient([
      anthropicMessage([{ type: "text", text: "{}", citations: null }]),
    ]);
    const provider = new AnthropicProvider({ client, environment: {} });
    const controller = new AbortController();

    await provider.countInputTokens(initialMessages, tools, {
      signal: controller.signal,
    });
    await provider.complete(initialMessages, tools, {
      signal: controller.signal,
    });

    expect(client.countOptions[0]).toEqual({ signal: controller.signal });
    expect(client.createOptions[0]).toEqual({ signal: controller.signal });
  });

  test("maps every Anthropic stop reason and nullable cache usage", async () => {
    const stopReasons: ReadonlyArray<
      readonly [StopReason | null, ProviderStopReason]
    > = [
      ["end_turn", "end_turn"],
      ["tool_use", "tool_use"],
      ["max_tokens", "max_tokens"],
      ["stop_sequence", "stop_sequence"],
      ["pause_turn", "pause_turn"],
      ["refusal", "refusal"],
      ["model_context_window_exceeded", "context_exceeded"],
      [null, "unknown"],
    ];

    for (const [anthropicReason, expectedReason] of stopReasons) {
      const message = anthropicMessage(
        [{ type: "text", text: "{}", citations: null }],
        anthropicReason,
      );
      message.usage.cache_creation_input_tokens = null;
      message.usage.cache_read_input_tokens = null;
      const provider = new AnthropicProvider({
        client: new FakeAnthropicMessagesClient([message]),
        environment: {},
      });

      const turn = await provider.complete(initialMessages, []);

      expect(turn.stopReason).toBe(expectedReason);
      expect(turn.usage).toEqual({
        inputTokens: 101,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 29,
      });
    }
  });

  test("rejects a non-object tool schema before making an API request", async () => {
    const client = new FakeAnthropicMessagesClient([]);
    const provider = new AnthropicProvider({ client, environment: {} });

    await expect(
      provider.complete(initialMessages, [
        {
          name: "broken_tool",
          description: "Invalid schema",
          inputSchema: { type: "string" },
        },
      ]),
    ).rejects.toThrow("broken_tool input schema must have type object");
    expect(client.createRequests).toHaveLength(0);
  });
});
