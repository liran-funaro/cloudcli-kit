#!/usr/bin/env bash
# Install the parts of cloudcli-kit that a plugin cannot carry.
#
# The Recent-conversations TAB is a plugin -- install that from CloudCLI's own
# Settings > Plugins by pasting this repo's URL. Nothing here is needed for it.
#
# This script installs the rest, which is everything that has to be in place
# before the app renders or before the server starts, and therefore cannot be a
# plugin (a plugin's module is imported only when its tab is activated):
#
#   ~/.config/cloudcli/ide-theme.css   appearance -- yours to retune, seeded once
#   ~/bin/cloudcli-start               applies it to the package on every start,
#                                      so an upgrade cannot revert it
#
#   --force        overwrite ide-theme.css with the repo's copy (backs up first)
#   --plugin       also install/update the plugin into ~/.claude-code-ui/plugins
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
WITH_PLUGIN=0
APPLY=1

for arg in "$@"; do
  case $arg in
    --force) FORCE=1 ;;
    --plugin) WITH_PLUGIN=1 ;;
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

# --- un-seed the pill --------------------------------------------------------
# The Recent list used to be servable as a page script as well as a plugin tab,
# from a second copy of index.js here. The tab is the only way in now, and it is
# mounted from the plugin directory, so this copy has no consumer. Keep a dated
# copy only if it is something other than index.js -- nothing is lost otherwise.
if [[ -f $CONF/ide-recent.js ]]; then
  echo "recent-conversations pill (removed):"
  cmp -s "$REPO/index.js" "$CONF/ide-recent.js" || stamp "$CONF/ide-recent.js"
  rm -f "$CONF/ide-recent.js"
  echo "  un-seeded $CONF/ide-recent.js -- the plugin tab replaces it"
fi

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

# --- optional: the plugin, without going through the UI ----------------------
# scanPlugins() iterates with withFileTypes and tests isDirectory(), which is
# false for a symlink -- so a symlinked plugin is silently never discovered.
# It has to be a real directory, which means a clone (or a copy).
if [[ $WITH_PLUGIN == 1 ]]; then
  echo "plugin:"
  mkdir -p "$PLUGINS"
  ORIGIN="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
  NAME="$(basename "${ORIGIN%.git}" 2>/dev/null || true)"
  [[ -n $NAME && $NAME != . ]] || NAME="$(basename "$REPO")"
  DEST="$PLUGINS/$NAME"
  if [[ -d $DEST/.git ]]; then
    git -C "$DEST" pull --ff-only --quiet && echo "  updated $DEST"
  elif [[ -d $DEST ]]; then
    echo "  $DEST exists and is not a clone -- leaving it alone"
  elif [[ -n $ORIGIN ]]; then
    git clone --depth 1 --quiet -- "$ORIGIN" "$DEST" && echo "  cloned $ORIGIN -> $DEST"
  else
    cp -R "$REPO" "$DEST"
    rm -rf "$DEST/.git"
    echo "  copied $REPO -> $DEST (no origin remote, so the UI's Update button"
    echo "  will not work -- push the repo and re-run to get a real clone)"
  fi
  echo "  enable it in Settings > Plugins (a browser reload lists it)"
fi

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
