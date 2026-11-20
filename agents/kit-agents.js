// KIT: the agent map behind the composer's agents pill (see agents/ide-agents.js).
//
// Installed by cloudcli-start as dist-server/server/kit-agents.js and mounted at
// /api/kit/agents behind the app's own authenticateToken:
//
//   GET /:sessionId                         agents and background jobs
//   GET /:sessionId/tasks/:taskId/output    a job's output (tail; ?full=1 for all)
//   GET /:sessionId/agents/:agentId         what one agent did
//
// Everything is read from what Claude Code writes to disk: the session's
// transcript, and <transcript dir>/<session>/subagents/agent-<id>.jsonl with
// its .meta.json. Transcripts only grow, so each file is read incrementally:
// a poll costs the bytes appended since the last one, not a re-parse of a
// transcript that can run to tens of megabytes.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const MAX_ACTIVITY = 500;
const TAIL_BYTES = 64 * 1024;
const FULL_BYTES = 4 * 1024 * 1024;
const MAX_READERS = 64;
const CHUNK = 8 * 1024 * 1024;

const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ms = (ts) => (ts ? Date.parse(ts) || null : null);

/** What a tool call was about, in one line: the command, the file, the pattern. */
export function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.description && name === 'Bash' ? input.command
    : input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url
      ?? input.description ?? input.prompt ?? input.query ?? Object.values(input).find((v) => typeof v === 'string');
  return clip(pick);
}

const contextOf = (usage) => {
  if (!usage || typeof usage !== 'object') return null;
  const n = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return n > 0 ? n : null;
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).join('\n');
};

const NOTE_TAG = (body, tag) => body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
const OUTPUT_AT = /Output is being written to:\s*(\S+)/;
const TYPE_OF = { Bash: 'shell', Monitor: 'monitor', Agent: 'agent', Task: 'agent', Workflow: 'workflow' };

/** The state one transcript has built up, fed one parsed line at a time. */
function newState() {
  return {
    model: null, contextTokens: null, firstTs: null, lastTs: null,
    toolIds: new Set(),
    // Only a name and a line per call: a Write's input is the whole file it wrote.
    tools: new Map(),      // toolUseId -> { name, label, ts }
    agentCalls: new Map(), // toolUseId -> { description, subagentType, background, startedAt, endedAt, failed, result }
    tasks: new Map(),      // taskId -> { ... }
    activity: [], activityCount: 0,
    lastText: null,        // an agent's answer, when its parent only got a launch acknowledgement
  };
}

function noteActivity(state, entry) {
  state.activityCount += 1;
  if (state.activity.length < MAX_ACTIVITY) state.activity.push(entry);
}

function applyNotification(state, body, ts) {
  const taskId = NOTE_TAG(body, 'task-id');
  if (!taskId) return;
  const status = NOTE_TAG(body, 'status');
  const toolUseId = NOTE_TAG(body, 'tool-use-id');
  const outputFile = NOTE_TAG(body, 'output-file');
  const summary = NOTE_TAG(body, 'summary');
  let task = state.tasks.get(taskId);
  if (!task && toolUseId) {
    const tool = state.tools.get(toolUseId);
    task = {
      taskId, toolUseId, type: TYPE_OF[tool?.name] ?? 'task',
      name: tool ? tool.label : clip(summary),
      startedAt: ms(tool?.ts) ?? ms(ts), endedAt: null, status: null, outputFile: null, summary: null,
    };
    state.tasks.set(taskId, task);
  }
  if (!task) return;
  if (outputFile) task.outputFile = outputFile;
  if (summary) task.summary = clip(summary, 300);
  if (status) {
    task.status = status === 'killed' ? 'stopped' : status;
    task.endedAt = ms(ts);
    const call = state.agentCalls.get(task.toolUseId);
    if (call && !call.endedAt) { call.endedAt = task.endedAt; call.failed = status === 'failed'; }
  }
}

