import { expect, spyOn, test } from "bun:test";
import {
  estimateChatGptWebInputTokens,
  estimateChatGptWebUsage,
  resolveBiggerContextMultipartParts,
  resolveFullContextMultipartPlan,
} from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt, CHATGPT_FULL_CONTEXT_MAX_PARTS } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_WEB_FULL_CONTEXT_WINDOW,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  resolveChatGptWebContextLimits,
} from "../src/chatgpt-web-models";
import { COMPACTION_PRESSURE_BYTES, underCompactionPressure } from "../src/request-size-policy";
import * as tokenEstimate from "../src/lib/token-estimate";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";
import { resolveChatGptWebMessageTokenBudget, resolveChatGptWebStagingTokenBudget } from "../src/chatgpt-web-models";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test("usage counts the configured plugin name carried by the submitted prompt", () => {
  const parsed = request("Inspect the repository.");
  const caps = { ...capabilities, localToolsEnabled: true };
  const appName = `Codex ${"測試_".repeat(16)}`;
  const token = `turn_${"0".repeat(32)}`;
  const compiled = compileChatGptWebPrompt(parsed, caps, token, { appName });
  const expected = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(expected).not.toBe(estimateChatGptWebInputTokens(parsed, caps));
  for (const biggerContext of [false, true]) {
    expect(estimateChatGptWebUsage(parsed, {}, caps, biggerContext, false, false, appName).inputTokens).toBe(expected);
  }
});

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 6],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 6],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    }
  }
  // Low-token text can still exceed the reasoning model's server character ceiling.
  // Stage the complete record instead of sending it inline or dropping its contents.
  const sparsePro = request("x".repeat(600_000));
  expect(resolveBiggerContextMultipartParts(sparsePro, capabilities)).toBe(2);
  const stagedPro = compileChatGptWebPrompt(sparsePro, capabilities, undefined, { experimentalMultipartParts: 2 });
  expect(stagedPro.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([sparsePro.context.messages[0]!.content]);
  const proMessages = compiledChatGptWebMessages(stagedPro);
  expect(proMessages[1]!.length).toBeLessThanOrEqual(500_000);
  expect(resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol", capabilities, estimateTokens(proMessages[0]!), proMessages[0]!.length,
  ).effort).toBe("max");
}, 60_000);

test("Bigger Context compaction selects six parts before the legacy inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("GPT-6 Sol stages complete Plus and Pro history with consistent usage accounting", () => {
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 4 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(24_000)}`, timestamp: index + 1,
  }));
  const original = structuredClone(parsed);
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    const parts = resolveBiggerContextMultipartParts(parsed, caps);
    expect(parts).toBe(2);
    const staged = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
    expect(staged.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
      .toEqual(parsed.context.messages.map(message => message.content));
    expect(estimateChatGptWebUsage(parsed, { answer: "done" }, caps, true).inputTokens)
      .toBe(estimateCompiledChatGptWebInputTokens(staged, parsed.modelId));
    expect(parsed).toEqual(original);
  }
}, 30_000);

test("GPT-6 compaction respects the selected account and effort", () => {
  const parsed = { ...request("Summarize this task."), _chatgptModelFamily: "6" as const, _compactionRequest: true };
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      parsed.options.reasoning = effort;
      const supported = effort !== "low";
      const parts = resolveBiggerContextMultipartParts(parsed, caps);
      if (supported) {
        expect(parts).toBe(6);
        expect(compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts }).multipart!.parts).toHaveLength(6);
      } else {
        expect(parts).toBeUndefined();
        expect(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, true))
          .toEqual(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, false));
        expect(() => compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 }))
          .toThrow("GPT-6 Instant uses standard context");
      }
    }
  }
  parsed.options.reasoning = "max";
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  expect(compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts }).multipart!.parts).toHaveLength(6);
});

test("Plus history is rebalanced into smaller Instant uploads and a larger selected-mode final message", () => {
  const plus = { ...capabilities, proAvailable: false, extraHighAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 60 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(3000)}`, timestamp: index + 1,
  }));
  for (const compaction of [false, true]) {
    parsed._compactionRequest = compaction;
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message.content)).toEqual(parsed.context.messages.map(message => message.content));
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    const messages = compiledChatGptWebMessages(compiled);
    const stagingTokens = messages.slice(0, -1).map(text => estimateTokens(text));
    const stagingBudget = resolveChatGptWebStagingTokenBudget("gpt-5.6-sol", "low", plus);
    expect(Math.max(...stagingTokens)).toBeLessThanOrEqual(stagingBudget);
    expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus,
      Math.max(...stagingTokens), Math.max(...messages.slice(0, -1).map(text => text.length))).effort).toBe("low");
    const finalTokens = estimateTokens(messages.at(-1)!);
    expect(finalTokens).toBeGreaterThan(Math.max(...stagingTokens));
    expect(finalTokens).toBeLessThanOrEqual(resolveChatGptWebMessageTokenBudget("gpt-5.6-sol", "high", plus));
  }
}, 30_000);

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { extraHighAvailable: false, proAvailable: false, images: 3, schema: false },
    { extraHighAvailable: true, proAvailable: true, images: 10, schema: false },
    { extraHighAvailable: false, proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 6,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);

