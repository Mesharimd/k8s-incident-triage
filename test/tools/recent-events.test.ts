import { describe, expect, test } from "bun:test";

import {
  getRecentEvents,
  getRecentEventsDefinition,
  type KubernetesEventsApi,
} from "../../src/tools/recent-events";
import { MAX_TOOL_RESULT_BYTES, ToolExecutionError, ToolInputError } from "../../src/tools/result";

const recentEventsFixture: unknown = await Bun.file(
  new URL("../fixtures/events-recent.json", import.meta.url),
).json();

describe("get_recent_events", () => {
  test("returns recent Core/v1 events newest first using Kubernetes timestamp precedence", async () => {
    const requests: unknown[] = [];
    const api: KubernetesEventsApi = {
      listNamespacedEvents: async (request) => {
        requests.push(request);
        return recentEventsFixture;
      },
    };

    const result = await getRecentEvents(
      { namespace: "payments", minutes: 5 },
      { api, now: () => new Date("2026-07-25T15:20:00Z") },
    );

    expect(requests).toEqual([{ namespace: "payments", limit: 500 }]);
    expect(JSON.parse(result.content)).toEqual({
      namespace: "payments",
      window: {
        start: "2026-07-25T15:15:00.000Z",
        end: "2026-07-25T15:20:00.000Z",
        minutes: 5,
      },
      events: [
        {
          timestamp: "2026-07-25T15:19:45.000Z",
          type: "Warning",
          reason: "BackOff",
          regarding: { kind: "Pod", name: "checkout-api-5b48f95f67-9mh8k" },
          count: 8,
          note: "Back-off restarting failed container checkout",
          reportingComponent: "kubelet",
        },
        {
          timestamp: "2026-07-25T15:19:00.000Z",
          type: "Warning",
          reason: "Unhealthy",
          regarding: { kind: "Pod", name: "checkout-api-5b48f95f67-9mh8k" },
          count: 3,
          note: "Readiness probe failed: HTTP probe failed with statuscode: 503",
          reportingComponent: "kubelet",
        },
        {
          timestamp: "2026-07-25T15:18:00.000Z",
          type: "Normal",
          reason: "Pulled",
          regarding: { kind: "Pod", name: "checkout-api-5b48f95f67-vs7jn" },
          count: 1,
          note: "Successfully pulled image registry.example.com/checkout:v42",
          reportingComponent: "kubelet",
        },
        {
          timestamp: "2026-07-25T15:17:00.000Z",
          type: "Normal",
          reason: "Scheduled",
          regarding: { kind: "Pod", name: "checkout-api-5b48f95f67-vs7jn" },
          count: 1,
          note: "Successfully assigned payments/checkout-api-5b48f95f67-vs7jn to worker-2",
          reportingComponent: "default-scheduler",
        },
      ],
      scannedEvents: 5,
      matchingEvents: 4,
      omittedMatchingEvents: 0,
      incomplete: false,
    });
    expect(result).toMatchObject({ truncated: false, truncationReasons: [] });
    expect(result.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  test("scans at most 500, returns at most 50, and marks bounded notes incomplete", async () => {
    const items = Array.from({ length: 520 }, (_, index) => ({
      apiVersion: "v1",
      kind: "Event",
      metadata: {
        name: `worker-${index}.18f119fc95a52fd1`,
        namespace: "payments",
        creationTimestamp: new Date(Date.parse("2026-07-25T15:19:59Z") - index).toISOString(),
      },
      involvedObject: { kind: "Pod", namespace: "payments", name: `worker-${index}` },
      reason: "BackOff",
      message: index === 0 ? "🔥".repeat(2_000) : `Back-off worker-${index}`,
      type: "Warning",
      count: 1,
    }));
    const api: KubernetesEventsApi = {
      listNamespacedEvents: async () => ({
        apiVersion: "v1",
        kind: "EventList",
        metadata: { continue: "next-page-token", remainingItemCount: 20 },
        items,
      }),
    };

    const result = await getRecentEvents(
      { namespace: "payments", minutes: 5 },
      { api, now: () => new Date("2026-07-25T15:20:00Z") },
    );
    const content = JSON.parse(result.content) as {
      events: readonly { note: string | null }[];
      scannedEvents: number;
      matchingEvents: number;
      omittedMatchingEvents: number;
      incomplete: boolean;
    };

    expect(content.events).toHaveLength(50);
    expect(content.scannedEvents).toBe(500);
    expect(content.matchingEvents).toBe(500);
    expect(content.omittedMatchingEvents).toBe(450);
    expect(new TextEncoder().encode(content.events[0]?.note ?? "").byteLength).toBeLessThanOrEqual(2_048);
    expect(content.incomplete).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual([
      "source_pagination",
      "scan_limit",
      "event_limit",
      "event_note_limit",
    ]);
    expect(result.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  test("publishes a strict schema and rejects unsafe namespaces", async () => {
    expect(getRecentEventsDefinition).toMatchObject({
      name: "get_recent_events",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["namespace", "minutes"],
        properties: {
          namespace: {
            type: "string",
            minLength: 1,
            maxLength: 63,
            pattern: "^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$",
          },
          minutes: { type: "integer", minimum: 1, maximum: 1440 },
        },
      },
    });

    const api: KubernetesEventsApi = {
      listNamespacedEvents: async () => recentEventsFixture,
    };
    await expect(
      getRecentEvents({ namespace: "payments/../../secrets", minutes: 5 }, { api }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  test("rejects malformed EventList responses at the Kubernetes boundary", async () => {
    const api: KubernetesEventsApi = {
      listNamespacedEvents: async () => ({
        apiVersion: "v1",
        kind: "EventList",
        items: [{ metadata: {}, involvedObject: "pod", count: "many" }],
      }),
    };

    await expect(
      getRecentEvents({ namespace: "payments", minutes: 5 }, { api }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});
