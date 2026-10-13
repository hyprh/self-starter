# Checking Self-Starter in the Codex app

CI covers everything up to the Codex app, on Linux and macOS: the install with launchd or systemd, the plugin registered with the real Codex CLI, probes, fires delivered with `codex queue`, threads woken through the app server (also after Codex was closed in the middle of a turn), receipts, and email. What only your machine can show is how the Codex desktop app itself behaves. That is four checks, about ten minutes, and `self-starter history` tells you the result of most of them.

Before you start: install as the [guide](guide.md#install) says, run `brew install terminal-notifier`, and restart the Codex app.

## 1. The app loads the plugin (H1)

In a new conversation, ask: "What Self-Starter triggers do I have?"

- Expected: Codex answers from the plugin (it calls `trigger_list` and says there are none yet), instead of guessing.
- If Codex does not know the tools: run `self-starter doctor`, then `self-starter install` again, and restart the app.

## 2. A fire reaches a conversation the app has open (H5)

In that conversation, say: "Tell me when the file /tmp/self-starter-demo/done appears, and what it says. Check every 10 seconds." Keep the conversation on screen, then in a terminal:

```sh
mkdir -p /tmp/self-starter-demo && echo "build finished in 4m12s" > /tmp/self-starter-demo/done
```

- Expected: within about 20 seconds Codex answers in the conversation, and `self-starter history` ends the fire's line with `(your thread, open in Codex)`.
- If it says `(your thread, opened in the background)` instead, the app did not run the queued message itself and Self-Starter ran it for you; the answer should still be in the conversation.
- If nothing happens and after 5 minutes you get "waiting for Codex in your thread", the app held the conversation without running the fire. Note it in your report.

## 3. An answer given while the app was closed shows up (H9)

Ask for a second trigger: "Tell me when /tmp/self-starter-demo/second appears. Check every 10 seconds." Quit the Codex app, then:

```sh
echo "tests passed" > /tmp/self-starter-demo/second
```

- Expected: within about a minute `self-starter history` shows `(your thread, opened in the background)`. Open the app and the conversation: the answer is there.
- Also try it with the app open on another conversation instead of quit.

## 4. Notifications open the conversation (H7)

Click the notification from step 2 or 3.

- Expected: the Codex app comes to the front with that conversation open.
- The same link by hand: `open "codex://threads/<thread id>"`, with the id that `self-starter list` shows for the trigger.

## Afterwards

Ask Codex to delete the demo triggers (or run `self-starter delete <id>`), and `rm -r /tmp/self-starter-demo`.

To report what you saw, paste `self-starter history` and `self-starter logs -n 40`, with a line per check.
