# Self-Starter for Google Antigravity

Define custom events in plain language. Antigravity writes a small TypeScript probe; Self-Starter checks files, logs, commands, local services or APIs in the background without calling a model while it waits. When the condition holds, it runs your task in a dedicated `agy` CLI session, or sends a notification across your configured push channels.

For example: “When `runs/exp42/train.log` finishes, compare its results with `exp41`” or “Notify me on Telegram if my local GPU server goes idle for 10 minutes.” Self-Starter handles minimum hold duration (`for`), cooldown, event deduplication, quiet hours and expiry.

### Pairing with Antigravity Remote Control

Self-Starter complements [Antigravity Remote Control](https://antigravity.google/docs/remote-agents):

- **Google Remote Agents** run inside ephemeral cloud VMs without a persistent local `systemd` / `launchd` daemon.
- **Antigravity Remote Control** (`agy remote-control start`) connects your mobile or web browser at `antigravity.google.com` to **your own local workstation or server**, where Self-Starter watches files, GPUs, ports and APIs at zero token cost and wakes dedicated `agy` sessions (`agy --conversation <id>`) when something happens.

This integration supports **dedicated CLI result sessions**. Because Antigravity 2.0 App, Antigravity IDE and `agy` CLI maintain separate conversation stores, background fires run in dedicated `agy` CLI sessions rather than injecting into open GUI windows. Installing the plugin into `~/.gemini/config/plugins/self-starter` makes its MCP tools and `triggers` skill available across Antigravity 2.0 App, Antigravity IDE and `agy` CLI alike.

## Installation

Requires macOS or Linux, Node.js 20 or newer, and an authenticated Antigravity CLI (`agy auth status`).

### Option 1: Install via npm (recommended)

```sh
npx self-starter install
~/.self-starter/bin/self-starter doctor
```

If `agy` is not on your `PATH` or in `~/.local/bin/agy`, pass `--agy /absolute/path/to/agy`. Installing globally (`npm install -g self-starter && self-starter install`) puts `self-starter` directly on your `PATH`.

### Option 2: Install the plugin directly with `agy`

```sh
agy plugin install ./agy-plugin
agy plugin enable self-starter
```

On first MCP tool use, the launcher installs the matching Self-Starter runtime into `~/.self-starter/runtime/<version>` and starts the background daemon (`systemd` on Linux, `launchd` on macOS).

## Permissions

Probes run as the current user by default and should only observe. API-only probes can use `probe.access: sandbox`, which limits Deno to declared network hosts and environment variables. Store credentials in a terminal with `~/.self-starter/bin/self-starter secret set NAME`, never in chat or probe source.

For background agent actions, Self-Starter enforces `action.sandbox` through the plugin's `PreToolUse` hook (`bin/guard.mjs`):

| `action.sandbox` | Background `PreToolUse` policy |
|---|---|
| `read-only` | Read/search tools and safe Self-Starter reporting tools only; file writes, shell commands and external MCP tools are denied |
| `workspace-write` (default) | Allows file edits inside `target.cwd` (excluding `.git`, `.agents` and `.gemini`); shell commands and external MCP tools are denied |
| `danger-full-access` | Permits commands, file edits and MCP tools without approval prompts |

These are **hook-enforced tool policies, not operating-system isolation**. Authorize the intended side effects before activating a trigger, and use `action.type: notify` when you only need an alert.

See the bundled [trigger skill](skills/triggers/SKILL.md), [security policy](SECURITY.md) and [project guide](https://github.com/hyprh/self-starter/blob/main/docs/guide.md).
