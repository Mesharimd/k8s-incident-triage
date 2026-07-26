# k8s-incident-triage Helm chart

This chart installs the receiver Service, a single-replica Deployment, and an
optional read-only ServiceAccount/ClusterRole. It never creates a Kubernetes
Secret.

Create the credentials through the cluster's secret-management flow with these
keys:

- `anthropic-api-key`
- `telegram-bot-token`
- `telegram-chat-id`

By default, the Deployment references a Secret with the Helm release's full
name. Set `secrets.existingSecret` to reuse a differently named Secret. To reuse
RBAC managed elsewhere, set `serviceAccount.create=false`,
`serviceAccount.name=<name>`, and `rbac.create=false`.

The chart enables an ingress `NetworkPolicy` by default. It permits the webhook
port only from namespaces labeled `kubernetes.io/metadata.name: monitoring`.
Set `networkPolicy.alertmanagerNamespaceSelector` to the live Alertmanager
namespace labels, and optionally narrow `alertmanagerPodSelector` after
inspecting the operator-managed Pod labels. This protection requires a CNI that
enforces Kubernetes NetworkPolicy; verify it during the cluster install. Do not
disable the policy unless the cluster provides an equivalent authenticated or
network-isolated receiver path.

The trace and `/tmp` mounts are bounded ephemeral `emptyDir` volumes. Their
default limits are configured through `storage.traces.sizeLimit` and
`storage.tmp.sizeLimit`, while the container has matching finite
`ephemeral-storage` requests and limits. Trace files disappear when the Pod is
replaced; configure the cluster's approved logging or telemetry collector to
export them when retention is required.

On `SIGTERM` or `SIGINT`, the process stops accepting work, makes `/readyz`
fail, cancels queued incidents, lets already-active incidents settle, and then
stops the HTTP server. The default 120-second termination grace covers the
configured 75-second triage and 40-second Telegram deadlines. Multi-part
Telegram reports are paced at one message per second; a report whose mandatory
pacing cannot fit its configured deadline is rejected before the first part to
avoid a guaranteed partial delivery. The queue and
dedupe state are intentionally in memory: a hard crash, node loss, or incident
still pending when graceful shutdown begins can be lost after its webhook was
acknowledged. Treat delivery as at-most-once until a durable queue is added.
Telegram delivery is also non-transactional: a timeout can occur after Telegram
accepted a request but before the response arrived, and a cancelled multi-part
report can leave earlier parts visible. The runtime retains incident dedupe after
any Telegram error and logs sent/total part counts to avoid amplifying ambiguous
or partial sends. Every multi-part message should therefore be treated as one
report, not as an independent remediation instruction.

For Prometheus Operator installations, `alertmanagerConfig.enabled=true`
creates an `AlertmanagerConfig` whose webhook points at the in-cluster Service.
Enabling it also requires an explicit `alertmanagerConfig.scope`:

- `OnNamespace` is the safe default behavior. Set
  `alertmanagerConfig.namespace` to the target workload namespace carried by
  the alerts (for example, `payments`), not merely the Alertmanager namespace.
  The chart renders an exact matcher for that namespace, so the route remains
  scoped even when the cluster-owned Alertmanager uses matcher strategy `None`.
  Do not add a second `namespace` entry to
  `alertmanagerConfig.route.matchers`; the chart owns this matcher. The
  cluster-owned Alertmanager must also select AlertmanagerConfigs from that
  namespace through `spec.alertmanagerConfigNamespaceSelector`; this chart does
  not change that cluster-level selector.
- `Global` is valid only after the cluster-owned Alertmanager has been inspected
  and `spec.alertmanagerConfigMatcherStrategy.type: None` has been verified.
  Otherwise, the operator's namespace matcher still prevents global routing.
  If the config is placed outside the Alertmanager namespace, its
  `spec.alertmanagerConfigNamespaceSelector` must select that namespace too.

For example, namespace-scoped routing for alerts from `payments` uses:

```sh
helm upgrade --install k8s-incident-triage ./deploy/chart \
  --namespace incident-triage \
  --set alertmanagerConfig.enabled=true \
  --set alertmanagerConfig.scope=OnNamespace \
  --set alertmanagerConfig.namespace=payments
```

Set `alertmanagerConfig.labels` when the cluster-owned Alertmanager uses an
`alertmanagerConfigSelector`. Leave the feature disabled when the CRD is
unavailable or until these cluster-owned selectors and matcher strategy have
been verified. The Prometheus Operator forces `continue: true` on the generated
first-level route, so matching alerts continue through the existing
Alertmanager routing tree.

Build the DigitalOcean droplet image explicitly for x86-64:

```sh
docker buildx build --platform linux/amd64 --tag ghcr.io/mesharimd/k8s-incident-triage:0.1.0 .
```

In production GitOps values, pin `image.digest` to the published `sha256:`
digest rather than relying on a mutable tag.
