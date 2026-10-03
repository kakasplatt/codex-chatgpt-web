# Full Context Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental Full Context mode that advertises a 1,050,000-token logical Codex context with auto-compaction at 900,000 tokens while keeping every physical ChatGPT Web message inside measured browser limits through retained-conversation reuse, adaptive multipart staging, and recovery checkpoints.

**Architecture:** Full Context is a new automatic Sol-only context mode beside Standard and Bigger Context. Canonical Codex history remains authoritative for context limits, usage, and native compaction; the browser may physically receive only a retained suffix or an exact-parent recovery checkpoint plus the current turn, and a separate Full Context multipart planner chooses the smallest safe count from 2 through 12 when a fresh physical send cannot fit inline. Existing Bigger Context and Luna behavior remain compatibility contracts and must stay green while shared multipart/checkpoint primitives are generalized.

**Tech Stack:** TypeScript 5.9, Bun 1.4, Playwright browser worker, Electron/React launcher, Zod persistence validation, existing ChatGPT Web adapter and Responses bridge tests.

**Spec:** `docs/superpowers/specs/2026-10-03-full-context-hybrid-design.md`

## Global Constraints

- Full Context logical context window is exactly `1_050_000` tokens.
- Full Context auto-compaction threshold is exactly `900_000` tokens; the effective context percentage is derived from those values.
- Measured per-message ChatGPT Web token and composer-character limits remain unchanged and are enforced for every physical send.
- Full Context multipart uses the smallest safe count from `2` through `12`; the number of parts never increases the logical `1_050_000`-token ceiling.
- Multipart partitions only complete ordered transport records; never split or truncate an individual Codex message, JSON record, schema, attachment descriptor, or current execution record.
- Full Context private checkpoints use a separate marker and a maximum of `16_000` checkpoint tokens.
- Canonical Codex history is authoritative. Retained suffixes and private checkpoints are physical transport optimizations/recovery state only.
- Reuse the retained ChatGPT conversation whenever the existing retained-conversation contract proves it is reusable; normal retained turns send only the resume suffix.
- A Full Context checkpoint is recovery-only. Missing, stale, malformed, wrong-parent, wrong-source-turn, or wrong-current-revision checkpoint evidence falls back to canonical history.
- Once a Full Context checkpoint chain starts, refresh it after every successful normal Full Context turn while the chain remains exact-parent valid.
- Codex input usage and compaction decisions are calculated from the canonical input even when the browser physically receives a resume suffix or checkpoint recovery input.
- Native compaction prefers the retained structured handoff; if the retained source is unavailable, run fresh canonical Full Context compaction. A recovery checkpoint never substitutes for canonical/native compaction input.
- Existing Bigger Context keeps its current three-times logical profile and its `2`/`6` part-selection semantics.
- Existing Luna rolling-checkpoint behavior, marker, `4_000`-token checkpoint limit, and persistence semantics remain unchanged.
- Full Context and Bigger Context are mutually exclusive. Both enabled at runtime is invalid; enabling one through setup/launcher atomically disables the other.
- Full Context defaults to disabled and is unavailable in Zero Risk/manual browser interaction mode.
- After semantic submission acceptance, recovery must never physically resend the accepted multipart stage or final payload. Adaptive effort promotion is allowed only after the existing pre-acceptance measured message-length rejection.

## Review Focus

- A single atomic record fits the `1_050_000` logical window but cannot fit any measured physical message: fail before browser submission with a compact/reduce-input error; never split the record.
- A retained ChatGPT conversation disappears after an earlier Full Context multipart turn: use the exact-parent Full Context checkpoint plus the current native turn when valid, without replaying or duplicating retained history.
- The canonical history contains repeated identical assistant text from another turn/branch: source-turn identity and current-turn revision must prevent the wrong checkpoint from being applied; fall back to canonical history.
- A multipart stage is semantically accepted and then its DOM/ACK surface disappears or stalls: recover observation for that accepted submission and never issue a second physical Send for the stage.
- Configuration is ambiguous or mode changes to Zero Risk: reject `experimentalFullContext=true` with `experimentalBiggerContext=true`, make launcher toggles mutually exclusive, and force Full Context off for manual mode.

---

### Task 1: Add the Full Context logical profile and backend configuration contract

**Files:**
- Modify: `src/chatgpt-web-models.ts:78-165,250-262,462-499`
- Modify: `src/config.ts:98-123,249-255,530-585,631-643`
- Modify: `src/setup.ts:45-60,140-185,280-322`
- Modify: `src/types.ts:270-315`
- Modify: `src/cli.ts:70-90,318-327`
- Modify: `src/dev-chat/cli.ts:350-385`
- Test: `tests/chatgpt-web-models.test.ts`
- Test: `tests/model-catalog.test.ts`
- Test: `tests/server-models.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/setup-lifecycle.test.ts`

