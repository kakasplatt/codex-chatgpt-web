# PR #11 Review Findings Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the Full Context multipart planner so physical planning includes recovery-checkpoint prompt overhead when checkpoint capture is active, and make the PR pass `git diff --check` without unrelated changes.

**Architecture:** Keep `resolveFullContextMultipartPlan()` as the single place that chooses the smallest safe Full Context part count. Preserve the current checkpoint-activation rule by leaving canonical planning checkpoint-free, but allow the physical-input planner to include the exact `captureCheckpoint: "full"` overhead that `compileChatGptWebPrompt()` will send. Treat the EOF cleanup as an independent mechanical change with no formatter or semantic rewrites.

**Tech Stack:** TypeScript, Bun test runner, ChatGPT Web adapter, PowerShell/Git.

**Spec:** `docs/superpowers/specs/2026-10-03-full-context-hybrid-design.md`

## Global Constraints

- Small Full Context threads must not begin paying checkpoint overhead merely because the checkpoint contract itself would force multipart transport.
- Checkpoint capture starts only when the canonical normal-turn request already requires Full Context multipart, or when an exact-parent Full Context checkpoint already exists.
- Codex usage accounting remains based on canonical logical input, not retained-resume/recovery physical input or checkpoint prompt overhead.
- Browser preflight must validate the exact physical prompt that will be submitted.
- Do not split an individual Codex message or JSON record to make it fit.
- Preserve Bigger Context, Luna, Zero Risk, skill-attachment, retained-conversation, and compaction behavior.
- Do not run a repository-wide formatter or change line endings while fixing EOF whitespace.

## Review Focus

- Boundary where canonical planning needs two parts, but adding the Full checkpoint contract makes the two-part physical final message exceed the 81,807-token Plus budget: physical planning must promote to three parts.
- Small inline canonical requests: checkpoint overhead must not bootstrap checkpoint capture or force multipart by itself.
- Existing checkpoint chain with a small recovery/resume input: physical planning must include checkpoint overhead while usage accounting remains canonical.
- Full Context with checkpoint capture near the 12-part maximum: the planner must either choose a fitting count through 12 or fail before Send; it must never return a physically invalid count.
- Pro-capable accounts and attachment/schema reservations: the new checkpoint-aware path must continue using the existing per-effort token/character budgets and final-attachment reservations.

---

### Task 1: Make Full Context physical planning checkpoint-aware

**Files:**
- Modify: `src/adapters/chatgpt-web/usage.ts:148-253`
- Modify: `src/adapters/chatgpt-web/index.ts:456-509`
- Test: `tests/chatgpt-web-usage.test.ts:113-190`
- Test: `tests/chatgpt-web-harness.test.ts:4160-4339`

**Interfaces:**
- Consumes: `compileChatGptWebPrompt(parsed, capabilities, turnToken, options)` and the existing `shouldCaptureFullCheckpoint` decision in `createChatGptWebAdapter()`.
- Produces: `resolveFullContextMultipartPlan(parsed, capabilities, experimentalSkillAttachments = false, includeFullCheckpoint = false): ChatGptWebMultipartPartCount | undefined`.
- Contract: `includeFullCheckpoint=false` preserves canonical/logical planning; `includeFullCheckpoint=true` compiles candidates with `captureCheckpoint: "full"` so the selected count matches the physical browser payload.

- [ ] **Step 1: Add a failing unit regression for the exact two-to-three-part boundary**

Add a focused test in `tests/chatgpt-web-usage.test.ts` using Plus/Sol High capabilities:

```ts
const plus = {
  localToolsEnabled: false,
  solAvailable: true,
  extraHighAvailable: false,
  proAvailable: false,
};

const parsed = request("");
parsed.context.messages = [
  { role: "user", content: "intro ".repeat(1_000), timestamp: 1 },
  { role: "user", content: "word ".repeat(80_600), timestamp: 2 },
];

expect(resolveFullContextMultipartPlan(parsed, plus)).toBe(2);
expect(resolveFullContextMultipartPlan(parsed, plus, false, true)).toBe(3);
```

