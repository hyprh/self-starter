#!/usr/bin/env bash
# Step 4 (H7): deep links into Codex Desktop.
#   a) codex://threads/<id>                      opens an existing thread
#   b) codex://threads/new?prompt=...&path=...   opens a new thread with a prefilled prompt
set -euo pipefail
source "$(dirname "$0")/lib.sh"

thread_id="${1:-$(last_thread_id)}"
[ -n "$thread_id" ] || die "No thread id. Pass one as the first argument or finish step 1 first."

echo "## H7 deep links" >>"$RESULTS_FILE"

info "a) Opening codex://threads/$thread_id"
open "codex://threads/$thread_id"
answer="$(ask_yes_no "Did Codex Desktop open that exact thread?")"
record "H7a open existing thread via codex://threads/<id>: $answer"

project="$(cd "$SPIKE_ROOT/.." && pwd)"
prompt="[codex-triggers spike] This text was prefilled by a deep link. Seeing it means H7b holds; no need to send it."
url="codex://threads/new?prompt=$(urlencode "$prompt")&path=$(urlencode "$project")"

info "b) Opening a new thread with a prefilled prompt"
echo "   $url"
open "$url"
answer="$(ask_yes_no "Did a new thread open with the prompt prefilled (not sent)?")"
record "H7b new thread with prefilled prompt: $answer"
answer="$(ask_yes_no "Was the new thread's workspace $project?")"
record "H7b path parameter selects the workspace: $answer"

ok "Deep link results recorded."
