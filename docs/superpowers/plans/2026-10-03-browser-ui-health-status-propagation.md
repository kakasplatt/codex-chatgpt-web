# Browser UI Health Status Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining PR #10 review gap by surfacing browser UI-health transitions through the existing turn commentary/trace path while keeping browser health independent from Codex/MCP backend liveness.

**Architecture:** Keep `ChatGptBrowserUiHealthTracker` as the single state machine and deduplication boundary. In `ChatGptBrowserWorker.runExclusive()`, translate each real health transition into a stable commentary/status message and continue emitting the existing structured `console.warn` diagnostic; `BrowserTurn.onCommentary` already crosses the helper IPC boundary and is already converted into `ChatGptTraceFeed` commentary, so no new protocol event or global state is needed.

**Tech Stack:** TypeScript, Bun test runner, ChatGPT browser worker/helper IPC, `ChatGptTraceFeed`.

**Spec:** `docs/superpowers/specs/2026-10-01-browser-ui-health-and-compaction-handoff-design.md`

## Global Constraints

- Browser UI health remains `"responsive" | "degraded" | "unresponsive"`; backend/MCP activity must never promote browser UI health back to `responsive`.
- `record("dom-observation-ok")` may recover only `degraded -> responsive`; native `unresponsive` requires `renderer-responsive` for recovery.
- Keep `CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS = 10 * 60_000` unchanged.
- Keep `chatGptExternalProgressSuppressesDomHealth()` behavior unchanged: external progress may postpone a terminal missing-DOM verdict but must not reset the UI-health tracker.
- Emit status only for actual tracker transitions; repeated evidence that leaves the combined health unchanged must remain deduplicated.
- Route health status through the existing `BrowserTurn.onCommentary` -> helper `commentary` event -> `ChatGptTraceFeed` path. Do not add a second IPC/status protocol.
- Preserve `traceId`, browser state, transition reason, and `externalProgressLive` in the existing structured diagnostic.
- Do not change retained-compaction handoff, commit, deadline, or cleanup semantics as part of this correction.
- Preserve unrelated worktree changes and the current branch history; implementation commits must include only files owned by the corresponding task.

## Review Focus

- MCP/backend progress is live while the browser renderer becomes `unresponsive`: the user-facing commentary must still say the browser UI is unresponsive and must never imply the browser is healthy. Covered by Task 1.
- A DOM observation timeout moves the UI to `degraded` without native renderer failure: emit one degraded commentary and no duplicate on repeated timeout evidence. Covered by Task 1.
- Recovery from `degraded -> responsive`: emit exactly one recovery commentary after the successful DOM observation. Covered by Task 1.
- A DOM success while the renderer remains `unresponsive`: do not emit recovery until `renderer-responsive` arrives. Covered by Task 1.
- Out-of-process launcher helper transport: one worker commentary event must cross `browser-helper-main.ts` and `launcher-helper-client.ts` exactly once and appear as adapter commentary rather than final-answer text. Covered by Tasks 2 and 3.

## Observed Integration Path

Graphify discovery against the existing `graphify-out/graph.json` identified `ChatGptBrowserUiHealthTracker` in `browser-worker.ts`, `BrowserTurn`, `browser-helper-main.ts`, `LauncherBrowserHelperClient`, `index.ts`, and `ChatGptTraceFeed`/`TraceWaiter` as the relevant neighborhood. Direct source inspection confirms the material path:

1. `browser-worker.ts` owns `ChatGptBrowserUiHealthTracker` and `BrowserTurn.onCommentary`.
2. `browser-helper-main.ts` serializes `onCommentary` as the existing helper protocol event `event: "commentary"`.
3. `launcher-helper-client.ts` maps that event back to `pending.turn.onCommentary(...)`.
4. `index.ts` pushes `onCommentary` into `ChatGptTraceFeed` as `{ kind: "commentary", text }`.
5. `emitTraceEvents()` emits trace commentary as `{ type: "text_delta", phase: "commentary", text }`.

The correction therefore changes the worker emission point and tests the already-shipped transport instead of introducing another status channel.

---

### Task 1: Surface UI-health transitions from the browser worker

**Files:**
- Modify: `src/adapters/chatgpt-web/browser-worker.ts`
- Test: `tests/browser-worker-contract.test.ts`

