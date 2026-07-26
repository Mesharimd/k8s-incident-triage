import { describe, expect, test } from "bun:test";

import type { PrometheusApi } from "../../src/tools/api";
import { InClusterKubernetesApi } from "../../src/tools/kubernetes-api";
import type {
  KubernetesDescribeApi,
  KubernetesDescribeRequest,
} from "../../src/tools/kubernetes-describe";
import type {
  KubernetesEventsApi,
  ListNamespacedEventsRequest,
} from "../../src/tools/recent-events";
import type {
  KubernetesRolloutApi,
  ListNamespacedReplicaSetsRequest,
  ReadNamespacedDeploymentRequest,
} from "../../src/tools/rollout-history";
import type { PodLogsApi, PodLogsRequest } from "../../src/tools/pod-logs";
import {
  createProductionReadOnlyToolRegistry,
  createReadOnlyToolRegistry,
  readOnlyToolDefinitions,
} from "../../src/tools";

type KubernetesFixtureApi = PodLogsApi &
  KubernetesDescribeApi &
  KubernetesEventsApi &
  KubernetesRolloutApi;

describe("read-only tool registry", () => {
  test("publishes exactly the five strict tool definitions", () => {
    expect(readOnlyToolDefinitions.map((definition) => definition.name)).toEqual([
      "query_prometheus",
      "get_pod_logs",
      "kubectl_describe",
      "get_recent_events",
      "get_rollout_history",
    ]);
    expect(
      readOnlyToolDefinitions.every(
        (definition) => definition.inputSchema.additionalProperties === false,
      ),
    ).toBe(true);
  });

  test("validates unknown input and runs the bounded log tool", async () => {
    let logCalls = 0;
    const kubernetes: KubernetesFixtureApi = {
      getPodLogs: async (_request: PodLogsRequest): Promise<string> => {
        logCalls += 1;
        return Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n");
      },
      getResource: async (_request: KubernetesDescribeRequest): Promise<unknown> => ({}),
      listNamespacedEvents: async (
        _request: ListNamespacedEventsRequest,
      ): Promise<unknown> => ({ apiVersion: "v1", kind: "EventList", items: [] }),
      readNamespacedDeployment: async (
        _request: ReadNamespacedDeploymentRequest,
      ): Promise<unknown> => ({}),
      listNamespacedReplicaSets: async (
        _request: ListNamespacedReplicaSetsRequest,
      ): Promise<unknown> => ({
        apiVersion: "apps/v1",
        kind: "ReplicaSetList",
        items: [],
      }),
    };
    const prometheus: PrometheusApi = {
      queryRange: async () => ({
        status: "success",
        data: { resultType: "matrix", result: [] },
      }),
    };
    const registry = createReadOnlyToolRegistry({ prometheus, kubernetes });

    const result = await registry.run("get_pod_logs", {
      namespace: "payments",
      pod: "checkout-0",
      container: "checkout",
      lines: 5_000,
    });
    const content = JSON.parse(result.content) as {
      effectiveLines: number;
      returnedLines: number;
    };

    expect(content).toMatchObject({ effectiveLines: 200, returnedLines: 200 });
    expect(logCalls).toBe(1);
    await expect(
      registry.run("get_pod_logs", {
        namespace: "payments",
        pod: "checkout-0",
        container: "checkout",
        lines: 20,
        unexpected: true,
      }),
    ).rejects.toThrow("unexpected input field");
    expect(logCalls).toBe(1);
    await expect(registry.run("delete_pod", {})).rejects.toThrow("unknown tool");
  });

  test("production Kubernetes client exposes no mutating operation", () => {
    expect(Object.getOwnPropertyNames(InClusterKubernetesApi.prototype).sort()).toEqual([
      "constructor",
      "getPodLogs",
      "getResource",
      "listNamespacedEvents",
      "listNamespacedReplicaSets",
      "readNamespacedDeployment",
    ]);
  });

  test("assembles production read clients only from explicit environment", () => {
    expect(() =>
      createProductionReadOnlyToolRegistry({
        KUBERNETES_API_URL: "https://kubernetes.default.svc",
      }),
    ).toThrow("PROMETHEUS_URL is required");

    const registry = createProductionReadOnlyToolRegistry({
      PROMETHEUS_URL: "http://prometheus.monitoring.svc:9090",
      KUBERNETES_API_URL: "https://kubernetes.default.svc",
      KUBERNETES_TOKEN_PATH: "/serviceaccount/token",
      KUBERNETES_CA_PATH: "/serviceaccount/ca.crt",
    });

    expect(registry.definitions).toHaveLength(5);
  });
});
