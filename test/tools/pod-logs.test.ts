import { describe, expect, test } from "bun:test";

import {
  getPodLogs,
  getPodLogsDefinition,
  MAX_POD_LOG_RESULT_BYTES,
  type PodLogsApi,
} from "../../src/tools/pod-logs";
import { ToolInputError } from "../../src/tools/result";

const crashLogs = await Bun.file(
  new URL("../fixtures/pod-logs-checkout-crash.log", import.meta.url),
).text();

describe("get_pod_logs", () => {
  test("returns targeted pod logs and identifies the effective tail request", async () => {
    let receivedRequest: unknown;
    const api: PodLogsApi = {
      getPodLogs: async (request) => {
        receivedRequest = request;
        return crashLogs;
      },
    };

    const result = await getPodLogs(
      {
        namespace: "payments",
        pod: "checkout-api-5b48f95f67-9mh8k",
        container: "checkout-api",
        lines: 25,
      },
      { api },
    );
    const content = JSON.parse(result.content) as {
      target: Readonly<Record<string, string>>;
      requestedLines: number;
      effectiveLines: number;
      returnedLines: number;
      logs: string;
    };

    expect(receivedRequest).toEqual({
      namespace: "payments",
      pod: "checkout-api-5b48f95f67-9mh8k",
      container: "checkout-api",
      tailLines: 25,
    });
    expect(content).toMatchObject({
      target: {
        namespace: "payments",
        pod: "checkout-api-5b48f95f67-9mh8k",
        container: "checkout-api",
      },
      requestedLines: 25,
      effectiveLines: 25,
      returnedLines: 6,
    });
    expect(content.logs).toContain("order_id=ord-8472");
    expect(content.logs.endsWith("ERROR process exiting code=1")).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test("clamps oversized requests and keeps the newest 200 response lines", async () => {
    let receivedTailLines: number | undefined;
    const oversizedLogs = Array.from(
      { length: 260 },
      (_, index) => `2026-07-25T15:19:${String(index % 60).padStart(2, "0")}Z INFO log-${String(index + 1).padStart(3, "0")}`,
    ).join("\n");
    const api: PodLogsApi = {
      getPodLogs: async (request) => {
        receivedTailLines = request.tailLines;
        return oversizedLogs;
      },
    };

    const result = await getPodLogs(
      {
        namespace: "payments",
        pod: "checkout-api-5b48f95f67-9mh8k",
        container: "checkout-api",
        lines: 5_000,
      },
      { api },
    );
    const content = JSON.parse(result.content) as {
      effectiveLines: number;
      returnedLines: number;
      logs: string;
      truncation: {
        reasons: readonly string[];
        originalLines: number;
        omittedLines: number;
      };
    };
    const returned = content.logs.split("\n");

    expect(receivedTailLines).toBe(200);
    expect(content.effectiveLines).toBe(200);
    expect(content.returnedLines).toBe(200);
    expect(returned).toHaveLength(200);
    expect(returned[0]?.endsWith("log-061")).toBe(true);
    expect(returned.at(-1)?.endsWith("log-260")).toBe(true);
    expect(content.truncation).toMatchObject({
      reasons: ["requested_line_limit", "response_line_limit"],
      originalLines: 260,
      omittedLines: 60,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual([
      "requested_line_limit",
      "response_line_limit",
    ]);
  });

  test("clamps non-positive requests to one newest line", async () => {
    let receivedTailLines: number | undefined;
    const api: PodLogsApi = {
      getPodLogs: async (request) => {
        receivedTailLines = request.tailLines;
        return "older line\nnewest line\n";
      },
    };

    const result = await getPodLogs(
      {
        namespace: "payments",
        pod: "checkout-api-5b48f95f67-9mh8k",
        container: "checkout-api",
        lines: 0,
      },
      { api },
    );
    const content = JSON.parse(result.content) as {
      effectiveLines: number;
      returnedLines: number;
      logs: string;
    };

    expect(receivedTailLines).toBe(1);
    expect(content).toMatchObject({
      effectiveLines: 1,
      returnedLines: 1,
      logs: "newest line",
    });
    expect(result.truncationReasons).toEqual([
      "requested_line_floor",
      "response_line_limit",
    ]);
  });

  test("byte-bounds one enormous UTF-8 line while preserving its tail", async () => {
    const enormousLine = `${"🙂\\\"".repeat(8_000)}TAIL-🚨`;
    const api: PodLogsApi = {
      getPodLogs: async () => enormousLine,
    };

    const result = await getPodLogs(
      {
        namespace: "payments",
        pod: "checkout-api-5b48f95f67-9mh8k",
        container: "checkout-api",
        lines: 50,
      },
      { api },
    );
    const content = JSON.parse(result.content) as {
      logs: string;
      returnedLines: number;
      truncation: {
        reasons: readonly string[];
        leadingLinePartial: boolean;
      };
    };

    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(
      MAX_POD_LOG_RESULT_BYTES,
    );
    expect(result.bytes).toBeLessThanOrEqual(MAX_POD_LOG_RESULT_BYTES);
    expect(content.logs.endsWith("TAIL-🚨")).toBe(true);
    expect(content.logs.startsWith("�")).toBe(false);
    expect(content.returnedLines).toBe(1);
    expect(content.truncation).toMatchObject({
      reasons: ["byte_limit"],
      leadingLinePartial: true,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(["byte_limit"]);
  });

  test("publishes a strict schema describing the safe request envelope", () => {
    expect(getPodLogsDefinition).toMatchObject({
      name: "get_pod_logs",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["namespace", "pod", "container", "lines"],
        properties: {
          namespace: {
            type: "string",
            minLength: 1,
            maxLength: 63,
            pattern: expect.any(String),
          },
          pod: {
            type: "string",
            minLength: 1,
            maxLength: 253,
            pattern:
              "^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$",
          },
          container: {
            type: "string",
            minLength: 1,
            maxLength: 63,
            pattern: expect.any(String),
          },
          lines: {
            type: "integer",
            minimum: 1,
            maximum: 200,
          },
        },
      },
    });
  });

  test("rejects Kubernetes name and path injection before calling the API", async () => {
    let apiCalls = 0;
    const api: PodLogsApi = {
      getPodLogs: async () => {
        apiCalls += 1;
        return crashLogs;
      },
    };
    const injectedInputs = [
      {
        namespace: "../kube-system",
        pod: "checkout-api",
        container: "checkout-api",
        lines: 20,
      },
      {
        namespace: "payments",
        pod: "checkout-api/../../secrets",
        container: "checkout-api",
        lines: 20,
      },
      {
        namespace: "payments",
        pod: "checkout-api",
        container: "checkout-api?previous=true",
        lines: 20,
      },
      {
        namespace: "payments",
        pod: `${"a".repeat(64)}.payments`,
        container: "checkout-api",
        lines: 20,
      },
    ] as const;

    for (const input of injectedInputs) {
      await expect(getPodLogs(input, { api })).rejects.toBeInstanceOf(
        ToolInputError,
      );
    }
    expect(apiCalls).toBe(0);
  });
});
