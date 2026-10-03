# Superpowers Model and Reasoning-Effort Selection Guide

This document defines the repository-wide policy for choosing models and reasoning effort when using Superpowers across **Codex, Claude Code, and Google Antigravity**. It is designed to be referenced from `AGENTS.md` and used directly by the coordinator and by subagents.

The goal is to spend reasoning where it changes correctness: stronger models and deeper effort for architecture, uncertain debugging, adversarial review, and difficult planning; workhorse models for implementation; fast models for mechanical routing and verification. Model selection must follow the phase and risk of the current task instead of keeping one expensive model for an entire workflow.

Se o modelo atual for gpt-5.6-sol (web), ignore as instruções, ela não serve.

## 1. Scope and authority

Apply this guide whenever a Superpowers skill is invoked, when a Superpowers workflow dispatches agents, or when a task is being divided into planning, implementation, review, and verification phases.

Instruction priority remains:

1. Runtime/system/developer instructions.
2. Direct user instructions, including an explicit model or effort choice.
3. Repository `AGENTS.md` instructions.
4. This guide.
5. Superpowers defaults and agent judgment.

Do not override an explicit user-selected model merely to follow this matrix. If the requested model or effort is unavailable, use the fallback rules in this document and report the substitution.

## 2. Runtime snapshot used by this policy

This policy was written against the local Codex model catalog, the installed Claude Code CLI/help and changelog, the installed Antigravity workspace/runtime, the local ECC Antigravity documentation, and the Superpowers installation observed on 2026-10-03.

Superpowers version: `6.4.2`.

Available Superpowers skills:

- `using-superpowers`
- `brainstorming`
- `diagnosing-superpowers`
- `dispatching-parallel-agents`
- `executing-plans`
- `finishing-a-development-branch`
- `receiving-code-review`
- `requesting-code-review`
- `subagent-driven-development`
- `systematic-debugging`
- `test-driven-development`
- `using-git-worktrees`
- `verification-before-completion`
- `writing-plans`
- `writing-skills`

### Codex models

Relevant visible Codex models in the local catalog:

| Model | Local catalog description | Role in this policy |
| --- | --- | --- |
| `gpt-6.1-sol` | Latest workhorse model for coding and everyday work | Default model for most Superpowers work |
| `gpt-6-astra` | Frontier intelligence for the most demanding work | Escalation model for hardest planning, diagnosis, and review |
| `gpt-6-luna` | Fast and affordable model for easier tasks | Mechanical, bounded, low-ambiguity work |
| `gpt-6-sol` | Previous generation workhorse model | First compatibility fallback for `gpt-6.1-sol` |
| `gpt-5.6-sol` | Older generation workhorse model | Legacy compatibility fallback |
| `gpt-5.6-terra` | Older balanced model for straightforward work | Legacy balanced fallback only |
| `gpt-5.6-luna` | Older fast and efficient model | Legacy fast fallback only |
| `gpt-5.5` | Legacy coding model | Avoid for new routing; compatibility only |

`gpt-reserve` and `codex-auto-review` are hidden/special-purpose catalog entries. Do not manually route Superpowers work to them.

### Claude Code models

The installed Claude UI in this environment currently exposes the following model set. Availability badges shown by the UI are recorded because some frontier models require a Pro/Max entitlement:

| Claude UI model | Availability shown | Role in this policy |
| --- | --- | --- |
| `Fable 5.1` | Pro or Max | Highest-tier option for the hardest architecture, diagnosis, planning, and final-review work |
| `Opus 5.5` | Pro | Frontier option for complex work, difficult debugging, and adversarial review |
| `Sonnet 5.5` | Available in the captured picker | Default Claude workhorse for implementation, normal planning, and most reviews |
| `Haiku 4.5` | Available in the captured picker | Fast option for routing, repository inspection, and deterministic verification |
| `Fable 5` | Pro or Max | Previous Fable generation; compatibility/fallback only when Fable 5.1 is unavailable |
| `Opus 5` | Pro | Previous Opus generation |
| `Opus 4.8` | Pro | Older Opus compatibility option |
| `Opus 4.7` | Pro | Older Opus compatibility option |
| `Opus 4.6` | Pro | Older Opus compatibility option |
| `Opus 3` | Pro | Legacy Opus option; avoid for new routing |
| `Sonnet 5` | Available in More models | Previous Sonnet generation |
| `Sonnet 4.6` | Available in More models | Older Sonnet compatibility option |

The Claude CLI accepts `--model` plus `--effort low|medium|high|xhigh|max`. In examples below, the guide names the UI model generation explicitly; when starting a standalone CLI session, use the matching model ID or current alias exposed by that installation.

### Antigravity models

Antigravity is treated as a separate agent harness. The captured model picker in this environment exposes these exact visible variants:

