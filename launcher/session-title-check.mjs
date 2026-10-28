// Does a session the app created take the title the CLI wrote for it?
//
// Lifts the PATCHED synchronizer out of the installed bundle, stubs only the
// database import, and drives processSessionFile over transcripts built for the
// occasion. A name the app generated from the first prompt gives way to the
// transcript's `ai-title`; a name someone typed never does. Run after
// cloudcli-start has patched the package:
//     node launcher/session-title-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = process.env.CLOUDCLI_PKG
    ?? path.join(os.homedir(), '.npm-global/lib/node_modules/@cloudcli-ai/cloudcli');
const MOD = process.argv[2] ?? path.join(PKG, 'dist-server/server/modules/providers/list/claude',
    'claude-session-synchronizer.provider.js');
const src = fs.readFileSync(MOD, 'utf8');
assert.ok(src.includes('kitTranscriptTitles'), `the session-title patch is not applied to ${MOD}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-synctitle-'));
// A one-table database: rows by app id, looked up by provider id as the real one is.
globalThis.__kitRows = new Map();
const stub = path.join(root, 'db-stub.mjs');
fs.writeFileSync(stub, `
const rows = globalThis.__kitRows;
export const sessionsDb = {
  getSessionByProviderSessionId: (id) => [...rows.values()].find((r) => r.provider_session_id === id) ?? null,
  getSessionById: (id) => rows.get(id) ?? null,
  updateSessionCustomName: (id, name) => { rows.get(id).custom_name = name; },
};
`);
const loadable = path.join(root, 'sync.mjs');
fs.writeFileSync(loadable, src
    .replace("'../../../../modules/database/index.js'", JSON.stringify(stub))
    .replace("'../../../../shared/utils.js'", JSON.stringify(path.join(PKG, 'dist-server/server/shared/utils.js'))));
const { ClaudeSessionSynchronizer } = await import(loadable);
const sync = new ClaudeSessionSynchronizer();

const cwd = path.join(root, 'repo');
const dir = path.join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const write = (id, lines) => {
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify({ sessionId: id, cwd, ...l })).join('\n') + '\n');
    return file;
};
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const ai = (t) => ({ type: 'ai-title', aiTitle: t });
const row = (app, id, name) => globalThis.__kitRows.set(app, { session_id: app, provider_session_id: id, custom_name: name });
const name = (app) => globalThis.__kitRows.get(app).custom_name;
const run = async (file) => sync.processSessionFile(file, new Map());

// 1. the app's placeholder (first four words) gives way to the AI title
row('a1', 'p1', 'Fix the flaky login');
let r = await run(write('p1', [prompt('Fix the flaky login test in CI please'), ai('Flaky login test fix')]));
assert.equal(name('a1'), 'Flaky login test fix'); assert.equal(r.sessionName, 'Flaky login test fix');

// 2. and follows the CLI when it re-titles the session later
write('p1', [prompt('Fix the flaky login test in CI please'), ai('Flaky login test fix'), ai('Login test and CI retry policy')]);
await run(path.join(dir, 'p1.jsonl'));
assert.equal(name('a1'), 'Login test and CI retry policy');

// 3. a name someone typed is never replaced, however many titles follow
row('a3', 'p3', 'My own name');
await run(write('p3', [prompt('Fix the flaky login test in CI please'), ai('Flaky login test fix')]));
assert.equal(name('a3'), 'My own name');

// 4. a rename in the UI after the session was titled sticks too
row('a4', 'p4', 'Fix the flaky login');
await run(write('p4', [prompt('Fix the flaky login test'), ai('Flaky login')]));
assert.equal(name('a4'), 'Flaky login');
globalThis.__kitRows.get('a4').custom_name = 'Renamed by hand';
write('p4', [prompt('Fix the flaky login test'), ai('Flaky login'), ai('Flaky login, round two')]);
await run(path.join(dir, 'p4.jsonl'));
assert.equal(name('a4'), 'Renamed by hand');

// 5. a /rename in the CLI wins over the AI title, as upstream ranks them
row('a5', 'p5', 'Fix the flaky login');
await run(write('p5', [prompt('Fix the flaky login test'), { type: 'custom-title', customTitle: 'Chosen in the CLI' }, ai('Flaky login')]));
assert.equal(name('a5'), 'Chosen in the CLI');

// 6. no title yet: the placeholder stays
row('a6', 'p6', 'Fix the flaky login');
await run(write('p6', [prompt('Fix the flaky login test')]));
assert.equal(name('a6'), 'Fix the flaky login');

// 7. a prompt with images (array content) still counts as the first prompt
row('a7', 'p7', 'Look at this screenshot');
await run(write('p7', [{ type: 'user', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'Look at this screenshot please' }] } }, ai('Screenshot review')]));
assert.equal(name('a7'), 'Screenshot review');

fs.rmSync(root, { recursive: true, force: true });
console.log('session title: 7 cases ok');
