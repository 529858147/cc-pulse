'use strict';
// Aggregations over parsed transcripts. Pure functions of FileState objects plus options.
const path = require('path');
const { requestCost } = require('./pricing');
const { sessionFileOf } = require('./core');

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

const ONE_MILLION = 1000000;
// Gap between requests that still counts as continuous activity.
const ACTIVE_GAP_MS = 5 * 60000;
// A session whose last event says "working" but which has written nothing for this long was
// interrupted (window closed, process killed) rather than still working.
const STALE_MS = 30 * 60000;

function emptyTokens() {
  // dur / sout: seconds and output tokens of the requests whose duration is known, for a weighted average speed.
  return { in: 0, cr: 0, cw: 0, out: 0, think: 0, reqs: 0, cost: 0, unpriced: 0, dur: 0, sout: 0 };
}
function addTokens(t, r) {
  const dur = r.sendTs ? (r.endTs - r.sendTs) / 1000 : null;
  if (dur !== null && dur >= 0.5 && r.out > 0) {
    t.dur += dur;
    t.sout += r.out;
  }
  t.in += r.in;
  t.cr += r.cr;
  t.cw += r.cw;
  t.out += r.out;
  t.think += r.think;
  t.reqs++;
  const c = requestCost(r);
  if (c === null) t.unpriced++;
  else t.cost += c;
}
function totalOf(t) {
  return t.in + t.cr + t.cw + t.out;
}
/** Share of prompt tokens served from cache. */
function hitRate(t) {
  const p = t.in + t.cr + t.cw;
  return p ? t.cr / p : null;
}
function maxOf(xs) {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return m;
}

function resolveWindow(model, maxSeen, windows) {
  let best = '';
  for (const k of Object.keys(windows)) if (k !== 'default' && model && model.startsWith(k) && k.length > best.length) best = k;
  const win = best ? windows[best] : windows.default || 200000;
  // A request larger than the configured window means the session runs with the 1M window.
  return maxSeen > win ? Math.max(win, ONE_MILLION) : win;
}

function mainRequests(st) {
  return [...st.reqs.values()].filter((r) => !r.side).sort((a, b) => a.startTs - b.startTs);
}

/** working: Claude is generating or running a tool; waiting: its turn is over; idle: nothing recent. */
function sessionState(st, now) {
  const { kind, ts } = st.last;
  if (!kind) return { kind: 'idle', since: st.mtimeMs };
  if (kind === 'answer') return { kind: 'waiting', since: ts };
  if (now - Math.max(ts, st.mtimeMs) > STALE_MS) return { kind: 'idle', since: ts };
  return { kind: kind === 'tool' ? 'tool' : 'generating', since: ts };
}

/** Prompt cache of the main conversation: TTL of the last request and when it lapses without a new request. */
function cacheState(main) {
  for (let i = main.length - 1; i >= 0; i--) {
    if (main[i].ttl) {
      const last = main[main.length - 1];
      return { ttl: main[i].ttl, expiresAt: last.endTs + main[i].ttl * 1000 };
    }
  }
  return null;
}

function activeMs(reqs) {
  const iv = reqs.map((r) => [r.sendTs || r.startTs, r.endTs]).filter(([a, b]) => a && b >= a).sort((x, y) => x[0] - y[0]);
  let sum = 0;
  let cur = null;
  for (const [a, b] of iv) {
    if (cur && a - cur[1] <= ACTIVE_GAP_MS) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) sum += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) sum += cur[1] - cur[0];
  return sum;
}

