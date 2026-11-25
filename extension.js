'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const core = require('./core');
const stats = require('./stats');
const { History } = require('./history');

// The transcript directory is listed (new sessions, deleted files) and global stats are recomputed every Nth poll.
const RESCAN_EVERY = 10;
// How long the "+18K" / "↑0.4%" change stays in the status bar after a request completes.
const FLASH_MS = 8000;
// A request that rewrote at least this many tokens with less than half served from cache rebuilt the cache.
const CACHE_MISS_TOKENS = 20000;

function fmtTok(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtPct(x) {
  return x == null ? '—' : (x * 100).toFixed(1) + '%';
}
function fmtNum(x, d = 1) {
  return x == null ? '—' : x.toFixed(d);
}
function fmtUsd(x) {
  return x == null ? '—' : x > 0 && x < 0.01 ? '<$0.01' : '$' + x.toFixed(2);
}
const costOf = (t) => ({ in: t.cIn, out: t.cOut, cr: t.cCr, cw: t.cCw });
/** Monospace table for a hover: first column left, the rest right-aligned. ASCII only, so columns line up whatever font fills in. */
function monoTable(head, rows, foot) {
  const all = [head, ...rows, foot];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ');
  return ['```text', line(head), '-'.repeat(line(head).length), ...rows.map(line), '-'.repeat(line(head).length), line(foot), '```'];
}
/** "↑38% 较上周同期", or '' when there is no baseline to compare with. */
function fmtDelta(c, note = '') {
  return c ? `${c.pct >= 0 ? '↑' : '↓'}${Math.abs(c.pct * 100).toFixed(0)}% 较${c.label}${note}` : '';
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}
/** Status bar items cannot draw SVG, so the context fill is shown as a quarter-step circle glyph. */
function ring(p) {
  return ['○', '◔', '◑', '◕', '●'][Math.max(0, Math.min(4, Math.round((p || 0) * 4)))];
}
function cacheLeft(cache, now) {
  return cache ? cache.expiresAt - now : null;
}
function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|-|\[)/.exec(id || '');
  if (!m) return id || '—';
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
}
function fmtAgo(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前';
}
function md(lines) {
  const m = new vscode.MarkdownString(lines.join('\n'));
  m.supportThemeIcons = true;
  m.isTrusted = { enabledCommands: ['ccPulse.pickSession'] }; // the "切换会话" link in the tooltip
  return m;
}

// A conversation tab of the Claude Code extension: a webview whose viewType contains this.
const CLAUDE_TAB = 'claudeVSCodePanel';
// The label Claude Code gives a conversation that has no title yet, and the rule it applies to the others.
const UNTITLED = 'Claude Code';
const tabLabel = (title) => (title.length > 25 ? title.substring(0, 24) + '…' : title);
const NEW_CONVERSATION = '<new conversation>';
const EDITOR_ENTRY = 'claude-vscode'; // entrypoint of sessions started from the editor panel
const BIND_SLACK_MS = 15000; // a session file may be created slightly before the tab is seen to be untitled
const isClaudeTab = (t) => !!(t && t.input && 'viewType' in t.input && t.input.viewType.includes(CLAUDE_TAB));

