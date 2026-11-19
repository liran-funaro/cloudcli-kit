// Checks the tunnel loop's backoff, and that a returning network resets it.
//
//   node client/devproxyd-check.mjs
//
// Runs client/devproxyd-run against stub `ssh`, `lsof` and `dscacheutil` on
// PATH, with one-second delays, and reads what it logs. Needs no Mac and no
// network: the stub ssh fails every connection at once.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-devproxyd-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const bin = path.join(root, 'bin');
const down = path.join(root, 'net-down');
fs.mkdirSync(bin);
const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
stub('ssh', '[ "$1" = -G ] && { echo "hostname devbox.example.com"; exit 0; }\nexit 255');
stub('lsof', 'exit 1');
stub('dscacheutil', `[ -e ${down} ] || echo "ip_address: 10.0.0.1"`);
const logs = path.join(root, 'logs');
fs.mkdirSync(logs);
fs.writeFileSync(path.join(logs, 'stderr.log'), 'x'.repeat(1048577));

const run = spawn('/bin/sh', [path.join(import.meta.dirname, 'devproxyd-run')], {
  env: { PATH: `${bin}:/usr/bin:/bin`, DEVPROXYD_INITIAL_DELAY: '1', DEVPROXYD_MAX_DELAY: '4',
    DEVPROXYD_STABLE_AFTER: '300', DEVPROXYD_LOG_DIR: logs },
});
let out = '';
run.stdout.on('data', (d) => { out += d; });
const waits = () => [...out.matchAll(/next attempt in (\d+)s/g)].map((m) => Number(m[1]));
const until = async (test, what, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    if (test()) return;
  }
  assert.fail(`timed out waiting for ${what}; log so far:\n${out}`);
};

await until(() => waits().length >= 4, 'four failed attempts');
assert.deepEqual(waits().slice(0, 4), [1, 2, 4, 4], 'doubles, capped at the maximum');
assert.equal(fs.statSync(path.join(logs, 'stderr.log')).size, 0, 'a log past 1 MB is trimmed');

fs.writeFileSync(down, '');
await until(() => out.includes('network is not ready'), 'the outage');
const before = waits().length;
fs.rmSync(down);
await until(() => waits().length > before, 'the first attempt after the network returns');
assert.equal(waits()[before], 1, 'a returning network resets the backoff');

const exited = new Promise((r) => run.on('exit', (code) => r(code)));
run.kill('SIGTERM');
assert.equal(await exited, 0, 'TERM stops it cleanly');
console.log('devproxyd: all checks passed');
