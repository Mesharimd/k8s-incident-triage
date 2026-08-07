import { expect, test } from "bun:test";

import { OpenRouterProvider } from "../../src/agent/openrouter";
import { parseTriageReport } from "../../src/agent/triage-report";
import type { ToolDefinition } from "../../src/tools/definition";

const inspectFixtureTool: ToolDefinition = {
  name: "inspect_fixture",
  description:
    "Read one bounded synthetic incident fixture. This test-only tool never accesses a cluster.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fixture"],
    properties: {
      fixture: { type: "string", enum: ["oom"] },
    },
  },
};

test.skipIf(Bun.env.OPENROUTER_LIVE_TEST !== "1")(
  "OpenRouter live API completes one strict synthetic tool-use round trip",
  async () => {
    const apiKey = Bun.env.OPENROUTER_API_KEY?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        "OPENROUTER_API_KEY is required for the live provider test",
      );
    }
    const provider = new OpenRouterProvider();
    const initialMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "Do not return the final report yet. First call inspect_fixture exactly once with fixture oom; it is the only source of incident evidence.",
          },
        ],
      },
    ];
    const toolTurn = await provider.complete(initialMessages, [
      inspectFixtureTool,
    ]);
    const toolCalls = toolTurn.content.filter(
      (block) => block.type === "tool_call",
    );
    expect(toolTurn.stopReason).toBe("tool_use");
    expect(toolCalls).toHaveLength(1);
    const toolCall = toolCalls[0];
    if (toolCall?.type !== "tool_call") {
      throw new Error("OpenRouter live response must request inspect_fixture");
    }
    expect(toolCall.name).toBe("inspect_fixture");

    const reportTurn = await provider.complete(
      [
        ...initialMessages,
        toolTurn,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: toolCall.id,
              content: JSON.stringify({
                evidenceCallId: "call_001",
                fixture: "oom",
                pod: "checkout-api-abc",
                lastTermination: { reason: "OOMKilled", exitCode: 137 },
                memoryLimit: "128Mi",
              }),
              isError: false,
            },
          ],
        },
      ],
      [],
    );
    const serialized = reportTurn.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const report = parseTriageReport(serialized, new Set(["call_001"]));

    expect(reportTurn.stopReason).toBe("end_turn");
    expect(report.status).toBe("diagnosed");
    expect(report.probableCause?.evidenceCallIds).toContain("call_001");
  },
  120_000,
);
