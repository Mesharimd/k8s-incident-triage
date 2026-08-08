import { describe, expect, test } from "bun:test";

async function readRepositoryFile(path: string): Promise<string> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

async function repositoryFileExists(path: string): Promise<boolean> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).exists();
}

describe("production container contract", () => {
  test("uses a reproducible non-root Bun runtime with an explicit health check", async () => {
    expect(await repositoryFileExists("Dockerfile")).toBe(true);
    const dockerfile = await readRepositoryFile("Dockerfile");

    expect(dockerfile).toContain("ARG BUN_VERSION=1.2.15");
    expect(dockerfile).toContain("oven/bun:${BUN_VERSION}-alpine");
    expect(dockerfile).toContain("bun install --frozen-lockfile --production");
    expect(dockerfile).toContain("USER bun");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/healthz");
    expect(dockerfile).toContain('CMD ["bun", "run", "src/server.ts"]');
    expect(dockerfile).not.toContain("COPY . .");

    const server = await readRepositoryFile("src/server.ts");
    expect(server).toContain('hostname: "0.0.0.0"');
  });

  test("excludes local state and secrets from the build context", async () => {
    expect(await repositoryFileExists(".dockerignore")).toBe(true);
    const ignored = (await readRepositoryFile(".dockerignore"))
      .split("\n")
      .map((line) => line.trim());

    for (const path of [".env", ".git", "node_modules", "traces", "traces-test"]) {
      expect(ignored).toContain(path);
    }
  });
});

describe("container image publishing contract", () => {
  test("publishes linux/amd64 latest and full-SHA tags to GHCR", async () => {
    const workflow = await readRepositoryFile(".github/workflows/image.yml");

    expect(workflow).toMatch(/push:\s*[\s\S]*branches:\s*[\s\S]*- main/);
    expect(workflow).toMatch(
      /permissions:\s*[\s\S]*contents: read[\s\S]*packages: write/,
    );
    expect(workflow).toContain("platforms: linux/amd64");
    expect(workflow).toContain(
      "ghcr.io/mesharimd/k8s-incident-triage:latest",
    );
    expect(workflow).toContain(
      "ghcr.io/mesharimd/k8s-incident-triage:${{ github.sha }}",
    );
    expect(workflow).toContain("password: ${{ secrets.GITHUB_TOKEN }}");

    const actionReferences = workflow
      .split("\n")
      .filter((line) => /^\s*uses:/.test(line));
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(
        /^\s*uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}(?:\s+#\s+.+)?\s*$/,
      );
    }
  });
});

describe("production deployment runbook contract", () => {
  test("documents the ordered GitHub, Sealed Secrets, Argo CD, and Alertmanager handoff", async () => {
    const runbook = await readRepositoryFile("docs/deploy-runbook.md");
    const orderedSections = [
      "## 1. Enable the image workflow and publish the image",
      "## 2. Make the GHCR package public",
      "## 3. Add the namespace and seal `triage-env`",
      "## 4. Add the Argo CD Application",
      "## 5. Route critical alerts from kube-prometheus-stack",
      "## 6. Verify reconciliation",
    ] as const;

    let previousIndex = -1;
    for (const section of orderedSections) {
      const currentIndex = runbook.indexOf(section);
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }

    expect(runbook).toContain("--controller-name sealed-secrets-controller");
    expect(runbook).toContain("--controller-namespace sealed-secrets");
    expect(runbook).toContain("--scope strict");
    expect(runbook).toContain(
      "> argocd/apps/k8s-incident-triage-sealedsecret.yaml",
    );
    expect(runbook).toContain(
      "repoURL: https://github.com/Mesharimd/k8s-incident-triage.git",
    );
    expect(runbook).toContain("path: deploy/chart");
    expect(runbook).not.toContain("sources:");
    expect(runbook).toContain("disableAlerting: false");
    expect(runbook).toContain("'severity = \"critical\"'");
    expect(runbook).toContain(
      "http://k8s-incident-triage.k8s-incident-triage.svc:80/alerts",
    );
  });

  test("validates rendered core resources with pinned strict schemas", async () => {
    const makefile = await readRepositoryFile("Makefile");

    expect(makefile).toContain(
      "ghcr.io/yannh/kubeconform:v0.7.0@sha256:85dbef6b4b312b99133decc9c6fc9495e9fc5f92293d4ff3b7e1b30f5611823c",
    );
    expect(makefile).toContain("KUBERNETES_SCHEMA_VERSION := 1.36.0");
    expect(makefile).toContain("rendered_manifest");
    expect(makefile).toContain("-schema-location");
    expect(makefile).toContain("-strict");
    expect(makefile).toContain("-summary");
  });
});

