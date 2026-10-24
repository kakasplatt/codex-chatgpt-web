# Issue #66: Oversized Image-Heavy Request Bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A thread whose history has grown past the 64 MiB local request limit stays recoverable through compaction. Every body rejection is logged with sizes only and returns an actionable message. A rejected follow-up ends its browser turn at once with a distinct failure code. Byte growth causes compaction before the limit is reached.

**Architecture:** Requests are read under one bounded hard ceiling. After parsing, a size policy applies a per-request limit: Web-model compaction bodies may use the whole ceiling, and every other body keeps today's 64/128 MiB limit. `responseRequest` is split into "read body" and "handle the parsed body", so `/responses/compact` stops re-serializing and re-reading its body. Attribution maps a rejected request's native turn identity to its active browser trace, then revokes the broker channel with a new failure variant. Prevention passes the measured body size to the adapter. Above a soft threshold, the adapter reports usage at the route's context window, which triggers the auto-compaction Codex already performs.

**Tech Stack:** TypeScript, Bun (`bun test`, `Bun.zstdDecompress`, `tsc --noEmit`), no new dependencies.

**Spec:** https://github.com/kakasplatt/codex-chatgpt-web/issues/66 (four work items: recovery, logging, attribution, prevention). Each phase below is one PR that references #66, merged in order.

## Findings that change the issue's assumptions (verified in source)

1. **Codex compacts routed models through `POST /v1/responses`, not only `/v1/responses/compact`.**
   - Remote compaction v2 sends a normal `/responses` request whose input ends with `{"type":"compaction_trigger"}` (`src/responses/compaction.ts:3-18`, `src/responses/parser.ts:305-321`, test `tests/server-compaction.test.ts:478`). `server.ts` calls this format "the default".
   - Native text compaction (`responses/memento`) also uses `/responses`, flagged by `request_kind: "compaction"` in `x-codex-turn-metadata` (`src/responses/compaction.ts:23-38`, `parser.ts:637-646`).
   - `/responses/compact` (v1) is a third path, used by the DEV driver (`src/dev-chat/driver.ts:640`).
   - **Consequence:** raising the limit only on the compact route would not have rescued the incident. A compaction body on `/responses` can only be recognized after it is parsed, so both routes must read up to a larger ceiling and then apply the per-request limit.
2. `compactRequest` (`src/server.ts:854-969`) builds an internal `Request` (L920-927) and calls `responseRequest`, which reads the body a second time.
   - The internal request inherits `content-encoding: zstd` and a stale `content-length` from the outer headers. A zstd `/compact` body therefore fails with `Decompression failed` (a latent bug; no evidence yet that Codex zstd-encodes `/compact`).
   - The internal body is identity JSON, so a history over 64 MiB raw is rejected even when the outer compressed body was accepted.
3. Image tool outputs already reach the prompt as attachment references, never as text.
   - `function_call_output`/`custom_tool_call_output` `input_image` items become image parts (`parser.ts:236-255`).
   - The compiler keeps the newest `CHATGPT_MAX_INPUT_IMAGES = 10` and replaces older ones with `DROPPED_IMAGE_NOTE` (`prompt.ts:202, 219-250, 692-699`). This is covered by `tests/prompt-contract.test.ts:625`.
   - `image_generation_call` items are not parsed at all.
   - **Decision:** do not strip image payloads after parsing (YAGNI). The compaction prompt is already independent of image bytes.
4. `classifyError` (`src/lib/errors.ts:76-98`) infers the error code from message text. A message containing "context window", "context length", "maximum context" or "too many tokens" becomes `context_length_exceeded`, and "rate limit" or "quota" are also remapped. The actionable message must avoid these phrases.
5. A pinned Bun is already present in this worktree: `.tools/bun-1.4.0/bun.exe`. `package.json` pins `bun@1.4.0`, and the local `bun` on PATH is 1.4.3.
6. `startServer`'s `Bun.serve` (`server.ts:1011`) sets no `maxRequestBodySize`. Probed with the pinned Bun 1.4.0: a 127 MiB POST reaches the handler, while a 129 MiB POST gets "socket connection was closed" and the handler never runs. The default cap is therefore 128 MiB.
   - The 64.3 MiB incident body was under this cap.
   - Any ceiling of 128 MiB or more needs an explicit `maxRequestBodySize`. Otherwise over-ceiling bodies are dropped without a log line or a 400, and Codex sees a transport error.

## Global Constraints

- Make the smallest safe change, with no new dependencies and no unrelated refactors. Keep `readJsonRequestBody(request)` source-compatible for its other callers (`src/native-passthrough.ts:237`, `scripts/smoke-codex-environment.ts:101`).
- Standard limits are unchanged: `encodedBytes = 64 * 1024 * 1024` and `decodedBytes = 128 * 1024 * 1024`.
- Compaction ceiling: `encodedBytes = 128 * 1024 * 1024` and `decodedBytes = 256 * 1024 * 1024`.
  - Why this is enough: once a request is rejected, a thread stops growing except for the one tool batch that was rejected. A stuck thread is therefore at most 64/128 MiB plus one batch. The incident body was 64.3 MiB zstd and 119.6 MiB raw.
  - Why not larger: peak memory is roughly encoded + clone + decoded + string + parsed tree, about 1 GB at this ceiling.
- `Bun.serve` `maxRequestBodySize = 2 * 128 MiB = 256 MiB` (finding 6). Bodies above the ceiling but no larger than this get a logged 400.
- Native (non-Web) models keep the standard limits on both routes, including native compaction. Their bodies are forwarded upstream unchanged.
- Never log body content. Log lines may contain the route, stage, byte counts, limits, content encoding, image count and image bytes, trace ids, HTTP status and reason codes. Never log `error.message` from JSON/UTF-8/zstd decoding, because JSON parse messages can quote body text.
- Actionable messages keep `type: "invalid_request_error"`, and `classifyError` must leave the code as `invalid_request_error` (finding 4).
- New broker failure code: `codex_request_rejected`. The existing `codex_tool_timeout` payload and its behavior are unchanged.
- Prevention thresholds: soft encoded `48 MiB` (64 − 16) and soft decoded `96 MiB` (128 − 32).
  - Headroom per incident data: one 2.64 MiB `view_image` result added 3.6 MiB raw and 2.7 MiB zstd.
  - 16 MiB of encoded headroom covers about 5 such results in one batch; 32 MiB of decoded headroom covers about 8.
