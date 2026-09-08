// Checks the compaction/wait row mapping the launcher patches into the bundle.
//
//   node launcher/rows-check.mjs <patched ide-*.js> <package dir> <transcript.jsonl>
//
// It lifts the patched loop out of the bundle VERBATIM and runs it, so what is
// under test is the code that shipped rather than a transcription of it: real
// compaction rows come from the patched server module reading a real transcript,
// and the ordering rules are exercised on rows built by hand.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const bundle = process.argv[2];
const src = fs.readFileSync(bundle, 'utf8');
const start = src.indexOf('const _kitDone=');
const end = src.indexOf('switch(l.kind){', start);
assert.ok(start > 0 && end > start, 'patched loop not found in the bundle');

// The patch text verbatim, with the switch replaced by a marker tail so the
// loop closes: this exercises the injected branch, not a transcription of it.
const body = src.slice(start, end) + 't.push({fellThrough:l.kind});}return t;';
const run = new Function('e', 'const t=[],r=new Map,i=new Map,hj=new Map;' + body);

// 1. real compaction rows, straight out of the patched server module
const {ClaudeSessionsProvider} = await import(
  `${process.argv[3]}/dist-server/server/modules/providers/list/claude/claude-sessions.provider.js`);
const provider = new ClaudeSessionsProvider();
const real = [];
for (const line of fs.readFileSync(process.argv[4], 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let parsed; try { parsed = JSON.parse(line); } catch { continue; }
  real.push(...provider.normalizeMessageRows(parsed, 'check'));
}
const realCompact = real.filter((row) => row.compact);
assert.ok(realCompact.length >= 10, `expected real compact rows, got ${realCompact.length}`);
const mappedReal = run(real);
const drawnReal = mappedReal.filter((row) => row.compact);
assert.equal(drawnReal.length, realCompact.length);
assert.ok(drawnReal.every((row) => row.compact.phase === 'done' && row.content.startsWith('Compacted')));
console.log(`real transcript: ${realCompact.length} compact rows carried through, `
  + `${mappedReal.length} rows total`);

// 2. a running compaction that a later boundary overtook is dropped
let out = run([
  { kind: 'text', role: 'assistant', content: 'Compacting…', compact: { phase: 'running' } },
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
]);
assert.deepEqual(out.map((r) => r.compact.phase), ['done']);

// 3. a still-running compaction with nothing after it survives
out = run([{ kind: 'text', role: 'assistant', content: 'Compacting…', compact: { phase: 'running' } }]);
assert.deepEqual(out.map((r) => r.compact.phase), ['running']);

// 4. the summary folds into the row already drawn
out = run([
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
  { kind: 'text', role: 'assistant', content: 'The summary body', isCompactSummary: true },
]);
assert.equal(out.length, 1);
assert.equal(out[0].compactSummary, 'The summary body');

// 5. an orphan summary still gets a row of its own
out = run([{ kind: 'text', role: 'assistant', content: 'Orphan summary', isCompactSummary: true }]);
assert.equal(out.length, 1);
assert.equal(out[0].compact.phase, 'done');
assert.equal(out[0].compactSummary, 'Orphan summary');

// 6. only the newest live wait row is drawn; a finished one stays
out = run([
  { kind: 'text', role: 'assistant', content: 'Waiting (old)', wait: { phase: 'holding' } },
  { kind: 'text', role: 'assistant', content: 'Waiting (new)', wait: { phase: 'started' } },
]);
assert.deepEqual(out.map((r) => r.content), ['Waiting (new)']);
out = run([
  { kind: 'text', role: 'assistant', content: 'Done waiting', wait: { phase: 'done' } },
  { kind: 'text', role: 'assistant', content: 'Waiting now', wait: { phase: 'holding' } },
]);
assert.deepEqual(out.map((r) => r.content), ['Done waiting', 'Waiting now']);

// 7. ordinary rows still reach upstream's switch, and subagent rows never do
out = run([
  { kind: 'text', role: 'assistant', content: 'hello' },
  { kind: 'tool_use', toolId: 't1', parentToolUseId: 'p1' },
]);
assert.deepEqual(out, [{ fellThrough: 'text' }]);

console.log('all checks passed');
