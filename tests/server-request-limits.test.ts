import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { RequestSizeLimits } from "../src/request-size-policy";
import { compactRequest, responseRequest, startServer } from "../src/server";
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
