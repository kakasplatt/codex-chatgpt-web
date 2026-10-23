import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";
import type { CodexMessage, CodexProviderConfig } from "../src/types";

// Real-size regression for issue #66: an image-heavy Web history whose zstd body exceeds the
// standard 64 MiB encoded limit but whose decoded form stays under the 128 MiB decoded limit.
// Uses the default REQUEST_SIZE_LIMITS (no injection). This is the only real-size test file.

const MiB = 1024 * 1024;
const IMAGE_PAIRS = 34;
const IMAGE_BYTES = 2_076_180;
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

let encodedBody: Uint8Array<ArrayBuffer> | undefined;
let decodedBytes = 0;
let ordinaryEncodedBody: Uint8Array<ArrayBuffer> | undefined;

function encode(body: unknown): { zstd: Uint8Array<ArrayBuffer>; decoded: number } {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  return { zstd: new Uint8Array(Bun.zstdCompressSync(raw)), decoded: raw.byteLength };
}

beforeAll(() => {
  const input: unknown[] = [];
  for (let index = 0; index < IMAGE_PAIRS; index += 1) {
    const callId = `call_view_image_${index}`;
    input.push({ type: "function_call", call_id: callId, name: "view_image", arguments: JSON.stringify({ path: `/tmp/shot-${index}.png` }) });
    input.push({
      type: "function_call_output",
      call_id: callId,
      output: [{ type: "input_image", image_url: `data:image/png;base64,${randomBytes(IMAGE_BYTES).toString("base64")}` }],
    });
  }
  input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "Continue with the next screenshot." }] });

  const ordinary = encode({ model: "chatgpt-web/high", stream: false, input });
  ordinaryEncodedBody = ordinary.zstd;
  decodedBytes = ordinary.decoded;
  // The v2 trigger is a few bytes; compress it separately so the body stays a valid zstd frame.
  encodedBody = encode({ model: "chatgpt-web/high", stream: false, input: [...input, { type: "compaction_trigger" }] }).zstd;

  expect(ordinaryEncodedBody.byteLength).toBeGreaterThan(64 * MiB);
  expect(encodedBody.byteLength).toBeGreaterThan(64 * MiB);
  expect(decodedBytes).toBeLessThan(128 * MiB);
}, 60_000);

afterAll(() => {
  encodedBody = undefined;
  ordinaryEncodedBody = undefined;
});

function recordingAdapterFactory(seen: CodexMessage[][], factoryCalls: CodexProviderConfig[] = []) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    factoryCalls.push(provider);
    return {
      name: "test-web-compactor",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        seen.push(parsed.context.messages);
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

function post(path: string, body: Uint8Array<ArrayBuffer>): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd", "content-length": String(body.byteLength) },
    body,
  });
}

function imageToolResults(messages: CodexMessage[]) {
  return messages.filter((message) =>
    message.role === "toolResult"
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === "image"));
}

test("v2 compaction of a >64 MiB zstd image history succeeds on /responses", async () => {
  const seen: CodexMessage[][] = [];
  const response = await responseRequest(
    post("/v1/responses", encodedBody!),
    defaultConfig("full"),
    recordingAdapterFactory(seen),
    { rememberState: false },
  );
  expect(response.status).toBe(200);
  const result = await response.json() as { output: Array<{ type: string }> };
  expect(result.output.filter((item) => item.type === "compaction")).toHaveLength(1);
  expect(seen).toHaveLength(1);
  expect(imageToolResults(seen[0]!)).toHaveLength(IMAGE_PAIRS);
}, 60_000);

test("v1 /compact of the same history succeeds and the replacement history is small", async () => {
  const seen: CodexMessage[][] = [];
  const response = await compactRequest(
    post("/v1/responses/compact", ordinaryEncodedBody!),
    defaultConfig("full"),
    recordingAdapterFactory(seen),
  );
  expect(response.status).toBe(200);
  const result = await response.json() as { output: Array<{ type: string }> };
  expect(JSON.stringify(result.output).length).toBeLessThan(1 * MiB);
  expect(result.output.some((item) => item.type === "function_call_output")).toBe(false);
  expect(imageToolResults(seen[0]!)).toHaveLength(IMAGE_PAIRS);
}, 60_000);

test("an ordinary oversized follow-up is still rejected", async () => {
  const factoryCalls: CodexProviderConfig[] = [];
  const response = await responseRequest(
    post("/v1/responses", ordinaryEncodedBody!),
    defaultConfig("full"),
    recordingAdapterFactory([], factoryCalls),
    { rememberState: false },
  );
  expect(response.status).toBe(400);
  const error = (await response.json() as { error: { message: string } }).error.message;
  expect(error).toBe("Encoded request body exceeds 67108864 bytes");
  expect(factoryCalls).toHaveLength(0);
}, 60_000);
