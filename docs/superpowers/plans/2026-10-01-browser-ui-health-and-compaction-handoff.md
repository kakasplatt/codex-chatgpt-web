# Browser UI Health and Compaction Handoff Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct two incident classes: false "not stuck" diagnoses when the ChatGPT browser UI/renderer is degraded while Codex/MCP is still active, and retained-compaction handoffs that time out yet leave the owned browser turn alive for minutes.

**Architecture:** Split generic turn liveness into independent backend, DOM, renderer/UI, completion, and compaction-protocol states. Preserve the existing long-running MCP grace semantics, but stop treating backend activity as evidence that the renderer is healthy. For retained compaction, make the structured handoff receipt the logical commit boundary and bound browser retirement/cleanup separately from the handoff deadline.

**Tech Stack:** TypeScript, Bun, Playwright, Electron, existing launcher control HTTP API, existing TurnBroker/retained-compaction protocol.

**Spec:** `docs/superpowers/specs/2026-10-01-browser-ui-health-and-compaction-handoff-design.md`

## Global Constraints

- Do not shorten or remove `CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS` merely to make browser freezes fail faster.
- Long-running legitimate MCP/tool work must remain valid even when a response DOM is transiently unavailable.
- `browser.turn_heartbeat` proves helper/control-channel liveness only; it must never imply renderer/UI health.
- Electron `webContents` `unresponsive`/`responsive` events are authoritative native renderer evidence and must remain scoped to the owned turn/tab.
- A structured compaction handoff must remain single-use and authenticated; do not add automatic retry until idempotency is explicitly designed.
- A compaction timeout must not kill unrelated tabs, turns, or the launcher process.
- Logical protocol outcome and physical browser retirement must be observable separately.
- Use TDD for each behavioral change and keep commits split by independently reviewable behavior.

## Review Focus

- Renderer becomes unresponsive while MCP tool calls continue: backend remains alive, browser health becomes degraded/unresponsive, and the turn is not prematurely aborted.
- DOM observation times out repeatedly without Electron emitting `unresponsive`: browser health still becomes degraded and is visible diagnostically.
- Renderer recovers after a degraded interval: recovery is recorded once and does not erase the historical diagnostic evidence for that incident.
- Structured compaction handoff succeeds but browser abort/settlement is slow: summary remains committed while cleanup is bounded separately.
- Compaction handoff never arrives and the retained page is also unresponsive: transaction expires once, stale control tokens cannot commit later, and the browser turn is physically retired within the cleanup budget.

---

## File Structure and Responsibility Map

- `launcher/electron/browser-host.cjs`
  - Own renderer health state for each turn tab.
  - Capture `webContents` `unresponsive`/`responsive` transitions.
  - Expose renderer health through `tabSnapshot()` and the turn heartbeat response.
  - Continue to own physical turn-tab release through `endTurn()` / `removeTurnTab()`.
- `launcher/electron/control-server.cjs`
  - Return trace-scoped renderer health from `/v1/turn/heartbeat` instead of discarding the host heartbeat result.
- `src/launcher-browser-host.ts`
  - Define and validate the heartbeat health response from the launcher control API.
  - Keep `phase: "heartbeat"` semantically distinct from renderer health.
- `src/adapters/chatgpt-web/browser-worker.ts`
  - Add browser UI-health tracking alongside `ChatGptTurnDomHealthTracker`.
  - Consume renderer health returned by its existing direct `notifyLauncherTurn(... phase: "heartbeat")` calls.
  - Keep the existing `turn.onHeartbeat` helper callback as backend/helper liveness only; do not attach renderer semantics to that callback.
  - Keep external MCP progress as a veto against premature terminal DOM verdicts, but never as evidence of a healthy UI.
  - Emit deduplicated degradation/recovery diagnostics.
- `src/adapters/chatgpt-web/compaction-handoff.ts`
  - Make compaction phases explicit.
  - Treat structured handoff receipt as logical commit.
  - Separate handoff timeout from physical browser cleanup timeout.
- `src/adapters/chatgpt-web/turn-broker.ts`
  - Continue exposing the broker facade for compaction transaction begin/wait/abort.