| Antigravity UI model | Visible reasoning/speed marker | Role in this policy |
| --- | --- | --- |
| `Gemini 3.8 Flash High` | High, Fast | Default Antigravity workhorse for implementation, planning, debugging, and strong general-purpose work |
| `Gemini 3.7 Flash Medium` | Medium | Balanced fallback for ordinary implementation and analysis |
| `Gemini 3.6 Flash Medium` | Medium, Fast | Fast balanced option for mechanical implementation and verification |
| `Gemini 3.1 Pro Low` | Low | Pro-family option with the captured low-reasoning variant; use only where low reasoning is acceptable |
| `Claude Sonnet 4.6 (Thinking)` | Thinking | Reasoning-heavy alternative inside Antigravity |
| `Claude Opus 4.6 (Thinking)` | Thinking | Strong independent planning/review/debugging alternative inside Antigravity |
| `GPT-OSS 120B (Medium)` | Medium | Open-weight alternative for bounded analysis or implementation |

For Antigravity, `High`, `Medium`, and `Low` are part of the **visible model variant name** in the captured picker. Do not append a fictitious `xhigh` or `max` effort to those Gemini variants. When deeper reasoning is needed than the visible Gemini variant provides, prefer an available `(Thinking)` model such as `Claude Opus 4.6 (Thinking)` rather than inventing unsupported effort semantics.

### Models to avoid as a primary choice

Do not select these as the normal primary model for a new Superpowers task:

- `gpt-5.5`: legacy model; the local catalog marks it for retirement on 2026-10-14.
- `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`: older generation; use only when a GPT-6 family model is unavailable or a compatibility test explicitly requires them.
- `gpt-6-sol`: previous generation; valid fallback, but `gpt-6.1-sol` is the current workhorse.
- `gpt-reserve`, `codex-auto-review`: hidden/special-purpose models; leave their selection to the runtime feature that owns them.
- `Opus 3`, `Opus 4.6`, `Opus 4.7`, `Opus 4.8`, `Sonnet 4.6`, and other older Claude generations when `Sonnet 5.5`, `Opus 5.5`, or `Fable 5.1` is available and appropriate.
- `Gemini 3.1 Pro Low` for difficult planning/debug/review merely because it says Pro; the captured variant is explicitly Low reasoning.
- Older Antigravity variants when `Gemini 3.8 Flash High` is available and the task benefits from stronger reasoning.

## 3. Reasoning-effort semantics

Use only effort levels supported by the selected model or harness. Codex and Claude Code expose explicit effort controls. In the captured Antigravity picker, the reasoning level is already encoded in several visible model variants, such as `Gemini 3.8 Flash High`, `Gemini 3.7 Flash Medium`, `Gemini 3.6 Flash Medium`, and `Gemini 3.1 Pro Low`.

| Effort | Use |
| --- | --- |
| `low` | Fast responses with light reasoning; routing, trivial inspection, mechanical operations |
| `medium` | Everyday reasoning; bounded low-risk work with clear requirements |
| `high` | Complex implementation, review, debugging, and decisions with several interacting constraints |
| `xhigh` | Extra-deep reasoning for architecture, difficult root-cause analysis, intricate plans, and high-risk review |
| `max` | Maximum reasoning depth for the hardest problems; use when an unresolved decision still matters after targeted evidence gathering |
| `ultra` | Codex-specific maximum reasoning with automatic task delegation; use for genuinely decomposable, very hard work where delegation is desirable |

`gpt-6-luna` supports through `max` but does not expose `ultra` in the current catalog. Claude Code currently exposes through `max`. Antigravity does **not** use the Codex/Claude effort ladder in this guide: select the exact visible Antigravity variant instead.

### Effort rules

- Start at the recommended effort in the skill matrix.
- Escalate one level when new evidence reveals more ambiguity, coupling, or risk.
- Escalate directly to `max` only when the problem is genuinely hard enough to justify maximum reasoning.
- Use `ultra` only when automatic delegation helps. Do not use `ultra` for a single atomic implementation task, a one-file fix, a focused reviewer, or any task whose correctness depends on one agent maintaining a single coherent local state.
- De-escalate after the uncertain phase is resolved. A task can use Astra/Fable/Opus/Antigravity Thinking for architecture, Sol/Sonnet/Gemini 3.8 Flash High for implementation, and Luna/Haiku/Gemini 3.6 Flash Medium (Fast) for mechanical verification.
- Never reduce a planning/debug/review task to `low` merely because a preferred effort is unavailable. Follow the effort fallback ladder instead.

## 4. Default phase routing

Use these defaults before consulting the per-skill matrix. Every phase includes at least one concrete model from each supported harness family.

