# cloudcli-kit

Personal customisations for [CloudCLI UI](https://github.com/siteboon/claudecodeui) — a
plugin, a stylesheet, and a launcher that re-applies both on every start, so a package
upgrade cannot silently revert them.

Two things go in, and they install differently because CloudCLI's plugin API can only carry
one of them:

| | What it is | How it installs |
|---|---|---|
| **Recent** tab | Every project's conversations in one recency-ordered list, with a chip for the ones that stopped to ask you something | Settings → Plugins → paste this repo's URL |
| Appearance + behaviour | Surfaces, accent, typography, inline code, full-width chat; Conversations as the sidebar's default, with a dot on the ones that are working; each model described, priced, and pruned in the model menu; Enter for a newline, ⌘/Ctrl+Enter to send | `./install.sh` |

## Why the split

A plugin's module is fetched and `import()`ed **when its tab is activated**, and torn down
via `unmount()` when you navigate away. That is exactly right for a tab, and structurally
wrong for everything else here:

- **A stylesheet must be in effect at first paint, on every page load.** As a plugin it
  would apply only after you visited the tab, and only until you left it.
- **The accent substitution reads the app's own CSS bundle off disk.** Recolouring
  `--primary` alone leaves ~106 hardcoded `bg-blue-600` / `text-blue-400` rules behind and
  the UI comes out two-toned, so the launcher rewrites every one of them into the new hue
  *at equal relative luminance* — contrast is then preserved by construction rather than by
  eye. That is a filesystem job, not a browser job.
- **The model options live in the server's own module.** Dropping one, or giving one a
  description worth reading, is an edit to a file on disk. No plugin surface reaches it.
- **Four of the tweaks are inside the app bundle.** The sidebar's Projects/Conversations
  switch is React state; the model menu never passes the description to the menu component
  that would render it; the Conversations list is never handed the running-session state
  its sibling lists draw a dot from; and the Enter key sends by default. None of the first
  three is reachable from CSS, and a plugin runs too late and in the wrong scope to change
  any of them. The fourth *is* stored in the browser, but a plugin could only overwrite the
  value you chose — the bundle edit changes the default and leaves your choice alone.

So the plugin is the plugin, and the rest is one file plus a launcher. The upside of doing
it this way rather than forking CloudCLI: nothing here lives in a file upstream also edits,
so there is never a merge — upgrading is `npm i -g @cloudcli-ai/cloudcli` and one launcher
run. (Upstream ships a release roughly every 4–5 days, and does not commit `dist/`, so a
fork would mean a weekly merge *plus* a vite + tsc build with two native modules.)

## Install

The plugin, on any machine:

> Settings → Plugins → paste the repo URL → Install → Enable

It has no `package.json` on purpose, so the registry skips `npm install` and `npm run
build` entirely: install and update are a bare `git clone --depth 1` / `git pull
--ff-only`. The **Update** button in the UI is all a later version needs.

Everything else:

```bash
git clone https://github.com/<you>/cloudcli-kit.git
cd cloudcli-kit
./install.sh                # add --plugin to install the tab without the UI
```

That seeds one file and installs the launcher:

```
~/.config/cloudcli/ide-theme.css   appearance — yours to retune, seeded once
~/bin/cloudcli-start               applies everything to the package on every start
```

Nothing is restarted, so it is safe to run while a session is in progress; reload the
browser to see the result.

## The tab

[`index.js`](index.js) is the whole plugin — one file, no build step, no dependencies. It
renders into a shadow root, so the app's styles and these can never collide, while CSS custom
properties still inherit *through* the boundary — which is why the panel tracks the active
theme and any retune without reading `api.context.theme` at all.

### What the chips mean

CloudCLI tracks sessions that are *running* — the Active tab, backed by an in-memory
registry. It tracks nothing about the state you actually go looking for: a session that
stopped because Claude asked you something. Those leave the Active tab the moment they stop.

- **working** — in `/api/providers/sessions/running`
- **your turn** — not running, and its transcript was touched in the last 6 hours. The
  server reads `lastActivity` off the JSONL's mtime, which advances while Claude writes, so
  a recently stopped session is the one that just asked.

The list is fetched on open and on demand, never polled: `/api/projects` broadcasts a
`loading_progress` frame to every websocket client and the app renders it as a progress
indicator, so a background poll would make the whole UI flicker.

## Four small edits in the bundle

Three are things the app already almost does; the fourth is a default worth flipping:

- **Conversations, not Projects, as the sidebar's default.** The switch is `useState` that is
  never persisted, so it reset to Projects on every load.
- **The model's description in the model menu.** Every option already carries one, and the
  menu-item component already renders one when given it — the effort menu right next door
  passes exactly that prop. The model menu just never did.
- **A working dot on the Conversations list.** The Projects and Running lists both draw one;
  the Conversations list, alone among the three, was never handed the state to draw it from —
  even though its own call site already reads two other fields off the very object that holds
  it. So the patch passes them along and reuses the app's own indicator: green for working,
  amber for a session waiting on an answer.
- **Enter for a newline, ⌘/Ctrl+Enter to send.** This one the app does have a setting for —
  Quick Settings (the tab on the right edge of the window) → Input Settings → *Send by
  Ctrl+Enter* — it just defaults off, so every browser starts out sending on Enter. The patch
  flips that one default and nothing else, which makes its reach precise: the preferences hook
  persists the whole object to `localStorage.uiPreferences` on its **first render**, so a
  profile that has already opened the app has `sendByCtrlEnter:false` written down, and a
  stored value wins. There it takes one flip of the toggle, once. The patch is what a *fresh*
  profile starts from — new browser, private window, another machine, cleared site storage —
  and it leaves the toggle working in both directions, which is the point of changing the
  default rather than the behaviour. Shift+Enter is a newline in either mode; it has never sent.

The bundle is **never written to**. Each start makes a patched *copy* beside it, named by the
md5 of its own contents (`assets/ide-<md5>.js`), and points `index.html` at that:

- Patching in place would not reach the browser. `/assets/` is served
  `Cache-Control: immutable` **and** the bundled service worker is cache-first there, so a
  browser that already has the entry chunk never asks again. A new name is a new cache entry,
  and `index.html` is served `no-store`, so one reload picks it up.
- Working from a pristine original makes the patch idempotent, and leaves something to fall
  back to: the copy is `node --check`ed, and on failure `index.html` is pointed back at
  upstream's own file. `CLOUDCLI_FRONTEND=0` does the same on purpose.

Each substitution must match its anchor **exactly once** — in a minified bundle there is no
way to tell the intended site from a coincidence — and the run says what it did:

```
frontend: 4/4 applied -- sidebar default, model description, conversation status, ctrl+enter to send
```

## The model menu

The menu takes two patches, and only one of them is in the bundle. Making it *render* a
description is the bundle edit above; the description itself comes from a **server** module —
the option list, each entry with a label and a description — so the launcher rewrites the text
there, adding the one thing nothing on the machine knows: what a model costs.

```
Opus            Opus 5, 1M context. Best for everyday, complex tasks. $5/$25 per Mtok.
Haiku           Haiku 4.5, 200K context. Fastest for quick answers. $1/$5 per Mtok.
```

```
models: dropped fable, best; described 7
```

Prices are Anthropic's list rates per million input/output tokens; a gateway or a
subscription may bill differently, and the table in the launcher is the place to correct that.
The same pass drops options a deployment cannot serve — `CLOUDCLI_DROP_MODELS`, default
`fable best`, because with Fable gone `best` is just a second Opus that still advertises Fable
in its description. The edit is brace-matched, checked with `node --check`, and reverted
automatically if it would break syntax.

**This is the one patch a browser reload does not pick up.** It is a server module, already in
node's memory, so it lands on the next server start — which the launcher will not force while
a session is live.

## Retuning the appearance

Edit `~/.config/cloudcli/ide-theme.css`, then:

```bash
CLOUDCLI_PATCH_ONLY=1 ~/bin/cloudcli-start
```

Applies to the installed package, starts nothing, leaves a running server and an in-flight
session alone. Reload the browser. Change the accent in one place — `--primary` — and the
~106 blue utilities follow. Copy the result back into `theme/ide-theme.css` to keep the repo
the source of truth.

For a page you don't want to reload at all, paste into the browser console:

```js
document.head.insertAdjacentHTML('beforeend',
  '<link rel="stylesheet" href="/ide-theme.css?live=' + Date.now() + '">')
```

## The anchor self-check

Every override hangs off something upstream *happens* to do — a Tailwind class (`md:w-72`,
`font-serif`, `prose-invert`), a CSS variable (`--primary`), a localStorage key
(`auth-token`), a route (`session/:sessionId`). None of that is a published interface, so an
upgrade can move one and the override would go quietly ineffective. That is the one genuine
weakness of patching rather than forking, so the launcher checks each anchor by name and
says so:

```
anchors: 7/7 ok
```

If it reports `MISSING`, that override no longer applies and the selector in
`theme/ide-theme.css` needs re-pointing at whatever replaced it. The check only reports — it
never edits.

## Notes

- **JetBrains Mono** must be installed on the machine running the *browser*, not the server.
- **Don't symlink this repo into `~/.claude-code-ui/plugins/`.** The registry iterates with
  `withFileTypes` and tests `isDirectory()`, which is false for a symlink, so the plugin
  would silently never be discovered. `install.sh --plugin` clones or copies instead.
- The stylesheet lands at the **dist root**, not `dist/assets/`: the bundled service worker is
  cache-first for `/assets/` and network-first elsewhere, so a file there could be served
  stale. The server also sends `Cache-Control: immutable` for every static file, which is why
  its tag carries an md5 version query. The patched bundle is the exception — it has to sit in
  `dist/assets/` beside the sibling chunks it imports relatively, so it is versioned by md5 in
  its *name* instead, which is a new URL and therefore a new cache entry either way.
- The launcher checks that the server's three native dependencies (`better-sqlite3`,
  `bcrypt`, `node-pty`) actually load before starting. npm 11 warns about dependencies
  whose install scripts it hasn't recorded as approved, and says a future release will block
  them — which would produce an install that imports fine and then fails on its first query.
  If the check trips it prints the `npm rebuild` line to fix it and starts nothing.
- Everything is an environment knob, read on every start: `CLOUDCLI_PATCH_ONLY=1` (apply and
  exit), `CLOUDCLI_FRONTEND=0` (serve upstream's bundle untouched), `CLOUDCLI_DROP_MODELS`
  (see above), and `CLOUDCLI_THEME` (a stylesheet somewhere other than `~/.config/cloudcli`).
  `CLOUDCLI_PREFIX` and `CLOUDCLI_CONF` move the paths themselves, for an install that is not
  where the launcher looks.
- Delete `~/.config/cloudcli/ide-theme.css` and the next launcher run cleanly un-links it. An
  earlier version of the launcher could also serve the Recent list as a floating pill; that is
  gone, and both scripts un-link what it left behind on a machine that ran it.

## Licence

MIT — see [LICENSE](LICENSE). CloudCLI UI itself is AGPL-3.0; nothing here includes or
modifies its source, and the generated accent rules are derived on your own machine at
start-up and never distributed.
