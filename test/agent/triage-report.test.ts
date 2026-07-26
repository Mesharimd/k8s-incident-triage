import { describe, expect, test } from "bun:test";

import {
  InvalidTriageReportError,
  createInsufficientDataReport,
  parseTriageReport,
} from "../../src/agent/triage-report";

const oomReport = JSON.stringify({
  status: "diagnosed",
  probableCause: {
    claim: "The checkout container was terminated by the kernel OOM killer.",
    confidence: "high",
    evidenceCallIds: ["call_001"],
  },
  evidence: [
    {
      callId: "call_001",
      observation: "The last terminated state reports reason OOMKilled and exit code 137.",
    },
  ],
  suggestions: [
    {
      action: "Review the container memory limit and recent memory growth.",
      rationale: "The termination evidence points to memory exhaustion.",
      evidenceCallIds: ["call_001"],
      executed: false,
    },
  ],
  recentChanges: [],
  uncertainties: ["No heap profile was available."],
});

describe("triage report validation", () => {
  test("accepts a diagnosis only when every cited call was executed", () => {
    expect(parseTriageReport(oomReport, new Set(["call_001"]))).toEqual({
      status: "diagnosed",
      probableCause: {
        claim: "The checkout container was terminated by the kernel OOM killer.",
        confidence: "high",
        evidenceCallIds: ["call_001"],
      },
      evidence: [
        {
          callId: "call_001",
          observation:
            "The last terminated state reports reason OOMKilled and exit code 137.",
        },
      ],
      suggestions: [
        {
          action: "Review the container memory limit and recent memory growth.",
          rationale: "The termination evidence points to memory exhaustion.",
          evidenceCallIds: ["call_001"],
          executed: false,
        },
      ],
      recentChanges: [],
      uncertainties: ["No heap profile was available."],
    });
  });

  test("rejects hallucinated citations and claims without evidence", () => {
    expect(() => parseTriageReport(oomReport, new Set())).toThrow(
      "probableCause.evidenceCallIds cites unknown tool call call_001",
    );

    const uncited = JSON.parse(oomReport) as Record<string, unknown>;
    uncited.probableCause = {
      claim: "OOMKilled",
      confidence: "high",
      evidenceCallIds: [],
    };
    expect(() => parseTriageReport(JSON.stringify(uncited), new Set(["call_001"]))).toThrow(
      "probableCause.evidenceCallIds must not be empty",
    );
  });

  test("rejects action claims marked as executed or extra fields", () => {
    const executed = JSON.parse(oomReport) as {
      suggestions: Array<Record<string, unknown>>;
    };
    const firstSuggestion = executed.suggestions[0];
    if (firstSuggestion === undefined) {
      throw new Error("fixture must include a suggestion");
    }
    firstSuggestion.executed = true;
    expect(() =>
      parseTriageReport(JSON.stringify(executed), new Set(["call_001"])),
    ).toThrow("suggestions[0].executed must be false");

    const extra = JSON.parse(oomReport) as Record<string, unknown>;
    extra.commandWasRun = true;
    expect(() => parseTriageReport(JSON.stringify(extra), new Set(["call_001"]))).toThrow(
      "report contains unexpected field commandWasRun",
    );
  });

  test("builds a deterministic insufficient-data report", () => {
    expect(createInsufficientDataReport("context budget exhausted")).toEqual({
      status: "insufficient_data",
      probableCause: null,
      evidence: [],
      suggestions: [],
      recentChanges: [],
      uncertainties: ["context budget exhausted"],
    });
  });

  test("wraps malformed JSON in a report-specific error", () => {
    expect(() => parseTriageReport("not json", new Set())).toThrow(
      InvalidTriageReportError,
    );
  });
});