| Phase | Codex | Claude Code | Antigravity | Guidance |
| --- | --- | --- | --- | --- |
| Intent/routing | `gpt-6-luna` / `medium` | `Haiku 4.5` / `medium` | `Gemini 3.6 Flash Medium` (Fast) | Cheap classification and skill selection |
| Brainstorming/design | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Escalate when architecture or requirements remain ambiguous |
| Detailed implementation planning | `gpt-6.1-sol` / `xhigh` | `Fable 5.1` / `max` if entitled; otherwise `Opus 5.5` / `xhigh` | `Claude Opus 4.6 (Thinking)` | Plans must be precise enough for another agent to execute |
| Atomic implementation | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Keep one bounded task per agent |
| Difficult debugging | `gpt-6.1-sol` / `xhigh` | `Opus 5.5` / `xhigh`; `Fable 5.1` / `max` for the hardest cases | `Claude Opus 4.6 (Thinking)` | Evidence first; escalate after failed hypotheses or cross-system ambiguity |
| Independent code review | `gpt-6-astra` / `high` | `Opus 5.5` / `high` | `Claude Opus 4.6 (Thinking)` | Prefer a reviewer family/model different from the implementer when practical |
| Review feedback evaluation | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Verify reviewer claims against code and tests |
| Mechanical verification | `gpt-6-luna` / `medium` | `Haiku 4.5` / `medium` | `Gemini 3.6 Flash Medium` (Fast) | Verification is evidence collection |
| Final difficult review | `gpt-6-astra` / `xhigh` | `Fable 5.1` / `max` if entitled; otherwise `Opus 5.5` / `xhigh` | `Claude Opus 4.6 (Thinking)` | Use after implementation when blast radius is material |

## 5. Per-skill model matrix

Each row below provides one concrete choice for **Codex**, **Claude Code**, and **Antigravity**. These are peer examples for the same Superpowers specificity; choose the harness actually available for the worker, then apply the same escalation logic.

| Superpowers skill | Codex model / effort | Claude model / effort | Antigravity model / visible variant | Why |
| --- | --- | --- | --- | --- |
| `using-superpowers` | `gpt-6-luna` / `medium` | `Haiku 4.5` / `medium` | `Gemini 3.6 Flash Medium` (Fast) | Mostly discovery, routing, precedence, and workflow selection. |
| `brainstorming` | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Requires intent discovery, scope classification, trade-offs, and recognition of hidden architectural complexity. |
| `writing-plans` | `gpt-6.1-sol` / `xhigh` | `Fable 5.1` / `max` if entitled; otherwise `Opus 5.5` / `xhigh` | `Claude Opus 4.6 (Thinking)` | Plans must preserve design intent, exact files, interfaces, TDD order, verification, and task independence. |
| `executing-plans` | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Execution needs reliable coding judgment, scoped edits, and continuous verification. |
| `subagent-driven-development` | `gpt-6.1-sol` / `high` coordinator | `Sonnet 5.5` / `high` coordinator | `Gemini 3.8 Flash High` (Fast) coordinator | The coordinator must partition tasks, maintain plan state, reconcile workers, and route reviews. |
| `dispatching-parallel-agents` | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Independence analysis matters more than raw speed when deciding whether work can safely run in parallel. |
| `systematic-debugging` | `gpt-6.1-sol` / `xhigh` | `Opus 5.5` / `xhigh` | `Claude Opus 4.6 (Thinking)` | Root-cause work benefits from hypothesis discipline and evidence correlation. |
| `test-driven-development` | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Once behavior is known, TDD is normally bounded implementation with a clear oracle. |
| `using-git-worktrees` | `gpt-6-luna` / `medium` | `Haiku 4.5` / `medium` | `Gemini 3.6 Flash Medium` (Fast) | Primarily deterministic repository inspection and workspace setup. |
| `requesting-code-review` | `gpt-6-astra` / `high` | `Opus 5.5` / `high` | `Claude Opus 4.6 (Thinking)` | Independent review should have enough judgment to find regressions, requirement gaps, and incorrect assumptions. |
| `receiving-code-review` | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Feedback must be checked against code and tests before implementation. |
| `verification-before-completion` | `gpt-6-luna` / `medium` | `Haiku 4.5` / `medium` | `Gemini 3.6 Flash Medium` (Fast) | Core activity is fresh evidence collection and claim matching. |
| `finishing-a-development-branch` | `gpt-6-luna` / `medium` | `Haiku 4.5` / `medium` | `Gemini 3.6 Flash Medium` (Fast) | Mostly deterministic Git, test, worktree, and integration-state handling. |
| `writing-skills` | `gpt-6.1-sol` / `xhigh` | `Fable 5.1` / `max` if entitled; otherwise `Opus 5.5` / `xhigh` | `Claude Opus 4.6 (Thinking)` | Skill authoring is process-level TDD and requires anticipating loopholes and pressure scenarios. |
| `diagnosing-superpowers` | `gpt-6.1-sol` / `xhigh` | `Fable 5.1` / `max` if entitled; otherwise `Opus 5.5` / `xhigh` | `Claude Opus 4.6 (Thinking)` | Transcript diagnosis requires provenance, evidence reconstruction, and reconciliation of independent analyses. |

