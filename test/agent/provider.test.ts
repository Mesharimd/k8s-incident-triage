import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AGENT_CONTEXT_TOKENS,
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  DEFAULT_AGENT_MAX_TOOL_CALLS,
  loadAgentRuntimeConfig,
} from "../../src/agent/provider";

describe("agent runtime configuration", () => {
  test("uses bounded provider-neutral defaults", () => {
    expect(loadAgentRuntimeConfig({})).toEqual({
      maxToolCalls: DEFAULT_AGENT_MAX_TOOL_CALLS,
      contextWindowTokens: DEFAULT_AGENT_CONTEXT_TOKENS,
      maxOutputTokens: DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
      contextSafetyTokens: 1_024,
      incidentTimeoutMs: 75_000,
    });
  });

  test("allows operators to lower the tool-call ceiling but never raise it", () => {
    expect(
      loadAgentRuntimeConfig({
        AGENT_MAX_TOOL_CALLS: "4",
        AGENT_CONTEXT_TOKENS: "24000",
        AGENT_MAX_OUTPUT_TOKENS: "2048",
        AGENT_CONTEXT_SAFETY_TOKENS: "512",
        AGENT_INCIDENT_TIMEOUT_MS: "60000",
      }),
    ).toEqual({
      maxToolCalls: 4,
      contextWindowTokens: 24_000,
      maxOutputTokens: 2_048,
      contextSafetyTokens: 512,
      incidentTimeoutMs: 60_000,
    });

    expect(() =>
      loadAgentRuntimeConfig({ AGENT_MAX_TOOL_CALLS: "11" }),
    ).toThrow("AGENT_MAX_TOOL_CALLS must be between 1 and 10");
  });

  test("rejects malformed and internally impossible token budgets", () => {
    expect(() =>
      loadAgentRuntimeConfig({ AGENT_CONTEXT_TOKENS: "many" }),
    ).toThrow("AGENT_CONTEXT_TOKENS must be an integer");
    expect(() =>
      loadAgentRuntimeConfig({
        AGENT_CONTEXT_TOKENS: "4096",
        AGENT_MAX_OUTPUT_TOKENS: "4096",
      }),
    ).toThrow("context window must exceed output and safety reserves");
    expect(() =>
      loadAgentRuntimeConfig({
        AGENT_CONTEXT_TOKENS: "9".repeat(400),
      }),
    ).toThrow("AGENT_CONTEXT_TOKENS must be a safe integer");
    expect(() =>
      loadAgentRuntimeConfig({ AGENT_MAX_OUTPUT_TOKENS: "0" }),
    ).toThrow("AGENT_MAX_OUTPUT_TOKENS must be at least 1");
    expect(() =>
      loadAgentRuntimeConfig({ AGENT_INCIDENT_TIMEOUT_MS: "120001" }),
    ).toThrow("AGENT_INCIDENT_TIMEOUT_MS must be between 1000 and 120000");
  });
});
