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

describe("Helm deployment contract", () => {
  const expectedFiles = [
    "deploy/chart/Chart.yaml",
    "deploy/chart/values.yaml",
    "deploy/chart/templates/_helpers.tpl",
    "deploy/chart/templates/alertmanagerconfig.yaml",
    "deploy/chart/templates/configmap.yaml",
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
    const configMap = await readRepositoryFile(
      "deploy/chart/templates/configmap.yaml",
    );
    const values = await readRepositoryFile("deploy/chart/values.yaml");

    expect(deployment).toContain("kind: Deployment");
    expect(deployment).toContain(
      "replicaCount must remain 1 because incident dedupe is process-local",
    );
    expect(deployment).toContain("configMapRef:");
    expect(deployment).toContain("secretKeyRef:");
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
    expect(configMap).toContain("PROMETHEUS_URL:");
    expect(configMap).toContain("INCIDENT_STATE_CAPACITY:");
    expect(configMap).toContain("INCIDENT_QUEUE_CAPACITY:");
    expect(configMap).toContain("INCIDENT_CONCURRENCY:");
    expect(configMap).toContain("TELEGRAM_TIMEOUT_MS:");
    expect(configMap).toContain("TRACE_DIR:");
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

  test("references external credentials without rendering a Secret", async () => {
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

    expect(deployment).toContain("ANTHROPIC_API_KEY");
    expect(deployment).toContain("TELEGRAM_BOT_TOKEN");
    expect(deployment).toContain("TELEGRAM_CHAT_ID");
    expect(values).toContain("existingSecret:");
    expect(values).toContain("anthropicApiKeyKey:");
    expect(values).toContain("telegramBotTokenKey:");
    expect(values).toContain("telegramChatIdKey:");
    expect(allTemplates).not.toMatch(/kind:\s*Secret\b/);
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
