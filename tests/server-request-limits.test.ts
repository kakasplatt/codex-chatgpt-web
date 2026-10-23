import { expect, test } from "bun:test";
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
  expect(await errorMessage(response)).toBe("Encoded request body exceeds 4096 bytes");
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
  expect(await errorMessage(response)).toBe("Encoded request body exceeds 4096 bytes");
});

test("responses: body above the compaction ceiling is rejected at read time", async () => {
  const body = JSON.stringify({
    model: webModel,
    stream: false,
    input: [{ ...padding, content: [{ type: "input_text", text: "x".repeat(40_000) }] }, { type: "compaction_trigger" }],
  });
  const response = await respond(post("/v1/responses", body));
  expect(response.status).toBe(400);
  expect(await errorMessage(response)).toBe("Encoded request body exceeds 32768 bytes");
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
  expect(await errorMessage(response)).toBe("Encoded request body exceeds 4096 bytes");
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
    expect(await errorMessage(response)).toContain("134217728");
  } finally {
    await server.stop(true);
  }
}, 60_000);
