import { expect, test } from "bun:test";
import {
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveFullContextMultipartPlan } from "../src/adapters/chatgpt-web/usage";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_WEB_BACKEND_MODEL, resolveChatGptWebMessageTokenBudget } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

const plus: ChatGptWebCapabilities = {
  localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false,
};

// Sized so the plan's stages land within a few dozen tokens of the Plus Medium stage budget.
// The worker sends `ctx_<random hex>`. Alternating digits and letters is a legal id that
// tokenizes one token per character, the most expensive id the worker can draw.
const expensiveTransactionId = `ctx_${"0a".repeat(16)}`;

function longToolHeavyTask(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    _chatgptModelFamily: "6",
    context: {
      systemPrompt: ["preserve system instructions"],
      messages: [
        ...Array.from({ length: 2_496 }, (_, index) => ({
          role: "toolResult" as const, toolCallId: `call-${index}`, toolName: "read", isError: false,
          content: `line ${index}: scene label jump`, timestamp: index + 1,
        })),
        { role: "user" as const, content: "Continue the task.", timestamp: 2_497 },
      ],
    },
    stream: false,
    options: { reasoning: "high" },
  };
}

test("#112: a Full Context plan still fits once the worker applies its real transaction id", () => {
  const parsed = longToolHeavyTask();
  const partCount = resolveFullContextMultipartPlan(parsed, plus);
  expect(partCount).toBeDefined();
  const compiled = compileChatGptWebPrompt(parsed, plus, `turn_${"0".repeat(32)}`, {
    experimentalMultipartParts: partCount, experimentalMultipartMode: "full",
  });
  const parts = compiled.multipart!.parts;
  const stages = parts.slice(0, -1).map((payload, index) => (
    formatChatGptWebMultipartStage(payload, expensiveTransactionId, index + 1, parts.length).text
  ));
  const maxStageTokens = Math.max(...stages.map(stage => estimateTokens(stage)));
  const maxStageChars = Math.max(...stages.map(stage => stage.length));

  expect(() => resolveChatGptWebMultipartStagingMode(parsed.modelId, plus, maxStageTokens, maxStageChars, "high"))
    .not.toThrow();
  const commit = formatChatGptWebMultipartCommit(compiled.multipart!, expensiveTransactionId);
  expect(estimateTokens(commit))
    .toBeLessThanOrEqual(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_BACKEND_MODEL, "high", plus));
});
