import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mock } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptBrowserUiHealthTracker,
  ChatGptBrowserWorker,
  chatGptExternalProgressSuppressesDomHealth,
} from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexParsedRequest } from "../src/types";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, notifyLauncherTurn } from "../src/launcher-browser-host";

function retainedRetirementFixture() {
  const require = createRequire(import.meta.url);
  const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
  const closed: string[] = [];
  const tab = (id: string, traceId: string, helperPid: number, status: string) => ({
    id, traceId, helperPid, status, interactionMode: "automatic", surfaceId: "a".repeat(32),
    conversationKey: "b".repeat(64), connectorIdentity: "Codex Native2", connectorBound: true,
    rendererHealth: "responsive" as "responsive" | "unresponsive",
    rendererStateChangedAt: Date.now(),
    view: { webContents: {
      isDestroyed: () => closed.includes(id), setBackgroundThrottling() {}, close: () => { closed.push(id); },
    } },
  });
  const retained = tab("retained-tab", "source-trace", process.pid, "ready");
  const unrelated = tab("unrelated-tab", "unrelated-trace", process.pid + 1, "running");
  unrelated.conversationKey = "c".repeat(64);
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[retained.id, retained], [unrelated.id, unrelated]]),
    closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    logger: { info() {}, warn() {}, error() {} },
    window: { contentView: { removeChildView() {} } },
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, writeDescriptor() {}, snapshot: () => ({}),
  });
  return { host, retained, unrelated, closed };
}

