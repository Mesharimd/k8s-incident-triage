import type { ToolDefinition } from "./definition";
import {
  isKubernetesDnsLabel,
  isKubernetesDnsSubdomain,
  KUBERNETES_DNS_LABEL_MAX_LENGTH,
  KUBERNETES_DNS_LABEL_PATTERN,
  KUBERNETES_DNS_SUBDOMAIN_MAX_LENGTH,
  KUBERNETES_DNS_SUBDOMAIN_PATTERN,
} from "./kubernetes-names";
import {
  createBoundedJsonResult,
  ToolExecutionError,
  ToolInputError,
  utf8ByteLength,
} from "./result";
import type { BoundedToolResult } from "./result";

const MAX_REPLICA_SETS_SCANNED = 500;
const MAX_REVISIONS_RETURNED = 10;
const MAX_CHANGE_CAUSE_BYTES = 1_024;
const MAX_IMAGES_PER_REVISION = 8;
const MAX_IMAGE_BYTES = 512;
const SAFE_LABEL_KEY = /^(?:[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/;
const SAFE_LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?)?$/;

export interface ReadNamespacedDeploymentRequest {
  readonly name: string;
  readonly namespace: string;
}

export interface ListNamespacedReplicaSetsRequest {
  readonly namespace: string;
  readonly labelSelector: string;
  readonly limit: number;
}

export interface KubernetesRolloutApi {
  readNamespacedDeployment(
    request: ReadNamespacedDeploymentRequest,
  ): Promise<unknown>;
  listNamespacedReplicaSets(
    request: ListNamespacedReplicaSetsRequest,
  ): Promise<unknown>;
}

export interface GetRolloutHistoryInput {
  readonly deployment: string;
  readonly namespace: string;
}

export interface GetRolloutHistoryDependencies {
  readonly api: KubernetesRolloutApi;
}

export const getRolloutHistoryDefinition: ToolDefinition = {
  name: "get_rollout_history",
  description:
    "Return at most ten controller-owned ReplicaSet revisions for one Kubernetes Deployment.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["deployment", "namespace"],
    properties: {
      deployment: {
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

interface ParsedDeployment {
  readonly uid: string;
  readonly selector: string;
  readonly currentRevision: number | null;
}

interface ParsedRevision {
  readonly revision: number;
  readonly replicaSet: string;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly changeCause: string | null;
  readonly images: readonly string[];
  readonly replicas: {
    readonly desired: number;
    readonly ready: number;
    readonly available: number;
  };
  readonly changeCauseTruncated: boolean;
  readonly imagesTruncated: boolean;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolExecutionError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): Record<string, unknown> | undefined {
  return object[key] === undefined ? undefined : asObject(object[key], field);
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  maxBytes: number,
): string {
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8ByteLength(value) > maxBytes
  ) {
    throw new ToolExecutionError(
      `${field} must be a non-empty string of at most ${maxBytes} bytes`,
    );
  }
  return value;
}

function optionalString(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  maxBytes: number,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || utf8ByteLength(value) > maxBytes) {
    throw new ToolExecutionError(
      `${field} must be a string of at most ${maxBytes} bytes`,
    );
  }
  return value;
}

function optionalNonNegativeInteger(
  object: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ToolExecutionError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return { value: decoder.decode(encoded.subarray(0, end)), truncated: true };
    } catch {
      // Move to the previous complete UTF-8 code point.
    }
  }
  return { value: "", truncated: true };
}

function parseRevision(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new ToolExecutionError(`${field} must be a positive numeric revision`);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new ToolExecutionError(`${field} exceeds the safe numeric range`);
  }
  return revision;
}

function assertLabelKey(value: string, field: string): void {
  if (value.length > 317 || !SAFE_LABEL_KEY.test(value)) {
    throw new ToolExecutionError(`${field} is not a valid Kubernetes label key`);
  }
}

function assertLabelValue(value: string, field: string): void {
  if (value.length > 63 || !SAFE_LABEL_VALUE.test(value)) {
    throw new ToolExecutionError(`${field} is not a valid Kubernetes label value`);
  }
}

