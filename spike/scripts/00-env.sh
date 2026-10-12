#!/usr/bin/env bash
# Step 0: check the machine and record versions.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

: >"$RESULTS_FILE"
{
  echo "# codex-triggers spike results"
  echo
  echo "## Environment"
} >>"$RESULTS_FILE"

case "$OS" in
  Darwin) os_name="macOS $(sw_vers -productVersion)" ;;
  Linux) os_name="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}" || echo Linux)" ;;
  *) die "Unsupported system: $OS. The spike runs on macOS or Linux." ;;
esac
info "$os_name ($(uname -m))"
record "OS: $os_name ($(uname -m))"

CODEX="$(find_codex)"
CODEX_VERSION="$("$CODEX" --version 2>/dev/null | tail -n 1)"
ok "codex: $CODEX ($CODEX_VERSION)"
record "codex CLI: $CODEX ($CODEX_VERSION)"

app="$(find_app)"
if [ -n "$app" ]; then
  ok "Codex app: $app"
  record "Codex app: $app"
else
  warn "No Codex desktop app found. You can still run the spike with the codex terminal UI."
  record "Codex app: not found (terminal UI only)"
fi

handler="$(codex_link_handler)"
if [ "$OS" != "Darwin" ]; then
  record "codex:// link handler: ${handler:-none}"
  [ -n "$handler" ] && ok "codex:// links open with: $handler" || warn "No handler registered for codex:// links."
fi

if command -v node >/dev/null 2>&1; then
  ok "node: $(command -v node) ($(node --version))"
  record "node: $(command -v node) ($(node --version))"
else
  die "node is required by the test MCP server. Install Node.js and rerun."
fi

info "Daemon status (codex app-server daemon version)"
daemon="$("$CODEX" app-server daemon version 2>&1 | head -n 3 || true)"
echo "$daemon"
record "app-server daemon version: $(echo "$daemon" | tr '\n' ' ')"

# Shows whether the app runs its own app-server or talks to the shared daemon.
info "Running app-server processes (start the Codex app first)"
processes="$(list_processes | grep -i '[a]pp-server' | sed "s#$HOME#~#g" || true)"
echo "${processes:-none}"
record "app-server processes: $(echo "${processes:-none}" | tr '\n' ';')"

info "Relevant feature flags"
features="$("$CODEX" features list 2>/dev/null | grep -E '^(plugins|hooks|daemon_auto_start|tool_call_mcp_elicitation|in_app_local_automation|mcp_2026_07_28) ' || true)"
echo "$features"
record "features: $(echo "$features" | tr -s ' ' | tr '\n' ';')"

ok "Environment recorded in $RESULTS_FILE"
