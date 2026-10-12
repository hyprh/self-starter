# codex-triggers

Let Codex act when something happens.

Codex works when you talk to it, and its Automations run on a clock. Many things you want done are "when X happens, do Y": when NVDA breaks 200, find out why; when CI on main fails, investigate; when a dependency ships a release, check it for breaking changes. codex-triggers is a Codex plugin for exactly that.

You tell Codex in one sentence what to watch and what to do. Codex writes a small **probe** (a few lines of TypeScript) that checks the condition, you approve it, and a background service keeps running it. No model is called while waiting. When the condition is met, the task goes back to Codex: into the thread where you asked, or into a thread dedicated to the trigger, which Codex works on in the background. You get a notification with the result.

```
You:    When the Rust compiler ships a new stable release, read the release notes and tell me
        what matters for this project.
Codex:  I'll check the GitHub releases of rust-lang/rust every 30 minutes and, for each new
        stable release, work through the notes in a dedicated thread. [approval dialog]
...three weeks later, a notification:
        Rust releases: 1.97.0 adds X; our use of Y in src/parse.rs is affected. Details in the thread.
```

Status: working MVP, verified end to end with the Codex CLI and app server on Linux; see the [design](docs/design.md) for what is still to be checked in the Codex app on your machine.

## How it works

- **Probes are code, the engine owns the rules.** A probe answers "what do I see now, and does it count?". The engine runs it on a schedule the probe can adapt (check more often near a threshold), fires only when a condition becomes true (with optional minimum duration, re-arm hysteresis, cooldown, max fires and expiry), deduplicates events, retries, and alerts you when a probe keeps failing.
- **Sandboxed and approved.** Probes run in Deno with network access only to the hosts they declare, no file access and no subprocesses. Nothing runs on a schedule until you approve a dialog that shows what is watched, the network access, the action and a trial run. If the code or permissions change later, the trigger pauses until you approve again.
- **Two ways back into Codex.** `origin` queues the task into the thread where you created the trigger (good for "tell me when this build finishes"); `dedicated` runs each fire in the trigger's own thread in the background (good for long-running watches), titled "Trigger: <name>" in Codex.
- **Fires are data, not instructions.** What a probe saw is passed to Codex in a block marked untrusted; the task itself is the one you approved. A turn handling a fire cannot create or change triggers.

## Install

Requirements: macOS or Linux, Node.js 20 or newer, and the Codex CLI (`npm install -g @openai/codex`) or the Codex app. Deno is installed for you.

```sh
git clone https://github.com/hyprh/SelfReflection.git codex-triggers
cd codex-triggers
npm install            # also builds
npm link               # puts `ctrig` on your PATH (or use: node dist/src/cli/main.js)
ctrig install          # installs the Codex plugin and the background service
ctrig doctor           # checks everything
```

`ctrig install` registers a local plugin marketplace with Codex, installs the `codex-triggers` plugin, and starts the background service (a launchd agent on macOS, a systemd user unit on Linux). Restart the Codex app afterwards so it loads the plugin. If `codex` is not on your PATH, pass `--codex /path/to/codex`.

For notifications that open the right thread when clicked on macOS, install `terminal-notifier` (`brew install terminal-notifier`). On Linux, notifications use `notify-send`.

## Use

Just ask Codex, for example:

- "Tell me when https://status.example.com stops returning 200."
- "When NVDA closes above 200, look into why and write me a five-line brief."
- "Whenever CI fails on main in this repo, find the cause and suggest a fix."
- "Watch the releases of `denoland/deno` and tell me about anything that affects this project."

Codex uses the plugin's skill (`$codex-triggers:triggers`), writes the probe, runs it once, explains what it will do, and asks you to approve. Later you can ask "what triggers do I have?", "why didn't the NVDA trigger fire?", "raise the threshold to 210" or "pause the release watch".

If a probe needs an API key, Codex asks you to store it in a terminal; it never sees the key:

```sh
ctrig secret set QUOTE_API_KEY --hosts api.example.com
```

The secret is only given to probes that cannot reach any other host.

### Ready-made recipes

Some things to watch come with a probe already written and tested, so Codex only fills in your settings. `ctrig recipes` lists them.

- **IBKR account watch** (`ibkr-account`): new executions and option assignments within 5 to 10 minutes, and once a day deposits and withdrawals, positions that changed without a trade, and large moves in net asset value. It uses Interactive Brokers' Flex Web Service with a read-only token; ask Codex "watch my IBKR account" and it walks you through the five-minute setup.

### Email

Notifications go to the desktop by default. To get them by email too:

```sh
ctrig channel email --to you@example.com --host smtp.example.com --user you@example.com
ctrig channel test email
```

Then ask Codex to email you about a trigger, or make email a default with `ctrig channel default desktop,email`. The SMTP password is kept in a file only you can read and is never given to probes.

## Command line

```
ctrig list                         all triggers and their state
ctrig show <id>                    definition, state, recent checks and fires
ctrig test <id>                    run the probe once, without firing
ctrig pause|resume|delete <id>
ctrig history [<id>]               recent fires and what came of them
ctrig approve <draft-id|id>        review and approve in the terminal
ctrig recipes                      ready-made recipes
ctrig secret set|list|rm
ctrig channel list|email|default|test|rm
ctrig service install|uninstall|start|stop|restart|status
ctrig logs
ctrig uninstall [--purge]
```

Everything lives in `~/.codex-triggers` (set `CODEX_TRIGGERS_HOME` to move it): readable YAML definitions and probe code, the fire log, and logs.

## Development

```sh
npm test               # builds, then runs unit and integration tests (real Deno probes, the daemon, the MCP protocol)
```

- [docs/design.md](docs/design.md): design and the verified Codex integration points
- [plugin/](plugin): the Codex plugin (manifest and skills)
- [recipes/](recipes): ready-made probes, such as the IBKR account watch
- [site/](site): the landing page, published to GitHub Pages by `.github/workflows/pages.yml` (Settings > Pages > Source: GitHub Actions)
- [src/](src): `core` (definitions, firing rules, messages), `engine` (scheduler, executor, storage, Codex and Deno), `daemon`, `mcp`, `cli`
- [spike/](spike/README.md): scripts that check the remaining assumptions in the Codex app
