import { createHash } from "node:crypto";

export interface Incident {
  alertname: string;
  namespace: string;
  pod: string;
  severity: string;
  fingerprint: string;
  startsAt: string;
  labels: Readonly<Record<string, string>>;
  annotations: Readonly<Record<string, string>>;
}

export type Severity = "info" | "warning" | "critical";

type AlertStatus = "firing" | "resolved";

const MAX_ALERTS_PER_WEBHOOK = 100;
const MAX_METADATA_ENTRIES = 64;
const MAX_METADATA_KEY_BYTES = 256;
const MAX_LABEL_VALUE_BYTES = 1_024;
const MAX_ANNOTATION_VALUE_BYTES = 4_096;
const MAX_INCIDENT_BYTES = 16_384;

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  info: 0,
  warning: 1,
  critical: 2,
};

interface NormalizedAlert {
  status: AlertStatus;
  incident: Incident;
}

interface StoredIncident {
  incident: Incident;
  isOpen: boolean;
  suppressUntil: number;
}

export interface IncidentReceiverOptions {
  debounceMs: number;
  minSeverity?: Severity;
  namespaceAllowlist?: readonly string[];
  namespaceDenylist?: readonly string[];
}

export interface IncidentReceiveResult {
  opened: Incident[];
  resolved: Incident[];
  duplicateCount: number;
  filteredCount: number;
}

export class InvalidAlertmanagerPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAlertmanagerPayloadError";
  }
}

