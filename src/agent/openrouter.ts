import type { ToolDefinition } from "../tools/definition";
import {
  loadAgentRuntimeConfig,
  type AssistantTurn,
  type CompletionProvider,
  type ProviderMessage,
  type ProviderRequestOptions,
  type ProviderStopReason,
  type TextContentBlock,
  type ToolCallContentBlock,
} from "./provider";
import {
  OPENROUTER_TRIAGE_REPORT_SCHEMA,
  SRE_SYSTEM_PROMPT,
} from "./sre-contract";

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
export const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_OPENROUTER_TIMEOUT_MS = 15_000;
const MIN_OPENROUTER_TIMEOUT_MS = 1_000;
const MAX_OPENROUTER_TIMEOUT_MS = 120_000;
const DEFAULT_OPENROUTER_MAX_RETRIES = 0;
const MAX_OPENROUTER_MAX_RETRIES = 2;
const MAX_OPENROUTER_RESPONSE_BYTES = 1_048_576;
const MAX_RETRY_DELAY_MS = 1_000;

type JsonObject = Readonly<Record<string, unknown>>;

export interface OpenRouterClientConfig {
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export interface OpenRouterRequestOptions extends ProviderRequestOptions {}

export interface OpenRouterFunctionTool {
  readonly type: "function";
  readonly function: Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
  }>;
}

export type OpenRouterChatMessage =
  | Readonly<{ role: "system"; content: string }>
  | Readonly<{ role: "user"; content: string }>
  | Readonly<{ role: "tool"; tool_call_id: string; content: string }>
  | (JsonObject & Readonly<{ role: "assistant" }>);

export interface OpenRouterChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly OpenRouterChatMessage[];
  readonly max_tokens: number;
  readonly stream: false;
  readonly response_format: Readonly<{
    type: "json_schema";
    json_schema: Readonly<{
      name: "triage_report";
      strict: true;
      schema: Readonly<Record<string, unknown>>;
    }>;
  }>;
  readonly provider: Readonly<{ require_parameters: true }>;
  readonly tools?: readonly OpenRouterFunctionTool[];
  readonly tool_choice?: "auto";
  readonly parallel_tool_calls?: false;
}

type OpenRouterRequestContext = Omit<
  OpenRouterChatCompletionRequest,
  "max_tokens"
>;

export interface OpenRouterChatClient {
  create(
    request: OpenRouterChatCompletionRequest,
    options?: OpenRouterRequestOptions,
  ): Promise<unknown>;
}