class Pulse {
  constructor(context) {
    this.context = context;
    this.states = new Map(); // transcript file -> FileState
    this.current = null; // main session file shown in the status bar
    this.session = null; // sessionStats of the current session
    this.global = null; // { g, daily, cal }
    this.history = new History(context.globalStorageUri.fsPath);
    this.tick = 0;
    this.busy = false;
    this.prev = null;
    this.flash = null;
    this.range = 'all'; // date range of the 全局洞察 tab, chosen in the panel
    this.pinned = context.workspaceState.get('pinned') || null; // session file the status bar is fixed to, or null to follow the newest
    this.viewing = null; // session of the conversation tab that is active in the editor, NEW_CONVERSATION, or null
    this.fresh = null; // the new (untitled) conversation: { since, file: its session once found, labelled: it has had its own label, previous: session shown before }
    this.blank = new core.FileState(path.join(core.PROJECTS_DIR, 'new-conversation.jsonl')); // stands in for a session with no transcript yet
    this.usage = null; // today / this week over every session
    this.notified = { ctx: new Set(), cache: new Map() }; // what has already been announced, so each is shown once
    this.fileErrors = new Set();
    // Parse results are cached per transcript so a restart only parses what was appended since.
    // The extension version is part of the key: a release that changes the parsing never reads an older cache.
    this.cacheDir = path.join(context.globalStorageUri.fsPath, 'cache');
    this.version = context.extension.packageJSON.version;
    this.noCache = false; // set by 重新扫描 to rebuild from the transcripts
    this.pruned = false;

    const mk = (prio) => {
      const it = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prio);
      it.command = 'ccPulse.open';
      context.subscriptions.push(it);
      return it;
    };
    this.items = { state: mk(103), tokens: mk(102), ctx: mk(101), today: mk(100) };

