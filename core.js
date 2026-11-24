'use strict';
// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) incrementally.
// No `vscode` dependency so it can be run and checked with plain node.
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { bashCommands, cokeProjects } = require('./commands');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CHUNK = 4 * 1024 * 1024;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

class FileState {
  constructor(file) {
    this.file = file;
    this.isSub = file.split(path.sep).includes('subagents');
    this.dirty = false; // parsed data not yet written to the on-disk cache
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.mtimeMs = 0;
    this.reqs = new Map(); // message.id -> request
    this.apiSend = new Map(); // api-request id -> { ts, ttl }
    this.lastEventTs = 0;
    this.turns = 0;
    this.compactions = 0;
    this.compactTs = []; // when each compaction happened
    this.firstTs = 0; // timestamp of the first record: when the session was created
    this.entry = null; // what started the session: claude-vscode (the editor panel), cli (a terminal), sdk-*
    this.title = null;
    this.firstPrompt = null;
    this.cwd = null;
    // [timestamp, 'tool' | 'cmd' | 'skill', name]; timestamps let the rankings follow a date range.
    this.uses = [];
    this.promptTs = [];
    this.dirs = new Map(); // directories of files read/edited, for project detection
    this.cokeProjects = new Map();
    // Last main-chain event, used to tell whether Claude is working or waiting for the user.
    this.last = { kind: null, ts: 0 };
  }
}

function isPromptText(t) {
  return typeof t === 'string' && t.trim() !== '' && !t.startsWith('<') && !t.startsWith('[Request interrupted');
}

function promptText(c) {
  if (typeof c === 'string') return isPromptText(c) ? c : null;
  if (!Array.isArray(c) || c.some((b) => b.type === 'tool_result')) return null;
  const t = c.find((b) => b.type === 'text' && isPromptText(b.text));
  if (t) return t.text;
  return c.some((b) => b.type === 'image') ? '[图片]' : null;
}

function isInterrupt(c) {
  const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text') || {}).text : '';
  return typeof t === 'string' && t.startsWith('[Request interrupted');
}

function addPrompt(st, text, ts) {
  st.turns++;
  st.promptTs.push(ts);
  if (!st.firstPrompt) st.firstPrompt = text.replace(/\s+/g, ' ').slice(0, 120);
  st.last = { kind: 'request', ts };
}

function ttlOf(cacheControl) {
  let ttl = 0;
  for (const c of cacheControl || []) ttl = Math.max(ttl, c.value && c.value.ttl === '1h' ? 3600 : 300);
  return ttl;
}

function addToolUse(st, b, cwd, ts) {
  st.uses.push([ts, 'tool', b.name]);
  const input = b.input || {};
  if (b.name === 'Bash' && typeof input.command === 'string') {
    for (const c of bashCommands(input.command)) st.uses.push([ts, 'cmd', c]);
    for (const p of cokeProjects(input.command)) bump(st.cokeProjects, p);
  } else if (b.name === 'Skill' && input.skill) {
    st.uses.push([ts, 'skill', input.skill]);
  } else if (FILE_TOOLS.has(b.name) && typeof input.file_path === 'string' && path.isAbsolute(input.file_path)) {
    bump(st.dirs, path.dirname(input.file_path));
  }
  if (!st.cwd && cwd) st.cwd = cwd;
}

