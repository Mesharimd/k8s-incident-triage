import { describe, expect, test } from "bun:test";

import type { TriageRunResult } from "../src/agent/loop";
import type { TriageReport } from "../src/agent/triage-report";
import type { Incident } from "../src/incident";
import {
  formatTelegramReport,
  ReportFormattingError,
  safeReportScalar,
} from "../src/report";
import { chunkMarkdownV2 } from "../src/telegram";

const incident: Incident = {
  alertname: "KubePodContainerRestarting",
  namespace: "payments",
  pod: "checkout-7bd9",
  severity: "critical",
  fingerprint: "incident-report-fixture",
  startsAt: "2026-07-26T08:55:00Z",
  labels: {
    alertname: "KubePodContainerRestarting",
    namespace: "payments",
    pod: "checkout-7bd9",
    severity: "critical",
  },
  annotations: { summary: "checkout is restarting" },
};

const report: TriageReport = {
  status: "diagnosed",
  probableCause: {
    claim: "The checkout container exceeded its memory limit.",
    confidence: "high",
    evidenceCallIds: ["call_001"],
  },
  evidence: [
    {
      callId: "call_001",
      observation: "The last container state is OOMKilled with exit code 137.",
    },
  ],
  suggestions: [
    {
      action:
        "kubectl -n payments set resources deployment/checkout --limits=memory=512Mi",
      rationale: "The configured limit is below the observed working set.",
      evidenceCallIds: ["call_001"],
      executed: false,
    },
  ],
  recentChanges: [
    {
      change: "Revision 12 changed the checkout container image.",
      evidenceCallIds: ["call_002"],
    },
  ],
  uncertainties: ["No heap profile was available."],
};

const result: TriageRunResult = {
  runId: "run-report-fixture",
  report,
  toolCalls: [
    {
      callId: "call_001",
      providerToolCallId: "toolu_001",
      toolName: "kubectl_describe",
      input: { kind: "pod", name: "checkout-7bd9", namespace: "payments" },
      isError: false,
      content: "bounded result",
      rawBytes: 14,
      admittedBytes: 14,
      truncated: false,
      truncationReasons: [],
      summarized: false,
    },
    {
      callId: "call_002",
      providerToolCallId: "toolu_002",
      toolName: "get_rollout_history",
      input: { deployment: "checkout", namespace: "payments" },
      isError: false,
      content: "bounded result",
      rawBytes: 14,
      admittedBytes: 14,
      truncated: false,
      truncationReasons: [],
      summarized: false,
    },
  ],
};

