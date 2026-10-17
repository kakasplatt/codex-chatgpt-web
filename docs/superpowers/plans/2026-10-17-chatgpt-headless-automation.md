# Experimental Headless ChatGPT Automation Implementation Plan

## Execution status · 2026-10-17

The full feature-parity and performance acceptance gates remain open. The
uncommitted source prototype includes an embedded-default Settings switch,
localized labels, dedicated headed Chrome sign-in, managed-Chrome routing for
production automatic browser-only turns, launcher transaction rollback, and
explicit Full MCP / DEV / Zero Risk restrictions. An optional Windows
process-tree sampler lives at `scripts/headless-benchmark.ts`.

- Passed: `bun run typecheck`, `bun run launcher:typecheck`,
  `bun run launcher:build`, `git diff --check`; 25 targeted Bun tests and
  headless-focused launcher tests.
- Broad launcher tests: 166 passed, 1 skipped, 1 Windows symlink `EPERM`
  failure; the wider launcher suite additionally failed the installer test
  because PowerShell script execution was disabled on the host.
- Broad Bun tests: 1077 passed, 73 skipped, 2 Windows symlink-permission
  failures. The process sampler also completed a local two-second smoke test.
- **Not exercised:** real Chrome sign-in or headless turns (Chrome absent from
  standard Windows executable paths), parallel/cancel/recovery smoke, Full MCP
  approval/compaction parity, comparative CPU/RAM/DOM-stall/latency benchmarking.

The prototype is not yet ready for a production rollout or a performance claim.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reversible Settings toggle for true headless automatic ChatGPT execution, and demonstrate whether it improves performance without introducing browser-turn failures.

**Architecture:** Preserve existing Electron automation as the default `embedded` engine. Add a second `headless` engine built on the existing Playwright `managed-chrome` execution path, keeping launcher ownership of the local runtime/tunnel but isolating ChatGPT rendering in a Chrome process with no window. Select the engine at safe runtime-transition boundaries and gate activation on verified login, feature parity, and end-to-end smoke tests.

**Tech Stack:** Electron 41, React 19, TypeScript, CommonJS Node launcher, Bun runtime/tests, Playwright Core, Google Chrome, Windows-first integration tests.

**Spec:** `docs/superpowers/specs/2026-10-17-chatgpt-headless-automation-design.md` (proposal; review before implementation).

## Global Constraints

- The default is `automaticBrowserEngine: "embedded"`, independent of `browserInteractionMode: "automatic" | "manual"`; existing installs migrate without changing behavior.
- `manual` always keeps its interactive browser; the experimental headless setting is inapplicable there.
- Launcher/runtime/tunnel ownership, token authorization, connector and Codex approvals, trace ownership and current account limits must remain intact.
- Never switch execution engines while a browser turn, approval, login or runtime transaction is in progress. An accepted/possibly accepted send must not be retried automatically.
- Never assume Electron session cookies are portable to Chrome; headless uses explicit login and a separately verified storage-state file.
- Maintain existing output/status, images, model/effort, saved/retained chats, compaction and native MCP-tool semantics in both engines; fail capability preflight rather than silently degrade.
- No disabling GPU/sandbox/website protections or using Electron bitmap offscreen rendering under a headless label.
- Preserve unrelated worktree changes and add only explicit task files to each commit; no commits, source implementation or publication are authorized by this planning document.

## Review Focus

1. A prompt is accepted, but its DOM fails to answer: **no** automatic replay when switching/failing over. Test in Task 5.
2. Two concurrent jobs share the same ChatGPT account and a retained conversation: each job keeps exact trace and page ownership. Test in Task 5.
3. Login expires or shows an interactive challenge while headless: report `authentication-required` and enter a headed login flow without pretending the turn succeeded. Test in Task 4 and Task 6.
4. User changes setting during an active job or service restart fails: reject change or atomically roll back; never leak a Chrome process or corrupt the previous runtime. Test in Task 3 and Task 6.
5. Renderer freezes while MCP tools still run: report independent browser health and keep external task liveness; do not declare the entire backend stopped. Test in Task 5 and Task 6.

## Current integration points

