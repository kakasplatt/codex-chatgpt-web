export interface RequestBodyLimits {
  encodedBytes: number;
  decodedBytes: number;
}

export const DEFAULT_REQUEST_BODY_LIMITS: RequestBodyLimits = {
  encodedBytes: 64 * 1024 * 1024,
  decodedBytes: 128 * 1024 * 1024,
};

export type RequestBodyLimitStage = "declared" | "encoded" | "decoded";

export class RequestBodyLimitError extends Error {
  readonly stage: RequestBodyLimitStage;
  readonly limitBytes: number;
  readonly declaredBytes?: number;
  readonly encodedBytes?: number;
  readonly decodedBytes?: number;
  readonly contentEncoding: string;
  /** True when reading stopped at the limit, so `encodedBytes` is only a lower bound of the body. */
  readonly partial: boolean;

  constructor(
    stage: RequestBodyLimitStage,
    limitBytes: number,
    contentEncoding: string,
    sizes: { declaredBytes?: number; encodedBytes?: number; decodedBytes?: number; partial?: boolean } = {},
  ) {
    super(`${stage === "decoded" ? "Decoded" : "Encoded"} request body exceeds ${limitBytes} bytes`);
    this.name = "RequestBodyLimitError";
    this.stage = stage;
    this.limitBytes = limitBytes;
    this.contentEncoding = contentEncoding;
    this.partial = sizes.partial === true;
    if (sizes.declaredBytes !== undefined) this.declaredBytes = sizes.declaredBytes;
    if (sizes.encodedBytes !== undefined) this.encodedBytes = sizes.encodedBytes;
    if (sizes.decodedBytes !== undefined) this.decodedBytes = sizes.decodedBytes;
  }
}

export interface MeasuredRequestBody {
  declaredBytes?: number;
  encodedBytes: number;
  decodedBytes: number;
  contentEncoding: string;
}

export interface JsonRequestBody extends MeasuredRequestBody {
  value: unknown;
}

/**
 * Throws a {@link RequestBodyLimitError} when an already-measured body exceeds `limits`.
 * Lets a caller apply a stricter limit than the one used while reading.
 */
export function assertRequestBodyWithin(size: MeasuredRequestBody, limits: RequestBodyLimits): void {
  const sizes = {
    ...(size.declaredBytes !== undefined ? { declaredBytes: size.declaredBytes } : {}),
    encodedBytes: size.encodedBytes,
    decodedBytes: size.decodedBytes,
  };
  if (size.encodedBytes > limits.encodedBytes) {
    throw new RequestBodyLimitError("encoded", limits.encodedBytes, size.contentEncoding, sizes);
  }
  if (size.decodedBytes > limits.decodedBytes) {
    throw new RequestBodyLimitError("decoded", limits.decodedBytes, size.contentEncoding, sizes);
  }
}

export function readDeclaredLength(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  const declared = Number(header);
  return Number.isFinite(declared) ? declared : undefined;
}

/**
 * Reads the body stream, stopping as soon as it passes `limitBytes`, so a body without a usable
 * `content-length` (chunked) is never buffered past the limit. The chunks are joined once at the
 * end; a declared length is deliberately not trusted to pre-allocate, because a client could
 * declare the maximum and send nothing.
 */
async function readBytesWithin(
  request: Request,
  limitBytes: number,
  declaredBytes: number | undefined,
  contentEncoding: string,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        throw new RequestBodyLimitError("encoded", limitBytes, contentEncoding, {
          ...(declaredBytes !== undefined ? { declaredBytes } : {}),
          encodedBytes: total,
          partial: true,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (chunks.length === 1) return chunks[0]!;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Returns a copy of `request` whose body errors with a {@link RequestBodyLimitError} once more than
 * `limitBytes` have been read. For routes that buffer the body themselves: a body without a
 * `content-length` is cut off at the limit instead of growing without bound.
 */
export function limitRequestBodyStream(request: Request, limitBytes: number, onExceeded?: (readBytes: number) => void): Request {
  if (!request.body) return request;
  let seen = 0;
  const limited = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limitBytes) {
        onExceeded?.(seen);
        controller.error(new RequestBodyLimitError("encoded", limitBytes, "identity", { encodedBytes: seen, partial: true }));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: request.headers,
    body: limited,
    signal: request.signal,
    duplex: "half",
  };
  return new Request(request.url, init);
}

export async function readJsonRequestBodyWithSize(
  request: Request,
  limits: RequestBodyLimits = DEFAULT_REQUEST_BODY_LIMITS,
): Promise<JsonRequestBody> {
  const contentEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase() || "identity";

  const declaredBytes = readDeclaredLength(request);
  if (declaredBytes !== undefined && declaredBytes > limits.encodedBytes) {
    throw new RequestBodyLimitError("declared", limits.encodedBytes, contentEncoding, { declaredBytes });
  }

  const declared = declaredBytes !== undefined ? { declaredBytes } : {};
  const encoded = await readBytesWithin(request, limits.encodedBytes, declaredBytes, contentEncoding);
  const encodedBytes = encoded.byteLength;

  let decoded: Uint8Array;
  if (contentEncoding === "identity") {
    decoded = encoded;
  } else if (contentEncoding === "zstd") {
    decoded = await Bun.zstdDecompress(encoded);
  } else {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  const decodedBytes = decoded.byteLength;
  if (decodedBytes > limits.decodedBytes) {
    throw new RequestBodyLimitError("decoded", limits.decodedBytes, contentEncoding, {
      ...declared,
      encodedBytes,
      decodedBytes,
    });
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return {
    value: JSON.parse(text) as unknown,
    ...declared,
    encodedBytes,
    decodedBytes,
    contentEncoding,
  };
}

export async function readJsonRequestBody(
  request: Request,
  limits: RequestBodyLimits = DEFAULT_REQUEST_BODY_LIMITS,
): Promise<unknown> {
  return (await readJsonRequestBodyWithSize(request, limits)).value;
}
