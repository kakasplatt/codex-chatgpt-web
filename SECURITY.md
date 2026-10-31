# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
Codex prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon binds only to loopback. If another local user can access your account or application
home, treat the browser session and tunnel key as compromised and rotate them.

Read the complete [security model](docs/security-model.md) before enabling full mode. In particular,
full mode lets an untrusted model response request tools from the current Codex turn; keep connector
action control, Codex sandboxing, and approvals aligned with the workspace's risk.

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though
this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP
adapter to patched 2.0.12. `bun audit`, the MCP protocol test, and the compiled-binary smoke test are
release gates; remove the override when the stable SDK itself moves to the patched major.

The launcher audit ignores GHSA-g3hv-75wg-m249 (minimatch globparts DoS, fixed only in 11.0.1).
Every affected minimatch copy (3.x, 5.x, 9.x, 10.x) comes from electron-builder build tooling, which
only evaluates repository-controlled glob patterns. `bun audit --prod` in `launcher/` stays clean.
Overriding to minimatch 11 would break consumers that call it as a function. Remove the ignore when
those dependencies move to minimatch 11 (tracked in #99).

Once the GitHub repository is public, use its private Security Advisory reporting flow. Until that
is enabled, do not publish a proof of concept that exposes credentials or arbitrary local tool
execution; contact the maintainer privately through the GitHub account listed by the repository.
