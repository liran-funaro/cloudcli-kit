#!/usr/bin/env bash
#
# litellm-cost.sh — the spend dashboard as a page, for the Cost tab.
#
# This is litellm-spend.sh with the terminal taken out: the same three queries
# and the same jq, rendering HTML instead of columns. It writes one standalone
# page and exits, so something else decides when to run it -- the launcher does
# once at start, and systemd/cloudcli-cost.timer does every few minutes.
#
# LITELLM-SPECIFIC, AND STAYS IN THIS KIT. A LiteLLM proxy's /user/daily/activity
# ledger is not something CloudCLI knows or should know about, so none of this
# belongs upstream; it is why the report is a file the app serves rather than a
# route the app implements.
#
# Why the ledger and not the key counters: a key's `spend` field is scoped to its
# budget cycle and vanishes with the key, so rotating a key or crossing a cycle
# boundary under-reports the real total. /user/daily/activity keeps history per
# key hash regardless. Counters are still shown, because they enforce the cap.
#
# Auth: the token is read from the environment (or --token-file) and passed to
# curl over stdin, so it never appears in `ps` output or in the page.
#
# Usage:
#   ./litellm-cost.sh                       # write the report, exit
#   ./litellm-cost.sh --out /tmp/cost.html  # somewhere other than the default
#   ./litellm-cost.sh --start 2026-01-01    # ledger window
#
# Environment (no paths are baked in):
#   ANTHROPIC_AUTH_TOKEN / LITELLM_TOKEN      virtual key (required)
#   ANTHROPIC_BASE_URL   / LITELLM_BASE_URL   proxy base URL (required)
#   LITELLM_TOKEN_FILE                        read the key from a file instead
#   SPEND_START                               ledger window start, default -365d
#   TIMEOUT                                   per-request seconds, default 45
#   CLOUDCLI_COST_OUT                         where to write the page
#   CLOUDCLI_PREFIX                           npm prefix, to derive that default
#
# Needs: bash, curl, jq.

set -uo pipefail

PREFIX="${CLOUDCLI_PREFIX:-$HOME/.npm-global}"
PKG="$PREFIX/lib/node_modules/@cloudcli-ai/cloudcli"
OUT="${CLOUDCLI_COST_OUT:-$PKG/dist/cost.html}"
TIMEOUT="${TIMEOUT:-45}"
BASE="${LITELLM_BASE_URL:-${ANTHROPIC_BASE_URL:-}}"
TOKEN="${LITELLM_TOKEN:-${ANTHROPIC_AUTH_TOKEN:-}}"
TOKEN_FILE="${LITELLM_TOKEN_FILE:-}"
START="${SPEND_START:-}"

usage() { sed -n '2,/^# Needs/p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)        OUT="${2:?--out needs a path}"; shift 2 ;;
    --start)      START="${2:?--start needs YYYY-MM-DD}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:?--token-file needs a path}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for dep in curl jq; do
  command -v "$dep" >/dev/null || { echo "error: '$dep' is required but not installed" >&2; exit 1; }
done
BASE="${BASE%/}"
[[ -n $START ]] || START="$(date -u -d '365 days ago' +%F)"

TMP="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP"' EXIT

TODAY="$(date -u +%F)"
D7="$(date -u -d '6 days ago' +%F)"
D30="$(date -u -d '29 days ago' +%F)"
NOW="$(date -u '+%Y-%m-%d %H:%M:%S')"

# ---------------------------------------------------------------- helpers

# Same definitions as litellm-spend.sh: money, percentages, compact counts.
JQ_LIB='
def d2: (. * 100 | round) as $c
  | (($c / 100) | floor | tostring) + "."
  + ((($c % 100) | tostring) | if length == 1 then "0" + . else . end);
def d3: (. * 1000 | round) as $c
  | (($c / 1000) | floor | tostring) + "."
  + ((($c % 1000) | tostring) as $f | ("000"[0:3 - ($f | length)]) + $f);
