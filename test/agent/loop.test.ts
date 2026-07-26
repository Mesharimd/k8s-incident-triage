import { describe, expect, test } from "bun:test";

import type { Incident } from "../../src/incident";
import {
  runTriageAgent,
  type TriageRunResult,
} from "../../src/agent/loop";
import type {
  AgentRuntimeConfig,
  AssistantContentBlock,
  AssistantTurn,
  CompletionProvider,
  ProviderMessage,
  ProviderRequestOptions,
  ProviderStopReason,
  ToolResultContentBlock,
} from "../../src/agent/provider";
import {
  createReadOnlyToolRegistry,
  readOnlyToolDefinitions,
  type ReadOnlyToolRegistry,
} from "../../src/tools";
import type { ToolDefinition } from "../../src/tools/definition";
import { utf8ByteLength } from "../../src/tools/result";
import { InMemoryTraceSink } from "../../src/trace";

const incident: Incident = {
  alertname: "KubePodContainerRestarting",
  namespace: "payments",
  pod: "checkout-7bd9",
  severity: "critical",
  fingerprint: "fixture-incident",
  startsAt: "2026-07-26T08:55:00Z",
  labels: {
    alertname: "KubePodContainerRestarting",
    namespace: "payments",
    pod: "checkout-7bd9",
    severity: "critical",
  },
  annotations: { summary: "checkout is restarting" },
};

const config: AgentRuntimeConfig = {
  maxToolCalls: 10,
  contextWindowTokens: 32_000,
  maxOutputTokens: 4_096,
  contextSafetyTokens: 1_024,
};

interface CapturedRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ToolDefinition[];
}

type ScriptedTurn =
  | AssistantTurn
  | ((messages: readonly ProviderMessage[]) => AssistantTurn);

class ScriptedProvider implements CompletionProvider {
  readonly name = "scripted";
  readonly requests: CapturedRequest[] = [];
  readonly countRequests: CapturedRequest[] = [];
  #index = 0;

  constructor(
    private readonly turns: readonly ScriptedTurn[],
    private readonly counter: (
      messages: readonly ProviderMessage[],
      tools: readonly ToolDefinition[],
    ) => number = () => 100,
  ) {}

  async complete(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<AssistantTurn> {
    this.requests.push({ messages, tools });
    const turn = this.turns[this.#index];
    this.#index += 1;
    if (turn === undefined) {
      throw new Error("scripted provider exhausted");
    }
    return typeof turn === "function" ? turn(messages) : turn;
  }

  async countInputTokens(
    messages: readonly ProviderMessage[],
    tools: readonly ToolDefinition[],
  ): Promise<number> {
    this.countRequests.push({ messages, tools });
    return this.counter(messages, tools);
  }
}

function assistantTurn(
  index: number,
  content: readonly AssistantContentBlock[],
  stopReason: ProviderStopReason,
): AssistantTurn {
  return {
    role: "assistant",
    id: `response_${index}`,
    model: "fixture-model",
    content,
    stopReason,
    usage: {
      inputTokens: 100 + index,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 20,
    },
  };
}

function finalReport(
  claim: string,
  observation: string,
  action: string,
  confidence: "low" | "medium" | "high" = "high",
): string {
  return JSON.stringify({
    status: "diagnosed",
    probableCause: {
      claim,
      confidence,
      evidenceCallIds: ["call_001"],
    },
    evidence: [{ callId: "call_001", observation }],
    suggestions: [
      {
        action,
        rationale: observation,
        evidenceCallIds: ["call_001"],
        executed: false,
      },
    ],
    recentChanges: [],
    uncertainties: ["No application profile was available."],
  });
}

function finalReportWithEvidence(
  claim: string,
  evidence: readonly {
    readonly callId: string;
    readonly observation: string;
  }[],
  action: string,
): string {
  const evidenceCallIds = evidence.map(({ callId }) => callId);
  return JSON.stringify({
    status: "diagnosed",
    probableCause: {
      claim,
      confidence: "high",
      evidenceCallIds,
    },
    evidence,
    suggestions: [
      {
        action,
        rationale: "The cited read-only evidence supports this operator suggestion.",
        evidenceCallIds,
        executed: false,
      },
    ],
    recentChanges: [],
    uncertainties: ["No application profile was available."],
  });
}

function registryReturning(content: string): ReadOnlyToolRegistry {
  return {
    definitions: readOnlyToolDefinitions,
    run: async () => ({
      content,
      bytes: utf8ByteLength(content),
      truncated: false,
      truncationReasons: [],
    }),
  };
}

function firstToolResult(
  messages: readonly ProviderMessage[],
): ToolResultContentBlock | undefined {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        return block;
      }
    }
  }
  return undefined;
}