test("Full Context planner evaluates inline first, selects smallest safe count up to 12, and preserves whole records", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };

  // 1. Inline fit: small task returns undefined
  const small = request("small task");
  expect(resolveFullContextMultipartPlan(small, plus)).toBeUndefined();

  // 2. Smallest safe count: moderate task requires 2 parts
  const moderate = request("");
  moderate.context.messages = [
    { role: "user", content: "word ".repeat(45_000), timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "word ".repeat(45_000) }], timestamp: 2 },
  ];
  expect(resolveFullContextMultipartPlan(moderate, plus)).toBe(2);
  expect(resolveFullContextMultipartPlan(moderate, plus, false, true)).toBe(2);

  // 3. Payload requiring more than 6 but at most 12 parts
  const large = request("");
  // 8 messages of 55,000 words each (~55k tokens each = ~440k tokens total).
  // Plus staging message limit is ~81k tokens, so 6 parts can hold ~480k only if balanced, but with wrappers and final execution overhead, 6 parts does not fit, requiring 7 or 8 parts.
  const eightChunks = Array.from({ length: 8 }, (_, i) => `chunk ${i}: ${"word ".repeat(55_000)}`);
  large.context.messages = eightChunks.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
  const planCount = resolveFullContextMultipartPlan(large, plus);
  expect(planCount).toBeGreaterThan(6);
  expect(planCount).toBeLessThanOrEqual(CHATGPT_FULL_CONTEXT_MAX_PARTS);

  // Compile with selected count and verify records and mode
  const compiledLarge = compileChatGptWebPrompt(large, plus, undefined, {
    experimentalMultipartParts: planCount,
    experimentalMultipartMode: "full",
  });
  expect(compiledLarge.multipart?.contextMode).toBe("full");
  const extractedRecords = compiledLarge.multipart!.parts.flatMap(part => JSON.parse(part).records);
  expect(extractedRecords.map(r => r.message.content)).toEqual(eightChunks);
  // Whole-record order preserved
  expect(extractedRecords.map(r => r.message_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

  // 4. Schema and attachments reserve final-message budget and may increase part count
  const withSchema = request("");
  withSchema.context.messages = [
    { role: "user", content: "word ".repeat(40_000), timestamp: 1 },
    { role: "user", content: "word ".repeat(40_000), timestamp: 2 },
  ];
  const baseCount = resolveFullContextMultipartPlan(withSchema, plus);
  withSchema.options.outputFormat = {
    type: "json_schema",
    name: "huge_schema",
    strict: true,
    schema: { type: "string", description: "schema ".repeat(25_000) },
  };
  const countWithSchema = resolveFullContextMultipartPlan(withSchema, plus);
  expect(countWithSchema).toBeGreaterThanOrEqual(baseCount ?? 2);

  // 5. Canonical input at or above 1_050_000 rejected independent of part count
  // 11 messages of 96,000 words each = ~1,056,000 tokens (> 1,050,000). Each individually fits under Pro message limit.
  const hugeInput = request("");
  hugeInput.context.messages = Array.from({ length: 11 }, (_, i) => ({
    role: "user" as const,
    content: `chunk ${i}: ${"word ".repeat(96_000)}`,
    timestamp: i + 1,
  }));
  expect(() => resolveFullContextMultipartPlan(hugeInput, capabilities))
    .toThrow("1,050,000-token ceiling");

  // 6. One atomic record below logical ceiling but above every physical message budget fails before Send
  // Single message of 120,000 tokens is below 1,050,000 ceiling, but exceeds every single message budget (Plus 81,807, Pro 104,000).
  const atomicTooBig = request("word ".repeat(120_000));
  expect(() => resolveFullContextMultipartPlan(atomicTooBig, plus))
    .toThrow("The bridge will not split an individual Codex message or JSON record");

  // Also verify single atomic record exceeding maximum composer character limit (1,300,000 chars)
  const atomicTooManyChars = request("x".repeat(1_300_000));
  expect(() => resolveFullContextMultipartPlan(atomicTooManyChars, plus))
    .toThrow("The bridge will not split an individual Codex message or JSON record");

  // 7. Checkpoint-aware planning fails before Send when 13 near-limit atomic records cannot fit through 12 parts.
  const tooManyPhysicalParts = request("");
  tooManyPhysicalParts.context.messages = Array.from({ length: 13 }, (_, i) => ({
    role: "user" as const,
    content: `chunk ${i}: ${"word ".repeat(79_000)}`,
    timestamp: i + 1,
  }));
  expect(() => resolveFullContextMultipartPlan(tooManyPhysicalParts, plus, false, true))
    .toThrow("maximum allowed 12 parts");
}, 60_000);

