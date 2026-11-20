// Checks the agent map's server side against the installed package (patch 26).
//
//   node agents/agent-map-check.mjs <package dir>
//
// Builds a session on disk the way Claude Code writes one: a background shell
// job that later reports its end, an agent the session ran, and an agent that
// agent spawned in the background. Then reads it through the installed
// dist-server/server/kit-agents.js, appends to the transcript and reads again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pkg = process.argv[2];
assert.ok(pkg && fs.existsSync(pkg), 'pass the package directory');
const { readAgentMap, readTaskOutput, readAgentActivity } = await import(`${pkg}/dist-server/server/kit-agents.js`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-agentmap-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const transcript = path.join(root, 'sess.jsonl');
const subagentDir = path.join(root, 'sess', 'subagents');
fs.mkdirSync(subagentDir, { recursive: true });
const out = path.join(root, 'b1.output');
fs.writeFileSync(out, 'x'.repeat(70 * 1024) + '\nbuild finished\n');

const line = (o) => `${JSON.stringify(o)}\n`;
const t = (s) => `2026-11-20T10:00:${String(s).padStart(2, '0')}.000Z`;
const assistant = (s, model, content, usage) => line({ type: 'assistant', timestamp: t(s), message: { model, usage, content } });
const result = (s, id, text, extra = {}) => line({ type: 'user', timestamp: t(s), ...extra,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const usage = (n) => ({ input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 0, output_tokens: 5 });

fs.writeFileSync(transcript,
  assistant(1, 'claude-main', [{ type: 'tool_use', id: 'tu_bash', name: 'Bash',
    input: { command: 'make build', description: 'Build the project', run_in_background: true } }], usage(1000))
  + result(2, 'tu_bash', `Command running in background with ID: b1. Output is being written to: ${out}`,
    { toolUseResult: { backgroundTaskId: 'b1' } })
  + assistant(3, 'claude-main', [{ type: 'tool_use', id: 'tu_a1', name: 'Agent',
    input: { description: 'Explore the code', subagent_type: 'Explore', prompt: 'look', run_in_background: false } }], usage(2000))
  + result(20, 'tu_a1', 'The answer the agent gave')
  + line({ type: 'queue-operation', operation: 'enqueue', timestamp: t(30), content:
    `<task-notification><task-id>b1</task-id><tool-use-id>tu_bash</tool-use-id><output-file>${out}</output-file><status>completed</status><summary>build done</summary></task-notification>` }));

fs.writeFileSync(path.join(subagentDir, 'agent-a1.jsonl'),
  assistant(4, 'claude-sub', [{ type: 'text', text: 'Looking around.' },
    { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/repo/x.ts' } }], usage(5000))
  + result(5, 'tu_read', 'file text')
  + assistant(6, 'claude-sub', [{ type: 'tool_use', id: 'tu_a2', name: 'Agent',
    input: { description: 'Check the tests' } }], usage(7000)));
fs.writeFileSync(path.join(subagentDir, 'agent-a1.meta.json'),
  JSON.stringify({ agentType: 'Explore', description: 'Explore the code', finished: true, model: 'claude-sub', toolUseId: 'tu_a1' }));
fs.writeFileSync(path.join(subagentDir, 'agent-a2.jsonl'),
  assistant(7, 'claude-tiny', [{ type: 'tool_use', id: 'tu_grep', name: 'Grep', input: { pattern: 'describe(' } }], usage(300)));
fs.writeFileSync(path.join(subagentDir, 'agent-a2.meta.json'),
  JSON.stringify({ agentType: 'general-purpose', description: 'Check the tests', finished: false, toolUseId: 'tu_a2' }));

const where = { transcript, subagentDir };
let map = readAgentMap(where, { running: true, taskIds: new Set(), toolUseIds: new Set(['tu_a2']) });
assert.equal(map.main.model, 'claude-main');
assert.equal(map.main.contextTokens, 2010, 'the session context is its latest reading');
assert.deepEqual(map.tasks.map((x) => [x.id, x.type, x.status, x.hasOutput, x.name]),
  [['b1', 'shell', 'completed', true, 'Build the project']], 'one shell job, ended by its notification');
assert.equal(map.tasks[0].endedAt - map.tasks[0].startedAt, 29000, 'its runtime runs from the call to the notification');
const byId = Object.fromEntries(map.agents.map((a) => [a.id, a]));
assert.equal(byId.a1.parentId, 'main');
assert.equal(byId.a1.status, 'completed');
assert.equal(byId.a1.model, 'claude-sub');
assert.equal(byId.a1.contextTokens, 7010);
assert.equal(byId.a1.endedAt - byId.a1.startedAt, 17000, 'a foreground agent ends when its result comes back');
assert.equal(byId.a2.parentId, 'a1', 'an agent an agent spawned hangs under it');
assert.equal(byId.a2.status, 'running');
assert.equal(byId.a2.background, true, 'an Agent call runs in the background unless it says false');
assert.equal(byId.a2.stoppable, true, 'the tracker holds it, so it can be stopped');
assert.equal(byId.a1.stoppable, false, 'a finished agent cannot');

map = readAgentMap(where, { running: false, taskIds: new Set() });
assert.equal(map.agents.find((a) => a.id === 'a2').status, 'stopped', 'no live run: unfinished work is not running');
map = readAgentMap(where, { running: true, taskIds: new Set(), toolUseIds: new Set() });
assert.equal(map.agents.find((a) => a.id === 'a2').status, 'stopped',
  'the run is up but its tracker lost the background agent: stopped, not running forever');

const tail = readTaskOutput(where, 'b1', false);
assert.equal(tail.truncated, true);
assert.ok(tail.text.endsWith('build finished\n'));
assert.equal(readTaskOutput(where, 'b1', true).truncated, false, 'the full output is read whole');
assert.equal(readTaskOutput(where, 'nope', false), null, 'only a file the transcript named is read');

const act = readAgentActivity(where, 'a1');
assert.deepEqual(act.activity.map((e) => e.kind === 'tool' ? `${e.name}:${e.summary}` : 'text'),
  ['text', 'Read:/repo/x.ts', 'Agent:Check the tests']);
assert.equal(act.result, 'The answer the agent gave', "the agent's answer comes from its parent");
assert.equal(readAgentActivity(where, '../etc'), null, 'an agent id cannot climb out');

// The transcript grows: only the new lines are read, and a running job shows.
fs.appendFileSync(transcript,
  assistant(40, 'claude-main', [{ type: 'tool_use', id: 'tu_watch', name: 'Bash',
    input: { command: 'npm run watch', run_in_background: true } }], usage(3000))
  + result(41, 'tu_watch', 'Command running in background with ID: b2. Output is being written to: /tmp/none',
    { toolUseResult: { backgroundTaskId: 'b2' } }));
map = readAgentMap(where, { running: false, taskIds: new Set(['b2']) });
assert.deepEqual(map.tasks.map((x) => [x.id, x.status, x.name]),
  [['b1', 'completed', 'Build the project'], ['b2', 'running', 'npm run watch']], 'the live tracker marks a job running');
assert.equal(map.main.contextTokens, 3010);
// claudecodeui#1656: the session's run is up, but the job's end never reached the
// transcript and the tracker no longer holds it. It must not read as running.
map = readAgentMap(where, { running: true, taskIds: new Set() });
assert.equal(map.tasks.find((x) => x.id === 'b2').status, 'stopped', 'a job the tracker dropped is not running');
assert.equal(map.tasks.find((x) => x.id === 'b2').stoppable, false, 'and offers no Stop');
assert.deepEqual(readTaskOutput(where, 'b2', false), { text: '', size: 0, truncated: false, missing: true });
console.log('agent map: all checks passed');
