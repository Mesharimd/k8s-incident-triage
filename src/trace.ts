import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface IncidentStartedTraceEvent {
  readonly type: "incident_started";
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly startsAt: string;
  readonly alertname: string;
  readonly namespace: string;
  readonly pod: string;
  readonly severity: string;
}

export interface ProviderRequestTraceEvent {
  readonly type: "provider_request";
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly provider: string;
  readonly requestId: string;
  readonly inputTokens: number;
  readonly messageCount: number;
  readonly toolDefinitionCount: number;
  readonly remainingToolCalls: number;
}

export interface ProviderResponseTraceEvent {
  readonly type: "provider_response";
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly provider: string;
  readonly requestId: string;
  readonly responseId: string;
  readonly model: string;
  readonly stopReason: string;
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  readonly toolCallCount: number;
}

export interface ToolCallTraceEvent {
  readonly type: "tool_call";
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly callId: string;
  readonly providerToolCallId?: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface ToolResultTraceEvent {
  readonly type: "tool_result";
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly callId: string;
  readonly providerToolCallId?: string;
  readonly toolName: string;
  readonly rawBytes: number;
  readonly admittedBytes: number;
  readonly contentSha256: string;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly summarized: boolean;
  readonly summaryReason?: string;
}

export type TraceRunStopReason =
  | "context_budget"
  | "tool_call_limit"
  | "provider_refusal"
  | "provider_error"
  | "invalid_report";

export interface RunStoppedTraceEvent {
  readonly type: "run_stopped";
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly reason: TraceRunStopReason;
  readonly detail: string;
  readonly inputTokens?: number;
  readonly limit?: number;
  readonly providerErrorKind?: string;
  readonly providerStatus?: number;
  readonly providerRequestId?: string;
}

export type TraceReportStatus = "diagnosed" | "insufficient_data";

export interface ReportCompletedTraceEvent {
  readonly type: "report_completed";
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly status: TraceReportStatus;
  readonly toolCallCount: number;
  readonly citationCount: number;
  readonly reportBytes: number;
  readonly report: unknown;
}

export type TraceEvent =
  | IncidentStartedTraceEvent
  | ProviderRequestTraceEvent
  | ProviderResponseTraceEvent
  | ToolCallTraceEvent
  | ToolResultTraceEvent
  | RunStoppedTraceEvent
  | ReportCompletedTraceEvent;

export type RecordedTraceEvent = Readonly<{ timestamp: string }> & TraceEvent;

export interface TraceSink {
  record(event: TraceEvent): Promise<void>;
}

export type TraceClock = () => Date;

const REDACTED = "[REDACTED]";
const defaultClock: TraceClock = () => new Date();

const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "anthropicapikey",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "password",
  "passwd",
  "providerstate",
  "reasoning",
  "redactedthinking",
  "refreshtoken",
  "secret",
  "setcookie",
  "thinking",
  "token",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.includes("apikey") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.endsWith("token")
  );
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+(?::[^\s/@]*)?@)/gi,
      `$1${REDACTED}@`,
    )
    .replace(
      /\b((?:proxy-)?authorization)(\s*[:=]\s*)[^\r\n]*/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    )
    .replace(
      /\b((?:set-)?cookie)(\s*[:=]\s*)[^\r\n]*/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, REDACTED)
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    )
    .replace(
      /\b([a-z0-9_-]*(?:api[_-]?key|access[_-]?key|credential|password|passwd|secret|token)[a-z0-9_-]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    );
}

const redactPlainText = redactSensitiveText;

function sanitizeUnknown(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value, ancestors);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "[NON_FINITE_NUMBER]";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return "[UNSERIALIZABLE]";
  }
  if (ancestors.has(value)) {
    return "[CIRCULAR]";
  }

  ancestors.add(value);
  let sanitized: unknown;
  if (Array.isArray(value)) {
    sanitized = value.map((entry) => sanitizeUnknown(entry, ancestors));
  } else if (value instanceof Date) {
    sanitized = value.toISOString();
  } else {
    const entries = Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? REDACTED : sanitizeUnknown(entry, ancestors),
    ] as const);
    sanitized = Object.fromEntries(entries);
  }
  ancestors.delete(value);
  return sanitized;
}

function redactText(value: string, ancestors = new WeakSet<object>()): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(sanitizeUnknown(parsed, ancestors));
      }
    } catch {
      // A tool result can be ordinary text that happens to begin with a brace.
    }
  }
  return redactPlainText(value);
}