function allToolResults(
  messages: readonly ProviderMessage[],
): readonly ToolResultContentBlock[] {
  return messages.flatMap((message) =>
    message.role === "user"
      ? message.content.filter(
          (block): block is ToolResultContentBlock => block.type === "tool_result",
        )
      : [],
  );
}

async function unavailableFixtureApi(): Promise<never> {
  throw new Error("scenario attempted an unexpected external read");
}

interface CrashFixture {
  readonly deployment: unknown;
  readonly replicaSets: unknown;
  readonly pod: unknown;
  readonly logs: string;
}

interface CpuFixture {
  readonly throttling: unknown;
  readonly latency: unknown;
}

const oomPodFixture: unknown = await Bun.file(
  new URL("../fixtures/agent-oom-result.json", import.meta.url),
).json();
const crashFixture = (await Bun.file(
  new URL("../fixtures/agent-crash-result.json", import.meta.url),
).json()) as CrashFixture;
const cpuFixture = (await Bun.file(
  new URL("../fixtures/agent-cpu-result.json", import.meta.url),
).json()) as CpuFixture;

function oomFixtureRegistry(): ReadOnlyToolRegistry {
  return createReadOnlyToolRegistry({
    prometheus: { queryRange: unavailableFixtureApi },
    kubernetes: {
      getPodLogs: unavailableFixtureApi,
      getResource: async () => oomPodFixture,
      listNamespacedEvents: unavailableFixtureApi,
      readNamespacedDeployment: unavailableFixtureApi,
      listNamespacedReplicaSets: unavailableFixtureApi,
    },
  });
}

function crashFixtureRegistry(): ReadOnlyToolRegistry {
  return createReadOnlyToolRegistry({
    prometheus: { queryRange: unavailableFixtureApi },
    kubernetes: {
      getPodLogs: async () => crashFixture.logs,
      getResource: async () => crashFixture.pod,
      listNamespacedEvents: unavailableFixtureApi,
      readNamespacedDeployment: async () => crashFixture.deployment,
      listNamespacedReplicaSets: async () => crashFixture.replicaSets,
    },
  });
}

function cpuFixtureRegistry(): ReadOnlyToolRegistry {
  const responses = [cpuFixture.throttling, cpuFixture.latency];
  let responseIndex = 0;
  return createReadOnlyToolRegistry({
    prometheus: {
      queryRange: async () => {
        const response = responses[responseIndex];
        responseIndex += 1;
        if (response === undefined) {
          throw new Error("CPU scenario exhausted its Prometheus fixtures");
        }
        return response;
      },
    },
    kubernetes: {
      getPodLogs: unavailableFixtureApi,
      getResource: unavailableFixtureApi,
      listNamespacedEvents: unavailableFixtureApi,
      readNamespacedDeployment: unavailableFixtureApi,
      listNamespacedReplicaSets: unavailableFixtureApi,
    },
    now: () => new Date("2026-07-26T09:00:00Z"),
  });
}

interface DiagnosisScenario {
  readonly label: string;
  readonly incident: Incident;
  readonly registry: () => ReadOnlyToolRegistry;
  readonly steps: readonly {
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly evidenceFragments: readonly string[];
    readonly observation: string;
  }[];
  readonly claim: string;
  readonly suggestion: string;
}

