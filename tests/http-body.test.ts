import { expect, test } from "bun:test";
import {
  RequestBodyLimitError,
  assertRequestBodyWithin,
  readJsonRequestBody,
  readJsonRequestBodyWithSize,
} from "../src/http-body";

test("decodes Codex zstd-compressed JSON request bodies", async () => {
  const body = { model: "chatgpt-web/pro", reasoning: { effort: "ultra" }, input: [{ role: "user", content: "hello" }] };
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(encoded).set(compressed);
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: encoded,
  });

  expect(await readJsonRequestBody(request)).toEqual(body);
});

test("rejects unsupported request content encodings", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "br" },
    body: "{}",
  });

  await expect(readJsonRequestBody(request)).rejects.toThrow("Unsupported Content-Encoding: br");
});

const small = { encodedBytes: 64, decodedBytes: 128 };

function identityRequest(text: string): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
  });
}

function zstdRequest(body: unknown): Request {
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(encoded).set(compressed);
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: encoded,
  });
}

test("reports encoded and decoded sizes for a zstd body", async () => {
  const r = await readJsonRequestBodyWithSize(zstdRequest({ a: "x".repeat(500) }), {
    encodedBytes: 1024,
    decodedBytes: 1024,
  });
  expect(r.contentEncoding).toBe("zstd");
  expect(r.decodedBytes).toBe(JSON.stringify({ a: "x".repeat(500) }).length);
  expect(r.encodedBytes).toBeLessThan(r.decodedBytes);
});

test("encoded limit raises RequestBodyLimitError with the unchanged message", async () => {
  const error = await readJsonRequestBodyWithSize(identityRequest("x".repeat(200)), small).catch((e) => e);
  expect(error).toBeInstanceOf(RequestBodyLimitError);
  expect(error).toMatchObject({
    stage: "encoded",
    limitBytes: 64,
    encodedBytes: expect.any(Number),
    contentEncoding: "identity",
  });
  expect(error.message).toBe("Encoded request body exceeds 64 bytes");
});

test("decoded limit raises stage decoded with both sizes", async () => {
  const error = await readJsonRequestBodyWithSize(zstdRequest({ a: "x".repeat(1000) }), {
    encodedBytes: 1024,
    decodedBytes: 128,
  }).catch((e) => e);
  expect(error).toBeInstanceOf(RequestBodyLimitError);
  expect(error.stage).toBe("decoded");
  expect(error.limitBytes).toBe(128);
  expect(error.encodedBytes).toBeLessThan(1024);
  expect(error.decodedBytes).toBeGreaterThan(128);
  expect(error.contentEncoding).toBe("zstd");
  expect(error.message).toBe("Decoded request body exceeds 128 bytes");
});

test("declared length is checked against the supplied limits", async () => {
  const make = () =>
    new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
      // @ts-expect-error Bun/undici streaming request bodies need duplex.
      duplex: "half",
    });
  const error = await readJsonRequestBodyWithSize(make(), small).catch((e) => e);
  expect(error).toBeInstanceOf(RequestBodyLimitError);
  expect(error).toMatchObject({ stage: "declared", declaredBytes: 100, limitBytes: 64 });
  expect(error.message).toBe("Encoded request body exceeds 64 bytes");

  const ok = await readJsonRequestBodyWithSize(make(), { encodedBytes: 1024, decodedBytes: 1024 });
  expect(ok.value).toEqual({});
  expect(ok.declaredBytes).toBe(100);
});

test("assertRequestBodyWithin enforces a stricter limit after reading", () => {
  expect(() =>
    assertRequestBodyWithin({ encodedBytes: 100, decodedBytes: 100, contentEncoding: "identity" }, small),
  ).toThrow(RequestBodyLimitError);
  expect(() =>
    assertRequestBodyWithin({ encodedBytes: 10, decodedBytes: 200, contentEncoding: "zstd" }, small),
  ).toThrow("Decoded request body exceeds 128 bytes");
  expect(() =>
    assertRequestBodyWithin({ encodedBytes: 10, decodedBytes: 100, contentEncoding: "zstd" }, small),
  ).not.toThrow();
});
