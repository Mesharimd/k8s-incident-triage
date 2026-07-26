import { createHash } from "node:crypto";

export const TELEGRAM_MESSAGE_UTF16_LIMIT = 4_096;
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 40_000;
export const MIN_TELEGRAM_TIMEOUT_MS = 100;
export const MAX_TELEGRAM_TIMEOUT_MS = 120_000;
const MAX_TELEGRAM_RESPONSE_BYTES = 65_536;
const MAX_TELEGRAM_REPORT_UTF16 = 131_072;
const MAX_OWNED_TELEGRAM_REPORTS = 10;
export const TELEGRAM_PART_PREFIX_RESERVE = 64;
export const TELEGRAM_INTER_PART_DELAY_MS = 1_000;

const MARKDOWN_V2_RESERVED = new Set([
  "_",
  "*",
  "[",
  "]",
  "(",
  ")",
  "~",
  "`",
  ">",
  "#",
  "+",
  "-",
  "=",
  "|",
  "{",
  "}",
  ".",
  "!",
  "\\",
]);

export function escapeMarkdownV2(value: string): string {
  let escaped = "";
  for (const symbol of value) {
    escaped += MARKDOWN_V2_RESERVED.has(symbol) ? `\\${symbol}` : symbol;
  }
  return escaped;
}

export function chunkMarkdownV2(
  value: string,
  maxUtf16Length = TELEGRAM_MESSAGE_UTF16_LIMIT,
): readonly string[] {
  if (
    !Number.isSafeInteger(maxUtf16Length) ||
    maxUtf16Length < 1 ||
    maxUtf16Length > TELEGRAM_MESSAGE_UTF16_LIMIT
  ) {
    throw new Error(
      `maxUtf16Length must be between 1 and ${TELEGRAM_MESSAGE_UTF16_LIMIT}`,
    );
  }

  const lines: string[] = [];
  let line = "";
  for (const symbol of value) {
    line += symbol;
    if (symbol === "\n") {
      lines.push(line);
      line = "";
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }

  const chunks: string[] = [];
  let chunk = "";
  const pushChunk = (): void => {
    if (chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
    }
  };
  const appendOversizedLine = (rawLine: string): void => {
    pushChunk();
    for (const symbol of rawLine) {
      const escaped = escapeMarkdownV2(symbol);
      if (escaped.length > maxUtf16Length) {
        throw new Error("maxUtf16Length cannot hold one escaped character");
      }
      if (chunk.length + escaped.length > maxUtf16Length) {
        pushChunk();
      }
      chunk += escaped;
    }
  };

  for (const rawLine of lines) {
    const escapedLine = escapeMarkdownV2(rawLine);
    if (escapedLine.length > maxUtf16Length) {
      appendOversizedLine(rawLine);
      continue;
    }
    if (chunk.length + escapedLine.length > maxUtf16Length) {
      pushChunk();
    }
    chunk += escapedLine;
  }
  pushChunk();
  return chunks;
}

export type TelegramFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
  readonly timeoutMs: number;
}

const BOT_TOKEN_PATTERN = /^[1-9]\d*:[A-Za-z0-9_-]{20,}$/;
const PRIVATE_CHAT_ID_PATTERN = /^-?[1-9]\d{0,30}$/;
const MAX_API_ERROR_DESCRIPTION_UTF16 = 256;
const REDACTED = "[REDACTED]";

