#!/usr/bin/env bash
# Removes what the spike installed: the plugin, the marketplace entry, the
# generated .mcp.json, the thread made by step 3, and optionally the results.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

CODEX="$(find_codex)"

"$CODEX" plugin remove trigger-spike@codex-triggers-spike || warn "Plugin was not installed."
"$CODEX" plugin marketplace remove codex-triggers-spike || warn "Marketplace was not registered."
rm -f "$MARKETPLACE_DIR/plugins/trigger-spike/.mcp.json"

if [ -f "$SPIKE_DIR/dedicated_thread_id" ]; then
  thread_id="$(tr -d '[:space:]' <"$SPIKE_DIR/dedicated_thread_id")"
  "$CODEX" archive "$thread_id" || warn "Could not archive thread $thread_id."
fi

if [ "$(ask_yes_no "Delete $SPIKE_DIR (results and logs)?")" = "yes" ]; then
  rm -rf "$SPIKE_DIR"
fi
ok "Spike removed. Restart Codex Desktop to unload the plugin."
