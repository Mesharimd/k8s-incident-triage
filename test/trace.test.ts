import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryTraceSink,
  JsonlTraceSink,
  NoopTraceSink,
  redactSensitiveText,
  type TraceEvent,
} from "../src/trace";

const FIXED_TIME = new Date("2026-07-26T09:10:11.000Z");
const RUN_ID = "run-20260726-a";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "k8s-triage-trace-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("trace sinks", () => {
  test("redacts complete authorization and cookie header values", () => {
    const value = [
      "Authorization: Basic dXNlcjpwYXNz",
      "proxy-authorization: Negotiate opaquecredential",
      "Cookie: session=abc; csrf=def",
      "Set-Cookie: session=ghi; HttpOnly",
    ].join("\n");
    const redacted = redactSensitiveText(value);

    for (const secret of [
      "dXNlcjpwYXNz",
      "opaquecredential",
      "session=abc",
      "csrf=def",
      "session=ghi",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  test("keeps deterministic, provider-neutral events in memory", async () => {
    const sink = new InMemoryTraceSink(() => FIXED_TIME);
    const events: TraceEvent[] = [
      {
        type: "incident_started",
        incidentFingerprint: "incident-123",
        runId: RUN_ID,
        startsAt: "2026-07-26T09:00:00Z",
        alertname: "KubePodCrashLooping",
        namespace: "checkout",
        pod: "checkout-api-7bd9",
        severity: "critical",
      },
      {
        type: "provider_request",
        incidentFingerprint: "incident-123",
        runId: RUN_ID,
        provider: "test-provider",
        requestId: "request-1",
        inputTokens: 834,
        messageCount: 3,
        toolDefinitionCount: 5,
        remainingToolCalls: 7,
      },
      {
        type: "provider_response",
        incidentFingerprint: "incident-123",
        runId: RUN_ID,
        provider: "test-provider",
        requestId: "request-1",
        responseId: "response-1",
        model: "test-model",
        stopReason: "tool_use",
        inputTokens: 834,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 20,
        outputTokens: 92,
        toolCallCount: 1,
      },
      {
        type: "tool_call",
        incidentFingerprint: "incident-123",
        runId: RUN_ID,
        callId: "call-001",
        providerToolCallId: "toolu_1",
        toolName: "get_pod_logs",
        input: { namespace: "checkout", pod: "checkout-api-7bd9" },
      },
      {
        type: "tool_result",
        incidentFingerprint: "incident-123",
        runId: RUN_ID,
        callId: "call-001",
        providerToolCallId: "toolu_1",
        toolName: "get_pod_logs",
        rawBytes: 20_000,
        admittedBytes: 900,
        contentSha256:
          "8fd13c4e832d039dd0813b0210305b21c1a9bfefe1b2d6db2926116e10c51d3d",
        truncated: true,
        truncationReasons: ["serialized_result_limit"],
        summarized: true,
        summaryReason: "agent_context_limit",
      },
      {
        type: "run_stopped",
        incidentFingerprint: "incident-123",
        runId: RUN_ID,
        reason: "context_budget",
        detail: "next request would exceed the input budget",
        inputTokens: 30_100,
        limit: 30_000,
      },
      {
        type: "report_completed",
        incidentFingerprint: "incident-123",
        runId: RUN_ID,
        status: "insufficient_data",
        toolCallCount: 1,
        citationCount: 1,
        reportBytes: 512,
        report: {
          status: "insufficient_data",
          probableCause: null,
          evidence: [],
          suggestions: [],
          recentChanges: [],
          uncertainties: ["context budget exhausted"],
        },
      },
    ];

    for (const event of events) {
      await sink.record(event);
    }

    expect(sink.events).toHaveLength(events.length);
    expect(sink.events.map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
    expect(sink.events[0]?.timestamp).toBe(FIXED_TIME.toISOString());

    const noop = new NoopTraceSink();
    await expect(noop.record(events[0]!)).resolves.toBeUndefined();
  });

  test("creates one append-only JSONL file per incident using safe filenames", async () => {
    const directory = join(await temporaryDirectory(), "nested", "traces");
    const maliciousFingerprint = "../../outside\nincident";
    const sink = new JsonlTraceSink({
      directory,
      clock: () => FIXED_TIME,
    });

    await sink.record({
      type: "incident_started",
      incidentFingerprint: maliciousFingerprint,
      runId: "run-malicious-a",
      startsAt: "2026-07-26T09:00:00Z",
      alertname: "HighCpu",
      namespace: "payments",
      pod: "api-1",
      severity: "warning",
    });
    await sink.record({
      type: "report_completed",
      incidentFingerprint: maliciousFingerprint,
      runId: "run-malicious-a",
      status: "diagnosed",
      toolCallCount: 2,
      citationCount: 2,
      reportBytes: 741,
      report: {
        status: "diagnosed",
        probableCause: {
          claim: "CPU throttling",
          confidence: "high",
          evidenceCallIds: ["call-001"],
        },
        evidence: [],
        suggestions: [],
        recentChanges: [],
        uncertainties: ["No profile was available"],
      },
    });
    await sink.record({
      type: "incident_started",
      incidentFingerprint: maliciousFingerprint,
      runId: "run-malicious-b",
      startsAt: "2026-07-27T09:00:00Z",
      alertname: "OOMKilled",
      namespace: "worker",
      pod: "worker-1",
      severity: "critical",
    });

    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(files.every((file) => /^incident-[a-f0-9]{64}\.jsonl$/.test(file))).toBe(
      true,
    );

    const contents = await Promise.all(
      files.map(async (file) => ({
        file,
        text: await readFile(join(directory, file), "utf8"),
      })),
    );
    const maliciousTrace = contents.find(({ text }) =>
      text.includes('"type":"report_completed"'),
    );
    expect(maliciousTrace).toBeDefined();

    const lines = maliciousTrace!.text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      "incident_started",
      "report_completed",
    ]);
    expect(lines.every((line) => JSON.parse(line).timestamp === FIXED_TIME.toISOString())).toBe(
      true,
    );
    expect(JSON.parse(lines[1]!).report.probableCause.claim).toBe(
      "CPU throttling",
    );
  });

  test("appends across sink instances instead of overwriting prior events", async () => {
    const directory = await temporaryDirectory();
    const event: TraceEvent = {
      type: "run_stopped",
      incidentFingerprint: "same-incident",
      runId: "same-run",
      reason: "tool_call_limit",
      detail: "the eleventh tool call was refused",
      limit: 10,
    };

    await new JsonlTraceSink({ directory, clock: () => FIXED_TIME }).record(event);
    await new JsonlTraceSink({ directory, clock: () => FIXED_TIME }).record(event);

    const [file] = await readdir(directory);
    expect(file).toBeDefined();
    const lines = (await readFile(join(directory, file!), "utf8"))
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(2);
  });

  test("redacts secrets and strips opaque provider reasoning while preserving evidence", async () => {
    const directory = await temporaryDirectory();
    const sink = new JsonlTraceSink({ directory, clock: () => FIXED_TIME });
    const toolCall = {
      type: "tool_call",
      incidentFingerprint: "redaction-test",
      runId: "redaction-run",
      callId: "call-001",
      providerToolCallId: "toolu_secret",
      toolName: "describe_kubernetes_resource",
      input: {
        namespace: "checkout",
        name: "checkout-api",
        apiKey: "top-secret-api-key",
        nested: {
          authorization: "Bearer bearer-secret-token",
          reasoning: "private chain of thought",
          providerState: { signed: "opaque-signed-state" },
        },
      },
      providerState: { rawAssistantContent: "must-not-be-written" },
      reasoning: "must-not-be-written-either",
    } as TraceEvent & Readonly<Record<string, unknown>>;

    await sink.record(toolCall);
    await sink.record({
      type: "tool_result",
      incidentFingerprint: "redaction-test",
      runId: "redaction-run",
      callId: "call-001",
      providerToolCallId: "toolu_secret",
      toolName: "describe_kubernetes_resource",
      rawBytes: 220,
      admittedBytes: 180,
      contentSha256:
        "b2062662e3f4743df2603fca7d5b8a7f41a823be00c5e9737b2fbc908654bc2e",
      truncated: false,
      truncationReasons: [],
      summarized: false,
    });
    await sink.record({
      type: "report_completed",
      incidentFingerprint: "redaction-test",
      runId: "redaction-run",
      status: "diagnosed",
      toolCallCount: 1,
      citationCount: 1,
      reportBytes: 300,
      report: {
        status: "diagnosed",
        probableCause: {
          claim: "CrashLoopBackOff from useful evidence",
          confidence: "high",
          evidenceCallIds: ["call-001"],
        },
        evidence: [
          {
            callId: "call-001",
            observation:
              "database_url=postgres://admin:hunter2@db/prod aws_secret_access_key=not-redacted",
          },
        ],
        suggestions: [],
        recentChanges: [],
        uncertainties: ["No profile was available"],
      },
    });

    const [file] = await readdir(directory);
    const trace = await readFile(join(directory, file!), "utf8");

    expect(trace).toContain("checkout-api");
    expect(trace).toContain("CrashLoopBackOff");
    expect(trace).toContain("useful evidence");
    expect(trace).not.toContain("top-secret-api-key");
    expect(trace).not.toContain("bearer-secret-token");
    expect(trace).not.toContain("private chain of thought");
    expect(trace).not.toContain("opaque-signed-state");
    expect(trace).not.toContain("must-not-be-written");
    expect(trace).not.toContain("result-secret-token");
    expect(trace).not.toContain("hunter2");
    expect(trace).not.toContain("not-redacted");
    expect(trace).toContain("[REDACTED]");
  });
});