Then compile the returned checkpoint-aware count with `captureCheckpoint: "full"` and assert it passes the same physical multipart limit helper already used in this test file. This pins the demonstrated regression: two parts produce a final message of 81,861 tokens against an 81,807-token budget, while three parts fit.

- [ ] **Step 2: Run the focused test and confirm the new assertion fails before implementation**

Run:

```powershell
bun test tests/chatgpt-web-usage.test.ts
```

Expected before the code change: the new checkpoint-aware call cannot return `3` because the planner has no checkpoint-overhead input yet.

- [ ] **Step 3: Add an explicit checkpoint-overhead input to `resolveFullContextMultipartPlan()`**

Change the signature in `src/adapters/chatgpt-web/usage.ts` to:

```ts
export function resolveFullContextMultipartPlan(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
  includeFullCheckpoint = false,
): ChatGptWebMultipartPartCount | undefined
```

Inside the local `compile(parts)` helper, add:

```ts
captureCheckpoint: includeFullCheckpoint ? "full" : undefined,
```

Do not add a token safety margin. The planner must measure the real prompt generated by `compileChatGptWebPrompt()`, not estimate an extra constant separately.

- [ ] **Step 4: Wire only physical-input planning to the checkpoint-aware mode**

In `src/adapters/chatgpt-web/index.ts`, preserve the first canonical call used to compute `canonicalRequiresMultipart` without the fourth argument:

```ts
canonicalRequiresMultipart = resolveFullContextMultipartPlan(
  parsed,
  turnCapabilities,
  experimentalSkillAttachments,
) !== undefined;
```

This call must stay checkpoint-free so a small inline request cannot create a circular condition where checkpoint overhead itself causes checkpoint capture to start.

In `compileOptionsFor(input)`, pass `shouldCaptureFullCheckpoint` as the fourth argument:

```ts
const experimentalMultipartParts = resolveFullContextMultipartPlan(
  input,
  turnCapabilities,
  experimentalSkillAttachments,
  shouldCaptureFullCheckpoint,
);
```

Leave `estimateChatGptWebUsage()` on the default `includeFullCheckpoint=false` path. Its job is logical canonical usage accounting, per the spec, not physical browser prompt sizing.

- [ ] **Step 5: Add an adapter-level regression proving the wiring reaches physical preparation**

Add a focused case beside the existing Full Context integration test in `tests/chatgpt-web-harness.test.ts` that:

- enables Full Context with a valid thread/turn identity so checkpoint capture can activate;
- uses a Plus-style capability set (`proAvailable: false`, `extraHighAvailable: false`);
- uses the same boundary payload from Step 1;
- intercepts `turn.prepare()` as the existing harness test already does;
- asserts checkpoint capture mode is `full` and the prepared multipart payload has three parts, not two;
- keeps the canonical usage assertion independent from the smaller/larger physical representation.

The test must fail if `index.ts` forgets to pass `shouldCaptureFullCheckpoint` to the physical planner, even if the planner unit test itself is correct.

- [ ] **Step 6: Pin the non-circular and maximum-boundary behavior**

In `tests/chatgpt-web-usage.test.ts`, add or extend assertions so that:

- the same small inline request returns `undefined` with `includeFullCheckpoint=false`;
- checkpoint-aware planning still selects the smallest fitting count rather than always adding one part;
- a checkpoint-aware request that cannot fit through 12 parts still throws `context_length_exceeded` before submission.

Use existing test fixtures/helpers where possible; do not add production-only seams solely for tests.

- [ ] **Step 7: Run focused verification for the functional fix**

Run:

```powershell
bun test tests/chatgpt-web-usage.test.ts tests/chatgpt-web-harness.test.ts tests/prompt-contract.test.ts tests/browser-worker-contract.test.ts
bun run typecheck
```

Expected: all selected tests pass and TypeScript reports no errors.

- [ ] **Step 8: Commit the functional fix separately**

```powershell
git add src/adapters/chatgpt-web/usage.ts src/adapters/chatgpt-web/index.ts tests/chatgpt-web-usage.test.ts tests/chatgpt-web-harness.test.ts
git commit -m "fix: account for full context checkpoint overhead"
```

---

