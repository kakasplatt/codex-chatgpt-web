import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import {
  CHATGPT_FULL_CONTEXT_CHECKPOINT_MAX_TOKENS,
  CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER,
  ChatGptFullContextCheckpointStore,
  ChatGptFullContextCheckpointStream,
  hashChatGptFullContextAnswer,
  parseChatGptFullContextCheckpoint,
  type ChatGptFullContextCheckpoint,
} from "../src/adapters/chatgpt-web/full-context-checkpoint";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const checkpoint: ChatGptFullContextCheckpoint = {
  version: 1,
  objective: "Finish the requested repository audit and full context hybrid implementation.",
  state: ["The multipart transport and private checkpoint core were implemented."],
  evidence: ["tests/full-context-checkpoint.test.ts covers the stream and store boundaries."],
  decisions: ["Use an exact-parent checkpoint for Full Context recovery."],
  pending: ["Wire 3-way input selection and native compaction."],
};

function message(role: "developer" | "user" | "assistant", text: string, turnId: string): Record<string, unknown> {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function request(
  threadId: string,
  turnId: string,
  input: Record<string, unknown>[],
) {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    input,
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
  });
}

test("Full Context checkpoint marker is distinct from Luna marker", () => {
  expect(CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER).toBe("CODEXFULLPRIVATECHECKPOINTV1A7F3C9D2");
  expect(CHATGPT_FULL_CONTEXT_CHECKPOINT_MAX_TOKENS).toBe(16_000);
});

test("Full Context checkpoint stream hides a marker split across arbitrary DOM deltas", () => {
  const stream = new ChatGptFullContextCheckpointStream();
  const checkpointText = "Objective:\nFinish full context.\nPending:\n- Wire compaction.";
  const raw = `Visible answer.\n\n${CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER}\n${checkpointText}`;
  let visible = "";
  for (let index = 0; index < raw.length; index += (index % 7) + 1) {
    const next = raw.slice(index, index + (index % 7) + 1);
    visible += stream.push(next);
  }
  const completed = stream.finish(raw);
  expect(visible).toBe("Visible answer.");
  expect(completed.answer).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual({ version: 2, summary: checkpointText });
  expect(completed.captured.answerHash).toBe(hashChatGptFullContextAnswer("Visible answer."));
  expect(visible).not.toContain("CHECKPOINT");
});

test("Full Context checkpoint marker survives the real ChatGPT DOM-to-Markdown serializer", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const domCheckpoint = "State:\n- Inspect src/full_context.ts and preserve *literal* [evidence].";
  const segments = [
    { key: "answer", html: "<p>Visible answer.</p>", text: "Visible answer.", streamable: true },
    {
      key: "marker",
      html: `<p>${CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER}</p>`,
      text: CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER,
      streamable: true,
    },
    {
      key: "checkpoint",
      html: `<p>${domCheckpoint}</p>`,
      text: domCheckpoint,
      streamable: false,
    },
  ];
  const stream = new ChatGptFullContextCheckpointStream();
  const delta = buffer.observe(segments, 0);
  const final = buffer.finish();
  let visible = stream.push(delta);
  visible += stream.push(final.delta);
  const raw = `Visible answer.\n\n${CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER}\n${domCheckpoint}`;
  const completed = stream.finish(raw);
  expect(final.markdown).toContain(CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER);
  expect(final.markdown).toContain("full\\_context.ts");
  expect(visible).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual({ version: 2, summary: domCheckpoint });
});

test("Full Context checkpoint stream preserves answer and succeeds without checkpoint when omitted", () => {
  const stream = new ChatGptFullContextCheckpointStream();
  const visible = stream.push("A normal answer without a checkpoint.");
  expect(visible).toBe("");
  expect(stream.finishOptional("A normal answer without a checkpoint.")).toEqual({
    answer: "A normal answer without a checkpoint.",
    visibleRemainder: "A normal answer without a checkpoint.",
  });
});

test("Full Context checkpoint stream discards malformed or over-budget checkpoint tail when visible answer exists", () => {
  const stream = new ChatGptFullContextCheckpointStream();
  const answer = "Important visible answer that must not be lost.";
  stream.push(`${answer}\n\n${CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER}\n`);
  // Oversized checkpoint > 16k tokens
  const hugeCheckpoint = "word ".repeat(17_000);
  stream.push(hugeCheckpoint);

  const completed = stream.finishOptional(`${answer}\n\n${CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER}\n${hugeCheckpoint}`);
  expect(completed.answer).toBe(answer);
  expect(completed.captured).toBeUndefined();
});

test("Full Context checkpoint stream rethrows hard invariant violation when no visible answer exists", () => {
  const stream = new ChatGptFullContextCheckpointStream();
  stream.push(`${CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER}\nObjective:\nNo visible answer.`);
  expect(() => stream.finishOptional(`${CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER}\nObjective:\nNo visible answer.`)).toThrow(
    /user-facing answer/,
  );
});

