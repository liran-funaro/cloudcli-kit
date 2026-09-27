// Checks the guard that keeps the app from resuming a session a terminal has open.
//
//   node launcher/terminal-guard-check.mjs [patched claude-runtime.provider.js]
//
// Lifts kitTerminalHolder out of the patched module verbatim and runs it against
// a registry in a temp CLAUDE_CONFIG_DIR, with real processes standing in for
// the CLI -- one this process spawned (ours) and one reparented away from it
// (a terminal's) -- so what is under test is the code that shipped.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = process.env.CLOUDCLI_PKG
    ?? path.join(os.homedir(), '.npm-global/lib/node_modules/@cloudcli-ai/cloudcli');
const MOD = process.argv[2] ?? path.join(PKG,
    'dist-server/server/modules/providers/list/claude/claude-runtime.provider.js');
const src = fs.readFileSync(MOD, 'utf8');
const start = src.indexOf('async function kitTerminalHolder(');
const end = src.indexOf('\nasync function queryClaudeSDK(', start);
assert.ok(start >= 0 && end > start, `the terminal guard is not applied to ${MOD}`);
assert.ok(src.includes('const kitHolder = await kitTerminalHolder(providerSessionId);'),
    'the guard must run before the SDK is called');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-guard-'));
const mod = path.join(root, 'guard.mjs');
fs.writeFileSync(mod, "import path from 'path'; import os from 'os'; import { promises as fs } from 'fs';\n"
    + src.slice(start, end) + '\nexport { kitTerminalHolder };\n');
const { kitTerminalHolder } = await import(mod);

const reg = path.join(root, 'sessions');
fs.mkdirSync(reg);
process.env.CLAUDE_CONFIG_DIR = root;
const startOf = (pid) => {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[19]);
};
const register = (pid, sessionId, extra = {}) => fs.writeFileSync(path.join(reg, `${pid}.json`),
    JSON.stringify({ pid, sessionId, procStart: startOf(pid), entrypoint: 'cli', kind: 'interactive', ...extra }));
const clear = () => { for (const f of fs.readdirSync(reg)) fs.rmSync(path.join(reg, f)); };

// A terminal's CLI: not a descendant of this process. The shell backgrounds it
// and exits, so it is reparented away from us.
const foreign = Number(execFileSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).toString().trim());
// One of ours: a direct child, the way the server's own SDK runs are.
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
const cleanup = () => { try { process.kill(foreign); } catch {} child.kill(); fs.rmSync(root, { recursive: true, force: true }); };

try {
    // 1. a terminal holding this session is found, with what the refusal names.
    register(foreign, 'sess-a', { tmux: 'main:@0.%0' });
    const held = await kitTerminalHolder('sess-a');
    assert.equal(held?.pid, foreign, 'a live foreign process holding the session must be found');
    assert.equal(held.tmux, 'main:@0.%0', 'and the entry comes back whole, for the message');

    // 2. other sessions are not held by it.
    assert.equal(await kitTerminalHolder('sess-b'), null, 'a different session is free');
    assert.equal(await kitTerminalHolder(null), null, 'a brand-new session has nothing to check');

    // 3. our own runs never block us -- the server's SDK children register too.
    clear(); register(child.pid, 'sess-a', { entrypoint: 'sdk-ts' });
    assert.equal(await kitTerminalHolder('sess-a'), null, 'a process this server spawned is ours');

    // 4. a stale file: the process exited, or its pid now belongs to someone else.
    clear(); fs.writeFileSync(path.join(reg, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'sess-a' }));
    assert.equal(await kitTerminalHolder('sess-a'), null, 'an exited process holds nothing');
    clear(); register(foreign, 'sess-a', { procStart: 1 });
    assert.equal(await kitTerminalHolder('sess-a'), null, 'a reused pid holds nothing');

    // 5. junk in the registry is skipped, not thrown on.
    clear(); fs.writeFileSync(path.join(reg, 'x.json'), '{ not json'); register(foreign, 'sess-a');
    assert.equal((await kitTerminalHolder('sess-a'))?.pid, foreign, 'a corrupt neighbour does not hide a holder');

    // 6. the switch, and a registry that is not there.
    process.env.CLOUDCLI_TERMINAL_GUARD = '0';
    assert.equal(await kitTerminalHolder('sess-a'), null, 'CLOUDCLI_TERMINAL_GUARD=0 turns it off');
    delete process.env.CLOUDCLI_TERMINAL_GUARD;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'nowhere');
    assert.equal(await kitTerminalHolder('sess-a'), null, 'no registry, no holder');

    console.log('terminal guard: all checks passed');
} finally {
    cleanup();
}