**Interfaces:**
- Consumes: `ChatGptBrowserUiHealthTransition`, `BrowserTurn.onCommentary`, and `chatGptExternalProgressSuppressesDomHealth(snapshot, now)`.
- Produces: `formatChatGptBrowserUiHealthStatus(transition: ChatGptBrowserUiHealthTransition): string`, used only for transition commentary; `runExclusive()` emits that message once per tracker transition.
- Preserves: the current structured `console.warn` fields `trace`, `previous`, `current`, `reason`, and `externalProgressLive`.

- [ ] **Step 1: Convert the existing MCP-live degradation contract into a failing commentary test**

  Update `managed browser turns report degraded UI health while MCP progress remains live` in `tests/browser-worker-contract.test.ts` to collect `turn.onCommentary` messages in addition to warnings. Trigger `browserUiHealth.record("dom-observation-timeout", 4_000)` while the mocked external progress remains live and assert:

  ```ts
  expect(commentary).toEqual([
    "ChatGPT browser UI is degraded; Codex/MCP activity may still be running.",
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("current=degraded");
  expect(warnings[0]).toContain("externalProgressLive=true");
  ```

- [ ] **Step 2: Add failing transition-deduplication and recovery tests**

  Add a focused worker test that records `dom-observation-timeout` twice, then `dom-observation-ok` twice through the same tracker created by `runExclusive()`. Assert exactly one degradation message and one recovery message:

  ```ts
  expect(commentary).toEqual([
    "ChatGPT browser UI is degraded; Codex/MCP activity may still be running.",
    "ChatGPT browser UI became responsive again.",
  ]);
  ```

  The repeated same-state evidence must not add commentary or warning transitions.

- [ ] **Step 3: Add a failing native-renderer precedence test**

  Trigger this sequence through the shared tracker: `renderer-unresponsive`, `dom-observation-ok`, `renderer-responsive`. Assert:

  ```ts
  expect(commentary).toEqual([
    "ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running.",
    "ChatGPT browser UI became responsive again.",
  ]);
  ```

  Assert there is no recovery commentary after `dom-observation-ok`; recovery occurs only after `renderer-responsive`.

- [ ] **Step 4: Run the worker contract tests and verify RED**

  Run: `bun test tests/browser-worker-contract.test.ts`

  Expected: the new commentary assertions fail because `runExclusive()` currently logs transitions only with `console.warn`.

- [ ] **Step 5: Implement the stable health-status formatter**

  Add this exact helper in `src/adapters/chatgpt-web/browser-worker.ts` near the tracker types:

  ```ts
  function formatChatGptBrowserUiHealthStatus(
    transition: ChatGptBrowserUiHealthTransition,
  ): string
  ```

  Required outputs:

  - `transition.current === "degraded"` -> `ChatGPT browser UI is degraded; Codex/MCP activity may still be running.`
  - `transition.current === "unresponsive"` -> `ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running.`
  - `transition.current === "responsive"` -> `ChatGPT browser UI became responsive again.`

  Do not include `externalProgressLive` in the formatter's state decision. The wording intentionally keeps browser and backend domains separate even when no current MCP progress sample is live.

- [ ] **Step 6: Emit the status from the existing transition callback**

  In the `ChatGptBrowserUiHealthTracker` callback inside `runExclusive()`:

  1. compute `externalProgressLive` exactly as today;
  2. keep the structured `console.warn` diagnostic unchanged in meaning;
  3. call `turn.onCommentary?.(formatChatGptBrowserUiHealthStatus(transition))` exactly once for that transition.

  Do not add local dedupe state; the tracker callback already runs only when `current !== previous`.

- [ ] **Step 7: Run the worker contract tests and verify GREEN**

  Run: `bun test tests/browser-worker-contract.test.ts`

  Expected: PASS, including degraded, unresponsive, dedupe, and recovery assertions.

- [ ] **Step 8: Commit Task 1**

  ```bash
  git add src/adapters/chatgpt-web/browser-worker.ts tests/browser-worker-contract.test.ts
  git commit -m "fix(browser): surface ui health through turn commentary"
  ```

---

### Task 2: Lock the existing helper commentary transport contract

**Files:**
- Test: `tests/launcher-helper-client.test.ts`
- Source verification only: `src/adapters/chatgpt-web/browser-helper-main.ts`
- Source verification only: `src/adapters/chatgpt-web/launcher-helper-client.ts`

**Interfaces:**
- Consumes: `BrowserTurn.onCommentary(text, continuation?)` from Task 1.
- Produces: regression coverage proving the production helper protocol transports commentary unchanged and once.
- No new protocol type, event name, or source edit is expected. If the test exposes a real transport defect, stop at that evidence and revise the plan before widening source scope.