function addAssistant(st, d, ts) {
  const m = d.message;
  if (!m || !m.id || m.model === '<synthetic>') return;
  for (const b of Array.isArray(m.content) ? m.content : []) if (b && b.type === 'tool_use') addToolUse(st, b, d.cwd, ts);
  if (!d.isSidechain) {
    // stop_reason is only known once the response is complete; until then Claude is still generating.
    const stop = m.stop_reason;
    st.last = { kind: stop === 'tool_use' ? 'tool' : stop && stop !== 'pause_turn' ? 'answer' : 'request', ts };
  }
  const u = m.usage;
  if (!u) return;
  const r = st.reqs.get(m.id);
  if (r) {
    // One response is written as one line per content block; they share the same usage.
    if (ts > r.endTs) r.endTs = ts;
    if ((u.output_tokens || 0) > r.out) r.out = u.output_tokens;
    return;
  }
  const api = d.requestRef && st.apiSend.get(d.requestRef);
  const cc = u.cache_creation || {};
  const cw1h = cc.ephemeral_1h_input_tokens || 0;
  const cw5 = cc.ephemeral_5m_input_tokens || 0;
  st.reqs.set(m.id, {
    model: m.model,
    effort: d.effort || null, // reasoning effort of the request; absent in older transcripts
    side: !!d.isSidechain,
    src: d.entrypoint || null, // cli / claude-vscode / sdk-*
    startTs: ts,
    endTs: ts,
    // api-request records exist in newer Claude Code versions; older ones fall back to the
    // preceding user/tool_result record, which is when the request was sent.
    sendTs: (api && api.ts) || st.lastEventTs || 0,
    ttl: (api && api.ttl) || (cw1h ? 3600 : cw5 ? 300 : 0),
    in: u.input_tokens || 0,
    cr: u.cache_read_input_tokens || 0,
    cw: u.cache_creation_input_tokens || 0,
    cw1h,
    cw5,
    out: u.output_tokens || 0,
    think: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
  });
}

function parseLine(st, line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    // A line that is not valid JSON is not a transcript record we can use; skip it.
    return;
  }
  const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
  if (ts && !st.firstTs) st.firstTs = ts;
  if (!st.entry && d.entrypoint) st.entry = d.entrypoint;
  switch (d.type) {
    case 'assistant':
      addAssistant(st, d, ts);
      break;
    case 'api-request':
      if (d.id && ts) {
        st.apiSend.set(d.id, { ts, ttl: ttlOf(d.cacheControl) });
        st.last = { kind: 'request', ts };
      }
      break;
    case 'user': {
      if (ts) st.lastEventTs = ts;
      if (!st.cwd && d.cwd) st.cwd = d.cwd;
      if (d.isSidechain) break;
      const c = d.message && d.message.content;
      if (typeof c === 'string') {
        const cmd = c.match(/<command-name>\/?([^<\s]+)<\/command-name>/);
        if (cmd) st.uses.push([ts, 'skill', '/' + cmd[1]]);
      }
      if (d.isMeta) break;
      if (d.toolUseResult || (Array.isArray(c) && c.some((b) => b.type === 'tool_result'))) {
        st.last = { kind: 'request', ts };
      } else if (isInterrupt(c)) {
        st.last = { kind: 'answer', ts };
      } else {
        const text = promptText(c);
        if (text) addPrompt(st, text, ts);
      }
      break;
    }
    case 'attachment': {
      // Messages typed while Claude is working arrive as queued commands.
      const a = d.attachment;
      const text = a && a.type === 'queued_command' ? promptText(a.prompt) : null;
      if (text) addPrompt(st, text, ts || st.last.ts);
      break;
    }
    case 'ai-title':
      if (d.aiTitle) st.title = d.aiTitle;
      break;
    case 'system':
      if (d.subtype === 'compact_boundary') {
        st.compactions++;
        st.compactTs.push(ts);
      }
      break;
  }
}

