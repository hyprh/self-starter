# Self-Starter guide

Everything beyond the [README](../README.md): day-to-day triggers, result delivery in Codex and Claude Code, the ZCode source preview, secrets, email, recipes and the command line. The [design](design.md) explains how it is built.

## Install

Requirements: macOS or Linux, Node.js 20 or newer, and an authenticated Codex or Claude Code installation. Deno is installed for you. The [ZCode source preview](../zcode-plugin/README.md) requires Node.js 24.14.0 or newer and has a separate installation path.

For Codex:

```sh
codex plugin marketplace add hyprh/self-starter
codex plugin add self-starter@self-starter
```

Then restart the Codex app. For [Claude Code](#claude-code), use the installation commands below and start a new session. Each published plugin installs its matching runtime (the background service, the MCP server and Deno) into `~/.self-starter/runtime/<version>` on first start. Allow a minute or two. It sets up a launchd agent on macOS or a systemd user service on Linux and writes the terminal command `~/.self-starter/bin/self-starter`. Later starts need no network. To update the Codex plugin, run `codex plugin marketplace upgrade self-starter` and `codex plugin add self-starter@self-starter` again; the next start installs its runtime and replaces the older service.

From a clone of this repository, for development:

```sh
npm install            # also builds
npm link               # puts `self-starter` on your PATH (or use: node dist/src/cli/main.js)
self-starter install   # installs the Codex plugin and the background service
self-starter doctor    # checks everything
```

`self-starter install` registers a local plugin marketplace with Codex whose plugin runs this checkout, installs the plugin, and starts the background service. If `codex` is not on your PATH, pass `--codex /path/to/codex`. Run it again after pulling changes; your triggers are kept. `--no-service` runs the daemon without the service, and the plugin then leaves it that way.

For notifications that open the right conversation when clicked on macOS, install `terminal-notifier` (`brew install terminal-notifier`). On Linux, notifications use `notify-send`.

## Using triggers

Ask Codex in plain words what to watch and what to do. Codex uses the plugin's skill (`$self-starter:triggers`), writes a small probe, runs it once and turns it on. For a trigger that acts on your behalf or runs for a long time, it tells you what it will check and do, and asks before starting it; a plain "let me know when the build finishes" just starts.

Later you can ask "what triggers do I have?", "why didn't the CI trigger fire?", "check every 10 minutes instead" or "pause the release watch".

- **Probes are code, the engine owns the rules.** A probe answers "what do I see now, and does it count?". The engine runs it on a schedule the probe can adapt (more often near a threshold), fires only when a condition becomes true (with optional minimum duration, re-arm hysteresis, cooldown, max fires and expiry), deduplicates events, retries, and alerts you when a probe keeps failing.
- **Probes run on your machine, as you.** A probe can read files and logs, run the commands you have (`git`, `gh`, `docker`, a skill's scripts), talk to local services and call web APIs. When a probe only needs a few web APIs, it can run in a sandbox instead (`probe.access: sandbox`): network to the hosts it declares, no files, no commands.
- **Fires are data, not instructions.** What a probe saw is passed to Codex in a block marked untrusted; the task itself comes from the trigger's definition. A turn handling a fire cannot create or change triggers, with one exception: when a trigger fires far more often than is useful, Codex can make it quieter (check less often, wait longer after a fire, require the condition to hold longer, fire fewer times, or pause it) and tells you what it changed and why. Making a trigger more sensitive always goes through you.

## Where Codex answers

- **`origin`** sends the task back into the conversation where you created the trigger. If a Codex app has it open, it runs there right away. If not, Self-Starter opens the conversation in the background about 20 seconds later and Codex handles it there, so the answer is waiting when you come back. That also works when you closed Codex in the middle of a turn; only if you stopped Codex there with messages of your own waiting does the fire wait with them, and you get a notification.
- **`dedicated`** sends each fire to the trigger's own conversation, titled "Trigger: <name>" in Codex, the same way. It suits long-running watches, so that their fires do not crowd your work. It is the default for triggers that can fire more than once.
- Runs in the background can change files and run commands in their folder (Codex's `workspace-write` sandbox); a trigger can choose `read-only`, or `danger-full-access` when it needs more.
- `self-starter history` ends each answered fire with where Codex answered: `(your thread, open in Codex)` or `(your thread, opened in the background)`.

## ZCode

The ZCode integration uses dedicated CLI result sessions. It shares the probe engine and event rules, but does not resume the desktop conversation where a watch was created. See the [ZCode installation and permissions guide](../zcode-plugin/README.md).

## Claude Code

Self-Starter also works as a Claude Code plugin, with the same triggers, service and command line. Use Claude Code 2.1.224 or newer for delivery into open sessions. Inside a session:

```
/plugin marketplace add hyprh/self-starter
/plugin install self-starter@self-starter
```

Or run `claude plugin marketplace add hyprh/self-starter` followed by `claude plugin install self-starter@self-starter` in a terminal. Start a new session afterward. The plugin's first start installs the runtime as above, while you work: if that takes longer than Claude Code waits for a plugin's server (30 seconds), the plugin answers anyway, and its tools appear as soon as it is ready. From a clone, `self-starter install` sets up the supported agents it finds; see the [ZCode guide](../zcode-plugin/README.md) before using the source preview.

Claude Code asks before the tools that create, change, pause or delete a trigger, as it does for any tool. The plugin lets its own tools that report a fire, make a trigger quieter or only read run without asking, so that a fire can report back while you are away; deny rules you set still apply.

Where fires go, for triggers made in Claude Code:

- **`origin`** brings the task back to the session where you made the trigger. While a terminal has it open, the fire arrives there as soon as Claude is done with what it is doing, however long that takes (a fire never interrupts a turn; if you stopped Claude with Esc, it arrives once the session has been quiet for 15 minutes). It comes as a message from another session: the Self-Starter service. Claude Code shows it as "Another Claude session sent a message". The plugin's MCP server posts it, as part of the session, so it is delivered in every permission mode. When no terminal has the session open, Self-Starter resumes it in the background with `claude -p --resume <id>`, in the session's folder, and the answer is in the session when you open it again (`claude --resume`).
- **`dedicated`** starts a session of the trigger's own when you turn it on, named "Trigger: <name>", and sends each fire there the same way.
- A fire that runs in the background gets a permission mode from the trigger's `action.sandbox`: `workspace-write` (the default) runs in `acceptEdits` mode, so Claude can edit files in the folder; `read-only` runs in `dontAsk` mode, so it does only what needs no approval, such as reading; `danger-full-access` runs in `bypassPermissions` mode. Your own permission rules apply as well, and what would need approval is declined, since nobody is there to give it. A fire in an open session runs in that session's mode.
- The plugin's hooks record, under `~/.self-starter/sessions` and `~/.self-starter/inboxes`, which session each running Claude Code process shows (it changes with `/clear` and `/resume`), whether a turn is running there, and whether a fire started it. A turn that a fire started cannot create or change triggers, except to make that trigger quieter.
- If you set `crossSessionInbound` to `hold` or `refuse`, Claude Code holds or drops a fire sent into an open session, as it does any message from another session; Self-Starter cannot tell, and reminds you after 5 minutes. Background runs use the `claude` on your PATH (or `claudeBin` in `~/.self-starter/config.json`) with the login Claude Code keeps; an API key that is only exported in your shell does not reach the background service.
- `self-starter history` shows where each fire was answered: `(your session, open in Claude Code)` or `(your session, resumed in the background)`.

## Secrets

If a probe needs an API key, Codex asks you to store it in a terminal; it never sees the key:

```sh
self-starter secret set QUOTE_API_KEY
```

Probes that list the secret in `probe.permissions.env` get it as an environment variable. With `--hosts api.example.com`, a sandboxed probe only gets it when it cannot reach any other host.

## Email

Notifications go to the desktop by default. To get them by email too, give your address:

```sh
self-starter channel email you@gmail.com
```

The mail server is filled in for Gmail, iCloud, Yahoo, Fastmail, QQ, 163, 126 and Aliyun addresses. The command asks for an app password (create one in your mailbox's security settings; QQ and NetEase call it an authorization code), keeps it in a file only you can read, and sends you a test email. Outlook and Hotmail addresses cannot send this way, because Microsoft now requires OAuth; use another address, or your own server with `--host smtp.example.com [--port 587 --starttls]`.

Then ask Codex to email you about a trigger, or make email a default with `self-starter channel default desktop,email`. Probes never see the app password.

## Ready-made recipes

Some things to watch come with a probe already written and tested, so Codex only fills in your settings. `self-starter recipes` lists them.

- **IBKR account watch** (`ibkr-account`): new executions and option assignments within 5 to 10 minutes, and once a day deposits and withdrawals, positions that changed without a trade, and large moves in net asset value. It uses Interactive Brokers' Flex Web Service with a read-only token; ask Codex "watch my IBKR account" and it walks you through the five-minute setup.
- **Futu news watch** (`futu-news`): new research reports (analyst ratings and price targets), company announcements or news about the stocks you follow, from Futu's news search, with no account needed. It pairs with [Futu's own skills for Codex](https://www.futunn.com/skillhub): with them installed, Codex handles each fire with Futu's stock digest and community sentiment. Ask Codex, for example, "tell me when analysts change their view on Tencent or NVIDIA, and what the community thinks".

## Command line

If you installed only the plugin, the command is `~/.self-starter/bin/self-starter`.

```
self-starter list                   all triggers and their state
self-starter show <id>              definition, state, recent checks and fires
self-starter test <id>              run the probe once, without firing
self-starter pause|resume|delete <id>
self-starter history [<id>]         recent fires, what came of them and where Codex answered
self-starter drafts                 drafts Codex tried but did not turn on
self-starter activate <draft-id>    turn a draft on
self-starter recipes                ready-made recipes
self-starter secret set|list|rm
self-starter channel list|email|default|test|rm
self-starter service install|uninstall|start|stop|restart|status
self-starter logs
self-starter doctor
self-starter uninstall [--purge]
```

Everything lives in `~/.self-starter` (set `SELF_STARTER_HOME` to move it): readable YAML definitions and probe code, the fire log, and logs. `self-starter uninstall` removes the plugin and the service and keeps your triggers; `--purge` deletes them too.
