import type { TriageRunOptions, TriageRunResult } from "./agent/loop";
import type { Incident } from "./incident";
import { formatTelegramReport } from "./report";

const DEFAULT_INCIDENT_QUEUE_CAPACITY = 100;
const MAX_INCIDENT_QUEUE_CAPACITY = 1_000;
const DEFAULT_INCIDENT_CONCURRENCY = 2;
const MAX_INCIDENT_CONCURRENCY = 10;

export interface IncidentQueueConfig {
  readonly capacity: number;
  readonly concurrency: number;
}

export interface IncidentTriageAgent {
  triage(
    incident: Incident,
    options?: TriageRunOptions,
  ): Promise<TriageRunResult>;
}

export interface IncidentDeliveryOptions {
  readonly signal: AbortSignal;
  readonly shouldContinue: () => boolean;
}

export interface CurrentIncidentProcessingDependencies {
  readonly agent: IncidentTriageAgent;
  readonly isCurrentOpen: (incident: Incident) => boolean;
  readonly deliver: (
    text: string,
    options: IncidentDeliveryOptions,
  ) => Promise<void>;
  readonly signal?: AbortSignal;
}

export type IncidentProcessingOutcome =
  | Readonly<{ status: "delivered"; runId: string }>
  | Readonly<{ status: "superseded" }>;

export async function processCurrentIncident(
  incident: Incident,
  dependencies: CurrentIncidentProcessingDependencies,
): Promise<IncidentProcessingOutcome> {
  const signal = dependencies.signal ?? new AbortController().signal;
  const shouldContinue = (): boolean =>
    !signal.aborted && dependencies.isCurrentOpen(incident);

  if (!shouldContinue()) {
    return { status: "superseded" };
  }

  const result = await dependencies.agent.triage(incident, { signal });
  if (!shouldContinue()) {
    return { status: "superseded" };
  }

  const report = formatTelegramReport({ incident, result });
  try {
    await dependencies.deliver(report, { signal, shouldContinue });
  } catch (error: unknown) {
    if (!shouldContinue()) {
      return { status: "superseded" };
    }
    throw error;
  }
  if (!shouldContinue()) {
    return { status: "superseded" };
  }
  return { status: "delivered", runId: result.runId };
}

export interface BoundedIncidentQueueOptions {
  readonly config: IncidentQueueConfig;
  readonly process: (incident: Incident) => Promise<void>;
  readonly onFailure?: (incident: Incident, error: unknown) => void;
}

export interface IncidentWorkerOptions
  extends Omit<CurrentIncidentProcessingDependencies, "signal"> {
  readonly config: IncidentQueueConfig;
  readonly onFailure?: (incident: Incident, error: unknown) => void;
  readonly onOutcome?: (
    incident: Incident,
    outcome: IncidentProcessingOutcome,
  ) => void;
}

export class IncidentQueueFullError extends Error {
  constructor() {
    super("incident queue is at capacity");
    this.name = "IncidentQueueFullError";
  }
}

function integerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return value;
}

export function loadIncidentQueueConfig(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): IncidentQueueConfig {
  const capacity = integerFromEnvironment(
    environment,
    "INCIDENT_QUEUE_CAPACITY",
    DEFAULT_INCIDENT_QUEUE_CAPACITY,
  );
  const concurrency = integerFromEnvironment(
    environment,
    "INCIDENT_CONCURRENCY",
    DEFAULT_INCIDENT_CONCURRENCY,
  );

  if (capacity < 1 || capacity > MAX_INCIDENT_QUEUE_CAPACITY) {
    throw new Error(
      `INCIDENT_QUEUE_CAPACITY must be between 1 and ${MAX_INCIDENT_QUEUE_CAPACITY}`,
    );
  }
  if (concurrency < 1 || concurrency > MAX_INCIDENT_CONCURRENCY) {
    throw new Error(
      `INCIDENT_CONCURRENCY must be between 1 and ${MAX_INCIDENT_CONCURRENCY}`,
    );
  }

  return { capacity, concurrency };
}

export class BoundedIncidentQueue {
  readonly #capacity: number;
  readonly #concurrency: number;
  readonly #process: (incident: Incident) => Promise<void>;
  readonly #onFailure: ((incident: Incident, error: unknown) => void) | undefined;
  readonly #pending: Incident[] = [];
  readonly #drainWaiters: (() => void)[] = [];
  #active = 0;
  #closed = false;

