import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  CHATGPT_WEB_FULL_CONTEXT_WINDOW,
  CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT,
  CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT,
  CHATGPT_WEB_LUNA_BIGGER_CONTEXT_ERROR,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
  supportsChatGptWebFullContext,
  type ChatGptWebBackendModel,
  supportsChatGptWebBiggerContext,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET,
  CHATGPT_FULL_CONTEXT_MAX_PARTS,
  chatGptPromptJsonBytes,
  compileChatGptWebPrompt,
  type ChatGptWebBiggerContextPartCount,
  type ChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
} from "./prompt";
import { extractChatGptTurnIdentity } from "./environment";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptWebAdapterError } from "./adapter-error";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions = {},
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits
 * can require more parts even when the total token estimate is small. Plan before submission;
 * compaction always receives all six parts without passing through the legacy inline budget.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
): ChatGptWebBiggerContextPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(CHATGPT_WEB_LUNA_BIGGER_CONTEXT_ERROR);
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (!supportsChatGptWebBiggerContext(parsed.modelId, mode.effort, capabilities, parsed._chatgptModelFamily)) return undefined;
  if (parsed._compactionRequest) return CHATGPT_BIGGER_CONTEXT_PARTS;
  const { contextWindow, autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const compile = (parts?: ChatGptWebBiggerContextPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    { experimentalMultipartParts: parts, experimentalSkillAttachments },
  );
  const inline = compile();
  const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const initialParts = biggerContextPartCount(inputTokens, autoCompactTokenLimit, false);
  if (initialParts === CHATGPT_BIGGER_CONTEXT_PARTS) return initialParts;

  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    // Inert stages may use any explicitly available staging effort; execution keeps the chosen
    // effort. These are the widest stage modes used by the browser's existing selector.
    const stagingEffort = capabilities.proAvailable ? "max" : "medium";
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)
      < contextWindow * Math.min(messages.length, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER);
  };
  if (initialParts === undefined && fits(inline)) return undefined;
  return fits(compile(2)) ? 2 : CHATGPT_BIGGER_CONTEXT_PARTS;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  compaction: boolean,
): ChatGptWebBiggerContextPartCount | undefined {
  if (compaction) return CHATGPT_BIGGER_CONTEXT_PARTS;
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
}

/**
 * Select the smallest safe number of parts (from 2 up to 12) required for the physical request.
 * Inline is evaluated first. If no plan through 12 parts fits, fails with context_length_exceeded
 * before submission and states that atomic records are not split.
 */
export function resolveFullContextMultipartPlan(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
  includeFullCheckpoint = false,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Full Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Full Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget");
  }
  if (!supportsChatGptWebFullContext(parsed.modelId as ChatGptWebBackendModel)) {
    throw new Error(`ChatGPT Full Context limit is not defined for model: ${parsed.modelId}`);
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);

  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      experimentalMultipartParts: parts,
      experimentalMultipartMode: "full",
      experimentalSkillAttachments,
      captureCheckpoint: includeFullCheckpoint ? "full" : undefined,
    },
  );

  const maxPossibleComposerChars = capabilities.proAvailable
    ? CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT
    : CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT;
  const widestEffort: ChatGptWebModelMode["effort"] = capabilities.proAvailable ? "max" : "medium";
  const maxPossibleMessageTokens = resolveChatGptWebMessageTokenBudget(
    CHATGPT_WEB_BACKEND_MODEL, widestEffort, capabilities,
  );

  const checkAtomicString = (text: string): void => {
    if (text.length > maxPossibleComposerChars) {
      throw new ChatGptWebAdapterError(
        `A Full Context record contains ${text.length.toLocaleString("en-US")} characters, which exceeds the measured ${maxPossibleComposerChars.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    const tokens = estimateTokens(text, parsed.modelId);
    if (tokens > maxPossibleMessageTokens) {
      throw new ChatGptWebAdapterError(
        `A Full Context record requires ${tokens.toLocaleString("en-US")} visible message tokens, which exceeds its ${maxPossibleMessageTokens.toLocaleString("en-US")}-token input budget after reserving space for ChatGPT and attachments. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
  };

  if (parsed.context.systemPrompt) {
    for (const sys of parsed.context.systemPrompt) {
      if (typeof sys === "string") checkAtomicString(sys);
    }
  }
  for (const message of parsed.context.messages) {
    if (typeof message.content === "string") {
      checkAtomicString(message.content);
    }
  }

  const inline = compile();
  const canonicalInline = includeFullCheckpoint
    ? compileChatGptWebPrompt(parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined, {
      experimentalMultipartMode: "full",
      experimentalSkillAttachments,
    })
    : inline;
  const inputTokens = estimateCompiledChatGptWebInputTokens(canonicalInline, parsed.modelId);
  if (inputTokens >= CHATGPT_WEB_FULL_CONTEXT_WINDOW) {
    throw new ChatGptWebAdapterError(
      `This Full Context transaction is estimated at ${inputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${CHATGPT_WEB_FULL_CONTEXT_WINDOW.toLocaleString("en-US")}-token ceiling. Run /compact, then retry.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }

  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    if (parsed._compactionRequest && !compiled.multipart && chatGptPromptJsonBytes(compiled.text) > CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET) {
      return false;
    }
    const messages = compiledChatGptWebMessages(compiled);
    const stagingEffort = capabilities.proAvailable ? "max" : "medium";
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL,
        effort,
        capabilities,
        final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    return true;
  };

  if (fits(inline)) return undefined;

  for (let count = 2; count <= CHATGPT_FULL_CONTEXT_MAX_PARTS; count++) {
    const candidateParts = count as ChatGptWebMultipartPartCount;
    let candidate: CompiledChatGptWebPrompt;
    try {
      candidate = compile(candidateParts);
    } catch {
      continue;
    }
    if (fits(candidate)) {
      return candidateParts;
    }
  }

  throw new ChatGptWebAdapterError(
    `A Full Context transaction requires more parts than the maximum allowed 12 parts, or contains an individual Codex message or JSON record that exceeds ChatGPT message limits. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}


function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
  experimentalSkillAttachments = false,
  experimentalFullContext = false,
): CodexUsage {
  const experimentalMultipartMode = experimentalFullContext ? "full" : "bigger";
  const experimentalMultipartParts = experimentalFullContext
    ? resolveFullContextMultipartPlan(parsed, capabilities, experimentalSkillAttachments)
    : (experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities, experimentalSkillAttachments)
      : undefined);
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    experimentalSkillAttachments,
    experimentalMultipartMode,
    experimentalMultipartParts,
  });
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
