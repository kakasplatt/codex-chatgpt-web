# DEV chat harness

The repository DEV chat exercises current source code without routing the native Codex app through
that working tree. It is intended for browser, MCP, tool-round, retry, and compaction development
while the normal launcher, its ChatGPT account, and the maintainer's active Codex session remain
usable.

## Prerequisites

- Use the repository-pinned Bun version.
- Install a launcher built from the same working tree.
- Start the isolated launcher with `bun run dev:launcher`.
- It skips the normal marketing onboarding and opens the setup surface directly. Sign in inside the
  window labelled **DEV**. This may be a different ChatGPT account.
- Run its browser smoke test and initialize the DEV profile. Complete MCP setup only when testing
  simulated tool rounds; browser, effort, context-limit, and compaction work in browser-only mode.
  The launcher stores any MCP credentials only in the DEV home and supervises only that isolated
  tunnel. Create the ChatGPT connector as `Codex Native2 DEV`; keep `Codex Native2` unchanged.

Nothing is copied from the normal launcher. The DEV command fails closed if its own launcher,
browser descriptor, credentials, or connector are not ready. It never falls back to the production
profile, another model, a fake browser, or a second connector.

## Run

One browser-only message:

```bash
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat smoke "Reply with exactly: DEV READY"
```

Persistent interactive chat:

```bash
bun run dev:chat compaction-lab
```

After optional Full/MCP setup, the same command also exposes simulated outer tools:

```bash
bun run dev:chat tool-lab "Use a command tool and explain the simulated receipt"
```

The direct DEV tool `mcp__dev_simulator__large_context_payload` accepts the explicit arguments
`segment` (1, 2, or 3) and `target_tokens` (1,000 to 95,000). It returns deterministic, coherent,
inert prose through the real simulated MCP-result path so a live named chat can exercise retention
and automatic compaction without embedding a giant fixture in the user prompt. It is advertised
directly rather than through deferred tool search so the test can prove the requested call happened.

Reusing the same name continues its canonical Responses history. Sequential native messages in the
same compaction epoch lease one Temporary Chat, exactly like production. Every message receives a
new turn-bound MCP token, and all MCP tool rounds for that message remain inside the same ChatGPT
response. On an exact native compaction request, the same Web agent submits the checkpoint through
a one-shot MCP control call in that chat; only then does the surface close and the next epoch open a
new Temporary Chat. The complete named history remains owned by the existing prompt compiler. New
chats use the cheapest account-supported browser mode:
Instant (`light`) when Sol is available, otherwise Luna. Override it with `--model` or `/model`.

Interactive commands:

```text
/status
/fill 30000
/send-fill 12000
/compact
/model high
/reset yes
/help
/exit
```

`/fill N` appends deterministic inert text measured by the production tokenizer. It does not open
ChatGPT. The next message checks the real model-specific auto-compaction threshold and calls the
same `compactRequest` handler when the threshold is crossed. `/compact` forces that handler
immediately. Luna keeps its production rolling-checkpoint contract and therefore rejects the
separate compact command.

`/send-fill N` sends deterministic inert text as the current message through the live browser. Use
it to exercise the one-message composer budget and multi-chunk prompt insertion independently of
history growth. The normal model-specific browser preflight still applies and fails closed above
the measured transport limit.

## Skills as files experiment

**Settings → Skills as files (experimental)** is off by default in both launcher profiles.
It uploads only skills explicitly selected in Codex and identified by native selected-skill
metadata. Skill discovery and reading other skills through tools are unchanged. The CLI setup
flags are `--skill-attachments` and `--inline-skills`; Zero Risk does not support automated uploads.

Each UTF-8 `.txt` attachment contains the original skill envelope, including its path or resource
authority. Its filename uses the skill name and a content digest to distinguish changed versions.
Files are generated in memory, with no persistent file cache. Retained chats send only new context;
a fresh chat reconstructs its attachments from canonical history. Files and images share the
10-attachment limit, and skill content still counts toward context and message token budgets.
An unsupported browser helper or rejected upload produces an error instead of silently omitting
instructions. This remains experimental: moving instructions into attachments does not guarantee
that ChatGPT will follow them more reliably.

## Context Experiments (Bigger Context & Full Context)

Both launcher profiles expose **Full Context (experimental)** and **Bigger Context (experimental)**
in Settings. They are disabled by default and mutually exclusive: enabling one atomically disables
the other. Switching to Zero Risk (manual) mode automatically disables both context experiments and
restores standard limits.

The context preference can also be selected directly during setup or through CLI flags:
- `--full-context`: Enables Full Context (and disables Bigger Context).
- `--bigger-context`: Enables Bigger Context (and disables Full Context).
- `--standard-context`: Disables both experiments, restoring standard context limits.

The switch updates the profile's canonical runtime configuration through the normal setup
transaction; it is not a launcher-only preference. Production setup also rewrites the managed
Codex model catalog with the active context and auto-compaction thresholds and prompts to restart
Codex. The DEV CLI reads the same settings from its isolated runtime configuration on each command.

### Bigger Context (3x Multiplier)