export interface OpenRouterProviderOptions {
  readonly client?: OpenRouterChatClient;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

interface OpenRouterErrorOptions {
  readonly type: string;
  readonly status?: number;
  readonly requestID?: string;
  readonly retryAfterMs?: number;
}

export class OpenRouterError extends Error {
  override readonly name = "OpenRouterError";
  readonly type: string;
  readonly status?: number;
  readonly requestID?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: OpenRouterErrorOptions) {
    super(message);
    this.type = options.type;
    this.status = options.status;
    this.requestID = options.requestID;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function boundedEnvironmentInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function loadOpenRouterClientConfig(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): OpenRouterClientConfig {
  return {
    timeoutMs: boundedEnvironmentInteger(
      environment,
      "OPENROUTER_TIMEOUT_MS",
      DEFAULT_OPENROUTER_TIMEOUT_MS,
      MIN_OPENROUTER_TIMEOUT_MS,
      MAX_OPENROUTER_TIMEOUT_MS,
    ),
    maxRetries: boundedEnvironmentInteger(
      environment,
      "OPENROUTER_MAX_RETRIES",
      DEFAULT_OPENROUTER_MAX_RETRIES,
      0,
      MAX_OPENROUTER_MAX_RETRIES,
    ),
  };
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function safeMetadataToken(
  value: unknown,
  maximumLength: number,
  forbiddenValue?: string,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
    (forbiddenValue !== undefined && value.includes(forbiddenValue))
  ) {
    return undefined;
  }
  return value;
}

function safeRequestId(
  response: Response,
  forbiddenValue?: string,
): string | undefined {
  const value =
    response.headers.get("x-request-id") ??
    response.headers.get("x-openrouter-request-id");
  return safeMetadataToken(value, 256, forbiddenValue);
}

function errorMetadata(
  body: unknown,
  fallbackStatus?: number,
  forbiddenValue?: string,
): Pick<OpenRouterErrorOptions, "type" | "status"> {
  const error = objectValue(objectValue(body)?.error);
  const metadata = objectValue(error?.metadata);
  const errorType = metadata?.error_type;
  const code = error?.code;
  const status =
    typeof fallbackStatus === "number"
      ? fallbackStatus
      : typeof code === "number" &&
          Number.isSafeInteger(code) &&
          code >= 100 &&
          code <= 599
        ? code
        : undefined;
  return {
    type:
      safeMetadataToken(errorType, 128, forbiddenValue) ?? "openrouter_error",
    ...(status === undefined ? {} : { status }),
  };
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const milliseconds = Math.ceil(Number(raw) * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }
  const milliseconds = Math.max(retryAt - Date.now(), 0);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the bounded-response classification even if cancellation fails.
  }
}

async function readBoundedJson(
  response: Response,
  forbiddenValue?: string,
): Promise<unknown> {
  const requestID = safeRequestId(response, forbiddenValue);
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength !== undefined && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length > MAX_OPENROUTER_RESPONSE_BYTES
    ) {
      await cancelResponseBody(response);
      throw new OpenRouterError("OpenRouter response exceeded the byte limit", {
        type: "response_too_large",
        status: response.status,
        ...(requestID === undefined ? {} : { requestID }),
      });
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new OpenRouterError("OpenRouter returned an empty response", {
      type: "invalid_response",
      status: response.status,
      ...(requestID === undefined ? {} : { requestID }),
    });
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_OPENROUTER_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the bounded-response classification if cancellation fails.
      }
      throw new OpenRouterError("OpenRouter response exceeded the byte limit", {
        type: "response_too_large",
        status: response.status,
        ...(requestID === undefined ? {} : { requestID }),
      });
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new OpenRouterError("OpenRouter returned invalid JSON", {
      type: "invalid_response",
      status: response.status,
      ...(requestID === undefined ? {} : { requestID }),
    });
  }
}

function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new DOMException("The operation was aborted", "AbortError");
}

