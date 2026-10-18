# Experimental Headless ChatGPT Automation Design (prototype; validation pending)

> **Status · 2026-10-17:** An initial source-only implementation now exposes a reversible
> headless Settings control and uses the existing Playwright-managed Chrome worker.
> It is limited to production **browser-only / automatic** turns; Full MCP,
> Zero Risk and DEV remain unsupported. The broader design below describes
> target behavior, not capabilities proven in the current prototype.
> Authenticated headless smoke and matched performance measurements are pending:
> Google Chrome was not present in the standard Windows paths on the test host.
> Do not release this as a validated performance improvement.

## Intent and scope

The user wants a setting that runs **automatic ChatGPT interactions in true Chromium headless mode** to reduce launcher UI freezes and, when measurable, resource consumption. The setting should be optional, reversible, and usable from the existing launcher Settings page. The original design preceded the partial source implementation; independent review and the live acceptance gates are still outstanding.

“Headless” here means that an automatic turn runs in a Chromium instance launched without a native window. It is distinct from the existing **Show browser during turns** preference, which only hides an Electron `WebContentsView`. Do not market merely moving a view offscreen, Electron `offscreen` painting, disabling animations, or minimizing the launcher as true headless execution.

## Current source-backed boundaries

- `launcher/src/App.tsx` (`SettingsSurface`, ~L1700-2025) already exposes **Automatic / Zero Risk** and **Show browser during turns**.
- `launcher/electron/state.cjs` stores Settings in version-1 `launcher-state.json`; `launcher/src/types.ts`, `launcher/electron/preload.cjs`, and `launcher/electron/main.cjs` implement typed preference IPC.
- `launcher/electron/control-server.cjs` leases automatic browser turns to `BrowserHost` and consults `showBrowserDuringTurns`; `launcher/electron/browser-host.cjs` (~L1728-1827) keeps running `WebContentsView`s drawable offscreen to preserve nonzero viewports/CDP ownership. This is not headless.
- `src/adapters/chatgpt-web/browser-worker.ts` (~L2709-2755) already has a `managed-chrome` path with `chromium.launch({ headless: !config.headed })`; the launcher path connects to an Electron-owned CDP page.
- `launcher/electron/runtime-supervisor.cjs` (~L190-255) currently requires `browserHost === "launcher"`. `launcher/electron/runtime.cjs` (~L445-470) also confuses browser ownership with launcher-runtime ownership when classifying `managed-chrome` as `external`. Merely changing `headed` cannot switch the launcher safely.
- `src/browser-login.ts` (~L380-450) supports explicit, visible Chrome login and saves a verified Playwright storage state. It does not imply that an existing Electron session can be silently reused by headless Chrome.
- `browser-worker.ts` uses launcher turn leasing/heartbeats and tracks renderer health through its launcher path. The managed path needs parity for cancellation, progress, capability detection, conversation retention, limits, and tool calls before it can replace that path.

Graphify discovery: queries for `SettingsSurface`, `syncBrowserPreferences`, `BrowserHost`, `BrowserTurn`, and `ChatGptBrowserWorker` found the source nodes above; `graphify explain launcher_electron_main_syncbrowserpreferences` reported extracted call edges in `launcher/electron/main.cjs`. A direct path from Settings to BrowserHost was ambiguous/not present in the directed graph; direct source reads establish the IPC/control-flow boundaries.

## Approaches considered

| Approach | Change | Benefit | Drawback |
| --- | --- | --- | --- |
| A. Existing hidden Electron surface | Disable `showBrowserDuringTurns` | Already supported, immediate rollback | Renderer and DOM still run and may hang; does not satisfy headless requirement |
| B. Electron offscreen rendering | Render into a bitmap/texture | Keeps Electron partition/ownership | Still performs rendering and can add copying/CPU cost; does not satisfy true headless requirement |
| **C. Managed Chromium headless (recommended experimental design)** | Route automatic turns into independently managed Playwright Chrome with `headless: true` | Real headless browser; separates active page renderer from launcher UI | Requires a separate verified login state, lifecycle/ownership changes, and feature-parity testing; performance gain is unproven |

## Proposed product contract

