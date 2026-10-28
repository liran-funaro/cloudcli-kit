// Checks the Conversations click the launcher patches into the bundle.
//
//   node launcher/conversation-click-check.mjs <patched ide-*.js>
//
// It lifts the patched handler out of the bundle VERBATIM and runs it against
// fake projects, so what is under test is the code that shipped: a row whose
// project id names nothing loaded has to land on the project whose sessions
// hold it, with the row's summary and worktree, rather than a bare {id}.
import fs from 'node:fs'; import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('onConversationResultClick:(');
const body = src.slice(start + 'onConversationResultClick:'.length, src.indexOf('},onRefresh:', start) + 1);
// The closure's free names -- projects, the sorted-sessions helper, selectProject,
// selectSession -- are whatever the minifier chose this release, so they are read
// off the handler rather than written down.
const names = body.match(/=\(\w+\?(\w+)\.find\(\w+=>\w+\.projectId===\w+\):null\)\|\|\1\.find\(_kitOwnsIt=>(\w+)\(_kitOwnsIt\)/);
const calls = body.match(/if\(\w+\)\{(\w+)\(\w+\);const \w+=\w+\(\w+\)\.find\([^)]*\);(\w+)\(/);
assert.ok(names && calls, 'the handler no longer has the shape this check reads');
const picked = [];
const make = new Function(names[1], names[2], calls[1], calls[2], `return ${body}`);
const projects = [
  { projectId: 'repo', sessions: [{ id: 'main-s', summary: 'Main work' }, { id: 'wt-s', summary: 'Worktree work', worktree: '.wt-1' }] },
  { projectId: 'other', sessions: [{ id: 'o-s', summary: 'Other' }] },
];
const click = make(projects, (p) => p.sessions, (p) => picked.push(['project', p.projectId]), (s, pid) => picked.push(['session', s, pid]));
const run = (pid, sid) => { picked.length = 0; click(pid, sid, 'claude', null, null); return picked.slice(); };
// 1. a stale worktree project id (the bug): falls back to the repository's row, title and worktree kept
let r = run('wt-proj', 'wt-s');
assert.deepEqual(r[0], ['project', 'repo']);
assert.equal(r[1][1].summary, 'Worktree work'); assert.equal(r[1][1].worktree, '.wt-1'); assert.equal(r[1][2], 'repo');
// 2. the right id still works as before
r = run('other', 'o-s'); assert.deepEqual(r[0], ['project', 'other']); assert.equal(r[1][1].summary, 'Other');
// 3. no id at all: found by the session
r = run(null, 'main-s'); assert.deepEqual(r[0], ['project', 'repo']);
// 4. nothing holds it: upstream's bare fallback, unchanged
r = run('gone', 'nowhere'); assert.equal(r.length, 1); assert.equal(r[0][1].id, 'nowhere'); assert.equal(r[0][2], 'gone');
console.log('conversation click: 4 cases ok');