function telegramConfig(
  botTokenValue: string | undefined,
  chatIdValue: string | undefined,
  timeoutMs: number,
): TelegramConfig {
  const botToken = botTokenValue?.trim();
  if (botToken === undefined || botToken.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (botToken.length > 256 || !BOT_TOKEN_PATTERN.test(botToken)) {
    throw new Error("TELEGRAM_BOT_TOKEN is invalid");
  }

  const chatId = chatIdValue?.trim();
  if (chatId === undefined || chatId.length === 0) {
    throw new Error("TELEGRAM_CHAT_ID is required");
  }
  if (!PRIVATE_CHAT_ID_PATTERN.test(chatId)) {
    throw new Error(
      "TELEGRAM_CHAT_ID must be a numeric private chat or channel ID",
    );
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TELEGRAM_TIMEOUT_MS ||
    timeoutMs > MAX_TELEGRAM_TIMEOUT_MS
  ) {
    throw new Error(
      `TELEGRAM_TIMEOUT_MS must be between ${MIN_TELEGRAM_TIMEOUT_MS} and ${MAX_TELEGRAM_TIMEOUT_MS}`,
    );
  }
  return { botToken, chatId, timeoutMs };
}

function environmentTimeout(value: string | undefined): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return DEFAULT_TELEGRAM_TIMEOUT_MS;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error("TELEGRAM_TIMEOUT_MS must be an integer");
  }
  const timeoutMs = Number(normalized);
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error(
      `TELEGRAM_TIMEOUT_MS must be between ${MIN_TELEGRAM_TIMEOUT_MS} and ${MAX_TELEGRAM_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export function loadTelegramConfig(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): TelegramConfig {
  return telegramConfig(
    environment.TELEGRAM_BOT_TOKEN,
    environment.TELEGRAM_CHAT_ID,
    environmentTimeout(environment.TELEGRAM_TIMEOUT_MS),
  );
}

export interface SendTelegramMessageInput {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly fetch?: TelegramFetch;
  readonly signal?: AbortSignal;
  readonly shouldContinue?: () => boolean;
  readonly timeoutMs?: number;
}

export interface TelegramDeliveryResult {
  readonly messageCount: number;
  readonly messageIds: readonly number[];
}

export class TelegramDeliveryError extends Error {
  readonly sentCount: number;
  readonly totalCount: number;
  readonly retrySafe: boolean;
  readonly fatalConfiguration: boolean;

  constructor(
    message: string,
    sentCount: number,
    totalCount: number,
    retrySafe: boolean,
    fatalConfiguration = false,
  ) {
    super(message);
    this.name = "TelegramDeliveryError";
    this.sentCount = sentCount;
    this.totalCount = totalCount;
    this.retrySafe = retrySafe;
    this.fatalConfiguration = fatalConfiguration;
  }
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function responseMessageId(value: unknown): number | undefined {
  const response = objectValue(value);
  if (response?.ok !== true) {
    return undefined;
  }
  const result = objectValue(response.result);
  const messageId = result?.message_id;
  return typeof messageId === "number" && Number.isSafeInteger(messageId)
    ? messageId
    : undefined;
}

function retrySafeTelegramRejection(
  response: Response,
  payload: unknown,
  sentCount: number,
): boolean {
  return (
    sentCount === 0 &&
    objectValue(payload)?.ok === false &&
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 408
  );
}

function fatalTelegramConfigurationRejection(
  response: Response,
  payload: unknown,
): boolean {
  if (objectValue(payload)?.ok !== false) {
    return false;
  }
  if (response.status === 401 || response.status === 403) {
    return true;
  }
  const description = objectValue(payload)?.description;
  return (
    response.status === 400 &&
    typeof description === "string" &&
    /(?:^|:\s*)chat not found\b/i.test(description.trim())
  );
}

class TelegramResponseLimitError extends Error {
  constructor() {
    super("Telegram Bot API response exceeded safe limit");
    this.name = "TelegramResponseLimitError";
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_TELEGRAM_RESPONSE_BYTES
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new TelegramResponseLimitError();
    }
  }
  if (response.body === null) {
    return "";
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
    if (totalBytes > MAX_TELEGRAM_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new TelegramResponseLimitError();
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function truncateUtf16(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  let end = limit;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

function safeApiErrorDescription(
  payload: unknown,
  config: TelegramConfig,
): string | undefined {
  const description = objectValue(payload)?.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return undefined;
  }
  const sanitized = description
    .split(config.botToken)
    .join(REDACTED)
    .split(encodeURIComponent(config.botToken))
    .join(REDACTED)
    .split(config.chatId)
    .join(REDACTED)
    .replace(
      /https:\/\/api\.telegram\.org\/bot[^/\s]+/gi,
      `https://api.telegram.org/bot${REDACTED}`,
    )
    .replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length === 0
    ? undefined
    : truncateUtf16(sanitized, MAX_API_ERROR_DESCRIPTION_UTF16);
}

type DeliveryInterruption = "cancelled" | "timed_out";

interface TelegramDeliveryExecution {
  readonly visible: Promise<TelegramDeliveryResult>;
  readonly settled: Promise<TelegramDeliveryResult>;
  readonly isSettled: () => boolean;
}

function interruptedDeliveryError(
  reason: DeliveryInterruption,
  sentCount: number,
  totalCount: number,
  retrySafe: boolean,
): TelegramDeliveryError {
  return new TelegramDeliveryError(
    reason === "timed_out"
      ? "Telegram delivery timed out"
      : "Telegram delivery was cancelled",
    sentCount,
    totalCount,
    retrySafe,
  );
}