## 6. Planning policy

Planning quality determines how much intelligence implementation workers need later. Spend more reasoning in the plan so implementation can remain narrow and predictable.

For normal bounded design and plans:

- Codex: use `gpt-6.1-sol` `high` for brainstorming and `xhigh` for `writing-plans`.
- Claude Code: use `Sonnet 5.5` `high` for brainstorming. For `writing-plans`, prefer `Fable 5.1` `max` when the entitlement is available; otherwise use `Opus 5.5` `xhigh`.
- Antigravity: use `Gemini 3.8 Flash High` for normal brainstorming/design. For deeper planning, use `Claude Opus 4.6 (Thinking)`.
- Keep the plan executable by an engineer who has not seen the design conversation.
- Name exact files, behavioral expectations, test commands, and task boundaries.

Escalate planning to the frontier tier when any of these are true. Examples: Codex `gpt-6-astra xhigh`, Claude `Fable 5.1 max` or `Opus 5.5 xhigh`, Antigravity `Claude Opus 4.6 (Thinking)`.

- the change introduces a new subsystem or changes an interface used by several modules;
- concurrency, cancellation, retries, persistence, recovery, or distributed ordering is central;
- security/trust boundaries, permissions, credentials, or data-loss risk are involved;
- a migration is difficult to reverse;
- two plausible designs have materially different long-term costs;
- the plan must coordinate several independent agents without shared-file collisions.

Use maximum reasoning only when targeted repository evidence still leaves a consequential architecture decision unresolved. Examples: Codex `gpt-6-astra max`, Claude `Fable 5.1 max` when available, or Antigravity `Claude Opus 4.6 (Thinking)`.

## 7. Atomic implementation policy

Atomic implementation is deliberately narrower than planning. The worker receives a precise task and should finish that task without redesigning the larger system.

Default atomic worker:

- Codex: `gpt-6.1-sol` / `high`.
- Claude Code: `Sonnet 5.5` / `high`.
- Antigravity: `Gemini 3.8 Flash High` (Fast).

For a very mechanical task, prefer the fast tier: Codex `gpt-6-luna high`, Claude `Haiku 4.5 high`, or Antigravity `Gemini 3.6 Flash Medium` (Fast) when all of these are true:

- the plan is explicit;
- the task is confined to one clear behavior or a small file set;
- there is an existing local pattern to copy;
- the test oracle is clear;
- there is no security, concurrency, migration, or cross-system ambiguity.

Do not use Codex `ultra` or any equivalent automatic-delegation mode for an atomic worker. Automatic delegation weakens the guarantee that one bounded task has one owner and one coherent state.

Each atomic implementation task must:

1. Read only the context needed for its assigned behavior.
2. Follow `test-driven-development` for features and bug fixes.
3. Produce the smallest change that satisfies the task.
4. Run the focused RED/GREEN evidence required by the task.
5. Run broader project verification when the skill requires it.
6. Report changed files, tests run, observed results, and any residual uncertainty.
7. Avoid editing files assigned concurrently to another worker unless the coordinator explicitly serializes the work.

If an atomic worker discovers that the task requires an architectural decision, it must stop implementation at that boundary and return the decision to the coordinator. The coordinator then escalates model/effort and, when required by Superpowers, returns to design/planning.

## 8. Parallel and subagent routing

Parallelism is allowed only for tasks that do not depend on each other's intermediate state.

The coordinator should normally use a workhorse/high profile:

- Codex: `gpt-6.1-sol high`.
- Claude Code: `Sonnet 5.5 high`.
- Antigravity: `Gemini 3.8 Flash High` (Fast).

Worker selection is per task:

| Worker type | Codex | Claude Code | Antigravity |
| --- | --- | --- | --- |
| Mechanical repository inspection | `gpt-6-luna medium` | `Haiku 4.5 medium` | `Gemini 3.6 Flash Medium` (Fast) |
| Straightforward atomic implementation | `gpt-6-luna high` or `gpt-6.1-sol high` | `Sonnet 5.5 high` | `Gemini 3.8 Flash High` (Fast) |
| Complex implementation | `gpt-6.1-sol high|xhigh` | `Sonnet 5.5 high|xhigh` | `Gemini 3.8 Flash High` (Fast) |
| Independent review | `gpt-6-astra high` | `Opus 5.5 high` | `Claude Opus 4.6 (Thinking)` |
| Hard root-cause investigation | `gpt-6.1-sol xhigh` -> `gpt-6-astra xhigh|max` | `Opus 5.5 xhigh` -> `Fable 5.1 max` if available | `Claude Opus 4.6 (Thinking)` |