- [ ] **Step 1: Extend the real-helper lifecycle test with commentary**

  In `daemon streams browser lifecycle through the real helper process`, make the substituted worker emit:

  ```ts
  turn.onCommentary?.("ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running.");
  ```

  Add a `commentary: string[]` collector to the client-side turn and assert:

  ```ts
  expect(commentary).toEqual([
    "ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running.",
  ]);
  ```

  Keep the existing reasoning, multipart, checkpoint, submission, and text assertions intact so the test continues to exercise both sides of the production IPC protocol.

- [ ] **Step 2: Run the helper transport test**

  Run: `bun test tests/launcher-helper-client.test.ts`

  Expected: PASS with no source changes in `browser-helper-main.ts` or `launcher-helper-client.ts`, demonstrating that the existing `commentary` event is sufficient.

- [ ] **Step 3: Commit Task 2**

  ```bash
  git add tests/launcher-helper-client.test.ts
  git commit -m "test(browser): cover helper commentary transport"
  ```

---

### Task 3: Prove browser health commentary reaches the adapter trace and run regression verification

**Files:**
- Test: `tests/chatgpt-web-harness.test.ts`
- Source verification only: `src/adapters/chatgpt-web/index.ts`
- Source verification only: `src/adapters/chatgpt-web/turn-execution.ts`

**Interfaces:**
- Consumes: the `BrowserTurn.onCommentary` event propagated by Tasks 1 and 2.
- Produces: adapter-level evidence that browser UI-health status is emitted as commentary and remains distinct from final-answer text.

- [ ] **Step 1: Add an adapter-level commentary regression**

  Add a focused harness test using the existing `ChatGptBrowserWorker.forProvider(provider)` substitution pattern. The substituted `worker.run(turn)` should emit the unresponsive health status via `turn.onCommentary?.(...)`, then emit a normal final answer via `turn.onTextDelta(...)` and resolve.

  Assert the adapter event stream contains exactly one health commentary event:

  ```ts
  expect(events.filter(
    event => event.type === "text_delta" && event.phase === "commentary",
  )).toContainEqual({
    type: "text_delta",
    phase: "commentary",
    text: "ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running.",
  });
  ```

  Also assert the final answer remains a separate `text_delta` with `phase: "final_answer"`. No event may translate backend activity into a healthy-browser claim.

- [ ] **Step 2: Run the focused adapter regression**

  Run: `bun test tests/chatgpt-web-harness.test.ts`

  Expected: PASS. If this fails because `onCommentary` does not reach `emitTraceEvents()`, inspect the existing trace path before changing any production interface.

- [ ] **Step 3: Run the focused browser/helper suites together**

  Run:

  ```powershell
  bun test tests/browser-worker-contract.test.ts tests/launcher-helper-client.test.ts tests/chatgpt-web-harness.test.ts tests/launcher-browser-host.test.ts
  ```

  Expected: PASS with no regression in browser-health state, helper lifecycle, or launcher renderer handling.

- [ ] **Step 4: Run the repository verification gates**

  Run:

  ```powershell
  bun run test
  $env:PSExecutionPolicyPreference='Bypass'; bun run launcher:test
  bun run typecheck
  git diff --check
  ```

  Expected:

  - root test suite passes;
  - launcher test suite passes;
  - TypeScript typecheck passes;
  - `git diff --check` reports no whitespace errors.

  If `bun run verify` is used additionally and stops at `bun audit`, report that stage separately rather than calling the aggregate verification green.

- [ ] **Step 5: Review the final diff against the original blocker**

  Confirm all of the following from the final diff and fresh test output:

  - degraded/unresponsive transitions are visible through commentary;
  - MCP/backend activity remains separate metadata and never mutates browser health;
  - repeated same-state evidence produces no duplicate status;
  - recovery is emitted once and respects native renderer precedence;
  - helper IPC uses the existing `commentary` event unchanged;
  - retained-compaction source files and semantics are untouched.

- [ ] **Step 6: Commit Task 3**

  ```bash
  git add tests/chatgpt-web-harness.test.ts
  git commit -m "test(browser): prove ui health reaches adapter commentary"
  ```

---

## Expected End State

When backend/MCP activity continues while the ChatGPT renderer or response DOM becomes unhealthy, the turn can truthfully expose both domains at once:

```text
backend=active
browserUi=unresponsive
commentary="ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running."
```

The status is transition-driven and deduplicated, recovery appears once when the browser genuinely becomes responsive, and the same message reaches in-process and out-of-process turns through the existing commentary/trace mechanism. No new IPC event, health state machine, compaction behavior, or liveness timeout is introduced.