**Interfaces:**
- Produces: `CHATGPT_WEB_FULL_CONTEXT_WINDOW = 1_050_000` and `CHATGPT_WEB_FULL_CONTEXT_AUTO_COMPACT_TOKEN_LIMIT = 900_000` in `src/chatgpt-web-models.ts`.
- Produces: `ChatGptWebAccountCapabilities.experimentalFullContext?: boolean`.
- Produces: an explicit `supportsChatGptWebFullContext(backendModel: ChatGptWebBackendModel): boolean` contract that is true only for the Sol automatic backend family in this release.
- Produces: `AppConfig.experimentalFullContext: boolean`, default `false`, without changing config version `3`.
- Produces: `SetupOptions.experimentalFullContext?: boolean` and provider/config propagation of the flag.
- Produces: CLI flag `--full-context`; `--standard-context` clears both Full and Bigger; `--full-context` and `--bigger-context` are mutually exclusive.
- Preserves: native-only context overrides and every existing Standard/Bigger/Luna/Zero Risk catalog row.

- [ ] **Step 1: Write failing model/config tests for the Full Context profile and invalid combinations**

Add assertions that an automatic Sol route with `experimentalFullContext: true` reports `{ contextWindow: 1_050_000, autoCompactTokenLimit: 900_000, effectiveContextWindowPercent: 86 }`, Bigger still reports its existing values, Luna is not routed through Full Context, and Full+Bigger or manual+Full throws. Add CLI/setup tests proving `--full-context`, `--standard-context`, and the three-way context-mode conflict rules.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test tests/chatgpt-web-models.test.ts tests/model-catalog.test.ts tests/server-models.test.ts tests/cli.test.ts tests/setup-lifecycle.test.ts`

Expected: FAIL because Full Context constants, config fields, and CLI/setup routing do not exist.

- [ ] **Step 3: Implement the Full Context logical/config contract**

Add the explicit Sol-family support helper and use it in `resolveChatGptWebContextLimits()` so Full Context returns exactly `1_050_000/900_000` only for supported automatic routes, rejects Luna and ambiguous Full+Bigger state, and remains unavailable for Zero Risk/manual routes. Add `experimentalFullContext` to config parsing/defaults/provider wiring and setup transaction options. Extend the production and DEV CLIs with `--full-context`; make `--standard-context` clear both experimental context flags and reject simultaneous context-mode flags.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun test tests/chatgpt-web-models.test.ts tests/model-catalog.test.ts tests/server-models.test.ts tests/cli.test.ts tests/setup-lifecycle.test.ts`

Expected: PASS, including exact `1_050_000`, `900_000`, `86`, unchanged Bigger values, and Zero Risk rejection.

- [ ] **Step 5: Commit**

```bash
git add src/chatgpt-web-models.ts src/config.ts src/setup.ts src/types.ts src/cli.ts src/dev-chat/cli.ts tests/chatgpt-web-models.test.ts tests/model-catalog.test.ts tests/server-models.test.ts tests/cli.test.ts tests/setup-lifecycle.test.ts
git commit -m "feat: add full context logical profile"
```

### Task 2: Generalize multipart primitives to 2 through 12 parts without changing Bigger Context semantics

**Files:**
- Modify: `src/adapters/chatgpt-web/prompt.ts:20-135,360-470,620-680`
- Modify: `src/adapters/chatgpt-web/usage.ts:1-130`
- Test: `tests/prompt-contract.test.ts`
- Test: `tests/chatgpt-web-usage.test.ts`

**Interfaces:**
- Produces: `CHATGPT_FULL_CONTEXT_MAX_PARTS = 12`.
- Produces: `ChatGptWebMultipartPartCount = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12`.
- Produces: `ChatGptWebBiggerContextPartCount = 2 | typeof CHATGPT_BIGGER_CONTEXT_PARTS`.
- Produces: `ChatGptWebMultipartContextMode = "bigger" | "full"` and `ChatGptWebMultipartPrompt.contextMode`.
- Produces: `CompileChatGptWebPromptOptions.experimentalMultipartMode?: ChatGptWebMultipartContextMode`; when `experimentalMultipartParts` is set and mode is omitted, compatibility default is `"bigger"`.
- Preserves: `resolveBiggerContextMultipartParts()` and `biggerContextPartCount()` return only `undefined | 2 | 6`.

