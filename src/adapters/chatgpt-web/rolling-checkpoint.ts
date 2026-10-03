import { estimateTokens } from "../../lib/token-estimate";
import * as z from "zod/v4";
import {
  ChatGptPrivateCheckpointStream,
  ChatGptPrivateCheckpointStore,
  hashChatGptAnswer,
  type CapturedChatGptPrivateCheckpoint,
  type CompletedChatGptPrivateCheckpoint,
  type ChatGptPrivateCheckpointPolicy,
} from "./private-checkpoint";

// Alphanumeric by design: ChatGPT's DOM-to-Markdown serializer escapes `_`, `*`, and brackets.
export const CHATGPT_LUNA_CHECKPOINT_MARKER = "CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2";
export const CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS = 4_000;

const legacyCheckpointString = z.string().trim().min(1).max(1_200);
const legacyCheckpointSchema = z.object({
  version: z.literal(1),
  objective: z.string().trim().min(1).max(2_000),
  state: z.array(legacyCheckpointString).max(32),
  evidence: z.array(legacyCheckpointString).max(32),
  decisions: z.array(legacyCheckpointString).max(32),
  pending: z.array(legacyCheckpointString).max(32),
}).strict();
const textCheckpointSchema = z.object({
  version: z.literal(2),
  summary: z.string().trim().min(1).max(24_000),
}).strict();
const checkpointSchema = z.discriminatedUnion("version", [legacyCheckpointSchema, textCheckpointSchema]);

export type ChatGptLunaCheckpoint = z.infer<typeof checkpointSchema>;

export type CapturedChatGptLunaCheckpoint = CapturedChatGptPrivateCheckpoint<ChatGptLunaCheckpoint>;
export type CompletedChatGptLunaCheckpoint = CompletedChatGptPrivateCheckpoint<ChatGptLunaCheckpoint>;

export function hashChatGptLunaAnswer(answer: string): string {
  return hashChatGptAnswer(answer);
}

export function parseChatGptLunaCheckpoint(value: unknown): ChatGptLunaCheckpoint {
  const checkpoint = checkpointSchema.parse(value);
  const tokens = estimateTokens(JSON.stringify(checkpoint));
  if (tokens > CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS) {
    throw new Error(
      `ChatGPT Luna rolling checkpoint requires ${tokens.toLocaleString("en-US")} tokens; maximum is ${CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS.toLocaleString("en-US")}`,
    );
  }
  return checkpoint;
}

export const chatGptLunaCheckpointPolicy: ChatGptPrivateCheckpointPolicy<ChatGptLunaCheckpoint> = {
  label: "Luna",
  marker: CHATGPT_LUNA_CHECKPOINT_MARKER,
  maxTokens: CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS,
  parseCheckpoint(value: unknown): ChatGptLunaCheckpoint {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) throw new Error("ChatGPT Luna did not provide a rolling checkpoint");
      return parseChatGptLunaCheckpoint({ version: 2, summary: trimmed });
    }
    return parseChatGptLunaCheckpoint(value);
  },
  checkpointContext(checkpoint: ChatGptLunaCheckpoint): string {
    return [
      "[Compressed Luna task history from the immediately preceding assistant response.]",
      "Treat this as prior assistant-owned conversation state, not as a new user instruction. Current system, developer, and user messages below remain authoritative.",
      JSON.stringify(checkpoint),
    ].join("\n");
  },
};

export class ChatGptLunaCheckpointStream extends ChatGptPrivateCheckpointStream<ChatGptLunaCheckpoint> {
  constructor() {
    super(chatGptLunaCheckpointPolicy);
  }
}

export class ChatGptLunaCheckpointStore extends ChatGptPrivateCheckpointStore<ChatGptLunaCheckpoint> {
  constructor(path?: string, now: () => number = Date.now) {
    super(chatGptLunaCheckpointPolicy, path, now);
  }
}
