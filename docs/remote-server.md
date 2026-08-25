# Claude Code Web UI on a Remote Dev Server

A readable browser UI for Claude Code, with the session **executing on your remote Linux dev
box**, reached from your laptop over an SSH tunnel. Nothing is exposed to the network and no
session content is relayed through third-party infrastructure.

Verified on RHEL 9.8, Claude Code CLI 2.1.235, CloudCLI 1.37.2, with model access through a
self-hosted LiteLLM gateway. Earlier revisions of this guide carried the launcher inline; it is
[`launcher/cloudcli-start`](../launcher/cloudcli-start) in this repository now.

---

## Why this instead of an official surface

If your Claude Code access is an **internal LLM gateway** (`ANTHROPIC_BASE_URL` pointing
somewhere other than `api.anthropic.com`) rather than a claude.ai subscription, most of
Anthropic's nicer surfaces are unavailable to you:

| Surface | Works with a gateway token? | Why |
| --- | --- | --- |
| Terminal CLI | Yes | — |
| VS Code / Cursor / fork extensions | Yes | bundled CLI |
| JetBrains plugin | Yes | uses the CLI |
| **Remote Control** (phone/browser driving your session) | **No** | requires a claude.ai subscription, and is explicitly disabled when `ANTHROPIC_BASE_URL` is not `api.anthropic.com` |
| Desktop app (incl. its SSH sessions) | **No** | requires a paid claude.ai subscription |
| claude.ai/code (web) and mobile app | **No** | same |
| Self-hosted environments (own runners) | **No** | Team/Enterprise only, and inference cannot be routed through an LLM gateway |