function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) {
    throwAbortReason(signal);
  }
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        throwAbortReason(signal as AbortSignal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryable(error: OpenRouterError): boolean {
  return (
    error.type === "transport_error" ||
    error.type === "timeout_error" ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  );
}

function embeddedErrorEnvelope(value: unknown): unknown | undefined {
  const response = objectValue(value);
  if (response === undefined) {
    return undefined;
  }
  if (response.error !== undefined) {
    return response;
  }
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const choice = objectValue(choices[0]);
  if (choice === undefined) {
    return undefined;
  }
  if (choice.error !== undefined) {
    return { error: choice.error };
  }
  return choice.finish_reason === "error" ? response : undefined;
}

class FetchOpenRouterChatClient implements OpenRouterChatClient {
  constructor(
    private readonly apiKey: string,
    private readonly config: OpenRouterClientConfig,
    private readonly fetchImplementation: typeof fetch,
  ) {}

  private async attempt(
    body: string,
    outerSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (outerSignal?.aborted === true) {
      throwAbortReason(outerSignal);
    }

    const attemptController = new AbortController();
    let timedOut = false;
    const onOuterAbort = (): void => {
      attemptController.abort(outerSignal?.reason);
    };
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, this.config.timeoutMs);

    try {
      const response = await this.fetchImplementation(
        OPENROUTER_CHAT_COMPLETIONS_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: attemptController.signal,
        },
      );
      const responseBody = await readBoundedJson(response, this.apiKey);
      const requestID = safeRequestId(response, this.apiKey);
      if (!response.ok) {
        const retryAfterMs = retryAfterMilliseconds(response);
        throw new OpenRouterError("OpenRouter request failed", {
          ...errorMetadata(responseBody, response.status, this.apiKey),
          ...(requestID === undefined ? {} : { requestID }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      const embeddedError = embeddedErrorEnvelope(responseBody);
      if (embeddedError !== undefined) {
        const retryAfterMs = retryAfterMilliseconds(response);
        throw new OpenRouterError("OpenRouter returned a generation error", {
          ...errorMetadata(embeddedError, undefined, this.apiKey),
          ...(requestID === undefined ? {} : { requestID }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      return responseBody;
    } catch (error) {
      if (isAborted(outerSignal)) {
        throwAbortReason(outerSignal);
      }
      if (error instanceof OpenRouterError) {
        throw error;
      }
      if (timedOut) {
        throw new OpenRouterError("OpenRouter request timed out", {
          type: "timeout_error",
        });
      }
      throw new OpenRouterError("OpenRouter request failed", {
        type: "transport_error",
      });
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }

  async create(
    request: OpenRouterChatCompletionRequest,
    options?: OpenRouterRequestOptions,
  ): Promise<unknown> {
    if (options?.signal?.aborted === true) {
      throwAbortReason(options.signal);
    }
    let body: string;
    try {
      body = JSON.stringify(request);
    } catch {
      throw new OpenRouterError("OpenRouter request was not serializable", {
        type: "invalid_request",
      });
    }

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await this.attempt(body, options?.signal);
      } catch (error) {
        if (isAborted(options?.signal)) {
          throwAbortReason(options.signal);
        }
        const failure =
          error instanceof OpenRouterError
            ? error
            : new OpenRouterError("OpenRouter request failed", {
                type: "transport_error",
              });
        if (attempt >= this.config.maxRetries || !retryable(failure)) {
          throw failure;
        }
        if (
          failure.retryAfterMs !== undefined &&
          failure.retryAfterMs > this.config.timeoutMs
        ) {
          throw failure;
        }
        const delayMs =
          failure.retryAfterMs ??
          Math.min(100 * 2 ** attempt, MAX_RETRY_DELAY_MS);
        await abortableDelay(delayMs, options?.signal);
      }
    }
    throw new OpenRouterError("OpenRouter request failed", {
      type: "transport_error",
    });
  }
}

function createFetchClient(
  environment: Readonly<Record<string, string | undefined>>,
  fetchImplementation: typeof fetch,
): OpenRouterChatClient {
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  return new FetchOpenRouterChatClient(
    apiKey,
    loadOpenRouterClientConfig(environment),
    fetchImplementation,
  );
}

function mapTool(tool: ToolDefinition): OpenRouterFunctionTool {
  if (tool.inputSchema.type !== "object") {
    throw new Error(`${tool.name} input schema must have type object`);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        ...tool.inputSchema,
        type: "object",
        additionalProperties: false,
      },
    },
  };
}

function serializeToolArguments(input: unknown): string {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) {
      throw new Error("not serializable");
    }
    return serialized;
  } catch {
    throw new OpenRouterError("OpenRouter tool input was not serializable", {
      type: "invalid_request",
    });
  }
}

function mapGenericAssistantMessage(
  message: Extract<ProviderMessage, { role: "assistant" }>,
): OpenRouterChatMessage {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block) => block.type === "tool_call")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: {
        name: block.name,
        arguments: serializeToolArguments(block.input),
      },
    }));
  return {
    role: "assistant",
    content: text.length === 0 ? null : text,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function cloneRoundTripState(value: unknown): OpenRouterChatMessage {
  const state = objectValue(value);
  if (state?.role !== "assistant") {
    throw new Error("invalid OpenRouter assistant round-trip state");
  }
  if (
    state.content !== undefined &&
    state.content !== null &&
    typeof state.content !== "string"
  ) {
    throw new Error("invalid OpenRouter assistant round-trip state");
  }
  try {
    return structuredClone(state) as OpenRouterChatMessage;
  } catch {
    throw new Error("invalid OpenRouter assistant round-trip state");
  }
}

function mapMessages(
  messages: readonly ProviderMessage[],
): OpenRouterChatMessage[] {
  const mapped: OpenRouterChatMessage[] = [
    { role: "system", content: SRE_SYSTEM_PROMPT },
  ];
  for (const message of messages) {
    if (message.role === "assistant") {
      mapped.push(
        message.providerState?.provider === "openrouter"
          ? cloneRoundTripState(message.providerState.value)
          : mapGenericAssistantMessage(message),
      );
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        mapped.push({ role: "user", content: block.text });
      } else {
        mapped.push({
          role: "tool",
          tool_call_id: block.toolCallId,
          content: block.content,
        });
      }
    }
  }
  return mapped;
}