- [ ] **Step 1: Write failing multipart contract tests**

Add tests that `3`, `7`, and `12` are valid generic multipart counts, `1` and `13` are rejected, stage/commit manifests preserve ordered whole JSON records for non-`2/6` counts, and Bigger selection still returns only inline/`2`/`6` for the existing fixtures.

- [ ] **Step 2: Run focused multipart tests and verify RED**

Run: `bun test tests/prompt-contract.test.ts tests/chatgpt-web-usage.test.ts`

Expected: FAIL because generic multipart currently accepts only `2 | 6` and commit/stage validation rejects other counts.

- [ ] **Step 3: Generalize multipart count and mode primitives**

Expand the generic multipart guards/formatters/partition typing to integer counts `2..12`, carry `contextMode` on the compiled multipart transaction, and keep a narrower Bigger type/guard for Bigger-only selection. Preserve whole-record partitioning and transaction manifest ordering; do not change Bigger thresholds or multiplier math.

- [ ] **Step 4: Run focused multipart tests and verify GREEN**

Run: `bun test tests/prompt-contract.test.ts tests/chatgpt-web-usage.test.ts`

Expected: PASS; generic `2..12` transport works and every existing Bigger `2/6` expectation remains green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/chatgpt-web/prompt.ts src/adapters/chatgpt-web/usage.ts tests/prompt-contract.test.ts tests/chatgpt-web-usage.test.ts
git commit -m "refactor: generalize multipart context transport"
```

### Task 3: Implement the Full Context multipart planner and physical/logical preflight

**Files:**
- Modify: `src/adapters/chatgpt-web/usage.ts:30-160`
- Modify: `src/adapters/chatgpt-web/browser-worker.ts:1024-1118,5060-5105`
- Test: `tests/chatgpt-web-usage.test.ts`
- Test: `tests/browser-worker-contract.test.ts`
- Test: `tests/skill-attachments.test.ts`

**Interfaces:**
- Consumes: generic `ChatGptWebMultipartPartCount` and `ChatGptWebMultipartContextMode` from Task 2.
- Produces: `resolveFullContextMultipartPlan(parsed: CodexParsedRequest, capabilities: ChatGptWebCapabilities, experimentalSkillAttachments?: boolean): ChatGptWebMultipartPartCount | undefined`.
- Produces: `assertChatGptWebMultipartInputWithinLimits(...)` enforcement keyed by `prepared.multipart.contextMode`: Bigger uses the existing `baseContextWindow * min(partCount, 3)` ceiling; Full uses exactly `CHATGPT_WEB_FULL_CONTEXT_WINDOW` independent of part count.
- Guarantees: planner evaluates inline first, then counts `2..12` in ascending order and returns the first count whose fully formatted physical messages fit measured token/character budgets.

- [ ] **Step 1: Write failing planner/preflight tests, including Review Focus atomic-record coverage**

Add cases for: inline fit; smallest safe count selection; a payload requiring more than six but at most twelve parts; schemas/images/skill attachments reserving final-message budget; whole-record order across parts; canonical input at or above `1_050_000` rejected independent of part count; and one atomic record below the logical ceiling but above every physical message budget failing before any browser Send.

- [ ] **Step 2: Run planner/preflight tests and verify RED**

Run: `bun test tests/chatgpt-web-usage.test.ts tests/browser-worker-contract.test.ts tests/skill-attachments.test.ts`

Expected: FAIL because Full Context planning and Full logical preflight do not exist.

- [ ] **Step 3: Implement `resolveFullContextMultipartPlan()` and mode-aware preflight**

Use the existing compiled-message accounting so wrapper text, stage acknowledgements, schemas, images, and skill-file reserves are included. For inert stages use the same account-visible staging-effort candidates as current adaptive Bigger Context; use the requested effort for the final execution message. Return the first fitting count. If no count through `12` fits, fail with `context_length_exceeded` before submission and state that atomic records are not split.

- [ ] **Step 4: Run planner/preflight tests and verify GREEN**

Run: `bun test tests/chatgpt-web-usage.test.ts tests/browser-worker-contract.test.ts tests/skill-attachments.test.ts`

Expected: PASS; a `>6` part Full transaction succeeds in preflight, `>12`/atomic-record failures are pre-submit, and Bigger tests remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/chatgpt-web/usage.ts src/adapters/chatgpt-web/browser-worker.ts tests/chatgpt-web-usage.test.ts tests/browser-worker-contract.test.ts tests/skill-attachments.test.ts
git commit -m "feat: plan full context multipart transport"
```

