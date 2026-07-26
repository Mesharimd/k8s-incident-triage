import { describe, expect, test } from "bun:test";

import type {
  KubernetesCredentialsProvider,
  KubernetesServiceAccountCredentials,
} from "../../src/tools/kubernetes-api";
import {
  createInClusterKubernetesApi,
  InClusterKubernetesApi,
} from "../../src/tools/kubernetes-api";
import type {
  ReadRequest,
  ReadResponse,
  ReadTransport,
} from "../../src/tools/read-transport";

describe("in-cluster Kubernetes read API", () => {
  test("maps every tool operation to a bounded authenticated GET", async () => {
    const observed: ReadRequest[] = [];
    const responses = [
      "2026-07-25T15:00:00Z checkout ready\n",
      JSON.stringify({ apiVersion: "v1", kind: "Pod", metadata: { name: "checkout-0" } }),
      JSON.stringify({ apiVersion: "v1", kind: "EventList", items: [] }),
      JSON.stringify({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "checkout", uid: "deployment-uid" },
      }),
      JSON.stringify({ apiVersion: "apps/v1", kind: "ReplicaSetList", items: [] }),
    ];
    const transport: ReadTransport = {
      get: async (request): Promise<ReadResponse> => {
        observed.push(request);
        const next = responses.shift();
        if (next === undefined) {
          throw new Error("unexpected read request");
        }
        return { status: 200, body: new TextEncoder().encode(next) };
      },
    };
    let credentialLoads = 0;
    const credentials: KubernetesCredentialsProvider = {
      load: async (): Promise<KubernetesServiceAccountCredentials> => {
        credentialLoads += 1;
        return { token: `rotated-token-${credentialLoads}`, ca: "test-ca" };
      },
    };
    const api = new InClusterKubernetesApi(
      "https://kubernetes.default.svc:443",
      transport,
      credentials,
    );

    await api.getPodLogs({
      namespace: "payments",
      pod: "checkout-api-0",
      container: "checkout-api",
      tailLines: 200,
    });
    await api.getResource({ kind: "pod", name: "checkout-api-0", namespace: "payments" });
    await api.listNamespacedEvents({ namespace: "payments", limit: 500 });
    await api.readNamespacedDeployment({ name: "checkout", namespace: "payments" });
    await api.listNamespacedReplicaSets({
      namespace: "payments",
      labelSelector: "app=checkout,tier in (api,worker)",
      limit: 500,
    });

    expect(observed.map((request) => request.url.toString())).toEqual([
      "https://kubernetes.default.svc/api/v1/namespaces/payments/pods/checkout-api-0/log?container=checkout-api&tailLines=200&limitBytes=32768&timestamps=true",
      "https://kubernetes.default.svc/api/v1/namespaces/payments/pods/checkout-api-0",
      "https://kubernetes.default.svc/api/v1/namespaces/payments/events?limit=500",
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/payments/deployments/checkout",
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/payments/replicasets?labelSelector=app%3Dcheckout%2Ctier+in+%28api%2Cworker%29&limit=500",
    ]);
    expect(observed.every((request) => request.ca === "test-ca")).toBe(true);
    expect(observed.map((request) => request.headers?.authorization)).toEqual([
      "Bearer rotated-token-1",
      "Bearer rotated-token-2",
      "Bearer rotated-token-3",
      "Bearer rotated-token-4",
      "Bearer rotated-token-5",
    ]);
    expect(credentialLoads).toBe(5);
  });

  test("ignores a blank local override in favor of the in-cluster service host", () => {
    expect(() =>
      createInClusterKubernetesApi({
        KUBERNETES_API_URL: "",
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        KUBERNETES_SERVICE_PORT_HTTPS: "443",
      }),
    ).not.toThrow();
  });

  test("rejects an in-cluster URL override that could receive the bearer token", () => {
    expect(() =>
      createInClusterKubernetesApi({
        KUBERNETES_API_URL: "https://attacker.example",
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        KUBERNETES_SERVICE_PORT_HTTPS: "443",
      }),
    ).toThrow("must match the in-cluster Kubernetes API origin");
  });
});