test("Full Context checkpoint overhead promotes a physical two-part plan to three parts", () => {
  const plus = {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  };
  const parsed = request("");
  const small = request("small inline request");
  expect(resolveFullContextMultipartPlan(small, plus)).toBeUndefined();

  parsed.context.messages = [
    { role: "user", content: "intro ".repeat(1_000), timestamp: 1 },
    { role: "user", content: "word ".repeat(80_600), timestamp: 2 },
  ];

  expect(resolveFullContextMultipartPlan(parsed, plus)).toBe(2);
  const checkpointAwareParts = resolveFullContextMultipartPlan(parsed, plus, false, true);
  expect(checkpointAwareParts).toBe(3);

  const compiled = compileChatGptWebPrompt(parsed, plus, undefined, {
    experimentalMultipartParts: checkpointAwareParts,
    experimentalMultipartMode: "full",
    captureCheckpoint: "full",
  });
  const messages = compiledChatGptWebMessages(compiled);
  const tokens = messages.map(text => estimateTokens(text, parsed.modelId));
  const chars = messages.map(text => text.length);
  const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
  const maxStageChars = Math.max(...chars.slice(0, -1));
  const stage = resolveChatGptWebMultipartStagingMode(
    parsed.modelId,
    plus,
    maxStageMessageTokens,
    maxStageChars,
  );

  expect(() => assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...tokens),
    parsed.modelId,
    "high",
    plus,
    Math.max(...chars),
    checkpointAwareParts!,
    {
      stagingEffort: stage.effort,
      maxStageMessageTokens,
      maxStageChars,
      finalMessageTokens: tokens.at(-1)!,
      finalMessageChars: chars.at(-1)!,
      finalImageTokens: estimateChatGptWebImageTokens(compiled),
    },
    "full",
  )).not.toThrow();
}, 30_000);