function waitForNextTelegramPart(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    timer = globalThis.setTimeout(finish, TELEGRAM_INTER_PART_DELAY_MS);
  });
}

function telegramChunks(text: string): readonly string[] {
  if (text.trim().length === 0) {
    throw new Error("Telegram message text must not be empty");
  }
  if (text.length > MAX_TELEGRAM_REPORT_UTF16) {
    throw new Error(
      `Telegram report must be at most ${MAX_TELEGRAM_REPORT_UTF16} UTF-16 units`,
    );
  }
  const ordinaryChunks = chunkMarkdownV2(text);
  if (ordinaryChunks.length === 1) {
    return ordinaryChunks;
  }
  const bodyChunks = chunkMarkdownV2(
    text,
    TELEGRAM_MESSAGE_UTF16_LIMIT - TELEGRAM_PART_PREFIX_RESERVE,
  );
  const reportId = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return bodyChunks.map((chunk, index) => {
    const prefix = `Report ${reportId} part ${index + 1} of ${bodyChunks.length}\n`;
    const message = `${prefix}${chunk}`;
    if (message.length > TELEGRAM_MESSAGE_UTF16_LIMIT) {
      throw new Error("Telegram report part prefix exceeded its reserved bound");
    }
    return message;
  });
}

function requiredInterPartPacingMs(partCount: number): number {
  return Math.max(0, partCount - 1) * TELEGRAM_INTER_PART_DELAY_MS;
}

function createTelegramDelivery(
  {
    botToken,
    chatId,
    text,
    fetch: fetchOverride,
    signal,
    shouldContinue,
    timeoutMs = DEFAULT_TELEGRAM_TIMEOUT_MS,
  }: SendTelegramMessageInput,
  predecessor: Promise<void> = Promise.resolve(),
): TelegramDeliveryExecution {
  const config = telegramConfig(botToken, chatId, timeoutMs);
  const chunks = telegramChunks(text);
  if (requiredInterPartPacingMs(chunks.length) >= config.timeoutMs) {
    throw new TelegramDeliveryError(
      "Telegram delivery timeout cannot fit required inter-part pacing",
      0,
      chunks.length,
      true,
    );
  }
  const request = fetchOverride ?? globalThis.fetch;
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const messageIds: number[] = [];
  const controller = new AbortController();
  let interruption: DeliveryInterruption | undefined;
  let requestStartedCount = 0;
  let operationSettled = false;
  let rejectInterruption: (reason: unknown) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  // The operation can also reject after observing the same cancellation. Keep
  // the dedicated wake-up promise handled even when those paths settle together.
  void interrupted.catch(() => undefined);

  const interrupt = (reason: DeliveryInterruption): void => {
    if (interruption !== undefined) {
      return;
    }
    interruption = reason;
    controller.abort();
    rejectInterruption(
      interruptedDeliveryError(
        reason,
        messageIds.length,
        chunks.length,
        messageIds.length === 0 && requestStartedCount === 0,
      ),
    );
  };
  const abortForCaller = (): void => interrupt("cancelled");
  const timeout = globalThis.setTimeout(
    () => interrupt("timed_out"),
    config.timeoutMs,
  );
  if (signal?.aborted === true) {
    abortForCaller();
  } else {
    signal?.addEventListener("abort", abortForCaller, { once: true });
  }

  const assertActive = (): void => {
    let current = true;
    try {
      current = shouldContinue?.() ?? true;
    } catch {
      current = false;
    }
    if (!current) {
      interrupt("cancelled");
    }
    if (controller.signal.aborted) {
      throw interruptedDeliveryError(
        interruption ?? "cancelled",
        messageIds.length,
        chunks.length,
        messageIds.length === 0 && requestStartedCount === 0,
      );
    }
  };
  const deliver = async (): Promise<TelegramDeliveryResult> => {
    assertActive();
    for (let index = 0; index < chunks.length; index += 1) {
      assertActive();
      if (index > 0) {
        await waitForNextTelegramPart(controller.signal);
        assertActive();
      }
      const chunk = chunks[index];
      if (chunk === undefined) {
        throw new Error("Telegram report part was unexpectedly missing");
      }
      let response: Response;
      try {
        requestStartedCount += 1;
        response = await request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: config.chatId,
            text: chunk,
            parse_mode: "MarkdownV2",
          }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        if (controller.signal.aborted) {
          assertActive();
        }
        throw new TelegramDeliveryError(
          "Telegram delivery request failed",
          messageIds.length,
          chunks.length,
          false,
        );
      }
      // A transport may ignore AbortSignal and resolve after the caller already
      // timed out. Never parse that response or emit another report chunk.
      assertActive();

      let payload: unknown;
      try {
        payload = JSON.parse(await readBoundedResponseText(response)) as unknown;
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          assertActive();
        }
        throw new TelegramDeliveryError(
          error instanceof TelegramResponseLimitError
            ? error.message
            : "Telegram Bot API returned an invalid response",
          messageIds.length,
          chunks.length,
          false,
        );
      }
      assertActive();
      const messageId = responseMessageId(payload);
      if (!response.ok || messageId === undefined) {
        const description = safeApiErrorDescription(payload, config);
        throw new TelegramDeliveryError(
          [
            `Telegram Bot API rejected a message (HTTP ${response.status})`,
            ...(description === undefined ? [] : [description]),
          ].join(": "),
          messageIds.length,
          chunks.length,
          retrySafeTelegramRejection(response, payload, messageIds.length),
          fatalTelegramConfigurationRejection(response, payload),
        );
      }
      messageIds.push(messageId);
    }
    return { messageCount: messageIds.length, messageIds };
  };

  const operation = predecessor.then(deliver);
  const settled = operation.finally(() => {
    operationSettled = true;
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortForCaller);
  });
  return {
    visible: Promise.race([settled, interrupted]),
    settled,
    isSettled: () => operationSettled,
  };
}

