import { DEFAULT_REQUEST_BODY_LIMITS, type RequestBodyLimitError, type RequestBodyLimits } from "./http-body";
import { isNativeTextCompaction } from "./responses/compaction";

/**
 * Compaction must be able to accept a thread that the standard limits already rejected, so the
 * summarizer can shrink it. A stuck thread is at most the standard limits plus one tool batch.
 * Peak memory (encoded + clone + decoded + string + parsed tree) is about 1 GB at this ceiling.
 */
export const COMPACTION_REQUEST_BODY_LIMITS: RequestBodyLimits = {
  encodedBytes: 128 * 1024 * 1024,
  decodedBytes: 256 * 1024 * 1024,
};

/**
 * `Bun.serve` cuts a larger body off by closing the socket before the handler runs, so the server
 * accepts up to twice the compaction encoded ceiling and lets the handler answer with a 400.
 */
export const SERVER_MAX_REQUEST_BODY_BYTES = 2 * COMPACTION_REQUEST_BODY_LIMITS.encodedBytes;

export interface RequestSizeLimits {
  standard: RequestBodyLimits;
  compaction: RequestBodyLimits;
}

export const REQUEST_SIZE_LIMITS: RequestSizeLimits = {
  standard: DEFAULT_REQUEST_BODY_LIMITS,
  compaction: COMPACTION_REQUEST_BODY_LIMITS,
};

export type RequestRoute = "responses" | "compact";

/**
 * True when any `input` item is a `compaction_trigger`. The parser flags it at any position
 * (responses_lite can place an `additional_tools` item after it), so this does too.
 */
export function hasCompactionTrigger(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const input = (raw as Record<string, unknown>).input;
  if (!Array.isArray(input)) return false;
  return input.some(item =>
    Boolean(item)
    && typeof item === "object"
    && !Array.isArray(item)
    && (item as Record<string, unknown>).type === "compaction_trigger");
}

export function isCompactionRequestBody(raw: unknown, route: RequestRoute): boolean {
  if (route === "compact") return true;
  if (hasCompactionTrigger(raw)) return true;
  try {
    return isNativeTextCompaction(raw);
  } catch {
    // Unsupported memento protocol: let parseRequest report the protocol error, not a size error.
    return true;
  }
}

export function requestBodyLimitsFor(
  input: { route: RequestRoute; raw: unknown; webModel: boolean },
  limits: RequestSizeLimits = REQUEST_SIZE_LIMITS,
): RequestBodyLimits {
  return input.webModel && isCompactionRequestBody(input.raw, input.route)
    ? limits.compaction
    : limits.standard;
}

export interface ImagePayloadSummary {
  count: number;
  bytes: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Counts `input_image` parts with a `data:` URL in tool outputs and message content. Other
 * item types and remote image URLs are ignored; `bytes` is the summed length of the data URLs.
 */
export function measureImagePayloads(raw: unknown): ImagePayloadSummary {
  const summary: ImagePayloadSummary = { count: 0, bytes: 0 };
  const input = asRecord(raw)?.input;
  if (!Array.isArray(input)) return summary;
  for (const item of input) {
    const record = asRecord(item);
    if (!record) continue;
    const parts = record.type === "function_call_output" || record.type === "custom_tool_call_output"
      ? record.output
      : record.type === "message"
        ? record.content
        : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const partRecord = asRecord(part);
      if (partRecord?.type !== "input_image") continue;
      const url = partRecord.image_url;
      if (typeof url !== "string" || !url.startsWith("data:")) continue;
      summary.count += 1;
      summary.bytes += url.length;
    }
  }
  return summary;
}

export type RequestRejectionRemedy = "compact" | "new_task";

export interface RequestRejectionContext {
  route: RequestRoute;
  remedy: RequestRejectionRemedy;
  images?: ImagePayloadSummary;
}

const LOG_PREFIX = "[codex-chatgpt-web]";

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function formatRequestBodyRejection(
  error: RequestBodyLimitError,
  context: RequestRejectionContext,
): string {
  const { encodedBytes, decodedBytes, declaredBytes } = error;
  const known = decodedBytes ?? encodedBytes ?? declaredBytes;
  const size = encodedBytes !== undefined && decodedBytes !== undefined && error.contentEncoding !== "identity"
    ? `${mib(encodedBytes)} MiB compressed (${mib(decodedBytes)} MiB uncompressed)`
    : `${mib(known ?? 0)} MiB`;
  const total = decodedBytes ?? encodedBytes;
  const images = context.images && total !== undefined && context.images.bytes * 2 > total
    ? `, mostly image tool results (${context.images.count} images, ${mib(context.images.bytes)} MiB)`
    : "";
  const limitMiB = Math.round(error.limitBytes / (1024 * 1024));
  const head = `This task's request is ${size}, over the ${limitMiB} MiB local request limit${images}.`;
  return context.remedy === "compact"
    ? `${head} Run /compact to shrink the task history, or start a new task.`
    : `${head} Compaction cannot run on a request this large; start a new task to continue.`;
}

/** One size-only line. Never include body content or decode-error messages here. */
export function logRequestBodyRejection(
  error: RequestBodyLimitError,
  context: RequestRejectionContext,
): void {
  console.warn(`${LOG_PREFIX} request_body_rejected ${JSON.stringify({
    route: context.route,
    stage: error.stage,
    limitBytes: error.limitBytes,
    declaredBytes: error.declaredBytes,
    encodedBytes: error.encodedBytes,
    decodedBytes: error.decodedBytes,
    contentEncoding: error.contentEncoding,
    imageCount: context.images?.count,
    imageBytes: context.images?.bytes,
    remedy: context.remedy,
  })}`);
}

/** Logs a body that could not be read or decoded. Deliberately omits `error.message`. */
export function logUnreadableRequestBody(route: RequestRoute, request: Request, error: unknown): void {
  const header = request.headers.get("content-length");
  const declared = header === null ? undefined : Number(header);
  console.warn(`${LOG_PREFIX} request_body_unreadable ${JSON.stringify({
    route,
    reason: error instanceof Error ? error.name : typeof error,
    declaredBytes: declared !== undefined && Number.isFinite(declared) ? declared : undefined,
    contentEncoding: (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase() || "identity",
  })}`);
}