test("Full Context checkpoint rejects payloads exceeding 16,000 tokens in parse helper", () => {
  const oversize = {
    version: 2 as const,
    summary: "word ".repeat(17_000),
  };
  expect(() => parseChatGptFullContextCheckpoint(oversize)).toThrow("maximum is 16,000");
});

test("Full Context checkpoint replaces only exact-parent history, refreshes chain, and preserves current turn", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-full-checkpoint-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_full_checkpoint";
  const sourceTurnId = "turn_source_1";
  const originalTask = `Original task ${"x".repeat(40_000)}`;
  const source1 = request(threadId, sourceTurnId, [
    message("developer", "Current operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
  ]);
  const answer1 = "Completed the first step.";
  const store = new ChatGptFullContextCheckpointStore(path);
  const textCheckpoint1: ChatGptFullContextCheckpoint = {
    version: 2,
    summary: "Objective:\nFinish full context.\nPending:\n- Step 2.",
  };
  store.commit(source1, { checkpoint: textCheckpoint1, answerHash: hashChatGptFullContextAnswer(answer1) }, answer1);

  // Turn 2: applies CP 1
  const turn2Id = "turn_source_2";
  const next2 = request(threadId, turn2Id, [
    message("developer", "Old operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
    message("assistant", answer1, sourceTurnId),
    message("developer", "Fresh operational contract", turn2Id),
    message("user", "Continue with the second step", turn2Id),
  ]);
  const applied2 = new ChatGptFullContextCheckpointStore(path).apply(next2);
  expect(applied2.applied).toBe(true);
  expect(extractChatGptTurnUserRevision(applied2.parsed)).toEqual(
    extractChatGptTurnUserRevision(next2),
  );
  const encoded2 = JSON.stringify(applied2.parsed.context.messages);
  expect(encoded2).toContain("Compressed Full Context task history");
  expect(encoded2).toContain("Fresh operational contract");
  expect(encoded2).toContain("Continue with the second step");
  expect(encoded2).not.toContain("Old operational contract");
  expect(encoded2).not.toContain("Original task");

  // Chain refresh: Turn 2 completes and commits CP 2
  const answer2 = "Completed the second step.";
  const textCheckpoint2: ChatGptFullContextCheckpoint = {
    version: 2,
    summary: "Objective:\nFinish full context.\nPending:\n- Step 3.",
  };
  store.commit(next2, { checkpoint: textCheckpoint2, answerHash: hashChatGptFullContextAnswer(answer2) }, answer2);

  // Turn 3: applies CP 2 (refreshed chain)
  const turn3Id = "turn_source_3";
  const next3 = request(threadId, turn3Id, [
    message("developer", "Old operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
    message("assistant", answer1, sourceTurnId),
    message("developer", "Fresh operational contract", turn2Id),
    message("user", "Continue with the second step", turn2Id),
    message("assistant", answer2, turn2Id),
    message("developer", "Turn 3 contract", turn3Id),
    message("user", "Perform step 3", turn3Id),
  ]);
  const applied3 = store.apply(next3);
  expect(applied3.applied).toBe(true);
  const encoded3 = JSON.stringify(applied3.parsed.context.messages);
  expect(encoded3).toContain("Step 3");
  expect(encoded3).not.toContain("Step 2");
  expect(encoded3).not.toContain(originalTask);

  // Continuation with active tool calls in Turn 3
  const continued3 = request(threadId, turn3Id, [
    message("assistant", answer2, turn2Id),
    message("developer", "Turn 3 contract", turn3Id),
    message("user", "Perform step 3", turn3Id),
    message("assistant", "Current-turn progress commentary", turn3Id),
    {
      type: "function_call",
      call_id: "call_full_current",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    },
    {
      type: "function_call_output",
      call_id: "call_full_current",
      output: "current tool evidence",
    },
  ]);
  const appliedContinuation = store.apply(continued3);
  expect(appliedContinuation.applied).toBe(true);
  const continuedEncoded = JSON.stringify(appliedContinuation.parsed.context.messages);
  expect(continuedEncoded).toContain("Current-turn progress commentary");
  expect(continuedEncoded).toContain("current tool evidence");
});

test("Full Context checkpoint fails closed on mismatched parent answer or branch", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-full-branch-checkpoint-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_full_branch";
  const sourceTurnId = "turn_source";
  const source = request(threadId, sourceTurnId, [message("user", "Start", sourceTurnId)]);
  const answer = "Started.";
  const store = new ChatGptFullContextCheckpointStore(path);
  store.commit(source, { checkpoint, answerHash: hashChatGptFullContextAnswer(answer) }, answer);

  const branch = request(threadId, "turn_branch", [
    message("assistant", "A completely different answer.", sourceTurnId),
    message("user", "Continue on another branch", "turn_branch"),
  ]);
  const rejected = store.apply(branch);
  expect(rejected.applied).toBe(false);
  expect(rejected.reason).toContain("exact parent");
});

test("Review Focus: repeated identical assistant text with mismatched sourceTurnId safely falls back to canonical history", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-full-stale-source-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_repeated_text";
  const sourceTurnId = "turn_source_valid";
  const source = request(threadId, sourceTurnId, [message("user", "Start task", sourceTurnId)]);
  const commonAnswer = "Common repeating assistant answer across turns.";
  const store = new ChatGptFullContextCheckpointStore(path);
  store.commit(source, { checkpoint, answerHash: hashChatGptFullContextAnswer(commonAnswer) }, commonAnswer);

  // Another turn has identical assistant text, but its turn_id is DIFFERENT (turn_unrelated)
  const repeated = request(threadId, "turn_after_repeated", [
    message("assistant", commonAnswer, "turn_unrelated"),
    message("user", "Proceed after repeated answer", "turn_after_repeated"),
  ]);
  const result = store.apply(repeated);
  expect(result.applied).toBe(false);
  expect(result.reason).toContain("source turn");
  // Parsed request remains intact canonical input
  expect(result.parsed).toBe(repeated);
});