| Boundary | Source and contract |
| --- | --- |
| Settings, translations, types | `launcher/src/App.tsx` (SettingsSurface ~L1700), `launcher/src/types.ts`, `launcher/src/i18n.ts` |
| Persisted state / IPC | `launcher/electron/state.cjs`, `preload.cjs`, `main.cjs` (`launcher:set-preference` ~L1046) |
| Runtime ownership/setup | `launcher/electron/runtime.cjs` (`runtimeConfigSnapshot`, `runSetup`, `setBrowserInteractionMode`), `runtime-supervisor.cjs` (`validateConfig`) |
| Runtime config / CLI | `src/config.ts`, `src/types.ts`, `src/cli.ts` |
| Browser execution | `src/adapters/chatgpt-web/browser-worker.ts` (`ensureManagedBrowser`, `runExclusive`), `src/browser-login.ts` |
| Browser control/UI | `launcher/electron/browser-host.cjs`, `control-server.cjs`, `src/launcher-browser-host.ts` |
| Tests | `launcher/tests/state.test.cjs`, `renderer-wiring.test.cjs`, `runtime-host.test.cjs`, `runtime-supervisor.test.cjs`, `control-server.test.cjs`, `browser-host.test.cjs`, `tests/browser-worker-contract.test.ts`, `tests/browser-login.test.ts` |

Graphify queries identified `SettingsSurface`, `syncBrowserPreferences`, `BrowserHost`, `BrowserTurn` and `ChatGptBrowserWorker` as the graph entry points. `graphify explain launcher_electron_main_syncbrowserpreferences` returned extracted `main.cjs` call edges. A directed path from Settings to BrowserHost was ambiguous/absent, so task assignments above are confirmed by current source and IPC reads rather than an inferred Graphify edge.

---

### Task 1: Record baseline and validate a minimal real headless turn

**Files:** Create `scripts/benchmark-chatgpt-browser-modes.ts`; create `tests/chatgpt-headless-benchmark.test.ts`; inspect `src/adapters/chatgpt-web/browser-worker.ts` and `src/browser-login.ts`.

**Interfaces:** Produce a JSON measurement report with `{ engine, runId, completed, submissionStatus, wallMs, cpuMs, peakRssBytes, domStalls, rendererUnresponsiveEvents: number | null }`. Use `null` (`N/A`) if the browser engine does not expose an equivalent native renderer signal. Instrument the spawned Chrome process tree as well as Electron; do not export prompt text or session cookies.

- [ ] Write a deterministic test for metric aggregation (correct unit conversions, p50/p95, failures not counted as successes, process-tree totals).
- [ ] Run `bun test tests/chatgpt-headless-benchmark.test.ts`, see the new assertions fail, and implement the minimal benchmark collection/reporting script.
- [ ] With the user's existing verified **managed Chrome** login or a fresh explicit login, run one interactive smoke turn using existing `browserHost: "managed-chrome"`, `headed: false`; validate model selection, accepted send, response extraction, cancellation and cleanup. Make this live step opt-in; no automated login or message submission without operator attendance.
- [ ] Compare to the existing Electron-hidden mode. **Go/no-go:** if Chrome headless cannot authenticate reliably or complete the turn, stop before shipping a Settings toggle and record the blocking behavior and logs (redacted). A successful launch alone is insufficient.
- [ ] Commit only the benchmark harness and tests after reviewing its absence of credentials from reports: `test(perf): establish headless browser baseline`.

### Task 2: Add a persisted, typed and localized Settings control

**Files:** Modify `launcher/electron/state.cjs`, `launcher/src/types.ts`, `launcher/src/App.tsx`, `launcher/src/i18n.ts`, `launcher/electron/preload.cjs`; test `launcher/tests/state.test.cjs`, `launcher/tests/renderer-wiring.test.cjs`.

**Interfaces:** `type AutomaticBrowserEngine = "embedded" | "headless"`; `LauncherState.automaticBrowserEngine`; `LauncherApi.setAutomaticBrowserEngine(engine): Promise<LauncherState>`; new IPC `launcher:automatic-browser-engine`. For the activation transaction, return an updated state only after success.

- [ ] Test v1 settings migration/default, persistence, invalid enum normalization, IPC/preload wiring, `SettingsSurface` checked/disabled/loading/error states, and manual-mode isolation. Test `showBrowserDuringTurns` is remembered when headless is active.
- [ ] Run `bun run launcher:test` and confirm the new tests fail for absent setting/API.
- [ ] Add the switch immediately below the `InteractionModePicker`, disable it during Zero Risk/active transitions, show a separate sign-in action when needed; include copy in all supported `i18n.ts` languages (EN, zh-CN, ja, ko, zh-TW). Use the existing `SettingRow`/`Switch` pattern.
- [ ] Run `bun run launcher:test && bun run launcher:typecheck`; verify feature presentation via actual launcher UI before declaring it visually complete.
- [ ] Commit the bounded UI/state change: `feat(launcher): expose experimental headless setting`.

### Task 3: Make the execution engine a safe launcher-owned runtime choice

**Files:** Modify `src/config.ts`, `src/types.ts`, `src/cli.ts`, `launcher/electron/runtime.cjs`, `launcher/electron/runtime-supervisor.cjs`, `launcher/electron/main.cjs`; test `tests/cli.test.ts`, `tests/config.test.ts` (create only if absent), `launcher/tests/runtime-host.test.cjs`, `launcher/tests/runtime-supervisor.test.cjs`.

