#!/usr/bin/env bash
# statusline-docket.sh: a Claude Code status line that also keeps Docket's usage figure in sync.
#
# It prints one line (model, context used, and "7d: N%" when Claude Code reports your weekly
# limit). When the rounded weekly figure, or its reset time, differs from the last one sent, it
# also sends it to Docket in the background:
#   PUT $DOCKET_URL/api/usage  {"used_pct": N, "resets_at": "<ISO time>", "source": "statusline"}
# The status line never waits for the network: the request runs detached with a 5 s timeout,
# errors are ignored, and a failed send is retried on the next update.
#
# Fields read from the JSON that Claude Code pipes in (code.claude.com/docs/en/statusline):
#   model.display_name, context_window.used_percentage,
#   rate_limits.seven_day.used_percentage (0-100), rate_limits.seven_day.resets_at (epoch seconds).
# rate_limits is only present for claude.ai Pro and Max subscribers, and only after the first
# response in a session. Until it appears, the script prints the line and sends nothing.
#
# Install (Mac):
#   1. Copy the script somewhere stable and make it executable:
#        cp docket/scripts/statusline-docket.sh ~/.claude/statusline-docket.sh
#        chmod +x ~/.claude/statusline-docket.sh
#   2. Create ~/.claude/docket.env with these two lines (the token exactly as Render shows it,
#      not percent-encoded), then make it readable only by you:
#        DOCKET_URL=https://docket-t6dw.onrender.com
#        DOCKET_TOKEN=<your DOCKET_TOKEN>
#      chmod 600 ~/.claude/docket.env
#   3. Add this to ~/.claude/settings.json (keep whatever else is in the file):
#        "statusLine": { "type": "command", "command": "~/.claude/statusline-docket.sh" }
#   4. Try it by hand; it should print "Opus | ctx 8%" at once (no rate_limits, so nothing is sent):
#        echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":8}}' | ~/.claude/statusline-docket.sh
#      Then start Claude Code. After its first reply the status line ends in "7d: N%", and Docket's
#      Usage screen says "synced from Claude Code". If it doesn't, ~/.claude/docket-statusline.err
#      holds the last failure (the HTTP status, or 000 for no answer).
#
# Needs bash and curl, plus jq or node to read the JSON (without either it prints the model only).
# DOCKET_URL and DOCKET_TOKEN already set in the environment take precedence over the file.
# The last value sent is kept in ~/.claude/docket-statusline.last; delete it to force a resend.

input=$(cat)

conf="$HOME/.claude/docket.env"
last="$HOME/.claude/docket-statusline.last"
err="$HOME/.claude/docket-statusline.err"

# Read the two settings without executing the file.
unquote() {
  local v=${1%$'\r'}
  case $v in
    \"*\") v=${v#\"}; v=${v%\"} ;;
    \'*\') v=${v#\'}; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}
if [ -r "$conf" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line#export }
    case $line in
      DOCKET_URL=*) [ -n "${DOCKET_URL:-}" ] || DOCKET_URL=$(unquote "${line#DOCKET_URL=}") ;;
      DOCKET_TOKEN=*) [ -n "${DOCKET_TOKEN:-}" ] || DOCKET_TOKEN=$(unquote "${line#DOCKET_TOKEN=}") ;;
    esac
  done < "$conf"
fi

# One field per line: model, context %, weekly %, weekly reset (ISO). Empty when absent.
if command -v jq >/dev/null 2>&1; then
  fields=$(printf '%s' "$input" | jq -r '
    def pct: if type == "number" then (round | tostring) else "" end;
    [ (.model.display_name // "" | tostring),
      (.context_window.used_percentage | pct),
      (.rate_limits.seven_day.used_percentage | pct),
      (.rate_limits.seven_day.resets_at | if type == "number" then (floor | todate) else "" end)
    ] | .[]' 2>/dev/null)
elif command -v node >/dev/null 2>&1; then
  fields=$(printf '%s' "$input" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let j = {}; try { j = JSON.parse(s) || {}; } catch {}
      const num = v => typeof v === "number" && isFinite(v);
      const pct = v => num(v) ? String(Math.round(v)) : "";
      const w = (j.rate_limits || {}).seven_day || {};
      const iso = num(w.resets_at) ? new Date(Math.floor(w.resets_at) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
      process.stdout.write([String((j.model || {}).display_name || ""), pct((j.context_window || {}).used_percentage), pct(w.used_percentage), iso].join("\n") + "\n");
    });' 2>/dev/null)
else
  fields=$(printf '%s' "$input" | sed -n 's/.*"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi

{ read -r model; read -r ctx; read -r week; read -r resets; } <<EOF
$fields
EOF

# The status text comes first, so a slow or missing network never delays it.
out=${model:-Claude}
[ -n "$ctx" ] && out="$out | ctx $ctx%"
[ -n "$week" ] && out="$out | 7d: $week%"
printf '%s\n' "$out"

# Sync only when there is a weekly figure, a server to send it to, and something new.
[ -n "$week" ] && [ -n "${DOCKET_URL:-}" ] && [ -n "${DOCKET_TOKEN:-}" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
key="$week $resets"
[ "$(cat "$last" 2>/dev/null)" = "$key" ] && exit 0

# Written before sending so overlapping runs don't send the same value twice; removed on failure.
printf '%s\n' "$key" > "$last" 2>/dev/null
url="${DOCKET_URL%/}/api/usage"
body="{\"used_pct\":$week${resets:+,\"resets_at\":\"$resets\"},\"source\":\"statusline\"}"
(
  # The token goes to curl through its config on stdin, so it never shows in the process list.
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$DOCKET_TOKEN" |
    curl -sS -m 5 -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
      --data "$body" -K - "$url" 2>/dev/null)
  case $code in
    2??) rm -f "$err" ;;
    *) rm -f "$last"; printf '%s PUT %s -> %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$url" "${code:-000}" > "$err" ;;
  esac
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
