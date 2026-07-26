import type { PrometheusApi } from "./api";
import type { ToolDefinition } from "./definition";
import {
  createBoundedJsonResult,
  MAX_TOOL_RESULT_BYTES,
  ToolExecutionError,
  ToolInputError,
  utf8ByteLength,
} from "./result";
import type { BoundedToolResult } from "./result";

export { MAX_TOOL_RESULT_BYTES } from "./result";

const MAX_PROMQL_BYTES = 2_048;
const MAX_LOOKBACK_MINUTES = 360;
const MAX_SERIES = 20;
const MAX_SAMPLES_PER_SERIES = 60;
const MAX_METRIC_ENTRIES = 32;
const MAX_METRIC_KEY_BYTES = 128;
const MAX_METRIC_VALUE_BYTES = 256;
const MAX_SAMPLE_VALUE_BYTES = 128;

export interface QueryPrometheusInput {
  readonly promql: string;
  readonly range: {
    readonly lookbackMinutes: number;
    readonly stepSeconds?: number;
  };
}

export interface QueryPrometheusDependencies {
  readonly api: PrometheusApi;
  readonly now?: () => Date;
}

export const queryPrometheusDefinition: ToolDefinition = {
  name: "query_prometheus",
  description:
    "Run a bounded Prometheus range query and return capped samples or deterministic series summaries.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["promql", "range"],
    properties: {
      promql: { type: "string", minLength: 1, maxLength: MAX_PROMQL_BYTES },
      range: {
        type: "object",
        additionalProperties: false,
        required: ["lookbackMinutes"],
        properties: {
          lookbackMinutes: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LOOKBACK_MINUTES,
          },
          stepSeconds: {
            type: "integer",
            minimum: 15,
            maximum: 300,
          },
        },
      },
    },
  },
};

interface PrometheusSeries {
  readonly metric: Readonly<Record<string, string>>;
  readonly values: readonly (readonly [number, string])[];
  readonly metadataTruncated: boolean;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolExecutionError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedMetric(value: unknown, field: string): {
  readonly metric: Readonly<Record<string, string>>;
  readonly truncated: boolean;
} {
  const object = asObject(value, field);
  const entries = Object.entries(object);
  const metric: Record<string, string> = {};
  let truncated = entries.length > MAX_METRIC_ENTRIES;

  for (const [key, entry] of entries.slice(0, MAX_METRIC_ENTRIES)) {
    if (typeof entry !== "string") {
      throw new ToolExecutionError(`${field}.${key} must be a string`);
    }
    if (
      utf8ByteLength(key) > MAX_METRIC_KEY_BYTES ||
      utf8ByteLength(entry) > MAX_METRIC_VALUE_BYTES
    ) {
      truncated = true;
      continue;
    }
    metric[key] = entry;
  }

  return { metric, truncated };
}

function parseSample(value: unknown, field: string): readonly [number, string] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ToolExecutionError(`${field} must be a timestamp/value pair`);
  }
  const timestamp = value[0];
  const sample = value[1];
  if (
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    typeof sample !== "string" ||
    utf8ByteLength(sample) > MAX_SAMPLE_VALUE_BYTES
  ) {
    throw new ToolExecutionError(`${field} contains an invalid sample`);
  }
  return [timestamp, sample];
}

function parsePrometheusResponse(value: unknown): {
  readonly series: readonly PrometheusSeries[];
  readonly observedSeriesCount: number;
} {
  const envelope = asObject(value, "Prometheus response");
  if (envelope.status !== "success") {
    const error = typeof envelope.error === "string" ? envelope.error.slice(0, 512) : "query failed";
    throw new ToolExecutionError(`Prometheus query failed: ${error}`);
  }
  const data = asObject(envelope.data, "Prometheus response.data");
  if (data.resultType !== "matrix" || !Array.isArray(data.result)) {
    throw new ToolExecutionError("Prometheus response must contain a matrix result");
  }

  const observedSeriesCount = data.result.length;
  const series = data.result.slice(0, MAX_SERIES).map((entry, seriesIndex) => {
    const object = asObject(entry, `Prometheus series[${seriesIndex}]`);
    const metricResult = boundedMetric(
      object.metric,
      `Prometheus series[${seriesIndex}].metric`,
    );
    if (!Array.isArray(object.values)) {
      throw new ToolExecutionError(
        `Prometheus series[${seriesIndex}].values must be an array`,
      );
    }
    const values = object.values
      .slice(0, MAX_SAMPLES_PER_SERIES)
      .map((sample, sampleIndex) =>
        parseSample(sample, `Prometheus series[${seriesIndex}].values[${sampleIndex}]`),
      );

    return {
      metric: metricResult.metric,
      values,
      metadataTruncated:
        metricResult.truncated || object.values.length > MAX_SAMPLES_PER_SERIES,
    };
  });

  return { series, observedSeriesCount };
}

