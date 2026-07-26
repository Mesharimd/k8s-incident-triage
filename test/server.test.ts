import { describe, expect, test } from "bun:test";

import type { TriageRunResult } from "../src/agent/loop";
import type { Incident } from "../src/incident";
import { IncidentReceiver } from "../src/incident";
import { IncidentQueueFullError } from "../src/pipeline";
import { TelegramDeliveryError } from "../src/telegram";
import {
  createAlertRequestHandler,
  createIncidentRuntime,
  loadServerConfig,
} from "../src/server";

const firingFixture: unknown = await Bun.file(
  new URL("fixtures/alert-firing.json", import.meta.url),
).json();

const insufficientResult: TriageRunResult = {
  runId: "runtime-run-fixture",
  report: {
    status: "insufficient_data",
    probableCause: null,
    evidence: [],
    suggestions: [],
    recentChanges: [],
    uncertainties: ["No conclusive evidence was available."],
  },
  toolCalls: [],
};

function alertRequest(payload: unknown = firingFixture): Request {
  return new Request("http://localhost/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /alerts", () => {
  test("serves a side-effect-free health probe without accepting other GET routes", async () => {
    const handler = createAlertRequestHandler({
      receiver: new IncidentReceiver({ debounceMs: 60_000 }),
      onIncident: () => undefined,
    });

    const healthy = await handler(
      new Request("http://localhost/healthz", { method: "GET" }),
    );
    const missing = await handler(
      new Request("http://localhost/not-a-route", { method: "GET" }),
    );

    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: "ok" });
    expect(missing.status).toBe(404);
  });

  test("reports readiness from the bounded incident dispatcher", async () => {
    let ready = false;
    const handler = createAlertRequestHandler({
      receiver: new IncidentReceiver({ debounceMs: 60_000 }),
      onIncident: () => undefined,
      isReady: () => ready,
    });

    const unavailable = await handler(
      new Request("http://localhost/readyz", { method: "GET" }),
    );
    ready = true;
    const available = await handler(
      new Request("http://localhost/readyz", { method: "GET" }),
    );

    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });
    expect(available.status).toBe(200);
    expect(await available.json()).toEqual({ status: "ok" });
  });

  test("accepts normalized incidents and does not dispatch duplicates", async () => {
    const dispatched: Incident[] = [];
    const handler = createAlertRequestHandler({
      receiver: new IncidentReceiver({ debounceMs: 60_000 }),
      onIncident: (incident) => {
        dispatched.push(incident);
      },
    });
    const makeRequest = (): Request =>
      new Request("http://localhost/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(firingFixture),
      });

    const first = await handler(makeRequest());
    const duplicate = await handler(makeRequest());

    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({
      accepted: 1,
      resolved: 0,
      duplicates: 0,
      filtered: 0,
    });
    expect(await duplicate.json()).toMatchObject({
      accepted: 0,
      duplicates: 1,
    });
    expect(dispatched).toHaveLength(1);
  });

  test("rejects malformed webhook payloads", async () => {
    const handler = createAlertRequestHandler({
      receiver: new IncidentReceiver({ debounceMs: 60_000 }),
      onIncident: () => undefined,
    });

    const response = await handler(
      new Request("http://localhost/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "firing" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "alerts must be an array" });
  });

  test("releases a dedupe reservation when incident dispatch fails", async () => {
    let attempts = 0;
    const handler = createAlertRequestHandler({
      receiver: new IncidentReceiver({ debounceMs: 60_000 }),
      onIncident: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("dispatch failed");
        }
      },
    });
    const makeRequest = (): Request =>
      new Request("http://localhost/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(firingFixture),
      });

    await expect(handler(makeRequest())).rejects.toThrow("dispatch failed");
    const retry = await handler(makeRequest());

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(attempts).toBe(2);
  });

  test("returns a retryable response when the bounded incident queue is full", async () => {
    let attempts = 0;
    const handler = createAlertRequestHandler({
      receiver: new IncidentReceiver({ debounceMs: 60_000 }),
      onIncident: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new IncidentQueueFullError();
        }
      },
    });
    const request = (): Request =>
      new Request("http://localhost/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(firingFixture),
      });

    const unavailable = await handler(request());
    const retried = await handler(request());

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("5");
    expect(await unavailable.json()).toEqual({
      error: "incident queue is at capacity",
    });
    expect(retried.status).toBe(202);
    expect(attempts).toBe(2);
  });

  test("returns a bounded retryable response when incident lifecycle state is full", async () => {
    const receiver = new IncidentReceiver({
      debounceMs: 60_000,
      maxTrackedIncidents: 1,
    });
    const handler = createAlertRequestHandler({
      receiver,
      onIncident: () => undefined,
    });
    const secondAlert: unknown = {
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: "SecondAlert",
            namespace: "payments",
            pod: "checkout-second",
            severity: "critical",
          },
          annotations: { summary: "second lifecycle" },
          startsAt: "2026-07-25T14:04:00Z",
          fingerprint: "0a19d85e7cafe132",
        },
      ],
    };

    expect((await handler(alertRequest())).status).toBe(202);
    const unavailable = await handler(alertRequest(secondAlert));

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("5");
    expect(await unavailable.json()).toEqual({
      error: "incident state is at capacity",
    });
  });

  test("dispatches a resolution before rejecting a later firing at state capacity", async () => {
    const receiver = new IncidentReceiver({
      debounceMs: 60_000,
      maxTrackedIncidents: 1,
    });
    const opened: Incident[] = [];
    const resolved: Incident[] = [];
    const handler = createAlertRequestHandler({
      receiver,
      onIncident: (incident) => {
        opened.push(incident);
      },
      onResolved: (incident) => {
        resolved.push(incident);
      },
    });

    expect((await handler(alertRequest())).status).toBe(202);
    opened.length = 0;
    const response = await handler(
      alertRequest({
        status: "firing",
        alerts: [
          {
            status: "resolved",
            labels: {
              alertname: "PodMemoryPressure",
              namespace: "payments",
              pod: "checkout-api-7c8f6f6d8b-r4x9n",
              severity: "critical",
            },
            annotations: {},
            startsAt: "2026-07-25T14:03:00Z",
            fingerprint: "7f0dcb4fc25a9e2b",
          },
          {
            status: "firing",
            labels: {
              alertname: "SecondAlert",
              namespace: "payments",
              pod: "checkout-second",
              severity: "critical",
            },
            annotations: {},
            startsAt: "2026-07-25T14:04:00Z",
            fingerprint: "0a19d85e7cafe132",
          },
        ],
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(resolved.map((incident) => incident.fingerprint)).toEqual([
      "7f0dcb4fc25a9e2b",
    ]);
    expect(opened).toEqual([]);
    expect(receiver.isOpen("7f0dcb4fc25a9e2b")).toBe(false);
  });

  test("dispatches resolved incidents", async () => {
    const resolved: Incident[] = [];
    const receiver = new IncidentReceiver({ debounceMs: 60_000 });
    const handler = createAlertRequestHandler({
      receiver,
      onIncident: () => undefined,
      onResolved: (incident) => {
        resolved.push(incident);
      },
    });
    const resolvedFixture: unknown = await Bun.file(
      new URL("fixtures/alert-resolved.json", import.meta.url),
    ).json();
    const request = (payload: unknown): Request =>
      new Request("http://localhost/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    await handler(request(firingFixture));
    const response = await handler(request(resolvedFixture));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: 0, resolved: 1 });
    expect(resolved).toHaveLength(1);
  });

  test("rejects incident content that exceeds the bounded contract", async () => {
    const handler = createAlertRequestHandler({
      receiver: new IncidentReceiver({ debounceMs: 60_000 }),
      onIncident: () => undefined,
    });
    const oversizedPayload: unknown = {
      status: "firing",
      commonLabels: {},
      commonAnnotations: {},
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: "HugeAnnotation",
            namespace: "payments",
            pod: "checkout-0",
            severity: "critical",
          },
          annotations: { description: "x".repeat(4_097) },
          startsAt: "2026-07-25T14:03:00Z",
          fingerprint: "4f9b2de6e89d5b1a",
        },
      ],
    };

    const response = await handler(
      new Request("http://localhost/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(oversizedPayload),
      }),
    );

    expect(response.status).toBe(413);
  });
});

