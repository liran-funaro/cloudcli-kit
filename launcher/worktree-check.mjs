// Checks the worktree coalescing the launcher patches into the projects service.
//
//   node launcher/worktree-check.mjs <patched projects-with-sessions-fetch.service.js>
//
// The patched file is imported with its DB and synchronizer replaced by fakes, so
// what is under test is the code that ships rather than a copy of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const target = process.argv[2];
assert.ok(target && fs.existsSync(target), 'pass the patched service file');

// --- a real repository with real worktrees, so git answers for itself --------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-wt-'));
const repo = path.join(root, 'demo-repo');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
git(repo, 'config', 'user.email', 'check@example.invalid');
git(repo, 'config', 'user.name', 'check');
fs.writeFileSync(path.join(repo, 'f'), 'x');
git(repo, 'add', 'f');
git(repo, 'commit', '-qm', 'one');
for (const suffix of ['.wt-1', '.storage']) {
  git(repo, 'worktree', 'add', '-q', '-b', `b${suffix}`, `${repo}${suffix}`);
}
// a worktree that was removed properly: git has forgotten it and the directory
// is gone, exactly like acme-common.storage
const deleted = `${repo}.gone`;
git(repo, 'worktree', 'add', '-q', '-b', 'b-gone', deleted);
git(repo, 'worktree', 'remove', '--force', deleted);
assert.ok(!fs.existsSync(deleted), 'the removed worktree is really gone');
assert.ok(!execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  .includes(deleted), 'and git no longer lists it');

// a directory that merely shares a prefix without a separator, which must NOT
// be adopted
const lookalike = path.join(root, 'demo-repository-elsewhere');

const unrelated = path.join(root, 'other-repo');
fs.mkdirSync(unrelated);
execFileSync('git', ['init', '-q', unrelated], { stdio: 'ignore' });
const plain = path.join(root, 'not-a-repo');
fs.mkdirSync(plain);

// --- fakes for everything the service imports -------------------------------
const projectRows = [
  { project_id: 'p-main', project_path: repo, custom_project_name: 'Demo' },
  { project_id: 'p-wt1', project_path: `${repo}.wt-1`, custom_project_name: null },
  { project_id: 'p-storage', project_path: `${repo}.storage`, custom_project_name: null },
  { project_id: 'p-other', project_path: unrelated, custom_project_name: null },
  { project_id: 'p-plain', project_path: plain, custom_project_name: null },
  { project_id: 'p-gone', project_path: deleted, custom_project_name: null },
  { project_id: 'p-look', project_path: lookalike, custom_project_name: null },
  { project_id: 'p-mac', project_path: '/Users/someone/workspace/demo-repo', custom_project_name: null },
];
const sessionRows = {
  [repo]: [{ session_id: 's-main', provider: 'claude', project_path: repo, updated_at: '2026-09-24T09:00:00Z', custom_name: 'main work' }],
  [`${repo}.wt-1`]: [{ session_id: 's-wt1', provider: 'claude', project_path: `${repo}.wt-1`, updated_at: '2026-09-24T10:00:00Z', custom_name: 'newest' }],
  [`${repo}.storage`]: [{ session_id: 's-storage', provider: 'claude', project_path: `${repo}.storage`, updated_at: '2026-09-24T08:00:00Z', custom_name: 'older' }],
  [unrelated]: [{ session_id: 's-other', provider: 'claude', project_path: unrelated, updated_at: '2026-09-24T07:00:00Z', custom_name: 'elsewhere' }],
  [plain]: [],
  [deleted]: [{ session_id: 's-gone', provider: 'claude', project_path: deleted, updated_at: '2026-09-24T09:30:00Z', custom_name: 'work in a worktree since removed' }],
  [lookalike]: [{ session_id: 's-look', provider: 'claude', project_path: lookalike, updated_at: '2026-09-24T06:00:00Z', custom_name: 'different project' }],
  ['/Users/someone/workspace/demo-repo']: [{ session_id: 's-mac', provider: 'claude', project_path: '/Users/someone/workspace/demo-repo', updated_at: '2026-09-24T05:00:00Z', custom_name: 'another machine' }],
};

