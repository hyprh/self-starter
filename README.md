# Self-Starter

Give Codex eyes: it notices when something changes, and comes back to your conversation with what it found and what it did.

Codex works when you talk to it, and its Automations run on a clock. Many things you want done are "when X happens, do Y": when the training run finishes, compare it with the last one; when CI on main fails, find the cause; when NVDA closes above 235, give me the numbers. Self-Starter is a Codex plugin for exactly that.

You tell Codex in one sentence what to watch and what to do. Codex writes a small **probe** (a few lines of TypeScript) that checks the condition, and a background service keeps running it. No model is called while waiting. When the condition is met, the task goes back to Codex, in the conversation where you asked, even if the Codex app is closed, or in a thread of its own. You get a notification or an email with the result.

Landing page: https://hyprh.github.io/self-starter/ (source in [site/](site)).

```
You:    When the training run in runs/exp42 finishes, compare its metrics with exp41
        and tell me which one to keep.
Codex:  I'll check the end of runs/exp42/train.log every two minutes. When it says
        "Finished training", I'll compare the two runs here and report back. Start it?
You:    Yes.
...four hours later, in the same thread:
        exp42 finished: val loss 0.412 vs 0.437 for exp41, same accuracy. Keep exp42.
```

Status: working MVP, verified end to end with the Codex CLI and app server. CI installs it for real on macOS (launchd) and Linux (systemd) and sends real email. What is left to check in the Codex desktop app takes about ten minutes: [docs/codex-app-checklist.md](docs/codex-app-checklist.md).

## How it works

- **Probes are code, the engine owns the rules.** A probe answers "what do I see now, and does it count?". The engine runs it on a schedule the probe can adapt (check more often near a threshold), fires only when a condition becomes true (with optional minimum duration, re-arm hysteresis, cooldown, max fires and expiry), deduplicates events, retries, and alerts you when a probe keeps failing.
- **Probes run on your machine, as you.** A probe can read files and logs, run the commands you have (`git`, `gh`, `docker`, a skill's scripts), talk to local services and call web APIs. When a probe only needs a few web APIs, it can run in a sandbox instead (`probe.access: sandbox`): network to the hosts it declares, no files, no commands.
- **Codex decides when to ask.** Codex tries every probe once before turning it on. For a trigger that acts on your behalf or runs for a long time, it tells you what it will check and do, and asks before starting it; a plain "let me know when the build finishes" just starts.
- **The conversation answers by itself.** `origin` sends the task back into the thread where you created the trigger. If that thread is open in a Codex app, it runs there right away; if not, Self-Starter opens the thread in the background about 20 seconds later and Codex handles it there, so the reply is waiting when you come back (also when you closed Codex in the middle of a turn; only if you stopped Codex there with messages of your own waiting, the fire waits with them and you get a notification). `dedicated` sends each fire to the trigger's own thread instead (good for long-running watches), titled "Trigger: <name>" in Codex, the same way. Runs in the background (dedicated threads, and origin threads woken while the app is closed) can change files and run commands in their folder (Codex's `workspace-write` sandbox); a trigger can choose `read-only`, or `danger-full-access` when it needs more.
- **Fires are data, not instructions.** What a probe saw is passed to Codex in a block marked untrusted; the task itself comes from the trigger's definition. A turn handling a fire cannot create or change triggers.

## Install

Requirements: macOS or Linux, Node.js 20 or newer, and the Codex CLI (`npm install -g @openai/codex`) or the Codex app. Deno is installed for you.

```sh
git clone https://github.com/hyprh/self-starter.git
cd self-starter
npm install            # also builds
npm link               # puts `self-starter` on your PATH (or use: node dist/src/cli/main.js)
self-starter install   # installs the Codex plugin and the background service
self-starter doctor    # checks everything
```

`self-starter install` registers a local plugin marketplace with Codex, installs the Self-Starter plugin, and starts the background service (a launchd agent on macOS, a systemd user unit on Linux). Restart the Codex app afterwards so it loads the plugin. If `codex` is not on your PATH, pass `--codex /path/to/codex`.

For notifications that open the right thread when clicked on macOS, install `terminal-notifier` (`brew install terminal-notifier`). On Linux, notifications use `notify-send`.

## Try it in two minutes

No API keys needed. This also shows a conversation answering while the Codex app is closed.

1. In a Codex conversation, say: "Tell me when the file /tmp/self-starter-demo/done appears, and what it says."
2. Codex sets up the trigger (it may ask first). Close the Codex app if you like.
3. In a terminal: `mkdir -p /tmp/self-starter-demo && echo "build finished in 4m12s" > /tmp/self-starter-demo/done`
4. At the next check (Codex picks how often; ask for "every 30 seconds" if you are impatient), Codex answers in that same conversation and you get a notification. If the app was closed, this takes about 20 seconds longer, and the answer is there when you open the conversation again. `self-starter history` shows what happened, and where Codex answered: `(your thread, open in Codex)` or `(your thread, opened in the background)`.

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

Notifications go to the desktop by default. To get them by email too, give your address:

```sh
self-starter channel email you@gmail.com
```

The mail server is filled in for Gmail, iCloud, Yahoo, Fastmail, QQ, 163, 126 and Aliyun addresses. The command asks for an app password (create one in your mailbox's security settings; QQ and NetEase call it an authorization code), keeps it in a file only you can read, and sends you a test email. Outlook and Hotmail addresses cannot send this way, because Microsoft now requires OAuth; use another address, or your own server with `--host smtp.example.com [--port 587 --starttls]`.

Then ask Codex to email you about a trigger, or make email a default with `self-starter channel default desktop,email`. Probes never see the app password.

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
npm test                         # builds, then runs unit and integration tests (real Deno probes, the daemon, the MCP protocol)
node dist/test/e2e/email.js      # real email: sets up the email channel and lets a trigger fire into a throwaway Ethereal mailbox
node dist/test/e2e/agent.js      # fires through the real Codex CLI (on your PATH) with a stand-in model, in folders of its own
```

CI runs the tests on Linux and macOS, and on both installs for real (test/e2e/install.ts: the Codex CLI, launchd or systemd, a trigger, a crash, a reinstall and an uninstall) and runs fires through the real Codex CLI with a stand-in model (test/e2e/agent.ts: a fire picked up by an open thread, then, with Codex closed in the middle of a turn, fires in that conversation and in a thread of the trigger's own). The Email workflow runs the email check when the email code changes, or on demand.

- [docs/design.md](docs/design.md): design and the verified Codex integration points
- [plugin/](plugin): the Codex plugin (manifest and skills)
- [recipes/](recipes): ready-made probes, such as the IBKR account watch
- [site/](site): the landing page, published to GitHub Pages by `.github/workflows/pages.yml` (Settings > Pages > Source: GitHub Actions)
- [src/](src): `core` (definitions, firing rules, messages), `engine` (scheduler, executor, storage, Codex and Deno), `daemon`, `mcp`, `cli`
- [docs/codex-app-checklist.md](docs/codex-app-checklist.md): what to check in the Codex app on your machine (about ten minutes)

## License

[MIT](LICENSE)