// Records that start with their "type" key and are not one of these (api-request-blob, file-history-snapshot, …)
// are skipped without decoding them: they are most of the bytes of a transcript and carry nothing we use.
const TOP_TYPE = /^\{"type":"([a-z-]+)"/;
const NEEDED_TOP = new Set(['api-request', 'ai-title', 'system', 'attachment', 'user', 'assistant']);
function wanted(buf, start, end) {
  const m = TOP_TYPE.exec(buf.toString('latin1', start, Math.min(end, start + 40)));
  return !m || NEEDED_TOP.has(m[1]);
}
// Parsing a large transcript is synchronous; give the extension host a turn every this many lines.
const YIELD_EVERY = 500;

/** Reads bytes appended since the last call. Returns true when anything new was parsed. */
async function readIncrement(st) {
  const stat = await fsp.stat(st.file);
  if (stat.size < st.offset) st.reset(); // file was rewritten: parse from the start
  st.mtimeMs = stat.mtimeMs;
  if (stat.size === st.offset) return false;
  const fh = await fsp.open(st.file, 'r');
  try {
    while (st.offset < stat.size) {
      const len = Math.min(CHUNK, stat.size - st.offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, st.offset);
      if (bytesRead === 0) break;
      st.offset += bytesRead;
      const data = Buffer.concat([st.partial, buf.subarray(0, bytesRead)]);
      // Split on the newline byte so multi-byte UTF-8 characters are never cut in half.
      const nl = data.lastIndexOf(10);
      if (nl < 0) {
        st.partial = data;
        continue;
      }
      st.partial = Buffer.from(data.subarray(nl + 1));
      // Cut lines on the newline byte and decode only the ones we need.
      let pos = 0;
      let n = 0;
      while (pos < nl) {
        const end = data.indexOf(10, pos);
        if (end > pos && wanted(data, pos, end)) parseLine(st, data.toString('utf8', pos, end));
        pos = end + 1;
        if (++n % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    await fh.close();
  }
  st.dirty = true;
  return true;
}

// ---- on-disk cache: one file per transcript holding its parse state, so a restart only parses what was appended since.
// Transcripts are append-only. The cache is derived data: anything that does not check out is dropped and re-parsed.
const FP_BYTES = 4096;

const cacheName = (file) => crypto.createHash('sha1').update(file).digest('hex').slice(0, 20) + '.json';
const mapReplacer = (k, v) => (v instanceof Map ? { $map: [...v] } : v);
const mapReviver = (k, v) => (v && typeof v === 'object' && Array.isArray(v.$map) ? new Map(v.$map) : v);

/** Hash of the first `len` bytes: tells an appended file from a replaced one. */
async function fingerprint(file, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return crypto.createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally {
    await fh.close();
  }
}

/**
 * Writes the parse state of one transcript. `version` ties the cache to the extension version, so a
 * release that changes what is parsed never reads an older cache. Parsing resumes at the start of the
 * last unfinished line, so that partial line is not stored.
 */
async function saveState(dir, version, st) {
  const { file, isSub, partial, dirty, ...rest } = st;
  const resume = st.offset - partial.length;
  const fpLen = Math.min(FP_BYTES, resume);
  const fp = fpLen ? await fingerprint(file, fpLen) : '';
  const body = JSON.stringify({ version, file, fpLen, fp, state: { ...rest, offset: resume } }, mapReplacer);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, cacheName(file));
  await fsp.writeFile(target + '.tmp', body);
  await fsp.rename(target + '.tmp', target);
  st.dirty = false;
}

/** The saved state of a transcript, or null when there is none, it is from another version, or the file no longer matches it. */
async function loadState(dir, version, file) {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(dir, cacheName(file)), 'utf8'), mapReviver);
    if (data.version !== version || data.file !== file) return null;
    if ((await fsp.stat(file)).size < data.state.offset) return null;
    if (data.fpLen && (await fingerprint(file, data.fpLen)) !== data.fp) return null;
    const st = new FileState(file);
    Object.assign(st, data.state);
    return st;
  } catch {
    return null;
  }
}

/** Removes cache files of transcripts that no longer exist. */
async function pruneCache(dir, files) {
  const keep = new Set(files.map(cacheName));
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const n of names) if (!keep.has(n)) await fsp.rm(path.join(dir, n), { force: true });
}

/** Claude Code names a project directory after its path with every non-alphanumeric character replaced by '-'. */
function projectDirFor(folder) {
  return path.join(PROJECTS_DIR, folder.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Every transcript file (main sessions and subagents). */
async function listTranscripts() {
  const out = [];
  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.name.endsWith('.jsonl')) out.push(p);
    }
  }
  await walk(PROJECTS_DIR);
  return out;
}

/** Main session files directly inside one project directory (no recursion, cheap enough for every poll). */
async function listProjectSessions(dir) {
  try {
    return (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl') && !n.startsWith('agent-')).map((n) => path.join(dir, n));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function isMainSession(file) {
  return path.dirname(path.dirname(file)) === PROJECTS_DIR && !path.basename(file).startsWith('agent-');
}

/** Main session files belong to a project dir; subagent files live in <session>/subagents/. */
function sessionFileOf(subFile) {
  return path.dirname(path.dirname(subFile)) + '.jsonl';
}

module.exports = {
  PROJECTS_DIR,
  FileState,
  readIncrement,
  projectDirFor,
  listTranscripts,
  listProjectSessions,
  saveState,
  loadState,
  pruneCache,
  isMainSession,
  sessionFileOf,
};
