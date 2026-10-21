# Retained tab frame-stall recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a reused (retained) ChatGPT tab whose renderer produces no animation frames from failing effort selection with `locator.click: Timeout 3000ms exceeded`, and from forcing a full-context resend in a new tab.

**Architecture:** Right after the worker acquires a *reused* launcher tab, it samples `requestAnimationFrame` in the page and climbs a recovery ladder from lightest to heaviest. No rung submits anything:

1. **Repaint, no reload:** the existing `refreshViewport` heartbeat now also forces a repaint (`invalidate()`). If Task 5 shows that is not enough, it instead hides the view and shows it again.
2. **Page reload, saved chats only:** `page.reload()` on the same `/c/<id>` URL, followed by composer and session checks. It never navigates to a new chat.
3. **Fail fast:** throw a specific error so the existing retry opens a fresh tab.

The worker samples again after each rung and stops at the first one that paints. Independently, a click timeout in `activateChatGptEffortMenu` falls through to the existing `pointerdown` fallback instead of throwing.

**Tech Stack:** TypeScript on Bun (`bun test`), Playwright (`page.evaluate`, `Locator.click`), Electron `WebContentsView`/`webContents` in `launcher/electron/browser-host.cjs` (`node --test`).

**Spec:** No separate design doc. The root-cause evidence below is the spec, from the investigation of trace `b7d193e89e19` (2026-10-21 02:33 UTC) and `C:\Users\kakas\Documents\codex-web-gpt-diagnostics-2026-10-21.jsonl`:

- The failure happens in stage `effort_selection` on a tab logged as `browser.tab_reused`. The control resolved, was enabled, had `centerHit: true`, and the page had `documentHidden: false`. Playwright waited on *"visible, enabled and stable"* until 3000 ms ran out.
- The `03-turn-failed` interaction state recorded `frames: {count: 0, elapsedMs: 501}`. Playwright's "stable" check needs consecutive rAF callbacks, so it can never pass when there are none.
- Across 21 frame samples that day: 5 of 13 samples on reused tabs had 0, 1 or 23 frames, and all 8 samples on fresh tabs had 62–85. Page size is not the discriminator, because same-size reused tabs reached 84 frames. Some reused tabs still had 0 frames 60–80 s after reuse, so the renderer does not resume on its own. A longer timeout or a delay does **not** fix it.
- Lifecycle: `endTurn` sets `setBackgroundThrottling(true)`, and the retained tab is hidden via `presentTurnView` (`launcher/electron/browser-host.cjs:2697`, `:1774-1794`). On reuse, `beginTurn` re-enables painting with `setBackgroundThrottling(false)` and `syncViewVisibility()` (`:2626-2631`).
- Cost of the current behavior: the failed attempt would have sent about 9.5k tokens (`transport=inline`). The automatic retry opened a new tab and re-sent about 184k tokens (`multipart-3`, 9 images), taking about 20 min.
- In `activateChatGptEffortMenu` (`src/chatgpt-session.ts:208`), `control.click` throwing on timeout skips the `pointerdown` fallback at `:212-220`.

## Global Constraints

- Root runtime tests: `bun test ./tests`. Typecheck: `bun run typecheck`. Launcher tests: `bun run launcher:test` (`node --test tests/*.test.cjs`). Launcher typecheck: `bun run launcher:typecheck`.
- Do not change the control-server HTTP contract. Reuse `refreshViewport: true` on `/v1/turn/heartbeat`, and add no new endpoint or field.
- Do not change the 3000 ms `settleMs` default in `activateChatGptEffortMenu`.
- The probe runs only for reused launcher tabs: `lease.reused === true` and `launcherSurfaceId !== undefined`. Fresh tabs and the non-launcher (`pageForNewTurn`) path must be unchanged.
- The probe must run before any prompt or attachment is placed in the composer, so failing fast never risks a duplicate submission.
- The reload rung runs only when `this.config.useSavedChats === true` **and** the page is a saved conversation: path `/c/<id>` or `/g/<gpt>/c/<id>`, with no `temporary-chat` query parameter. Reloading a temporary chat destroys the conversation.
- After reloading, never call `prepareChatSurface`: it navigates to a new chat (`browser-worker.ts:3190-3195`). Use only `activeComposer`, `throwIfChatGptSessionFailureAlert` and `assertAuthenticatedChatGptPage`.
- After reloading, `page.url()` must equal the URL before the reload. Otherwise, fail fast with the not-painting error.
- Logs must carry no conversation text. Counts and trace ids only, matching existing `[chatgpt-web]` log lines.
- `graphify-out/` is local analysis state. Do not commit it.

