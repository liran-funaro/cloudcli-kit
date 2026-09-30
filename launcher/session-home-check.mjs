// Checks that a session runs in its own directory, whatever the browser sends.
//
//   node launcher/session-home-check.mjs [package dir]
//
// Two halves. The browser: the worktree picker's cwd rides only a send with no
// session selected. The server: mapCliOptionsToSDK, lifted verbatim from the
// patched runtime and run against a fake sessions table, puts a resumed session
// back in the directory its row records.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = process.argv[2] ?? path.join(os.homedir(), '.npm-global/lib/node_modules/@cloudcli-ai/cloudcli');

// -- browser ---------------------------------------------------------------------
const assets = path.join(PKG, 'dist/assets');
const bundle = fs.readdirSync(assets).filter((f) => /^ide-.*\.js$/.test(f))
    .map((f) => path.join(assets, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const js = fs.readFileSync(bundle, 'utf8');
const send = js.match(/cwd:!(\w+)&&window\.__kitWtCwd[^,]*,skipPermissions:[^,]*,sessionSummary:\w+\((\w+),\w+\)/);
assert.ok(send, 'the picker cwd must be gated on there being no session');
assert.equal(send[1], send[2], 'gated on the selected session -- the same one sessionSummary is built from');
const hook = js.slice(0, send.index).match(/function \w+\(\{selectedProject:\w+,selectedSession:(\w+),[^}]*\}\)\{(?![\s\S]*function \w+\(\{selectedProject:)/);
assert.equal(hook?.[1], send[1], 'and that variable is the hook\'s selectedSession');

// -- server ----------------------------------------------------------------------
const rt = fs.readFileSync(path.join(PKG, 'dist-server/server/modules/providers/list/claude/claude-runtime.provider.js'), 'utf8');
const at = rt.indexOf('function mapCliOptionsToSDK(');
let depth = 0, end = -1;
// From the body's brace: the parameter list has one of its own, `options = {}`.
for (let i = rt.indexOf(') {', at) + 2; i < rt.length; i += 1) {
    if (rt[i] === '{') depth += 1;
    else if (rt[i] === '}' && --depth === 0) { end = i + 1; break; }
}
assert.ok(at >= 0 && end > at && rt.slice(at, end).includes('KIT: a resumed session runs in its own directory'),
    'the resumed-session cwd patch is not applied');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-home-'));
const home = path.join(root, 'repo.wt-a');
const other = path.join(root, 'repo.wt-b');
fs.mkdirSync(home); fs.mkdirSync(other);
const rows = { 'sess-a': { project_path: home }, 'sess-gone': { project_path: path.join(root, 'removed.wt') } };
const overrides = {
    sessionsDb: { getSessionByProviderSessionId: (id) => rows[id] ?? null },
    console: { ...console, warn: () => {} },
};
// Anything else the mapper touches is stubbed out: only cwd is under test.
const scope = new Proxy({}, {
    has: () => true,
    get: (_t, name) => (name in overrides ? overrides[name]
        : name in globalThis ? globalThis[name]
        : name === Symbol.unscopables ? undefined : () => undefined),
});
const map = new Function('scope', `with (scope) { return (${rt.slice(at, end)}); }`)(scope);

assert.equal(map({ providerSessionId: 'sess-a', cwd: other }).cwd, home,
    'a resumed session runs at home, not where the browser said');
assert.equal(map({ providerSessionId: 'sess-a', cwd: home }).cwd, home, 'agreeing is fine');
assert.equal(map({ providerSessionId: 'sess-a' }).cwd, home, 'and no cwd sent still means home');
assert.equal(map({ cwd: other }).cwd, other, 'a new session goes where it was sent -- that is the picker\'s job');
assert.equal(map({ providerSessionId: 'sess-a', cwd: other, resumeFromScratch: true }).cwd, other,
    'nothing resumed, nothing to hold to');
assert.equal(map({ providerSessionId: 'sess-unknown', cwd: other }).cwd, other, 'no row, the caller decides');
assert.equal(map({ providerSessionId: 'sess-gone', cwd: other }).cwd, other,
    'a home that was removed is not forced on the turn');

fs.rmSync(root, { recursive: true, force: true });
console.log('session home: all checks passed');
