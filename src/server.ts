import { createProductionTriageAgent } from "./agent";
import type { Incident, IncidentReceiverOptions, Severity } from "./incident";
import {
  AlertmanagerPayloadLimitError,
  DEFAULT_MAX_TRACKED_INCIDENTS,
  IncidentReceiver,
  IncidentStateCapacityError,
  InvalidAlertmanagerPayloadError,
  MAX_TRACKED_INCIDENTS,
  isSeverity,
} from "./incident";
import {
  IncidentQueueFullError,
  IncidentWorker,
  loadIncidentQueueConfig,
  type IncidentDeliveryOptions,
  type IncidentProcessingOutcome,
  type IncidentTriageAgent,
} from "./pipeline";
import {
  loadTelegramConfig,
  TelegramDeliveryError,
  TelegramReportSender,
} from "./telegram";

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const MAX_PORT = 65_535;
const MAX_ALERT_DEBOUNCE_SECONDS = 86_400;

export interface ServerConfig {
  port: number;
  receiver: IncidentReceiverOptions;
}

export interface AlertRequestHandlerDependencies {
  receiver: IncidentReceiver;
  onIncident: (incident: Incident) => void | Promise<void>;
  onResolved?: (incident: Incident) => void | Promise<void>;
  isReady?: () => boolean;
}

export type IncidentRuntimeEvent =
  | Readonly<{
      event: "incident.delivered";
      fingerprint: string;
      runId: string;
    }>
  | Readonly<{
      event: "incident.superseded";
      fingerprint: string;
    }>
  | Readonly<{
      event: "incident.delivery_failed";
      fingerprint: string;
      errorKind: string;
      sentCount?: number;
      totalCount?: number;
      retrySafe?: boolean;
      fatalConfiguration?: boolean;
    }>
  | Readonly<{
      event: "incident.resolved";
      fingerprint: string;
      cancelledPending: number;
    }>;

export interface IncidentRuntimeDependencies {
  readonly agent: IncidentTriageAgent;
  readonly deliver: (
    report: string,
    options: IncidentDeliveryOptions,
  ) => Promise<void>;
  readonly isDeliveryReady?: () => boolean;
  readonly record?: (event: IncidentRuntimeEvent) => void;
}

export interface IncidentRuntime {
  readonly port: number;
  readonly handler: (request: Request) => Promise<Response>;
  readonly receiver: IncidentReceiver;
  readonly worker: IncidentWorker;
  readonly shutdown: () => Promise<Readonly<{ cancelledPending: number }>>;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseIncidentStateCapacity(value: string | undefined): number {
  return parseBoundedInteger(
    value,
    DEFAULT_MAX_TRACKED_INCIDENTS,
    "INCIDENT_STATE_CAPACITY",
    1,
    MAX_TRACKED_INCIDENTS,
  );
}

function parseMinSeverity(value: string | undefined): Severity {
  const normalized = (value ?? "info").trim().toLowerCase();
  if (!isSeverity(normalized)) {
    throw new Error("MIN_SEVERITY must be info, warning, or critical");
  }
  return normalized;
}

export function loadServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  return {
    port: parseBoundedInteger(environment.PORT, 3000, "PORT", 1, MAX_PORT),
    receiver: {
      debounceMs:
        parseBoundedInteger(
          environment.ALERT_DEBOUNCE_SECONDS,
          300,
          "ALERT_DEBOUNCE_SECONDS",
          0,
          MAX_ALERT_DEBOUNCE_SECONDS,
        ) * 1_000,
      minSeverity: parseMinSeverity(environment.MIN_SEVERITY),
      namespaceAllowlist: parseList(environment.NAMESPACE_ALLOWLIST),
      namespaceDenylist: parseList(environment.NAMESPACE_DENYLIST),
      maxTrackedIncidents: parseIncidentStateCapacity(
        environment.INCIDENT_STATE_CAPACITY,
      ),
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function safeErrorKind(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UnknownError";
  }
  const candidate = error.name.trim();
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate)
    ? candidate
    : "UnknownError";
}

function recordRuntimeEvent(
  record: ((event: IncidentRuntimeEvent) => void) | undefined,
  event: IncidentRuntimeEvent,
): void {
  try {
    record?.(event);
  } catch {
    // Runtime observability must not affect incident delivery semantics.
  }
}

export function createIncidentRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: IncidentRuntimeDependencies,
): IncidentRuntime {
  const serverConfig = loadServerConfig(environment);
  const receiver = new IncidentReceiver(serverConfig.receiver);
  let serving = true;
  const worker = new IncidentWorker({
    config: loadIncidentQueueConfig(environment),
    agent: dependencies.agent,
    isCurrentOpen: (incident) => receiver.isCurrentOpen(incident),
    deliver: dependencies.deliver,
    onFailure: (incident, error) => {
      const telegramError =
        error instanceof TelegramDeliveryError ? error : undefined;
      // Once a Telegram request starts, a lost response makes delivery
      // ambiguous. Release dedupe only when no send occurred or the delivery
      // implementation explicitly proves a retry cannot duplicate a message.
      if (telegramError === undefined || telegramError.retrySafe) {
        receiver.markIncidentDeliveryFailed(incident);
      }
      recordRuntimeEvent(dependencies.record, {
        event: "incident.delivery_failed",
        fingerprint: incident.fingerprint,
        errorKind: safeErrorKind(error),
        ...(telegramError === undefined
          ? {}
          : {
              sentCount: telegramError.sentCount,
              totalCount: telegramError.totalCount,
              retrySafe: telegramError.retrySafe,
              fatalConfiguration: telegramError.fatalConfiguration,
            }),
      });
    },
    onOutcome: (incident, outcome: IncidentProcessingOutcome) => {
      recordRuntimeEvent(
        dependencies.record,
        outcome.status === "delivered"
          ? {
              event: "incident.delivered",
              fingerprint: incident.fingerprint,
              runId: outcome.runId,
            }
          : {
              event: "incident.superseded",
              fingerprint: incident.fingerprint,
            },
      );
    },
  });
  const handler = createAlertRequestHandler({
    receiver,
    onIncident: (incident) => {
      if (!serving || dependencies.isDeliveryReady?.() === false) {
        throw new IncidentQueueFullError();
      }
      worker.submit(incident);
    },
    onResolved: (incident) => {
      const closedIncident = receiver.incidentClosedBy(incident);
      const cancelledPending =
        closedIncident === undefined ? 0 : worker.resolve(closedIncident);
      recordRuntimeEvent(dependencies.record, {
        event: "incident.resolved",
        fingerprint: incident.fingerprint,
        cancelledPending,
      });
    },
    isReady: () => serving,
  });
  return {
    port: serverConfig.port,
    handler,
    receiver,
    worker,
    shutdown: async () => {
      serving = false;
      return { cancelledPending: await worker.shutdown() };
    },
  };
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_WEBHOOK_BODY_BYTES
  ) {
    throw new AlertmanagerPayloadLimitError(
      `request body must be at most ${MAX_WEBHOOK_BODY_BYTES} bytes`,
    );
  }
  if (request.body === null) {
    throw new InvalidAlertmanagerPayloadError("request body is required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      throw new AlertmanagerPayloadLimitError(
        `request body must be at most ${MAX_WEBHOOK_BODY_BYTES} bytes`,
      );
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new InvalidAlertmanagerPayloadError(
        "request body must contain valid UTF-8 JSON",
      );
    }
    throw error;
  }
}

