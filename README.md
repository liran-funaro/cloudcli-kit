# cloudcli-kit

Personal customisations for [CloudCLI UI](https://github.com/siteboon/claudecodeui) — a
stylesheet, a launcher that re-applies it and everything below on every start so a package
upgrade cannot silently revert them, and a Cost tab for the LiteLLM proxy behind it.

Surfaces, accent, typography, inline code, full-width chat. Conversations as the sidebar's
default, its rows drawn the way the Projects list draws a session — the activity dot, the
spinner, the session menu — plus the project each one belongs to. Each model described,
priced, and pruned in the model menu. The CLI's own commands — `/compact` among them — in the
composer's command menu. Enter for a newline, ⌘/Ctrl+Enter to send. A Stop that always stops,
and a message typed mid-turn steering the turn it lands in. Compaction drawn where it happens —
a bar and a percentage while it runs, then what it cost, with the summary folded behind a disclosure instead of
dropped into the conversation. A Cost tab showing what the proxy has billed. One command:
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

## Install

```bash
git clone https://github.com/<you>/cloudcli-kit.git
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

Nothing is restarted, so it is safe to run while a session is in progress; reload the
browser to see the result.

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

## Eight small edits in the bundle

Three are things the app already almost does; one is a default worth flipping; one is a
list keeping itself current; one is a menu that never listed what the CLI can do; one puts a
number on the page that was only ever a command away; one draws something the app never
mentioned at all:

- **Conversations, not Projects, as the sidebar's default.** The switch is `useState` that is
  never persisted, so it reset to Projects on every load.
- **The model's description in the model menu.** Every option already carries one, and the
  menu-item component already renders one when given it — the effort menu right next door
  passes exactly that prop. The model menu just never did.
- **A Conversations row, drawn the way a Projects session row is drawn.** The two lists show
  the same sessions, and the Projects one said far more about one: a dot at the left edge,
  amber when it needs an answer and green when it was touched in the last ten minutes; a
  spinner while it works, or how long ago it was touched; and a three-dot menu that renames,
  copies the provider session id, archives or deletes. A Conversations row had none of it —
  just a chevron that says nothing the row does not, the row being a link. So the whole row
  is replaced by that one, built from the app's own pieces: its button variants, its
  `Tooltip`, its spinner, its provider mark, its `ActionMenu` and icons, and the editing
  state it already keys by session id. Added to it is the one line a row under a project does
  not need — which project it belongs to — where a session row shows its message count.
  Nothing had to be reimplemented: rename and delete key on the session id alone (their
  `projectId` and `provider` arguments are compatibility parameters upstream marks unused),
  so a row holding only a conversation summary drives both. The one thing not carried over is
  the copy item's *loading* / *copied* labels, which are component state this row has none
  of; it copies, and says only that it copies. Upstream is carrying
  [the same change](https://github.com/siteboon/claudecodeui/pull/1157) as a shared component.
- **A rename or a delete refreshing the list it was made from.** Upstream refetches the
  archived sessions when one is deleted and the projects when one is renamed. The
  Conversations list, which until now had neither action, was refetched by neither — it
  would keep showing the old title, or a row whose session is gone. Both paths get one more
  call: the same page-zero fetch the sidebar's own refresh button makes. (The PR upstream
  patches the loaded rows in place instead, which also keeps the pages a reader has loaded
  past the first; reaching those state setters through the minifier is not worth it here.)
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
- **Compaction, drawn where it happened.** The browser half of [patch
  9](#compaction-said-out-loud): a dot, one line of numbers, a bar with the CLI's own
  percentage while it runs, and the
  summary folded behind *full summary* — the disclosure standing in for the CLI's ctrl+o.
  Two rows are folded into one on the way: the boundary and the summary that follows it are
  separate records, and a summary sitting alone (an older session, compacted before the CLI
  wrote boundaries) still gets a row of its own to fold into. A bar with a finished
  compaction after it is dropped rather than drawn, so history never shows one that will
  never stop.

  The look is not in the patch. It is `.kit-compact-*` in
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
send while running, conversation row, conversation refresh, cli commands, cost chip,
compaction rows
```

Nine because one of them, *send while running*, belongs to steering — described with it
below. `CLOUDCLI_STEER=0` leaves it out and the run prints `8/8`.

Several are read from more than one anchor: the conversation row alone borrows twelve names
the minifier chose — the classname helper and button variants that give a session row its
card, the `Tooltip`, the spinner, the provider mark, the `ActionMenu` and four icons, the api
object, the clipboard helper, and the row's own locals. Not one is guessed. Each comes from a
site that says which is which: the Projects row names its own card, spinner and menu, the
copy-state ternary names the clipboard icon, the api object comes from its own call, and the
row's locals from the line that declares them. A name that appears more than once is accepted
only when every occurrence agrees on it — the mobile and desktop halves of a row name the
same spinner — and a name **bound** inside the function being patched would shadow what the
new row means by it, so that is checked too, and nothing is applied if it is. A name merely
*used* there is no obstacle: the row already calls two of the twelve.

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

The browser half is one of the bundle substitutions: the composer's busy guard learns one
condition, so a send during a run goes out instead of becoming a draft. It is still guarded on a
global rather than compiled in, but the sense is now the escape hatch — `__cloudcliSteer = false`
in the console puts a tab back on upstream's hold-it-back composer mid-session, with no restart.

```
chat: applied stop always stops, steering history, steering channel, steering queue, steering
park, steering pusher, steering export, steering passthrough, steering route
[KIT] steering <session> mid-turn (32 chars)
```

Eight steering edits across three server modules (the ninth line is Stop), so it is
all-or-nothing by construction — a facade naming a function that failed to be inserted is a
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
field beside it is only how [the browser half](#eight-small-edits-in-the-bundle) draws it. The
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
compaction: applied
```

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
across a week of candidate start dates, where my own sum was identical for three
consecutive starts while the counter sat $58 above all of them. So counters answer
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
where exactly one member matches — which here resolves 14 of 26 aliases, and folds
`Liran`, `Liran-Mac` and `Liran - Full` into one row. An alias nothing matches
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
  (steering off, see above), `CLOUDCLI_DROP_MODELS` (see above), and `CLOUDCLI_THEME` (a stylesheet
  somewhere other than `~/.config/cloudcli`).
  `CLOUDCLI_PREFIX` and `CLOUDCLI_CONF` move the paths themselves, for an install that is not
  where the launcher looks.
- Delete `~/.config/cloudcli/ide-theme.css` and the next launcher run cleanly un-links it.
  Earlier versions served a Recent list of their own — a floating pill, then a plugin tab —
  and both scripts clean up after the pill on a machine that ran it.
- [`systemd/cloudcli.service`](systemd/cloudcli.service) is the user unit this is deployed
  under, kept here as a copy rather than installed by `install.sh` — putting a unit in place
  is enabling and starting a service, which is a decision, not a file operation. Copy it to
  `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable
  --now cloudcli`. It binds loopback, starts through a login shell so `PATH`/node and the
  gateway environment apply, and names `CLOUDCLI_STEER=0` in a comment as the way to reverse
  steering. Nothing reconciles it: a divergence between that copy and the running unit is
  yours to notice, which is the price of the kit not touching your services.

## Licence

MIT — see [LICENSE](LICENSE). CloudCLI UI itself is AGPL-3.0; nothing here includes or
modifies its source, and the generated accent rules are derived on your own machine at
start-up and never distributed.