function serializeSelector(value: unknown): string {
  const selector = asObject(value, "Deployment.spec.selector");
  const requirements: string[] = [];
  const matchLabels = optionalObject(
    selector,
    "matchLabels",
    "Deployment.spec.selector.matchLabels",
  );
  if (matchLabels !== undefined) {
    for (const [key, rawValue] of Object.entries(matchLabels)) {
      assertLabelKey(key, `Deployment.spec.selector.matchLabels.${key}`);
      if (typeof rawValue !== "string") {
        throw new ToolExecutionError(
          `Deployment.spec.selector.matchLabels.${key} must be a string`,
        );
      }
      assertLabelValue(rawValue, `Deployment.spec.selector.matchLabels.${key}`);
      requirements.push(`${key}=${rawValue}`);
    }
  }

  const expressions = selector.matchExpressions;
  if (expressions !== undefined) {
    if (!Array.isArray(expressions)) {
      throw new ToolExecutionError(
        "Deployment.spec.selector.matchExpressions must be an array",
      );
    }
    expressions.forEach((entry, index) => {
      const field = `Deployment.spec.selector.matchExpressions[${index}]`;
      const expression = asObject(entry, field);
      const key = requiredString(expression, "key", `${field}.key`, 317);
      assertLabelKey(key, `${field}.key`);
      const operator = requiredString(expression, "operator", `${field}.operator`, 16);
      const rawValues = expression.values;
      if (operator === "Exists" || operator === "DoesNotExist") {
        if (rawValues !== undefined && (!Array.isArray(rawValues) || rawValues.length > 0)) {
          throw new ToolExecutionError(`${field}.values must be empty for ${operator}`);
        }
        requirements.push(operator === "Exists" ? key : `!${key}`);
        return;
      }
      if (operator !== "In" && operator !== "NotIn") {
        throw new ToolExecutionError(`${field}.operator is not supported`);
      }
      if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.length > 64) {
        throw new ToolExecutionError(`${field}.values must contain 1 to 64 values`);
      }
      const values = rawValues.map((rawValue, valueIndex) => {
        if (typeof rawValue !== "string") {
          throw new ToolExecutionError(`${field}.values[${valueIndex}] must be a string`);
        }
        assertLabelValue(rawValue, `${field}.values[${valueIndex}]`);
        return rawValue;
      });
      requirements.push(`${key} ${operator === "In" ? "in" : "notin"} (${values.join(",")})`);
    });
  }

  if (requirements.length === 0) {
    throw new ToolExecutionError("Deployment.spec.selector must not be empty");
  }
  return requirements.sort().join(",");
}

function parseDeployment(value: unknown): ParsedDeployment {
  const deployment = asObject(value, "Kubernetes Deployment response");
  if (deployment.apiVersion !== "apps/v1" || deployment.kind !== "Deployment") {
    throw new ToolExecutionError(
      "Kubernetes deployment response must be an apps/v1 Deployment",
    );
  }
  const metadata = asObject(deployment.metadata, "Deployment.metadata");
  const uid = requiredString(metadata, "uid", "Deployment.metadata.uid", 256);
  const spec = asObject(deployment.spec, "Deployment.spec");
  const annotations = optionalObject(
    metadata,
    "annotations",
    "Deployment.metadata.annotations",
  );
  const rawRevision = annotations?.["deployment.kubernetes.io/revision"];
  return {
    uid,
    selector: serializeSelector(spec.selector),
    currentRevision:
      rawRevision === undefined
        ? null
        : parseRevision(rawRevision, "Deployment revision annotation"),
  };
}

function isControllerOwnedBy(
  metadata: Readonly<Record<string, unknown>>,
  deploymentUid: string,
  field: string,
): boolean {
  const ownerReferences = metadata.ownerReferences;
  if (ownerReferences === undefined) {
    return false;
  }
  if (!Array.isArray(ownerReferences)) {
    throw new ToolExecutionError(`${field}.ownerReferences must be an array`);
  }
  return ownerReferences.some((entry, index) => {
    const owner = asObject(entry, `${field}.ownerReferences[${index}]`);
    if (owner.controller !== undefined && typeof owner.controller !== "boolean") {
      throw new ToolExecutionError(
        `${field}.ownerReferences[${index}].controller must be a boolean`,
      );
    }
    return (
      owner.apiVersion === "apps/v1" &&
      owner.kind === "Deployment" &&
      owner.uid === deploymentUid &&
      owner.controller === true
    );
  });
}