- `src/adapters/chatgpt-web/compaction-transaction.ts`
  - Own one-shot transaction retirement and reject late/stale handoff completion after expiry, abort, or consumption.
- `src/adapters/chatgpt-web/turn-execution.ts`
  - Keep logical browser outcome and physical settlement distinct; consume the refined compaction semantics without collapsing them.
- Tests:
  - `launcher/tests/browser-host.test.cjs`
  - `launcher/tests/control-server.test.cjs`
  - `tests/launcher-browser-host.test.ts`
  - `tests/browser-worker-contract.test.ts`
  - `tests/retained-compaction.test.ts`
  - `tests/compaction-browser-recovery.test.ts`
  - `tests/turn-broker-lifecycle.test.ts`

---

## Subproject A — Browser UI / Renderer Health

### Task 1: Persist renderer health on each launcher turn tab

**Files:**
- Modify: `launcher/electron/browser-host.cjs` around `tabSnapshot()`, `bindWebContents()`, `heartbeatTurn()`
- Test: `launcher/tests/browser-host.test.cjs`

**Interfaces:**
- Add exact tab-owned fields:
  - `rendererHealth: "responsive" | "unresponsive"`
  - `rendererStateChangedAt: number | null`
- `tabSnapshot(tab)` must expose the current renderer health for the exact owned tab.

- [ ] **Step 1: Write failing launcher tests for native renderer state transitions**
  - Simulate `webContents` `unresponsive`.
  - Assert the tab snapshot becomes `rendererHealth: "unresponsive"` and records the transition time.
  - Simulate `responsive`.
  - Assert the same tab returns to `rendererHealth: "responsive"` with a new transition time.
  - Assert another concurrent tab is unchanged.

- [ ] **Step 2: Run the focused launcher test and verify RED**

  Run: `bun test launcher/tests/browser-host.test.cjs`

  Expected: FAIL because snapshots do not yet expose renderer health.

- [ ] **Step 3: Implement renderer state ownership in `BrowserHost`**
  - Initialize new turn tabs as responsive unless Electron already proves otherwise.
  - In the existing `contents.on("unresponsive")` handler, update only that tab's renderer state before publishing state/logging.
  - In `contents.on("responsive")`, update only that tab back to responsive before publishing state/logging.
  - Preserve existing renderer-gone behavior.

- [ ] **Step 4: Run the focused launcher test and verify GREEN**

  Run: `bun test launcher/tests/browser-host.test.cjs`

- [ ] **Step 5: Commit**

  Suggested commit: `fix(browser): track renderer health per turn tab`

### Task 2: Return renderer health from turn heartbeats without changing heartbeat semantics

**Files:**
- Modify: `launcher/electron/control-server.cjs`
- Modify: `src/launcher-browser-host.ts`
- Test: `launcher/tests/control-server.test.cjs`
- Test: `tests/launcher-browser-host.test.ts`

**Interfaces:**
- Add `LauncherBrowserRendererHealth = "responsive" | "unresponsive"`.
- Add `LauncherBrowserHeartbeatState` with exact fields:
  - `rendererHealth: LauncherBrowserRendererHealth`
  - `rendererStateChangedAt: number | null`
- For `LauncherTurnActivity` with `phase: "heartbeat"`, `notifyLauncherTurn()` must resolve with `LauncherBrowserHeartbeatState`; other phases preserve their existing result contract.
- Do not return or depend on the entire global launcher snapshot.

- [ ] **Step 1: Write a failing control-client test**
  - In `launcher/tests/control-server.test.cjs`, assert `/v1/turn/heartbeat` returns only `{ ok: true, rendererHealth, rendererStateChangedAt }` for the exact owner.
  - Mock `/v1/turn/heartbeat` returning `rendererHealth: "unresponsive"` and `rendererStateChangedAt`.
  - Assert `notifyLauncherTurn()` returns that state for heartbeat calls.
  - Assert malformed health values are rejected.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `bun test launcher/tests/control-server.test.cjs tests/launcher-browser-host.test.ts`