test.each([
  [false, false], [true, false], [false, true], [true, true],
])("a stuck retained helper retires only its owned tab within the independent cleanup budget (accepted=%s, stalled end acknowledgement=%s)", async (accepted, stalledEnd) => {
  // Removing the independent scoped cleanup caller must fail this test. Keep real helper-client
  // abort handling and real BrowserHost ownership/removal; simulate only the helper IPC/browser.
  const { host, retained, unrelated, closed } = retainedRetirementFixture();
  const traceId = "retained_timeout_retirement";
  const helperPid = process.pid + 2;
  let releaseEnd!: () => void;
  const endGate = new Promise<void>(resolve => { releaseEnd = resolve; });
  const originalEnd = host.endTurn.bind(host);
  host.endTurn = async (...args: unknown[]) => {
    const result = await originalEnd(...args);
    if (stalledEnd) await endGate;
    return result;
  };
  const root = mkdtempSync(join(tmpdir(), "compaction-retirement-"));
  const { BrowserControlServer } = createRequire(import.meta.url)("../launcher/electron/control-server.cjs");
  const server = await new BrowserControlServer({
    logger: host.logger, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    endpoint: server.descriptor().endpoint, control: server.descriptor(),
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: { ["a".repeat(32)]: "owned-target" },
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol", stream: true, context: { messages: [] }, options: { reasoning: "high" },
  };
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"), physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    conversationKey: retained.conversationKey, cancel() {},
  });
  const config = {
    appName: "Codex Native2", browserHost: "launcher" as const, browserHostDescriptorPath: descriptorPath,
    storageStatePath: "unused-state.json", chromeExecutablePath: "unused-chrome", headed: true,
    autoApproveToolCalls: false, useSavedChats: true,
  };
  const client = new LauncherBrowserHelperClient(config);
  const child = { pid: helperPid };
  const internal = client as any;
  internal.child = child;
  internal.ensureChild = async () => {};
  let aborted = false;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  internal.send = async (message: any) => {
    if (message.type === "run") {
      await host.beginTurn(traceId, false, helperPid, retained.conversationKey, config.appName, true);
      internal.handleLine(child, JSON.stringify({ type: "event", id: traceId, event: "prepared_selected", reused: true }));
    } else if (message.type === "prepared_selected_ack") {
      internal.handleLine(child, JSON.stringify({ type: "event", id: traceId, event: "send_activated" }));
    } else if (message.type === "send_activation_ack") started();
    else if (message.type === "abort") {
      // The worker's stuck browser/CDP promise does not settle or reach its turn-end finally.
      aborted = true;
    }
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config, launcherHelper: client, activeRuns: new Map(),
  });
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control_fixture", handoffId: "handoff_fixture" }),
    waitForCompactionHandoff: async () => {
      await receiptGate;
      return accepted ? "Committed checkpoint" : new Promise<string>(() => {});
    }, abortCompactionTransaction() {},
  } as unknown as TurnBroker;
  let submitReceipt!: () => void;
  const receiptGate = new Promise<void>(resolve => { submitReceipt = resolve; });
  let physicallySettled = false;
  let retainedSettlements = 0;
  const diagnostics: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")); };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const outcome = requestRetainedCompactionHandoff(
      worker, parsed, source, broker,
      { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true }, traceId,
      undefined, accepted ? 300_000 : 25, undefined, settlement => {
        // The first gate is the actual browser, independently of bounded cleanup work.
        if (retainedSettlements++ === 0) void settlement.then(() => { physicallySettled = true; });
      },
    ).catch(error => error);
    await ready;
    expect(host.heartbeatTurn(traceId, helperPid)).toMatchObject({ rendererHealth: "responsive" });
    // A replacement child must never supply the cleanup PID for this dispatched turn.
    internal.child = { pid: helperPid + 10 };
    submitReceipt();
    await Bun.sleep(0);
    if (!accepted) mock.timers.tick(25);
    await Bun.sleep(0);
    expect(aborted).toBeTrue();
    expect(physicallySettled).toBeFalse();
    for (let attempt = 0; attempt < 100 && host.turnTabs.has(retained.id); attempt++) await Bun.sleep(5);
    let logicalSettled = false;
    void outcome.then(() => { logicalSettled = true; });
    mock.timers.tick(14_999);
    await Bun.sleep(0);
    if (accepted) expect(logicalSettled).toBeFalse();
    expect(diagnostics.some(line => line.includes("retained_compaction_cleanup_timeout"))).toBeFalse();
    mock.timers.tick(1);
    await Bun.sleep(0);
    expect(logicalSettled).toBeTrue();
    if (accepted) expect(await outcome).toBe("Committed checkpoint");
    else expect(await outcome).toMatchObject({ code: "compaction_handoff_timeout", phase: "waiting_for_control_handoff" });
    expect(host.turnTabs.has(retained.id)).toBeFalse();
    expect(closed).toEqual([retained.id]);
    expect(host.turnTabs.get(unrelated.id)).toBe(unrelated);
    await expect(notifyLauncherTurn(descriptorPath, { phase: "heartbeat", traceId, helperPid }))
      .rejects.toThrow(/already released|ownership mismatch/);
    await expect(notifyLauncherTurn(descriptorPath, {
      phase: "heartbeat", traceId: unrelated.traceId, helperPid: unrelated.helperPid,
    })).resolves.toMatchObject({ rendererHealth: "responsive" });
    // Physical tab retirement alone must not counterfeit the real helper's settlement.
    expect(physicallySettled).toBeFalse();
    expect(diagnostics.some(line => line.includes("retained_compaction_cleanup_timeout")
      && line.includes('"timeoutMs":15000'))).toBeTrue();
    expect(retainedSettlements).toBe(2);
  } finally {
    mock.timers.reset();
    releaseEnd();
    if (host.turnTabs.has(retained.id)) await host.endTurn(traceId, helperPid, "aborted", false);
    internal.child = child;
    internal.handleLine(child, JSON.stringify({ type: "error", id: traceId, name: "AbortError", message: "fixture helper settled" }));
    await Bun.sleep(0);
    await server.close();
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing scoped endTurn retires a stuck retained owner and rejects its later heartbeats without touching another owner", async () => {
  const { host, retained, unrelated, closed } = retainedRetirementFixture();
  const traceId = "retained_scoped_end";
  const helperPid = process.pid + 2;
  await host.beginTurn(traceId, false, helperPid, retained.conversationKey, "Codex Native2", true);
  await expect(host.endTurn(traceId, helperPid + 1, "aborted", false)).rejects.toThrow("helper ownership mismatch");
  expect(closed).toEqual([]);
  await expect(host.endTurn(traceId, helperPid, "aborted", false)).resolves.toEqual({ cancelledByUser: false });
  expect(closed).toEqual([retained.id]);
  expect(host.turnTabs.has(retained.id)).toBeFalse();
  expect(host.turnTabs.get(unrelated.id)).toBe(unrelated);
  expect(() => host.heartbeatTurn(traceId, helperPid)).toThrow(/already released|ownership mismatch/);
  expect(host.heartbeatTurn(unrelated.traceId, unrelated.helperPid)).toMatchObject({ rendererHealth: "responsive" });
});