function sanitizeTraceEvent(event: TraceEvent): TraceEvent {
  switch (event.type) {
    case "incident_started":
      return {
        type: event.type,
        incidentFingerprint: redactPlainText(event.incidentFingerprint),
        runId: redactPlainText(event.runId),
        startsAt: redactPlainText(event.startsAt),
        alertname: redactPlainText(event.alertname),
        namespace: redactPlainText(event.namespace),
        pod: redactPlainText(event.pod),
        severity: redactPlainText(event.severity),
      };
    case "provider_request":
      return {
        type: event.type,
        incidentFingerprint: redactPlainText(event.incidentFingerprint),
        runId: redactPlainText(event.runId),
        provider: redactPlainText(event.provider),
        requestId: redactPlainText(event.requestId),
        inputTokens: event.inputTokens,
        messageCount: event.messageCount,
        toolDefinitionCount: event.toolDefinitionCount,
        remainingToolCalls: event.remainingToolCalls,
      };
    case "provider_response":
      return {
        type: event.type,
        incidentFingerprint: redactPlainText(event.incidentFingerprint),
        runId: redactPlainText(event.runId),
        provider: redactPlainText(event.provider),
        requestId: redactPlainText(event.requestId),
        responseId: redactPlainText(event.responseId),
        model: redactPlainText(event.model),
        stopReason: redactPlainText(event.stopReason),
        inputTokens: event.inputTokens,
        cacheCreationInputTokens: event.cacheCreationInputTokens,
        cacheReadInputTokens: event.cacheReadInputTokens,
        outputTokens: event.outputTokens,
        toolCallCount: event.toolCallCount,
      };
    case "tool_call": {
      const base = {
        type: event.type,
        incidentFingerprint: redactPlainText(event.incidentFingerprint),
        runId: redactPlainText(event.runId),
        callId: redactPlainText(event.callId),
        toolName: redactPlainText(event.toolName),
        input: sanitizeUnknown(event.input),
      } as const;
      return event.providerToolCallId === undefined
        ? base
        : {
            ...base,
            providerToolCallId: redactPlainText(event.providerToolCallId),
          };
    }
    case "tool_result": {
      const base = {
        type: event.type,
        incidentFingerprint: redactPlainText(event.incidentFingerprint),
        runId: redactPlainText(event.runId),
        callId: redactPlainText(event.callId),
        toolName: redactPlainText(event.toolName),
        rawBytes: event.rawBytes,
        admittedBytes: event.admittedBytes,
        contentSha256: redactPlainText(event.contentSha256),
        truncated: event.truncated,
        truncationReasons: event.truncationReasons.map(redactPlainText),
        summarized: event.summarized,
      } as const;
      const withProviderId =
        event.providerToolCallId === undefined
          ? base
          : {
              ...base,
              providerToolCallId: redactPlainText(event.providerToolCallId),
            };
      return event.summaryReason === undefined
        ? withProviderId
        : {
            ...withProviderId,
            summaryReason: redactPlainText(event.summaryReason),
          };
    }
    case "run_stopped": {
      const base = {
        type: event.type,
        incidentFingerprint: redactPlainText(event.incidentFingerprint),
        runId: redactPlainText(event.runId),
        reason: event.reason,
        detail: redactText(event.detail),
      } as const;
      const withInputTokens =
        event.inputTokens === undefined
          ? base
          : { ...base, inputTokens: event.inputTokens };
      const withLimit =
        event.limit === undefined
          ? withInputTokens
          : { ...withInputTokens, limit: event.limit };
      const withKind =
        event.providerErrorKind === undefined
          ? withLimit
          : {
              ...withLimit,
              providerErrorKind: redactPlainText(event.providerErrorKind),
            };
      const withStatus =
        event.providerStatus === undefined
          ? withKind
          : { ...withKind, providerStatus: event.providerStatus };
      return event.providerRequestId === undefined
        ? withStatus
        : {
            ...withStatus,
            providerRequestId: redactPlainText(event.providerRequestId),
          };
    }
    case "report_completed":
      return {
        type: event.type,
        incidentFingerprint: redactPlainText(event.incidentFingerprint),
        runId: redactPlainText(event.runId),
        status: event.status,
        toolCallCount: event.toolCallCount,
        citationCount: event.citationCount,
        reportBytes: event.reportBytes,
        report: sanitizeUnknown(event.report),
      };
  }
}

function recordedEvent(event: TraceEvent, clock: TraceClock): RecordedTraceEvent {
  return Object.assign(
    { timestamp: clock().toISOString() },
    sanitizeTraceEvent(event),
  );
}

function traceFilename(incidentFingerprint: string, runId: string): string {
  const digest = createHash("sha256")
    .update(incidentFingerprint)
    .update("\0")
    .update(runId)
    .digest("hex");
  return `incident-${digest}.jsonl`;
}

export class NoopTraceSink implements TraceSink {
  async record(_event: TraceEvent): Promise<void> {}
}

export class InMemoryTraceSink implements TraceSink {
  readonly #events: RecordedTraceEvent[] = [];

  constructor(private readonly clock: TraceClock = defaultClock) {}

  get events(): readonly RecordedTraceEvent[] {
    return this.#events;
  }

  async record(event: TraceEvent): Promise<void> {
    this.#events.push(recordedEvent(event, this.clock));
  }
}

export interface JsonlTraceSinkOptions {
  readonly directory: string;
  readonly clock?: TraceClock;
}

export class JsonlTraceSink implements TraceSink {
  readonly #directory: string;
  readonly #clock: TraceClock;
  #directoryReady: Promise<void> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonlTraceSinkOptions) {
    this.#directory = options.directory;
    this.#clock = options.clock ?? defaultClock;
  }

  record(event: TraceEvent): Promise<void> {
    const prepared = recordedEvent(event, this.#clock);
    const nextWrite = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await this.ensureDirectory();
        const path = join(
          this.#directory,
          traceFilename(event.incidentFingerprint, event.runId),
        );
        await appendFile(path, `${JSON.stringify(prepared)}\n`, {
          encoding: "utf8",
          flag: "a",
          mode: 0o600,
        });
      });
    this.#writeQueue = nextWrite;
    return nextWrite;
  }

  private ensureDirectory(): Promise<void> {
    this.#directoryReady ??= mkdir(this.#directory, {
      recursive: true,
      mode: 0o700,
    }).then(() => undefined);
    return this.#directoryReady;
  }
}
