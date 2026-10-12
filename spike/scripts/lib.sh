# Shared helpers for the spike scripts. Sourced, not executed.
# Written for the bash 3.2 that ships with macOS.

SPIKE_DIR="${CODEX_TRIGGERS_SPIKE_DIR:-$HOME/.codex-triggers-spike}"
SPIKE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKETPLACE_DIR="$SPIKE_ROOT/marketplace"
RESULTS_FILE="$SPIKE_DIR/results.md"

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

# Finds a codex binary: $CODEX_BIN, then PATH, then inside Codex.app.
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
  local app candidate
  for app in "/Applications/Codex.app" "$HOME/Applications/Codex.app"; do
    [ -d "$app" ] || continue
    candidate="$(find "$app/Contents" -maxdepth 4 -type f -name codex -perm -u+x 2>/dev/null | head -n 1)"
    if [ -n "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  die "codex not found. Install the CLI (npm i -g @openai/codex) or set CODEX_BIN."
}

# Percent-encodes $1. Uses JavaScript for Automation, which every macOS has.
urlencode() {
  osascript -l JavaScript -e 'function run(argv) { return encodeURIComponent(argv[0]); }' "$1"
}

# Reads the thread id recorded by the spike_record_thread tool. Falls back to
# the threadId Codex attached to the latest MCP tool call (_meta), in case the
# Desktop shell did not expose CODEX_THREAD_ID.
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