/** Folds one transcript line into the state. Exported for the check. */
export function applyLine(state, entry) {
  if (!entry || typeof entry !== 'object') return;
  const ts = entry.timestamp;
  if (ts) { state.firstTs ??= ts; state.lastTs = ts; }
  const raw = JSON.stringify(entry.content ?? '');
  if (entry.type === 'queue-operation' && raw.includes('<task-notification>')) {
    applyNotification(state, typeof entry.content === 'string' ? entry.content : raw, ts);
    return;
  }
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return;
  if (entry.type === 'assistant') {
    if (msg.model && msg.model !== '<synthetic>') {
      state.model = msg.model;
      state.contextTokens = contextOf(msg.usage) ?? state.contextTokens;
    }
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === 'tool_use') {
        state.toolIds.add(block.id);
        const summary = summarizeInput(block.name, block.input);
        state.tools.set(block.id, { name: block.name, label: clip(block.input?.description) || summary, ts });
        noteActivity(state, { kind: 'tool', id: block.id, name: block.name, summary, ts });
        if (TYPE_OF[block.name] === 'agent') {
          state.agentCalls.set(block.id, {
            description: block.input?.description, subagentType: block.input?.subagent_type,
            // An agent runs in the background unless the call says otherwise (the
            // runtime's startsBackgroundWork reads it the same way); its tool result
            // is then only the launch acknowledgement, and its end is a notification.
            background: block.input?.run_in_background !== false, startedAt: ms(ts), endedAt: null, failed: false, result: null,
          });
        }
      } else if (block?.type === 'text' && block.text?.trim()) {
        noteActivity(state, { kind: 'text', text: clip(block.text, 600), ts });
        state.lastText = clip(block.text, 4000);
      }
    }
    return;
  }
  if (entry.type !== 'user') return;
  const content = msg.content;
  const body = textOf(content);
  if (body.includes('<task-notification>')) applyNotification(state, body, ts);
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    const resultText = textOf(block.content);
    const done = state.activity.find((a) => a.kind === 'tool' && a.id === id);
    if (done && block.is_error) done.error = true;
    const bgId = entry.toolUseResult?.backgroundTaskId;
    const tool = state.tools.get(id);
    if (bgId && tool) {
      const task = state.tasks.get(bgId) ?? {
        taskId: bgId, toolUseId: id, type: TYPE_OF[tool.name] ?? 'task',
        name: tool.label,
        startedAt: ms(tool.ts), endedAt: null, status: null, outputFile: null, summary: null,
      };
      task.outputFile ??= resultText.match(OUTPUT_AT)?.[1] ?? null;
      state.tasks.set(bgId, task);
    }
    const call = state.agentCalls.get(id);
    if (call && !call.background && !call.endedAt) {
      call.endedAt = ms(ts);
      call.failed = Boolean(block.is_error);
      call.result = clip(resultText, 4000);
    } else if (call && !call.result && !call.background) {
      call.result = clip(resultText, 4000);
    }
  }
}

/** Reads a transcript from where it left off, so each poll costs only what was appended. */
class Reader {
  constructor(file) { this.file = file; this.reset(); }
  reset() { this.offset = 0; this.carry = ''; this.state = newState(); }
  read() {
    let st;
    try { st = fs.statSync(this.file); } catch { return this.state; }
    if (st.size < this.offset) this.reset();
    if (st.size === this.offset) return this.state;
    // In chunks, so a first read of a 250 MB transcript never holds it whole.
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - this.offset));
      while (this.offset < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        const lines = (this.carry + buf.toString('utf8', 0, n)).split('\n');
        this.carry = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { applyLine(this.state, JSON.parse(line)); } catch { /* a half-written line */ }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return this.state;
  }
}

const readers = new Map();
function stateOf(file) {
  let r = readers.get(file);
  if (!r) {
    if (readers.size >= MAX_READERS) readers.delete(readers.keys().next().value);
    r = new Reader(file);
    readers.set(file, r);
  }
  return r.read();
}

const readMeta = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

/**
 * The agents and background jobs of one session, from its files.
 *
 * `live` is what the runtime knows: whether the session's run is up, and the
 * background tasks its tracker still holds (by task id and by launching call).
 * Background work counts as running only while the tracker holds it. A task
 * whose end never reached the transcript (the CLI was restarted under it, as
 * in claudecodeui#1656) is otherwise `running` forever while the session lives.
 * Foreground agents run inside the turn, so they run while the run is up.
 */
