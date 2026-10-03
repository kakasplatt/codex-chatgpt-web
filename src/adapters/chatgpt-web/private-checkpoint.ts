import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { parseRequest } from "../../responses/parser";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "./environment";

export interface ChatGptPrivateCheckpointPolicy<TCheckpoint> {
  label: string;
  marker: string;
  maxTokens: number;
  parseCheckpoint(value: unknown): TCheckpoint;
  checkpointContext(checkpoint: TCheckpoint): string;
}

export interface CapturedChatGptPrivateCheckpoint<TCheckpoint> {
  checkpoint: TCheckpoint;
  answerHash: string;
}

export interface CompletedChatGptPrivateCheckpoint<TCheckpoint> {
  answer: string;
  visibleRemainder: string;
  captured?: CapturedChatGptPrivateCheckpoint<TCheckpoint>;
}

export interface StoredChatGptPrivateCheckpoint<TCheckpoint> extends CapturedChatGptPrivateCheckpoint<TCheckpoint> {
  threadId: string;
  sourceTurnId: string;
  updatedAt: number;
}

export interface StoredChatGptPrivateCheckpointFile<TCheckpoint> {
  version: 1;
  checkpoints: StoredChatGptPrivateCheckpoint<TCheckpoint>[];
}

export const MAX_STORED_CHECKPOINTS = 512;
export const CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

function checkpointKey(threadId: string, answerHash: string): string {
  return `${threadId}\u0000${answerHash}`;
}

export function canonicalAnswer(answer: string): string {
  return answer.replaceAll("\r\n", "\n").trimEnd();
}

export function hashChatGptAnswer(answer: string): string {
  return createHash("sha256").update(canonicalAnswer(answer)).digest("hex");
}

export class ChatGptPrivateCheckpointStream<TCheckpoint> {
  private pending = "";
  private checkpointText = "";
  private visibleAnswer = "";
  private markerSeen = false;
  private readonly visibleMarkerReserveChars: number;

  constructor(private readonly policy: ChatGptPrivateCheckpointPolicy<TCheckpoint>) {
    this.visibleMarkerReserveChars = policy.marker.length + 16;
  }

  push(delta: string): string {
    if (!delta) return "";
    if (this.markerSeen) {
      this.checkpointText += delta;
      return "";
    }

    this.pending += delta;
    const markerIndex = this.pending.indexOf(this.policy.marker);
    if (markerIndex >= 0) {
      const visible = this.pending.slice(0, markerIndex).trimEnd();
      this.checkpointText = this.pending.slice(markerIndex + this.policy.marker.length);
      this.pending = "";
      this.markerSeen = true;
      this.visibleAnswer += visible;
      return visible;
    }

    if (this.pending.length <= this.visibleMarkerReserveChars) return "";
    const emitLength = this.pending.length - this.visibleMarkerReserveChars;
    const visible = this.pending.slice(0, emitLength);
    this.pending = this.pending.slice(emitLength);
    this.visibleAnswer += visible;
    return visible;
  }

  private flushVisibleRemainder(): string {
    if (this.markerSeen || !this.pending) return "";
    const visible = this.pending;
    this.pending = "";
    this.visibleAnswer += visible;
    return visible;
  }

  finishOptional(rawResponseText: string): CompletedChatGptPrivateCheckpoint<TCheckpoint> {
    if (this.markerSeen) {
      const completed = this.finish(rawResponseText);
      return { ...completed, visibleRemainder: "" };
    }
    if (rawResponseText.includes(this.policy.marker)) {
      throw new Error(`ChatGPT ${this.policy.label} rolling checkpoint marker was not preserved in the Markdown stream`);
    }
    const visibleRemainder = this.flushVisibleRemainder();
    const answer = canonicalAnswer(this.visibleAnswer);
    if (!answer) throw new Error(`ChatGPT ${this.policy.label} completed without a user-facing answer`);
    return { answer, visibleRemainder };
  }

