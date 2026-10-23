import { ChatGptWebAdapterError } from "./adapter-error";

/** Maximum number of automatic browser-turn retries after the initial send. */
export const MAX_CHATGPT_WEB_TURN_RETRIES = 3;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;
/** Safety ceiling for an attempt that never records a failure or clears its budget. */
export const MAX_ACTIVE_ATTEMPT_MS = 6 * 60 * 60_000;

interface RetryBudgetEntry {
  retries: number;
  updatedAt: number;
  /** Set while a retry attempt for this key is running; idle expiry does not apply then. */
  activeSince?: number;
  lastError: {
    message: string;
    status: number;
    errorType: string;
    code: string;
  };
}

function exhaustedError(entry: RetryBudgetEntry): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `${entry.lastError.message} ChatGPT remained unavailable after several attempts.`,
    {
      status: entry.lastError.status,
      errorType: entry.lastError.errorType,
      code: entry.lastError.code,
      retryable: false,
    },
  );
}

/**
 * Tracks only retryable ChatGPT browser failures across adapter instances. The HTTP bridge creates
 * one adapter per request, so this process-local budget must live outside createChatGptWebAdapter.
 */
export class ChatGptWebTurnRetryPolicy {
  private readonly entries = new Map<string, RetryBudgetEntry>();

  constructor(private readonly ttlMs = RETRY_BUDGET_TTL_MS) {}

  recordRetryableFailure(key: string, error: ChatGptWebAdapterError, now = Date.now()): ChatGptWebAdapterError {
    this.prune(now);
    const previous = this.entries.get(key);
    const entry: RetryBudgetEntry = {
      retries: (previous?.retries ?? 0) + 1,
      updatedAt: now,
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.entries.set(key, entry);
    return entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : error;
  }

  exhaustedError(key: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry && entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : undefined;
  }

  /**
   * Marks a request for an already-failed key as a running attempt. One ChatGPT attempt can outlast
   * the idle TTL (turnTimeoutMs is unset by default), so a running attempt must not let its budget
   * expire before it records the next failure. Recording a failure makes the entry idle again.
   */
  markAttempt(key: string, now = Date.now()): void {
    this.prune(now);
    const entry = this.entries.get(key);
    if (entry) entry.activeSince = now;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      const expired = entry.activeSince !== undefined
        ? now - entry.activeSince >= MAX_ACTIVE_ATTEMPT_MS
        : now - entry.updatedAt >= this.ttlMs;
      if (expired) this.entries.delete(key);
    }
  }
}

export const chatGptWebTurnRetryPolicy = new ChatGptWebTurnRetryPolicy();