- [ ] **Step 3: Implement scoped heartbeat health response**
  - In `control-server.cjs`, use the result of `host.heartbeatTurn(...)` to select the exact trace/tab health and return only the required health fields plus `ok: true`.
  - In `src/launcher-browser-host.ts`, define the exact heartbeat result type and validate both enum and timestamp before returning it.
  - Keep the heartbeat request itself unchanged as evidence of helper ownership/liveness.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run: `bun test launcher/tests/control-server.test.cjs tests/launcher-browser-host.test.ts`

- [ ] **Step 5: Commit**

  Suggested commit: `feat(browser): expose renderer health on turn heartbeat`

### Task 3: Track browser UI health independently from DOM-completion health

**Files:**
- Modify: `src/adapters/chatgpt-web/browser-worker.ts`
- Test: `tests/browser-worker-contract.test.ts`

**Interfaces:**
- Add exact types in `browser-worker.ts`:
  - `ChatGptBrowserUiHealth = "responsive" | "degraded" | "unresponsive"`
  - `ChatGptBrowserUiHealthReason = "dom-observation-timeout" | "dom-observation-ok" | "renderer-unresponsive" | "renderer-responsive"`
  - `ChatGptBrowserUiHealthTransition = { previous: ChatGptBrowserUiHealth; current: ChatGptBrowserUiHealth; reason: ChatGptBrowserUiHealthReason; at: number }`
- Add `ChatGptBrowserUiHealthTracker` with:
  - `current(): ChatGptBrowserUiHealth`
  - `record(reason: ChatGptBrowserUiHealthReason, at?: number): ChatGptBrowserUiHealthTransition | undefined`
- The tracker consumes:
  - launcher `rendererHealth` heartbeat evidence;
  - `ChatGptBrowserObservationTimeoutError` events;
  - successful response-DOM observations / renderer recovery.
- `record("dom-observation-ok")` may recover only `degraded -> responsive`; native `unresponsive` requires `renderer-responsive` for recovery.
- `externalProgressLive` must not reset this tracker.

- [ ] **Step 1: Write failing tracker tests**
  - First DOM probe timeout moves `responsive -> degraded`.
  - Repeated DOM probe timeouts remain `degraded` and emit no duplicate transition.
  - Electron unresponsive moves any nonterminal state to `unresponsive`.
  - MCP progress while unresponsive leaves browser UI health unresponsive.
  - Successful DOM observation may recover `degraded -> responsive`.
  - Native `responsive` recovers `unresponsive -> responsive`.
  - Repeated identical evidence does not emit duplicate transitions.

- [ ] **Step 2: Run focused worker tests and verify RED**

  Run: `bun test tests/browser-worker-contract.test.ts`

- [ ] **Step 3: Implement the tracker and feed it from `runBrowserTurn()`**
  - Feed observation timeouts before page rebind.
  - Feed successful DOM reads after `responseDomSnapshot()` succeeds.
  - Feed launcher renderer health from the resolved value of the existing `notifyLauncherTurn(... phase: "heartbeat")` calls, including the periodic heartbeat and rebind heartbeat.
  - Leave `turn.onHeartbeat` / helper protocol heartbeat unchanged as backend/helper liveness evidence.
  - Do not alter `ChatGptTurnDomHealthTracker` completion semantics yet.

- [ ] **Step 4: Preserve the existing MCP grace contract**
  - Keep `chatGptExternalProgressSuppressesDomHealth()` and `CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS` behavior intact.
  - Ensure external progress can still postpone a terminal missing-DOM verdict.
  - Ensure the UI-health tracker remains degraded/unresponsive while that postponement is active.

- [ ] **Step 5: Run focused worker tests and verify GREEN**

  Run: `bun test tests/browser-worker-contract.test.ts`

- [ ] **Step 6: Commit**

  Suggested commit: `fix(browser): separate ui health from backend liveness`

### Task 4: Surface browser degradation and recovery as deduplicated diagnostics/status

**Files:**
- Modify: `src/adapters/chatgpt-web/browser-worker.ts`
- Test: `tests/browser-worker-contract.test.ts`

