import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptWebTurnRetryPolicy,
  MAX_ACTIVE_ATTEMPT_MS,
  MAX_CHATGPT_WEB_TURN_RETRIES,
} from "../src/adapters/chatgpt-web/retry-policy";

const MIN = 60_000;
const err = new ChatGptWebAdapterError("ChatGPT stopped this response with an error.", {
  status: 502,
  errorType: "server_error",
  code: "upstream_server_error",
  retryable: true,
});

test("long attempt keeps the retry count", () => {
  const policy = new ChatGptWebTurnRetryPolicy(30 * MIN);
  policy.recordRetryableFailure("k", err, 0);
  policy.markAttempt("k", 2_000);
  policy.recordRetryableFailure("k", err, 34 * MIN);
  policy.markAttempt("k", 34 * MIN + 2_000);
  policy.recordRetryableFailure("k", err, 70 * MIN);
  policy.markAttempt("k", 70 * MIN + 2_000);
  const fourth = policy.recordRetryableFailure("k", err, 110 * MIN);
  expect(fourth.retryable).toBe(false);
  expect(policy.exhaustedError("k", 110 * MIN + 1)).toBeDefined();
});

test("idle entry still expires after the TTL", () => {
  const policy = new ChatGptWebTurnRetryPolicy(30 * MIN);
  for (let i = 0; i < MAX_CHATGPT_WEB_TURN_RETRIES; i += 1) policy.recordRetryableFailure("k", err, i);
  expect(policy.recordRetryableFailure("k", err, 31 * MIN).retryable).toBe(true);
});

test("markAttempt without a failure is a no-op", () => {
  const policy = new ChatGptWebTurnRetryPolicy(30 * MIN);
  policy.markAttempt("k", 0);
  expect(policy.exhaustedError("k", 1)).toBeUndefined();
  for (let i = 1; i <= MAX_CHATGPT_WEB_TURN_RETRIES; i += 1) {
    expect(policy.recordRetryableFailure("k", err, i).retryable).toBe(true);
  }
});

test("stale active attempt is pruned after the ceiling", () => {
  const policy = new ChatGptWebTurnRetryPolicy(30 * MIN);
  for (let i = 0; i <= MAX_CHATGPT_WEB_TURN_RETRIES; i += 1) policy.recordRetryableFailure("k", err, i);
  policy.markAttempt("k", 10);
  expect(policy.exhaustedError("k", MAX_ACTIVE_ATTEMPT_MS - 1)).toBeDefined();
  expect(policy.exhaustedError("k", 10 + MAX_ACTIVE_ATTEMPT_MS)).toBeUndefined();
});
