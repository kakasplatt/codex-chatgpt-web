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

## Verification

- `bun run verify` (see `scripts/verify.ts`) is the full gate. It requires the exact Bun version pinned in `package.json` `packageManager` and stops at the first failing step. If the local Bun differs, run the steps individually and report the version-gated steps (`check-version`, the runtime bundle build, and the release smoke) as not run. `build-windows.cmd` downloads the pinned Bun into the git-ignored `.tools\` folder.
- Launcher tests need `launcher/node_modules`. In a fresh worktree, run `bun install --frozen-lockfile` inside `launcher/` first.
- Some Windows test failures are environmental:
  - Without symlink privilege (Developer Mode off), the symlink-based tests in `tests/codex-integration.test.ts` and `launcher/tests/runtime-host.test.cjs` fail with `EPERM`.
  - `launcher/tests/windows-installer.test.cjs` fails when the PowerShell execution policy blocks scripts.

  Re-run these on the base commit before treating them as regressions, and report them as environmental.
- Behavior that depends on an authenticated ChatGPT session (see [`docs/release-validation.md`](docs/release-validation.md)) cannot be proven by automated tests. State explicitly when such a check was not run.

## Quality tools (ub-mode)

Run from the project root, using the venv Python in C:\Users\kakas\.agents\tools\.venv:
- CRAP:        C:\Users\kakas\.agents\tools\.venv\Scripts\python -m crapper --threshold 10 <folders>
- Duplication: C:\Users\kakas\.agents\tools\.venv\Scripts\python -m dryer --threshold 0.8 <folders>
- Mutation:    C:\Users\kakas\.agents\tools\.venv\Scripts\python -m mutator <file>
To run everything at once: .\ub-quality.bat
Do not use the crapper/dryer/mutator launcher scripts (they don't work on Windows).
