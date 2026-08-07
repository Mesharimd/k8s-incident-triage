import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterProvider,
  type OpenRouterChatClient,
  type OpenRouterChatCompletionRequest,
  type OpenRouterRequestOptions,
  loadOpenRouterClientConfig,
} from "../../src/agent/openrouter";
import { runTriageAgent } from "../../src/agent/loop";
import type {
  ProviderMessage,
  ProviderStopReason,
} from "../../src/agent/provider";
import type { ToolDefinition } from "../../src/tools/definition";
import type { ReadOnlyToolRegistry } from "../../src/tools";

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
      properties: {
        pod: { type: "string" },
        lines: { type: "integer", minimum: 1 },
      },
      required: ["pod"],
    },
  },
];

const noTools: ReadOnlyToolRegistry = {
  definitions: [],
  run: async () => {
    throw new Error("no tool should run");
  },
};

function openRouterResponse(
  message: Readonly<Record<string, unknown>>,
  finishReason: string | null = "stop",
): Readonly<Record<string, unknown>> {
  return {
    id: "gen_01",
    model: "openai/gpt-4o-mini",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 101,
      completion_tokens: 29,
      total_tokens: 130,
      prompt_tokens_details: {
        cached_tokens: 7,
        cache_write_tokens: 11,
      },
    },
  };
}

class FakeOpenRouterChatClient implements OpenRouterChatClient {
  readonly requests: OpenRouterChatCompletionRequest[] = [];
  readonly options: Array<OpenRouterRequestOptions | undefined> = [];

  constructor(private readonly responses: unknown[]) {}

  async create(
    request: OpenRouterChatCompletionRequest,
    options?: OpenRouterRequestOptions,
  ): Promise<unknown> {
    this.requests.push(request);
    this.options.push(options);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("fake OpenRouter response queue is empty");
    }
    return response;
  }
}