### Task 4: Extract the generic exact-parent private-checkpoint core with Luna parity

**Files:**
- Create: `src/adapters/chatgpt-web/private-checkpoint.ts`
- Modify: `src/adapters/chatgpt-web/rolling-checkpoint.ts:1-340`
- Test: `tests/rolling-checkpoint.test.ts`

**Interfaces:**
- Produces: `ChatGptPrivateCheckpointPolicy<TCheckpoint>` with `{ label, marker, maxTokens, parseCheckpoint, checkpointContext }`.
- Produces: `CapturedChatGptPrivateCheckpoint<TCheckpoint> = { checkpoint: TCheckpoint; answerHash: string }`.
- Produces: `ChatGptPrivateCheckpointStream<TCheckpoint>` with the existing stream contract: `push(delta)`, `complete(rawResponseText)`, and `finish(rawResponseText)`.
- Produces: `ChatGptPrivateCheckpointStore<TCheckpoint>` with `apply(parsed: CodexParsedRequest)` and `commit(parsed: CodexParsedRequest, captured, answer: string)` plus the existing persistence TTL/max-entry behavior.
- Preserves: all public Luna exports and observable behavior in `rolling-checkpoint.ts`; it becomes a Luna policy/wrapper around the generic core.

- [ ] **Step 1: Add Luna parity tests around the extraction boundary**

Pin the current Luna marker, `4_000`-token maximum, split-marker streaming, exact-parent answer hash, source-turn identity, current-turn preservation, malformed persistence cleanup, TTL, max-entry behavior, and wrong-parent fallback before moving code.

- [ ] **Step 2: Run Luna tests as the pre-refactor baseline**

Run: `bun test tests/rolling-checkpoint.test.ts`

Expected: PASS before refactor; record this as the compatibility baseline.

- [ ] **Step 3: Extract `private-checkpoint.ts` and convert Luna to a wrapper**

Move only the reusable stream, exact-parent lookup, current-turn slicing, answer-hash binding, persistence, and generic policy hooks. Keep Luna schema/marker/error naming in `rolling-checkpoint.ts` and export the same `ChatGptLunaCheckpointStream`, `ChatGptLunaCheckpointStore`, `CapturedChatGptLunaCheckpoint`, marker, and max-token names expected by current callers/tests.

- [ ] **Step 4: Run Luna parity tests and verify GREEN**

Run: `bun test tests/rolling-checkpoint.test.ts`

