# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Preview releases and updater visibility

Use GitHub's **Set as a pre-release** flag for public test builds. They remain downloadable from
Releases but are excluded from `/releases/latest`, the endpoint used by both existing launchers
and the installer. A draft is private; a pre-release is the public testing option. No separate
launcher update channel or custom release-body flag is required.

After validation, uncheck **Set as a pre-release** and select **Set as latest release**, or publish
a newer stable release. Launchers discover it on their next startup update check, provided its
version is newer and its platform asset and checksums are present. Already running launchers
do not poll for publication changes.

The tag workflow marks new suffixed versions such as `v6.0.0-rc.1` as pre-releases automatically
and preserves an existing release's pre-release flag when rerun.
Use a new version for changed binaries; toggling publication flags promotes the existing build.
Do not publish a stable tag and only mark it as a pre-release afterwards: an older launcher could
offer it during that interval. To keep a final version out of the updater during testing,
prepare a draft release with **Set as a pre-release** checked before pushing its tag.
The workflow publishes it with that flag preserved.

GitHub documents this contract in [Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or prompt contents.

## Windows 11 gate

Run this list on a maintained Windows 11 x64 machine with a real ChatGPT account:

1. Install the packaged launcher on a clean profile and prove that the embedded Bun runtime starts.
2. Sign in inside the embedded browser and prove that Temporary Chat reaches a usable composer.
3. Install the Codex model route, restart Codex, and prove that every account-available ChatGPT Web
   effort appears exactly once without removing native models.
4. Complete one Browser-only turn and verify streamed commentary plus the final answer.
5. Configure the `Codex Native2` connector, run **Verify runtime**, and complete one Full-mode local
   tool turn. Repeat with Pro when the account exposes Pro.
6. Drive a chat past the compaction threshold and prove that it continues after compaction without
   a duplicate or orphaned browser turn.
7. On a clean install, prove that setup offers both interaction modes and defaults to With
   Automation. Select Zero Risk and prove that Codex shows exactly one generic Web model after
   restart, a retained chat receives only the next prompt, and
   compaction completes through MCP before the compacted continuation opens a fresh manual chat.
   Inspect the copied prompt and prove that it contains only the current `request_id`, never a
   surface nonce, capability token, or prompt-level lifecycle commands.
   Switch back to Automatic and prove that the account-visible catalog is restored.
8. Cancel a running turn by closing its launcher tab, then cancel another with the launcher action;
   prove that neither turn recreates a tab or keeps the runtime busy.
9. Quit the launcher during an active turn, confirm the explicit cancellation path, reopen it, and
   prove that the saved ChatGPT session and Codex route are still valid.
10. Prove Codex Voice can create a WebRTC call while Responses use the local bridge. Disconnect the
   bridge and prove that both exact previous route assignments are restored; reconnect it and prove
   that the existing private MCP credentials are reused rather than replaced.
11. Upgrade from the previous public release and prove that launcher state, browser state, Codex
    settings, and MCP configuration survive the updater transaction.
12. With saved chats enabled, leave one task idle for at least two minutes between turns, including
    one turn that generates images, then send a follow-up. Prove that:
    - the follow-up reuses the retained chat;
    - the exported Activity log has one `retained_tab_frames` line for that reused turn;
    - effort selection never fails with `locator.click: Timeout`.

    Record the logged outcome (`painting`, `repainted`, `reloaded` or `stalled`).

Any failed or unexecuted item blocks a stable release. An alpha may ship with a named failed item
only when the release notes describe the limitation and recovery path explicitly.

### v3.0.0 result

Maintainer validation passed on Windows 11 x64 on 2026-08-22 using the published v3.0.0-alpha
upgrade package and a real ChatGPT Pro account. The authenticated launcher, Codex model catalog,
Full-mode MCP tools, Pro turns, compaction, cancellation, session reuse, and preserved connector
configuration were exercised successfully. The direct installer completed successfully but gave no
clear completion action; v3.0.0 changes it to an assisted installer with a final launch option.

### Oversized request bodies (issues #66, #70, #71)

These checks need an authenticated ChatGPT session, so no automated test proves them. They are
not part of the numbered gate above; run them before relying on the oversized-request behavior,
and record the outcome of each one. As of #71 none has been run.

Use a real image-heavy thread: about 120 MiB of base64 `view_image` / `image_gen` tool output,
never compacted, so the zstd request body sits near or above the 64 MiB encoded limit.

1. **Recovery.** Run `/compact` on the thread. Prove that it succeeds through `/v1/responses/compact`,
   and that on a second copy the v2 `compaction_trigger` on `/v1/responses` succeeds too. Then send
   one more turn and read the `request_body_size` line in the exported log: its `encodedBytes` must
   be under 64 MiB.
2. **Actionable message.** Reproduce a rejected follow-up (for example by lowering the limit on a
   development build) and prove that the Codex UI shows the "Run /compact ... or start a new task"
   message, not a bare transport error.
3. **Prompt attribution.** In the same run, prove that the ChatGPT turn ends at once with
   `codex_request_rejected` rather than after 90 s with `codex_tool_timeout`.
4. **Turn metadata header.** Prove that Codex sends `x-codex-turn-metadata` as an HTTP header on the
   ChatGPT-auth path, not only with a custom provider (observed on `codex-cli 0.164.0`). Without the
   header, a body rejected at the read ceiling cannot be attributed.
5. **Byte-pressure compaction.** Let the thread grow until a `compaction_pressure` line is logged and
   prove that Codex auto-compacts in the middle of the turn and the turn continues.
6. **Refused compaction on Luna.** With Luna and without Bigger Context, force Codex to auto-compact
   while a tool call is pending. Prove that the turn ends at once with `codex_compaction_unavailable`.
   This assumes Codex fails the turn on the 409; if it continues instead, revert that attribution.
7. **Compaction repetition.** Across a real thread, count `compaction_pressure` lines with
   `afterCompaction: true`. Repeated lines mean a compaction did not shrink the history enough and a
   guard is needed; none means the item can be closed.
8. **Broker endpoint on POSIX.** `resolveBrokerEndpoint(config.brokerSocketPath) === config.brokerSocketPath`
   is now asserted by `tests/runtime-layout.test.ts` on the Linux and macOS CI jobs. Confirm the CI run
   was green on both.

## macOS gate

Repeat items 2 through 10 and item 12 on the oldest supported macOS version or the closest maintained machine.
Packaging smoke and code-signing verification remain separate gates; neither substitutes for the
interactive account flow.

## Linux gate

CI packaging smoke is required. Before claiming interactive Linux support for a release, repeat
items 2 through 7 under a supported desktop session and record the display server and packaging
format used.
