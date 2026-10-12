# Feasibility spike

Purpose: check, on your own machine, the hypotheses listed in section 11 of the [design](../docs/design.md). Nothing here creates a real trigger, and `99-uninstall.sh` removes everything afterwards.

Runs on macOS and Linux, with any of these as "the Codex app":

- Codex Desktop on macOS (or the ChatGPT desktop app, which also ships Codex)
- the ChatGPT desktop app on Linux, which ships Codex as a preview since August 2026
- the `codex` terminal UI, if you have no desktop app

## Already verified

These were verified on Linux with Codex CLI 0.162.1 and its app-server, so there is no need to test them again:

- The local marketplace registers, the plugin installs with `codex plugin add` (copied into `~/.codex/plugins/cache/...`), and the uninstall script cleans everything up.
- Codex starts both MCP servers from the plugin, with the installed plugin folder as their working directory; the skill shows up as `trigger-spike:run`.
- When a plugin tool is called through the app-server, `_meta` carries `threadId`.
- The confirmation dialog path works end to end: an elicitation request from the MCP server reaches the client as `mcpServer/elicitation/request`, and the client's answer makes it back to the server.
- The first line of `codex exec --json` output is `thread.started` with the thread ID.
- `codex queue` stores messages in the queue even when no background daemon is running.

Every script has also been run end to end with scripted answers. What the Codex app actually does can only be seen on your machine.

## What to check

| ID | What to confirm | Where |
|---|---|---|
| H1 | A plugin installed with the CLI is usable in the app | `01-install.sh` |
| H2 | The plugin's MCP server starts in the app, and whether bare `node` is found (the PATH question) | Running the skill in the app |
| H3 | The app shows the MCP confirmation dialog (elicitation) | Skill step 5 |
| H4 | Commands run in the app can read `CODEX_THREAD_ID` | Skill step 1 |
| H5 | What `codex queue` does with a thread that is idle, busy, or whose app is closed | `02-queue.sh` |
| H6 | Threads created by `codex exec` show up in the app and accept queued messages | `03-dedicated-thread.sh` |
| H7 | Deep links open a given thread, and open a new thread with a prefilled prompt | `04-deeplink.sh` |
| H8 | `_meta` of MCP tool calls carries `threadId` | Skill step 2 |
| H9 | How the app shows a thread it has open while another process writes to it | `03-dedicated-thread.sh` |

## Requirements

- macOS or Linux, with the Codex CLI installed. `codex` must be on your PATH; if it is not, point `CODEX_BIN` at it.
- One of the Codex apps listed above.
- Node, which the test MCP server needs.
- About 20 minutes.

## Steps

**Run every script in a normal terminal, not in a terminal inside Codex.** The Codex sandbox blocks files that `codex queue` needs. With the terminal UI, use a second terminal for the scripts.

0. Start the Codex app, then run `spike/scripts/00-env.sh` to record your environment.
1. Run `spike/scripts/01-install.sh` and restart the app when it asks. Then open any project in the app (terminal UI: run `codex` inside a project folder), start a new thread, and send `$trigger-spike:run` (or say "run the trigger spike").
2. Run `spike/scripts/02-queue.sh` to test delivering messages into that thread.
3. Run `spike/scripts/03-dedicated-thread.sh` to test a thread created outside the app (a stand-in for a dedicated thread).
4. Run `spike/scripts/04-deeplink.sh` to test deep links.
5. Run `spike/scripts/05-collect.sh`. It builds a report and copies it to the clipboard when it can; paste it back into the conversation.

To clean up, run `spike/scripts/99-uninstall.sh`.

## Notes

- Step 3 starts two very short conversations with `codex exec`, which uses a small amount of quota.
- On Linux, deep links only work if the app registers itself for `codex://` links. Step 0 records whether a handler exists, and step 4 skips itself when none does. Step 3 then falls back to `codex resume <id>`.
- With the terminal UI, threads can keep running in a shared background process after you exit, so "app closed" in step 2 may behave differently from a desktop app. That difference is useful to know too.
- In the report, paths under your home folder are shown as `~`. The report contains no secrets: the MCP server only records environment variables starting with `CODEX_`, masks anything that looks like a secret, and keeps only the identity fields of tool call `_meta`.
- If the app does not show the plugin's tools, check in this order:
  1. Run `node spike/scripts/mcp-selftest.mjs` to confirm the server itself works.
  2. Look at `~/.codex-triggers-spike/mcp.log.jsonl`. No `start` entry means the app never started the server.
- After changing the plugin, run `01-install.sh` again. Codex only refreshes its cached copy when the plugin version changes or the plugin is installed again.
