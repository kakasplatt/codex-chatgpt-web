import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHATGPT_COMPLETION_SETTLE_MS, CHATGPT_RESPONSE_DOM_GRACE_MS, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test.each([[true, false, true], [false, false, true], [true, true, true], [true, false, false]])("browser turns preserve recovery, ordering and final-only tools (owned=%s, tools=%s, multipart=%s)", async (owned, tools, multipart) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "compaction-observation-"));
  const cancellationCase = owned && !tools && !multipart;
  const effort = tools ? "xhigh" : "high";
  const finalResponse = cancellationCase ? chatGptBrowserTabClosedError() : new Error("fixture reached final response observation");
  const capabilities = { localToolsEnabled: tools, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const progress = tools ? new ChatGptExternalTurnProgress() : undefined;
  const recoveryCallbacks: unknown[] = [];
  const actions: string[] = [];
  const sendBudgets: number[] = [];
  let stage = "";
  let released = false;
  let activated = 0;
  const frame = {};
  const page = Object.assign(new EventEmitter(), { evaluate: async () => ({}), isClosed: () => false, mainFrame: () => frame });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    runStage: async (_trace: string, name: string, timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      if (name === "send" || name.endsWith("_send")) sendBudgets.push(timeout);
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string, _capabilities: unknown,
      _diagnostic: unknown, trackUsage: boolean, family: string) => {
      expect(trackUsage).toBe(false);
      expect(family).toBe("5.6");
      actions.push(`effort:${effort}`);
      return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    captureSubmissionBaseline: async () => ({}),
    attachPrompt: async (_page: unknown, _text: string, localTools: boolean) => {
      expect(localTools).toBe(false);
      actions.push("attach:plain");
    },
    attachPromptWithCompactionRetry: async (_page: unknown, _text: string, localTools: boolean) => {
      expect(localTools).toBe(tools);
      actions.push(localTools ? "attach:tools" : "attach:plain");
    },
    attachFiles: async () => { actions.push("files"); },
    sendAttachedPrompt: async (...args: unknown[]) => {
      // Context ingestion cannot mistake tool activity for acknowledgement of a part.
      expect(args[4]).toBe(stage === "send" ? progress : undefined);
      const lifecycle = args[5] as { onSendActivated(): Promise<void>; onSubmitted?: () => void };
      if (stage !== "send") expect(lifecycle.onSubmitted).toBeUndefined();
      await lifecycle.onSendActivated();
      if (cancellationCase) {
        // An observed size rejection must not replace the user's explicit tab-close verdict.
        const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
        page.emit("request", request);
        page.emit("response", {
          request: () => request, status: () => 413, headers: () => ({ "content-type": "application/json" }),
          json: async () => ({ detail: { code: "message_length_exceeds_limit" } }),
        });
      }
      recoveryCallbacks.push(args[7]);
      actions.push("send");
      return "user_turn";
    },
    waitForNewAssistantTurn: async (...args: unknown[]) => {
      expect(args[4]).toBe(stage === "send" ? progress : undefined);
      recoveryCallbacks.push(args[7]);
      actions.push("observe");
      if (stage === "send") throw finalResponse;
      return {};
    },
    waitForMultipartAcknowledgement: async () => { actions.push("ack"); },
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: "compaction_recovery_fixture",
      modelId: "gpt-5.6-sol",
      modelFamily: "5.6",
      reasoning: effort,
      onSendActivated: () => { activated += 1; },
      capabilities,
      compaction: !tools,
      externalProgress: progress,
      completionFence: tools ? {
        begin: async () => { throw new Error("fixture must stop before completion"); },
        commit: async () => { throw new Error("fixture must stop before completion"); },
      } : undefined,
      prepare: async () => ({ text: "Summarize the context", images: [], multipart: multipart ? { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "Summarize" } : undefined, release: () => { released = true; } }),
    }, owned ? "owned-surface" : undefined, page)).rejects.toBe(finalResponse);
    expect(recoveryCallbacks.map(callback => typeof callback)).toEqual(
      Array(multipart ? 12 : 2).fill(owned ? "function" : "undefined"),
    );
    expect(actions).toEqual([
      ...(multipart ? [
        "effort:medium",
        ...Array.from({ length: 5 }, (_, index) => [
          ...(index > 0 ? ["effort:medium"] : []), "attach:plain", "send", "observe", "ack",
        ]).flat(),
      ] : []),
      `effort:${effort}`,
      tools ? "attach:tools" : "attach:plain", "files", "send", "observe",
    ]);
    expect(sendBudgets).toEqual(multipart ? Array(6).fill(180_000) : [60_000]);
    expect(released).toBe(true);
    expect(activated).toBe(1);
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});

