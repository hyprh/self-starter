#!/usr/bin/env bash
# Step 0: check the machine and record versions.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ "$(uname -s)" = "Darwin" ] || die "The spike targets Codex Desktop on macOS."

: >"$RESULTS_FILE"
{
  echo "# codex-triggers spike results"
  echo
  echo "## Environment"
} >>"$RESULTS_FILE"

info "macOS $(sw_vers -productVersion)"
record "macOS $(sw_vers -productVersion) ($(uname -m))"

CODEX="$(find_codex)"
CODEX_VERSION="$("$CODEX" --version 2>/dev/null | tail -n 1)"
ok "codex: $CODEX ($CODEX_VERSION)"
record "codex CLI: $CODEX ($CODEX_VERSION)"

desktop=""
for app in "/Applications/Codex.app" "$HOME/Applications/Codex.app"; do
  if [ -d "$app" ]; then
    desktop="$app"
    break
  fi
done
if [ -n "$desktop" ]; then
  desktop_version="$(defaults read "$desktop/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo unknown)"
  ok "Codex Desktop: $desktop ($desktop_version)"
  record "Codex Desktop: $desktop ($desktop_version)"
else
  warn "Codex Desktop not found in /Applications or ~/Applications"
  record "Codex Desktop: not found"
fi

if command -v node >/dev/null 2>&1; then
  ok "node: $(command -v node) ($(node --version))"
  record "node: $(command -v node) ($(node --version))"
else
  die "node is required by the test MCP server. Install it (brew install node) and rerun."
fi

info "Daemon status (codex app-server daemon version)"
daemon="$("$CODEX" app-server daemon version 2>&1 || true)"
echo "$daemon"
record "app-server daemon version: $(echo "$daemon" | tr '\n' ' ')"

# Shows whether Desktop runs its own app-server or talks to the shared daemon.
info "Running app-server processes (start Codex Desktop first)"
processes="$(ps -axo pid,ppid,command | grep -i '[a]pp-server' | sed "s#$HOME#~#g" || true)"
echo "${processes:-none}"
record "app-server processes: $(echo "${processes:-none}" | tr '\n' ';')"

info "Relevant feature flags"
features="$("$CODEX" features list 2>/dev/null | grep -E '^(plugins|hooks|daemon_auto_start|tool_call_mcp_elicitation|in_app_local_automation|mcp_2026_07_28) ' || true)"
echo "$features"
record "features: $(echo "$features" | tr -s ' ' | tr '\n' ';')"

ok "Environment recorded in $RESULTS_FILE"
