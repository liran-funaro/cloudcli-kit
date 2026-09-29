// Checks that the token counter follows a compaction, live and on reload.
//
//   node launcher/compaction-counter-check.mjs [package dir]
//
// Live: lifts extractTokenBudget and buildTokenBudget out of the patched runtime
// verbatim. Reload: imports the patched token-usage service itself. Then feeds
// both the event shapes the SDK stream and the transcript actually use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = process.argv[2] ?? path.join(os.homedir(), '.npm-global/lib/node_modules/@cloudcli-ai/cloudcli');
const SRV = path.join(PKG, 'dist-server/server/modules/providers');
process.env.CONTEXT_WINDOW = '1000000';

// -- live -----------------------------------------------------------------------
const rt = fs.readFileSync(path.join(SRV, 'list/claude/claude-runtime.provider.js'), 'utf8');
const lift = (name) => {
    const at = rt.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} not found`);
    let depth = 0;
    for (let i = rt.indexOf('{', at); i < rt.length; i += 1) {
        if (rt[i] === '{') depth += 1;
        else if (rt[i] === '}' && --depth === 0) return rt.slice(at, i + 1);
    }
    throw new Error(`${name} does not close`);
};
assert.ok(rt.includes("message.type === 'assistant' || message.subtype === 'compact_boundary'"),
    'a compaction reading must also stand in for the turn\'s, or /compact falls back to the bill');
const live = new Function(`${lift('readNumber')}\n${lift('buildTokenBudget')}\n${lift('extractTokenBudget')}\n`
    + 'return extractTokenBudget;')();

const boundary = live({ type: 'system', subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 955986, post_tokens: 16735 } });
assert.equal(boundary?.used, 16735, 'the boundary publishes the size the compaction left');
assert.equal(boundary.total, 1000000, 'against the configured window');
assert.equal(live({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5 } }), null,
    'a boundary without post_tokens publishes nothing, rather than zero');
assert.equal(live({ type: 'system', subtype: 'compact_boundary', parent_tool_use_id: 'x',
    compact_metadata: { post_tokens: 9 } }), null, 'a subagent\'s compaction is not this session\'s');
assert.equal(live({ type: 'system', subtype: 'status', compact_metadata: { post_tokens: 9 } }), null,
    'only the boundary, not the "compacting" status');
// the ordinary reading is untouched
const call = live({ type: 'assistant', message: { usage: { input_tokens: 3, cache_creation_input_tokens: 100,
    cache_read_input_tokens: 40000, output_tokens: 50 } } });
assert.equal(call?.used, 40153, 'a complete per-call frame reads as before');

// -- reload ---------------------------------------------------------------------
const { summarizeClaudeTokenUsage } = await import(path.join(SRV, 'services/provider-token-usage.service.js'));
const usage = (n) => ({ type: 'assistant', message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0,
    cache_read_input_tokens: n - 1, output_tokens: 0 } } });
const cut = (post) => ({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 955986, postTokens: post } });

assert.equal(summarizeClaudeTokenUsage([usage(955000), cut(16735)]).used, 16735,
    'a boundary after the last call is the reading');
assert.equal(summarizeClaudeTokenUsage([usage(955000), cut(16735), usage(21000)]).used, 21000,
    'a call after the boundary is newer still');
assert.equal(summarizeClaudeTokenUsage([usage(955000), { type: 'system', subtype: 'compact_boundary',
    compactMetadata: { preTokens: 1 } }]).used, 955000, 'a boundary without postTokens is walked past');
assert.equal(summarizeClaudeTokenUsage([usage(400000), usage(955000)]).used, 955000,
    'no compaction, nothing changes');

console.log('compaction counter: all checks passed');