function mapStopReason(reason: string | null): ProviderStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "unknown";
  }
}

function requiredString(
  object: JsonObject,
  key: string,
  description: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OpenRouterError(`OpenRouter returned an invalid ${description}`, {
      type: "invalid_response",
    });
  }
  return value;
}

function nonNegativeUsageInteger(
  object: JsonObject,
  key: string,
  fallback?: number,
): number {
  const value = object[key];
  if ((value === undefined || value === null) && fallback !== undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OpenRouterError("OpenRouter returned invalid token usage", {
      type: "invalid_response",
    });
  }
  return value as number;
}

function embeddedResponseError(value: unknown): OpenRouterError {
  return new OpenRouterError("OpenRouter returned a generation error", {
    ...errorMetadata(value),
  });
}

function parseAssistantContent(
  message: JsonObject,
): Array<TextContentBlock | ToolCallContentBlock> {
  const content: Array<TextContentBlock | ToolCallContentBlock> = [];
  if (typeof message.content === "string") {
    content.push({ type: "text", text: message.content });
  } else if (message.content !== null && message.content !== undefined) {
    throw new OpenRouterError("OpenRouter returned invalid assistant content", {
      type: "invalid_response",
    });
  }

  if (message.tool_calls === undefined) {
    return content;
  }
  if (!Array.isArray(message.tool_calls)) {
    throw new OpenRouterError("OpenRouter returned invalid tool calls", {
      type: "invalid_response",
    });
  }
  for (const value of message.tool_calls) {
    const toolCall = objectValue(value);
    const functionCall = objectValue(toolCall?.function);
    if (
      toolCall === undefined ||
      toolCall.type !== "function" ||
      functionCall === undefined
    ) {
      throw new OpenRouterError("OpenRouter returned an invalid tool call", {
        type: "invalid_response",
      });
    }
    const id = requiredString(toolCall, "id", "tool call ID");
    const name = requiredString(functionCall, "name", "tool name");
    const argumentsJson = requiredString(
      functionCall,
      "arguments",
      "tool arguments",
    );
    let input: unknown;
    try {
      input = JSON.parse(argumentsJson) as unknown;
    } catch {
      throw new OpenRouterError("OpenRouter returned invalid tool arguments", {
        type: "invalid_response",
      });
    }
    content.push({
      type: "tool_call",
      id,
      name,
      input: structuredClone(input),
    });
  }
  return content;
}

