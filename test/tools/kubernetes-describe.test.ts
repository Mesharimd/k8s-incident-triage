import { describe, expect, test } from "bun:test";

import {
  MAX_KUBERNETES_DESCRIBE_BYTES,
  kubectlDescribe,
  kubectlDescribeDefinition,
} from "../../src/tools/kubernetes-describe";
import type {
  KubectlDescribeInput,
  KubernetesDescribeApi,
  KubernetesDescribeRequest,
} from "../../src/tools/kubernetes-describe";
import { ToolInputError, utf8ByteLength } from "../../src/tools/result";

const oomKilledPodFixture: unknown = await Bun.file(
  new URL("../fixtures/describe-oomkilled-pod.json", import.meta.url),
).json();
const oversizedPodFixture: unknown = await Bun.file(
  new URL("../fixtures/describe-oversized-pod.json", import.meta.url),
).json();

describe("kubectl_describe", () => {
  test("describes an OOMKilled pod without exposing raw environment or Secret data", async () => {
    const requests: KubernetesDescribeRequest[] = [];
    const api: KubernetesDescribeApi = {
      getResource: async (request) => {
        requests.push(request);
        return oomKilledPodFixture;
      },
    };

    const result = await kubectlDescribe(
      {
        kind: "pod",
        name: "checkout-api-5b48f95f67-9mh8k",
        namespace: "payments",
      },
      { api },
    );

    expect(requests).toEqual([
      {
        kind: "pod",
        name: "checkout-api-5b48f95f67-9mh8k",
        namespace: "payments",
      },
    ]);
    expect(result.content).toContain("Kind: pod");
    expect(result.content).toContain("Name: checkout-api-5b48f95f67-9mh8k");
    expect(result.content).toContain("Namespace: payments");
    expect(result.content).toContain("State: waiting (CrashLoopBackOff)");
    expect(result.content).toContain("Previous state: terminated (OOMKilled)");
    expect(result.content).toContain("Exit code: 137");
    expect(result.content).not.toContain("super-secret-value");
    expect(result.content).not.toContain("REDIS_PASSWORD");
    expect(result.content).not.toContain("not-for-model-context");
    expect(result.content).not.toContain("checkout-secrets");
    expect(result.bytes).toBeLessThanOrEqual(MAX_KUBERNETES_DESCRIBE_BYTES);
    expect(result.truncated).toBe(false);
  });

  test("publishes a strict schema and rejects unsafe kinds and resource names", async () => {
    expect(kubectlDescribeDefinition).toEqual({
      name: "kubectl_describe",
      description: expect.any(String),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name", "namespace"],
        properties: {
          kind: { type: "string", enum: ["pod", "deployment", "replicaset"] },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 253,
            pattern:
              "^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$",
          },
          namespace: {
            type: "string",
            minLength: 1,
            maxLength: 63,
            pattern: "^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$",
          },
        },
      },
    });

    let calls = 0;
    const api: KubernetesDescribeApi = {
      getResource: async () => {
        calls += 1;
        return oomKilledPodFixture;
      },
    };
    const invalidInputs: readonly KubectlDescribeInput[] = [
      { kind: "secret", name: "checkout-api", namespace: "payments" } as unknown as KubectlDescribeInput,
      { kind: "pod", name: "Checkout_API", namespace: "payments" },
      { kind: "pod", name: "checkout..api", namespace: "payments" },
      { kind: "deployment", name: "checkout-api", namespace: "payments/prod" },
      {
        kind: "replicaset",
        name: `${"a".repeat(64)}.payments`,
        namespace: "payments",
      },
    ];

    for (const invalidInput of invalidInputs) {
      await expect(kubectlDescribe(invalidInput, { api })).rejects.toBeInstanceOf(
        ToolInputError,
      );
    }
    expect(calls).toBe(0);
  });

  test("describes deployment rollout health from selected diagnostic fields", async () => {
    const deploymentFixture: unknown = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "checkout-api",
        namespace: "payments",
        generation: 8,
        creationTimestamp: "2026-07-24T08:00:00Z",
        annotations: { "private-note": "do-not-return-this" },
      },
      spec: {
        replicas: 4,
        minReadySeconds: 10,
        progressDeadlineSeconds: 600,
        strategy: { type: "RollingUpdate" },
        template: {
          spec: {
            containers: [
              { name: "checkout-api", env: [{ name: "TOKEN", value: "hidden" }] },
            ],
          },
        },
      },
      status: {
        observedGeneration: 8,
        replicas: 4,
        updatedReplicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
        unavailableReplicas: 1,
        conditions: [
          {
            type: "Progressing",
            status: "True",
            reason: "ReplicaSetUpdated",
            message: "ReplicaSet checkout-api-6f6dc7d95b is progressing.",
            lastUpdateTime: "2026-07-25T14:01:00Z",
          },
        ],
      },
    };
    const api: KubernetesDescribeApi = {
      getResource: async () => deploymentFixture,
    };

    const result = await kubectlDescribe(
      { kind: "deployment", name: "checkout-api", namespace: "payments" },
      { api },
    );

    expect(result.content).toContain("Generation: 8");
    expect(result.content).toContain("Strategy: RollingUpdate");
    expect(result.content).toContain("Desired replicas: 4");
    expect(result.content).toContain("Updated replicas: 3");
    expect(result.content).toContain("Unavailable replicas: 1");
    expect(result.content).toContain("Progressing: True (ReplicaSetUpdated)");
    expect(result.content).not.toContain("do-not-return-this");
    expect(result.content).not.toContain("hidden");
  });

  test("describes replica-set availability and labeling health", async () => {
    const replicaSetFixture: unknown = {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: { name: "checkout-api-6f6dc7d95b", namespace: "payments" },
      spec: {
        replicas: 4,
        minReadySeconds: 10,
        template: {
          spec: {
            containers: [{ name: "checkout-api", env: [{ value: "raw-secret" }] }],
          },
        },
      },
      status: {
        replicas: 4,
        fullyLabeledReplicas: 4,
        readyReplicas: 3,
        availableReplicas: 3,
        conditions: [
          {
            type: "ReplicaFailure",
            status: "True",
            reason: "FailedCreate",
            message: "One replacement pod could not be created.",
          },
        ],
      },
    };
    const api: KubernetesDescribeApi = {
      getResource: async () => replicaSetFixture,
    };

    const result = await kubectlDescribe(
      {
        kind: "replicaset",
        name: "checkout-api-6f6dc7d95b",
        namespace: "payments",
      },
      { api },
    );

    expect(result.content).toContain("Desired replicas: 4");
    expect(result.content).toContain("Fully labeled replicas: 4");
    expect(result.content).toContain("Ready replicas: 3");
    expect(result.content).toContain("ReplicaFailure: True (FailedCreate)");
    expect(result.content).not.toContain("raw-secret");
  });

  test("deterministically truncates oversized diagnostics with UTF-8 head and tail", async () => {
    const api: KubernetesDescribeApi = {
      getResource: async () => oversizedPodFixture,
    };
    const input = {
      kind: "pod",
      name: "oversized-diagnostic",
      namespace: "payments",
    } as const;

    const first = await kubectlDescribe(input, { api });
    const second = await kubectlDescribe(input, { api });

    expect(first.content).toBe(second.content);
    expect(first.content).toContain("HEAD_SENTINEL");
    expect(first.content).toContain("TAIL_SENTINEL");
    expect(first.content).toContain("--- output omitted; showing head and tail ---");
    expect(first.content).not.toContain("oversized-secret-must-not-leak");
    expect(first.content).not.toContain("oversized-token-must-not-leak");
    expect(first.bytes).toBe(utf8ByteLength(first.content));
    expect(first.bytes).toBeLessThanOrEqual(MAX_KUBERNETES_DESCRIBE_BYTES);
    expect(first.truncated).toBe(true);
    expect(first.truncationReasons).toEqual(["describe_output_limit"]);
  });
});
