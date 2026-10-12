#!/usr/bin/env bash
# Step 4 (H7): deep links into the Codex app.
#   a) codex://threads/<id>                      opens an existing thread
#   b) codex://threads/new?prompt=...&path=...   opens a new thread with a prefilled prompt
set -euo pipefail
source "$(dirname "$0")/lib.sh"

thread_id="${1:-$(last_thread_id)}"
[ -n "$thread_id" ] || die "No thread id. Pass one as the first argument or finish step 1 first."

echo "## H7 deep links" >>"$RESULTS_FILE"

if [ "$OS" != "Darwin" ] && [ -z "$(codex_link_handler)" ]; then
  warn "No app is registered for codex:// links on this system, so deep links cannot be tested."
  record "H7 deep links: no codex:// handler registered"
  exit 0
fi

info "a) Opening codex://threads/$thread_id"
if open_url "codex://threads/$thread_id"; then
  answer="$(ask_yes_no "Did the Codex app open that exact thread?")"
else
  warn "The link could not be opened."
  answer="no"
fi
record "H7a open existing thread via codex://threads/<id>: $answer"

project="$(cd "$SPIKE_ROOT/.." && pwd)"
prompt="[codex-triggers spike] This text was prefilled by a deep link. Seeing it means H7b holds; no need to send it."
url="codex://threads/new?prompt=$(urlencode "$prompt")&path=$(urlencode "$project")"

info "b) Opening a new thread with a prefilled prompt"
echo "   $url"
if open_url "$url"; then
  answer="$(ask_yes_no "Did a new thread open with the prompt prefilled (not sent)?")"
  record "H7b new thread with prefilled prompt: $answer"
  answer="$(ask_yes_no "Was the new thread's workspace $project?")"
  record "H7b path parameter selects the workspace: $answer"
else
  warn "The link could not be opened."
  record "H7b new thread with prefilled prompt: could not open the link"
fi

ok "Deep link results recorded."