  constructor(options: BoundedIncidentQueueOptions) {
    const { capacity, concurrency } = options.config;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > MAX_INCIDENT_QUEUE_CAPACITY
    ) {
      throw new Error(
        `incident queue capacity must be between 1 and ${MAX_INCIDENT_QUEUE_CAPACITY}`,
      );
    }
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_INCIDENT_CONCURRENCY
    ) {
      throw new Error(
        `incident concurrency must be between 1 and ${MAX_INCIDENT_CONCURRENCY}`,
      );
    }
    if (concurrency > capacity) {
      throw new Error("incident concurrency must not exceed queue capacity");
    }
    this.#capacity = capacity;
    this.#concurrency = concurrency;
    this.#process = options.process;
    this.#onFailure = options.onFailure;
  }

  get activeCount(): number {
    return this.#active;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get accepting(): boolean {
    return (
      !this.#closed &&
      this.#active + this.#pending.length < this.#capacity
    );
  }

  enqueue(incident: Incident): void {
    if (!this.accepting) {
      throw new IncidentQueueFullError();
    }
    this.#pending.push(incident);
    this.#pump();
  }

  cancelPending(incident: Incident): number {
    let removed = 0;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      if (this.#pending[index] === incident) {
        this.#pending.splice(index, 1);
        removed += 1;
      }
    }
    this.#resolveDrainWaitersIfIdle();
    return removed;
  }

  closeAndCancelPending(): readonly Incident[] {
    this.#closed = true;
    const cancelled = this.#pending.splice(0);
    this.#resolveDrainWaitersIfIdle();
    return cancelled;
  }

  async drain(): Promise<void> {
    if (this.#active === 0 && this.#pending.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
  }

  #pump(): void {
    while (this.#active < this.#concurrency) {
      const next = this.#pending.shift();
      if (next === undefined) {
        break;
      }
      this.#active += 1;
      void this.#run(next);
    }
  }

  async #run(incident: Incident): Promise<void> {
    try {
      await this.#process(incident);
    } catch (error: unknown) {
      try {
        this.#onFailure?.(incident, error);
      } catch {
        // A reporting callback must never stop the bounded worker.
      }
    } finally {
      this.#active -= 1;
      this.#pump();
      this.#resolveDrainWaitersIfIdle();
    }
  }

  #resolveDrainWaitersIfIdle(): void {
    if (this.#active !== 0 || this.#pending.length !== 0) {
      return;
    }
    for (const resolve of this.#drainWaiters.splice(0)) {
      resolve();
    }
  }
}

/**
 * Owns the non-blocking boundary between Alertmanager acknowledgement and the
 * bounded triage/delivery pipeline.
 */
export class IncidentWorker {
  readonly #queue: BoundedIncidentQueue;
  readonly #activeCancellations = new Map<Incident, AbortController>();

  constructor(options: IncidentWorkerOptions) {
    this.#queue = new BoundedIncidentQueue({
      config: options.config,
      process: async (incident) => {
        const cancellation = new AbortController();
        this.#activeCancellations.set(incident, cancellation);
        try {
          const outcome = await processCurrentIncident(incident, {
            agent: options.agent,
            isCurrentOpen: options.isCurrentOpen,
            deliver: options.deliver,
            signal: cancellation.signal,
          });
          try {
            options.onOutcome?.(incident, outcome);
          } catch {
            // Observability callbacks must never fail accepted incident work.
          }
        } finally {
          if (this.#activeCancellations.get(incident) === cancellation) {
            this.#activeCancellations.delete(incident);
          }
        }
      },
      ...(options.onFailure === undefined
        ? {}
        : { onFailure: options.onFailure }),
    });
  }

  get activeCount(): number {
    return this.#queue.activeCount;
  }

  get pendingCount(): number {
    return this.#queue.pendingCount;
  }

  get accepting(): boolean {
    return this.#queue.accepting;
  }

  submit(incident: Incident): void {
    this.#queue.enqueue(incident);
  }

  resolve(incident: Incident): number {
    const cancelledPending = this.#queue.cancelPending(incident);
    this.#activeCancellations.get(incident)?.abort();
    return cancelledPending;
  }

  drain(): Promise<void> {
    return this.#queue.drain();
  }

  async shutdown(): Promise<number> {
    const cancelledPending = this.#queue.closeAndCancelPending().length;
    await this.#queue.drain();
    return cancelledPending;
  }
}