## Review Focus

1. **A healthy reused tab that just paints slowly.** Its first sample may be 0–1 frames while the second, after the nudge, is healthy. Expected: the turn continues on the retained conversation, with one extra 500 ms sample. Pinned in Task 3 (`recovers after one repaint`).
2. **The probe's `page.evaluate` hangs because the renderer is fully stuck.** Expected: the probe is bounded by its own timeout (`RETAINED_TAB_FRAME_WINDOW_MS + 1_500`) and counts as "not painting", not as a turn-long hang. Pinned in Task 1 (`times out as zero frames`).
3. **The turn is aborted (user interrupt) during the probe or the nudge.** Expected: an `AbortError`, never the not-painting error. Pinned in Task 3 (`abort wins over the ladder`).
4. **The click times out for a reason other than frames,** for example an overlay that persists. Expected: `pointerdown` is tried. If the surface still never appears, the existing *"did not expose its owned menu or structural slider"* error is thrown, not a raw Playwright timeout. Pinned in Task 2.
5. **A retained *temporary* chat, or a saved chat when the saved-chats option is off, stops painting.** Expected: the ladder skips the reload rung and fails fast. The conversation is never reloaded away. Pinned in Task 3 (`never reloads a temporary conversation`, plus the `isReloadableRetainedConversation` cases).

## File Structure

- `src/adapters/chatgpt-web/browser-interaction-state.ts`: add an in-page frame counter that can be used on its own. This file already owns in-page actionability probes.
- `src/adapters/chatgpt-web/retained-tab-paint.ts` (new): the worker-side probe-nudge-probe policy as a pure function with injected dependencies, so it is unit-testable without Playwright or the launcher.
- `src/adapters/chatgpt-web/browser-worker.ts`: call the policy once after `browser-page-acquired` for reused launcher tabs.
- `src/chatgpt-session.ts`: let a click timeout fall through to `pointerdown`.
- `launcher/electron/browser-host.cjs`: make the `refreshViewport` heartbeat force a repaint of the owned tab.
- `TROUBLESHOOTING.md`: one entry for the new error message.

## Model routing (per `docs/superpowers/model-selection.md`)

- Tasks 1, 2 and 4 are small and atomic: Claude Code `Sonnet 5.5` / high, or Codex `gpt-6.1-sol` / medium.
- Task 3 is cross-module and touches the turn lifecycle: Claude Code `Opus 5.5` / high, or Codex `gpt-6.1-sol` / high.
- Final whole-branch review: the most capable available model (`Fable 5.1` / max if entitled, otherwise `Opus 5.5` / xhigh).

---

### Task 1: In-page frame sampler and bounded worker probe

**Files:**
- Modify: `src/adapters/chatgpt-web/browser-interaction-state.ts`
- Create: `src/adapters/chatgpt-web/retained-tab-paint.ts`
- Test: `tests/retained-tab-paint.test.ts` (new)

**Interfaces:**
- Produces:
  - `export async function chatGptAnimationFrameSample({ windowMs }: { windowMs: number }): Promise<{ count: number; elapsedMs: number }>` runs in the page. It uses the same rAF loop as the existing `frames` block in `chatGptInteractionState`. Do **not** refactor `chatGptInteractionState` to call it: `page.evaluate` serializes each function on its own, so in-page functions must be self-contained. Keep the loop duplicated, and add a comment in both places that points at the other.
  - `export const RETAINED_TAB_FRAME_WINDOW_MS = 500`
  - `export const RETAINED_TAB_MIN_FRAMES = 2`. Playwright's stability check needs two consecutive frames.
  - `export async function sampleRetainedTabFrames(evaluate: () => Promise<{ count: number }>, timeoutMs: number): Promise<number>`. It returns the frame count, or `0` when `evaluate` does not settle within `timeoutMs`. Any rejection of `evaluate` is rethrown. Later rejections of a timed-out `evaluate` must be swallowed (`void promise.catch(() => {})`).