That leaves the CLI as the only engine, so a **third-party UI that wraps the CLI** is the way
to get a graphical interface. This guide uses [CloudCLI](https://github.com/siteboon/claudecodeui)
(`@cloudcli-ai/cloudcli`, AGPL-3.0), which reads and writes the same `~/.claude` config as the
CLI — so it inherits your gateway credentials with no extra auth.

> CloudCLI is third-party software. It runs the CLI inside your repositories, which means it
> can read your source and it sees the credentials in `~/.claude/settings.json`. That is the
> same access the CLI already has, but check whether running it is acceptable under your
> organisation's policy before deploying it.

---

## Architecture

```
  your laptop                          remote dev server (inside the corp network)
  ───────────                          ────────────────────────────────────────────
  browser
    │  http://localhost:3001
    ▼
  ssh -L 3001 ────────────────────────► 127.0.0.1:3001   cloudcli (systemd user service)
                                                │
                                                ├─► claude CLI  ──► your LLM gateway
                                                └─► your repos, Docker, internal services
```

The server binds **loopback only**, so the port does not exist on the network. The SSH tunnel
is the only path in.

---

## Prerequisites on the remote server

1. **Claude Code CLI installed and working.** Verify:
   ```bash
   claude --version
   claude -p "reply with: ok"        # must print ok
   ```
2. **Gateway credentials in `~/.claude/settings.json`** (typically `env.ANTHROPIC_BASE_URL`
   and `env.ANTHROPIC_AUTH_TOKEN`). CloudCLI reads this file; nothing extra to configure.
3. **Node.js ≥ 22.** On RHEL 9: `sudo dnf module install nodejs:22` (or `nodejs:24`).
4. **A systemd user session that survives logout**, so the service keeps running when you
   disconnect:
   ```bash
   sudo loginctl enable-linger "$USER"
   loginctl show-user "$USER" --property=Linger      # expect Linger=yes
   ```

---

## Security model — read before deploying

Three facts that determine how you must configure this:

**1. It defaults to listening on all interfaces.** The code is
`HOST = process.env.HOST || '0.0.0.0'`. On a machine inside a corporate network that would
expose a UI capable of running arbitrary commands in your repos. **Always set
`HOST=127.0.0.1`.** The service unit below does.

**2. Loopback does not protect you from your own browser.** The server sends
`Access-Control-Allow-Origin: *`, so once your tunnel is up, *any* web page you have open can
issue requests to `localhost:3001`. Your firewall is irrelevant — the request originates
inside your machine.

**3. Which is why the login is load-bearing, and effective.** The API requires a bearer JWT
(`/api/projects` → `401` without one). Because it is a bearer token rather than a cookie, a
hostile page cannot read it or have it attached automatically. Do not attempt to disable
authentication — and there is no supported switch to do so.

> **Complete the first-run setup immediately after your first connect.** Until you do,
> `/api/auth/status` reports `needsSetup: true`, and the account-creation endpoint is the one
> thing that cannot require a token yet. Creating your account closes that window.

What was observed during a review of v1.37.0, for your own risk assessment:

- No telemetry or analytics dependencies among its 60 dependencies; no analytics hosts in the
  server code; **no outbound connections while idle or while being driven**.
- Its `postinstall` is a macOS-only `node-pty` permissions fix — no network, no-op on Linux.
- The browser bundle references `cdnjs.cloudflare.com` and `fonts.googleapis.com`, so your
  *browser* may fetch assets from Cloudflare and Google. Your code and prompts do not go there.
- This was static inspection plus at-rest observation, not a full audit. Re-verify yourself:
  ```bash
  sudo ss -tlnp | grep 3001                      # must show 127.0.0.1:3001
  PID=$(pgrep -f 'cloudcli' | head -1)
  sudo ss -tnp | grep "pid=$PID" | grep -v 127.0.0.1   # outbound connections
  ```

---

## Step 1 — install the kit

The launcher, the stylesheet and every patch this guide used to carry inline live in this
repository. On the server:

```bash
git clone https://github.com/liran-funaro/cloudcli-kit.git
cd cloudcli-kit
./install.sh
```

That installs CloudCLI into `~/.npm-global` if it is not already there, seeds
`~/.config/cloudcli/ide-theme.css`, installs `~/bin/cloudcli-start`, and applies everything to
the installed package. It starts and restarts nothing, so it is safe to run while a session is
in progress. [The README's Deploy section](../README.md#deploy) has the details: what each
installed file is, the npm prefix trap that upgrades a copy nothing runs, and the flags
(`--no-cost`, `--no-apply`, `--force`).

`~/bin/cloudcli-start` is what the service below runs. On every start it re-applies the whole
set — so a package upgrade cannot silently revert any of it — and prints one line per patch
into the journal:

| | |
|---|---|
| [appearance](../README.md#retuning-the-appearance) | your stylesheet, linked after the app's own, plus a generated accent substitution for the blue Tailwind utilities no variable reaches |
| [ten bundle edits](../README.md#eight-small-edits-in-the-bundle) | sidebar default, model descriptions, ⌘/Ctrl+Enter to send, send while running, conversation rows, the CLI's own slash commands, the cost chip, compaction and wait rows, clickable paths |
| [the model menu](../README.md#the-model-menu) | each option described and priced; options a deployment cannot serve dropped |
| [a Stop that always stops](../README.md#a-stop-that-always-stops) | an interrupt that cannot wedge on a CLI that has stopped reading |
| [steering](../README.md#steering-a-turn-in-flight) | a message typed mid-turn changes course in that same turn |
| [compaction](../README.md#compaction-said-out-loud) | drawn where it happens, with the summary folded in |
| [waiting](../README.md#waiting-said-out-loud) | a turn held open for background work says so, and your next message goes into the same process |
| [clickable paths](../README.md#a-path-in-the-chat-clickable) | a file path in a message opens the file, including one an agent wrote outside the project |
| [the token counter](../README.md#the-token-counter-and-what-an-interrupt-did-to-it) | a message the CLI wrote itself, whose usage is all zeros, no longer resets it |

Each is anchored on text upstream chose, so a later CloudCLI release can move an anchor: that
patch then reports `MISSING`, the rest still apply, and nothing is left half-edited — see [the
anchor self-check](../README.md#the-anchor-self-check).

---

## Step 2 — run it as a service

The unit is [`systemd/cloudcli.service`](../systemd/cloudcli.service) in this repository —
copy it, or paste it:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/cloudcli.service <<'UNIT'
[Unit]
Description=CloudCLI - Claude Code web UI (loopback only)
After=network-online.target

[Service]
Type=simple
Environment=HOST=127.0.0.1
Environment=PORT=3001
# Login shell so PATH/node and the Claude gateway env from ~/.bashrc apply.
ExecStart=/bin/bash -lc '%h/bin/cloudcli-start'
Restart=on-failure
RestartSec=5
Nice=5

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now cloudcli.service
```

First start installs the package, so allow ~60 seconds.

---

## Step 3 — verify on the server

```bash
systemctl --user is-active cloudcli                  # active
sudo ss -tlnp | grep 3001                            # 127.0.0.1:3001  ← must NOT be 0.0.0.0
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/          # 200
curl -sS http://127.0.0.1:3001/api/projects                               # 401 (auth works)

# appearance patch: stylesheet served as text/css, and linked AFTER the app's own
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:3001/ide-theme.css
curl -sS http://127.0.0.1:3001/ | grep -nE 'assets/index.*css|ide-theme'
curl -sS http://127.0.0.1:3001/ide-theme.css | grep -c '!important}'  # ~100 accent rules
journalctl --user -u cloudcli -n 20 | grep -iE 'ide-theme|removed model'  # patches applied
```

The `grep` must show `ide-theme.css` on a **later line** than the `/assets/…css` link — several
rules rely on winning an equal-specificity tie by document order.

Confirm it is genuinely unreachable from the network — from another machine, or using the
server's own external address:

```bash
curl -m 5 http://<server-ip>:3001/     # expect: Connection refused
```

---

## Step 4 — tunnel from your workstation

```bash
ssh -f -N -L 3001:127.0.0.1:3001 <your-ssh-host>
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3001/     # 200
```

Then open **<http://localhost:3001>** and **create your account straight away**.

To close the tunnel later: `pkill -f 'ssh -f -N -L 3001:'`

If you use VS Code or a fork over Remote-SSH, its automatic port forwarding may already give
you `localhost:3001` without a manual tunnel.

For a setup that uses the server's own hostname in the browser instead of `localhost`, and one
SSH proxy for every loopback port rather than a tunnel per service, see [Remote Dev Server
Browser Access over SSH](./browser-over-ssh.md).

---

## What the launcher changes, and how to opt out

The patches are [`launcher/cloudcli-start`](../launcher/cloudcli-start), and the README explains
each one and why it exists. Every knob is an environment variable, read on every start:

| | |
|---|---|
| `CLOUDCLI_FRONTEND=0` | serve upstream's bundle untouched |
| `CLOUDCLI_STEER=0` | drop the steering edits and the held-run resume; the two files they share with nothing else go back to byte-identical with upstream |
| `CLOUDCLI_LINKS=0` | drop the clickable file paths, and with them the one read that is allowed outside the project root; the file goes back to byte-identical with upstream |
| `CLOUDCLI_DROP_MODELS` | model options to hide, space-separated; default `fable best` |
| `CLOUDCLI_THEME` | a stylesheet somewhere other than `~/.config/cloudcli` |
| `CLOUDCLI_PREFIX`, `CLOUDCLI_CONF` | an install, or a config directory, that is not where the launcher looks |
| `CLOUDCLI_PATCH_ONLY=1` | apply and exit, starting nothing |

Put any of them in the unit as `Environment=…`, then:

```bash
systemctl --user daemon-reload && systemctl --user restart cloudcli
```

Frontend patches land on the next browser reload; the server-module ones (Stop, steering,
compaction, waiting) land on the next restart, which the launcher will not force while a
session is live.

### Which models your gateway actually serves

CloudCLI's picker falls back to a hardcoded catalogue, so it can offer models your gateway
cannot serve. Ask the gateway, then hide the rest with `CLOUDCLI_DROP_MODELS`:

```bash
python3 - <<'PY' | curl -sS --config - "$@" | python3 -m json.tool | grep '"id"'
import json, os
env = json.load(open(os.path.expanduser('~/.claude/settings.json')))['env']
# Written as a curl config on stdin so the token never reaches argv, the
# environment of another process, or your shell history.
print(f'url = "{env["ANTHROPIC_BASE_URL"].rstrip("/")}/v1/models"')
print(f'header = "Authorization: Bearer {env["ANTHROPIC_AUTH_TOKEN"]}"')
print('silent')
PY
```

---

## Enabling extended thinking

Two independent switches, which is easy to miss:

1. **Render it** — turn on **Show thinking** in CloudCLI's *Quick Settings* panel.
2. **Produce it** — CloudCLI never passes a thinking budget, so this comes from Claude Code's
   own configuration. Add to `~/.claude/settings.json` on the server:
   ```json
   { "alwaysThinkingEnabled": true }
   ```
   Then start a **new conversation** — the setting is read at session start. You can also ask
   per-prompt ("think hard about …").

---

## Upgrading

```bash
npm update -g --prefix ~/.npm-global @cloudcli-ai/cloudcli
systemctl --user restart cloudcli
```

The launcher re-applies every patch on start: it re-copies your stylesheet into the new package
tree, re-links it in the new `index.html`, rebuilds the patched bundle, and re-patches the
server modules from the copies the package shipped. Upstream's own CSS filenames are
content-hashed, so a new version arrives on a new URL and your browser cache updates by
itself.

Your `~/.config/cloudcli/ide-theme.css` is left alone by upgrades — which also means it will
not pick up improvements to the default. Delete it and restart to take a newer default.

---

## Uninstalling

```bash
systemctl --user disable --now cloudcli
systemctl --user disable --now cloudcli-cost.timer          # if you installed it
rm -f ~/.config/systemd/user/cloudcli.service \
      ~/.config/systemd/user/cloudcli-cost.{service,timer}
rm -f ~/bin/cloudcli-start ~/bin/cloudcli-cost
rm -rf ~/.claude-code-ui/plugins/cost                      # the Cost tab
rm -rf ~/.npm-global/lib/node_modules/@cloudcli-ai/cloudcli ~/.npm-global/bin/cloudcli
rm -rf ~/.cloudcli          # local accounts + settings database
rm -rf ~/.config/cloudcli   # your appearance stylesheet
systemctl --user daemon-reload
```

To keep CloudCLI but drop the kit, see [Going back to
upstream](../README.md#going-back-to-upstream) — no reinstall required.

Your `~/.claude` sessions and settings are untouched — CloudCLI only reads them.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Appearance patch has no effect | Check the `<link>` is present *after* the app stylesheet: `curl -sS http://127.0.0.1:3001/ \| grep -nE 'assets/index.*css\|ide-theme'`. If it is, the browser is on a cached copy — the version query normally prevents that, so hard-reload (**Cmd/Ctrl+Shift+R**), which also bypasses the service worker. |
| Colours changed but message text did not | Expected if you only edited the `.dark` variables — chat bodies use the `--tw-prose-*` palette in the `.dark .prose` block. |
| Accent changed in places, still blue elsewhere | The generated substitution did not run. `grep -c '!important}' ~/.npm-global/lib/node_modules/@cloudcli-ai/cloudcli/dist/ide-theme.css` should be about a hundred; if it is 0, your stylesheet has no `--primary` line in a form the launcher can parse (`--primary: <h> <s>% <l>%;`), or `dist/assets/index-*.css` was renamed by an upgrade. |
| Accent labels unreadable on buttons | `--primary-foreground` is the text *on* the accent and is not derived. Near-black suits a mid-to-light accent, near-white a dark one. |
| Chat still narrow | The `max-w-*` rule lives in the same stylesheet; if colours applied and width did not, something is overriding with a more specific rule — check DevTools → Elements → Computed. |
| Listening on `0.0.0.0` | `HOST` not set. The unit sets `Environment=HOST=127.0.0.1`; check with `sudo ss -tlnp \| grep 3001`. |
| `localhost:3001` refuses on your laptop | Tunnel is down. Re-run the `ssh -L` command. |
| Login prompt after every restart | Should not happen — the JWT secret is persisted in `~/.cloudcli/auth.db` (`app_config`). If it does, set a fixed `JWT_SECRET` in the unit. |
| Model requests fail with an auth error | The session is not picking up your gateway env. Confirm `claude -p "reply with: ok"` works as the same user, and that the unit uses `bash -lc` so `~/.bashrc` is sourced. |
| Port 3001 already in use | `PORT=3002` in the unit, and tunnel `-L 3002:127.0.0.1:3002`. |
| Service will not stay up | `journalctl --user -u cloudcli -n 50`. |
| Sessions vanish after you log out of SSH | Linger is off: `sudo loginctl enable-linger "$USER"`. |

---

## Known limitations

- **Not a substitute for Remote Control.** You must have SSH access and a tunnel; there is no
  phone access unless you tunnel from the phone.
- **The patches are a local fork of upstream behaviour.** If either stops applying after an
  upgrade, the log says so and the app still runs — unpatched.
- **One user per instance.** The account database is per-server; run separate instances (and
  ports) per user on a shared box.
- **Sessions are still CLI sessions.** For work that must survive everything, prefer
  `claude --bg` background agents or `claude` inside `tmux`; a UI-hosted session depends on
  its host process staying alive.
