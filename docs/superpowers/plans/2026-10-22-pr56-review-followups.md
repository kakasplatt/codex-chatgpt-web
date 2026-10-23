# PR #56 Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the three review findings on PR #56: keep the right side of the welcome header clear of the caption buttons, pin the overlay precondition in tests, and define the overlay insets once.

**Architecture:** On non-darwin roots, define two custom properties derived from the Window Controls Overlay geometry: `--titlebar-inset-left` and `--titlebar-inset-right`. The title-bar rules consume these properties instead of repeating `env()`. The test also asserts that `main.cjs` enables `titleBarOverlay` for non-mac windows, because without it the `env(titlebar-area-*)` variables are undefined.

**Tech Stack:** Electron 43.8.3, plain CSS, `node --test` source assertions.

**Spec:** Review of PR #56 (findings 1–3), plan `2026-10-22-issue43-electron43-titlebar-overlay.md`.

## Global Constraints

- Do not touch the darwin rules.
- When the overlay variables are absent, both insets must compute to `0px`: `titlebar-area-x` falls back to `0px` and `titlebar-area-width` falls back to `100vw`.
- On Windows, the left values must stay `8px` and `20px`. The right value changes from `20px` to `20px` plus the caption-button width. That change is intended (finding 1).
- Commits use `Refs #43`.

## Review Focus

- Windows welcome screen: `v<version>` must sit left of minimize/maximize/close.
- Windows main screen: the title bar must be unchanged, and the user's screenshot is the baseline. Only `.titlebar-left` uses the left inset there.
- Linux with left-side buttons: the left inset equals the width of the controls, and the right inset is about `0`.
- Overlay absent: the layout is identical to before PR #56.

---

### Task 1: Shared overlay insets and the right-side welcome padding

**Files:**
- Modify: `launcher/src/styles.css`. Add a `.app-root:not([data-platform="darwin"])` block that defines both properties. Update the non-darwin `.titlebar-left` and `.welcome-top` rules.
- Test: `launcher/tests/renderer-wiring.test.cjs`, in the test `non-darwin title bar insets follow the Window Controls Overlay`.

**Interfaces:**
- Produces:
  - `--titlebar-inset-left: env(titlebar-area-x, 0px)`
  - `--titlebar-inset-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))`

- [ ] **Step 1: Update the test.** Assert that:
  - both property definitions exist exactly as written above;
  - `.titlebar-left` contains `left: calc(var(--titlebar-inset-left) + 8px)`;
  - `.welcome-top` contains `padding-left: calc(var(--titlebar-inset-left) + 20px)` and `padding-right: calc(var(--titlebar-inset-right) + 20px)`;
  - `electronMain` matches `/titleBarStyle: isMac \? "hiddenInset" : "hidden"/` and `/titleBarOverlay:\s*\{/`;
  - `left: 76px` is still present.
- [ ] **Step 2: Run the failing test.** Run `node --test --test-name-pattern="Window Controls Overlay" tests/renderer-wiring.test.cjs` in `launcher/`. Expected: FAIL.
- [ ] **Step 3: Implement the CSS** as described in the Interfaces block.
- [ ] **Step 4: Run the full checks.** Run `node --test tests/*.test.cjs` and `bun run build` in `launcher/`. Expected: PASS, apart from the environmental failures documented in AGENTS.md.
- [ ] **Step 5: Commit.** Use the message `fix(launcher): keep the welcome header clear of the caption buttons`, with `Refs #43`.

### Out of scope

Finding 2 also needs a human check that Electron 43 on Linux actually defines `titlebar-area-x`. This stays manual on #43.
