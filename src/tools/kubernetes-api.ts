import type { ReadTransport } from "./read-transport";
import { FetchReadTransport } from "./read-transport";
import { ToolExecutionError, ToolInputError } from "./result";

const DEFAULT_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_LOG_RESPONSE_BYTES = 65_536;
const MAX_RESOURCE_RESPONSE_BYTES = 1_048_576;
const MAX_LIST_RESPONSE_BYTES = 2_097_152;

export interface KubernetesServiceAccountCredentials {
  readonly token: string;
  readonly ca: string;
}

export interface KubernetesCredentialsProvider {
  load(): Promise<KubernetesServiceAccountCredentials>;
}

export class FileKubernetesCredentialsProvider
  implements KubernetesCredentialsProvider
{
  readonly #tokenPath: string;
  readonly #caPath: string;

  constructor(tokenPath = DEFAULT_TOKEN_PATH, caPath = DEFAULT_CA_PATH) {
    this.#tokenPath = tokenPath;
    this.#caPath = caPath;
  }

  async load(): Promise<KubernetesServiceAccountCredentials> {
    const [token, ca] = await Promise.all([
      Bun.file(this.#tokenPath).text(),
      Bun.file(this.#caPath).text(),
    ]);
    const trimmedToken = token.trim();
    if (trimmedToken.length === 0 || ca.trim().length === 0) {
      throw new ToolExecutionError(
        "Kubernetes service account token and CA must be non-empty",
      );
    }
    return { token: trimmedToken, ca };
  }
}

type KubernetesDescribeKind = "pod" | "deployment" | "replicaset";

export class InClusterKubernetesApi {
  readonly #baseUrl: URL;
  readonly #transport: ReadTransport;
  readonly #credentials: KubernetesCredentialsProvider;

  constructor(
    baseUrl: string,
    transport: ReadTransport,
    credentials: KubernetesCredentialsProvider,
  ) {
    this.#baseUrl = new URL(baseUrl);
    if (this.#baseUrl.protocol !== "https:") {
      throw new Error("Kubernetes API URL must use HTTPS");
    }
    this.#transport = transport;
    this.#credentials = credentials;
  }

  async getPodLogs(request: {
    readonly namespace: string;
    readonly pod: string;
    readonly container: string;
    readonly tailLines: number;
  }): Promise<string> {
    const url = this.#url(
      `/api/v1/namespaces/${this.#segment(request.namespace)}/pods/${this.#segment(request.pod)}/log`,
    );
    url.searchParams.set("container", request.container);
    url.searchParams.set(
      "tailLines",
      String(Math.min(200, Math.max(1, Math.floor(request.tailLines)))),
    );
    url.searchParams.set("limitBytes", "32768");
    url.searchParams.set("timestamps", "true");

    const response = await this.#get(url, MAX_LOG_RESPONSE_BYTES, "text/plain");
    return new TextDecoder("utf-8", { fatal: true }).decode(response);
  }

  async getResource(request: {
    readonly kind: KubernetesDescribeKind;
    readonly name: string;
    readonly namespace: string;
  }): Promise<unknown> {
    const namespace = this.#segment(request.namespace);
    const name = this.#segment(request.name);
    const path =
      request.kind === "pod"
        ? `/api/v1/namespaces/${namespace}/pods/${name}`
        : request.kind === "deployment"
          ? `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`
          : request.kind === "replicaset"
            ? `/apis/apps/v1/namespaces/${namespace}/replicasets/${name}`
            : undefined;
    if (path === undefined) {
      throw new ToolInputError("unsupported Kubernetes resource kind");
    }
    return this.#getJson(this.#url(path), MAX_RESOURCE_RESPONSE_BYTES);
  }

  async listNamespacedEvents(request: {
    readonly namespace: string;
    readonly limit: number;
  }): Promise<unknown> {
    const url = this.#url(
      `/api/v1/namespaces/${this.#segment(request.namespace)}/events`,
    );
    url.searchParams.set(
      "limit",
      String(Math.min(500, Math.max(1, Math.floor(request.limit)))),
    );
    return this.#getJson(url, MAX_LIST_RESPONSE_BYTES);
  }

  async readNamespacedDeployment(request: {
    readonly name: string;
    readonly namespace: string;
  }): Promise<unknown> {
    return this.#getJson(
      this.#url(
        `/apis/apps/v1/namespaces/${this.#segment(request.namespace)}/deployments/${this.#segment(request.name)}`,
      ),
      MAX_RESOURCE_RESPONSE_BYTES,
    );
  }

  async listNamespacedReplicaSets(request: {
    readonly namespace: string;
    readonly labelSelector: string;
    readonly limit: number;
  }): Promise<unknown> {
    const url = this.#url(
      `/apis/apps/v1/namespaces/${this.#segment(request.namespace)}/replicasets`,
    );
    url.searchParams.set("labelSelector", request.labelSelector);
    url.searchParams.set(
      "limit",
      String(Math.min(500, Math.max(1, Math.floor(request.limit)))),
    );
    return this.#getJson(url, MAX_LIST_RESPONSE_BYTES);
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }

  #segment(value: string): string {
    return encodeURIComponent(value);
  }

  async #getJson(url: URL, maxResponseBytes: number): Promise<unknown> {
    const bytes = await this.#get(url, maxResponseBytes, "application/json");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    try {
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new ToolExecutionError("Kubernetes API returned invalid JSON");
      }
      throw error;
    }
  }

  async #get(
    url: URL,
    maxResponseBytes: number,
    accept: string,
  ): Promise<Uint8Array> {
    const credentials = await this.#credentials.load();
    const response = await this.#transport.get({
      url,
      headers: {
        accept,
        authorization: `Bearer ${credentials.token}`,
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes,
      ca: credentials.ca,
    });
    if (response.status < 200 || response.status >= 300) {
      const body = new TextDecoder().decode(response.body).slice(0, 512);
      throw new ToolExecutionError(
        `Kubernetes API returned HTTP ${response.status}: ${body}`,
      );
    }
    return response.body;
  }
}

export function createInClusterKubernetesApi(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): InClusterKubernetesApi {
  const configuredUrl = environment.KUBERNETES_API_URL?.trim();
  const explicitUrl =
    configuredUrl === undefined || configuredUrl.length === 0
      ? undefined
      : configuredUrl;
  const configuredHost = environment.KUBERNETES_SERVICE_HOST?.trim();
  const host =
    configuredHost === undefined || configuredHost.length === 0
      ? undefined
      : configuredHost;
  const port = environment.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
  const urlHost =
    host !== undefined && host.includes(":") && !host.startsWith("[")
      ? `[${host}]`
      : host;
  const inClusterUrl =
    urlHost === undefined ? undefined : `https://${urlHost}:${port}`;
  if (
    explicitUrl !== undefined &&
    inClusterUrl !== undefined &&
    new URL(explicitUrl).origin !== new URL(inClusterUrl).origin
  ) {
    throw new Error(
      "KUBERNETES_API_URL must match the in-cluster Kubernetes API origin",
    );
  }
  const baseUrl = inClusterUrl ?? explicitUrl;
  if (baseUrl === undefined) {
    throw new Error(
      "KUBERNETES_API_URL or KUBERNETES_SERVICE_HOST is required",
    );
  }

  return new InClusterKubernetesApi(
    baseUrl,
    new FetchReadTransport(),
    new FileKubernetesCredentialsProvider(
      environment.KUBERNETES_TOKEN_PATH ?? DEFAULT_TOKEN_PATH,
      environment.KUBERNETES_CA_PATH ?? DEFAULT_CA_PATH,
    ),
  );
}
