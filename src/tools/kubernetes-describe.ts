import type { ToolDefinition } from "./definition";
import {
  isKubernetesDnsLabel,
  isKubernetesDnsSubdomain,
  KUBERNETES_DNS_LABEL_MAX_LENGTH,
  KUBERNETES_DNS_LABEL_PATTERN,
  KUBERNETES_DNS_SUBDOMAIN_MAX_LENGTH,
  KUBERNETES_DNS_SUBDOMAIN_PATTERN,
} from "./kubernetes-names";
import { ToolInputError, utf8ByteLength } from "./result";
import type { BoundedToolResult } from "./result";

export const MAX_KUBERNETES_DESCRIBE_BYTES = 12_000;

const OMISSION_MARKER = "\n\n--- output omitted; showing head and tail ---\n\n";
const KINDS: readonly KubernetesDescribeKind[] = [
  "pod",
  "deployment",
  "replicaset",
];

export type KubernetesDescribeKind = "pod" | "deployment" | "replicaset";

export interface KubectlDescribeInput {
  readonly kind: KubernetesDescribeKind;
  readonly name: string;
  readonly namespace: string;
}

export interface KubernetesDescribeRequest {
  readonly kind: KubernetesDescribeKind;
  readonly name: string;
  readonly namespace: string;
}

export interface KubernetesDescribeApi {
  getResource(request: KubernetesDescribeRequest): Promise<unknown>;
}

export interface KubectlDescribeDependencies {
  readonly api: KubernetesDescribeApi;
}

export const kubectlDescribeDefinition: ToolDefinition = {
  name: "kubectl_describe",
  description: "Return a bounded diagnostic summary for one Kubernetes resource.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "name", "namespace"],
    properties: {
      kind: { type: "string", enum: KINDS },
      name: {
        type: "string",
        minLength: 1,
        maxLength: KUBERNETES_DNS_SUBDOMAIN_MAX_LENGTH,
        pattern: KUBERNETES_DNS_SUBDOMAIN_PATTERN,
      },
      namespace: {
        type: "string",
        minLength: 1,
        maxLength: KUBERNETES_DNS_LABEL_MAX_LENGTH,
        pattern: KUBERNETES_DNS_LABEL_PATTERN,
      },
    },
  },
};

type UnknownObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown): UnknownObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownObject;
}

function objectAt(object: UnknownObject | undefined, key: string): UnknownObject | undefined {
  return asObject(object?.[key]);
}

function arrayAt(object: UnknownObject | undefined, key: string): readonly unknown[] {
  const value = object?.[key];
  return Array.isArray(value) ? value : [];
}

