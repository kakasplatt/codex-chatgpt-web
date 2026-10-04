# Running subagent close guard implementation plan

**Goal:** Prevent the ChatGPT Web coordinator from treating a still-running subagent, or a wait timeout with no terminal status, as safe to close.

**Scope:** Runtime orchestration guidance in `src/adapters/chatgpt-web/mcp-server.ts` plus focused contract coverage in `tests/chatgpt-web-harness.test.ts`. No changes to native Codex multi-agent implementation.

**Root cause:** `close_agent` is a native/deferred tool. The Web bridge already rewrites `wait_agent` semantics for its transport, but forwards `close_agent`'s native description unchanged. The native close schema has only `{target}` and the wait result reports terminal statuses or timeout; there is no reliable `last_progress_at`/stall signal for a hard state gate.

## Task 1: Encode the running-worker close policy in every Web tool surface

- [x] RED: add focused assertions that direct and gateway-discovered `close_agent` descriptions require terminal/stall evidence and that raw `exec` carries the same orchestration rule.
- [x] Run the focused harness test and observe the new assertion fail for the missing policy.
- [x] GREEN: centralize an agent lifecycle rule beside the existing wait rule and apply it to `wait_agent`, `close_agent`, nested gateway discovery, and raw `exec` descriptions.
- [x] Run the focused harness test and typecheck.
- [x] Run the full root and launcher test suites from a fully installed worktree.
- [x] Commit on `fix/p2-running-agent-close-guard`.

## Review focus

- A wait timeout must never be described as proof that the worker is stalled.
- The policy must cover `multi_agent_v1__close_agent` and future equivalent close-agent namespaces without changing native tool arguments.
- Terminal agents must remain closable so completed agents do not consume concurrency slots.
- Raw `exec` must not provide a guidance escape hatch.
