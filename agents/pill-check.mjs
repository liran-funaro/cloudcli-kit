// Checks the browser half of the agent map: where the pill goes, what it says,
// and how the map splits agents, active jobs and recently finished ones.
//
//   node agents/pill-check.mjs <jsdom package dir>
//
// jsdom is not a kit dependency; any checkout that has it will do (the
// claudecodeui clone's node_modules/jsdom does). The script runs in a page
// shaped like the composer, against a stubbed /api/kit/agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const dir = process.argv[2];
assert.ok(dir && fs.existsSync(dir), 'pass the jsdom package directory');
const { JSDOM } = createRequire(path.join(dir, 'package.json'))(dir);
const script = fs.readFileSync(path.join(import.meta.dirname, 'ide-agents.js'), 'utf8');

const now = Date.parse('2026-11-20T12:00:00Z');
const min = 60 * 1000;
const busy = {
  now,
  main: { model: 'claude-main', contextTokens: 120000, running: true },
  agents: [
    { id: 'done', parentId: 'main', name: 'Finished agent', status: 'completed', startedAt: now - 9 * min, endedAt: now - 8 * min, toolCalls: 3 },
    { id: 'bad', parentId: 'main', name: 'Failed agent', status: 'failed', startedAt: now - 7 * min, endedAt: now - 6 * min, toolCalls: 1 },
    { id: 'work', parentId: 'main', name: 'Working agent', status: 'running', startedAt: now - 2 * min, toolCalls: 5, stoppable: true },
    { id: 'kid', parentId: 'work', name: 'Nested agent', status: 'running', startedAt: now - min, toolCalls: 2 },
  ],
  tasks: [
    { id: 'old', name: 'Old build', type: 'shell', status: 'completed', startedAt: now - 40 * min, endedAt: now - 30 * min },
    { id: 'fresh', name: 'Fresh build', type: 'shell', status: 'completed', startedAt: now - 6 * min, endedAt: now - 5 * min },
    { id: 'live', name: 'npm run watch', type: 'shell', status: 'running', startedAt: now - 3 * min, stoppable: true },
  ],
};

const dom = new JSDOM(`<!doctype html><body><div id="root">
<div class="chat-messages-pane relative"><div class="pointer-events-none sticky right-4 top-3">
  <div class="pointer-events-auto min-w-0"><div id="strip" role="status" aria-label="Background tasks">chips</div></div>
  <div class="pointer-events-auto"><button id="export">Export</button></div>
</div></div>
<div class="chat-composer-shell"><div class="row">
  <button id="other" type="button"><svg></svg></button>
  <button id="tokens" type="button"><span class="hidden h-5 w-5 bg-primary/10 text-primary"><svg></svg></span><span>12k</span></button>
  <button id="clear" type="button">clear</button>
</div></div></div></body>`, { url: 'http://localhost/session/s1', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
window.localStorage.setItem('auth-token', 't');
let map = busy;
const posts = [];
let stopStatus = 200;
window.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    posts.push(String(url));
    return { ok: stopStatus === 200, status: stopStatus, json: async () => ({ stopped: stopStatus === 200 }) };
  }
  return { ok: true, json: async () => (String(url).endsWith('/api/kit/agents/s1') ? map : { activity: [], activityCount: 0 }) };
};
window.eval(script);
const settle = () => new Promise((r) => setTimeout(r, 30));
await settle();

assert.equal(window.getComputedStyle(document.getElementById('strip')).display, 'none', "upstream's purple strip is gone");
assert.notEqual(window.getComputedStyle(document.getElementById('export')).display, 'none', 'the export menu beside it stays');
const pill = document.querySelector('.kit-ag-pill');
assert.ok(pill, 'the pill is drawn');
assert.equal(pill.previousElementSibling?.id, 'tokens', 'beside the token-count pill');
assert.equal(pill.textContent, '2 agents · 1 job', 'while work runs, it counts what runs');
assert.ok(pill.querySelector('.kit-ag-dot.run'), 'and its dot is green');

pill.click();
await settle();
const panel = document.querySelector('.kit-ag-panel');
const sections = [...panel.querySelectorAll('.kit-ag-sec')].map((e) => e.textContent);
assert.deepEqual(sections, ['Agents', 'Active jobs · 1', 'Recently finished · 1'], 'agents first, then active, then recent');
const names = [...panel.querySelectorAll('.kit-ag-name')].map((e) => e.textContent);
assert.deepEqual(names, ['Main session', 'Working agent', 'Nested agent', 'Failed agent', 'Finished agent', 'npm run watch', 'Fresh build'],
  'working agents first with their children, then failed, then finished; a job 30 minutes old has left');

const stops = [...panel.querySelectorAll('.kit-ag-stop')];
assert.equal(stops.length, 2, 'a ✕ on the working agent and the running job, and nothing else');
stops[1].click();
await settle();
assert.deepEqual(posts, ['/api/kit/agents/s1/tasks/live/stop'], 'the ✕ asks the server to stop that job');
assert.ok(document.querySelector('.kit-ag-panel'), 'and the click does not open or close anything else');
stopStatus = 409;
document.querySelector('.kit-ag-panel .kit-ag-stop').click();
await settle();
assert.equal(posts.at(-1), '/api/kit/agents/s1/agents/work/stop');
assert.equal(document.querySelector('.kit-ag-note'), null, 'a 409 (no longer running) is not reported as a failure');

let reached = false;
document.addEventListener('keydown', () => { reached = true; });
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(document.querySelector('.kit-ag-panel'), null, 'Escape closes the map');
assert.equal(reached, false, 'and goes no further, where it would stop the turn');

// The composer row re-renders and loses the pill: it comes back beside the tokens.
pill.remove();
await settle();
assert.equal(document.querySelector('.kit-ag-pill')?.previousElementSibling?.id, 'tokens', 'put back after a re-render');

// Idle: nothing runs, so the pill says how many agents the session had.
map = { ...busy, main: { ...busy.main, running: false },
  agents: busy.agents.map((a) => ({ ...a, status: a.status === 'running' ? 'completed' : a.status, endedAt: a.endedAt ?? now })),
  tasks: busy.tasks.filter((t) => t.status !== 'running') };
await window.eval('new Promise((r) => setTimeout(r, 3100))');
const idle = document.querySelector('.kit-ag-pill');
assert.equal(idle.textContent, '4 agents');
assert.ok(idle.querySelector('.kit-ag-dot.fail'), 'idle with a failed agent: red');
console.log('agent pill: all checks passed');
// The script polls forever, as a page does: end here rather than tear the page down under it.
process.exit(0);
