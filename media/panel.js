// CC Pulse sidebar. Receives { type: 'session' | 'global' } messages from the extension and renders four tabs.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ui = Object.assign({ tab: 'session', q: '', sort: 'recent', heat: 'reqs', range: 'week', gran: 'day', year: null, day: null, log: null }, vscode.getState() || {});
  // Request log at the bottom of the "模型用量" tab; it keeps its own page and re-attaches after each re-render.
  const log = window.RequestLog(vscode, ui.log, (q) => ((ui.log = q), vscode.setState(ui)), { size: 10, scope: 'all', compact: true, hostRange: true });
  const RANGES = window.CCP_RANGES;
  const isMonthRange = (r) => /^\d{4}-\d{2}$/.test(r);
  const rangeLabel = (k) => (isMonthRange(k) ? k : (RANGES.find((r) => r[0] === k) || [])[1] || '');
  let S = null; // current session stats
  let G = null; // { g, daily, cal }
  let cfg = { contextWarn: 0.7, contextAlert: 0.85, cacheWarnMinutes: 10 };
  // Timestamps come from the remote machine's clock; the webview runs on the local one.
  let skew = 0;
  const now = () => Date.now() + skew;
  const save = () => vscode.setState(ui);

  // ---------- formatting
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const tok = (n) => {
    if (n == null) return '—';
    const a = Math.abs(n);
    return a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
  };
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
  const num = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
  const usd = (x) => (x == null ? '—' : x > 0 && x < 0.01 ? '<$0.01' : '$' + x.toFixed(2));
  const usd3 = (x) => (x == null ? '—' : x > 0 && x < 0.001 ? '<$0.001' : '$' + x.toFixed(3));
  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + '秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + '分' + (s % 60) + '秒';
    return Math.floor(m / 60) + '小时' + (m % 60) + '分';
  };
  const hours = (ms) => (ms >= 3600000 ? (ms / 3600000).toFixed(1) + ' 小时' : Math.round(ms / 60000) + ' 分钟');
  const ago = (ts) => {
    const m = Math.round((now() - ts) / 60000);
    return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前';
  };
  function modelName(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|-|\[)/.exec(id || '');
    if (!m) return id || '—';
    return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
  }
  const total = (t) => t.in + t.cr + t.cw + t.out;
  const hitOf = (t) => {
    const p = t.in + t.cr + t.cw;
    return p ? t.cr / p : null;
  };
  function sumT(list) {
    const o = { in: 0, cr: 0, cw: 0, out: 0, think: 0, reqs: 0, cost: 0, unpriced: 0, dur: 0, sout: 0 };
    for (const t of list) for (const k in o) o[k] += t[k] || 0;
    return o;
  }

  const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
  /** Per-effort totals of a list of day/model entries; what the history has no effort for is returned as 'unknown'. */
  function effortTotals(list) {
    const all = sumT(list);
    const by = {};
    for (const t of list) for (const [e, x] of Object.entries(t.eff || {})) by[e] = sumT([by[e] || sumT([]), x]);
    const known = sumT(Object.values(by));
    const rest = {};
    for (const k in all) rest[k] = all[k] - known[k];
    if (rest.reqs > 0) by.unknown = rest;
    return Object.entries(by).sort((a, b) => (EFFORT_ORDER.indexOf(a[0]) + 1 || 99) - (EFFORT_ORDER.indexOf(b[0]) + 1 || 99));
  }

  const C = ['var(--vscode-charts-blue)', 'var(--vscode-charts-purple)', 'var(--vscode-charts-green)', 'var(--vscode-charts-orange)', 'var(--vscode-charts-yellow)', 'var(--vscode-charts-red)', 'var(--vscode-foreground)'];
  const TT = [
    ['cr', '缓存读取', 'var(--vscode-charts-blue)'],
    ['in', '未缓存输入', 'var(--vscode-charts-yellow)'],
    ['cw', '缓存写入', 'var(--vscode-charts-orange)'],
    ['out', '输出', 'var(--vscode-charts-green)'],
  ];
  const STATE = { generating: '生成中', tool: '执行工具', waiting: '等你回复', idle: '空闲' };

  // ---------- small building blocks
  const card = (k, v, sub, cls = '') => `<div class="card ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const kv = (pairs) => `<div class="kv">${pairs.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>`;
  function stackBar(t) {
    const all = total(t) || 1;
    const seg = (k, n) => tips.push(tipHtml(n, t[k].toLocaleString() + ' tokens', `占 ${pct(t[k] / all)}`)) - 1;
    return `<div class="bar">${TT.map(([k, n, c]) => `<i data-tip="${seg(k, n)}" style="width:${(t[k] / all) * 100}%;background:${c}"></i>`).join('')}</div>
      <div class="legend">${TT.map(([k, n, c]) => `<span><i style="background:${c}"></i>${n} ${pct(t[k] / all)}</span>`).join('')}</div>`;
  }
  /**
   * Line chart over pts [{ v, tip, mark }]: Y axis with grid lines, optional dashed reference lines
   * (refs: [{ v, color, label }]), a dot and tooltip per point, and a vertical line at points with `mark`.
   */
  function lineChart({ pts, yMax, fmt, refs = [], xLabels = ['', ''], h = 96 }) {
    if (pts.length < 2) return '<div class="sub">数据不足</div>';
    const L = 30;
    const R = 4;
    const y0 = 6;
    const base = h - 12;
    const step = (300 - L - R) / (pts.length - 1);
    const xOf = (i) => L + i * step;
    const yOf = (v) => base - (Math.min(v, yMax) / yMax) * (base - y0);
    let out = '';
    for (const v of [0, yMax / 2, yMax]) out += `<line class="grid ${v ? 'dash' : ''}" x1="${L}" x2="300" y1="${yOf(v)}" y2="${yOf(v)}"/><text x="${L - 5}" y="${yOf(v) + 3}" text-anchor="end">${fmt(v)}</text>`;
    for (const r of refs) if (r.v > 0 && r.v < yMax) out += `<line class="ref" x1="${L}" x2="300" y1="${yOf(r.v)}" y2="${yOf(r.v)}" stroke="${r.color}"/><text x="300" y="${yOf(r.v) - 2}" text-anchor="end" style="fill:${r.color}">${esc(r.label)}</text>`;
    const line = pts.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
    out += `<polygon points="${xOf(0)},${base} ${line} ${xOf(pts.length - 1)},${base}" fill="var(--accent)" fill-opacity="0.12"/><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    pts.forEach((p, i) => {
      if (p.mark) out += `<line class="mark" x1="${xOf(i)}" x2="${xOf(i)}" y1="${y0}" y2="${base}"/>`;
      const x = Math.max(L, xOf(i) - step / 2);
      const w = Math.min(300, xOf(i) + step / 2) - x;
      out += `<g class="pt"><rect class="hit" data-tip="${tips.push(p.tip) - 1}" x="${x}" y="${y0}" width="${w}" height="${base - y0}"/><circle cx="${xOf(i)}" cy="${yOf(p.v)}" r="2.6"/></g>`;
    });
    out += `<text x="${L}" y="${h}" text-anchor="start">${esc(xLabels[0])}</text><text x="${300 - R}" y="${h}" text-anchor="end">${esc(xLabels[1])}</text>`;
    return `<svg viewBox="0 0 300 ${h}" style="height:${h}px">${out}</svg>`;
  }
  /** Round the axis maximum up to 1, 2 or 5 times a power of ten. */
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => n <= x + 1e-9) || 10) * p;
  }
  /** cols: [{ label, tip, parts: [{ v, c }] }]; draws grid lines with a Y axis and a hover target per column. */
  function bars(cols, h = 90) {
    const top = niceMax(Math.max(1, ...cols.map((c) => c.parts.reduce((a, p) => a + p.v, 0))));
    const L = 30;
    const y0 = 6;
    const base = h - 12;
    const yOf = (v) => base - (v / top) * (base - y0);
    const w = (300 - L) / cols.length;
    const bw = Math.min(w * 0.64, 24); // a lone column should not stretch across the whole chart
    const every = Math.ceil(cols.length / 8);
    let out = '';
    for (const v of [0, top / 2, top]) out += `<line class="grid ${v ? 'dash' : ''}" x1="${L}" x2="300" y1="${yOf(v)}" y2="${yOf(v)}"/><text x="${L - 5}" y="${yOf(v) + 3}" text-anchor="end">${tok(v)}</text>`;
    cols.forEach((col, i) => {
      let y = base;
      for (const p of col.parts) {
        const ph = (p.v / top) * (base - y0);
        if (ph <= 0) continue;
        y -= ph;
        out += `<rect x="${L + i * w + (w - bw) / 2}" y="${y}" width="${bw}" height="${ph}" fill="${p.c}"/>`;
      }
      if (i % every === 0) out += `<text x="${L + i * w + w / 2}" y="${h}" text-anchor="middle">${esc(col.label)}</text>`;
      if (col.tip) out += `<rect class="hit" data-tip="${tips.push(col.tip) - 1}" x="${L + i * w}" y="${y0}" width="${w}" height="${base - y0}"/>`;
    });
    return `<svg viewBox="0 0 300 ${h}" style="height:${h}px">${out}</svg>`;
  }
  function rank(title, items, fmt, extra) {
    if (!items.length) return `<section class="rank"><h3>${title}</h3><div class="sub">暂无</div></section>`;
    const max = items[0].value || 1;
    return `<section class="rank"><h3>${title}<span>${extra || ''}</span></h3>${items
      .map((x) => `<div class="row"><span class="n" title="${esc(x.name)}">${esc(x.name)}</span><span class="c">${fmt(x)}</span><div class="bar"><i style="width:${(x.value / max) * 100}%;background:var(--vscode-charts-blue)"></i></div></div>`)
      .join('')}</section>`;
  }
  const level = (p) => (p >= cfg.contextAlert ? 'alert' : p >= cfg.contextWarn ? 'warn' : '');
  /** Progress ring; the circle has circumference 100 so the dash length is the percentage. */
  const donut = (p) => `<svg class="donut" viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15.9155"/><circle class="fg" cx="18" cy="18" r="15.9155" stroke-dasharray="${(Math.min(1, p || 0) * 100).toFixed(1)} 100"/></svg>`;

  // ---------- hover card: per-model breakdown of a day / week / month
  const tips = []; // tooltip data of the chart columns drawn in the current render, indexed by data-tip
  let colorFor = null;
  let colorOrder = [];
  /** One stable colour per model (largest overall first), shared by charts, legends and tooltips. */
  function modelColor(m) {
    if (colorFor !== G.daily) {
      const sum = {};
      for (const day of Object.values(G.daily)) for (const [mm, t] of Object.entries(day)) sum[mm] = (sum[mm] || 0) + total(t);
      colorOrder = Object.keys(sum).sort((a, b) => sum[b] - sum[a]);
      colorFor = G.daily;
    }
    return C[Math.max(0, colorOrder.indexOf(m)) % C.length];
  }
  function tipOf(title, keys) {
    const by = {};
    let reqs = 0;
    for (const k of keys) for (const [m, t] of Object.entries(G.daily[k] || {})) ((by[m] = (by[m] || 0) + total(t)), (reqs += t.reqs));
    const sum = Object.values(by).reduce((a, b) => a + b, 0);
    return { title, sum, reqs, items: Object.entries(by).sort((a, b) => b[1] - a[1]).map(([m, v]) => ({ name: modelName(m), color: modelColor(m), v })) };
  }
  const tipEl = document.createElement('div');
  tipEl.id = 'tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  let tipKey = null;
  function showTip(el, e) {
    const key = el.dataset.tip !== undefined ? 't' + el.dataset.tip : 'd' + el.dataset.day;
    if (key !== tipKey) {
      const t = el.dataset.tip !== undefined ? tips[Number(el.dataset.tip)] : G && tipOf(el.dataset.day, [el.dataset.day]);
      if (!t) return hideTip();
      tipKey = key;
      if (t.html) tipEl.innerHTML = t.html;
      else tipEl.innerHTML = `<div class="d">${esc(t.title)}</div><div class="n">${t.sum.toLocaleString()} Token</div><div class="d">${t.reqs} 次请求</div>` +
        (t.items.length ? `<div class="m">${t.items.map((x) => `<i style="background:${x.color}"></i><span>${esc(x.name)}</span><span>${tok(x.v)}</span><span>${pct(t.sum ? x.v / t.sum : 0)}</span>`).join('')}</div>` : '');
    }
    tipEl.hidden = false;
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    const x = Math.max(4, Math.min(e.clientX + 12, window.innerWidth - w - 4));
    const y = e.clientY + 16 + h > window.innerHeight ? Math.max(4, e.clientY - h - 12) : e.clientY + 16;
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  }
  const tipHtml = (title, big, ...lines) => ({ html: `<div class="d">${title}</div><div class="n">${big}</div>${lines.map((l) => `<div class="d">${l}</div>`).join('')}` });
  const clock = (t, sec) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined });
  function hideTip() {
    tipEl.hidden = true;
    tipKey = null;
  }

  // ---------- tab: current session
  function cacheText(s) {
    if (!s.cache) return '—';
    const left = s.cache.expiresAt - now();
    const tier = s.cache.ttl >= 3600 ? '1 小时档' : '5 分钟档';
    if (s.state.kind === 'generating' || s.state.kind === 'tool') return `${tier} · 请求中，自动续期`;
    return left > 0 ? `${tier} · 剩 <b data-expire="${s.cache.expiresAt}">${dur(left)}</b>` : `${tier} · 已过期`;
  }
  function renderSession() {
    const s = S;
    if (!s) return '<div class="empty">还没有找到 Claude Code 会话记录</div>';
    const working = s.state.kind === 'generating' || s.state.kind === 'tool';
    const left = s.cache ? s.cache.expiresAt - now() : null;
    const cacheCls = !working && left !== null && left > 0 && left <= cfg.cacheWarnMinutes * 60000 ? 'warn' : '';
    const t = sumT([s.tokens, s.sub]);
    return `
      <div class="head"><div class="t" title="${esc(s.sessionId)}">${esc(s.title || s.sessionId)}</div>
        <div class="sub">${esc(modelName(s.model))} · <span class="badge ${s.state.kind}">${STATE[s.state.kind]}${working ? ` <span data-since="${s.state.since}">${dur(now() - s.state.since)}</span>` : ''}</span> <button class="small" data-action="pick" title="${s.pinned ? '状态栏已固定在这个会话；选“自动”可恢复跟随' : '固定状态栏要跟踪的会话'}">${s.pinned ? '已固定 · 切换' : '切换会话'}</button></div></div>
      <div class="grid3">
        ${card('速度', `${num(s.speed.latest)}<small>tok/s</small>`, `平均 ${num(s.speed.avg)}`)}
        ${card('缓存命中', pct(s.hit), `<span id="cacheMini">${cacheText(s).replace(/<[^>]+>/g, '')}</span>`, cacheCls)}
        ${card('上下文', donut(s.context.pct) + pct(s.context.pct), `${tok(s.context.used)} / ${tok(s.context.window)}`, level(s.context.pct))}
      </div>
      <section><h3>速度<span>${s.speed.samples} 次采样</span></h3>
        ${lineChart({
          pts: s.speed.series.map((p) => ({ v: p.v, tip: tipHtml(clock(p.t, true), `${num(p.v)} tok/s`, esc(modelName(p.model)) + (p.effort ? ' · ' + esc(p.effort) : ''), `输出 ${p.out.toLocaleString()} token · 用时 ${num(p.dur)} 秒`) })),
          yMax: niceMax(Math.max(1, ...s.speed.series.map((p) => p.v))),
          fmt: (v) => String(Math.round(v)),
          refs: s.speed.avg ? [{ v: s.speed.avg, color: 'var(--muted)', label: `平均 ${num(s.speed.avg, 0)}` }] : [],
          xLabels: s.speed.series.length ? [clock(s.speed.series[0].t), clock(s.speed.series[s.speed.series.length - 1].t)] : ['', ''],
        })}
        <div class="note">每个点是一次请求的输出速率（tok/s），共最近 ${s.speed.series.length} 次，悬停查看详情；虚线是会话平均。</div>
        ${kv([
          ['最新请求', num(s.speed.latest) + ' tok/s'],
          ['会话平均', num(s.speed.avg) + ' tok/s'],
          ['峰值', num(s.speed.peak) + ' tok/s'],
          ['平均请求耗时', num(s.speed.avgLatency) + ' s'],
          ['总输出（含思考）', tok(s.tokens.out)],
          ['活跃时长', hours(s.activeMs)],
        ])}
        <div class="note">速率 = 输出 token ÷ 请求总耗时（含等待首字的时间），会比纯解码速度低。</div></section>
      <section><h3>Token 用量<span>命中率 ${pct(hitOf(t))}</span></h3>
        <div class="card" style="border:0;padding:0;background:none"><div class="v">${total(t).toLocaleString()}<small>tokens</small></div></div>
        ${stackBar(t)}
        ${kv([
          ['缓存读取', tok(s.tokens.cr)],
          ['未缓存输入', tok(s.tokens.in)],
          ['缓存写入', tok(s.tokens.cw)],
          ['输出', tok(s.tokens.out)],
          ['子代理', `${tok(total(s.sub))} · ${s.sub.reqs} 次`],
          ['估算费用', usd(t.cost)],
        ])}
        <div class="note">缓存：<span id="cacheFull">${cacheText(s)}</span>。费用按 API 价格折算，仅供参考。</div></section>
      <section><h3>上下文窗口<span>${s.turns} 轮 · ${s.steps} 步</span></h3>
        <div class="bar"><i style="width:${Math.min(100, (s.context.pct || 0) * 100)}%;background:${level(s.context.pct) === 'alert' ? 'var(--alert)' : level(s.context.pct) === 'warn' ? 'var(--warn)' : 'var(--accent)'}"></i></div>
        ${lineChart({
          pts: s.context.series.map((p, i, a) => ({
            v: p.used,
            mark: p.c,
            tip: tipHtml(clock(p.t, true), `${tok(p.used)} / ${tok(s.context.window)}`, `占窗口 ${pct(p.used / s.context.window)}`, i ? `较上一次 ${p.used >= a[i - 1].used ? '+' : '−'}${tok(Math.abs(p.used - a[i - 1].used))}` : '本段的第一次请求', ...(p.c ? ['此前发生了自动压缩'] : [])),
          })),
          yMax: s.context.window,
          fmt: tok,
          refs: [
            { v: cfg.contextWarn * s.context.window, color: 'var(--warn)', label: pct(cfg.contextWarn) },
            { v: cfg.contextAlert * s.context.window, color: 'var(--alert)', label: pct(cfg.contextAlert) },
          ],
          xLabels: s.context.series.length ? [clock(s.context.series[0].t), clock(s.context.series[s.context.series.length - 1].t)] : ['', ''],
        })}
        <div class="note">每个点是一次请求发出时的上下文占用，悬停查看详情；黄色、红色虚线是提醒阈值，橙色竖线表示发生过自动压缩。</div>
        ${kv([
          ['已用 / 窗口', `${tok(s.context.used)} / ${tok(s.context.window)}`],
          ['自动压缩', s.context.compactions + ' 次'],
        ])}</section>`;
  }

  // ---------- tab: global insights
  function heatmap(m) {
    const max = Math.max(1, ...m.flat());
    const W = ['一', '二', '三', '四', '五', '六', '日'];
    let out = '';
    for (let w = 0; w < 7; w++) {
      out += `<text x="0" y="${w * 11 + 8}">${W[w]}</text>`;
      for (let h = 0; h < 24; h++) {
        const v = m[w][h];
        out += `<rect x="${12 + h * 12}" y="${w * 11}" width="10" height="9" rx="1.5" fill="${v ? 'var(--vscode-charts-blue)' : 'var(--track)'}" fill-opacity="${v ? 0.2 + 0.8 * (v / max) : 1}" data-tip="${tips.push(tipHtml(`周${W[w]} ${h}:00 – ${h + 1}:00`, ui.heat === 'reqs' ? v + ' 次请求' : tok(v) + ' tokens')) - 1}"/>`;
      }
    }
    for (const h of [0, 6, 12, 18, 23]) out += `<text x="${12 + h * 12 + 5}" y="88" text-anchor="middle">${h}</text>`;
    return `<svg viewBox="0 0 300 90" style="height:90px">${out}</svg>`;
  }
  /** YYYY-MM-DD n days before the given day key (day keys are already in the configured time zone). */
  function daysBefore(day, n) {
    return new Date(Date.parse(day + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  }
  function last7() {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(daysBefore(G.cal.today, i));
    return bars(
      days.map((d) => {
        const t = sumT(Object.values(G.daily[d] || {}));
        return { label: d.slice(5), tip: tipOf(d, [d]), parts: TT.map(([k, , c]) => ({ v: t[k], c })) };
      }),
    );
  }
  function sessionList() {
    const q = ui.q.trim().toLowerCase();
    let list = G.g.sessions.filter((x) => !q || (x.title + ' ' + x.project + ' ' + x.id).toLowerCase().includes(q));
    if (ui.sort === 'tokens') list = list.slice().sort((a, b) => b.total - a.total);
    else if (ui.sort === 'cost') list = list.slice().sort((a, b) => b.cost - a.cost);
    const rows = list
      .slice(0, 200)
      .map(
        (x) => `<div class="sess" title="${esc(x.id)}"><span class="t">${esc(x.title)}</span><span class="r">${tok(x.total)} · ${usd(x.cost)}</span>
        <span class="m">${esc(x.project)} · ${esc(modelName(x.model))} · <span class="badge ${x.state}">${STATE[x.state]}</span> · ${ago(x.lastActivity)}</span><span class="r">${x.turns} 轮 · ${pct(x.hit)}</span></div>`,
      )
      .join('');
    return `<h3>会话列表<span>${list.length} / ${G.g.sessions.length} · 用量为所选范围内</span></h3>${rows || '<div class="sub">没有匹配的会话</div>'}`;
  }
  function renderGlobalBody() {
    if (!G) return '<div class="empty">正在扫描会话记录…</div>';
    tips.length = 0;
    const g = G.g;
    const t = g.totals;
    return `
      <div class="sub srcnote">本机现存会话记录 · 始于 ${g.since ? new Date(g.since).toLocaleDateString('zh-CN') : '—'}（默认保留 30 天），不含已被 Claude Code 删除的</div>
      <div class="grid3">
        ${card('会话', g.sessionCount, `${g.activeSessions} 个活跃（此刻）`)}
        ${card('Token 消耗', tok(t.total), `${t.reqs.toLocaleString()} 次请求`)}
        ${card('估算费用', usd(t.cost), 'API 价格折算')}
        ${card('缓存命中率', pct(t.hit), `${tok(t.cr)} 读取`)}
        ${card('工具调用', g.toolCalls.toLocaleString(), `${t.reqs.toLocaleString()} 次模型调用`)}
        ${card('活跃时长', hours(g.activeMs), `${g.sessionCount} 个会话`)}
      </div>
      <section><h3>近 7 天用量<span>固定 7 天，不随范围 · ${tok(total(rangeTotal((d) => d > daysBefore(G.cal.today, 7) && d <= G.cal.today)))}</span></h3>${last7()}
        <div class="legend">${TT.map(([, n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')}</div></section>
      <section><h3>活跃度热力图<span class="seg"><button data-heat="reqs" class="${ui.heat === 'reqs' ? 'on' : ''}">请求数</button><button data-heat="tokens" class="${ui.heat === 'tokens' ? 'on' : ''}">Token</button></span></h3>
        ${heatmap(g.heat[ui.heat])}</section>
      <section><h3>Token 构成<span>${tok(t.total)}</span></h3>${stackBar(t)}</section>
      ${rank('项目分布', g.projects, (x) => `${tok(x.value)} · ${x.sessions} 会话`, `${g.projects.length} 个项目`)}
      ${rank('技能与斜杠命令', g.skills, (x) => x.value + ' 次', '/ 开头为手动输入的命令')}
      ${rank('工具调用', g.tools, (x) => x.value.toLocaleString() + ' 次')}
      ${rank('命令执行', g.cmds, (x) => x.value.toLocaleString() + ' 次', '“coke ▸” 为在 coke 上执行')}
      <section id="sessList">${sessionList()}</section>
      <div class="note">当前范围：${rangeLabel(g.range)}。数据来自仍保留在本机的 Claude Code 会话记录（最早 ${g.since ? new Date(g.since).toLocaleDateString('zh-CN') : '—'}，默认保留 30 天），更早的只有“每日活动”和“模型用量”里的汇总。</div>`;
  }
  function renderGlobal() {
    return `${rangeBar()}<div class="toolbar"><input id="q" placeholder="搜索会话标题 / 项目" value="${esc(ui.q)}">
      <select id="sort"><option value="recent">最近更新</option><option value="tokens">用量</option><option value="cost">费用</option></select>
      <button class="small" data-action="openLog" title="在编辑器中打开全部请求日志">请求日志</button>
      <button class="small" data-action="refresh" title="重新扫描全部会话记录">重新扫描</button></div><div id="gbody">${renderGlobalBody()}</div>`;
  }

  // ---------- tab: daily / weekly activity
  function dayTotal(d) {
    return sumT(Object.values((G && G.daily[d]) || {}));
  }
  function rangeTotal(pred) {
    return sumT(Object.keys(G.daily).filter(pred).map(dayTotal));
  }
  /** Day keys covered by a preset; "all" runs from the first recorded day to today. */
  function rangeDays(key) {
    let r = G.cal.ranges[key];
    if (isMonthRange(key)) {
      const [y, m] = key.split('-').map(Number);
      r = { from: key + '-01', to: key + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0') };
    }
    const from = r ? r.from : Object.keys(G.daily).sort()[0] || G.cal.today;
    const to = r ? r.to : G.cal.today;
    const out = [];
    for (let d = from; d <= to; d = daysBefore(d, -1)) out.push(d);
    return out;
  }
  const presetTotal = (key) => sumT(rangeDays(key).map(dayTotal));
  const monthsOf = () => {
    const ms = [...new Set(Object.keys(G.daily).map((d) => d.slice(0, 7)))];
    if (!ms.includes(G.cal.month)) ms.push(G.cal.month);
    return ms.sort();
  };
  /**
   * The one time-range control, shared by 全局洞察, 模型用量 and the request log under it:
   * a preset, or a calendar month ("按月") that gets prev/next buttons.
   */
  function rangeBar() {
    const cur = ui.range;
    const byMonth = isMonthRange(cur);
    const buttons = RANGES.map(([k, n]) => `<button data-range="${k}" class="${cur === k ? 'on' : ''}">${n}</button>`).join('') +
      (G ? `<button data-range="${byMonth ? cur : G.cal.month}" class="${byMonth ? 'on' : ''}">按月</button>` : '');
    let nav = '';
    if (byMonth && G) {
      const ms = monthsOf();
      const i = ms.indexOf(cur);
      nav = `<span class="nav"><button class="small" data-range="${ms[i - 1] || ''}" ${i > 0 ? '' : 'disabled'}>‹</button><b>${cur}</b><button class="small" data-range="${ms[i + 1] || ''}" ${i >= 0 && i < ms.length - 1 ? '' : 'disabled'}>›</button></span>`;
    }
    return `<div class="rangebar"><span class="seg">${buttons}</span>${nav}</div>`;
  }
  /** Chart granularities that make sense for a range of n days: not a monthly bar for one day, not hundreds of daily bars. */
  function granularities(n) {
    return n <= 7 ? ['day'] : n <= 31 ? ['day', 'week'] : n <= 92 ? ['day', 'week', 'month'] : ['week', 'month'];
  }

  function calendar(year) {
    const start = Date.UTC(year, 0, 1);
    const offset = (new Date(start).getUTCDay() + 6) % 7;
    const days = [];
    for (let ms = start; new Date(ms).getUTCFullYear() === year; ms += 86400000) days.push(new Date(ms).toISOString().slice(0, 10));
    const vals = days.map((d) => total(dayTotal(d))).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => vals[Math.floor((vals.length - 1) * p)] || 0;
    const th = [q(0.25), q(0.5), q(0.75)];
    const lvl = (v) => (v <= 0 ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4);
    const op = [1, 0.3, 0.5, 0.75, 1];
    let out = '';
    let lastMonth = -1;
    days.forEach((d, i) => {
      const col = Math.floor((i + offset) / 7);
      const row = (i + offset) % 7;
      const v = total(dayTotal(d));
      const l = lvl(v);
      const mo = Number(d.slice(5, 7));
      if (mo !== lastMonth && row === 0) {
        out += `<text x="${col * 12}" y="8">${mo}月</text>`;
        lastMonth = mo;
      }
      out += `<rect class="day ${d === ui.day ? 'sel' : ''}" data-day="${d}" x="${col * 12}" y="${12 + row * 12}" width="10" height="10" rx="2" fill="${l ? 'var(--vscode-charts-blue)' : 'var(--track)'}" fill-opacity="${op[l]}"></rect>`;
    });
    const width = (Math.floor((days.length + offset - 1) / 7) + 1) * 12;
    const wk = ['一', '', '三', '', '五', '', '日'].map((x) => `<span>${x}</span>`).join('');
    return `<div class="calwrap"><div class="calwk">${wk}</div><div class="scroll" id="calScroll"><svg viewBox="0 0 ${width} 98" style="width:${width}px;height:98px">${out}</svg></div></div>`;
  }
  function renderDays() {
    if (!G) return '<div class="empty">正在扫描会话记录…</div>';
    const { today, month } = G.cal;
    const all = Object.keys(G.daily).sort();
    const years = [...new Set(all.map((d) => Number(d.slice(0, 4))))];
    if (!years.includes(Number(today.slice(0, 4)))) years.push(Number(today.slice(0, 4)));
    const year = ui.year && years.includes(ui.year) ? ui.year : Number(today.slice(0, 4));
    const day = ui.day || today;
    const dt = dayTotal(day);
    const yearT = rangeTotal((d) => d.startsWith(String(year)));
    const models = Object.entries(G.daily[day] || {}).sort((a, b) => total(b[1]) - total(a[1]));
    const mo = rangeTotal((d) => d.startsWith(month));
    const cards = [...RANGES.map(([k, n]) => [k === 'all' ? '累计用量' : n + '用量', presetTotal(k)])];
    cards.splice(4, 0, ['本月用量', mo]);
    return `
      <div class="sub srcnote">累计历史 · 卡片是固定范围，不随其他页的范围切换</div>
      <div class="grid2">
        ${cards.map(([n, t]) => card(n, tok(total(t)), usd(t.cost))).join('')}
      </div>
      <section><h3><span class="nav"><button class="small" data-year="${year - 1}" ${years.includes(year - 1) ? '' : 'disabled'}>‹</button><b>${year}</b><button class="small" data-year="${year + 1}" ${years.includes(year + 1) ? '' : 'disabled'}>›</button></span><span>${tok(total(yearT))} tokens</span></h3>
        ${calendar(year)}
        <div class="legend"><span>少</span>${[0.3, 0.5, 0.75, 1].map((o) => `<span><i style="background:var(--vscode-charts-blue);opacity:${o}"></i></span>`).join('')}<span>多 · 点击格子查看当天</span></div></section>
      <section><h3>${day}<span>${dt.reqs} 次请求 · ${usd(dt.cost)}</span></h3>
        <div class="card" style="border:0;padding:0;background:none"><div class="v">${total(dt).toLocaleString()}<small>tokens · 命中 ${pct(hitOf(dt))}</small></div></div>
        ${models.length ? stackBar(dt) : ''}
        ${models.map(([m, t]) => `<div class="rank"><div class="row"><span class="n">${esc(modelName(m))}</span><span class="c">${tok(total(t))} · ${t.reqs} 次 · ${usd(t.cost)}</span></div></div>`).join('') || '<div class="sub">这一天没有记录</div>'}</section>
      <div class="foot"><span title="CC Pulse 每天保存一份按模型的汇总，Claude Code 删除旧会话记录后这里仍保留">已记录 ${presetTotal('all').reqs.toLocaleString()} 次请求 · 始于 ${all[0] || '—'}</span><span>${esc(G.cal.tz || '')} · 本地统计</span></div>`;
  }

  // ---------- tab: model usage
  function renderModels() {
    if (!G) return '<div class="empty">正在扫描会话记录…</div>';
    tips.length = 0;
    const byMonth = isMonthRange(ui.range);
    const days = rangeDays(ui.range);
    // The chosen granularity is kept in ui.gran, but only used where it fits this range.
    const allowed = granularities(days.length);
    const gran = allowed.includes(ui.gran) ? ui.gran : days.length > 31 ? 'week' : 'day';
    const per = {};
    for (const key of days) for (const [model, t] of Object.entries(G.daily[key] || {})) (per[model] = per[model] || []).push(t);
    const models = Object.keys(per).sort((a, b) => total(sumT(per[b])) - total(sumT(per[a])));
    // Chart columns: one per day, per week (Monday start) or per month.
    const bucketOf = gran === 'month' ? (k) => k.slice(0, 7) : gran === 'week' ? (k) => daysBefore(k, (new Date(Date.parse(k + 'T00:00:00Z')).getUTCDay() + 6) % 7) : (k) => k;
    const buckets = new Map();
    for (const key of days) {
      const b = bucketOf(key);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(key);
    }
    const cols = [...buckets].map(([b, keys]) => {
      const by = {};
      for (const k of keys) for (const [mm, t] of Object.entries(G.daily[k] || {})) by[mm] = (by[mm] || 0) + total(t);
      const label = gran === 'day' ? (byMonth ? String(Number(b.slice(8))) : b.slice(5)) : gran === 'week' ? b.slice(5) : b;
      const title = gran === 'week' ? `${b} 起一周` : b;
      return { label, tip: tipOf(title, keys), parts: models.map((mm) => ({ v: by[mm] || 0, c: modelColor(mm) })) };
    });
    const mt = sumT(models.map((mm) => sumT(per[mm])));
    const rows = models
      .flatMap((mm) => effortTotals(per[mm]).map(([e, t]) => [mm, e, t]))
      .map(([mm, e, t]) => `<tr><td><span class="legend" style="display:inline"><i style="background:${modelColor(mm)}"></i></span>${esc(modelName(mm))}</td><td class="eff" ${e === 'unknown' ? 'title="这些请求发生在 Claude Code 开始记录 Effort 之前"' : ''}>${e === 'unknown' ? '未记录' : esc(e)}</td><td>${total(t).toLocaleString()}</td><td>${tok(t.in)}</td><td>${tok(t.cr)}</td><td>${pct(hitOf(t))}</td><td>${tok(t.cw)}</td><td>${tok(t.out)}</td><td>${usd(t.cost)}</td><td>${t.reqs ? usd3(t.cost / t.reqs) : '—'}</td><td>${t.dur > 0 ? num(t.sout / t.dur, 0) : '—'}</td><td>${t.reqs}</td></tr>`)
      .join('');
    const head = byMonth
      ? `<b>${ui.range}</b>`
      : `<b>${rangeLabel(ui.range)}${days.length ? ` <small>${days[0]}${days.length > 1 ? ' ~ ' + days[days.length - 1] : ''}</small>` : ''}</b>`;
    // Only the granularities that apply; with a single one there is nothing to switch.
    const granBar = allowed.length > 1 ? `<span class="seg">${[['day', '天'], ['week', '周'], ['month', '月']].filter(([k]) => allowed.includes(k)).map(([k, n]) => `<button data-gran="${k}" class="${gran === k ? 'on' : ''}">${n}</button>`).join('')}</span>` : '';
    const first = Object.keys(G.daily).sort()[0] || '—';
    return `
      ${rangeBar()}
      <div class="sub srcnote">累计历史 · 始于 ${first}（含已被 Claude Code 删除的会话）</div>
      <section><h3>${head}${granBar}</h3>
        <div class="legend" style="margin:0 0 4px">${models.map((mm) => `<span><i style="background:${modelColor(mm)}"></i>${esc(modelName(mm))}</span>`).join('')}</div>
        ${bars(cols, 120)}</section>
      <section><h3>按模型<span>${usd(mt.cost)}</span></h3>
        <div class="total"><span>全部模型</span><b>${tok(total(mt))} (100%) · ${mt.reqs.toLocaleString()} 次 · 命中 ${pct(hitOf(mt))}</b></div>
        <div class="scroll"><table><tr><th>模型</th><th>Effort</th><th>总 Token</th><th>未缓存输入</th><th>缓存读取</th><th>命中率</th><th>缓存写入</th><th>输出</th><th>费用</th><th title="费用 ÷ 请求数">成本/次</th><th title="输出 token ÷ 请求总耗时（含等待首字的时间）；没有耗时记录的旧历史不计入">速度 tok/s</th><th>请求</th></tr>${rows || '<tr><td colspan="12">这段时间没有记录</td></tr>'}</table></div></section>
      <div class="note">费用按 API 价格折算（platform.claude.com 定价页，2026-11-24），订阅用户仅作参考。</div>
      <div class="foot"><span>已记录 ${presetTotal('all').reqs.toLocaleString()} 次请求 · 始于 ${Object.keys(G.daily).sort()[0] || '—'}</span><span>${esc(G.cal.tz || '')} · 本地统计</span></div>
      <section id="logHost"></section>`;
  }

  // ---------- render loop
  const TABS = [
    ['session', '当前会话', renderSession],
    ['global', '全局洞察', renderGlobal],
    ['days', '每日活动', renderDays],
    ['models', '模型用量', renderModels],
  ];
  function render() {
    const tab = TABS.find((t) => t[0] === ui.tab) || TABS[0];
    tips.length = 0;
    tipKey = null;
    app.innerHTML = `<div class="tabs">${TABS.map(([k, n]) => `<button data-tab="${k}" class="${k === tab[0] ? 'on' : ''}">${n}</button>`).join('')}</div>${tab[2]()}`;
    const sort = document.getElementById('sort');
    if (sort) sort.value = ui.sort;
    const cal = document.getElementById('calScroll');
    if (cal) cal.scrollLeft = cal.scrollWidth;
    const host = document.getElementById('logHost');
    if (host) log.attach(host);
  }
  /** Re-render only what changed without stealing focus from the search box. */
  function refresh(kind) {
    if (ui.tab === 'global') {
      if (kind === 'global') {
        const body = document.getElementById('gbody');
        if (body) body.innerHTML = renderGlobalBody();
        else render();
      }
      return;
    }
    // The session tab follows the current session; the history tabs only change with global data.
    if ((ui.tab === 'session') === (kind === 'session')) render();
  }

  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-tab],[data-heat],[data-range],[data-gran],[data-year],[data-day],[data-action]');
    if (!el || el.disabled) return;
    const d = el.dataset;
    if (d.tab) ui.tab = d.tab;
    else if (d.heat) ui.heat = d.heat;
    else if (d.range) {
      ui.range = d.range;
      log.setRange(d.range); // the request log under the model table follows the page-wide range
      vscode.postMessage({ type: 'range', range: d.range }); // the extension recomputes the insights for it
    } else if (d.gran) ui.gran = d.gran;
    else if (d.year) ui.year = Number(d.year);
    else if (d.day) ui.day = d.day;
    else if (d.action === 'refresh' || d.action === 'openLog' || d.action === 'pick') {
      vscode.postMessage({ type: d.action });
      return;
    }
    save();
    render();
  });
  app.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip],rect.day');
    if (el && G) showTip(el, e);
    else hideTip();
  });
  app.addEventListener('mouseleave', hideTip);
  app.addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    ui.q = e.target.value;
    save();
    const list = document.getElementById('sessList');
    if (list && G) list.innerHTML = sessionList();
  });
  app.addEventListener('change', (e) => {
    if (e.target.id !== 'sort') return;
    ui.sort = e.target.value;
    save();
    const list = document.getElementById('sessList');
    if (list && G) list.innerHTML = sessionList();
  });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'log') {
      log.onMessage(data);
      return;
    }
    skew = data.now - Date.now();
    if (data.type === 'session') {
      S = data.s;
      cfg = data.cfg;
    } else if (data.type === 'global') {
      G = { g: data.g, daily: data.daily, cal: data.cal };
    }
    refresh(data.type);
  });

  // Countdowns tick locally between updates.
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = dur(now() - Number(el.dataset.since));
    for (const el of document.querySelectorAll('[data-expire]')) {
      const left = Number(el.dataset.expire) - now();
      el.textContent = left > 0 ? dur(left) : '已过期';
    }
    if (S) {
      const mini = document.getElementById('cacheMini');
      if (mini) mini.textContent = cacheText(S).replace(/<[^>]+>/g, '');
    }
  }, 1000);

  render();
  log.setRange(ui.range);
  vscode.postMessage({ type: 'ready', range: ui.range });
  log.start();
})();
