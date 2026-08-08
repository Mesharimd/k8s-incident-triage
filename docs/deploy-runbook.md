# Production deployment runbook

This runbook deploys `k8s-incident-triage` into the
`production-cluster-in-a-box` cluster. Run the steps in order. Never commit a
plaintext Secret, local environment file, API key, bot token, or chat ID.

Use one full 40-character commit SHA as `<BOT_GIT_SHA>` everywhere below. It
must be the bot-repository commit containing the image workflow and chart being
deployed.

## 1. Enable the image workflow and publish the image

Before pushing, open the bot repository's **Settings → Actions → General** and
ensure GitHub Actions is enabled. The repository must allow the actions used by
`.github/workflows/image.yml`.

From the bot repository, confirm the commit and push it to `main`:

```sh
git switch main
git status --short
git rev-parse HEAD
git push origin main
```

The push starts the **Container image** workflow. It builds `linux/amd64` and
publishes both of these tags with the built-in `GITHUB_TOKEN`:

```text
ghcr.io/mesharimd/k8s-incident-triage:latest
ghcr.io/mesharimd/k8s-incident-triage:<BOT_GIT_SHA>
```

Wait for the exact run to pass before continuing:

```sh
gh run list \
  --repo Mesharimd/k8s-incident-triage \
  --workflow image.yml \
  --branch main \
  --limit 1

gh run watch '<IMAGE_WORKFLOW_RUN_ID>' \
  --repo Mesharimd/k8s-incident-triage \
  --exit-status
```

## 2. Make the GHCR package public

The first successful push creates the package. Open the package page while
signed in as its owner:

1. Open **Mesharimd → Packages → k8s-incident-triage**.
2. Open **Package settings**.
3. Under **Danger Zone**, choose **Change package visibility → Public** and
   confirm the package name.

Verify that the immutable tag can be pulled without registry credentials:

```sh
(
  set -eu
  anonymous_docker_config="$(mktemp -d)"
  trap 'rm -f "$anonymous_docker_config/config.json"; rmdir "$anonymous_docker_config"' EXIT
  DOCKER_CONFIG="$anonymous_docker_config" \
    docker manifest inspect \
    'ghcr.io/mesharimd/k8s-incident-triage:<BOT_GIT_SHA>' \
    >/dev/null
)
```

Do not continue while the package is private; this deployment intentionally
does not create an image-pull Secret.

## 3. Add the namespace and seal `triage-env`

Work in the `production-cluster-in-a-box` repository. The namespace is a plain
root-app manifest, matching the existing monitoring namespace pattern. Save
this as `argocd/apps/k8s-incident-triage-namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: k8s-incident-triage
  annotations:
    argocd.argoproj.io/sync-wave: "0"
    argocd.argoproj.io/sync-options: Prune=false,Delete=false
  labels:
    app.kubernetes.io/part-of: production-cluster-in-a-box
```

The following is the exact sealing command. Replace only
`<OPENROUTER_MODEL>` before running it. API keys and Telegram values are read
silently, kept out of command arguments and files, and piped directly into
`kubeseal`. Do not run it with shell tracing enabled.

```bash
(
  set -euo pipefail

  TRIAGE_OPENROUTER_MODEL='<OPENROUTER_MODEL>'

  printf 'OpenRouter API key: ' >&2
  IFS= read -r -s TRIAGE_OPENROUTER_API_KEY
  printf '\nTelegram bot token: ' >&2
  IFS= read -r -s TRIAGE_TELEGRAM_BOT_TOKEN
  printf '\nTelegram private chat or channel ID: ' >&2
  IFS= read -r -s TRIAGE_TELEGRAM_CHAT_ID
  printf '\n' >&2

  test -n "$TRIAGE_OPENROUTER_MODEL"
  test -n "$TRIAGE_OPENROUTER_API_KEY"
  test -n "$TRIAGE_TELEGRAM_BOT_TOKEN"
  test -n "$TRIAGE_TELEGRAM_CHAT_ID"

  {
    printf '%s\n' \
      'PORT=3000' \
      'ALERT_DEBOUNCE_SECONDS=300' \
      'MIN_SEVERITY=critical' \
      'NAMESPACE_ALLOWLIST=' \
      'NAMESPACE_DENYLIST=kube-system' \
      'INCIDENT_STATE_CAPACITY=1000' \
      'INCIDENT_QUEUE_CAPACITY=100' \
      'INCIDENT_CONCURRENCY=2' \
      'LLM_PROVIDER=openrouter' \
      'AGENT_MAX_TOOL_CALLS=10' \
      'AGENT_CONTEXT_TOKENS=32000' \
      'AGENT_MAX_OUTPUT_TOKENS=4096' \
      'AGENT_CONTEXT_SAFETY_TOKENS=1024' \
      'AGENT_INCIDENT_TIMEOUT_MS=75000' \
      'TRACE_DIR=/var/lib/k8s-incident-triage/traces' \
      "OPENROUTER_MODEL=$TRIAGE_OPENROUTER_MODEL" \
      'OPENROUTER_TIMEOUT_MS=15000' \
      'OPENROUTER_MAX_RETRIES=0' \
      'TELEGRAM_TIMEOUT_MS=40000'
    printf 'OPENROUTER_API_KEY=%s\n' "$TRIAGE_OPENROUTER_API_KEY"
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TRIAGE_TELEGRAM_BOT_TOKEN"
    printf 'TELEGRAM_CHAT_ID=%s\n' "$TRIAGE_TELEGRAM_CHAT_ID"
  } \
  | kubectl create secret generic triage-env \
      --namespace k8s-incident-triage \
      --from-env-file=/dev/stdin \
      --dry-run=client \
      --output=yaml \
  | kubeseal \
      --controller-name sealed-secrets-controller \
      --controller-namespace sealed-secrets \
      --scope strict \
      --format=yaml \
  | kubectl annotate \
      --local \
      --filename=- \
      'argocd.argoproj.io/sync-wave=55' \
      --output=yaml \
  > argocd/apps/k8s-incident-triage-sealedsecret.yaml
)
```

