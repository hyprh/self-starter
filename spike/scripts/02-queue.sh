#!/usr/bin/env bash
# Step 2 (H5): deliver messages into the Desktop thread with `codex queue`:
# while the thread is idle, while it is busy, and while Desktop is closed.
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
[ -n "$thread_id" ] || die "No thread id. Run \$trigger-spike:run in Desktop first (it records the id), or pass one."

queue() {
  local out
  out="$("$CODEX" queue --thread "$thread_id" --message "$1" </dev/null 2>&1)" || warn "codex queue exited with an error"
  echo "$out"
  record "$2 codex queue output: $(echo "$out" | tr '\n' ' ')"
}

echo "## H5 codex queue into a Desktop thread" >>"$RESULTS_FILE"
record "thread: $thread_id"

info "a) Idle thread"
echo "Open that thread in Codex Desktop and make sure it is not running anything."
printf 'Press Enter to queue a message... '
read -r _
queue "[codex-triggers spike: queue-idle] This message was delivered with codex queue. Reply only with: got queue-idle." H5a
echo "Watch Desktop for about 30 seconds (up to ~10 s delay is expected)."
answer="$(ask_yes_no "Did the message appear in the open thread without reopening it?")"
record "H5a message appears live in Desktop: $answer"
if [ "$answer" = "no" ]; then
  answer="$(ask_yes_no "Switch to another thread and back. Does it show up now?")"
  record "H5a message appears after reopening the thread: $answer"
fi
answer="$(ask_yes_no "Did Codex reply to it on its own, without you clicking anything?")"
record "H5a idle thread runs the queued message by itself: $answer"

info "b) Busy thread"
echo "In the same Desktop thread, send:  Run sleep 60 in the terminal, then reply done"
echo "(Approve the command if Desktop asks.)"
printf 'Press Enter as soon as sleep is running... '
read -r _
queue "[codex-triggers spike: queue-busy] This message was delivered while you were busy. Reply only with: got queue-busy." H5b
answer="$(ask_yes_no "Did the running turn continue without being interrupted?")"
record "H5b running turn not interrupted: $answer"
answer="$(ask_yes_no "After 'done', did Codex answer the queued message by itself?")"
record "H5b queued message runs after the current turn: $answer"

info "c) Desktop closed"
echo "Quit Codex Desktop completely (Cmd+Q)."
printf 'Press Enter once it has quit... '
read -r _
queue "[codex-triggers spike: queue-closed] This message was delivered while Desktop was closed. Reply only with: got queue-closed." H5c
echo "Now open Codex Desktop again and open the same thread."
answer="$(ask_yes_no "After opening the thread, did Codex answer the queued message by itself?")"
record "H5c message queued while Desktop was closed runs when the thread is opened: $answer"

ok "Queue results recorded. Next: spike/scripts/03-dedicated-thread.sh"
