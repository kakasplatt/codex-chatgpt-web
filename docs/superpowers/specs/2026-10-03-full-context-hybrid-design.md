# Full Context Hybrid Design

## Context

The current ChatGPT Web adapter exposes two different limits as if they were one concept.

For ordinary automatic Sol-backed routes, the bridge uses measured ChatGPT Web transport budgets. On Plus Medium/High, the base model row advertises a 90,000-token context window with an 80,000-token auto-compaction threshold. Enabling Bigger Context multiplies both by three, so Codex sees a 270,000-token nominal window and compacts at 240,000 tokens.

The underlying recent GPT models used by the project support a 1,050,000-token model context, and native Codex already accepts a `model_context_window` override of that size. The Web route intentionally ignores that native override because the browser composer, server request envelope, and per-message token budgets are separate product limits. Raising the Web row to 1,050,000 without changing transport would therefore allow Codex to prepare requests that the browser cannot submit.

The repository already contains two complementary mechanisms that can solve different parts of this problem:

- Bigger Context stages one logical Codex request across multiple ChatGPT messages while preserving record order and validating each stage against the measured browser limits.
- Luna rolling checkpoints preserve an exact-parent semantic summary so a later turn can continue without replaying the full canonical history.
- retained ChatGPT conversations already avoid replaying completed history during normal Sol-backed turns by sending only the suffix after the last assistant reply.
- retained compaction handoff already prefers summarizing inside the retained conversation and falls back to fresh canonical compaction when that conversation is unavailable.

The missing piece is a mode that composes these mechanisms around one explicit distinction: Codex owns the logical context budget; the adapter owns the physical browser transport budget.

## Goals

1. Add an experimental Full Context mode for automatic Sol-backed ChatGPT Web routes.
2. Advertise a 1,050,000-token logical model context to Codex while using a 900,000-token auto-compaction threshold.
3. Keep every browser message within the already measured account- and effort-specific token and character limits.
4. Use the existing retained ChatGPT conversation as the primary continuity mechanism so completed history remains available to the model without being resent on every Codex turn.
5. Expand multipart staging so a fresh browser conversation can receive a large canonical Codex request without pretending one browser message can carry it.
6. Capture a private rolling checkpoint once a Full Context thread becomes large, and use that checkpoint only as a recovery path when the retained browser conversation cannot be reused.
7. Preserve the full canonical Codex history as the source of truth. Checkpoints may optimize recovery but must never replace canonical history for accounting, native compaction, branching, or correctness decisions.
8. Preserve existing Bigger Context, Luna, Zero Risk, cancellation, accepted-submission, retained-compaction, and tool-loop behavior unless this design explicitly changes it.
9. Fail before browser submission when a request cannot be represented within both the 1,050,000-token logical window and the measured physical transport envelopes.
10. Make the feature independently disableable so rollback restores current behavior without migrating user task state.

## Non-goals

- Do not make the browser accept a single 1,050,000-token message.
- Do not apply top-level native `model_context_window` overrides directly to ChatGPT Web model rows.
- Do not change the measured Instant, Medium/High, Pro, or Luna per-message browser limits as part of this work.
- Do not change Luna's 1,050,000-token logical window or its 28,000-token browser input budget.
- Do not make semantic checkpoints the normal source of history while a retained browser conversation is available.
- Do not automatically migrate existing Bigger Context users to Full Context in the first implementation.
- Do not remove Bigger Context in the first implementation; it remains available as the lower-risk 3x mode during Full Context validation.
- Do not enable Full Context in Zero Risk/manual mode.
- Do not introduce automatic retries that can resend an already accepted multipart stage or final task submission.
- Do not solve oversized single-record inputs by silently truncating, splitting JSON records, or dropping attachments.

## Design Principles

### Logical context and physical transport are separate contracts

Full Context exposes this logical budget to Codex:

```text
logical model context:          1,050,000 tokens
logical auto-compaction limit:    900,000 tokens
effective context percentage:          ~86%
```

The browser transport continues to use measured limits for each visible message. Those limits vary by account and selected effort and remain authoritative for submission.

