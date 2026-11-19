# Remote Dev Server Browser Access over SSH

Use normal server-style browser URLs for web applications that run on a remote development
server, while keeping every application bound to remote loopback and using SSH authentication
as the only path in.

For installing CloudCLI itself, see [Claude Code Web UI on a Remote Server](./remote-server.md). That guide covers the server service, authentication,
theming, upgrades, and operational checks. This document replaces its `localhost`/`ssh -L`
workstation access method with one reusable SSH SOCKS proxy and a small Chrome extension.

Verified with:

- macOS workstation with Fish and Google Chrome
- Chrome Manifest V3
- OpenSSH dynamic forwarding
- RHEL 9 remote server
- Remote SSH alias `dev`
- Remote hostname — the examples use `devbox.example.com`; substitute the FQDN your
  server answers to, and keep it consistent across `/etc/hosts`, the PAC rule and the URLs

---

## Goals and security model

The desired URL is:

```text
http://devbox.example.com:<service-port>
```

The remote applications still listen only on loopback:

```text
127.0.0.1:<service-port>
```

This design deliberately does **not**:

- bind an application or relay to the server's network interface;
- add a source-IP firewall exception;
- depend on the workstation's current VPN address;
- alter `/etc/hosts` or global proxy settings on macOS;
- route unrelated Chrome traffic through the server.

The security boundary is SSH authentication. If the SSH connection is absent, Chrome has no
working route to the loopback-only service.

---

## Architecture

```text
Mac                                               remote dev server
───                                               ─────────────────
Chrome requests
http://devbox.example.com:3001
  │
  │ inline PAC rule in a local Chrome extension
  │ only devbox.example.com → SOCKS5 127.0.0.1:1080
  │ all other hosts → DIRECT
  ▼
ssh -D 127.0.0.1:1080 dev ───── authenticated SSH ─────► SOCKS connect
                                                            │
                                                            │ server-local name mapping
                                                            │ devbox... → 127.0.0.1
                                                            ▼
                                                       127.0.0.1:3001
                                                       CloudCLI or another service
```

`ssh -D` is a dynamic SOCKS proxy. Unlike `ssh -L`, one instance supports every TCP port, so a
new loopback web service does not need another tunnel declaration.

---

## 1. Keep services on remote loopback

Configure each remote web application to listen on an IPv4 loopback address, for example:

```text
127.0.0.1:3001
127.0.0.1:8080
127.0.0.1:9090
```

Do not bind to `0.0.0.0` or the server's network-interface address merely to make this scheme
work.

Verify on the server:

```bash
ss -ltnp | grep ':3001'
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/
```

The listener should show `127.0.0.1`, not `0.0.0.0`.

---

## 2. Make the browser hostname resolve to loopback on the server

Chrome hands the **hostname** to the SOCKS proxy rather than resolving it itself, so the server
resolves the name before connecting — and DNS answers with the server's routable address, where
a loopback-only service is not listening. Ask the server what the name means to it:

```bash
ssh dev getent ahostsv4 devbox.example.com     # want 127.0.0.1
```

This step is required unless that already answers `127.0.0.1` — a few images map their own
FQDN to loopback, and most answer with the routable address. Add the mapping once, on the
server:

```bash
ssh dev
printf '%s\n' '127.0.0.1 devbox.example.com' | sudo tee -a /etc/hosts >/dev/null
```

That changes name resolution for processes running on the server, and nothing else: no listener,
no port exposed to the network. With CloudCLI running, the round trip should now answer:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://devbox.example.com:3001/     # 200
```

---

## 3. Add the Fish command that starts the SSH proxy

Save as:

```text
~/.config/fish/functions/devproxy.fish
```

```fish
function devproxy --description 'Start the CloudCLI SSH SOCKS proxy on port 1080'
    set -l host dev
    set -l proxy 127.0.0.1:1080

    if lsof -nP -iTCP:1080 -sTCP:LISTEN >/dev/null 2>&1
        echo "devproxy: $proxy is already in use" >&2
        return 1
    end

    echo "devproxy: starting SOCKS5 proxy at $proxy; press Ctrl-C to stop"
    ssh -NT \
        -D $proxy \
        -o ExitOnForwardFailure=yes \
        $host
end
```

Run it in a terminal:

```fish
devproxy
```

Not a Fish user? The whole function is one command, and bash or zsh needs no wrapper:

```bash
ssh -NT -D 127.0.0.1:1080 -o ExitOnForwardFailure=yes dev
```

It stays in the foreground. Press `Ctrl-C` to stop it. The local bind is explicitly
`127.0.0.1`, so the SOCKS endpoint is not available to other machines.

The `dev` SSH configuration should supply the identity and keepalive settings. A representative
entry is:

```sshconfig
Host dev
  HostName <server-address>
  User <server-user>
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
  ServerAliveCountMax 6
```

Verify the proxy independently of Chrome:

```bash
curl --socks5-hostname 127.0.0.1:1080 \
  -sS -o /dev/null -w '%{http_code}\n' \
  http://devbox.example.com:3001/