### Task 2: Remove the eight EOF whitespace violations

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-full-context-hybrid-design.md`
- Modify: `tests/browser-worker-contract.test.ts`
- Modify: `tests/chatgpt-web-harness.test.ts`
- Modify: `tests/chatgpt-web-usage.test.ts`
- Modify: `tests/prompt-contract.test.ts`
- Modify: `tests/rolling-checkpoint.test.ts`
- Modify: `tests/runtime-layout.test.ts`
- Modify: `tests/server-compaction.test.ts`

**Interfaces:**
- Consumes: Git's whitespace validation only.
- Produces: identical file content except for removal of the single extra blank line at EOF reported by `git diff --check`.

- [ ] **Step 1: Reconfirm the exact eight violations before editing**

Run:

```powershell
git diff --check origin/main...HEAD
```

Expected before cleanup: exactly the eight `new blank line at EOF` reports listed above and no other whitespace errors.

- [ ] **Step 2: Remove only the extra blank line at EOF in each file**

Use targeted patches. Preserve existing CRLF/LF style and do not run Prettier, ESLint autofix, editor-wide whitespace cleanup, or any command that rewrites whole files.

- [ ] **Step 3: Verify the whitespace-only nature of this task**

Run:

```powershell
git diff --check origin/main...HEAD
git diff --word-diff=porcelain HEAD -- docs/superpowers/specs/2026-10-03-full-context-hybrid-design.md tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts tests/chatgpt-web-usage.test.ts tests/prompt-contract.test.ts tests/rolling-checkpoint.test.ts tests/runtime-layout.test.ts tests/server-compaction.test.ts
```

Expected: `git diff --check` exits 0 with no output; inspection shows no semantic text change attributable to the EOF cleanup.

- [ ] **Step 4: Commit the cleanup independently**

```powershell
git add docs/superpowers/specs/2026-10-03-full-context-hybrid-design.md tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts tests/chatgpt-web-usage.test.ts tests/prompt-contract.test.ts tests/rolling-checkpoint.test.ts tests/runtime-layout.test.ts tests/server-compaction.test.ts
git commit -m "chore: clean full context diff whitespace"
```

---

### Task 3: Run the full pre-merge verification gate

**Files:**
- No production changes expected.
- Inspect: complete branch diff against `origin/main`.

**Interfaces:**
- Consumes: the two completed fix commits.
- Produces: fresh evidence that the branch is merge-ready from the two review findings' perspective.

- [ ] **Step 1: Verify the worktree and diff hygiene**

Run:

```powershell
git status --short --branch
git diff --check origin/main...HEAD
```

Expected: clean worktree and no whitespace diagnostics.

- [ ] **Step 2: Run the root test suite in isolation**

Run:

```powershell
$env:CI='1'
bun test ./tests
```

Expected baseline from the review before the fix: `931 pass`, `30 skip`, `0 fail`. The post-fix total may increase by the new regression tests, but failures must remain zero.

- [ ] **Step 3: Run Launcher and both typecheck gates**

Run:

```powershell
$env:PSExecutionPolicyPreference='Bypass'
bun run launcher:test
bun run typecheck
bun run launcher:typecheck
```

Expected baseline from the review: Launcher `375 pass`, `4 skip`, `0 fail`; both typechecks exit 0.

- [ ] **Step 4: Reproduce the original boundary numerically after the fix**

Use the Step 1 fixture and report:

- canonical planner without checkpoint still chooses `2`;
- physical checkpoint-aware planner chooses `3`;
- the two-part checkpoint-bearing final message remains demonstrably over budget (`81,861 > 81,807`), proving the regression fixture is still meaningful;
- the selected three-part physical prompt stays within every message token/character limit.

- [ ] **Step 5: Perform a fresh review of the final diff**

Review `origin/main...HEAD` with focus on:

- no checkpoint-overhead circular activation;
- no change to canonical usage accounting;
- no Bigger Context/Luna/Zero Risk regression;
- no broad whitespace or line-ending rewrites;
- the new tests failing on the old implementation and passing on the fixed implementation.

Do not merge solely because tests pass; the final review must confirm the planner and execution compile the same physical representation whenever checkpoint capture is active.
