import type { PrometheusApi } from "./api";
import type { ToolDefinition } from "./definition";
import { createInClusterKubernetesApi } from "./kubernetes-api";
import type {
  KubernetesDescribeApi,
  KubernetesDescribeKind,
  KubectlDescribeInput,
} from "./kubernetes-describe";
import {
  kubectlDescribe,
  kubectlDescribeDefinition,
} from "./kubernetes-describe";
import type { GetPodLogsInput, PodLogsApi } from "./pod-logs";
import { getPodLogs, getPodLogsDefinition } from "./pod-logs";
import type { QueryPrometheusInput } from "./prometheus";
import { queryPrometheus, queryPrometheusDefinition } from "./prometheus";
import { PrometheusHttpApi } from "./prometheus-api";
import { FetchReadTransport } from "./read-transport";
import type { GetRecentEventsInput, KubernetesEventsApi } from "./recent-events";
import { getRecentEvents, getRecentEventsDefinition } from "./recent-events";
import type { BoundedToolResult } from "./result";
import { ToolInputError } from "./result";
import type {
  GetRolloutHistoryInput,
  KubernetesRolloutApi,
} from "./rollout-history";
import {
  getRolloutHistory,
  getRolloutHistoryDefinition,
} from "./rollout-history";

export type ToolName =
  | "query_prometheus"
  | "get_pod_logs"
  | "kubectl_describe"
  | "get_recent_events"
  | "get_rollout_history";

export const readOnlyToolDefinitions: readonly ToolDefinition[] = Object.freeze([
  queryPrometheusDefinition,
  getPodLogsDefinition,
  kubectlDescribeDefinition,
  getRecentEventsDefinition,
  getRolloutHistoryDefinition,
]);

export interface ReadOnlyToolDependencies {
  readonly prometheus: PrometheusApi;
  readonly kubernetes: PodLogsApi &
    KubernetesDescribeApi &
    KubernetesEventsApi &
    KubernetesRolloutApi;
  readonly now?: () => Date;
}

export interface ReadOnlyToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  run(name: string, input: unknown): Promise<BoundedToolResult>;
}

function inputObject(
  value: unknown,
  allowedFields: readonly string[],
  field = "input",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolInputError(`${field} must be an object`);
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!allowedFields.includes(key)) {
      throw new ToolInputError(`unexpected input field: ${field}.${key}`);
    }
  }
  return object;
}

function stringField(object: Readonly<Record<string, unknown>>, key: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new ToolInputError(`${key} must be a string`);
  }
  return value;
}

function numberField(object: Readonly<Record<string, unknown>>, key: string): number {
  const value = object[key];
  if (typeof value !== "number") {
    throw new ToolInputError(`${key} must be a number`);
  }
  return value;
}

function queryPrometheusInput(value: unknown): QueryPrometheusInput {
  const object = inputObject(value, ["promql", "range"]);
  const range = inputObject(object.range, ["lookbackMinutes", "stepSeconds"], "input.range");
  const stepSeconds = range.stepSeconds;
  if (stepSeconds !== undefined && typeof stepSeconds !== "number") {
    throw new ToolInputError("stepSeconds must be a number");
  }
  return {
    promql: stringField(object, "promql"),
    range: {
      lookbackMinutes: numberField(range, "lookbackMinutes"),
      ...(stepSeconds === undefined ? {} : { stepSeconds }),
    },
  };
}

function podLogsInput(value: unknown): GetPodLogsInput {
  const object = inputObject(value, ["namespace", "pod", "container", "lines"]);
  return {
    namespace: stringField(object, "namespace"),
    pod: stringField(object, "pod"),
    container: stringField(object, "container"),
    lines: numberField(object, "lines"),
  };
}

function describeInput(value: unknown): KubectlDescribeInput {
  const object = inputObject(value, ["kind", "name", "namespace"]);
  const kind = stringField(object, "kind");
  if (kind !== "pod" && kind !== "deployment" && kind !== "replicaset") {
    throw new ToolInputError("kind must be pod, deployment, or replicaset");
  }
  return {
    kind: kind satisfies KubernetesDescribeKind,
    name: stringField(object, "name"),
    namespace: stringField(object, "namespace"),
  };
}

function recentEventsInput(value: unknown): GetRecentEventsInput {
  const object = inputObject(value, ["namespace", "minutes"]);
  return {
    namespace: stringField(object, "namespace"),
    minutes: numberField(object, "minutes"),
  };
}

function rolloutHistoryInput(value: unknown): GetRolloutHistoryInput {
  const object = inputObject(value, ["deployment", "namespace"]);
  return {
    deployment: stringField(object, "deployment"),
    namespace: stringField(object, "namespace"),
  };
}

function isToolName(name: string): name is ToolName {
  return readOnlyToolDefinitions.some((definition) => definition.name === name);
}

export function createReadOnlyToolRegistry(
  dependencies: ReadOnlyToolDependencies,
): ReadOnlyToolRegistry {
  return {
    definitions: readOnlyToolDefinitions,
    run: async (name: string, input: unknown): Promise<BoundedToolResult> => {
      if (!isToolName(name)) {
        throw new ToolInputError(`unknown tool: ${name}`);
      }
      switch (name) {
        case "query_prometheus":
          return queryPrometheus(queryPrometheusInput(input), {
            api: dependencies.prometheus,
            now: dependencies.now,
          });
        case "get_pod_logs":
          return getPodLogs(podLogsInput(input), {
            api: dependencies.kubernetes,
          });
        case "kubectl_describe":
          return kubectlDescribe(describeInput(input), {
            api: dependencies.kubernetes,
          });
        case "get_recent_events":
          return getRecentEvents(recentEventsInput(input), {
            api: dependencies.kubernetes,
            now: dependencies.now,
          });
        case "get_rollout_history":
          return getRolloutHistory(rolloutHistoryInput(input), {
            api: dependencies.kubernetes,
          });
      }
    },
  };
}

export function createProductionReadOnlyToolRegistry(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): ReadOnlyToolRegistry {
  const prometheusUrl = environment.PROMETHEUS_URL?.trim();
  if (prometheusUrl === undefined || prometheusUrl.length === 0) {
    throw new Error("PROMETHEUS_URL is required");
  }
  const transport = new FetchReadTransport();
  return createReadOnlyToolRegistry({
    prometheus: new PrometheusHttpApi(prometheusUrl, transport),
    kubernetes: createInClusterKubernetesApi(environment),
  });
}

export type { BoundedToolResult } from "./result";
