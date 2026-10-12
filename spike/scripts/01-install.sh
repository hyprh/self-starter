#!/usr/bin/env bash
# Step 1 (H1, H2): install the trigger-spike plugin from the local marketplace,
# then check that the Codex app picks it up.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

CODEX="$(find_codex)"
NODE="$(command -v node)" || die "node not found; run 00-env.sh first."
PLUGIN_DIR="$MARKETPLACE_DIR/plugins/trigger-spike"
MARKETPLACE_NAME="codex-triggers-spike"
PLUGIN_ID="trigger-spike@$MARKETPLACE_NAME"

echo "## H1/H2 plugin install" >>"$RESULTS_FILE"

# Two copies of the same server: one launched with an absolute node path, one
# with bare `node`, to learn whether the app's PATH can find node (H2b).
# cwd "." makes Codex start the server in the installed plugin folder.
info "Writing $PLUGIN_DIR/.mcp.json (node: $NODE)"
cat >"$PLUGIN_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "trigger_spike": {
      "command": "$NODE",
      "args": ["./mcp/server.mjs"],
      "cwd": ".",
      "env": { "TRIGGER_SPIKE_VARIANT": "absolute-node", "CODEX_TRIGGERS_SPIKE_DIR": "$SPIKE_DIR" },
      "startup_timeout_sec": 30
    },
    "trigger_spike_path": {
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "cwd": ".",
      "env": { "TRIGGER_SPIKE_VARIANT": "path-node", "CODEX_TRIGGERS_SPIKE_DIR": "$SPIKE_DIR" },
      "startup_timeout_sec": 30
    }
  }
}
EOF

info "Registering the local marketplace"
if out="$("$CODEX" plugin marketplace add "$MARKETPLACE_DIR" 2>&1)"; then
  echo "$out"
else
  echo "$out"
  case "$out" in
    *already*) warn "Marketplace already registered; continuing." ;;
    *) die "codex plugin marketplace add failed" ;;
  esac
fi

# `plugin add` copies the plugin into ~/.codex/plugins/cache, so rerunning this
# script is how changes to the plugin reach Codex.
info "Installing $PLUGIN_ID"
"$CODEX" plugin add "$PLUGIN_ID"
"$CODEX" plugin list --marketplace "$MARKETPLACE_NAME"
record "H1a CLI install of $PLUGIN_ID: ok"

cat <<EOF

Next, in the Codex app:
  1. $QUIT_APP. Then start it again, so it reloads plugins.
  2. Look for "Trigger Spike" in the app's plugin list (in the terminal UI, type /plugins).
EOF
printf 'Press Enter once the app has restarted... '
read -r _
answer="$(ask_yes_no "Does the app list the Trigger Spike plugin as installed?")"
record "H1b app lists the plugin installed via CLI: $answer"

cat <<'EOF'

Now run the in-app checks (H2, H3, H4, H8):
  1. Open any project folder in the app and start a new thread
     (terminal UI: run `codex` inside a project folder).
  2. Send:  $trigger-spike:run
     (or just say: run the trigger spike)
  3. Approve what it asks, and choose "Allow" if a confirmation dialog appears.
  4. Keep that thread open, then come back here and run:  spike/scripts/02-queue.sh
     (terminal UI: run it from a second terminal)
EOF