Expected: PASS with no changed Luna expectations.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/chatgpt-web/private-checkpoint.ts src/adapters/chatgpt-web/rolling-checkpoint.ts tests/rolling-checkpoint.test.ts
git commit -m "refactor: extract private checkpoint core"
```

### Task 5: Add the Full Context checkpoint policy, persistence, and capture-chain contract

**Files:**
- Create: `src/adapters/chatgpt-web/full-context-checkpoint.ts`
- Modify: `src/adapters/chatgpt-web/prompt.ts:20-50,430-470`
- Modify: `src/adapters/chatgpt-web/browser-worker.ts:1320-1340` and checkpoint stream handling sites
- Modify: `src/types.ts:280-315`
- Modify: `src/config.ts:625-645`
- Test: `tests/full-context-checkpoint.test.ts`
- Test: `tests/prompt-contract.test.ts`
- Test: `tests/browser-worker-contract.test.ts`
- Test: `tests/runtime-layout.test.ts`

**Interfaces:**
- Consumes: generic private-checkpoint core from Task 4.
- Produces: `CHATGPT_FULL_CONTEXT_CHECKPOINT_MARKER = "CODEXFULLPRIVATECHECKPOINTV1A7F3C9D2"`.
- Produces: `CHATGPT_FULL_CONTEXT_CHECKPOINT_MAX_TOKENS = 16_000`.
- Produces: `ChatGptFullContextCheckpointStream` and `ChatGptFullContextCheckpointStore` wrappers using the Full policy.
- Produces: provider field `fullContextCheckpointStatePath?: string`, defaulting to `runtime/full-context-checkpoints.json`.
- Produces: generic prompt/browser checkpoint-capture contract that can select Luna or Full policy without changing Luna output; Full capture is best-effort from the user's perspective, so a valid visible answer without a Full checkpoint marker still succeeds and logs a warning.
- Capture rule: on a normal Full turn, capture when the canonical turn needs Full multipart or the exact parent already yielded a valid Full checkpoint; once active, successful child turns refresh the chain.

- [ ] **Step 1: Write failing Full checkpoint tests, including wrong-branch/repeated-answer Review Focus coverage**

Test the separate marker, `16_000` maximum, exact-parent apply/commit, persistence path, successful chain refresh, invalid/malformed/stale fallback, repeated identical assistant text with mismatched `sourceTurnId`, current user-revision/current-turn preservation, and a valid visible answer that omits the Full checkpoint marker but still succeeds with no new checkpoint. Assert malformed capture never overwrites a previously valid exact-parent mapping. Add a prompt/browser contract test showing the generic capture mode selects Full without changing Luna capture behavior.

- [ ] **Step 2: Run checkpoint-focused tests and verify RED**

Run: `bun test tests/full-context-checkpoint.test.ts tests/rolling-checkpoint.test.ts tests/prompt-contract.test.ts tests/browser-worker-contract.test.ts tests/runtime-layout.test.ts`

Expected: FAIL only for missing Full/generic capture functionality; existing Luna tests remain green.

- [ ] **Step 3: Implement Full checkpoint policy and generic capture wiring**

Build `full-context-checkpoint.ts` on the Task 4 core. Add the dedicated runtime file path. Replace Luna-only prompt/browser capture branching with a policy-driven capture descriptor while retaining Luna public wrappers and errors. The Full prompt asks the checkpoint to preserve concrete requirements, paths, commands, observed results, architectural decisions, unresolved failures, and next actions. Missing/malformed Full capture is discarded after the visible answer succeeds unless it exposes a hard invariant violation; never mutate canonical history or overwrite a previously valid mapping on capture/apply failure.

- [ ] **Step 4: Run checkpoint-focused tests and verify GREEN**

Run: `bun test tests/full-context-checkpoint.test.ts tests/rolling-checkpoint.test.ts tests/prompt-contract.test.ts tests/browser-worker-contract.test.ts tests/runtime-layout.test.ts`

Expected: PASS, including wrong-source-turn fallback and unchanged Luna parity.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/chatgpt-web/full-context-checkpoint.ts src/adapters/chatgpt-web/prompt.ts src/adapters/chatgpt-web/browser-worker.ts src/types.ts src/config.ts tests/full-context-checkpoint.test.ts tests/rolling-checkpoint.test.ts tests/prompt-contract.test.ts tests/browser-worker-contract.test.ts tests/runtime-layout.test.ts
git commit -m "feat: add full context recovery checkpoints"
```

### Task 6: Integrate canonical, retained-resume, and recovery input selection with canonical usage accounting

**Files:**
- Modify: `src/adapters/chatgpt-web/index.ts:390-485,700-810,1260-1440`
- Modify: `src/adapters/chatgpt-web/usage.ts:140-175`
- Modify: `src/adapters/chatgpt-web/conversation-key.ts`
- Test: `tests/chatgpt-web-harness.test.ts`
- Test: `tests/chatgpt-web-usage.test.ts`
- Test: `tests/rolling-checkpoint.test.ts`
- Test: `tests/full-context-checkpoint.test.ts`

**Interfaces:**
- Consumes: `resolveFullContextMultipartPlan()` from Task 3 and `ChatGptFullContextCheckpointStore` from Task 5.
- Defines per normal Full turn: `canonicalInput = parsed`; `resumeInput = retainedConversationResumeRequest(canonicalInput)` when a retained conversation key is eligible; `recoveryInput = fullContextCheckpointStore.apply(canonicalInput).parsed` only when exact-parent validation succeeds.
- Preserves: the conversation key is derived from canonical thread/model/effort/compaction identity, independent of which physical input is selected.
- Physical selection: `prepareResume()` compiles `resumeInput`; fresh `prepare()` compiles `recoveryInput` when valid, otherwise `canonicalInput`.
- Produces: Full compile options with `experimentalMultipartMode: "full"` and part count resolved separately for the physical input being prepared.
- Produces: usage accounting that always estimates input from `canonicalInput` for Full Context, regardless of `resumeInput`/`recoveryInput`; Luna keeps its existing bounded-physical-input accounting.

- [ ] **Step 1: Write failing harness/accounting tests, including retained-loss Review Focus coverage**

Add three-path tests proving: retained reuse prepares only the suffix and does not substitute a checkpoint; a fresh browser conversation with a valid exact-parent Full checkpoint prepares checkpoint+current turn; a fresh conversation with no/invalid checkpoint prepares canonical history and invokes Full multipart when needed. Simulate retained conversation loss after a prior multipart turn and assert the recovery path contains no duplicate retained prefix. Add usage tests where the physical suffix/checkpoint is small but reported Codex input tokens still reflect the canonical request.

