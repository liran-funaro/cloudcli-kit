#!/usr/bin/env bash
#
# litellm-cost.sh — the spend dashboard as a page, for the Cost tab.
#
# This is litellm-spend.sh with the terminal taken out: the same three queries
# and the same jq, rendering HTML instead of columns. It writes one standalone
# page and exits, so something else decides when to run it -- the launcher does
# once at start, and systemd/cloudcli-cost.timer does every few minutes.
#
# Two queries more than that script made, for the section it never had: the team,
# and every key billing against it rather than only yours. Both are optional --
# no team, or a proxy that refuses a member those endpoints, loses that section
# and nothing else. A member key cannot read another member's user record (403),
# so a key there is named by its alias and carries no cap or reset date.
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
#   LITELLM_TEAM_ID                           team to report on, default your first
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
#
# Alignment is decided per COLUMN, not per cell, and the header takes the same
# side as the column under it -- which is why the whole table is read before any
# of it is written. Deciding cell by cell was the bug that made a header sit left
# of its own numbers, and made a column ragged wherever one row said "—" and the
# next said "$12.34".
table() {
  local head=1
  [[ ${1:-} == --no-head ]] && head=0
  local -a rows=() cells
  local line
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    rows+=("$line")
  done
  [[ ${#rows[@]} -eq 0 ]] && { printf '<table></table>\n'; return; }

  # A column is numeric when every value in it is -- money, a count, a
  # percentage, a dash standing in for one -- ignoring blanks. Column 0 is the
  # label in every table here, so it stays left whatever it looks like.
  local -a numeric=()
  local first_data=$head cols=0 i cell
  for line in "${rows[@]}"; do
    IFS=$'\t' read -r -a cells <<<"$line"
    [[ ${#cells[@]} -gt $cols ]] && cols=${#cells[@]}
  done
  for ((i = 0; i < cols; i++)); do numeric[i]=$((i > 0 ? 1 : 0)); done
  local row_index=0
  for line in "${rows[@]}"; do
    if [[ $row_index -eq 0 && $head -eq 1 ]]; then row_index=1; continue; fi
    IFS=$'\t' read -r -a cells <<<"$line"
    for ((i = 1; i < cols; i++)); do
      cell="${cells[i]:-}"
      [[ -z $cell ]] && continue
      [[ $cell =~ ^(\$|[0-9]|—|-) ]] || numeric[i]=0
    done
    row_index=$((row_index + 1))
  done

  local html
  printf '<table>\n'
  row_index=0
  for line in "${rows[@]}"; do
    IFS=$'\t' read -r -a cells <<<"$line"
    html=''
    for ((i = 0; i < cols; i++)); do
      cell="$(printf '%s' "${cells[i]:-}" | esc)"
      local class=''
      [[ ${numeric[i]} -eq 1 ]] && class=' class="n"'
      if [[ $row_index -eq 0 && $head -eq 1 ]]; then
        html+="<th$class>$cell</th>"
      else
        html+="<td$class>$cell</td>"
      fi
    done
    if [[ $row_index -eq 0 && $head -eq 1 ]]; then
      printf '<thead><tr>%s</tr></thead>\n<tbody>\n' "$html"
    else
      printf '<tr>%s</tr>\n' "$html"
    fi
    row_index=$((row_index + 1))
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
  /* Both, and with the same padding, or the header's right edge sits 18px away
     from the right edge of the numbers it is supposed to label. Marking the
     header cell in the markup did nothing until this selector included it. */
  th.n, td.n { text-align: right; padding-right: 18px; }
  td.n { font-family: ui-monospace, SFMono-Regular, monospace; }
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
  .note {
    margin: 10px 0 0; max-width: 78ch; color: var(--muted); font-size: 11px; line-height: 1.6;
  }
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

# The team, for reference — every key that billed against it, not only yours.
# Best-effort and separate from the three above: a key with no team, or a proxy
# that does not let a member read team endpoints, still gets the whole report
# minus this one section. The team id comes from your own /user/info unless
# LITELLM_TEAM_ID names another.
TEAM="${LITELLM_TEAM_ID:-$(jq -r '(.teams // [])[0].team_id // empty' "$TMP/user.json" 2>/dev/null)}"
if [[ -n $TEAM ]]; then
  api "/team/info?team_id=${TEAM}" "$TMP/team.json"
  api "/team/daily/activity?start_date=${START}&end_date=${TODAY}&page_size=1000" "$TMP/teamday.json"
  # One unreadable endpoint drops the section rather than the report.
  for f in team teamday; do
    api_error "$TMP/$f.json" >/dev/null && { rm -f "$TMP/team.json" "$TMP/teamday.json"; break; }
  done
fi

FAIL=""
for f in user keys day; do
  msg="$(api_error "$TMP/$f.json")" && [[ -n $msg ]] && { FAIL="$msg"; break; }
done
[[ -n $BASE ]] || FAIL="set LITELLM_BASE_URL or ANTHROPIC_BASE_URL"

# ---------------------------------------------------------------- the cycle
#
# The budget cycle is the thing being tracked, so the report is arranged around
# it. Two figures describe it and they do not agree, which is worth stating once
# rather than papering over:
#
#   * the COUNTERS -- a key's `spend`, a team's `spend` -- are live, per request,
#     and are what the proxy enforces a cap against. These are the budget.
#   * the LEDGER -- /user/daily/activity, /team/daily/activity -- is aggregated
#     per UTC day, and is the only source for per-day or per-member figures.
#
# Summing the ledger from the cycle's start lands a few percent under the
# counter (batching, and requests the daily table does not count), and no choice
# of start date reconciles them -- checked across a week of candidate boundaries.
# So counters answer "how much of the budget is gone" and the ledger answers
# "where did it go", and each is labelled with which it is.
RESET_AT="$(jq -r '[(.team_info // .).budget_reset_at // empty] | first // empty' "$TMP/team.json" 2>/dev/null)"
CYCLE_DUR="$(jq -r '[(.team_info // .).budget_duration // empty] | first // empty' "$TMP/team.json" 2>/dev/null)"
# No team, or a team without a budget: fall back to whatever your own keys say.
[[ -n $RESET_AT ]] || RESET_AT="$(jq -r '[(.keys // [])[] | .budget_reset_at // empty] | max // empty' "$TMP/keys.json" 2>/dev/null)"
[[ -n $CYCLE_DUR ]] || CYCLE_DUR="$(jq -r '[(.keys // [])[] | .budget_duration // empty] | first // empty' "$TMP/keys.json" 2>/dev/null)"

CYCLE_START=""; CYCLE_END="${RESET_AT:0:10}"; CYCLE_DAYS=""; DAYS_IN=""; DAYS_LEFT=""
if [[ -n $CYCLE_END ]]; then
  # LiteLLM durations are "30d", "1mo", "24h", "60s"; only the coarse ones can
  # bound a day-grained window, and anything else leaves the window unstated.
  case "$CYCLE_DUR" in
    *mo) CYCLE_START="$(date -u -d "$CYCLE_END -${CYCLE_DUR%mo} month" +%F 2>/dev/null)" ;;
    *w)  CYCLE_START="$(date -u -d "$CYCLE_END -$((${CYCLE_DUR%w} * 7)) days" +%F 2>/dev/null)" ;;
    *d)  CYCLE_START="$(date -u -d "$CYCLE_END -${CYCLE_DUR%d} days" +%F 2>/dev/null)" ;;
  esac
fi
if [[ -n $CYCLE_START ]]; then
  CYCLE_DAYS=$(( ($(date -u -d "$CYCLE_END" +%s) - $(date -u -d "$CYCLE_START" +%s)) / 86400 ))
  DAYS_IN=$(( ($(date -u -d "$TODAY" +%s) - $(date -u -d "$CYCLE_START" +%s)) / 86400 + 1 ))
  DAYS_LEFT=$(( ($(date -u -d "$CYCLE_END" +%s) - $(date -u -d "$TODAY" +%s)) / 86400 ))
  (( DAYS_IN < 1 )) && DAYS_IN=1
  (( DAYS_LEFT < 0 )) && DAYS_LEFT=0
fi
D1="$(date -u -d '1 day ago' +%F)"

# ---------------------------------------------------------------- render

render() {
  page_head
  printf '<header>\n<h1>LiteLLM spend</h1>\n'
  printf '<div class="sub">%s · generated <b>%s UTC</b>' \
    "$(printf '%s' "${BASE#https://}" | esc)" "$NOW"
  if [[ -z $FAIL ]]; then
    if [[ -n $CYCLE_START ]]; then
      printf ' · cycle <b>%s → %s</b>, %s day%s left' \
        "$CYCLE_START" "$CYCLE_END" "$DAYS_LEFT" "$([[ $DAYS_LEFT == 1 ]] || printf s)"
    fi
    printf ' · ledger read from %s' "$START"
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
    ["role", (.user_info.user_role // "?")]
    | @tsv
  ' "$TMP/user.json" | table --no-head
  end_section

  # ---- the budget, which is what the counters measure
  section 'Budget — this cycle'
  {
    if [[ -n $CYCLE_START ]]; then
      printf 'cycle\t%s → %s\t%s of %s days, %s left\n' \
        "$CYCLE_START" "$CYCLE_END" "$DAYS_IN" "$CYCLE_DAYS" "$DAYS_LEFT"
    elif [[ -n $CYCLE_END ]]; then
      printf 'cycle\tresets %s\tduration %s\n' "$CYCLE_END" "${CYCLE_DUR:-unknown}"
    fi
    # Your keys, then the team, each against its own cap. Burn is the counter
    # over the days elapsed, and the projection carries that rate to the reset
    # -- which is the number that says whether the cap will hold.
    jq -r --argjson days_in "${DAYS_IN:-0}" --argjson days_left "${DAYS_LEFT:-0}" "$JQ_LIB"'
      ((.keys // []) | map(.spend // 0) | add // 0) as $s
      | ((.keys // []) | map(.max_budget // 0) | add // 0) as $m
      | [ ["your keys", "$" + ($s | d2)
             + (if $m > 0 then " of $" + ($m | d2) + " (" + ($s / $m | pct | tostring)
                               + "%, $" + (($m - $s) | d2) + " left)" else "" end),
           (if $days_in > 0
            then "$" + (($s / $days_in) | d2) + "/day"
                 + (if $days_left > 0
                    then " → $" + (($s + ($s / $days_in) * $days_left) | d2) + " by reset"
                    else "" end)
            else "" end)] ]
      | .[] | @tsv
    ' "$TMP/keys.json"
    if [[ -s $TMP/team.json ]]; then
      jq -r --argjson days_in "${DAYS_IN:-0}" --argjson days_left "${DAYS_LEFT:-0}" "$JQ_LIB"'
        (.team_info // .) as $t
        | ($t.spend // 0) as $s | ($t.max_budget // 0) as $m
        | [ ["team " + ($t.team_alias // "?"), "$" + ($s | d2)
               + (if $m > 0 then " of $" + ($m | d2) + " (" + ($s / $m | pct | tostring)
                                 + "%, $" + (($m - $s) | d2) + " left)" else "" end),
             (if $days_in > 0
              then "$" + (($s / $days_in) | d2) + "/day"
                   + (if $days_left > 0
                      then " → $" + (($s + ($s / $days_in) * $days_left) | d2) + " by reset"
                      else "" end)
              else "" end)] ]
        | .[] | @tsv
      ' "$TMP/team.json"
    fi
  } | table --no-head
  printf '<p class="note">These are the proxy&#39;s live counters — what a cap is '
  printf 'enforced against, and what resets on the date above. Everything below '
  printf 'comes from the daily ledger instead, which is the only source for a '
  printf 'per-day or per-member figure and runs a few percent under a counter: it '
  printf 'aggregates per UTC day, so the two never agree to the cent.</p>\n'
  end_section

  # ---- day and week, the rhythm rather than the total
  section 'Recent — you'
  jq -r --arg today "$TODAY" --arg d1 "$D1" --arg d7 "$D7" \
        --argjson days_in "${DAYS_IN:-0}" --arg cstart "${CYCLE_START:-}" "$JQ_LIB"'
    (.results // []) as $r
    | [ ["today",      "$" + (($r | map(select(.date == $today)) | sum(.metrics.spend)) | d2), $today],
        ["yesterday",  "$" + (($r | map(select(.date == $d1))    | sum(.metrics.spend)) | d2), $d1],
        ["last 7 days","$" + (($r | map(select(.date >= $d7))    | sum(.metrics.spend)) | d2),
                       "$" + ((($r | map(select(.date >= $d7))   | sum(.metrics.spend)) / 7) | d2) + "/day"] ]
      + (if $cstart != "" and $days_in > 0
         then [ ["this cycle (ledger)",
                 "$" + (($r | map(select(.date >= $cstart)) | sum(.metrics.spend)) | d2),
                 "$" + ((($r | map(select(.date >= $cstart)) | sum(.metrics.spend)) / $days_in) | d2)
                   + "/day since " + $cstart ] ]
         else [] end)
    | .[] | @tsv
  ' "$TMP/day.json" | table --no-head
  end_section

  section 'Your keys — counters, which is what a cap is enforced against'
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

  # Same cycle, from the ledger — which is where a key you rotated mid-cycle
  # still appears, and a counter no longer does.
  section 'Keys — this cycle in the ledger, rotated ones included'
  printf '<div class="scroll">\n'
  jq -r --arg today "$TODAY" --arg d7 "$D7" --arg cstart "${CYCLE_START:-1970-01-01}" \
        --slurpfile kl "$TMP/keys.json" "$JQ_LIB"'
    (reduce (($kl[0].keys // [])[]) as $k ({}; .[$k.token] = ($k.key_alias // "(no alias)"))) as $alias
    | [ .results[]? as $d
        | select($d.date >= $cstart)
        | ($d.breakdown.api_keys // {} | to_entries[]
           | {k: .key, s: (.value.metrics.spend // 0), d: $d.date}) ]
    | group_by(.k)
    | map({k: .[0].k, s: sum(.s),
           t: (map(select(.d == $today)) | sum(.s)),
           w: (map(select(.d >= $d7)) | sum(.s)),
           last: (map(.d) | max)})
    | map(select(.s > 0.005))
    | ( ["KEY", "ALIAS", "CYCLE", "TODAY", "7 DAYS", "LAST"],
        ( sort_by(-.s)[]
          | [ .k[0:8] + "…",
              ($alias[.k] // "(rotated out / deleted)"),
              "$" + (.s | d2),
              (if .t > 0.005 then "$" + (.t | d2) else "—" end),
              (if .w > 0.005 then "$" + (.w | d2) else "—" end),
              .last ] ) )
    | @tsv
  ' "$TMP/day.json" | table
  printf '</div>\n'
  end_section

  section 'By model — this cycle'
  printf '<div class="scroll">\n'
  jq -r --arg cstart "${CYCLE_START:-1970-01-01}" "$JQ_LIB"'
    [ .results[]? | select(.date >= $cstart) | .breakdown.models // {} | to_entries[] ]
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

  section 'Tokens and reliability — this cycle'
  jq -r --arg cstart "${CYCLE_START:-1970-01-01}" "$JQ_LIB"'
    ([ .results[]? | select(.date >= $cstart) | .metrics ]) as $days
    | { total_tokens: ($days | sum(.total_tokens // 0)),
        total_prompt_tokens: ($days | sum(.prompt_tokens // 0)),
        total_completion_tokens: ($days | sum(.completion_tokens // 0)),
        total_cache_read_input_tokens: ($days | sum(.cache_read_input_tokens // 0)),
        total_cache_creation_input_tokens: ($days | sum(.cache_creation_input_tokens // 0)),
        total_api_requests: ($days | sum(.api_requests // 0)),
        total_failed_requests: ($days | sum(.failed_requests // 0)) } as $m
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

  # ---- the team, for reference
  if [[ -s $TMP/teamday.json && -s $TMP/team.json ]]; then
    section 'Team — this cycle, per member'
    jq -r --slurpfile td "$TMP/teamday.json" "$JQ_LIB"'
      (.team_info // .) as $t
      | [ ["team", ($t.team_alias // $t.team_id // "?")],
          ["members", (($t.members_with_roles // $t.members // []) | length | tostring)],
          ["cycle counter", "$" + (($t.spend // 0) | d2)
             + (if ($t.max_budget // 0) > 0
                then " of $" + ($t.max_budget | d2)
                     + " (" + (($t.spend // 0) / $t.max_budget | pct | tostring) + "%, $"
                     + (($t.max_budget - ($t.spend // 0)) | d2) + " left)"
                else "" end)],
          ["resets", ($t.budget_reset_at // "—" | tostring | .[0:10])]
        ][] | @tsv
    ' "$TMP/team.json" | table --no-head

    printf '<div class="scroll">\n'
    # Per member, not per key -- one person's three keys are one row. The ledger
    # names a key by alias and never by owner, so a member is matched to an alias
    # by NAME: the alias up to its first separator against the email's local part
    # or that part's first dot-segment, and only when exactly one member matches.
    # An alias nothing matches stays its own row, which is why the member column
    # is an email when it is a person and an alias when it is a guess declined.
    jq -r --arg today "$TODAY" --arg d7 "$D7" --arg cstart "${CYCLE_START:-1970-01-01}" \
          --slurpfile mine "$TMP/keys.json" \
          --slurpfile ti "$TMP/team.json" "$JQ_LIB"'
      def norm: ascii_downcase | split("-")[0] | split("_")[0] | gsub("^ +| +$"; "");
      def loc($e): $e | ascii_downcase | split("@")[0];
      def resolve($alias; $emails):
        ($alias | norm) as $a
        | [ $emails[]
            | select((loc(.) == $a) or ((loc(.) | split(".")[0]) == $a)) ]
        | if length == 1 then .[0] else null end;
      (($ti[0].team_info // $ti[0]) as $t
        | [ ($t.members_with_roles // $t.members // [])[] | .user_email // empty ]) as $emails
      | ([ ($mine[0].keys // [])[] | .token ]) as $own
      | [ .results[]? as $d
          | select($d.date >= $cstart)
          | ($d.breakdown.api_keys // {} | to_entries[]
             | {k: .key, s: (.value.metrics.spend // 0), r: (.value.metrics.api_requests // 0),
                a: (.value.metadata.key_alias // null), d: $d.date}) ]
      | group_by(.k)
      | map({ k: .[0].k,
              a: ((map(.a) | map(select(. != null)) | first) // "(no alias)"),
              s: sum(.s), r: sum(.r),
              t: (map(select(.d == $today)) | sum(.s)),
              w: (map(select(.d >= $d7)) | sum(.s)),
              last: (map(.d) | max) })
      | map(select(.s > 0.005 or .r > 0))
      | map(. as $row
            | . + { who: (resolve(.a; $emails) // .a),
                    matched: (resolve(.a; $emails) != null),
                    mine: (($own | index($row.k)) != null) })
      | group_by(.who)
      | map({ who: .[0].who,
              matched: .[0].matched,
              aliases: (map(.a) | unique),
              n: length,
              s: sum(.s), t: sum(.t), w: sum(.w), r: sum(.r),
              last: (map(.last) | max),
              mine: (map(.mine) | any) })
      | ( ["MEMBER", "KEYS", "CYCLE", "TODAY", "7 DAYS", "LAST"],
          ( sort_by(-.s)[]
            | [ .who + (if .mine then " · yours" else "" end),
                ((if .n > 1 then (.n | tostring) + " · " else "" end)
                 + (.aliases[0:4] | join(", "))
                 + (if (.aliases | length) > 4
                    then " +" + (((.aliases | length) - 4) | tostring) else "" end)),
                "$" + (.s | d2),
                (if .t > 0.005 then "$" + (.t | d2) else "—" end),
                (if .w > 0.005 then "$" + (.w | d2) else "—" end),
                .last ] ) )
      | @tsv
    ' "$TMP/teamday.json" | table
    printf '</div>\n'

    # What the numbers above cannot say, said once rather than guessed at.
    printf '<p class="note">A member column that reads as an email was matched to '
    printf 'its key aliases by name — the alias up to its first separator against '
    printf 'the email&#39;s local part, and only where exactly one member matched. '
    printf 'One that reads as an alias is a match declined rather than a person '
    printf 'identified: the team ledger carries a key&#39;s alias and never its '
    printf 'owner, so the rest cannot be attributed without guessing. Reading '
    printf 'another member&#39;s user record needs an admin key (a member key gets '
    printf '403), so for keys that are not yours there is also no cap and no reset '
    printf 'date — the team counter above is the reset-scoped figure that does '
    printf 'exist. Spend and today are the ledger&#39;s, which is why a rotated or '
    printf 'deleted key still counts.</p>\n'
    end_section
  fi

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
  jq -n --arg gen "$NOW" --arg today "$TODAY" --arg d7 "$D7" \
        --arg cstart "${CYCLE_START:-}" --arg creset "${CYCLE_END:-}" \
        --argjson dleft "${DAYS_LEFT:-0}" \
        --slurpfile day "$TMP/day.json" --slurpfile keys "$TMP/keys.json" \
        --slurpfile team "$TMP/team.json" "$JQ_LIB"'
    ($day[0].results // []) as $r
    | (($keys[0].keys // []) | map(.spend // 0) | add // 0) as $ks
    | (($keys[0].keys // []) | map(.max_budget // 0) | add // 0) as $kc
    | (($team | first | (.team_info // .)) // {}) as $t
    | { generated: $gen,
        today:  (($r | map(select(.date == $today)) | sum(.metrics.spend)) | d2),
        last7:  (($r | map(select(.date >= $d7))    | sum(.metrics.spend)) | d2),
        # The counters, because these are the budget -- the chip says what is
        # left of a cap, and a ledger sum would say something slightly else.
        cycle: { spend: ($ks | d2),
                 cap: (if $kc > 0 then ($kc | d2) else null end),
                 pct: (if $kc > 0 then ($ks / $kc | pct) else null end),
                 start: (if $cstart == "" then null else $cstart end),
                 resets: (if $creset == "" then null else $creset end),
                 days_left: $dleft },
        team: (if ($t.team_id // null) then
                 { alias: ($t.team_alias // null),
                   spend: (($t.spend // 0) | d2),
                   cap: (if ($t.max_budget // 0) > 0 then ($t.max_budget | d2) else null end),
                   pct: (if ($t.max_budget // 0) > 0 then (($t.spend // 0) / $t.max_budget | pct) else null end) }
               else null end) }
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
