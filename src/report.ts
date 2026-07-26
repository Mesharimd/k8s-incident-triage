import type { ExecutedToolCall, TriageRunResult } from "./agent/loop";
import type { Incident } from "./incident";
import { redactSensitiveText } from "./trace";

export interface TelegramReportInput {
  readonly incident: Incident;
  readonly result: TriageRunResult;
}

export class ReportFormattingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportFormattingError";
  }
}

export const MAX_REPORT_SCALAR_UTF16 = 512;
const MAX_REPORT_ACTION_UTF16 = 1_024;
const MAX_REPORT_QUERY_SCALAR_UTF16 = 1_024;
const REPORT_TRUNCATION_MARKER = "…[truncated]";
const UNSAFE_FORMAT_REPLACEMENT = "�";

function truncateReportScalar(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  let end = limit - REPORT_TRUNCATION_MARKER.length;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${value.slice(0, end)}${REPORT_TRUNCATION_MARKER}`;
}

/** Render untrusted webhook/model text as one visible, non-reordering line. */
export function safeReportScalar(
  value: string,
  maxUtf16Length = MAX_REPORT_SCALAR_UTF16,
): string {
  if (
    !Number.isSafeInteger(maxUtf16Length) ||
    maxUtf16Length < REPORT_TRUNCATION_MARKER.length
  ) {
    throw new Error("report scalar limit is too small");
  }
  let result = "";
  for (const symbol of redactSensitiveText(value)) {
    const codePoint = symbol.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint === 0x0a) {
      result += "\\n";
      continue;
    }
    if (codePoint === 0x0d) {
      result += "\\r";
      continue;
    }
    if (codePoint === 0x09) {
      result += "\\t";
      continue;
    }
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
    ) {
      // One visible unit neutralizes direction/format controls without letting
      // bounded input expand into an undeliverable Telegram report.
      result += UNSAFE_FORMAT_REPLACEMENT;
      continue;
    }
    result += symbol;
  }
  return truncateReportScalar(result, maxUtf16Length);
}

function inputObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function quotedString(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = input[field];
  return JSON.stringify(
    safeReportScalar(
      typeof value === "string" ? value : "[invalid]",
      MAX_REPORT_QUERY_SCALAR_UTF16,
    ),
  );
}

function finiteNumber(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = input[field];
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "[invalid]";
}

function toolQuery(call: ExecutedToolCall): string {
  const input = inputObject(call.input);
  switch (call.toolName) {
    case "query_prometheus": {
      const range = inputObject(input.range);
      return [
        `promql=${quotedString(input, "promql")}`,
        `lookbackMinutes=${finiteNumber(range, "lookbackMinutes")}`,
        ...(range.stepSeconds === undefined
          ? []
          : [`stepSeconds=${finiteNumber(range, "stepSeconds")}`]),
      ].join("; ");
    }
    case "get_pod_logs":
      return [
        `namespace=${quotedString(input, "namespace")}`,
        `pod=${quotedString(input, "pod")}`,
        `container=${quotedString(input, "container")}`,
        `lines=${finiteNumber(input, "lines")}`,
      ].join("; ");
    case "kubectl_describe":
      return [
        `kind=${quotedString(input, "kind")}`,
        `name=${quotedString(input, "name")}`,
        `namespace=${quotedString(input, "namespace")}`,
      ].join("; ");
    case "get_recent_events":
      return [
        `namespace=${quotedString(input, "namespace")}`,
        `minutes=${finiteNumber(input, "minutes")}`,
      ].join("; ");
    case "get_rollout_history":
      return [
        `deployment=${quotedString(input, "deployment")}`,
        `namespace=${quotedString(input, "namespace")}`,
      ].join("; ");
    default:
      return "unavailable";
  }
}

function callFor(
  calls: ReadonlyMap<string, ExecutedToolCall>,
  callId: string,
): ExecutedToolCall {
  const call = calls.get(callId);
  if (call === undefined) {
    throw new ReportFormattingError(
      `report cites tool call ${callId}, but its execution metadata is missing`,
    );
  }
  return call;
}

function numbered(values: readonly string[]): string {
  return values
    .map((value, index) => `${index + 1}. ${safeReportScalar(value)}`)
    .join("\n");
}

function safeCallIds(values: readonly string[]): string {
  return values.map((value) => safeReportScalar(value)).join(", ");
}

export function formatTelegramReport({
  incident,
  result,
}: TelegramReportInput): string {
  const calls = new Map(result.toolCalls.map((call) => [call.callId, call]));
  const summary = incident.annotations.summary?.trim();
  const alert = [
    "🔥 Alert",
    `${safeReportScalar(incident.alertname)} · ${safeReportScalar(incident.severity)}`,
    `Namespace: ${safeReportScalar(incident.namespace)}`,
    `Pod: ${safeReportScalar(incident.pod)}`,
    `Started: ${safeReportScalar(incident.startsAt)}`,
    `Fingerprint: ${safeReportScalar(incident.fingerprint)}`,
    `Run ID: ${safeReportScalar(result.runId)}`,
    ...(summary === undefined || summary.length === 0
      ? []
      : [`Summary: ${safeReportScalar(summary)}`]),
  ].join("\n");

  const cause = result.report.probableCause;
  const probableCause =
    cause === null
      ? [
          "🧭 Probable cause · INSUFFICIENT DATA",
          "No probable cause was established.",
        ].join("\n")
      : [
          `🧭 Probable cause · ${cause.confidence.toUpperCase()} confidence`,
          safeReportScalar(cause.claim),
          `Cited evidence: ${safeCallIds(cause.evidenceCallIds)}`,
        ].join("\n");

  const evidence = [
    "🔍 Evidence",
    result.report.evidence.length === 0
      ? "No verified tool evidence was available."
      : result.report.evidence
          .map((item, index) => {
            const call = callFor(calls, item.callId);
            return [
              `${index + 1}. ${safeReportScalar(item.observation)}`,
              `   Citation: ${safeReportScalar(item.callId)}`,
              `   Tool: ${safeReportScalar(call.toolName)}`,
              `   Query: ${toolQuery(call)}`,
            ].join("\n");
          })
          .join("\n"),
  ].join("\n");

  const suggestedFix = [
    "🛠 Suggested fix · NOT EXECUTED",
    "No command or cluster mutation was executed by this agent.",
    result.report.suggestions.length === 0
      ? "No operator action was suggested."
      : result.report.suggestions
          .map((suggestion, index) =>
            [
              `${index + 1}. [NOT EXECUTED] ${safeReportScalar(
                suggestion.action,
                MAX_REPORT_ACTION_UTF16,
              )}`,
              `   Why: ${safeReportScalar(suggestion.rationale)}`,
              `   Cited evidence: ${safeCallIds(suggestion.evidenceCallIds)}`,
            ].join("\n"),
          )
          .join("\n"),
  ].join("\n");

  const recentChanges = [
    "⏱ What changed recently",
    result.report.recentChanges.length === 0
      ? "No recent change was established from cited evidence."
      : result.report.recentChanges
          .map((change, index) =>
            [
              `${index + 1}. ${safeReportScalar(change.change)}`,
              `   Cited evidence: ${safeCallIds(change.evidenceCallIds)}`,
            ].join("\n"),
          )
          .join("\n"),
  ].join("\n");

  const uncertainties = [
    "⚠️ Uncertainty",
    numbered(result.report.uncertainties),
  ].join("\n");

  return [
    alert,
    probableCause,
    evidence,
    suggestedFix,
    recentChanges,
    uncertainties,
  ].join("\n\n");
}
