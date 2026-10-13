<h1 align="center">Self-Starter</h1>

<p align="center"><b>Give Codex eyes.</b><br>
Tell Codex what to keep an eye on. A small probe watches it on your machine without spending tokens,<br>
and when something changes, Codex comes back to your conversation with what it found and what it did.</p>

<p align="center">
  <a href="https://hyprh.github.io/self-starter/"><b>Website</b></a> ·
  <a href="#install">Install</a> ·
  <a href="#what-to-watch">Use cases</a> ·
  <a href="docs/guide.md">Guide</a> ·
  <a href="docs/design.md">Design</a>
</p>

<p align="center">
  <a href="https://github.com/hyprh/self-starter/actions/workflows/ci.yml"><img src="https://github.com/hyprh/self-starter/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

<p align="center"><img src="docs/architecture.svg" width="880" alt="You set up a trigger in a Codex conversation. The Self-Starter service on your machine runs its probe on a schedule, without calling a model. When it happens, the task goes back to the conversation, opened in the background if Codex is closed, and the result comes to your desktop or email."></p>

```
You:    When the run in runs/exp42 finishes, compare it with exp41.
Codex:  I'll check the end of its log every two minutes and compare the runs here. Start it?
You:    Yes.
        ...four hours later, in the same conversation, even if Codex was closed:
Codex:  exp42 finished: val loss 0.412 vs 0.437 for exp41, same accuracy. Keep exp42.
```

## What to watch

Ask Codex in one sentence. It writes the probe, tries it once and turns it on.

| You say | Self-Starter watches | Then Codex |
|---|---|---|
| "When the training run finishes, compare it with the last one." | the end of the training log | compares the runs and says which to keep |
| "If the dev server is down for two minutes, find out why." | the health endpoint | reads the logs, fixes what it can, restarts it |
| "Whenever CI fails on main, find the cause." | `gh run list` | finds the failing step and proposes a fix |
| "When a new version of zod is out, try it on a branch." | the npm registry | upgrades, runs the tests, says if it is safe |
| "When a new invoice lands in invoices/, add it to expenses.csv." | the folder | reads the PDF and adds the row |
| "Tell me when NVDA closes above $235, with the numbers." | the daily close | reports the move, volume and context |
| "Tell me when analysts change their view on Tencent." | Futu research reports ([`futu-news`](recipes/futu-news)) | sums it up with [Futu's skills](https://www.futunn.com/skillhub) |
| "Watch my IBKR account for anything unusual." | IBKR Flex reports ([`ibkr-account`](recipes/ibkr-account)) | explains trades, assignments and transfers |

## Install

macOS or Linux, Node.js 20+, and the Codex CLI (`npm install -g @openai/codex`) or the Codex app.

```sh
git clone https://github.com/hyprh/self-starter.git && cd self-starter
npm install && npm link
self-starter install   # the Codex plugin, and a background service (launchd or systemd)
self-starter doctor    # checks everything
```

Restart the Codex app so it loads the plugin. Email, secrets and the command line are in the [guide](docs/guide.md).

## Try it in two minutes

1. In a Codex conversation: "Tell me when /tmp/self-starter-demo/done appears, and what it says. Check every 10 seconds."
2. Close the Codex app if you like, then: `mkdir -p /tmp/self-starter-demo && echo "build finished" > /tmp/self-starter-demo/done`
3. Codex answers in that conversation and you get a notification. `self-starter history` shows where it answered: `(your thread, open in Codex)` or `(your thread, opened in the background)`.

## How it works

- **Probes, not prompts.** Codex writes a few lines of TypeScript once; the background service runs them on a schedule. No model is called while waiting.
- **The engine owns the rules.** It fires only when the condition becomes true, with optional minimum duration, cooldown and limits, deduplicates events, retries, and tells you when a probe keeps failing.
- **The conversation answers by itself.** The task goes back to the conversation where you asked, or to a thread of the trigger's own. If Codex is closed, Self-Starter opens the conversation in the background.
- **You stay in control.** Codex asks before turning on triggers that act for you. API keys are typed in a terminal, never in the chat. What a probe saw reaches Codex as data, not instructions.

## More

- [Guide](docs/guide.md): using triggers, where Codex answers, secrets, email, recipes, the command line
- [Design](docs/design.md): how it is built, and what was verified against Codex
- [Checklist for the Codex app](docs/codex-app-checklist.md): four checks on your machine, about ten minutes
- Development: `npm test` runs the unit and integration tests. CI also installs it for real on macOS and Linux, runs fires through the real Codex CLI with a stand-in model (`test/e2e/agent.ts`), and sends real email (`test/e2e/email.ts`).

## License

[MIT](LICENSE)
