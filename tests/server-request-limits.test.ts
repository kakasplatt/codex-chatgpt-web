import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { chatGptWebTraceId } from "../src/adapters/chatgpt-web";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, providerConfig } from "../src/config";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import type { RequestSizeLimits } from "../src/request-size-policy";
import {
  compactRequest,
  type CodexRequestRejection,
  responseRequest,
  routeChatGptWebRequest,
  startServer,
  turnIdentityFromHeaders,
} from "../src/server";
import type { CodexProviderConfig } from "../src/types";

const MiB = 1024 * 1024;
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";
const webModel = "chatgpt-web/high";
const requestSizeLimits: RequestSizeLimits = {
  standard: { encodedBytes: 4_096, decodedBytes: 8_192 },
  compaction: { encodedBytes: 32_768, decodedBytes: 65_536 },
};

const padding = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "x".repeat(10_000) }],
};

function compactionAdapterFactory(factoryCalls: CodexProviderConfig[] = []) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    factoryCalls.push(provider);
    return {
      name: "test-web-compactor",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        emit({ type: "text_delta", text: summary, phase: "final_answer" });
        emit({
          type: "done",
          stopReason: "stop",
          endTurn: true,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, estimated: true },
        });
      },
    };
  };
}

function post(path: string, body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string> = {}): Request {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), ...headers },
    body: bytes,
  });
}

const respond = (request: Request, factory = compactionAdapterFactory()) =>
  responseRequest(request, defaultConfig("full"), factory, { requestSizeLimits, rememberState: false });

async function errorMessage(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}

const REJECTION_PREFIX = "This task's request is";
const COMPACT_ADVICE = "Run /compact to shrink the task history, or start a new task.";
const NEW_TASK_ADVICE = "Compaction cannot run on a request this large; start a new task to continue.";

// Rejections log a warning per request; capture it so test output stays clean and lines can be asserted.
const warn = spyOn(console, "warn").mockImplementation(() => {});
beforeEach(() => warn.mockClear());
afterAll(() => warn.mockRestore());
const warnings = () => warn.mock.calls.map(call => call.map(String).join(" "));

test("responses: web v2 compaction between limits is accepted", async () => {
  const body = JSON.stringify({
    model: webModel,
    stream: false,
    input: [padding, { type: "compaction_trigger" }],
  });
  const response = await respond(post("/v1/responses", body));
  expect(response.status).toBe(200);
  const result = await response.json() as { output: Array<{ type: string }> };
  expect(result.output[0]!.type).toBe("compaction");
});

test("responses: web memento compaction between limits is accepted", async () => {
  const metadata = {
    request_kind: "compaction", thread_id: "thread_limits_memento", turn_id: "turn_limits_memento",
    compaction: { trigger: "auto", reason: "context_limit", implementation: "responses", phase: "pre_turn", strategy: "memento" },
  };
  const body = JSON.stringify({
    model: webModel,
    stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    input: [{ ...padding, id: "msg_limits_user" }],
  });
  const response = await respond(post("/v1/responses", body));
  expect(response.status).toBe(200);
  const result = await response.json() as { status: string; output: Array<{ type: string }> };
  expect(result.status).toBe("completed");
  expect(result.output[0]!.type).toBe("message");
});

test("responses: ordinary web body between limits is rejected with the standard limit", async () => {
  const factoryCalls: CodexProviderConfig[] = [];
  const body = JSON.stringify({ model: webModel, stream: false, input: [padding] });
  const response = await respond(post("/v1/responses", body), compactionAdapterFactory(factoryCalls));
  expect(response.status).toBe(400);
  const message = await errorMessage(response);
  expect(message.startsWith(REJECTION_PREFIX)).toBe(true);
  expect(message).toContain("over the 0 MiB local request limit");
  expect(message.endsWith(COMPACT_ADVICE)).toBe(true);
  expect(factoryCalls).toHaveLength(0);
});

test("responses: native-model body between limits is rejected before forwarding", async () => {
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    stream: false,
    input: [padding, { type: "compaction_trigger" }],
  });
  const response = await respond(post("/v1/responses", body));
  expect(response.status).toBe(400);
  const message = await errorMessage(response);
  expect(message.startsWith(REJECTION_PREFIX)).toBe(true);
  expect(message.endsWith(NEW_TASK_ADVICE)).toBe(true);
});