const NOT_LIVE = { running: false, taskIds: new Set(), toolUseIds: new Set() };
export function readAgentMap({ transcript, subagentDir }, live = NOT_LIVE, now = Date.now()) {
  live = { ...NOT_LIVE, ...live };
  const main = stateOf(transcript);
  const agents = [];
  const owners = new Map(); // toolUseId -> agent id that made the call ('main' for the session)
  for (const id of main.toolIds) owners.set(id, 'main');
  let files = [];
  try { files = fs.readdirSync(subagentDir).filter((f) => /^agent-.+\.jsonl$/.test(f)); } catch { /* no agents */ }
  const subs = files.map((f) => {
    const id = f.slice('agent-'.length, -'.jsonl'.length);
    const state = stateOf(path.join(subagentDir, f));
    for (const t of state.toolIds) owners.set(t, id);
    return { id, state, meta: readMeta(path.join(subagentDir, `agent-${id}.meta.json`)) };
  });
  const callOf = (toolUseId) => {
    for (const s of [main, ...subs.map((x) => x.state)]) if (s.agentCalls.has(toolUseId)) return s.agentCalls.get(toolUseId);
    return null;
  };
  for (const { id, state, meta } of subs) {
    const call = callOf(meta.toolUseId) ?? {};
    const endedAt = call.endedAt ?? null;
    const held = call.background ? live.toolUseIds.has(meta.toolUseId) : live.running;
    const status = call.failed ? 'failed'
      : meta.finished || endedAt ? 'completed'
        : held ? 'running' : 'stopped';
    agents.push({
      id,
      parentId: owners.get(meta.toolUseId) ?? 'main',
      name: meta.description || call.description || meta.agentType || id,
      type: meta.agentType || call.subagentType || 'agent',
      model: state.model || meta.model || null,
      contextTokens: state.contextTokens,
      status,
      background: Boolean(call.background),
      stoppable: status === 'running' && live.toolUseIds.has(meta.toolUseId),
      startedAt: call.startedAt ?? ms(state.firstTs),
      endedAt: endedAt ?? (status === 'running' ? null : ms(state.lastTs)),
      toolCalls: state.toolIds.size,
    });
  }
  const tasks = [];
  for (const s of [main, ...subs.map((x) => x.state)]) {
    for (const t of s.tasks.values()) {
      if (t.type === 'agent') continue; // drawn as an agent
      const status = t.status ?? (live.taskIds.has(t.taskId) ? 'running' : 'stopped');
      tasks.push({
        id: t.taskId, name: t.name, type: t.type, status, summary: t.summary,
        startedAt: t.startedAt, endedAt: t.endedAt ?? (status === 'running' ? null : t.startedAt),
        hasOutput: Boolean(t.outputFile),
        stoppable: status === 'running',
      });
    }
  }
  return {
    now,
    main: { model: main.model, contextTokens: main.contextTokens, running: live.running },
    agents: agents.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
    tasks: tasks.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
  };
}