const diagnosisScenarios: readonly DiagnosisScenario[] = [
  {
    label: "OOMKilled",
    incident: {
      ...incident,
      pod: "checkout-api-5b48f95f67-9mh8k",
      labels: {
        ...incident.labels,
        pod: "checkout-api-5b48f95f67-9mh8k",
      },
    },
    registry: oomFixtureRegistry,
    steps: [
      {
        toolName: "kubectl_describe",
        toolInput: {
          kind: "pod",
          name: "checkout-api-5b48f95f67-9mh8k",
          namespace: "payments",
        },
        evidenceFragments: [
          "Previous state: terminated (OOMKilled)",
          "Exit code: 137",
        ],
        observation: "The previous container state reports OOMKilled with exit code 137.",
      },
    ],
    claim: "The checkout container was terminated by the kernel OOM killer.",
    suggestion: "Review the memory limit and recent memory growth.",
  },
  {
    label: "CrashLoopBackOff from a bad image",
    incident,
    registry: crashFixtureRegistry,
    steps: [
      {
        toolName: "get_rollout_history",
        toolInput: { deployment: "checkout", namespace: "payments" },
        evidenceFragments: [
          '"currentRevision":18',
          '"images":["registry.example/checkout:v2-broken"]',
        ],
        observation: "Revision 18 introduced the v2-broken image and has no ready replicas.",
      },
      {
        toolName: "kubectl_describe",
        toolInput: { kind: "pod", name: "checkout-7bd9", namespace: "payments" },
        evidenceFragments: [
          "State: waiting (CrashLoopBackOff)",
          "Exit code: 127",
        ],
        observation: "The checkout pod is in CrashLoopBackOff after exiting with code 127.",
      },
      {
        toolName: "get_pod_logs",
        toolInput: {
          namespace: "payments",
          pod: "checkout-7bd9",
          container: "checkout",
          lines: 50,
        },
        evidenceFragments: ["exec /app/server: not found"],
        observation: "The bounded log tail says the new image cannot find /app/server.",
      },
    ],
    claim: "The latest checkout image is broken and is causing CrashLoopBackOff.",
    suggestion: "Have an operator roll back to the last known-good image.",
  },
  {
    label: "latency from CPU starvation",
    incident: {
      ...incident,
      alertname: "HighApiLatency",
      pod: "api-6cd8",
      labels: {
        ...incident.labels,
        alertname: "HighApiLatency",
        pod: "api-6cd8",
      },
      annotations: { summary: "API p99 latency is above two seconds" },
    },
    registry: cpuFixtureRegistry,
    steps: [
      {
        toolName: "query_prometheus",
        toolInput: {
          promql: 'container_cpu_cfs_throttled_ratio{pod="api-6cd8"}',
          range: { lookbackMinutes: 30, stepSeconds: 30 },
        },
        evidenceFragments: [
          '"__name__":"container_cpu_cfs_throttled_ratio"',
          '"0.91"',
        ],
        observation: "CPU throttling on api-6cd8 reached 91 percent.",
      },
      {
        toolName: "query_prometheus",
        toolInput: {
          promql: 'http_request_duration_p99_seconds{pod="api-6cd8"}',
          range: { lookbackMinutes: 30, stepSeconds: 30 },
        },
        evidenceFragments: [
          '"__name__":"http_request_duration_p99_seconds"',
          '"2.8"',
        ],
        observation: "API p99 latency on the same pod rose to 2.8 seconds.",
      },
    ],
    claim: "CPU throttling is the probable cause of elevated API latency.",
    suggestion: "Review the CPU limit and capacity before changing it.",
  },
];

function scenarioTurns(scenario: DiagnosisScenario): readonly ScriptedTurn[] {
  const firstStep = scenario.steps[0];
  if (firstStep === undefined) {
    throw new Error(`${scenario.label} must define at least one evidence step`);
  }
  const turns: ScriptedTurn[] = [
    assistantTurn(
      1,
      [
        {
          type: "tool_call",
          id: "provider_tool_1",
          name: firstStep.toolName,
          input: firstStep.toolInput,
        },
      ],
      "tool_use",
    ),
  ];

  scenario.steps.forEach((step, index) => {
    turns.push((messages) => {
      const results = allToolResults(messages);
      expect(results).toHaveLength(index + 1);
      const result = results[index];
      expect(result?.toolCallId).toBe(`provider_tool_${index + 1}`);
      expect(result?.content).toContain(
        `Evidence call ID: call_${(index + 1).toString().padStart(3, "0")}`,
      );
      for (const fragment of step.evidenceFragments) {
        expect(result?.content).toContain(fragment);
      }

      const nextStep = scenario.steps[index + 1];
      if (nextStep !== undefined) {
        return assistantTurn(
          index + 2,
          [
            {
              type: "tool_call",
              id: `provider_tool_${index + 2}`,
              name: nextStep.toolName,
              input: nextStep.toolInput,
            },
          ],
          "tool_use",
        );
      }

      return assistantTurn(
        index + 2,
        [
          {
            type: "text",
            text: finalReportWithEvidence(
              scenario.claim,
              scenario.steps.map((evidenceStep, evidenceIndex) => ({
                callId: `call_${(evidenceIndex + 1).toString().padStart(3, "0")}`,
                observation: evidenceStep.observation,
              })),
              scenario.suggestion,
            ),
          },
        ],
        "end_turn",
      );
    });
  });
  return turns;
}