test("Full Context checkpoint overhead does not reduce the canonical 1,050,000-token ceiling", () => {
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 11 }, (_, index) => ({
    role: "user" as const,
    content: "word ".repeat(94_550),
    timestamp: index + 1,
  }));

  expect(resolveFullContextMultipartPlan(parsed, capabilities)).toBe(11);
  expect(resolveFullContextMultipartPlan(parsed, capabilities, false, true)).toBe(11);
}, 30_000);

test("Full Context planner tokenizes each context record once per planning call", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 4 }, (_, index) => ({
    role: "user" as const,
    content: `chunk ${index}: ${"word ".repeat(60_000)}`,
    timestamp: index + 1,
  }));

  // Record weights do not depend on the part count or the staging effort, so one planning call
  // tries several counts and efforts but must tokenize each record only once.
  const estimate = spyOn(tokenEstimate, "estimateTokens");
  try {
    expect(resolveFullContextMultipartPlan(parsed, plus)).toBe(4);
    const recordTexts = estimate.mock.calls
      .map(([text]) => text)
      .filter(text => text.startsWith('{"kind":'));
    expect(new Set(recordTexts).size).toBe(4);
    expect(recordTexts).toHaveLength(4);
  } finally {
    estimate.mockRestore();
  }
}, 30_000);

test("Full Context usage accounting always reports logical canonical tokens, ignoring smaller physical resume/recovery input", () => {
  const largeCanonical = request("word ".repeat(50_000));
  const smallSuffix = request("word ".repeat(100));

  const evidence = { answer: "Completed.", reasoning: [] };
  const canonicalUsage = estimateChatGptWebUsage(
    largeCanonical,
    evidence,
    capabilities,
    false, // bigger context
    false, // skill attachments
    true,  // full context
  );

  const suffixUsage = estimateChatGptWebUsage(
    smallSuffix,
    evidence,
    capabilities,
    false,
    false,
    true,
  );

  expect(canonicalUsage.inputTokens).toBeGreaterThan(50_000);
  expect(suffixUsage.inputTokens).toBeLessThan(12_000);
  expect(canonicalUsage.inputTokens).toBeGreaterThan(suffixUsage.inputTokens + 40_000);

  const lunaReq = request("hello");
  lunaReq.modelId = "gpt-5.6-luna";
  lunaReq.options.reasoning = "low";
  const lunaCapabilities = { ...capabilities, solAvailable: false };
  expect(() => estimateChatGptWebUsage(lunaReq, evidence, lunaCapabilities, false, false, true))
    .toThrow("Full Context is unavailable for Luna");
});

test("Full Context usage approaching 900,000 auto-compact threshold reports canonical tokens even when resume suffix is tiny", () => {
  const massiveCanonical: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      messages: Array.from({ length: 11 }, (_, i) => (
        i % 2 === 0
          ? {
            role: "user" as const,
            content: `Segment ${i}: ${"token ".repeat(70_000)}`,
            timestamp: i + 1,
          }
          : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `Segment ${i}: ${"token ".repeat(70_000)}` }],
            timestamp: i + 1,
          }
      )),
    },
  };
  const tinyResumeSuffix: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      messages: [
        { role: "user", content: "Please summarize the work so far.", timestamp: 12 },
      ],
    },
  };

  const evidence = { answer: "Compaction required.", reasoning: [] };
  const canonicalUsage = estimateChatGptWebUsage(
    massiveCanonical,
    evidence,
    capabilities,
    false,
    false,
    true,
  );
  expect(canonicalUsage.inputTokens).toBeGreaterThan(700_000);
  expect(canonicalUsage.inputTokens).toBeLessThan(CHATGPT_WEB_FULL_CONTEXT_WINDOW);

  const suffixUsage = estimateChatGptWebUsage(
    tinyResumeSuffix,
    evidence,
    capabilities,
    false,
    false,
    true,
  );
  expect(suffixUsage.inputTokens).toBeLessThan(10_000);

  const compactReq: CodexParsedRequest = {
    ...massiveCanonical,
    _compactionRequest: true,
  };
  const compactUsage = estimateChatGptWebUsage(
    compactReq,
    evidence,
    capabilities,
    false,
    false,
    true,
  );
  expect(compactUsage.inputTokens).toBeGreaterThan(700_000);
  expect(Math.abs(compactUsage.inputTokens - canonicalUsage.inputTokens)).toBeLessThan(500);
}, 60_000);

