import { expect, spyOn, test } from "bun:test";
import { DEFAULT_REQUEST_BODY_LIMITS, RequestBodyLimitError } from "../src/http-body";
import { classifyError } from "../src/lib/errors";
import {
  COMPACTION_REQUEST_BODY_LIMITS,
  REQUEST_SIZE_LIMITS,
  REQUEST_SIZE_LOG_FLOOR_BYTES,
  formatRequestBodyRejection,
  hasCompactionTrigger,
  isCompactionRequestBody,
  logRequestBodyRejection,
  logRequestBodySize,
  logUnreadableRequestBody,
  measureImagePayloads,
  requestBodyLimitsFor,
} from "../src/request-size-policy";

const MiB = 1024 * 1024;

function limitError(input: {
  stage: "declared" | "encoded" | "decoded";
  limitBytes: number;
  declaredBytes?: number;
  encodedBytes?: number;
  decodedBytes?: number;
  contentEncoding?: string;
}): RequestBodyLimitError {
  const { stage, limitBytes, contentEncoding = "identity", ...sizes } = input;
  return new RequestBodyLimitError(stage, limitBytes, contentEncoding, sizes);
}

const zstdError = () => limitError({
  stage: "encoded",
  limitBytes: 64 * MiB,
  encodedBytes: 67_423_000,
  decodedBytes: 125_400_000,
  contentEncoding: "zstd",
});

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

test("compact remedy names sizes, limit, image share and /compact", () => {
  expect(formatRequestBodyRejection(zstdError(), {
    route: "responses",
    remedy: "compact",
    images: { count: 165, bytes: 123_700_000 },
  })).toBe("This task's request is 64.3 MiB compressed (119.6 MiB uncompressed), over the 64 MiB local request limit, mostly image tool results (165 images, 118.0 MiB). Run /compact to shrink the task history, or start a new task.");
});

test("image clause is omitted when images are not the majority", () => {
  const message = formatRequestBodyRejection(zstdError(), {
    route: "responses",
    remedy: "compact",
    images: { count: 3, bytes: 1_000_000 },
  });
  expect(message).not.toContain("mostly");
  expect(message).toContain("over the 64 MiB local request limit. Run /compact");
});

test("identity or partially known sizes print a single size", () => {
  const identity = limitError({ stage: "decoded", limitBytes: 128 * MiB, encodedBytes: 10 * MiB, decodedBytes: 130 * MiB });
  expect(formatRequestBodyRejection(identity, { route: "compact", remedy: "compact" }))
    .toStartWith("This task's request is 130.0 MiB, over the 128 MiB local request limit.");
  const declared = limitError({ stage: "declared", limitBytes: 256 * MiB, declaredBytes: 300 * MiB });
  expect(formatRequestBodyRejection(declared, { route: "compact", remedy: "new_task" }))
    .toStartWith("This task's request is 300.0 MiB, over the 256 MiB local request limit.");
});

test("a zstd body whose decoded size is unknown prints the encoded size alone", () => {
  // The encoded limit fires before the body is decompressed, so only the encoded size is known.
  const encodedOnly = limitError({ stage: "encoded", limitBytes: 64 * MiB, encodedBytes: 70 * MiB, contentEncoding: "zstd" });
  const message = formatRequestBodyRejection(encodedOnly, { route: "responses", remedy: "new_task" });
  expect(message).toStartWith("This task's request is 70.0 MiB, over the 64 MiB local request limit.");
  expect(message).not.toContain("compressed");
});

test("new_task remedy does not suggest /compact as the fix", () => {
  const message = formatRequestBodyRejection(zstdError(), { route: "compact", remedy: "new_task" });
  expect(message).toContain("Compaction cannot run on a request this large; start a new task to continue.");
  expect(message).not.toContain("Run /compact");
});

for (const remedy of ["compact", "new_task"] as const) {
  test(`the ${remedy} remedy message keeps the invalid_request_error code`, () => {
    const message = formatRequestBodyRejection(zstdError(), {
      route: "compact",
      remedy,
      images: { count: 165, bytes: 123_700_000 },
    });
    expect(classifyError(400, "invalid_request_error", message).code).toBe("invalid_request_error");
  });
}