**Interfaces:** `RuntimeHost.setAutomaticBrowserEngine(engine: "embedded" | "headless")` is the only mutation point. The runtime's effective `browserHost`/`headed` must be `{ launcher, true }` for embedded or `{ managed-chrome, false }` for headless; `manual` requires `{ launcher, true }`. Keep launcher ownership explicit and independent from `browserHost`, so `managed-chrome` does **not** mean an external daemon. Introduce CLI setup option `--automatic-browser-engine embedded|headless`, preserved by every existing setup/reconfiguration path.

- [ ] Write failing config/CLI/host tests: valid combinations, invalid mixed combinations, backward compatibility, `runtimeConfigSnapshot().owner`, setup preflight, restart rollback and active-turn rejection (including multiple tabs and pending approvals).
- [ ] Run focused tests (`bun test tests/cli.test.ts` and `node --test launcher/tests/runtime-host.test.cjs launcher/tests/runtime-supervisor.test.cjs`) and confirm the new cases fail.
- [ ] Implement a single transactional switch with existing `runSetup` checkpoint/restore, consistent configuration for production/DEV profiles, and startup/doctor validation before persisted state commit. Ensure all CLI setup paths preserve the selected engine unless explicitly reset, including mode/connector changes.
- [ ] Re-run focused tests, `bun run typecheck`, `bun run launcher:test`; confirm interruption and failed startup restore the former engine without resetting credentials or Codex integration.
- [ ] Commit: `feat(runtime): support launcher-owned headless browser engine`.

### Task 4: Authenticate a dedicated Chrome profile safely

**Files:** Modify `src/browser-login.ts`, `launcher/electron/runtime.cjs`, `launcher/electron/main.cjs`, `launcher/src/App.tsx`; test `tests/browser-login.test.ts`, `launcher/tests/renderer-wiring.test.cjs`, `launcher/tests/runtime-host.test.cjs`.

**Interfaces:** Expose `headlessReady` and `headlessFailure` to launcher snapshot; headless authorization requires `browserLoginStateExists(config)` **and** a current successful headed/compatible-capability probe. Define `LauncherApi.loginHeadless(): Promise<{ headlessReady: boolean; headlessFailure: string | null }>` via `launcher:headless-login`; it invokes existing `loginToChatGpt` in a dedicated normal Chrome window, then verifies the state; never hand cookies to renderer JS.

- [ ] Write failing tests for missing/expired/corrupt storage state, cancelled login, active-turn conflict, verified profile isolation, sign-in completion, and storage-state secret redaction in logs.
- [ ] Run `bun test tests/browser-login.test.ts` and focused launcher tests to see the new behavior fail.
- [ ] Wire an explicit sign-in/reconnect CTA and operation status; preserve embedded Electron cookies/session, never copy cookies between engines, never start headless before verified credentials are ready.
- [ ] Verify the visible Chrome login flow on Windows and a successful post-login headless one-turn smoke; verify sensitive files remain in private app paths.
- [ ] Commit: `feat(auth): verify dedicated headless ChatGPT session`.

### Task 5: Restore automatic-turn parity in managed Chrome

**Files:** Modify `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/launcher-helper-client.ts` and `launcher/electron/control-server.cjs` **only where required by parity**; test `tests/browser-worker-contract.test.ts`, `tests/compaction-browser-recovery.test.ts`, `tests/chatgpt-web-harness.test.ts`, `launcher/tests/control-server.test.cjs`.

**Interfaces:** An engine-neutral logical turn ownership contract must expose `traceId`, helper PID/identity, conversation key, accepted-submission receipt, progress, approval state, cancellation, usage and terminal status. A managed turn must never lease an Electron `WebContentsView`; it still reports progress and usage through the existing authenticated launcher control channel or an equivalently scoped token-checked route. Per-conversation retention must have exact-owner cleanup.

- [ ] Write failing contract tests for model/effort, connector tool call+approval, attachments, temporary/saved chat, retained conversation resume, compaction, usage tracking, two concurrent tabs/owners, cancellation and no retry after uncertain submission.
- [ ] Run focused tests and confirm the new parity failures; document any existing launcher-only assumption revealed by these tests.
- [ ] Reuse the existing managed-Chrome Playwright flow while adding only missing ownership/status/retention parity. Ensure headless page lifecycle and browser connections terminate on abort, failure and normal completion, with bounded cleanup, and retain no stale tab in a different conversation.
- [ ] Run `bun test tests/browser-worker-contract.test.ts tests/compaction-browser-recovery.test.ts tests/chatgpt-web-harness.test.ts` and `node --test launcher/tests/control-server.test.cjs`.
- [ ] Validate an authenticated live headless turn using the full native connector and approval flow; **do not release headless** if any automatic feature silently disappears.
- [ ] Commit: `feat(browser): preserve native turn contract in headless Chrome`.

