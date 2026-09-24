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

// 8. the worktree picker, lifted from the same bundle: the columns are laid out,
//    so what has to hold is the structure -- a label column that cannot shrink,
//    a divider on the branch column, and no dependence on any font.
const picker = src.slice(src.indexOf('_kitProj&&(_kitProj._kitWorktrees||[]).length>1'),
  src.indexOf('_w.path))})]}):null') + 20);
assert.ok(picker.length > 200 && picker.length < 4000, 'picker markup not found in the bundle');
for (const needed of [
  'jsxs("details"', 'kit-wt relative',          // open/closed with no React state
  'shrink-0 font-mono text-foreground',         // the label column ...
  'style:{minWidth:"10rem"}',                   // ... whose width cannot be a class
  'border-l border-border/60 pl-2',             // the divider, on every row
  'onClick:_e=>kitWtPick(', 'title:_w.path',
]) {
  assert.ok(picker.includes(needed), `picker must contain ${needed}`);
}
assert.ok(!picker.includes('"option"') && !picker.includes('u00a0'),
  'no native options and no padded text: alignment must not depend on a font');

// Tailwind compiles only the classes upstream's own source mentions, so a class
// this patch invents is a no-op in the shipped CSS -- which is exactly how the
// columns came out unaligned with the markup already correct. Every class the
// picker uses has to exist; anything else belongs in an inline style, and the
// four that carry the layout are checked by name.
const cssFile = fs.readdirSync(`${process.argv[3]}/dist/assets`)
  .find((f) => /^index-.*\.css$/.test(f));
assert.ok(cssFile, 'no shipped stylesheet to check classes against');
const css = fs.readFileSync(`${process.argv[3]}/dist/assets/${cssFile}`, 'utf8');
const escape = (cls) => cls.replace(/[.:/[\]%()&]/g, (ch) => `\\${ch}`);
const ours = new Set(['kit-wt', 'kit-wt-now']);   // selector hooks, never styling
for (const match of picker.matchAll(/className:"([^"]+)"/g)) {
  for (const cls of match[1].split(/\s+/).filter(Boolean)) {
    if (ours.has(cls)) continue;
    assert.ok(css.includes(`.${escape(cls)}`), `class ${cls} is not in the shipped CSS`);
  }
}
for (const style of ['minWidth:"10rem"', 'maxHeight:"18rem"', 'listStyle:"none"',
  'fontSize:"12px"']) {
  assert.ok(picker.includes(style), `the layout needs ${style} inline, not as a class`);
}

// The click handler updates the summary and closes the disclosure, since nothing
// else will: run the injected helpers against a fake row and check both.
const hStart = src.indexOf('function kitWtKey(project){');
const hEnd = src.indexOf('d.open=false}', hStart);
assert.ok(hStart > 0 && hEnd > hStart, 'picker helpers not found in the bundle');
const helpers = src.slice(hStart, hEnd + 'd.open=false}'.length);
const win = {};
const kitWtPick = new Function('window', 'localStorage',
  helpers + ';return kitWtPick')(win, { getItem: () => null, setItem: () => {} });
const now = { textContent: '' };
const details = { open: true, querySelector: () => now };
kitWtPick({ projectId: 'p' }, { label: '.storage', branch: 'design/storage', path: '/w/r.storage' },
  { closest: () => details });
assert.equal(now.textContent, '.storage \u00b7 design/storage', 'the summary must follow the pick');
assert.equal(details.open, false, 'picking must close the list');
assert.equal(win.__kitWtCwd.path, '/w/r.storage', 'the send must see the choice');

console.log('all checks passed');