function parseAssistantTurn(value: unknown): AssistantTurn {
  const response = objectValue(value);
  if (response === undefined) {
    throw new OpenRouterError("OpenRouter returned an invalid response", {
      type: "invalid_response",
    });
  }
  if (response.error !== undefined) {
    throw embeddedResponseError(response);
  }
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OpenRouterError("OpenRouter returned no completion choice", {
      type: "invalid_response",
    });
  }
  const choice = objectValue(choices[0]);
  if (choice === undefined) {
    throw new OpenRouterError("OpenRouter returned an invalid completion choice", {
      type: "invalid_response",
    });
  }
  if (choice.error !== undefined || choice.finish_reason === "error") {
    throw embeddedResponseError(
      choice.error === undefined ? response : { error: choice.error },
    );
  }
  const finishReason = choice.finish_reason;
  if (finishReason !== null && typeof finishReason !== "string") {
    throw new OpenRouterError("OpenRouter returned an invalid finish reason", {
      type: "invalid_response",
    });
  }
  const message = objectValue(choice.message);
  if (message?.role !== "assistant") {
    throw new OpenRouterError("OpenRouter returned an invalid assistant message", {
      type: "invalid_response",
    });
  }
  if (
    message.refusal !== undefined &&
    message.refusal !== null &&
    typeof message.refusal !== "string"
  ) {
    throw new OpenRouterError("OpenRouter returned an invalid refusal", {
      type: "invalid_response",
    });
  }
  const usage = objectValue(response.usage);
  if (usage === undefined) {
    throw new OpenRouterError("OpenRouter returned invalid token usage", {
      type: "invalid_response",
    });
  }
  const promptDetails = objectValue(usage.prompt_tokens_details);
  const promptTokens = nonNegativeUsageInteger(usage, "prompt_tokens");
  const cacheCreationInputTokens =
    promptDetails === undefined
      ? 0
      : nonNegativeUsageInteger(promptDetails, "cache_write_tokens", 0);
  const cacheReadInputTokens =
    promptDetails === undefined
      ? 0
      : nonNegativeUsageInteger(promptDetails, "cached_tokens", 0);
  if (cacheCreationInputTokens + cacheReadInputTokens > promptTokens) {
    throw new OpenRouterError("OpenRouter returned invalid token usage", {
      type: "invalid_response",
    });
  }
  const rawState = structuredClone(message);
  return {
    role: "assistant",
    id: requiredString(response, "id", "response ID"),
    model: requiredString(response, "model", "model"),
    stopReason:
      typeof message.refusal === "string" && message.refusal.length > 0
        ? "refusal"
        : mapStopReason(finishReason),
    usage: {
      inputTokens:
        promptTokens - cacheCreationInputTokens - cacheReadInputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens: nonNegativeUsageInteger(usage, "completion_tokens"),
    },
    content: parseAssistantContent(message),
    providerState: {
      provider: "openrouter",
      value: rawState,
    },
  };
}

export class OpenRouterProvider implements CompletionProvider {
  readonly name = "openrouter";

  private readonly client: OpenRouterChatClient;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(options: OpenRouterProviderOptions = {}) {
    const environment = options.environment ?? Bun.env;
    const configuredModel = environment.OPENROUTER_MODEL?.trim();
    this.model =
      configuredModel === undefined || configuredModel.length === 0
        ? DEFAULT_OPENROUTER_MODEL
        : configuredModel;
    this.maxOutputTokens = loadAgentRuntimeConfig(environment).maxOutputTokens;
    this.client =
      options.client ??
      createFetchClient(environment, options.fetch ?? globalThis.fetch);
  }

  private requestContext(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
  ): OpenRouterRequestContext {
    const mappedTools = tools.map(mapTool);
    const context: OpenRouterRequestContext = {
      model: this.model,
      messages: mapMessages(messages),
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "triage_report",
          strict: true,
          schema: OPENROUTER_TRIAGE_REPORT_SCHEMA,
        },
      },
      provider: { require_parameters: true },
    };
    return mappedTools.length === 0
      ? context
      : {
          ...context,
          tools: mappedTools,
          tool_choice: "auto",
          parallel_tool_calls: false,
        };
  }

  async complete(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
    options?: OpenRouterRequestOptions,
  ): Promise<AssistantTurn> {
    const response = await this.client.create(
      {
        ...this.requestContext(messages, tools),
        max_tokens: this.maxOutputTokens,
      },
      options?.signal === undefined ? undefined : { signal: options.signal },
    );
    return parseAssistantTurn(response);
  }

  async countInputTokens(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
    options?: OpenRouterRequestOptions,
  ): Promise<number> {
    if (options?.signal?.aborted === true) {
      throwAbortReason(options.signal);
    }
    const serialized = JSON.stringify(this.requestContext(messages, tools));
    const estimate = new TextEncoder().encode(serialized).byteLength;
    if (!Number.isSafeInteger(estimate)) {
      throw new OpenRouterError("OpenRouter context estimate was unsafe", {
        type: "invalid_request",
      });
    }
    // OpenRouter exposes native counts only after generation. UTF-8 bytes are a
    // conservative, model-independent preflight ceiling for supported tokenizers.
    return estimate;
  }
}
