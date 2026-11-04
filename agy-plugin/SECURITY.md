# Security

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/hyprh/self-starter/security/advisories/new). If private reporting is unavailable, open an issue asking for a private contact without posting exploit details or credentials. Security fixes target the latest Self-Starter release; Google Antigravity support starts with v0.0.7.

Probe programs run as the current user by default. They can read files, run commands and use the network; write them to observe conditions only. An API-only probe can use `probe.access: sandbox` to restrict Deno to its declared network hosts and environment variables. Treat probe results as untrusted data, never instructions.

Background Antigravity actions run in dedicated `agy` CLI sessions (`agy --print`) and enforce `action.sandbox` through the plugin's `PreToolUse` guard hook (`bin/guard.mjs`): `read-only` blocks writes, commands and external MCP tools; `workspace-write` permits file edits strictly inside `target.cwd` (excluding `.git`, `.agents` and `.gemini`) while blocking shell commands; `danger-full-access` permits all tools. These are **hook-enforced tool policies, not operating-system isolation**. Authorize the task and its side effects before activation. A notification-only action does not invoke a model.

This integration creates dedicated CLI result sessions (`agy --conversation <id>`). It does not inject messages into open Antigravity desktop or IDE windows. A fire handling turn cannot create or change triggers, including after it reports its result; it may only tune the firing trigger to be quieter.

Credentials belong in the user's terminal configuration or Self-Starter's secret store, never in chat, probe source or trigger parameters. Stored local secrets are readable by the same operating-system user and are not encrypted at rest. Install only trusted code: plugin launchers, probes and background actions run on the user's machine.