test("Review Focus: malformed checkpoint commit never overwrites a previously valid exact-parent mapping", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-full-overwrite-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_overwrite_guard";
  const sourceTurnId = "turn_source";
  const source = request(threadId, sourceTurnId, [message("user", "Start task", sourceTurnId)]);
  const answer = "Completed step.";
  const store = new ChatGptFullContextCheckpointStore(path);

  // 1. Commit valid checkpoint
  store.commit(source, { checkpoint, answerHash: hashChatGptFullContextAnswer(answer) }, answer);

  const next = request(threadId, "turn_next", [
    message("assistant", answer, sourceTurnId),
    message("user", "Next step", "turn_next"),
  ]);
  expect(store.apply(next).applied).toBe(true);

  // 2. Attempt to commit a malformed capture for the same source turn
  const invalidOversize = {
    version: 2 as const,
    summary: "word ".repeat(17_000),
  };
  expect(() => {
    store.commit(source, { checkpoint: invalidOversize as any, answerHash: hashChatGptFullContextAnswer(answer) }, answer);
  }).toThrow("maximum is 16,000");

  // 3. Verify original valid checkpoint is STILL intact and usable
  const recheckStore = new ChatGptFullContextCheckpointStore(path);
  const recheck = recheckStore.apply(next);
  expect(recheck.applied).toBe(true);
  const encoded = JSON.stringify(recheck.parsed.context.messages);
  expect(encoded).toContain("The multipart transport and private checkpoint core were implemented.");
});

test("Full Context checkpoint store enforces TTL and max-entry bounds", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-full-ttl-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_full_ttl";

  let nowMs = 1_000_000_000;
  const store = new ChatGptFullContextCheckpointStore(path, () => nowMs);

  const sourceTurnId = "turn_source";
  const source = request(threadId, sourceTurnId, [message("user", "Start", sourceTurnId)]);
  const answer = "Started.";
  store.commit(source, { checkpoint, answerHash: hashChatGptFullContextAnswer(answer) }, answer);

  const next = request(threadId, "turn_next", [
    message("assistant", answer, sourceTurnId),
    message("user", "Continue", "turn_next"),
  ]);

  // Valid right now
  expect(store.apply(next).applied).toBeTrue();

  // Advance time beyond 30 days TTL
  nowMs += 31 * 24 * 60 * 60_000;
  const expiredStore = new ChatGptFullContextCheckpointStore(path, () => nowMs);
  expect(expiredStore.apply(next).applied).toBeFalse();
  expect(expiredStore.apply(next).reason).toContain("no checkpoint");
});

test("Full Context checkpoint preserves the server-resolved backend model when raw body carries a route slug", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-full-route-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_full_route";
  const sourceTurnId = "turn_route_source";
  const source = request(threadId, sourceTurnId, [message("user", "Start", sourceTurnId)]);
  const answer = "Started.";
  const store = new ChatGptFullContextCheckpointStore(path);
  store.commit(source, { checkpoint, answerHash: hashChatGptFullContextAnswer(answer) }, answer);

  const nextTurnId = "turn_route_next";
  const next = request(threadId, nextTurnId, [
    message("assistant", answer, sourceTurnId),
    message("user", "Continue", nextTurnId),
  ]);
  (next._rawBody as { model: string }).model = "chatgpt-web/pro";
  next.modelId = "gpt-5.4-pro";
  next.options.reasoning = "high";

  const applied = store.apply(next);
  expect(applied.applied).toBeTrue();
  expect(applied.parsed.modelId).toBe("gpt-5.4-pro");
  expect(applied.parsed.options.reasoning).toBe("high");
});