- Size-log floor: per-request size lines are written only when `encodedBytes >= 8 MiB` or `decodedBytes >= 8 MiB`.
- Tests: focused `bun test <file>`.
  - Limit-matrix tests inject small limits through `ResponseRequestOptions.requestSizeLimits`.
  - Exactly one real-size test file uses a synthetic image history of about 90 MiB raw and 67 MiB zstd. Measured with Bun 1.4.3: generation 95 ms, compression 79 ms, decompression 102 ms, RSS 660 MiB.
- Verification gate per PR:
  - Run `.tools/bun-1.4.0/bun.exe run verify`, which uses the pinned Bun.
  - If `.tools/bun-1.4.0` is missing, run `typecheck`, `test`, `launcher:typecheck`, `launcher:test`, `launcher:build`, `audit` and `launcher:audit` individually with the local Bun. Report `check-version`, the runtime bundle build and the release smoke as **not run**.
  - Known environmental Windows failures:
    - symlink `EPERM` in `tests/codex-integration.test.ts` and `launcher/tests/runtime-host.test.cjs`;
    - execution-policy failure in `launcher/tests/windows-installer.test.cjs`.

    Re-run them on the base commit before calling any of them a regression.
- Behavior that needs an authenticated ChatGPT session cannot be proven by automated tests (`docs/release-validation.md`). This covers real Codex compaction of an oversized thread, the message as Codex renders it, live attribution, and live auto-compaction. Each PR must say so explicitly.
- Model routing follows `docs/superpowers/model-selection.md`: implementation workers use Sonnet 5.5/high. Escalate Phase 3 Task 9 (cancellation/ownership) to Opus 5.5/high. The final whole-branch review per PR uses Opus 5.5/high.

## Review Focus

1. **A body above Bun's default 128 MiB `maxRequestBodySize`.** Today Bun closes the socket and nothing is logged. It must get a logged HTTP 400. Unit tests that call `responseRequest` directly cannot see this. Task 3 (`server: a 129 MiB body gets an HTTP 400 instead of a closed socket`).
2. **Declared `content-length` between 64 MiB and the ceiling on a v2 compaction `/responses` request.** The pre-read check must not reject it, so the declared check must use the ceiling. Task 1 (`declared length is checked against the supplied limits`) and Task 3 (`responses: web v2 compaction between limits is accepted`, which sends an explicit content-length).
3. **A v2 compaction where `compaction_trigger` is not the last input item**, for example when it is followed by a responses_lite `additional_tools` item. It must still get the compaction limits. Task 2 (`trigger followed by additional_tools still selects the compaction limits`).
4. **Actionable message text that trips `classifyError`.** Codex must still receive `code: "invalid_request_error"`. Task 5 (`actionable messages keep the invalid_request_error code`).
5. **Byte pressure on Luna without Bigger Context, where compaction is refused by design (409).** Raised usage would make Codex request compactions that can only fail, and attribution would then kill the turn. Usage must stay unchanged, and the Luna 409 is not an attribution site. Task 13 (`Luna under byte pressure reports unchanged usage`) and Task 9 (reporting-site list).

Also covered by task tests, but outside the top five:
- body text in logs (Task 6);
- a rejection for a turn without delivered calls (Task 8);
- ordinary bodies between 64 MiB and the ceiling (Task 4).

---

## Phase 1 — Recovery (PR 1)

### Task 1: Configurable limits, measured sizes and a typed limit error in `http-body.ts`

**Files:**
- Modify: `src/http-body.ts:1-31`
- Test: `tests/http-body.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RequestBodyLimits { encodedBytes: number; decodedBytes: number }
  export const DEFAULT_REQUEST_BODY_LIMITS: RequestBodyLimits; // 64 MiB / 128 MiB
  export type RequestBodyLimitStage = "declared" | "encoded" | "decoded";
  export class RequestBodyLimitError extends Error {
    readonly stage: RequestBodyLimitStage;
    readonly limitBytes: number;
    readonly declaredBytes?: number;
    readonly encodedBytes?: number;
    readonly decodedBytes?: number;
    readonly contentEncoding: string; // normalized, "identity" when absent
  }
  export interface MeasuredRequestBody {
    declaredBytes?: number; encodedBytes: number; decodedBytes: number; contentEncoding: string;
  }
  export interface JsonRequestBody extends MeasuredRequestBody { value: unknown }
  export async function readJsonRequestBodyWithSize(request: Request, limits?: RequestBodyLimits): Promise<JsonRequestBody>;
  export async function readJsonRequestBody(request: Request, limits?: RequestBodyLimits): Promise<unknown>; // = (await readJsonRequestBodyWithSize(...)).value
  export function assertRequestBodyWithin(size: MeasuredRequestBody, limits: RequestBodyLimits): void; // throws RequestBodyLimitError, stage "encoded" | "decoded"
  ```
- `RequestBodyLimitError.message` stays byte-identical to today: `` `${"Encoded" | "Decoded"} request body exceeds ${limit} bytes` ``. The `declared` stage uses the "Encoded" text.
- Errors that are not about limits (unsupported encoding, zstd failure, UTF-8, JSON) keep their current types and messages.

- [ ] **Step 1: Write the failing tests** in `tests/http-body.test.ts`, keeping the two existing tests.

```ts
const small = { encodedBytes: 64, decodedBytes: 128 };
test("reports encoded and decoded sizes for a zstd body", async () => {
  const r = await readJsonRequestBodyWithSize(zstdRequest({ a: "x".repeat(500) }), { encodedBytes: 1024, decodedBytes: 1024 });
  expect(r.contentEncoding).toBe("zstd");
  expect(r.decodedBytes).toBe(JSON.stringify({ a: "x".repeat(500) }).length);
  expect(r.encodedBytes).toBeLessThan(r.decodedBytes);
});
test("encoded limit raises RequestBodyLimitError with the unchanged message", async () => {
  const error = await readJsonRequestBodyWithSize(identityRequest("x".repeat(200)), small).catch(e => e);
  expect(error).toBeInstanceOf(RequestBodyLimitError);
  expect(error).toMatchObject({ stage: "encoded", limitBytes: 64, encodedBytes: expect.any(Number), contentEncoding: "identity" });
  expect(error.message).toBe("Encoded request body exceeds 64 bytes");
});
test("decoded limit raises stage decoded with both sizes", async () => { /* zstd of 1000 'x' chars, limits {1024, 128} */
  // expect stage "decoded", encodedBytes < 1024, decodedBytes > 128, message "Decoded request body exceeds 128 bytes"
});
test("declared length is checked against the supplied limits", async () => {
  // Request with header content-length: "100" and limits {64, 128} -> stage "declared", declaredBytes 100.
  // Same header with limits {1024, 1024} must NOT throw at the declared stage.
  // If Bun rewrites content-length for a fixed body, use a ReadableStream body so the header is kept.
});
test("assertRequestBodyWithin enforces a stricter limit after reading", () => {
  expect(() => assertRequestBodyWithin({ encodedBytes: 100, decodedBytes: 100, contentEncoding: "identity" }, small))
    .toThrow(RequestBodyLimitError);
});
```