- [ ] **Step 2: Run adapter selection tests and verify RED**

Run: `bun test tests/chatgpt-web-harness.test.ts tests/chatgpt-web-usage.test.ts tests/full-context-checkpoint.test.ts tests/rolling-checkpoint.test.ts`

Expected: FAIL because Full Context currently has neither three-way physical selection nor canonical accounting.

- [ ] **Step 3: Implement Full input selection and canonical accounting**

Keep `canonicalInput` immutable for Full usage/compaction decisions. Build `prepare` and `prepareResume` independently so browser retained-conversation reuse remains the primary path. Apply Full checkpoints only to fresh physical preparation. Start/refresh Full checkpoint capture according to Task 5's chain rule and commit only after a successful normal browser turn.

- [ ] **Step 4: Run adapter selection tests and verify GREEN**

Run: `bun test tests/chatgpt-web-harness.test.ts tests/chatgpt-web-usage.test.ts tests/full-context-checkpoint.test.ts tests/rolling-checkpoint.test.ts`

Expected: PASS for canonical/resume/recovery selection and canonical usage accounting; existing Luna behavior remains green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/chatgpt-web/index.ts src/adapters/chatgpt-web/usage.ts src/adapters/chatgpt-web/conversation-key.ts tests/chatgpt-web-harness.test.ts tests/chatgpt-web-usage.test.ts tests/full-context-checkpoint.test.ts tests/rolling-checkpoint.test.ts
git commit -m "feat: integrate full context input selection"
```

### Task 7: Route Full Context native compaction through retained handoff or fresh canonical multipart

**Files:**
- Modify: `src/adapters/chatgpt-web/index.ts:980-1185`
- Modify: `src/adapters/chatgpt-web/usage.ts`
- Test: `tests/retained-compaction.test.ts`
- Test: `tests/server-compaction.test.ts`
- Test: `tests/chatgpt-web-harness.test.ts`

**Interfaces:**
- Consumes: canonical Full Context usage/planning from Tasks 3 and 6.
- Preserves: existing retained structured compaction handoff as the first choice when the retained source conversation is available.
- Produces: fresh Full Context compaction fallback that compiles the canonical compaction request with `resolveFullContextMultipartPlan()` and never calls `ChatGptFullContextCheckpointStore.apply()`.
- Guarantees: approaching `900_000` canonical input tokens triggers the native compaction behavior exposed to Codex; physical suffix/checkpoint size cannot postpone it.

- [ ] **Step 1: Write failing compaction tests**

Add tests for retained Full compaction handoff, retained-source-unavailable fallback to fresh canonical multipart, checkpoint presence not changing compaction input, and usage near the `900_000` threshold remaining canonical even when the browser resume suffix is tiny.

- [ ] **Step 2: Run compaction tests and verify RED**

Run: `bun test tests/retained-compaction.test.ts tests/server-compaction.test.ts tests/chatgpt-web-harness.test.ts`

Expected: FAIL because Full Context compaction fallback/planning and canonical accounting are not integrated.

- [ ] **Step 3: Implement Full compaction routing**

Leave the retained handoff lifecycle intact. When it cannot source the retained conversation, invoke the existing fresh-compaction path with the untouched canonical compaction request and Full multipart planner. Explicitly bypass recovery-checkpoint substitution for every `_compactionRequest`.

- [ ] **Step 4: Run compaction tests and verify GREEN**

Run: `bun test tests/retained-compaction.test.ts tests/server-compaction.test.ts tests/chatgpt-web-harness.test.ts`

Expected: PASS, including canonical fallback and retained handoff regression coverage.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/chatgpt-web/index.ts src/adapters/chatgpt-web/usage.ts tests/retained-compaction.test.ts tests/server-compaction.test.ts tests/chatgpt-web-harness.test.ts
git commit -m "feat: compact full context canonically"
```

### Task 8: Harden Full multipart browser lifecycle and accepted-stage no-resend behavior

**Files:**
- Modify: `src/adapters/chatgpt-web/browser-worker.ts:1328-1336,3810-3860,5300-5600`
- Test: `tests/browser-worker-contract.test.ts`
- Test: `tests/chatgpt-web-harness.test.ts`
- Test: `tests/compaction-browser-recovery.test.ts`
- Test: `tests/browser-response-dom.test.ts`