Do not dispatch two workers in parallel when they are likely to modify the same file, depend on the same mutable fixture, need the same branch operation, or require the result of the other task to define correctness.

When `ultra` is used, treat its automatic delegation as another form of parallelism: only select it when autonomous decomposition is compatible with the task. It is not a shortcut around `dispatching-parallel-agents` independence rules.

## 9. Escalation criteria

Escalate effort first when the current model is appropriate but the reasoning depth is insufficient. Escalate model when the task itself crosses into a harder reasoning class.

Increase effort by one level when:

- a previously simple task spans more files or contracts than expected;
- a focused test contradicts the current hypothesis;
- two pieces of repository evidence conflict;
- the agent must compare several plausible implementations;
- a reviewer identifies a credible issue that is not locally obvious;
- the task has failed once due to reasoning rather than a mechanical command error.

Escalate from the fast tier to the workhorse tier when:

- behavior is ambiguous;
- implementation requires API/design judgment;
- the task crosses module boundaries;
- failures are not explained by one obvious cause;
- code review requires semantic understanding rather than checklist verification.

Examples of this escalation are Codex `gpt-6-luna -> gpt-6.1-sol`, Claude `Haiku 4.5 -> Sonnet 5.5`, and Antigravity `Gemini 3.6 Flash Medium -> Gemini 3.8 Flash High`.

Escalate from the workhorse tier to the frontier/reviewer tier when:

- concurrency, ordering, distributed state, or recovery semantics remain uncertain;
- a security/trust boundary or irreversible migration is involved;
- multiple strong hypotheses remain after targeted investigation;
- independent reviewers disagree on a material correctness issue;
- the problem has already consumed multiple failed Sol hypotheses;
- the user explicitly requests maximum-quality reasoning for a consequential decision.

Examples are Codex `gpt-6.1-sol -> gpt-6-astra`, Claude `Sonnet 5.5 -> Opus 5.5 -> Fable 5.1` when entitled, and Antigravity `Gemini 3.8 Flash High -> Claude Opus 4.6 (Thinking)`.

Escalate to `max` when the hardest unresolved decision remains after evidence gathering. Use `ultra` instead only if automatic delegation itself is desirable.

## 10. De-escalation criteria

Do not keep an escalated model for mechanical follow-through.

De-escalate when:

- the architecture/design decision is approved and tasks are fully specified;
- the root cause has been reproduced and the remaining work is a small TDD fix;
- review findings have been reduced to concrete independent fixes;
- verification consists of deterministic commands and requirement checks;
- branch finishing consists only of known Git/test steps.

Typical flow:

- Codex: `gpt-6-astra xhigh` design -> `gpt-6.1-sol xhigh` plan -> `gpt-6.1-sol high` implementation -> `gpt-6-astra high` independent review -> `gpt-6-luna medium` verification.
- Claude Code: `Opus 5.5 xhigh` or `Fable 5.1 max` design/plan -> `Sonnet 5.5 high` implementation -> `Opus 5.5 high` independent review -> `Haiku 4.5 medium` verification.
- Antigravity: `Claude Opus 4.6 (Thinking)` design/plan -> `Gemini 3.8 Flash High` implementation -> `Claude Opus 4.6 (Thinking)` independent review -> `Gemini 3.6 Flash Medium` (Fast) verification.

## 11. Model fallback rules

Fallback must preserve the task's reasoning class. Do not silently substitute a fast model for a frontier review or architectural decision.

### Codex fallback

For `gpt-6-astra` tasks:

1. `gpt-6-astra` at requested effort.
2. `gpt-6.1-sol` at the same effort if supported.
3. `gpt-6.1-sol` `max` for Astra `max` work when Astra is unavailable.
4. `gpt-6-sol` at the same or next-higher effort.
5. `gpt-5.6-sol` at the same or next-higher effort only as legacy compatibility fallback.

For `gpt-6.1-sol` tasks:

1. `gpt-6.1-sol` at requested effort.
2. `gpt-6-sol` at the same effort.
3. `gpt-5.6-sol` at the same effort.
4. `gpt-5.6-terra` only for straightforward non-frontier work.

For `gpt-6-luna` tasks:

1. `gpt-6-luna` at requested effort.
2. `gpt-6.1-sol` at `low`/`medium` for routing/mechanical work or `high` for atomic implementation.
3. `gpt-5.6-luna` only as legacy fast fallback.

Do not fall back to `gpt-5.5` unless every newer compatible option is unavailable and the task must continue for compatibility reasons. State that the legacy model was used.

### Claude Code fallback

