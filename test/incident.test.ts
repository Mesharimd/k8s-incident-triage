import { describe, expect, test } from "bun:test";

import { IncidentReceiver } from "../src/incident";

const firingFixture: unknown = await Bun.file(
  new URL("fixtures/alert-firing.json", import.meta.url),
).json();
const resolvedFixture: unknown = await Bun.file(
  new URL("fixtures/alert-resolved.json", import.meta.url),
).json();
const groupedFixture: unknown = await Bun.file(
  new URL("fixtures/alerts-grouped.json", import.meta.url),
).json();
const mixedGroupedFixture: unknown = await Bun.file(
  new URL("fixtures/alerts-grouped-mixed.json", import.meta.url),
).json();

const sharedLabels = {
  alertname: "PodMemoryPressure",
  namespace: "payments",
  pod: "checkout-api-7c8f6f6d8b-r4x9n",
  severity: "critical",
  container: "checkout-api",
};

function lifecyclePayload(
  status: "firing" | "resolved",
  startsAt: string,
  fingerprint = "7f0dcb4fc25a9e2b",
): unknown {
  return {
    status,
    alerts: [
      {
        status,
        labels: sharedLabels,
        annotations: { summary: `${status} lifecycle` },
        startsAt,
        fingerprint,
      },
    ],
  };
}

