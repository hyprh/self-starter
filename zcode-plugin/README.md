# Self-Starter for ZCode

Define custom events in plain language. ZCode writes a small TypeScript probe; Self-Starter checks files, logs, commands, local services or APIs without calling a model while it waits. When the condition holds, it runs your task in a dedicated ZCode CLI session, or only sends a notification.

For example: “When this training log says the run finished, compare its results with the previous run” or “Tell me when the GPU has been idle for ten minutes.” The existing trigger engine handles minimum duration, cooldown, event deduplication and expiry.

This first integration supports **dedicated CLI result sessions**. It does not resume or wake the original ZCode desktop conversation. Write each action as a complete task, including the working directory and the context it needs. Results and receipts are available through `self-starter history` and the trigger tools.

## Source installation

Requires macOS or Linux, Node.js 24.14.0 or newer for the current ZCode CLI, and a ZCode CLI already configured and authenticated by the user. This integration has been available since Self-Starter v0.0.4. Use a checkout of the [v0.0.5 tag](https://github.com/hyprh/self-starter/tree/v0.0.5).

From the repository root:

```sh
npm ci
npm run build
node dist/src/cli/main.js install --zcode /absolute/path/to/zcode
node dist/src/cli/main.js doctor
```

The installer copies the plugin into a local marketplace, points its MCP server at this checkout, and configures the background service to use your ZCode executable. Keep the checkout available. Start a new ZCode session after installation. This is a local source installation; the plugin has not been published in ZCode's official catalog.

The installer registers the explicit `marketplace.json` file: adding this repository directory alone would select its Claude Code catalog instead. Use the source installer above to register the ZCode integration.

Use a file that does not exist yet, then ask: “Notify me once when `/tmp/self-starter-zcode-done` appears. Check every minute and stop after an hour. After activation, confirm the first scheduled check found no file.” Once that check is confirmed, create the file in a terminal and inspect `node dist/src/cli/main.js history`. Use a dedicated agent action next when you want ZCode to analyze or change something.

Agent watches initialize a result session once when activated; this calls a model. Scheduled probe checks do not call a model. Keep the CLI's model configuration available to the background service; credentials exported only in an interactive shell may not reach it. Pause a watch before manually continuing its result session.

## Permissions

Probes run as the current user by default and should only observe. API-only probes can use `probe.access: sandbox`, which limits Deno to declared network hosts and environment variables. Store credentials in a terminal with `node dist/src/cli/main.js secret set NAME`, never in chat or probe source.

For agent actions, Self-Starter explicitly selects ZCode's tool permission mode:

| `action.sandbox` | ZCode mode |
|---|---|
| `read-only` | `plan` |
| `workspace-write` (default) | `edit` |
| `danger-full-access` | `yolo` |

These are **tool permission modes, not operating-system isolation**. `plan` restricts ordinary writes and commands; `edit` usually permits workspace file edits; `yolo` skips ordinary permission prompts. Tool-specific checks and hooks can still deny operations. A background session has no user to answer approval prompts. Authorize the intended side effects before activating a trigger, and use `action.type: notify` when you only need an alert.

See the bundled [trigger skill](skills/triggers/SKILL.md), [security policy](SECURITY.md) and [project guide](https://github.com/hyprh/self-starter/blob/main/docs/guide.md). The guide's Codex and Claude Code conversation-delivery behavior does not apply to this first ZCode integration.

## Check the integration

With an installed ZCode CLI and Node.js 24.14.0 or newer, run from the repository root:

```sh
npm run build
ZCODE_BIN=/absolute/path/to/zcode node dist/test/e2e/zcode-agent.js
```

This uses isolated settings and a local stand-in model to check native plugin installation, MCP calls and session resume. It does not use your account or a paid model API.