### Task 6: Health, recovery, UI behavior and safe rollback

**Files:** Modify `launcher/electron/main.cjs`, `launcher/electron/browser-host.cjs` only for the presentation boundary, `launcher/src/App.tsx`, `src/adapters/chatgpt-web/browser-worker.ts`; test `launcher/tests/browser-host.test.cjs`, `launcher/tests/renderer-wiring.test.cjs`, `tests/browser-worker-contract.test.ts`.

**Interfaces:** Launcher snapshot exposes `configuredEngine`, `activeEngine`, `headlessReady`, `headlessFailure` and separate `browserUiHealth` versus backend/worker liveness. Switching back to embedded is an explicit setting operation; an automatic preflight fallback to embedded is legal only **before turn acquisition**, without sending a user message. A possibly accepted headless Send produces a clear terminal/needs-attention state.

- [ ] Write failing tests for refusal while busy, early auth/preflight fallback, post-send failure without replay, crash/renderer stall, Cloudflare/captcha needing headed login, reconnection, activity progress while DOM is unresponsive, and restored embedded visibility preference.
- [ ] Confirm red tests, then wire status, diagnostics, operator CTA, error redaction, and transactional recovery on the exact owning turn only. Do not pass arbitrary browser flags or manipulate the page to bypass login controls.
- [ ] Run launcher/worker focused tests. Manually exercise login required, crash recovery, minimize/restore launcher, manual-mode transitions, restart and config rollback on Windows.
- [ ] Commit: `fix(browser): report headless failure and restore embedded safely`.

### Task 7: Benchmark, regression gates and rollout decision

**Files:** Extend `scripts/benchmark-chatgpt-browser-modes.ts`; add verified outcomes and usage notes to `README.md`/app help documentation; avoid unrelated runtime changes.

**Interfaces:** Benchmark report must compare combined Electron+Chrome costs, task completion, accepted submissions, p50/p95 latency, peak RSS and renderer/DOM stall counts for matching workloads. Include environment (OS, Electron/Chrome versions, CPU/RAM), engine mode, sample size and uncertainty, with no prompts or tokens.

- [ ] Run unit/contract checks: `bun run typecheck`, `bun run launcher:typecheck`, `bun run launcher:test`, `bun test ./tests`, `bun run launcher:build`, and package smoke when a build is available. Record pass/fail evidence; do not claim an unrun step passed.
- [ ] Execute a Windows live matrix: sign-in, single turn, 30 alternating sequential turns per engine, 3 concurrent turns, long MCP call, approval, cancellation, retained compaction, restart, Cloudflare/auth required, idle cleanup. Treat each real external message/tool action as opt-in.
- [ ] Apply spec acceptance thresholds (>=15% lower combined CPU p95 **or** >=30% fewer comparably instrumented DOM stalls; <=10% worse task p95 latency; no material total RSS regression; zero behavior regressions). Report Electron `renderer-unresponsive` events independently; mark unavailable headless native events `N/A`. If unmet, report neutral measurements, keep `embedded` the default, and do not advertise a performance gain.
- [ ] Publish a redacted benchmark table and compatibility notes in project documentation, including the existing simpler **Show browser during turns** option and how to return to embedded.
- [ ] Request independent requirements review and separate regression/performance review before merge. Commit only the final validation/docs: `docs: record headless browser rollout validation`.

## Plan self-review before execution

- Spec coverage: opt-in/default (Tasks 2-3), login isolation (4), true headless (1, 3, 5), full turn parity (5), recoverability (3, 6), measurable benefit and rollout (1, 7).
- Highest-risk interfaces: runtime ownership/config validation, persisted state after rollback, launcher helper semantics, connector approvals/limits, and retained conversation identity. All have explicit owning tasks and tests.
- First implementation gate: **Task 1 feasibility**. Do not enable the Settings toggle if live headless ChatGPT cannot authenticate/submit/extract reliably.
- Final gate: all required behavior and benchmarks must be reviewed. A test-green result by itself does not prove reduced freezes.

## Execution handoff

**Recommended:** `superpowers:subagent-driven-development`, with one independent reviewer after each interface-changing task and a whole-branch review, because the runtime and browser-turn contracts cross Electron, Playwright, CLI, and MCP boundaries. Keep each agent in a separate worktree if tasks are parallelized; do not edit the same runtime or browser-control files concurrently. **No implementation has been started by preparing this plan.**
