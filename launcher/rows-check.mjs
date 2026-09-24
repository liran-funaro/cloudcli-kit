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
// The tail stands in for upstream's switch, which pushes each row with its
// content -- the dedupe below reads that, so the stub has to carry it too.
const body = src.slice(start, end)
  + 't.push({fellThrough:l.kind,content:l.content});}return t;';
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

// 4b. the CLI's unflagged second copy of the summary is not drawn again --
// after the fold
out = run([
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
  { kind: 'text', role: 'assistant', content: 'The summary body', isCompactSummary: true },
  { kind: 'text', role: 'assistant', content: 'The summary body' },
]);
assert.equal(out.length, 1);
assert.equal(out[0].compactSummary, 'The summary body');

// 4c. ... and before it, where the loose copy has already been pushed
out = run([
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
  { kind: 'text', role: 'assistant', content: 'The summary body' },
  { kind: 'text', role: 'assistant', content: 'The summary body', isCompactSummary: true },
]);
assert.equal(out.length, 1);
assert.equal(out[0].compact.phase, 'done');
assert.equal(out[0].compactSummary, 'The summary body');

// 4c2. the loose copy several rows earlier, which is where a live one lands
out = run([
  { kind: 'text', role: 'assistant', content: 'The summary body\n' },
  { kind: 'text', role: 'assistant', content: 'some work' },
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
  { kind: 'text', role: 'assistant', content: 'The summary body', isCompactSummary: true },
]);
assert.deepEqual(out.map((r) => r.content), ['some work', 'Compacted · auto']);
assert.equal(out[1].compactSummary, 'The summary body');

// 4d. an ordinary row that merely follows a compaction is untouched
out = run([
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
  { kind: 'text', role: 'assistant', content: 'The summary body', isCompactSummary: true },
  { kind: 'text', role: 'assistant', content: 'On with the work' },
]);
assert.deepEqual(out.map((r) => r.compactSummary || r.fellThrough), ['The summary body', 'text']);

// 4e. the live order: the summary arrives BEFORE its boundary, and the two
// still come out as one row carrying the metrics line
out = run([
  { kind: 'text', role: 'assistant', content: 'The summary body', isCompactSummary: true },
  { kind: 'text', role: 'assistant', content: 'Compacted · manual · 335k → 10k tokens · 2m 22s',
    compact: { phase: 'done', trigger: 'manual' } },
]);
assert.equal(out.length, 1);
assert.equal(out[0].content, 'Compacted · manual · 335k → 10k tokens · 2m 22s');
assert.equal(out[0].compactSummary, 'The summary body');

// 4f. the CLI's live-only one-word notice is dropped beside a real row, and
// kept when there is none (an unpatched server, where it is all there is)
out = run([
  { kind: 'text', role: 'assistant', content: 'Compacted' },
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
]);
assert.deepEqual(out.map((r) => r.content), ['Compacted · auto']);
out = run([{ kind: 'text', role: 'assistant', content: 'Compacted' }]);
assert.deepEqual(out.map((r) => r.content), ['Compacted']);

// 4g. a message that merely mentions the word is untouched
out = run([
  { kind: 'text', role: 'assistant', content: 'Compacted the log file for you' },
  { kind: 'text', role: 'assistant', content: 'Compacted · auto', compact: { phase: 'done' } },
]);
assert.deepEqual(out.map((r) => r.content),
  ['Compacted the log file for you', 'Compacted · auto']);

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
assert.deepEqual(out, [{ fellThrough: 'text', content: 'hello' }]);

// 8. the worktree picker's two columns, lifted from the same bundle: every option
//    must put its bar at the same offset, whatever the labels are.
const wtStart = src.indexOf('function kitWtText(project,w){');
assert.ok(wtStart > 0, 'kitWtText not found in the bundle');
const wtEnd = src.indexOf('\n', wtStart);
const kitWtText = new Function('return ' + src.slice(wtStart, wtEnd > 0 ? wtEnd : undefined)
  + ';kitWtText')();
const project = { _kitWorktrees: [
  { label: '', branch: 'release/2.x' },              // the main checkout
  { label: '.signing', branch: 'feat/faster-signing' },
  { label: '.storage', branch: null },               // git reports no branch
  { label: '.a', branch: 'detached' },               // the shortest label
] };
const lines = project._kitWorktrees.map((w) => kitWtText(project, w));
const bars = lines.map((l) => l.indexOf('\u2502'));
assert.equal(new Set(bars).size, 1, 'bars must line up: ' + JSON.stringify(lines));
assert.ok(bars[0] >= '.signing'.length, 'labels must pad to the widest one');
assert.ok(lines[2].endsWith('\u00a0'), 'a branchless row still draws its bar');
assert.ok(!lines.some((l) => / {2}/.test(l)), 'padding must be non-breaking, not spaces');

//    ... and the face the options are drawn in has to travel with them, since the
//    popup is the browser's own widget and does not reliably inherit the select's.
const fontStart = src.indexOf('const KIT_WT_FONT=');
assert.ok(fontStart > 0, 'KIT_WT_FONT not found in the bundle');
const font = new Function(src.slice(fontStart, src.indexOf('\n', fontStart)) + ';return KIT_WT_FONT')();
assert.match(font.fontFamily, /monospace$/, 'options must fall back to monospace');
assert.ok(src.includes('title:_w.path,style:KIT_WT_FONT'),
  'every option must carry the face inline');

console.log('all checks passed');
