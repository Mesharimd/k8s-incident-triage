KUBECTL ?= kubectl
KUBE_CONTEXT ?=
DOCKER ?= docker

DEMO_MANIFEST_DIR := deploy/demo
PROMETHEUS_IMAGE := prom/prometheus@sha256:497fe921f22fea8535fa2bcb1c193dacc6ce98c08274257b3d18a4eaae0f9647
HELM_IMAGE := alpine/helm@sha256:9b25e60ae264940b276e32866d37e3088e70c4e2d1784b964dc3f90346281a74

.PHONY: demo-oom demo-crash demo-latency demo-clean
.PHONY: check-demo-rules check-chart

check-demo-rules:
	$(DOCKER) run --rm \
		--network none \
		--read-only \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m \
		--volume "$(CURDIR)/deploy/demo:/demo:ro" \
		--entrypoint /bin/sh \
		$(PROMETHEUS_IMAGE) \
		-eu -c '\
			printf "groups:\n" > /tmp/demo-rules.yaml; \
			for file in /demo/oom.yaml /demo/crash.yaml /demo/latency.yaml; do \
				awk "/^spec:$$/ { in_spec=1; next } in_spec && /^  groups:$$/ { in_groups=1; next } in_groups { sub(/^  /, \"\"); print }" "$$file" >> /tmp/demo-rules.yaml; \
			done; \
			rule_count="$$(grep -c "^[[:space:]]*- alert:" /tmp/demo-rules.yaml)"; \
			test "$$rule_count" -eq 3; \
			/bin/promtool check rules /tmp/demo-rules.yaml'

check-chart:
	$(DOCKER) run --rm \
		--network none \
		--read-only \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		--env HOME=/tmp \
		--env HELM_CACHE_HOME=/tmp/cache \
		--env HELM_CONFIG_HOME=/tmp/config \
		--env HELM_DATA_HOME=/tmp/data \
		--volume "$(CURDIR)/deploy/chart:/chart:ro" \
		--entrypoint /bin/sh \
		$(HELM_IMAGE) \
		-eu -c '\
			helm lint /chart; \
			helm template verification /chart --namespace incident-triage > /dev/null; \
			helm template verification /chart --namespace incident-triage --set alertmanagerConfig.enabled=true --set alertmanagerConfig.scope=OnNamespace --set alertmanagerConfig.namespace=k8s-incident-triage-demo > /dev/null; \
			helm template verification /chart --namespace incident-triage --set alertmanagerConfig.enabled=true --set alertmanagerConfig.scope=Global > /dev/null'

demo-oom:
	$(if $(strip $(KUBE_CONTEXT)),,$(error KUBE_CONTEXT is required; choose the cluster explicitly))
	$(KUBECTL) --context "$(KUBE_CONTEXT)" apply --filename "$(DEMO_MANIFEST_DIR)/namespace.yaml"
	$(KUBECTL) --context "$(KUBE_CONTEXT)" apply --filename "$(DEMO_MANIFEST_DIR)/oom.yaml"

demo-crash:
	$(if $(strip $(KUBE_CONTEXT)),,$(error KUBE_CONTEXT is required; choose the cluster explicitly))
	$(KUBECTL) --context "$(KUBE_CONTEXT)" apply --filename "$(DEMO_MANIFEST_DIR)/namespace.yaml"
	$(KUBECTL) --context "$(KUBE_CONTEXT)" apply --filename "$(DEMO_MANIFEST_DIR)/crash.yaml"

demo-latency:
	$(if $(strip $(KUBE_CONTEXT)),,$(error KUBE_CONTEXT is required; choose the cluster explicitly))
	$(KUBECTL) --context "$(KUBE_CONTEXT)" apply --filename "$(DEMO_MANIFEST_DIR)/namespace.yaml"
	$(KUBECTL) --context "$(KUBE_CONTEXT)" apply --filename "$(DEMO_MANIFEST_DIR)/latency.yaml"

# The demos intentionally keep failing until removed. Delete only the three
# scenario manifests; the namespace may predate this demo and deliberately stays.
demo-clean:
	$(if $(strip $(KUBE_CONTEXT)),,$(error KUBE_CONTEXT is required; choose the cluster explicitly))
	$(KUBECTL) --context "$(KUBE_CONTEXT)" delete --ignore-not-found --filename "$(DEMO_MANIFEST_DIR)/oom.yaml"
	$(KUBECTL) --context "$(KUBE_CONTEXT)" delete --ignore-not-found --filename "$(DEMO_MANIFEST_DIR)/crash.yaml"
	$(KUBECTL) --context "$(KUBE_CONTEXT)" delete --ignore-not-found --filename "$(DEMO_MANIFEST_DIR)/latency.yaml"
