#!/usr/bin/env bash
# Step 2 (H5): deliver messages into the app's thread with `codex queue`:
# while the thread is idle, while it is busy, and while the app is closed.
#
# How codex queue works (from the Codex source): it stores the message in the
# shared queue in ~/.codex (queue_1.sqlite). Any Codex process that has the
# thread loaded checks that queue about every 10 seconds and runs the message
# once the thread is idle. If no process has the thread loaded, the message
# waits until the thread is opened again.
#
# Run this from a normal terminal, not from inside a Codex shell: the Codex
# sandbox blocks the files codex queue needs.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

CODEX="$(find_codex)"
thread_id="${1:-$(last_thread_id)}"
[ -n "$thread_id" ] || die "No thread id. Run \$trigger-spike:run in the app first (it records the id), or pass one."

queue() {
  local out
  out="$("$CODEX" queue --thread "$thread_id" --message "$1" </dev/null 2>&1)" || warn "codex queue exited with an error"
  echo "$out"
  record "$2 codex queue output: $(echo "$out" | tr '\n' ' ')"
}

echo "## H5 codex queue into the app's thread" >>"$RESULTS_FILE"
record "thread: $thread_id"

info "a) Idle thread"
echo "Open that thread in the Codex app and make sure it is not running anything."
printf 'Press Enter to queue a message... '
read -r _
queue "[codex-triggers spike: queue-idle] This message was delivered with codex queue. Reply only with: got queue-idle." H5a
echo "Watch the app for about 30 seconds (up to ~10 s delay is expected)."
answer="$(ask_yes_no "Did the message appear in the open thread without reopening it?")"
record "H5a message appears live in the app: $answer"
if [ "$answer" = "no" ]; then
  answer="$(ask_yes_no "Switch to another thread and back (terminal UI: exit and run codex resume). Does it show up now?")"
  record "H5a message appears after reopening the thread: $answer"
fi
answer="$(ask_yes_no "Did Codex reply to it on its own, without you doing anything?")"
record "H5a idle thread runs the queued message by itself: $answer"

info "b) Busy thread"
echo "In the same thread, send:  Run sleep 60 in the terminal, then reply done"
echo "(Approve the command if the app asks.)"
printf 'Press Enter as soon as sleep is running... '
read -r _
queue "[codex-triggers spike: queue-busy] This message was delivered while you were busy. Reply only with: got queue-busy." H5b
answer="$(ask_yes_no "Did the running turn continue without being interrupted?")"
record "H5b running turn not interrupted: $answer"
answer="$(ask_yes_no "After 'done', did Codex answer the queued message by itself?")"
record "H5b queued message runs after the current turn: $answer"

info "c) App closed"
echo "$QUIT_APP."
printf 'Press Enter once it has quit... '
read -r _
queue "[codex-triggers spike: queue-closed] This message was delivered while the app was closed. Reply only with: got queue-closed." H5c
echo "Now start the app again and open the same thread (terminal UI: codex resume $thread_id)."
answer="$(ask_yes_no "Had Codex already answered it, or did it answer by itself once the thread was open?")"
record "H5c message queued while the app was closed gets answered: $answer"

ok "Queue results recorded. Next: spike/scripts/03-dedicated-thread.sh"
