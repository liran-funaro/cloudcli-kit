#!/bin/sh
# Sets up the workstation side on a Mac: the persistent SSH SOCKS proxy under
# launchd, its fish helper, and the Chrome extension that routes the server's
# hostname through it. See docs/browser-over-ssh.md.
#
#   client/install.sh --hostname devbox.example.com [--host dev] [--port 1080]
#                     [--label local.cloudcli.devproxyd]
#
# Your ~/.ssh/config is not touched: the block the tunnel needs is printed.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
hostname= host=dev port=1080 label=local.cloudcli.devproxyd

while [ $# -gt 0 ]; do
    case $1 in
        --hostname) hostname=$2; shift 2 ;;
        --host) host=$2; shift 2 ;;
        --port) port=$2; shift 2 ;;
        --label) label=$2; shift 2 ;;
        *) echo "usage: $0 --hostname <server fqdn> [--host <ssh alias>] [--port <socks port>] [--label <launchd label>]" >&2; exit 2 ;;
    esac
done

# Each value lands in a plist, a PAC script and a sed expression: allow only
# what a hostname, an ssh alias, a port and a launchd label can hold.
valid() {
    case $2 in *'
'*) echo "install: --$1 holds a newline" >&2; exit 2 ;; esac
    printf '%s' "$2" | grep -Eqx "$3" || { echo "install: --$1 '$2' is not valid" >&2; exit 2; }
}
[ -n "$hostname" ] || { echo "install: --hostname is required (the server's name in the browser URL)" >&2; exit 2; }
valid hostname "$hostname" '[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?'
valid host "$host" '[A-Za-z0-9._-]+'
valid port "$port" '[0-9]{2,5}'
valid label "$label" '[A-Za-z0-9.-]+'

esc() { printf '%s' "$1" | sed 's/[.]/\\./g'; }
fill() {
    sed -e "s|@LABEL@|$label|g" -e "s|@HOME@|$HOME|g" -e "s|@HOST@|$host|g" -e "s|@PORT@|$port|g" "$1"
}

state=$HOME/.local/state/devproxyd
agent=$HOME/Library/LaunchAgents/$label.plist
ext=$HOME/.config/cloudcli-chrome-proxy
mkdir -p "$HOME/.local/bin" "$state" "$HOME/Library/LaunchAgents" "$ext"

cp "$here/devproxyd-run" "$HOME/.local/bin/devproxyd-run"
chmod 0755 "$HOME/.local/bin/devproxyd-run"
fill "$here/devproxyd.plist.in" > "$agent"
echo "installed $agent"

cp "$here/chrome-extension/manifest.json" "$ext/manifest.json"
sed -e "s/$(esc devbox.example.com)/$hostname/" -e "s/127\.0\.0\.1:1080/127.0.0.1:$port/" \
    "$here/chrome-extension/background.js" > "$ext/background.js"
echo "installed the Chrome extension in $ext"

if command -v fish >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/fish/functions"
    fill "$here/devproxyd.fish.in" > "$HOME/.config/fish/functions/devproxyd.fish"
    echo "installed the fish function devproxyd (start|stop|restart|status|logs)"
fi

# launchd has no one to answer a prompt: the key has to work on its own. A
# short-lived certificate from an interactive login does not last.
if ssh -o BatchMode=yes -o ConnectTimeout=10 -S none "$host" true 2>/dev/null; then
    echo "ssh $host: logs in without a prompt"
else
    cat >&2 <<EOF

WARNING: 'ssh -o BatchMode=yes $host true' failed. The tunnel needs a key that
logs in with no prompt and does not expire. In ~/.ssh/config:

  Host $host
    HostName <server address>
    User <server user>
    IdentityFile ~/.ssh/id_ed25519      # authorized on the server
    ServerAliveInterval 30
    ServerAliveCountMax 6

The agent keeps retrying, so it connects once this works.
EOF
fi

if command -v launchctl >/dev/null 2>&1; then
    service=gui/$(id -u)/$label
    launchctl bootout "$service" 2>/dev/null || true
    launchctl enable "$service"
    launchctl bootstrap "gui/$(id -u)" "$agent"
    echo "loaded $service; logs in $state"
else
    echo "launchctl not found: files written, agent not loaded"
fi

cat <<EOF

Next:
  1. Chrome: chrome://extensions > Developer mode > Load unpacked > $ext
  2. The server must resolve its own name to loopback (once, on the server):
       ssh $host getent ahostsv4 $hostname        # want 127.0.0.1
  3. Check the route, then open http://$hostname:3001
       curl -s --socks5-hostname 127.0.0.1:$port -o /dev/null -w '%{http_code}\n' http://$hostname:3001/
EOF
