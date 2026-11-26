'use strict';
// Sidebar projects: groups of folders the user defines, plus per-session choices (moved by hand, pinned, archived).
// Nothing here touches Claude Code's own files; it all lives in one JSON file in the extension's storage.
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');

const VERSION = 1;
// Most sessions are started in a folder that holds several projects (the VS Code workspace /root/work), so the
// folder alone says nothing. Such a session goes to the project whose folders it worked in: one
// `win-work.sh run <project>` counts as much as this many file reads or edits, and the project needs this share
// of everything the session did.
const RUN_WEIGHT = 3;
const CONTENT_SHARE = 0.6;
const SUGGEST_MAX = 8;

/** True when `dir` is `root` or lies below it. Both are absolute and normalised. */
function isWithin(root, dir) {
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
const sessionId = (st) => path.basename(st.file, '.jsonl');

class Projects {
  constructor(dir) {
    this.file = path.join(dir, 'projects-v1.json');
    this.list = []; // [{ id, name, paths: [absolute folder] }]
    this.overrides = {}; // session id -> project id, or '' for "no project"; absent = decided automatically
    this.pins = []; // session ids
    this.archived = []; // session ids hidden from the list unless asked for; their transcripts are untouched
    this.rev = 0; // bumped on every change, so cached automatic choices are recomputed
    this.memo = new Map(); // session file -> { sig, res }
    this.writing = Promise.resolve();
  }

  async load() {
    let text;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    const data = JSON.parse(text);
    if (data.version !== VERSION) throw new Error(`不认识的项目文件版本 ${data.version}：${this.file}`);
    this.list = data.list;
    this.overrides = data.overrides;
    this.pins = data.pins;
    this.archived = data.archived || []; // 0.12.0 wrote the file before archiving existed
  }

  /** Writes are queued: two quick changes (e.g. two drags) must not write the same temporary file at once. */
  save() {
    this.rev++;
    const data = JSON.stringify({ version: VERSION, list: this.list, overrides: this.overrides, pins: this.pins, archived: this.archived });
    const write = async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, this.file);
    };
    // A failed earlier write was already reported to whoever made that change; it must not block this one.
    this.writing = this.writing.catch(() => {}).then(write);
    return this.writing;
  }

  byId(id) {
    return this.list.find((p) => p.id === id) || null;
  }

  /**
   * The project of a main session: { project: id | null, how: 'manual' | 'cwd' | 'content' | null }.
   * A move by hand wins. `subs` are the session's subagent transcripts, whose file reads count too.
   */
  classify(st, subs) {
    const o = this.overrides[sessionId(st)];
    if (o !== undefined) return { project: o || null, how: 'manual' };
    const sig = `${this.rev}:${st.mtimeMs}:${subs.map((s) => s.mtimeMs).join(',')}`;
    const m = this.memo.get(st.file);
    if (m && m.sig === sig) return m.res;
    const res = this.auto(st, subs);
    this.memo.set(st.file, { sig, res });
    return res;
  }

  /**
   * The automatic choice, in this order:
   *  1. the deepest project folder the session was started in (or below);
   *  2. otherwise (typically started in a folder that holds several projects, e.g. /root/work) the project it
   *     worked in most — `win-work.sh run <name>` names the project folder called <name>, a file read or edited
   *     names the folder it is in — if that is at least CONTENT_SHARE of its runs and of its file operations
   *     inside the start folder or a project.
   * A session whose folder is unknown (no record carried one) matches by folder only a project folder it was started in exactly.
   */
  auto(st, subs) {
    const none = { project: null, how: null };
    let best = null;
    let bestLen = -1;
    for (const p of this.list) {
      for (const dir of p.paths) {
        const hit = st.cwd ? isWithin(dir, st.cwd) : core.projectDirFor(dir) === path.dirname(st.file);
        if (hit && dir.length > bestLen) [best, bestLen] = [p.id, dir.length];
      }
    }
    if (best) return { project: best, how: 'cwd' };
    const folders = []; // [folder, project id], deepest first
    for (const p of this.list) for (const dir of p.paths) folders.push([dir, p.id]);
    folders.sort((a, b) => b[0].length - a[0].length);
    const score = new Map();
    let total = 0;
    const add = (hit, n) => hit && score.set(hit[1], (score.get(hit[1]) || 0) + n);
    for (const s of [st, ...subs]) {
      for (const [name, n] of s.cokeProjects) {
        total += n * RUN_WEIGHT;
        add(folders.find(([dir]) => path.basename(dir) === name), n * RUN_WEIGHT);
      }
      for (const [dir, n] of s.dirs) {
        const hit = folders.find(([d]) => isWithin(d, dir));
        // Files outside the start folder and every project (memory, scratchpad, system files) say nothing either way.
        if (hit || (st.cwd && isWithin(st.cwd, dir))) total += n;
        add(hit, n);
      }
    }
    let top = null;
    let topN = 0;
    for (const [id, n] of score) if (n > topN) [top, topN] = [id, n];
    return top && topN >= total * CONTENT_SHARE ? { project: top, how: 'content' } : none;
  }

  /**
   * Folders worth registering, from what the sessions did: each first-level folder below a session's start folder
   * that it ran `win-work.sh run` for or read/edited files in, else the start folder itself. A start folder that
   * holds other candidates (e.g. /root/work), the home folder, temporary folders and folders already inside a
   * project are left out. `sessions` is [{ st, subs }]. Returns [{ path, sessions }], most sessions first;
   * whether the folder still exists is not checked.
   */
  suggest(sessions) {
    const count = new Map();
    for (const { st, subs } of sessions) {
      if (!st.cwd) continue;
      const found = new Set();
      for (const s of [st, ...subs]) {
        for (const [name] of s.cokeProjects) if (!name.includes(path.sep) && !name.startsWith('.')) found.add(path.join(st.cwd, name));
        for (const [dir] of s.dirs) {
          if (dir === st.cwd || !isWithin(st.cwd, dir)) continue;
          const seg = path.relative(st.cwd, dir).split(path.sep)[0];
          if (!seg.startsWith('.')) found.add(path.join(st.cwd, seg));
        }
      }
      if (!found.size) found.add(st.cwd);
      for (const f of found) count.set(f, (count.get(f) || 0) + 1);
    }
    const all = [...count.keys()];
    const registered = this.list.flatMap((p) => p.paths);
    const tmp = os.tmpdir();
    return [...count]
      .filter(([f]) => f !== os.homedir() && !isWithin(tmp, f) && !registered.some((r) => isWithin(r, f)) && !all.some((o) => o !== f && isWithin(f, o)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, SUGGEST_MAX)
      .map(([p, sessions]) => ({ path: p, sessions }));
  }

  /**
   * Creates a project, or updates the one with `id`. `folders` is [{ path, create }] from the webview; it is
   * checked here because the webview is the trust boundary. Throws an Error whose message is shown to the user;
   * when folders are missing and not marked `create`, the error lists them in `missing`.
   */
  async upsert({ id, name, folders }) {
    name = typeof name === 'string' ? name.trim() : '';
    if (!name) throw new Error('请填写项目名称');
    if (!Array.isArray(folders)) throw new Error('目录列表不正确');
    const wanted = new Map(); // normalised path -> { create, raw: as typed }
    for (const f of folders) {
      const raw = f && typeof f.path === 'string' ? f.path.trim() : '';
      if (!path.isAbsolute(raw)) throw new Error(`需要绝对路径：${raw || '（空）'}`);
      wanted.set(path.resolve(raw), { create: !!f.create, raw });
    }
    if (!wanted.size) throw new Error('至少添加一个目录');
    const current = id ? this.byId(id) : null;
    if (id && !current) throw new Error('项目不存在');
    for (const p of this.list) {
      if (p === current) continue;
      if (p.name === name) throw new Error(`已有同名项目「${name}」`);
      const dup = p.paths.find((d) => wanted.has(d));
      if (dup) throw new Error(`目录 ${dup} 已属于项目「${p.name}」`);
    }
    const missing = []; // as typed, so the webview can find them in its list
    for (const [dir, { create, raw }] of wanted) {
      if (create) continue;
      let stat;
      try {
        stat = await fsp.stat(dir);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        missing.push(raw);
        continue;
      }
      if (!stat.isDirectory()) throw new Error(`不是目录：${dir}`);
    }
    if (missing.length) {
      const e = new Error(`目录不存在：${missing.join('、')}`);
      e.missing = missing;
      throw e;
    }
    for (const [dir, { create }] of wanted) if (create) await fsp.mkdir(dir, { recursive: true });
    const paths = [...wanted.keys()];
    if (current) Object.assign(current, { name, paths });
    else this.list.push({ id: crypto.randomUUID(), name, paths });
    await this.save();
  }

  /** Removes the registration only; folders and sessions are untouched, and manual moves into it are dropped. */
  async remove(id) {
    const before = this.list.length;
    this.list = this.list.filter((p) => p.id !== id);
    if (this.list.length === before) throw new Error('项目不存在');
    for (const [s, p] of Object.entries(this.overrides)) if (p === id) delete this.overrides[s];
    await this.save();
  }

  /** Moves a session by hand. `target` is a project id or '' for "no project"; the choice is dropped when it equals the automatic one. */
  async move(st, subs, target) {
    if (target && !this.byId(target)) throw new Error('项目不存在');
    const id = sessionId(st);
    if (target === (this.auto(st, subs).project || '')) delete this.overrides[id];
    else this.overrides[id] = target;
    await this.save();
  }

  async autoAssign(st) {
    delete this.overrides[sessionId(st)];
    await this.save();
  }

  /** Adds the session to, or takes it off, the 'pins' or 'archived' list. */
  async mark(key, st, on) {
    const id = sessionId(st);
    this[key] = this[key].filter((x) => x !== id);
    if (on) this[key].push(id);
    await this.save();
  }

  /** Drops choices about sessions whose transcripts Claude Code has deleted. `ids` are all main sessions on disk. */
  async prune(ids) {
    const before = JSON.stringify([this.overrides, this.pins, this.archived]);
    for (const s of Object.keys(this.overrides)) if (!ids.has(s)) delete this.overrides[s];
    this.pins = this.pins.filter((s) => ids.has(s));
    this.archived = this.archived.filter((s) => ids.has(s));
    if (JSON.stringify([this.overrides, this.pins, this.archived]) !== before) await this.save();
  }
}

module.exports = { Projects, isWithin };