test("responses: body above the compaction ceiling is rejected at read time", async () => {
  const body = JSON.stringify({
    model: webModel,
    stream: false,
    input: [{ ...padding, content: [{ type: "input_text", text: "x".repeat(40_000) }] }, { type: "compaction_trigger" }],
  });
  const response = await respond(post("/v1/responses", body));
  expect(response.status).toBe(400);
  const message = await errorMessage(response);
  expect(message.startsWith(REJECTION_PREFIX)).toBe(true);
  expect(message.endsWith(NEW_TASK_ADVICE)).toBe(true);
});

const compact = (request: Request, factory = compactionAdapterFactory()) =>
  compactRequest(request, defaultConfig("full"), factory, { requestSizeLimits });

test("compact: zstd-encoded web body is handled without re-reading it", async () => {
  const body = new Uint8Array(Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({
    model: webModel,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] }],
  }))));
  const response = await compact(post("/v1/responses/compact", body, { "content-encoding": "zstd" }));
  expect(response.status).toBe(200);
  const result = await response.json() as { output: Array<{ content: Array<{ text: string }> }> };
  expect(result.output.at(-1)!.content[0]!.text).toBe(`${SUMMARY_PREFIX}\n${summary}`);
});

test("compact: identity web body between limits is accepted", async () => {
  const body = JSON.stringify({ model: webModel, input: [padding] });
  const response = await compact(post("/v1/responses/compact", body));
  expect(response.status).toBe(200);
  const result = await response.json() as { output: unknown[] };
  expect(result.output.length).toBeGreaterThan(0);
});

test("compact: native-model body between limits is rejected with the standard limit", async () => {
  const body = JSON.stringify({ model: "gpt-5.6-sol", input: [padding] });
  const response = await compact(post("/v1/responses/compact", body));
  expect(response.status).toBe(400);
  const message = await errorMessage(response);
  expect(message.startsWith(REJECTION_PREFIX)).toBe(true);
  expect(message.endsWith(NEW_TASK_ADVICE)).toBe(true);
});

const REJECTION_LOG_PREFIX = "[codex-chatgpt-web] request_body_rejected";

for (const route of ["responses", "compact"] as const) {
  test(`${route}: oversized body logs one diagnostic line and returns the actionable message`, async () => {
    // responses: between the limits (policy stage); compact: above the compaction ceiling (read stage).
    const body = route === "responses"
      ? JSON.stringify({ model: webModel, stream: false, input: [padding] })
      : JSON.stringify({ model: webModel, input: [{ ...padding, content: [{ type: "input_text", text: "x".repeat(40_000) }] }] });
    const response = route === "responses"
      ? await respond(post("/v1/responses", body))
      : await compact(post("/v1/responses/compact", body));
    expect(response.status).toBe(400);
    const error = ((await response.json()) as { error: { message: string; code: string; type: string } }).error;
    expect(error.message.startsWith(REJECTION_PREFIX)).toBe(true);
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("invalid_request_error");
    const lines = warnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(REJECTION_LOG_PREFIX)).toBe(true);
    const logged = JSON.parse(lines[0]!.slice(REJECTION_LOG_PREFIX.length)) as { route: string; stage: string };
    expect(logged.route).toBe(route);
    expect(logged.stage).toBe(route === "responses" ? "encoded" : "declared");
  });
}

test("unreadable body logs one line without body text", async () => {
  const response = await respond(post("/v1/responses", "{\"secret\":\"SENTINEL_BODY_TEXT\""));
  expect(response.status).toBe(400);
  const lines = warnings();
  expect(lines).toHaveLength(1);
  expect(lines[0]!.startsWith("[codex-chatgpt-web] request_body_unreadable")).toBe(true);
  expect(lines.some(line => line.includes("SENTINEL_BODY_TEXT"))).toBe(false);
});

test("an ordinary web body under the ceiling advises /compact; one above it advises a new task", async () => {
  const under = await respond(post("/v1/responses", JSON.stringify({ model: webModel, stream: false, input: [padding] })));
  expect((await errorMessage(under)).endsWith(COMPACT_ADVICE)).toBe(true);
  const above = await respond(post("/v1/responses", JSON.stringify({
    model: webModel,
    stream: false,
    input: [{ ...padding, content: [{ type: "input_text", text: "x".repeat(40_000) }] }],
  })));
  expect((await errorMessage(above)).endsWith(NEW_TASK_ADVICE)).toBe(true);
});

