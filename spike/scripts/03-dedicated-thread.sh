#!/usr/bin/env bash
# Step 3 (H6, H9): create a thread outside Desktop with `codex exec`, the way
# the engine would create a dedicated thread. Then check that Desktop shows it,
# that `codex queue` can deliver into it, and what Desktop shows when another
# process runs a turn in a thread that Desktop has open.
# Usage: 03-dedicated-thread.sh [project-dir]   (defaults to this repository)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

CODEX="$(find_codex)"
project="$(cd "${1:-$SPIKE_ROOT/..}" && pwd)"

echo "## H6/H9 thread created outside Desktop" >>"$RESULTS_FILE"

seed="[codex-triggers spike] This thread was created by codex exec as a stand-in for a dedicated thread. Reply only with: dedicated thread created."
info "Creating a thread with codex exec in $project (read-only sandbox)"
events="$("$CODEX" exec --json --skip-git-repo-check -s read-only -C "$project" "$seed" </dev/null 2>/dev/null || true)"
thread_id="$(printf '%s\n' "$events" |
  sed -n 's/.*"type":"thread.started","thread_id":"\([^"]*\)".*/\1/p' | head -n 1)"
[ -n "$thread_id" ] || die "Could not read thread_id from codex exec --json output."
echo "$thread_id" >"$SPIKE_DIR/dedicated_thread_id"
ok "thread: $thread_id"
record "H6 thread created by codex exec: $thread_id"
if printf '%s\n' "$events" | grep -q '"type":"turn.completed"'; then
  ok "The exec turn completed."
else
  warn "The exec turn did not complete. Last events:"
  printf '%s\n' "$events" | tail -n 3
fi

echo "In Codex Desktop, open the project $project and look at its thread list."
answer="$(ask_yes_no "Does the new thread appear in the list?")"
record "H6a exec-created thread listed in Desktop: $answer"

info "Opening codex://threads/$thread_id"
open "codex://threads/$thread_id"
answer="$(ask_yes_no "Did Desktop open it, showing the seed message and the reply?")"
record "H6b deep link opens the exec-created thread: $answer"

# Desktop now has the thread loaded, so its queue watcher should pick this up.
info "Queueing a message into it (keep the thread open in Desktop)"
msg="[codex-triggers spike: dedicated-queue] This is the second message, delivered into the dedicated thread. Reply only with: got dedicated-queue."
out="$("$CODEX" queue --thread "$thread_id" --message "$msg" </dev/null 2>&1)" || warn "codex queue exited with an error"
echo "$out"
record "H6c codex queue output: $(echo "$out" | tr '\n' ' ')"
answer="$(ask_yes_no "Within ~30 seconds, did the queued message appear in Desktop and get an answer?")"
record "H6c queue into the exec-created thread works in Desktop: $answer"

# H9: a headless executor (codex exec resume) writes a turn while Desktop has
# the thread open. This only touches the test thread created above.
info "Running a turn in that thread from the terminal (codex exec resume)"
msg="[codex-triggers spike: exec-resume] This message was sent by codex exec resume from a terminal. Reply only with: got exec-resume."
"$CODEX" exec resume --skip-git-repo-check "$thread_id" "$msg" </dev/null >/dev/null 2>&1 || warn "codex exec resume exited with an error"
answer="$(ask_yes_no "Did that exchange show up in the open Desktop thread without reopening it?")"
record "H9a turn written by another process appears live in Desktop: $answer"
if [ "$answer" = "no" ]; then
  answer="$(ask_yes_no "Switch to another thread and back. Does it show up now?")"
  record "H9a turn written by another process appears after reopening: $answer"
fi
answer="$(ask_yes_no "Does the thread look intact (no errors, no missing or duplicated messages)?")"
record "H9b thread intact after a write from another process: $answer"

ok "Results recorded. Next: spike/scripts/04-deeplink.sh"