function sessionStats(st, subStates, windows, now) {
  const main = mainRequests(st);
  const speeds = [];
  const speedPts = []; // the same speeds with what the chart tooltip shows
  let outSum = 0;
  let durSum = 0;
  const ctxSeries = main.map((r) => r.in + r.cr + r.cw);
  // One point per request; `c` marks a point right after a compaction, where the context shrinks.
  let prevEnd = 0;
  const ctxPts = main.map((r) => {
    const pt = { t: r.endTs, used: r.in + r.cr + r.cw, model: r.model, c: st.compactTs.some((c) => c > prevEnd && c <= r.startTs) };
    prevEnd = r.endTs;
    return pt;
  });
  const last = main[main.length - 1];
  const window = resolveWindow(last && last.model, maxOf(ctxSeries), windows);
  for (const r of main) {
    const dur = r.sendTs ? (r.endTs - r.sendTs) / 1000 : null;
    const ok = dur !== null && dur >= 0.5 && r.out > 0;
    if (ok) {
      speeds.push(r.out / dur);
      speedPts.push({ t: r.endTs, v: r.out / dur, out: r.out, dur, model: r.model, effort: r.effort });
      outSum += r.out;
      durSum += dur;
    }
  }
  const tok = emptyTokens();
  for (const r of main) addTokens(tok, r);
  const sub = emptyTokens();
  for (const s of subStates) for (const r of s.reqs.values()) addTokens(sub, r);
  const used = last ? last.in + last.cr + last.cw : 0;
  const lastDur = last && last.sendTs ? (last.endTs - last.sendTs) / 1000 : null;
  return {
    sessionId: path.basename(st.file, '.jsonl'),
    title: st.title || st.firstPrompt,
    project: path.basename(path.dirname(st.file)),
    model: last ? last.model : null,
    effort: last ? last.effort : null,
    lastActivity: last ? last.endTs : st.mtimeMs,
    state: sessionState(st, now),
    cache: cacheState(main),
    speed: {
      latest: lastDur && lastDur >= 0.5 && last.out > 0 ? last.out / lastDur : speeds.length ? speeds[speeds.length - 1] : null,
      avg: durSum ? outSum / durSum : null,
      peak: speeds.length ? maxOf(speeds) : null,
      avgLatency: speeds.length ? durSum / speeds.length : null,
      samples: speeds.length,
      series: speedPts.slice(-40),
    },
    tokens: tok,
    sub,
    hit: hitRate(tok),
    lastHit: last ? hitRate(last) : null,
    lastCw: last ? last.cw : 0,
    context: { used, window, pct: window ? used / window : null, series: ctxPts.slice(-60), compactions: st.compactions },
    turns: st.turns,
    steps: main.length,
    activeMs: activeMs(main),
  };
}

/**
 * Project of a session: the `coke.sh run` target it used most, else the folder under one of
 * `projectRoots` it touched most, else the folder it was started in.
 */
function projectOf(st, projectRoots) {
  let best = null;
  let bestN = 0;
  for (const [p, n] of st.cokeProjects) if (n > bestN) [best, bestN] = [p, n];
  if (best) return best;
  const hits = new Map();
  for (const [dir, n] of st.dirs) {
    for (const root of projectRoots) {
      const rel = path.relative(root, dir);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const seg = rel.split(path.sep)[0];
      if (!seg.startsWith('.')) hits.set(seg, (hits.get(seg) || 0) + n);
    }
  }
  for (const [p, n] of hits) if (n > bestN) [best, bestN] = [p, n];
  if (best) return best;
  return st.cwd ? path.basename(st.cwd) || st.cwd : path.basename(path.dirname(st.file));
}

function makeTime(timeZone) {
  const tz = timeZone || undefined;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    day: (ms) => day.format(ms), // YYYY-MM-DD
    hourWeekday(ms) {
      let h = 0;
      let w = 0;
      for (const p of parts.formatToParts(ms)) {
        if (p.type === 'hour') h = Number(p.value) % 24;
        else if (p.type === 'weekday') w = WD[p.value];
      }
      return [h, w];
    },
  };
}