describe("OpenRouterProvider", () => {
  test("sends an OpenAI-compatible strict SRE request with the configured model and output budget", async () => {
    const client = new FakeOpenRouterChatClient([
      openRouterResponse({ role: "assistant", content: "{}" }),
    ]);
    const provider = new OpenRouterProvider({
      client,
      environment: {
        OPENROUTER_MODEL: "google/gemini-2.5-flash",
        AGENT_MAX_OUTPUT_TOKENS: "2048",
      },
    });

    await provider.complete(initialMessages, tools);

    const request = client.requests[0];
    const serializedRequest = JSON.stringify(request);
    expect(structuredClone(request)).toMatchObject({
      model: "google/gemini-2.5-flash",
      max_tokens: 2_048,
      stream: false,
      messages: [
        { role: "system", content: expect.stringContaining("hypothesis") },
        { role: "user", content: "Investigate checkout-api latency" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_pod_logs",
            description: "Read a bounded tail of pod logs.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                pod: { type: "string" },
                lines: { type: "integer", minimum: 1 },
              },
              required: ["pod"],
            },
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "triage_report",
          strict: true,
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
          },
        },
      },
      provider: { require_parameters: true },
    });
    expect(serializedRequest).toContain("code-issued evidence call ID");
    expect(serializedRequest).toContain("never execute");
    const mappedFunction = request?.tools?.[0]?.function as
      | Readonly<Record<string, unknown>>
      | undefined;
    expect(mappedFunction?.strict).toBeUndefined();
    const responseSchema = request?.response_format.json_schema.schema;
    expect(responseSchema?.anyOf).toBeUndefined();
  });

  test("uses the documented default model and omits tool controls when no tools are available", async () => {
    const client = new FakeOpenRouterChatClient([
      openRouterResponse({ role: "assistant", content: "{}" }),
    ]);
    const provider = new OpenRouterProvider({ client, environment: {} });

    await provider.complete(initialMessages, []);

    expect(DEFAULT_OPENROUTER_MODEL).toBe("openai/gpt-4o-mini");
    expect(client.requests[0]).toMatchObject({
      model: "openai/gpt-4o-mini",
    });
    expect(client.requests[0]?.tools).toBeUndefined();
    expect(client.requests[0]?.tool_choice).toBeUndefined();
    expect(client.requests[0]?.parallel_tool_calls).toBeUndefined();
  });

  test("requires a key for the real client and bounds timeout and retry settings", () => {
    expect(() => new OpenRouterProvider({ environment: {} })).toThrow(
      "OPENROUTER_API_KEY is required",
    );
    expect(loadOpenRouterClientConfig({})).toEqual({
      timeoutMs: 15_000,
      maxRetries: 0,
    });
    expect(
      loadOpenRouterClientConfig({
        OPENROUTER_TIMEOUT_MS: "30000",
        OPENROUTER_MAX_RETRIES: "2",
      }),
    ).toEqual({ timeoutMs: 30_000, maxRetries: 2 });

    for (const environment of [
      { OPENROUTER_TIMEOUT_MS: "999" },
      { OPENROUTER_TIMEOUT_MS: "120001" },
      { OPENROUTER_TIMEOUT_MS: "fifteen seconds" },
      { OPENROUTER_MAX_RETRIES: "3" },
      { OPENROUTER_MAX_RETRIES: "-1" },
    ]) {
      expect(() => loadOpenRouterClientConfig(environment)).toThrow(
        /OPENROUTER_(?:TIMEOUT_MS|MAX_RETRIES)/,
      );
    }
  });

  test("maps text and tool calls, then replays opaque reasoning and emits role tool results", async () => {
    const rawAssistantMessage = {
      role: "assistant",
      content: "Checking the failing pod.",
      reasoning_details: [
        {
          type: "reasoning.encrypted",
          data: "opaque-signed-reasoning",
          index: 0,
        },
      ],
      tool_calls: [
        {
          id: "call_or_01",
          type: "function",
          function: {
            name: "get_pod_logs",
            arguments:
              '{"pod":"checkout-api-abc","options":{"lines":200}}',
          },
        },
      ],
    } as const;
    const client = new FakeOpenRouterChatClient([
      openRouterResponse(rawAssistantMessage, "tool_calls"),
      openRouterResponse({ role: "assistant", content: "{}" }),
    ]);
    const provider = new OpenRouterProvider({ client, environment: {} });

    const firstTurn = await provider.complete(initialMessages, tools);

    expect(firstTurn).toEqual({
      role: "assistant",
      id: "gen_01",
      model: "openai/gpt-4o-mini",
      stopReason: "tool_use",
      usage: {
        inputTokens: 83,
        cacheCreationInputTokens: 11,
        cacheReadInputTokens: 7,
        outputTokens: 29,
      },
      content: [
        { type: "text", text: "Checking the failing pod." },
        {
          type: "tool_call",
          id: "call_or_01",
          name: "get_pod_logs",
          input: {
            pod: "checkout-api-abc",
            options: { lines: 200 },
          },
        },
      ],
      providerState: {
        provider: "openrouter",
        value: rawAssistantMessage,
      },
    });

    const toolCall = firstTurn.content.find(
      (block) => block.type === "tool_call",
    );
    if (toolCall?.type !== "tool_call") {
      throw new Error("OpenRouter fixture must expose a tool call");
    }
    const input = toolCall.input as {
      pod: string;
      options: { lines: number };
    };
    input.pod = "mutated-by-registry";
    input.options.lines = 9_999;

    await provider.complete(
      [
        ...initialMessages,
        firstTurn,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "call_or_01",
              content: '{"evidenceCallId":"call_001","result":"OOMKilled"}',
              isError: true,
            },
            { type: "text", text: "Use only that evidence." },
          ],
        },
      ],
      tools,
    );

    expect(client.requests[1]?.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "Investigate checkout-api latency" },
      rawAssistantMessage,
      {
        role: "tool",
        tool_call_id: "call_or_01",
        content: '{"evidenceCallId":"call_001","result":"OOMKilled"}',
      },
      { role: "user", content: "Use only that evidence." },
    ]);
  });

  test("rebuilds provider-neutral assistant text and tool calls without matching round-trip state", async () => {
    const client = new FakeOpenRouterChatClient([
      openRouterResponse({ role: "assistant", content: "{}" }),
    ]);
    const provider = new OpenRouterProvider({ client, environment: {} });
    const messages: readonly ProviderMessage[] = [
      ...initialMessages,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting." },
          {
            type: "tool_call",
            id: "call_generic",
            name: "get_pod_logs",
            input: { pod: "checkout-api-abc" },
          },
        ],
        providerState: { provider: "another-provider", value: "ignored" },
      },
    ];

    await provider.complete(messages, tools);

    expect(client.requests[0]?.messages[2]).toEqual({
      role: "assistant",
      content: "Inspecting.",
      tool_calls: [
        {
          id: "call_generic",
          type: "function",
          function: {
            name: "get_pod_logs",
            arguments: '{"pod":"checkout-api-abc"}',
          },
        },
      ],
    });
  });

  test("estimates the complete mapped context locally and fails promptly when aborted", async () => {
    const client = new FakeOpenRouterChatClient([]);
    const provider = new OpenRouterProvider({ client, environment: {} });
    const withoutTools = await provider.countInputTokens(initialMessages, []);
    const withTools = await provider.countInputTokens(initialMessages, tools);
    const longText = "é".repeat(1_000);
    const withLongText = await provider.countInputTokens(
      [
        {
          role: "user",
          content: [{ type: "text", text: longText }],
        },
      ],
      tools,
    );
    const withOpaqueState = await provider.countInputTokens(
      [
        ...initialMessages,
        {
          role: "assistant",
          content: [],
          providerState: {
            provider: "openrouter",
            value: {
              role: "assistant",
              content: null,
              reasoning_details: [{ data: "x".repeat(2_000) }],
            },
          },
        },
      ],
      tools,
    );

    expect(Number.isSafeInteger(withoutTools)).toBe(true);
    expect(withoutTools).toBeGreaterThan(0);
    expect(withTools).toBeGreaterThan(withoutTools);
    expect(withLongText).toBeGreaterThan(withTools + 1_000);
    expect(withOpaqueState).toBeGreaterThan(withTools + 1_000);
    expect(client.requests).toHaveLength(0);

    const controller = new AbortController();
    controller.abort(new Error("fixture abort"));
    await expect(
      provider.countInputTokens(initialMessages, tools, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("fixture abort");
  });

  test("enforces the loop context budget before making a billable completion", async () => {
    const client = new FakeOpenRouterChatClient([]);
    const provider = new OpenRouterProvider({
      client,
      environment: { AGENT_MAX_OUTPUT_TOKENS: "1" },
    });

    const result = await runTriageAgent(
      {
        alertname: "HighLatency",
        namespace: "payments",
        pod: "api-1",
        severity: "warning",
        fingerprint: "openrouter-budget",
        startsAt: "2026-08-07T00:00:00Z",
        labels: {},
        annotations: {},
      },
      {
        provider,
        tools: noTools,
        config: {
          maxToolCalls: 1,
          contextWindowTokens: 3,
          maxOutputTokens: 1,
          contextSafetyTokens: 1,
        },
      },
    );

    expect(client.requests).toHaveLength(0);
    expect(result.report.status).toBe("insufficient_data");
    expect(result.report.uncertainties).toEqual(["context budget exhausted"]);
  });

  test("forwards the overall abort signal to completion", async () => {
    const client = new FakeOpenRouterChatClient([
      openRouterResponse({ role: "assistant", content: "{}" }),
    ]);
    const provider = new OpenRouterProvider({ client, environment: {} });
    const controller = new AbortController();

    await provider.complete(initialMessages, tools, {
      signal: controller.signal,
    });

    expect(client.options[0]).toEqual({ signal: controller.signal });
  });

  test("maps every supported finish reason and nullable usage details", async () => {
    const finishReasons: ReadonlyArray<
      readonly [string | null, ProviderStopReason]
    > = [
      ["stop", "end_turn"],
      ["tool_calls", "tool_use"],
      ["function_call", "tool_use"],
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
      ["other", "unknown"],
      [null, "unknown"],
    ];

    for (const [finishReason, expected] of finishReasons) {
      const response = openRouterResponse(
        { role: "assistant", content: "{}" },
        finishReason,
      ) as {
        usage: { prompt_tokens_details?: unknown };
      };
      response.usage.prompt_tokens_details = null;
      const provider = new OpenRouterProvider({
        client: new FakeOpenRouterChatClient([response]),
        environment: {},
      });

      const turn = await provider.complete(initialMessages, []);

      expect(turn.stopReason).toBe(expected);
      expect(turn.usage).toEqual({
        inputTokens: 101,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 29,
      });
    }
  });

  test("maps a structured-output refusal to the provider refusal path", async () => {
    const provider = new OpenRouterProvider({
      client: new FakeOpenRouterChatClient([
        openRouterResponse(
          {
            role: "assistant",
            content: null,
            refusal: "I cannot help with this request.",
          },
          "stop",
        ),
      ]),
      environment: {},
    });

    const turn = await provider.complete(initialMessages, []);

    expect(turn.stopReason).toBe("refusal");
    expect(turn.content).toEqual([]);
  });

  test("rejects malformed tool arguments, embedded errors, empty choices, and invalid round-trip state", async () => {
    const malformedFixtures: readonly unknown[] = [
      openRouterResponse(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bad_json",
              type: "function",
              function: { name: "get_pod_logs", arguments: "{not json" },
            },
          ],
        },
        "tool_calls",
      ),
      { id: "gen_empty", model: "model", choices: [], usage: {} },
      {
        error: {
          code: 429,
          message: "private upstream diagnostic",
          metadata: { error_type: "rate_limit_error" },
        },
      },
      {
        ...openRouterResponse({
          role: "assistant",
          content: "partial unsafe answer",
        }),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "partial unsafe answer" },
            finish_reason: "error",
            error: {
              code: 503,
              message: "private generation diagnostic",
              metadata: { error_type: "provider_error" },
            },
          },
        ],
      },
    ];

    for (const fixture of malformedFixtures) {
      const provider = new OpenRouterProvider({
        client: new FakeOpenRouterChatClient([fixture]),
        environment: {},
      });
      await expect(provider.complete(initialMessages, tools)).rejects.toThrow();
    }

    const invalidStateClient = new FakeOpenRouterChatClient([]);
    const invalidStateProvider = new OpenRouterProvider({
      client: invalidStateClient,
      environment: {},
    });
    await expect(
      invalidStateProvider.complete(
        [
          {
            role: "assistant",
            content: [],
            providerState: { provider: "openrouter", value: "not-an-object" },
          },
        ],
        [],
      ),
    ).rejects.toThrow("invalid OpenRouter assistant round-trip state");
    expect(invalidStateClient.requests).toHaveLength(0);
  });

  test("rejects non-object tool schemas before making an API request", async () => {
    const client = new FakeOpenRouterChatClient([]);
    const provider = new OpenRouterProvider({ client, environment: {} });

    await expect(
      provider.complete(initialMessages, [
        {
          name: "broken_tool",
          description: "Invalid schema",
          inputSchema: { type: "string" },
        },
      ]),
    ).rejects.toThrow("broken_tool input schema must have type object");
    expect(client.requests).toHaveLength(0);
  });

  test("posts to the exact endpoint with bearer auth and retries only bounded transient failures", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "retry",
            metadata: { error_type: "rate_limit_error" },
          },
        }),
        { status: 429, headers: { "Retry-After": "0" } },
      ),
      new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: "retry",
            metadata: { error_type: "provider_unavailable" },
          },
        }),
        { status: 503, headers: { "Retry-After": "0" } },
      ),
      new Response(
        JSON.stringify(
          openRouterResponse({ role: "assistant", content: "{}" }),
        ),
        { status: 200 },
      ),
    ];
    const fetchFixture = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("fetch fixture queue is empty");
      }
      return response;
    }) as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: "fixture-openrouter-key-not-a-secret",
        OPENROUTER_MAX_RETRIES: "2",
      },
    });

    await provider.complete(initialMessages, []);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(call.init?.method).toBe("POST");
      expect(call.init?.headers).toMatchObject({
        Authorization: "Bearer fixture-openrouter-key-not-a-secret",
        "Content-Type": "application/json",
      });
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("retries transient errors embedded in HTTP 200 completion envelopes", async () => {
    let calls = 0;
    const fetchFixture = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            id: "gen_error",
            model: "openai/gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null },
                finish_reason: "error",
                error: {
                  code: 503,
                  message: "private provider diagnostic",
                  metadata: { error_type: "provider_unavailable" },
                },
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify(
          openRouterResponse({ role: "assistant", content: "{}" }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: "fixture-openrouter-key-not-a-secret",
        OPENROUTER_MAX_RETRIES: "1",
      },
    });

    await provider.complete(initialMessages, []);

    expect(calls).toBe(2);
  });

  test("does not retry earlier than a Retry-After delay that exceeds the request timeout", async () => {
    let calls = 0;
    const fetchFixture = (async (): Promise<Response> => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "wait before retrying",
            metadata: { error_type: "rate_limit_error" },
          },
        }),
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: "fixture-openrouter-key-not-a-secret",
        OPENROUTER_TIMEOUT_MS: "1000",
        OPENROUTER_MAX_RETRIES: "1",
      },
    });

    await expect(provider.complete(initialMessages, [])).rejects.toMatchObject({
      type: "rate_limit_error",
      status: 429,
    });
    expect(calls).toBe(1);
  });

  test("applies the configured request timeout without retrying by default", async () => {
    let calls = 0;
    let attemptSignal: AbortSignal | null | undefined;
    const fetchFixture = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls += 1;
      attemptSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: "fixture-openrouter-key-not-a-secret",
        OPENROUTER_TIMEOUT_MS: "1000",
      },
    });

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await provider.complete(initialMessages, []);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ type: "timeout_error" });
    expect(attemptSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });

  test("redacts non-retryable HTTP error bodies and credentials", async () => {
    let calls = 0;
    const fetchFixture = (async (): Promise<Response> => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 401,
            message:
              "credential fixture-openrouter-key-not-a-secret is invalid; private diagnostic",
            metadata: { error_type: "authentication_error" },
          },
        }),
        { status: 401, headers: { "x-request-id": "req_safe_01" } },
      );
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: "fixture-openrouter-key-not-a-secret",
        OPENROUTER_MAX_RETRIES: "2",
      },
    });

    let failure: unknown;
    try {
      await provider.complete(initialMessages, []);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      type: "authentication_error",
      status: 401,
      requestID: "req_safe_01",
    });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).not.toContain("fixture-openrouter-key-not-a-secret");
    expect(message).not.toContain("private diagnostic");
    expect(calls).toBe(1);
  });

  test("cancels a response whose declared body exceeds the byte limit", async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancellations += 1;
      },
    });
    const fetchFixture = (async (): Promise<Response> => {
      return new Response(body, {
        status: 502,
        headers: { "Content-Length": "1048577" },
      });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: "fixture-openrouter-key-not-a-secret",
      },
    });

    await expect(provider.complete(initialMessages, [])).rejects.toMatchObject({
      type: "response_too_large",
      status: 502,
    });
    expect(cancellations).toBe(1);
  });

  test("keeps the bounded error when cancellation of a streamed oversized body fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel: () => {
        throw new Error("private cancellation diagnostic");
      },
    });
    const fetchFixture = (async (): Promise<Response> => {
      return new Response(body, { status: 502 });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: "fixture-openrouter-key-not-a-secret",
      },
    });

    await expect(provider.complete(initialMessages, [])).rejects.toMatchObject({
      type: "response_too_large",
      status: 502,
    });
  });

  test("drops malformed response-controlled error metadata", async () => {
    const reflectedCredential = "fixture-openrouter-key-not-a-secret";
    const fetchFixture = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "private diagnostic",
            metadata: { error_type: reflectedCredential },
          },
        }),
        { status: 400, headers: { "x-request-id": reflectedCredential } },
      );
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider({
      fetch: fetchFixture,
      environment: {
        OPENROUTER_API_KEY: reflectedCredential,
      },
    });

    let failure: unknown;
    try {
      await provider.complete(initialMessages, []);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ type: "openrouter_error", status: 400 });
    expect(failure).not.toHaveProperty("requestID", reflectedCredential);
  });
});
