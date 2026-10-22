# Issue #46 — Upstream sync keeping Electron 43 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `upstream/main` (`0901b9f`) into the fork while keeping Electron 43.8.3, the launcher `postinstall` binary install and its contract test, and the #28 midnight/broad-root behavior.

**Architecture:** One real merge commit (precedent: `6aad886 Merge upstream/main (6.1.13) into main`) on branch `kakasplatt/upstream-sync-will-conflict-on-the-electron-vers`, followed by one test commit that covers where upstream #884 (compaction + midnight delta) meets fork #28 (full-access context roots + broad-root guard). No rebase or squash, so the next sync does not re-conflict on the same hunks.

**Tech Stack:** Git, Bun 1.4.0 (`.tools\bun-1.4.0\bun.exe`), TypeScript (`bun test`), Electron launcher (`node --test`).

**Spec:** GitHub issue kakasplatt/codex-chatgpt-web#46.

**Planning note:** `docs/superpowers/model-selection.md` assigns `writing-plans` to Opus 5.5 / high; this plan was written in a session that switched to Haiku 5.5, with the key resolution decision reviewed by the Opus advisor.

## Evidence (collected 2026-10-22)

- `git merge-tree --write-tree --name-only main upstream/main` reports exactly three conflicts: `launcher/package.json`, `launcher/bun.lock`, `src/adapters/chatgpt-web/thread-environment.ts`. Auto-merged: `environment.ts`, `server.ts`, `tests/environment.test.ts`, `tests/server-compaction.test.ts`, plus upstream-only `src/responses/native-context.ts`, `src/responses/parser.ts`, `tests/responses-agent-message.test.ts`.
- Upstream's Electron change `bb37955` touches only `launcher/package.json` and `launcher/bun.lock` (one version line each); no permission-handler code. Dropping its pin loses nothing but the version number.
- `launcher/tests/packaging-contract.test.cjs` is unchanged upstream, so it auto-merges and keeps the fork's `postinstall` assertion.
- The third conflict is not in the issue: upstream #884 introduced `resolvedCalendarDelta = calendarDelta ?? currentClaim?.calendarDelta` (a delta carried by a compaction continuation), while fork #28 replaced the same strict root check with the `contextRoots` relaxation and `refusesContext` guard.
- Graphify (`graphify query`, existing graph) locates `electron` at `launcher/package.json:34` and `packaging-contract.test.cjs` in the launcher packaging community; no other code node depends on the version number.

## Global Constraints

- Electron stays `"43.8.3"` (issue floor: `>= 43.7.0`).
- `launcher/package.json` keeps `"postinstall": "node node_modules/electron/install.js"`, no `pretest`, `"test": "node --test tests/*.test.cjs"`.
- `launcher/bun.lock` is produced by Bun **1.4.0** (`.tools\bun-1.4.0\bun.exe`), not the local 1.4.3.
- Merge commit, not rebase/squash. Do not push or open a PR without the user's go-ahead.
- Proposing the Electron 43 upgrade upstream (miuuyy) is outward-facing: optional, only with explicit user OK.

## Review Focus

1. Compaction continuation + midnight delta, full-access rollout without `workspace_roots`, repeated matching roots → roots kept (Task 2, test A).
2. Same, but the delta adds a broad root (user home / trusted Codex home) → `"Calendar environment delta conflicts"` (Task 2, test B).
3. Compaction continuation + midnight delta using the #28 bullet worker inventory (`- <thread id>: <name>`) through upstream's `afterEnvironmentIndex` path → accepted (Task 2, test C).
4. A fresh `bun install --frozen-lockfile` in `launcher/` installs the Electron 43 binary (postinstall) so root tests that `require("electron")` run (Task 1, step 6).
5. Managed (non-full-access) compaction + midnight still rejects any root change — upstream test `compaction plus midnight keeps native ${mode} network=${networkAccess}` must pass unchanged (Task 1, step 7).

---

### Task 1: Merge upstream/main and resolve the three conflicts

**Files:**
- Modify (conflict): `launcher/package.json`, `launcher/bun.lock`, `src/adapters/chatgpt-web/thread-environment.ts` (~lines 286–312 of the merged file)
- Check: `launcher/tests/packaging-contract.test.cjs`

**Interfaces:**
- Consumes: `resolvedCalendarDelta: ChatGptCalendarEnvironmentDelta | undefined` (from upstream, `{ workspaceRoots: string[][]; filesystemProfiles: string[] }`), fork's `refusesContext(roots, nativeRoots)` and `pathIdentity`.
- Produces: merge commit whose `thread-environment.ts` applies the #28 rules to every calendar delta, including compaction-sourced ones.

- [ ] **Step 1: Confirm clean state and fresh refs**

Run: `git status --short; git fetch upstream; git rev-parse upstream/main`
Expected: empty status; `0901b9f…` (if upstream moved, re-run `git merge-tree --write-tree --name-only main upstream/main` and stop if the conflict set changed).

- [ ] **Step 2: Start the merge**

Run: `git merge --no-ff --no-commit upstream/main`
Expected: `CONFLICT` in exactly the three files above.

- [ ] **Step 3: Resolve launcher manifests to ours**

Run: `git checkout --ours launcher/package.json launcher/bun.lock`
Then: `git diff main -- launcher/package.json launcher/bun.lock` → empty.

- [ ] **Step 4: Resolve `thread-environment.ts`**

