import type { Incident, IncidentReceiverOptions, Severity } from "./incident";
import {
  AlertmanagerPayloadLimitError,
  IncidentReceiver,
  InvalidAlertmanagerPayloadError,
  isSeverity,
} from "./incident";

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export interface ServerConfig {
  port: number;
  receiver: IncidentReceiverOptions;
}

export interface AlertRequestHandlerDependencies {
  receiver: IncidentReceiver;
  onIncident: (incident: Incident) => void | Promise<void>;
  onResolved?: (incident: Incident) => void | Promise<void>;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseMinSeverity(
  value: string | undefined,
): Severity {
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
    port: parseInteger(environment.PORT, 3000, "PORT"),
    receiver: {
      debounceMs:
        parseInteger(
          environment.ALERT_DEBOUNCE_SECONDS,
          300,
          "ALERT_DEBOUNCE_SECONDS",
        ) * 1_000,
      minSeverity: parseMinSeverity(environment.MIN_SEVERITY),
      namespaceAllowlist: parseList(environment.NAMESPACE_ALLOWLIST),
      namespaceDenylist: parseList(environment.NAMESPACE_DENYLIST),
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
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
  const config = loadServerConfig(environment);
  const receiver = new IncidentReceiver(config.receiver);
  const handler = createAlertRequestHandler({
    receiver,
    onIncident: (incident) => {
      console.log(JSON.stringify({ event: "incident.opened", incident }));
    },
    onResolved: (incident) => {
      console.log(JSON.stringify({ event: "incident.resolved", incident }));
    },
  });

  return Bun.serve({
    port: config.port,
    fetch: handler,
  });
}

if (import.meta.main) {
  const server = startServer();
  console.log(`k8s-incident-triage listening on ${server.url}`);
}
