# Self-Starter

Let Codex act when something happens.

Codex works when you talk to it, and its Automations run on a clock. Many things you want done are "when X happens, do Y": when NVDA breaks 200, find out why; when CI on main fails, investigate; when a dependency ships a release, check it for breaking changes. Self-Starter is a Codex plugin for exactly that.

You tell Codex in one sentence what to watch and what to do. Codex writes a small **probe** (a few lines of TypeScript) that checks the condition, and a background service keeps running it. No model is called while waiting. When the condition is met, the task goes back to Codex: into the thread where you asked, or into a thread dedicated to the trigger, which Codex works on in the background. You get a notification with the result.

```
You:    When the training run in runs/exp42 finishes, compare its metrics with exp41
        and tell me which one to keep.
Codex:  I'll check the end of runs/exp42/train.log every two minutes. When it says
        "Finished training", I'll compare the two runs here and report back. Start it?
You:    Yes.
...four hours later, in the same thread:
        exp42 finished: val loss 0.412 vs 0.437 for exp41, same accuracy. Keep exp42.
```

Status: working MVP, verified end to end with the Codex CLI and app server on Linux; see the [design](docs/design.md) for what is still to be checked in the Codex app on your machine.

## How it works

- **Probes are code, the engine owns the rules.** A probe answers "what do I see now, and does it count?". The engine runs it on a schedule the probe can adapt (check more often near a threshold), fires only when a condition becomes true (with optional minimum duration, re-arm hysteresis, cooldown, max fires and expiry), deduplicates events, retries, and alerts you when a probe keeps failing.
- **Probes run on your machine, as you.** A probe can read files and logs, run the commands you have (`git`, `gh`, `docker`, a skill's scripts), talk to local services and call web APIs. When a probe only needs a few web APIs, it can run in a sandbox instead (`probe.access: sandbox`): network to the hosts it declares, no files, no commands.
- **Codex decides when to ask.** Codex tries every probe once before turning it on. For a trigger that acts on your behalf or runs for a long time, it tells you what it will check and do, and asks before starting it; a plain "let me know when the build finishes" just starts.
- **Two ways back into Codex.** `origin` queues the task into the thread where you created the trigger (good for "tell me when this build finishes"); `dedicated` runs each fire in the trigger's own thread in the background (good for long-running watches), titled "Trigger: <name>" in Codex. Dedicated runs can change files and run commands in the trigger's folder (Codex's `workspace-write` sandbox); a trigger can choose `read-only`, or `danger-full-access` when it needs more.
- **Fires are data, not instructions.** What a probe saw is passed to Codex in a block marked untrusted; the task itself comes from the trigger's definition. A turn handling a fire cannot create or change triggers.

## Install

Requirements: macOS or Linux, Node.js 20 or newer, and the Codex CLI (`npm install -g @openai/codex`) or the Codex app. Deno is installed for you.

```sh
git clone https://github.com/hyprh/SelfReflection.git self-starter
cd self-starter
npm install            # also builds
npm link               # puts `self-starter` on your PATH (or use: node dist/src/cli/main.js)
self-starter install   # installs the Codex plugin and the background service
self-starter doctor    # checks everything
```

`self-starter install` registers a local plugin marketplace with Codex, installs the Self-Starter plugin, and starts the background service (a launchd agent on macOS, a systemd user unit on Linux). Restart the Codex app afterwards so it loads the plugin. If `codex` is not on your PATH, pass `--codex /path/to/codex`.

For notifications that open the right thread when clicked on macOS, install `terminal-notifier` (`brew install terminal-notifier`). On Linux, notifications use `notify-send`.

## Use

Just ask Codex, for example:

- "When the training run in runs/exp42 finishes, summarize its metrics."
- "If the dev server on port 3000 stops answering for two minutes, find out why."
- "Whenever CI fails on main in this repo, find the cause and suggest a fix."
- "When a new version of `zod` is published, check whether it affects this project."

Codex uses the plugin's skill (`$self-starter:triggers`), writes the probe, runs it once and turns it on, asking you first when the trigger acts for you. Later you can ask "what triggers do I have?", "why didn't the CI trigger fire?", "check every 10 minutes instead" or "pause the release watch".

If a probe needs an API key, Codex asks you to store it in a terminal; it never sees the key:

```sh
self-starter secret set QUOTE_API_KEY
```

Probes that list the secret in `probe.permissions.env` get it as an environment variable. With `--hosts api.example.com`, a sandboxed probe only gets it when it cannot reach any other host.

### Ready-made recipes

Some things to watch come with a probe already written and tested, so Codex only fills in your settings. `self-starter recipes` lists them.

- **IBKR account watch** (`ibkr-account`): new executions and option assignments within 5 to 10 minutes, and once a day deposits and withdrawals, positions that changed without a trade, and large moves in net asset value. It uses Interactive Brokers' Flex Web Service with a read-only token; ask Codex "watch my IBKR account" and it walks you through the five-minute setup.

### Email

Notifications go to the desktop by default. To get them by email too:

```sh
self-starter channel email --to you@example.com --host smtp.example.com --user you@example.com
self-starter channel test email
```

Then ask Codex to email you about a trigger, or make email a default with `self-starter channel default desktop,email`. The SMTP password is kept in a file only you can read and is never given to probes.

## Command line

```
self-starter list                   all triggers and their state
self-starter show <id>              definition, state, recent checks and fires
self-starter test <id>              run the probe once, without firing
self-starter pause|resume|delete <id>
self-starter history [<id>]         recent fires and what came of them
self-starter drafts                 drafts Codex tried but did not turn on
self-starter activate <draft-id>    turn a draft on
self-starter recipes                ready-made recipes
self-starter secret set|list|rm
self-starter channel list|email|default|test|rm
self-starter service install|uninstall|start|stop|restart|status
self-starter logs
self-starter uninstall [--purge]
```

Everything lives in `~/.self-starter` (set `SELF_STARTER_HOME` to move it): readable YAML definitions and probe code, the fire log, and logs.

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