Take the fork (`main`) side of the hunk and rename every `calendarDelta.` inside it to `resolvedCalendarDelta.` (four uses: `.workspaceRoots.map`, `.filesystemProfiles.some`, two `.workspaceRoots.at(-1)!`). Keep upstream's surrounding `const resolvedCalendarDelta = …` and `if (resolvedCalendarDelta) {`. Do not take upstream's strict exact-roots block — it reverts #28 (tests `tests/environment.test.ts:1415-1576` would fail). Decision for the user to veto: the full-access relaxation now also applies to deltas carried by a compaction continuation; `refusesContext` still guards broad roots, matching the `currentClaim` widening a few lines above.

Run: `git diff --check; Select-String -Path src/adapters/chatgpt-web/thread-environment.ts -Pattern '^(<<<<<<<|=======|>>>>>>>)'`
Expected: no output.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck` (root)
Expected: no errors (a leftover bare `calendarDelta.` would fail as possibly undefined).

- [ ] **Step 6: Regenerate and verify the lockfile with pinned Bun**

Run in `launcher/`: `..\.tools\bun-1.4.0\bun.exe install --frozen-lockfile`
Expected: success, Electron 43.8.3 binary installed by `postinstall`; `git diff main -- launcher/bun.lock` empty. If frozen install fails, run `..\.tools\bun-1.4.0\bun.exe install` and inspect the lock diff — only `electron@43.8.3` entries may differ from upstream's side.

- [ ] **Step 7: Focused tests**

Run: `bun test tests/environment.test.ts tests/server-compaction.test.ts tests/responses-agent-message.test.ts`
Expected: PASS, including upstream's `compaction plus midnight keeps native …` and fork's `a midnight delta …` tests.
Run in `launcher/`: `node --test tests/packaging-contract.test.cjs`
Expected: PASS including `installing launcher dependencies installs the Electron binary before any test or dev run`.

- [ ] **Step 8: Commit the merge**

```bash
git add launcher/package.json launcher/bun.lock src/adapters/chatgpt-web/thread-environment.ts
git commit -m "Merge upstream/main into main keeping Electron 43.8.3 (#46)" -m "Keep the fork's Electron 43.8.3 pin, launcher postinstall and contract test over upstream's 42.11.3. Apply #28's full-access context roots and broad-root guard to upstream #884's compaction-carried calendar delta."
```

### Task 2: Cover compaction + midnight delta with full-access context roots

**Files:**
- Test: `tests/environment.test.ts` (next to the `undeclaredRolloutMidnightFixture()` tests, ~line 1415, and upstream's `compaction plus midnight keeps native …`)

**Interfaces:**
- Consumes: `undeclaredRolloutMidnightFixture()` → `{ codexHome, request, body, delta, rolloutPath, visualizationRoot, repeatRoots }`; the compaction setup from upstream's `compaction plus midnight keeps native …` test (`rememberCompactionContinuation`, `encodeCompactionSummary`, `rolloutParentId`, `content_item_kinds: ["environments.environment_context"]`). Factor that setup into a local helper `asCompactionContinuation(fixture, summary)` if used three times.

- [ ] **Step 1: Write the tests**

- A `"compaction plus midnight keeps repeated workspace context when a full-access rollout omits workspace_roots"`: `repeatRoots(delta, root, visualizationRoot)`, convert to a compaction continuation, `expect(store.resolve(request)).toEqual({ cwd: root, roots: [root, visualizationRoot], writableRoots: [root, visualizationRoot], sandboxPolicy: { type: "dangerFullAccess" }, tools: [] })`. The full preamble's environment must use full access with the same cwd so the earlier `currentClaim` widening does not mask the delta path; assert `roots` comes from the delta by using roots that the preamble does not list.
- B `"compaction plus midnight cannot add a trusted Codex home as workspace context"`: `repeatRoots(delta, root, codexHome)` → `toThrow("Calendar environment delta conflicts")`.
- C `"compaction plus midnight accepts a native bullet worker inventory (#27)"`: reuse the bullet-inventory delta from the test at ~line 1620 in the compaction setup → resolves to the rollout cwd.

- [ ] **Step 2: Prove the tests bite**

Temporarily replace the Task 1 resolution with upstream's strict block; run `bun test tests/environment.test.ts -t "compaction plus midnight"`.
Expected: A FAILS (`Calendar environment delta conflicts`). Restore the resolution (`git checkout -- src/adapters/chatgpt-web/thread-environment.ts`).

- [ ] **Step 3: Run them green**

Run: `bun test tests/environment.test.ts`
Expected: PASS. If B or C fails with the real resolution, stop: that is a genuine sync bug — use superpowers:systematic-debugging before changing code.

- [ ] **Step 4: Commit**

```bash
git add tests/environment.test.ts
git commit -m "test(environment): cover compaction-carried midnight deltas with full-access context roots (#46)"
```

### Task 3: Full verification and handoff

- [ ] **Step 1: Full gate with pinned Bun**

Run: `.\.tools\bun-1.4.0\bun.exe run verify`
Expected: all steps pass. On `EPERM` (symlink tests in `tests/codex-integration.test.ts`, `launcher/tests/runtime-host.test.cjs`) or execution-policy failures (`launcher/tests/windows-installer.test.cjs`), re-run those on base `8379a7b` in a separate worktree and report as environmental if they fail there too.

- [ ] **Step 2: Review the diff against main**

Run: `git diff main --stat` and `git diff main -- launcher/`
Expected: no `launcher/` changes at all; source changes limited to upstream's commits plus the four renamed identifiers.

- [ ] **Step 3: Report and wait**

Report checks run and results; state explicitly that authenticated ChatGPT-session behavior (compaction across midnight, `docs/release-validation.md`) was not exercised. Then ask the user before: pushing the branch, opening the PR to `main` (body ends with the Claude Code attribution line and `Closes #46`), and the optional upstream proposal of Electron 43 + install-time binary fix.
