# Browser UI Health and Compaction Handoff Design

## Context

An observed ChatGPT Web turn exposed two related reliability problems.

First, the Codex backend and MCP tool loop continued to make progress while the ChatGPT browser UI had already exhibited concrete degradation: DOM observation exceeded its 5-second probe timeout, same-page rebinding was required, and the Electron renderer only later emitted a `browser.tab_responsive` event. The CLI nevertheless answered the user's question `travou ?` with `Não travou`, because it inferred health from preserved local work and continued backend activity rather than from browser/renderer evidence.

Second, the same turn entered retained-context compaction, intercepted a post-compaction MCP call, then settled with `compaction_handoff_timeout`. Even after that logical failure, the owned browser turn continued to emit heartbeats for several minutes before the tab recovered/was aborted. This means the logical compaction protocol and physical browser retirement are not sufficiently separated or bounded.

The two problems share one design flaw: several independent concepts are compressed into a generic notion of "turn liveness". This design separates those concepts and defines explicit commit/cleanup boundaries for retained compaction.

## Goals

1. Report browser UI/renderer degradation truthfully even while Codex/MCP backend activity continues.
2. Preserve legitimate long-running tool execution and existing external-progress grace semantics.
3. Make renderer health, response-DOM health, backend liveness, completion state, and compaction state independently observable.
4. Make a structured retained-compaction handoff receipt the logical commit boundary for compaction.
5. Bound physical browser cleanup separately from the handoff deadline.
6. Prevent stale or late compaction control submissions from committing after transaction retirement.
7. Ensure a failed or timed-out retained compaction cannot leave its owned browser tab emitting normal heartbeats for minutes.
8. Keep all cleanup scoped to the exact turn/tab ownership; never solve this by restarting the launcher or killing unrelated tabs.

## Non-goals

- Do not reduce `CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS` as a shortcut.
- Do not remove MCP-based protection against false missing-DOM failures during legitimate long-running tool calls.
- Do not add automatic retained-compaction retries in this change.
- Do not redesign general model completion detection beyond what is required to separate UI health from backend liveness.
- Do not replace the existing launcher ownership model or introduce global browser-process recovery for a turn-scoped failure.

## Design Principles

### Backend liveness is not browser health

The system must be able to represent all of these simultaneously:

```text
backend=active
browserUi=unresponsive
responseDom=unavailable
completion=waiting
compaction=waiting_for_control_handoff
```

No single field named `healthy`, `alive`, or equivalent may stand in for all of them.

### Heartbeats prove ownership/liveness only

`browser.turn_heartbeat` proves that the browser helper can still reach the launcher control channel and that the turn ownership lease is being refreshed. It does not prove that Chromium's renderer event loop, the ChatGPT page DOM, or the response subtree is responsive.

### Native renderer evidence must remain independent

Electron `webContents` `unresponsive` and `responsive` events are direct renderer signals. They must be captured as per-tab renderer state and exposed to the helper/worker without being overwritten by MCP activity.

### External progress may delay a terminal DOM verdict, but may not erase UI degradation

The existing external-progress grace exists for a valid reason: a model can be actively executing tools while the rendered response DOM is transiently incomplete or absent. That grace remains.

However, if DOM observation itself times out or Electron reports the renderer unresponsive, the system must retain and expose that browser-health evidence even while the turn remains logically active.

### Compaction success and browser cleanup are separate phases

A structured compaction handoff is accepted through a one-shot authenticated control transaction. Once the broker accepts that summary, the logical compaction result is committed. The retained browser turn must then be retired, but a slow cleanup must not retroactively convert an already accepted handoff into `compaction_handoff_timeout`.

## State Model

### Backend liveness

Backend liveness describes whether Codex/MCP activity proves that work is continuing.

Suggested semantic states:

```text
active
idle
stalled
```

This state may use external MCP progress and active tool-call evidence.

### Browser UI health

Browser UI health describes whether the owned ChatGPT browser surface is responsive enough to observe and interact with.

Required states:

```text
responsive
degraded
unresponsive
```

Evidence rules:

- New turn/tab starts as `responsive` unless Electron already reports otherwise.
- A `ChatGptBrowserObservationTimeoutError` transitions `responsive -> degraded`.
- Repeated observation timeout while already degraded keeps it degraded and updates diagnostics without spamming duplicate transitions.
- Electron `webContents` `unresponsive` transitions any nonterminal state to `unresponsive`.
- A successful DOM observation may recover `degraded -> responsive`.
- Electron `responsive` recovers `unresponsive -> responsive`.
- `externalProgressLive` never forces browser UI health back to `responsive`.

### Response DOM health

`ChatGptTurnDomHealthTracker` remains responsible for response/completion semantics such as missing response DOM, empty completed response, and missing completion action. It may continue using external MCP progress to postpone terminal conclusions.

