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

## Task 3: Invalidate stale terminal observations after reactivation

- [x] RED: prove that `wait_agent` terminal evidence remained reusable after `send_input` reactivated the same agent.
- [x] Invalidate a target's terminal observation before structured `send_input`, `resume_agent`, or `followup_task` dispatch.
- [x] Treat every attempted structured reactivation as a new causal generation; even an explicit tool error requires a new terminal `wait_agent` before close.
- [x] Require deferred lifecycle reactivation tools to use structured arguments so the target can always be tracked.
- [x] Clear all terminal observations before raw `exec`, since arbitrary nested lifecycle mutations cannot update the structured ledger; keep raw `close_agent` blocked.
- [x] Cover V1 `send_input`, V1 `resume_agent`, V2/collaboration `followup_task`, freeform mutation rejection, raw-exec reactivation, and re-wait-before-close behavior.

## Task 4: Make lifecycle evidence causal under concurrency

- [x] RED: cover `close_agent` racing a reactivation, `wait_agent` overlapping reactivation, and `wait_agent` overlapping raw `exec` in one broker batch.
- [x] Track a monotonically increasing generation per agent and accept terminal evidence only for the same generation observed when the wait started.
- [x] Track in-flight reactivation/close mutations so a wait overlapping either mutation cannot certify terminality regardless of local request ordering.
- [x] Reserve `close_agent` before dispatch and reject reactivation while that close is in flight; a competing reactivation invalidates terminality before close can reserve it.
- [x] Track a binding epoch plus raw-exec in-flight count so waits crossing arbitrary raw code cannot repopulate stale terminal evidence.
- [x] Keep `wait_agent` itself non-blocking with respect to useful lifecycle intervention; do not hold a 30-second global mutex.

## Task 5: Scope lifecycle interception to Codex multi-agent protocols

- [x] RED: prove that unrelated `vendor__close_agent` and `vendor__send_input` calls are not lifecycle-gated.
- [x] Remove generic `endsWith()` lifecycle classification and match only the explicit V1/V2/collaboration wire names supported by the bridge.
- [x] Preserve unrelated vendor `close_agent` inside raw `exec`; block only the known Codex multi-agent close tools.
- [x] Prove a vendor `send_input` targeting the same string id cannot invalidate Codex agent terminal evidence.

## Review focus

- A wait timeout must never be described as proof that the worker is stalled.
- The policy must cover `multi_agent_v1__close_agent` and future equivalent close-agent namespaces without changing native tool arguments.
- Terminal agents must remain closable so completed agents do not consume concurrency slots.
- A target that has not been returned by structured `wait_agent` as terminal must fail closed because the current native schema supplies no verifiable stall evidence.
- Terminal evidence must be invalidated whenever the same agent is reactivated and must be earned again with a later terminal `wait_agent` result.
- A wait result is usable only if no lifecycle generation/epoch change or overlapping mutation occurred since that wait started.
- A close reservation and a reactivation for the same target must never both be dispatched concurrently.
- Generic vendor/MCP tools that merely share lifecycle-looking suffixes are outside this policy.
- Raw `exec` must not provide an enforcement escape hatch.