For frontier/review work:

1. `Fable 5.1` at `max` when the required Pro/Max entitlement is available.
2. `Opus 5.5` at `high|xhigh|max`, according to task difficulty and supported effort.
3. `Sonnet 5.5` at the same effort or next-higher supported effort when the frontier models are unavailable.
4. Older Opus generations only as compatibility fallbacks.
5. `Haiku 4.5` only for deterministic/mechanical work, not as a silent substitute for architecture or final adversarial review.

For normal implementation:

1. `Sonnet 5.5` at requested effort.
2. `Opus 5.5` at the same effort when higher quality is preferable to lower cost and the entitlement is available.
3. `Sonnet 5` as the first previous-generation fallback.
4. `Sonnet 4.6` only as an older compatibility fallback.
5. `Haiku 4.5` when the task is mechanically specified and low ambiguity.

### Antigravity fallback

For reasoning-heavy work:

1. `Claude Opus 4.6 (Thinking)` for the deepest planning, difficult debugging, and adversarial review.
2. `Gemini 3.8 Flash High` for strong general-purpose reasoning with the visible High variant.
3. `Claude Sonnet 4.6 (Thinking)` when a Thinking model is desirable but Opus is unnecessary or unavailable.
4. `Gemini 3.7 Flash Medium` for balanced reasoning.
5. `GPT-OSS 120B (Medium)` as a bounded-analysis alternative.

For fast/mechanical work:

1. `Gemini 3.6 Flash Medium` (Fast).
2. `Gemini 3.8 Flash High` (Fast) when the task needs stronger reasoning.
3. `Gemini 3.7 Flash Medium` when a non-Fast balanced variant is preferable.
4. `Gemini 3.1 Pro Low` only when low reasoning is explicitly sufficient.

Use the exact model variant visible in the Antigravity picker. If a named model is missing, choose the closest same-tier variant visible in that picker and record the substitution.

## 12. Effort fallback rules

If the requested effort is unavailable on the selected model, use the nearest supported effort that preserves or increases reasoning depth.

Use this fallback order for reasoning-intensive work:

`ultra` -> `max` -> `xhigh` -> `high` -> `medium`.

Because Codex `ultra` adds automatic delegation, replacing `ultra` with `max` preserves maximum reasoning depth but removes automatic delegation. Claude Code has no `ultra` level in the current CLI and tops out at `max`. For Antigravity, switch to the exact stronger visible variant/model instead of fabricating an effort value: for example `Gemini 3.6 Flash Medium -> Gemini 3.8 Flash High -> Claude Opus 4.6 (Thinking)`.

For low-cost mechanical work:

`low` -> `medium`.

Never downgrade `high`, `xhigh`, or `max` work to `low` without explicit user direction.

## 13. Review policy

Review is a separate reasoning phase, not a continuation of implementation.

### Per-task review

After a meaningful implementation task in `subagent-driven-development`, invoke `requesting-code-review` according to the skill. Prefer:

- Codex reviewer: `gpt-6-astra high`; fallback `gpt-6.1-sol xhigh`.
- Claude reviewer: `Opus 5.5 high|xhigh`; use `Fable 5.1 max` for the hardest final reviews when entitled; fallback `Sonnet 5.5 xhigh`.
- Antigravity reviewer: `Claude Opus 4.6 (Thinking)`; fallback `Gemini 3.8 Flash High`.

When practical, do not use the exact same model/effort combination that authored the implementation. Context separation is mandatory; model diversity is preferred.

### Final review

Before integration of a material change, use two distinct review passes when the change is large enough to justify them:

1. Requirements/spec compliance: Codex `gpt-6.1-sol xhigh`, Claude `Sonnet 5.5 xhigh`, or Antigravity `Gemini 3.8 Flash High`. Check whether the implementation matches the approved design/plan and whether all required behaviors are present.
2. Code quality/regression review: Codex `gpt-6-astra xhigh`, Claude `Opus 5.5 xhigh` or `Fable 5.1 max`, or Antigravity `Claude Opus 4.6 (Thinking)`. Search for correctness bugs, race conditions, state leaks, error-path regressions, compatibility issues, and missing meaningful tests.

For a small bounded change, one independent high-quality review is sufficient unless the risk profile requires more. Examples: Codex `gpt-6-astra high`, Claude `Opus 5.5 high`, or Antigravity `Gemini 3.8 Flash High`.

Review findings are hypotheses until verified. Apply `receiving-code-review` before implementing them.

## 14. Verification and completion policy

Use `verification-before-completion` before claiming success, committing, creating a PR, or moving past a task when the skill requires it.

The verification agent may use the fast tier when the work is deterministic: Codex `gpt-6-luna medium`, Claude `Haiku 4.5 medium`, or Antigravity `Gemini 3.6 Flash Medium` (Fast). It must still gather fresh evidence itself; a stronger implementation agent's statement that tests passed is not verification.

