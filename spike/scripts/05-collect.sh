#!/usr/bin/env bash
# Step 5: put the answers and the MCP log summary into one report to paste back.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

report="$SPIKE_DIR/report.md"
{
  cat "$RESULTS_FILE" 2>/dev/null || echo "(no results recorded yet)"
  echo
  echo "## MCP server log"
  echo
  echo '```'
  node "$SPIKE_ROOT/scripts/summarize-log.mjs" "$SPIKE_DIR/mcp.log.jsonl"
  echo '```'
} >"$report"

if pbcopy <"$report" 2>/dev/null; then
  ok "Report copied to the clipboard."
fi
ok "Report: $report"
echo "Paste it back into the conversation. Paths under your home folder are shown as ~."
