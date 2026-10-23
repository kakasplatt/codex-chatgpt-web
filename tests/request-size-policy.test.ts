import { expect, test } from "bun:test";
import { DEFAULT_REQUEST_BODY_LIMITS } from "../src/http-body";
import {
  COMPACTION_REQUEST_BODY_LIMITS,
  REQUEST_SIZE_LIMITS,
  hasCompactionTrigger,
  isCompactionRequestBody,
  requestBodyLimitsFor,
} from "../src/request-size-policy";

function mementoBody(strategy: string): unknown {
  return {
    input: [{ type: "message", role: "user", content: "hi" }],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "compaction",
        compaction: { implementation: "responses", strategy },
      }),
    },
  };
}

test("limit constants keep the standard values and double them for compaction", () => {
  expect(REQUEST_SIZE_LIMITS.standard).toEqual(DEFAULT_REQUEST_BODY_LIMITS);
  expect(REQUEST_SIZE_LIMITS.compaction).toBe(COMPACTION_REQUEST_BODY_LIMITS);
  expect(COMPACTION_REQUEST_BODY_LIMITS).toEqual({
    encodedBytes: 128 * 1024 * 1024,
    decodedBytes: 256 * 1024 * 1024,
  });
});

test("v2 trigger tail on /responses selects the compaction limits for a Web model", () => {
  expect(requestBodyLimitsFor({
    route: "responses",
    raw: { input: [{ type: "message" }, { type: "compaction_trigger" }] },
    webModel: true,
  })).toEqual(COMPACTION_REQUEST_BODY_LIMITS);
});

test("memento metadata on /responses selects the compaction limits", () => {
  expect(requestBodyLimitsFor({ route: "responses", raw: mementoBody("memento"), webModel: true }))
    .toEqual(COMPACTION_REQUEST_BODY_LIMITS);
});

test("unsupported memento protocol still selects the compaction limits", () => {
  expect(requestBodyLimitsFor({ route: "responses", raw: mementoBody("other"), webModel: true }))
    .toEqual(COMPACTION_REQUEST_BODY_LIMITS);
});

test("/compact always selects the compaction limits for a Web model", () => {
  expect(requestBodyLimitsFor({ route: "compact", raw: {}, webModel: true }))
    .toEqual(COMPACTION_REQUEST_BODY_LIMITS);
});

test("ordinary Web bodies and every native body keep the standard limits", () => {
  expect(requestBodyLimitsFor({ route: "responses", raw: { input: [{ type: "message" }] }, webModel: true }))
    .toEqual(DEFAULT_REQUEST_BODY_LIMITS);
  expect(requestBodyLimitsFor({ route: "responses", raw: null, webModel: true }))
    .toEqual(DEFAULT_REQUEST_BODY_LIMITS);
  expect(requestBodyLimitsFor({
    route: "compact",
    raw: { input: [{ type: "compaction_trigger" }] },
    webModel: false,
  })).toEqual(DEFAULT_REQUEST_BODY_LIMITS);
  expect(requestBodyLimitsFor({
    route: "responses",
    raw: { input: [{ type: "compaction_trigger" }] },
    webModel: false,
  })).toEqual(DEFAULT_REQUEST_BODY_LIMITS);
});

test("trigger followed by additional_tools still selects the compaction limits", () => {
  const raw = {
    input: [
      { type: "message" },
      { type: "compaction_trigger" },
      { type: "additional_tools", role: "developer", tools: [] },
    ],
  };
  expect(hasCompactionTrigger(raw)).toBe(true);
  expect(isCompactionRequestBody(raw, "responses")).toBe(true);
  expect(requestBodyLimitsFor({ route: "responses", raw, webModel: true }))
    .toEqual(COMPACTION_REQUEST_BODY_LIMITS);
});

test("hasCompactionTrigger tolerates malformed input", () => {
  expect(hasCompactionTrigger(undefined)).toBe(false);
  expect(hasCompactionTrigger([])).toBe(false);
  expect(hasCompactionTrigger({ input: "compaction_trigger" })).toBe(false);
  expect(hasCompactionTrigger({ input: [null, 1, "x", [], {}] })).toBe(false);
});

test("injected limits override the defaults", () => {
  const limits = {
    standard: { encodedBytes: 1, decodedBytes: 2 },
    compaction: { encodedBytes: 3, decodedBytes: 4 },
  };
  expect(requestBodyLimitsFor({ route: "compact", raw: {}, webModel: true }, limits)).toBe(limits.compaction);
  expect(requestBodyLimitsFor({ route: "responses", raw: {}, webModel: true }, limits)).toBe(limits.standard);
});
