import { describe, expect, test } from "bun:test";

import type { PrometheusApi } from "../../src/tools/api";
import {
  MAX_TOOL_RESULT_BYTES,
  queryPrometheus,
  queryPrometheusDefinition,
} from "../../src/tools/prometheus";

const rangeFixture: unknown = await Bun.file(
  new URL("../fixtures/prometheus-range.json", import.meta.url),
).json();

describe("query_prometheus", () => {
  test("returns a bounded range result with the effective query window", async () => {
    const api: PrometheusApi = {
      queryRange: async () => rangeFixture,
    };

    const result = await queryPrometheus(
      {
        promql: "rate(container_cpu_usage_seconds_total[5m])",
        range: { lookbackMinutes: 5, stepSeconds: 15 },
      },
      { api, now: () => new Date("2026-07-25T15:20:00Z") },
    );
    const content: unknown = JSON.parse(result.content);

    expect(content).toEqual({
      query: "rate(container_cpu_usage_seconds_total[5m])",
      range: {
        start: "2026-07-25T15:15:00.000Z",
        end: "2026-07-25T15:20:00.000Z",
        stepSeconds: 15,
      },
      mode: "samples",
      series: [
        {
          metric: {
            __name__: "container_cpu_usage_seconds_total",
            namespace: "payments",
            pod: "checkout-api-5b48f95f67-9mh8k",
          },
          samples: [
            [1784987880, "0.42"],
            [1784987895, "0.51"],
            [1784987910, "0.63"],
          ],
        },
        {
          metric: {
            __name__: "container_cpu_usage_seconds_total",
            namespace: "payments",
            pod: "checkout-api-5b48f95f67-vs7jn",
          },
          samples: [
            [1784987880, "0.37"],
            [1784987895, "0.39"],
            [1784987910, "0.44"],
          ],
        },
      ],
    });
    expect(result.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect(result.truncated).toBe(false);
  });

  test("summarizes and caps an oversized series set", async () => {
    const oversized: unknown = {
      status: "success",
      data: {
        resultType: "matrix",
        result: Array.from({ length: 25 }, (_, index) => ({
          metric: { pod: `worker-${index}` },
          values: [
            [1784987880, String(index)],
            [1784987895, String(index + 2)],
          ],
        })),
      },
    };
    const api: PrometheusApi = { queryRange: async () => oversized };

    const result = await queryPrometheus(
      {
        promql: "worker_queue_depth",
        range: { lookbackMinutes: 5 },
      },
      { api, now: () => new Date("2026-07-25T15:20:00Z") },
    );
    const content = JSON.parse(result.content) as {
      mode: string;
      series: readonly unknown[];
      omittedSeriesAtLeast: number;
      seriesLimitReached: boolean;
    };

    expect(content.mode).toBe("summary");
    expect(content.series).toHaveLength(20);
    expect(content.omittedSeriesAtLeast).toBe(5);
    expect(content.seriesLimitReached).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  test("labels the server-side overflow count as a lower bound", async () => {
    const limitedResponse: unknown = {
      status: "success",
      data: {
        resultType: "matrix",
        result: Array.from({ length: 21 }, (_, index) => ({
          metric: { pod: `worker-${index}` },
          values: [[1784987880, String(index)]],
        })),
      },
    };
    const api: PrometheusApi = { queryRange: async () => limitedResponse };

    const result = await queryPrometheus(
      { promql: "worker_queue_depth", range: { lookbackMinutes: 5 } },
      { api, now: () => new Date("2026-07-25T15:20:00Z") },
    );
    const content = JSON.parse(result.content) as {
      omittedSeriesAtLeast: number;
      seriesLimitReached: boolean;
    };

    expect(content).toMatchObject({
      omittedSeriesAtLeast: 1,
      seriesLimitReached: true,
    });
  });

  test("publishes a strict bounded JSON schema", () => {
    expect(queryPrometheusDefinition).toMatchObject({
      name: "query_prometheus",
      inputSchema: {
        additionalProperties: false,
        required: ["promql", "range"],
        properties: {
          promql: { type: "string", minLength: 1, maxLength: 2048 },
          range: {
            additionalProperties: false,
            required: ["lookbackMinutes"],
          },
        },
      },
    });
  });
});