function validateInput(input: QueryPrometheusInput): void {
  if (
    typeof input.promql !== "string" ||
    input.promql.trim().length === 0 ||
    utf8ByteLength(input.promql) > MAX_PROMQL_BYTES
  ) {
    throw new ToolInputError(
      `promql must be non-empty and at most ${MAX_PROMQL_BYTES} bytes`,
    );
  }
  if (
    !Number.isInteger(input.range.lookbackMinutes) ||
    input.range.lookbackMinutes < 1 ||
    input.range.lookbackMinutes > MAX_LOOKBACK_MINUTES
  ) {
    throw new ToolInputError(
      `lookbackMinutes must be an integer from 1 to ${MAX_LOOKBACK_MINUTES}`,
    );
  }
  if (
    input.range.stepSeconds !== undefined &&
    (!Number.isInteger(input.range.stepSeconds) ||
      input.range.stepSeconds < 15 ||
      input.range.stepSeconds > 300)
  ) {
    throw new ToolInputError("stepSeconds must be an integer from 15 to 300");
  }
}

function summarizeSeries(series: PrometheusSeries): Readonly<Record<string, unknown>> {
  const finiteValues = series.values
    .map(([, value]) => Number(value))
    .filter((value) => Number.isFinite(value));
  const sum = finiteValues.reduce((total, value) => total + value, 0);

  return {
    metric: series.metric,
    sampleCount: series.values.length,
    first: series.values[0]?.[1] ?? null,
    last: series.values.at(-1)?.[1] ?? null,
    min: finiteValues.length > 0 ? Math.min(...finiteValues) : null,
    max: finiteValues.length > 0 ? Math.max(...finiteValues) : null,
    average: finiteValues.length > 0 ? sum / finiteValues.length : null,
    nonFiniteCount: series.values.length - finiteValues.length,
  };
}

export async function queryPrometheus(
  input: QueryPrometheusInput,
  dependencies: QueryPrometheusDependencies,
): Promise<BoundedToolResult> {
  validateInput(input);
  const end = (dependencies.now ?? (() => new Date()))();
  const lookbackSeconds = input.range.lookbackMinutes * 60;
  const start = new Date(end.getTime() - lookbackSeconds * 1_000);
  const effectiveStep = Math.max(
    input.range.stepSeconds ?? 15,
    Math.ceil(lookbackSeconds / (MAX_SAMPLES_PER_SERIES - 1)),
  );
  const range = {
    start: start.toISOString(),
    end: end.toISOString(),
    stepSeconds: effectiveStep,
  };
  const response = await dependencies.api.queryRange({
    query: input.promql,
    ...range,
    timeoutSeconds: 10,
    maxSeries: MAX_SERIES + 1,
  });
  const parsed = parsePrometheusResponse(response);
  const shouldSummarize =
    parsed.observedSeriesCount > MAX_SERIES ||
    parsed.series.some((series) => series.metadataTruncated);
  const truncationReasons: string[] = [];
  if (parsed.observedSeriesCount > MAX_SERIES) {
    truncationReasons.push("series_limit");
  }
  if (parsed.series.some((series) => series.metadataTruncated)) {
    truncationReasons.push("series_metadata_or_sample_limit");
  }

  const output = shouldSummarize
    ? {
        query: input.promql,
        range,
        mode: "summary",
        series: parsed.series.map(summarizeSeries),
        omittedSeriesAtLeast: Math.max(
          0,
          parsed.observedSeriesCount - MAX_SERIES,
        ),
        seriesLimitReached: parsed.observedSeriesCount > MAX_SERIES,
      }
    : {
        query: input.promql,
        range,
        mode: "samples",
        series: parsed.series.map((series) => ({
          metric: series.metric,
          samples: series.values,
        })),
      };

  return createBoundedJsonResult(output, {
    truncated: shouldSummarize,
    truncationReasons,
    fallback: {
      query: input.promql.slice(0, 256),
      range,
      mode: "summary",
      series: [],
      omittedSeriesAtLeast: Math.max(
        0,
        parsed.observedSeriesCount - MAX_SERIES,
      ),
      seriesLimitReached: parsed.observedSeriesCount > MAX_SERIES,
      note: "Series metadata exceeded the serialized result limit.",
    },
  });
}
