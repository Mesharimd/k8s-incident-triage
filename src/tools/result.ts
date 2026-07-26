export const MAX_TOOL_RESULT_BYTES = 16_000;

export interface BoundedToolResult {
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function createBoundedJsonResult(
  value: unknown,
  options: {
    readonly truncated?: boolean;
    readonly truncationReasons?: readonly string[];
    readonly fallback: unknown;
    readonly maxBytes?: number;
  },
): BoundedToolResult {
  const maxBytes = options.maxBytes ?? MAX_TOOL_RESULT_BYTES;
  let content = JSON.stringify(value);
  let truncated = options.truncated ?? false;
  const reasons = [...(options.truncationReasons ?? [])];

  if (utf8ByteLength(content) > maxBytes) {
    content = JSON.stringify(options.fallback);
    truncated = true;
    reasons.push("serialized_result_limit");
  }

  const bytes = utf8ByteLength(content);
  if (bytes > maxBytes) {
    throw new ToolExecutionError(
      `bounded fallback exceeded the ${maxBytes}-byte tool contract`,
    );
  }

  return {
    content,
    bytes,
    truncated,
    truncationReasons: reasons,
  };
}
