'use strict';
// Subscription quota (5-hour / 7-day) from the official `claude` CLI.
// There is no public API for it: the CLI answers a `get_usage` control request in SDK (stream-json) mode,
// the same request the Claude Code extension's usage panel sends. The CLI marks it experimental, so any
// change in the reply is reported as an error rather than guessed around.
// cc-pulse never touches the login token: the CLI does the request with its own credentials.
const { spawn } = require('child_process');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 15000;
// No user/project settings (hooks, plugins, status line) and no MCP servers: only the CLI and its login.
const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];

/** One quota window of the reply, or null when the plan has none. Throws when it is not in the known shape. */
function parseWindow(w, name) {
  if (w == null) return null;
  const resetsAt = Date.parse(w.resets_at);
  if (typeof w.utilization !== 'number' || Number.isNaN(resetsAt)) throw new Error(`返回的 ${name} 字段格式变了`);
  return { pct: w.utilization / 100, resetsAt };
}

/** The `get_usage` reply -> { plan, fiveHour, sevenDay }. */
function parseUsage(r) {
  if (!r || typeof r !== 'object') throw new Error('返回内容为空');
  if (r.rate_limits_available !== true || !r.rate_limits) throw new Error('当前登录方式没有额度数据（需要用 Pro / Max 订阅登录 claude）');
  const fiveHour = parseWindow(r.rate_limits.five_hour, 'five_hour');
  const sevenDay = parseWindow(r.rate_limits.seven_day, 'seven_day');
  if (!fiveHour && !sevenDay) throw new Error('返回里没有 5 小时和 7 天额度');
  return { plan: r.subscription_type || null, fiveHour, sevenDay };
}

/** Runs the CLI once and resolves with the parsed quota. */
function fetchUsage(bin = 'claude', timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ARGS, { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error(`claude 在 ${timeoutMs / 1000} 秒内没有返回`)), timeoutMs);
    child.on('error', (e) => finish(reject, e.code === 'ENOENT' ? new Error(`找不到 ${bin} 命令（扩展进程的 PATH 里没有）`) : e));
    child.stdin.on('error', () => {}); // the CLI exiting early is reported by 'exit' below
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.stdout.on('data', (d) => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not a protocol line
        }
        const res = msg.type === 'control_response' && msg.response;
        if (!res || res.request_id !== 'usage') continue;
        if (res.subtype !== 'success') return finish(reject, new Error('claude 拒绝了查询：' + (res.error || res.subtype)));
        try {
          finish(resolve, parseUsage(res.response));
        } catch (e) {
          finish(reject, e);
        }
      }
    });
    child.on('exit', (code) => finish(reject, new Error(`claude 提前退出（退出码 ${code}）${err.trim() ? '：' + err.trim().split('\n').pop() : ''}`)));
    // stdin stays open until the answer arrives: closing it ends the CLI before it replies.
    child.stdin.write(
      JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }) + '\n' +
        JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } }) + '\n',
    );
  });
}

/**
 * The latest result, shared by every VS Code window through a file in the extension's global storage,
 * so several windows do not each query the (rate limited) usage endpoint.
 * A result is { at, data } or { at, error }.
 */
class Quota {
  constructor(dir, fetch = fetchUsage) {
    this.file = path.join(dir, 'quota.json');
    this.fetch = fetch;
    this.last = null;
  }

  async read() {
    try {
      return JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Uses the shared result when it was taken at or after `notBefore`, otherwise queries the CLI and shares the answer. */
  async refresh(notBefore, now = Date.now()) {
    const shared = await this.read();
    if (shared && shared.at >= notBefore) return (this.last = shared);
    let r;
    try {
      r = { at: now, data: await this.fetch() };
    } catch (e) {
      r = { at: now, error: e.message };
    }
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(r));
    return (this.last = r);
  }
}

module.exports = { fetchUsage, parseUsage, Quota };
