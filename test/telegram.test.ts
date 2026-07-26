import { describe, expect, test } from "bun:test";

import type { TriageRunResult } from "../src/agent/loop";
import { parseTriageReport } from "../src/agent/triage-report";
import type { Incident } from "../src/incident";
import { formatTelegramReport } from "../src/report";
import {
  chunkMarkdownV2,
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  escapeMarkdownV2,
  loadTelegramConfig,
  sendTelegramMessage,
  TELEGRAM_INTER_PART_DELAY_MS,
  TELEGRAM_MESSAGE_UTF16_LIMIT,
  TELEGRAM_PART_PREFIX_RESERVE,
  TelegramDeliveryError,
  TelegramReportSender,
  type TelegramFetch,
} from "../src/telegram";

async function waitForMicrotaskCondition(
  condition: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("microtask condition was not reached");
}

describe("Telegram MarkdownV2 encoding", () => {
  test("escapes every reserved character outside code and pre entities", () => {
    expect(escapeMarkdownV2("_ * [ ] ( ) ~ ` > # + - = | { } . ! \\"))
      .toBe("\\_ \\* \\[ \\] \\( \\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\! \\\\");
  });

  test("chunks by escaped UTF-16 length without splitting escapes or surrogate pairs", () => {
    expect(chunkMarkdownV2("abc_def", 5)).toEqual(["abc\\_", "def"]);
    expect(chunkMarkdownV2("aaa🙂b", 4)).toEqual(["aaa", "🙂b"]);
  });

  test("starts a normal copy-paste command on the next chunk instead of splitting it", () => {
    const prefix = `${"x".repeat(4_090)}\n`;
    const command = "kubectl -n payments rollout undo deployment/checkout";

    expect(chunkMarkdownV2(`${prefix}${command}`)).toEqual([
      prefix,
      escapeMarkdownV2(command),
    ]);
  });
});