describe("Alertmanager incident lifecycle", () => {
  test("opens one incident, suppresses a resend, and closes it on resolution", () => {
    const receiver = new IncidentReceiver({ debounceMs: 5 * 60_000 });
    const first = receiver.receive(firingFixture, Date.parse("2026-07-25T14:03:01Z"));
    const resend = receiver.receive(firingFixture, Date.parse("2026-07-25T14:04:01Z"));
    const resolved = receiver.receive(
      resolvedFixture,
      Date.parse("2026-07-25T14:11:01Z"),
    );

    expect(first.opened).toEqual([
      {
        alertname: "PodMemoryPressure",
        namespace: "payments",
        pod: "checkout-api-7c8f6f6d8b-r4x9n",
        severity: "critical",
        fingerprint: "7f0dcb4fc25a9e2b",
        startsAt: "2026-07-25T14:03:00Z",
        labels: {
          alertname: "PodMemoryPressure",
          container: "checkout-api",
          namespace: "payments",
          pod: "checkout-api-7c8f6f6d8b-r4x9n",
          severity: "critical",
        },
        annotations: {
          description: "Working set is above 95% of the configured limit",
          summary: "Checkout pod is approaching its memory limit",
        },
      },
    ]);
    expect(resend).toMatchObject({ opened: [], duplicateCount: 1 });
    expect(resolved.resolved).toHaveLength(1);
    expect(receiver.isOpen("7f0dcb4fc25a9e2b")).toBe(false);
  });

  test("suppresses every resend while an incident remains open", () => {
    const receiver = new IncidentReceiver({ debounceMs: 5 * 60_000 });
    receiver.receive(firingFixture, Date.parse("2026-07-25T14:03:01Z"));

    const muchLaterResend = receiver.receive(
      firingFixture,
      Date.parse("2026-07-25T16:03:01Z"),
    );

    expect(muchLaterResend).toMatchObject({ opened: [], duplicateCount: 1 });
    expect(receiver.isOpen("7f0dcb4fc25a9e2b")).toBe(true);
  });

  test("normalizes grouped alerts and enforces severity and namespace filters", () => {
    const namespaceReceiver = new IncidentReceiver({
      debounceMs: 5 * 60_000,
      namespaceAllowlist: ["payments", "kube-system"],
      namespaceDenylist: ["kube-system"],
    });
    const severityReceiver = new IncidentReceiver({
      debounceMs: 5 * 60_000,
      minSeverity: "critical",
    });

    const namespaceResult = namespaceReceiver.receive(groupedFixture);
    const severityResult = severityReceiver.receive(groupedFixture);

    expect(namespaceResult.opened.map((incident) => incident.fingerprint)).toEqual([
      "0a19d85e7cafe132",
    ]);
    expect(namespaceResult.filteredCount).toBe(2);
    expect(severityResult.opened.map((incident) => incident.fingerprint)).toEqual([
      "0a19d85e7cafe132",
      "dd5817bb25b83f12",
    ]);
    expect(severityResult.filteredCount).toBe(1);
  });

  test("handles firing and resolved alerts independently inside one group", () => {
    const receiver = new IncidentReceiver({ debounceMs: 5 * 60_000 });
    receiver.receive(firingFixture);

    const result = receiver.receive(mixedGroupedFixture);

    expect(result.resolved.map((incident) => incident.fingerprint)).toEqual([
      "7f0dcb4fc25a9e2b",
    ]);
    expect(result.opened.map((incident) => incident.fingerprint)).toEqual([
      "0a19d85e7cafe132",
    ]);
  });

  test("distinguishes a current reopen from an older incident with the same fingerprint", () => {
    const receiver = new IncidentReceiver({ debounceMs: 0 });
    const first = receiver.receive(
      firingFixture,
      Date.parse("2026-07-25T14:03:01Z"),
    ).opened[0];
    receiver.receive(resolvedFixture, Date.parse("2026-07-25T14:04:01Z"));
    const reopened = receiver.receive(
      lifecyclePayload("firing", "2026-07-25T14:05:00Z"),
      Date.parse("2026-07-25T14:05:01Z"),
    ).opened[0];

    expect(first).toBeDefined();
    expect(reopened).toBeDefined();
    expect(receiver.isOpen("7f0dcb4fc25a9e2b")).toBe(true);
    expect(receiver.isCurrentOpen(first!)).toBe(false);
    expect(receiver.isCurrentOpen(reopened!)).toBe(true);
    const resolution = receiver.receive(
      lifecyclePayload("resolved", "2026-07-25T14:05:00Z"),
      Date.parse("2026-07-25T14:06:01Z"),
    ).resolved[0];
    expect(resolution).toBeDefined();
    expect(receiver.incidentClosedBy(resolution!)).toBe(reopened);
  });

  test("ignores a delayed resolution from an older same-fingerprint lifecycle", () => {
    const receiver = new IncidentReceiver({ debounceMs: 0 });
    const oldStart = "2026-07-25T14:03:00Z";
    const newStart = "2026-07-25T14:12:00Z";

    receiver.receive(lifecyclePayload("firing", oldStart), 1);
    receiver.receive(lifecyclePayload("resolved", oldStart), 2);
    const reopened = receiver.receive(
      lifecyclePayload("firing", newStart),
      3,
    ).opened[0];
    const staleResolution = receiver.receive(
      lifecyclePayload("resolved", oldStart),
      4,
    );

    expect(reopened).toBeDefined();
    expect(staleResolution.resolved).toEqual([]);
    expect(receiver.isCurrentOpen(reopened!)).toBe(true);
  });

  test("normalizes supplied fingerprint case across firing and resolution", () => {
    const receiver = new IncidentReceiver({ debounceMs: 0 });
    const startsAt = "2026-07-25T14:03:00Z";
    const uppercase = "ABCDEF0123456789";
    const lowercase = uppercase.toLowerCase();

    const opened = receiver.receive(
      lifecyclePayload("firing", startsAt, uppercase),
      1,
    ).opened[0];
    const resolved = receiver.receive(
      lifecyclePayload("resolved", startsAt, lowercase),
      2,
    );

    expect(opened?.fingerprint).toBe(lowercase);
    expect(resolved.resolved).toHaveLength(1);
    expect(receiver.isOpen(lowercase)).toBe(false);
  });

  test("uses collision-safe canonical labels when fingerprint is omitted", () => {
    const receiver = new IncidentReceiver({ debounceMs: 0 });
    const payload = (labels: Readonly<Record<string, string>>): unknown => ({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels,
          startsAt: "2026-07-25T14:03:00Z",
        },
      ],
    });

    const first = receiver.receive(
      payload({ a: "b\nc=d", severity: "critical" }),
      1,
    ).opened[0];
    const second = receiver.receive(
      payload({ a: "b", c: "d", severity: "critical" }),
      2,
    ).opened[0];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  test("rejects non-hexadecimal supplied fingerprints", () => {
    const receiver = new IncidentReceiver({ debounceMs: 0 });

    expect(() =>
      receiver.receive(
        lifecyclePayload(
          "firing",
          "2026-07-25T14:03:00Z",
          "token=supersecret",
        ),
      ),
    ).toThrow("fingerprint must contain 16 to 64 hexadecimal characters");
  });

  test("bounds lifecycle state while preserving the resolution debounce window", () => {
    const receiver = new IncidentReceiver({
      debounceMs: 1_000,
      maxTrackedIncidents: 1,
    });
    const secondFingerprint = "0a19d85e7cafe132";

    receiver.receive(lifecyclePayload("firing", "2026-07-25T14:03:00Z"), 0);
    receiver.receive(lifecyclePayload("resolved", "2026-07-25T14:03:00Z"), 1);

    const rejected = receiver.receive(
      lifecyclePayload(
        "firing",
        "2026-07-25T14:04:00Z",
        secondFingerprint,
      ),
      1_000,
    );
    expect(rejected.capacityRejectedCount).toBe(1);

    const accepted = receiver.receive(
      lifecyclePayload(
        "firing",
        "2026-07-25T14:04:00Z",
        secondFingerprint,
      ),
      1_001,
    );
    expect(accepted.opened.map((incident) => incident.fingerprint)).toEqual([
      secondFingerprint,
    ]);
  });

  test("commits a resolution even when a later firing exceeds state capacity", () => {
    const receiver = new IncidentReceiver({
      debounceMs: 1_000,
      maxTrackedIncidents: 1,
    });
    const oldStart = "2026-07-25T14:03:00Z";
    const nextFingerprint = "0a19d85e7cafe132";
    receiver.receive(lifecyclePayload("firing", oldStart), 0);

    const mixed = receiver.receive(
      {
        status: "firing",
        alerts: [
          {
            status: "resolved",
            labels: sharedLabels,
            annotations: {},
            startsAt: oldStart,
            fingerprint: "7f0dcb4fc25a9e2b",
          },
          {
            status: "firing",
            labels: sharedLabels,
            annotations: {},
            startsAt: "2026-07-25T14:04:00Z",
            fingerprint: nextFingerprint,
          },
        ],
      },
      1,
    );

    expect(mixed.resolved).toHaveLength(1);
    expect(mixed.opened).toEqual([]);
    expect(mixed.capacityRejectedCount).toBe(1);
    expect(receiver.isOpen("7f0dcb4fc25a9e2b")).toBe(false);
    expect(receiver.isOpen(nextFingerprint)).toBe(false);
  });
});