The chart owns `PROMETHEUS_URL`, so it is deliberately absent from
`triage-env`. Production also omits local Kubernetes API overrides, inactive
Anthropic settings, and all live-test flags.

Validate the encrypted manifest against the live controller certificate:

```sh
kubeseal \
  --controller-name sealed-secrets-controller \
  --controller-namespace sealed-secrets \
  --validate \
  < argocd/apps/k8s-incident-triage-sealedsecret.yaml
```

Only the encrypted `SealedSecret` file belongs in git. Confirm that its resource
name and namespace are both exact before continuing:

```sh
kubectl apply \
  --dry-run=client \
  --filename argocd/apps/k8s-incident-triage-sealedsecret.yaml \
  --output=name
```

## 4. Add the Argo CD Application

Save this as `argocd/apps/k8s-incident-triage.yaml`. Replace both occurrences
of `<BOT_GIT_SHA>` with the same full SHA published in step 1.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: k8s-incident-triage
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "60"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/Mesharimd/k8s-incident-triage.git
    targetRevision: "<BOT_GIT_SHA>"
    path: deploy/chart
    helm:
      releaseName: k8s-incident-triage
      values: |
        fullnameOverride: k8s-incident-triage
        image:
          repository: ghcr.io/mesharimd/k8s-incident-triage
          tag: "<BOT_GIT_SHA>"
          pullPolicy: IfNotPresent
        serviceAccount:
          create: true
          name: k8s-incident-triage
        rbac:
          create: true
        environment:
          existingSecret: triage-env
        service:
          port: 80
        container:
          port: 3000
        prometheus:
          url: http://prometheus-operated.monitoring.svc:9090
  destination:
    server: https://kubernetes.default.svc
    namespace: k8s-incident-triage
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

The chart renders the ServiceAccount, ClusterRole, and ClusterRoleBinding with
the same names and read-only rules as `deploy/rbac.yaml`; the Application does
not need a second source.

## 5. Route critical alerts from kube-prometheus-stack

Edit `argocd/apps/kube-prometheus-stack.yaml` in the cluster repository. Merge
the following fields into the existing top-level `alertmanager:` and
`prometheus:` blocks inside `helm.values`. Do not add duplicate top-level YAML
keys, and keep the existing resource limits and other stack settings.

```yaml
alertmanager:
  enabled: true
  config:
    route:
      routes:
        - receiver: "null"
          matchers:
            - 'alertname = "Watchdog"'
        - receiver: k8s-incident-triage
          group_by:
            - alertname
            - namespace
            - pod
          group_wait: 10s
          group_interval: 1m
          repeat_interval: 5m
          matchers:
            - 'severity = "critical"'
    receivers:
      - name: "null"
      - name: k8s-incident-triage
        webhook_configs:
          - url: http://k8s-incident-triage.k8s-incident-triage.svc:80/alerts
            send_resolved: true

prometheus:
  prometheusSpec:
    disableAlerting: false
```

The quoted `"null"` receiver and Watchdog route preserve the chart's existing
sink when the receiver and route lists are replaced. `disableAlerting: false`
is required; without it Prometheus does not send firing alerts to Alertmanager.
This route handles existing critical `PrometheusRule` alerts but does not create
new alerting rules. The repository's demo alerts (`deploy/demo/`) are labeled
`critical` and exercise this route end to end; the critical-only matcher keeps
the stack's many default `warning` rules from paging the bot.

Commit the namespace, SealedSecret, Application, and monitoring values change
together, then push the cluster repository:

```sh
git add \
  argocd/apps/k8s-incident-triage-namespace.yaml \
  argocd/apps/k8s-incident-triage-sealedsecret.yaml \
  argocd/apps/k8s-incident-triage.yaml \
  argocd/apps/kube-prometheus-stack.yaml
git diff --cached --check
git commit -m 'Add Kubernetes incident triage'
git push origin main
```

## 6. Verify reconciliation

The root app creates the namespace at wave 0, the SealedSecret at wave 55, and
the triage Application at wave 60. Verify only names and readiness; do not print
Secret data:

```sh
kubectl --namespace argocd get application k8s-incident-triage
kubectl --namespace k8s-incident-triage get secret triage-env --output=name
kubectl --namespace k8s-incident-triage rollout status \
  deployment/k8s-incident-triage \
  --timeout=5m
kubectl --namespace k8s-incident-triage get service k8s-incident-triage
kubectl --namespace monitoring rollout status \
  statefulset/alertmanager-monitoring-kube-prometheus-alertmanager \
  --timeout=5m
```

The stable webhook endpoint is:

```text
http://k8s-incident-triage.k8s-incident-triage.svc:80/alerts
```
