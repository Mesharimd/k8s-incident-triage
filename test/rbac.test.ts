import { describe, expect, test } from "bun:test";

const manifestText = await Bun.file(
  new URL("../deploy/rbac.yaml", import.meta.url),
).text();
const documents = manifestText.split(/^---\s*$/mu);

function documentFor(kind: string): string {
  const document = documents.find((candidate) =>
    new RegExp(`^kind: ${kind}$`, "mu").test(candidate),
  );
  if (document === undefined) {
    throw new Error(`${kind} document is required`);
  }
  return document;
}

describe("restricted Kubernetes RBAC", () => {
  test("grants only the exact get/list resource allowlist", () => {
    const role = documentFor("ClusterRole");
    expect(role).toContain(
      '  - apiGroups: [""]\n    resources: ["pods", "events"]\n    verbs: ["get", "list"]',
    );
    expect(role).toContain(
      '  - apiGroups: [""]\n    resources: ["pods/log"]\n    verbs: ["get"]',
    );
    expect(role).toContain(
      '  - apiGroups: ["apps"]\n    resources: ["deployments", "replicasets"]\n    verbs: ["get", "list"]',
    );
    expect(role.match(/^  - apiGroups:/gmu)).toHaveLength(3);
    expect(role).not.toMatch(/\["\*"\]|\bcreate\b|\bupdate\b|\bpatch\b|\bdelete\b|\bwatch\b/u);
    expect(role).not.toContain("pods/exec");
    expect(role).not.toContain("secrets");
  });

  test("binds the dedicated service account to the restricted role", () => {
    const serviceAccount = documentFor("ServiceAccount");
    const binding = documentFor("ClusterRoleBinding");
    expect(serviceAccount).toMatch(/name: k8s-incident-triage\n  namespace: k8s-incident-triage/u);
    expect(binding).toContain(
      "roleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: k8s-incident-triage-readonly",
    );
    expect(binding).toContain(
      "subjects:\n  - kind: ServiceAccount\n    name: k8s-incident-triage\n    namespace: k8s-incident-triage",
    );
  });
});

test.skipIf(Bun.env.K8S_RBAC_LIVE_TEST !== "1")(
  "restricted service account rejects a deliberate dry-run Pod write",
  async () => {
    const host = Bun.env.KUBERNETES_SERVICE_HOST;
    const port = Bun.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
    const namespace = Bun.env.K8S_RBAC_TEST_NAMESPACE ?? "default";
    if (host === undefined) {
      throw new Error("KUBERNETES_SERVICE_HOST is required for the live RBAC test");
    }
    const token = (
      await Bun.file(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
      ).text()
    ).trim();
    const ca = await Bun.file(
      "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    ).text();
    const response = await fetch(
      `https://${host}:${port}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?dryRun=All`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Pod",
          metadata: { generateName: "triage-rbac-denial-" },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "rbac-denial-probe",
                image: "registry.k8s.io/pause:3.10",
              },
            ],
          },
        }),
        tls: { ca, rejectUnauthorized: true },
      },
    );

    expect(response.status).toBe(403);
  },
);
