#!/usr/bin/env bash
# Thin wrapper over `codex exec` so a multi-turn conversation with Codex is one
# command per turn instead of a jq incantation.
#
#   ask   -> starts a thread, prints the thread id you need for the next turn
#   reply -> continues that thread (Codex keeps its own context; you only send
#            what is new)
#
# Output is three blocks: a compact activity log (what Codex actually ran), the
# final message, and the metadata you need to continue or debug.

set -uo pipefail

MODE=""
SANDBOX="read-only"
EFFORT="xhigh"
MODEL="gpt-6-astra"
WORKDIR="$PWD"
LOG=""
THREAD=""
BRIEF=""
NETWORK=0

# Caller-supplied paths are resolved here, before the `cd` below, so a relative
# --log or brief still means what the caller meant.
abspath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$PWD/$1" ;; esac; }

usage() {
  cat <<'EOF'
Usage:
  codex-chat.sh ask   [options] <brief-file>
  codex-chat.sh reply [options] <thread-id> <brief-file>

Options:
  --sandbox MODE   read-only | workspace-write | danger-full-access  (default: read-only)
  --network        allow network under workspace-write (off by default there)
  --effort LEVEL   low | medium | high | xhigh                       (default: xhigh)
  --model NAME     model to run                                      (default: gpt-6-astra)
  --cwd DIR        repo root Codex works in                          (default: $PWD)
  --log FILE       raw JSONL log path                                (default: temp file)

The brief is a file; the script feeds it to Codex on stdin, so it can be any
length and needs no shell quoting.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    ask|reply) MODE="$1"; shift ;;
    --network) NETWORK=1; shift ;;
    --sandbox|--effort|--model|--cwd|--log)
      # set -u would turn a trailing flag into an unbound-variable crash.
      [ $# -ge 2 ] || { echo "missing value for $1" >&2; exit 2; }
      case "$1" in
        --sandbox) SANDBOX="$2" ;;
        --effort)  EFFORT="$2" ;;
        --model)   MODEL="$2" ;;
        --cwd)     WORKDIR="$2" ;;
        --log)     LOG="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ "$MODE" = "reply" ] && [ -z "$THREAD" ]; then THREAD="$1"
      else BRIEF="$1"; fi
      shift ;;
  esac
done

[ -n "$MODE" ] || { echo "missing mode (ask|reply)" >&2; usage >&2; exit 2; }
[ -n "$BRIEF" ] || { echo "missing brief file" >&2; usage >&2; exit 2; }
[ -r "$BRIEF" ] || { echo "brief file not readable: $BRIEF" >&2; exit 2; }
[ -d "$WORKDIR" ] || { echo "cwd not a directory: $WORKDIR" >&2; exit 2; }
if [ "$MODE" = "reply" ] && [ -z "$THREAD" ]; then
  echo "reply needs a thread id (printed by a previous ask)" >&2; exit 2
fi

command -v codex >/dev/null || { echo "codex CLI not found in PATH" >&2; exit 127; }
command -v jq    >/dev/null || { echo "jq not found in PATH" >&2; exit 127; }

RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
BRIEF="$(abspath "$BRIEF")"
WORK="$(abspath "${CODEX_CHAT_DIR:-${TMPDIR:-/tmp}/codex-chat}")"
mkdir -p "$WORK"
if [ -n "$LOG" ]; then LOG="$(abspath "$LOG")"; else LOG="$WORK/$RUN_ID.jsonl"; fi
LAST="$WORK/$RUN_ID.last.md"
ERR="$WORK/$RUN_ID.err"

# `resume` has no -s/--sandbox flag, so the sandbox goes through -c in both
# paths to keep one code path honest.
COMMON=(-m "$MODEL"
        -c "sandbox_mode=$SANDBOX"
        -c "model_reasoning_effort=$EFFORT"
        --json --skip-git-repo-check
        -o "$LAST")
[ "$NETWORK" -eq 1 ] && COMMON+=(-c "sandbox_workspace_write.network_access=true")

cd "$WORKDIR" || exit 2

echo "=== codex activity (${MODE}, sandbox=${SANDBOX}, effort=${EFFORT}) ==="

if [ "$MODE" = "ask" ]; then
  codex exec "${COMMON[@]}" - < "$BRIEF" 2>"$ERR"
else
  codex exec resume "$THREAD" "${COMMON[@]}" - < "$BRIEF" 2>"$ERR"
fi | tee "$LOG" | jq -r --unbuffered '
    if .type == "thread.started" then "· thread \(.thread_id)"
    elif .type == "turn.failed" then "· TURN FAILED: \(.error // . | tostring)"
    elif .type == "turn.completed" then
      "· tokens in=\(.usage.input_tokens // "?") out=\(.usage.output_tokens // "?")"
    elif .type == "item.completed" and .item.type == "command_execution" then
      "· $ \((.item.command // "") | tostring | .[0:160]) → exit \(.item.exit_code // "?")"
    elif .type == "item.completed" and .item.type == "agent_message" then
      "· message (\((.item.text // "") | length) chars)"
    elif .type == "item.completed" then
      "· \(.item.type): \((.item.path // .item.title // .item.text // "") | tostring | .[0:160])"
    else empty end' 2>/dev/null

STATUS="${PIPESTATUS[0]}"

echo
echo "=== codex reply ==="
if [ -s "$LAST" ]; then
  cat "$LAST"
else
  # -o can come back empty if the turn died mid-flight; salvage from the log.
  jq -rs 'map(select(.type=="item.completed" and .item.type=="agent_message"))
          | if length > 0 then last.item.text else "(no reply — see stderr below)" end' "$LOG" 2>/dev/null \
    || echo "(no reply — see stderr below)"
fi

THREAD_ID="$(jq -r 'select(.type=="thread.started") | .thread_id' "$LOG" 2>/dev/null | head -1)"
[ -n "$THREAD_ID" ] || THREAD_ID="$THREAD"

echo
echo "=== meta ==="
echo "thread_id: ${THREAD_ID:-unknown}"
echo "log: $LOG"
echo "exit: $STATUS"
if [ "$STATUS" -ne 0 ] || [ ! -s "$LAST" ]; then
  echo "--- stderr ---"
  tail -20 "$ERR" 2>/dev/null
fi

exit "$STATUS"
