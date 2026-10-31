# Repository Agent Instructions

## Superpowers model routing

Before invoking or applying any Superpowers skill, or dispatching subagents as part of a Superpowers workflow, read and follow [`docs/superpowers/model-selection.md`](docs/superpowers/model-selection.md).

That guide is the repository policy for:

- model and reasoning-effort selection per Superpowers skill;
- cross-harness routing with at least one Codex, Claude Code, and Antigravity model example for every Superpowers skill;
- planning, atomic implementation, debugging, review, and verification routing;
- escalation and de-escalation criteria;
- model/effort fallback behavior;
- parallel-agent isolation and final-review requirements.

Direct user instructions and higher-priority runtime instructions override the guide. When the user explicitly selects a model or effort, preserve that choice unless it is unavailable; if unavailable, apply the guide's fallback rules and state the substitution.

## Graphify repository analysis

Before invoking or applying Graphify, or using Graphify output to make architecture, debugging, review, or implementation decisions, read and follow [`docs/graphify/usage.md`](docs/graphify/usage.md).

That guide is the repository policy for:

- query-first use of the existing `graphify-out/graph.json`;
- choosing between `query`, `path`, `explain`, incremental update, clustering, and full extraction;
- validating graph relationships against source code, Git history, and tests;
- handling stale or incomplete graph evidence without inventing relationships;
- coordinating Graphify with Superpowers investigation, planning, implementation, and review;
- preserving unrelated worktree state and avoiding unnecessary graph rebuilds;
- reporting Graphify evidence with source locations, confidence, and explicit uncertainty.

Direct user instructions and higher-priority runtime instructions override the guide. For ordinary natural-language questions about this repository, use the existing graph before considering any rebuild. Treat Graphify as a discovery and architecture-navigation layer; source code, current diffs, Git history, and executable verification remain authoritative for behavioral conclusions.

## Engineering discipline (ub-mode)

Always invoke the `/ub-mode` skill before writing or changing code in this repository. Follow its rules: TDD, small verifiable units, fix root causes, test behavior rather than implementation, and small ordered commits.

- Coordinate with Superpowers: `/ub-mode` governs how code is written and what quality gates it must pass; Superpowers governs planning, subagent dispatch, and review routing. When they overlap, apply both; if they conflict, follow the stricter rule and state the conflict.
- After each completed unit of work, run the quality tools below on the files you changed, before starting the next unit.
- Direct user instructions and higher-priority runtime instructions override `/ub-mode`.

## Verification

- `bun run verify` (see `scripts/verify.ts`) is the full gate. It requires the exact Bun version pinned in `package.json` `packageManager` and stops at the first failing step. If the local Bun differs, run the steps individually and report the version-gated steps (`check-version`, the runtime bundle build, and the release smoke) as not run. `build-windows.cmd` downloads the pinned Bun into the git-ignored `.tools\` folder.
- Launcher tests need `launcher/node_modules`. In a fresh worktree, run `bun install --frozen-lockfile` inside `launcher/` first.
- Some Windows test failures are environmental:
  - Without symlink privilege (Developer Mode off), the symlink-based tests in `tests/codex-integration.test.ts` and `launcher/tests/runtime-host.test.cjs` fail with `EPERM`.
  - `launcher/tests/windows-installer.test.cjs` fails when the PowerShell execution policy blocks scripts.

  Re-run these on the base commit before treating them as regressions, and report them as environmental.
- Behavior that depends on an authenticated ChatGPT session (see [`docs/release-validation.md`](docs/release-validation.md)) cannot be proven by automated tests. State explicitly when such a check was not run.

## Quality tools (ub-mode)

Run from the project root, using the venv Python in `C:\Users\kakas\.agents\tools\.venv`:

- CRAP:        `C:\Users\kakas\.agents\tools\.venv\Scripts\python -m crapper --threshold 10 <folders>`
- Duplication: `C:\Users\kakas\.agents\tools\.venv\Scripts\python -m dryer --threshold 0.8 <folders>`
- Mutation:    `C:\Users\kakas\.agents\tools\.venv\Scripts\python -m mutator <file>`

To run everything at once: `.\ub-quality.bat`

Rules:

- Do not use the `crapper`/`dryer`/`mutator` launcher scripts (they don't work on Windows).
- Analyze source folders only. Exclude generated or minified output such as `.launcher-runtime`, `dist`, and `target`; scores for generated code are meaningless.
- Tests run on Bun, so coverage must come from Bun's native coverage (`bun test --coverage --coverage-reporter=lcov`), not `c8`. `ub-quality.bat` handles this. Without coverage, every CRAP score is computed at 0% and is not a valid result; report such a run as not valid.
- Targets: every function below CRAP 10 and no duplication at or above 0.8. For mutation, cover uncovered code, kill surviving mutants, and delete dead code.
- Mutation runs are slow on a full tree. Run `mutator` on the changed files, not the whole project.
- Report the tool output (scores, duplicate pairs, surviving mutants) in your summary. If a tool could not run, say so explicitly instead of omitting it.