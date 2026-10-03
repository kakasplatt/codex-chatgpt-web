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
