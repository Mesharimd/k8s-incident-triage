import type { ToolDefinition } from "./definition";
import {
  isKubernetesDnsLabel,
  KUBERNETES_DNS_LABEL_MAX_LENGTH,
  KUBERNETES_DNS_LABEL_PATTERN,
} from "./kubernetes-names";
import {
  createBoundedJsonResult,
  ToolExecutionError,
  ToolInputError,
  utf8ByteLength,
} from "./result";
import type { BoundedToolResult } from "./result";

const MAX_LOOKBACK_MINUTES = 1_440;
const MAX_EVENTS_SCANNED = 500;
const MAX_EVENTS_RETURNED = 50;
const MAX_EVENT_NOTE_BYTES = 2_048;
const MAX_EVENT_NAME_BYTES = 253;
const MAX_OBJECT_NAME_BYTES = 253;
const MAX_KIND_BYTES = 128;
const MAX_REASON_BYTES = 256;
const MAX_TYPE_BYTES = 32;
const MAX_REPORTING_COMPONENT_BYTES = 256;

export interface ListNamespacedEventsRequest {
  readonly namespace: string;
  readonly limit: number;
}

export interface KubernetesEventsApi {
  listNamespacedEvents(request: ListNamespacedEventsRequest): Promise<unknown>;
}

export interface GetRecentEventsInput {
  readonly namespace: string;
  readonly minutes: number;
}

export interface GetRecentEventsDependencies {
  readonly api: KubernetesEventsApi;
  readonly now?: () => Date;
}

export const getRecentEventsDefinition: ToolDefinition = {
  name: "get_recent_events",
  description:
    "List recent Kubernetes events in one namespace, newest first, with strict scan and output limits.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["namespace", "minutes"],
    properties: {
      namespace: {
        type: "string",
        minLength: 1,
        maxLength: KUBERNETES_DNS_LABEL_MAX_LENGTH,
        pattern: KUBERNETES_DNS_LABEL_PATTERN,
      },
      minutes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LOOKBACK_MINUTES,
      },
    },
  },
};

interface ParsedEvent {
  readonly timestampMs: number;
  readonly timestamp: string;
  readonly type: string | null;
  readonly reason: string | null;
  readonly regarding: {
    readonly kind: string;
    readonly name: string;
  };
  readonly count: number;
  readonly note: string | null;
  readonly reportingComponent: string | null;
  readonly noteTruncated: boolean;
}

interface ParsedEventList {
  readonly items: readonly unknown[];
  readonly sourcePaginated: boolean;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolExecutionError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  maxBytes: number,
): string {
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8ByteLength(value) > maxBytes
  ) {
    throw new ToolExecutionError(
      `${field} must be a non-empty string of at most ${maxBytes} bytes`,
    );
  }
  return value;
}

function optionalString(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  maxBytes: number,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || utf8ByteLength(value) > maxBytes) {
    throw new ToolExecutionError(
      `${field} must be a string of at most ${maxBytes} bytes`,
    );
  }
  return value;
}

