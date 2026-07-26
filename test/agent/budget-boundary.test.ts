import { describe, expect, test } from "bun:test";

import { runTriageAgent } from "../../src/agent/loop";
import type {
  AssistantTurn,
  CompletionProvider,
  ProviderMessage,
} from "../../src/agent/provider";
import type { ToolDefinition } from "../../src/tools/definition";
import type { ReadOnlyToolRegistry } from "../../src/tools";
import { InMemoryTraceSink } from "../../src/trace";

const noTools: ReadOnlyToolRegistry = {
  definitions: [],
  run: async () => {
    throw new Error("no tool should run");
  },
};

function providerWithCount(inputTokens: number): CompletionProvider & {
  readonly completions: number;
} {
  let completions = 0;
  return {
    name: "invalid-counter",
    get completions() {
      return completions;
    },
    countInputTokens: async (
      _messages: readonly ProviderMessage[],
      _tools: readonly ToolDefinition[],
    ) => inputTokens,
    complete: async (): Promise<AssistantTurn> => {
      completions += 1;
      throw new Error("completion must not be reached");
    },
  };
}

describe("context budget boundary", () => {
  test("rejects a direct runtime configuration that raises the hard call ceiling", async () => {
    const provider = providerWithCount(100);
    await expect(
      runTriageAgent(
        {
          alertname: "HighLatency",
          namespace: "payments",
          pod: "api-1",
          severity: "warning",
          fingerprint: "invalid-direct-config",
          startsAt: "2026-07-26T09:00:00Z",
          labels: {},
          annotations: {},
        },
        {
          provider,
          tools: noTools,
          config: {
            maxToolCalls: 11,
            contextWindowTokens: 32_000,
            maxOutputTokens: 4_096,
            contextSafetyTokens: 1_024,
          },
        },
      ),
    ).rejects.toThrow("maxToolCalls must be between 1 and 10");
    expect(provider.completions).toBe(0);
  });

  test("rejects a direct non-finite context budget", async () => {
    const provider = providerWithCount(100);
    await expect(
      runTriageAgent(
        {
          alertname: "HighLatency",
          namespace: "payments",
          pod: "api-1",
          severity: "warning",
          fingerprint: "invalid-context-config",
          startsAt: "2026-07-26T09:00:00Z",
          labels: {},
          annotations: {},
        },
        {
          provider,
          tools: noTools,
          config: {
            maxToolCalls: 10,
            contextWindowTokens: Number.POSITIVE_INFINITY,
            maxOutputTokens: 4_096,
            contextSafetyTokens: 1_024,
          },
        },
      ),
    ).rejects.toThrow("contextWindowTokens must be between");
    expect(provider.completions).toBe(0);
  });

  for (const invalidCount of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    test(`fails closed on invalid provider token count ${String(invalidCount)}`, async () => {
      const provider = providerWithCount(invalidCount);
      const trace = new InMemoryTraceSink();
      const result = await runTriageAgent(
        {
          alertname: "HighLatency",
          namespace: "payments",
          pod: "api-1",
          severity: "warning",
          fingerprint: `invalid-count-${String(invalidCount)}`,
          startsAt: "2026-07-26T09:00:00Z",
          labels: {},
          annotations: {},
        },
        {
          provider,
          tools: noTools,
          trace,
          config: {
            maxToolCalls: 10,
            contextWindowTokens: 32_000,
            maxOutputTokens: 4_096,
            contextSafetyTokens: 1_024,
          },
        },
      );

      expect(provider.completions).toBe(0);
      expect(result.report.status).toBe("insufficient_data");
      expect(result.report.uncertainties).toEqual([
        "provider returned an invalid token count",
      ]);
      expect(
        trace.events.some(
          (event) =>
            event.type === "run_stopped" && event.reason === "provider_error",
        ),
      ).toBe(true);
    });
  }

  test("traces a sanitized provider error classification without its body", async () => {
    const provider: CompletionProvider = {
      name: "failing-provider",
      countInputTokens: async () => {
        const error = new Error("response body contains private diagnostics");
        Object.assign(error, {
          name: "RateLimitError",
          type: "rate_limit_error",
          status: 429,
          requestID: "req_01SAFE",
        });
        throw error;
      },
      complete: async () => {
        throw new Error("completion must not run");
      },
    };
    const trace = new InMemoryTraceSink();

    await runTriageAgent(
      {
        alertname: "HighLatency",
        namespace: "payments",
        pod: "api-1",
        severity: "warning",
        fingerprint: "provider-error",
        startsAt: "2026-07-26T09:00:00Z",
        labels: {},
        annotations: {},
      },
      {
        provider,
        tools: noTools,
        trace,
        config: {
          maxToolCalls: 10,
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
          contextSafetyTokens: 1_024,
        },
      },
    );

    const stopped = trace.events.find((event) => event.type === "run_stopped");
    expect(stopped).toMatchObject({
      providerErrorKind: "rate_limit_error",
      providerStatus: 429,
      providerRequestId: "req_01SAFE",
    });
    expect(JSON.stringify(stopped)).not.toContain("private diagnostics");
  });
});
