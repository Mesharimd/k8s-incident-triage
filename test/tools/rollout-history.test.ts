import { describe, expect, test } from "bun:test";

import {
  getRolloutHistory,
  getRolloutHistoryDefinition,
  type KubernetesRolloutApi,
} from "../../src/tools/rollout-history";
import { MAX_TOOL_RESULT_BYTES, ToolExecutionError, ToolInputError } from "../../src/tools/result";

interface RolloutFixture {
  readonly deployment: unknown;
  readonly replicaSets: unknown;
}

const rolloutFixture = (await Bun.file(
  new URL("../fixtures/rollout-history.json", import.meta.url),
).json()) as RolloutFixture;

describe("get_rollout_history", () => {
  test("returns the deployment's controller-owned ReplicaSets by numeric revision", async () => {
    const requests: unknown[] = [];
    const api: KubernetesRolloutApi = {
      readNamespacedDeployment: async (request) => {
        requests.push({ operation: "deployment", request });
        return rolloutFixture.deployment;
      },
      listNamespacedReplicaSets: async (request) => {
        requests.push({ operation: "replicaSets", request });
        return rolloutFixture.replicaSets;
      },
    };

    const result = await getRolloutHistory(
      { deployment: "checkout-api", namespace: "payments" },
      { api },
    );

    expect(requests).toEqual([
      {
        operation: "deployment",
        request: { name: "checkout-api", namespace: "payments" },
      },
      {
        operation: "replicaSets",
        request: {
          namespace: "payments",
          labelSelector: "app=checkout-api,component=api",
          limit: 500,
        },
      },
    ]);
    expect(JSON.parse(result.content)).toEqual({
      deployment: "checkout-api",
      namespace: "payments",
      selector: "app=checkout-api,component=api",
      currentRevision: 12,
      revisions: [
        {
          revision: 12,
          replicaSet: "checkout-api-6f5f8d4d76",
          createdAt: "2026-07-25T15:10:00.000Z",
          changeCause:
            "kubectl set image deployment/checkout-api checkout=registry.example.com/checkout:v42",
          images: ["registry.example.com/checkout:v42"],
          replicas: { desired: 1, ready: 0, available: 0 },
        },
        {
          revision: 11,
          replicaSet: "checkout-api-765694c86b",
          createdAt: "2026-07-24T10:30:00.000Z",
          changeCause: "release checkout-api v41",
          images: [
            "registry.example.com/checkout:v41",
            "registry.example.com/envoy:1.31.0",
          ],
          replicas: { desired: 0, ready: 0, available: 0 },
        },
        {
          revision: 9,
          replicaSet: "checkout-api-5b48f95f67",
          createdAt: "2026-07-22T09:00:00.000Z",
          changeCause: null,
          images: ["registry.example.com/checkout:v39"],
          replicas: { desired: 0, ready: 0, available: 0 },
        },
      ],
      scannedReplicaSets: 5,
      matchingReplicaSets: 3,
      omittedRevisions: 0,
      incomplete: false,
    });
    expect(result).toMatchObject({ truncated: false, truncationReasons: [] });
    expect(result.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  test("returns at most 10 revisions and marks bounded change causes incomplete", async () => {
    const deploymentUid = "2ee2db84-32f7-4b62-9c02-ffca7d30ce38";
    const replicaSets = Array.from({ length: 15 }, (_, index) => {
      const revision = index + 1;
      return {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: `checkout-api-revision-${revision}`,
          namespace: "payments",
          uid: `replicaset-${revision}`,
          creationTimestamp: new Date(
            Date.parse("2026-07-01T00:00:00Z") + revision * 60_000,
          ).toISOString(),
          annotations: {
            "deployment.kubernetes.io/revision": String(revision),
            "kubernetes.io/change-cause":
              revision === 15 ? "deploy 🚀".repeat(500) : `release ${revision}`,
          },
          ownerReferences: [
            {
              apiVersion: "apps/v1",
              kind: "Deployment",
              name: "checkout-api",
              uid: deploymentUid,
              controller: true,
            },
          ],
        },
        spec: {
          replicas: 0,
          template: {
            spec: {
              containers: [
                { name: "checkout", image: `registry.example.com/checkout:v${revision}` },
              ],
            },
          },
        },
        status: { replicas: 0 },
      };
    });
    const api: KubernetesRolloutApi = {
      readNamespacedDeployment: async () => rolloutFixture.deployment,
      listNamespacedReplicaSets: async () => ({
        apiVersion: "apps/v1",
        kind: "ReplicaSetList",
        metadata: { continue: "next-page-token", remainingItemCount: 5 },
        items: replicaSets,
      }),
    };

    const result = await getRolloutHistory(
      { deployment: "checkout-api", namespace: "payments" },
      { api },
    );
    const content = JSON.parse(result.content) as {
      revisions: readonly { revision: number; changeCause: string | null }[];
      matchingReplicaSets: number;
      omittedRevisions: number;
      incomplete: boolean;
    };

    expect(content.revisions.map(({ revision }) => revision)).toEqual([
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
    ]);
    expect(new TextEncoder().encode(content.revisions[0]?.changeCause ?? "").byteLength).toBeLessThanOrEqual(1_024);
    expect(content.matchingReplicaSets).toBe(15);
    expect(content.omittedRevisions).toBe(5);
    expect(content.incomplete).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual([
      "source_pagination",
      "revision_limit",
      "change_cause_limit",
    ]);
    expect(result.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  test("publishes a strict schema and rejects unsafe resource names", async () => {
    expect(getRolloutHistoryDefinition).toMatchObject({
      name: "get_rollout_history",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["deployment", "namespace"],
        properties: {
          deployment: {
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
          },
        },
      },
    });

    const api: KubernetesRolloutApi = {
      readNamespacedDeployment: async () => rolloutFixture.deployment,
      listNamespacedReplicaSets: async () => rolloutFixture.replicaSets,
    };
    await expect(
      getRolloutHistory(
        { deployment: "checkout-api/scale", namespace: "payments" },
        { api },
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      getRolloutHistory(
        {
          deployment: `${"a".repeat(64)}.payments`,
          namespace: "payments",
        },
        { api },
      ),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  test("rejects a non-numeric revision on a controller-owned ReplicaSet", async () => {
    const deployment = rolloutFixture.deployment as {
      readonly metadata: { readonly uid: string };
    };
    const api: KubernetesRolloutApi = {
      readNamespacedDeployment: async () => rolloutFixture.deployment,
      listNamespacedReplicaSets: async () => ({
        apiVersion: "apps/v1",
        kind: "ReplicaSetList",
        metadata: {},
        items: [
          {
            apiVersion: "apps/v1",
            kind: "ReplicaSet",
            metadata: {
              name: "checkout-api-invalid-revision",
              namespace: "payments",
              uid: "replicaset-invalid",
              creationTimestamp: "2026-07-25T15:10:00Z",
              annotations: { "deployment.kubernetes.io/revision": "latest" },
              ownerReferences: [
                {
                  apiVersion: "apps/v1",
                  kind: "Deployment",
                  name: "checkout-api",
                  uid: deployment.metadata.uid,
                  controller: true,
                },
              ],
            },
            spec: {
              replicas: 1,
              template: {
                spec: {
                  containers: [
                    { name: "checkout", image: "registry.example.com/checkout:v42" },
                  ],
                },
              },
            },
            status: { replicas: 1 },
          },
        ],
      }),
    };

    await expect(
      getRolloutHistory(
        { deployment: "checkout-api", namespace: "payments" },
        { api },
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});
