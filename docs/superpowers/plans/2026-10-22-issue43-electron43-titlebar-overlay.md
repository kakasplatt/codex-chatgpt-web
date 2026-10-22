# Issue #43 — Electron 43 Window Controls Overlay Insets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the launcher's title-bar content clear of the native window controls on Windows/Linux now that Electron 43 makes the Window Controls Overlay follow the native title-bar layout.

**Architecture:** The non-darwin windows use `titleBarStyle: "hidden"` + `titleBarOverlay` (`launcher/electron/main.cjs:408-420`), so the renderer receives the `env(titlebar-area-*)` CSS variables. Replace the fixed non-darwin left offsets with offsets derived from `env(titlebar-area-x, 0px)`. On Windows (controls on the right) `titlebar-area-x` is `0`, so computed values equal today's; on Linux with left-side controls the content shifts past them.

**Tech Stack:** Electron 43.8.3, React/Vite renderer, plain CSS, `node --test` source-assertion tests.

**Spec:** https://github.com/kakasplatt/codex-chatgpt-web/issues/43 (Linux title-bar item).

## Pertinence verdict

The issue is pertinent as a manual-validation checklist. Code inspection (Graphify query + source):

| Item | Status |
| --- | --- |
| Export safe log opens save dialog in Documents | Verified in code: `main.cjs` `launcher:export-logs` uses `app.getPath("documents")`. Needs human on packaged builds. |
| Manual turn copies prompt (sync `clipboard.writeText`) | Verified in code: `browser-host.cjs` calls `this.clipboard.writeText(prompt)` synchronously. Needs human. |
| Linux title bar / WCO overlap with `.titlebar-left` (`left: 8px`) | **Code remedy (this plan).** Rounded-corner clipping still needs a human on Linux. |
| macOS `UNNotification` | Verified: no `Notification` usage in `launcher/src` or `launcher/electron`. |
| Main window, browser pane, tray, authenticated flows | Human-only; not provable by automated tests. |

## Global Constraints

- Do not change the darwin rules (`.titlebar-left { left: 76px }`, `.welcome-top` padding `0 20px 0 96px`).
- Fallbacks must reduce to the current values when `env(titlebar-area-*)` is absent.
- Commit text uses `Refs #43`, never `Fixes`/`Closes` (manual items remain).

## Review Focus

- Windows (controls on the right): `.titlebar-left` must stay at 8px; `titlebar-area-x` = 0 guarantees it.
- Linux with `close,minimize,maximize:` button layout: sidebar button must start after the controls.
- Overlay hidden/absent (env undefined): fallback `0px` keeps 8px/20px.
- Welcome screen header on Linux left-side layout: brand must not sit under the controls.
- macOS: untouched selectors, so no change.

---

### Task 1: WCO-aware non-darwin title-bar insets

**Files:**
- Modify: `launcher/src/styles.css` (`.app-root:not([data-platform="darwin"]) .titlebar-left`, `.app-root:not([data-platform="darwin"]) .welcome-top`)
- Test: `launcher/tests/renderer-wiring.test.cjs`

- [ ] **Step 1: Write the failing test** `non-darwin title bar insets follow the Window Controls Overlay`: assert `stylesSource` contains `left: calc(env(titlebar-area-x, 0px) + 8px)` and `padding-left: calc(env(titlebar-area-x, 0px) + 20px)`, and still contains `left: 76px`.
- [ ] **Step 2: Run** `node --test tests/renderer-wiring.test.cjs` in `launcher/` → FAIL on the new test.
- [ ] **Step 3: Implement** the two declarations in the non-darwin rules.
- [ ] **Step 4: Run** `node --test tests/*.test.cjs` and `bun run build` in `launcher/` → PASS (environmental EPERM/execution-policy failures reported separately).
- [ ] **Step 5: Commit** `fix(launcher): offset title bar content by the window controls overlay` with `Refs #43`.

### Manual (out of scope for code; stays on the issue)

Packaged-app checks on all three OSes, Linux rounded corners, tray, macOS notifications sanity, authenticated flows from `docs/release-validation.md`.
