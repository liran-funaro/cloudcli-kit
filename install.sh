#!/usr/bin/env bash
# Install cloudcli-kit: one stylesheet, and a launcher that applies it and the
# rest of the patches to the installed package on every start, so a package
# upgrade cannot silently revert them.
#
#   ~/.config/cloudcli/ide-theme.css   appearance -- yours to retune, seeded once
#   ~/bin/cloudcli-start               applies it to the package on every start,
#                                      so an upgrade cannot revert it
#
#   --force        overwrite ide-theme.css with the repo's copy (backs up first)
#   --no-apply     install the files but do not touch the package yet
#
# Never restarts anything: the running server and any in-flight session are left
# alone, and the browser picks the changes up on its next reload.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONF="${CLOUDCLI_CONF:-$HOME/.config/cloudcli}"
BIN="${CLOUDCLI_BIN:-$HOME/bin}"
PLUGINS="$HOME/.claude-code-ui/plugins"
FORCE=0
APPLY=1

for arg in "$@"; do
  case $arg in
    --force) FORCE=1 ;;
    --no-apply) APPLY=0 ;;
    # The header comment above IS the help text, printed up to the first line
    # of code -- so editing one can never leave the other behind.
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next }
                      NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# stamp <path> -- keep a dated copy before replacing something the user may
# have edited, rather than deciding for them that it was disposable.
stamp() {
  local f=$1
  [[ -f $f ]] || return 0
  local bak="$f.bak-$(date +%Y%m%d%H%M%S)"
  cp -p "$f" "$bak"
  echo "  backed up $(basename "$f") -> $(basename "$bak")"
}

mkdir -p "$CONF" "$BIN"

# --- appearance: config, so seed it once and leave it alone afterwards -------
echo "stylesheet:"
if [[ -f $CONF/ide-theme.css && $FORCE == 0 ]]; then
  if cmp -s "$REPO/theme/ide-theme.css" "$CONF/ide-theme.css"; then
    echo "  $CONF/ide-theme.css already matches the repo"
  else
    echo "  keeping your $CONF/ide-theme.css (differs from the repo; --force to replace)"
  fi
else
  [[ $FORCE == 1 ]] && stamp "$CONF/ide-theme.css"
  cp -f "$REPO/theme/ide-theme.css" "$CONF/ide-theme.css"
  echo "  installed $CONF/ide-theme.css"
fi

# --- what the retired Recent list left behind --------------------------------
# The kit used to carry a Recent-conversations list of its own: first a floating
# pill served from a copy here, then a plugin tab. The sidebar's Conversations
# tab is that list now, patched to show what the pill and the tab were for, so
# both are gone. The pill's copy is un-seeded (dated first, since it is a file
# you could have edited); the plugin directory is only reported, because it is a
# real clone with a UI switch beside it, and removing either is yours to do.
if [[ -f $CONF/ide-recent.js ]]; then
  echo "recent-conversations pill (retired):"
  stamp "$CONF/ide-recent.js"
  rm -f "$CONF/ide-recent.js"
  echo "  un-seeded $CONF/ide-recent.js"
fi
for d in "$PLUGINS"/cloudcli-kit "$PLUGINS"/cloudcli-recent; do
  [[ -d $d ]] || continue
  echo "recent-conversations tab (retired):"
  echo "  $d is still installed -- disable it in Settings > Plugins, then"
  echo "  rm -rf $d"
done

# --- launcher ----------------------------------------------------------------
echo "launcher:"
if cmp -s "$REPO/launcher/cloudcli-start" "$BIN/cloudcli-start"; then
  echo "  $BIN/cloudcli-start already current"
else
  stamp "$BIN/cloudcli-start"
  cp -f "$REPO/launcher/cloudcli-start" "$BIN/cloudcli-start"
  chmod +x "$BIN/cloudcli-start"
  echo "  installed $BIN/cloudcli-start"
fi
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  note: $BIN is not on PATH -- call it by full path, or add it" ;;
esac

# --- apply to the installed package -----------------------------------------
if [[ $APPLY == 1 ]]; then
  echo "applying to the package:"
  CLOUDCLI_PATCH_ONLY=1 "$BIN/cloudcli-start" 2>&1 | sed 's/^/  /'
  echo
  echo "Done. Reload the browser -- nothing was restarted, so a session in"
  echo "progress is unaffected."
else
  echo
  echo "Done. Files installed; run  CLOUDCLI_PATCH_ONLY=1 $BIN/cloudcli-start"
  echo "when you want them applied to the package."
fi