function stringAt(object: UnknownObject | undefined, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberAt(object: UnknownObject | undefined, key: string): number | undefined {
  const value = object?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanAt(object: UnknownObject | undefined, key: string): boolean | undefined {
  const value = object?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function metadataDiagnostic(resource: UnknownObject): readonly string[] {
  const metadata = objectAt(resource, "metadata");
  const lines: string[] = [];
  const created = stringAt(metadata, "creationTimestamp");
  if (created !== undefined) {
    lines.push(`Created: ${created}`);
  }
  const generation = numberAt(metadata, "generation");
  if (generation !== undefined) {
    lines.push(`Generation: ${generation}`);
  }
  return lines;
}

function conditionLines(status: UnknownObject | undefined): readonly string[] {
  const conditions = arrayAt(status, "conditions");
  const lines: string[] = [];
  if (conditions.length > 0) {
    lines.push("Conditions:");
  }
  for (const value of conditions) {
    const condition = asObject(value);
    if (condition === undefined) {
      continue;
    }
    const type = stringAt(condition, "type") ?? "Unknown";
    const conditionStatus = stringAt(condition, "status") ?? "Unknown";
    const reason = stringAt(condition, "reason");
    lines.push(
      `  - ${type}: ${conditionStatus}${reason === undefined ? "" : ` (${reason})`}`,
    );
    const message = stringAt(condition, "message");
    if (message !== undefined) {
      lines.push(`    Message: ${message}`);
    }
    const transitioned =
      stringAt(condition, "lastTransitionTime") ??
      stringAt(condition, "lastUpdateTime");
    if (transitioned !== undefined) {
      lines.push(`    Last transition: ${transitioned}`);
    }
  }
  return lines;
}

function stateLines(
  state: UnknownObject | undefined,
  label: "State" | "Previous state",
): readonly string[] {
  const stateNames = ["waiting", "running", "terminated"] as const;
  for (const stateName of stateNames) {
    const detail = objectAt(state, stateName);
    if (detail === undefined) {
      continue;
    }

    const reason = stringAt(detail, "reason");
    const lines = [`    ${label}: ${stateName}${reason === undefined ? "" : ` (${reason})`}`];
    const exitCode = numberAt(detail, "exitCode");
    if (exitCode !== undefined) {
      lines.push(`      Exit code: ${exitCode}`);
    }
    return lines;
  }
  return [];
}

function podDiagnostic(resource: UnknownObject): readonly string[] {
  const status = objectAt(resource, "status");
  const lines: string[] = [];
  const phase = stringAt(status, "phase");
  if (phase !== undefined) {
    lines.push(`Phase: ${phase}`);
  }

  const containerStatuses = arrayAt(status, "containerStatuses");
  if (containerStatuses.length > 0) {
    lines.push("Containers:");
  }
  for (const value of containerStatuses) {
    const container = asObject(value);
    if (container === undefined) {
      continue;
    }
    lines.push(`  - ${stringAt(container, "name") ?? "unknown"}`);
    const ready = booleanAt(container, "ready");
    if (ready !== undefined) {
      lines.push(`    Ready: ${ready}`);
    }
    const restartCount = numberAt(container, "restartCount");
    if (restartCount !== undefined) {
      lines.push(`    Restarts: ${restartCount}`);
    }
    lines.push(...stateLines(objectAt(container, "state"), "State"));
    lines.push(...stateLines(objectAt(container, "lastState"), "Previous state"));
  }
  lines.push(...conditionLines(status));
  return lines;
}

function addNumber(
  lines: string[],
  object: UnknownObject | undefined,
  key: string,
  label: string,
): void {
  const value = numberAt(object, key);
  if (value !== undefined) {
    lines.push(`${label}: ${value}`);
  }
}

function deploymentDiagnostic(resource: UnknownObject): readonly string[] {
  const spec = objectAt(resource, "spec");
  const status = objectAt(resource, "status");
  const lines: string[] = [];
  const strategy = stringAt(objectAt(spec, "strategy"), "type");
  if (strategy !== undefined) {
    lines.push(`Strategy: ${strategy}`);
  }
  addNumber(lines, spec, "replicas", "Desired replicas");
  addNumber(lines, spec, "minReadySeconds", "Minimum ready seconds");
  addNumber(lines, spec, "progressDeadlineSeconds", "Progress deadline seconds");
  addNumber(lines, status, "observedGeneration", "Observed generation");
  addNumber(lines, status, "replicas", "Current replicas");
  addNumber(lines, status, "updatedReplicas", "Updated replicas");
  addNumber(lines, status, "readyReplicas", "Ready replicas");
  addNumber(lines, status, "availableReplicas", "Available replicas");
  addNumber(lines, status, "unavailableReplicas", "Unavailable replicas");
  lines.push(...conditionLines(status));
  return lines;
}

function replicaSetDiagnostic(resource: UnknownObject): readonly string[] {
  const spec = objectAt(resource, "spec");
  const status = objectAt(resource, "status");
  const lines: string[] = [];
  addNumber(lines, spec, "replicas", "Desired replicas");
  addNumber(lines, spec, "minReadySeconds", "Minimum ready seconds");
  addNumber(lines, status, "observedGeneration", "Observed generation");
  addNumber(lines, status, "replicas", "Current replicas");
  addNumber(lines, status, "fullyLabeledReplicas", "Fully labeled replicas");
  addNumber(lines, status, "readyReplicas", "Ready replicas");
  addNumber(lines, status, "availableReplicas", "Available replicas");
  lines.push(...conditionLines(status));
  return lines;
}

function validateInput(input: KubectlDescribeInput): void {
  if (!KINDS.includes(input.kind)) {
    throw new ToolInputError("kind must be pod, deployment, or replicaset");
  }
  if (!isKubernetesDnsSubdomain(input.name)) {
    throw new ToolInputError("name must be a valid Kubernetes resource name");
  }
  if (
    !isKubernetesDnsLabel(input.namespace)
  ) {
    throw new ToolInputError("namespace must be a valid Kubernetes namespace name");
  }
}

function takeUtf8Prefix(value: string, byteBudget: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > byteBudget) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function takeUtf8Suffix(value: string, byteBudget: number): string {
  let bytes = 0;
  const result: string[] = [];
  const characters = [...value];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (character === undefined) {
      continue;
    }
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > byteBudget) {
      break;
    }
    result.push(character);
    bytes += characterBytes;
  }
  return result.reverse().join("");
}

function boundDiagnostic(content: string): BoundedToolResult {
  const originalBytes = utf8ByteLength(content);
  if (originalBytes <= MAX_KUBERNETES_DESCRIBE_BYTES) {
    return {
      content,
      bytes: originalBytes,
      truncated: false,
      truncationReasons: [],
    };
  }

  const availableBytes =
    MAX_KUBERNETES_DESCRIBE_BYTES - utf8ByteLength(OMISSION_MARKER);
  const headBudget = Math.floor(availableBytes / 2);
  const tailBudget = availableBytes - headBudget;
  const boundedContent =
    takeUtf8Prefix(content, headBudget) +
    OMISSION_MARKER +
    takeUtf8Suffix(content, tailBudget);

  return {
    content: boundedContent,
    bytes: utf8ByteLength(boundedContent),
    truncated: true,
    truncationReasons: ["describe_output_limit"],
  };
}

export async function kubectlDescribe(
  input: KubectlDescribeInput,
  dependencies: KubectlDescribeDependencies,
): Promise<BoundedToolResult> {
  validateInput(input);
  const response = await dependencies.api.getResource(input);
  const resource = asObject(response) ?? {};
  const kindDiagnostic =
    input.kind === "pod"
      ? podDiagnostic(resource)
      : input.kind === "deployment"
        ? deploymentDiagnostic(resource)
        : replicaSetDiagnostic(resource);
  const content = [
    `Kind: ${input.kind}`,
    `Name: ${input.name}`,
    `Namespace: ${input.namespace}`,
    ...metadataDiagnostic(resource),
    ...kindDiagnostic,
  ].join("\n");

  return boundDiagnostic(content);
}
