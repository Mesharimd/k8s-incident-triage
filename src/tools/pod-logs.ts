import type { ToolDefinition } from "./definition";
import {
  isKubernetesDnsLabel,
  isKubernetesDnsSubdomain,
  KUBERNETES_DNS_LABEL_MAX_LENGTH,
  KUBERNETES_DNS_LABEL_PATTERN,
  KUBERNETES_DNS_SUBDOMAIN_MAX_LENGTH,
  KUBERNETES_DNS_SUBDOMAIN_PATTERN,
} from "./kubernetes-names";
import {
  createBoundedJsonResult,
  type BoundedToolResult,
  ToolInputError,
  utf8ByteLength,
} from "./result";

export const MAX_POD_LOG_LINES = 200;
export const MAX_POD_LOG_RESULT_BYTES = 12_000;

export const getPodLogsDefinition: ToolDefinition = {
  name: "get_pod_logs",
  description:
    "Read a bounded tail of logs from one Kubernetes pod container without mutating the cluster.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["namespace", "pod", "container", "lines"],
    properties: {
      namespace: {
        type: "string",
        minLength: 1,
        maxLength: KUBERNETES_DNS_LABEL_MAX_LENGTH,
        pattern: KUBERNETES_DNS_LABEL_PATTERN,
      },
      pod: {
        type: "string",
        minLength: 1,
        maxLength: KUBERNETES_DNS_SUBDOMAIN_MAX_LENGTH,
        pattern: KUBERNETES_DNS_SUBDOMAIN_PATTERN,
      },
      container: {
        type: "string",
        minLength: 1,
        maxLength: KUBERNETES_DNS_LABEL_MAX_LENGTH,
        pattern: KUBERNETES_DNS_LABEL_PATTERN,
      },
      lines: {
        type: "integer",
        minimum: 1,
        maximum: MAX_POD_LOG_LINES,
      },
    },
  },
};

export interface GetPodLogsInput {
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  readonly lines: number;
}

export interface PodLogsRequest {
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  readonly tailLines: number;
}

export interface PodLogsApi {
  getPodLogs(request: PodLogsRequest): Promise<string>;
}

export interface GetPodLogsDependencies {
  readonly api: PodLogsApi;
}

interface PodLogsPayload {
  readonly target: {
    readonly namespace: string;
    readonly pod: string;
    readonly container: string;
  };
  readonly requestedLines: number;
  readonly effectiveLines: number;
  readonly returnedLines: number;
  readonly logs: string;
  readonly truncation: {
    readonly truncated: boolean;
    readonly reasons: readonly string[];
    readonly originalLines: number;
    readonly omittedLines: number;
    readonly leadingLinePartial: boolean;
  };
}

function logLines(value: string): readonly string[] {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized.length === 0) {
    return [];
  }

  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function validateDnsLabel(value: unknown, field: string): asserts value is string {
  if (!isKubernetesDnsLabel(value)) {
    throw new ToolInputError(`${field} must be a valid Kubernetes DNS label`);
  }
}

function validatePodName(value: unknown): asserts value is string {
  if (!isKubernetesDnsSubdomain(value)) {
    throw new ToolInputError("pod must be a valid Kubernetes DNS subdomain");
  }
}

function validateInput(input: GetPodLogsInput): void {
  validateDnsLabel(input.namespace, "namespace");
  validatePodName(input.pod);
  validateDnsLabel(input.container, "container");
  if (!Number.isSafeInteger(input.lines)) {
    throw new ToolInputError("lines must be a safe integer");
  }
}

function createPayload(
  input: GetPodLogsInput,
  effectiveLines: number,
  originalLines: number,
  logs: string,
  truncationReasons: readonly string[],
  leadingLinePartial: boolean,
): PodLogsPayload {
  const returnedLines = logLines(logs).length;
  return {
    target: {
      namespace: input.namespace,
      pod: input.pod,
      container: input.container,
    },
    requestedLines: input.lines,
    effectiveLines,
    returnedLines,
    logs,
    truncation: {
      truncated: truncationReasons.length > 0,
      reasons: truncationReasons,
      originalLines,
      omittedLines: Math.max(0, originalLines - returnedLines),
      leadingLinePartial,
    },
  };
}

function byteBoundedPayload(
  input: GetPodLogsInput,
  effectiveLines: number,
  originalLineCount: number,
  lineBoundedLogs: string,
  baseReasons: readonly string[],
): PodLogsPayload {
  const unbounded = createPayload(
    input,
    effectiveLines,
    originalLineCount,
    lineBoundedLogs,
    baseReasons,
    false,
  );
  if (utf8ByteLength(JSON.stringify(unbounded)) <= MAX_POD_LOG_RESULT_BYTES) {
    return unbounded;
  }

  const reasons = [...baseReasons, "byte_limit"];
  const characters = Array.from(lineBoundedLogs);
  let lower = 0;
  let upper = characters.length;

  while (lower < upper) {
    const start = Math.floor((lower + upper) / 2);
    const candidate = characters.slice(start).join("");
    const leadingLinePartial = start > 0 && characters[start - 1] !== "\n";
    const payload = createPayload(
      input,
      effectiveLines,
      originalLineCount,
      candidate,
      reasons,
      leadingLinePartial,
    );

    if (utf8ByteLength(JSON.stringify(payload)) <= MAX_POD_LOG_RESULT_BYTES) {
      upper = start;
    } else {
      lower = start + 1;
    }
  }

  let start = lower;
  while (characters[start] === "\n") {
    start += 1;
  }
  const logs = characters.slice(start).join("");
  return createPayload(
    input,
    effectiveLines,
    originalLineCount,
    logs,
    reasons,
    start > 0 && characters[start - 1] !== "\n",
  );
}

export async function getPodLogs(
  input: GetPodLogsInput,
  dependencies: GetPodLogsDependencies,
): Promise<BoundedToolResult> {
  validateInput(input);
  const effectiveLines = Math.min(
    MAX_POD_LOG_LINES,
    Math.max(1, input.lines),
  );
  const response = await dependencies.api.getPodLogs({
    namespace: input.namespace,
    pod: input.pod,
    container: input.container,
    tailLines: effectiveLines,
  });
  const originalLines = logLines(response);
  const lines = originalLines.slice(-effectiveLines);
  const truncationReasons: string[] = [];
  if (input.lines < 1) {
    truncationReasons.push("requested_line_floor");
  } else if (input.lines > MAX_POD_LOG_LINES) {
    truncationReasons.push("requested_line_limit");
  }
  if (originalLines.length > effectiveLines) {
    truncationReasons.push("response_line_limit");
  }
  const payload = byteBoundedPayload(
    input,
    effectiveLines,
    originalLines.length,
    lines.join("\n"),
    truncationReasons,
  );

  return createBoundedJsonResult(
    payload,
    {
      fallback: { logs: "" },
      maxBytes: MAX_POD_LOG_RESULT_BYTES,
      truncated: payload.truncation.truncated,
      truncationReasons: payload.truncation.reasons,
    },
  );
}