describe("triage agent loop", () => {
  test("gives repeated executions of the same incident distinct run IDs", async () => {
    const final = JSON.stringify({
      status: "insufficient_data",
      probableCause: null,
      evidence: [],
      suggestions: [],
      recentChanges: [],
      uncertainties: ["No tools were needed for this run-ID fixture."],
    });
    const trace = new InMemoryTraceSink();
    const runOnce = () =>
      runTriageAgent(incident, {
        provider: new ScriptedProvider([
          assistantTurn(1, [{ type: "text", text: final }], "end_turn"),
        ]),
        tools: registryReturning("unused"),
        trace,
        config,
      });

    const first = await runOnce();
    const second = await runOnce();

    expect(first.runId).not.toBe(second.runId);
    const firstEvents = trace.events.filter((event) => event.runId === first.runId);
    const secondEvents = trace.events.filter((event) => event.runId === second.runId);
    expect(firstEvents.map((event) => event.type)).toEqual([
      "incident_started",
      "provider_request",
      "provider_response",
      "report_completed",
    ]);
    expect(secondEvents.map((event) => event.type)).toEqual(
      firstEvents.map((event) => event.type),
    );
  });

  test("cancels a provider turn when the incident lifecycle is superseded", async () => {
    const controller = new AbortController();
    const trace = new InMemoryTraceSink();
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const provider: CompletionProvider = {
      name: "abort-aware",
      complete: async () => {
        throw new Error("completion must not start after token-count cancellation");
      },
      countInputTokens: async (
        _messages: readonly ProviderMessage[],
        _tools: readonly ToolDefinition[],
        options?: ProviderRequestOptions,
      ): Promise<number> => {
        providerStarted?.();
        return new Promise<number>((_resolve, reject) => {
          const rejectCancelled = (): void =>
            reject(new Error("provider request cancelled"));
          if (options?.signal?.aborted === true) {
            rejectCancelled();
            return;
          }
          options?.signal?.addEventListener("abort", rejectCancelled, {
            once: true,
          });
        });
      },
    };

    const running = runTriageAgent(
      incident,
      {
        provider,
        tools: registryReturning("unused"),
        trace,
        config: { ...config, incidentTimeoutMs: 10_000 },
      },
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("external cancellation did not settle promptly")),
          250,
        ),
      ),
    ]);

    expect(result.report.status).toBe("insufficient_data");
    expect(result.report.uncertainties).toEqual([
      "incident lifecycle was superseded",
    ]);
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        type: "run_stopped",
        providerErrorKind: "IncidentSuperseded",
      }),
    );
    expect(trace.events).not.toContainEqual(
      expect.objectContaining({ providerErrorKind: "IncidentDeadlineExceeded" }),
    );
  });

  test("releases a blocked tool turn when the incident lifecycle is superseded", async () => {
    const controller = new AbortController();
    const trace = new InMemoryTraceSink();
    let toolStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let toolRuns = 0;
    const tools: ReadOnlyToolRegistry = {
      definitions: readOnlyToolDefinitions,
      run: async () => {
        toolRuns += 1;
        toolStarted?.();
        return new Promise(() => {
          // The loop must release its worker slot even if a transport ignores
          // cancellation; production tool transports remain separately bounded.
        });
      },
    };
    const provider = new ScriptedProvider([
      assistantTurn(
        1,
        [
          {
            type: "tool_call",
            id: "provider_tool_blocked",
            name: "kubectl_describe",
            input: {
              kind: "pod",
              name: incident.pod,
              namespace: incident.namespace,
            },
          },
        ],
        "tool_use",
      ),
    ]);

    const running = runTriageAgent(
      incident,
      {
        provider,
        tools,
        trace,
        config: { ...config, incidentTimeoutMs: 10_000 },
      },
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("tool cancellation did not settle promptly")),
          250,
        ),
      ),
    ]);

    expect(result.report.uncertainties).toEqual([
      "incident lifecycle was superseded",
    ]);
    expect(result.toolCalls).toEqual([]);
    expect(toolRuns).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        type: "run_stopped",
        providerErrorKind: "IncidentSuperseded",
      }),
    );
  });

  for (const scenario of diagnosisScenarios) {
    test(`returns a cited ${scenario.label} diagnosis from fixture evidence`, async () => {
      const provider = new ScriptedProvider(scenarioTurns(scenario));
      const trace = new InMemoryTraceSink(
        () => new Date("2026-07-26T09:00:00Z"),
      );

      const result = await runTriageAgent(scenario.incident, {
        provider,
        tools: scenario.registry(),
        trace,
        config,
      });

      expect(result.report.status).toBe("diagnosed");
      expect(result.report.probableCause?.claim).toBe(scenario.claim);
      expect(result.report.probableCause?.evidenceCallIds).toEqual(
        scenario.steps.map((_, index) =>
          `call_${(index + 1).toString().padStart(3, "0")}`,
        ),
      );
      expect(result.toolCalls).toHaveLength(scenario.steps.length);
      expect(result.toolCalls[0]?.callId).toBe("call_001");
      expect(result.toolCalls.map(({ toolName }) => toolName)).toEqual(
        scenario.steps.map(({ toolName }) => toolName),
      );
      expect(result.toolCalls[0]?.isError).toBe(false);
      expect(result.toolCalls.length).toBeLessThan(10);
      expect(trace.events.filter((event) => event.type === "tool_call")).toHaveLength(
        scenario.steps.length,
      );
      expect(trace.events.filter((event) => event.type === "tool_result")).toHaveLength(
        scenario.steps.length,
      );
      expect(trace.events.at(-1)?.type).toBe("report_completed");
    });
  }

  test("summarizes an oversized result before it reaches the provider", async () => {
    const hugeResult = "log-line with repeated data\n".repeat(2_000);
    const provider = new ScriptedProvider([
      assistantTurn(
        1,
        [
          {
            type: "tool_call",
            id: "provider_tool_1",
            name: "get_pod_logs",
            input: {
              namespace: "payments",
              pod: "checkout-7bd9",
              container: "checkout",
              lines: 200,
            },
          },
        ],
        "tool_use",
      ),
      assistantTurn(
        2,
        [
          {
            type: "text",
            text: finalReport(
              "The logs show a repeatable application failure.",
              "The bounded log preview contains the repeating failure.",
              "Inspect the failing code path.",
              "medium",
            ),
          },
        ],
        "end_turn",
      ),
    ]);

    const result = await runTriageAgent(incident, {
      provider,
      tools: registryReturning(hugeResult),
      trace: new InMemoryTraceSink(),
      config,
    });

    const secondRequest = provider.requests[1];
    const toolResult =
      secondRequest === undefined
        ? undefined
        : firstToolResult(secondRequest.messages);
    expect(toolResult?.type).toBe("tool_result");
    if (toolResult?.type !== "tool_result") {
      throw new Error("second request must contain a tool result");
    }
    expect(utf8ByteLength(toolResult.content)).toBeLessThanOrEqual(16_000);
    expect(toolResult.content).toContain('"sha256"');
    expect(result.toolCalls[0]?.summarized).toBe(true);
    expect(result.toolCalls[0]?.summaryReason).toBe("agent_tool_result_limit");
  });

  test("tightens a result under context pressure before hard-stopping", async () => {
    const provider = new ScriptedProvider(
      [
        assistantTurn(
          1,
          [
            {
              type: "tool_call",
              id: "provider_tool_1",
              name: "get_pod_logs",
              input: {
                namespace: "payments",
                pod: "checkout-7bd9",
                container: "checkout",
                lines: 200,
              },
            },
          ],
          "tool_use",
        ),
        assistantTurn(
          2,
          [
            {
              type: "text",
              text: finalReport(
                "The bounded log sample identifies the failure.",
                "The admitted preview contains the failure marker.",
                "Inspect the identified application path.",
              ),
            },
          ],
          "end_turn",
        ),
      ],
      (messages) => {
        const toolResult = firstToolResult(messages);
        if (toolResult === undefined) {
          return 100;
        }
        return utf8ByteLength(toolResult.content) > 4_500 ? 5_000 : 3_000;
      },
    );
    const pressuredConfig: AgentRuntimeConfig = {
      ...config,
      contextWindowTokens: 8_000,
      maxOutputTokens: 4_000,
      contextSafetyTokens: 500,
    };

    const result = await runTriageAgent(incident, {
      provider,
      tools: registryReturning("x".repeat(8_000)),
      trace: new InMemoryTraceSink(),
      config: pressuredConfig,
    });

    expect(result.report.status).toBe("diagnosed");
    expect(result.toolCalls[0]?.summarized).toBe(true);
    expect(result.toolCalls[0]?.summaryReason).toBe("agent_context_pressure");
    expect(result.toolCalls[0]?.admittedBytes).toBeLessThanOrEqual(4_000);
  });

  test("returns insufficient data when even the pressure summary exceeds budget", async () => {
    const provider = new ScriptedProvider(
      [
        assistantTurn(
          1,
          [
            {
              type: "tool_call",
              id: "provider_tool_1",
              name: "get_pod_logs",
              input: {
                namespace: "payments",
                pod: "checkout-7bd9",
                container: "checkout",
                lines: 200,
              },
            },
          ],
          "tool_use",
        ),
      ],
      (messages) =>
        messages.some((message) =>
          message.content.some((block) => block.type === "tool_result"),
        )
          ? 9_000
          : 100,
    );
    const trace = new InMemoryTraceSink();

    const result = await runTriageAgent(incident, {
      provider,
      tools: registryReturning("x".repeat(8_000)),
      trace,
      config: {
        ...config,
        contextWindowTokens: 8_000,
        maxOutputTokens: 4_000,
        contextSafetyTokens: 500,
      },
    });

    expect(result.report.status).toBe("insufficient_data");
    expect(result.report.uncertainties).toContain("context budget exhausted");
    expect(provider.requests).toHaveLength(1);
    expect(
      trace.events.some(
        (event) => event.type === "run_stopped" && event.reason === "context_budget",
      ),
    ).toBe(true);
  });

  test("refuses an eleventh tool call and executes only ten", async () => {
    const toolTurns = Array.from({ length: 11 }, (_, index) =>
      assistantTurn(
        index + 1,
        [
          {
            type: "tool_call" as const,
            id: `provider_tool_${index + 1}`,
            name: "get_recent_events",
            input: { namespace: "payments", minutes: 15 },
          },
        ],
        "tool_use",
      ),
    );
    const provider = new ScriptedProvider(toolTurns);
    let executions = 0;
    const tools: ReadOnlyToolRegistry = {
      definitions: readOnlyToolDefinitions,
      run: async () => {
        executions += 1;
        const content = JSON.stringify({ events: [], execution: executions });
        return {
          content,
          bytes: utf8ByteLength(content),
          truncated: false,
          truncationReasons: [],
        };
      },
    };
    const trace = new InMemoryTraceSink();

    const result = await runTriageAgent(incident, {
      provider,
      tools,
      trace,
      config,
    });

    expect(executions).toBe(10);
    expect(result.toolCalls).toHaveLength(10);
    expect(result.report.status).toBe("insufficient_data");
    expect(result.report.uncertainties).toContain("tool call limit reached");
    expect(provider.requests[10]?.tools).toHaveLength(0);
    expect(
      trace.events.some(
        (event) => event.type === "run_stopped" && event.reason === "tool_call_limit",
      ),
    ).toBe(true);
  });

  test("refuses the eleventh call when one provider turn requests eleven", async () => {
    const provider = new ScriptedProvider([
      assistantTurn(
        1,
        Array.from({ length: 11 }, (_, index) => ({
          type: "tool_call" as const,
          id: `parallel_tool_${index + 1}`,
          name: "get_recent_events",
          input: { namespace: "payments", minutes: 15 },
        })),
        "tool_use",
      ),
    ]);
    let executions = 0;
    const tools: ReadOnlyToolRegistry = {
      definitions: readOnlyToolDefinitions,
      run: async () => {
        executions += 1;
        const content = JSON.stringify({ events: [], execution: executions });
        return {
          content,
          bytes: utf8ByteLength(content),
          truncated: false,
          truncationReasons: [],
        };
      },
    };

    const result = await runTriageAgent(incident, {
      provider,
      tools,
      trace: new InMemoryTraceSink(),
      config,
    });

    expect(executions).toBe(10);
    expect(result.toolCalls).toHaveLength(10);
    expect(result.report.status).toBe("insufficient_data");
    expect(provider.requests).toHaveLength(1);
  });
});
