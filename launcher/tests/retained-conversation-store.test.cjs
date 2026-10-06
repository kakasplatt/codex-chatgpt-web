const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_RETAINED_CONVERSATIONS,
  RetainedConversationStore,
  canonicalChatGptConversationUrl,
} = require("../electron/retained-conversation-store.cjs");

test("canonical retained URLs keep only durable ChatGPT conversation identity", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    canonicalChatGptConversationUrl(`https://chatgpt.com/c/${id}?model=gpt-5#answer`),
    `https://chatgpt.com/c/${id}`,
  );
  assert.equal(canonicalChatGptConversationUrl(`https://chatgpt.com/c/${id}?temporary-chat=true`), undefined);
  assert.equal(canonicalChatGptConversationUrl("https://chatgpt.com/"), undefined);
  assert.equal(canonicalChatGptConversationUrl(`https://example.com/c/${id}`), undefined);
});

test("retained conversations persist across store instances and stay connector-bound", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retained-conversations-"));
  const file = path.join(dir, "retained-conversations.json");
  const key = "a".repeat(64);
  const url = "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001?model=gpt-5";
  try {
    const store = new RetainedConversationStore(file, () => 1234);
    assert.equal(store.remember(key, url, "Codex Native2"), true);

    const reloaded = new RetainedConversationStore(file, () => 5678);
    assert.deepEqual(reloaded.get(key, "Codex Native2"), {
      url: "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001",
      connectorIdentity: "Codex Native2",
      updatedAt: 1234,
    });
    assert.equal(reloaded.get(key, "Other Connector"), undefined);
    assert.equal(reloaded.delete(key), true);
    assert.equal(new RetainedConversationStore(file).get(key, "Codex Native2"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retained conversation store ignores malformed state and bounds old entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retained-conversations-"));
  const file = path.join(dir, "retained-conversations.json");
  try {
    fs.writeFileSync(file, "{ malformed", "utf8");
    const store = new RetainedConversationStore(file, (() => {
      let now = 0;
      return () => ++now;
    })());
    assert.equal(store.get("a".repeat(64), "Codex Native2"), undefined);
    for (let index = 0; index <= MAX_RETAINED_CONVERSATIONS; index += 1) {
      const key = index.toString(16).padStart(64, "0");
      assert.equal(store.remember(
        key,
        `https://chatgpt.com/c/00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        "Codex Native2",
      ), true);
    }
    assert.equal(store.get("0".repeat(64), "Codex Native2"), undefined);
    assert.equal(store.get(MAX_RETAINED_CONVERSATIONS.toString(16).padStart(64, "0"), "Codex Native2")?.url,
      `https://chatgpt.com/c/00000000-0000-4000-8000-${MAX_RETAINED_CONVERSATIONS.toString().padStart(12, "0")}`);
    store.clear();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, conversations: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retained conversation mutations keep in-memory state transactional when persistence fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retained-conversations-"));
  const file = path.join(dir, "retained-conversations.json");
  const key = "d".repeat(64);
  const connector = "Codex Native2";
  const url = "https://chatgpt.com/c/00000000-0000-4000-8000-000000000099";
  try {
    const store = new RetainedConversationStore(file, () => 1);
    const persist = store.persist.bind(store);
    store.persist = () => { throw new Error("disk unavailable"); };
    assert.throws(() => store.remember(key, url, connector), /disk unavailable/);
    assert.equal(store.get(key, connector), undefined);

    store.persist = persist;
    assert.equal(store.remember(key, url, connector), true);
    assert.equal(store.get(key, connector)?.url, url);

    store.persist = () => { throw new Error("disk unavailable"); };
    assert.throws(() => store.delete(key), /disk unavailable/);
    assert.equal(store.get(key, connector)?.url, url);
    assert.throws(() => store.clear(), /disk unavailable/);
    assert.equal(store.get(key, connector)?.url, url);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