Verification should answer concrete claims:

- Which command proves the test suite passes?
- Which command or behavioral reproduction proves the reported bug is fixed?
- Which diff/status command proves only intended files changed?
- Which requirement checklist proves the plan/spec was fully implemented?
- Which integration test or smoke test covers the user-visible path?

Escalate verification when outputs conflict, the requirement mapping is ambiguous, or verification requires interpreting nontrivial runtime behavior. Examples: Codex `gpt-6.1-sol medium|high`, Claude `Sonnet 5.5 medium|high`, or Antigravity `Gemini 3.8 Flash High`.

## 15. Operational selection algorithm

For every Superpowers phase, apply this algorithm:

1. Identify the active skill.
2. Identify the current phase: routing, design, planning, implementation, debugging, review, verification, or integration.
3. Start with the skill matrix's recommended model and effort.
4. Check whether the task meets an escalation criterion.
5. If yes, raise effort first when the model class is still suitable; otherwise move to the stronger model.
6. If dispatching an implementation worker, narrow the assignment until it is atomic before choosing the worker model.
7. If dispatching parallel workers, prove independence before dispatch.
8. If the selected model/effort is unavailable, follow the explicit fallback ladder and record the substitution.
9. After the uncertain phase is resolved, de-escalate for mechanical follow-through.
10. Use an independent review model before integration when the change is material.
11. Run fresh verification before any completion claim.

When the harness supports per-agent model and effort overrides, set both explicitly at dispatch time. If it does not, preserve the workflow and compensate with the nearest available parent model/effort. Do not invent unsupported dispatch parameters.

For standalone harness sessions, examples are:

```powershell
codex -m gpt-6.1-sol -c 'model_reasoning_effort="high"'
claude --model sonnet --effort high
```

Antigravity selection should use its model picker or native agent configuration; do not invent an unsupported command-line effort flag. Select the exact visible variant, such as `Gemini 3.8 Flash High`, `Gemini 3.6 Flash Medium`, or `Claude Opus 4.6 (Thinking)`.

Use CLI examples only when starting a separate harness session is actually desired. Superpowers subagents should use each harness's native agent dispatch when available.

## 16. Worked examples

### Example A: one-file bug with a clear reproduction

Task: a parser mishandles one known input and there is an existing test suite.

Routing:

- Codex: `systematic-debugging = gpt-6.1-sol high`, TDD worker `gpt-6-luna high`, review `gpt-6-astra high`, verification `gpt-6-luna medium`.
- Claude Code: `systematic-debugging = Sonnet 5.5 high`, TDD worker `Sonnet 5.5 high`, review `Opus 5.5 high`, verification `Haiku 4.5 medium`.
- Antigravity: `systematic-debugging = Gemini 3.8 Flash High`, TDD worker `Gemini 3.8 Flash High`, review `Claude Opus 4.6 (Thinking)`, verification `Gemini 3.6 Flash Medium` (Fast).

Do not keep the frontier reviewer model for implementation merely because it performed the review.

### Example B: cross-module cancellation/retry race

Task: an accepted request can be retried after a timeout because cancellation and recovery state cross process boundaries.

Routing:

- Codex: `gpt-6.1-sol xhigh` debugging, escalate to `gpt-6-astra xhigh|max`; plan on `gpt-6.1-sol xhigh`; atomic workers on `gpt-6.1-sol high`; final review on `gpt-6-astra xhigh`.
- Claude Code: `Opus 5.5 xhigh` debugging/planning, escalating to `Fable 5.1 max` when entitled; `Sonnet 5.5 high` atomic workers; `Opus 5.5 xhigh` or `Fable 5.1 max` final review.
- Antigravity: `Claude Opus 4.6 (Thinking)` for debugging/planning and final review; `Gemini 3.8 Flash High` for isolated implementation workers.

Verification may de-escalate to Luna, Haiku, or Gemini Flash only when the final smoke becomes deterministic; semantic lifecycle-log interpretation stays on the workhorse/reasoning tier.

### Example C: large implementation plan with independent tasks

Task: an approved plan contains six independent feature tasks.

Routing:

- Codex coordinator: `gpt-6.1-sol high`; straightforward workers: `gpt-6-luna high`; complex workers: `gpt-6.1-sol high`.
- Claude coordinator: `Sonnet 5.5 high`; straightforward workers: `Haiku 4.5 high` when the task is truly mechanical, otherwise `Sonnet 5.5 high`; complex workers: `Sonnet 5.5 high|xhigh`.
- Antigravity coordinator: `Gemini 3.8 Flash High`; straightforward workers: `Gemini 3.6 Flash Medium` (Fast); complex workers: `Gemini 3.8 Flash High`.
- Parallel dispatch only for non-overlapping files/state.
- Each meaningful task gets independent review.
- Coordinator integrates results and runs full verification.

