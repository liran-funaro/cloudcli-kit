// KIT: the agents pill under the composer, and the map it opens.
//
// Served as /ide-agents.js and linked into index.html by cloudcli-start. The
// pill counts the session's agents and background jobs. Clicking it opens a
// panel listing the jobs (status, type, runtime) and the agents as a tree of
// who spawned whom (model, context tokens, runtime). A job opens its output,
// the tail while it runs and in full on request. An agent opens what it did.
//
// Data comes from /api/kit/agents (agents/kit-agents.js). Every value from the
// transcript is set as text, never as markup: transcript content is untrusted.
(() => {
  'use strict';
  if (window.__kitAgents) return;
  window.__kitAgents = true;

  const POLL_MS = 3000;
  const MAX_DONE = 50;
  // A finished job stays listed this long after it ends, then leaves. (The VS
  // Code extension drops one the moment it ends; a while longer lets you look.)
  const RECENT_MS = 15 * 60 * 1000;
  const state = { sessionId: null, map: null, open: false, view: null, timer: null, viewTimer: null };

  const css = `
.kit-ag-pill{display:inline-flex;flex:none;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:8px;
  border:1px solid hsl(var(--border)/.7);background:hsl(var(--background)/.7);color:hsl(var(--muted-foreground));
  box-shadow:0 1px 2px rgba(0,0,0,.05);font-size:12px;white-space:nowrap;cursor:pointer;user-select:none}
.kit-ag-pill:hover{color:hsl(var(--foreground));border-color:hsl(var(--primary)/.25)}
.kit-ag-pill.kit-ag-alone{margin:6px 0 0 4px}
.kit-ag-dot{width:7px;height:7px;border-radius:50%;background:#9ca3af;flex:none}
.kit-ag-dot.run{background:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.25)}
.kit-ag-dot.fail{background:#ef4444}
.kit-ag-panel{position:fixed;z-index:60;width:min(560px,calc(100vw - 32px));max-height:min(60vh,520px);overflow:auto;
  border:1px solid hsl(var(--border));border-radius:10px;background:hsl(var(--popover));color:hsl(var(--popover-foreground));
  box-shadow:0 10px 30px rgba(0,0,0,.18);font-size:13px}
.kit-ag-h{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:8px 12px;background:hsl(var(--popover));
  border-bottom:1px solid hsl(var(--border));font-weight:600}
.kit-ag-h button{margin-left:auto;background:none;border:0;color:hsl(var(--muted-foreground));cursor:pointer;font-size:12px}
.kit-ag-sec{padding:6px 12px 2px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))}
.kit-ag-row{display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer}
.kit-ag-row:hover{background:hsl(var(--accent))}
.kit-ag-row.static{cursor:default}.kit-ag-row.static:hover{background:none}
.kit-ag-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kit-ag-meta{color:hsl(var(--muted-foreground));font-size:12px;white-space:nowrap}
.kit-ag-tree{color:hsl(var(--muted-foreground));font-family:ui-monospace,monospace;white-space:pre}
.kit-ag-empty{padding:10px 12px;color:hsl(var(--muted-foreground))}
.kit-ag-pre{margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,monospace}
.kit-ag-act{padding:4px 12px;border-bottom:1px dashed hsl(var(--border))}
.kit-ag-act .t{font-family:ui-monospace,monospace;font-size:12px}
.kit-ag-act .e{color:#ef4444}
.kit-ag-bar{display:flex;gap:8px;padding:8px 12px}
.kit-ag-bar button{border:1px solid hsl(var(--border));background:hsl(var(--card));color:hsl(var(--foreground));
  border-radius:6px;padding:2px 10px;cursor:pointer;font-size:12px}
.kit-ag-stop{flex:none;border:0;background:none;color:hsl(var(--muted-foreground));cursor:pointer;font-size:12px;padding:0 4px;border-radius:4px}
.kit-ag-stop:hover{color:#ef4444;background:hsl(var(--accent))}
.kit-ag-bar .kit-ag-stop.big{border:1px solid #ef4444;color:#ef4444;padding:2px 10px}
.kit-ag-note{padding:6px 12px;color:#ef4444;font-size:12px}
/* The map replaces upstream's background-tasks strip (the purple chips at the top
   of the transcript); the export menu beside it stays. */
.chat-messages-pane > div.sticky > div:first-child > [role="status"]{display:none!important}`;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  };
  const token = () => { try { return localStorage.getItem('auth-token'); } catch { return null; } };
  const api = async (path, options = {}) => {
    const res = await fetch(`/api/kit/agents/${encodeURIComponent(state.sessionId)}${path}`, {
      ...options,
      headers: token() ? { Authorization: `Bearer ${token()}` } : {},
    });
    if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
    return res.json();
  };

  // A stop goes through the runtime's own stop. A 409 means the task is not
  // running any more (claudecodeui#1656: its end never reached the page), so the
  // map is just redrawn: nothing to report, and nothing left to click.
  const stopping = new Set();
  async function stop(kind, id) {
    const key = `${kind}:${id}`;
    if (stopping.has(key)) return;
    stopping.add(key);
    render();
    try {
      await api(`/${kind === 'task' ? 'tasks' : 'agents'}/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    } catch (error) {
      if (error.status !== 409) state.notice = 'The stop did not take. It may have finished already.';
    }
    stopping.delete(key);
    await tick();
    render();
  }
  const stopButton = (kind, item, big) => {
    const busy = stopping.has(`${kind}:${item.id}`);
    const b = el('button', big ? 'kit-ag-stop big' : 'kit-ag-stop', busy ? 'Stopping…' : big ? 'Stop' : '✕');
    b.title = `Stop this ${kind === 'task' ? 'job' : 'agent'}`;
    b.disabled = busy;
    b.addEventListener('click', (e) => { e.stopPropagation(); stop(kind, item.id); });
    return b;
  };
  const dur = (a, b) => {
    if (!a) return '';
    const s = Math.max(0, Math.round(((b ?? Date.now()) - a) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const toks = (n) => (n == null ? '' : n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`);
  const shortModel = (m) => (m ? String(m).replace(/^claude-/, '').replace(/^(aws|bedrock)\//, '') : '');
  const dotClass = (status) => `kit-ag-dot${status === 'running' ? ' run' : status === 'failed' ? ' fail' : ''}`;

  /** Running jobs, and the ones that ended recently, newest first. Ages use the server's clock. */
  function jobs(m) {
    const active = m.tasks.filter((t) => t.status === 'running');
    const recent = m.tasks
      .filter((t) => t.status !== 'running' && t.endedAt && m.now - t.endedAt < RECENT_MS)
      .sort((a, b) => b.endedAt - a.endedAt);
    return { active, recent };
  }
  // Working first, then failed, then finished newest first, as the VS Code map sorts them.
  const RANK = { running: 0, failed: 1 };
  const byState = (a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2)
    || (a.status === 'running' ? (a.startedAt ?? 0) - (b.startedAt ?? 0) : (b.endedAt ?? 0) - (a.endedAt ?? 0));

  // ------------------------------------------------------------- the pill
  // Beside the token-count pill: upstream's TokenUsageSummary, a button whose
  // first child is its icon badge. Its labels are translated, so it is found by
  // shape. Without one (no token reading yet), the pill sits under the composer.
  const tokenPill = (shell) => [...shell.querySelectorAll('button')]
    .find((b) => b.querySelector(':scope > span[class~="bg-primary/10"] > svg'));

  function pill() {
    const shell = document.querySelector('.chat-composer-shell');
    if (!shell) return null;
    let p = shell.querySelector('.kit-ag-pill');
    if (!p) {
      p = el('div', 'kit-ag-pill');
      p.setAttribute('role', 'button');
      p.tabIndex = 0;
      p.addEventListener('click', toggle);
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    const tok = tokenPill(shell);
    if (tok) {
      if (p.previousElementSibling !== tok) tok.after(p);
      p.classList.remove('kit-ag-alone');
    } else if (p.parentElement !== shell) {
      shell.appendChild(p);
      p.classList.add('kit-ag-alone');
    }
    return p;
  }

  function drawPill() {
    const p = pill();
    if (!p) return;
    const m = state.map;
    const j = m ? jobs(m) : { active: [], recent: [] };
    const agents = m?.agents ?? [];
    p.style.display = agents.length || j.active.length || j.recent.length ? '' : 'none';
    if (!m) return;
    const workingAgents = agents.filter((a) => a.status === 'running').length;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    // While anything runs, the pill counts what runs; idle, how many agents the session had.
    const running = workingAgents + j.active.length;
    const label = running
      ? [workingAgents && plural(workingAgents, 'agent'), j.active.length && plural(j.active.length, 'job')].filter(Boolean).join(' · ')
      : agents.length ? plural(agents.length, 'agent') : plural(j.recent.length, 'finished job');
    const failed = agents.some((a) => a.status === 'failed') && !running;
    p.title = running ? 'Agents or jobs are working · click for the agent map' : 'Click for the agent map';
    p.replaceChildren(el('span', dotClass(running ? 'running' : failed ? 'failed' : 'done')), el('span', null, label));
  }

  // ------------------------------------------------------------- the panel
  let panel = null;
  function place() {
    const p = pill();
    if (!panel || !p) return;
    const r = p.getBoundingClientRect();
    panel.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - panel.offsetWidth - 16))}px`;
    panel.style.bottom = `${Math.max(16, window.innerHeight - r.top + 6)}px`;
  }

  function header(title, back) {
    const h = el('div', 'kit-ag-h');
    if (back) {
      const b = el('button', null, '‹ Back');
      b.style.marginLeft = '0';
      b.addEventListener('click', () => { state.view = null; render(); });
      h.append(b);
    }
    h.append(el('span', null, title));
    const x = el('button', null, '✕');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    h.append(x);
    return h;
  }

  function renderMap() {
    const m = state.map;
    const out = [header('Agents and background jobs')];
    if (state.notice) { out.push(el('div', 'kit-ag-note', state.notice)); state.notice = null; }
    const j = m ? jobs(m) : { active: [], recent: [] };
    if (!m || (!m.agents.length && !j.active.length && !j.recent.length)) {
      out.push(el('div', 'kit-ag-empty', 'No agents or background jobs in this session.'));
      return out;
    }
    if (m.agents.length) {
      out.push(el('div', 'kit-ag-sec', 'Agents'));
      const main = el('div', 'kit-ag-row static');
      main.append(el('span', dotClass(m.main.running ? 'running' : 'done')), el('span', 'kit-ag-name', 'Main session'),
        el('span', 'kit-ag-meta', shortModel(m.main.model)), el('span', 'kit-ag-meta', toks(m.main.contextTokens)));
      out.push(main);
      const kids = new Map();
      for (const a of m.agents) {
        const key = m.agents.some((b) => b.id === a.parentId) ? a.parentId : 'main';
        if (!kids.has(key)) kids.set(key, []);
        kids.get(key).push(a);
      }
      for (const list of kids.values()) list.sort(byState);
      const walk = (parent, prefix) => {
        const list = kids.get(parent) ?? [];
        list.forEach((a, i) => {
          const last = i === list.length - 1;
          const row = el('div', 'kit-ag-row');
          row.title = `${a.type} · ${a.toolCalls} tool calls${a.background ? ' · background' : ''}`;
          row.append(el('span', 'kit-ag-tree', `${prefix}${last ? '└─' : '├─'}`), el('span', dotClass(a.status)),
            el('span', 'kit-ag-name', a.name), el('span', 'kit-ag-meta', shortModel(a.model)),
            el('span', 'kit-ag-meta', toks(a.contextTokens)),
            el('span', 'kit-ag-meta', dur(a.startedAt, a.status === 'running' ? null : a.endedAt)));
          if (a.stoppable) row.append(stopButton('agent', a));
          row.addEventListener('click', () => { state.view = { kind: 'agent', id: a.id, name: a.name }; render(); });
          out.push(row);
          walk(a.id, `${prefix}${last ? '   ' : '│  '}`);
        });
      };
      walk('main', '');
    }
    const jobRow = (t) => {
      const row = el('div', 'kit-ag-row');
      row.title = t.summary || t.name;
      row.append(el('span', dotClass(t.status)), el('span', 'kit-ag-name', t.name || t.id),
        el('span', 'kit-ag-meta', t.type), el('span', 'kit-ag-meta', dur(t.startedAt, t.status === 'running' ? null : t.endedAt)));
      if (t.stoppable) row.append(stopButton('task', t));
      row.addEventListener('click', () => { state.view = { kind: 'task', id: t.id, name: t.name, full: false }; render(); });
      return row;
    };
    if (j.active.length) {
      out.push(el('div', 'kit-ag-sec', `Active jobs · ${j.active.length}`));
      for (const t of j.active) out.push(jobRow(t));
    }
    if (j.recent.length) {
      out.push(el('div', 'kit-ag-sec', `Recently finished · ${j.recent.length}`));
      for (const t of j.recent.slice(0, MAX_DONE)) out.push(jobRow(t));
      if (j.recent.length > MAX_DONE) out.push(el('div', 'kit-ag-empty', `+ ${j.recent.length - MAX_DONE} more`));
    }
    return out;
  }

  async function renderView(v) {
    if (v.kind === 'task') {
      const task = state.map?.tasks.find((t) => t.id === v.id);
      const out = [header(v.name || v.id, true)];
      if (task?.stoppable) { const bar = el('div', 'kit-ag-bar'); bar.append(stopButton('task', task, true)); out.push(bar); }
      try {
        const o = await api(`/tasks/${encodeURIComponent(v.id)}/output${v.full ? '?full=1' : ''}`);
        if (o.truncated) {
          const bar = el('div', 'kit-ag-bar');
          const b = el('button', null, v.full ? `Showing the last 4 MB of ${Math.round(o.size / 1024)} KB` : `Load full output (${Math.round(o.size / 1024)} KB)`);
          if (!v.full) b.addEventListener('click', () => { state.view = { ...v, full: true }; render(); });
          bar.append(b);
          out.push(bar);
        }
        out.push(el('pre', 'kit-ag-pre', o.missing ? '(the output file is gone)' : o.text || '(no output yet)'));
      } catch {
        out.push(el('div', 'kit-ag-empty', task?.summary || 'No output was recorded for this job.'));
      }
      return { out, live: task?.status === 'running' && !v.full };
    }
    const agent = state.map?.agents.find((a) => a.id === v.id);
    const out = [header(v.name || v.id, true)];
    if (agent?.stoppable) { const bar = el('div', 'kit-ag-bar'); bar.append(stopButton('agent', agent, true)); out.push(bar); }
    try {
      const a = await api(`/agents/${encodeURIComponent(v.id)}`);
      for (const e of a.activity) {
        const row = el('div', 'kit-ag-act');
        if (e.kind === 'tool') row.append(el('span', `t${e.error ? ' e' : ''}`, `${e.name}  `), el('span', null, e.summary));
        else row.append(el('span', null, e.text));
        out.push(row);
      }
      if (a.activityCount > a.activity.length) out.push(el('div', 'kit-ag-empty', `… ${a.activityCount - a.activity.length} more entries not shown`));
      if (a.result) { out.push(el('div', 'kit-ag-sec', 'Result')); out.push(el('pre', 'kit-ag-pre', a.result)); }
      if (!a.activity.length && !a.result) out.push(el('div', 'kit-ag-empty', 'Nothing recorded yet.'));
    } catch {
      out.push(el('div', 'kit-ag-empty', 'This agent left no transcript.'));
    }
    return { out, live: agent?.status === 'running' };
  }

  let rendering = 0;
  async function render() {
    if (!state.open) return;
    const ticket = ++rendering;
    clearTimeout(state.viewTimer);
    if (!panel) {
      panel = el('div', 'kit-ag-panel');
      panel.setAttribute('role', 'dialog');
      document.body.append(panel);
    }
    if (!state.view) {
      panel.replaceChildren(...renderMap());
    } else {
      const pre = panel.querySelector('.kit-ag-pre');
      const atBottom = pre ? panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 8 : true;
      const { out, live } = await renderView(state.view);
      if (ticket !== rendering || !state.open) return;
      panel.replaceChildren(...out);
      if (atBottom && state.view.kind === 'task') panel.scrollTop = panel.scrollHeight;
      if (live) state.viewTimer = setTimeout(render, POLL_MS);
    }
    place();
  }

  function toggle() { state.open ? close() : openPanel(); }
  function openPanel() { state.open = true; state.view = null; render(); }
  function close() {
    state.open = false;
    state.view = null;
    clearTimeout(state.viewTimer);
    panel?.remove();
    panel = null;
  }

  // Escape closes the panel and goes no further: in the chat, Escape stops a turn.
  document.addEventListener('keydown', (e) => {
    if (state.open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (state.open && panel && !panel.contains(e.target) && !e.target.closest?.('.kit-ag-pill')) close();
  }, true);
  window.addEventListener('resize', place);

  // ------------------------------------------------------------- polling
  const sessionFromUrl = () => location.pathname.match(/\/session\/([^/?#]+)/)?.[1] ?? null;
  async function tick() {
    const id = sessionFromUrl();
    if (id !== state.sessionId) {
      state.sessionId = id;
      state.map = null;
      close();
    }
    if (state.sessionId && document.visibilityState === 'visible' && token()) {
      try {
        state.map = await api('');
      } catch {
        state.map = null;
      }
      if (state.open && !state.view) render();
    }
    drawPill();
  }

  const style = el('style');
  style.textContent = css;
  document.head.append(style);
  setInterval(tick, POLL_MS);
  // The composer is re-created on navigation; put the pill back as soon as it is.
  // The composer row re-renders often: put the pill back beside the token pill
  // whenever it has lost its place.
  new MutationObserver(() => {
    if (!state.map) return;
    const p = document.querySelector('.chat-composer-shell .kit-ag-pill');
    const shell = document.querySelector('.chat-composer-shell');
    const tok = shell && tokenPill(shell);
    if (!p || (tok && p.previousElementSibling !== tok)) drawPill();
  })
    .observe(document.body, { childList: true, subtree: true });
  tick();
})();
