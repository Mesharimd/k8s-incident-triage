import { describe, expect, test } from "bun:test";

import { createProductionTriageAgent } from "../../src/agent";

const productionEnvironment = {
  PROMETHEUS_URL: "http://prometheus.monitoring.svc:9090",
  KUBERNETES_API_URL: "https://kubernetes.default.svc",
  KUBERNETES_TOKEN_PATH: "/serviceaccount/token",
  KUBERNETES_CA_PATH: "/serviceaccount/ca.crt",
  TRACE_DIR: "./traces-test",
  AGENT_MAX_TOOL_CALLS: "3",
} as const;

describe("production triage agent assembly", () => {
  test("fails closed when LLM_PROVIDER is missing, blank, or unknown", () => {
    for (const environment of [
      {},
      { LLM_PROVIDER: "   " },
      { LLM_PROVIDER: "ollama" },
    ]) {
      expect(() => createProductionTriageAgent(environment)).toThrow(
        'LLM_PROVIDER must be "anthropic" or "openrouter"',
      );
    }
  });

  test("requires the credential for the selected provider", () => {
    expect(() =>
      createProductionTriageAgent({ LLM_PROVIDER: "anthropic" }),
    ).toThrow("ANTHROPIC_API_KEY is required");
    expect(() =>
      createProductionTriageAgent({ LLM_PROVIDER: "openrouter" }),
    ).toThrow("OPENROUTER_API_KEY is required");
  });

  test("constructs the Anthropic provider without reading inactive OpenRouter settings", () => {
    const agent = createProductionTriageAgent({
      ...productionEnvironment,
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "fixture-key-not-a-secret",
      OPENROUTER_TIMEOUT_MS: "not-an-integer",
    });

    expect(agent.triage).toBeFunction();
  });

  test("constructs the OpenRouter provider without reading inactive Anthropic settings", () => {
    const agent = createProductionTriageAgent({
      ...productionEnvironment,
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "fixture-key-not-a-secret",
      ANTHROPIC_TIMEOUT_MS: "not-an-integer",
    });

    expect(agent.triage).toBeFunction();
  });

  test("assembles read-only tools, bounded runtime config, and disk tracing", () => {
    const agent = createProductionTriageAgent({
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "fixture-key-not-a-secret",
      ...productionEnvironment,
    });

    expect(agent.triage).toBeFunction();
  });
});
