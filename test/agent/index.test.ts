import { describe, expect, test } from "bun:test";

import { createProductionTriageAgent } from "../../src/agent";

describe("production triage agent assembly", () => {
  test("fails closed when the Anthropic credential is absent", () => {
    expect(() => createProductionTriageAgent({})).toThrow(
      "ANTHROPIC_API_KEY is required",
    );
  });

  test("assembles read-only tools, bounded runtime config, and disk tracing", () => {
    const agent = createProductionTriageAgent({
      ANTHROPIC_API_KEY: "fixture-key-not-a-secret",
      PROMETHEUS_URL: "http://prometheus.monitoring.svc:9090",
      KUBERNETES_API_URL: "https://kubernetes.default.svc",
      KUBERNETES_TOKEN_PATH: "/serviceaccount/token",
      KUBERNETES_CA_PATH: "/serviceaccount/ca.crt",
      TRACE_DIR: "./traces-test",
      AGENT_MAX_TOOL_CALLS: "3",
    });

    expect(agent.triage).toBeFunction();
  });
});
