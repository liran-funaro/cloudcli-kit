// Checks which key the cost script picks, run by run.
//
//   node cost/key-check.mjs
//
// Drives `litellm-cost.sh --which-key` against a stub curl on PATH that
// refuses any key starting `old`, fails the transport for `flaky`, and counts
// the probes. Fake keys only; nothing leaves the machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-costkey-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const probes = path.join(root, 'probes');
fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
tok=$(sed -n 's/^header = "Authorization: Bearer \\(.*\\)"$/\\1/p')
echo probe >> ${probes}
case $tok in old*) printf 401 ;; flaky*) printf 000; exit 7 ;; *) printf 200 ;; esac
`, { mode: 0o755 });
const claude = path.join(root, 'claude');
fs.mkdirSync(claude);
const script = path.join(import.meta.dirname, 'litellm-cost.sh');

const pick = ({ settings, env }) => {
  if (settings === undefined) fs.rmSync(path.join(claude, 'settings.json'), { force: true });
  else fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: settings } }));
  fs.rmSync(probes, { force: true });
  const r = spawnSync('/bin/bash', [script, '--which-key'], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, CLAUDE_CONFIG_DIR: claude,
      ANTHROPIC_BASE_URL: 'http://proxy.invalid', ...(env ? { ANTHROPIC_AUTH_TOKEN: env } : {}) },
  });
  assert.equal(r.status, 0, r.stderr);
  const count = fs.existsSync(probes) ? fs.readFileSync(probes, 'utf8').split('\n').filter(Boolean).length : 0;
  return { source: r.stdout.trim(), note: r.stderr.trim(), probes: count };
};

let r = pick({ settings: 'new-key', env: 'old-key' });
assert.equal(r.source, 'Claude settings', 'a rotated key in the settings is used first');
assert.equal(r.probes, 1);

r = pick({ settings: 'old-key', env: 'new-key' });
assert.equal(r.source, 'environment', 'a refused settings key falls back to the environment');
assert.match(r.note, /refused the one from Claude settings/);
assert.doesNotMatch(r.note, /old-key|new-key/, 'no key value is ever logged');

r = pick({ settings: 'old-a', env: 'old-b' });
assert.equal(r.source, 'Claude settings (refused)', 'none accepted: the first is used, so the report says why');

r = pick({ settings: 'same-key', env: 'same-key' });
assert.equal(r.probes, 1, 'the same key in two places is probed once');

r = pick({ settings: 'flaky-key', env: 'new-key' });
assert.equal(r.source, 'Claude settings', 'a transport failure is not a refusal');

r = pick({ env: 'new-key' });
assert.equal(r.source, 'environment', 'no settings file: the environment alone still works');
console.log('cost key: all checks passed');