test("server: a 129 MiB body gets an HTTP 400 instead of a closed socket", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(129 * MiB),
    });
    expect(response.status).toBe(400);
    const message = await errorMessage(response);
    expect(message.startsWith(REJECTION_PREFIX)).toBe(true);
    expect(message).toContain("over the 128 MiB local request limit");
    expect(message.endsWith(NEW_TASK_ADVICE)).toBe(true);
  } finally {
    await server.stop(true);
  }
}, 60_000);

const turnMetadata = (threadId: string, turnId: string): string => JSON.stringify({
  thread_id: threadId, turn_id: turnId, parent_thread_id: "thread_parent",
});

function rejectionRecorder() {
  const rejections: CodexRequestRejection[] = [];
  return { rejections, onRequestRejected: (rejection: CodexRequestRejection) => { rejections.push(rejection); } };
}

test("responses: oversized follow-up reports the rejection with the body identity", async () => {
  const recorder = rejectionRecorder();
  const body = JSON.stringify({
    model: webModel,
    stream: false,
    client_metadata: { "x-codex-turn-metadata": turnMetadata("thread_rejected_followup", "turn_rejected_followup") },
    input: [padding, { type: "function_call_output", call_id: "call_rejected", output: "done" }],
  });
  const response = await responseRequest(post("/v1/responses", body), defaultConfig("full"), compactionAdapterFactory(), {
    requestSizeLimits, rememberState: false, onRequestRejected: recorder.onRequestRejected,
  });
  expect(response.status).toBe(400);
  expect((await errorMessage(response)).startsWith(REJECTION_PREFIX)).toBe(true);
  expect(recorder.rejections).toEqual([{
    identity: { threadId: "thread_rejected_followup", turnId: "turn_rejected_followup" },
    status: 400,
    reason: "request_body_too_large",
  }]);
});

const ceilingBody = JSON.stringify({
  model: webModel,
  stream: false,
  input: [{ ...padding, content: [{ type: "input_text", text: "x".repeat(40_000) }] }],
});

test("responses: read-time ceiling rejection reports the header identity", async () => {
  const recorder = rejectionRecorder();
  const headers = { "x-codex-turn-metadata": turnMetadata("thread_ceiling", "turn_ceiling") };
  const response = await responseRequest(post("/v1/responses", ceilingBody, headers), defaultConfig("full"), compactionAdapterFactory(), {
    requestSizeLimits, rememberState: false, onRequestRejected: recorder.onRequestRejected,
  });
  expect(response.status).toBe(400);
  expect((await errorMessage(response)).endsWith(NEW_TASK_ADVICE)).toBe(true);
  expect(recorder.rejections).toEqual([{
    identity: { threadId: "thread_ceiling", turnId: "turn_ceiling" },
    status: 400,
    reason: "request_body_too_large",
  }]);
});

test("responses: read-time ceiling rejection with a missing or unparseable header reports nothing", async () => {
  const cases: Array<Record<string, string>> = [{}, { "x-codex-turn-metadata": "{not json" }, { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_only" }) }];
  for (const headers of cases) {
    const recorder = rejectionRecorder();
    const response = await responseRequest(post("/v1/responses", ceilingBody, headers), defaultConfig("full"), compactionAdapterFactory(), {
      requestSizeLimits, rememberState: false, onRequestRejected: recorder.onRequestRejected,
    });
    expect(response.status).toBe(400);
    expect((await errorMessage(response)).endsWith(NEW_TASK_ADVICE)).toBe(true);
    expect(recorder.rejections).toEqual([]);
  }
});

test("turnIdentityFromHeaders returns the header turn or undefined without throwing", () => {
  const identity = (value?: string) => turnIdentityFromHeaders(new Headers(value === undefined ? {} : { "x-codex-turn-metadata": value }));
  expect(identity(turnMetadata("thread_h", "turn_h"))).toEqual({ threadId: "thread_h", turnId: "turn_h" });
  expect(identity()).toBeUndefined();
  expect(identity("{not json")).toBeUndefined();
  expect(identity("[1,2]")).toBeUndefined();
  expect(identity(JSON.stringify({ thread_id: "thread_only" }))).toBeUndefined();
  expect(identity(JSON.stringify({ thread_id: 1, turn_id: 2 }))).toBeUndefined();
});

test("responses: a refused previous_response_id follow-up reports an invalid_request rejection", async () => {
  const recorder = rejectionRecorder();
  const body = JSON.stringify({
    model: webModel,
    stream: false,
    previous_response_id: "resp_unknown_local_state",
    client_metadata: { "x-codex-turn-metadata": turnMetadata("thread_previous", "turn_previous") },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }],
  });
  const response = await responseRequest(post("/v1/responses", body), defaultConfig("full"), compactionAdapterFactory(), {
    requestSizeLimits, rememberState: false, onRequestRejected: recorder.onRequestRejected,
  });
  expect(response.status).toBe(409);
  expect(recorder.rejections).toEqual([{
    identity: { threadId: "thread_previous", turnId: "turn_previous" },
    status: 409,
    reason: "invalid_request",
  }]);
});

