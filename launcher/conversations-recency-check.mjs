// Checks the Conversations tab's recency order the launcher patches into the bundle.
//
//   node launcher/conversations-recency-check.mjs <patched ide-*.js>
//
// The tab is fetched once; the live projects list is what session_upserted keeps
// current. The patched memo is lifted out of the bundle VERBATIM and run with a
// stand-in useMemo, so what is under test is the code that shipped.
import fs from 'node:fs'; import assert from 'node:assert/strict';
const src = fs.readFileSync(process.argv[2], 'utf8');
const m = src.match(/(\w+)=f\.useMemo\(\(\)=>\{if\((\w+)\.length===0\)return \2;const \w+=new Map;for\(const \w+ of (\w+)\)for\(const[\s\S]*?return _kitByRecency\},\[\3,\2\]\)/);
assert.ok(m, 'patched memo not found in the bundle');
const run = (projects, rows) => new Function(m[3], m[2], 'f', `let ${m[1]};${m[0]};return ${m[1]};`)(
  projects, rows, { useMemo: (fn) => fn() });

const row = (id, at, title = id) => ({ sessionId: id, provider: 'claude', projectId: 'P', projectDisplayName: 'repo', sessionTitle: title, lastActivity: at });
const feed = [row('a', '2026-10-21T10:00:00Z'), row('b', '2026-10-21T09:00:00Z'), row('c', '2026-10-21T08:00:00Z')];
const live = (sessions) => [{ projectId: 'P', displayName: 'repo', sessions }];

// 1. nothing changed: the very same array, so the list does not re-render
const same = live([{ id: 'a', lastActivity: '2026-10-21T10:00:00Z' }, { id: 'b', lastActivity: '2026-10-21T09:00:00Z' }]);
assert.equal(run(same, feed), feed);

// 2. c got a message: it moves to the top, the rest keep their order
let out = run(live([{ id: 'c', lastActivity: '2026-10-21T11:00:00Z' }]), feed);
assert.deepEqual(out.map((r) => r.sessionId), ['c', 'a', 'b']);
assert.equal(out[0].lastActivity, '2026-10-21T11:00:00Z');

// 3. a new session appears at the top, named after its own checkout
out = run(live([{ id: 'n', summary: 'New work', worktree: '.wt-1', lastActivity: '2026-10-21T12:00:00Z' }]), feed);
assert.deepEqual(out.map((r) => r.sessionId), ['n', 'a', 'b', 'c']);
assert.equal(out[0].sessionTitle, 'New work'); assert.equal(out[0].projectDisplayName, 'repo.wt-1'); assert.equal(out[0].projectId, 'P');

// 4. an old session the projects list carries is not added (no flood of history)
out = run(live([{ id: 'old', lastActivity: '2026-01-01T00:00:00Z' }]), feed);
assert.equal(out, feed);

// 5. renames still fold in, as upstream did
out = run(live([{ id: 'b', summary: 'Renamed', lastActivity: '2026-10-21T09:00:00Z' }]), feed);
assert.equal(out.find((r) => r.sessionId === 'b').sessionTitle, 'Renamed');

// 6. an empty feed stays empty (the tab has not loaded)
assert.deepEqual(run(live([{ id: 'n', lastActivity: '2026-10-21T12:00:00Z' }]), []), []);
console.log('conversations by recency: 6 cases ok');
