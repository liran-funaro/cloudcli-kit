// Checks patch 20: the header takes the live title and worktree of the session it shows.
//
//   node launcher/header-sync-check.mjs <package dir>
//
// Runs the patched statement out of the bundle index.html serves, with the
// event and the header's state setter stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pkg = process.argv[2];
assert.ok(pkg && fs.existsSync(pkg), 'pass the package directory');
const html = fs.readFileSync(path.join(pkg, 'dist/index.html'), 'utf8');
const served = html.match(/src="\/?(assets\/[^"?]+\.js)/g).map((m) => m.replace(/^src="\/?/, ''));
const bundle = served.map((f) => fs.readFileSync(path.join(pkg, 'dist', f), 'utf8')).find((b) => b.includes('_kitHeadSync'));
assert.ok(bundle, 'the served bundle carries the header sync');
const m = bundle.match(/(\w+)\(_kitHeadSync=>\{if\(!_kitHeadSync\|\|_kitHeadSync\.id!==(\w+)\.sessionId\).*?return\{\.\.\._r,summary:_t,worktree:_w\}\}\);/);
assert.ok(m, 'the statement is found');
const run = new Function(m[1], m[2], m[0]);

const header = (prev, event) => { let next; run((f) => { next = f(prev); }, event); return next; };
const ev = (summary, worktree) => ({ sessionId: 's1', session: { summary, worktree } });
const open = { id: 's1', summary: '', worktree: undefined, __searchTargetSnippet: 'x', __provider: 'claude' };

const titled = header(open, ev('fix the flaky test', '.wt-2'));
assert.equal(titled.summary, 'fix the flaky test', 'the title the sidebar got reaches the header');
assert.equal(titled.worktree, '.wt-2', 'and the worktree, which names the checkout under it');
assert.equal(titled.__searchTargetSnippet, undefined, 'the one-shot search jump is not replayed');
assert.equal(titled.__provider, 'claude', 'everything else is kept');
assert.equal(header(titled, ev('', '.wt-2')), titled, 'an empty summary never blanks a title, and nothing changed: same object');
assert.equal(header(titled, ev('fix the flaky test', '.wt-2')), titled, 'an update that changes nothing leaves the header alone');
const other = { id: 's2', summary: 'other' };
assert.equal(header(other, ev('fix the flaky test', '.wt-2')), other, "another session's update does not touch this header");
assert.equal(header(null, ev('t', '')), null, 'no session open: nothing');
assert.equal(header(titled, { sessionId: 's1', session: { summary: 'x' } }).worktree, '.wt-2',
  'a server without the worktree field keeps what the header had');
console.log('header sync: all checks passed');
