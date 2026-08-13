/* ---------------------------------------------------------------------------
   Recent conversations, across every project.

   CloudCLI tracks sessions that are *running* -- the Active tab, backed by
   /api/providers/sessions/running, an in-memory registry of live runs. It
   tracks nothing about the state you actually go looking for: a session that
   stopped because Claude asked you something. Those leave the Active tab the
   moment they stop and are then reachable only by opening each project in
   turn. This is one cross-project, recency-ordered list of them.

   This is a CloudCLI plugin and nothing else: the host fetches this file,
   imports it from a blob: URL, and calls mount(container, api) when the tab is
   activated, unmount(container) when you navigate away.
   See https://cloudcli.ai/docs/plugin-overview

   It renders into a shadow root, so the app's own styles and this file's can
   never collide -- while CSS custom properties still inherit *through* the
   boundary, which is why the colours below track the active theme (and any
   ide-theme.css retune) without reading api.context.theme at all.

   No build step, no framework, no dependencies -- and no package.json, which
   is load-bearing: the plugin registry runs `npm install` and `npm run build`
   only when it finds one, so leaving it out makes install and update a bare
   git clone / git pull.
   --------------------------------------------------------------------------- */

/* A session that is not running has, by definition, handed the turn back to
   you -- but only a recently stopped one is likely to be a question still
   waiting for an answer, so that chip is time-bounded. lastActivity is the
   transcript file's mtime (the server reads it off the JSONL), so it advances
   while Claude writes, not only when you send.                             */
const YOUR_TURN_MS = 6 * 60 * 60 * 1000;
const PER_PROJECT = 15; // sessions per project the projects API returns
const MAX_ROWS = 60; // rows rendered; the filter still sees them all

/* Colours are the app's own tokens, so this follows the theme and any future
   ide-theme.css retune. Upstream defines them for both light and dark, so the
   fallbacks only matter if a token is ever dropped.                        */
const CSS = `
  :host { display: block; height: 100%; font-family: inherit; }
  [hidden] { display: none !important; }
  button, input { font: inherit; color: inherit; }

  /* The host supplies the surface and the heading, so the panel carries no
     chrome of its own and simply fills what it was handed.                */
  .panel {
    display: flex; flex-direction: column; overflow: hidden;
    width: 100%; height: 100%; min-height: 18rem;
    color: hsl(var(--foreground, 0 0% 100%));
  }

  .head { display: flex; gap: .5rem; padding: .7rem; align-items: center; }
  .filter {
    flex: 1; min-width: 0; padding: .4rem .6rem; border-radius: 7px;
    background: hsl(var(--input, 0 0% 20.4%));
    border: 1px solid hsl(var(--border, 0 0% 18%));
    font-size: .9375rem; outline: none;
  }
  .filter:focus { border-color: hsl(var(--primary, 197 71% 52%)); }
  .icon {
    background: none; border: 0; cursor: pointer; padding: .3rem .45rem;
    border-radius: 7px; color: hsl(var(--muted-foreground, 0 0% 78%));
    font-size: 1rem; line-height: 1;
  }
  .icon:hover { background: hsl(var(--secondary, 0 0% 20.4%)); color: inherit; }

  .list { overflow-y: auto; }
  .row {
    display: flex; align-items: baseline; gap: .55rem;
    padding: .5rem .85rem; text-decoration: none; color: inherit;
    border-top: 1px solid hsl(var(--border, 0 0% 18%) / .55);
  }
  .row:hover { background: hsl(var(--secondary, 0 0% 20.4%) / .6); }
  .row.here { box-shadow: inset 2px 0 0 hsl(var(--primary, 197 71% 52%)); }
  .title {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-size: .9375rem;
  }
  .proj, .time {
    flex: none; font-size: .8125rem;
    color: hsl(var(--muted-foreground, 0 0% 78%));
  }
  .proj { max-width: 11rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { min-width: 4.5rem; text-align: right; }
  .chip {
    flex: none; font-size: .6875rem; padding: .05rem .4rem;
    border-radius: 999px; border: 1px solid currentColor; white-space: nowrap;
  }
  .chip.work { color: #3fb950; }            /* no success token in the theme */
  .chip.turn { color: hsl(var(--primary, 197 71% 52%)); }

  .note {
    padding: .6rem .85rem; font-size: .8125rem;
    color: hsl(var(--muted-foreground, 0 0% 78%));
    border-top: 1px solid hsl(var(--border, 0 0% 18%) / .55);
  }
`;

const PANEL_HTML = `
  <div class="head">
    <input class="filter" type="text" placeholder="Filter by conversation or project..." />
    <button class="icon refresh" title="Refresh">&#x27F3;</button>
  </div>
  <div class="list"></div>
  <div class="note"></div>
`;

const token = () => localStorage.getItem('auth-token') || '';