/** A job's output: the tail by default, the whole file (capped) on request. */
export function readTaskOutput({ transcript, subagentDir }, taskId, full) {
  const states = [stateOf(transcript)];
  try {
    for (const f of fs.readdirSync(subagentDir)) if (/^agent-.+\.jsonl$/.test(f)) states.push(stateOf(path.join(subagentDir, f)));
  } catch { /* none */ }
  const task = states.map((s) => s.tasks.get(taskId)).find(Boolean);
  // Only a file the transcript itself named for this task is ever read.
  if (!task?.outputFile) return null;
  let st;
  try { st = fs.statSync(task.outputFile); } catch { return { text: '', size: 0, truncated: false, missing: true }; }
  if (!st.isFile()) return null;
  const want = full ? FULL_BYTES : TAIL_BYTES;
  const start = Math.max(0, st.size - want);
  const fd = fs.openSync(task.outputFile, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), size: st.size, truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** One agent's recorded timeline, and its answer when the parent has it. */
export function readAgentActivity({ transcript, subagentDir }, agentId) {
  if (!/^[\w-]+$/.test(agentId)) return null;
  const file = path.join(subagentDir, `agent-${agentId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const state = stateOf(file);
  const meta = readMeta(path.join(subagentDir, `agent-${agentId}.meta.json`));
  let result = null;
  for (const f of [transcript, ...fs.readdirSync(subagentDir).filter((x) => /^agent-.+\.jsonl$/.test(x)).map((x) => path.join(subagentDir, x))]) {
    const call = stateOf(f).agentCalls.get(meta.toolUseId);
    if (call?.result) { result = call.result; break; }
  }
  return { activity: state.activity, activityCount: state.activityCount, result: result ?? state.lastText };
}

/** The routes, given how to find a session's files, what its live run knows, and how to stop a task. */
export function createKitAgentsRoutes({ locate, liveOf, stopTask }) {
  const router = express.Router();
  const withSession = (handler) => (req, res) => {
    try {
      const where = locate(req.params.sessionId);
      if (!where) return res.status(404).json({ error: 'no transcript for this session' });
      return handler(req, res, where);
    } catch (error) {
      return res.status(500).json({ error: error?.message || String(error) });
    }
  };
  router.get('/:sessionId', withSession((req, res, where) => res.json(readAgentMap(where, liveOf(req.params.sessionId, where)))));
  router.get('/:sessionId/tasks/:taskId/output', withSession((req, res, where) => {
    const out = readTaskOutput(where, req.params.taskId, req.query.full === '1');
    return out ? res.json(out) : res.status(404).json({ error: 'no output recorded for this task' });
  }));
  // Stops go through the runtime's own stop, which counts only once the task has
  // left its tracker. A task the tracker no longer holds is not running any more
  // (claudecodeui#1656): that is a 409 the panel answers by redrawing, not an error.
  const stop = async (res, sessionId, where, find) => {
    const live = liveOf(sessionId, where);
    const target = find(live);
    if (!target) return res.status(409).json({ error: 'not running' });
    try {
      const stopped = await stopTask(target.key, target.taskId);
      return stopped ? res.json({ stopped: true }) : res.status(409).json({ error: 'not running' });
    } catch (error) {
      return res.status(502).json({ error: error?.message || 'the stop did not take' });
    }
  };
  router.post('/:sessionId/tasks/:taskId/stop', withSession((req, res, where) =>
    stop(res, req.params.sessionId, where, (live) => live.byTask.get(req.params.taskId))));
  router.post('/:sessionId/agents/:agentId/stop', withSession((req, res, where) => {
    if (!/^[\w-]+$/.test(req.params.agentId)) return res.status(404).json({ error: 'no such agent' });
    const meta = readMeta(path.join(where.subagentDir, `agent-${req.params.agentId}.meta.json`));
    return stop(res, req.params.sessionId, where, (live) => live.byToolUse.get(meta.toolUseId));
  }));
  router.get('/:sessionId/agents/:agentId', withSession((req, res, where) => {
    const out = readAgentActivity(where, req.params.agentId);
    return out ? res.json(out) : res.status(404).json({ error: 'no such agent' });
  }));
  return router;
}

/** Wired to the app: the session row says where the transcript is, the runtime what is live. */
export async function kitAgentsRoutes() {
  const { sessionsDb } = await import('./modules/database/index.js');
  const runtime = await import('./modules/providers/list/claude/claude-runtime.provider.js');
  const locate = (sessionId) => {
    const row = sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId?.(sessionId);
    if (!row?.jsonl_path || !row.provider_session_id) return null;
    return { transcript: row.jsonl_path, subagentDir: path.join(path.dirname(row.jsonl_path), row.provider_session_id, 'subagents'), row };
  };
  const liveOf = (sessionId, { row }) => {
    const keys = new Set([sessionId, row.session_id, row.provider_session_id].filter(Boolean));
    const running = [...keys].some((k) => runtime.getClaudeSDKSessionStartTime?.(k));
    const taskIds = new Set();
    const toolUseIds = new Set();
    const byTask = new Map();     // taskId -> { key, taskId }: what a stop names
    const byToolUse = new Map();  // launching call -> the same
    for (const entry of runtime.listClaudeSDKBackgroundWork?.() ?? []) {
      if (!keys.has(entry.sessionId)) continue;
      for (const t of entry.tasks) {
        const target = { key: entry.sessionId, taskId: t.taskId };
        taskIds.add(t.taskId);
        byTask.set(t.taskId, target);
        if (t.toolUseId) { toolUseIds.add(t.toolUseId); byToolUse.set(t.toolUseId, target); }
      }
    }
    return { running: running || taskIds.size > 0, taskIds, toolUseIds, byTask, byToolUse };
  };
  return createKitAgentsRoutes({ locate, liveOf, stopTask: (key, taskId) => runtime.stopClaudeSDKTask(key, taskId) });
}
