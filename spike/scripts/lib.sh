# Shared helpers for the spike scripts. Sourced, not executed.
# Works with the bash 3.2 that ships with macOS and with bash on Linux.

SPIKE_DIR="${CODEX_TRIGGERS_SPIKE_DIR:-$HOME/.codex-triggers-spike}"
SPIKE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKETPLACE_DIR="$SPIKE_ROOT/marketplace"
RESULTS_FILE="$SPIKE_DIR/results.md"
OS="$(uname -s)"

mkdir -p "$SPIKE_DIR"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mERR\033[0m %s\n' "$*" >&2
  exit 1
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Appends a line to the results file, so the user can paste one file back.
record() {
  printf -- '- [%s] %s\n' "$(now)" "$*" >>"$RESULTS_FILE"
}

# Prompts until the user answers y or n; echoes "yes" or "no".
# Echoes "no" if input runs out, so the scripts cannot spin forever.
ask_yes_no() {
  local answer
  while true; do
    printf '%s [y/n] ' "$1" >&2
    if ! read -r answer; then
      echo no
      return
    fi
    case "$answer" in
      y | Y) echo yes; return ;;
      n | N) echo no; return ;;
    esac
  done
}

# macOS app bundles that may ship Codex: the Codex app, or the ChatGPT app.
mac_app_bundles() {
  echo "/Applications/Codex.app"
  echo "$HOME/Applications/Codex.app"
  echo "/Applications/ChatGPT.app"
  echo "$HOME/Applications/ChatGPT.app"
}

# Finds a codex binary: $CODEX_BIN, then PATH, then inside a macOS app bundle.
find_codex() {
  if [ -n "${CODEX_BIN:-}" ]; then
    [ -x "$CODEX_BIN" ] || die "CODEX_BIN=$CODEX_BIN is not executable"
    echo "$CODEX_BIN"
    return
  fi
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return
  fi
  if [ "$OS" = "Darwin" ]; then
    local app candidate
    for app in $(mac_app_bundles); do
      [ -d "$app" ] || continue
      candidate="$(find "$app/Contents" -maxdepth 4 -type f -name codex -perm -u+x 2>/dev/null | head -n 1)"
      if [ -n "$candidate" ]; then
        echo "$candidate"
        return
      fi
    done
  fi
  die "codex not found. Install the CLI (npm i -g @openai/codex) or set CODEX_BIN."
}

# Describes the installed Codex app, or prints nothing.
#   macOS: Codex.app, or ChatGPT.app, which also ships Codex.
#   Linux: the ChatGPT desktop app, which ships Codex as a preview since August 2026.
find_app() {
  local app version entry
  if [ "$OS" = "Darwin" ]; then
    for app in $(mac_app_bundles); do
      [ -d "$app" ] || continue
      version="$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo unknown)"
      echo "$app ($version)"
      return
    done
    return
  fi
  for entry in /usr/share/applications/*.desktop "$HOME/.local/share/applications"/*.desktop; do
    [ -f "$entry" ] || continue
    if grep -qiE '^Name=.*(chatgpt|codex)' "$entry"; then
      echo "$entry"
      return
    fi
  done
}

# Opens a URL with the system handler; returns non-zero if it could not.
open_url() {
  if [ "$OS" = "Darwin" ]; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

# Names the app registered for codex:// links. Linux only; prints nothing on
# macOS, which has no simple way to ask.
codex_link_handler() {
  if [ "$OS" != "Darwin" ] && command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime query default x-scheme-handler/codex 2>/dev/null || true
  fi
}

# Percent-encodes $1.
urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

# Copies stdin to the clipboard; returns non-zero when no clipboard tool exists.
copy_to_clipboard() {
  if command -v pbcopy >/dev/null 2>&1; then
    pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then
    wl-copy
  elif command -v xclip >/dev/null 2>&1; then
    xclip -selection clipboard
  elif command -v xsel >/dev/null 2>&1; then
    xsel --clipboard --input
  else
    return 1
  fi
}

# Lists running processes with their parent and full command line.
list_processes() {
  if [ "$OS" = "Darwin" ]; then
    ps -axo pid,ppid,command
  else
    ps -eo pid,ppid,args
  fi
}

# How to fully quit the Codex app on this system, for prompts.
if [ "$OS" = "Darwin" ]; then
  QUIT_APP="Quit the Codex app completely (Cmd+Q)"
else
  QUIT_APP="Quit the Codex app completely (also from the system tray, if it stays there)"
fi
QUIT_APP="$QUIT_APP; if you use the codex terminal UI instead, exit it"

# Reads the thread id recorded by the spike_record_thread tool. Falls back to
# the threadId Codex attached to the latest MCP tool call (_meta), in case the
# app's shell did not expose CODEX_THREAD_ID.
last_thread_id() {
  if [ -f "$SPIKE_DIR/last_thread_id" ]; then
    tr -d '[:space:]' <"$SPIKE_DIR/last_thread_id"
    return
  fi
  [ -f "$SPIKE_DIR/mcp.log.jsonl" ] || return 0
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    const ids = lines.map((l) => JSON.parse(l)).filter((e) => e.kind === "tools_call")
      .map((e) => e.callMeta && e.callMeta.threadId).filter(Boolean);
    if (ids.length) process.stdout.write(ids[ids.length - 1]);
  ' "$SPIKE_DIR/mcp.log.jsonl"
}
