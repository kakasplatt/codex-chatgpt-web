import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import {
  CHATGPT_THREAD_ALERT_GRACE_MS,
  ChatGptThreadAlertTracker,
  chatGptThreadAlertError,
  chatGptThreadAlertTexts,
} from "../src/adapters/chatgpt-web/browser-worker";

const deliveryTimeout = "A entrega da mensagem atingiu o tempo limite. Tente novamente. Tentar novamente";

function threadDocument(html: string): Document {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  return createDocument(html);
}

function turnOf(document: Document): Element {
  const turn = document.getElementById("turn");
  if (!turn) throw new Error("fixture requires #turn");
  return turn;
}

test("a localized delivery alert after the current turn is reported", () => {
  const document = threadDocument(`<main>
    <section data-turn-key="previous"><div role="alert">Old banner</div></section>
    <section id="turn" data-turn-key="current"><div data-conversation-role="assistant"></div></section>
    <aside role="alert">${deliveryTimeout}</aside>
  </main>`);

  expect(chatGptThreadAlertTexts(turnOf(document))).toEqual([deliveryTimeout]);
});

test("a delivery alert rendered inside the current turn below its activity rows is reported", () => {
  const document = threadDocument(`<main>
    <section id="turn" data-turn-key="current"><div data-conversation-role="assistant"></div>
      <div>Pensando</div>
      <aside role="alert">${deliveryTimeout}</aside>
    </section>
  </main>`);

  expect(chatGptThreadAlertTexts(turnOf(document))).toEqual([deliveryTimeout]);
});

test("the observed 78-character localized delivery alert is not matched by the English terminal-error detector", async () => {
  // Root cause of trace 489e31f82f93: this alert reached only the generic stalled-turn verdict.
  const alertText = "A entrega da mensagem atingiu o tempo limite. Tente novamente.Tentar novamente";
  expect(alertText).toHaveLength(78);
  const { throwIfChatGptTerminalErrorAlert } = await import("../src/adapters/chatgpt-web/browser-worker");
  const document = threadDocument(`<section id="turn"><aside role="alert">${alertText}</aside></section>`);
  const root = turnOf(document);
  const locatorFor = (elements: Element[]): any => ({
    filter: ({ hasText }: { hasText: RegExp }) => locatorFor(elements.filter(e => hasText.test(e.textContent ?? ""))),
    last: () => locatorFor(elements.slice(-1)),
    isVisible: async () => elements.length > 0,
  });
  const scope = {
    locator: (selector: string) => locatorFor(Array.from(root.querySelectorAll(selector))),
    getByTestId: () => locatorFor([]),
  };
  await throwIfChatGptTerminalErrorAlert(scope as any);
});

test("message content and the composer are never thread alerts", () => {
  const document = threadDocument(`<main>
    <section id="turn" data-turn-key="current">
      <div data-markdown-text-style="assistant-message"><p role="alert">${deliveryTimeout}</p></div>
    </section>
    <div data-user-message-bubble><span role="alert">${deliveryTimeout}</span></div>
    <form><div role="alert">${deliveryTimeout}</div></form>
    <div hidden><div role="alert">${deliveryTimeout}</div></div>
  </main>`);

  expect(chatGptThreadAlertTexts(turnOf(document))).toEqual([]);
});

test("a new thread alert fails the turn only after generation and tools stop for the grace period", () => {
  const tracker = new ChatGptThreadAlertTracker();
  const idle = { running: false, externalToolCallsInFlight: false, responseStreamActive: false };

  expect(tracker.update({ ...idle, alerts: [] }, 0)).toBeUndefined();
  expect(tracker.update({ ...idle, alerts: [deliveryTimeout] }, 1_000)).toBeUndefined();
  expect(tracker.update({ ...idle, alerts: [deliveryTimeout] }, 1_000 + CHATGPT_THREAD_ALERT_GRACE_MS - 1))
    .toBeUndefined();
  expect(tracker.update({ ...idle, alerts: [deliveryTimeout] }, 1_000 + CHATGPT_THREAD_ALERT_GRACE_MS))
    .toBe(deliveryTimeout);
});

test.each([
  ["Stop is visible", { running: true }],
  ["a Codex tool call is in flight", { externalToolCallsInFlight: true }],
  ["the response stream is open", { responseStreamActive: true }],
])("a thread alert is not terminal while %s", (_label, activity) => {
  const tracker = new ChatGptThreadAlertTracker();
  const state = { running: false, externalToolCallsInFlight: false, responseStreamActive: false, ...activity };

  tracker.update({ ...state, alerts: [] }, 0);
  for (const now of [1_000, 10_000, 100_000]) {
    expect(tracker.update({ ...state, alerts: [deliveryTimeout] }, now)).toBeUndefined();
  }
});

test("an alert already visible when observation began belongs to an earlier turn", () => {
  const tracker = new ChatGptThreadAlertTracker();
  const idle = { running: false, externalToolCallsInFlight: false, responseStreamActive: false };

  tracker.update({ ...idle, alerts: [deliveryTimeout] }, 0);
  expect(tracker.update({ ...idle, alerts: [deliveryTimeout] }, 60_000)).toBeUndefined();
});

test("renewed activity restarts the alert grace period", () => {
  const tracker = new ChatGptThreadAlertTracker();
  const idle = { running: false, externalToolCallsInFlight: false, responseStreamActive: false };

  tracker.update({ ...idle, alerts: [] }, 0);
  tracker.update({ ...idle, alerts: [deliveryTimeout] }, 1_000);
  tracker.update({ ...idle, running: true, alerts: [deliveryTimeout] }, 2_000);
  expect(tracker.update({ ...idle, alerts: [deliveryTimeout] }, 4_500)).toBeUndefined();
  expect(tracker.update({ ...idle, alerts: [deliveryTimeout] }, 4_500 + CHATGPT_THREAD_ALERT_GRACE_MS))
    .toBe(deliveryTimeout);
});

test("thread alert failures are retryable upstream errors that carry ChatGPT's own text", () => {
  expect(chatGptThreadAlertError(deliveryTimeout)).toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });
  expect(chatGptThreadAlertError(deliveryTimeout).message).toContain(deliveryTimeout);
  expect(chatGptThreadAlertError("x".repeat(1_000)).message.length).toBeLessThan(300);
});

test("the response loop checks thread alerts before the generic stalled-turn verdict", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const alertCheck = workerSource.indexOf("responseTurn.locator.evaluate(chatGptThreadAlertTexts)");
  expect(alertCheck).toBeGreaterThan(-1);
  expect(workerSource.indexOf("const domError = domHealthTracker.update({", alertCheck)).toBeGreaterThan(alertCheck);
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("thread alerts are read from a real rendered thread", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main>
      <section data-turn-key="previous"><div role="alert">Old banner</div></section>
      <section id="turn" data-turn-key="current">
        <div data-markdown-text-style="assistant-message"><p role="alert">quoted</p></div>
      </section>
      <div role="alert" style="display:none">invisible</div>
      <aside role="alert"><span>A entrega da mensagem atingiu o tempo limite.</span>
        <button>Tentar novamente</button></aside>
    </main>`);
    const texts = await page.locator("#turn").evaluate(chatGptThreadAlertTexts);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("A entrega da mensagem atingiu o tempo limite.");
    expect(texts[0]).toContain("Tentar novamente");
  } finally { await browser.close(); }
}, 15_000);