const MIB = 1024 * 1024;
const noOverride = () => undefined;

function withBytes(parsed: CodexParsedRequest, encoded: number, decoded: number): CodexParsedRequest {
  parsed._requestBodyBytes = { encoded, decoded };
  return parsed;
}

function pressureUsage(
  parsed: CodexParsedRequest,
  caps = capabilities,
  biggerContext = false,
  readOverride: () => { contextWindow: number } | undefined = noOverride,
) {
  return estimateChatGptWebUsage(parsed, { answer: "done" }, caps, biggerContext, false, false, undefined, readOverride);
}

const solWindow = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", capabilities).contextWindow;

test("usage is unchanged below the soft threshold", () => {
  const baseline = pressureUsage(request("small"));
  expect(COMPACTION_PRESSURE_BYTES).toEqual({ encodedBytes: 48 * MIB, decodedBytes: 96 * MIB });
  expect(underCompactionPressure(undefined)).toBe(false);
  for (const bytes of [
    undefined,
    { encoded: 48 * MIB - 1, decoded: 96 * MIB - 1 },
  ]) {
    const parsed = request("small");
    if (bytes) parsed._requestBodyBytes = bytes;
    expect(pressureUsage(parsed)).toEqual(baseline);
  }
  expect(baseline.inputTokens).toBeLessThan(solWindow);
});

test("usage reaches the context window at 48 MiB encoded", () => {
  const usage = pressureUsage(withBytes(request("small"), 48 * MIB, 90 * MIB));
  expect(usage.inputTokens).toBe(solWindow);
  // Codex compares total_tokens against its auto-compact limit, so the total must carry the raise.
  expect(usage.totalTokens).toBeGreaterThanOrEqual(solWindow);
  expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
});

test("usage reaches the context window at 96 MiB decoded even when the encoded size is well below its threshold", () => {
  // The encoded size (47 MiB) is under its 48 MiB threshold, so only the decoded check can fire.
  const baseline = pressureUsage(request("small"));
  expect(pressureUsage(withBytes(request("small"), 47 * MIB, 96 * MIB - 1))).toEqual(baseline);
  const decodedOnly = pressureUsage(withBytes(request("small"), 47 * MIB, 96 * MIB));
  expect(decodedOnly.inputTokens).toBe(solWindow);
  expect(decodedOnly.totalTokens).toBeGreaterThanOrEqual(solWindow);
});

test("an identity-encoded body reaches the context window at the 48 MiB encoded threshold", () => {
  // Identity encoding has equal sizes, so the encoded threshold fires first.
  const baseline = pressureUsage(request("small"));
  expect(pressureUsage(withBytes(request("small"), 48 * MIB - 1, 48 * MIB - 1))).toEqual(baseline);
  const identity = pressureUsage(withBytes(request("small"), 48 * MIB, 48 * MIB));
  expect(identity.inputTokens).toBe(solWindow);
  expect(identity.totalTokens).toBeGreaterThanOrEqual(solWindow);
});

