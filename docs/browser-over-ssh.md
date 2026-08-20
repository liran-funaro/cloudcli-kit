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

The browser gives the SOCKS proxy the hostname rather than resolving it locally. The remote end
of SSH therefore resolves the name before connecting. Add this on the remote server:

```text
# /etc/hosts
127.0.0.1 devbox.example.com
```

For the current server:

```bash
ssh dev
printf '%s\n' '127.0.0.1 devbox.example.com' \
  | sudo tee -a /etc/hosts >/dev/null
```

Add it only once. Verify:

```bash
getent ahostsv4 devbox.example.com
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://devbox.example.com:3001/
```

Both should use `127.0.0.1`; the HTTP request should return `200` when CloudCLI is running.

This entry affects name resolution only for processes running on the server. It does not add a
listener or expose a port to the network.

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

---

## 4. Create the minimal Chrome extension

Create this local directory:

```text
~/.config/cloudcli-chrome-proxy/
```

### `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "CloudCLI SSH Proxy",
  "description": "Routes the CloudCLI hostname through a local SSH SOCKS proxy.",
  "version": "1.0.0",
  "permissions": ["proxy", "storage"],
  "action": {
    "default_title": "CloudCLI SSH Proxy"
  },
  "background": {
    "service_worker": "background.js"
  }
}
```

### `background.js`

```javascript
const proxyConfig = {
  mode: "pac_script",
  pacScript: {
    data: `function FindProxyForURL(url, host) {
      if (host.toLowerCase() === "devbox.example.com") {
        return "SOCKS5 127.0.0.1:1080";
      }
      return "DIRECT";
    }`,
    mandatory: true,
  },
};

function enableProxy() {
  chrome.proxy.settings.set(
    { value: proxyConfig, scope: "regular" },
    () => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError.message);
        return;
      }

      chrome.storage.local.set({ enabled: true });
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
      chrome.action.setTitle({ title: "CloudCLI SSH Proxy: enabled" });
    },
  );
}

function disableProxy() {
  chrome.proxy.settings.clear({ scope: "regular" }, () => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError.message);
      return;
    }

    chrome.storage.local.set({ enabled: false });
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "CloudCLI SSH Proxy: disabled" });
  });
}

chrome.runtime.onInstalled.addListener(enableProxy);
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
    if (enabled) {
      enableProxy();
    }
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
    if (enabled) {
      disableProxy();
    } else {
      enableProxy();
    }
  });
});
```

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

1. Stop `devproxy` with `Ctrl-C`.
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
