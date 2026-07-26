import { describe, expect, test } from "bun:test";

import type { TriageRunResult } from "../src/agent/loop";
import type { Incident } from "../src/incident";
import {
  BoundedIncidentQueue,
  IncidentQueueFullError,
  IncidentWorker,
  loadIncidentQueueConfig,
  processCurrentIncident,
} from "../src/pipeline";

function incident(fingerprint: string): Incident {
  return {
    alertname: "KubePodContainerRestarting",
    namespace: "payments",
    pod: `checkout-${fingerprint}`,
    severity: "critical",
    fingerprint,
    startsAt: "2026-07-26T08:55:00Z",
    labels: {
      alertname: "KubePodContainerRestarting",
      namespace: "payments",
      pod: `checkout-${fingerprint}`,
      severity: "critical",
    },
    annotations: { summary: "checkout is restarting" },
  };
}

const insufficientResult: TriageRunResult = {
  runId: "run-pipeline-fixture",
  report: {
    status: "insufficient_data",
    probableCause: null,
    evidence: [],
    suggestions: [],
    recentChanges: [],
    uncertainties: ["The provider deadline was reached."],
  },
  toolCalls: [],
};

describe("current incident processing", () => {
  test("triages, formats, and delivers one current incident", async () => {
    const value = incident("current");
    const delivered: string[] = [];

    const outcome = await processCurrentIncident(value, {
      agent: { triage: async () => insufficientResult },
      isCurrentOpen: (candidate) => candidate === value,
      deliver: async (text) => {
        delivered.push(text);
      },
    });

    expect(outcome).toEqual({
      status: "delivered",
      runId: "run-pipeline-fixture",
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("🔥 Alert");
    expect(delivered[0]).toContain("No probable cause was established.");
  });

  test("does not spend model tokens on an incident already superseded", async () => {
    let triageCalls = 0;
    let deliveryCalls = 0;

    const outcome = await processCurrentIncident(incident("resolved"), {
      agent: {
        triage: async () => {
          triageCalls += 1;
          return insufficientResult;
        },
      },
      isCurrentOpen: () => false,
      deliver: async () => {
        deliveryCalls += 1;
      },
    });

    expect(outcome).toEqual({ status: "superseded" });
    expect(triageCalls).toBe(0);
    expect(deliveryCalls).toBe(0);
  });

  test("suppresses a stale report when the incident resolves during triage", async () => {
    let current = true;
    let deliveryCalls = 0;

    const outcome = await processCurrentIncident(incident("during-triage"), {
      agent: {
        triage: async () => {
          current = false;
          return insufficientResult;
        },
      },
      isCurrentOpen: () => current,
      deliver: async () => {
        deliveryCalls += 1;
      },
    });

    expect(outcome).toEqual({ status: "superseded" });
    expect(deliveryCalls).toBe(0);
  });

  test("passes an exact-currentness guard into delivery and classifies cancellation as superseded", async () => {
    let current = true;
    const value = incident("during-delivery");

    const outcome = await processCurrentIncident(value, {
      agent: { triage: async () => insufficientResult },
      isCurrentOpen: (candidate) => current && candidate === value,
      deliver: async (_text, options) => {
        current = false;
        if (!options.shouldContinue()) {
          throw new Error("stale delivery cancelled");
        }
      },
    });

    expect(outcome).toEqual({ status: "superseded" });
  });
});

describe("incident worker cancellation", () => {
  test("passes exact-incident cancellation into active triage", async () => {
    const value = incident("active-triage");
    let triageStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      triageStarted = resolve;
    });
    const outcomes: string[] = [];
    const worker = new IncidentWorker({
      config: { capacity: 1, concurrency: 1 },
      agent: {
        triage: async (_incident, options) => {
          triageStarted?.();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted === true) {
              resolve();
              return;
            }
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return insufficientResult;
        },
      },
      isCurrentOpen: (candidate) => candidate === value,
      deliver: async () => {
        throw new Error("cancelled triage must not reach delivery");
      },
      onOutcome: (_incident, outcome) => outcomes.push(outcome.status),
    });

    worker.submit(value);
    await started;
    expect(worker.resolve(value)).toBe(0);
    await worker.drain();

    expect(outcomes).toEqual(["superseded"]);
  });

  test("aborts active delivery for the exact resolved incident", async () => {
    const value = incident("active-delivery");
    const outcomes: string[] = [];
    let deliveryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    const worker = new IncidentWorker({
      config: { capacity: 1, concurrency: 1 },
      agent: { triage: async () => insufficientResult },
      isCurrentOpen: (candidate) => candidate === value,
      deliver: async (_text, options) => {
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
        throw new Error("cancelled transport");
      },
      onOutcome: (_incident, outcome) => outcomes.push(outcome.status),
    });

    worker.submit(value);
    await started;
    expect(worker.resolve(value)).toBe(0);
    await worker.drain();

    expect(outcomes).toEqual(["superseded"]);
  });
});

