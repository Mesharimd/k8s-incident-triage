import type { PrometheusApi, PrometheusRangeRequest } from "./api";
import type { ReadTransport } from "./read-transport";
import { ToolExecutionError } from "./result";

const MAX_PROMETHEUS_RESPONSE_BYTES = 1_048_576;
const MAX_TIMEOUT_SECONDS = 10;

export class PrometheusHttpApi implements PrometheusApi {
  readonly #baseUrl: URL;
  readonly #transport: ReadTransport;

  constructor(baseUrl: string, transport: ReadTransport) {
    this.#baseUrl = new URL(baseUrl);
    if (this.#baseUrl.protocol !== "http:" && this.#baseUrl.protocol !== "https:") {
      throw new Error("Prometheus URL must use HTTP or HTTPS");
    }
    this.#transport = transport;
  }

  async queryRange(request: PrometheusRangeRequest): Promise<unknown> {
    const url = new URL("/api/v1/query_range", this.#baseUrl);
    url.searchParams.set("query", request.query);
    url.searchParams.set("start", request.start);
    url.searchParams.set("end", request.end);
    url.searchParams.set("step", String(request.stepSeconds));
    const timeoutSeconds = Math.min(
      MAX_TIMEOUT_SECONDS,
      Math.max(1, Math.floor(request.timeoutSeconds)),
    );
    url.searchParams.set("timeout", `${timeoutSeconds}s`);
    url.searchParams.set("limit", String(request.maxSeries));

    const response = await this.#transport.get({
      url,
      headers: { accept: "application/json" },
      timeoutMs: timeoutSeconds * 1_000,
      maxResponseBytes: MAX_PROMETHEUS_RESPONSE_BYTES,
    });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    if (response.status < 200 || response.status >= 300) {
      throw new ToolExecutionError(
        `Prometheus returned HTTP ${response.status}: ${text.slice(0, 512)}`,
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new ToolExecutionError("Prometheus returned invalid JSON");
      }
      throw error;
    }
  }
}
