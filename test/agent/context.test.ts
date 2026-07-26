import { describe, expect, test } from "bun:test";

import {
  AGENT_TOOL_CONTEXT_BYTES,
  prepareToolResultForContext,
} from "../../src/agent/context";
import { utf8ByteLength } from "../../src/tools/result";

describe("tool-result context admission", () => {
  test("passes a bounded result through with a code-issued evidence ID", () => {
    const admitted = prepareToolResultForContext(
      "call_001",
      "kubectl_describe",
      {
        content: '{"reason":"OOMKilled"}',
        bytes: 22,
        truncated: false,
        truncationReasons: [],
      },
    );

    expect(admitted.content).toContain("Evidence call ID: call_001");
    expect(admitted.content).toContain('{"reason":"OOMKilled"}');
    expect(admitted.rawBytes).toBe(22);
    expect(admitted.admittedBytes).toBe(utf8ByteLength(admitted.content));
    expect(admitted.summarized).toBe(false);
  });

  test("deterministically summarizes oversized UTF-8 output under the byte cap", () => {
    const content = `${"begin-".repeat(3_000)}${"💥".repeat(3_000)}${"-end".repeat(
      3_000,
    )}`;
    const result = {
      content,
      bytes: utf8ByteLength(content),
      truncated: false,
      truncationReasons: [] as readonly string[],
    };

    const first = prepareToolResultForContext(
      "call_007",
      "get_pod_logs",
      result,
    );
    const second = prepareToolResultForContext(
      "call_007",
      "get_pod_logs",
      result,
    );

    expect(first).toEqual(second);
    expect(first.summarized).toBe(true);
    expect(first.summaryReason).toBe("agent_tool_result_limit");
    expect(first.admittedBytes).toBeLessThanOrEqual(AGENT_TOOL_CONTEXT_BYTES);
    expect(first.content).toContain('"originalBytes"');
    expect(first.content).toContain('"sha256"');
    expect(first.content).toContain('"head"');
    expect(first.content).toContain('"tail"');
    expect(first.content).not.toContain("�");
  });

  test("can tighten an already bounded result when total context is pressured", () => {
    const content = "x".repeat(8_000);
    const admitted = prepareToolResultForContext(
      "call_002",
      "get_pod_logs",
      {
        content,
        bytes: utf8ByteLength(content),
        truncated: true,
        truncationReasons: ["line_limit"],
      },
      {
        maxBytes: 2_000,
        summaryReason: "agent_context_pressure",
      },
    );

    expect(admitted.admittedBytes).toBeLessThanOrEqual(2_000);
    expect(admitted.summarized).toBe(true);
    expect(admitted.summaryReason).toBe("agent_context_pressure");
    expect(admitted.truncated).toBe(true);
    expect(admitted.truncationReasons).toEqual(["line_limit"]);
  });
});