**Interfaces:**
- Consumes: generic `2..12` compiled transactions and mode-aware preflight from Tasks 2-3.
- Preserves: `onSendActivated` as the ambiguity boundary and `onSubmitted` as semantic acceptance evidence.
- Preserves: current adaptive staging-effort candidate order and promotion only for `chatgpt_message_length_exceeds_limit` observed before acceptance.
- Guarantees: after a stage or final payload reaches semantic acceptance, DOM/ACK timeout, page reacquisition, cancellation settlement, or response-observation recovery may rebind/reobserve but may not invoke Send again for that payload.

- [ ] **Step 1: Write failing browser lifecycle tests, including accepted-stage Review Focus coverage**

Add a `7+` part transaction fixture and a `12` part boundary fixture. Add a regression where part N is accepted, its ACK/DOM surface disappears, recovery reacquires the same logical turn, and the send counter stays exactly `1` for that part. Keep tests showing pre-acceptance measured size rejection may promote effort once per existing candidate sequence, while cancellation and non-size errors never promote/resend.

- [ ] **Step 2: Run browser lifecycle tests and verify RED where Full/generic behavior is missing**

Run: `bun test tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts tests/compaction-browser-recovery.test.ts tests/browser-response-dom.test.ts`

Expected: generic/high-part or Full lifecycle cases fail; existing accepted-send regressions remain green.

- [ ] **Step 3: Generalize the staged loop while retaining accepted-send safety boundaries**

Remove any remaining `2/6` assumptions from stage iteration/acknowledgement messages, use `prepared.multipart.parts.length`, and route Full through the same bounded effort-promotion machinery. Keep accepted submission state outside any branch that can loop back to physical send, and use existing observation recovery for post-acceptance DOM/ACK loss.

- [ ] **Step 4: Run browser lifecycle tests and verify GREEN**

Run: `bun test tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts tests/compaction-browser-recovery.test.ts tests/browser-response-dom.test.ts`

