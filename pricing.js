'use strict';
// API list prices in USD per million tokens, copied from
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-11-24.
// For a claude.ai subscription this is an "API-equivalent" estimate, not what is billed.
// Keys are model ID prefixes; the longest matching prefix wins.

/** Cache writes are 1.25x (5 min) / 2x (1 h) of input; the cache-read multiplier differs per model. */
function price(input, output, readMul) {
  return { in: input, out: output, cw5: input * 1.25, cw1h: input * 2, cr: input * readMul };
}

const PRICES = {
  'claude-fable-5-2': price(8, 40, 0.025),
  'claude-mythos-5-2': price(8, 40, 0.025),
  'claude-fable-5-1': price(10, 50, 0.025),
  'claude-mythos-5-1': price(10, 50, 0.025),
  'claude-fable-5': price(10, 50, 0.1),
  'claude-mythos-5': price(10, 50, 0.1),
  'claude-opus-5-5': price(4, 20, 0.05),
  'claude-opus-5': price(5, 25, 0.1),
  'claude-opus-4-8': price(5, 25, 0.1),
  'claude-opus-4-7': price(5, 25, 0.1),
  'claude-opus-4-6': price(5, 25, 0.1),
  'claude-opus-4-5': price(5, 25, 0.1),
  'claude-opus-4-1': price(15, 75, 0.1),
  'claude-opus-4': price(15, 75, 0.1),
  'claude-sonnet-5-5': price(2, 10, 0.05),
  'claude-sonnet-5': price(2, 10, 0.1),
  'claude-sonnet-4': price(3, 15, 0.1), // Sonnet 4, 4.5 and 4.6 share this price
  // Haiku 5.5 prices the whole request at the higher tier once its prompt (input + cache reads + cache writes) exceeds 100K.
  'claude-haiku-5-5': { ...price(0.1, 0.5, 0.1), longOver: 100000, long: price(0.5, 2.5, 0.1) },
  'claude-haiku-4-5': price(1, 5, 0.1),
};

const cache = new Map();
function priceFor(model) {
  if (!model) return null;
  if (cache.has(model)) return cache.get(model);
  let best = '';
  for (const k of Object.keys(PRICES)) if (model.startsWith(k) && k.length > best.length) best = k;
  const p = best ? PRICES[best] : null;
  cache.set(model, p);
  return p;
}

/** The price row that applies to this request (Haiku 5.5 has a higher tier for long prompts), or null. */
function pricesOf(r) {
  const p = priceFor(r.model);
  return p && p.longOver && r.in + r.cr + r.cw > p.longOver ? p.long : p;
}

// Older transcripts have no 5m/1h split; the unsplit part counts at the 5-minute rate.
const cw5Of = (r) => r.cw5 + Math.max(0, r.cw - r.cw5 - r.cw1h);

/** USD cost of one request split by what was paid for, or null when the model has no known price. */
function costParts(r) {
  const p = pricesOf(r);
  if (!p) return null;
  return { in: (r.in * p.in) / 1e6, out: (r.out * p.out) / 1e6, cr: (r.cr * p.cr) / 1e6, cw: (cw5Of(r) * p.cw5 + r.cw1h * p.cw1h) / 1e6 };
}

/** USD cost of one request, or null when the model has no known price. */
function requestCost(r) {
  const c = costParts(r);
  return c && c.in + c.out + c.cr + c.cw;
}

/** What writing the cache again cost on top of what reading it would have: cache-write minus cache-read price. */
function cacheRewriteExtra(r) {
  const p = pricesOf(r);
  return p && (cw5Of(r) * (p.cw5 - p.cr) + r.cw1h * (p.cw1h - p.cr)) / 1e6;
}

module.exports = { priceFor, requestCost, costParts, cacheRewriteExtra };