export function createAlertRequestHandler(
  dependencies: AlertRequestHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "method not allowed" }), {
          status: 405,
          headers: {
            "content-type": "application/json",
            allow: "GET",
          },
        });
      }
      return jsonResponse({ status: "ok" }, 200);
    }
    if (url.pathname === "/readyz") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "method not allowed" }), {
          status: 405,
          headers: {
            "content-type": "application/json",
            allow: "GET",
          },
        });
      }
      let ready = false;
      try {
        ready = dependencies.isReady?.() ?? true;
      } catch {
        ready = false;
      }
      return ready
        ? jsonResponse({ status: "ok" }, 200)
        : jsonResponse({ status: "unavailable" }, 503);
    }
    if (url.pathname !== "/alerts") {
      return jsonResponse({ error: "not found" }, 404);
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: {
          "content-type": "application/json",
          allow: "POST",
        },
      });
    }

    try {
      const payload = await readBoundedJson(request);
      const result = dependencies.receiver.receive(payload);

      if (dependencies.onResolved !== undefined) {
        await Promise.all(
          result.resolved.map(async (incident) => {
            try {
              await dependencies.onResolved?.(incident);
            } catch (error: unknown) {
              dependencies.receiver.markResolutionDeliveryFailed(incident);
              throw error;
            }
          }),
        );
      }
      await Promise.all(
        result.opened.map(async (incident) => {
          try {
            await dependencies.onIncident(incident);
          } catch (error: unknown) {
            dependencies.receiver.markIncidentDeliveryFailed(incident);
            throw error;
          }
        }),
      );
      if (result.capacityRejectedCount > 0) {
        throw new IncidentStateCapacityError();
      }

      return jsonResponse(
        {
          accepted: result.opened.length,
          resolved: result.resolved.length,
          duplicates: result.duplicateCount,
          filtered: result.filteredCount,
        },
        202,
      );
    } catch (error: unknown) {
      if (
        error instanceof IncidentQueueFullError ||
        error instanceof IncidentStateCapacityError
      ) {
        return Response.json(
          { error: error.message },
          { status: 503, headers: { "retry-after": "5" } },
        );
      }
      if (error instanceof AlertmanagerPayloadLimitError) {
        return jsonResponse({ error: error.message }, 413);
      }
      if (
        error instanceof InvalidAlertmanagerPayloadError ||
        error instanceof SyntaxError
      ) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "invalid JSON" },
          400,
        );
      }
      throw error;
    }
  };
}

export function startServer(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): ReturnType<typeof Bun.serve> {
  const telegram = new TelegramReportSender(loadTelegramConfig(environment));
  const runtime = createIncidentRuntime(environment, {
    agent: createProductionTriageAgent(environment),
    isDeliveryReady: () => telegram.accepting,
    deliver: async (report, options) => {
      await telegram.send(report, options);
    },
    record: (event) => {
      const serialized = JSON.stringify(event);
      if (event.event === "incident.delivery_failed") {
        console.error(serialized);
      } else {
        console.log(serialized);
      }
    },
  });

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: runtime.port,
    fetch: runtime.handler,
  });
  let shuttingDown = false;
  const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const drain = runtime.shutdown();
    const stop = Promise.resolve(server.stop(false));
    const [result] = await Promise.all([drain, stop]);
    console.log(
      JSON.stringify({
        event: "server.shutdown",
        signal,
        cancelledPending: result.cancelledPending,
      }),
    );
  };
  const requestShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "server.shutdown_failed",
          signal,
          errorKind: safeErrorKind(error),
        }),
      );
      void server.stop(true);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  return server;
}

if (import.meta.main) {
  const server = startServer();
  console.log(`k8s-incident-triage listening on ${server.url}`);
}