test("an in-process launcher retirement handle cannot end a later turn reusing its trace and PID", async () => {
  // Keep runExclusive and authenticated control calls real. Only browser work is replaced.
  const { host, retained } = retainedRetirementFixture();
  host.browserInteractionMode = () => "automatic";
  const root = mkdtempSync(join(tmpdir(), "compaction-owner-reuse-"));
  const { BrowserControlServer } = createRequire(import.meta.url)("../launcher/electron/control-server.cjs");
  const server = await new BrowserControlServer({
    logger: host.logger, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    endpoint: server.descriptor().endpoint, control: server.descriptor(),
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: { ["a".repeat(32)]: "owned-target" },
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  let retire!: (signal: AbortSignal) => Promise<void>;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptorPath, appName: "Codex Native2" },
    runBrowserTurn: async () => "completed",
  });
  try {
    await worker.runExclusive({
      traceId: "trace_reused_in_process", modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      conversationKey: retained.conversationKey, requireRetainedConversation: true,
      prepareResume: async () => ({ text: "checkpoint", images: [], release() {} }),
      onBrowserRetirementAvailable: (handle: typeof retire) => { retire = handle; },
    });
    const successor = { ...retained, id: "successor-tab", status: "running" };
    host.turnTabs.set(successor.id, successor);
    await retire(new AbortController().signal);
    expect(host.turnTabs.get(successor.id)).toBe(successor);
    expect(host.heartbeatTurn(successor.traceId, successor.helperPid)).toMatchObject({ rendererHealth: "responsive" });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  [true, false, true, false, false],
  [false, false, true, false, false],
  [true, true, true, false, false],
  [true, false, false, false, false],
  [true, false, true, true, false],
  [true, true, false, false, true],
])("browser turns preserve recovery, ordering and final-only tools (owned=%s, tools=%s, multipart=%s, size rejected=%s, retained=%s)", async (owned, tools, multipart, sizeRejected, retained) => {
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
  let freshChatPreparations = 0;
  let rejectionAbortedWait = false;
  const frame = {};
  const page = Object.assign(new EventEmitter(), { evaluate: async () => ({}), isClosed: () => false, mainFrame: () => frame });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    runStage: async (_trace: string, name: string, timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      if (name === "send" || name.endsWith("_send")) sendBudgets.push(timeout);
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => { freshChatPreparations += 1; },
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
      expect(typeof lifecycle.onSubmitted).toBe("function");
      await lifecycle.onSendActivated();
      if (cancellationCase || (sizeRejected && stage === "multipart_stage_2_send")) {
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
      if (sizeRejected && stage === "multipart_stage_2_acknowledgement") {
        const signal = args[3] as AbortSignal;
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("rejected stage kept waiting")), 250);
          const onAbort = () => { clearTimeout(timer); rejectionAbortedWait = true; reject(signal.reason); };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      return {};
    },
    waitForMultipartAcknowledgement: async () => { actions.push("ack"); },
  });
  if (retained) {
    // Exercise the real attachment path: the previous Send cleared its mention,
    // even though this conversation still belongs to the same launcher task.
    let connectorSelected = false;
    const composer = {
      fill: async () => { connectorSelected = false; },
      focus: async () => {}, press: async () => {},
    };
    const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
    Object.assign(page, { locator: () => absentDialog });
    Object.assign(worker, {
      attachPrompt: (ChatGptBrowserWorker.prototype as any).attachPrompt,
      attachPromptWithCompactionRetry: (ChatGptBrowserWorker.prototype as any).attachPromptWithCompactionRetry,
      activeComposer: async () => composer,
      selectConnector: async () => { connectorSelected = true; actions.push("attach:tools"); return composer; },
      insertPromptText: async () => { expect(connectorSelected).toBeTrue(); },
      assertPromptAttached: async () => {},
      clearChatGptComposerState: async () => { connectorSelected = false; },
    });
  }
  const prepare = async () => ({ text: "Summarize the context", images: [], multipart: multipart ? { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "Summarize" } : undefined, release: () => { released = true; } });
  try {
    const run = worker.runBrowserTurn({
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
      prepare,
      prepareResume: prepare,
    }, owned ? "owned-surface" : undefined, page, retained);
    if (sizeRejected) {
      await expect(run).rejects.toMatchObject({ code: "chatgpt_message_length_exceeds_limit", retryable: false });
      expect(rejectionAbortedWait).toBeTrue();
      expect(sendBudgets).toHaveLength(3);
      expect(actions).toContain("effort:max");
      expect(actions.filter(action => action === "ack")).toHaveLength(1);
      expect(released).toBeTrue();
      expect(page.listenerCount("request")).toBe(0);
      expect(page.listenerCount("response")).toBe(0);
      return;
    }
    await expect(run).rejects.toBe(finalResponse);
    expect(freshChatPreparations).toBe(retained ? 0 : 1);
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

test("incident regression: degraded UI with active MCP followed by timed-out retained compaction retires browser and rejects stale handoff", async () => {
  // 1. Browser turn is active and has recent MCP tool activity.
  const { host, retained, unrelated, closed } = retainedRetirementFixture();
  const sourceTraceId = "source_active_trace";
  const sourceHelperPid = process.pid + 1;
  retained.traceId = sourceTraceId;
  retained.helperPid = sourceHelperPid;
  retained.status = "running";

  const brokerRoot = mkdtempSync(join(tmpdir(), "broker-incident-"));
  const brokerEndpoint = defaultBrokerEndpoint(brokerRoot);
  const broker = TurnBroker.forSocket(brokerEndpoint);

  const launcherRoot = mkdtempSync(join(tmpdir(), "launcher-incident-"));
  const { BrowserControlServer } = createRequire(import.meta.url)("../launcher/electron/control-server.cjs");
  const server = await new BrowserControlServer({
    logger: host.logger, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const descriptorPath = join(launcherRoot, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    endpoint: server.descriptor().endpoint, control: server.descriptor(),
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: { ["a".repeat(32)]: "owned-target" },
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const progress = new ChatGptExternalTurnProgress();
  progress.recordToolBatch(1);
  progress.recordToolResult();
  expect(chatGptExternalProgressSuppressesDomHealth(progress.snapshot(), Date.now())).toBeTrue();

  // Register active turn on broker
  const env = {
    cwd: brokerRoot, roots: [brokerRoot], writableRoots: [brokerRoot],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
  };
  const turnToken = await broker.register(env, 60_000, sourceTraceId);
  const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token: turnToken });

  // 2. Response DOM observation times out and same-page recovery/rebind is attempted.
  // 3. Renderer/UI health becomes degraded or unresponsive while backend liveness remains active.
  const uiTransitions: unknown[] = [];
  const uiTracker = new ChatGptBrowserUiHealthTracker(transition => {
    uiTransitions.push(transition);
  });
  uiTracker.record("dom-observation-timeout", Date.now());
  expect(uiTracker.current()).toBe("degraded");

  // Renderer event loop reports unresponsive
  retained.rendererHealth = "unresponsive";
  retained.rendererStateChangedAt = Date.now();
  uiTracker.record("renderer-unresponsive", Date.now());
  expect(uiTracker.current()).toBe("unresponsive");

  // Assert: Backend progress remains active while UI is unresponsive
  expect(chatGptExternalProgressSuppressesDomHealth(progress.snapshot(), Date.now())).toBeTrue();
  expect(uiTracker.current()).toBe("unresponsive");

  // Heartbeat returns unresponsive renderer health without implying UI is healthy
  const initialHeartbeat = host.heartbeatTurn(sourceTraceId, sourceHelperPid);
  expect(initialHeartbeat.rendererHealth).toBe("unresponsive");
  expect(uiTracker.current()).not.toBe("responsive");

  // 4. Context compaction starts.
  await broker.requestCompaction(turnToken, {
    content: [{ type: "text", text: "Codex context compaction started" }],
    isError: true,
  });

  // 5. A post-compaction MCP/control interaction occurs.
  const postCompactionMcp = await callTurnBroker<{ content: Array<{ text: string }> }>(broker.socketPath, {
    method: "invoke", bindingId: claimed.bindingId, wireName: "exec_command",
  });
  expect(postCompactionMcp.content[0].text).toContain("Codex context compaction started");
  expect(broker.compactionDeliveryCount(turnToken)).toBe(1);

  // Source response settles and retains the tab for the compaction handoff
  retained.status = "ready";

  // 6. Structured retained handoff never reaches commit before the logical deadline.
  const retainedTraceId = "retained_handoff_trace";
  const retainedHelperPid = process.pid + 5;
  const config = {
    appName: "Codex Native2", browserHost: "launcher" as const, browserHostDescriptorPath: descriptorPath,
    storageStatePath: "unused-state.json", chromeExecutablePath: "unused-chrome", headed: true,
    autoApproveToolCalls: false, useSavedChats: true,
  };
  const client = new LauncherBrowserHelperClient(config);
  const child = { pid: retainedHelperPid };
  const internal = client as any;
  internal.child = child;
  internal.ensureChild = async () => {};
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let helperAborted = false;
  internal.send = async (message: any) => {
    if (message.type === "run") {
      await host.beginTurn(retainedTraceId, false, retainedHelperPid, retained.conversationKey, config.appName, true);
      internal.handleLine(child, JSON.stringify({ type: "event", id: retainedTraceId, event: "prepared_selected", reused: true }));
    } else if (message.type === "prepared_selected_ack") {
      internal.handleLine(child, JSON.stringify({ type: "event", id: retainedTraceId, event: "send_activated" }));
    } else if (message.type === "send_activation_ack") {
      started();
    } else if (message.type === "abort") {
      helperAborted = true;
    }
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config, launcherHelper: client, activeRuns: new Map(),
  });
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol", stream: true, context: { messages: [] }, options: { reasoning: "high" },
  };
  const sourceSession = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"), physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    conversationKey: retained.conversationKey, cancel() {},
  });

  mock.timers.enable({ apis: ["setTimeout"] });
  let handoffTransaction: { token: string; handoffId: string } | undefined;
  const originalBegin = broker.beginCompactionTransaction.bind(broker);
  broker.beginCompactionTransaction = async (tId: string, ttlMs?: number) => {
    const handle = await originalBegin(tId, ttlMs);
    handoffTransaction = handle;
    return handle;
  };

  try {
    const handoffOutcome = requestRetainedCompactionHandoff(
      worker, parsed, sourceSession, broker,
      { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      retainedTraceId, undefined, 25,
    ).catch(error => error);

    await ready;
    // Advance beyond logical handoff deadline (25ms)
    mock.timers.tick(25);
    await Bun.sleep(0);

    const caught = await handoffOutcome;
    // Assert timeout identifies the compaction phase
    expect(caught).toMatchObject({
      code: "compaction_handoff_timeout",
      phase: "waiting_for_control_handoff",
    });
    expect(helperAborted).toBeTrue();

    // 7. The compaction transaction expires: stale handoff cannot commit afterward
    expect(handoffTransaction).toBeDefined();
    await expect(callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: handoffTransaction!.token,
      handoffId: handoffTransaction!.handoffId,
      summary: "late summary after timeout",
    })).rejects.toThrow("compaction control token is invalid, expired, or consumed");

    // 8. The owned browser turn is retired within the cleanup deadline.
    // Advance timer by cleanup deadline (15,000ms)
    mock.timers.tick(15_000);
    await Bun.sleep(0);

    expect(host.turnTabs.has(retained.id)).toBeFalse();
    expect(closed).toContain(retained.id);
    expect(host.turnTabs.has(unrelated.id)).toBeTrue();

    // Assert no long-lived heartbeat stream remains after cleanup
    await expect(notifyLauncherTurn(descriptorPath, { phase: "heartbeat", traceId: retainedTraceId, helperPid: retainedHelperPid }))
      .rejects.toThrow(/already released|ownership mismatch/);

    // Unrelated turn heartbeat remains healthy
    await expect(notifyLauncherTurn(descriptorPath, {
      phase: "heartbeat", traceId: unrelated.traceId, helperPid: unrelated.helperPid,
    })).resolves.toMatchObject({ rendererHealth: "responsive" });
  } finally {
    mock.timers.reset();
    internal.child = child;
    if (host.turnTabs.has(retained.id)) await host.endTurn(retainedTraceId, retainedHelperPid, "aborted", false);
    internal.handleLine(child, JSON.stringify({ type: "error", id: retainedTraceId, name: "AbortError", message: "settled" }));
    await Bun.sleep(0);
    await server.close();
    await broker.close();
    rmSync(brokerRoot, { recursive: true, force: true });
    rmSync(launcherRoot, { recursive: true, force: true });
  }
});