export class AlertmanagerPayloadLimitError extends InvalidAlertmanagerPayloadError {
  constructor(message: string) {
    super(message);
    this.name = "AlertmanagerPayloadLimitError";
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidAlertmanagerPayloadError(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function asStringRecord(
  value: unknown,
  field: string,
  maxValueBytes: number,
): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const object = asObject(value, field);
  const entries = Object.entries(object);
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new AlertmanagerPayloadLimitError(
      `${field} must contain at most ${MAX_METADATA_ENTRIES} entries`,
    );
  }
  const result: Record<string, string> = {};

  for (const [key, entry] of entries) {
    if (typeof entry !== "string") {
      throw new InvalidAlertmanagerPayloadError(`${field}.${key} must be a string`);
    }
    if (byteLength(key) > MAX_METADATA_KEY_BYTES) {
      throw new AlertmanagerPayloadLimitError(
        `${field} keys must be at most ${MAX_METADATA_KEY_BYTES} bytes`,
      );
    }
    if (byteLength(entry) > maxValueBytes) {
      throw new AlertmanagerPayloadLimitError(
        `${field}.${key} must be at most ${maxValueBytes} bytes`,
      );
    }
    result[key] = entry;
  }

  return result;
}

function stringField(
  object: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = object[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = stringField(object, field);
  if (value === undefined) {
    throw new InvalidAlertmanagerPayloadError(`${field} must be a non-empty string`);
  }
  return value;
}

function stableFingerprint(labels: Readonly<Record<string, string>>): string {
  const serialized = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

function assertMetadataCount(
  metadata: Readonly<Record<string, string>>,
  field: string,
): void {
  if (Object.keys(metadata).length > MAX_METADATA_ENTRIES) {
    throw new AlertmanagerPayloadLimitError(
      `${field} must contain at most ${MAX_METADATA_ENTRIES} combined entries`,
    );
  }
}

function assertIncidentBounded(incident: Incident): void {
  const serialized = JSON.stringify(incident);
  if (byteLength(serialized) > MAX_INCIDENT_BYTES) {
    throw new AlertmanagerPayloadLimitError(
      `normalized incident must be at most ${MAX_INCIDENT_BYTES} bytes`,
    );
  }
}

export function isSeverity(value: string): value is Severity {
  return value === "info" || value === "warning" || value === "critical";
}

export function normalizeAlertmanagerPayload(payload: unknown): NormalizedAlert[] {
  const body = asObject(payload, "payload");
  const alerts = body.alerts;
  if (!Array.isArray(alerts)) {
    throw new InvalidAlertmanagerPayloadError("alerts must be an array");
  }
  if (alerts.length > MAX_ALERTS_PER_WEBHOOK) {
    throw new AlertmanagerPayloadLimitError(
      `alerts must contain at most ${MAX_ALERTS_PER_WEBHOOK} entries`,
    );
  }

  const commonLabels = asStringRecord(
    body.commonLabels,
    "commonLabels",
    MAX_LABEL_VALUE_BYTES,
  );
  const commonAnnotations = asStringRecord(
    body.commonAnnotations,
    "commonAnnotations",
    MAX_ANNOTATION_VALUE_BYTES,
  );
  const groupStatus = stringField(body, "status");

  return alerts.map((value, index) => {
    const alert = asObject(value, `alerts[${index}]`);
    const labels = {
      ...commonLabels,
      ...asStringRecord(
        alert.labels,
        `alerts[${index}].labels`,
        MAX_LABEL_VALUE_BYTES,
      ),
    };
    const annotations = {
      ...commonAnnotations,
      ...asStringRecord(
        alert.annotations,
        `alerts[${index}].annotations`,
        MAX_ANNOTATION_VALUE_BYTES,
      ),
    };
    assertMetadataCount(labels, `alerts[${index}].labels`);
    assertMetadataCount(annotations, `alerts[${index}].annotations`);
    const rawStatus = stringField(alert, "status") ?? groupStatus;

    if (rawStatus !== "firing" && rawStatus !== "resolved") {
      throw new InvalidAlertmanagerPayloadError(
        `alerts[${index}].status must be firing or resolved`,
      );
    }

    const fingerprint =
      stringField(alert, "fingerprint") ?? stableFingerprint(labels);

    const normalized: NormalizedAlert = {
      status: rawStatus,
      incident: {
        alertname: labels.alertname ?? "unknown",
        namespace: labels.namespace ?? "default",
        pod: labels.pod ?? "unknown",
        severity: labels.severity ?? "unknown",
        fingerprint,
        startsAt: requiredString(alert, "startsAt"),
        labels,
        annotations,
      },
    };
    assertIncidentBounded(normalized.incident);
    return normalized;
  });
}

export class IncidentReceiver {
  readonly #debounceMs: number;
  readonly #minSeverity: Severity;
  readonly #namespaceAllowlist: ReadonlySet<string>;
  readonly #namespaceDenylist: ReadonlySet<string>;
  readonly #incidents = new Map<string, StoredIncident>();
  readonly #resolutionRollbacks = new WeakMap<Incident, Incident>();

  constructor(options: IncidentReceiverOptions) {
    if (!Number.isFinite(options.debounceMs) || options.debounceMs < 0) {
      throw new Error("debounceMs must be a non-negative finite number");
    }
    this.#debounceMs = options.debounceMs;
    this.#minSeverity = options.minSeverity ?? "info";
    this.#namespaceAllowlist = new Set(options.namespaceAllowlist ?? []);
    this.#namespaceDenylist = new Set(options.namespaceDenylist ?? []);
  }

  receive(payload: unknown, now = Date.now()): IncidentReceiveResult {
    const result: IncidentReceiveResult = {
      opened: [],
      resolved: [],
      duplicateCount: 0,
      filteredCount: 0,
    };

    for (const notification of normalizeAlertmanagerPayload(payload)) {
      const { incident, status } = notification;
      const existing = this.#incidents.get(incident.fingerprint);

      if (status === "resolved") {
        if (existing?.isOpen === true) {
          this.#resolutionRollbacks.set(incident, existing.incident);
          existing.isOpen = false;
          existing.incident = incident;
          existing.suppressUntil = now + this.#debounceMs;
          result.resolved.push(incident);
        }
        continue;
      }

      if (!this.#accepts(incident)) {
        result.filteredCount += 1;
        continue;
      }

      if (
        existing?.isOpen === true ||
        (existing !== undefined && now < existing.suppressUntil)
      ) {
        result.duplicateCount += 1;
        continue;
      }

      this.#incidents.set(incident.fingerprint, {
        incident,
        isOpen: true,
        suppressUntil: 0,
      });
      result.opened.push(incident);
    }

    return result;
  }

  isOpen(fingerprint: string): boolean {
    return this.#incidents.get(fingerprint)?.isOpen ?? false;
  }

  markIncidentDeliveryFailed(incident: Incident): void {
    const existing = this.#incidents.get(incident.fingerprint);
    if (existing?.isOpen === true && existing.incident === incident) {
      this.#incidents.delete(incident.fingerprint);
    }
  }

  markResolutionDeliveryFailed(incident: Incident): void {
    const existing = this.#incidents.get(incident.fingerprint);
    const previous = this.#resolutionRollbacks.get(incident);
    if (
      existing?.isOpen === false &&
      existing.incident === incident &&
      previous !== undefined
    ) {
      existing.incident = previous;
      existing.isOpen = true;
      existing.suppressUntil = 0;
    }
  }

  #accepts(incident: Incident): boolean {
    if (this.#namespaceDenylist.has(incident.namespace)) {
      return false;
    }
    if (
      this.#namespaceAllowlist.size > 0 &&
      !this.#namespaceAllowlist.has(incident.namespace)
    ) {
      return false;
    }

    const normalizedSeverity = incident.severity.toLowerCase();
    const actual = isSeverity(normalizedSeverity)
      ? SEVERITY_RANK[normalizedSeverity]
      : -1;
    return actual >= SEVERITY_RANK[this.#minSeverity];
  }
}
