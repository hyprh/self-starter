# Changelog

## 0.0.4 (unreleased)

- **OpenCode custom events.** A native plugin uses the shared trigger tools and engine. Events run in dedicated CLI result sessions, reused for later events even while the UI is closed. Source installation, diagnostics and removal preserve existing OpenCode configuration. Original-conversation delivery is not supported.
- **ZCode custom events.** A local plugin connects ZCode to the shared trigger engine. Probes wait without calling a model; agent actions run in dedicated CLI sessions that are reused for subsequent events. The original desktop conversation is not resumed.
- **Install and inspect ZCode.** `self-starter install --zcode /absolute/path/to/zcode` registers the native plugin and configures the background service. `doctor` checks its installation, and `history` shows results and session resume commands.
- **Explicit background permissions.** Actions select ZCode's `plan`, `edit` or `yolo` tool policy. These policies do not provide operating-system isolation. Background turns cannot create new triggers or expand existing ones.
- **Keep sessions separate.** Turn guards include the host and conversation, and a completed session initialization cannot attach to a trigger that changed while it was being created.

## 0.0.3 (2026-10-16)

This release prepares Self-Starter for plugin catalogs and gives the plugin and website a shared event-trigger icon.

- **Catalog bundles retain the launcher.** The Codex manifest now declares `bin/`, so a catalog that mirrors only declared plugin paths can still start the MCP server. A regression test covers that installation layout.
- **Complete plugin metadata and documentation.** The bundle includes repository and license metadata, installation policy, its own README, license and security policy, and an icon. Descriptions emphasize custom events defined in plain language.
- **A shared visual identity.** The plugin and GitHub Pages favicon use the same mint ring and signal dot. The website includes Codex and Claude Code examples, and the README adds a desktop-notification demo.
- **Repeatable security checks.** GitHub Actions are pinned to commit SHAs, scanner wheels are checksum-verified, and CI checks both scanner versions used or recommended by the awesome catalog. Dependabot checks dependency and action updates.
- **Clearer scanner inputs.** Local test credentials are generated per run; equivalent regex and command-building changes remove scanner false positives without changing execution permissions or trigger behavior.

Validated with 155 tests, catalog manifest and icon checks, a mirrored-bundle startup check, and both plugin scanners with no high or critical findings. Existing Codex and Claude Code end-to-end checks pass on Linux and macOS.

## 0.0.2 (2026-10-13)

Self-Starter now works in Claude Code too, with the same triggers, background service and command line.

```
/plugin install self-starter --marketplace hyprh/self-starter
```

- **Fires come back to your session, between turns.** While a terminal has the session open, the fire arrives there as soon as Claude is done with what it is doing, however long that takes (it never interrupts a turn; after you stop Claude with Esc, which no hook reports, it arrives once the session has been quiet for 15 minutes). The plugin's MCP server posts it inside that session, so Claude Code delivers it in every permission mode. When no terminal has it open, Self-Starter resumes the session in the background (`claude -p --resume`), in its folder, with a permission mode from the trigger's `action.sandbox`. Triggers of their own get a session named "Trigger: <name>".
- **Fires report while you are away.** The plugin lets its tools that report a fire, make a trigger quieter or only read run without a permission prompt; creating, changing and deleting triggers still ask.
- **The plugin follows your sessions.** Its hooks record which session each Claude Code process shows (through `/clear` and `/resume`), whether a turn is running there, and whether a fire started it: such a turn cannot create or change triggers, except to make that trigger quieter.
- **A slow first start no longer fails.** The plugin installs its runtime in a process of its own, which finishes even if the host stops waiting. When that takes longer than Claude Code waits (30 seconds), the plugin answers anyway, and its tools appear once it is ready.
- **`self-starter install` sets up every agent it finds**, Codex and Claude Code, and `self-starter doctor` checks each. A `claude` installed with npm runs with Self-Starter's own node, like `codex`, so the background service needs no node on its PATH.

Checked by unit tests, and end to end with the real Claude Code CLI and a stand-in model (`test/e2e/cc-agent.ts`): installing from the marketplace, answering permission prompts as a user would, a fire waiting for the user's turn and then coming into the open session, and fires in closed sessions and in a trigger's own session.

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
