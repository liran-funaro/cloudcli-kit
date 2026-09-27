// Checks the Bash-diff rows the launcher patches into the bundle, and the server
// line that lets a live turn's diff reach them.
//
//   node launcher/bash-diff-check.mjs <patched ide-*.js> <package dir>
//
// Lifts kitBashDiff out of the bundle verbatim and renders it through a fake JSX
// runtime, so what is under test is the code that shipped.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const [bundle, pkg] = process.argv.slice(2);
const src = fs.readFileSync(bundle, 'utf8');

// 1. wired in: the Bash row renders the diff after the command, from the result.
assert.ok(/kitBashDiff\(\w+,\w+\?\.toolUseResult\?\.bashEditDiff\)\]\}\)\}/.test(src),
  'the Bash row must pass toolUseResult.bashEditDiff to kitBashDiff');

// 2. the helper, lifted and run.
const start = src.indexOf('function kitBashDiff(J,d){');
const end = src.indexOf('"data-kit-bash-diff":"1",children:[...files,more]})}', start);
assert.ok(start >= 0 && end > start, 'kitBashDiff not found in the bundle');
const helper = src.slice(start, end + '"data-kit-bash-diff":"1",children:[...files,more]})}'.length);
const kitBashDiff = new Function(helper + ';return kitBashDiff')();
const el = (type, props) => ({ type, props });
const J = { jsx: el, jsxs: el, Fragment: 'Fragment' };
const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  const kids = node.props?.children;
  for (const kid of Array.isArray(kids) ? kids.flat() : [kids]) walk(kid, out);
  return out;
};
const text = (node) => walk(node).map((n) => n.props?.children)
  .filter((c) => typeof c === 'string').join('|');

for (const empty of [undefined, null, {}, { files: [] }, { skipped: true, files: [{}] }]) {
  assert.equal(kitBashDiff(J, empty), null, `nothing to draw for ${JSON.stringify(empty)}`);
}

// the shape the CLI records (seen in a real transcript and a live stream frame)
const diff = {
  files: [
    { filePath: '/r/f.txt', hunks: [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+TWO', ' three'] },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, lines: [' nine', '+ten'] },
    ] },
    { filePath: '/r/new.txt', created: true, hunks: [] },
  ],
  moreFiles: 2,
  changedFiles: ['/r/f.txt', '/r/new.txt'],
};
const tree = kitBashDiff(J, diff);
const nodes = walk(tree);
const details = nodes.filter((n) => n.type === 'details');
assert.equal(details.length, 2, 'one disclosure per file');
assert.ok(details.every((d) => d.props.open === true), 'open, the way the terminal shows it');
const t = text(tree);
assert.ok(t.includes('/r/f.txt') && t.includes('Bash edit'), 'the file and its badge');
assert.ok(t.includes('/r/new.txt') && t.includes('New'), 'a created file says so');
assert.ok(t.includes('two') && t.includes('TWO') && !t.includes('-two') && !t.includes('+TWO'),
  'the sign goes in the gutter, not in the text');
assert.ok(t.includes('⋯'), 'hunks are separated');
assert.ok(t.includes('+2 more files changed'), 'files the CLI left out are counted');
const signs = nodes.filter((n) => n.type === 'span' && (n.props.children === '-' || n.props.children === '+'));
assert.deepEqual(signs.map((n) => n.props.children), ['-', '+', '+'], 'a gutter sign per changed line');
assert.ok(signs[0].props.className.includes('text-red-400') && signs[1].props.className.includes('text-green-400'),
  'removed is red, added is green');

// 3. every class it uses is one the shipped stylesheet compiled -- a class
//    Tailwind never saw is no style at all.
const cssFile = fs.readdirSync(`${pkg}/dist/assets`).find((f) => /^index-.*\.css$/.test(f));
assert.ok(cssFile, 'no shipped stylesheet to check classes against');
const css = fs.readFileSync(`${pkg}/dist/assets/${cssFile}`, 'utf8');
const escape = (cls) => cls.replace(/[.:/[\]%()&]/g, (ch) => `\\${ch}`);
for (const match of helper.matchAll(/"([a-z0-9 :./\[\]-]*(?:px-|text-|bg-|w-6|flex)[a-z0-9 :./\[\]-]*)"/g)) {
  for (const cls of match[1].split(/\s+/).filter(Boolean)) {
    assert.ok(css.includes(`.${escape(cls)}`), `class ${cls} is not in the shipped CSS`);
  }
}

// 4. the server half: a live frame's structured result is read under both names.
const csp = fs.readFileSync(
  `${pkg}/dist-server/server/modules/providers/list/claude/claude-sessions.provider.js`, 'utf8');
assert.ok(csp.includes('toolUseResult: raw.toolUseResult ?? raw.tool_use_result,'),
  'the live normalizer must read tool_use_result too');

console.log('bash diffs: all checks passed');