function parseTimestamp(value: unknown, field: string): {
  readonly milliseconds: number;
  readonly iso: string;
} {
  if (typeof value !== "string") {
    throw new ToolExecutionError(`${field} must be an RFC 3339 timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ToolExecutionError(`${field} must be an RFC 3339 timestamp`);
  }
  return { milliseconds, iso: new Date(milliseconds).toISOString() };
}

function parseImages(spec: Readonly<Record<string, unknown>>, field: string): {
  readonly images: readonly string[];
  readonly truncated: boolean;
} {
  const template = asObject(spec.template, `${field}.template`);
  const podSpec = asObject(template.spec, `${field}.template.spec`);
  if (!Array.isArray(podSpec.containers)) {
    throw new ToolExecutionError(`${field}.template.spec.containers must be an array`);
  }
  let truncated = podSpec.containers.length > MAX_IMAGES_PER_REVISION;
  const images = podSpec.containers
    .slice(0, MAX_IMAGES_PER_REVISION)
    .map((entry, index) => {
      const container = asObject(entry, `${field}.template.spec.containers[${index}]`);
      requiredString(
        container,
        "name",
        `${field}.template.spec.containers[${index}].name`,
        253,
      );
      const image = requiredString(
        container,
        "image",
        `${field}.template.spec.containers[${index}].image`,
        4_096,
      );
      const bounded = truncateUtf8(image, MAX_IMAGE_BYTES);
      truncated ||= bounded.truncated;
      return bounded.value;
    });
  return { images, truncated };
}

function parseOwnedRevision(
  replicaSet: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>>,
  field: string,
): ParsedRevision {
  const annotations = asObject(metadata.annotations, `${field}.metadata.annotations`);
  const revision = parseRevision(
    annotations["deployment.kubernetes.io/revision"],
    `${field} revision annotation`,
  );
  const createdAt = parseTimestamp(
    metadata.creationTimestamp,
    `${field}.metadata.creationTimestamp`,
  );
  const rawCause = annotations["kubernetes.io/change-cause"];
  if (rawCause !== undefined && typeof rawCause !== "string") {
    throw new ToolExecutionError(`${field} change-cause annotation must be a string`);
  }
  const cause =
    rawCause === undefined
      ? { value: null, truncated: false }
      : truncateUtf8(rawCause, MAX_CHANGE_CAUSE_BYTES);
  const spec = asObject(replicaSet.spec, `${field}.spec`);
  const status = asObject(replicaSet.status, `${field}.status`);
  const images = parseImages(spec, `${field}.spec`);

  return {
    revision,
    replicaSet: requiredString(metadata, "name", `${field}.metadata.name`, 253),
    createdAt: createdAt.iso,
    createdAtMs: createdAt.milliseconds,
    changeCause: cause.value,
    images: images.images,
    replicas: {
      desired:
        optionalNonNegativeInteger(spec, "replicas", `${field}.spec.replicas`) ?? 1,
      ready:
        optionalNonNegativeInteger(status, "readyReplicas", `${field}.status.readyReplicas`) ?? 0,
      available:
        optionalNonNegativeInteger(
          status,
          "availableReplicas",
          `${field}.status.availableReplicas`,
        ) ?? 0,
    },
    changeCauseTruncated: cause.truncated,
    imagesTruncated: images.truncated,
  };
}

function parseReplicaSetList(value: unknown, deploymentUid: string): {
  readonly revisions: readonly ParsedRevision[];
  readonly scanned: number;
  readonly sourcePaginated: boolean;
  readonly scanLimited: boolean;
} {
  const list = asObject(value, "Kubernetes ReplicaSetList response");
  if (list.apiVersion !== "apps/v1" || list.kind !== "ReplicaSetList") {
    throw new ToolExecutionError(
      "Kubernetes ReplicaSet response must be an apps/v1 ReplicaSetList",
    );
  }
  const metadata = asObject(list.metadata, "ReplicaSetList.metadata");
  const continuation = optionalString(
    metadata,
    "continue",
    "ReplicaSetList.metadata.continue",
    4_096,
  );
  const remaining = optionalNonNegativeInteger(
    metadata,
    "remainingItemCount",
    "ReplicaSetList.metadata.remainingItemCount",
  );
  if (!Array.isArray(list.items)) {
    throw new ToolExecutionError("ReplicaSetList.items must be an array");
  }
  const scannedItems = list.items.slice(0, MAX_REPLICA_SETS_SCANNED);
  const revisions: ParsedRevision[] = [];
  scannedItems.forEach((entry, index) => {
    const field = `ReplicaSetList.items[${index}]`;
    const replicaSet = asObject(entry, field);
    if (replicaSet.apiVersion !== "apps/v1" || replicaSet.kind !== "ReplicaSet") {
      throw new ToolExecutionError(`${field} must be an apps/v1 ReplicaSet`);
    }
    const itemMetadata = asObject(replicaSet.metadata, `${field}.metadata`);
    requiredString(itemMetadata, "name", `${field}.metadata.name`, 253);
    if (isControllerOwnedBy(itemMetadata, deploymentUid, `${field}.metadata`)) {
      revisions.push(parseOwnedRevision(replicaSet, itemMetadata, field));
    }
  });
  return {
    revisions,
    scanned: scannedItems.length,
    sourcePaginated:
      (continuation !== undefined && continuation.length > 0) ||
      (remaining !== undefined && remaining > 0),
    scanLimited: list.items.length > MAX_REPLICA_SETS_SCANNED,
  };
}

function validateInput(input: GetRolloutHistoryInput): void {
  if (
    !isKubernetesDnsLabel(input.namespace)
  ) {
    throw new ToolInputError("namespace must be a valid Kubernetes namespace name");
  }
  if (
    !isKubernetesDnsSubdomain(input.deployment)
  ) {
    throw new ToolInputError("deployment must be a valid Kubernetes resource name");
  }
}

export async function getRolloutHistory(
  input: GetRolloutHistoryInput,
  dependencies: GetRolloutHistoryDependencies,
): Promise<BoundedToolResult> {
  validateInput(input);
  const deploymentResponse = await dependencies.api.readNamespacedDeployment({
    name: input.deployment,
    namespace: input.namespace,
  });
  const deployment = parseDeployment(deploymentResponse);
  const replicaSetResponse = await dependencies.api.listNamespacedReplicaSets({
    namespace: input.namespace,
    labelSelector: deployment.selector,
    limit: MAX_REPLICA_SETS_SCANNED,
  });
  const parsed = parseReplicaSetList(replicaSetResponse, deployment.uid);
  const sorted = [...parsed.revisions].sort(
    (left, right) =>
      right.revision - left.revision || right.createdAtMs - left.createdAtMs,
  );
  const returned = sorted.slice(0, MAX_REVISIONS_RETURNED);
  const revisionLimited = sorted.length > MAX_REVISIONS_RETURNED;
  const causeLimited = returned.some((revision) => revision.changeCauseTruncated);
  const imagesLimited = returned.some((revision) => revision.imagesTruncated);
  const truncationReasons: string[] = [];
  if (parsed.sourcePaginated) truncationReasons.push("source_pagination");
  if (parsed.scanLimited) truncationReasons.push("scan_limit");
  if (revisionLimited) truncationReasons.push("revision_limit");
  if (causeLimited) truncationReasons.push("change_cause_limit");
  if (imagesLimited) truncationReasons.push("image_limit");
  const incomplete = truncationReasons.length > 0;
  const revisions = returned.map(
    ({ createdAtMs: _createdAtMs, changeCauseTruncated: _cause, imagesTruncated: _images, ...revision }) => revision,
  );
  const output = {
    deployment: input.deployment,
    namespace: input.namespace,
    selector: deployment.selector,
    currentRevision: deployment.currentRevision,
    revisions,
    scannedReplicaSets: parsed.scanned,
    matchingReplicaSets: sorted.length,
    omittedRevisions: Math.max(0, sorted.length - MAX_REVISIONS_RETURNED),
    incomplete,
  };

  return createBoundedJsonResult(output, {
    truncated: incomplete,
    truncationReasons,
    fallback: {
      deployment: input.deployment,
      namespace: input.namespace,
      selector: deployment.selector,
      currentRevision: deployment.currentRevision,
      revisions: returned.map(({ revision, replicaSet, createdAt }) => ({
        revision,
        replicaSet,
        createdAt,
      })),
      scannedReplicaSets: parsed.scanned,
      matchingReplicaSets: sorted.length,
      omittedRevisions: Math.max(0, sorted.length - MAX_REVISIONS_RETURNED),
      incomplete: true,
      note: "Rollout details exceeded the serialized result limit.",
    },
  });
}