describe("bounded incident queue", () => {
  test("acknowledges enqueue immediately and drains accepted incidents", async () => {
    const completed: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new BoundedIncidentQueue({
      config: { capacity: 3, concurrency: 1 },
      process: async (value) => {
        if (value.fingerprint === "first") {
          await firstBlocked;
        }
        completed.push(value.fingerprint);
      },
    });

    queue.enqueue(incident("first"));
    queue.enqueue(incident("second"));

    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(1);
    expect(completed).toEqual([]);

    releaseFirst?.();
    await queue.drain();

    expect(completed).toEqual(["first", "second"]);
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  test("never starts more than the configured concurrency", async () => {
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const queue = new BoundedIncidentQueue({
      config: { capacity: 4, concurrency: 2 },
      process: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
      },
    });

    queue.enqueue(incident("one"));
    queue.enqueue(incident("two"));
    queue.enqueue(incident("three"));
    queue.enqueue(incident("four"));

    expect(queue.activeCount).toBe(2);
    expect(queue.pendingCount).toBe(2);
    expect(peak).toBe(2);

    releases.shift()?.();
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);

    for (const release of releases.splice(0)) {
      release();
    }
    await queue.drain();
  });

  test("fails closed when the total accepted work reaches capacity", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new BoundedIncidentQueue({
      config: { capacity: 2, concurrency: 1 },
      process: async () => blocked,
    });

    queue.enqueue(incident("active"));
    queue.enqueue(incident("pending"));

    expect(queue.accepting).toBe(false);
    expect(() => queue.enqueue(incident("rejected"))).toThrow(
      IncidentQueueFullError,
    );

    release?.();
    await queue.drain();
    expect(queue.accepting).toBe(true);
  });

  test("cancels a resolved incident before pending triage starts", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processed: string[] = [];
    const queue = new BoundedIncidentQueue({
      config: { capacity: 3, concurrency: 1 },
      process: async (value) => {
        processed.push(value.fingerprint);
        if (value.fingerprint === "active") {
          await blocked;
        }
      },
    });

    const active = incident("active");
    const resolved = incident("resolved");
    queue.enqueue(active);
    queue.enqueue(resolved);

    expect(queue.cancelPending(resolved)).toBe(1);
    expect(queue.pendingCount).toBe(0);

    release?.();
    await queue.drain();
    expect(processed).toEqual(["active"]);
  });

  test("stops admission and cancels pending work during graceful shutdown", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processed: string[] = [];
    const queue = new BoundedIncidentQueue({
      config: { capacity: 3, concurrency: 1 },
      process: async (value) => {
        processed.push(value.fingerprint);
        if (value.fingerprint === "active") {
          await blocked;
        }
      },
    });

    queue.enqueue(incident("active"));
    queue.enqueue(incident("pending"));
    const cancelled = queue.closeAndCancelPending();

    expect(cancelled.map((value) => value.fingerprint)).toEqual(["pending"]);
    expect(queue.accepting).toBe(false);
    expect(() => queue.enqueue(incident("late"))).toThrow(
      IncidentQueueFullError,
    );
    release?.();
    await queue.drain();
    expect(processed).toEqual(["active"]);
  });

  test("does not cancel a reopened incident that shares the old fingerprint", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processed: Incident[] = [];
    const active = incident("active");
    const oldIncident = incident("shared");
    const reopenedIncident = incident("shared");
    const queue = new BoundedIncidentQueue({
      config: { capacity: 3, concurrency: 1 },
      process: async (value) => {
        processed.push(value);
        if (value === active) {
          await blocked;
        }
      },
    });

    queue.enqueue(active);
    queue.enqueue(reopenedIncident);

    expect(queue.cancelPending(oldIncident)).toBe(0);
    expect(queue.pendingCount).toBe(1);

    release?.();
    await queue.drain();
    expect(processed).toEqual([active, reopenedIncident]);
  });

  test("reports processing failures without poisoning later work", async () => {
    const processed: string[] = [];
    const failures: { fingerprint: string; error: unknown }[] = [];
    const queue = new BoundedIncidentQueue({
      config: { capacity: 3, concurrency: 1 },
      process: async (value) => {
        processed.push(value.fingerprint);
        if (value.fingerprint === "bad") {
          throw new Error("delivery failed");
        }
      },
      onFailure: (value, error) => {
        failures.push({ fingerprint: value.fingerprint, error });
      },
    });

    queue.enqueue(incident("bad"));
    queue.enqueue(incident("good"));
    await queue.drain();

    expect(processed).toEqual(["bad", "good"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fingerprint).toBe("bad");
    expect(failures[0]?.error).toBeInstanceOf(Error);
  });
});

describe("incident queue configuration", () => {
  test("loads bounded defaults and explicit values", () => {
    expect(loadIncidentQueueConfig({})).toEqual({
      capacity: 100,
      concurrency: 2,
    });
    expect(
      loadIncidentQueueConfig({
        INCIDENT_QUEUE_CAPACITY: "24",
        INCIDENT_CONCURRENCY: "3",
      }),
    ).toEqual({ capacity: 24, concurrency: 3 });
  });

  test("rejects unsafe, empty, or excessive concurrency settings", () => {
    expect(() =>
      loadIncidentQueueConfig({ INCIDENT_QUEUE_CAPACITY: "0" }),
    ).toThrow("INCIDENT_QUEUE_CAPACITY must be between 1 and 1000");
    expect(() =>
      loadIncidentQueueConfig({ INCIDENT_CONCURRENCY: "11" }),
    ).toThrow("INCIDENT_CONCURRENCY must be between 1 and 10");
    expect(() =>
      loadIncidentQueueConfig({ INCIDENT_CONCURRENCY: "1.5" }),
    ).toThrow("INCIDENT_CONCURRENCY must be an integer");
  });

  test("revalidates direct queue configuration at the execution boundary", () => {
    const process = async (): Promise<void> => undefined;

    expect(
      () =>
        new BoundedIncidentQueue({
          config: { capacity: 1_001, concurrency: 1 },
          process,
        }),
    ).toThrow("incident queue capacity must be between 1 and 1000");
    expect(
      () =>
        new BoundedIncidentQueue({
          config: { capacity: 11, concurrency: 11 },
          process,
        }),
    ).toThrow("incident concurrency must be between 1 and 10");
  });
});