**Interfaces:**
- Emit a transition only when UI health changes.
- Diagnostic wording must distinguish browser state from backend state, e.g. semantic equivalents of:
  - degraded/unresponsive: `ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running.`
  - recovery: `ChatGPT browser UI became responsive again.`

- [ ] **Step 1: Write failing tests for status semantics**
  - MCP active + renderer unresponsive must never produce a status equivalent to "not stuck" / "browser healthy".
  - Consecutive heartbeats in the same renderer state must not spam duplicate events.
  - Recovery emits exactly once.

- [ ] **Step 2: Implement transition reporting**
  - Route through the project's existing diagnostics/commentary/status mechanism rather than inventing a second logging path.
  - Include `traceId`, browser health state, and whether external MCP progress is active in structured diagnostics where supported.

- [ ] **Step 3: Verify focused tests**

  Run: `bun test tests/browser-worker-contract.test.ts tests/launcher-browser-host.test.ts`

- [ ] **Step 4: Commit**

  Suggested commit: `fix(browser): report ui degradation separately from turn activity`

---

## Subproject B — Retained Compaction Handoff Lifecycle

### Task 5: Make compaction handoff phases explicit and observable

**Files:**
- Modify: `src/adapters/chatgpt-web/compaction-handoff.ts`
- Test: `tests/retained-compaction.test.ts`

**Interfaces:**
- Add exact `RetainedCompactionPhase` values:
  - `source_settling`
  - `compaction_instruction_delivered`
  - `retained_turn_started`
  - `waiting_for_control_handoff`
  - `handoff_accepted`
  - `retiring_browser`
  - `complete`
- A timeout must identify the phase in which it occurred.
- Keep the current phase local to `requestRetainedCompactionHandoff()` and include it in structured diagnostics/errors; no global compaction state store is introduced.

- [ ] **Step 1: Write failing tests for phase-aware timeout diagnostics**
  - Handoff never arrives: timeout reports `waiting_for_control_handoff`.
  - Handoff arrives but browser cleanup stalls: logical state reaches `handoff_accepted` before cleanup fails/times out.

- [ ] **Step 2: Run retained-compaction tests and verify RED**

  Run: `bun test tests/retained-compaction.test.ts`

- [ ] **Step 3: Add phase transitions without changing protocol semantics**
  - Keep the current `MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000` as the maximum logical handoff deadline.
  - Record elapsed time and phase at each transition.

- [ ] **Step 4: Run tests and verify GREEN**

  Run: `bun test tests/retained-compaction.test.ts`

- [ ] **Step 5: Commit**

  Suggested commit: `feat(compaction): expose retained handoff phases`

### Task 6: Make structured handoff receipt the logical commit boundary

**Files:**
- Modify: `src/adapters/chatgpt-web/compaction-handoff.ts`
- Modify: `src/adapters/chatgpt-web/turn-execution.ts` only if the session outcome contract needs to distinguish committed handoff from cleanup
- Test: `tests/retained-compaction.test.ts`

**Interfaces:**
- `broker.waitForCompactionHandoff(transaction.token, operationSignal)` resolving successfully marks the compaction summary logically committed.
- Browser retirement after that point is cleanup, not evidence that the handoff failed.

- [ ] **Step 1: Write a failing test for successful handoff + slow browser retirement**
  - Deliver a valid structured handoff.
  - Hold the browser promise open after the receipt.
  - Assert the summary remains the committed logical result.
  - Assert cleanup is still attempted and bounded separately.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `bun test tests/retained-compaction.test.ts`

- [ ] **Step 3: Refactor `requestRetainedCompactionHandoff()` around the commit boundary**
  - Keep the race between handoff and browser-without-handoff for the pre-commit phase.
  - Once the handoff resolves, mark the logical operation committed.
  - Abort the purpose-built retained browser turn with `ChatGptCompactionHandoffAccepted` exactly once.
  - Do not allow a later cleanup timeout to rewrite the already accepted summary into `compaction_handoff_timeout`.

