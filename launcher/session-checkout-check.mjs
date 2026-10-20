// Checks the session-checkout swap the launcher patches into the workspace.
//
//   node launcher/session-checkout-check.mjs <patched ide-*.js>
//
// The workspace component hands its project to Files, the editor, Shell, Source
// Control and the header. For a worktree session that has to be the worktree's
// own project row -- its id is what the server resolves file reads and git
// against -- so the swap is lifted out of the bundle VERBATIM and run, and the
// component body is checked to read nothing but the swapped project.
import fs from 'node:fs'; import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8');
const i = src.indexOf('{const e=(_s=>{'); const j = src.indexOf('/*_kitCheckout*/;', i);
const expr = src.slice(i + '{const e='.length, j);
const pick = (repo, sess) => new Function('_kitRepo', 't', 'return ' + expr.replace(/\)\(t\)$/, ')(t)'))(repo, sess);
const repo = { projectId: 'R', path: '/w/repo', fullPath: '/w/repo', displayName: 'repo',
  _kitWorktrees: [{ path: '/w/repo', projectId: 'R', label: '' }, { path: '/w/repo.wt-2', projectId: 'M', label: '.wt-2' }] };
const a = pick(repo, { id: 's', worktree: '.wt-2' });
assert.deepEqual([a.projectId, a.path, a.fullPath, a.displayName], ['M', '/w/repo.wt-2', '/w/repo.wt-2', 'repo.wt-2']);
assert.equal(pick(repo, { id: 's', worktree: '' }), repo);
assert.equal(pick(repo, null), repo);
assert.equal(pick(null, { worktree: '.wt-2' }), null);
// every consumer in the workspace reads `e`: none may still read the repository
const body = src.slice(j, src.indexOf('function ', j + 20));
assert.ok(!/\b_kitRepo\b/.test(body), 'nothing downstream reads the repository');
for (const k of ['selectedProject:e,onFileOpen:', 'project:e,session:t,', 'selectedProject:e,isMobile:', 'projectPath:e.path', 'selectedProject:e,selectedSession:t,shouldShowTasksTab']) assert.ok(body.includes(k), k);
console.log('session checkout: ok');