```

Expected result: `200`.

### Or keep it up: the launchd agent

`devproxy` lasts as long as its terminal. To have the proxy start at login, survive sleep and
reconnect after the VPN drops, run the installer once on the Mac. It sets up this and the
extension below:

```bash
client/install.sh --hostname devbox.example.com --host dev
```

It writes four things and loads the agent:

| Path | Role |
|---|---|
| `~/Library/LaunchAgents/local.cloudcli.devproxyd.plist` | launchd agent: RunAtLoad and KeepAlive |
| `~/.local/bin/devproxyd-run` | the loop the agent runs |
| `~/.config/fish/functions/devproxyd.fish` | `devproxyd start\|stop\|restart\|status\|logs` (when fish is installed) |
| `~/.config/cloudcli-chrome-proxy/` | the extension, with your hostname and port written in |

`--port` (default `1080`) and `--label` change the SOCKS port and the agent's name. Your
`~/.ssh/config` is left alone.

What the loop does:

- **Waits for the network.** It connects only once the server's name resolves. On a network
  where the name resolves only over the VPN, this is a cheap "VPN is up" test.
- **Reconnects with backoff:** 2 s, doubling to a 30 s cap. A returning network resets it to
  2 s, as does a connection that stayed up 5 minutes. A failed attempt costs one 15 s connect
  timeout, so the cap is short on purpose: a VPN that comes back is picked up within half a
  minute.
- **Stays off a shared connection.** It never uses a `ControlMaster` socket (`-S none`), so it
  doesn't ride on, or die with, one your terminals or VS Code share.
- **Steps aside for a manual `devproxy`.** If something already listens on the port, it waits.
- **Trims its logs.** launchd never rotates them, so each log is emptied past 1 MB.

**The key has to work without you.** The agent runs with `BatchMode=yes`, and launchd has no one
to answer a prompt. It needs an `IdentityFile` that is authorized on the server and doesn't
expire. A short-lived certificate from an interactive login (`step ssh login` and the like)
lapses, and the agent can't renew it. The installer runs `ssh -o BatchMode=yes <host> true` and
warns if that fails.

Two notes on `~/.ssh/config`:

- **Set the `Host dev` options in that block.** A block like `Host !*.github.*` looks like it
  covers every other host. A `Host` line that has only negated patterns matches nothing, so
  nothing in it applies.
- **The `IdentityFile` is what the agent uses.** It doesn't need ssh-agent.

`stderr.log` fills with `channel N: open failed: connect failed: Connection refused` whenever
the browser asks for a port nothing listens on, for example while CloudCLI restarts on the
server. The tunnel itself is fine.

`node client/devproxyd-check.mjs` runs the loop against stub `ssh`, `lsof` and `dscacheutil`.
It checks the backoff, its reset when the network returns, the log trim, and a clean stop on
`TERM`. It needs no Mac.

---

## 4. Create the minimal Chrome extension

The extension is [`client/chrome-extension/`](../client/chrome-extension/). `client/install.sh`
installs a copy with your hostname and port written in. To do it by hand, copy the directory and
replace `devbox.example.com` (and `1080`, if you changed the port) in `background.js`.

The PAC script is inline in `background.js`. There is no PAC file or PAC server. The exact
hostname uses SOCKS; every other Chrome destination remains `DIRECT`.

### Load it

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select `~/.config/cloudcli-chrome-proxy`.
   If the hidden `.config` directory is not visible, press **Cmd+Shift+G** and paste the path.
5. Pin the extension if desired.

The green `ON` badge means its PAC rule is active. Click the extension icon to disable or
re-enable it.

A Chrome extension with the `proxy` permission can control Chrome's proxy configuration. Keep
this extension minimal, local, and auditable; do not add third-party dependencies.

---

## 5. Use it

With `devproxy` running and the extension showing `ON`, open:

```text
http://devbox.example.com:3001
```

For another loopback service on the same server, keep the hostname and change only the port:

```text
http://devbox.example.com:8080
http://devbox.example.com:9090
```

No extension or SSH change is required: the PAC rule matches every port on that hostname, and
SOCKS preserves the requested port.

Ordinary HTTP and WebSocket services work. Application-level rules may still require the
browser origin/host to be allowed. HTTPS additionally requires a certificate valid for
`devbox.example.com`.

This setup is Chrome-only. Other programs must be configured explicitly to use SOCKS5 at
`127.0.0.1:1080`, with remote hostname resolution.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Chrome immediately says connection refused | Run `devproxy`; verify `lsof -nP -iTCP:1080 -sTCP:LISTEN`. |
| Page opens but login or live updates hang | Ensure the extension is `ON`, then reload. WebSockets use the same hostname and PAC route. |
| SOCKS test says connection refused | Nothing is listening on local port 1080, or another process owns it. |
| SOCKS connects but the remote request is refused | On `dev`, verify the service listens on `127.0.0.1:<port>` and `getent ahostsv4 devbox.example.com` returns `127.0.0.1`. |
| Unrelated Chrome sites stop working | The PAC script must end with `return "DIRECT"`; check whether another proxy extension or policy controls Chrome. |
| Extension changes do not apply | On `chrome://extensions`, click the extension's reload button. |
| Browser shows the login page after a transient failure | Restart `devproxy`, then refresh; the application authentication state remains in the browser origin's local storage. |

For CloudCLI server failures rather than tunnel failures, use the verification and
troubleshooting sections in [Claude Code Web UI on a Remote Server](./remote-server.md).

---

## Removing the setup

1. Stop `devproxy` with `Ctrl-C`, or the agent with `devproxyd stop`. Without fish, run
   `launchctl bootout gui/$(id -u)/local.cloudcli.devproxyd`. Then delete
   `~/Library/LaunchAgents/local.cloudcli.devproxyd.plist`, `~/.local/bin/devproxyd-run`,
   `~/.config/fish/functions/devproxyd.fish` and `~/.local/state/devproxyd`.
2. Remove the unpacked extension on `chrome://extensions`.
3. Delete local files if desired:
   ```bash
   rm -rf ~/.config/cloudcli-chrome-proxy
   rm -f ~/.config/fish/functions/devproxy.fish
   ```
4. On the server, remove only the corresponding line from `/etc/hosts`:
   ```text
   127.0.0.1 devbox.example.com
   ```

No application service or data is removed.