- [ ] **Step 4: Verify retained-compaction tests**

  Run: `bun test tests/retained-compaction.test.ts`

- [ ] **Step 5: Commit**

  Suggested commit: `fix(compaction): commit summary before browser cleanup`

### Task 7: Separate handoff deadline from physical cleanup deadline

**Files:**
- Modify: `src/adapters/chatgpt-web/compaction-handoff.ts`
- Modify: `src/launcher-browser-host.ts` only if existing `phase: "end"` needs a dedicated bounded cleanup caller
- Modify: `launcher/electron/browser-host.cjs` only if `endTurn()` cannot guarantee scoped physical retirement after helper abort
- Test: `tests/retained-compaction.test.ts`
- Test: `tests/compaction-browser-recovery.test.ts`

**Interfaces:**
- Keep the handoff deadline capped at five minutes.
- Add `RETAINED_COMPACTION_BROWSER_CLEANUP_TIMEOUT_MS = 15_000` as the independent physical cleanup deadline after success or failure; this matches the existing launcher turn-end timeout budget without reusing the handoff `AbortSignal`.
- Prefer the existing scoped `phase: "end"` / `BrowserHost.endTurn()` / `removeTurnTab()` path.
- Only add a new force-release control action if tests prove the current `endTurn()` path cannot retire the exact owned tab after a stuck helper/CDP operation.

- [ ] **Step 1: Write a failing physical-retirement test reproducing the incident class**
  - Retained turn starts.
  - Handoff never completes.
  - Worker/browser promise ignores or delays cooperative abort.
  - Logical handoff deadline expires.
  - Assert the owned tab is retired within the independent cleanup budget rather than continuing heartbeats for minutes.

- [ ] **Step 2: Run recovery tests and verify RED**

  Run: `bun test tests/compaction-browser-recovery.test.ts tests/retained-compaction.test.ts`

- [ ] **Step 3: Implement bounded cleanup using existing turn-end ownership first**
  - Signal browser abort.
  - Attempt normal browser/helper settlement for the short cleanup window.
  - If the existing lifecycle exposes the exact owned tab to `endTurn()`, use it and verify `removeTurnTab()` executes only for that trace/helper owner.
  - Do not terminate the launcher process or unrelated tabs.

- [ ] **Step 4: Add a scoped force-release API only if Step 3 cannot guarantee retirement**
  - If required, make the API require the exact `traceId` + `helperPid` ownership pair.
  - Reuse `removeTurnTab(tab, ...)` internally.
  - Make duplicate release idempotent for the same closed owner.

- [ ] **Step 5: Verify no post-timeout heartbeat leak**
  - Assert that once cleanup completes, heartbeat attempts for that trace fail as already released/ownership mismatch according to the existing contract.

- [ ] **Step 6: Commit**

  Suggested commit: `fix(compaction): bound retained browser retirement`

### Task 8: Reject stale/late compaction handoffs after transaction expiry

**Files:**
- Modify: `src/adapters/chatgpt-web/compaction-transaction.ts` only if current behavior is insufficient
- Modify: `src/adapters/chatgpt-web/turn-broker.ts` only if the facade needs to expose a missing transaction lifecycle operation
- Test: `tests/turn-broker-lifecycle.test.ts`
- Test: `tests/retained-compaction.test.ts`

**Interfaces:**
- A transaction that timed out or was aborted can never later commit its one-shot summary.
- Duplicate successful submission for an already committed transaction must preserve the existing one-shot/idempotency policy rather than create a second commit.
- The rejection after retirement remains `compaction control token is invalid, expired, or consumed` unless an existing test requires a more specific message.

- [ ] **Step 1: Write failing lifecycle tests**
  - Timeout transaction, then attempt late handoff with its token: reject.
  - Abort transaction, then attempt late handoff: reject.
  - Successful handoff followed by cleanup must not reopen the transaction.

- [ ] **Step 2: Run broker tests and verify RED or confirm current behavior is already GREEN**

  Run: `bun test tests/turn-broker-lifecycle.test.ts tests/retained-compaction.test.ts`