export async function sendTelegramMessage(
  input: SendTelegramMessageInput,
): Promise<TelegramDeliveryResult> {
  return createTelegramDelivery(input).visible;
}

export interface TelegramReportSenderOptions extends TelegramConfig {
  readonly fetch?: TelegramFetch;
}

export interface TelegramQueuedSendOptions {
  readonly signal?: AbortSignal;
  readonly shouldContinue?: () => boolean;
}

/**
 * Serializes complete reports, rather than individual chunks, so two concurrent
 * incidents cannot produce an interleaved operator conversation.
 */
export class TelegramReportSender {
  readonly #config: TelegramConfig;
  readonly #fetch: TelegramFetch | undefined;
  #tail: Promise<void> = Promise.resolve();
  #ownedExecutions = 0;
  #circuitOpen = false;
  #configurationRejected = false;

  constructor(options: TelegramReportSenderOptions) {
    this.#config = telegramConfig(
      options.botToken,
      options.chatId,
      options.timeoutMs,
    );
    this.#fetch = options.fetch;
  }

  get accepting(): boolean {
    return (
      !this.#circuitOpen &&
      !this.#configurationRejected &&
      this.#ownedExecutions < MAX_OWNED_TELEGRAM_REPORTS
    );
  }

  send(
    text: string,
    options: TelegramQueuedSendOptions = {},
  ): Promise<TelegramDeliveryResult> {
    if (!this.accepting) {
      let totalCount: number;
      try {
        totalCount = telegramChunks(text).length;
      } catch (error: unknown) {
        return Promise.reject(error);
      }
      return Promise.reject(
        new TelegramDeliveryError(
          this.#circuitOpen
            ? "Telegram delivery circuit is open"
            : this.#configurationRejected
              ? "Telegram delivery configuration was rejected"
            : "Telegram report queue is at capacity",
          0,
          totalCount,
          true,
        ),
      );
    }
    let execution: TelegramDeliveryExecution;
    try {
      execution = createTelegramDelivery(
        {
          ...this.#config,
          text,
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.shouldContinue === undefined
            ? {}
            : { shouldContinue: options.shouldContinue }),
        },
        this.#tail,
      );
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    this.#ownedExecutions += 1;
    // Retain queue ownership until the transport settles. The public promise can
    // time out earlier, but a cancellation-ignoring fetch must not overlap the
    // next report or emit a late second chunk.
    this.#tail = execution.settled.then(
      () => undefined,
      () => undefined,
    );
    void execution.settled.then(
      () => this.#releaseExecution(),
      () => this.#releaseExecution(),
    );
    return execution.visible.catch((error: unknown) => {
      if (
        error instanceof TelegramDeliveryError &&
        error.fatalConfiguration
      ) {
        this.#configurationRejected = true;
      } else if (!execution.isSettled()) {
        this.#circuitOpen = true;
      }
      throw error;
    });
  }

  #releaseExecution(): void {
    this.#ownedExecutions -= 1;
    if (this.#ownedExecutions === 0) {
      this.#circuitOpen = false;
    }
  }
}