function optionalNonNegativeInteger(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ToolExecutionError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function optionalTimestamp(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): { readonly milliseconds: number; readonly iso: string } | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolExecutionError(`${field} must be an RFC 3339 timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ToolExecutionError(`${field} must be an RFC 3339 timestamp`);
  }
  return { milliseconds, iso: new Date(milliseconds).toISOString() };
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        value: decoder.decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { value: "", truncated: true };
}

function parseEventList(value: unknown): ParsedEventList {
  const list = asObject(value, "Kubernetes EventList response");
  if (list.apiVersion !== "v1" || list.kind !== "EventList") {
    throw new ToolExecutionError(
      "Kubernetes events response must be a Core/v1 EventList",
    );
  }
  const metadata = asObject(list.metadata, "Kubernetes EventList.metadata");
  const continuation = optionalString(
    metadata,
    "continue",
    "Kubernetes EventList.metadata.continue",
    4_096,
  );
  const remainingItemCount = optionalNonNegativeInteger(
    metadata,
    "remainingItemCount",
    "Kubernetes EventList.metadata.remainingItemCount",
  );
  if (!Array.isArray(list.items)) {
    throw new ToolExecutionError("Kubernetes EventList.items must be an array");
  }

  return {
    items: list.items,
    sourcePaginated:
      (continuation !== undefined && continuation.length > 0) ||
      (remainingItemCount !== undefined && remainingItemCount > 0),
  };
}

function parseEvent(value: unknown, index: number): ParsedEvent {
  const field = `Kubernetes EventList.items[${index}]`;
  const event = asObject(value, field);
  if (event.apiVersion !== "v1" || event.kind !== "Event") {
    throw new ToolExecutionError(`${field} must be a Core/v1 Event`);
  }

  const metadata = asObject(event.metadata, `${field}.metadata`);
  requiredString(metadata, "name", `${field}.metadata.name`, MAX_EVENT_NAME_BYTES);
  const involvedObject = asObject(event.involvedObject, `${field}.involvedObject`);
  const kind = requiredString(
    involvedObject,
    "kind",
    `${field}.involvedObject.kind`,
    MAX_KIND_BYTES,
  );
  const name = requiredString(
    involvedObject,
    "name",
    `${field}.involvedObject.name`,
    MAX_OBJECT_NAME_BYTES,
  );

  let series: Record<string, unknown> | undefined;
  if (event.series !== undefined) {
    series = asObject(event.series, `${field}.series`);
  }
  const observed =
    (series === undefined
      ? undefined
      : optionalTimestamp(
          series,
          "lastObservedTime",
          `${field}.series.lastObservedTime`,
        )) ??
    optionalTimestamp(event, "lastTimestamp", `${field}.lastTimestamp`) ??
    optionalTimestamp(event, "eventTime", `${field}.eventTime`) ??
    optionalTimestamp(
      metadata,
      "creationTimestamp",
      `${field}.metadata.creationTimestamp`,
    );
  if (observed === undefined) {
    throw new ToolExecutionError(`${field} has no observable timestamp`);
  }

  const noteValue =
    optionalString(event, "note", `${field}.note`, Number.MAX_SAFE_INTEGER) ??
    optionalString(event, "message", `${field}.message`, Number.MAX_SAFE_INTEGER);
  const boundedNote =
    noteValue === undefined
      ? { value: null, truncated: false }
      : truncateUtf8(noteValue, MAX_EVENT_NOTE_BYTES);

  let source: Record<string, unknown> | undefined;
  if (event.source !== undefined) {
    source = asObject(event.source, `${field}.source`);
  }
  const reportingComponent =
    optionalString(
      event,
      "reportingComponent",
      `${field}.reportingComponent`,
      MAX_REPORTING_COMPONENT_BYTES,
    ) ??
    optionalString(
      event,
      "reportingController",
      `${field}.reportingController`,
      MAX_REPORTING_COMPONENT_BYTES,
    ) ??
    (source === undefined
      ? undefined
      : optionalString(
          source,
          "component",
          `${field}.source.component`,
          MAX_REPORTING_COMPONENT_BYTES,
        ));
  const seriesCount =
    series === undefined
      ? undefined
      : optionalNonNegativeInteger(series, "count", `${field}.series.count`);
  const count =
    seriesCount ??
    optionalNonNegativeInteger(event, "count", `${field}.count`) ??
    1;

  return {
    timestampMs: observed.milliseconds,
    timestamp: observed.iso,
    type:
      optionalString(event, "type", `${field}.type`, MAX_TYPE_BYTES) ?? null,
    reason:
      optionalString(event, "reason", `${field}.reason`, MAX_REASON_BYTES) ??
      null,
    regarding: { kind, name },
    count,
    note: boundedNote.value,
    reportingComponent: reportingComponent ?? null,
    noteTruncated: boundedNote.truncated,
  };
}

function validateInput(input: GetRecentEventsInput): void {
  if (
    !isKubernetesDnsLabel(input.namespace)
  ) {
    throw new ToolInputError("namespace must be a valid Kubernetes namespace name");
  }
  if (
    !Number.isInteger(input.minutes) ||
    input.minutes < 1 ||
    input.minutes > MAX_LOOKBACK_MINUTES
  ) {
    throw new ToolInputError(
      `minutes must be an integer from 1 to ${MAX_LOOKBACK_MINUTES}`,
    );
  }
}

export async function getRecentEvents(
  input: GetRecentEventsInput,
  dependencies: GetRecentEventsDependencies,
): Promise<BoundedToolResult> {
  validateInput(input);
  const end = (dependencies.now ?? (() => new Date()))();
  const endMs = end.getTime();
  if (!Number.isFinite(endMs)) {
    throw new ToolExecutionError("injected clock returned an invalid date");
  }
  const start = new Date(endMs - input.minutes * 60_000);
  const window = {
    start: start.toISOString(),
    end: end.toISOString(),
    minutes: input.minutes,
  };

  const response = await dependencies.api.listNamespacedEvents({
    namespace: input.namespace,
    limit: MAX_EVENTS_SCANNED,
  });
  const list = parseEventList(response);
  const scanLimited = list.items.length > MAX_EVENTS_SCANNED;
  const parsed = list.items
    .slice(0, MAX_EVENTS_SCANNED)
    .map((event, index) => parseEvent(event, index));
  const recent = parsed
    .filter((event) => event.timestampMs >= start.getTime())
    .sort((left, right) => right.timestampMs - left.timestampMs);
  const returned = recent.slice(0, MAX_EVENTS_RETURNED);
  const eventLimited = recent.length > MAX_EVENTS_RETURNED;
  const noteLimited = returned.some((event) => event.noteTruncated);
  const truncationReasons: string[] = [];
  if (list.sourcePaginated) {
    truncationReasons.push("source_pagination");
  }
  if (scanLimited) {
    truncationReasons.push("scan_limit");
  }
  if (eventLimited) {
    truncationReasons.push("event_limit");
  }
  if (noteLimited) {
    truncationReasons.push("event_note_limit");
  }
  const incomplete = truncationReasons.length > 0;
  const events = returned.map(({ timestampMs: _timestampMs, noteTruncated: _noteTruncated, ...event }) => event);
  const output = {
    namespace: input.namespace,
    window,
    events,
    scannedEvents: parsed.length,
    matchingEvents: recent.length,
    omittedMatchingEvents: Math.max(0, recent.length - MAX_EVENTS_RETURNED),
    incomplete,
  };

  return createBoundedJsonResult(output, {
    truncated: incomplete,
    truncationReasons,
    fallback: {
      namespace: input.namespace,
      window,
      events: [],
      scannedEvents: parsed.length,
      matchingEvents: recent.length,
      omittedMatchingEvents: recent.length,
      incomplete: true,
      note: "Event details exceeded the serialized result limit.",
    },
  });
}
