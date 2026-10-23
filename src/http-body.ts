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

  constructor(
    stage: RequestBodyLimitStage,
    limitBytes: number,
    contentEncoding: string,
    sizes: { declaredBytes?: number; encodedBytes?: number; decodedBytes?: number } = {},
  ) {
    super(`${stage === "decoded" ? "Decoded" : "Encoded"} request body exceeds ${limitBytes} bytes`);
    this.name = "RequestBodyLimitError";
    this.stage = stage;
    this.limitBytes = limitBytes;
    this.contentEncoding = contentEncoding;
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

function readDeclaredLength(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  const declared = Number(header);
  return Number.isFinite(declared) ? declared : undefined;
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

  const encoded = new Uint8Array(await request.arrayBuffer());
  const encodedBytes = encoded.byteLength;
  const declared = declaredBytes !== undefined ? { declaredBytes } : {};
  if (encodedBytes > limits.encodedBytes) {
    throw new RequestBodyLimitError("encoded", limits.encodedBytes, contentEncoding, { ...declared, encodedBytes });
  }

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