  finish(rawResponseText: string): { answer: string; captured: CapturedChatGptPrivateCheckpoint<TCheckpoint> } {
    if (!this.markerSeen) {
      throw new Error(
        `ChatGPT ${this.policy.label} completed without the required ${this.policy.marker} rolling checkpoint marker`,
      );
    }
    const rawMarkerIndex = rawResponseText.indexOf(this.policy.marker);
    if (rawMarkerIndex < 0 || rawMarkerIndex !== rawResponseText.lastIndexOf(this.policy.marker)) {
      throw new Error(`ChatGPT ${this.policy.label} response must contain exactly one raw rolling checkpoint marker`);
    }
    if (this.checkpointText.includes(this.policy.marker)) {
      throw new Error(`ChatGPT ${this.policy.label} Markdown stream contained more than one rolling checkpoint marker`);
    }
    const checkpoint = this.policy.parseCheckpoint(
      rawResponseText.slice(rawMarkerIndex + this.policy.marker.length),
    );
    const answer = canonicalAnswer(this.visibleAnswer);
    if (!answer) throw new Error(`ChatGPT ${this.policy.label} completed without a user-facing answer before its rolling checkpoint`);
    return {
      answer,
      captured: { checkpoint, answerHash: hashChatGptAnswer(answer) },
    };
  }
}

function currentTurnBoundary(parsed: CodexParsedRequest, input: unknown[], turnId: string): number | undefined {
  const replayPrefix = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  if (replayPrefix > 0) return replayPrefix;
  const firstCurrentItem = input.findIndex(item => itemTurnId(item) === turnId);
  return firstCurrentItem >= 0 ? firstCurrentItem : undefined;
}

function assistantItemText(value: unknown): string | undefined {
  const item = record(value);
  if (!item || item.role !== "assistant") return undefined;
  if (typeof item.content === "string") return item.content.trim() ? item.content : undefined;
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content.map(block => {
    const content = record(block);
    return content && (content.type === "output_text" || content.type === "text")
      && typeof content.text === "string"
      ? content.text
      : "";
  }).join("");
  return text.trim() ? text : undefined;
}

export function parentAssistantAnswer(
  parsed: CodexParsedRequest,
  turnId: string,
): { answer: string; turnId: string } | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : undefined;
  if (!input) return undefined;
  const boundary = currentTurnBoundary(parsed, input, turnId);
  if (boundary === undefined) return undefined;
  for (let index = boundary - 1; index >= 0; index -= 1) {
    const text = assistantItemText(input[index]);
    const parentTurnId = itemTurnId(input[index]);
    if (text && parentTurnId) return { answer: text, turnId: parentTurnId };
  }
  return undefined;
}

export function currentTurnInput(parsed: CodexParsedRequest, turnId: string): unknown[] | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : undefined;
  if (!input) return undefined;
  const boundary = currentTurnBoundary(parsed, input, turnId);
  if (boundary === undefined) return undefined;
  const suffix = input.slice(boundary);
  return suffix.length > 0 ? suffix : undefined;
}

export class ChatGptPrivateCheckpointStore<TCheckpoint> {
  private loaded = false;
  private readonly checkpoints = new Map<string, StoredChatGptPrivateCheckpoint<TCheckpoint>>();