- [ ] **Step 2: Run** `bun test tests/http-body.test.ts`. Expected: FAIL, because `readJsonRequestBodyWithSize` and `RequestBodyLimitError` are not exported.
- [ ] **Step 3: Implement** the interfaces above in `src/http-body.ts`. Keep the check order: declared, then encoded, then encoding, then decoded.
- [ ] **Step 4: Run** `bun test tests/http-body.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(http-body): configurable request limits with measured sizes (#66)`.

### Task 2: Request size policy (compaction detection and limit selection)

**Files:**
- Create: `src/request-size-policy.ts`
- Test: `tests/request-size-policy.test.ts`
- `src/native-passthrough.ts:243` stays unchanged. Its tail-only heuristic affects only native models, which get the standard limits in either case.

**Interfaces:**
- Consumes: `RequestBodyLimits` and `DEFAULT_REQUEST_BODY_LIMITS` (Task 1); `isNativeTextCompaction` (`src/responses/compaction.ts:23`).
- Produces:
  ```ts
  export const COMPACTION_REQUEST_BODY_LIMITS: RequestBodyLimits; // 128 MiB / 256 MiB
  export interface RequestSizeLimits { standard: RequestBodyLimits; compaction: RequestBodyLimits }
  export const REQUEST_SIZE_LIMITS: RequestSizeLimits;
  export type RequestRoute = "responses" | "compact";
  export function hasCompactionTrigger(raw: unknown): boolean;
  // any raw.input item with type "compaction_trigger": matches parser.ts:320, which flags it at any position
  // (responses_lite can place an `additional_tools` item in input, parser.ts:325)
  export function isCompactionRequestBody(raw: unknown, route: RequestRoute): boolean;
  // route "compact" -> true; "responses" -> hasCompactionTrigger(raw) || isNativeTextCompaction(raw).
  // If isNativeTextCompaction throws (unsupported protocol) -> true, so parseRequest reports the protocol error, not a size error.
  export function requestBodyLimitsFor(
    input: { route: RequestRoute; raw: unknown; webModel: boolean },
    limits?: RequestSizeLimits,
  ): RequestBodyLimits; // webModel && isCompactionRequestBody -> limits.compaction, else limits.standard
  ```

- [ ] **Step 1: Write the failing tests.**

```ts
test("v2 trigger tail on /responses selects the compaction limits for a Web model", () => {
  expect(requestBodyLimitsFor({ route: "responses", raw: { input: [{ type: "message" }, { type: "compaction_trigger" }] }, webModel: true }))
    .toEqual(COMPACTION_REQUEST_BODY_LIMITS);
});
test("memento metadata on /responses selects the compaction limits", () => { /* client_metadata x-codex-turn-metadata request_kind compaction, strategy memento */ });
test("unsupported memento protocol still selects the compaction limits", () => { /* strategy "other" -> COMPACTION_REQUEST_BODY_LIMITS */ });
test("/compact always selects the compaction limits for a Web model", () => { /* raw {} */ });
test("ordinary Web bodies and every native body keep the standard limits", () => {
  // responses without trigger, webModel true -> DEFAULT; compact + trigger with webModel false -> DEFAULT
});
test("trigger followed by additional_tools still selects the compaction limits", () => {
  // input [{message}, {compaction_trigger}, {type: "additional_tools", role: "developer", tools: []}] -> COMPACTION_REQUEST_BODY_LIMITS
});
```

- [ ] **Step 2: Run** `bun test tests/request-size-policy.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/request-size-policy.ts`.
- [ ] **Step 4: Run** `bun test tests/request-size-policy.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): request size policy for compaction bodies (#66)`.

### Task 3: Split `responseRequest` and apply the policy on both routes