No formula may derive a browser message limit from the 1,050,000-token model window.

### Retained conversation is the full-fidelity fast path

When the launcher can reuse the retained ChatGPT conversation for the same Codex thread, model family, effort, and compaction epoch, the adapter sends only the current suffix through `prepareResume`.

The previous staged context and assistant responses remain in the ChatGPT conversation, so the model can use the accumulated conversation directly. Full Context does not replace that history with a checkpoint on the normal retained path.

### Checkpoints are recovery state, not canonical state

When a retained conversation is unavailable, the adapter may replace completed prior history with an exact-parent private checkpoint and send the current turn in a fresh browser conversation.

This is a recovery optimization. The original Codex request remains canonical and continues to drive:

- logical token usage reported to Codex;
- the 900,000-token auto-compaction boundary;
- native compaction input;
- branch/revision identity;
- fallback reconstruction when no checkpoint is valid.

### Recovery must fail open to canonical history

A missing, stale, malformed, or mismatched Full Context checkpoint must not fail the user-facing turn. The adapter falls back to the canonical Codex request and uses multipart transport if necessary.

The only checkpoint failures that are terminal are invariant violations that prove the adapter changed the active native user revision or associated a checkpoint with the wrong exact parent.

### Submission acceptance remains the replay boundary

Existing protected-send semantics remain authoritative. Once a multipart stage or final task submission has semantic acceptance evidence, observation or acknowledgement failure must never cause the bridge to physically resend that accepted payload.

Full Context may add more stages, so this invariant becomes more important rather than less.

## Feature Surface

### New experimental setting

Add `experimentalFullContext: boolean` alongside the existing `experimentalBiggerContext` setting for the first release.

The two modes are mutually exclusive:

```text
standard: Bigger=false, Full=false
bigger:   Bigger=true,  Full=false
full:     Bigger=false, Full=true
```

Configuration with both flags enabled is invalid at runtime. The launcher should prevent that state by disabling the other mode when the user enables one.

Keeping the flags separate during the experimental period provides a direct rollback path and avoids silently changing the behavior of installations that currently rely on Bigger Context's 3x contract.

### Supported routes

Full Context is available only when all of these are true:

- browser interaction mode is automatic;
- the account exposes a Sol-backed automatic route;
- the selected Web route belongs to a model family whose adapter contract is explicitly marked as supporting the 1,050,000-token context profile;
- the request is a normal automatic ChatGPT Web request, not Zero Risk/manual.

Luna keeps its existing dedicated rolling-checkpoint path. Full Context must not route Luna through Sol multipart logic.

### Launcher copy

The launcher should describe Full Context as a logical-context feature with staged browser transport, not as a claim that the composer accepts 1.05M tokens in one message.

The warning should state that large fresh turns may require several staged messages and may increase rate limits or temporary cooldowns.

## Context Limit Model

Add explicit constants for the logical Full Context profile:

```ts
CHATGPT_WEB_FULL_CONTEXT_WINDOW = 1_050_000;
CHATGPT_WEB_FULL_CONTEXT_AUTO_COMPACT_TOKEN_LIMIT = 900_000;
```

When Full Context is enabled for a supported automatic route, `resolveChatGptWebContextLimits()` returns those logical values instead of the base or Bigger Context values.

The existing measured transport resolvers remain unchanged:

```text
resolveChatGptWebContextLimits()     -> logical Codex/model budget
resolveChatGptWebTransportLimits()   -> physical browser message limits
resolveChatGptWebMessageTokenBudget()-> physical per-message token budget
```

This separation must be visible in names, comments, tests, and error messages.

The model catalog should advertise:

```text
context_window                 = 1,050,000
max_context_window             = 1,050,000
auto_compact_token_limit       =   900,000
effective_context_window_percent ~= 86
```

The top-level native Codex context override remains applicable only to native model rows. Full Context owns the Web route values explicitly.

## Adaptive Multipart Transport

### Current limitation

The current Bigger Context contract accepts exactly two or six parts and caps total context at:

```ts
baseContextWindow * min(partCount, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER)
```

That formula intentionally prevents multipart from enlarging the advertised window beyond 3x. Full Context needs a different planner rather than changing the Bigger Context multiplier.

### Full Context planner

Introduce a separate `resolveFullContextMultipartPlan()` that selects the smallest safe number of parts required for the physical request.

The initial Full Context implementation supports between 2 and 12 parts. Twelve parts are sufficient to stage requests near the 900,000-token auto-compaction threshold when Plus staging can use the measured Medium budget, while keeping a bounded maximum number of browser submissions.

The planner must consider, for every candidate part count:

- actual tokenizer-derived message tokens;
- browser character ceilings;
- whole-record preservation;
- final-message execution instructions;
- output schema text;
- image and skill attachment reserves;
- the wider account-visible staging effort already used by adaptive Bigger Context;
- the selected execution effort for the final task message;
- platform reserve tokens;
- acknowledgement wrapper overhead.

The planner chooses the lowest part count that fits all physical constraints. If no plan through 12 parts fits, the request fails before any stage is submitted with an error that identifies the limiting physical boundary.

### Record integrity

Full Context keeps the current multipart invariant: one Codex message/JSON record is atomic for transport partitioning.

The bridge must never split one record across browser messages. If a single record cannot fit any allowed staging message, the adapter fails before submission and tells the user which per-message limit was exceeded.

### Logical-window preflight

After physical partitioning succeeds, the complete canonical input must still be below the 1,050,000-token logical context window.

Multipart part count does not multiply the logical window. The Full Context preflight is:

```text
canonical estimated input < 1,050,000
AND
every staged/final browser message fits its measured transport limits
```

### Compaction turns

Native structured compaction keeps its existing priority order:

1. use the retained conversation handoff when an exact retained source exists;
2. otherwise run fresh compaction from canonical Codex history.

When Full Context fresh compaction requires multipart, it uses the Full Context planner rather than the fixed six-part Bigger Context planner.

Full Context recovery checkpoints are not used as compaction input. Native compaction must summarize the canonical context or the retained browser conversation that represents it.

## Full Context Recovery Checkpoints

### Relationship to Luna checkpoints

Reuse the proven exact-parent semantics from `rolling-checkpoint.ts`, but do not make Full Context depend on Luna-specific names or limits.

Extract a small generic private-checkpoint core responsible for:

- marker-safe response streaming;
- strict checkpoint parsing and token limits;
- exact-parent answer hashing;
- thread and source-turn binding;
- current-turn boundary extraction;
- current native user-revision preservation;
- TTL and bounded persisted storage.

Keep Luna as a policy wrapper around that core with its existing marker, 4,000-token limit, text, and behavior. Parity tests must pass before Full Context begins using the generic core.

### Full Context checkpoint policy

Full Context uses a distinct private marker and a larger semantic budget:

```text
maximum checkpoint size: 16,000 tokens
```

The larger budget is intentional: Full Context recovery may represent substantially more code, tool evidence, decisions, paths, and pending work than Luna's constrained browser transport.

The checkpoint remains plain assistant-owned state after the user-facing answer. It must preserve concrete requirements, paths, commands, observed results, architectural decisions, unresolved failures, and the next useful actions.

### When checkpoint capture starts

Small Full Context threads should not pay checkpoint overhead.

Capture is activated when either condition is true:

- the canonical normal-turn request requires multipart transport in Full Context mode; or
- the exact parent already has a valid Full Context checkpoint, meaning the thread has entered checkpoint-capable recovery state.

Once a checkpoint chain exists, each subsequent successfully completed normal turn captures the next checkpoint so recovery remains current.

### Retained conversation selection

For a normal Full Context turn, prepare three logical inputs:

```text
canonicalInput  = complete Codex request
resumeInput     = suffix after last assistant reply, for retained conversation reuse
recoveryInput   = exact-parent checkpoint + current native turn, when a valid checkpoint exists
```

The launcher/browser selection determines which physical input is used:

1. If the retained conversation is reused, send `resumeInput`. Do not replace history with the checkpoint.
2. If the launcher starts a fresh conversation and `recoveryInput` is valid, send `recoveryInput`.
3. If no valid checkpoint exists, send `canonicalInput`, using Full Context multipart when required.

The conversation key remains derived from canonical thread/model/effort/compaction identity. A fresh recovery turn may therefore become the new retained conversation for the same logical key after successful completion.

### Checkpoint failure behavior

Checkpoint capture is optional from the user's perspective. If the model completes a valid visible answer without a checkpoint marker, the answer succeeds, a warning is logged, and the next fresh turn falls back to canonical history.

Malformed checkpoints are discarded unless they reveal an invariant violation. They must never corrupt the canonical request or overwrite a previously valid exact-parent mapping.

## Usage Accounting

Full Context must report logical canonical usage to Codex, not the physical size of `resumeInput` or `recoveryInput`.

This is required so Codex reaches native compaction around 900,000 tokens even when the browser is efficiently receiving only a small suffix.

Therefore:

```text
Codex usage accounting -> canonicalInput
browser preflight       -> selected physical input
retained resume         -> resumeInput
recovery fallback       -> recoveryInput when valid, otherwise canonicalInput
```

This differs intentionally from Luna's current accounting behavior, where the bounded checkpoint payload is the meaningful active browser usage.

## Turn Lifecycle

### Normal retained turn

```text
Codex canonical request
        |
        +--> logical usage accounting (1.05M / 900K contract)
        |
        +--> conversation key matches retained browser chat
                  |
                  +--> compile suffix-only resumeInput
                  +--> browser transport preflight
                  +--> submit current turn
                  +--> optionally capture Full Context checkpoint
                  +--> retain conversation
```

### Fresh turn with recovery checkpoint

```text
Codex canonical request
        |
        +--> exact-parent checkpoint found
        +--> retained conversation unavailable
                  |
                  +--> checkpoint + current native turn
                  +--> inline or adaptive multipart transport
                  +--> execute task
                  +--> capture replacement checkpoint
                  +--> retain new browser conversation
```

### Fresh turn without recovery checkpoint

```text
Codex canonical request
        |
        +--> no retained conversation
        +--> no valid exact-parent checkpoint
                  |
                  +--> adaptive Full Context multipart of canonical request
                  +--> execute task
                  +--> capture checkpoint when multipart was needed
                  +--> retain new browser conversation
```

### Native compaction

```text
Codex reaches ~900K
        |
        +--> retained source exists -> structured retained handoff
        |
        +--> retained source absent -> fresh canonical Full Context multipart compaction
        |
        +--> new compaction epoch -> new conversation identity
```

## Error Handling

### Pre-submit errors

Fail before browser activation for:

- canonical input at or above the 1,050,000-token logical window;
- no multipart plan through 12 parts;
- one atomic record exceeding every available stage transport boundary;
- final task message exceeding its selected execution-mode message limit;
- invalid mutually exclusive Full/Bigger configuration;
- Full Context requested in Zero Risk/manual mode.

These failures are non-retryable until the input, mode, or configuration changes.

### Accepted multipart stage failures

Preserve the current accepted-stage state machine. Once a stage has semantic submission acceptance, no generic timeout, DOM error, acknowledgement failure, cancellation race, or upstream error may submit that same stage again.

Adaptive effort promotion remains allowed only for a stage that was rejected before acceptance with the specific measured message-length failure that current Bigger Context already handles.

### Retained conversation loss

Retained conversation unavailability is a routing event, not a task failure:

- use exact-parent recovery checkpoint when available;
- otherwise reconstruct canonical input with Full Context multipart.

### Checkpoint mismatch

Branching, repeated answer text from a different turn, stale checkpoint files, or a different source-turn ID invalidate the checkpoint. The adapter uses canonical history instead.

## Persistence and Migration

### Configuration

Add `experimentalFullContext` with default `false` to runtime config, launcher state, IPC/control messages, and renderer types.

Existing `experimentalBiggerContext` values are preserved unchanged.

