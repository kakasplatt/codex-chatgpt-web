# Durable ChatGPT Conversation Resume Design

## Context

The ChatGPT Web adapter already derives a stable `conversationKey` from the native Codex thread, model, reasoning configuration, model family, and compaction epoch. While the Launcher stays alive, `BrowserHost` can retain a completed browser tab under that key and later return `reused: true`, which makes the worker send only `prepareResume()`'s suffix instead of replaying the full Codex history.

That continuity is currently process-local. Closing or restarting the Launcher loses `turnTabs`, so a later Codex `/resume` cannot find the physical ChatGPT conversation even though the native Codex thread identity is still available. The Electron partition preserves authentication/session storage, but it does not preserve the logical `conversationKey -> https://chatgpt.com/c/<id>` association.

## Goals

1. Persist the physical saved ChatGPT conversation URL associated with an automatic retained `conversationKey`.
2. When a resumed Codex thread reaches the Launcher and no matching in-memory tab exists, open a new tab directly on the persisted ChatGPT conversation and return `reused: true`.
3. Preserve the existing `prepareResume()` behavior for a successfully restored conversation.
4. If a persisted conversation cannot be reopened during an ordinary turn, remove the stale association and safely fall back to a fresh ChatGPT conversation with the canonical/full prompt.
5. If the caller explicitly requires the retained conversation, fail with the existing `retained_conversation_unavailable` contract instead of sending an incremental prompt to a fresh conversation.
6. Keep Zero Risk/manual behavior unchanged.
7. Keep persisted state private to the Launcher profile and avoid logging the conversation URL or UUID.

Cross-process restoration requires ChatGPT **Saved Chats**. Temporary Chat stays intentionally process-local: its direct URL is not treated as durable state, so a Launcher restart cannot promise to reopen it without changing the user's privacy setting.

## Non-goals

- Do not change the `conversationKey` algorithm or native Codex `/resume` parsing.
- Do not persist prompt text, responses, cookies, or tool data in the new state file.
- Do not make temporary ChatGPT conversations durable. Only canonical non-temporary `https://chatgpt.com/c/<id>` URLs are eligible.
- Do not change Full Context, Bigger Context, Luna, or compaction prompt construction.
- Do not restore Zero Risk/manual tabs automatically because that mode intentionally requires human-controlled browser interaction.

## Design

### Durable store

Add a Launcher-local `RetainedConversationStore` backed by `retained-conversations.json` under the profile-specific Electron `userData` directory. The store is written with the existing private atomic-file helper.

Each entry contains only:

```text
conversationKey -> canonical ChatGPT conversation URL, connector identity, updatedAt
```

The store accepts only 64-character lowercase hexadecimal conversation keys and canonical ChatGPT saved-conversation URLs. Query strings and fragments are removed from saved URLs. URLs carrying `temporary-chat=true` are rejected. Connector identity remains part of the lookup contract so one connector cannot silently inherit another connector's retained history.

The store keeps the most recently updated 256 entries. There is no time-based expiry: `/resume` continuity should survive long gaps. Invalid or malformed persisted entries are ignored rather than preventing Launcher startup. Mutations are transactional with respect to the in-memory map: if the atomic file write fails, the previous in-memory state remains authoritative and the operation fails visibly.

### Capture

When an automatic turn completes successfully and qualifies for existing in-memory retention, `BrowserHost.endTurn()` canonicalizes the tab's current URL. A durable `/c/<id>` URL is written to the store and remembered on the tab. If the final page is no longer a durable conversation URL, any stale durable entry for that key is removed while the existing process-local retention rules remain unchanged.

### Restore

`BrowserHost.beginTurn()` keeps the current priority order:

1. reuse the exact matching in-memory retained tab;
2. if none exists, look up the durable store by `conversationKey` and connector identity;
3. if a durable entry exists, create a new automatic turn tab whose initial document is the persisted ChatGPT conversation URL, mark the connector as already bound, and return `reused: true`;
4. if no durable entry exists, create the normal fresh tab and return `reused: false`.

The worker therefore needs no new resume-prompt protocol. `reused: true` already selects `prepareResume()`, while `reused: false` already selects the canonical/full preparation path.

### Restore failure

If the persisted URL cannot be committed, the failed tab is discarded and the durable entry is deleted. For an ordinary resumed turn, the Launcher then allocates a normal fresh tab and returns `reused: false`, causing the worker to resend full canonical context and establish a replacement ChatGPT conversation. For `requireRetainedConversation=true`, the Launcher returns the existing typed unavailable error and does not allocate a replacement.

### Release and settings changes

Releasing a retained conversation removes both its ready in-memory tab and its durable store entry. Durable deletion happens first; if it cannot be persisted, the release fails and the ready tab remains available rather than reporting success with a stale record on disk. Changing retention-affecting settings (`experimentalFreshConversationPerTurn` or `useSavedChats`) clears durable retained-conversation state after the setting change commits, matching the existing behavior that retires completed in-memory history.

### Concurrency and safety

The Launcher remains the single owner of this file and uses atomic replacement on every mutation. Existing browser-tab concurrency limits and connector checks remain authoritative. The new store does not contain authentication material and its URL/UUID is intentionally omitted from logs; navigation diagnostics retain only non-sensitive error metadata and the URL origin.

## Verification

The implementation must prove the store survives reload, rejects temporary/foreign URLs, restores a persisted conversation as `reused: true`, falls back to a fresh full-context turn after stale restore failure, preserves fail-closed required-retention behavior, persists the final canonical URL on successful retention, deletes durable state on release/settings changes, and passes the full root and Launcher verification suites.