test("an accepted main response recovers a semantic stall without resending", async () => {
  const diagnostics = mkdtempSync(join(tmpdir(), "accepted-response-recovery-"));
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const hiddenLocator = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    getByText() { return this; },
    getByTestId() { return this; },
    isVisible: async () => false,
    count: async () => 0,
    press: async () => {},
  };
  const firstResponseLocator = { ...hiddenLocator, count: async () => 1 };
  const reboundResponseLocator = { ...hiddenLocator, count: async () => 1 };
  const frame = {};
  const makePage = (name: string, responseLocator: typeof firstResponseLocator) => Object.assign(new EventEmitter(), {
    name,
    url: () => "https://chatgpt.com/c/accepted-response",
    isClosed: () => false,
    mainFrame: () => frame,
    evaluate: async () => ({}),
    locator: (selector: string) => selector.includes("data-turn-key") ? responseLocator : hiddenLocator,
  });
  const firstPage = makePage("first", firstResponseLocator);
  const reboundPage = makePage("rebound", reboundResponseLocator);
  const fakeBrowser = { close: async () => {} };
  const responseIdentity = "group:assistant:accepted";
  const binding = {
    identity: responseIdentity,
    acceptedTurnIdentities: [responseIdentity],
    locator: firstResponseLocator,
  };
  const shell = (status: string) => ({
    responsePresent: true,
    assistantSurfacePresent: true,
    visibleText: "",
    fullHtml: "",
    markdownSegments: [],
    completionActionVisible: false,
    stoppedThinkingVisible: false,
    traceBlocks: [{ kind: "status" as const, text: status }],
  });
  const completed = {
    responsePresent: true,
    assistantSurfacePresent: true,
    visibleText: "Done",
    fullHtml: "<p>Done</p>",
    markdownSegments: [{ key: "answer", tag: "p", html: "<p>Done</p>", text: "Done", streamable: true }],
    completionActionVisible: true,
    stoppedThinkingVisible: false,
    traceBlocks: [{ kind: "answer" as const, text: "Done" }],
  };

  let now = 1_000;
  const realNow = Date.now;
  let sends = 0;
  let rebinds = 0;
  let preRecoveryObservations = 0;
  let recovered = false;
  let released = false;
  const textDeltas: string[] = [];
  Date.now = () => now;

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, browserHostDescriptorPath: "owned-descriptor" },
    runStage: async (_trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      if (name.startsWith("response_page_rebind_")) {
        rebinds += 1;
        recovered = true;
        return { browser: fakeBrowser, page: reboundPage };
      }
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => (
      resolveChatGptWebModelMode(model, effort, capabilities)
    ),
    assertSelectedEffort: async () => {},
    captureSubmissionBaseline: async () => ({ initialTurnIdentities: [], domCache: {}, submittedText: "prompt" }),
    attachPromptWithCompactionRetry: async () => {},
    attachFiles: async () => {},
    sendAttachedPrompt: async (...args: unknown[]) => {
      sends += 1;
      const lifecycle = args[5] as { onSendActivated(): Promise<void>; onSubmitted?: () => void };
      await lifecycle.onSendActivated();
      lifecycle.onSubmitted?.();
      return "user_turn";
    },
    waitForNewAssistantTurn: async () => binding,
    reconcileAssistantTurnBinding: async () => binding,
    responseDomSnapshot: async () => {
      if (recovered) {
        now += CHATGPT_COMPLETION_SETTLE_MS + 1;
        return completed;
      }
      preRecoveryObservations += 1;
      now += CHATGPT_RESPONSE_DOM_GRACE_MS + 1;
      return preRecoveryObservations === 1 ? shell("phase A") : shell("phase B");
    },
  });

  try {
    await expect(worker.runBrowserTurn({
      traceId: "accepted_response_recovery",
      modelId: "gpt-5.6-sol",
      modelFamily: "5.6",
      reasoning: "high",
      capabilities,
      prepare: async () => ({ text: "prompt", images: [], release: () => { released = true; } }),
      onTextDelta: (delta: string) => { textDeltas.push(delta); },
    }, "owned-surface", firstPage)).resolves.toBe("Done");
    expect(sends).toBe(1);
    expect(rebinds).toBe(1);
    expect(preRecoveryObservations).toBeGreaterThanOrEqual(4);
    expect(textDeltas.join("")).toBe("Done");
    expect(released).toBe(true);
  } finally {
    Date.now = realNow;
    rmSync(diagnostics, { recursive: true, force: true });
  }
});