// Every relative import becomes a fake: node:* stay real, so the code under
// test keeps its own fs, path and child_process.
const source = fs.readFileSync(target, 'utf8')
  .replace(/^import \{ projectsDb, sessionsDb \} from '.*';$/m,
    'const projectsDb = globalThis.__kitProjectsDb;\nconst sessionsDb = globalThis.__kitSessionsDb;')
  .replace(/^import \{ sessionSynchronizerService \} from '.*';$/m,
    'const sessionSynchronizerService = { synchronizeSessions: async () => {} };')
  .replace(/^import \{ WS_OPEN_STATE, connectedClients \} from '.*';$/m,
    'const WS_OPEN_STATE = 1;\nconst connectedClients = new Set();')
  .replace(/^import \{ AppError \} from '.*';$/m,
    'class AppError extends Error { constructor(message) { super(message); } }');
assert.ok(!/^import .*\.\.\//m.test(source), 'every relative import was replaced');

globalThis.__kitProjectsDb = {
  getProjectPaths: () => projectRows,
  getArchivedProjectPaths: () => [],
  getProjectById: (id) => projectRows.find((row) => row.project_id === id) ?? null,
};
globalThis.__kitSessionsDb = {
  getSessionsByProjectPathPage: (p, limit, offset) => (sessionRows[p] ?? []).slice(offset, offset + limit),
  countSessionsByProjectPath: (p) => (sessionRows[p] ?? []).length,
  getSessionsByProjectPathIncludingArchived: (p) => sessionRows[p] ?? [],
};

const moduleFile = path.join(root, 'service.mjs');
fs.writeFileSync(moduleFile, source);
const service = await import(moduleFile);

// --- what it should do ------------------------------------------------------
const projects = await service.getProjectsWithSessions({ skipSynchronization: true });
const paths = projects.map((p) => p.path);

assert.ok(paths.includes(repo), 'the repository is listed');
assert.ok(!paths.includes(`${repo}.wt-1`), 'its worktree is not a row of its own');
assert.ok(!paths.includes(`${repo}.storage`), 'nor the second worktree');
assert.ok(paths.includes(unrelated), 'an unrelated repository is untouched');
assert.ok(paths.includes(plain), 'a directory that is not a repository is untouched');

const demo = projects.find((p) => p.path === repo);
assert.deepEqual(demo.sessions.map((s) => s.id), ['s-wt1', 's-gone', 's-main', 's-storage'],
  'every checkout, newest first');
assert.deepEqual(demo.sessions.map((s) => s.worktree), ['.wt-1', '.gone', '', '.storage'],
  'each row says which worktree, and the main checkout says nothing');
assert.equal(demo.sessionMeta.total, 4, 'the total counts every checkout, deleted ones included');

// the picker's own data: a checkout, its label, and the branch it has out
const picker = demo._kitWorktrees;
assert.ok(picker.length >= 3, 'the picker lists every checkout');
const mainEntry = picker.find((w) => w.label === '');
assert.ok(mainEntry && mainEntry.path === repo, 'the main checkout is in the list, unlabelled');
assert.equal(typeof mainEntry.branch, 'string', 'and reports the branch it has out');
const wt1 = picker.find((w) => w.label === '.wt-1');
assert.equal(wt1.branch, 'b.wt-1', 'a worktree reports its own branch');
const goneEntry = picker.find((w) => w.label === '.gone');
assert.equal(goneEntry.branch, null, 'a checkout git no longer lists reports no branch');

const other = projects.find((p) => p.path === unrelated);
assert.equal(other.sessions.length, 1);
assert.equal(other.sessions[0].worktree, undefined, 'a lone project gains no label');

// --- a deleted worktree's sessions are still attributed to the repository ----
assert.ok(!paths.includes(deleted), 'the vanished worktree is not a row of its own');
assert.deepEqual(demo.sessions.map((s) => s.id), ['s-wt1', 's-gone', 's-main', 's-storage'],
  'its session sits in the repository list, in recency order');
const gone = demo.sessions.find((s) => s.id === 's-gone');
assert.equal(gone.worktree, '.gone', 'and says which worktree it came from');

// --- but naming alone must not adopt anything that merely looks similar ------
assert.ok(paths.includes(lookalike),
  'a vanished path with no separator after the repo name keeps its own row');
assert.ok(paths.includes('/Users/someone/workspace/demo-repo'),
  "another machine's path is not folded into this machine's repository");

// load more must read the same union, not fall back to the main checkout
const page = await service.getProjectSessionsPage('p-main', { limit: 2, offset: 0 });
assert.deepEqual(page.sessions.map((s) => s.id), ['s-wt1', 's-gone']);
const page2 = await service.getProjectSessionsPage('p-main', { limit: 2, offset: 2 });
assert.deepEqual(page2.sessions.map((s) => s.id), ['s-main', 's-storage'], 'the second page continues the union');
assert.equal(page2.sessionMeta.hasMore, false);

console.log('worktree coalescing: all checks passed');

// --- the live broadcast must name the repository, not the worktree -----------
// Regression for the row that appeared on the first message of a worktree
// session and disappeared on the next refresh.
{
  const broadcastFile = process.argv[3];
  if (broadcastFile && fs.existsSync(broadcastFile)) {
    const src = fs.readFileSync(broadcastFile, 'utf8')
      .replace(/^import \{ projectsDb, sessionsDb \} from '.*';$/m,
        'const projectsDb = globalThis.__kitProjectsDb;\nconst sessionsDb = globalThis.__kitSessionsDb;')
      .replace(/^import \{ generateDisplayName \} from '.*';$/m,
        'const generateDisplayName = async (name) => name;')
      .replace(/^import \{ kitWorktreeIndex, kitWorktreeLabel \} from '.*';$/m,
        `const { kitWorktreeIndex, kitWorktreeLabel } = await import(${JSON.stringify(moduleFile)});`)
      .replace(/^import \{ connectedClients, WS_OPEN_STATE \} from '.*';$/m,
        'const WS_OPEN_STATE = 1;\nconst connectedClients = new Set();');
    assert.ok(!/^import .*\.\.\//m.test(src),
      'every relative import was replaced: ' + (src.match(/^import .*\.\.\/.*$/m) || [''])[0]);

    // the broadcast resolves by provider id first, then by session id
    globalThis.__kitSessionsDb.getSessionByProviderSessionId = () => null;
    globalThis.__kitSessionsDb.getSessionById = (id) => ({
      's-wt1': { session_id: 's-wt1', provider: 'claude', project_path: `${repo}.wt-1`, custom_name: 'in a worktree', updated_at: '2026-09-24T10:00:00Z', isArchived: 0 },
      's-main': { session_id: 's-main', provider: 'claude', project_path: repo, custom_name: 'in the repo', updated_at: '2026-09-24T09:00:00Z', isArchived: 0 },
    }[id] ?? null);
    globalThis.__kitProjectsDb.getProjectPath = (p) =>
      projectRows.find((row) => row.project_path === p)
        ? { project_id: projectRows.find((row) => row.project_path === p).project_id, project_path: p, custom_project_name: null, isStarred: 0 }
        : null;

    const broadcastModule = path.join(root, 'broadcast.mjs');
    fs.writeFileSync(broadcastModule, src);
    const bc = await import(broadcastModule);

    const fromWorktree = await bc.buildSessionUpsertedEvent('s-wt1');
    assert.equal(fromWorktree.project.path, repo, 'a worktree session is announced against the repository');
    assert.equal(fromWorktree.session.worktree, '.wt-1', 'and carries its label so the row is badged live');

    const fromRepo = await bc.buildSessionUpsertedEvent('s-main');
    assert.equal(fromRepo.project.path, repo);
    assert.equal(fromRepo.session.worktree, '', 'a main-checkout session claims no worktree');
    console.log('broadcast coalescing: checks passed');
  }
}

fs.rmSync(root, { recursive: true, force: true });
