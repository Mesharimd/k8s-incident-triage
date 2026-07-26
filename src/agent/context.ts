import { createHash } from "node:crypto";

import type { BoundedToolResult } from "../tools/result";
import { MAX_TOOL_RESULT_BYTES, utf8ByteLength } from "../tools/result";

export const AGENT_TOOL_CONTEXT_BYTES = MAX_TOOL_RESULT_BYTES;

export interface PreparedToolResult {
  readonly content: string;
  readonly rawBytes: number;
  readonly admittedBytes: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly summarized: boolean;
  readonly summaryReason?: "agent_tool_result_limit" | "agent_context_pressure";
}

function safeHead(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (utf8ByteLength(candidate) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let end = low;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (end > 0 && finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

function safeTail(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(middle);
    if (utf8ByteLength(candidate) <= maxBytes) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  let start = low;
  const firstCodeUnit = value.charCodeAt(start);
  if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) {
    start += 1;
  }
  return value.slice(start);
}

function deterministicSummary(
  content: string,
  maxBytes: number,
  reason: "agent_tool_result_limit" | "agent_context_pressure",
): string {
  const originalBytes = utf8ByteLength(content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const build = (previewBytes: number): string =>
    JSON.stringify({
      summary: "Deterministic head/tail preview; omitted content was not sent to the model.",
      reason,
      originalBytes,
      sha256,
      head: safeHead(content, previewBytes),
      tail: safeTail(content, previewBytes),
    });

  const minimum = build(0);
  if (utf8ByteLength(minimum) > maxBytes) {
    throw new Error("tool context byte limit is too small for summary metadata");
  }

  let low = 0;
  let high = Math.floor(maxBytes / 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(build(middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return build(low);
}

function resultHeader(
  callId: string,
  toolName: string,
  truncated: boolean,
): string {
  return [
    `Evidence call ID: ${callId}`,
    `Tool: ${toolName}`,
    `Tool-layer truncated: ${truncated ? "yes" : "no"}`,
    "Result:",
    "",
  ].join("\n");
}

export function prepareToolResultForContext(
  callId: string,
  toolName: string,
  result: BoundedToolResult,
  options: {
    readonly maxBytes?: number;
    readonly summaryReason?: "agent_tool_result_limit" | "agent_context_pressure";
  } = {},
): PreparedToolResult {
  const maxBytes = options.maxBytes ?? AGENT_TOOL_CONTEXT_BYTES;
  const header = resultHeader(callId, toolName, result.truncated);
  const headerBytes = utf8ByteLength(header);
  if (maxBytes <= headerBytes) {
    throw new Error("tool context byte limit is too small for evidence metadata");
  }

  const rawBytes = utf8ByteLength(result.content);
  const resultBudget = maxBytes - headerBytes;
  const mustSummarize = rawBytes > resultBudget;
  const summaryReason = mustSummarize
    ? (options.summaryReason ?? "agent_tool_result_limit")
    : undefined;
  const admittedResult = mustSummarize
    ? deterministicSummary(result.content, resultBudget, summaryReason ?? "agent_tool_result_limit")
    : result.content;
  const content = `${header}${admittedResult}`;
  const admittedBytes = utf8ByteLength(content);

  if (admittedBytes > maxBytes) {
    throw new Error("prepared tool result exceeded its byte limit");
  }

  return {
    content,
    rawBytes,
    admittedBytes,
    truncated: result.truncated,
    truncationReasons: result.truncationReasons,
    summarized: mustSummarize,
    ...(summaryReason === undefined ? {} : { summaryReason }),
  };
}