- [ ] **Step 1: Write the failing tests** in `tests/retained-tab-paint.test.ts`:
  - `sampleRetainedTabFrames returns the page frame count`: evaluate resolves `{count: 84}` → `84`.
  - `sampleRetainedTabFrames times out as zero frames`: evaluate never settles, `timeoutMs: 20` → `0`.
  - `sampleRetainedTabFrames rethrows non-timeout errors`: evaluate rejects `new Error("Target closed")` → rejects with `"Target closed"`.
- [ ] **Step 2: Run** `bun test tests/retained-tab-paint.test.ts`. Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement** `chatGptAnimationFrameSample` in `browser-interaction-state.ts` (self-contained), then the constants and `sampleRetainedTabFrames` in `retained-tab-paint.ts`. Implement the timeout as a local `Promise.race` with a cleared `setTimeout`. `retained-tab-paint.ts` must **not** import from `browser-worker.ts`: `browser-worker.ts` imports this module, so that would create a cycle.
- [ ] **Step 4: Run** `bun test tests/retained-tab-paint.test.ts tests/browser-worker-contract.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(browser): sample animation frames on retained tabs`.

### Task 2: Effort click timeout falls through to pointerdown

**Files:**
- Modify: `src/chatgpt-session.ts:196-224` (`activateChatGptEffortMenu`)
- Test: `tests/chatgpt-session.test.ts` (next to `effort activation retries one ghost click with a primary pointerdown`, line 113)

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged signature. A rejected `control.click` whose error has `name === "TimeoutError"` (Playwright's `errors.TimeoutError`) is swallowed, and execution continues at `clearGhostEffortState` → `pointerdown`.

- [ ] **Step 1: Write the failing tests:**
  - `effort activation falls back to pointerdown when the click times out`: reuse the line-113 fixture, but `click` rejects with `Object.assign(new Error("locator.click: Timeout 3000ms exceeded."), { name: "TimeoutError" })`. Expect `activation.method` to be `"pointerdown"`, and `events` to start with `["click", { timeout: 1 }]` followed by `["pointerdown", …]`.
  - `effort activation still propagates non-timeout click errors`: `click` rejects `new Error("Target closed")` → rejects with `"Target closed"`, and `dispatchEvent` is never called.
  - `effort activation reports the structural error after a timed-out click and a dead pointerdown`: the click times out and no surface appears → rejects with `"did not expose its owned menu or structural slider"`.
- [ ] **Step 2: Run** `bun test tests/chatgpt-session.test.ts`. Expected: the 3 new tests FAIL.
- [ ] **Step 3: Implement.** Wrap only the `control.click(...)` call. Do not catch `waitForEffortSurface`.
- [ ] **Step 4: Run** `bun test tests/chatgpt-session.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(browser): fall back to pointerdown when the effort click times out`.

### Task 3: Recovery ladder after reusing a retained tab (repaint → reload → fail fast)

**Files:**
- Modify: `src/adapters/chatgpt-web/retained-tab-paint.ts`
- Modify: `src/adapters/chatgpt-web/browser-worker.ts`. Insert right after `await diagnostics.capture(page, "browser-page-acquired")` (currently line 5927) and before the `temporary_chat_preparation` / effort stages. `reused` comes from line 5544 of the same method.
- Modify: `TROUBLESHOOTING.md` (one new section)
- Test: `tests/retained-tab-paint.test.ts`

**Interfaces:**
- Consumes: `sampleRetainedTabFrames`, `RETAINED_TAB_MIN_FRAMES` and `RETAINED_TAB_FRAME_WINDOW_MS` (Task 1).
- Produces:
  - `export const CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE = "The retained ChatGPT tab stopped rendering frames; the turn will be retried in a new tab."`
  - `export function isReloadableRetainedConversation(url: string, useSavedChats: boolean): boolean`. True only when `useSavedChats` is true, the origin is `https://chatgpt.com`, the pathname matches `^/(g/[^/]+/)?c/[^/]+/?$`, and the URL has no `temporary-chat` search parameter. Any unparsable URL returns false.
  - `export type RetainedTabPaintOutcome = "painting" | "repainted" | "reloaded"`
  - `export async function ensureRetainedTabPaints(deps: { sample: () => Promise<number>; refresh: () => Promise<void>; reload?: () => Promise<void>; signal?: AbortSignal; log: (line: string) => void; traceId: string }): Promise<RetainedTabPaintOutcome>`.
    - Order: sample → (below threshold) `refresh` → sample → (below threshold, only if `reload` is defined) `reload` → sample.
    - It returns at the first sample `>= RETAINED_TAB_MIN_FRAMES`.
    - It throws `new Error(CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE)` when every attempted rung stays below the threshold, or when `reload` rejects with a non-abort error. Use a plain `Error`, the same class as today's click timeout, so the existing retry path is unchanged.
    - It throws `DOMException("ChatGPT web turn aborted", "AbortError")` whenever `signal` is aborted before or after any await.
    - It logs exactly one line: `[chatgpt-web] retained_tab_frames {"traceId":…,"first":n,"afterRepaint":n|null,"afterReload":n|null,"reloadEligible":bool,"outcome":"painting"|"repainted"|"reloaded"|"stalled"}`.

- [ ] **Step 1: Write the failing tests:**
  - `continues without refresh when the retained tab paints`: sample `84` → `"painting"`, neither `refresh` nor `reload` is called, and the log has `"outcome":"painting"`.
  - `recovers after one repaint`: samples `0`, then `60` → `"repainted"`, `refresh` is called once, `reload` is never called.
  - `reloads when the repaint is not enough`: samples `0`, `0`, then `70` → `"reloaded"`, and `refresh` then `reload` are each called once, in that order.
  - `never reloads a temporary conversation`: `reload` is undefined, samples `0` and `0` → rejects with `CHATGPT_RETAINED_TAB_NOT_PAINTING_MESSAGE`, and the log has `"reloadEligible":false` and `"outcome":"stalled"`.
  - `fails fast when the reloaded tab still does not paint`: samples `0`, `0`, `1` → rejects with the not-painting message, and the log has `"afterReload":1`.
  - `a failed reload fails fast`: `reload` rejects `new Error("net::ERR_ABORTED")` → rejects with the not-painting message, not the raw error.
  - `abort wins over the ladder`: the signal aborts while `reload` is pending → rejects with `name === "AbortError"`.
  - `isReloadableRetainedConversation` cases:
    - `("https://chatgpt.com/c/abc", true)` → true;
    - `("https://chatgpt.com/g/g-x/c/abc", true)` → true;
    - `("https://chatgpt.com/c/abc", false)` → false;
    - `("https://chatgpt.com/?temporary-chat=true", true)` → false;
    - `("https://chatgpt.com/c/abc?temporary-chat=true", true)` → false;
    - `("https://chatgpt.com/", true)` → false;
    - `("https://example.com/c/abc", true)` → false;
    - `("not a url", true)` → false.
- [ ] **Step 2: Run** `bun test tests/retained-tab-paint.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement `isReloadableRetainedConversation` and `ensureRetainedTabPaints`.**
- [ ] **Step 4: Wire it into `browser-worker.ts`,** guarded by `reused && launcherSurfaceId !== undefined && this.config.browserHostDescriptorPath !== undefined`. Pass these dependencies:
  - `sample`: `sampleRetainedTabFrames(() => page.evaluate(chatGptAnimationFrameSample, { windowMs: RETAINED_TAB_FRAME_WINDOW_MS }), RETAINED_TAB_FRAME_WINDOW_MS + 1_500)`.
  - `refresh`: the same `notifyLauncherTurn(..., { phase: "heartbeat", traceId, helperPid: process.pid, refreshViewport: true })` call used in `rebindLauncherPage`. Record its renderer health through `recordRendererHealth`.
  - `reload`: defined only when `isReloadableRetainedConversation(page.url(), this.config.useSavedChats)`. It is a private method `reloadRetainedConversation(page: Page, signal?: AbortSignal): Promise<void>` on the worker. It captures `before = page.url()`, then runs:
    1. `withBrowserTurnAbort(page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }), signal)`;
    2. `waitForOperationalChatGptViewport(page, signal)`;
    3. `this.activeComposer(page, 30_000, signal)`;
    4. `throwIfChatGptSessionFailureAlert(page)` and `assertAuthenticatedChatGptPage(page)`;
    5. throw if `page.url() !== before`.

    It must **not** call `prepareChatSurface` or `assertNewChatPage`.
  - `signal`: `turn.abortSignal`.
  - `log`: `console.info`.
  - On `"repainted"`, call `await diagnostics.capture(page, "retained-tab-repainted")`. On `"reloaded"`, call `await diagnostics.capture(page, "retained-tab-reloaded")`.
- [ ] **Step 5: Add** a `TROUBLESHOOTING.md` section titled with the exact message. Say that:
  - the retained tab stopped painting;
  - repaint and, for saved chats, a same-conversation reload were tried first;
  - the retry uses a new tab with full context;
  - the `retained_tab_frames` log line shows each rung's frame count.
- [ ] **Step 6: Run** `bun test ./tests` and `bun run typecheck`. Expected: PASS, with no change to existing browser-worker contract tests.
- [ ] **Step 7: Commit** `fix(browser): recover retained tabs that stop painting before effort selection`.

### Task 4: The launcher refresh heartbeat forces a repaint

**Files:**
- Modify: `launcher/electron/browser-host.cjs:1581-1587` (`heartbeatTurn`, `refreshViewport` branch)
- Test: `launcher/tests/browser-host.test.cjs` (extend `a live turn heartbeat refreshes its lease and rejects another helper`, line 2380, and add one test)

**Interfaces:**
- Consumes: the existing `heartbeatTurn(traceId, helperPid, refreshViewport, progress)`.
- Produces: unchanged return shape. When `refreshViewport` is true and `tab.view.webContents` is not destroyed, the launcher now also calls `webContents.setBackgroundThrottling(false)` and then `webContents.invalidate()`, after `syncViewVisibility()`.

- [ ] **Step 1: Write the failing tests:**
  - Extend the line-2380 test. The tab gets `view: { webContents: { isDestroyed: () => false, setBackgroundThrottling: v => calls.push(["throttle", v]), invalidate: () => calls.push(["invalidate"]) } }`. After the `refreshViewport: true` heartbeat, `calls` deep-equals `[["throttle", false], ["invalidate"]]`. A heartbeat without refresh adds no calls.
  - `refresh heartbeat skips invalidate on destroyed contents`: `isDestroyed: () => true` → no throw, `calls` stays empty, and the return value is unchanged.
- [ ] **Step 2: Run** `bun run launcher:test`. Expected: the new assertions FAIL.
- [ ] **Step 3: Implement** inside the existing `if (refreshViewport)` block.
- [ ] **Step 4: Run** `bun run launcher:test` and `bun run launcher:typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(launcher): force a repaint when a turn refreshes its viewport`.

### Task 5: Live verification and decision gate

**Files:** none, unless the gate fails (see Step 4).

- [ ] **Step 1: Run** `bun run verify`. Expected: exit 0.
- [ ] **Step 2: Build and run the launcher** (`bun run app`). Hold a long conversation with a retained tab: several turns, at least one with generated images. Leave it idle for at least 2 min between turns so the retained tab stays hidden and throttled.
- [ ] **Step 3: Export logs** from the launcher, then run `grep retained_tab_frames` on the export. Expected:
  - one line per reused turn that reached a verdict (none if aborted first);
  - every `"repainted"` or `"reloaded"` line is followed by a successful `effort_selection` on the **same** tab (no `browser.tab_created` for that trace);
  - no `locator.click: Timeout` during `effort_selection`;
  - no `"reloaded"` outcome on a line with `"reloadEligible":false`.
- [ ] **Step 4: Decision gate on the repaint rung.** If `"repainted"` never appears while `"afterRepaint"` is below the threshold on stalled tabs, `invalidate()` is not enough to wake the compositor. In that case, change only Task 4's refresh branch to cycle visibility (`tab.view.setVisible(false)`, then `syncViewVisibility()`), update its test the same way, and repeat Steps 1–3.
- [ ] **Step 5: Decision gate on the reload rung.** If `"afterReload"` is also below the threshold, the stall belongs to the Electron view, not the document. Stop and report. The fail-fast path is still correct and cheaper than today's 3 s click timeout, but keeping the retained conversation would then need a launcher-side view replacement. That is out of scope for this plan.
- [ ] **Step 6: Report** to the user the counts of the painting, repainted, reloaded and stalled outcomes, and which repaint nudge was kept.