function topN(map, n, valueOf = (v) => v) {
  return [...map.entries()]
    .map(([k, v]) => ({ name: k, value: valueOf(v), raw: v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

/** Tokens, cost and cache hit rate of today and this week over every session, plus today per model. */
function usageSummary(states, timeZone, now) {
  const inToday = resolveRange(timeZone, now, 'today').test;
  const inWeek = resolveRange(timeZone, now, 'week').test;
  const horizon = now - 8 * 86400000; // the week started at most 7 days (plus zone offset) ago
  const today = emptyTokens();
  const week = emptyTokens();
  const models = new Map();
  for (const st of states) {
    for (const r of st.reqs.values()) {
      if (r.startTs < horizon || !inWeek(r.startTs)) continue;
      addTokens(week, r);
      if (!inToday(r.startTs)) continue;
      addTokens(today, r);
      const m = models.get(r.model) || emptyTokens();
      addTokens(m, r);
      models.set(r.model, m);
    }
  }
  const fin = (t) => ({ ...t, total: totalOf(t), hit: hitRate(t) });
  return {
    today: fin(today),
    week: fin(week),
    models: [...models].map(([model, t]) => ({ model, total: totalOf(t), cost: t.cost })).sort((a, b) => b.total - a.total),
  };
}

/** One line of the session picker: title, project, size and recency. */
function sessionBrief(st, subs, projectRoots, now) {
  const t = emptyTokens();
  for (const s of [st, ...subs]) for (const r of s.reqs.values()) addTokens(t, r);
  const main = mainRequests(st);
  const last = main[main.length - 1];
  return {
    file: st.file,
    title: st.title || st.firstPrompt || '(无标题)',
    project: projectOf(st, projectRoots),
    total: totalOf(t),
    cost: t.cost,
    lastActivity: last ? last.endTs : st.mtimeMs,
    state: sessionState(st, now).kind,
  };
}

/** Rankings, totals and the session list over every transcript still on disk. */
function globalInsights(states, opts, now) {
  const time = makeTime(opts.timeZone);
  const range = resolveRange(opts.timeZone, now, opts.range);
  const inRange = range.test;
  const bySession = new Map(); // main file -> { st, subs: [] }
  for (const st of states) {
    const key = st.isSub ? sessionFileOf(st.file) : st.file;
    if (!bySession.has(key)) bySession.set(key, { st: null, subs: [] });
    if (st.isSub) bySession.get(key).subs.push(st);
    else bySession.get(key).st = st;
  }
  const total = emptyTokens();
  const tools = new Map();
  const cmds = new Map(); // lower-case key -> { name, n }
  const skills = new Map();
  const projects = new Map(); // name -> { tokens, sessions }
  const heatReq = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const heatTok = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let toolCalls = 0;
  let active = 0;
  let activeTotal = 0;
  let earliest = Infinity;
  const sessions = [];
  for (const [, { st, subs }] of bySession) {
    const all = [st, ...subs].filter(Boolean);
    const t = emptyTokens();
    for (const s of all) {
      for (const r of s.reqs.values()) {
        if (r.startTs) earliest = Math.min(earliest, r.startTs);
        if (!inRange(r.startTs)) continue;
        addTokens(t, r);
        if (r.startTs) {
          const [h, w] = time.hourWeekday(r.startTs);
          heatReq[w][h]++;
          heatTok[w][h] += totalOf(r);
        }
      }
      for (const [ts, kind, name] of s.uses) {
        if (!inRange(ts)) continue;
        if (kind === 'tool') {
          bump(tools, name);
          toolCalls++;
        } else if (kind === 'skill') bump(skills, name);
        else {
          const lk = name.toLowerCase();
          const e = cmds.get(lk) || { name, n: 0 };
          e.n++;
          cmds.set(lk, e);
        }
      }
    }
    for (const k of ['in', 'cr', 'cw', 'out', 'think', 'reqs', 'cost', 'unpriced']) total[k] += t[k];
    if (!st) continue; // subagent files whose main session file is gone
    const state = sessionState(st, now);
    const lastTs = Math.max(st.mtimeMs, st.last.ts);
    // "Active now" describes the present, so it ignores the selected range.
    if (state.kind !== 'idle' && now - lastTs < STALE_MS) active++;
    if (!t.reqs && range.key !== 'all') continue; // no request of this session falls in the range
    const main = mainRequests(st).filter((r) => inRange(r.startTs));
    const act = activeMs(main);
    activeTotal += act;
    const project = projectOf(st, opts.projectRoots);
    const pe = projects.get(project) || { tokens: 0, sessions: 0 };
    pe.tokens += totalOf(t);
    pe.sessions++;
    projects.set(project, pe);
    const lastReq = main[main.length - 1];
    sessions.push({
      id: path.basename(st.file, '.jsonl'),
      title: st.title || st.firstPrompt || '(无标题)',
      project,
      model: lastReq ? lastReq.model : null,
      total: totalOf(t),
      cost: t.cost,
      hit: hitRate(t),
      turns: st.promptTs.filter(inRange).length,
      reqs: t.reqs,
      state: state.kind,
      lastActivity: lastTs,
      activeMs: act,
    });
  }
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return {
    range: range.key,
    since: Number.isFinite(earliest) ? earliest : null,
    totals: { ...total, total: totalOf(total), hit: hitRate(total) },
    sessionCount: sessions.length,
    activeSessions: active,
    toolCalls,
    activeMs: activeTotal,
    heat: { reqs: heatReq, tokens: heatTok },
    projects: topN(projects, 12, (v) => v.tokens).map((x) => ({ name: x.name, value: x.value, sessions: x.raw.sessions })),
    skills: topN(skills, 12),
    tools: topN(tools, 12),
    cmds: [...cmds.values()].sort((a, b) => b.n - a.n).slice(0, 12).map((e) => ({ name: e.name, value: e.n })),
    sessions,
  };
}

/** day -> model -> token totals, for every request still on disk. */
function dailyByModel(states, timeZone) {
  const time = makeTime(timeZone);
  const out = {};
  for (const st of states) {
    for (const r of st.reqs.values()) {
      if (!r.startTs) continue;
      const d = time.day(r.startTs);
      const m = r.model || 'unknown';
      if (!out[d]) out[d] = {};
      const t = out[d][m] || (out[d][m] = emptyTokens());
      addTokens(t, r);
      // Per-effort breakdown of the same totals; days stored before effort was tracked have none.
      const eff = t.eff || (t.eff = {});
      addTokens(eff[r.effort || 'unknown'] || (eff[r.effort || 'unknown'] = emptyTokens()), r);
    }
  }
  return out;
}

const SOURCES = { cli: '终端', 'claude-vscode': 'VS Code' };
function sourceName(entrypoint) {
  if (!entrypoint) return '—';
  if (SOURCES[entrypoint]) return SOURCES[entrypoint];
  return entrypoint.startsWith('sdk') ? 'SDK' : entrypoint;
}
const LOG_SORT_KEYS = new Set(['t', 'src', 'model', 'effort', 'cost', 'in', 'cw', 'out', 'cr', 'hit', 'speed']);
const LOG_PAGE_SIZES = [10, 50, 100];
/** Ascending order with missing values first, so they sink to the end of a descending sort. */
function compare(a, b) {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  return typeof a === 'string' ? a.localeCompare(b) : a - b;
}

/**
 * One page of the request log.
 * q: { scope: 'all' | 'session', range, session: main session file, sort, dir: 'asc' | 'desc', page, size }
 * opts: { timeZone, now } resolve q.range into calendar days.
 */
function requestLog(states, q, opts) {
  const inRange = resolveRange(opts.timeZone, opts.now, q.range).test;
  const titles = new Map();
  for (const st of states) if (!st.isSub) titles.set(st.file, st.title || st.firstPrompt || '(无标题)');
  const rows = [];
  for (const st of states) {
    const main = st.isSub ? sessionFileOf(st.file) : st.file;
    if (q.scope === 'session' && main !== q.session) continue;
    for (const r of st.reqs.values()) {
      if (!inRange(r.startTs)) continue;
      const dur = r.sendTs ? (r.endTs - r.sendTs) / 1000 : null;
      rows.push({
        t: r.startTs,
        src: sourceName(r.src) + (r.side || st.isSub ? ' · 子代理' : ''),
        model: r.model,
        effort: r.effort,
        cost: requestCost(r),
        in: r.in,
        cw: r.cw,
        out: r.out,
        cr: r.cr,
        hit: hitRate(r),
        speed: dur && dur >= 0.5 && r.out > 0 ? r.out / dur : null,
        session: titles.get(main) || '(会话记录已删除)',
        sessionId: path.basename(main, '.jsonl'),
      });
    }
  }
  const sort = LOG_SORT_KEYS.has(q.sort) ? q.sort : 't';
  const dir = q.dir === 'asc' ? 'asc' : 'desc';
  const sign = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => sign * compare(a[sort], b[sort]) || b.t - a.t);
  const size = LOG_PAGE_SIZES.includes(q.size) ? q.size : 50;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, Math.floor(q.page) || 1), pages);
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length, page, pages, size, sort, dir, scope: q.scope === 'session' ? 'session' : 'all' };
}

