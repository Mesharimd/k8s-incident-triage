import { describe, expect, test } from "bun:test";

import type { Incident } from "../src/incident";
import { IncidentReceiver } from "../src/incident";
import {
  createAlertRequestHandler,
  loadServerConfig,
} from "../src/server";

const firingFixture: unknown = await Bun.file(
  new URL("fixtures/alert-firing.json", import.meta.url),
).json();

describe("POST /alerts", () => {
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
      },
    });
  });
});