Expected: PASS, with exactly one physical Send for each accepted stage/final payload and successful `7..12` part lifecycle coverage.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/chatgpt-web/browser-worker.ts tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts tests/compaction-browser-recovery.test.ts tests/browser-response-dom.test.ts
git commit -m "feat: harden full context browser staging"
```

### Task 9: Add mutually exclusive Full Context launcher state, runtime mutation, UI, and localization

**Files:**
- Modify: `launcher/src/types.ts:1-30`
- Modify: `launcher/electron/state.cjs:1-65`
- Modify: `launcher/electron/runtime-supervisor.cjs:250-270`
- Modify: `launcher/electron/runtime.cjs:1090-1140,1450-1465`
- Modify: `launcher/electron/main.cjs:775-790,855-870,900-920,985-1000,1295-1400`
- Modify: `launcher/electron/preload.cjs`
- Modify: `launcher/src/App.tsx:350-370,1880-1920`
- Modify: `launcher/src/i18n.ts`
- Test: `launcher/tests/state.test.cjs`
- Test: `launcher/tests/runtime-supervisor.test.cjs`
- Test: `launcher/tests/runtime-host.test.cjs`
- Test: `launcher/tests/renderer-wiring.test.cjs`
- Test: `launcher/tests/localization.test.cjs`

**Interfaces:**
- Produces: launcher state `experimentalFullContext: boolean`, default `false`.
- Produces: `RuntimeHost.setFullContext(enabled: boolean)` mirroring the existing Bigger setup transaction and invoking `--full-context`/`--standard-context` as appropriate.
- Produces: preload/IPC method `setFullContext(enabled)` via `launcher:full-context`.
- Mutation rule: enabling Full writes Full=`true`, Bigger=`false`; enabling Bigger writes Bigger=`true`, Full=`false`; Standard writes both `false` in one setup transaction.
- Manual-mode rule: switching to Zero Risk/manual persists runtime state with Full disabled and exposes the Full toggle as unavailable, matching the existing automatic-only setting pattern.
- UI copy: add Full Context title/body/unavailable text in every language currently present in `launcher/src/i18n.ts`; do not replace or silently repurpose Bigger Context copy.

- [ ] **Step 1: Write failing launcher tests, including configuration/mode Review Focus coverage**

Add default-state tests, runtime validation rejecting both flags, `setFullContext(true)` transaction tests, Bigger-to-Full and Full-to-Bigger atomic mutual-exclusion tests, manual-mode disable tests, IPC/preload wiring tests, disabled UI state in Zero Risk, and localization key completeness across all supported languages.

- [ ] **Step 2: Run launcher tests and verify RED**

Run: `$env:PSExecutionPolicyPreference='Bypass'; bun run launcher:test`

Expected: FAIL in the newly added Full Context launcher expectations.

- [ ] **Step 3: Implement launcher Full Context state/runtime/UI wiring**

Mirror the existing Bigger transaction path with a separate Full toggle and runtime method. Always send a single context-mode setup transaction that determines both flags. Update saved state reconciliation and manual-mode patches to include Full. Add settings UI and translated copy while leaving the Bigger startup recommendation behavior unchanged unless its toggle is used, in which case mutual exclusion still applies.

- [ ] **Step 4: Run launcher tests and typecheck**

Run: `$env:PSExecutionPolicyPreference='Bypass'; bun run launcher:test`

Run: `bun run launcher:typecheck`

Expected: PASS for both commands.

- [ ] **Step 5: Commit**

```bash
git add launcher/src/types.ts launcher/electron/state.cjs launcher/electron/runtime-supervisor.cjs launcher/electron/runtime.cjs launcher/electron/main.cjs launcher/electron/preload.cjs launcher/src/App.tsx launcher/src/i18n.ts launcher/tests/state.test.cjs launcher/tests/runtime-supervisor.test.cjs launcher/tests/runtime-host.test.cjs launcher/tests/renderer-wiring.test.cjs launcher/tests/localization.test.cjs
git commit -m "feat: add full context launcher controls"
```

### Task 10: Document the final contract and run focused, full, and live verification

**Files:**
- Modify: `docs/architecture.md:154-206`
- Modify: `docs/dev-chat.md:101-120`
- Modify as needed for test-only smoke coverage: `tests/dev-chat.test.ts`, `tests/dev-profile.test.ts`

**Interfaces:**
- Documents: logical `1_050_000/900_000` Full Context versus unchanged physical browser limits; retained suffix as primary continuity; exact-parent checkpoint as recovery; adaptive `2..12` fresh multipart; canonical usage/compaction; Bigger/Luna compatibility; no-resend-after-acceptance.
- Produces: a repeatable live-smoke checklist covering inline, approximately 200K, 350K-500K, 800K-850K, retained suffix, retained loss/checkpoint recovery, invalid checkpoint/canonical fallback, approximately 900K compaction, and cancellation/observation loss after an accepted stage.

- [ ] **Step 1: Update architecture/developer documentation and any smoke fixtures needed to expose Full mode**

Describe Full Context as one logical context carried by multiple possible physical transport representations. State measured browser message ceilings separately and keep Bigger Context documented as the existing 3x compatibility mode.

- [ ] **Step 2: Run the focused cross-feature regression set**

Run: `bun test tests/chatgpt-web-models.test.ts tests/chatgpt-web-usage.test.ts tests/prompt-contract.test.ts tests/rolling-checkpoint.test.ts tests/full-context-checkpoint.test.ts tests/retained-compaction.test.ts tests/server-compaction.test.ts tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts tests/compaction-browser-recovery.test.ts tests/skill-attachments.test.ts tests/cli.test.ts tests/setup-lifecycle.test.ts tests/model-catalog.test.ts tests/server-models.test.ts`

Expected: PASS.

- [ ] **Step 3: Run complete automated verification**

Run: `bun run typecheck`

Run: `bun test ./tests`

Run: `$env:PSExecutionPolicyPreference='Bypass'; bun run launcher:test`

Run: `bun run launcher:typecheck`

Run: `git diff --check`

Expected: all commands PASS. If `bun run verify` is also run, report its actual exit state rather than treating later stages as green when an earlier audit gate stops the script.

- [ ] **Step 4: Run the required live ChatGPT Web smoke matrix and record observed boundaries**

Verify, in order: small inline Full request; approximately 200K canonical request; 350K-500K request exceeding the old 240K effective Bigger budget; 800K-850K canonical request; next retained turn sending only its suffix; deliberate retained-conversation loss using exact-parent checkpoint recovery; invalid checkpoint forcing canonical fresh multipart; canonical usage approaching `900_000` causing native compaction; accepted multipart stage followed by cancellation/DOM observation disruption with no physical resend. For every case record logical tokens, chosen part count/retained path, largest physical message tokens/chars, selected staging effort, acceptance evidence, and final outcome.

- [ ] **Step 5: Commit documentation/final smoke fixtures**

```bash
git add docs/architecture.md docs/dev-chat.md tests/dev-chat.test.ts tests/dev-profile.test.ts
git commit -m "docs: document hybrid full context transport"
```

The implementation is ready for final branch review only after every task's focused checks pass, the complete TypeScript and launcher suites are green or any baseline-only failure is proven separately, and the live smoke matrix confirms that requests above the old 240K effective Bigger budget complete without any individual physical message exceeding the measured browser boundaries.