test("compact: read-time ceiling rejection reports the header identity", async () => {
  const recorder = rejectionRecorder();
  const body = JSON.stringify({ model: webModel, input: [{ ...padding, content: [{ type: "input_text", text: "x".repeat(40_000) }] }] });
  const headers = { "x-codex-turn-metadata": turnMetadata("thread_compact_ceiling", "turn_compact_ceiling") };
  const response = await compactRequest(post("/v1/responses/compact", body, headers), defaultConfig("full"), compactionAdapterFactory(), {
    requestSizeLimits, onRequestRejected: recorder.onRequestRejected,
  });
  expect(response.status).toBe(400);
  expect((await errorMessage(response)).endsWith(NEW_TASK_ADVICE)).toBe(true);
  expect(recorder.rejections).toEqual([{
    identity: { threadId: "thread_compact_ceiling", turnId: "turn_compact_ceiling" },
    status: 400,
    reason: "request_body_too_large",
  }]);
});

test("prediction-skip and terminal replay do not report a rejection", async () => {
  const recorder = rejectionRecorder();
  const noAdapter = (): ProviderAdapter => { throw new Error("a refused request must not construct an adapter"); };

  // Prediction-skip: default limits, so the oversized prediction reaches its own skip site.
  const predictionMetadata = {
    request_kind: "turn", thread_source: "composer_predictions", turn_trigger: "composer_predictions",
    thread_id: "prediction-thread", turn_id: "prediction-turn", forked_from_thread_id: "parent-thread",
  };
  const prediction = await responseRequest(post("/v1/responses", JSON.stringify({
    model: "chatgpt-web/gpt-6-pro", reasoning: { effort: "max" }, stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(predictionMetadata) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "preserve this entire history ".repeat(60_000) }] }],
    text: { format: { type: "json_schema", name: "suggestion", strict: true,
      schema: { type: "object", properties: { suggestion: { type: ["string", "null"] } }, required: ["suggestion"], additionalProperties: false } } },
  })), { ...defaultConfig("full"), proAvailable: true, experimentalBiggerContext: true }, noAdapter, {
    rememberState: false, onRequestRejected: recorder.onRequestRejected,
  });
  expect(prediction.status).toBe(400);
  expect(await prediction.text()).toContain("Next-message prediction skipped");

  // Luna compaction refusal is a designed 409, not a rejected follow-up (on both routes).
  const lunaConfig = { ...defaultConfig("browser-only"), solAvailable: false };
  const luna = await responseRequest(post("/v1/responses", JSON.stringify({
    model: "chatgpt-web/luna", stream: false,
    client_metadata: { "x-codex-turn-metadata": turnMetadata("thread_luna", "turn_luna") },
    input: [{ type: "compaction_trigger" }],
  })), lunaConfig, noAdapter, { rememberState: false, onRequestRejected: recorder.onRequestRejected });
  expect(luna.status).toBe(409);
  const lunaCompact = await compactRequest(post("/v1/responses/compact", JSON.stringify({ model: "chatgpt-web/luna", input: [] }), {
    "x-codex-turn-metadata": turnMetadata("thread_luna", "turn_luna"),
  }), lunaConfig, noAdapter, { onRequestRejected: recorder.onRequestRejected });
  expect(lunaCompact.status).toBe(409);

  // Terminal replay of a turn whose browser tab was closed.
  const config = defaultConfig("browser-only");
  const turnId = "turn_rejection_replay";
  const replayBody = {
    model: "chatgpt-web/high",
    stream: true,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_rejection_replay", turn_id: turnId }) },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Run until the browser tab is closed" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }],
  };
  const parsed = parseRequest(replayBody);
  routeChatGptWebRequest(parsed, config);
  const traceId = chatGptWebTraceId(providerConfig(config), parsed);
  chatGptTurnSessions.clear();
  let rejectBrowser!: (error: Error) => void;
  const cancelledBrowser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
  chatGptTurnSessions.getOrCreate("rejection-replay", () => ({
    mode: "read-only",
    browser: cancelledBrowser,
    physicalSettlement: cancelledBrowser.then(() => undefined, () => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: reason => rejectBrowser(reason ?? new Error("cancelled")),
  }), traceId);
  try {
    expect(await chatGptTurnSessions.cancelTrace(traceId)).toBe(1);
    const replay = await responseRequest(post("/v1/responses", JSON.stringify(replayBody)), config, noAdapter, {
      rememberState: false, onRequestRejected: recorder.onRequestRejected,
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: { type: string } }).error.type).toBe("client_closed_request");
  } finally {
    chatGptTurnSessions.clear();
  }

  expect(recorder.rejections).toEqual([]);
});

