# Durable ChatGPT Conversation Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reopen the saved ChatGPT conversation associated with a resumed Codex thread after the Launcher process has lost its in-memory retained tab.

**Architecture:** Persist `conversationKey -> canonical /c/<id> URL + connector identity` in the Launcher profile. `BrowserHost` restores that URL before leasing the tab and reports the existing `reused=true` signal, so the worker's current `prepareResume()` path remains unchanged. A failed restore is deleted and falls back to a fresh full-context turn unless the caller explicitly requires retained history.

**Tech Stack:** Electron/CommonJS Launcher, TypeScript adapter, Node test runner, Bun verification.

**Spec:** `docs/superpowers/specs/2026-10-05-resume-chatgpt-conversation-design.md`

## Global Constraints

- Preserve the existing `conversationKey` identity and `prepareResume()` contract.
- Do not persist temporary chats, prompt content, response content, cookies, or tool data.
- Preserve Zero Risk/manual behavior.
- Never log the saved conversation URL or UUID.
- Use the existing private atomic-file writer and profile-specific `userData` directory.
- Preserve the privacy meaning of Temporary Chat; durable cross-process `/resume` restoration is available only for saved ChatGPT conversations.

## Review Focus

- Persisted URL redirects or becomes unavailable: ordinary resume must resend full context in a fresh conversation; required retention must fail closed.
- Connector identity mismatch: never restore the saved conversation for a different connector.
- Temporary chat URL: keep only process-local retention and do not create durable state.
- Retention setting changes: clear durable history only after the setting transaction succeeds.
- Explicit retained-conversation release/compaction handoff: remove durable state as well as ready tabs.

---

### Task 1: Durable retained-conversation store

**Files:**
- Create: `launcher/electron/retained-conversation-store.cjs`
- Create: `launcher/tests/retained-conversation-store.test.cjs`

**Interfaces:**
- Produces: `canonicalChatGptConversationUrl(value)`, `RetainedConversationStore#get`, `remember`, `delete`, and `clear`.

- [x] Write failing tests for canonical URL validation, reload persistence, connector isolation, invalid-file tolerance, bounded retention, and persistence-failure rollback.
- [x] Run the focused store test and verify RED because the module/behavior does not exist.
- [x] Implement the private atomic JSON store with a 256-entry recency cap and transactional in-memory mutations.
- [x] Run the focused store test and verify GREEN.

### Task 2: BrowserHost restore/capture/release behavior

**Files:**
- Modify: `launcher/electron/browser-host.cjs`
- Modify: `launcher/electron/retained-turn-release.cjs`
- Modify: `launcher/tests/browser-host.test.cjs`
- Modify: `launcher/tests/control-server.test.cjs`

**Interfaces:**
- Consumes: `RetainedConversationStore` interface from Task 1.
- Produces: restored automatic lease with the existing `{ reused: true, connectorBound: true }` contract.

- [x] Write failing tests for persisted restore, stale restore fallback, required-retention failure, final URL capture, durable release, real initial-URL bootstrap, privacy-safe navigation diagnostics, and durable-release failure.
- [x] Run the focused Launcher tests and verify RED.
- [x] Update automatic tab initialization to accept a persisted initial URL and teach `beginTurn()` to restore it after in-memory lookup.
- [x] Persist/canonicalize the final retained URL in `endTurn()` and delete stale entries when appropriate.
- [x] Delete durable mappings through the existing retained-release path and fail release before tab removal if durable deletion cannot be persisted.
- [x] Run the focused Launcher tests and verify GREEN.

### Task 3: Launcher wiring and retention-policy invalidation

**Files:**
- Modify: `launcher/electron/main.cjs`
- Modify: `launcher/tests/browser-host.test.cjs`

**Interfaces:**
- Consumes: `RetainedConversationStore` and the profile-specific Electron `userData` path.
- Produces: one store instance shared by `BrowserHost` and retention-setting cleanup.

- [x] Write a failing wiring/setting regression assertion.
- [x] Instantiate `retained-conversations.json` in profile `userData` and pass it into `BrowserHost`.
- [x] Clear durable mappings after a committed `experimentalFreshConversationPerTurn` or `useSavedChats` policy change.
- [x] Run Launcher tests, Launcher typecheck/build, root typecheck/tests, and release smoke verification. The repository-wide `verify` wrapper is currently stopped earlier by the pre-existing Launcher dependency audit advisory for `http-cache-semantics@4.2.0` (`GHSA-ch52-4w7c-c8xp`).
