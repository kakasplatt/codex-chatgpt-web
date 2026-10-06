const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const MAX_RETAINED_CONVERSATIONS = 256;
const CONVERSATION_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CONVERSATION_PATH_PATTERN = /^\/c\/([A-Za-z0-9_-]{8,128})\/?$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function canonicalChatGptConversationUrl(value) {
  if (typeof value !== "string" || !value) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.origin !== CHATGPT_ORIGIN || parsed.protocol !== "https:") return undefined;
  if (parsed.searchParams.get("temporary-chat") === "true") return undefined;
  const match = parsed.pathname.match(CONVERSATION_PATH_PATTERN);
  if (!match) return undefined;
  return `${CHATGPT_ORIGIN}/c/${match[1]}`;
}

function connectorIdentity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 80) return undefined;
  return value;
}

function validEntry(value) {
  const parsed = record(value);
  if (!parsed || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) return undefined;
  const url = canonicalChatGptConversationUrl(parsed.url);
  const connector = connectorIdentity(parsed.connectorIdentity);
  if (!url || connector === undefined) return undefined;
  return { url, connectorIdentity: connector, updatedAt: parsed.updatedAt };
}

class RetainedConversationStore {
  constructor(filePath, now = Date.now) {
    this.filePath = filePath;
    this.now = now;
    this.loaded = false;
    this.conversations = new Map();
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return;
    }
    const conversations = record(parsed?.conversations);
    if (parsed?.version !== 1 || !conversations) return;
    const entries = Object.entries(conversations)
      .filter(([key]) => CONVERSATION_KEY_PATTERN.test(key))
      .flatMap(([key, value]) => {
        const entry = validEntry(value);
        return entry ? [[key, entry]] : [];
      })
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(-MAX_RETAINED_CONVERSATIONS);
    for (const [key, entry] of entries) this.conversations.set(key, entry);
  }

  persist(conversations = this.conversations) {
    if (!this.filePath) return;
    writePrivateFileAtomic(this.filePath, `${JSON.stringify({
      version: 1,
      conversations: Object.fromEntries(conversations),
    }, null, 2)}\n`);
  }

  get(conversationKey, expectedConnectorIdentity) {
    if (!CONVERSATION_KEY_PATTERN.test(conversationKey || "")) return undefined;
    const expectedConnector = connectorIdentity(expectedConnectorIdentity);
    if (expectedConnector === undefined) return undefined;
    this.load();
    const entry = this.conversations.get(conversationKey);
    if (!entry || entry.connectorIdentity !== expectedConnector) return undefined;
    return { ...entry };
  }

  remember(conversationKey, value, valueConnectorIdentity) {
    if (!CONVERSATION_KEY_PATTERN.test(conversationKey || "")) return false;
    const url = canonicalChatGptConversationUrl(value);
    const connector = connectorIdentity(valueConnectorIdentity);
    if (!url || connector === undefined) return false;
    this.load();
    const next = new Map(this.conversations);
    next.delete(conversationKey);
    next.set(conversationKey, {
      url,
      connectorIdentity: connector,
      updatedAt: this.now(),
    });
    while (next.size > MAX_RETAINED_CONVERSATIONS) {
      const oldest = next.keys().next().value;
      if (!oldest) break;
      next.delete(oldest);
    }
    this.persist(next);
    this.conversations = next;
    return true;
  }

  delete(conversationKey) {
    if (!CONVERSATION_KEY_PATTERN.test(conversationKey || "")) return false;
    this.load();
    const next = new Map(this.conversations);
    if (!next.delete(conversationKey)) return false;
    this.persist(next);
    this.conversations = next;
    return true;
  }

  clear() {
    this.load();
    const next = new Map();
    this.persist(next);
    this.conversations = next;
  }
}

module.exports = {
  MAX_RETAINED_CONVERSATIONS,
  RetainedConversationStore,
  canonicalChatGptConversationUrl,
};
