import { expect, test } from "bun:test";
import {
  estimateChatGptWebInputTokens,
  estimateChatGptWebUsage,
  resolveBiggerContextMultipartParts,
  resolveFullContextMultipartPlan,
} from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt, CHATGPT_FULL_CONTEXT_MAX_PARTS } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_FULL_CONTEXT_WINDOW } from "../src/chatgpt-web-models";
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

test("GPT-6 Sol on Plus keeps standard context while Pro can stage the same complete input", () => {
  const plus = { ...capabilities, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 4 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(24_000)}`, timestamp: index + 1,
  }));
  const original = structuredClone(parsed);
  expect(resolveBiggerContextMultipartParts(parsed, plus)).toBeUndefined();
  const compiled = compileChatGptWebPrompt(parsed, plus);
  expect(compiled.multipart).toBeUndefined();
  for (const message of parsed.context.messages) expect(compiled.text).toContain(message.content as string);
  expect(estimateChatGptWebUsage(parsed, { answer: "done" }, plus, true))
    .toEqual(estimateChatGptWebUsage(parsed, { answer: "done" }, plus, false));
  expect(() => compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: 2 }))
    .toThrow("GPT-6 Sol uses standard context");
  expect(parsed).toEqual(original);
  expect(resolveBiggerContextMultipartParts({ ...parsed, _chatgptModelFamily: "5.6" }, capabilities)).toBe(2);
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(2);
  const staged = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(staged.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities, true).inputTokens)
    .toBe(estimateCompiledChatGptWebInputTokens(staged, parsed.modelId));
}, 30_000);

test("GPT-6 compaction respects the selected account and effort", () => {
  const parsed = { ...request("Summarize this task."), _chatgptModelFamily: "6" as const, _compactionRequest: true };
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      parsed.options.reasoning = effort;
      const supported = proAvailable && effort !== "low";
      const parts = resolveBiggerContextMultipartParts(parsed, caps);
      if (supported) {
        expect(parts).toBe(6);
        expect(compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts }).multipart!.parts).toHaveLength(6);
      } else {
        expect(parts).toBeUndefined();
        expect(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, true))
          .toEqual(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, false));
        expect(() => compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 }))
          .toThrow("GPT-6 Sol uses standard context");
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
