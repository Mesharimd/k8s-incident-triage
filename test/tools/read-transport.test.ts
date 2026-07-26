import { describe, expect, test } from "bun:test";

import type { FetchLike } from "../../src/tools/read-transport";
import {
  FetchReadTransport,
  ResponseLimitError,
} from "../../src/tools/read-transport";

describe("read-only HTTP transport", () => {
  test("issues GET requests and returns a bounded response", async () => {
    let observedMethod: string | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      observedMethod = init?.method;
      return new Response("bounded response", { status: 200 });
    };
    const transport = new FetchReadTransport(fetcher);

    const response = await transport.get({
      url: new URL("https://prometheus.example/api/v1/query"),
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });

    expect(observedMethod).toBe("GET");
    expect(new TextDecoder().decode(response.body)).toBe("bounded response");
    expect(response.status).toBe(200);
  });

  test("refuses an upstream body above the byte contract", async () => {
    const fetcher: FetchLike = async () =>
      new Response("x".repeat(1_025), { status: 200 });
    const transport = new FetchReadTransport(fetcher);

    await expect(
      transport.get({
        url: new URL("https://prometheus.example/api/v1/query"),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toBeInstanceOf(ResponseLimitError);
  });
});
