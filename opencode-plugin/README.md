# Self-Starter for OpenCode

Define custom events in plain language. OpenCode writes a small TypeScript probe; Self-Starter checks files, logs, commands, local services or APIs without calling a model while it waits. When an event fires, OpenCode handles the task in a dedicated result session, or the service sends a notification.

For example: “When this training log finishes, compare the results with the previous run” or “When CI fails on this branch, investigate the failed job.” The existing engine handles duration, cooldown, event deduplication, expiry and receipts.

This integration uses **dedicated result sessions**. It does not inject events into your original conversation. Each trigger's agent action gets its own session, and later events resume that same session through `opencode run`, including when the UI is closed. Write the action as a complete task with the context and working directory it needs. Pause a trigger before manually continuing its result session.

## Development install

Requires macOS or Linux, Node.js 20 or newer, and an OpenCode CLI already configured and authenticated by the user. Supported versions are **1.19.3 or newer within 1.x**; the developing v2 plugin API is not supported. Install from a checkout containing these changes until a supporting release is available.

From the repository root:

```sh
npm ci
npm run build
node dist/src/cli/main.js install --opencode /absolute/path/to/opencode
node dist/src/cli/main.js doctor
```

The installer registers one native plugin in your OpenCode configuration and configures the background service to use this checkout and your OpenCode executable. Keep the checkout available and start a new OpenCode session after installation. The plugin exposes the trigger tools with session identity supplied by OpenCode, and adds its trigger instructions to the model's system context.

Do not also register this plugin in a project's configuration: OpenCode can load global and project plugins together. This source integration has not been published in an OpenCode catalog.

Try a notification first: “Notify me once when `/tmp/self-starter-opencode-done` appears. Check every minute and stop after an hour.” Confirm the first scheduled check found no file, then create the file in a terminal. Inspect the result with `node dist/src/cli/main.js history` or `trigger_history`. Use an agent action next when OpenCode should investigate or change something.

Agent watches initialize a dedicated result session when activated; this calls a model. Scheduled probe checks do not call a model. Model configuration and credentials must be available to the background service; environment variables set only in an interactive shell may not reach it.

## Permissions

Probes run as the current user by default and should only observe. API-only probes can use `probe.access: sandbox`, which limits Deno to declared network hosts and environment variables. Store secrets in a terminal with `node dist/src/cli/main.js secret set NAME`, never in chat or probe source.

Agent actions apply explicit OpenCode tool permissions for the selected `action.sandbox`. These are **tool rules, not operating-system isolation**. Background runs have no approval client, so operations that require approval are denied. Authorize the task and its side effects before activation. Use `action.type: notify` when only an alert is needed.

See the bundled [trigger instructions](skills/triggers/SKILL.md), [security policy](SECURITY.md) and [project guide](https://github.com/hyprh/self-starter/blob/main/docs/guide.md).