1. Introduce `AutomaticBrowserEngine = "embedded" | "headless"`, persisted as `automaticBrowserEngine`, default `"embedded"`. Keep `browserInteractionMode = "automatic" | "manual"` independent. Never introduce headless as a third interaction mode.
2. Settings: **Headless mode (experimental)** switch beneath the interaction-mode picker with text: “Run automatic ChatGPT tasks without opening a browser window. Requires a separate Chrome sign-in. Performance improvements depend on your machine.” Show active engine and actionable sign-in/error state. Translate all supported languages in `launcher/src/i18n.ts`.
3. The switch is disabled/inactive in manual Zero Risk mode and during active turns or setup/login operations. Preserve the preference when switching to manual, but execute manual turns visibly; on returning to automatic, revalidate headless credentials before using the saved choice.
4. Existing `showBrowserDuringTurns` remains persisted. While headless is active, disable that switch with explanation; restore its previous behavior when returning to embedded. The browser tab remains available for setup/login/diagnostics; headless tasks cannot be displayed as live embedded tabs.
5. `embedded`: current Electron `browserHost: "launcher"` remains the default, with its existing session and CDP contract. `headless`: automatic worker uses `browserHost: "managed-chrome"`, `headed: false`, and a verified dedicated Chrome storage state. The launcher still owns the Responses daemon/tunnel lifecycle; browser execution location must not change that ownership classification.
6. Activation is transactional: block if any active automatic/manual turn, pending approval, login, or runtime transition exists; validate browser installation and verified login; preflight configuration; restart only the affected runtime, run health/contract checks; commit preference **after** healthy startup. Failure restores the prior engine and runtime without discarding existing settings or credentials.
7. Authentication is explicit via the existing `loginToChatGpt` flow, with a separate visible Chrome window when required. Never export raw Electron-session cookies or copy secrets to the renderer. If ChatGPT requires sign-in, CAPTCHA/Cloudflare or other interactive steps, show an action to open a headed sign-in flow; never bypass the challenge.
8. Preserve all automatic capabilities: models/efforts, images/attachments, custom connector/MCP tool approvals, cancellations, diagnostics, temporary/saved chats, retained conversation and compaction, limits tracking, concurrent turn isolation and exact-owner cleanup. A missing parity item **blocks enabling headless**; it must not be silently disabled.
9. No implicit retry after submission is accepted or might have been accepted. If headless fails mid-turn, preserve ambiguous submission state, report the exact failure and offer an explicit next action. Automatic fallback to embedded is permitted only during preflight **before a turn is leased/started**, after a verified authentication/runtime failure; do not switch engines inside an active turn, re-send a possibly accepted prompt or repeat tool side effects.
10. Expose `configuredEngine`, `activeEngine`, `headlessReady`, and `headlessFailure` in a typed snapshot. Log engine transitions, startup failures, renderer/DOM stalls, CPU/RSS observations and cleanup, omitting cookies, prompt contents, credentials and raw ChatGPT page HTML.

## Acceptance and rollout

- Keep existing installs and settings unchanged by default (`embedded`); both launch profiles retain their isolated user-data/session paths.
- Windows (primary target) must pass login + 1-turn smoke + 30 sequential turns + 3 concurrent turns + cancellation + retained continuation + approval + recovery in each engine. Validate macOS/Linux packaging and platform-specific Chrome paths before marking them supported.
- Benchmark matched workloads (at least 30 turns per engine, alternating order) with machine-level CPU, memory (Electron **and** Chrome child processes), p50/p95 completion latency, common DOM-observation stalls, accepted-send/completion counts, and launcher-UI unresponsiveness. Keep native Electron `renderer-unresponsive` events in a separate **platform-specific** column; a headless Chrome run with no equivalent native event must be marked `N/A`, not zero. Separate browser responsiveness from backend/tool liveness.
- Declare a performance win only when measured: target at least 15% lower combined active CPU p95 **or** at least 30% fewer **comparably instrumented DOM stalls**, with no more than 10% worse p95 task latency, no meaningful increase in peak total RSS, and no correctness regressions. Report launcher-UI freezes separately. If results miss the target, keep embedded as default, report the measurements, and do not promise improvement.
- Do not replace the Electron page by `setVisible(false)` or turn background throttling on during active DOM automation: existing viewport/ownership tests show why this can break input and Playwright probes.

## Exclusions

- No ChatGPT private API requests, service authentication bypass, or unsupported browser flags as a substitute for true headless operation.
- No automatic conversion of an existing Electron login into a Playwright storage-state credential.
- No changes to Zero Risk manual message flow, MCP permissions, model routing defaults, usage-limit avoidance, or persistent browser-profile security policy.

## References

- Playwright browser/headless modes: https://playwright.dev/docs/browsers
- Electron `backgroundThrottling`: https://www.electronjs.org/docs/latest/api/web-contents
- Electron offscreen rendering (separate concept): https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
