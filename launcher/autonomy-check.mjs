// Does the autonomy loop nudge exactly the sessions it should?
//
//   node launcher/autonomy-check.mjs [patched dispatcher .js]
//
// Lifts the PATCHED dispatcher out of the installed bundle, stubs the database
// and websocket modules it imports, and drives kitAutonomyPass over real state
// files and real transcripts written for the occasion.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = process.env.CLOUDCLI_PKG
    ?? path.join(os.homedir(), '.npm-global/lib/node_modules/@cloudcli-ai/cloudcli');
const MOD = process.argv[2] ?? path.join(PKG,
    'dist-server/server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js');
const src = fs.readFileSync(MOD, 'utf8');
assert.ok(src.includes('kitAutonomyPass'), `the autonomy patch is not applied to ${MOD}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-autonomy-'));
const state = path.join(root, 'kit-autonomy.json');
const cost = path.join(root, 'cost.json');
process.env.CLOUDCLI_AUTONOMY_FILE = state;
process.env.CLOUDCLI_COST_JSON = cost;
fs.writeFileSync(cost, JSON.stringify({ cycle: { spend: '100.00' } }));

// Transcripts: what the agent last said is the whole of the state we read.
function transcript(name, text) {
    const file = path.join(root, `${name}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({
        type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
    })}\n`);
    return file;
}
const working = transcript('working', 'Pushed the branch, continuing with the tests.');
const finished = transcript('finished', 'Everything is green and pushed.\n\nKIT-DONE');
const stuck = transcript('stuck', 'The deploy needs a credential I do not have.\n\nKIT-BLOCKED');

// Stubs. The registry says who is running; the detached turn records the nudges.
const processing = new Set();
const sent = [];
const sessions = {
    's-work': { session_id: 's-work', jsonl_path: working },
    's-done': { session_id: 's-done', jsonl_path: finished },
    's-stuck': { session_id: 's-stuck', jsonl_path: stuck },
    's-busy': { session_id: 's-busy', jsonl_path: working },
    's-rich': { session_id: 's-rich', jsonl_path: working },
};
const dbStub = path.join(root, 'db.mjs');
fs.writeFileSync(dbStub, `
export const scheduledMessagesDb = {};
export const sessionDraftsDb = { listQueuedMessages: () => [] };
export const sessionsDb = { getSessionById: (id) => globalThis.__kitSessions[id] ?? null };
export const userPreferencesDb = { getPreferences: () => globalThis.__kitPrefs };
`);
const wsStub = path.join(root, 'ws.mjs');
fs.writeFileSync(wsStub, `
export const chatRunRegistry = { isProcessing: (id) => globalThis.__kitProcessing.has(id) };
export async function runDetachedChatTurn(input) {
  globalThis.__kitSent.push(input);
  return { started: true };
}
`);
globalThis.__kitPrefs = {
    claudePermissions: { allowedTools: ['Bash(ssh build-host:*)'], disallowedTools: [], skipPermissions: false },
};
globalThis.__kitSessions = sessions;
globalThis.__kitProcessing = processing;
globalThis.__kitSent = sent;

const loadable = path.join(root, 'dispatcher.mjs');
fs.writeFileSync(loadable, src
    .replace("'../../../modules/database/index.js'", JSON.stringify(dbStub))
    .replace("'../../../modules/websocket/index.js'", JSON.stringify(wsStub)));
const { kitAutonomyPass, kitAutNudge } = await import(loadable);

// The dialog shows the turn before it is sent, and it must be THE turn: the
// prompt route hands out kitAutNudge's own output, so that has to be exported
// and has to name the time it is given.
assert.equal(typeof kitAutNudge, 'function', 'the prompt route needs kitAutNudge exported');
const preview = kitAutNudge({ until: '2026-09-29T07:00:00Z' });
assert.ok(preview.includes('Autonomous mode'), 'the preview is the real nudge');
assert.ok(/2026/.test(preview), 'and names the return time the picker chose');

const armed = (extra = {}) => ({ state: 'running', since: '2026-09-20T00:00:00Z', nudges: 0,
    userId: 1, ...extra });
const write = (store) => fs.writeFileSync(state, JSON.stringify(store, null, 2));
const read = () => JSON.parse(fs.readFileSync(state, 'utf8'));

// 1. an armed, idle session with work left is nudged; a busy one is left alone;
//    the sentinels disarm rather than nudge; a spent-out session stops.
processing.add('s-busy');
write({
    's-work': armed({ until: '2026-09-29T07:00:00Z', options: { permissionMode: 'auto' } }),
    's-busy': armed(),
    's-done': armed(),
    's-stuck': armed(),
    's-rich': armed({ costLimit: 10, spendAtArm: 80 }),   // 100 - 80 >= 10
    's-gone': armed(),                                    // no such session
    's-off': { state: 'stopped' },                        // already disarmed
});
let nudged = await kitAutonomyPass({});
assert.equal(nudged, 1, 'exactly one session had work to continue');
assert.deepEqual(sent.map((s) => s.sessionId), ['s-work'], 'and it was the right one');
let store = read();
assert.equal(store['s-work'].nudges, 1);
assert.equal(store['s-done'].state, 'done', 'KIT-DONE disarms');
assert.equal(store['s-stuck'].state, 'blocked', 'KIT-BLOCKED disarms');
assert.equal(store['s-rich'].state, 'over budget', 'the ceiling disarms');
assert.equal(store['s-gone'].state, 'gone', 'a session that no longer exists disarms');
assert.equal(store['s-busy'].state, 'running', 'a running session is untouched');
assert.equal(store['s-busy'].nudges, 0, 'and is not nudged');

// 2. the nudge itself: the agent has to learn the terms it is working under.
const nudge = sent[0].content;
for (const needed of ['Autonomous mode', 'will not answer questions', 'reporting-to-slack',
    'KIT-DONE', 'KIT-BLOCKED', 'cut off mid-tool-call']) {
    assert.ok(nudge.includes(needed), `the nudge must say ${needed}`);
}
// Slack is for information, not for turns: being nudged is not news.
assert.match(nudge, /not for turns|must not be reported/i,
    'the nudge must rule out per-turn Slack reports');
assert.ok(nudge.includes('2026'), 'the nudge must name the time the user is back');

// 2b. the options the turn runs with. A nudge with no permission mode runs as
//     'default' with an empty allow-list, which denies every gated tool call
//     after 55s of waiting for a user who is away -- so both halves travel:
//     the mode stored at arming, the allow-list read fresh from preferences.
assert.equal(sent[0].options.permissionMode, 'auto',
    'the turn must run in the mode the session was armed with');
assert.deepEqual(sent[0].options.toolsSettings, globalThis.__kitPrefs.claudePermissions,
    'and with the allow-list the composer would have sent');

// 3. the minimum gap: a second pass straight afterwards must not nudge again.
sent.length = 0;
nudged = await kitAutonomyPass({});
assert.equal(nudged, 0, 'the gap must hold off a second nudge');
assert.deepEqual(sent, []);

// 4. once the gap has passed, it continues.
store = read();
store['s-work'].last = new Date(Date.now() - 10 * 60_000).toISOString();
write(store);
nudged = await kitAutonomyPass({});
assert.equal(nudged, 1, 'after the gap, the loop carries on');
assert.equal(read()['s-work'].nudges, 2);

// 5. a session's own nudge text is used verbatim when it has one.
sent.length = 0;
write({ 's-work': armed({ nudge: 'carry on with the migration' }) });
await kitAutonomyPass({});
assert.equal(sent[0].content, 'carry on with the migration');

// 6. the kit's own reporting is a heartbeat, not a commentary: the first pass only
//    starts the clock, and nothing else goes out until a day has passed.
const posts = [];
write({ 's-work': armed({ until: '2026-09-29T07:00:00Z', spendAtArm: 90 }) });
await kitAutonomyPass({});
store = read();
assert.ok(store['s-work'].reported, 'arming starts the daily clock');
const firstReport = store['s-work'].reported;
store['s-work'].last = new Date(Date.now() - 10 * 60_000).toISOString();
write(store);
await kitAutonomyPass({});
assert.equal(read()['s-work'].reported, firstReport,
    'a second turn within the day must not report again');
// A day old: the report goes out, and carries both numbers as facts.
store = read();
store['s-work'].reported = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
store['s-work'].last = new Date(Date.now() - 10 * 60_000).toISOString();
write(store);
await kitAutonomyPass({});
store = read();
assert.notEqual(store['s-work'].reported, firstReport, 'after a day, one report goes out');
assert.equal(store['s-work'].spendSince, 10, 'and states the spend since arming (100 - 90)');

// 7. nothing armed, and a corrupt file, are both quiet no-ops rather than throws.
fs.writeFileSync(state, '{ this is not json');
assert.equal(await kitAutonomyPass({}), 0, 'a corrupt state file must not throw');
fs.writeFileSync(state, '{}');
assert.equal(await kitAutonomyPass({}), 0, 'nothing armed is nothing to do');

console.log('autonomy: all checks passed');
fs.rmSync(root, { recursive: true, force: true });