- [ ] **Step 3: Implement only the missing lifecycle guard**
  - Prefer `CompactionTransactionStore`; do not redesign the broker if existing token retirement already satisfies the new tests.

- [ ] **Step 4: Re-run tests**

  Run: `bun test tests/turn-broker-lifecycle.test.ts tests/retained-compaction.test.ts`

- [ ] **Step 5: Commit if production code changed**

  Suggested commit: `fix(compaction): reject stale retained handoffs`

---

## Integration Regression

### Task 9: Reproduce both incident findings in one deterministic test

**Files:**
- Modify: `tests/compaction-browser-recovery.test.ts`
- Modify: `tests/browser-worker-contract.test.ts` only for lower-level fixture helpers if needed

**Scenario:**

1. Browser turn is active and has recent MCP tool activity.
2. Response DOM observation times out and same-page recovery/rebind is attempted.
3. Renderer/UI health becomes degraded or unresponsive while backend liveness remains active.
4. Context compaction starts.
5. A post-compaction MCP/control interaction occurs.
6. Structured retained handoff never reaches commit before the logical deadline.
7. The compaction transaction expires.
8. The owned browser turn is retired within the cleanup deadline.

- [ ] **Step 1: Write the failing integrated regression**
  - Assert the browser health diagnostic says degraded/unresponsive while backend/MCP can still be active.
  - Assert no status path equates heartbeat/tool activity with UI health.
  - Assert timeout identifies the compaction phase.
  - Assert stale handoff cannot commit afterward.
  - Assert no long-lived heartbeat stream remains after cleanup.

- [ ] **Step 2: Run the integrated regression and verify RED before any final adjustment**

  Run: `bun test tests/compaction-browser-recovery.test.ts`

- [ ] **Step 3: Apply only the minimum cross-subproject adjustments required for GREEN**

- [ ] **Step 4: Run focused suites**

  Run:

  ```powershell
  bun test tests/browser-worker-contract.test.ts `
    launcher/tests/browser-host.test.cjs `
    launcher/tests/control-server.test.cjs `
    tests/launcher-browser-host.test.ts `
    tests/retained-compaction.test.ts `
    tests/compaction-browser-recovery.test.ts `
    tests/turn-broker-lifecycle.test.ts
  ```

- [ ] **Step 5: Commit**

  Suggested commit: `test(browser): cover ui stall during retained compaction`

---

## Final Verification

### Task 10: Verify type safety and relevant regression surface

- [ ] Run typecheck:

  `bun run typecheck`

- [ ] Run all focused tests:

  ```powershell
  bun test tests/browser-worker-contract.test.ts `
    launcher/tests/browser-host.test.cjs `
    launcher/tests/control-server.test.cjs `
    tests/launcher-browser-host.test.ts `
    tests/retained-compaction.test.ts `
    tests/compaction-browser-recovery.test.ts `
    tests/turn-broker-lifecycle.test.ts
  ```

- [ ] Run any broader browser/launcher suites affected by the final diff.

- [ ] Inspect the final diff for these invariants:
  - No reduced MCP liveness ceiling as a shortcut.
  - No global launcher kill/restart as compaction cleanup.
  - No automatic retry of one-shot compaction handoff.
  - No heartbeat field named or interpreted as generic `healthy`.
  - No cleanup failure that rewrites an already committed summary into a handoff failure.
  - All new state transitions are trace-scoped and deduplicated.

- [ ] Perform one manual diagnostic smoke run if the harness supports deterministic browser freezing/unresponsive simulation; otherwise rely on the deterministic Electron/worker regression fixtures and document that limitation.

---

## Expected End State

The system can represent this incident truthfully:

```text
backend=active
browserUi=unresponsive
responseDom=unavailable
completion=waiting
compaction=waiting_for_control_handoff
```

without turning backend activity into a claim that the page is healthy.

If retained compaction later times out, the final state becomes phase-specific and physically bounded:

```text
compaction=timed_out(waiting_for_control_handoff)
transaction=retired
browserCleanup=completed | cleanup_failed
```

and the owned tab must not continue emitting normal turn heartbeats for minutes after the logical timeout.