describe("Helm deployment contract", () => {
  const expectedFiles = [
    "deploy/chart/Chart.yaml",
    "deploy/chart/values.yaml",
    "deploy/chart/templates/_helpers.tpl",
    "deploy/chart/templates/alertmanagerconfig.yaml",
    "deploy/chart/templates/deployment.yaml",
    "deploy/chart/templates/networkpolicy.yaml",
    "deploy/chart/templates/rbac.yaml",
    "deploy/chart/templates/service.yaml",
    "deploy/chart/templates/serviceaccount.yaml",
  ] as const;

  test("contains the minimal installable workload resources", async () => {
    for (const path of expectedFiles) {
      expect(await repositoryFileExists(path)).toBe(true);
    }

    const deployment = await readRepositoryFile(
      "deploy/chart/templates/deployment.yaml",
    );
    const service = await readRepositoryFile("deploy/chart/templates/service.yaml");
    const values = await readRepositoryFile("deploy/chart/values.yaml");

    expect(deployment).toContain("kind: Deployment");
    expect(deployment).toContain(
      "replicaCount must remain 1 because incident dedupe is process-local",
    );
    expect(deployment).toContain("envFrom:");
    expect(deployment).toContain("secretRef:");
    expect(deployment).toContain(".Values.environment.existingSecret");
    expect(deployment).not.toContain("configMapRef:");
    expect(deployment).not.toContain("secretKeyRef:");
    expect(deployment).toContain("startupProbe:");
    expect(deployment).toContain("readinessProbe:");
    expect(deployment).toContain("livenessProbe:");
    expect(deployment.match(/httpGet:/g)).toHaveLength(3);
    expect(deployment.match(/path: \/healthz/g)).toHaveLength(2);
    expect(deployment).toContain("path: /readyz");
    expect(deployment).toContain(".Values.podSecurityContext");
    expect(deployment).toContain(".Values.securityContext");
    expect(deployment).toContain(
      "terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}",
    );
    expect(values).toContain("runAsNonRoot: true");
    expect(values).toContain("readOnlyRootFilesystem: true");
    expect(values).toContain("allowPrivilegeEscalation: false");
    expect(values).toContain("terminationGracePeriodSeconds: 120");
    expect(deployment).toContain("mountPath: /var/lib/k8s-incident-triage/traces");
    expect(service).toContain("kind: Service");
    expect(service).toContain("targetPort: http");
    expect(values).toContain("fullnameOverride: k8s-incident-triage");
    expect(values).toMatch(/service:\s*[\s\S]*port: 80/);
    expect(values).toMatch(/container:\s*[\s\S]*port: 3000/);
    expect(deployment).toContain("name: PROMETHEUS_URL");
    expect(deployment).toContain(".Values.prometheus.url");
    expect(values).toContain(
      "http://prometheus-operated.monitoring.svc:9090",
    );
  });

  test("bounds writable ephemeral storage and documents trace durability", async () => {
    const deployment = await readRepositoryFile(
      "deploy/chart/templates/deployment.yaml",
    );
    const values = await readRepositoryFile("deploy/chart/values.yaml");
    const readme = await readRepositoryFile("deploy/chart/README.md");

    expect(deployment).toContain(
      "storage.traces.sizeLimit must be a finite Kubernetes quantity",
    );
    expect(deployment).toContain(
      "storage.tmp.sizeLimit must be a finite Kubernetes quantity",
    );
    expect(values.match(/ephemeral-storage:/g)).toHaveLength(2);
    expect(values).toContain("sizeLimit: 128Mi");
    expect(values).toContain("sizeLimit: 64Mi");
    expect(readme).toContain("bounded ephemeral `emptyDir` volumes");
    expect(readme).toMatch(
      /Trace files disappear when the Pod is\s+replaced;[\s\S]*logging or telemetry collector/,
    );
  });

  test("imports the existing triage-env Secret without rendering secret data", async () => {
    const deployment = await readRepositoryFile(
      "deploy/chart/templates/deployment.yaml",
    );
    const values = await readRepositoryFile("deploy/chart/values.yaml");
    const allTemplates = (
      await Promise.all(
        expectedFiles
          .filter((path) => path.includes("/templates/"))
          .map((path) => readRepositoryFile(path)),
      )
    ).join("\n");

    expect(deployment).toContain("secretRef:");
    expect(deployment).toContain(".Values.environment.existingSecret");
    expect(deployment).not.toContain("secretKeyRef:");
    expect(values).toContain("existingSecret: triage-env");
    expect(values).not.toContain("anthropicApiKeyKey:");
    expect(values).not.toContain("telegramBotTokenKey:");
    expect(values).not.toContain("telegramChatIdKey:");
    expect(
      await repositoryFileExists("deploy/chart/templates/configmap.yaml"),
    ).toBe(false);
    expect(allTemplates).not.toMatch(/kind:\s*ConfigMap\b/);
    expect(allTemplates).not.toMatch(/kind:\s*Secret\b/);
  });

  test("reuses the standalone read-only ServiceAccount contract", async () => {
    const deployment = await readRepositoryFile(
      "deploy/chart/templates/deployment.yaml",
    );
    const serviceAccount = await readRepositoryFile(
      "deploy/chart/templates/serviceaccount.yaml",
    );
    const rbac = await readRepositoryFile("deploy/chart/templates/rbac.yaml");
    const values = await readRepositoryFile("deploy/chart/values.yaml");

    expect(values).toMatch(/serviceAccount:\s*[\s\S]*create: true/);
    expect(values).toMatch(
      /serviceAccount:\s*[\s\S]*name: k8s-incident-triage/,
    );
    expect(deployment).toContain(
      'serviceAccountName: {{ include "k8s-incident-triage.serviceAccountName" . }}',
    );
    expect(serviceAccount).toContain(
      'name: {{ include "k8s-incident-triage.serviceAccountName" . }}',
    );
    expect(rbac).toContain(
      'name: {{ include "k8s-incident-triage.serviceAccountName" . }}',
    );
  });

  test("grants only the read operations required by the five cluster tools", async () => {
    const rbac = await readRepositoryFile("deploy/chart/templates/rbac.yaml");
    const verbDeclarations = rbac.match(/verbs:\s*\[[^\]]+\]/g) ?? [];

    expect(verbDeclarations).toEqual([
      'verbs: ["get", "list"]',
      'verbs: ["get"]',
      'verbs: ["get", "list"]',
    ]);
    expect(rbac).not.toContain("pods/exec");
  });

  test("restricts webhook ingress to the configured Alertmanager namespace", async () => {
    const policy = await readRepositoryFile(
      "deploy/chart/templates/networkpolicy.yaml",
    );
    const values = await readRepositoryFile("deploy/chart/values.yaml");
    const readme = await readRepositoryFile("deploy/chart/README.md");

    expect(policy).toContain("kind: NetworkPolicy");
    expect(policy).toContain("policyTypes:");
    expect(policy).toContain("namespaceSelector:");
    expect(policy).toContain("alertmanagerNamespaceSelector");
    expect(policy).toContain("alertmanagerPodSelector");
    expect(values).toContain("networkPolicy:");
    expect(values).toContain("enabled: true");
    expect(values).toContain("kubernetes.io/metadata.name: monitoring");
    expect(readme).toContain("requires a CNI that");
    expect(readme).toContain("equivalent authenticated or");
  });

  test("can opt into chart-managed Alertmanager webhook wiring", async () => {
    const alertmanagerConfig = await readRepositoryFile(
      "deploy/chart/templates/alertmanagerconfig.yaml",
    );
    const values = await readRepositoryFile("deploy/chart/values.yaml");
    const readme = await readRepositoryFile("deploy/chart/README.md");

    expect(alertmanagerConfig).toContain(".Values.alertmanagerConfig.enabled");
    expect(alertmanagerConfig).toContain(
      "alertmanagerConfig.scope must be explicitly set to OnNamespace or Global",
    );
    expect(alertmanagerConfig).toContain('(list "OnNamespace" "Global")');
    expect(alertmanagerConfig).toContain(
      "alertmanagerConfig.namespace must be the target workload namespace",
    );
    expect(alertmanagerConfig).toContain(
      "alertmanagerConfig.route.matchers must not set namespace",
    );
    expect(alertmanagerConfig).toContain("kind: AlertmanagerConfig");
    expect(alertmanagerConfig).toContain("- name: namespace");
    expect(alertmanagerConfig).toContain("matchType: \"=\"");
    expect(alertmanagerConfig).toContain("/alerts");
    expect(alertmanagerConfig).toContain("sendResolved: true");
    expect(values).toContain("alertmanagerConfig:");
    expect(values).toContain("enabled: false");
    expect(values).toContain('scope: ""');
    expect(readme).toContain("target workload namespace");
    expect(readme).toContain("chart owns this matcher");
    expect(readme).toContain("continue: true");
    expect(readme).toContain("spec.alertmanagerConfigNamespaceSelector");
    expect(readme).toContain(
      "spec.alertmanagerConfigMatcherStrategy.type: None",
    );
  });
});