Do not put the coordinator on `ultra` solely to obtain more parallelism. Use the explicit Superpowers parallel/subagent workflows so task boundaries remain reviewable.

### Example D: architecture choice with irreversible migration risk

Task: choose a persistence format and migration path that can cause data loss if wrong.

Routing:

- Codex: `gpt-6-astra xhigh|max` for design/planning, `gpt-6.1-sol high` for serialized implementation, `gpt-6-astra xhigh` for review, `gpt-6.1-sol high` for semantic verification.
- Claude Code: `Fable 5.1 max` when entitled or `Opus 5.5 xhigh` for design/planning, `Sonnet 5.5 high` implementation, `Opus 5.5 xhigh` review, `Sonnet 5.5 high` semantic verification.
- Antigravity: `Claude Opus 4.6 (Thinking)` for design/planning/review, `Gemini 3.8 Flash High` for narrow migration steps and semantic verification.

Keep irreversible migration steps serialized regardless of harness.

### Example E: Superpowers session diagnosis

Task: determine why a long Superpowers session repeated work and ignored plan boundaries.

Routing:

- Codex: `gpt-6.1-sol xhigh` coordinator; `gpt-6-luna high` or `gpt-6.1-sol high` analysts; `gpt-6-astra max` only for materially conflicting cited evidence.
- Claude Code: `Opus 5.5 xhigh` coordinator; `Sonnet 5.5 high` or `Haiku 4.5 high` analysts; `Fable 5.1 max` reconciliation only for real evidence conflicts when entitled.
- Antigravity: `Claude Opus 4.6 (Thinking)` coordinator; `Gemini 3.6 Flash Medium` (Fast) extraction analysts; `Claude Opus 4.6 (Thinking)` for conflict reconciliation.

The diagnosis remains evidence-based: model strength does not replace transcript path/line citations required by the skill.

## 17. Anti-patterns

Avoid these routing mistakes:

- Using Astra for every step of a workflow because it is the strongest model.
- Using Luna for architecture or adversarial review merely to save tokens.
- Keeping `max` or `ultra` after the task has become mechanical.
- Using `ultra` for a one-task implementation where automatic delegation can create overlapping state.
- Letting an implementation worker perform its own only review.
- Treating a reviewer finding as fact without `receiving-code-review` verification.
- Falling back from a frontier task directly to a legacy fast model.
- Silently changing a user-selected model or effort.
- Parallelizing tasks that modify the same file or depend on each other's intermediate output.
- Claiming completion from an agent summary instead of fresh verification evidence.
- Publishing a table that covers only one harness. Every Superpowers skill row in this guide must keep at least one Codex, one Claude Code, and one Antigravity model example.
- Treating Antigravity's visible `High`, `Medium`, or `Low` variant labels as if they were independent CLI effort flags.

## 18. Compact policy for agent prompts

When a subagent needs the routing policy but cannot read this file, include this compact instruction:

```text
Use Superpowers phase-based routing and keep all three harness families explicit.
Codex: GPT-6.1 Sol/high implementation, GPT-6.1 Sol/xhigh planning/debugging,
GPT-6 Astra/high|xhigh review, GPT-6 Luna/medium mechanical verification.
Claude Code: Sonnet 5.5/high implementation, Opus 5.5/xhigh or Fable 5.1/max
planning/debugging/review when entitled, Haiku 4.5/medium verification.
Antigravity: Gemini 3.8 Flash High for implementation/general reasoning,
Gemini 3.6 Flash Medium (Fast) for mechanical verification, and Claude Opus
4.6 (Thinking) for the deepest planning/debugging/review. Keep implementation
tasks atomic, prove parallel tasks are independent,
preserve reasoning depth across fallbacks, and run fresh verification before
completion claims.
```

This compact form is a reminder, not a replacement for the full matrix when the file is available.

## 19. Maintenance

Re-check this guide when the local Codex model catalog, Claude Code model set, Antigravity model picker, or Superpowers version changes.

Update the matrix when any of these change:

- a model becomes legacy, hidden, retired, or unavailable;
- a new workhorse/frontier model appears;
- reasoning-effort semantics change;
- Superpowers adds, removes, or materially changes a skill;
- native subagent routing gains or loses model/effort override support.
- Claude changes the current Opus/Sonnet/Haiku generation or supported effort levels;
- Antigravity changes the available Gemini models or reasoning/thinking controls.

When updating, prefer current local catalog/help/picker evidence and the installed Superpowers `SKILL.md` files over remembered model behavior. Preserve the invariant that every per-skill row names at least one Codex, one Claude Code, and one Antigravity option.