const SIZE_LOG_PREFIX = "[codex-chatgpt-web] request_body_size";
const sizeLines = () => warnings().filter(line => line.startsWith(SIZE_LOG_PREFIX));

function capturingAdapterFactory(seen: Array<Record<string, unknown>>) {
  return (): ProviderAdapter => ({
    name: "test-web-capture",
    async runTurn(parsed, _incoming, emit) {
      seen.push({ bytes: parsed._requestBodyBytes });
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, estimated: true },
      });
    },
  });
}

test("size line is logged at the floor and above, not below, and carries no body text", async () => {
  const image = "data:image/png;base64,SENTINEL_IMAGE_BYTES";
  const body = new TextEncoder().encode(JSON.stringify({
    model: webModel,
    stream: false,
    input: [
      padding,
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: image }] },
      { type: "compaction_trigger" },
    ],
  }));
  const at = (floor: number) => responseRequest(
    post("/v1/responses", body),
    defaultConfig("full"),
    compactionAdapterFactory(),
    { requestSizeLimits, rememberState: false, requestSizeLogFloorBytes: floor },
  );

  expect((await at(body.byteLength)).status).toBe(200);
  const lines = sizeLines();
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!.slice(SIZE_LOG_PREFIX.length))).toEqual({
    route: "responses",
    encodedBytes: body.byteLength,
    decodedBytes: body.byteLength,
    contentEncoding: "identity",
    imageCount: 1,
    imageBytes: image.length,
  });
  expect(lines[0]).not.toContain("SENTINEL_IMAGE_BYTES");
  expect(lines[0]).not.toContain("xxxx");

  warn.mockClear();
  expect((await at(body.byteLength + 1)).status).toBe(200);
  expect(sizeLines()).toHaveLength(0);
});

test("size line uses the 8 MiB floor by default", async () => {
  const response = await respond(post("/v1/responses", JSON.stringify({
    model: webModel,
    stream: false,
    input: [padding, { type: "compaction_trigger" }],
  })));
  expect(response.status).toBe(200);
  expect(sizeLines()).toHaveLength(0);
});

test("the adapter receives server-measured bytes; caller metadata cannot set them", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const body = new TextEncoder().encode(JSON.stringify({
    model: webModel,
    stream: false,
    _requestBodyBytes: { encoded: 1, decoded: 2 },
    input: [padding, { type: "compaction_trigger" }],
  }));
  const response = await responseRequest(
    post("/v1/responses", body),
    defaultConfig("full"),
    capturingAdapterFactory(seen),
    { requestSizeLimits, rememberState: false },
  );
  expect(response.status).toBe(200);
  expect(seen).toEqual([{ bytes: { encoded: body.byteLength, decoded: body.byteLength } }]);
});

test("compact: the adapter receives the outer body size, not the trigger-appended one", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const body = new TextEncoder().encode(JSON.stringify({ model: webModel, input: [padding] }));
  const response = await compactRequest(
    post("/v1/responses/compact", body),
    defaultConfig("full"),
    capturingAdapterFactory(seen),
    { requestSizeLimits, requestSizeLogFloorBytes: body.byteLength },
  );
  expect(response.status).toBe(200);
  expect(seen).toEqual([{ bytes: { encoded: body.byteLength, decoded: body.byteLength } }]);
  const lines = sizeLines();
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!.slice(SIZE_LOG_PREFIX.length)).route).toBe("compact");
});