test("presentation-only response churn cannot reset the accepted-response rebind budget", async () => {
  const diagnostics = mkdtempSync(join(tmpdir(), "accepted-response-rebind-budget-"));
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const hiddenLocator = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    getByText() { return this; },
    getByTestId() { return this; },
    isVisible: async () => false,
    count: async () => 0,
    press: async () => {},
  };
  const responseLocator = { ...hiddenLocator, count: async () => 1 };
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    url: () => "https://chatgpt.com/c/accepted-response-budget",
    isClosed: () => false,
    mainFrame: () => frame,
    evaluate: async () => ({}),
    locator: (selector: string) => selector.includes("data-turn-key") ? responseLocator : hiddenLocator,
  });
  const fakeBrowser = { close: async () => {} };
  const responseIdentity = "group:assistant:accepted-budget";
  const binding = {
    identity: responseIdentity,
    acceptedTurnIdentities: [responseIdentity],
    locator: responseLocator,
  };
  let now = 1_000;
  const realNow = Date.now;
  let sends = 0;
  let rebinds = 0;
  let released = false;
  Date.now = () => now;

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, browserHostDescriptorPath: "owned-descriptor" },
    runStage: async (_trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      if (name.startsWith("response_page_rebind_")) {
        rebinds += 1;
        if (rebinds > 4) throw new Error("rebind budget was reset by presentation churn");
        return { browser: fakeBrowser, page };
      }
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => (
      resolveChatGptWebModelMode(model, effort, capabilities)
    ),
    assertSelectedEffort: async () => {},
    captureSubmissionBaseline: async () => ({ initialTurnIdentities: [], domCache: {}, submittedText: "prompt" }),
    attachPromptWithCompactionRetry: async () => {},
    attachFiles: async () => {},
    sendAttachedPrompt: async (...args: unknown[]) => {
      sends += 1;
      const lifecycle = args[5] as { onSendActivated(): Promise<void>; onSubmitted?: () => void };
      await lifecycle.onSendActivated();
      lifecycle.onSubmitted?.();
      return "user_turn";
    },
    waitForNewAssistantTurn: async () => binding,
    reconcileAssistantTurnBinding: async () => binding,
    responseDomSnapshot: async () => {
      now += 1_000_000;
      return {
        responsePresent: true,
        assistantSurfacePresent: true,
        visibleText: "",
        fullHtml: "",
        markdownSegments: [],
        completionActionVisible: rebinds % 2 === 1,
        stoppedThinkingVisible: false,
        traceBlocks: [],
      };
    },
  });

  try {
    await expect(worker.runBrowserTurn({
      traceId: "accepted_response_rebind_budget",
      modelId: "gpt-5.6-sol",
      modelFamily: "5.6",
      reasoning: "high",
      capabilities,
      prepare: async () => ({ text: "prompt", images: [], release: () => { released = true; } }),
      onTextDelta: () => {},
    }, "owned-surface", page)).rejects.toThrow("after 2 same-page rebinds");
    expect(sends).toBe(1);
    expect(rebinds).toBe(2);
    expect(released).toBe(true);
  } finally {
    Date.now = realNow;
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
