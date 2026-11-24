// Request log component, shared by the sidebar (inside the "当前会话" tab) and the editor tab.
// The extension sorts and pages; the component renders one page and sends { type: 'query' } on changes.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const int = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
  const tok = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
  const usd = (x) => (x == null ? '—' : '$' + x.toFixed(4));
  function modelName(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|-|\[)/.exec(id || '');
    if (!m) return id || '—';
    return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
  }

  // Date range presets, shared with panel.js (same keys as RANGE_KEYS in stats.js).
  window.CCP_RANGES = [['today', '今日'], ['week', '本周'], ['last', '上周'], ['d30', '近30天'], ['all', '全部']];

  const COLS = [
    ['t', '时间'],
    ['src', '来源'],
    ['model', '模型'],
    ['effort', 'Effort'],
    ['cost', '成本'],
    ['in', '未缓存输入'],
    ['cw', '缓存写入'],
    ['out', '输出'],
    ['cr', '缓存读取'],
    ['hit', '命中率'],
    ['speed', '速度'],
  ];
  const HELP = {
    cost: '按 API 价格折算，订阅用户仅作参考',
    hit: '缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）',
    speed: '输出 token ÷ 请求总耗时（含等待首字的时间）',
  };

  /**
   * @param api      the webview's acquireVsCodeApi() object
   * @param saved    previously saved query, or undefined
   * @param save     called with the query whenever it changes
   * @param opts     { size, scope: defaults; compact: sidebar layout with an "open in editor" button }
   */
  window.RequestLog = function (api, saved, save, opts) {
    const q = Object.assign({ scope: opts.scope, range: 'all', sort: 't', dir: 'desc', page: 1, size: opts.size }, saved || {});
    let data = null;
    let skew = 0; // remote clock minus local clock
    let root = null;
    let started = false;

    function when(ts) {
      const d = new Date(ts);
      const today = new Date(Date.now() + skew).toDateString() === d.toDateString();
      const time = d.toLocaleTimeString('zh-CN', { hour12: false });
      return today ? time : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${time}`;
    }
    function cell(k, r) {
      switch (k) {
        case 't': return when(r.t);
        case 'src': return esc(r.src);
        case 'model': return esc(modelName(r.model));
        case 'effort': return esc(r.effort || '—');
        case 'cost': return `<b>${usd(r.cost)}</b>`;
        case 'cr': return tok(r.cr);
        case 'hit': return pct(r.hit);
        case 'speed': return r.speed == null ? '—' : `≈${Math.round(r.speed)} <small>tok/s</small>`;
        default: return int(r[k]);
      }
    }

    function query() {
      save(q);
      api.postMessage({ type: 'query', q });
    }

    function html() {
      const d = data;
      const head = COLS.map(([k, n]) => `<th data-sort="${k}" title="${esc(HELP[k] || '点击排序')}">${n}${d && d.sort === k ? (d.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('');
      const rows = d
        ? d.rows
            .map((r) => {
              const miss = r.hit !== null && r.hit < 0.5 && r.cw >= 20000;
              const tip = `${r.session}\n${new Date(r.t).toLocaleString('zh-CN', { hour12: false })}${miss ? '\n缓存未命中，重新写入 ' + int(r.cw) + ' token' : ''}`;
              return `<tr class="${miss ? 'miss' : ''}" title="${esc(tip)}">${COLS.map(([k]) => `<td>${cell(k, r)}</td>`).join('')}</tr>`;
            })
            .join('')
        : '';
      const scope = `<span class="seg"><button data-scope="session" class="${q.scope === 'session' ? 'on' : ''}">当前会话</button><button data-scope="all" class="${q.scope === 'all' ? 'on' : ''}">全部会话</button></span>`;
      const range = opts.hostRange ? '' : `<div class="logrange"><span class="seg">${window.CCP_RANGES.map(([k, n]) => `<button data-range="${k}" class="${q.range === k ? 'on' : ''}">${n}</button>`).join('')}</span></div>`;
      const count = `<span class="sub" title="来自仍保留在本机的会话记录（默认 30 天），比上方的累计历史少">${d ? d.total.toLocaleString() + ' 条 · 现存记录' : '加载中…'}</span>`;
      const bar = opts.compact
        ? `<h3>请求日志<span class="logtools">${count}${scope}<button class="small" data-open="1" title="在编辑器中以全宽打开">↗</button></span></h3>`
        : `<div class="logbar">${scope}<span class="sub logscope">${d && d.scope === 'session' ? '当前会话：' + esc(d.sessionTitle || '—') : '全部会话'}</span>${count}</div>`;
      return `${bar}${range}
        <div class="scroll" data-logscroll="1"><table class="log"><tr>${head}</tr>${rows || `<tr><td colspan="${COLS.length}" class="empty">${d ? '没有请求记录' : '加载中…'}</td></tr>`}</table></div>
        <div class="pager">
          <span class="sub">每页 <select data-size="1">${[10, 50, 100].map((n) => `<option value="${n}" ${q.size === n ? 'selected' : ''}>${n}</option>`).join('')}</select> 条</span>
          <span class="nav"><button class="small" data-page="${d ? d.page - 1 : 0}" ${d && d.page > 1 ? '' : 'disabled'}>‹</button>
          <span class="sub">${d ? d.page : '—'} / ${d ? d.pages : '—'}</span>
          <button class="small" data-page="${d ? d.page + 1 : 0}" ${d && d.page < d.pages ? '' : 'disabled'}>›</button></span>
        </div>
        <div class="note">黄色为缓存未命中（重新写入 ≥ 2 万 token 且命中率 &lt; 50%），悬停查看所属会话。${opts.hostRange ? '时间范围与上方一致。' : ''}</div>`;
    }

    function render() {
      if (!root) return;
      // The host re-renders every few seconds; keep the table's horizontal scroll position.
      const old = root.querySelector && root.querySelector('[data-logscroll]');
      const left = old ? old.scrollLeft : 0;
      root.innerHTML = html();
      const sc = root.querySelector && root.querySelector('[data-logscroll]');
      if (sc) sc.scrollLeft = left;
    }

    function onClick(e) {
      const el = e.target.closest('[data-sort],[data-scope],[data-page],[data-open],[data-range]');
      if (!el || el.disabled) return;
      const d = el.dataset;
      if (d.open) {
        api.postMessage({ type: 'openLog' });
        return;
      }
      if (d.sort) {
        // Clicking the current column flips the direction; a new column starts with the largest/newest first.
        q.dir = q.sort === d.sort && q.dir === 'desc' ? 'asc' : 'desc';
        q.sort = d.sort;
        q.page = 1;
      } else if (d.scope) {
        q.scope = d.scope;
        q.page = 1;
      } else if (d.range) {
        q.range = d.range;
        q.page = 1;
      } else q.page = Number(d.page);
      query();
    }
    function onChange(e) {
      if (!e.target.dataset || !e.target.dataset.size) return;
      q.size = Number(e.target.value);
      q.page = 1;
      query();
    }

    return {
      /** Renders into `el`; call again whenever the host replaced the element. */
      attach(el) {
        if (el !== root) {
          el.addEventListener('click', onClick);
          el.addEventListener('change', onChange);
        }
        root = el;
        render();
      },
      onMessage(m) {
        if (m.type !== 'log') return;
        skew = m.now - Date.now();
        data = m;
        // The extension clamps the page (e.g. after the list shrank); keep the query in step with it.
        q.page = m.page;
        save(q);
        render();
      },
      /** For hosts that own the range (the sidebar follows its page-wide range). */
      setRange(range) {
        if (q.range === range) return;
        q.range = range;
        q.page = 1;
        if (started) query();
        else save(q);
      },
      start() {
        started = true;
        query();
      },
    };
  };
})();