**Files:**
- Modify: `src/server.ts:359-366` (`ResponseRequestOptions`), `src/server.ts:617-841` (`responseRequest`), `src/server.ts:854-969` (`compactRequest`) and `src/server.ts:1011` (`Bun.serve` options).
- Modify: `src/request-size-policy.ts`, adding `SERVER_MAX_REQUEST_BODY_BYTES`.
- Test: `tests/server-request-limits.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`readJsonRequestBodyWithSize`, `assertRequestBodyWithin`, `RequestBodyLimitError`); Task 2 (`requestBodyLimitsFor`, `REQUEST_SIZE_LIMITS`, `RequestSizeLimits`).
- Produces:
  - `ResponseRequestOptions.requestSizeLimits?: RequestSizeLimits`, used by tests only and defaulting to `REQUEST_SIZE_LIMITS`.
  - `compactRequest`'s options type becomes `Pick<ResponseRequestOptions, "onTurnIdentity" | "requestSizeLimits">`.
  - Internal (not exported):
    ```ts
    interface ResponseBodyContext { headers: Headers; signal: AbortSignal; nativeRequest: Request }
    async function handleResponseBody(raw: unknown, context: ResponseBodyContext, config: AppConfig,
      adapterFactory: ChatGptWebAdapterFactory, options: ResponseRequestOptions): Promise<Response>
    ```
    `handleResponseBody` contains everything that `responseRequest` does today from `const requestedModel` (L634) to the end. Replace `req.headers` with `context.headers` (L789), `req.signal` with `context.signal` (L785-786), and `nativeRequest` with `context.nativeRequest`. The ChatGPT Web adapter does not read `incoming.headers`; it only forwards them.
- `responseRequest` becomes: `clone → readJsonRequestBodyWithSize(req, limits.compaction)`.
  - On a read failure: keep the current 400 response.
  - Otherwise compute `webModel` exactly as the existing branch does: `!(typeof model === "string" && !isChatGptWebModelSlug(model))`.
  - Then `assertRequestBodyWithin(size, requestBodyLimitsFor({ route: "responses", raw, webModel }, limits))`. On `RequestBodyLimitError`, return `formatErrorResponse(400, "invalid_request_error", error.message)`.
  - Then call `handleResponseBody(raw, { headers: req.headers, signal: req.signal, nativeRequest }, ...)`.
- `compactRequest`:
  - Read with `limits.compaction`, keeping the L862-872 object check.
  - Keep the header merge, identity and model check.
  - On the native branch, run `assertRequestBodyWithin(size, limits.standard)` before forwarding.
  - Keep the Web route and Luna checks.
  - Replace L919-928 (the internal `Request` and the `responseRequest` call) with `handleResponseBody({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }, { headers: req.headers, signal: req.signal, nativeRequest }, config, adapterFactory, options)`.
  - The rest (L929-968) is unchanged.
- `startServer`'s `Bun.serve` (L1011) currently sets no `maxRequestBodySize`, so Bun's default of 128 MiB applies. That equals the encoded ceiling, so a larger body is cut off by Bun before the handler runs (finding 6).
  - Set `maxRequestBodySize: SERVER_MAX_REQUEST_BODY_BYTES`, exported from `request-size-policy.ts` as `2 * COMPACTION_REQUEST_BODY_LIMITS.encodedBytes` (256 MiB).
  - Bodies in (128, 256] MiB then reach the handler. The declared-length check rejects them before reading, and Phase 2 logs them with an actionable 400.
  - Above 256 MiB, Bun still closes the socket. That case stays unlogged; record it in the PR as a known limit.

- [ ] **Step 1: Write the failing tests** in `tests/server-request-limits.test.ts`.
  - Inject `requestSizeLimits = { standard: { encodedBytes: 4_096, decodedBytes: 8_192 }, compaction: { encodedBytes: 32_768, decodedBytes: 65_536 } }`.
  - Pad bodies with a ~10 KB text item to land between the two limits.
  - Reuse the `compactionAdapterFactory` shape from `tests/server-compaction.test.ts:121`, copied locally and returning one summary, and `rememberState: false`.

```ts
test("responses: web v2 compaction between limits is accepted", async () => {
  // body: { model: "chatgpt-web/high", stream: false, input: [padding, { type: "compaction_trigger" }] }, explicit content-length header
  // expect status 200 and output[0].type === "compaction"
});
test("responses: web memento compaction between limits is accepted", async () => { /* request_kind compaction metadata, expect 200 */ });
test("responses: ordinary web body between limits is rejected with the standard limit", async () => {
  // expect status 400, error.message === "Encoded request body exceeds 4096 bytes", adapter factory never called
});
test("responses: native-model body between limits is rejected before forwarding", async () => {
  // model "gpt-5.6-sol" + trigger tail; expect 400 with the standard-limit message
});
test("responses: body above the compaction ceiling is rejected at read time", async () => { /* 40 KB identity -> 400 "Encoded request body exceeds 32768 bytes" */ });
test("compact: zstd-encoded web body is handled without re-reading it", async () => {
  // compactRequest with content-encoding zstd, small body -> expect 200 and output with the summary
  // (RED today: inner Request keeps content-encoding and fails "Decompression failed")
});
test("compact: identity web body between limits is accepted", async () => { /* 10 KB padding -> 200 (RED today: inner re-read hits 4096) */ });
test("compact: native-model body between limits is rejected with the standard limit", async () => { /* 400 "Encoded request body exceeds 4096 bytes" */ });
// Through startServer (copy the server setup used by tests/server-lifecycle.test.ts):
test("server: a 129 MiB body gets an HTTP 400 instead of a closed socket", async () => {
  // fetch POST /v1/responses with new Uint8Array(129 * MiB) (declared content-length); expect status 400,
  // error.message mentions 134217728 (the ceiling). RED today: fetch rejects "socket connection was closed".
}, 60_000);
```

- [ ] **Step 2: Run** `bun test tests/server-request-limits.test.ts`. Expected: FAIL. `requestSizeLimits` is ignored (TS error, or limits not applied) and the zstd compact case returns 400.
- [ ] **Step 3: Implement** the split and the policy as specified above.
- [ ] **Step 4: Run** `bun test tests/server-request-limits.test.ts tests/server-compaction.test.ts tests/compaction-v1.test.ts tests/server-predictions.test.ts tests/server-subagents.test.ts tests/native-passthrough.test.ts`. Expected: PASS. The existing compaction tests prove the refactor kept the v1 and v2 behavior.
- [ ] **Step 5: Commit** `fix(server): accept oversized Web compaction bodies on /responses and /compact (#66)`.

### Task 4: Real-size regression test for an image-heavy history

**Files:**
- Test: `tests/server-oversized-compaction.test.ts` (new)

**Interfaces:**
- Consumes: the default `REQUEST_SIZE_LIMITS` (no injection) and the Task 3 behavior.

- [ ] **Step 1: Write the tests.**
  - Build the fixture once in `beforeAll`: 34 pairs of `function_call` (`name: "view_image"`) and `function_call_output` whose `output` is `[{ type: "input_image", image_url: "data:image/png;base64," + randomBytes(2_076_180).toString("base64") }]`, followed by one user message.
  - Body: `{ model: "chatgpt-web/high", stream: false, input }`. Compress with `Bun.zstdCompressSync`.
  - Assert the fixture first: `encoded > 64 MiB && decoded < 128 MiB` (≈ 67.3 / 89.8 MiB).
  - Use a per-test timeout of `60_000`.
  - In `afterAll`, set the fixture buffers to `undefined`. `bun test ./tests` runs in one process, so the fixture must not raise the suite's peak memory.

```ts
test("v2 compaction of a >64 MiB zstd image history succeeds on /responses", async () => {
  // input + { type: "compaction_trigger" }, content-encoding zstd
  // expect 200, exactly one compaction item; the adapter saw 34 toolResult messages carrying image parts
});
test("v1 /compact of the same history succeeds and the replacement history is small", async () => {
  // expect 200; JSON.stringify(output).length < 1 * 1024 * 1024; no item has type function_call_output
});
test("an ordinary oversized follow-up is still rejected", async () => {
  // same body without trigger -> 400 "Encoded request body exceeds 67108864 bytes"; adapter never called
});
```

- [ ] **Step 2: Run** `bun test tests/server-oversized-compaction.test.ts`. Expected: PASS on the Task 3 branch. Confirm RED by running it once against `main`: the first two tests fail with 400. Record the runtime; if the file takes more than 30 s, reduce the number of images while keeping `encoded > 64 MiB`.
- [ ] **Step 3: Commit** `test(server): real-size image-heavy compaction recovery (#66)`.

**Not provable here:**
- For v2, Codex itself rebuilds the post-compaction history. That the next real Codex turn fits under 64 MiB depends on Codex's retention policy and needs a live session.
- A real Codex `/compact` on the incident thread needs an authenticated session.

**PR 1 verification:**
- Run the full gate (see Global Constraints).
- PR body: list the four compaction paths and state that native limits are unchanged.

---

## Phase 2 — Logging and actionable error (PR 2)

### Task 5: Actionable message, image measurement and one diagnostic line

**Files:**
- Modify: `src/request-size-policy.ts`
- Test: `tests/request-size-policy.test.ts`

**Interfaces:**
- Consumes: `RequestBodyLimitError` (Task 1) and `RequestRoute` (Task 2).
- Produces:
  ```ts
  export interface ImagePayloadSummary { count: number; bytes: number }
  export function measureImagePayloads(raw: unknown): ImagePayloadSummary;
  // Walks raw.input: input_image parts with a string image_url starting "data:" inside
  // function_call_output / custom_tool_call_output `output` arrays and message `content` arrays; bytes = image_url.length.
  export type RequestRejectionRemedy = "compact" | "new_task";
  export interface RequestRejectionContext { route: RequestRoute; remedy: RequestRejectionRemedy; images?: ImagePayloadSummary }
  export function formatRequestBodyRejection(error: RequestBodyLimitError, context: RequestRejectionContext): string;
  export function logRequestBodyRejection(error: RequestBodyLimitError, context: RequestRejectionContext): void;
  export function logUnreadableRequestBody(route: RequestRoute, request: Request, error: unknown): void;
  ```
- Exact message text. `MiB(x) = (x / 1048576).toFixed(1)`; the limit is printed as an integer MiB value.
  - `size` is `${MiB(encodedBytes)} MiB compressed (${MiB(decodedBytes)} MiB uncompressed)` when both are known and `contentEncoding !== "identity"`. Otherwise it is `${MiB(known)} MiB`, where `known` is `decodedBytes ?? encodedBytes ?? declaredBytes`.
  - `images` is `, mostly image tool results (${count} images, ${MiB(bytes)} MiB)` only when `images.bytes * 2 > (decodedBytes ?? encodedBytes)`, and empty otherwise.
  - Remedy `compact`: `This task's request is ${size}, over the ${limitMiB} MiB local request limit${images}. Run /compact to shrink the task history, or start a new task.`
  - Remedy `new_task`: `This task's request is ${size}, over the ${limitMiB} MiB local request limit${images}. Compaction cannot run on a request this large; start a new task to continue.`
- Log line (`console.warn`, one call):
  - Format: `[codex-chatgpt-web] request_body_rejected ${JSON.stringify({ route, stage, limitBytes, declaredBytes, encodedBytes, decodedBytes, contentEncoding, imageCount, imageBytes, remedy })}`. Undefined fields are omitted.
  - `logUnreadableRequestBody` writes `[codex-chatgpt-web] request_body_unreadable ${JSON.stringify({ route, reason: error.name, declaredBytes, contentEncoding })}`. It never includes `error.message`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("compact remedy names sizes, limit, image share and /compact", () => {
  const e = limitError({ stage: "encoded", limitBytes: 64 * MiB, encodedBytes: 67_423_000, decodedBytes: 125_400_000, contentEncoding: "zstd" });
  expect(formatRequestBodyRejection(e, { route: "responses", remedy: "compact", images: { count: 165, bytes: 123_700_000 } }))
    .toBe("This task's request is 64.3 MiB compressed (119.6 MiB uncompressed), over the 64 MiB local request limit, mostly image tool results (165 images, 118.0 MiB). Run /compact to shrink the task history, or start a new task.");
});
test("image clause is omitted when images are not the majority", () => { /* images.bytes small -> no ', mostly' */ });
test("new_task remedy does not suggest /compact as the fix", () => { /* contains "start a new task to continue", not "Run /compact" */ });
test("actionable messages keep the invalid_request_error code", () => {
  for (const remedy of ["compact", "new_task"] as const) {
    expect(classifyError(400, "invalid_request_error", formatRequestBodyRejection(e, { route: "compact", remedy })).code)
      .toBe("invalid_request_error");
  }
});
test("measureImagePayloads counts data-URL images in tool outputs and messages only", () => { /* 2 tool images + 1 user image + 1 https URL -> count 3 */ });
test("rejection log is one line with sizes only", () => { /* spyOn(console, "warn"); exactly 1 call; JSON parses; keys ⊆ allowed set */ });
```

- [ ] **Step 2: Run** `bun test tests/request-size-policy.test.ts`. Expected: FAIL (exports missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): actionable oversized-request message and size-only log (#66)`.

### Task 6: Wire logging and messages into both routes

**Files:**
- Modify: `src/server.ts`, at the `responseRequest` read and policy catch sites and the `compactRequest` read and native-policy catch sites from Task 3.
- Test: `tests/server-request-limits.test.ts`

**Interfaces:**
- Consumes: Task 5 functions.
- Remedy rule, in one helper `rejectionRemedy(error, stage: "read" | "policy", webModel: boolean): RequestRejectionRemedy`:
  - `"compact"` only for a Web-model, non-compaction body rejected by the **policy** (that is, under the compaction ceiling);
  - `"new_task"` for every read-time ceiling rejection, every native-model rejection, and any compaction body.
- `images` is passed only when the body was parsed (policy stage).
- Non-limit read errors keep their current response text and also call `logUnreadableRequestBody`.

- [ ] **Step 1: Write the failing tests.** Use the injected limits from Task 3 and `spyOn(console, "warn")`.

```ts
for (const route of ["responses", "compact"] as const) {
  test(`${route}: oversized body logs one diagnostic line and returns the actionable message`, async () => {
    // policy-stage rejection (between limits) for responses; read-stage (above ceiling) for compact
    // expect exactly one warn call starting "[codex-chatgpt-web] request_body_rejected", route matches,
    // error.message starts "This task's request is", error.code === "invalid_request_error"
  });
}
test("unreadable body logs one line without body text", async () => {
  // identity body "{\"secret\":\"SENTINEL_BODY_TEXT\"" (invalid JSON); expect 400, one request_body_unreadable line,
  // and no logged string contains "SENTINEL_BODY_TEXT"
});
test("an ordinary web body under the ceiling advises /compact; one above it advises a new task", async () => { /* message text checks */ });
```

- [ ] **Step 2: Run** `bun test tests/server-request-limits.test.ts`. Expected: the new tests FAIL. Then update the Task 3 and Task 4 assertions that pinned the old `"Encoded request body exceeds …"` text: they now assert the actionable prefix.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** `bun test tests/server-request-limits.test.ts tests/server-oversized-compaction.test.ts tests/http-body.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): log rejected request bodies on both routes (#66)`.

**PR 2 verification:**
- Run the full gate.
- Check by hand that the line reaches the safe log: runtime stdout and stderr are both captured as `runtime.<name>_stdout` and `runtime.<name>_stderr` (`launcher/electron/runtime-supervisor.cjs:519-529`) and exported by `exportSanitizedLogs`.
- How the message looks in a live Codex UI is not provable without an authenticated session.

---

## Phase 3 — Error attribution (PR 3)

Thanks to Phase 1, every body under the ceiling is parsed, so its turn identity is read from the body (`extractCodexTurnIdentityFromBody`). Only rejections above the ceiling depend on the open header question. That case is handled in Task 10 after the Task 7 gate.

### Task 7: Gate — does real Codex send `x-codex-turn-metadata` as a header on `/responses`?

**Files:** none (record the result in the PR description).

- [ ] **Step 1: Record** `"C:\Users\kakas\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe" --version`.
- [ ] **Step 2: Capture header names.**
  - Copy the fixture pattern of `scripts/smoke-codex-environment.ts` into a scratch script **outside the repo**. Change its `/v1/responses` handler to record only `[...request.headers.keys()]` and whether `x-codex-turn-metadata` parses to `{ thread_id, turn_id }`.
  - Return one `function_call`, so that Codex sends a tool-result follow-up.
  - Run it with the installed Codex. No ChatGPT session is needed.
  - Weak prior evidence: the binary's strings place `x-codex-turn-metadata` next to the header names `x-codex-window-id` and `x-codex-parent-thread-id`.
- [ ] **Step 3: Decide.**
  - Header present on the follow-up: take Task 10A.
  - Absent: take Task 10B.
  - Inconclusive: take 10B, which does not depend on the answer.

### Task 8: Broker failure variant, adapter error and a targeted revoke

**Files:**
- Modify: `src/adapters/chatgpt-web/turn-broker.ts:14-27` (failure type and validator), `src/adapters/chatgpt-web/turn-broker.ts:687-731` (new method next to `revokeTrace`) and the `release` dispatch at `turn-broker.ts:1208-1215`.
- Modify: `src/adapters/chatgpt-web/adapter-error.ts:25-31`
- Modify: `src/adapters/chatgpt-web/index.ts:593-596`
- Test: `tests/turn-broker-diagnostics.test.ts`, `tests/chatgpt-web-harness.test.ts:4586`

**Interfaces:**
- Produces:
  ```ts
  export interface CodexToolTimeoutFailure { code: "codex_tool_timeout"; tool: string; timeoutMs: number }
  export interface CodexRequestRejectedFailure {
    code: "codex_request_rejected"; status: number; // integer 400..499
    reason: "request_body_too_large" | "invalid_request";
  }
  export type BrokerRetirementFailure = CodexToolTimeoutFailure | CodexRequestRejectedFailure;
  // assertRetirementFailure accepts both shapes (still used by RemoteTurnBroker.waitForRetirement and "release").
  // The MCP "release" path keeps accepting only codex_tool_timeout (the MCP process never sends the new code).
  TurnBroker.failTraceAwaitingResults(traceId: string, failure: CodexRequestRejectedFailure): number;
  // revokes every channel with channel.traceId === traceId && channel.deliveredCallIds.size > 0,
  // via this.revoke(token, chatGptCodexRequestRejectedError(failure), failure); returns the count.
  export function chatGptCodexRequestRejectedError(failure: CodexRequestRejectedFailure): ChatGptWebAdapterError;
  // status 400, errorType "invalid_request_error", code "codex_request_rejected", retryable false, message:
  // "Conversation interrupted: Codex's request carrying this turn's tool results was rejected (HTTP ${status}, ${reason}). The turn was stopped."
  export function chatGptRetirementError(failure: BrokerRetirementFailure): ChatGptWebAdapterError; // switch on code
  ```
- `index.ts:594-596` uses `chatGptRetirementError(failure)` instead of `chatGptToolTimeoutError(...)`.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/turn-broker-diagnostics.test.ts`, reuse `fixture()`.
    ```ts
    test("failTraceAwaitingResults settles a delivered call at once with codex_request_rejected", async () => {
      // enqueue -> nextToolBatch (delivered) -> retirement = broker.waitForRetirement(token)
      // expect(broker.failTraceAwaitingResults("diagnostic-turn", rejected)).toBe(1)
      // expect(await retirement).toEqual(rejected); expect(await outcome).toBe("rejected")
      // logs contain a broker_retired line whose failure.code === "codex_request_rejected"
    });
    test("does not revoke a channel without delivered calls", async () => { /* queued only -> returns 0, channel alive */ });
    test("release still rejects a codex_request_rejected failure from the MCP side", async () => { /* "Invalid Codex tool retirement failure" */ });
    ```
  - In `tests/chatgpt-web-harness.test.ts:4586`, extend `test.each` to `["completed", "timedOut", "rejected"]`. In the `rejected` branch, call `broker.failTraceAwaitingResults(traceId, { code: "codex_request_rejected", status: 400, reason: "request_body_too_large" })` instead of `release`. Expect the last event to be `{ type: "error", code: "codex_request_rejected" }`, with a message containing `"was rejected (HTTP 400"`.
- [ ] **Step 2: Run** `bun test tests/turn-broker-diagnostics.test.ts tests/chatgpt-web-harness.test.ts -t "retired MCP binding|failTraceAwaitingResults|without delivered"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, then `bun test tests/mcp-observation.test.ts tests/chatgpt-web-harness.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(broker): codex_request_rejected retirement failure (#66)`.

### Task 9: Attribute rejected follow-ups to the active browser trace

**Files:**
- Modify: `src/adapters/chatgpt-web/turn-execution.ts`, adding a method next to `cancelNativeTurn` at L779.
- Modify: `src/server.ts` (`ResponseRequestOptions`, the early-return sites in `responseRequest`, `handleResponseBody` and `compactRequest`, and the route wiring at L1243-1270).
- Test: `tests/server-request-limits.test.ts`, `tests/turn-broker-lifecycle.test.ts` (it already constructs `new ChatGptTurnSessions`).

**Interfaces:**
- Consumes: `TurnBroker.failTraceAwaitingResults` and `CodexRequestRejectedFailure` (Task 8).
- Produces:
  ```ts
  ChatGptTurnSessions.activeTraceIdsForNativeTurn(threadId: string, turnId: string): string[];
  // read-only: distinct traceId of entries with nativeThreadId/nativeTurnId match, isActive(), traceId defined.
  export interface CodexRequestRejection {
    identity: NativeCodexTurnIdentity; status: number; reason: CodexRequestRejectedFailure["reason"];
  }
  ResponseRequestOptions.onRequestRejected?: (rejection: CodexRequestRejection) => void;
  // compactRequest options Pick adds "onRequestRejected".
  ```
- Reporting sites: every 4xx `formatErrorResponse` returned **after the body was read and before the adapter runs**, when the identity is known from the body. In `compactRequest` the identity can also come from the `x-codex-turn-metadata` header, which is already canonical there (L873).
  - `request_body_too_large`: Phase 1 policy rejections, and on `/compact` also read-time ceiling rejections, using the header identity.
  - `invalid_request`: parse/route errors (L669; compact L911, both after identity was bound), the opaque payload (L671-677), `previous_response_id` 409 (L679-685), and the revision conflict (L762).
  - Excluded:
    - identity-extraction failures (L643; compact L895), where no identity exists;
    - Luna compaction 409 (L732; compact L914), a designed refusal rather than a rejected follow-up (Review Focus 5);
    - prediction-skip (L692); `terminalReplayResponse` (L773, L780; the turn is already terminal), and the native passthrough 502.
- Server wiring, `startServer`:
  - For each `traceId` of `chatGptTurnSessions.activeTraceIdsForNativeTurn(...)`, call `turnBroker?.failTraceAwaitingResults(traceId, { code: "codex_request_rejected", status, reason })`.
  - Log `[codex-chatgpt-web] request_rejection_attributed ${JSON.stringify({ traceIds, revokedTurns, status, reason })}`.
  - `turnBroker` exists only in `full` mode (`server.ts:983`). Tool calls exist only there as well (`config.ts:659`).
  - The admin cancel-trace route already relies on the server and adapter sharing the same `TurnBroker.forSocket` instance (`server.ts:1082`). Verify that `resolveBrokerEndpoint(config.brokerSocketPath) === config.brokerSocketPath` for `defaultConfig("full")`. If they differ, use the resolved path in `startServer`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("activeTraceIdsForNativeTurn returns active traces for the exact native turn without mutating", () => {
  // two sessions same thread, different turns; one inactive -> returns only the active matching traceId; entries unchanged
});
test("responses: oversized follow-up reports the rejection with the body identity", async () => {
  // injected limits; body with client_metadata turn metadata {thread_id, turn_id}; onRequestRejected spy
  // expect one call { identity: {threadId, turnId}, status: 400, reason: "request_body_too_large" }
});
test("compact: read-time ceiling rejection reports the header identity", async () => { /* header metadata, body above ceiling */ });
test("prediction-skip and terminal replay do not report a rejection", async () => { /* spy not called */ });
```

- [ ] **Step 2: Run** `bun test tests/server-request-limits.test.ts tests/turn-broker-lifecycle.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add a local helper in `server.ts`: `rejectRequest(status, type, message, identity | undefined, reason, options)` returns `formatErrorResponse(...)` and calls `options.onRequestRejected` when `identity` is set. Replace only the listed sites.
- [ ] **Step 4: Run** the same command plus `bun test tests/server-compaction.test.ts tests/server-lifecycle.test.ts`. Expected: PASS.
- [ ] **Step 5: End-to-end check.**
  - Add `test("a rejected follow-up ends a turn with a delivered tool call promptly")` to `tests/chatgpt-web-harness.test.ts`, reusing the setup from the L4586 test.
  - While the call is delivered, invoke the `startServer` attribution function directly. To make that possible, export it as `attributeRejectedRequest(rejection, sessions, broker)` from `src/server.ts`.
  - Expect the adapter's last event to have `code: "codex_request_rejected"` within 2 s, far below the `CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000` at `mcp-server.ts:67`.
- [ ] **Step 6: Commit** `fix(server): settle a rejected follow-up's pending tool calls immediately (#66)`.

### Task 10A (only if Task 7 finds the header): header identity for ceiling rejections on `/responses`

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-request-limits.test.ts`

**Interfaces:**
- Produces `turnIdentityFromHeaders(headers: Headers): NativeCodexTurnIdentity | undefined`. It parses the header JSON for `thread_id` and `turn_id` and returns `undefined` on any parse failure.
- `responseRequest` uses it for read-time rejections only.

- [ ] **Step 1:** Write the test `responses: read-time ceiling rejection reports the header identity`, then implement it, run `bun test tests/server-request-limits.test.ts` (PASS), and commit.

### Task 10B (if the header is absent or unknown): record unattributed ceiling rejections

**Files:**
- Modify: `src/request-size-policy.ts`
- Modify: `src/adapters/chatgpt-web/turn-broker.ts`, in the `broker_retired` log inside `revoke` at L687.
- Test: `tests/turn-broker-diagnostics.test.ts`

**Interfaces:**
- Produces `recordUnattributedRejection(route: RequestRoute, at?: number): void` and `recentUnattributedRejections(windowMs: number, now?: number): number`. This is a bounded ring of 16 timestamps.
- `revoke` adds `recentUnattributedRejections: n` to the `broker_retired` JSON when `failure?.code === "codex_tool_timeout"` and `n > 0`, using the window `failure.timeoutMs`.

- [ ] **Step 1:** Write the test `timeout retirement mentions a recent unattributed request rejection`, then implement it, run the test (PASS), and commit.

**PR 3 verification:**
- Run the full gate.
- That a live ChatGPT response ends promptly needs an authenticated session and is not provable here.

---

## Phase 4 — Prevention (PR 4)

### Task 11: Gates — prove the trigger lever before building it

**Files:** none (record the results in the PR description; stop if a gate fails).

- [ ] **G4.1: Does Codex auto-compact mid-turn on reported usage?**
  - Method: use the Task 7 fixture. Return a `function_call` whose `response.completed.usage.input_tokens` is at or above the routed model's catalog `auto_compact_token_limit` (`src/model-catalog.ts:151`). Then observe whether the next POST is a compaction (trigger tail, or `request_kind: "compaction"`) **before** the `function_call_output` follow-up.
  - Evidence so far:
    - the bridge already handles a compaction that arrives with outstanding tool results (`compaction-handoff.ts:195-250`);
    - the memento fixture shows `phase: "pre_turn"` only;
    - the DEV driver compacts at `inputTokens >= autoCompactTokenLimit` (`src/dev-chat/driver.ts:583`).
- [ ] **G4.2: Which value does Codex compare, and can user config raise it?**
  - Questions: does Codex compare input tokens or total tokens against the limit? Can `model_auto_compact_token_limit` or `model_context_window` in the user's `config.toml` push the effective limit above the route's catalog `context_window`? The bridge reads only `model_context_window` (`codex-integration-document.ts:243-250`).
  - Method: read the codex-rs source at the installed version, or use the fixture.
- [ ] **Decision:**
  - If G4.1 holds: Tasks 12 and 13 as written, with pressure tokens equal to `max(route contextWindow, readCodexModelContextOverride()?.contextWindow ?? 0)`.
  - If Codex only compacts before a turn (`pre_turn`): the soft threshold cannot bound growth inside one turn. Stop and return the evidence to the owner. Do not invent another trigger.
- [ ] **Evaluation required by the issue (no code):**
  - Replacing old image outputs in bridge-side history cannot reduce request bytes. Codex sends `store:false` and resends its own full history on every request, and the bridge does not author that history.
  - The prompt already excludes images beyond the newest 10 (finding 3).
  - Record "evaluated, no change" in the PR.

### Task 12: Server-measured body bytes reach the adapter, plus per-request size log

**Files:**
- Modify: `src/types.ts:1-25` (`CodexParsedRequest`)
- Modify: `src/server.ts` (`handleResponseBody`, after `parseRequest`)
- Modify: `src/request-size-policy.ts`
- Test: `tests/server-request-limits.test.ts`

**Interfaces:**
- Produces:
  - `CodexParsedRequest._requestBodyBytes?: { encoded: number; decoded: number }`. Only the server sets it, after `parseRequest`, and the parser never reads it from caller data.
  - `handleResponseBody` gains a `size: MeasuredRequestBody` parameter. `compactRequest` passes the outer measured size.
  - `logRequestBodySize(route, size, images)` writes `[codex-chatgpt-web] request_body_size {route, encodedBytes, decodedBytes, contentEncoding, imageCount, imageBytes}` when either byte count is `>= 8 MiB`.

- [ ] **Step 1: Write the failing tests.**
  - `size line is logged at 8 MiB and above, not below`, using a test-only floor override, or a 9 MiB random-base64 identity body.
  - `the adapter receives server-measured bytes; caller metadata cannot set them`: send `_requestBodyBytes` inside the JSON; the adapter must see the measured value.
- [ ] **Step 2: Run, implement, run (PASS), and commit** `feat(server): measure request body bytes per turn (#66)`.

### Task 13: Report compaction pressure through usage

**Files:**
- Modify: `src/adapters/chatgpt-web/usage.ts:297-326` (`estimateChatGptWebUsage`)
- Modify: `src/request-size-policy.ts`
- Test: `tests/chatgpt-web-usage.test.ts`, and `tests/chatgpt-web-harness.test.ts` for one emitted-event check.

**Interfaces:**
- Produces:
  ```ts
  export const COMPACTION_PRESSURE_BYTES: RequestBodyLimits; // { encodedBytes: 48 MiB, decodedBytes: 96 MiB }
  export function underCompactionPressure(bytes: { encoded: number; decoded: number } | undefined): boolean;
  ```
- `estimateChatGptWebUsage` returns `inputTokens = max(estimate, pressureTokens)` and recomputes `totalTokens` when all three hold:
  - `underCompactionPressure(parsed._requestBodyBytes)`;
  - `!parsed._compactionRequest`;
  - compaction is not disabled for the route. Disabled means `parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !experimentalBiggerContext`, the adapter-side form of `server.ts:732`. `CHATGPT_WEB_LUNA_MODEL_ID` is `CHATGPT_WEB_LUNA_BACKEND_MODEL` (`model.ts:7`).
- Injection point check: all five callers (`index.ts:1338, 1437, 1459, 1545, 1605`) pass the result straight to `emitBrowserCompletion` or `emitToolBatch`. No bridge-internal decision reads it. If a new consumer appears before implementation, move the bump to those emit helpers instead.

  `pressureTokens` is defined by the Task 11 decision. The route context window comes from the same `resolveChatGptWebContextLimits(...)` call form as `usage.ts:98`.
- Log `[chatgpt-web] compaction_pressure {encodedBytes, decodedBytes, estimatedInputTokens, reportedInputTokens}` once per request.
- `currentUsageInput` (`index.ts:426-433`) must keep `_requestBodyBytes` on the Luna path. Assert it in a test, or copy the field there.

- [ ] **Step 1: Write the failing tests.**
  - `usage is unchanged below the soft threshold`
  - `usage reaches the context window at 48 MiB encoded`
  - `usage reaches the context window at 96 MiB decoded with identity encoding`
  - `compaction requests never report pressure`
  - `Luna under byte pressure reports unchanged usage`. With Bigger Context enabled, Luna does report pressure.
  - `Luna usage input keeps the measured bytes`
  - Harness: `a tool batch emitted under pressure carries the raised usage`
- [ ] **Step 2: Run** `bun test tests/chatgpt-web-usage.test.ts` and confirm FAIL. Implement, run again (PASS), then run `bun test tests/token-estimate.test.ts tests/chatgpt-web-harness.test.ts`.
- [ ] **Step 3: Commit** `feat(usage): request compaction before the request byte limit (#66)`.

**PR 4 verification:**
- Run the full gate.
- Live auto-compaction on a real image-heavy thread needs an authenticated session and is not provable here.
- Side effect to state in the PR: under pressure, Codex shows the context as full until compaction runs.

---

## Self-review notes

- **Spec coverage:**
  - Recovery: Tasks 1-4.
  - Logging and actionable error: Tasks 5-6.
  - Attribution: Tasks 7-10, with an immediate distinct code and a fallback record.
  - Prevention: Tasks 11-13, covering per-request size logging, the threshold with headroom, and the image-placeholder evaluation.
  - The issue's test requests: >64 MiB compressed `/compact` (Task 4), one diagnostic line on both routes (Task 6), and a delivered-call turn that ends promptly (Task 9, Step 5).
- **Deviation from the brief:**
  - `RequestBodyLimitError` arrives in Phase 1, not Phase 2, because the post-parse policy needs a stage-carrying error. Phase 2 adds the route, the remedy and the log line.
  - Compaction limits apply to `/responses` compaction bodies too (finding 1).
  - The ceiling is 128/256 MiB rather than 256/512 (Global Constraints). `Bun.serve` `maxRequestBodySize` is raised explicitly to 256 MiB (finding 6).
  - Compaction detection matches the parser (a trigger at any position), not the tail-only check that native passthrough uses.
  - The Luna 409 is excluded from attribution, and Luna without Bigger Context is excluded from pressure.
- **Open gates:**
  - Task 7: the header on `/responses`.
  - G4.1: mid-turn auto-compaction.
  - G4.2: the effective auto-compact limit.
