import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface MakeResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function dryRunDemo(target: string, kubeContext: string): MakeResult {
  const result = Bun.spawnSync({
    cmd: ["make", "--no-print-directory", "--dry-run", target],
    cwd: repositoryRoot,
    env: {
      HOME: process.env.HOME ?? repositoryRoot,
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      DEMO_NAMESPACE: "must-not-be-used",
      KUBECTL: "kubectl",
      KUBE_CONTEXT: kubeContext,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

async function readRepositoryFile(path: string): Promise<string> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

describe("operator demo contract", () => {
  test("each guarded target owns one namespace, bounded failure, and scoped alert rule", async () => {
    const demoNamespace = "k8s-incident-triage-demo";
    const namespacePath = "deploy/demo/namespace.yaml";
    const scenarios = [
      {
        alert: "K8sIncidentDemoOOMKilled",
        manifestPath: "deploy/demo/oom.yaml",
        namespaceMatcherCount: 1,
        signals: ["memory-hog", "OOMKilled", "memory: 24Mi"],
        target: "demo-oom",
      },
      {
        alert: "K8sIncidentDemoImagePullBackOff",
        manifestPath: "deploy/demo/crash.yaml",
        namespaceMatcherCount: 1,
        signals: ["definitely-missing", "ImagePullBackOff", "ErrImagePull"],
        target: "demo-crash",
      },
      {
        alert: "K8sIncidentDemoCPUStarvation",
        manifestPath: "deploy/demo/latency.yaml",
        namespaceMatcherCount: 2,
        signals: ["cpu-hog", "container_cpu_cfs_throttled_periods_total", "cpu: 10m"],
        target: "demo-latency",
      },
    ] as const;

    for (const scenario of scenarios) {
      const unscoped = dryRunDemo(scenario.target, "");
      expect(unscoped.exitCode).not.toBe(0);
      expect(unscoped.stderr).toContain("KUBE_CONTEXT is required");

      const scoped = dryRunDemo(scenario.target, "demo-context");
      expect(scoped.exitCode).toBe(0);
      expect(scoped.stderr).toBe("");
      const namespaceApply =
        `kubectl --context "demo-context" apply --filename "${namespacePath}"`;
      const scenarioApply =
        `kubectl --context "demo-context" apply --filename "${scenario.manifestPath}"`;
      expect(scoped.stdout).toContain(namespaceApply);
      expect(scoped.stdout).toContain(scenarioApply);
      expect(scoped.stdout.indexOf(namespaceApply)).toBeLessThan(
        scoped.stdout.indexOf(scenarioApply),
      );
      expect(scoped.stdout).not.toContain("must-not-be-used");

      const manifest = await readRepositoryFile(scenario.manifestPath);
      expect(manifest).toContain("kind: Deployment");
      expect(manifest).toContain("kind: PrometheusRule");
      expect(manifest).toContain("replicas: 1");
      expect(manifest).toContain("resources:");
      expect(manifest).toContain("limits:");
      expect(manifest).toContain(
        "app.kubernetes.io/part-of: k8s-incident-triage-demo",
      );
      expect(manifest).toContain(
        `incident-triage.meshari.dev/scenario: ${scenario.target.replace("demo-", "")}`,
      );
      expect(manifest.match(new RegExp(`namespace: ${demoNamespace}`, "g"))).toHaveLength(
        2,
      );
      expect(manifest).toContain(`alert: ${scenario.alert}`);
      expect(
        manifest.match(new RegExp(`namespace="${demoNamespace}"`, "g")),
      ).toHaveLength(scenario.namespaceMatcherCount);
      expect(manifest).not.toContain('namespace=~"');
      expect(manifest).toContain('severity: "warning"');
      expect(manifest).toContain('demo: "true"');
      expect(manifest).toContain("for: 30s");
      expect(manifest).toContain(
        "# Live prerequisite: Prometheus must select this namespace and release label.",
      );

      for (const signal of scenario.signals) {
        expect(manifest).toContain(signal);
      }

      expect(manifest).not.toContain("privileged: true");
      expect(manifest).not.toContain("hostNetwork: true");
      expect(manifest).not.toContain("hostPID: true");
      expect(manifest).not.toContain("hostPath:");
      expect(manifest).not.toMatch(/kind:\s*(?:ClusterRole|RoleBinding|ServiceAccount)\b/);
    }

    const crashManifest = await readRepositoryFile("deploy/demo/crash.yaml");
    expect(crashManifest).toContain("max by (namespace, pod, container) (");
    expect(crashManifest).not.toMatch(/max by\s*\([^)]*\breason\b[^)]*\)/);

    const namespace = await readRepositoryFile(namespacePath);
    expect(namespace).toContain("kind: Namespace");
    expect(namespace).toContain(`name: ${demoNamespace}`);
    expect(namespace).toContain(
      "app.kubernetes.io/part-of: k8s-incident-triage-demo",
    );
    for (const mode of ["enforce", "audit", "warn"] as const) {
      expect(namespace).toContain(
        `pod-security.kubernetes.io/${mode}: restricted`,
      );
    }

    const makefile = await readRepositoryFile("Makefile");
    expect(makefile).not.toContain("DEMO_NAMESPACE");

    const cleanup = dryRunDemo("demo-clean", "demo-context");
    expect(cleanup.exitCode).toBe(0);
    expect(cleanup.stderr).toBe("");
    expect(cleanup.stdout).toBe(
      'kubectl --context "demo-context" delete --ignore-not-found --filename "deploy/demo/oom.yaml"\n' +
        'kubectl --context "demo-context" delete --ignore-not-found --filename "deploy/demo/crash.yaml"\n' +
        'kubectl --context "demo-context" delete --ignore-not-found --filename "deploy/demo/latency.yaml"\n',
    );
    expect(cleanup.stdout).not.toContain(namespacePath);
  });
});

describe("offline demo validation contract", () => {
  test("checks exactly three Prometheus rules in an isolated immutable container", () => {
    const validation = dryRunDemo("check-demo-rules", "");

    expect(validation.exitCode).toBe(0);
    expect(validation.stderr).toBe("");

    const command = validation.stdout;
    expect(command).toContain("docker run --rm");
    expect(command).toContain("--network none");
    expect(command).toContain("--read-only");
    expect(command).toContain("--cap-drop ALL");
    expect(command).toContain("--security-opt no-new-privileges");
    expect(command).toContain(
      "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m",
    );
    expect(command.match(/--(?:volume|mount)\b/g)).toHaveLength(1);
    expect(command).toContain(
      `--volume "${repositoryRoot.replace(/\/$/, "")}/deploy/demo:/demo:ro"`,
    );
    expect(command).toContain("--entrypoint /bin/sh");
    expect(command).toContain(
      "prom/prometheus@sha256:497fe921f22fea8535fa2bcb1c193dacc6ce98c08274257b3d18a4eaae0f9647",
    );
    expect(command).toContain("-eu -c");

    expect(command.match(/\/demo\/(?:oom|crash|latency|namespace)\.yaml/g)).toEqual([
      "/demo/oom.yaml",
      "/demo/crash.yaml",
      "/demo/latency.yaml",
    ]);
    expect(command).not.toContain("/demo/*.yaml");
    expect(command).toContain("/^spec:$/");
    expect(command).toContain("/^  groups:$/");
    expect(command).toContain("/tmp/demo-rules.yaml");
    expect(command).toContain('test "$rule_count" -eq 3');
    expect(command).toContain(
      "/bin/promtool check rules /tmp/demo-rules.yaml",
    );
    expect(command).not.toContain("kubectl");
  });

  test("lints and renders every supported chart mode in an isolated immutable container", () => {
    const validation = dryRunDemo("check-chart", "");

    expect(validation.exitCode).toBe(0);
    expect(validation.stderr).toBe("");

    const command = validation.stdout;
    expect(command).toContain("docker run --rm");
    expect(command).toContain("--network none");
    expect(command).toContain("--read-only");
    expect(command).toContain("--cap-drop ALL");
    expect(command).toContain("--security-opt no-new-privileges");
    expect(command).toContain(
      "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m",
    );
    expect(command.match(/--(?:volume|mount)\b/g)).toHaveLength(1);
    expect(command).toContain(
      `--volume "${repositoryRoot.replace(/\/$/, "")}/deploy/chart:/chart:ro"`,
    );
    expect(command).toContain("--entrypoint /bin/sh");
    expect(command).toContain(
      "alpine/helm@sha256:9b25e60ae264940b276e32866d37e3088e70c4e2d1784b964dc3f90346281a74",
    );
    expect(command).toContain("-eu -c");
    expect(command).toContain("helm lint /chart");
    expect(command.match(/helm template verification \/chart/g)).toHaveLength(3);
    expect(command).toContain("--namespace incident-triage");
    expect(command).toContain("alertmanagerConfig.scope=OnNamespace");
    expect(command).toContain(
      "alertmanagerConfig.namespace=k8s-incident-triage-demo",
    );
    expect(command).toContain("alertmanagerConfig.scope=Global");
    expect(command).not.toContain("kubectl");
  });
});
