# cloudcli-kit

Opinionated customisations for [CloudCLI UI](https://github.com/siteboon/claudecodeui) — a
stylesheet, a launcher that re-applies it and everything below on every start so a package
upgrade cannot silently revert them, and a Cost tab for the LiteLLM proxy behind it.

Surfaces, accent, typography, inline code, full-width chat. Conversations as the sidebar's
default, its rows drawn the way the Projects list draws a session — the activity dot, the
spinner, the session menu — plus the project each one belongs to. Each model described,
priced, and pruned in the model menu. The CLI's own commands — `/compact` among them — in the
composer's command menu. Enter for a newline, ⌘/Ctrl+Enter to send. A Stop that always stops,
and a message typed mid-turn steering the turn it lands in. Compaction drawn where it happens —
a bar and a percentage while it runs, then what it cost, with the summary folded behind a disclosure instead of
dropped into the conversation. A turn that ends waiting on background work says so, counts down,
and takes your next message into the same process instead of killing what it was waiting for. A Cost tab showing what the proxy has billed. A command that reports
a finished run to Slack, and a skill that teaches every Claude Code session to reach for it. One command:
`./install.sh`.

## Why a launcher and not a plugin

CloudCLI has a plugin API, and the kit uses it for exactly one thing: the [Cost
tab](#the-cost-tab). A tab is what that API is for. It once carried a second one — a
**Recent** tab listing every project's conversations by recency, with a chip on the ones that
had stopped to ask you something — and that one is [retired](#the-retired-recent-tab),
because the sidebar's own Conversations tab, patched as described below, is that list in the
place you already look.

Everything else here a plugin could not do. Its module is fetched and `import()`ed **when its
tab is activated**, and torn down via `unmount()` when you navigate away — exactly right for
a tab, and structurally wrong for the rest:

- **A stylesheet must be in effect at first paint, on every page load.** As a plugin it
  would apply only after you visited the tab, and only until you left it.
- **The accent substitution reads the app's own CSS bundle off disk.** Recolouring
  `--primary` alone leaves ~106 hardcoded `bg-blue-600` / `text-blue-400` rules behind and
  the UI comes out two-toned, so the launcher rewrites every one of them into the new hue
  *at equal relative luminance* — contrast is then preserved by construction rather than by
  eye. That is a filesystem job, not a browser job.
- **The model options live in the server's own module.** Dropping one, or giving one a
  description worth reading, is an edit to a file on disk. No plugin surface reaches it.
- **Seven of the tweaks are inside the app bundle.** The sidebar's Projects/Conversations
  switch is React state; the model menu never passes the description to the menu component
  that would render it; a Conversations row is drawn without the activity, the spinner or the
  menu its sibling rows have, and nothing refetches that list when one of those actions
  changes something; the composer's command menu is assembled from three sources, none of
  which is the CLI's own commands; the sidebar footer has no row for what the proxy has billed
  today; and the Enter key sends by default. None of the first six is reachable from CSS, and
  a plugin runs too late and in the wrong scope to change any of them — the very rows and menus
  it would have to reach are rendered and gone before its module is fetched, and the footer is
  not a tab, so a plugin cannot put anything in it at all. The seventh *is* stored in the
  browser, but a plugin could only overwrite the value you chose — the bundle edit changes the
  default and leaves your choice alone.

So it is one stylesheet, a launcher, and one tab. The upside of doing it this way rather than forking
CloudCLI: nothing here lives in a file upstream also edits, so there is never a merge —
upgrading is `npm i -g @cloudcli-ai/cloudcli` and one launcher run. (Upstream ships a
release roughly every 4–5 days, and does not commit `dist/`, so a fork would mean a weekly
merge *plus* a vite + tsc build with two native modules.)

## What this needs

| | |
|---|---|
| **Node.js 20+ and npm** | CloudCLI is an npm package; the launcher installs it for you if it is missing |
| **A logged-in `claude` CLI on `PATH`** | CloudCLI spawns it per turn and resolves it from `PATH` (`CLAUDE_CLI_PATH` overrides). Install it from [claude.com/claude-code](https://claude.com/claude-code) and run `claude` once to log in |
| **bash and python3** | the launcher is bash; its patches are python |
| **curl and jq** | the Cost tab's report script and the Slack report command — `--no-cost` and `--no-slack` skip them |
| **Linux, or macOS without the units** | everything is POSIX except `systemd/`, which is Linux; on macOS run the launcher directly or wrap it in a launchd plist |

Written against **CloudCLI 1.37.3** and **Claude Code 2.1.263**. The bundle and server patches
are anchored on text upstream chose, so a later release can move an anchor: the launcher then
reports that patch as `MISSING`, applies the rest, and leaves the file it could not patch
untouched — see [the anchor self-check](#the-anchor-self-check). Nothing here forks or vendors
CloudCLI; it patches the installed package in place, on every start.

## Deploy

Running it on a **remote dev box** and reaching it from a laptop is the case two longer guides
cover end to end — the security model, the service, verification, the tunnel, upgrades and
troubleshooting:

- [**Claude Code Web UI on a Remote Server**](docs/remote-server.md) — why a third-party UI at
  all when your access is an LLM gateway, what CloudCLI can reach on the box, keeping it on
  loopback, and running it under systemd.
- [**Remote Dev Server Browser Access over SSH**](docs/browser-over-ssh.md) — one SSH SOCKS
  proxy and a small Chrome extension, so the browser uses the server's own hostname and every
  loopback port works without a tunnel per service.

The short version follows.

### 1. CloudCLI itself

```bash
npm install -g --prefix ~/.npm-global @cloudcli-ai/cloudcli
```

Or skip it: `cloudcli-start` installs the package into the same prefix on its first run if it
is not there.

**Mind the prefix.** The launcher, its patches and the Cost report all address one install:
`$CLOUDCLI_PREFIX`, default `~/.npm-global`. If your `~/.npmrc` sets a different `prefix=`,
a bare `npm install -g` upgrades a copy nothing runs — pass `--prefix` explicitly, or point
`CLOUDCLI_PREFIX` at wherever your install lives.

### 2. The kit

```bash
git clone https://github.com/liran-funaro/cloudcli-kit.git
cd cloudcli-kit
./install.sh
```

That seeds one file and installs the launcher, the report script and the Cost tab:

```
~/.config/cloudcli/ide-theme.css   appearance — yours to retune, seeded once
~/bin/cloudcli-start               applies everything to the package on every start
~/bin/cloudcli-cost                writes the LiteLLM spend report the Cost tab shows
~/.claude-code-ui/plugins/cost/    that tab
```

Nothing is restarted, so it is safe to run while a session is in progress; reload the browser
to see the result. `--no-cost` leaves the tab out, `--no-apply` installs the files without
touching the package, and `--force` replaces a stylesheet you have edited (dating the old one
first). Add `~/bin` to `PATH` if it is not there.

### 3. Run it

```bash
~/bin/cloudcli-start            # HOST=127.0.0.1 PORT=3001 unless you set them
```

It patches, prints what it applied, and execs the server. Open
[http://127.0.0.1:3001](http://127.0.0.1:3001) and create the login CloudCLI asks for on first
run — that account lives in `~/.cloudcli/auth.db`, which is CloudCLI's, not this kit's.

**Keep it on loopback.** CloudCLI runs Claude Code with your credentials and your filesystem;
the unit below binds `127.0.0.1` deliberately, and reaching it from elsewhere should mean an
SSH tunnel rather than a wider `HOST`.

### 4. Under systemd, optionally

```bash
cp systemd/cloudcli.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cloudcli
loginctl enable-linger "$USER"          # so it keeps running after you log out
```

The unit is a copy, not something `install.sh` puts in place: a unit file is yours, and
overwriting one is not a launcher's business. It runs the launcher through a login shell, so
whatever your profile exports (gateway URL, tokens, `PATH`) is what the server and the CLI it
spawns will see.

### 5. The Cost tab, if you run a LiteLLM proxy

The tab frames a page that `cloudcli-cost` writes; the script needs two things in its
environment and nothing else:

```bash
export LITELLM_BASE_URL=https://your-proxy.example.com   # or ANTHROPIC_BASE_URL
export LITELLM_TOKEN=<your-virtual-key>                  # or ANTHROPIC_AUTH_TOKEN
~/bin/cloudcli-cost                                      # writes the page once
```

Then enable **Cost** in Settings → Plugins. For a report that refreshes itself:

```bash
cp systemd/cloudcli-cost.service systemd/cloudcli-cost.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cloudcli-cost.timer
```

No proxy, no token, or a proxy that refuses those endpoints: the page says so and the rest of
the kit is unaffected. `LITELLM_TOKEN_FILE` reads the key from a file instead, and
`LITELLM_TEAM_ID` picks the team when the key belongs to more than one.

### 6. Slack reporting, if you want a run to reach your phone

One variable, and a dry run that proves the payload without posting:

```bash
export SLACK_REPORT_URL=https://hooks.slack.com/triggers/...   # Workflow Builder trigger
cloudcli-slack-report -n -t "hello" -m ":wave: checking"       # prints the payload, sends nothing
cloudcli-slack-report -t "hello" -m ":wave: checking"          # actually posts
```

The trigger has to declare the five variables the command sends — see
[Reporting to Slack](#reporting-to-slack) for the list and the two traps worth knowing before you
wire it. `./install.sh --no-slack` skips the command and its skill; no
variable set means `--dry-run` still works and a real send exits 3 rather than failing quietly.

### Updating

```bash
npm install -g --prefix ~/.npm-global @cloudcli-ai/cloudcli   # CloudCLI
git -C cloudcli-kit pull && cloudcli-kit/install.sh           # the kit
```

An upgrade replaces the files the kit patches, which is the whole reason the launcher patches
on every start rather than once — restart the server and it is all back. Kit updates work the
same way: every start re-patches from the copies the package shipped, so the launcher's own
edits can change between versions without stacking up.

### Going back to upstream

Every layer is reversible without reinstalling anything:

```bash
CLOUDCLI_FRONTEND=0 ~/bin/cloudcli-start    # upstream's bundle, untouched
CLOUDCLI_STEER=0 ~/bin/cloudcli-start       # drop the steering and held-run edits
CLOUDCLI_LINKS=0 ~/bin/cloudcli-start       # drop the clickable paths and the reads for them
rm ~/.config/cloudcli/ide-theme.css         # un-link the stylesheet on the next start
```

And to remove the kit altogether: delete `~/bin/cloudcli-start`, `~/bin/cloudcli-cost` and
`~/.claude-code-ui/plugins/cost/`, then reinstall the package (or copy each
`<file>.kitorig` in `dist-server/` back over its file) and start `~/.npm-global/bin/cloudcli`
directly.

## The retired Recent tab

The tab was a plugin — one file, a shadow root, no build step — and it existed because
CloudCLI's sidebar did not show what it showed: every project's conversations in one
recency-ordered list, each marked *working* if the server had it in
`/api/providers/sessions/running`, or *your turn* if it was not running and its transcript
had been touched in the last 6 hours (`lastActivity` comes off the JSONL's mtime, which
advances while Claude writes, so a recently stopped session is the one that just asked).

The sidebar's Conversations tab is that list, and the patches below give it the rest: it is
the tab you land on, its rows carry the working and needs-an-answer dots, and each row has
the session menu the Projects list always had. So the tab was a second place to look at the
same thing, in a corner of the window, and it is gone — `git log -- index.js` if you ever
want it back.

The launcher un-seeds what its earlier floating-pill version left behind, and `install.sh`
reports a still-installed plugin directory rather than deleting it: that is a clone with a
switch beside it in Settings → Plugins, and removing either is yours to do.

## Nine small edits in the bundle

Three are things the app already almost does; one is a default worth flipping; one is a menu
that never listed what the CLI can do; one puts a number on the page that was only ever a
command away; one draws two things the app never mentioned at all:

Two more used to live here and no longer do: the **Conversations row** and its **rename/delete
refresh** landed upstream in 1.37.3 as
[#1157](https://github.com/siteboon/claudecodeui/pull/1157), so the kit stopped carrying them —
the app draws that row itself now, and patches the row in place rather than refetching.

- **Conversations, not Projects, as the sidebar's default.** The switch is `useState` that is
  never persisted, so it reset to Projects on every load.
- **The model's description in the model menu.** Every option already carries one, and the
  menu-item component already renders one when given it — the effort menu right next door
  passes exactly that prop. The model menu just never did.
- **The CLI's own commands, in the command menu.** That menu offers three things — six
  built-ins the *server* implements, the provider's skills, and whatever sits in
  `.claude/commands` — and never the commands the **CLI** implements. `/compact` above all,
  which is the one you reach for when a session grows long. Nothing was broken, only
  invisible: typing `/compact` in full and pressing Enter already worked, because a query
  matching nothing falls through to an ordinary send and the CLI reads slash commands from the
  same stream-json channel the server already talks to. So the menu was the whole gap. Five
  are listed — `/compact`, `/context`, `/usage`, `/model`, `/clear` — each checked against the
  CLI on that channel, each answered by the CLI itself with no model call. They are *inserted*
  into the composer rather than executed, which is how the menu already treats a skill: the
  app has no handler for them and needs none, since sending the line is what does the work.
  Claude sessions only; the other providers would take them for a prompt.

  Both of the app's *would I execute this?* tests have to learn the new type — the menu's,
  which is a named predicate, and the composer's, which inlines `type !== "skill"` when a typed
  line starts with a slash. Missing the second makes listing a command worse than not listing
  it: the line that used to fall through to the CLI starts matching something the app tries to
  execute, and the server refuses it for having no file behind it
  (*Command path is required for custom commands*).

  The list is short and hand-kept because a substitution cannot do better. The CLI advertises
  its whole list — 63 on this machine, skills and plugins included — in the `init` frame of
  every run, and reading *that* is the honest fix: the server drops the frame before the
  browser sees it, and a patched server module would only land on the next restart. That one
  belongs upstream.
- **Today's spend and the cycle, permanently in the sidebar footer.** The [Cost
  tab](#the-cost-tab) is the whole report; this is what is worth seeing without going to look
  for it — `today $257.68 · cycle 37.5%`, with the cap, the reset date and the team's figure in
  its tooltip — in a row of
  exactly the shape the footer already stacks, above Settings. It reads the json sidecar
  `cloudcli-cost` writes beside the report — one number, rather than a page whose markup the
  chip would then depend on — and refreshes every 60s. No key reaches the browser: the file is
  already on disk, written by something that had one.

  React state would be the obvious way to hold that number and the obvious way to get it wrong
  from a substitution: hooks must be declared unconditionally and in order, inside a component
  whose minified name is a guess away from being wrong. A `ref` callback needs none of that.
  React hands it the node on mount and `null` on unmount, so the first mount starts one
  interval for the page's lifetime — guarded, so re-mounting the sidebar cannot start a second
  — and every later render re-fills the node from what was already fetched, which is why the
  number survives a re-render instead of blinking back to a dash. With no report on disk it
  reads `today —`, and says why in its tooltip.
- **Compaction and waiting, drawn where they happen.** The browser half of [patch
  9](#compaction-said-out-loud) and [patch 10](#waiting-said-out-loud) — one edit each in the
  mapper and the row renderer, shared because the two rows are the same shape: a dot, a
  sentence, a number, a bar, a disclosure. A compaction gets the CLI's own percentage while it
  runs, and the
  summary folded behind *full summary* — the disclosure standing in for the CLI's ctrl+o.
  Two rows are folded into one on the way: the boundary and the summary that follows it are
  separate records, and a summary sitting alone (an older session, compacted before the CLI
  wrote boundaries) still gets a row of its own to fold into. A bar with a finished
  compaction after it is dropped rather than drawn, so history never shows one that will
  never stop.

  A wait is the same row read the other way: the number counts **down** to a deadline the
  server chose and the bar drains toward it, because unlike a compaction that deadline is a
  real one. Behind its disclosure is what is being waited for, one line per task, from the
  CLI's own list. Only the newest countdown survives the mapper, so history never shows a
  clock that will never stop.

  The look is not in the patch. It is `.kit-row-*` in
  [`theme/ide-theme.css`](theme/ide-theme.css), loaded after the app's own stylesheet and
  built from the app's variables — so it follows the theme with no dark-mode copy, and can be
  retuned without re-patching. The elapsed counter ticks from a `ref` callback for the same
  reason the [spend chip](#the-cost-tab) does, with one interval for the page that stops
  itself as soon as no row is left to update.
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
frontend: 9/9 applied -- sidebar default, model description, ctrl+enter to send,
send while running, cli commands, cost chip, compaction and wait rows,
clickable paths, token chip dash
```

Nine because three of them belong to patches described below rather than here: *send while
running* to steering, *clickable paths* to the paths patch and its server half, and *token
chip dash* to the token counter. `CLOUDCLI_STEER=0` leaves the first out, `CLOUDCLI_LINKS=0`
the second, and the count comes down with them.


Several are read from more than one anchor, and no minified name is guessed: each comes from a
site that says which is which — the row that carries the cost chip names the JSX factory, the
markdown renderer names its own plugin array, the token chip names its formatter. A name that
appears more than once is accepted only when every occurrence agrees on it, and a patch whose
names did not resolve is skipped and reported rather than applied on a guess.

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

**A browser reload does not pick this one up.** It is a server module, already in node's memory,
so it lands on the next server start — which the launcher will not force while a session is
live. The two patches below are server modules too, and land the same way.

## A Stop that always stops

Stop — the button, and Esc — calls the SDK's `interrupt()`, which is not a signal but a control
request *written to the CLI's stdin*. So it is answered only while the child is alive and
reading, and a child that has wound down has nowhere to answer from: the promise never settles,
so the session is never removed, so the abort handler never returns and the client never
receives its terminal `complete`. The UI sits on *processing*, Esc does nothing, and every later
Stop wedges on the same session. Only a server restart clears it.

Upstream 1.37.2 narrowed the window — it holds stdin open for the turn, and for up to half an
hour past it when the turn left background work running — where 1.37.1 closed it at the first
`result` of every text-only turn. Narrower is not closed: a run whose child has exited, or one
too busy to read, still wedges.

So the patch gives the control request two seconds and then stops asking: it closes the
transport, which needs no cooperation from the child. This one is not gated and not optional —
it is a hang, and a transport whose child already answered is one the SDK closes next anyway.

```
[KIT] interrupt() unanswered for <session> (timed out); closing the transport
```

That line is the only sign it was needed. Stop working is what it looks like otherwise.

## Steering a turn in flight

```bash
CLOUDCLI_STEER=0 cloudcli-start     # to turn it off
```

On by default, and the other side of the same coin as Stop. Upstream holds a
message typed while a turn is running — it becomes a draft, sent once the run ends. But the
stdin that carries `interrupt()` is open for the whole run, and a user frame pushed into it is
read at the next agent-loop boundary, in the **same** turn — the model changes course mid-run,
no restart, no resume, nothing about how the turn was started has to change. Which is what
makes it small.

Since 1.37.2 that open pipe is upstream's own doing, and the patch rides it. Every turn is
sent as a stream that yields its messages and then **parks** (`createHeldPromptStream`),
deliberately holding stdin open so background work can report back through it and the CLI can
push follow-up turns. Steering needs exactly that pipe, so the patch puts a queue on the park:

- **The park passes on what is pushed to it.** With nothing steered in it awaits and returns
  precisely as upstream's `await held` did; a frame pushed in the same tick as the release is
  drained before it ends, rather than lost to the race.
- **A push after the release is refused, not queued.** Upstream closes the stream in its own
  `finally` and on abort, and a frame written then would go into a closed pipe. The refusal
  reaches the composer as *cannot steer*, so the send is held back the way upstream holds it —
  rather than recorded as a line nothing acted on.
- **Write the line down.** The CLI applies the frame but records nothing, and CloudCLI's history
  *is* the CLI's transcript — there is no second copy anywhere. So the launcher appends the line
  itself, in the shape a user turn has, chained onto the newest entry: the reader takes it for a
  normal user message, and the CLI replays it on the next resume rather than continuing a
  conversation it has no record of being redirected. Without this the steer is real but
  invisible — the model reacts, and the message is gone on the next reload.

Before 1.37.2 the same trick hung off the SDK's string-prompt path, which left stdin open by
omission and only for turns without attachments — so those turns had to be sniffed out at the
`query()` call site and skipped, and the kit ran a second `streamInput()` of its own whose
queue could never be allowed to end. Upstream now states the lifetime the patch used to infer,
and all of that went away: every turn is steerable, attachments included.

A message can also land when the turn is over but the process is still held open for its
background work. That is not a steer — the run is idle, not mid-turn — and it takes a different
route for a different reason: [see patch 10](#waiting-said-out-loud), which pushes it into the
same parked stdin so the work being waited on survives.

The browser half is one of the bundle substitutions: the composer's busy guard learns one
condition, so a send during a run goes out instead of becoming a draft. It is still guarded on a
global rather than compiled in, but the sense is now the escape hatch — `__cloudcliSteer = false`
in the console puts a tab back on upstream's hold-it-back composer mid-session, with no restart.

```
chat: applied stop always stops, waiting ceiling, waiting env, waiting state, waiting expiry,
waiting tasks, waiting hold, steering history, steering channel, steering queue, steering park,
steering pusher, steering export, waiting resume, steering passthrough, steering route,
waiting route
[KIT] steering <session> mid-turn (32 chars)
```

Ten steering-gated edits across three server modules — the eight above plus the two that take a
message into a [held run](#waiting-said-out-loud); the rest of that line is Stop and patch 10's
ungated half. So it is all-or-nothing by construction — a facade naming a function that failed to be inserted is a
ReferenceError at import, i.e. a server that does not start. And every one of them is
**reversed** by `CLOUDCLI_STEER=0`, back to byte-identical with what upstream shipped. Turning
steering off is a restart, not a reinstall.

## Compaction, said out loud

Compaction is the one thing the CLI does that CloudCLI never mentions. The normalizer knows
deltas, text, thinking, tool calls and tool results, and returns nothing at all for a `system`
event — so both records that describe a compaction are dropped on the floor, and the only trace
left in the conversation is the summary itself: a 24 KB assistant bubble, arriving with nothing
in front of it to say what it is or where it came from.

Two records, one row. The status the CLI sends when it starts compacting becomes a row that says
so, with a bar and a percentage; the boundary it sends when it is done becomes a row with the numbers — and the
numbers are worth having, because a compaction is the most expensive thing a long session does
without being asked:

```
Compacted · auto · 725k → 18k tokens · 2m 56s        ▸ full summary
```

`trigger` says whether you asked for it or the window did. Everything the row shows is in the
message's `content`, so an unpatched bundle renders it as the sentence it is; the `compact`
field beside it is only how the browser half draws it.

The field survives the trip because the server's own `createNormalizedMessage` spreads what it
is given, and 1.37.3's row mapper is where it would be lost — it builds each row from an
explicit list of fields. So the browser half anchors on that mapper's second loop, from its
header to the `switch`, and carries **everything upstream does inside it through untouched**:
the tool-result lookup, the subagent map and the projection cache are the matched text, replayed
verbatim. The patch adds two fields to the row template and one branch before the switch. A row
that branch pushes never reaches the projection cache, so it is rebuilt on every render — which
is what keeps a live countdown honest.

That loop grew a cache and a subagent map in #1206 and will grow again, which is why the anchor
stops at the switch rather than restating the loop. `launcher/rows-check.mjs` lifts the patched
loop out of the shipped bundle and runs it — real compaction rows read out of a real transcript
by the patched server module, plus the ordering rules by hand:

```
$ node launcher/rows-check.mjs <patched ide-*.js> <package dir> <transcript.jsonl>
real transcript: 19 compact rows carried through, 6206 rows total
all checks passed
``` The
metadata is spelled `compact_metadata` in the live stream and `compactMetadata` in the
transcript, so both are read — one branch serves the live turn and the history refetch that
replaces it, because upstream normalizes both through the same function.

The percentage is an estimate, and it is the CLI's estimate. Nothing in the stream reports real
progress: the CLI is told that compaction started and, much later, what it cost — exactly what
CloudCLI is told. So the number under its spinner is a curve over elapsed time,
`min(95, round((1 - e^(-t/90)) * 100))`, and that is what fills the bar here, lifted formula and
all out of the CLI binary. It eases toward a ceiling of 95% it never passes, so a compaction that
runs long never reads as finished, and the elapsed counter runs beside it as the one reading that
is not a guess:

```
● Compacting conversation…                                    2m 56s
  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░  86%
```

Copying the curve rather than inventing one is the whole point: the same compaction reads the
same in both windows. One 1-second interval drives every row on the page, and both numbers and
the width come from the row's own timestamp — so a re-render, or a second tab opened halfway
through, shows the same figures — and it stops itself as soon as no row is left to update.

Not gated on `CLOUDCLI_STEER`, and nothing to turn off — it adds a line to the transcript's own
account of itself and takes nothing away. Like the patches above it, the server half lands on
the next server start:

```
sessions: applied compaction, history token counter
```

## Waiting, said out loud

```bash
CLOUDCLI_STEER=0 cloudcli-start     # leaves the rows and the ceiling, drops the resume
```

A turn that ends with background work still running is the one case where CloudCLI shows a
finished turn and means *still waiting*. Upstream does the hard part: at the turn's `result` it
holds the CLI's stdin open — up to `BG_WAIT_CEILING_MS`, thirty minutes — precisely so a
monitor or a background shell can finish and push a follow-up turn. But the client is told
`complete` when that first `result` lands, and **nothing** is sent when the hold begins, when it
runs out, or when the work reports back. A session waiting on a test looks exactly like a
session that stopped.

It is not a rare corner. In one long-running session here — eight days, 10,845 records — the
agent handed work off to the background 46 times and **14 of those handoffs died silently**,
each one ending the same way: a `Monitor` or a backgrounded `Bash`, a last assistant line, then
a gap of 0 to 187 minutes, then a human typing *continue* and getting

> No completion record was found for this background shell command from the previous session. It
> may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no
> transcript marker)…

Three things were wrong, so patch 10 is three things.

**The wait is drawn.** The hold, the report-back, and the expiry each become an ordinary
assistant row, so the transcript says what the session is doing:

```
● Running in the background · errors in deploy.log                        3m 12s
  ▸ what is running

● Waiting on 1 background task · up to 42m                          41m 12s left
  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  ▸ what it is waiting for

● Background work reported back after 4m 12s
● Background work never reported back · waited 42m
```

The countdown and the draining bar come from the deadline the server actually chose, and behind
the disclosure is the CLI's own task list — `local_bash · run the suite` — so the row names what
it is waiting for rather than just that it waits. Everything it says is in the message's
`content`, so an unpatched bundle reads it as the sentence it is. These rows are live only: they
are CloudCLI's account of its own hold, not records in the CLI's transcript, so a reload after
the fact shows the transcript's version of events (the CLI's task notifications) rather than
these.

The first of those rows answers a different question from the rest: not *is this session still
waiting* but **what has it got running right now**. The CLI keeps that list itself and sends it
on every change — it is how the hold row knows what to name — but the kit only ever spoke it at
the hold, so while a turn was still working you had the tool call that armed each piece of work
and nothing that said which were still outstanding. Now a growing list says so, with an elapsed
clock and no bar, because at that point there is no deadline to drain towards: the ceiling is
chosen when the turn ends and the hold begins. Only the newest of these rows survives in the
view — the browser half drops the ones a later wait row has overtaken — so it reads as the
current state rather than as a pile of events, and the hold, the report-back or the expiry
replaces it in turn.

**The wait lasts as long as the work said it needs.** Thirty minutes is upstream's figure for
work that never reports; it is not a figure the *tools* agree with. The same session armed
monitors for 25, 30, 40 and 50 minutes — and a silent 50-minute monitor inside a 30-minute hold
cannot report before its container is torn down. The kit reads what each turn armed (a
`Monitor`'s `timeout_ms`, or the outer bound for a `persistent: true` one) and stretches that
run's hold to it plus two minutes, bounded at an hour, and hands the CLI the same bound so the
server's per-run figure is always the one that decides. The timer still measures *silence*, so a
chatty monitor is never cut off at all.

**Your next message goes into the same process.** This is the part that was destroying work.
The registry marks a run `completed` when that first `complete` passes through it, so a message
typed during the hold was not steering — it started a *new* run, and a new run supersedes the
held one: `addSession` interrupts it and releases its stdin, and the CLI takes every background
shell and monitor it was tracking down with it. Prodding a waiting session was the thing that
guaranteed the answer *no completion record*.

So the send path asks first. If the session has a run whose turn is over but whose process is
still held, the message is pushed into that same parked stdin, and the turn it starts belongs to
the new run — the loop swaps which writer it reports to, owes that run a `complete`, and the
countdown row is replaced by

```
● Continued in the same process · 1 task still running
```

What the CLI does with a frame pushed into a parked stream is not inferred. A probe against
2.1.235 armed a background shell, waited for the `result`, then pushed a second turn: the CLI ran
it as an ordinary turn, **wrote it into its own transcript** (unlike a mid-turn steer, which
patch 5 has to record itself, because there the CLI is busy rather than parked), and the shell
armed by the turn before it survived and reported back afterwards, in a third turn. Three turns,
one process, nothing lost.

Steering already owns the pipe this needs, so the resume half is gated with it and the rows and
the ceiling are not: `CLOUDCLI_STEER=0` leaves a session that still says what it is waiting for
and still waits long enough, and goes back to superseding the process when you speak.

```
chat: applied stop always stops, waiting ceiling, waiting env, waiting state, waiting expiry,
waiting tasks, waiting hold, steering history, steering channel, steering queue, steering park,
steering pusher, steering export, waiting resume, steering passthrough, steering route,
waiting route
[KIT] <session> took a message into its held run (8 chars)
```

Two notes on what a resumed turn is not. It carries text only — a message with attachments still
starts a fresh run, because the parked stream takes frames rather than uploads — and it runs with
the model and effort its process was started with, so a model changed in the composer applies to
the next *new* run, exactly as with a mid-turn steer.

## A path in the chat, clickable

```bash
CLOUDCLI_LINKS=0 cloudcli-start     # to turn it off, both halves
```

An agent hands you paths constantly: the file it changed, the line it means, the report it
wrote for you to read. Claude Code is asked to write them as `file:line` precisely because a
terminal and an IDE both make that a link you can follow. In CloudCLI it was text — select it,
copy it, go find it yourself.

The renderer was most of the way there. A markdown **link** whose target looks like a file
already opens that file in the editor panel: it checks the href, then the link text, and hands
either to the app's own `openFileInEditor`, which resolves it against the project's own file
list before opening. What it never sees is a path that was not written as a link — which is
every path an agent actually writes.

So the browser half adds no handler, no route and no component. One rehype plugin, running
after the markdown tree is built, hands upstream's own `<a>` handler the shape it already
knows:

- path-looking **text** becomes an anchor;
- an inline **`code`** span whose whole content is a path is wrapped in one, keeping the code
  element as the anchor's child — so it still renders as the chip it was, with one class added
  for the stylesheet to find.

The click, the project-relative resolution and the editor panel are all upstream's.

What counts as a path is deliberately asymmetric, because the two forms carry different intent.
In prose: an absolute path, a `~/` or `./` one, a relative one with a file extension, a bare
filename whose extension is one of a listed set, or anything with a `:line` suffix. In
backticks, which is someone naming a file on purpose: any path with a slash, plus that same set
of bare filenames. So `and/or`, `24/7` and `TCP/IP` stay words, `Math.min` and `Service.Run`
stay identifiers, `2.1.235` stays a version, `api.anthropic` stays a hostname, `Node.js` stays
a runtime, and mime types are excluded by name. Existing links and KaTeX are left alone, and so
are fenced code blocks — not out of caution but because that component joins its children into
one string for the copy button and the highlighter, so an element inserted among them would
break both. A fenced block is something you copy, not something you click.

Measured against 400 assistant messages from real transcripts on this machine: 62% of every
path-shaped string outside a code block becomes a link, and what is left is almost entirely
not paths — `0/0` and `271/487/283/425` from a test summary, `12/29` from a checklist,
`-c/--commit` from a usage line, `Math.min` and `chat.send` from prose about code. Which is the
trade being made on purpose: a missed path costs a copy-paste, an over-eager one costs a pane
that says the file is not there.

It still guesses, and a guess is cheap in one direction only: `/api/file-tree/projects` in a
sentence about routes becomes a link that opens a pane saying the file is not there. That is
the whole cost, and it is why a chip stays a chip — the stylesheet gives a path in backticks
the cursor and an underline on hover rather than a second colour, so a sentence full of file
names does not turn blue.

### The read behind it

A link is worth nothing if the read behind it is refused, and one of them was. The file-tree
API confines every path to the project root, so the report an agent wrote into `/tmp` came back
`403 Path must be under project root` — the reported case, and the reason this patch has a
server half at all.

One function gets a fallback, and only for reads: an **absolute** path that resolves outside
the project root is read anyway. A relative path stays relative to the project, and every
write, rename, delete and upload goes through upstream's check untouched — so the project root
remains the only place this server will *change* anything. What it refuses are the two ways a
read can hurt the server itself: `/proc`, `/sys` and `/dev`, where a file reports a size it
does not have and a read can never end, and anything over 16 MB, which is not a thing to hand
a browser as text. The blob route that previews an image or a PDF gets the same fallback and no
size cap, because it streams.

The bound that matters here is the one on the process, not the one on the person: the same
logged-in session can already run `cat` in the Shell tab, so this hands the UI no reach it did
not have — which is also why it is worth being deliberate about, and why it is one flag. On a
deployment where that reasoning does not hold, `CLOUDCLI_LINKS=0` puts the file back
byte-identical with what upstream shipped and leaves the links unmade.

One consequence worth knowing: a file outside the project opens, but does not save. The editor
still offers its Save button and the server still refuses it, with the message above.

```
frontend: 11/11 applied -- ..., clickable paths
file reads: applied
```

Like every server-side patch, this one lands on the next server start; the browser half is live
on the next reload.

## The token counter, and the three ways it read wrong

The number beside the composer had three ways to be wrong, and two of them said `0`
for a session holding half a million tokens.

**A message the CLI wrote itself.** The counter is republished from every message
carrying a usage object. The CLI writes some of those itself — model `<synthetic>`,
one for the interrupt notice, one for an API error, one for the usage-limit line —
and each carries a usage object with zeros in every field. Upstream published it
like any other, so pressing Stop zeroed the counter until the next real turn.
Counted over every transcript on this machine: **54 of 18,200 usage-bearing records**
would push a number under 5,000 into it, and all 54 are that one shape — the lowest
real reading in the corpus is 42,535, so the floor is not a matter of judgement.

**Two frames, and neither one is a context reading.** This is the `2 tokens` seen while a
turn is thinking. A five-call turn, captured on this deployment:

```
assistant  keys=[input_tokens, output_tokens]                                 ->   5,473
assistant  keys=[input_tokens, output_tokens]                                 ->   5,473
assistant  keys=[input_tokens, output_tokens]                                 ->       2
assistant  keys=[input_tokens, output_tokens]                                 ->       2
assistant  keys=[input_tokens, output_tokens]                                 ->       2
result     input=5479 cache_creation=39270 cache_read=111775 output=312       -> 156,836
           iterations: 0                    modelUsage.contextWindow: 1000000
```

The mid-turn frames carry `input_tokens` and `output_tokens` and *nothing else* — no
`cache_creation_input_tokens`, no `cache_read_input_tokens` — so what they report is the
**uncached remainder**, two or three tokens once the cache is warm, with the output not counted
yet. And the `result` is not the corrected version of them: it is a **sum over every call in
the turn**. That 156,836 is a conversation that ended on nearer 45,000 — the count of calls,
not the size of the context. Publishing either is a wrong number, in opposite directions, and
the second one is the one this kit published for a while and called complete.

One rule, then, and it is about shape rather than size: **a reading has to be a complete
per-call account.** No input at all is a message the CLI wrote itself. No cache fields at all
is a frame that has counted only part of its input. Every one of the 18,091 usage records in
the CLI's own transcripts carries all four fields, so their absence is the signal.

The aggregate is not discarded so much as unpacked: `usage.iterations` holds the per-call
figures it was summed from, and the newest `message` entry there — past the `compaction` and
`advisor_message` sub-inferences, whose usage is their own call's — *is* a per-call account.
Where that array is populated it is the live reading. Where it is empty, which is this stack on
both captured turns, nothing is published at all and the counter keeps its last complete
figure, which the transcript supplies through the history refresh below. That shape is
[thevinchi's, from claudecodeui#1125](https://github.com/siteboon/claudecodeui/pull/1125),
reached from the aggregate's side; the cache-field test is what that approach needs on a stack
whose per-call frames arrive partial, and is [issue
#1208](https://github.com/siteboon/claudecodeui/issues/1208).

**No reading, and something worse than none.** The chip renders unconditionally and
computes its number as `used || input + output`, so given nothing it prints `0 tokens`;
upstream's own formatter maps anything `<= 0` to `"0"`. That accounts for the gap between
switching to a session and its numbers arriving — but not for a counter that drops to zero
*after every completed turn*, which is [upstream issue
#1182](https://github.com/siteboon/claudecodeui/issues/1182): the frontend's session slot is
initialised with `tokenUsage: null`, and all three consumers gate on `!== undefined`, so every
history refresh writes that `null` straight over a live reading. A Claude session's history
carried no usage of its own to displace it with, where the Codex provider's already does.

Two halves here, and neither is the whole fix. The server sends a reading with the history:
`fetchHistory` has just read the whole transcript, and the last usage recorded there is
precisely what the live counter last showed, so it goes out on the same `tokenUsage` field Codex
uses, which the sessions service spreads through and the frontend store already carries — no new
route, no new state. That turns the clobber into a write of the right number. And the chip gets
an *unknown* state: a dash, not a zero, for the moment before any of it has arrived. The button
stays where it is and still opens the token dialog; it just stops asserting a number it does not
have.

What this does **not** claim is the cold open. Upstream already serves that: the frontend
fetches `GET /api/providers/sessions/:id/token-usage` on every session change, and
`readClaudeTokenUsage` scans the transcript backwards exactly as this does. Measured against it
over all 21 transcripts here, the two agree on 19 and neither finds a reading in the other 2.
The one thing that reader can still get wrong is the shape above: it breaks at the last
assistant record carrying a usage object, and a `<synthetic>` record carries one full of zeros.

While reading all this, the window being measured against was `CONTEXT_WINDOW`, whose default
is 160,000 — so a 1M-context model spent every long session measured against a sixth of its
window. The kit used to lift the real number out of `modelUsage`, where the CLI reports one
entry per model with a `contextWindow` on each. On 1.37.3 that pickup is gone: the budget is
built in `buildTokenBudget`, which is handed a usage payload and never sees the message the
`modelUsage` sits on, so re-adding it would mean threading the message through a function that
deliberately takes none. The window comes from `CONTEXT_WINDOW` again — set it per deployment
(`Environment=CONTEXT_WINDOW=1000000` in the unit here). The cost of that is honest to state: a
session switched to a smaller model reads against the configured number rather than its own.

**What 1.37.3 does itself, and this no longer patches.** Upstream now reads the per-call
assistant frame rather than the turn-summed `result`, skips subagent traffic and the
`<synthetic>` all-zero rows, and hands a reading back with each page of history
(`summarizeClaudeTokenUsage`, which skips sidechains and zero rows exactly as the kit's own
reader did). Six of this patch's members and the whole history-counter patch went with it.

**What is left is one guard.** Upstream still publishes a *partial* account: a frame whose cache
fields are absent, whose `input_tokens` is therefore only the uncached remainder — 2 against a
warm cache — which is how the badge lands on single digits and stays there. The kit requires
both cache halves to be reported (presence, not value: a cold first request reports both as
zero) and a prompt above zero, and publishes nothing otherwise, so the last complete reading
stands. That is
[claudecodeui#1288](https://github.com/siteboon/claudecodeui/pull/1288), open upstream; when it
lands, this member follows the six.

```
frontend: 9/9 applied -- ..., clickable paths, token chip dash
chat: applied ..., token counter guard, token counter fallback, ...
sessions: applied compaction
```

Neither half is gated on a flag: together they remove wrong numbers and add none. The browser
half lands on the next reload, the server half on the next restart.

## Compaction — landed upstream, and this stands down for it

[claudecodeui#1295](https://github.com/siteboon/claudecodeui/pull/1295) merged the
compaction row: the provider emits it, the client folds the summary into it, and the three
rows one compaction produces are reconciled in whichever order they arrive. That is this
kit's patch, ported into upstream's shapes (`CompactionInfo`, i18n keys, its own row idiom).

1.37.3 predates the merge, so both halves still apply here. The release that carries it
would draw a row of its own beside the kit's, so each half now checks for upstream's marker
first and reports itself gone instead:

```
MISSING: compaction and wait rows (upstream draws compaction now; the kit rows would double it)
MISSING: compaction (upstream emits the row now)
```

The wait rows have no upstream equivalent and go out with them, which is the honest trade:
upstream's activity indicator names a held session's work above the composer, so the live
case is covered, and what is lost is the record after a reload. [#1296](https://github.com/siteboon/claudecodeui/pull/1296)
proposed keeping that and was closed — most of it landed upstream by better means, including
a task tracker that gets the foreground-`Agent` case right where the kit's rule did not.

## A plugin's skills, when it also ships commands — landed upstream

A plugin may ship `commands/`, `skills/`, or both, and the CLI reads both. The server read
whichever it found first, and its commands reader takes `.md` only — so a plugin whose commands
are in another agent's format lost both halves at once, contributing nothing to the command menu
with no error to say why (`ponytail`, six `commands/*.toml` and six real skills, was exactly
that). Dropping one `continue` fixed it.

That is in 1.37.3 as [#1274](https://github.com/siteboon/claudecodeui/pull/1274), so the kit no
longer patches it. Kept here as the reason the launcher's report is one line shorter than it was.

## Worktrees, under the repository they belong to

```bash
CLOUDCLI_WORKTREES=0 cloudcli-start     # one project per worktree, as upstream builds it
```

A worktree is a checkout of the same repository, so a project per worktree splits one piece of
work across rows that cannot see each other — six of them here for `acme-server` alone.
The projects list folds every checkout into the repository's own row and reads their sessions
as one list, newest first, with the worktree named on each row:

```
▾ acme-server
    ● fix the flaky test          .wt-1   2m
    ● cache size probe       .storage1h
    ● tidy the teardown                 3h
```

Discovery is git's rather than a registry of ours — `rev-parse --git-common-dir` says which
repository a path belongs to, `worktree list --porcelain` says what else belongs to it — so a
tree made with a plain `git worktree add` is tracked with no project added for it. Both calls
fork, so the answer is cached for 30 seconds; the sidebar asks on every refresh. "Load more"
reads the same union, or page two falls back to the main checkout and repeats it.

**A worktree that was deleted** keeps its sessions attributed, which took some looking. Git is
no help: `worktree list` no longer names it. Nor is the transcript, which records `cwd` (the
vanished path, nothing new) and `gitBranch` — and that branch is usually deleted with the
worktree, as `storage/drop-unused-index` was here, present in no repository any
more. What survives is the path and the convention that made it, so an orphan is attributed to
the longest repository path it extends, with a separator required after it (`acme-common`
does not claim `acme-commonwealth`). That is an inference from naming rather than evidence,
so it applies **only to paths that no longer exist**: nothing live is ever reclassified, and a
path on another machine — `/Users/…/acme-server` — is left alone rather than merged into
the local repository's row.

**Which checkout a new session runs in** is then a question the row can no longer answer, so
the panel that asks the rest of it does: a new conversation opens with the provider/model card
at the top of the transcript, and the select sits directly under that card, above the
*ready with …* line. That panel exists only until the first message, so nothing has to gate the
select — it disappears with the panel, which is right: an existing session already runs
somewhere and a select cannot move it. Choosing one sets `cwd` on the next send, which is
all the server needs — `projectPath` for a session comes from the transcript's own `cwd`
(`claude-session-synchronizer.provider.ts`), so a session started in `.wt-2` records itself
there and comes back badged like every other worktree session. A repository with one checkout
shows no select at all.

Each option names the checkout and **the branch it has out**, which is what tells two of them
apart when the directory names do not:

```
worktree [ main              release/2.x        ⌄ ]
           .signing             feat/faster-signing
           .storage          design/storage
           .wt-2             detached
           .storage
```

`git worktree list --porcelain` reports the branch in the same call that reports the paths, so
this costs a few lines of parsing and no extra process; `detached` is reported as such, and a
checkout git no longer lists — a deleted worktree — carries no branch at all.

The list travels with the project row rather than being fetched, because the client cannot
reach `/api/worktrees` without the app's own auth helper — and it includes worktrees that were
never registered as projects, which is how `.parser`, `.metrics` and `/tmp/baseline`
appear here without anyone adding them.

**The live path coalesces too.** `session_upserted` named the session's *own* project, so the
first message of a session in a worktree made the sidebar grow a row for that worktree — which
the next refresh took away again, since the coalesced list does not contain it. The broadcast
now names the repository and carries the worktree label, so the row appears in the right place,
badged, without waiting for a reload. Both halves share one grouping index rather than forking
git twice.

`launcher/worktree-check.mjs` runs the patched service against a real temporary repository with
real worktrees, one of them removed properly mid-test, plus a lookalike directory and a
foreign-root path that must both stay separate.

## The model alias, pinned

```bash
CLOUDCLI_MODEL_PIN=none cloudcli-start          # send the alias through untouched
CLOUDCLI_MODEL_PIN=claude-opus-4-8 cloudcli-start   # pin somewhere else
```

The CLI resolves a bare family alias to the **newest** model in it, and it moves that target
without asking: 2.1.280 moved `opus` from `claude-opus-5` to `claude-opus-5-5`. Behind a
gateway that allow-lists models per team, the next turn after a CLI auto-update fails outright:

```
API Error: 403 team not allowed to access model. This team can only access
models=[…'aws/claude-opus-5'…]. Tried to access claude-opus-5-5
```

Measured against the proxy when it happened: `claude-opus-5` answers 200, `claude-opus-5-5`
answers 403 — so it is the alias that moved, not the key that broke (the key had been fine
all along, which is worth saying because the proxy reports its own failures as auth errors
too; see the Cost tab above).

So `default`, `best`, `opus` and `opus[1m]` are pinned to the newest Opus the gateway serves,
at the one point where the model goes to the SDK — after the effort lookup, which keys on the
catalog's own value and has to keep seeing it. A resumed session carrying the old alias is
covered as well, since every run passes there. `[1m]` is preserved, so the pinned id keeps the
1M context the option promised.

Terminal sessions do not go through the server, so `~/.claude/settings.json` needs the same
pin: `"model": "claude-opus-5[1m]"` rather than `"opus[1m]"`.

## The Cost tab

A LiteLLM proxy bills per token, and nothing in CloudCLI knows that. So the kit
carries [`cost/litellm-cost.sh`](cost/litellm-cost.sh) — the terminal dashboard
`litellm-spend.sh` with the terminal taken out: the same three queries against
`/user/info`, `/key/list` and `/user/daily/activity`, the same jq, rendering one
standalone HTML page instead of columns — and arranged around the **budget cycle**,
which is the thing being tracked. Where the cycle stands against its cap for your
keys and for the team, with the burn rate and where that lands by reset; then today,
yesterday and the week; then one table per key and one per member within the cycle, by
model, and the token and cache figures. A month-by-month table stays for trend, and that is the
only place a total appears.

Two figures describe a cycle and they do not agree, which the page says rather than
hides. The **counters** — a key's `spend`, a team's `spend` — are live, per request,
and are what a cap is enforced against: those are the budget. The **ledger**
(`/user/daily/activity`, `/team/daily/activity`) aggregates per UTC day and is the
only source for a per-day or per-member figure. Summing the ledger from the cycle's
start lands a few percent under the counter, and no boundary reconciles them — tested
across a week of candidate start dates, where one key's ledger sum came out identical for
three consecutive starts while its counter sat $58 above all of them. So counters answer
*how much of the budget is gone*, the ledger answers *where it went*, and each table
says which it is reading.

The cycle window itself is derived from the API: `budget_reset_at` minus
`budget_duration`, taken from the team when it has a budget and from your keys
otherwise.

Your keys are **one** table joining both sources rather than two side by side: cap and
what is left of it can only come from a counter, today and the week can only come from
the ledger, and where both have a cycle figure the counter wins because that is what
the proxy enforces. A key rotated or deleted inside the cycle has no counter left, so
it is marked `· ledger`, keeps its ledger figure, and shows no cap to run into.

**This is the one part of the kit that must never go upstream.** A LiteLLM ledger
is not something CloudCLI knows or should know about, which is also why the report
is a *file the app serves* rather than a route the app implements: nothing in the
server or the bundle is patched for it.

Last comes the team, for reference: **spend per member, over every key billing
against it** — not only yours. One row per person, their keys listed succinctly
beside it, then spend, today, requests and last activity, with your own row marked.
It is a separate pair of queries (`/team/info` and `/team/daily/activity`) and a
separate failure: a key with no team, or a proxy that refuses a member those
endpoints, loses that section and nothing else.

Per *member* takes a match, because the ledger names a key by alias and never by
owner. The rule is narrow and stated on the page: the alias up to its first
separator, against the email's local part or that part's first dot-segment, and only
where exactly one member matches — on the proxy this was written against that resolves 14 of
26 aliases, folding `Ada`, `Ada-Mac` and `Ada - Full` into one row. An alias nothing matches
**stays its own row**, so the member column reads as an email when it is a person
and as an alias when it is a guess declined. Attributing someone's spend to whoever's
name looked closest would be worse than leaving it unattributed.

What it still cannot show, it says. Reading another member's user record needs an
admin key (a member key gets `403`, checked), so for keys that are not yours there is
no cap and no reset date; the team's own counter against its cap is the reset-scoped
figure that does exist.

Three pieces, each doing only its own job:

| | |
|---|---|
| `~/bin/cloudcli-cost` | queries the proxy (five endpoints; the two team ones are optional), writes `dist/cost.html` and `dist/cost.json`. Reads the key and base URL from the environment (`ANTHROPIC_AUTH_TOKEN` / `LITELLM_TOKEN`, `ANTHROPIC_BASE_URL` / `LITELLM_BASE_URL`, or `LITELLM_TOKEN_FILE`), and passes the token to curl over **stdin**, so it never lands in `ps` or in what it writes |
| the **Cost** tab | a plugin that frames that page, says how old it is, and reloads it every 60s |
| the sidebar chip | today's figure and how much of the cycle is gone, permanently above Settings — a bundle edit, described with the others below |
| `cloudcli-cost.timer` | rewrites both files every 5 minutes |

The launcher writes a report at every start too, so the tab has something from the
first reload — best-effort by construction, since a package upgrade wipes `dist/`
and a shell without the proxy variables cannot query anything. Neither is a reason
to refuse to start; when the query fails the page says why, which is more use in a
tab than a 404. `CLOUDCLI_COST=0` skips the step, `CLOUDCLI_COST_OUT` moves the
page.

The tab frames the page rather than injecting it, which is the opposite of what
the retired Recent tab did — and for the opposite reason. That one rendered JSON
it fetched, so inheriting the app's CSS variables through a shadow boundary was
exactly right. This one shows a document that already has a stylesheet, and an
iframe is the only boundary that keeps two stylesheets apart. Custom properties do
not cross into a frame, so the theme is passed in the URL instead and the page
reads it from there.

Nothing sandboxes that frame, deliberately: it is a file this kit writes, in the
app's own origin, and it needs its own script for the theme. What makes that safe
is at the other end — every value the proxy supplies (key aliases, model names,
the account email, an error message) is HTML-escaped as the page is written.

```bash
./install.sh                    # includes the tab; --no-cost leaves it out
cloudcli-cost --out /tmp/x.html # look at the page without touching the deployed one

# refresh on its own, rather than only at launcher start:
cp systemd/cloudcli-cost.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now cloudcli-cost.timer
```

The plugin is **copied** into `~/.claude-code-ui/plugins/cost/`, not cloned: it
lives in a subdirectory here and the registry wants a manifest at the plugin root,
so the UI's **Update** button has nothing to pull and re-running `install.sh` is
how a change arrives. Enable it once in Settings → Plugins.


**A failed run keeps the last good page.** The proxy's own upstream trouble arrives as
`Authentication Error, All connection attempts failed`, which is not an authentication
problem and reads like a broken deployment when it lands in the tab. Measured over a week
here: 44 of 1840 runs carried a notice like that, none of them a real credential failure, so
each request now gets one retry, and a run that still fails leaves a report younger than
30 minutes where it is. Past that the notice is the truth and replaces it.

## Reporting to Slack

A long run finishes after you have left the desk, and the terminal it finished in is not
where you are. So the kit carries [`notify/cloudcli-slack-report`](notify/cloudcli-slack-report),
installed as `~/bin/cloudcli-slack-report`: a headline, a status line and a short detail block,
posted to a **Workflow Builder webhook trigger**.

A command rather than a tab, for the same reason the stylesheet is not a plugin — the recipient
is a phone, and the sender is usually something running unattended, so neither end is the
browser the plugin API can reach.

    cloudcli-slack-report -t "Tests failed" -m ":x: 2 of 47 failing" \
      -s "- both failures are in auth/session, not the new code
    - token refresh 401s since the clock-skew change"
    cloudcli-slack-report -t "Deploy finished" -m ":rocket: staging up, 4m12s"
    cloudcli-slack-report -n ...        # print the payload, send nothing

`-t` and `-m` are required, everything else has a default; `--help` lists the rest. Repo and
branch come from the git checkout, so **outside a repository, pass `-C DIR`**: a systemd unit's
working directory is not the repository being reported on, and without it both report as `n/a`.
Only an explicit `-s -` reads stdin, because a report with no detail block is the normal case and
auto-reading stdin would hang any caller that left a pipe open. `SLACK_REPORT_URL` holds the trigger URL and is read from the
environment, so a unit wants `/bin/bash -lc` for the same reason the two existing units do — the
credential stays in one file rather than being copied into a unit.

### What the Slack side has to look like

The trigger declares the variables; this command sends them. Declare five Text variables:
`title`, `message`, `summary`, `repo`, `branch`. Undeclared keys are ignored, so declaring a
subset is fine — but **every declared variable must arrive non-empty**, which is why the command
falls back to `n/a` and `—` rather than sending a field blank.

Two things measured rather than assumed. **Styling belongs in the workflow editor**: text passed
through a variable keeps newlines, indentation and `:emoji:`, and loses `*bold*` — it arrives
literal. And **link buttons were tried and dropped**: they take vertical space on the phone the
report is read on, and because a button's label is fixed in the editor while only its URL can be
a variable, five buttons meant five more variables to keep non-empty. What the report can't say
in its own lines, it doesn't say.

### The shape is checked, not suggested

`-m` is one line of at most 14 words; `-s` is at most 5 bullets, each starting `- ` and at most 12
words. Anything else **exits 2 and names the offending line**. This started as advice in the skill
and drifted back to walls of prose twice, so it lives in the command now — a rule an agent can
read is a rule an agent can rationalise, and the report is read on a phone in about two seconds.
It rejects rather than truncates: a truncated report looks exactly like a complete one.
[`notify/test-cloudcli-slack-report`](notify/test-cloudcli-slack-report) covers the accept and
reject cases; the three limits are constants at the top of the command.

### `{"ok":true}` is not delivery

The trigger answers `200` with `{"ok":true}` once it has accepted the payload and started the
workflow. A step can still fail afterwards and nothing reaches Slack. The command reports `sent`
on that basis, and `sent` is all it means. When a report never arrives, the workflow's **run
history** is the place that says why — a step reporting *"received invalid or missing data"* is
almost always a declared variable that arrived empty, or one the payload never sent at all.

Delivery is one-way. Slack carries the notification out; nothing comes back into the session
through it.

### The skill

[`skills/reporting-to-slack/SKILL.md`](skills/reporting-to-slack/SKILL.md) installs to
`~/.claude/skills/`, which is per-user rather than per-project — the command is on your `PATH`
for every repository, so the skill that mentions it should be too. It carries when a report is
worth sending, the flags, and the two traps above.

Its description is written to match reporting situations only — a finished run, an unattended
job, an explicit ask — and not any mention of Slack, because a skill that loads in every session
is a skill whose triggers are worth being narrow about.

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
`font-serif`, `prose-invert`), a CSS variable (`--primary`), the colour name the accent
substitution rewrites (`blue-`). None of that is a published interface, so an
upgrade can move one and the override would go quietly ineffective. That is the one genuine
weakness of patching rather than forking, so the launcher checks each anchor by name and
says so:

```
anchors: 5/5 ok
```

If it reports `MISSING`, that override no longer applies and the selector in
`theme/ide-theme.css` needs re-pointing at whatever replaced it. The check only reports — it
never edits.

## Notes

- **JetBrains Mono** must be installed on the machine running the *browser*, not the server.
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
- **Upgrading CloudCLI:** `npm install -g @cloudcli-ai/cloudcli` installs to npm's *own*
  prefix, which is not necessarily where the running install lives (`npm prefix -g` reads
  `~/.npmrc`; the launcher looks in `~/.npm-global` unless `CLOUDCLI_PREFIX` says otherwise).
  Name it — `npm install -g --prefix ~/.npm-global @cloudcli-ai/cloudcli` — or you will upgrade
  a copy nothing runs and wonder why the version did not change. Then re-run `install.sh` (or
  `CLOUDCLI_PATCH_ONLY=1 cloudcli-start`): an upgrade replaces `dist` and `dist-server`, so
  every patch above has to be re-applied, which is the whole reason the launcher applies them
  at start rather than once. The frontend half is live on the next browser reload; the server
  half needs a restart.
- Everything is an environment knob, read on every start: `CLOUDCLI_PATCH_ONLY=1` (apply and
  exit), `CLOUDCLI_FRONTEND=0` (serve upstream's bundle untouched), `CLOUDCLI_STEER=0`
  (steering off, see above), `CLOUDCLI_LINKS=0` (clickable paths off, and the read they need
  with them), `CLOUDCLI_DROP_MODELS` (see above), and `CLOUDCLI_THEME` (a stylesheet
  somewhere other than `~/.config/cloudcli`).
  `CLOUDCLI_PREFIX` and `CLOUDCLI_CONF` move the paths themselves, for an install that is not
  where the launcher looks.
- Delete `~/.config/cloudcli/ide-theme.css` and the next launcher run cleanly un-links it.
  Earlier versions served a Recent list of their own — a floating pill, then a plugin tab —
  and both scripts clean up after the pill on a machine that ran it.
- [`docs/`](docs) holds the two deployment guides linked above; they describe the same launcher
  this repository carries rather than a copy of it, so there is one place for each fact.
- [`systemd/cloudcli.service`](systemd/cloudcli.service) is the user unit this is deployed
  under, kept here as a copy rather than installed by `install.sh` — putting a unit in place
  is enabling and starting a service, which is a decision, not a file operation. Copy it to
  `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable
  --now cloudcli`. It binds loopback, starts through a login shell so `PATH`/node and the
  gateway environment apply, and names `CLOUDCLI_STEER=0` in a comment as the way to reverse
  steering. Nothing reconciles it: a divergence between that copy and the running unit is
  yours to notice, which is the price of the kit not touching your services.

## Licence

MIT — see [LICENSE](LICENSE) — for what this repository contains: the launcher, the stylesheet,
the report script, the plugin and the docs.

CloudCLI UI itself is AGPL-3.0, and no copy of it is distributed here. Two things are worth
stating plainly rather than implying, since both are how the kit works at all: the launcher
**quotes verbatim fragments of CloudCLI's source** — the anchor each patch matches on, a few
lines apiece — and on every start it **edits the installed package in place** on the machine it
runs on. The generated accent rules are derived there too, and never distributed. If you
redistribute the kit itself, that quoting is the part to take a view on.
