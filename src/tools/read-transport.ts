export type FetchLike = (
  input: string | URL | Request,
  init?: BunFetchRequestInit,
) => Promise<Response>;

export interface ReadRequest {
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly ca?: string;
}

export interface ReadResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export interface ReadTransport {
  get(request: ReadRequest): Promise<ReadResponse>;
}

export class ResponseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseLimitError";
  }
}

export class FetchReadTransport implements ReadTransport {
  readonly #fetcher: FetchLike;

  constructor(fetcher: FetchLike = fetch) {
    this.#fetcher = fetcher;
  }

  async get(request: ReadRequest): Promise<ReadResponse> {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
      throw new Error("timeoutMs must be a positive integer");
    }
    if (
      !Number.isInteger(request.maxResponseBytes) ||
      request.maxResponseBytes < 1
    ) {
      throw new Error("maxResponseBytes must be a positive integer");
    }

    const response = await this.#fetcher(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs),
      ...(request.ca === undefined
        ? {}
        : { tls: { ca: request.ca, rejectUnauthorized: true } }),
    });
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      Number.isFinite(Number(declaredLength)) &&
      Number(declaredLength) > request.maxResponseBytes
    ) {
      throw new ResponseLimitError(
        `upstream response exceeds ${request.maxResponseBytes} bytes`,
      );
    }
    if (response.body === null) {
      return { status: response.status, body: new Uint8Array() };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > request.maxResponseBytes) {
        await reader.cancel();
        throw new ResponseLimitError(
          `upstream response exceeds ${request.maxResponseBytes} bytes`,
        );
      }
      chunks.push(chunk.value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: response.status, body };
  }
}