test("pressure uses the advertised Full Context window", () => {
  const advertisedFull = resolveChatGptWebContextLimits(
    "gpt-5.6-sol", "high", { ...capabilities, experimentalFullContext: true },
  ).contextWindow;
  expect(advertisedFull).toBeGreaterThan(solWindow);
  const usage = estimateChatGptWebUsage(
    withBytes(request("small"), 60 * MIB, 60 * MIB), { answer: "done" }, capabilities, false, false, true, undefined, noOverride,
  );
  expect(usage.inputTokens).toBe(advertisedFull);
  expect(usage.totalTokens).toBeGreaterThanOrEqual(advertisedFull);
});

test("pressure uses the advertised Bigger Context window and the larger Codex override", () => {
  const advertisedBigger = resolveChatGptWebContextLimits(
    "gpt-5.6-sol", "high", { ...capabilities, experimentalBiggerContext: true },
  ).contextWindow;
  expect(advertisedBigger).toBeGreaterThan(solWindow);
  const bigger = pressureUsage(withBytes(request("small"), 60 * MIB, 60 * MIB), capabilities, true);
  expect(bigger.inputTokens).toBe(advertisedBigger);
  expect(bigger.totalTokens).toBeGreaterThanOrEqual(advertisedBigger);

  const raised = pressureUsage(withBytes(request("small"), 60 * MIB, 60 * MIB), capabilities, false, () => ({ contextWindow: solWindow * 3 }));
  expect(raised.inputTokens).toBe(solWindow * 3);
  const lowered = pressureUsage(withBytes(request("small"), 60 * MIB, 60 * MIB), capabilities, false, () => ({ contextWindow: 1_000 }));
  expect(lowered.inputTokens).toBe(solWindow);
  const unreadable = pressureUsage(withBytes(request("small"), 60 * MIB, 60 * MIB), capabilities, false, () => {
    throw new Error("model_context_window in Codex config must be a positive integer");
  });
  expect(unreadable.inputTokens).toBe(solWindow);
});

test("compaction requests never report pressure", () => {
  const parsed = withBytes(request("small"), 100 * MIB, 200 * MIB);
  parsed._compactionRequest = true;
  const unmeasured = request("small");
  unmeasured._compactionRequest = true;
  const baseline = pressureUsage(unmeasured);
  expect(pressureUsage(parsed)).toEqual(baseline);
  expect(baseline.inputTokens).toBeLessThan(solWindow);
});

test("Luna under byte pressure reports unchanged usage", () => {
  const luna = { ...capabilities, solAvailable: false, extraHighAvailable: false, proAvailable: false };
  const lunaRequest = (): CodexParsedRequest => ({
    ...request("small"),
    modelId: CHATGPT_WEB_LUNA_BACKEND_MODEL,
    options: { reasoning: "low" },
  });
  const baseline = pressureUsage(lunaRequest(), luna);
  expect(pressureUsage(withBytes(lunaRequest(), 60 * MIB, 100 * MIB), luna)).toEqual(baseline);

  const lunaBiggerWindow = resolveChatGptWebContextLimits(
    CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", { ...luna, experimentalBiggerContext: true },
  ).contextWindow;
  const bigger = pressureUsage(withBytes(lunaRequest(), 60 * MIB, 100 * MIB), luna, true);
  expect(bigger.inputTokens).toBe(lunaBiggerWindow);
  expect(bigger.totalTokens).toBeGreaterThanOrEqual(lunaBiggerWindow);
});

test("pressure is logged once per request without request content", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const parsed = withBytes(request("secret-body-marker"), 50 * MIB, 70 * MIB);
    const first = pressureUsage(parsed);
    pressureUsage(parsed);
    const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[chatgpt-web] compaction_pressure "));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.slice("[chatgpt-web] compaction_pressure ".length))).toEqual({
      encodedBytes: 50 * MIB,
      decodedBytes: 70 * MIB,
      estimatedInputTokens: pressureUsage(request("secret-body-marker")).inputTokens,
      reportedInputTokens: first.inputTokens,
    });
    expect(lines[0]).not.toContain("secret-body-marker");
  } finally {
    warn.mockRestore();
  }
});
