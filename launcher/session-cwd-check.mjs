// Does a session land in the project its transcript directory names?
//
// Lifts the PATCHED synchronizer out of the installed bundle (so this checks the
// shipped edit, not a copy of it), stubs only the database import, and drives
// processSessionFile over transcripts built for the occasion. Run after
// cloudcli-start has patched the package:
//     node launcher/session-cwd-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = process.env.CLOUDCLI_PKG
    ?? path.join(os.homedir(), '.npm-global/lib/node_modules/@cloudcli-ai/cloudcli');
const MOD = path.join(PKG, 'dist-server/server/modules/providers/list/claude',
    'claude-session-synchronizer.provider.js');

const src = fs.readFileSync(MOD, 'utf8');
if (!src.includes('kitTranscriptCwd')) {
    throw new Error('the session-cwd patch is not applied to ' + MOD);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-synccwd-'));
const stub = path.join(root, 'db-stub.mjs');
fs.writeFileSync(stub, 'export const sessionsDb = {'
    + ' getSessionByProviderSessionId: () => null, getSessionById: () => null };\n');

const utils = path.join(PKG, 'dist-server/server/shared/utils.js');
const loadable = path.join(root, 'sync.mjs');
fs.writeFileSync(loadable, src
    .replace("'../../../../modules/database/index.js'", JSON.stringify(stub))
    .replace("'../../../../shared/utils.js'", JSON.stringify(utils)));

// Transcripts. `line(cwd, extra)` writes what the synchronizer reads: a cwd and
// a sessionId, nothing else matters here.
const projects = path.join(root, 'projects');
const line = (cwd, id) => JSON.stringify({ type: 'user', cwd, sessionId: id }) + '\n';
function transcript(dirName, id, cwds) {
    const dir = path.join(projects, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, cwds.map((cwd) => line(cwd, id)).join(''));
    return file;
}

// 1. carried-in history first, this host's cwd later -- the shape that filed a
//    cloudcli-kit session under /Users/<someone>/workspace/acme-server
const carried = transcript('-home-me-workspace-kit', 's-carried', [
    '/Users/someone/workspace/acme-server',
    '/Users/someone/workspace/acme-server',
    '/home/me/workspace/kit',
]);
// 2. the ordinary case: first line already right, file never read
const plain = transcript('-home-me-workspace-kit', 's-plain', ['/home/me/workspace/kit']);
// 3. a dot in the path, which the directory name flattens to a dash
const dotted = transcript('-home-me-workspace-repo-wt-1', 's-dotted', [
    '/Users/someone/elsewhere',
    '/home/me/workspace/repo.wt-1',
]);
// 4. nothing in the file matches the directory -- keep the first cwd, do not guess
const nomatch = transcript('-home-me-somewhere-else', 's-nomatch', ['/Users/someone/elsewhere']);
// 5. no cwd at all is still not a session
const empty = transcript('-home-me-workspace-kit', 's-empty', []);

const { ClaudeSessionSynchronizer } = await import(loadable);
const sync = new ClaudeSessionSynchronizer();
const nameMap = new Map();
const projectOf = async (file) => (await sync.processSessionFile(file, nameMap))?.projectPath ?? null;

const expected = [
    [carried, '/home/me/workspace/kit', 'carried-in history must not win'],
    [plain, '/home/me/workspace/kit', 'the ordinary case must be untouched'],
    [dotted, '/home/me/workspace/repo.wt-1', 'a dotted path must be recovered, dot intact'],
    [nomatch, '/Users/someone/elsewhere', 'an unmatched directory must keep the first cwd'],
    [empty, null, 'a transcript with no cwd is not a session'],
];
for (const [file, want, why] of expected) {
    const got = await projectOf(file);
    if (got !== want) {
        throw new Error(`${why}: ${path.basename(file)} -> ${got}, expected ${want}`);
    }
}

// And the whole-directory scan reaches the same answer through synchronize().
const seen = [];
sync.claudeHome = root;
const { sessionsDb } = await import(stub);
sessionsDb.createSession = (id, provider, projectPath) => seen.push([id, projectPath]);
await sync.synchronize(null);
const carriedRow = seen.find(([id]) => id === 's-carried');
if (!carriedRow || carriedRow[1] !== '/home/me/workspace/kit') {
    throw new Error('synchronize() filed s-carried under ' + JSON.stringify(carriedRow));
}

console.log('session cwd: all checks passed');
fs.rmSync(root, { recursive: true, force: true });