The config loader rejects `experimentalBiggerContext=true` together with `experimentalFullContext=true`. Launcher mutation logic makes enabling one mode atomically disable the other before runtime restart.

### Checkpoint storage

Use a separate persisted file for Full Context checkpoints, for example:

```text
runtime/full-context-checkpoints.json
```

Do not mix Full Context entries into the existing Luna checkpoint file. Both may reuse the same generic storage implementation while retaining independent schema/version identity.

## Expected File Boundaries

The implementation should keep responsibilities separated approximately as follows:

- `src/chatgpt-web-models.ts`
  - logical Full Context constants and model-row limit resolution;
  - measured browser transport limits remain here unchanged.
- `src/adapters/chatgpt-web/usage.ts`
  - Full Context multipart planning and logical usage estimation.
- `src/adapters/chatgpt-web/prompt.ts`
  - generalized bounded multipart part count and Full Context private checkpoint contract.
- `src/adapters/chatgpt-web/browser-worker.ts`
  - physical per-message preflight, stage selection, accepted-stage lifecycle, and generic private-checkpoint stream handling.
- `src/adapters/chatgpt-web/rolling-checkpoint.ts`
  - Luna policy kept behaviorally stable; generic logic may be extracted from here.
- `src/adapters/chatgpt-web/private-checkpoint.ts` or equivalent new focused module
  - reusable exact-parent checkpoint stream/store core.
- `src/adapters/chatgpt-web/full-context-checkpoint.ts` or equivalent new focused module
  - Full Context marker, 16K policy, recovery text, and persisted-store wrapper.
- `src/adapters/chatgpt-web/index.ts`
  - canonical/resume/recovery input selection, usage-accounting separation, checkpoint capture policy, and retained-conversation integration.
- `src/config.ts`
  - Full Context runtime setting, validation, state path, and provider wiring.
- `launcher/electron/*`, `launcher/src/*`
  - persisted setting, mutually exclusive toggle behavior, restart operation, renderer types, and localized copy.
- `docs/architecture.md`
  - logical-versus-transport contract and recovery behavior.

This boundary may be refined during implementation, but the checkpoint core should not be absorbed into `index.ts` or `browser-worker.ts`; both files are already large lifecycle coordinators.

## Testing Strategy

### Model catalog and limit contracts

Add tests proving:

- Full Context model rows advertise exactly 1,050,000 context tokens;
- Full Context auto-compacts at exactly 900,000 tokens;
- effective percentage is derived from those values;
- native `model_context_window` behavior remains native-only;
- Bigger Context keeps its current 3x values;
- Standard, Bigger, Full, Luna, and Zero Risk remain distinguishable.

### Multipart planner

Add table-driven tests for Plus and Pro that prove:

- small requests stay inline;
- the planner chooses the smallest fitting part count;
- requests requiring more than six but no more than twelve parts succeed;
- attachments and output schemas reduce final-message capacity correctly;
- whole-record ordering is byte-for-byte preserved;
- a single oversized record fails before submission;
- canonical input at or above 1,050,000 fails regardless of available part count;
- part count never multiplies the 1,050,000 logical ceiling.

### Checkpoint core parity

Before Full Context uses the extracted generic checkpoint core, existing Luna tests must continue proving:

- marker isolation from visible answer text;
- exact-parent hash matching;
- source-turn binding;
- current-turn preservation;
- branch rejection;
- route/model preservation;
- TTL and bounded persisted storage;
- missing optional checkpoint does not fail the visible answer.

### Full Context recovery

Add focused tests proving:

- retained reuse selects canonical suffix and does not substitute a checkpoint;
- fresh conversation with an exact-parent checkpoint selects recovery input;
- fresh conversation without checkpoint selects canonical input;
- recovery input preserves the current native user revision exactly;
- stale/repeated-parent checkpoint falls back to canonical history;
- a missing checkpoint tail after a successful answer keeps the answer successful;
- once a checkpoint chain exists, the next completed turn refreshes it;
- successful recovery can become the new retained conversation for the canonical conversation key.

### Usage and compaction

Add tests proving:

- Codex usage reports canonical logical history even when the browser receives only a resume suffix;
- Codex usage reports canonical logical history even when fresh recovery uses a checkpoint;
- around 900,000 tokens, native compaction is requested before the 1,050,000 hard ceiling;
- retained compaction still uses the structured handoff first;
- missing retained compaction source uses fresh canonical Full Context multipart;
- recovery checkpoints are not substituted into native compaction input.

### Submission safety

Extend browser-worker/harness coverage for larger part counts and prove:

- accepted stages are never resent;
- pre-acceptance message-length rejection may promote staging effort only within the existing bounded policy;
- cancellation wins over later message-length evidence;
- post-acceptance acknowledgement/DOM failure does not replay the stage;
- final-task acceptance follows the same no-resend rule.

### Launcher/configuration

Add launcher and runtime tests proving:

- Full Context defaults off;
- Full and Bigger cannot be simultaneously active;
- enabling Full disables Bigger atomically and vice versa;
- Zero Risk disables Full Context;
- changing Full Context triggers the same required runtime/Codex restart behavior as the existing context setting;
- localized labels and descriptions render through the existing i18n contract.

## Live Verification

Automated tests establish state-machine correctness, but this feature also changes an empirically measured browser transport path. Before release, run live smoke scenarios with browser diagnostics enabled.

Required scenarios:

1. A request below the ordinary Medium/High threshold remains a one-message turn.
2. A request around 200K uses multipart and completes normally.
3. A request above the current Bigger Context ceiling, such as approximately 350K-500K, stages successfully and returns the requested result.
4. A request approaching the Full Context operating range, such as approximately 800K-850K canonical tokens, stays below the 900K compaction threshold and completes without any individual browser message exceeding measured limits.
5. A second turn on the same retained conversation sends only the suffix while logical Codex usage continues to reflect canonical history.
6. After deliberately releasing the retained browser conversation, the next turn uses the exact-parent recovery checkpoint and then establishes a new retained conversation.
7. After removing or invalidating that checkpoint as well, the next turn reconstructs canonical history through multipart without losing record order.
8. A task crossing the approximately 900K threshold triggers native compaction rather than an adapter context error.
9. Cancellation after an accepted multipart stage does not resend the accepted stage.

Record stage count, selected staging effort, per-stage token/character estimates, acceptance evidence, retained/recovery selection, and final logical usage for each smoke run.

## Rollout

Full Context remains experimental and disabled by default.

Initial rollout keeps Standard and Bigger Context available. This provides three useful comparison modes:

```text
Standard       -> measured one-message model profile
Bigger Context -> existing 3x profile with 2/6-part staging
Full Context   -> 1.05M logical profile with adaptive staging + retained continuity + checkpoint recovery
```

After live verification demonstrates that Full Context is stable across the intended account modes, a later cleanup may deprecate Bigger Context and replace the two booleans with one explicit context-mode setting. That cleanup is outside this first implementation.

## Success Criteria

The feature is complete when all of the following are true:

1. Codex displays approximately 1.05M context and a 900K auto-compaction boundary for supported Full Context Web routes.
2. Requests larger than the existing 240K effective Bigger Context budget can complete through ChatGPT Web without violating a measured per-message browser limit.
3. Ordinary retained turns preserve full-fidelity conversation continuity and send only the new suffix.
4. Loss of the retained conversation can recover from an exact-parent checkpoint without corrupting the canonical Codex history.
5. Absence or invalidity of a checkpoint falls back to canonical multipart reconstruction.
6. Logical usage accounting remains based on canonical history so native compaction still occurs around 900K.
7. No accepted multipart stage or final submission is physically replayed by the new path.
8. Luna, Bigger Context, Standard mode, Zero Risk, tool rounds, and retained structured compaction retain their existing tested behavior.
9. Focused tests, the full root test suite, launcher tests, both typechecks, and diff checks pass, with any baseline/environmental failure reported separately.
10. Live smoke evidence covers inline, >240K multipart, high-context retained continuation, checkpoint recovery, canonical fallback, compaction, and cancellation.

