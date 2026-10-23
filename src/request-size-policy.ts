import { DEFAULT_REQUEST_BODY_LIMITS, type RequestBodyLimits } from "./http-body";
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
