import { utf8ByteLength } from "../tools/result";

const MAX_REPORT_BYTES = 32_000;
const MAX_REPORT_ITEMS = 20;
const MAX_REPORT_STRING_BYTES = 4_096;

export type Confidence = "low" | "medium" | "high";

export interface CitedClaim {
  readonly claim: string;
  readonly confidence: Confidence;
  readonly evidenceCallIds: readonly string[];
}

export interface EvidenceItem {
  readonly callId: string;
  readonly observation: string;
}

export interface SuggestedAction {
  readonly action: string;
  readonly rationale: string;
  readonly evidenceCallIds: readonly string[];
  readonly executed: false;
}

export interface RecentChange {
  readonly change: string;
  readonly evidenceCallIds: readonly string[];
}

export interface TriageReport {
  readonly status: "diagnosed" | "insufficient_data";
  readonly probableCause: CitedClaim | null;
  readonly evidence: readonly EvidenceItem[];
  readonly suggestions: readonly SuggestedAction[];
  readonly recentChanges: readonly RecentChange[];
  readonly uncertainties: readonly string[];
}

export class InvalidTriageReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTriageReportError";
  }
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidTriageReportError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyFields(
  object: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new InvalidTriageReportError(`${path} contains unexpected field ${key}`);
    }
  }
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new InvalidTriageReportError(`${path} must be an array`);
  }
  if (value.length > MAX_REPORT_ITEMS) {
    throw new InvalidTriageReportError(
      `${path} must contain at most ${MAX_REPORT_ITEMS} items`,
    );
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidTriageReportError(`${path} must be a non-empty string`);
  }
  if (utf8ByteLength(value) > MAX_REPORT_STRING_BYTES) {
    throw new InvalidTriageReportError(
      `${path} must be at most ${MAX_REPORT_STRING_BYTES} bytes`,
    );
  }
  return value;
}

function citedCallIds(
  value: unknown,
  path: string,
  executedCallIds: ReadonlySet<string>,
): readonly string[] {
  const values = arrayValue(value, path);
  if (values.length === 0) {
    throw new InvalidTriageReportError(`${path} must not be empty`);
  }
  return values.map((entry, index) => {
    const callId = stringValue(entry, `${path}[${index}]`);
    if (!executedCallIds.has(callId)) {
      throw new InvalidTriageReportError(`${path} cites unknown tool call ${callId}`);
    }
    return callId;
  });
}

function parseProbableCause(
  value: unknown,
  executedCallIds: ReadonlySet<string>,
): CitedClaim {
  const object = objectValue(value, "probableCause");
  assertOnlyFields(
    object,
    ["claim", "confidence", "evidenceCallIds"],
    "probableCause",
  );
  const confidence = object.confidence;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new InvalidTriageReportError(
      "probableCause.confidence must be low, medium, or high",
    );
  }
  return {
    claim: stringValue(object.claim, "probableCause.claim"),
    confidence,
    evidenceCallIds: citedCallIds(
      object.evidenceCallIds,
      "probableCause.evidenceCallIds",
      executedCallIds,
    ),
  };
}

function parseEvidence(
  value: unknown,
  executedCallIds: ReadonlySet<string>,
): readonly EvidenceItem[] {
  return arrayValue(value, "evidence").map((entry, index) => {
    const path = `evidence[${index}]`;
    const object = objectValue(entry, path);
    assertOnlyFields(object, ["callId", "observation"], path);
    const callId = stringValue(object.callId, `${path}.callId`);
    if (!executedCallIds.has(callId)) {
      throw new InvalidTriageReportError(`${path}.callId cites unknown tool call ${callId}`);
    }
    return {
      callId,
      observation: stringValue(object.observation, `${path}.observation`),
    };
  });
}

function parseSuggestions(
  value: unknown,
  executedCallIds: ReadonlySet<string>,
): readonly SuggestedAction[] {
  return arrayValue(value, "suggestions").map((entry, index) => {
    const path = `suggestions[${index}]`;
    const object = objectValue(entry, path);
    assertOnlyFields(
      object,
      ["action", "rationale", "evidenceCallIds", "executed"],
      path,
    );
    if (object.executed !== false) {
      throw new InvalidTriageReportError(`${path}.executed must be false`);
    }
    return {
      action: stringValue(object.action, `${path}.action`),
      rationale: stringValue(object.rationale, `${path}.rationale`),
      evidenceCallIds: citedCallIds(
        object.evidenceCallIds,
        `${path}.evidenceCallIds`,
        executedCallIds,
      ),
      executed: false,
    };
  });
}

function parseRecentChanges(
  value: unknown,
  executedCallIds: ReadonlySet<string>,
): readonly RecentChange[] {
  return arrayValue(value, "recentChanges").map((entry, index) => {
    const path = `recentChanges[${index}]`;
    const object = objectValue(entry, path);
    assertOnlyFields(object, ["change", "evidenceCallIds"], path);
    return {
      change: stringValue(object.change, `${path}.change`),
      evidenceCallIds: citedCallIds(
        object.evidenceCallIds,
        `${path}.evidenceCallIds`,
        executedCallIds,
      ),
    };
  });
}

function parseUncertainties(value: unknown): readonly string[] {
  const uncertainties = arrayValue(value, "uncertainties").map((entry, index) =>
    stringValue(entry, `uncertainties[${index}]`),
  );
  if (uncertainties.length === 0) {
    throw new InvalidTriageReportError("uncertainties must not be empty");
  }
  return uncertainties;
}

export function parseTriageReport(
  serialized: string,
  executedCallIds: ReadonlySet<string>,
): TriageReport {
  if (utf8ByteLength(serialized) > MAX_REPORT_BYTES) {
    throw new InvalidTriageReportError(
      `report must be at most ${MAX_REPORT_BYTES} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new InvalidTriageReportError("assistant response must be valid JSON");
  }

  const object = objectValue(parsed, "report");
  assertOnlyFields(
    object,
    [
      "status",
      "probableCause",
      "evidence",
      "suggestions",
      "recentChanges",
      "uncertainties",
    ],
    "report",
  );
  if (object.status !== "diagnosed" && object.status !== "insufficient_data") {
    throw new InvalidTriageReportError(
      "status must be diagnosed or insufficient_data",
    );
  }

  const probableCause =
    object.probableCause === null
      ? null
      : parseProbableCause(object.probableCause, executedCallIds);
  if (object.status === "diagnosed" && probableCause === null) {
    throw new InvalidTriageReportError(
      "diagnosed report must include a probableCause",
    );
  }
  if (object.status === "insufficient_data" && probableCause !== null) {
    throw new InvalidTriageReportError(
      "insufficient_data report must not claim a probableCause",
    );
  }

  const evidence = parseEvidence(object.evidence, executedCallIds);
  if (object.status === "diagnosed" && evidence.length === 0) {
    throw new InvalidTriageReportError("diagnosed report must include evidence");
  }

  return {
    status: object.status,
    probableCause,
    evidence,
    suggestions: parseSuggestions(object.suggestions, executedCallIds),
    recentChanges: parseRecentChanges(object.recentChanges, executedCallIds),
    uncertainties: parseUncertainties(object.uncertainties),
  };
}

export function createInsufficientDataReport(reason: string): TriageReport {
  return {
    status: "insufficient_data",
    probableCause: null,
    evidence: [],
    suggestions: [],
    recentChanges: [],
    uncertainties: [reason],
  };
}
