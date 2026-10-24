import { expect, test } from "bun:test";
import {
  RequestBodyLimitError,
  assertRequestBodyWithin,
  limitRequestBodyStream,
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
  const make = () => {
    // Streaming request bodies need `duplex`. Typing the init (instead of `@ts-expect-error`)
    // keeps this compiling whether or not `@types/bun` starts declaring the property.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
      duplex: "half",
    };
    return new Request("http://127.0.0.1/v1/responses", init);
  };
  const error = await readJsonRequestBodyWithSize(make(), small).catch((e) => e);
  expect(error).toBeInstanceOf(RequestBodyLimitError);
  expect(error).toMatchObject({ stage: "declared", declaredBytes: 100, limitBytes: 64 });
  expect(error.message).toBe("Encoded request body exceeds 64 bytes");

  const ok = await readJsonRequestBodyWithSize(make(), { encodedBytes: 1024, decodedBytes: 1024 });
  expect(ok.value).toEqual({});
  expect(ok.declaredBytes).toBe(100);
});

test("assertRequestBodyWithin keeps every measured size on the error, including the declared length", () => {
  const measured = { declaredBytes: 90, encodedBytes: 100, decodedBytes: 100, contentEncoding: "identity" };
  const encoded = (() => {
    try { assertRequestBodyWithin(measured, small); } catch (error) { return error; }
  })();
  expect(encoded).toBeInstanceOf(RequestBodyLimitError);
  expect(encoded).toMatchObject({ stage: "encoded", limitBytes: 64, declaredBytes: 90, encodedBytes: 100, decodedBytes: 100 });

  const decoded = (() => {
    try { assertRequestBodyWithin({ ...measured, encodedBytes: 10, decodedBytes: 200, contentEncoding: "zstd" }, small); } catch (error) { return error; }
  })();
  expect(decoded).toMatchObject({ stage: "decoded", limitBytes: 128, declaredBytes: 90, encodedBytes: 10, decodedBytes: 200 });

  const undeclared = (() => {
    try { assertRequestBodyWithin({ encodedBytes: 100, decodedBytes: 100, contentEncoding: "identity" }, small); } catch (error) { return error; }
  })();
  expect((undeclared as RequestBodyLimitError).declaredBytes).toBeUndefined();
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

/** A request with no `content-length`, like a chunked upload, delivered in the given chunks. */
function chunkedRequest(chunks: Uint8Array[], hooks: { onPull?: () => void; onCancel?: () => void } = {}): Request {
  let index = 0;
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        hooks.onPull?.();
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else controller.close();
      },
      cancel() { hooks.onCancel?.(); },
    }),
    duplex: "half",
  };
  return new Request("http://127.0.0.1/v1/responses", init);
}

test("a chunked body is joined across chunks and keeps its content", async () => {
  const text = JSON.stringify({ message: "x".repeat(100) });
  const bytes = new TextEncoder().encode(text);
  const result = await readJsonRequestBodyWithSize(
    chunkedRequest([bytes.subarray(0, 30), bytes.subarray(30, 60), bytes.subarray(60)]),
    { encodedBytes: 1024, decodedBytes: 1024 },
  );
  expect(result.value).toEqual({ message: "x".repeat(100) });
  expect(result.encodedBytes).toBe(bytes.byteLength);
  expect(result.declaredBytes).toBeUndefined();
});

test("a chunked body is cut off at the encoded limit without reading the rest", async () => {
  let pulled = 0;
  let cancelled = false;
  const request = chunkedRequest(
    Array.from({ length: 100 }, () => new Uint8Array(10)),
    { onPull: () => { pulled += 1; }, onCancel: () => { cancelled = true; } },
  );
  const error = await readJsonRequestBodyWithSize(request, { encodedBytes: 64, decodedBytes: 128 }).catch(e => e);
  // The source is only pulled a few chunks ahead of the reader, nowhere near all 100.
  expect(pulled).toBeLessThan(20);
  expect(error).toBeInstanceOf(RequestBodyLimitError);
  expect(error).toMatchObject({ stage: "encoded", limitBytes: 64, partial: true, contentEncoding: "identity" });
  // Stopped on the chunk that crossed the limit, so the size is a lower bound well below the 1000 sent.
  expect(error.encodedBytes).toBeGreaterThan(64);
  expect(error.encodedBytes).toBeLessThan(1000);
  expect(cancelled).toBe(true);
  expect(error.message).toBe("Encoded request body exceeds 64 bytes");
});

test("a body with a declared length keeps partial false when the declared check rejects it", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-length": "100" }, body: "{}",
  });
  const error = await readJsonRequestBodyWithSize(request, small).catch(e => e);
  expect(error).toMatchObject({ stage: "declared", declaredBytes: 100, partial: false });
});

test("limitRequestBodyStream passes a body within the limit and errors one above it", async () => {
  const within = limitRequestBodyStream(chunkedRequest([new Uint8Array(50), new Uint8Array(50)]), 100);
  expect((await within.arrayBuffer()).byteLength).toBe(100);

  let exceeded: number | undefined;
  const above = limitRequestBodyStream(
    chunkedRequest([new Uint8Array(50), new Uint8Array(51)]),
    100,
    readBytes => { exceeded = readBytes; },
  );
  const error = await above.arrayBuffer().catch(e => e);
  expect(error).toBeInstanceOf(RequestBodyLimitError);
  expect(exceeded).toBe(101);
});

test("limitRequestBodyStream keeps the method, headers and a bodyless request", () => {
  const request = new Request("http://127.0.0.1/admin/x", { method: "POST", headers: { authorization: "Bearer t" } });
  expect(limitRequestBodyStream(request, 10)).toBe(request);
  const limited = limitRequestBodyStream(chunkedRequest([new Uint8Array(1)]), 10);
  expect(limited.method).toBe("POST");
  expect(limited.headers.get("content-type")).toBe("application/json");
});
