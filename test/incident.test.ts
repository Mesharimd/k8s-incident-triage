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
});