It is not the canonical renderer-health tracker.

### Completion state

Completion tracking remains distinct from both browser and backend liveness. Existing rules that prevent finalization while tool calls are in flight remain unchanged.

### Compaction state

Retained compaction must expose these phases at minimum:

```text
source_settling
compaction_instruction_delivered
retained_turn_started
waiting_for_control_handoff
handoff_accepted
retiring_browser
complete
timed_out(<phase>)
failed(<phase>)
```

Transitions must be trace-scoped and diagnostic logs must identify the phase that timed out or failed.

## Launcher Changes

### Per-tab renderer state

`launcher/electron/browser-host.cjs` already subscribes to `webContents` `unresponsive` and `responsive` events. Instead of logging only, those handlers must update renderer state owned by the exact turn tab.

`tabSnapshot(tab)` should expose at least:

```ts
rendererHealth: "responsive" | "unresponsive";
rendererStateChangedAt: number | null;
```

The timestamp is diagnostic metadata, not a timeout source of truth.

`render-process-gone` keeps its existing terminal behavior and is not reduced to ordinary `unresponsive`.

### Heartbeat response

`heartbeatTurn()` currently refreshes ownership and returns a global snapshot, while `/v1/turn/heartbeat` discards that result and returns only `{ ok: true }`.

The control endpoint should return only the renderer state for the exact trace/tab, rather than the entire launcher snapshot. The returned shape should remain small and validated.

The request heartbeat still means only helper/ownership liveness. The renderer fields are additional independent evidence.

## Worker Changes

### Browser UI health tracker

Add a small worker-side tracker, preferably close to `ChatGptTurnDomHealthTracker`, responsible only for browser UI health transitions.

Conceptual interface:

```ts
type ChatGptBrowserUiHealth = "responsive" | "degraded" | "unresponsive";

interface ChatGptBrowserUiHealthTransition {
  previous: ChatGptBrowserUiHealth;
  current: ChatGptBrowserUiHealth;
  reason: "dom-observation-timeout" | "dom-observation-ok" | "renderer-unresponsive" | "renderer-responsive";
  at: number;
}
```

The implementation may choose different exact names, but it must keep transition semantics explicit and deduplicated.

### DOM observation timeouts

When `responseDomSnapshot()` or equivalent observation hits `ChatGptBrowserObservationTimeoutError`, the UI health tracker records degradation before same-page rebind/recovery runs.

Existing `MAX_CHATGPT_BROWSER_PAGE_REBINDS` logic remains responsible for deciding when repeated observation failure is terminal.

### Successful observations

A subsequent successful page/DOM observation can recover a merely degraded state. If Electron explicitly reported `unresponsive`, native `responsive` evidence is preferred for recovery from that native state.

### External progress behavior

`chatGptExternalProgressSuppressesDomHealth()` remains responsible for deciding whether recent MCP activity postpones terminal response-DOM health conclusions.

It must not mutate or clear browser UI health.

This intentionally allows:

```text
backend=active
browserUi=degraded
```

or:

```text
backend=active
browserUi=unresponsive
```

without aborting a valid long-running tool call solely because the UI is degraded.

## User-visible/Diagnostic Semantics

The system must stop using evidence such as a successful local command, preserved git state, or ongoing MCP activity to imply that the browser page itself is responsive.

On transition to degraded/unresponsive, emit a deduplicated diagnostic/status whose semantics clearly distinguish the two domains, for example:

```text
ChatGPT browser UI is unresponsive; Codex/MCP activity may still be running.
```

On recovery, emit a single recovery transition, for example:

```text
ChatGPT browser UI became responsive again.
```

Exact wording may follow project conventions, but must not collapse backend and browser health into a single claim.

## Retained Compaction Protocol

### Current logical boundary

`requestRetainedCompactionHandoff()` creates a one-shot transaction, runs a retained browser turn containing the structured handoff instruction, and races:

- `broker.waitForCompactionHandoff(...)`
- browser completion without handoff

That race is correct for the pre-commit phase and should remain.

### Logical commit

When `broker.waitForCompactionHandoff(transaction.token, ...)` resolves with the summary, the handoff is logically committed.

After that point:

- The summary must remain the successful logical result.
- The one-shot transaction is no longer available for another commit.
- The purpose-built retained browser turn must be aborted/retired.
- Cleanup failure is reported as cleanup failure, not as if no handoff arrived.

### Separate deadlines

There are two independent deadlines:

1. **Handoff deadline** — bounded by the existing `MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000`.
2. **Cleanup deadline** — a short, independent bound for physical browser retirement after either success or failure.

The implementation must not reuse one `AbortSignal` in a way that makes post-commit cleanup expiry rewrite the pre-commit protocol result.

### Physical retirement

Cleanup should first use the existing scoped turn lifecycle:

```text
phase: "end"
-> BrowserHost.endTurn()
-> removeTurnTab()
```

If tests prove that a stuck helper/CDP operation prevents this path from physically retiring the exact owned tab, add the smallest possible scoped force-release operation.

Any force-release operation must:

- require the exact `traceId` and `helperPid` ownership pair;
- affect only the matching turn tab;
- be idempotent for an already closed owner where existing lifecycle semantics permit it;
- never restart or kill the whole launcher/browser process.

### Late handoffs

Once the transaction has timed out or been aborted, a later control submission using that transaction/token must not commit.

If the broker already enforces this through transaction retirement, tests should lock that behavior in without unnecessary production changes.

## Failure Semantics

### Renderer degradation with active MCP

Expected behavior:

```text
backend=active
browserUi=degraded|unresponsive
turn=active
```

The system reports degradation but does not kill the turn solely because MCP activity continues.

### DOM never recovers and progress becomes stale

Once external progress is no longer valid evidence and existing DOM grace/rebind budgets are exhausted, normal terminal browser/DOM failure rules apply.

### Compaction handoff never arrives

Expected behavior:

```text
compaction=timed_out(waiting_for_control_handoff)
transaction=retired
browserCleanup=attempted_and_bounded
```

The tab must not remain a normal running turn indefinitely after logical timeout.

### Handoff arrives but cleanup stalls

Expected behavior:

```text
compaction=handoff_accepted
summary=committed
browserCleanup=failed|timed_out
```

The committed summary remains valid.

## Testing Strategy

### Launcher tests

`tests/launcher-browser-host.test.ts` must prove:

- per-tab `unresponsive -> responsive` transitions;
- renderer state does not leak between concurrent tabs;
- heartbeat response exposes validated trace-scoped renderer state;
- malformed renderer state is rejected by the TypeScript client.

### Worker contract tests

`tests/browser-worker-contract.test.ts` must prove:

- DOM observation timeout causes browser UI degradation;
- Electron unresponsive causes native unresponsive state;
- active MCP progress does not erase degradation;
- active MCP progress may still postpone terminal DOM-health verdicts;
- recovery transitions are deduplicated;
- completion behavior around tool calls remains unchanged.

### Retained compaction tests

`tests/retained-compaction.test.ts` must prove:

- handoff timeout identifies the phase;
- a valid structured handoff is the logical commit boundary;
- slow browser cleanup after accepted handoff does not rewrite success as `compaction_handoff_timeout`;
- cleanup has its own deadline;
- abort/timeout retires the transaction exactly once.

### Broker lifecycle tests

`tests/turn-broker-lifecycle.test.ts` must prove:

- timed-out/aborted compaction transactions reject late handoffs;
- committed transactions cannot be reopened;
- existing one-shot semantics remain intact.

### Integrated regression

`tests/compaction-browser-recovery.test.ts` must reproduce the incident class deterministically:

1. active turn with recent MCP progress;
2. DOM observation timeout / browser degradation;
3. compaction begins;
4. post-compaction control interaction occurs;
5. handoff does not commit before the logical deadline;
6. phase-specific timeout is emitted;
7. stale handoff cannot commit;
8. the owned browser turn is physically retired within cleanup budget;
9. no multi-minute normal heartbeat stream remains after cleanup.

## Acceptance Criteria

- A renderer/DOM stall can coexist with active backend/MCP state without being mislabeled as healthy.
- The CLI/diagnostic path has enough explicit browser-health evidence that a response equivalent to `Não travou` cannot be justified solely by continued backend activity.
- Long-running active tool calls are not prematurely terminated because of the new health reporting.
- `browser.turn_heartbeat` is never used as proof of renderer responsiveness.
- A retained compaction timeout reports the phase that timed out.
- A successful structured handoff remains successful even if subsequent browser cleanup is slow.
- A failed/timed-out retained compaction physically retires its owned browser turn within a bounded cleanup window.
- Late handoff attempts after transaction retirement are rejected.
- No cleanup path affects unrelated tabs or restarts the launcher process.
- Typecheck and all focused browser/compaction suites pass.

## Implementation Decomposition

Implementation should be delivered as two coordinated subprojects:

1. **Browser UI / Renderer Health**
   - Persist native renderer health per tab.
   - Return it from heartbeat responses.
   - Add independent worker UI-health tracking.
   - Emit deduplicated degradation/recovery diagnostics.

2. **Retained Compaction Handoff Lifecycle**
   - Make phases explicit.
   - Move the logical commit boundary to structured handoff receipt.
   - Separate handoff and cleanup deadlines.
   - Guarantee scoped physical retirement.
   - Lock stale-handoff rejection with tests.

The two subprojects meet only at diagnostics and recovery policy. Backend liveness must never become the source of truth for browser renderer health.
