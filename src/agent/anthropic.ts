import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageCountTokensParams,
  MessageCreateParamsNonStreaming,
  MessageParam,
  MessageTokensCount,
  StopReason,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";

import type { ToolDefinition } from "../tools/definition";
import {
  loadAgentRuntimeConfig,
  type AssistantTurn,
  type CompletionProvider,
  type ProviderMessage,
  type ProviderStopReason,
  type TextContentBlock,
  type ToolCallContentBlock,
} from "./provider";
import { SRE_SYSTEM_PROMPT, TRIAGE_REPORT_SCHEMA } from "./sre-contract";

export { SRE_SYSTEM_PROMPT as ANTHROPIC_SRE_SYSTEM_PROMPT } from "./sre-contract";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const DEFAULT_ANTHROPIC_TIMEOUT_MS = 15_000;
const MIN_ANTHROPIC_TIMEOUT_MS = 1_000;
const MAX_ANTHROPIC_TIMEOUT_MS = 120_000;
const DEFAULT_ANTHROPIC_MAX_RETRIES = 0;
const MAX_ANTHROPIC_MAX_RETRIES = 2;

export interface AnthropicClientConfig {
  readonly timeoutMs: number;
  readonly maxRetries: number;
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

export function loadAnthropicClientConfig(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): AnthropicClientConfig {
  return {
    timeoutMs: boundedEnvironmentInteger(
      environment,
      "ANTHROPIC_TIMEOUT_MS",
      DEFAULT_ANTHROPIC_TIMEOUT_MS,
      MIN_ANTHROPIC_TIMEOUT_MS,
      MAX_ANTHROPIC_TIMEOUT_MS,
    ),
    maxRetries: boundedEnvironmentInteger(
      environment,
      "ANTHROPIC_MAX_RETRIES",
      DEFAULT_ANTHROPIC_MAX_RETRIES,
      0,
      MAX_ANTHROPIC_MAX_RETRIES,
    ),
  };
}

const STOP_REASON_MAP: Readonly<Record<StopReason, ProviderStopReason>> = {
  end_turn: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  stop_sequence: "stop_sequence",
  pause_turn: "pause_turn",
  refusal: "refusal",
  model_context_window_exceeded: "context_exceeded",
};

export interface AnthropicMessagesClient {
  create(
    params: MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Message>;
  countTokens(
    params: MessageCountTokensParams,
    options?: Anthropic.RequestOptions,
  ): Promise<MessageTokensCount>;
}

export interface AnthropicProviderOptions {
  readonly client?: AnthropicMessagesClient;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface AnthropicProviderRequestOptions {
  readonly signal?: AbortSignal;
}

function createSdkMessagesClient(
  environment: Readonly<Record<string, string | undefined>>,
): AnthropicMessagesClient {
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
  const clientConfig = loadAnthropicClientConfig(environment);
  const sdk = new Anthropic({
    apiKey,
    timeout: clientConfig.timeoutMs,
    maxRetries: clientConfig.maxRetries,
  });
  return {
    create: (params, options) => sdk.messages.create(params, options),
    countTokens: (params, options) => sdk.messages.countTokens(params, options),
  };
}

function sdkRequestOptions(
  options: AnthropicProviderRequestOptions | undefined,
): Anthropic.RequestOptions | undefined {
  return options?.signal === undefined ? undefined : { signal: options.signal };
}

function mapTool(tool: ToolDefinition): Tool {
  if (tool.inputSchema.type !== "object") {
    throw new Error(`${tool.name} input schema must have type object`);
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      ...tool.inputSchema,
      type: "object",
      additionalProperties: false,
    },
    strict: true,
  };
}

function mapGenericContent(message: ProviderMessage): ContentBlockParam[] {
  if (message.role === "user") {
    return message.content.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: block.isError,
      };
    });
  }

  return message.content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  });
}

function mapMessage(message: ProviderMessage): MessageParam {
  if (
    message.role === "assistant" &&
    message.providerState?.provider === "anthropic"
  ) {
    if (!Array.isArray(message.providerState.value)) {
      throw new Error("invalid Anthropic assistant round-trip state");
    }

    // This opaque value is created only from a successful Anthropic response below.
    // Reusing it verbatim preserves signed thinking and redacted-thinking blocks.
    const rawContent = message.providerState.value as ContentBlockParam[];
    return { role: "assistant", content: rawContent };
  }

  return { role: message.role, content: mapGenericContent(message) };
}

function mapStopReason(reason: StopReason | null): ProviderStopReason {
  return reason === null ? "unknown" : STOP_REASON_MAP[reason];
}

function mapAssistantContent(
  response: Message,
): Array<TextContentBlock | ToolCallContentBlock> {
  const content: Array<TextContentBlock | ToolCallContentBlock> = [];
  for (const block of response.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: structuredClone(block.input),
      });
    }
  }
  return content;
}

export class AnthropicProvider implements CompletionProvider {
  readonly name = "anthropic";

  private readonly client: AnthropicMessagesClient;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(options: AnthropicProviderOptions = {}) {
    const environment = options.environment ?? Bun.env;
    const configuredModel = environment.ANTHROPIC_MODEL?.trim();
    this.model =
      configuredModel === undefined || configuredModel.length === 0
        ? DEFAULT_ANTHROPIC_MODEL
        : configuredModel;
    this.maxOutputTokens = loadAgentRuntimeConfig(environment).maxOutputTokens;
    this.client = options.client ?? createSdkMessagesClient(environment);
  }

  private requestContext(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
  ): MessageCountTokensParams {
    const mappedTools = tools.map(mapTool);
    const context: MessageCountTokensParams = {
      model: this.model,
      system: SRE_SYSTEM_PROMPT,
      messages: messages.map(mapMessage),
      output_config: {
        format: {
          type: "json_schema",
          schema: TRIAGE_REPORT_SCHEMA,
        },
      },
    };
    return mappedTools.length === 0
      ? context
      : {
          ...context,
          tools: mappedTools,
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
        };
  }

  async complete(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
    options?: AnthropicProviderRequestOptions,
  ): Promise<AssistantTurn> {
    const response = await this.client.create(
      {
        ...this.requestContext(messages, tools),
        max_tokens: this.maxOutputTokens,
      },
      sdkRequestOptions(options),
    );

    return {
      role: "assistant",
      id: response.id,
      model: response.model,
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        outputTokens: response.usage.output_tokens,
      },
      content: mapAssistantContent(response),
      providerState: {
        provider: "anthropic",
        value: response.content,
      },
    };
  }

  async countInputTokens(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
    options?: AnthropicProviderRequestOptions,
  ): Promise<number> {
    const result = await this.client.countTokens(
      this.requestContext(messages, tools),
      sdkRequestOptions(options),
    );
    return result.input_tokens;
  }
}