describe("server configuration", () => {
  test("loads debounce and filtering controls from environment values", () => {
    expect(
      loadServerConfig({
        PORT: "4040",
        ALERT_DEBOUNCE_SECONDS: "120",
        MIN_SEVERITY: "critical",
        NAMESPACE_ALLOWLIST: "payments, checkout ",
        NAMESPACE_DENYLIST: "kube-system",
      }),
    ).toEqual({
      port: 4040,
      receiver: {
        debounceMs: 120_000,
        minSeverity: "critical",
        namespaceAllowlist: ["payments", "checkout"],
        namespaceDenylist: ["kube-system"],
        maxTrackedIncidents: 1_000,
      },
    });
  });

  test("rejects unsafe ports, debounce values, and lifecycle capacities", () => {
    expect(() => loadServerConfig({ PORT: "70000" })).toThrow(
      "PORT must be between 1 and 65535",
    );
    expect(() => loadServerConfig({ PORT: "3e3" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    );
    expect(() =>
      loadServerConfig({ ALERT_DEBOUNCE_SECONDS: "86401" }),
    ).toThrow("ALERT_DEBOUNCE_SECONDS must be between 0 and 86400");
    expect(() =>
      loadServerConfig({ ALERT_DEBOUNCE_SECONDS: "9007199254740992" }),
    ).toThrow("ALERT_DEBOUNCE_SECONDS must be between 0 and 86400");
    expect(() => loadServerConfig({ INCIDENT_STATE_CAPACITY: "2001" })).toThrow(
      "INCIDENT_STATE_CAPACITY must be between 1 and 2000",
    );
  });
});

describe("incident runtime", () => {
  test("acknowledges the webhook before background triage and delivery finish", async () => {
    let releaseTriage: ((result: TriageRunResult) => void) | undefined;
    const triageBlocked = new Promise<TriageRunResult>((resolve) => {
      releaseTriage = resolve;
    });
    const delivered: string[] = [];
    const runtime = createIncidentRuntime({}, {
      agent: { triage: async () => triageBlocked },
      deliver: async (report) => {
        delivered.push(report);
      },
    });

    const response = await runtime.handler(alertRequest());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: 1 });
    expect(runtime.worker.activeCount).toBe(1);
    expect(delivered).toEqual([]);

    releaseTriage?.(insufficientResult);
    await runtime.worker.drain();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("Run ID: runtime-run-fixture");
  });

  test("stays ready while saturated so resolution webhooks remain routable", async () => {
    let releaseTriage: ((result: TriageRunResult) => void) | undefined;
    const triageBlocked = new Promise<TriageRunResult>((resolve) => {
      releaseTriage = resolve;
    });
    const runtime = createIncidentRuntime(
      { INCIDENT_QUEUE_CAPACITY: "1", INCIDENT_CONCURRENCY: "1" },
      {
        agent: { triage: async () => triageBlocked },
        deliver: async () => undefined,
      },
    );
    const anotherAlert: unknown = {
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: "AnotherAlert",
            namespace: "payments",
            pod: "checkout-another",
            severity: "critical",
          },
          annotations: {},
          startsAt: "2026-07-26T09:00:00Z",
          fingerprint: "0a19d85e7cafe132",
        },
      ],
    };

    await runtime.handler(alertRequest());
    const readiness = await runtime.handler(
      new Request("http://localhost/readyz", { method: "GET" }),
    );
    const saturated = await runtime.handler(alertRequest(anotherAlert));

    expect(readiness.status).toBe(200);
    expect(saturated.status).toBe(503);
    releaseTriage?.(insufficientResult);
    await runtime.worker.drain();
  });

  test("suppresses an active report when Alertmanager resolves the exact incident", async () => {
    let releaseTriage: ((result: TriageRunResult) => void) | undefined;
    const triageBlocked = new Promise<TriageRunResult>((resolve) => {
      releaseTriage = resolve;
    });
    let deliveryCount = 0;
    const runtime = createIncidentRuntime({}, {
      agent: { triage: async () => triageBlocked },
      deliver: async () => {
        deliveryCount += 1;
      },
    });
    const resolvedFixture: unknown = await Bun.file(
      new URL("fixtures/alert-resolved.json", import.meta.url),
    ).json();

    const firing = await runtime.handler(alertRequest());
    const resolved = await runtime.handler(alertRequest(resolvedFixture));
    releaseTriage?.(insufficientResult);
    await runtime.worker.drain();

    expect(firing.status).toBe(202);
    expect(resolved.status).toBe(202);
    expect(await resolved.json()).toMatchObject({ resolved: 1 });
    expect(deliveryCount).toBe(0);
  });

  test("aborts an exact incident that resolves during active delivery", async () => {
    let deliveryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    const events: string[] = [];
    const runtime = createIncidentRuntime({}, {
      agent: { triage: async () => insufficientResult },
      deliver: async (_report, options) => {
        deliveryStarted?.();
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("cancelled fixture transport");
      },
      record: (event) => events.push(event.event),
    });
    const resolvedFixture: unknown = await Bun.file(
      new URL("fixtures/alert-resolved.json", import.meta.url),
    ).json();

    await runtime.handler(alertRequest());
    await started;
    await runtime.handler(alertRequest(resolvedFixture));
    await runtime.worker.drain();

    expect(events).toContain("incident.resolved");
    expect(events).toContain("incident.superseded");
    expect(events).not.toContain("incident.delivery_failed");
  });

  test("keeps a same-webhook reopen when resolving the older matching fingerprint", async () => {
    let releaseFirst: ((result: TriageRunResult) => void) | undefined;
    const firstBlocked = new Promise<TriageRunResult>((resolve) => {
      releaseFirst = resolve;
    });
    let triageCalls = 0;
    let deliveryCount = 0;
    const runtime = createIncidentRuntime(
      { ALERT_DEBOUNCE_SECONDS: "0", INCIDENT_CONCURRENCY: "1" },
      {
        agent: {
          triage: async () => {
            triageCalls += 1;
            return triageCalls === 1 ? firstBlocked : insufficientResult;
          },
        },
        deliver: async () => {
          deliveryCount += 1;
        },
      },
    );
    const labels = {
      alertname: "PodMemoryPressure",
      namespace: "payments",
      pod: "checkout-api-7c8f6f6d8b-r4x9n",
      severity: "critical",
      container: "checkout-api",
    };
    const resolvedAndReopened: unknown = {
      status: "firing",
      commonLabels: {},
      commonAnnotations: {},
      alerts: [
        {
          status: "resolved",
          labels,
          annotations: { summary: "old alert resolved" },
          startsAt: "2026-07-25T14:03:00Z",
          fingerprint: "7f0dcb4fc25a9e2b",
        },
        {
          status: "firing",
          labels,
          annotations: { summary: "new alert opened" },
          startsAt: "2026-07-25T14:12:00Z",
          fingerprint: "7f0dcb4fc25a9e2b",
        },
      ],
    };

    await runtime.handler(alertRequest());
    const mixed = await runtime.handler(alertRequest(resolvedAndReopened));
    expect(await mixed.json()).toMatchObject({ accepted: 1, resolved: 1 });

    releaseFirst?.(insufficientResult);
    await runtime.worker.drain();

    expect(triageCalls).toBe(2);
    expect(deliveryCount).toBe(1);
  });

  test("releases dedupe state after a background delivery failure", async () => {
    let deliveryAttempts = 0;
    const runtime = createIncidentRuntime({}, {
      agent: { triage: async () => insufficientResult },
      deliver: async () => {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) {
          throw new Error("fixture delivery failure");
        }
      },
    });

    const first = await runtime.handler(alertRequest());
    await runtime.worker.drain();
    const retry = await runtime.handler(alertRequest());
    await runtime.worker.drain();

    expect(first.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(deliveryAttempts).toBe(2);
  });

  test("retains dedupe and records counts after a partial Telegram delivery", async () => {
    let deliveryAttempts = 0;
    const recorded: unknown[] = [];
    const runtime = createIncidentRuntime({}, {
      agent: { triage: async () => insufficientResult },
      deliver: async () => {
        deliveryAttempts += 1;
        throw new TelegramDeliveryError(
          "fixture failed after one chunk",
          1,
          2,
          false,
        );
      },
      record: (event) => recorded.push(event),
    });

    await runtime.handler(alertRequest());
    await runtime.worker.drain();
    const resend = await runtime.handler(alertRequest());

    expect(await resend.json()).toMatchObject({
      accepted: 0,
      duplicates: 1,
    });
    expect(deliveryAttempts).toBe(1);
    expect(recorded).toContainEqual({
      event: "incident.delivery_failed",
      fingerprint: "7f0dcb4fc25a9e2b",
      errorKind: "TelegramDeliveryError",
      sentCount: 1,
      totalCount: 2,
      retrySafe: false,
      fatalConfiguration: false,
    });
  });

  test("records a safe diagnostic when Telegram permanently rejects its configuration", async () => {
    const recorded: unknown[] = [];
    const runtime = createIncidentRuntime({}, {
      agent: { triage: async () => insufficientResult },
      deliver: async () => {
        throw new TelegramDeliveryError(
          "fixture credential rejection",
          0,
          1,
          true,
          true,
        );
      },
      record: (event) => recorded.push(event),
    });

    await runtime.handler(alertRequest());
    await runtime.worker.drain();

    expect(recorded).toContainEqual({
      event: "incident.delivery_failed",
      fingerprint: "7f0dcb4fc25a9e2b",
      errorKind: "TelegramDeliveryError",
      sentCount: 0,
      totalCount: 1,
      retrySafe: true,
      fatalConfiguration: true,
    });
  });

  test("releases dedupe after a Telegram failure proven safe to retry", async () => {
    let deliveryAttempts = 0;
    const runtime = createIncidentRuntime({}, {
      agent: { triage: async () => insufficientResult },
      deliver: async () => {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) {
          throw new TelegramDeliveryError(
            "fixture rejected before delivery",
            0,
            1,
            true,
          );
        }
      },
    });

    await runtime.handler(alertRequest());
    await runtime.worker.drain();
    const retry = await runtime.handler(alertRequest());
    await runtime.worker.drain();

    expect(await retry.json()).toMatchObject({
      accepted: 1,
      duplicates: 0,
    });
    expect(deliveryAttempts).toBe(2);
  });

  test("stops readiness, cancels pending work, and settles active work on shutdown", async () => {
    let releaseTriage: ((result: TriageRunResult) => void) | undefined;
    const triageBlocked = new Promise<TriageRunResult>((resolve) => {
      releaseTriage = resolve;
    });
    let triageCalls = 0;
    const runtime = createIncidentRuntime(
      { INCIDENT_CONCURRENCY: "1", INCIDENT_QUEUE_CAPACITY: "2" },
      {
        agent: {
          triage: async () => {
            triageCalls += 1;
            return triageBlocked;
          },
        },
        deliver: async () => undefined,
      },
    );
    const pendingIncident: Incident = {
      alertname: "PendingAlert",
      namespace: "payments",
      pod: "checkout-pending",
      severity: "critical",
      fingerprint: "pending-shutdown-fixture",
      startsAt: "2026-07-26T09:00:00Z",
      labels: {},
      annotations: {},
    };

    await runtime.handler(alertRequest());
    runtime.worker.submit(pendingIncident);
    const shutdown = runtime.shutdown();
    const readiness = await runtime.handler(
      new Request("http://localhost/readyz", { method: "GET" }),
    );

    expect(readiness.status).toBe(503);
    expect(runtime.worker.pendingCount).toBe(0);
    releaseTriage?.(insufficientResult);
    await expect(shutdown).resolves.toEqual({ cancelledPending: 1 });
    expect(triageCalls).toBe(1);
  });
});
