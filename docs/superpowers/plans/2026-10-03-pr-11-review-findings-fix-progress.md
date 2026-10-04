# PR #11 Review Findings Fix Progress

Updated: 2026-10-04

Plan: `docs/superpowers/plans/2026-10-03-pr-11-review-findings-fix.md`

Branch: `design/full-context-hybrid`

## Task 1 - Full Context physical planning checkpoint-aware

Status: complete before this verification pass.

- Commit: `fb3b4a2 fix: account for full context checkpoint overhead`.
- `resolveFullContextMultipartPlan()` accepts `includeFullCheckpoint = false` and compiles physical candidates with `captureCheckpoint: "full"` when enabled.
- Canonical multipart activation remains checkpoint-free; only physical preparation passes `shouldCaptureFullCheckpoint`.
- Unit regression covers the exact 2-to-3-part boundary, smallest-fitting behavior, and failure beyond 12 physical parts.
- Adapter regression proves `turn.prepare()` receives three parts while checkpoint capture mode is `full`, with usage accounting remaining canonical.
- Fresh RED proof on 2026-10-04: with only the two production changes temporarily restored to `fb3b4a2^`, the unit regression failed `Expected: 3 / Received: 2`, and the adapter regression failed `Expected: 3 / Received: 2`.
- After restoring `HEAD`, both filtered regressions passed again (`1 pass, 0 fail` each).
- Focused verification: `311 pass, 0 fail` across `chatgpt-web-usage`, `chatgpt-web-harness`, `prompt-contract`, and `browser-worker-contract`; `bun run typecheck` exited 0.

## Task 2 - EOF whitespace cleanup

Status: complete before this verification pass.

- Commit: `4648d5b chore: clean full context diff whitespace`.
- The commit changes only the eight files named by the plan and removes EOF-only blank lines.
- Fresh `git diff --check origin/main...HEAD` exited 0 with no diagnostics before the progress document was created.

## Task 3 - Full pre-merge verification gate

Status: complete.

- Worktree/diff hygiene before this progress document: clean branch state and `git diff --check origin/main...HEAD` with no output.
- Initial root suite before the follow-up review fix: `933 pass, 30 skip, 0 fail` across 64 files.
- Refreshed root suite after the follow-up fix: `934 pass, 30 skip, 0 fail` across 64 files.
- Launcher suite: `375 pass, 4 skip, 0 fail`.
- `bun run typecheck`: exit 0.
- `bun run launcher:typecheck`: exit 0.
- Numeric boundary reproduction:
  - canonical planner: `2` parts;
  - checkpoint-aware physical planner: `3` parts;
  - two-part checkpoint-bearing final message: `81,861` tokens against an `81,807` token budget, so preflight rejects it;
  - selected three-part physical prompt: max message `81,064` tokens / `404,218` chars, final message `1,198` tokens / `5,710` chars, and preflight accepts it.
- First independent final code review found one Important issue: when `includeFullCheckpoint` was enabled, the private checkpoint contract was also counted against the canonical `1,050,000`-token logical ceiling. A canonical request below the ceiling could therefore fail only because checkpoint metadata pushed its physical inline representation above the ceiling.
- Follow-up TDD fix:
  - RED: the new boundary regression reproduced `1,050,239` checkpoint-bearing tokens and failed with `context_length_exceeded` while the canonical planner still accepted the request.
  - GREEN: logical ceiling accounting now recompiles the canonical checkpoint-free inline representation, while physical fit continues to use the checkpoint-bearing prompt.
  - Regression fixture: 11 whole records of `"word ".repeat(94_550)` remain accepted as an 11-part plan with and without physical checkpoint capture.
  - Commit: `29fb083 fix: keep full context ceiling canonical`.
- Focused suite after the follow-up fix: `312 pass, 0 fail` across the four plan-focused test files.
- The first re-review attempt was cancelled by its ChatGPT browser runtime before returning a verdict (`client_cancelled` after the browser tab closed); it made no code changes.
- Replacement independent final code review: `READY`, with no Critical or Important findings.
  - It confirmed the `1,050,000`-token logical ceiling is computed from checkpoint-free canonical input.
  - It confirmed physical `fits()` evaluation still uses checkpoint-bearing browser messages and retains the `2 -> 3` multipart promotion.
  - It confirmed the new 11-record regression covers the former `1,049,995` canonical / `1,050,239` checkpoint-bearing boundary.

## Remaining

- No implementation or verification work remains in this plan. Integration/push/PR is a separate branch-finishing decision.
