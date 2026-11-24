'use strict';
// Extracts the program names a Bash tool call runs, for the "命令执行" ranking.
// `coke.sh run <project> '<PowerShell>'` runs PowerShell on the Windows PC "coke"; those commands
// are reported as "coke ▸ <name>" so the ranking shows what actually ran instead of coke.sh itself.
const path = require('path');

// Shell plumbing that says nothing about what work was done.
const BASH_SKIP = new Set(['cd', 'pushd', 'popd', 'echo', 'printf', 'true', 'false', 'export', 'set', 'unset', 'source', '.',
  'exit', 'return', 'local', 'read', 'wait', 'shift', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', '{', '}', '!', '[', '[[', ']]', ']']);
const BASH_PREFIX = new Set(['sudo', 'env', 'nohup', 'exec', 'command', 'builtin', 'time', 'nice', 'stdbuf', 'xargs']);
const PS_SKIP = new Set(['cd', 'set-location', 'sl', 'chdir', 'push-location', 'pushd', 'pop-location', 'popd', 'echo',
  'write-host', 'write-output', 'out-null', 'out-string', 'out-host', 'format-table', 'ft', 'format-list', 'fl',
  'select-object', 'select', 'sort-object', 'sort', 'foreach-object', 'foreach', '%', 'where-object', 'where', '?',
  'if', 'else', 'elseif', 'try', 'catch', 'finally', 'for', 'while', 'return', 'exit', 'param', '{', '}', '(', ')']);

/** Drops heredoc bodies (`<<'EOF' ... EOF`) so script lines are not read as commands. */
function stripHeredocs(text) {
  const out = [];
  let end = null;
  for (const line of text.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    if (m) end = m[2];
  }
  return out.join('\n');
}

/**
 * Splits on unquoted command separators: newline ; | || && and, in Bash, a background &.
 * Commands after a single `|` are marked `piped`: they filter the previous command's output
 * (head, Select-String…) and are left out of the ranking.
 */
function splitSegments(text, ps) {
  const segs = [];
  let cur = '';
  let piped = false;
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (q) {
      cur += c;
      if (ps && q === '"' && c === '`') {
        cur += n || '';
        i++;
      } else if (!ps && q === '"' && c === '\\') {
        cur += n || '';
        i++;
      } else if (c === q) {
        if (ps && q === "'" && n === "'") {
          cur += n;
          i++;
        } else q = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if ((!ps && c === '\\') || (ps && c === '`')) {
      cur += c + (n || '');
      i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      // `2>&1` and `&>` are redirections; a single & in PowerShell is the call operator.
      if (c === '&' && (text[i - 1] === '>' || n === '>')) {
        cur += c;
        continue;
      }
      if (ps && c === '&' && n !== '&') {
        cur += c;
        continue;
      }
      segs.push({ text: cur, piped });
      cur = '';
      piped = c === '|' && n !== '|';
      if ((c === '&' || c === '|') && n === c) i++;
      continue;
    }
    cur += c;
  }
  segs.push({ text: cur, piped });
  return segs.map((s) => ({ text: s.text.trim(), piped: s.piped })).filter((s) => s.text);
}

/** Splits one command into words, removing quotes. */
function tokenize(seg, ps) {
  const toks = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    const n = seg[i + 1];
    if (q) {
      if (c === q) {
        if (ps && q === "'" && n === "'") {
          cur += "'";
          i++;
        } else q = null;
      } else if (q === '"' && n !== undefined && ((!ps && c === '\\') || (ps && c === '`'))) {
        cur += n;
        i++;
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) toks.push(cur);
      cur = '';
      has = false;
    } else if (!ps && c === '\\' && n !== undefined) {
      cur += n;
      i++;
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (cur || has) toks.push(cur);
  return toks;
}

function cleanWord(w) {
  return w.replace(/^[({@]+/, '').replace(/[)}]+$/, '');
}

function psCommands(text) {
  const out = [];
  for (const seg of splitSegments(text, true)) {
    if (seg.piped) continue;
    const t = tokenize(seg.text, true);
    let i = 0;
    if (t[0] && t[0].startsWith('$')) {
      // `$x = git status` runs git; a bare variable expression runs nothing.
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      i = eq + 1;
    }
    while (i < t.length && (t[i] === '&' || t[i] === '.')) i++;
    if (i >= t.length) continue;
    let name = cleanWord(t[i]);
    if (name.toLowerCase() === 'cmd' && /^\/c$/i.test(t[i + 1] || '') && t[i + 2]) name = cleanWord(t[i + 2].trim().split(/\s+/)[0]);
    name = name.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
    if (!name || PS_SKIP.has(name.toLowerCase()) || /^[$\-<>0-9'"]/.test(name)) continue;
    out.push(name);
  }
  return out;
}

function bashCommands(text, depth = 0) {
  const out = [];
  for (const seg of splitSegments(stripHeredocs(text), false)) {
    if (seg.piped) continue;
    const t = tokenize(seg.text, false);
    let i = 0;
    while (i < t.length) {
      const w = cleanWord(t[i]);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
      else if (w === 'timeout') {
        i++;
        while (i < t.length && t[i].startsWith('-')) i++;
        if (i < t.length && /^\d/.test(t[i])) i++;
      } else if (BASH_PREFIX.has(w)) {
        i++;
        while (i < t.length && t[i].startsWith('-')) i++;
      } else break;
    }
    if (i >= t.length) continue;
    const name = path.basename(cleanWord(t[i]));
    if (!name || BASH_SKIP.has(name) || /^[-<>0-9&$]/.test(name)) continue;
    const args = t.slice(i + 1);
    if (name === 'coke.sh') {
      if (args[0] === 'run' && args.length >= 3) out.push(...psCommands(args.slice(2).join(' ')).map((n) => 'coke ▸ ' + n));
      else out.push('coke.sh ' + (args[0] || ''));
    } else if ((name === 'bash' || name === 'sh') && args[0] === '-c' && args[1] && depth < 2) {
      out.push(...bashCommands(args[1], depth + 1));
    } else out.push(name);
  }
  return out;
}

/** The project argument of `coke.sh run <project> ...`, if the command has one. */
function cokeProjects(text) {
  const out = [];
  for (const seg of splitSegments(stripHeredocs(text), false)) {
    const t = tokenize(seg.text, false);
    const i = t.findIndex((w) => path.basename(w) === 'coke.sh');
    // `coke.sh run "$p" ...` names the project through a variable; that is not a project name.
    if (i >= 0 && t[i + 1] === 'run' && t[i + 2] && !t[i + 2].startsWith('$')) out.push(t[i + 2]);
  }
  return out;
}

module.exports = { bashCommands, psCommands, cokeProjects };