def pct: (. * 1000 | round) / 10;
def h:
  if   . >= 1000000000 then ((. / 1000000000 * 100 | round) / 100 | tostring) + "B"
  elif . >= 1000000    then ((. / 1000000 * 100 | round) / 100 | tostring) + "M"
  elif . >= 1000       then ((. / 1000 | round) | tostring) + "K"
  else tostring end;
def sum(f): (map(f) | add) // 0;
'

esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# TSV on stdin -> one HTML table. First row is the header unless --no-head is
# given, in which case every row is data and the first column labels it.
table() {
  local head=1
  [[ ${1:-} == --no-head ]] && head=0
  local first=1 cells html
  printf '<table>\n'
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    IFS=$'\t' read -r -a cells <<<"$line"
    html=''
    for cell in "${cells[@]}"; do
      if [[ $first -eq 1 && $head -eq 1 ]]; then
        html+="<th>$(printf '%s' "$cell" | esc)</th>"
      else
        # Money, percentages and counts read better right-aligned; the first
        # column is a label, so it stays left.
        if [[ ${#html} -gt 0 && $cell =~ ^(\$|[0-9]|—|-) ]]; then
          html+="<td class=\"n\">$(printf '%s' "$cell" | esc)</td>"
        else
          html+="<td>$(printf '%s' "$cell" | esc)</td>"
        fi
      fi
    done
    if [[ $first -eq 1 && $head -eq 1 ]]; then
      printf '<thead><tr>%s</tr></thead>\n<tbody>\n' "$html"
    else
      printf '<tr>%s</tr>\n' "$html"
    fi
    first=0
  done
  [[ $head -eq 1 ]] && printf '</tbody>\n'
  printf '</table>\n'
}

section() { printf '<section><h2>%s</h2>\n' "$(printf '%s' "$1" | esc)"; }
end_section() { printf '</section>\n'; }

read_token() {
  if [[ -n $TOKEN_FILE ]]; then
    [[ -r $TOKEN_FILE ]] || return 1
    tr -d '[:space:]' <"$TOKEN_FILE"
  else
    printf '%s' "$TOKEN"
  fi
}

# GET $1 into file $2. Token goes through stdin, never argv.
api() {
  local path="$1" out="$2" tok
  tok="$(read_token)" || { echo "cannot read token file: $TOKEN_FILE" >"$out.err"; return 1; }
  [[ -n $tok ]] || { echo "no token: set ANTHROPIC_AUTH_TOKEN or --token-file" >"$out.err"; return 1; }
  printf 'url = "%s"\nheader = "Authorization: Bearer %s"\nsilent\nshow-error\nmax-time = %s\n' \
    "${BASE}${path}" "$tok" "$TIMEOUT" \
    | curl --config - -o "$out" 2>"$out.err"
}

api_error() {
  [[ -s "$1.err" ]] && { tr -d '\n' <"$1.err"; return 0; }
  jq -er 'if type == "object"
          then (.error.message? // (if has("detail") then (.detail|tostring) else empty end))
          else empty end' "$1" 2>/dev/null
}

# The page's own styling. Custom properties with fallbacks, so it reads correctly
# standalone in a browser tab AND inside the app, whose theme sets `data-theme`
# on this document from the tab that frames it.
page_head() {
  cat <<'HTML'
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiteLLM spend</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e5e7eb;
    --card: #f9fafb; --accent: #1a759f; --warn: #b45309; --warn-bg: #fffbeb;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14161a; --fg: #e6e8ec; --muted: #9aa1ac; --line: #262a31;
      --card: #191c21; --accent: #56c1e8; --warn: #f0b429; --warn-bg: #2a2314;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14161a; --fg: #e6e8ec; --muted: #9aa1ac; --line: #262a31;
    --card: #191c21; --accent: #56c1e8; --warn: #f0b429; --warn-bg: #2a2314;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 18px 40px; background: var(--bg); color: var(--fg);
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header { border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: 4px; }
  h1 { margin: 0 0 2px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .sub b { color: var(--fg); font-weight: 500; }
  section { margin-top: 22px; }
  h2 {
    margin: 0 0 8px; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted);
  }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td {
    text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  th {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); border-bottom-color: var(--fg);
  }
  td.n { text-align: right; padding-right: 18px; font-family: ui-monospace, SFMono-Regular, monospace; }
  tbody tr:last-child td { border-bottom: 0; }
  tr:hover td { background: var(--card); }
  .warn {
    margin: 10px 0 0; padding: 8px 12px; list-style: none;
    border: 1px solid var(--warn); border-radius: 8px;
    background: var(--warn-bg); color: var(--warn); font-size: 12px;
  }
  .fail {
    margin: 24px 0; padding: 12px 14px; border: 1px solid var(--warn);
    border-radius: 8px; background: var(--warn-bg); color: var(--warn);
  }
  .fail code { font-family: ui-monospace, monospace; word-break: break-all; }
  footer { margin-top: 28px; color: var(--muted); font-size: 11px; }
</style>
<script>
  // The tab tells the page which way the app is themed; standalone, the browser does.
  var t = new URLSearchParams(location.search).get('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
</script>
HTML
}

# ---------------------------------------------------------------- fetch

api "/user/info" "$TMP/user.json"
api "/key/list?return_full_object=true&size=100" "$TMP/keys.json"   # 100 is the API max
api "/user/daily/activity?start_date=${START}&end_date=${TODAY}&page_size=1000" "$TMP/day.json"

FAIL=""
for f in user keys day; do
  msg="$(api_error "$TMP/$f.json")" && [[ -n $msg ]] && { FAIL="$msg"; break; }
done
[[ -n $BASE ]] || FAIL="set LITELLM_BASE_URL or ANTHROPIC_BASE_URL"

# ---------------------------------------------------------------- render

render() {
  page_head
  printf '<header>\n<h1>LiteLLM spend</h1>\n'
  printf '<div class="sub">%s · generated <b>%s UTC</b>' \
    "$(printf '%s' "${BASE#https://}" | esc)" "$NOW"
  if [[ -z $FAIL ]]; then
    printf ' · ledger window %s → %s' "$START" "$TODAY"
  fi
  printf '</div>\n</header>\n'

  if [[ -n $FAIL ]]; then
    printf '<div class="fail"><b>Could not read the proxy.</b><br><code>%s</code></div>\n' \
      "$(printf '%s' "$FAIL" | esc)"
    printf '<footer>litellm-cost.sh · retried on the next timer tick</footer>\n'
    return
  fi

  section 'Account'
  jq -r "$JQ_LIB"'
    ["account", (.user_info.user_email // "?")],
    ["role", (.user_info.user_role // "?")],
    ["cycle counter", "$" + ((.user_info.spend // 0) | d2)]
    | @tsv
  ' "$TMP/user.json" | table --no-head
  end_section

  section 'Totals'
  jq -r --arg today "$TODAY" --arg d7 "$D7" --arg d30 "$D30" "$JQ_LIB"'
    (.results // []) as $r
    | (.metadata.total_spend // 0) as $life
    | [ ["lifetime (ledger)", "$" + ($life | d2), "since first activity in window"],
        ["today",             "$" + (($r | map(select(.date == $today)) | sum(.metrics.spend)) | d2), $today],
        ["last 7 days",       "$" + (($r | map(select(.date >= $d7))    | sum(.metrics.spend)) | d2),
                              "$" + ((($r | map(select(.date >= $d7))   | sum(.metrics.spend)) / 7)  | d2) + "/day"],
        ["last 30 days",      "$" + (($r | map(select(.date >= $d30))   | sum(.metrics.spend)) | d2),
                              "$" + ((($r | map(select(.date >= $d30))  | sum(.metrics.spend)) / 30) | d2) + "/day"]
      ][] | @tsv
  ' "$TMP/day.json" | table --no-head
  end_section

  section 'Keys — budget cycle counters'
  printf '<div class="scroll">\n'
  jq -r "$JQ_LIB"'
    ["KEY", "ALIAS", "SPEND", "CAP", "USED", "LEFT", "RESETS"],
    ( (.keys // [])
      | sort_by(-(.spend // 0))[]
      | (.spend // 0) as $s | (.max_budget // null) as $m
      | [ (.token // "?")[0:8] + "…",
          (.key_alias // "(no alias)"),
          "$" + ($s | d2),
          (if $m then "$" + ($m | d2) else "—" end),
          (if $m and $m > 0 then (($s / $m) | pct | tostring) + "%" else "—" end),
          (if $m then "$" + (($m - $s) | d2) else "—" end),
          ((.budget_reset_at // "—") | tostring | .[0:10])
        ] )
    | @tsv
  ' "$TMP/keys.json" | table
  printf '</div>\n'

  # Any key close to its cap is the thing that will actually break.
  local warns
  warns="$(jq -r "$JQ_LIB"'
    (.keys // [])
    | map(select((.max_budget // 0) > 0 and (.spend / .max_budget) >= 0.8))
    | sort_by(-(.spend / .max_budget))[]
    | (.key_alias // "(no alias)") + " is at "
      + ((.spend / .max_budget) | pct | tostring) + "% of its $"
      + (.max_budget | d2) + " cap ($" + ((.max_budget - .spend) | d2) + " left)"
  ' "$TMP/keys.json" | esc)"
  if [[ -n $warns ]]; then
    printf '<ul class="warn">\n'
    while IFS= read -r w; do [[ -n $w ]] && printf '<li>%s</li>\n' "$w"; done <<<"$warns"
    printf '</ul>\n'
  fi
  end_section

  section 'Keys — lifetime spend (ledger, survives rotation)'
  printf '<div class="scroll">\n'
  jq -r --slurpfile kl "$TMP/keys.json" "$JQ_LIB"'
    (reduce (($kl[0].keys // [])[]) as $k ({}; .[$k.token] = ($k.key_alias // "(no alias)"))) as $alias
    | [ .results[]? as $d
        | ($d.breakdown.api_keys // {} | to_entries[]
           | {k: .key, s: (.value.metrics.spend // 0), d: $d.date}) ]
    | group_by(.k)
    | map({k: .[0].k, s: sum(.s), first: (map(.d) | min), last: (map(.d) | max)})
    | (map(select(.s <= 0.005)) | length) as $zero
    | (map(select(.s > 0.005)) | sort_by(-.s)) as $paid
    | ( ["KEY", "ALIAS", "SPEND", "FIRST", "LAST"],
        ($paid[] | [ .k[0:8] + "…",
                     ($alias[.k] // "(rotated out / deleted)"),
                     "$" + (.s | d2), .first, .last ]),
        (if $zero > 0 then ["", "+ " + ($zero | tostring) + " keys with $0.00", "", "", ""] else empty end) )
    | @tsv
  ' "$TMP/day.json" | table
  printf '</div>\n'
  end_section

  section 'By model'
  printf '<div class="scroll">\n'
  jq -r "$JQ_LIB"'
    [ .results[]?.breakdown.models // {} | to_entries[] ]
    | group_by(.key)
    | map({m: .[0].key,
           s: sum(.value.metrics.spend // 0),
           r: sum(.value.metrics.api_requests // 0)})
    | (sum(.s)) as $tot
    | ( ["MODEL", "SPEND", "SHARE", "REQUESTS", "$/REQ"],
        ( sort_by(-.s)[]
          | select(.s > 0.005 or .r > 0)
          | [ .m,
              "$" + (.s | d2),
              (if $tot > 0 then (.s / $tot | pct | tostring) + "%" else "—" end),
              (.r | tostring),
              (if .r > 0 then "$" + ((.s / .r) | d3) else "—" end) ] ) )
    | @tsv
  ' "$TMP/day.json" | table
  printf '</div>\n'
  end_section

  section 'By month'
  printf '<div class="scroll">\n'
  jq -r "$JQ_LIB"'
    ( ["MONTH", "SPEND", "REQUESTS", "ACTIVE DAYS", "$/ACTIVE DAY"],
      ( (.results // [])
        | group_by(.date[0:7])
        | map({mo: .[0].date[0:7],
               s: sum(.metrics.spend // 0),
               r: sum(.metrics.api_requests // 0),
               n: length})
        | sort_by(.mo)[]
        | [ .mo, "$" + (.s | d2), (.r | tostring), (.n | tostring),
            (if .n > 0 then "$" + ((.s / .n) | d2) else "—" end) ] ) )
    | @tsv
  ' "$TMP/day.json" | table
  printf '</div>\n'
  end_section

  section 'Tokens and reliability'
  jq -r "$JQ_LIB"'
    .metadata as $m
    | ($m.total_prompt_tokens // 0) as $p
    | ($m.total_api_requests // 0) as $req
    | [ ["total tokens",   ($m.total_tokens // 0 | h), ""],
        ["prompt",         ($p | h), ""],
        ["completion",     ($m.total_completion_tokens // 0 | h), ""],
        ["cache read",     ($m.total_cache_read_input_tokens // 0 | h),
                           (if $p > 0 then (($m.total_cache_read_input_tokens // 0) / $p | pct | tostring) + "% of prompt" else "" end)],
        ["cache write",    ($m.total_cache_creation_input_tokens // 0 | h), ""],
        ["requests",       ($req | tostring), ""],
        ["failed",         ($m.total_failed_requests // 0 | tostring),
                           (if $req > 0 then (($m.total_failed_requests // 0) / $req | pct | tostring) + "%" else "" end)]
      ][] | @tsv
  ' "$TMP/day.json" | table --no-head
  end_section

  printf '<footer>litellm-cost.sh · lifetime figures come from the proxy ledger, '
  printf 'which survives key rotation; cycle counters are what enforce a cap.</footer>\n'
}

# A handful of numbers beside the page, for the always-visible chip in the
# sidebar: it wants today's figure sixty seconds fresh and nothing else, and
# parsing a report to find one number would tie the chip to the report's markup.
# Written only when the query succeeded -- a chip with no number says "—", which
# is honest, whereas a chip showing a zero would not be.
write_json() {
  local out="${OUT%.html}.json"
  [[ $out == "$OUT" ]] && out="$OUT.json"
  out="${CLOUDCLI_COST_JSON:-$out}"
  jq -n --arg gen "$NOW" --arg today "$TODAY" --arg d7 "$D7" --arg d30 "$D30" \
        --arg start "$START" --slurpfile day "$TMP/day.json" "$JQ_LIB"'
    ($day[0].results // []) as $r
    | { generated: $gen,
        window: {start: $start, end: $today},
        today:    (($r | map(select(.date == $today)) | sum(.metrics.spend)) | d2),
        last7:    (($r | map(select(.date >= $d7))    | sum(.metrics.spend)) | d2),
        last30:   (($r | map(select(.date >= $d30))   | sum(.metrics.spend)) | d2),
        lifetime: (($day[0].metadata.total_spend // 0) | d2) }
  ' >"$TMP/out.json" || return 1
  install -m 640 "$TMP/out.json" "$out"
}

# Written whole or not at all: the tab fetches this file on a timer of its own,
# and half a page is worse than a stale one.
mkdir -p "$(dirname "$OUT")" 2>/dev/null
render >"$TMP/out.html" || { echo "error: render failed" >&2; exit 1; }
install -m 640 "$TMP/out.html" "$OUT" || { echo "error: cannot write $OUT" >&2; exit 1; }
[[ -z $FAIL ]] && { write_json || echo "warning: could not write the json sidecar" >&2; }
[[ -n $FAIL ]] && { echo "wrote $OUT with an error notice: $FAIL" >&2; exit 1; }
echo "wrote $OUT"
