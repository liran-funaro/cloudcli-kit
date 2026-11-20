// Checks that the agent map survives a page refresh, against the real runtime.
//
//   node agents/refresh-check.mjs <package dir>
//
// Upstream's count of running work lived in the page and was lost on reload.
// The map lives on the server: the session's files plus the runtime's own task
// tracker. Here a scripted CLI starts a background shell job and a background
// agent through queryClaudeSDK, ends its turn (the process is held open for the
// work), and the real /api/kit/agents route is read as two separate page loads
// would read it. Then the job is stopped through the route and the runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pkg = process.argv[2];
assert.ok(pkg && fs.existsSync(pkg), 'pass the package directory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-refresh-'));
process.env.DATABASE_PATH = path.join(root, 'auth.db'); // never the real database
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const server = `${pkg}/dist-server/server`;
const db = await import(`${server}/modules/database/index.js`);
await db.initializeDatabase?.();
const lib = `${server}/modules/providers/list/claude`;
const { queryClaudeSDK } = await import(`${lib}/claude-runtime.provider.js`);
const { ClaudeSessionsProvider } = await import(`${lib}/claude-sessions.provider.js`);
const { CLAUDE_PREDEFINED_MODELS } = await import(`${lib}/claude-models.provider.js`);
const { kitAgentsRoutes } = await import(`${server}/kit-agents.js`);
const { default: express } = await import(`${pkg}/node_modules/express/index.js`);

// The session as the app knows it: an app id mapped to the CLI's transcript.
const N = 'native-refresh';
const project = path.join(root, 'repo');
fs.mkdirSync(project);
const transcript = path.join(root, 'proj', `${N}.jsonl`);
const subagents = path.join(root, 'proj', N, 'subagents');
fs.mkdirSync(subagents, { recursive: true });
const line = (o) => `${JSON.stringify(o)}\n`;
const ts = new Date().toISOString();
fs.writeFileSync(transcript, line({ type: 'user', timestamp: ts, message: { content: 'go' } }));
db.sessionsDb.createSession(N, 'claude', project, 'refresh', ts, ts, transcript);
db.sessionsDb.createAppSession('app-refresh', 'claude', project, 'refresh');
db.sessionsDb.assignProviderSessionId('app-refresh', N);

// A scripted CLI: what it streams goes to the runtime; what it writes goes to disk.
const queue = [];
let wake = null;
const emit = (message) => { queue.push(message); wake?.(); };
const createQuery = ({ prompt }) => {
  void (async () => { for await (const _ of prompt) { /* the held stdin */ } })();
  const iterator = (async function* () {
    for (;;) {
      if (!queue.length) { await new Promise((r) => { wake = r; }); wake = null; continue; }
      const next = queue.shift();
      if (next === null) return;
      yield next;
    }
  })();
  // A stop the CLI honours: it reports the task stopped, which drops it from the tracker.
  const stopTask = async (taskId) => {
    emit({ type: 'system', subtype: 'task_notification', session_id: N, task_id: taskId, status: 'stopped', summary: 'stopped' });
  };
  return Object.assign(iterator, { interrupt: async () => {}, stopTask });
};
const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
const context = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
  normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
  createQuery,
};
const done = queryClaudeSDK('go', { sessionId: 'app-refresh', cwd: project }, { send: () => {}, userId: null }, context);
const settle = () => new Promise((r) => setTimeout(r, 40));

const bash = { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'sleep 600', description: 'Long build', run_in_background: true } };
const agent = { type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { description: 'Long research' } };
emit({ type: 'system', subtype: 'init', session_id: N });
emit({ type: 'assistant', session_id: N, parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-main', content: [bash, agent] } });
emit({ type: 'system', subtype: 'task_started', session_id: N, task_id: 'b1', tool_use_id: 'tu_bash', task_type: 'local_bash', description: 'Long build' });
emit({ type: 'system', subtype: 'task_started', session_id: N, task_id: 'a1', tool_use_id: 'tu_agent', task_type: 'local_agent', description: 'Long research' });
emit({ type: 'result', subtype: 'success', session_id: N, result: 'launched', duration_ms: 1, num_turns: 1 });
fs.appendFileSync(transcript,
  line({ type: 'assistant', timestamp: ts, message: { model: 'claude-main', content: [bash, agent] } })
  + line({ type: 'user', timestamp: ts, toolUseResult: { backgroundTaskId: 'b1' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: `Command running in background with ID: b1. Output is being written to: ${path.join(root, 'b1.out')}` }] } }));
fs.writeFileSync(path.join(root, 'b1.out'), 'compiling…\n');
fs.writeFileSync(path.join(subagents, 'agent-x1.jsonl'), line({ type: 'assistant', timestamp: ts, message: { model: 'claude-sub', content: [{ type: 'text', text: 'reading' }] } }));
fs.writeFileSync(path.join(subagents, 'agent-x1.meta.json'), JSON.stringify({ description: 'Long research', finished: false, toolUseId: 'tu_agent' }));
await settle();

const app = express();
app.use('/api/kit/agents', await kitAgentsRoutes());
const listener = app.listen(0, '127.0.0.1');
await new Promise((r) => listener.once('listening', r));
const base = `http://127.0.0.1:${listener.address().port}/api/kit/agents/app-refresh`;
const load = async () => (await fetch(base)).json();

const first = await load();
const second = await load(); // a refresh: a new page asks again, and nothing of the first is kept
for (const [label, map] of [['first load', first], ['after a refresh', second]]) {
  assert.deepEqual(map.tasks.map((t) => [t.id, t.status, t.stoppable]), [['b1', 'running', true]], `${label}: the job runs`);
  assert.deepEqual(map.agents.map((a) => [a.id, a.status, a.stoppable]), [['x1', 'running', true]], `${label}: the agent runs`);
}
assert.equal(first.main.running, true, 'the turn ended, but its process is held for the work');

const stop = await fetch(`${base}/tasks/b1/stop`, { method: 'POST' });
assert.equal(stop.status, 200, 'the job stops through the runtime');
const after = await load();
assert.deepEqual(after.tasks.map((t) => [t.id, t.status, t.stoppable]), [['b1', 'stopped', false]], 'and reads stopped, on any page');
assert.equal(after.agents[0].status, 'running', 'the agent is untouched');
assert.equal((await fetch(`${base}/tasks/b1/stop`, { method: 'POST' })).status, 409, 'stopping it again: not running (claudecodeui#1656)');

emit({ type: 'system', subtype: 'task_notification', session_id: N, task_id: 'a1', tool_use_id: 'tu_agent', status: 'completed', summary: 'done' });
await settle();
assert.equal((await load()).agents[0].stoppable, false, 'once the agent reports its end, the tracker lets it go');
emit(null);
await done;
listener.close();
console.log('agent map refresh: all checks passed');
process.exit(0);