When Bigger Context is enabled, a normal turn stays on the original single-message path while its
estimated input is below the selected mode's existing auto-compaction threshold. At the first
threshold it uses two messages; at twice that threshold it uses six messages. The final context part
also commits the transaction and starts the task, so there is no extra request. The model context
and auto-compaction ceilings are reported as 3× while the switch is active (e.g. 285,000 auto-compact
and 333,579 context window on Plus/Pro), but every individual stage must still fit the selected
ChatGPT mode's measured one-message boundary (~70,000–95,000 tokens).

### Full Context (1.05M Logical Context & Checkpoint Recovery)

Small turns use one request. Two-part turns use one inert staging request and one final request;
six-part turns use five staging requests and one final request. Browser-only compaction also uses
six parts. Inert stages use the fastest available mode that fits their complete messages; the final
part uses the selected execution effort. Plus Instant uploads keep the same input headroom as
ordinary Instant turns; the selected final mode can receive a larger share of the context.
Large turns may increase the probability of
rate limits or a temporary account cooldown. The experiment is intentionally unavailable for Luna:
Luna's later requests still include the accumulated transcript inside the same measured
28,000-token browser transport budget.

Full Context expands the logical context window to 1,050,000 tokens with an auto-compaction
threshold at 900,000 tokens on supported Plus/Pro routes (`chatgpt-web/high`, `chatgpt-web/extra-high`,
`chatgpt-web/deep`, `chatgpt-web/pro`, `chatgpt-web/fast`, `chatgpt-web/light`).

Full Context decouples the logical conversation context from physical browser message limits:
- **Inline Single-Message:** For turns within single-message browser ceilings, requests are sent
  inline in a single physical prompt.
- **Adaptive 2..12 Multipart Staging:** For larger requests, the engine automatically selects the
  smallest safe part count between 2 and 12 stages. Records are kept whole and atomic. Inert stages
  require exact SHA-256 acknowledgements before subsequent stages proceed.
- **Three-Way Input Lifecycle:**
  1. *Retained Suffix (`resumeInput`):* Ongoing turns in an active browser tab send only newly added
     turn records.
  2. *Exact-Parent Recovery Checkpoint (`recoveryInput`):* If the browser tab is lost or closed,
     an exact-parent recovery checkpoint (under 16,000 tokens, marked by
     `CODEXFULLPRIVATECHECKPOINTV1A7F3C9D2`) is loaded to resume in a fresh chat without replaying
     hundreds of thousands of tokens across multiple stages.
  3. *Canonical Fallback (`canonicalInput`):* If the checkpoint is missing or invalid, the engine
     safely falls back to full canonical multipart staging.
- **Canonical Usage Accounting:** Token estimation and usage metrics are always calculated from the
  canonical Codex request history, preventing transport wrappers or checkpoints from skewing usage.
- **Accepted-Stage Idempotency:** Once a multipart stage is accepted by the browser, it is marked
  submitted and will not be physically re-sent if observation is disrupted.

Both experiments are intentionally unavailable for Luna (`chatgpt-web/luna`, `chatgpt-web/think`),
which fails closed and stays pinned to its measured 128,000-token window and 28,000-token rolling
checkpoint transport budget.

Browser-only chats do not advertise outer tools and never claim simulated effects. Full setup keeps
the launcher-owned DEV tunnel ready so ChatGPT can create and validate `Codex Native2 DEV` before a
CLI chat starts. Each named chat attaches its broker to that tunnel, while every dispatched action
still returns an explicit simulation receipt.

The default isolated home is:

```text
~/.codex-chatgpt-web-dev/
├── config.json
├── codex-home/
├── launcher/                 # Electron userData, cookies, login, logs, window state
├── chats/<name>.json
├── runtime/
└── tunnel/
```

Set `CODEX_WEB_GPT_DEV_HOME` to choose another absolute DEV home. Generic `--home`,
`CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`, and `CODEX_WEB_GPT_LAUNCHER_DATA_DIR` never collapse the DEV
launcher into production storage.

## Isolation contract

The DEV driver:

- requires a descriptor explicitly marked `development` and a config explicitly marked
  `dev-harness`;
- uses a separate Electron `userData` directory and a separate persistent browser partition, so
  cookies, OAuth state, local storage, account selection, and launcher state cannot cross profiles;
- uses an isolated sandbox `CODEX_HOME` but never writes a Codex route into it;
- does not call setup, route connect/disconnect, service start/stop, or uninstall;
- does not start `Bun.serve` or bind the configured Responses port;
- rejects any attempt to start the Responses server from a `dev-harness` config;
- does not edit the normal `~/.codex/config.toml` or integration journal;
- leases an isolated DEV-launcher browser tab and runs the working-tree browser helper;
- owns the private DEV broker socket only for the command's lifetime;
- reuses the isolated tunnel supervised by the DEV launcher and never starts a competing alias;
- can run beside the production launcher, Responses port, and tunnel because none of their homes,
  browser partitions, descriptors, broker sockets, profiles, or aliases are shared;
- refuses to run Full-mode tool rounds until the launcher-owned DEV tunnel is ready;
- exposes ordinary structural tools, then returns a universal receipt containing
  `simulated: true` and `side_effects_performed: false` for every dispatched action.

The simulator has no keyword-to-result table and never claims that a command, patch, image read,
user interaction, or external mutation actually happened.