describe("Telegram Bot API delivery", () => {
  test("loads only a non-empty token and numeric private chat ID", () => {
    expect(() => loadTelegramConfig({})).toThrow(
      "TELEGRAM_BOT_TOKEN is required",
    );
    expect(() =>
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: "   ",
        TELEGRAM_CHAT_ID: "-1001234567890",
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is required");
    expect(() =>
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: "not-a-token",
        TELEGRAM_CHAT_ID: "-1001234567890",
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is invalid");
    expect(() =>
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
        TELEGRAM_CHAT_ID: "@public-channel",
      }),
    ).toThrow("TELEGRAM_CHAT_ID must be a numeric private chat or channel ID");

    expect(
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN:
          "  123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef  ",
        TELEGRAM_CHAT_ID: "  -1001234567890  ",
      }),
    ).toEqual({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      timeoutMs: 40_000,
    });
    expect(() =>
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
        TELEGRAM_CHAT_ID: "-1001234567890",
        TELEGRAM_TIMEOUT_MS: "99",
      }),
    ).toThrow("TELEGRAM_TIMEOUT_MS must be between 100 and 120000");
    expect(
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
        TELEGRAM_CHAT_ID: "-1001234567890",
        TELEGRAM_TIMEOUT_MS: "1200",
      }).timeoutMs,
    ).toBe(1_200);
  });

  test("sends escaped chunks in order to the configured private chat", async () => {
    const requests: Array<{
      readonly url: string;
      readonly init: RequestInit | undefined;
    }> = [];
    const requestTimes: number[] = [];
    const fetch: TelegramFetch = async (url, init) => {
      requests.push({ url, init });
      requestTimes.push(performance.now());
      return Response.json({
        ok: true,
        result: { message_id: 40 + requests.length },
      });
    };

    const delivery = await sendTelegramMessage({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      text: `${"a".repeat(4_095)}_`,
      fetch,
    });

    expect(delivery).toEqual({ messageCount: 2, messageIds: [41, 42] });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef/sendMessage",
      "https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef/sendMessage",
    ]);
    const bodies = requests.map(
      ({ init }) =>
        JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>,
    );
    const firstText = bodies[0]?.text;
    const secondText = bodies[1]?.text;
    expect(typeof firstText).toBe("string");
    expect(typeof secondText).toBe("string");
    expect(firstText).toMatch(
      /^Report [a-f0-9]{12} part 1 of 2\na{4032}$/,
    );
    expect(secondText).toMatch(
      /^Report [a-f0-9]{12} part 2 of 2\na{63}\\_$/,
    );
    expect(String(firstText).split(" ")[1]).toBe(
      String(secondText).split(" ")[1],
    );
    expect(
      bodies.every(
        (body) =>
          body.chat_id === "-1001234567890" &&
          body.parse_mode === "MarkdownV2",
      ),
    ).toBe(true);
    expect(requests.every(({ init }) => init?.method === "POST")).toBe(true);
    expect(requests.every(({ init }) => init?.redirect === "error")).toBe(true);
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(
      TELEGRAM_INTER_PART_DELAY_MS - 25,
    );
    expect(
      requests.every(
        ({ init }) =>
          new Headers(init?.headers).get("content-type") === "application/json",
      ),
    ).toBe(true);
  });

  test("bounds and redacts API error text without exposing delivery credentials", async () => {
    const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef";
    const chatId = "-1001234567890";
    const fetch: TelegramFetch = async () =>
      Response.json(
        {
          ok: false,
          error_code: 400,
          description: [
            `Bad Request for token ${botToken} and chat ${chatId}`,
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            "x".repeat(2_000),
          ].join(" "),
        },
        { status: 400 },
      );

    let caught: unknown;
    try {
      await sendTelegramMessage({ botToken, chatId, text: "report", fetch });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TelegramDeliveryError);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("Bad Request for token [REDACTED]");
    expect(message).not.toContain(botToken);
    expect(message).not.toContain(chatId);
    expect(message.length).toBeLessThanOrEqual(384);
    expect((caught as TelegramDeliveryError).retrySafe).toBe(true);
  });

  test("treats deterministic pre-send 4xx rejections as retry-safe", async () => {
    const cases = [
      { status: 400, retrySafe: true },
      { status: 408, retrySafe: false },
      { status: 429, retrySafe: true },
      { status: 500, retrySafe: false },
    ] as const;

    for (const item of cases) {
      const error = await sendTelegramMessage({
        botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
        chatId: "-1001234567890",
        text: "report",
        fetch: async () =>
          Response.json(
            { ok: false, description: "fixture rejection" },
            { status: item.status },
          ),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TelegramDeliveryError);
      expect((error as TelegramDeliveryError).retrySafe).toBe(item.retrySafe);
    }
  });

  test("latches admission after a permanent Telegram credential or chat rejection", async () => {
    const cases = [
      { status: 401, description: "Unauthorized" },
      { status: 403, description: "Forbidden: bot was blocked" },
      { status: 400, description: "Bad Request: chat not found" },
    ] as const;

    for (const item of cases) {
      let fetchCalls = 0;
      const sender = new TelegramReportSender({
        botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
        chatId: "-1001234567890",
        timeoutMs: 1_000,
        fetch: async () => {
          fetchCalls += 1;
          return Response.json(
            { ok: false, description: item.description },
            { status: item.status },
          );
        },
      });

      const first = await sender.send("report").catch((error: unknown) => error);
      expect(first).toBeInstanceOf(TelegramDeliveryError);
      expect((first as TelegramDeliveryError).fatalConfiguration).toBe(true);
      expect(sender.accepting).toBe(false);
      await expect(sender.send("retry")).rejects.toThrow(
        "Telegram delivery configuration was rejected",
      );
      expect(fetchCalls).toBe(1);
    }
  });

  test("keeps admission open after a transient Telegram rate-limit rejection", async () => {
    let fetchCalls = 0;
    const sender = new TelegramReportSender({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      timeoutMs: 1_000,
      fetch: async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? Response.json(
              { ok: false, description: "Too Many Requests" },
              { status: 429 },
            )
          : Response.json({ ok: true, result: { message_id: 2 } });
      },
    });

    const first = await sender.send("report").catch((error: unknown) => error);
    expect(first).toBeInstanceOf(TelegramDeliveryError);
    expect((first as TelegramDeliveryError).retrySafe).toBe(true);
    expect((first as TelegramDeliveryError).fatalConfiguration).toBe(false);
    await waitForMicrotaskCondition(() => sender.accepting);
    await expect(sender.send("retry")).resolves.toEqual({
      messageCount: 1,
      messageIds: [2],
    });
  });

  test("rejects declared and streamed Bot API responses above the byte cap", async () => {
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(40_000));
        controller.close();
      },
    });
    const responses = [
      new Response("{}", { headers: { "content-length": "65537" } }),
      new Response(oversizedStream),
    ];

    for (const response of responses) {
      const fetch: TelegramFetch = async () => response;
      await expect(
        sendTelegramMessage({
          botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
          chatId: "-1001234567890",
          text: "report",
          fetch,
        }),
      ).rejects.toThrow("Telegram Bot API response exceeded safe limit");
    }
  });

  test("aborts the overall delivery deadline with a credential-free error", async () => {
    const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef";
    const chatId = "-1001234567890";
    const fetch: TelegramFetch = () =>
      new Promise<Response>(() => {
        // A broken transport can ignore AbortSignal; the caller deadline must
        // still settle rather than depending on cooperative cancellation.
      });

    let caught: unknown;
    try {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: "report",
        fetch,
        timeoutMs: 100,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TelegramDeliveryError);
    const error = caught as TelegramDeliveryError;
    expect(error.message).toBe("Telegram delivery timed out");
    expect(error.message).not.toContain(botToken);
    expect(error.message).not.toContain(chatId);
    expect(error.sentCount).toBe(0);
    expect(error.totalCount).toBe(1);
  });

  test("rejects a pacing plan that cannot fit before starting any request", async () => {
    let fetchCalls = 0;
    const error = await sendTelegramMessage({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      text: "A".repeat(4_097),
      timeoutMs: 100,
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({
          ok: true,
          result: { message_id: fetchCalls },
        });
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramDeliveryError);
    expect((error as TelegramDeliveryError).message).toBe(
      "Telegram delivery timeout cannot fit required inter-part pacing",
    );
    expect((error as TelegramDeliveryError).sentCount).toBe(0);
    expect((error as TelegramDeliveryError).totalCount).toBe(2);
    expect((error as TelegramDeliveryError).retrySafe).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test("budgets the default deadline for a near-limit production report", async () => {
    const reserved = (length: number): string => "-".repeat(length);
    const serialized = JSON.stringify({
      status: "diagnosed",
      probableCause: {
        claim: reserved(1_800),
        confidence: "high",
        evidenceCallIds: ["call_001"],
      },
      evidence: [{ callId: "call_001", observation: reserved(1_000) }],
      suggestions: [],
      recentChanges: [],
      uncertainties: Array.from({ length: 7 }, () => reserved(4_096)),
    });
    const report = parseTriageReport(serialized, new Set(["call_001"]));
    const incident: Incident = {
      alertname: "A",
      namespace: "n",
      pod: "p",
      severity: "warning",
      fingerprint: "f",
      startsAt: "2026-01-01T00:00:00Z",
      labels: {},
      annotations: {},
    };
    const result: TriageRunResult = {
      runId: "r",
      report,
      toolCalls: [
        {
          callId: "call_001",
          providerToolCallId: "provider_1",
          toolName: "get_recent_events",
          input: { namespace: "n", minutes: 5 },
          isError: false,
          content: "{}",
          rawBytes: 2,
          admittedBytes: 2,
          truncated: false,
          truncationReasons: [],
          summarized: false,
        },
      ],
    };
    const text = formatTelegramReport({ incident, result });
    const partCount = chunkMarkdownV2(
      text,
      TELEGRAM_MESSAGE_UTF16_LIMIT - TELEGRAM_PART_PREFIX_RESERVE,
    ).length;
    expect(new TextEncoder().encode(serialized).byteLength).toBe(31_701);
    expect((partCount - 1) * TELEGRAM_INTER_PART_DELAY_MS).toBeLessThan(
      DEFAULT_TELEGRAM_TIMEOUT_MS,
    );

    const bidiReserved = (bytes: number): string =>
      "\u202e".repeat(Math.floor(bytes / 3));
    const bidiSerialized = JSON.stringify({
      status: "diagnosed",
      probableCause: {
        claim: bidiReserved(1_800),
        confidence: "high",
        evidenceCallIds: ["call_001"],
      },
      evidence: [
        { callId: "call_001", observation: bidiReserved(999) },
      ],
      suggestions: [],
      recentChanges: [],
      uncertainties: Array.from({ length: 7 }, () => bidiReserved(4_095)),
    });
    const bidiReport = parseTriageReport(
      bidiSerialized,
      new Set(["call_001"]),
    );
    const bidiText = formatTelegramReport({
      incident,
      result: { ...result, report: bidiReport },
    });
    const bidiPartCount = chunkMarkdownV2(
      bidiText,
      TELEGRAM_MESSAGE_UTF16_LIMIT - TELEGRAM_PART_PREFIX_RESERVE,
    ).length;

    expect(new TextEncoder().encode(bidiSerialized).byteLength).toBe(31_693);
    expect(bidiText).not.toContain("\u202e");
    expect(
      (bidiPartCount - 1) * TELEGRAM_INTER_PART_DELAY_MS,
    ).toBeLessThan(DEFAULT_TELEGRAM_TIMEOUT_MS);
  });

  test("keeps large unique evidence and bounded queries inside the default pacing budget", () => {
    const callIds = Array.from(
      { length: 10 },
      (_value, index) => `call_${String(index + 1).padStart(3, "0")}`,
    );
    const serialized = JSON.stringify({
      status: "diagnosed",
      probableCause: {
        claim: "-".repeat(500),
        confidence: "high",
        evidenceCallIds: callIds,
      },
      evidence: callIds.map((callId) => ({
        callId,
        observation: "-".repeat(300),
      })),
      suggestions: Array.from({ length: 10 }, (_value, index) => ({
        action: "-".repeat(400),
        rationale: "-".repeat(400),
        evidenceCallIds: [callIds[index % callIds.length]],
        executed: false,
      })),
      recentChanges: Array.from({ length: 10 }, (_value, index) => ({
        change: "-".repeat(400),
        evidenceCallIds: [callIds[index % callIds.length]],
      })),
      uncertainties: Array.from({ length: 10 }, () => "-".repeat(1_450)),
    });
    const report = parseTriageReport(serialized, new Set(callIds));
    const incident: Incident = {
      alertname: "-".repeat(1_024),
      namespace: "-".repeat(1_024),
      pod: "-".repeat(1_024),
      severity: "-".repeat(1_024),
      fingerprint: "f".repeat(64),
      startsAt: "-".repeat(4_096),
      labels: {},
      annotations: { summary: "-".repeat(4_096) },
    };
    const result: TriageRunResult = {
      runId: "r",
      report,
      toolCalls: callIds.map((callId, index) => ({
        callId,
        providerToolCallId: `provider_${index + 1}`,
        toolName: "query_prometheus",
        input: {
          promql: "-".repeat(2_048),
          range: { lookbackMinutes: 15 },
        },
        isError: false,
        content: "{}",
        rawBytes: 2,
        admittedBytes: 2,
        truncated: false,
        truncationReasons: [],
        summarized: false,
      })),
    };
    const text = formatTelegramReport({ incident, result });
    const partCount = chunkMarkdownV2(
      text,
      TELEGRAM_MESSAGE_UTF16_LIMIT - TELEGRAM_PART_PREFIX_RESERVE,
    ).length;

    expect(new TextEncoder().encode(serialized).byteLength).toBe(31_906);
    expect(partCount).toBe(23);
    expect((partCount - 1) * TELEGRAM_INTER_PART_DELAY_MS).toBeLessThan(
      DEFAULT_TELEGRAM_TIMEOUT_MS,
    );
  });

  test("serializes whole multi-chunk reports so concurrent incidents cannot interleave", async () => {
    const sentChunkPrefixes: string[] = [];
    let nextMessageId = 1;
    const fetch: TelegramFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error("test expected an object request body");
      }
      const text = (body as Readonly<Record<string, unknown>>).text;
      if (typeof text !== "string") {
        throw new Error("test expected a text field");
      }
      sentChunkPrefixes.push(
        text.slice(text.indexOf("\n") + 1).slice(0, 1),
      );
      const messageId = nextMessageId;
      nextMessageId += 1;
      return Response.json({ ok: true, result: { message_id: messageId } });
    };
    const sender = new TelegramReportSender({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      timeoutMs: 5_000,
      fetch,
    });

    const first = sender.send("A".repeat(4_097));
    const second = sender.send("B".repeat(4_097));
    const deliveries = await Promise.all([first, second]);

    expect(sentChunkPrefixes).toEqual(["A", "A", "B", "B"]);
    expect(deliveries).toEqual([
      { messageCount: 2, messageIds: [1, 2] },
      { messageCount: 2, messageIds: [3, 4] },
    ]);
  });

  test("cancels a stale report before it leaves the serialized queue", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstBlocked = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let fetchCalls = 0;
    const fetch: TelegramFetch = () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? firstBlocked
        : Promise.resolve(
            Response.json({ ok: true, result: { message_id: fetchCalls } }),
          );
    };
    const sender = new TelegramReportSender({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      timeoutMs: 1_500,
      fetch,
    });
    let current = true;

    const first = sender.send("first report");
    await waitForMicrotaskCondition(() => fetchCalls === 1);
    const stale = sender.send("stale report", {
      shouldContinue: () => current,
    });
    const staleResult = stale.catch((error: unknown) => error);
    current = false;
    resolveFirst?.(
      Response.json({ ok: true, result: { message_id: 1 } }),
    );

    await expect(first).resolves.toEqual({
      messageCount: 1,
      messageIds: [1],
    });
    const staleError = await staleResult;
    expect(staleError).toBeInstanceOf(TelegramDeliveryError);
    expect((staleError as TelegramDeliveryError).message).toBe(
      "Telegram delivery was cancelled",
    );
    expect(fetchCalls).toBe(1);
  });

  test("rechecks currentness after each request and emits no later chunk", async () => {
    let current = true;
    let fetchCalls = 0;
    const fetch: TelegramFetch = async () => {
      fetchCalls += 1;
      current = false;
      return Response.json({ ok: true, result: { message_id: fetchCalls } });
    };
    const sender = new TelegramReportSender({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      timeoutMs: 1_500,
      fetch,
    });

    await expect(
      sender.send("A".repeat(4_097), {
        shouldContinue: () => current,
      }),
    ).rejects.toThrow("Telegram delivery was cancelled");
    expect(fetchCalls).toBe(1);
  });

  test("includes queue wait in the deadline and never starts an expired report", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstBlocked = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let fetchCalls = 0;
    const fetch: TelegramFetch = () => {
      fetchCalls += 1;
      return firstBlocked;
    };
    const sender = new TelegramReportSender({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      timeoutMs: 100,
      fetch,
    });

    const first = sender.send("first report");
    const queued = sender.send("queued report");
    const [firstError, queuedError] = await Promise.all([
      first.catch((error: unknown) => error),
      queued.catch((error: unknown) => error),
    ]);

    expect(firstError).toBeInstanceOf(TelegramDeliveryError);
    expect(queuedError).toBeInstanceOf(TelegramDeliveryError);
    expect((queuedError as TelegramDeliveryError).message).toBe(
      "Telegram delivery timed out",
    );
    expect(fetchCalls).toBe(1);

    resolveFirst?.(
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    await waitForMicrotaskCondition(() => sender.accepting);
    expect(fetchCalls).toBe(1);
  });

  test("retains serialization after timeout when fetch ignores abort", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstBlocked = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const sentChunkPrefixes: string[] = [];
    let fetchCalls = 0;
    const fetch: TelegramFetch = async (_url, init) => {
      fetchCalls += 1;
      const body = JSON.parse(String(init?.body)) as Readonly<
        Record<string, unknown>
      >;
      const text = body.text;
      if (typeof text !== "string") {
        throw new Error("test expected a text field");
      }
      sentChunkPrefixes.push(text.slice(text.indexOf("\n") + 1).slice(0, 1));
      if (fetchCalls === 1) {
        return firstBlocked;
      }
      return Response.json({ ok: true, result: { message_id: fetchCalls } });
    };
    const sender = new TelegramReportSender({
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef",
      chatId: "-1001234567890",
      timeoutMs: 100,
      fetch,
    });

    const first = sender.send("A");
    await expect(first).rejects.toThrow("Telegram delivery timed out");
    const second = sender.send("B");
    await expect(second).rejects.toThrow("Telegram delivery circuit is open");
    expect(fetchCalls).toBe(1);

    resolveFirst?.(
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    await waitForMicrotaskCondition(() => sender.accepting);
    const recovered = sender.send("B");
    await expect(recovered).resolves.toEqual({
      messageCount: 1,
      messageIds: [2],
    });
    expect(sentChunkPrefixes).toEqual(["A", "B"]);
  });
});
