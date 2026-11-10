// Checks the send-key patch: Enter steers, Ctrl+Enter queues on a Mac, and the
// send menu labels say so.
//
//   node launcher/steer-keys-check.mjs <patched ide-*.js>
//
// The three patched expressions are lifted out of the served bundle VERBATIM and
// evaluated, so a rename by the minifier or a rewrite upstream fails here.
import fs from 'node:fs'; import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8');
const one = (re, what) => { const m = [...src.matchAll(re)]; assert.equal(m.length, 1, what); return m[0]; };

// Which sends steer: the composer's own test, as patched.
const test = one(/const \w+=(\((\w+)\?\.steerIntoTurn===!0\|\|[^)]*\))&&/g, 'steer test');
const steers = (opts, hatch) => new Function(test[2], 'window', `return ${test[1]}`)(opts, { __cloudcliSteer: hatch });
assert.equal(steers(undefined), true, 'a plain send steers');
assert.equal(steers({ kitQueue: true }), false, 'Ctrl+Enter on a Mac queues');
assert.equal(steers({ presetBackgroundChoice: 'queue' }), false, 'Queue from the menu queues');
assert.equal(steers({ steerIntoTurn: true }), true, 'Steer from the menu steers');
assert.equal(steers(undefined, false), false, 'the escape hatch puts Enter back on the queue');

// Which key tags a send as a queue: Ctrl without Cmd, on a Mac only.
const tag = one(/(\w+)\(\w+,void 0,(\/Mac\|iPhone\|iPad\/\.test\(navigator\.platform\)&&(\w+)\.ctrlKey&&!\3\.metaKey\?\{kitQueue:!0\}:void 0)\)/g, 'key tag');
const tagFor = (platform, ev) => new Function('navigator', tag[3], `return ${tag[2]}`)({ platform }, ev);
assert.deepEqual(tagFor('MacIntel', { ctrlKey: true, metaKey: false }), { kitQueue: true });
assert.equal(tagFor('MacIntel', { ctrlKey: false, metaKey: true }), undefined, 'Cmd+Enter is a plain send');
assert.equal(tagFor('Linux x86_64', { ctrlKey: true, metaKey: false }), undefined, 'off a Mac, Ctrl is the send key');

// The menu's labels: the send key on Steer, Ctrl+Enter on Queue.
const q = one(/label:\w+\("sendMenu\.queue\.label",\{[^}]*\}\),description:\w+,trailing:(\((\w+)&&window\.__cloudcliSteer!==!1\?\((\w+)==="responding"&&(\w+)\?"⌃↵":null\):(\w+)\))\?/g, 'queue label');
const st = one(/description:\w+\("sendMenu\.steer\.description",\{[^}]*\}\),trailing:(\w+&&window\.__cloudcliSteer!==!1&&\w+)\?/g, 'steer label');
const labels = ({ can = true, state = 'responding', mac = true, key = '⌘↵', hatch } = {}) => {
  const args = [q[2], q[3], q[4], q[5], 'window'];
  const env = [can, state, mac, key, { __cloudcliSteer: hatch }];
  return [new Function(...args, `return ${q[1]}`)(...env), new Function(...args, `return ${st[1]}`)(...env) || null];
};
assert.deepEqual(labels(), ['⌃↵', '⌘↵'], 'Mac: Ctrl+Enter queues, Cmd+Enter steers');
assert.deepEqual(labels({ mac: false, key: 'Ctrl+↵' }), [null, 'Ctrl+↵'], 'elsewhere: the send key steers, Queue is menu-only');
assert.deepEqual(labels({ can: false }), ['⌘↵', null], 'a provider that cannot steer keeps upstream labels');
assert.deepEqual(labels({ hatch: false }), ['⌘↵', null], 'and so does the escape hatch');
console.log('steer keys: all checks passed');
