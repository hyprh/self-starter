# Changelog

## 0.1.0 (unreleased)

Self-Starter now works in Claude Code too, with the same triggers, background service and command line.

```sh
claude plugin install self-starter --marketplace hyprh/self-starter
```

- **Fires come back to your session.** While a terminal has the session open, the fire arrives there as a message from another session, posted by the plugin's MCP server inside that session, so Claude Code delivers it in every permission mode. When no terminal has it open, Self-Starter resumes the session in the background (`claude -p --resume`), in its folder, with a permission mode from the trigger's `action.sandbox`. Triggers of their own get a session named "Trigger: <name>".
- **The plugin follows your sessions.** Its hooks record which session each Claude Code process shows (through `/clear` and `/resume`), and whether a fire started the current turn: such a turn cannot create or change triggers, except to make that trigger quieter.
- **A slow first start no longer starts over.** The plugin installs its runtime in a process of its own, which finishes even when the host gives up waiting (Claude Code waits 30 seconds), so the next start is ready.

Checked by unit tests, and end to end with the real Claude Code CLI and a stand-in model (`test/e2e/cc-agent.ts`): installing from the marketplace, a fire into an open session, and fires in closed sessions and in a trigger's own session.

## 0.0.1 (2026-10-13)

The first release. Tell Codex what to keep an eye on; a small probe watches it on your machine without spending tokens, and when something changes, Codex comes back to your conversation with what it found and what it did.

```sh
codex plugin marketplace add hyprh/self-starter
codex plugin add self-starter@self-starter
```

- **Triggers from one sentence.** Codex writes a small TypeScript probe, tries it once and turns it on. The engine runs it on a schedule without calling a model, fires only when the condition becomes true (state or event mode, with `for`, cooldown, `max_fires`, expiry and quiet hours), deduplicates events, retries, and tells you when a probe keeps failing.
- **Codex answers where you asked**: in the conversation where you set the trigger up, or in a thread of the trigger's own. If Codex is closed, Self-Starter opens the thread in the background, also after you stopped Codex in the middle of a turn.
- **Noisy triggers get quieter.** While handling a fire, Codex can make that trigger check less often, wait longer, fire fewer times or pause, never the other way, and tells you what it changed and why.
- **Results on the desktop and by email**, with the mail servers of Gmail, iCloud, Yahoo, Fastmail, QQ, 163, 126 and Aliyun filled in.
- **Safe by default.** API keys and app passwords are typed in a terminal, never in the chat; what a probe saw reaches Codex as untrusted data; a turn handling a fire cannot create or change triggers, except to make its own quieter.
- **Recipes**: an IBKR account watch (Flex Web Service) and a Futu news and research watch, written and tested in advance.
- **Installs itself.** The plugin's first start downloads the runtime of its version, with Deno, and sets up a launchd (macOS) or systemd (Linux) service, so triggers keep running when Codex is closed.

Checked by the unit and integration tests, and in CI on macOS and Linux with the real Codex CLI and a stand-in model: installing from the marketplace, the background service, fires in open, paused and background threads, and real email. A few behaviors of the Codex app are checked by hand ([checklist](docs/codex-app-checklist.md)).