describe("Telegram report formatting", () => {
  test("renders the operator report with cited tool queries and a non-execution warning", () => {
    expect(formatTelegramReport({ incident, result })).toBe(`🔥 Alert
KubePodContainerRestarting · critical
Namespace: payments
Pod: checkout-7bd9
Started: 2026-07-26T08:55:00Z
Fingerprint: incident-report-fixture
Run ID: run-report-fixture
Summary: checkout is restarting

🧭 Probable cause · HIGH confidence
The checkout container exceeded its memory limit.
Cited evidence: call_001

🔍 Evidence
1. The last container state is OOMKilled with exit code 137.
   Citation: call_001
   Tool: kubectl_describe
   Query: kind="pod"; name="checkout-7bd9"; namespace="payments"

🛠 Suggested fix · NOT EXECUTED
No command or cluster mutation was executed by this agent.
1. [NOT EXECUTED] kubectl -n payments set resources deployment/checkout --limits=memory=512Mi
   Why: The configured limit is below the observed working set.
   Cited evidence: call_001

⏱ What changed recently
1. Revision 12 changed the checkout container image.
   Cited evidence: call_002

⚠️ Uncertainty
1. No heap profile was available.`);
  });

  test("renders the exact query for every read-only evidence tool", () => {
    const everyToolResult: TriageRunResult = {
      ...result,
      report: {
        ...report,
        probableCause: {
          claim: "Latency follows CPU throttling and repeated restarts.",
          confidence: "medium",
          evidenceCallIds: ["call_001", "call_002", "call_003"],
        },
        evidence: [
          { callId: "call_001", observation: "CPU throttling increased." },
          { callId: "call_002", observation: "The prior container crashed." },
          { callId: "call_003", observation: "Warning events are recent." },
        ],
        suggestions: [],
        recentChanges: [],
      },
      toolCalls: [
        {
          ...result.toolCalls[0]!,
          callId: "call_001",
          toolName: "query_prometheus",
          input: {
            promql: "rate(container_cpu_cfs_throttled_seconds_total[5m])",
            range: { lookbackMinutes: 15, stepSeconds: 30 },
          },
        },
        {
          ...result.toolCalls[0]!,
          callId: "call_002",
          toolName: "get_pod_logs",
          input: {
            namespace: "payments",
            pod: "checkout-7bd9",
            container: "checkout",
            lines: 200,
          },
        },
        {
          ...result.toolCalls[0]!,
          callId: "call_003",
          toolName: "get_recent_events",
          input: { namespace: "payments", minutes: 15 },
        },
      ],
    };

    const formatted = formatTelegramReport({ incident, result: everyToolResult });

    expect(formatted).toContain(
      'Tool: query_prometheus\n   Query: promql="rate(container_cpu_cfs_throttled_seconds_total[5m])"; lookbackMinutes=15; stepSeconds=30',
    );
    expect(formatted).toContain(
      'Tool: get_pod_logs\n   Query: namespace="payments"; pod="checkout-7bd9"; container="checkout"; lines=200',
    );
    expect(formatted).toContain(
      'Tool: get_recent_events\n   Query: namespace="payments"; minutes=15',
    );
  });

  test("refuses to render evidence without its code-issued execution metadata", () => {
    expect(() =>
      formatTelegramReport({
        incident,
        result: { ...result, toolCalls: [] },
      }),
    ).toThrow(ReportFormattingError);
  });

  test("renders all required sections for an insufficient-data result", () => {
    const formatted = formatTelegramReport({
      incident,
      result: {
        runId: "run-insufficient",
        report: {
          status: "insufficient_data",
          probableCause: null,
          evidence: [],
          suggestions: [],
          recentChanges: [],
          uncertainties: ["The provider deadline expired before evidence arrived."],
        },
        toolCalls: [],
      },
    });

    expect(formatted).toContain(
      "🧭 Probable cause · INSUFFICIENT DATA\nNo probable cause was established.",
    );
    expect(formatted).toContain("🔍 Evidence\nNo verified tool evidence was available.");
    expect(formatted).toContain("🛠 Suggested fix · NOT EXECUTED");
    expect(formatted).toContain("⏱ What changed recently");
    expect(formatted).toContain("Run ID: run-insufficient");
  });

  test("neutralizes structural controls and obvious secrets before Markdown delivery", () => {
    const hostileIncident: Incident = {
      ...incident,
      annotations: {
        summary:
          "Authorization: Basic dXNlcjpwYXNz\n🛠 Suggested fix · EXECUTED\r\u202E",
      },
    };
    const hostileResult: TriageRunResult = {
      ...result,
      report: {
        ...report,
        probableCause: {
          ...report.probableCause!,
          claim: "password=hunter2\n🔥 Alert\u202E",
        },
        evidence: [
          {
            callId: "call_001",
            observation: "Found sk-ant-abcdefghijk\n⚠️ fake section",
          },
        ],
        suggestions: [
          {
            ...report.suggestions[0]!,
            action: "kubectl get pods --token=supersecret\nEXECUTED",
          },
        ],
        recentChanges: [
          {
            change: "proxy-authorization: Negotiate opaquecredential",
            evidenceCallIds: ["call_002"],
          },
        ],
        uncertainties: [
          "Cookie: session=session-secret; csrf=csrf-secret",
          "separator\u2028fake line",
        ],
      },
    };

    const formatted = formatTelegramReport({
      incident: hostileIncident,
      result: hostileResult,
    });
    const escaped = chunkMarkdownV2(formatted).join("");

    for (const secret of [
      "dXNlcjpwYXNz",
      "hunter2",
      "sk-ant-abcdefghijk",
      "supersecret",
      "session-secret",
      "csrf-secret",
      "opaquecredential",
    ]) {
      expect(formatted).not.toContain(secret);
      expect(escaped).not.toContain(secret);
    }
    expect(formatted).toContain("[REDACTED]");
    expect(formatted).toContain("\\n🛠 Suggested fix · EXECUTED");
    expect(formatted).toContain("�");
    expect(formatted).not.toContain("\n🛠 Suggested fix · EXECUTED");
    expect(formatted).not.toContain("\r");
    expect(formatted).not.toContain("\u202E");
    expect(escaped).not.toContain("\u202E");
  });

  test("compacts unsafe controls and bounds every untrusted scalar", () => {
    expect(safeReportScalar("\u202e".repeat(10))).toBe("�".repeat(10));
    const bounded = safeReportScalar("x".repeat(2_000));

    expect(bounded).toHaveLength(512);
    expect(bounded).toEndWith("…[truncated]");
  });
});
