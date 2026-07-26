import { describe, expect, test } from "bun:test";

import type {
  ReadRequest,
  ReadResponse,
  ReadTransport,
} from "../../src/tools/read-transport";
import { PrometheusHttpApi } from "../../src/tools/prometheus-api";

describe("Prometheus HTTP API", () => {
  test("builds a bounded query_range GET request", async () => {
    let observed: ReadRequest | undefined;
    const transport: ReadTransport = {
      get: async (request): Promise<ReadResponse> => {
        observed = request;
        return {
          status: 200,
          body: new TextEncoder().encode(
            JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } }),
          ),
        };
      },
    };
    const api = new PrometheusHttpApi("http://prometheus.monitoring.svc:9090", transport);

    const result = await api.queryRange({
      query: "rate(http_requests_total[5m])",
      start: "2026-07-25T15:15:00.000Z",
      end: "2026-07-25T15:20:00.000Z",
      stepSeconds: 15,
      timeoutSeconds: 10,
      maxSeries: 21,
    });

    expect(observed?.url.toString()).toBe(
      "http://prometheus.monitoring.svc:9090/api/v1/query_range?query=rate%28http_requests_total%5B5m%5D%29&start=2026-07-25T15%3A15%3A00.000Z&end=2026-07-25T15%3A20%3A00.000Z&step=15&timeout=10s&limit=21",
    );
    expect(observed).toMatchObject({
      timeoutMs: 10_000,
      maxResponseBytes: 1_048_576,
      headers: { accept: "application/json" },
    });
    expect(result).toEqual({
      status: "success",
      data: { resultType: "matrix", result: [] },
    });
  });
});