  constructor(
    private readonly policy: ChatGptPrivateCheckpointPolicy<TCheckpoint>,
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  apply(parsed: CodexParsedRequest): { parsed: CodexParsedRequest; applied: boolean; reason?: string } {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId) return { parsed, applied: false, reason: "missing native thread identity" };
    const parent = parentAssistantAnswer(parsed, identity.turnId);
    if (!parent) return { parsed, applied: false, reason: "no proven completed parent assistant answer" };

    const parentHash = hashChatGptAnswer(parent.answer);
    const stored = this.get(identity.threadId, parentHash);
    if (!stored) return { parsed, applied: false, reason: "no checkpoint for the exact parent answer" };
    if (stored.sourceTurnId !== parent.turnId) {
      return { parsed, applied: false, reason: "checkpoint source turn does not match the exact parent answer" };
    }

    const currentInput = currentTurnInput(parsed, identity.turnId);
    const body = record(parsed._rawBody);
    if (!currentInput || !body) {
      return { parsed, applied: false, reason: "current native turn boundary is unavailable" };
    }

    const checkpointItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: this.policy.checkpointContext(stored.checkpoint) }],
      internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
    };
    const { previous_response_id: _previousResponseId, ...bodyWithoutPrevious } = body;
    const compacted = parseRequest({
      ...bodyWithoutPrevious,
      input: [checkpointItem, ...currentInput],
    });
    compacted.modelId = parsed.modelId;
    compacted.options = { ...compacted.options, ...parsed.options };

    if (JSON.stringify(extractChatGptTurnUserRevision(compacted)) !== JSON.stringify(extractChatGptTurnUserRevision(parsed))) {
      throw new Error(`ChatGPT ${this.policy.label} rolling checkpoint changed the active native user revision`);
    }
    return { parsed: compacted, applied: true };
  }

  commit(parsed: CodexParsedRequest, captured: CapturedChatGptPrivateCheckpoint<TCheckpoint>, answer: string): void {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId) {
      throw new Error(`ChatGPT ${this.policy.label} rolling checkpoint requires native thread_id and turn_id metadata`);
    }
    const checkpoint = this.policy.parseCheckpoint(captured.checkpoint);
    const answerHash = hashChatGptAnswer(answer);
    if (captured.answerHash !== answerHash) {
      throw new Error(`ChatGPT ${this.policy.label} rolling checkpoint answer hash does not match the completed browser answer`);
    }
    this.load();
    const stored: StoredChatGptPrivateCheckpoint<TCheckpoint> = {
      threadId: identity.threadId,
      sourceTurnId: identity.turnId,
      answerHash,
      checkpoint,
      updatedAt: this.now(),
    };
    const key = checkpointKey(identity.threadId, answerHash);
    this.checkpoints.delete(key);
    this.checkpoints.set(key, stored);
    this.prune();
    this.persist();
  }

  private validateStored(value: unknown): StoredChatGptPrivateCheckpoint<TCheckpoint> {
    const parsed = record(value);
    if (!parsed
      || typeof parsed.threadId !== "string"
      || typeof parsed.sourceTurnId !== "string"
      || typeof parsed.answerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.answerHash)
      || typeof parsed.updatedAt !== "number") {
      throw new Error(`Invalid persisted ChatGPT ${this.policy.label} checkpoint metadata`);
    }
    return {
      threadId: parsed.threadId,
      sourceTurnId: parsed.sourceTurnId,
      answerHash: parsed.answerHash,
      checkpoint: this.policy.parseCheckpoint(parsed.checkpoint),
      updatedAt: parsed.updatedAt,
    };
  }

  private get(threadId: string, answerHash: string): StoredChatGptPrivateCheckpoint<TCheckpoint> | undefined {
    this.load();
    this.prune();
    return this.checkpoints.get(checkpointKey(threadId, answerHash));
  }

  private prune(): void {
    const cutoff = this.now() - CHECKPOINT_TTL_MS;
    for (const [key, checkpoint] of this.checkpoints) {
      if (checkpoint.updatedAt < cutoff) this.checkpoints.delete(key);
    }
    while (this.checkpoints.size > MAX_STORED_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      this.checkpoints.delete(oldest);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    const payload = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredChatGptPrivateCheckpointFile<TCheckpoint>>;
    if (payload.version !== 1 || !Array.isArray(payload.checkpoints)) {
      throw new Error(`Invalid ChatGPT ${this.policy.label} checkpoint store: ${this.path}`);
    }
    const checkpoints = payload.checkpoints
      .map(item => this.validateStored(item))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(-MAX_STORED_CHECKPOINTS);
    for (const checkpoint of checkpoints) {
      this.checkpoints.set(checkpointKey(checkpoint.threadId, checkpoint.answerHash), checkpoint);
    }
    this.prune();
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredChatGptPrivateCheckpointFile<TCheckpoint> = {
      version: 1,
      checkpoints: [...this.checkpoints.values()],
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