    this.view = null;
    this.logPanel = null;
    this.logTargets = new Map();
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('ccPulse.sidebar', this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('ccPulse.open', () => vscode.commands.executeCommand('workbench.view.extension.ccPulse')),
      vscode.commands.registerCommand('ccPulse.refresh', () => this.fullRescan()),
      vscode.commands.registerCommand('ccPulse.openLog', () => this.openLog()),
      vscode.commands.registerCommand('ccPulse.pickSession', () => this.pickSession()),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabChange(e)),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.onTabChange()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('ccPulse')) return;
        this.restartTimer();
        this.tick = 0; // recompute everything with the new settings on the next poll
        this.poll();
      }),
      { dispose: () => (clearInterval(this.timer), clearInterval(this.uiTimer)) },
    );
    this.uiTimer = setInterval(() => this.renderStatus(), 1000);
    this.start();
  }

  async start() {
    try {
      await this.history.load();
    } catch (e) {
      this.showError(e);
      return;
    }
    this.restartTimer();
    this.poll();
  }

  cfg() {
    const c = vscode.workspace.getConfiguration('ccPulse');
    const w = c.inspect('contextWindows') || {};
    return {
      timeZone: c.get('timeZone') || '',
      // Built-in defaults plus whatever the user set, so adding one model never drops the others.
      windows: { ...w.defaultValue, ...w.globalValue, ...w.workspaceValue },
      pollMs: Math.max(500, c.get('pollIntervalMs')),
      contextWarn: c.get('contextWarn'),
      contextAlert: c.get('contextAlert'),
      cacheWarnMinutes: c.get('cacheWarnMinutes'),
      projectRoots: c.get('projectRoots'),
      showToday: c.get('showToday'),
      followTab: c.get('followTab'),
      notifyContext: c.get('notifyContext'),
      notifyCache: c.get('notifyCache'),
    };
  }

  restartTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), this.cfg().pollMs);
  }

  fullRescan() {
    this.noCache = true;
    this.states.clear();
    this.current = null;
    this.prev = null;
    this.tick = 0;
    this.poll();
  }

  /**
   * Reads one file's new bytes; a file Claude Code deleted is dropped. Any other failure is
   * reported once for that file and does not stop the other files from being read.
   */
  async read(st) {
    try {
      return await core.readIncrement(st);
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.states.delete(st.file);
        return true;
      }
      if (!this.fileErrors.has(st.file)) {
        this.fileErrors.add(st.file);
        this.showError(new Error(`${path.basename(st.file)}: ${e.message}`));
      }
      return false;
    }
  }

  workspaceDirs() {
    return (vscode.workspace.workspaceFolders || []).map((f) => core.projectDirFor(f.uri.fsPath));
  }

  pickCurrent() {
    if (this.pinned) {
      if (this.states.has(this.pinned)) return this.pinned;
      this.pinned = null; // the pinned transcript was deleted
      this.context.workspaceState.update('pinned', undefined);
    }
    if (this.viewing === NEW_CONVERSATION) return NEW_CONVERSATION;
    if (this.viewing && this.states.has(this.viewing)) return this.viewing;
    const dirs = new Set(this.workspaceDirs());
    let best = null;
    let bestAny = null;
    for (const st of this.states.values()) {
      if (!core.isMainSession(st.file)) continue;
      if (!bestAny || st.mtimeMs > bestAny.mtimeMs) bestAny = st;
      if (dirs.has(path.dirname(st.file)) && (!best || st.mtimeMs > best.mtimeMs)) best = st;
    }
    return (best || bestAny || {}).file || null;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = this.cfg();
      const rescan = this.tick++ % RESCAN_EVERY === 0;
      // Full rescans are slow, so new sessions of the open workspace are looked up on every poll instead.
      const files = rescan
        ? await core.listTranscripts()
        : (await Promise.all(this.workspaceDirs().map((d) => core.listProjectSessions(d)))).flat();
      const fresh = files.filter((f) => !this.states.has(f));
      const loaded = await Promise.all(fresh.map(async (f) => (!this.noCache && (await core.loadState(this.cacheDir, this.version, f))) || new core.FileState(f)));
      this.noCache = false;
      for (const st of loaded) this.states.set(st.file, st);
      let changed = rescan;
      for (const st of [...this.states.values()]) if (await this.read(st)) changed = true;
      this.syncTab(); // the title of a conversation may reach its transcript after the tab was already switched to
      const next = this.pickCurrent();
      if (next !== this.current) {
        this.setCurrent(next);
        changed = true; // switching session must refresh the status bar even if no file was written
      }
      if (changed) {
        this.usage = stats.usageSummary([...this.states.values()], cfg.timeZone, Date.now());
        this.updateSession(cfg);
        this.postLog();
      }
      if (rescan) {
        await this.updateGlobal(cfg);
        await this.saveCaches();
      }
    } catch (e) {
      this.showError(e);
    } finally {
      this.busy = false;
    }
  }

  /** Writes the cache of every transcript that changed; on the first call also drops caches of deleted ones. */
  async saveCaches() {
    if (!this.pruned) {
      this.pruned = true;
      await core.pruneCache(this.cacheDir, [...this.states.keys()]);
    }
    for (const st of this.states.values()) {
      if (!st.dirty) continue;
      try {
        await core.saveState(this.cacheDir, this.version, st);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e; // the transcript was deleted meanwhile
      }
    }
  }

  /** Main session files in memory; `inWorkspace` keeps those of the open folders (where a new conversation starts). */
  mainFiles(inWorkspace = false) {
    const dirs = new Set(this.workspaceDirs());
    return [...this.states.values()].filter((st) => core.isMainSession(st.file) && (!inWorkspace || dirs.has(path.dirname(st.file)))).map((st) => st.file);
  }

  /**
   * The session a new (untitled) conversation tab belongs to: one the editor panel created shortly
   * before the tab appeared or since, that no other open tab shows. `/clear` creates its session file
   * at once (with only the command in it), so it can exist before or after the tab is renamed.
   */
  findBorn() {
    const labels = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudeTab).map((t) => t.label.trim()));
    return (
      this.mainFiles(true)
        .map((f) => this.states.get(f))
        .filter((st) => st.file !== this.fresh.previous && st.entry === EDITOR_ENTRY && st.firstTs >= this.fresh.since - BIND_SLACK_MS && !labels.has(tabLabel((st.title || st.firstPrompt || '').trim())))
        .sort((a, b) => b.firstTs - a.firstTs)[0] || {}
    ).file;
  }

  /**
   * Follows the Claude Code conversation tab that is active in the editor.
   *  - The tab is titled like its session (cut to 24 characters plus … when longer than 25), so the
   *    session is found by that label; a session without a title is labelled by its first prompt.
   *  - A new conversation, or one just cleared with /clear, is labelled "Claude Code": it shows an
   *    empty session until its session file is found (see findBorn) and stays bound to it.
   *  - Tabs that are not conversations (files, terminals, other webviews) leave the choice as it was.
   *  - A conversation tab that matches nothing else falls back to the newest activity.
   */
  syncTab() {
    if (!this.cfg().followTab) {
      this.viewing = null;
      return;
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!isClaudeTab(tab)) return;
    const label = tab.label.trim();
    let match = null;
    for (const st of this.states.values()) {
      if (!core.isMainSession(st.file)) continue;
      const name = (st.title || st.firstPrompt || '').trim();
      if (name && tabLabel(name) === label && (!match || st.mtimeMs > match.mtimeMs)) match = st;
    }
    if (match) {
      this.viewing = match.file;
      if (this.fresh && this.fresh.file === match.file) this.fresh.labelled = true; // it has got its own label
      return;
    }
    if (label !== UNTITLED) {
      this.viewing = null;
      return;
    }
    // A tab that had its session's label and is untitled again was cleared: it needs a new session.
    if (this.fresh && this.fresh.labelled) this.fresh = null;
    // `previous`: the session this tab showed until now. After /clear it is not the new conversation, even if it is young.
    if (!this.fresh) this.fresh = { since: Date.now(), file: null, labelled: false, previous: this.viewing && this.viewing !== NEW_CONVERSATION ? this.viewing : null };
    if (!this.fresh.file || !this.states.has(this.fresh.file)) this.fresh.file = this.findBorn() || null;
    this.viewing = this.fresh.file || NEW_CONVERSATION;
  }

  onTabChange(e) {
    // a newly opened untitled conversation starts over, whichever one was pending before
    if (e && e.opened && e.opened.some((t) => isClaudeTab(t) && t.label.trim() === UNTITLED)) this.fresh = null;
    const before = this.current;
    this.syncTab();
    const next = this.pickCurrent();
    if (next === before) return;
    this.setCurrent(next);
    this.updateSession(this.cfg());
    this.postLog();
  }

  setCurrent(file) {
    this.current = file;
    this.prev = null;
    this.flash = null;
  }

  /** Quick pick to fix the status bar to one session, or go back to following the newest. */
  async pickSession() {
    const cfg = this.cfg();
    const now = Date.now();
    const subsOf = new Map();
    for (const st of this.states.values()) {
      if (!st.isSub) continue;
      const key = core.sessionFileOf(st.file);
      if (!subsOf.has(key)) subsOf.set(key, []);
      subsOf.get(key).push(st);
    }
    const briefs = [...this.states.values()]
      .filter((st) => core.isMainSession(st.file))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 60)
      .map((st) => stats.sessionBrief(st, subsOf.get(st.file) || [], cfg.projectRoots, now));
    const items = [
      { label: `${this.pinned ? '' : '$(check) '}$(sync) 自动`, description: '跟随当前工作区里最近有动静的会话', file: null },
      ...briefs.map((b) => ({
        label: `${b.file === this.current ? '$(check) ' : ''}${b.title.replace(/\s+/g, ' ').slice(0, 60)}`,
        description: `${b.project} · ${fmtAgo(now - b.lastActivity)}`,
        detail: `${fmtTok(b.total)} · ${fmtUsd(b.cost)}`,
        file: b.file,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: this.pinned ? '已固定一个会话，选“自动”恢复跟随' : '选择状态栏要跟踪的会话（固定后不再自动切换）',
      matchOnDescription: true,
    });
    if (!pick) return;
    this.pinned = pick.file;
    await this.context.workspaceState.update('pinned', pick.file || undefined);
    this.setCurrent(this.pickCurrent());
    this.updateSession(this.cfg());
    this.postLog();
  }

  updateSession(cfg) {
    const now = Date.now();
    const st = this.current === NEW_CONVERSATION ? this.blank : this.current && this.states.get(this.current);
    if (!st) {
      this.session = null;
      this.renderStatus();
      return;
    }
    const subs = [...this.states.values()].filter((s) => s.isSub && core.sessionFileOf(s.file) === st.file);
    const s = stats.sessionStats(st, subs, cfg.windows, now);
    const total = stats.totalOf(s.tokens) + stats.totalOf(s.sub);
    if (this.prev && s.steps > this.prev.steps) {
      this.flash = { until: now + FLASH_MS, tokens: total - this.prev.total, ctx: (s.context.pct || 0) - (this.prev.pct || 0) };
    }
    this.prev = { steps: s.steps, total, pct: s.context.pct };
    s.pinned = !!this.pinned;
    // a session with no request and no prompt (nothing but /clear or another command) is shown as a new conversation
    s.blank = st === this.blank || (!st.reqs.size && !st.turns);
    if (s.blank) s.title = '新对话（还没有消息）';
    this.session = s;
    this.renderStatus();
    this.post({ type: 'session', s, now, cfg: this.viewCfg(cfg) });
  }

  async updateGlobal(cfg, merge = true) {
    const now = Date.now();
    const all = [...this.states.values()];
    const g = stats.globalInsights(all, { ...cfg, range: this.range }, now);
    if (merge && this.history.merge(stats.dailyByModel(all, cfg.timeZone))) await this.history.save();
    const tz = cfg.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const keys = stats.calendarKeys(cfg.timeZone, now);
    this.global = { g, daily: this.history.days, cal: { ...keys, tz }, hourly: stats.hourlyToday(all, cfg.timeZone, now), cmp: stats.periodComparisons(this.history.days, keys) };
    this.post({ type: 'global', ...this.global, now });
  }

  setRange(range) {
    if (!stats.isRangeKey(range) || range === this.range) return;
    this.range = range;
    if (this.global) this.updateGlobal(this.cfg(), false).catch((e) => this.showError(e));
  }

  viewCfg(cfg) {
    return { contextWarn: cfg.contextWarn, contextAlert: cfg.contextAlert, cacheWarnMinutes: cfg.cacheWarnMinutes };
  }

  /**
   * Assigns a status bar property only when its value changed. Re-assigning an identical value
   * still re-renders the item, which made an open hover card flicker once per second.
   */
  put(item, prop, value) {
    const sig = value instanceof vscode.MarkdownString ? value.value : value instanceof vscode.ThemeColor ? 'c:' + value.id : value;
    const seen = item._seen || (item._seen = {});
    if (prop in seen && seen[prop] === sig) return;
    seen[prop] = sig;
    item[prop] = value;
  }

  renderStatus() {
    const s = this.session;
    const it = this.items;
    if (!s) {
      this.put(it.state, 'text', '$(pulse) CC Pulse');
      this.put(it.state, 'tooltip', '还没有找到 Claude Code 会话记录（~/.claude/projects）');
      this.put(it.state, 'backgroundColor', undefined);
      it.state.show();
      it.state._shown = true;
      for (const k of ['tokens', 'ctx', 'today']) (it[k].hide(), (it[k]._shown = false));
      return;
    }
    const cfg = this.cfg();
    const now = Date.now();
    const flash = this.flash && now < this.flash.until ? this.flash : null;

    // ---- state / speed / cache countdown
    const { kind } = s.state;
    const left = cacheLeft(s.cache, now);
    // While Claude works the next request renews the cache, so the lapse warning only applies when it is your turn.
    const working = kind === 'generating' || kind === 'tool';
    let cacheText = '';
    let bg;
    let fg;
    if (left !== null) {
      cacheText = left > 0 ? ` · 缓存 ${left >= 60000 ? Math.ceil(left / 60000) + '分' : Math.ceil(left / 1000) + '秒'}` : ' · 缓存已过期';
      if (!working && left > 0 && left <= cfg.cacheWarnMinutes * 60000) bg = new vscode.ThemeColor('statusBarItem.warningBackground');
      if (!working && left <= 0) fg = new vscode.ThemeColor('disabledForeground');
    }
    this.put(it.state, 'backgroundColor', bg);
    this.put(it.state, 'color', fg);
    this.put(it.state, 'text', `${this.pinned ? '$(pin)' : '$(pulse)'} ${s.blank ? '新对话' : `${fmtNum(s.speed.latest)} tok/s${cacheText}`}`);
    const stateLine = s.blank ? '新对话，发出第一条消息后开始统计' : { generating: '正在生成回复', tool: '正在执行工具（也可能在等你批准权限）', waiting: '等你回复', idle: '空闲' }[kind];
    this.put(it.state, 'tooltip', md([
      `**${stateLine}** · ${s.model || ''}${s.effort ? ' · ' + s.effort : ''}`,
      `会话：${(s.title || '').replace(/[|\n]/g, ' ').slice(0, 50)}`,
      '',
      '| | |',
      '|---|---:|',
      `| 最新请求 | **${fmtNum(s.speed.latest)}** tok/s |`,
      `| 会话平均 | ${fmtNum(s.speed.avg)} tok/s |`,
      `| 峰值 | ${fmtNum(s.speed.peak)} tok/s |`,
      `| 平均请求耗时 | ${fmtNum(s.speed.avgLatency)} s |`,
      s.cache
        ? `| 缓存（${s.cache.ttl >= 3600 ? '1 小时' : '5 分钟'}档） | ${left > 0 ? (left >= 60000 ? '剩 ' + Math.ceil(left / 60000) + ' 分钟' : '不足 1 分钟') : '已过期'} |`
        : '| 缓存 | — |',
      '',
      '速率 = 输出 token ÷ 请求总耗时（含等待首字的时间）。缓存从最后一次请求结束开始计时，每次请求都会续期。',
      '',
      `[切换会话](command:ccPulse.pickSession)${this.pinned ? ' · 已固定这个会话' : ''}`,
    ]));

    // ---- tokens
    const total = stats.totalOf(s.tokens) + stats.totalOf(s.sub);
    this.put(it.tokens, 'text', `$(database) ${fmtTok(total)}${flash && flash.tokens > 0 ? ' +' + fmtTok(flash.tokens) : ''}`);
    const miss = s.lastHit !== null && s.lastHit < 0.5 && s.lastCw >= CACHE_MISS_TOKENS;
    this.put(it.tokens, 'backgroundColor', miss ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined);
    this.put(it.tokens, 'tooltip', md([
      `**Token 用量** · 本会话 ${total.toLocaleString()}（含子代理）`,
      miss ? `\n$(warning) 最近一次请求缓存未命中，重新写入了 ${fmtTok(s.lastCw)} token` : '',
      '',
      '| | |',
      '|---|---:|',
      `| 缓存命中率 | ${fmtPct(s.hit)} |`,
      `| 缓存读取 | ${fmtTok(s.tokens.cr)} |`,
      `| 未缓存输入 | ${fmtTok(s.tokens.in)} |`,
      `| 缓存写入 | ${fmtTok(s.tokens.cw)} |`,
      `| 输出（含思考） | ${fmtTok(s.tokens.out)} |`,
      `| 子代理 | ${fmtTok(stats.totalOf(s.sub))} |`,
      `| 估算费用 | ${fmtUsd(s.tokens.cost + s.sub.cost)} |`,
      '',
      '费用按 API 价格折算，仅供参考。',
    ]));

    // ---- context
    const pct = s.context.pct;
    const up = flash && Math.abs(flash.ctx) >= 0.0005 ? ` ${flash.ctx > 0 ? '↑' : '↓'}${(Math.abs(flash.ctx) * 100).toFixed(1)}%` : '';
    this.put(it.ctx, 'text', `${ring(pct)} ${fmtPct(pct)} · ${s.turns}轮${up}`);
    this.put(
      it.ctx,
      'backgroundColor',
      pct >= cfg.contextAlert
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : pct >= cfg.contextWarn
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined,
    );
    this.put(it.ctx, 'tooltip', md([
      `**上下文窗口** · ${fmtPct(pct)} 已用`,
      '',
      '| | |',
      '|---|---:|',
      `| 已用 / 窗口 | ${fmtTok(s.context.used)} / ${fmtTok(s.context.window)} |`,
      `| 轮数 · 步数 | ${s.turns} 轮 · ${s.steps} 步 |`,
      `| 自动压缩 | ${s.context.compactions} 次 |`,
      `| 会话 | ${(s.title || '').replace(/[|\n]/g, ' ').slice(0, 40)} |`,
      '',
      pct >= cfg.contextWarn ? '上下文偏大：可以在任务的自然断点主动 `/compact`，或开新会话。' : '',
    ]));
    // ---- today, over every session
    const u = this.usage;
    const cmp = (this.global && this.global.cmp) || {};
    if (cfg.showToday && u) {
      this.put(it.today, 'text', `$(graph) 今日 ${fmtTok(u.today.total)} · ${fmtUsd(u.today.cost)}`);
      const tc = costOf(u.today);
      this.put(it.today, 'tooltip', md([
        '**今日用量** · 全部会话',
        '',
        `### ${fmtUsd(u.today.cost)}`,
        [`${fmtTok(u.today.total)} Token`, `${u.today.reqs} 次`, cmp.today && fmtDelta(cmp.today, '（今日未结束）')].filter(Boolean).join(' · '),
        '',
        ...monoTable(
          ['Model', 'Token', 'Cost', 'Write', 'Read', 'Other'],
          u.models.map((m) => [modelName(m.model), fmtTok(m.total), fmtUsd(m.cost), fmtUsd(m.parts.cw), fmtUsd(m.parts.cr), fmtUsd(m.parts.in + m.parts.out)]),
          ['Total', fmtTok(u.today.total), fmtUsd(u.today.cost), fmtUsd(tc.cw), fmtUsd(tc.cr), fmtUsd(tc.in + tc.out)],
        ),
        '',
        `缓存命中率 ${fmtPct(u.today.hit)}  `,
        `本周 ${fmtTok(u.week.total)} · ${fmtUsd(u.week.cost)} · ${u.week.reqs} 次${cmp.week ? ' · ' + fmtDelta(cmp.week) : ''}`,
        '',
        '---',
        'Cost 费用 = Write 缓存写入 + Read 缓存读取 + Other 其余（未缓存输入和输出）。按 API 价格折算，仅供参考。',
      ]));
      if (!it.today._shown) (it.today.show(), (it.today._shown = true));
    } else if (it.today._shown !== false) {
      it.today.hide();
      it.today._shown = false;
    }
    for (const k of ['state', 'tokens', 'ctx']) {
      if (!it[k]._shown) (it[k].show(), (it[k]._shown = true));
    }
    this.notify(s, left, cfg);
  }

  /** Opt-in heads-up for a context that is nearly full or a prompt cache about to lapse; each is shown once. */
  notify(s, left, cfg) {
    // Skip sessions that have been quiet for a long time (e.g. one left over from yesterday).
    if (s.state.kind === 'idle') return;
    const id = s.sessionId;
    if (cfg.notifyContext) {
      if (s.context.pct >= cfg.contextAlert) {
        if (!this.notified.ctx.has(id)) {
          this.notified.ctx.add(id);
          vscode.window.showWarningMessage(`上下文已用 ${fmtPct(s.context.pct)}（${fmtTok(s.context.used)} / ${fmtTok(s.context.window)}）。可以在任务的自然断点 /compact，或开新会话。`);
        }
      } else if (s.context.pct < cfg.contextWarn) this.notified.ctx.delete(id); // compacted: announce again next time
    }
    if (cfg.notifyCache && s.cache && s.state.kind === 'waiting' && left > 0 && left <= 60000 && this.notified.cache.get(id) !== s.cache.expiresAt) {
      this.notified.cache.set(id, s.cache.expiresAt);
      vscode.window.showInformationMessage('提示缓存不到 1 分钟就过期了。现在继续对话可以续期；过期后下一次请求要重新写入缓存，费用更高。');
    }
  }

  showError(e) {
    const msg = e && e.message ? e.message : String(e);
    this.put(this.items.state, 'text', '$(warning) CC Pulse');
    this.put(this.items.state, 'tooltip', 'CC Pulse 出错：' + msg);
    this.items.state.show();
    console.error('[cc-pulse]', e);
  }

  mediaUri() {
    return vscode.Uri.joinPath(this.context.extensionUri, 'media');
  }

  html(webview, scripts) {
    const media = this.mediaUri();
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = scripts.map((s) => `<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, s))}"></script>`).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div>${js}</body></html>`;
  }

  // ---- request log: shown in the sidebar and, at full width, in an editor tab.
  // Each place keeps its own query (scope, sort, page); `logTargets` maps place -> { webview, visible, q }.

  setLogQuery(key, webview, visible, q) {
    this.logTargets.set(key, { webview, visible, q });
    this.postLog();
  }

  postLog() {
    const all = [...this.states.values()];
    const st = this.current && this.states.get(this.current);
    const sessionTitle = st ? st.title || st.firstPrompt : null;
    const opts = { timeZone: this.cfg().timeZone, now: Date.now() };
    for (const t of this.logTargets.values()) {
      if (!t.visible()) continue;
      const res = stats.requestLog(all, { ...t.q, session: this.current }, opts);
      t.webview.postMessage({ type: 'log', ...res, sessionTitle, now: Date.now() });
    }
  }

  openLog() {
    if (this.logPanel) {
      this.logPanel.reveal();
      return;
    }
    const p = vscode.window.createWebviewPanel('ccPulse.log', 'CC Pulse 请求日志', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.mediaUri()],
    });
    p.webview.html = this.html(p.webview, ['log.js', 'log-page.js']);
    p.webview.onDidReceiveMessage((m) => {
      if (m && m.type === 'query') this.setLogQuery('editor', p.webview, () => p.visible, m.q);
    });
    p.onDidChangeViewState(() => this.postLog());
    p.onDidDispose(() => {
      this.logPanel = null;
      this.logTargets.delete('editor');
    });
    this.logPanel = p;
  }

  // ---- sidebar

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.mediaUri()] };
    view.webview.html = this.html(view.webview, ['log.js', 'panel.js']);
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.type === 'ready') {
        this.setRange(m.range);
        this.pushAll();
      } else if (m && m.type === 'range') this.setRange(m.range);
      else if (m && m.type === 'refresh') this.fullRescan();
      else if (m && m.type === 'openLog') this.openLog();
      else if (m && m.type === 'pick') this.pickSession();
      else if (m && m.type === 'query') this.setLogQuery('sidebar', view.webview, () => view.visible, m.q);
    });
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.pushAll();
      this.postLog();
    });
    view.onDidDispose(() => {
      this.view = null;
      this.logTargets.delete('sidebar');
    });
  }

  pushAll() {
    const now = Date.now();
    if (this.session) this.post({ type: 'session', s: this.session, now, cfg: this.viewCfg(this.cfg()) });
    if (this.global) this.post({ type: 'global', ...this.global, now });
  }

  post(msg) {
    if (this.view && this.view.visible) this.view.webview.postMessage(msg);
  }
}

let pulse = null;

function activate(context) {
  pulse = new Pulse(context);
}

// Flush what changed since the last periodic save.
function deactivate() {
  return pulse && pulse.saveCaches();
}

module.exports = { activate, deactivate };
