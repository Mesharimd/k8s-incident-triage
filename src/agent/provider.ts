import type { ToolDefinition } from "../tools/definition";

export const DEFAULT_AGENT_MAX_TOOL_CALLS = 10;
export const DEFAULT_AGENT_CONTEXT_TOKENS = 32_000;
export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 4_096;
export const DEFAULT_AGENT_CONTEXT_SAFETY_TOKENS = 1_024;
export const MAX_AGENT_CONTEXT_TOKENS = 1_000_000;
export const DEFAULT_AGENT_INCIDENT_TIMEOUT_MS = 75_000;
export const MIN_AGENT_INCIDENT_TIMEOUT_MS = 1_000;
export const MAX_AGENT_INCIDENT_TIMEOUT_MS = 120_000;

export interface AgentRuntimeConfig {
  readonly maxToolCalls: number;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly contextSafetyTokens: number;
  readonly incidentTimeoutMs?: number;
}

export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ToolCallContentBlock {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type AssistantContentBlock = TextContentBlock | ToolCallContentBlock;

export interface ToolResultContentBlock {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: readonly (TextContentBlock | ToolResultContentBlock)[];
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly AssistantContentBlock[];
  /**
   * Opaque round-trip state owned by the provider adapter. The loop never reads or
   * logs it; an adapter can use it to preserve provider-specific signed blocks.
   */
  readonly providerState?: Readonly<{
    readonly provider: string;
    readonly value: unknown;
  }>;
}

export type ProviderMessage = UserMessage | AssistantMessage;

export type ProviderStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal"
  | "context_exceeded"
  | "unknown";

export interface ProviderTokenUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

export interface AssistantTurn extends AssistantMessage {
  readonly id: string;
  readonly model: string;
  readonly stopReason: ProviderStopReason;
  readonly usage: ProviderTokenUsage;
}

export interface ProviderRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Provider-neutral completion surface. A future Ollama adapter can implement this
 * without changing the triage loop.
 */
export interface CompletionProvider {
  readonly name: string;
  complete(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
    options?: ProviderRequestOptions,
  ): Promise<AssistantTurn>;
  countInputTokens(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
    options?: ProviderRequestOptions,
  ): Promise<number>;
}

function integerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
}

export function loadAgentRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): AgentRuntimeConfig {
  const maxToolCalls = integerFromEnvironment(
    environment,
    "AGENT_MAX_TOOL_CALLS",
    DEFAULT_AGENT_MAX_TOOL_CALLS,
  );
  if (maxToolCalls < 1 || maxToolCalls > DEFAULT_AGENT_MAX_TOOL_CALLS) {
    throw new Error("AGENT_MAX_TOOL_CALLS must be between 1 and 10");
  }

  const contextWindowTokens = integerFromEnvironment(
    environment,
    "AGENT_CONTEXT_TOKENS",
    DEFAULT_AGENT_CONTEXT_TOKENS,
  );
  const maxOutputTokens = integerFromEnvironment(
    environment,
    "AGENT_MAX_OUTPUT_TOKENS",
    DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  );
  const contextSafetyTokens = integerFromEnvironment(
    environment,
    "AGENT_CONTEXT_SAFETY_TOKENS",
    DEFAULT_AGENT_CONTEXT_SAFETY_TOKENS,
  );
  const incidentTimeoutMs = integerFromEnvironment(
    environment,
    "AGENT_INCIDENT_TIMEOUT_MS",
    DEFAULT_AGENT_INCIDENT_TIMEOUT_MS,
  );

  if (contextWindowTokens < 1 || contextWindowTokens > MAX_AGENT_CONTEXT_TOKENS) {
    throw new Error(
      `AGENT_CONTEXT_TOKENS must be between 1 and ${MAX_AGENT_CONTEXT_TOKENS}`,
    );
  }
  if (maxOutputTokens < 1) {
    throw new Error("AGENT_MAX_OUTPUT_TOKENS must be at least 1");
  }
  if (contextSafetyTokens < 1) {
    throw new Error("AGENT_CONTEXT_SAFETY_TOKENS must be at least 1");
  }
  if (
    incidentTimeoutMs < MIN_AGENT_INCIDENT_TIMEOUT_MS ||
    incidentTimeoutMs > MAX_AGENT_INCIDENT_TIMEOUT_MS
  ) {
    throw new Error(
      `AGENT_INCIDENT_TIMEOUT_MS must be between ${MIN_AGENT_INCIDENT_TIMEOUT_MS} and ${MAX_AGENT_INCIDENT_TIMEOUT_MS}`,
    );
  }

  if (contextWindowTokens <= maxOutputTokens + contextSafetyTokens) {
    throw new Error("context window must exceed output and safety reserves");
  }

  return {
    maxToolCalls,
    contextWindowTokens,
    maxOutputTokens,
    contextSafetyTokens,
    incidentTimeoutMs,
  };
}

export function assertAgentRuntimeConfig(config: AgentRuntimeConfig): void {
  if (
    !Number.isSafeInteger(config.maxToolCalls) ||
    config.maxToolCalls < 1 ||
    config.maxToolCalls > DEFAULT_AGENT_MAX_TOOL_CALLS
  ) {
    throw new Error("maxToolCalls must be between 1 and 10");
  }
  if (
    !Number.isSafeInteger(config.contextWindowTokens) ||
    config.contextWindowTokens < 1 ||
    config.contextWindowTokens > MAX_AGENT_CONTEXT_TOKENS
  ) {
    throw new Error(
      `contextWindowTokens must be between 1 and ${MAX_AGENT_CONTEXT_TOKENS}`,
    );
  }
  if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1) {
    throw new Error("maxOutputTokens must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(config.contextSafetyTokens) ||
    config.contextSafetyTokens < 1
  ) {
    throw new Error("contextSafetyTokens must be a positive safe integer");
  }
  if (
    config.contextWindowTokens <=
    config.maxOutputTokens + config.contextSafetyTokens
  ) {
    throw new Error("context window must exceed output and safety reserves");
  }
  const incidentTimeoutMs =
    config.incidentTimeoutMs ?? DEFAULT_AGENT_INCIDENT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(incidentTimeoutMs) ||
    incidentTimeoutMs < MIN_AGENT_INCIDENT_TIMEOUT_MS ||
    incidentTimeoutMs > MAX_AGENT_INCIDENT_TIMEOUT_MS
  ) {
    throw new Error(
      `incidentTimeoutMs must be between ${MIN_AGENT_INCIDENT_TIMEOUT_MS} and ${MAX_AGENT_INCIDENT_TIMEOUT_MS}`,
    );
  }
}
