# Running subagent close guard implementation plan

**Goal:** Prevent the ChatGPT Web coordinator from treating a still-running subagent, or a wait timeout with no terminal status, as safe to close.

**Scope:** Runtime orchestration guidance and an enforceable terminal-state close gate in `src/adapters/chatgpt-web/mcp-server.ts`, plus focused contract/behavior coverage in `tests/chatgpt-web-harness.test.ts`. No changes to native Codex multi-agent implementation.

**Root cause:** `close_agent` is a native/deferred tool. The Web bridge already rewrites `wait_agent` semantics for its transport, but originally forwarded `close_agent` without lifecycle enforcement. The native close schema has only `{target}` and exposes no reliable `last_progress_at`/stall-evidence signal. `wait_agent`, however, is defined to return entries only for agents that reached a final status, so those returned target ids are the only state the bridge can safely authorize for close.

## Task 1: Encode the running-worker close policy in every Web tool surface

- [x] RED: add focused assertions that direct and gateway-discovered `close_agent` descriptions require terminal/stall evidence and that raw `exec` carries the same orchestration rule.
- [x] Run the focused harness test and observe the new assertion fail for the missing policy.
- [x] GREEN: centralize an agent lifecycle rule beside the existing wait rule and apply it to `wait_agent`, `close_agent`, nested gateway discovery, and raw `exec` descriptions.
- [x] Run the focused harness test and typecheck.
- [x] Run the full root and launcher test suites from a fully installed worktree.
- [x] Commit on `fix/p2-running-agent-close-guard`.

## Task 2: Enforce the review finding

- [x] RED: prove that a direct `close_agent` with no observed terminal result is currently dispatched to the native broker.
- [x] GREEN: retain terminal target ids per broker binding when structured `wait_agent` returns them and reject `close_agent` for every other target.
- [x] Treat empty/timed-out waits as no evidence and consume terminal authorization before close dispatch so concurrent/repeated closes cannot reuse it.
- [x] Apply the same gate to deferred/gateway close tools and block `close_agent` from raw `exec`, which cannot share the structured terminal-state ledger.
- [x] Add behavior coverage for direct V1, deferred V2, timeout, successful terminal close, repeated close, and raw-exec bypass attempts.

## Review focus

- A wait timeout must never be described as proof that the worker is stalled.
- The policy must cover `multi_agent_v1__close_agent` and future equivalent close-agent namespaces without changing native tool arguments.
- Terminal agents must remain closable so completed agents do not consume concurrency slots.
- A target that has not been returned by structured `wait_agent` as terminal must fail closed because the current native schema supplies no verifiable stall evidence.
- Raw `exec` must not provide an enforcement escape hatch.
