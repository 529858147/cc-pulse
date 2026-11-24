'use strict';
// Keeps per-day, per-model totals after Claude Code deletes old transcripts (cleanupPeriodDays, 30 days by default).
const fsp = require('fs').promises;
const path = require('path');

const VERSION = 1;

class History {
  constructor(dir) {
    this.file = path.join(dir, 'history-v1.json');
    this.days = {};
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
    if (data.version !== VERSION) throw new Error(`不认识的历史文件版本 ${data.version}：${this.file}`);
    this.days = data.days;
  }

  /**
   * Merges totals computed from the transcripts on disk. Transcripts only grow while they exist and
   * disappear when Claude Code deletes them, so for each day and model the entry with more requests
   * is the more complete one.
   */
  merge(live) {
    let changed = false;
    for (const [day, models] of Object.entries(live)) {
      const stored = this.days[day] || (this.days[day] = {});
      for (const [model, t] of Object.entries(models)) {
        const old = stored[model];
        // Same request count but the stored entry predates the effort breakdown, the speed totals or the cost split: backfill it.
        if (!old || t.reqs > old.reqs || (t.reqs === old.reqs && (!old.eff || old.cIn === undefined))) {
          stored[model] = t;
          changed = true;
        }
      }
    }
    return changed;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ version: VERSION, days: this.days }));
    await fsp.rename(tmp, this.file);
  }
}

module.exports = { History };
