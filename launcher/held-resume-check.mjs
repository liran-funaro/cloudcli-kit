// Checks the held-run resume (patches 5 and 10) against the installed runtime.
//
//   node launcher/held-resume-check.mjs <package dir>
//
// A turn that ends with background work still running holds its CLI open. A
// message sent then must go INTO that process -- a new run would supersede it
// and take the work down -- and must come back with a `complete` of its own.
// Driven through queryClaudeSDK with a scripted SDK stream, the seam upstream's
// own runtime tests use, and read off the stdin the CLI would have seen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pkg = process.argv[2];
assert.ok(pkg && fs.existsSync(pkg), 'pass the package directory');
// Never the real database: the runtime opens one on import.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-held-'));
process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
process.on('exit', () => fs.rmSync(dbDir, { recursive: true, force: true }));
const lib = `${pkg}/dist-server/server/modules/providers/list/claude`;
const { claudeRuntime, queryClaudeSDK } = await import(`${lib}/claude-runtime.provider.js`);
const { ClaudeSessionsProvider } = await import(`${lib}/claude-sessions.provider.js`);
const { CLAUDE_PREDEFINED_MODELS } = await import(`${lib}/claude-models.provider.js`);
assert.equal(typeof claudeRuntime.resumeHeld, 'function', 'the runtime exports the resume');
assert.equal(typeof claudeRuntime.steer, 'function', "upstream's steer is still there beside it");

const queue = [];
const read = [];
let wake = null;
let released = false;
const emit = (message) => { queue.push(message); wake?.(); };
const createQuery = ({ prompt }) => {
  void (async () => {
    for await (const message of prompt) read.push(message);
    released = true;
  })();
  const iterator = (async function* () {
    for (;;) {
      if (queue.length === 0) {
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
        continue;
      }
      const next = queue.shift();
      if (next === null) return;
      yield next;
    }
  })();
  return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
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
const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });
const N = 'native-held';
const first = [];
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-held-cwd-'));
const done = queryClaudeSDK('hello', { sessionId: 'app-held', cwd },
  { send: (m) => { first.push(m); }, userId: null }, context);

emit({ type: 'system', subtype: 'init', session_id: N });
emit({ type: 'assistant', session_id: N, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash',
    input: { command: 'sleep 600', run_in_background: true } }] } });
emit({ type: 'system', subtype: 'task_started', session_id: N, task_id: 'b1', tool_use_id: 'toolu_bg',
  description: 'sleep', task_type: 'local_bash' });
emit({ type: 'result', subtype: 'success', session_id: N, result: 'launched', duration_ms: 1, num_turns: 1 });
await settle();
assert.ok(first.some((m) => m.kind === 'complete'), 'the turn is over for the client');
assert.ok(first.some((m) => m.wait?.phase === 'holding'), 'and the hold is drawn');
assert.equal(released, false, 'the CLI is held for its background work');

// Nothing held yet for a session with no run: the caller starts one as usual.
assert.equal(claudeRuntime.resumeHeld('no-such-session', 'hi', null), null);

const second = [];
const resumed = claudeRuntime.resumeHeld('app-held', 'how is it going?', { send: (m) => { second.push(m); } });
assert.ok(resumed && typeof resumed.then === 'function', 'a held run takes the message');
await settle();
assert.equal(read.at(-1)?.message?.content, 'how is it going?', 'pushed onto the same stdin');
assert.equal(released, false, 'into the same process, not a new one');
assert.ok(second.some((m) => m.wait?.phase === 'resumed'), 'the countdown row says so');

emit({ type: 'system', subtype: 'init', session_id: N });
emit({ type: 'assistant', session_id: N, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text: 'still sleeping' }] } });
emit({ type: 'result', subtype: 'success', session_id: N, result: 'still sleeping', duration_ms: 1, num_turns: 1 });
await resumed;
assert.ok(second.some((m) => m.kind === 'complete'), "the message's own turn completes on its own writer");
assert.equal(released, false, 'and the work it was waiting on is still held');

emit({ type: 'system', subtype: 'task_notification', session_id: N, task_id: 'b1', tool_use_id: 'toolu_bg',
  status: 'stopped', summary: 'b1 stopped', output_file: '' });
await settle();
assert.equal(released, true, 'the hold ends when the work does');
emit(null);
await done;
fs.rmSync(cwd, { recursive: true, force: true });
console.log('held resume: all checks passed');