const api = async (path) => {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token()}` } });
  if (res.status === 401) throw new Error('not signed in');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

const ago = (iso) => {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.round(min / 60)}h ago`;
  if (min < 10080) return `${Math.round(min / 1440)}d ago`;
  return new Date(iso).toLocaleDateString();
};

/* Fetched on demand, never polled: /api/projects broadcasts a loading_progress
   frame to every websocket client and the app renders that as a progress
   indicator, so a background poll would make the whole UI flicker. skipSync=1
   keeps it a pure SQLite read -- the server's own sessions watcher is what
   keeps that table current.                                               */
const fetchRows = async () => {
  const [projects, live] = await Promise.all([
    api(`/api/projects?skipSync=1&sessionsLimit=${PER_PROJECT}`),
    api('/api/providers/sessions/running').catch(() => null),
  ]);
  const running = new Set((live?.data?.sessions ?? []).map((s) => s.sessionId));
  const rows = [];
  for (const p of projects ?? []) {
    for (const s of p.sessions ?? []) {
      rows.push({
        id: s.id,
        title: (s.summary || '').trim(),
        project: p.displayName || p.path || '',
        ts: s.lastActivity,
      });
    }
  }
  rows.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return { rows, running };
};

/* Builds the list into `root`, an element mount() has already placed inside a
   shadow root carrying the CSS above. `current` returns the session id to mark
   as "you are here", read lazily because the host's context changes under us.
   Returns what mount() needs to drive it.                                */
function createPanel(root, current) {
  root.innerHTML = PANEL_HTML;
  const q = (sel) => root.querySelector(sel);
  const list = q('.list');
  const filter = q('.filter');
  const note = q('.note');
  let rows = [];
  let running = new Set();
  let currentId = current();

  const render = () => {
    const needle = filter.value.trim().toLowerCase();
    const shown = rows.filter(
      (r) => !needle || `${r.title} ${r.project}`.toLowerCase().includes(needle),
    );
    list.textContent = '';
    for (const r of shown.slice(0, MAX_ROWS)) {
      const a = document.createElement('a');
      a.className = 'row' + (r.id === currentId ? ' here' : '');
      a.href = `/session/${encodeURIComponent(r.id)}`;
      /* textContent throughout: these titles come out of transcripts. */
      const add = (cls, text) => {
        const el = document.createElement('span');
        el.className = cls;
        el.textContent = text;
        a.appendChild(el);
      };
      add('title', r.title || 'Untitled conversation');
      if (running.has(r.id)) add('chip work', 'working');
      else if (Date.now() - new Date(r.ts).getTime() < YOUR_TURN_MS) add('chip turn', 'your turn');
      add('proj', r.project);
      add('time', ago(r.ts));
      list.appendChild(a);
    }
    note.textContent = shown.length
      ? `${Math.min(shown.length, MAX_ROWS)} of ${rows.length} conversations` +
        `${shown.length > MAX_ROWS ? ' (filter to narrow)' : ''}`
      : 'Nothing to show.';
  };

  const refresh = async () => {
    note.textContent = 'Loading...';
    try {
      const got = await fetchRows();
      rows = got.rows;
      running = got.running;
      render();
    } catch (err) {
      list.textContent = '';
      note.textContent = `Could not load conversations: ${err.message}`;
    }
  };

  q('.refresh').addEventListener('click', refresh);
  filter.addEventListener('input', render);
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = list.querySelector('.row');
    if (first) first.click();
  });

  return {
    refresh,
    setCurrent: (id) => {
      if (id === currentId) return;
      currentId = id;
      render();
    },
  };
}

/* --- the plugin tab ------------------------------------------------------- */

/* The host hands the same container to mount and unmount. It re-imports this
   file on every activation (a fresh blob: URL each time, so nothing is cached
   between mounts), which is why the instance is parked on the element itself
   rather than in module scope.                                            */
const HELD = new WeakMap();

export async function mount(container, host) {
  container.replaceChildren();
  const holder = document.createElement('div');
  container.appendChild(holder);
  const sr = holder.attachShadow({ mode: 'open' });
  sr.innerHTML = `<style>${CSS}</style><div class="panel"></div>`;

  const panel = createPanel(sr.querySelector('.panel'),
    () => host?.context?.session?.id ?? '');

  /* Project and session travel with the host's context, so following it keeps
     the "you are here" marker honest as you move around the app.          */
  const off = host?.onContextChange?.((ctx) => panel.setCurrent(ctx?.session?.id ?? ''));

  HELD.set(container, { holder, off });
  await panel.refresh();
}

export function unmount(container) {
  const held = HELD.get(container);
  if (!held) return;
  HELD.delete(container);
  try {
    held.off?.();
  } catch {
    /* the host is tearing us down either way */
  }
  held.holder.remove();
}