test("measureImagePayloads counts data-URL images in tool outputs and messages only", () => {
  const dataUrl = (n: number) => `data:image/png;base64,${"A".repeat(n)}`;
  const raw = {
    input: [
      { type: "function_call_output", call_id: "a", output: [{ type: "input_image", image_url: dataUrl(10) }] },
      { type: "custom_tool_call_output", call_id: "b", output: [
        { type: "input_text", text: "x" },
        { type: "input_image", image_url: dataUrl(20) },
      ] },
      { type: "message", role: "user", content: [
        { type: "input_image", image_url: dataUrl(30) },
        { type: "input_image", image_url: "https://example.com/a.png" },
      ] },
      { type: "reasoning", content: [{ type: "input_image", image_url: dataUrl(99) }] },
      { type: "function_call_output", call_id: "c", output: "plain string" },
    ],
  };
  const lengths = [10, 20, 30].map(n => dataUrl(n).length);
  expect(measureImagePayloads(raw)).toEqual({ count: 3, bytes: lengths[0]! + lengths[1]! + lengths[2]! });
});

const malformedImageInputs: Array<[label: string, raw: unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["a number", 1],
  ["an array", []],
  ["an empty object", {}],
  ["a string input", { input: "x" }],
  ["junk input items", { input: [null, 1, [], { type: "message", content: [null, 2] }] }],
];
for (const [label, raw] of malformedImageInputs) {
  test(`measureImagePayloads tolerates ${label}`, () => {
    expect(measureImagePayloads(raw)).toEqual({ count: 0, bytes: 0 });
  });
}

test("the size line is written from 8 MiB of either encoded or decoded bytes", () => {
  expect(REQUEST_SIZE_LOG_FLOOR_BYTES).toBe(8 * MiB);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const images = { count: 0, bytes: 0 };
    const sized = (encodedBytes: number, decodedBytes: number) => ({ encodedBytes, decodedBytes, contentEncoding: "zstd" });
    logRequestBodySize("responses", sized(REQUEST_SIZE_LOG_FLOOR_BYTES - 1, REQUEST_SIZE_LOG_FLOOR_BYTES - 1), images);
    expect(warn).toHaveBeenCalledTimes(0);
    // Only one of the two counts crosses the floor: the `||` keeps the line.
    logRequestBodySize("responses", sized(REQUEST_SIZE_LOG_FLOOR_BYTES, 1), images);
    expect(warn).toHaveBeenCalledTimes(1);
    logRequestBodySize("responses", sized(1, REQUEST_SIZE_LOG_FLOOR_BYTES), images);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});

test("rejection log is one line with sizes only", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    logRequestBodyRejection(zstdError(), {
      route: "responses",
      remedy: "compact",
      images: { count: 165, bytes: 123_700_000 },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line.startsWith("[codex-chatgpt-web] request_body_rejected ")).toBe(true);
    expect(line).not.toContain("\n");
    const fields = JSON.parse(line.slice("[codex-chatgpt-web] request_body_rejected ".length));
    expect(fields).toEqual({
      route: "responses",
      stage: "encoded",
      limitBytes: 64 * MiB,
      encodedBytes: 67_423_000,
      decodedBytes: 125_400_000,
      contentEncoding: "zstd",
      imageCount: 165,
      imageBytes: 123_700_000,
      remedy: "compact",
    });
  } finally {
    warn.mockRestore();
  }
});

test("logs normalize the client-controlled content encoding to identity, zstd or other", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const encodingOf = (index: number) => JSON.parse(String(warn.mock.calls[index]![0]).replace(/^\S+ \S+ /, "")).contentEncoding;
    const hostile = "x".repeat(10_000);
    logRequestBodyRejection(limitError({ stage: "encoded", limitBytes: 64 * MiB, encodedBytes: 1, contentEncoding: hostile }), { route: "responses", remedy: "new_task" });
    logRequestBodyRejection(limitError({ stage: "encoded", limitBytes: 64 * MiB, encodedBytes: 1, contentEncoding: " ZStd " }), { route: "responses", remedy: "new_task" });
    logRequestBodySize("responses", { encodedBytes: 9 * MiB, decodedBytes: 9 * MiB, contentEncoding: hostile }, { count: 0, bytes: 0 });
    logUnreadableRequestBody("responses", new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-encoding": hostile }, body: "x",
    }), new Error("boom"));
    expect([0, 1, 2, 3].map(encodingOf)).toEqual(["other", "zstd", "other", "other"]);
    expect(warn.mock.calls.every(call => String(call[0]).length < 500)).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("unreadable-body log carries the error name but never its message", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-length": "1234", "content-encoding": "ZSTD" },
      body: "x",
    });
    logUnreadableRequestBody("responses", request, new SyntaxError("Unexpected token 'secret body text'"));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).not.toContain("secret");
    const prefix = "[codex-chatgpt-web] request_body_unreadable ";
    expect(line.startsWith(prefix)).toBe(true);
    expect(JSON.parse(line.slice(prefix.length))).toEqual({
      route: "responses",
      reason: "SyntaxError",
      declaredBytes: 1234,
      contentEncoding: "zstd",
    });
  } finally {
    warn.mockRestore();
  }
});