const RANGE_KEYS = ['today', 'week', 'last', 'd30', 'all'];

/** YYYY-MM-DD `n` days after the given day key (day keys are already in the configured time zone). */
function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Calendar keys the panel needs: today, Monday of this week, this month, and the inclusive day
 * range of each preset (today, this week from Monday, last week, the last 30 days incl. today).
 * `all` has no bounds.
 */
function calendarKeys(timeZone, now) {
  const time = makeTime(timeZone);
  const today = time.day(now);
  const [, w] = time.hourWeekday(now);
  const weekStart = addDays(today, -w);
  return {
    today,
    weekStart,
    month: today.slice(0, 7),
    ranges: {
      today: { from: today, to: today },
      week: { from: weekStart, to: today },
      last: { from: addDays(weekStart, -7), to: addDays(weekStart, -1) },
      d30: { from: addDays(today, -29), to: today },
      all: null,
    },
  };
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const isRangeKey = (key) => RANGE_KEYS.includes(key) || MONTH_KEY.test(key);

/** A preset (today, week, last, d30, all) or a calendar month 'YYYY-MM'. */
function rangeOf(timeZone, now, key) {
  if (MONTH_KEY.test(key)) {
    const [y, m] = key.split('-').map(Number);
    return { from: key + '-01', to: key + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0') };
  }
  return RANGE_KEYS.includes(key) ? calendarKeys(timeZone, now).ranges[key] : null;
}

/** `test(ms)` tells whether a timestamp falls in the range; an unknown key means `all`. */
function resolveRange(timeZone, now, key) {
  const r = rangeOf(timeZone, now, key);
  if (!r) return { key: 'all', test: () => true };
  const time = makeTime(timeZone);
  return {
    key,
    test(ts) {
      if (!ts) return false;
      const d = time.day(ts);
      return d >= r.from && d <= r.to;
    },
  };
}

module.exports = { RANGE_KEYS, isRangeKey, usageSummary, sessionBrief, sessionStats, sessionState, globalInsights, dailyByModel, calendarKeys, requestLog, totalOf, hitRate };
