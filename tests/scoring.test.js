// tests/scoring.test.js — scoreDipReversal is the pure buy-decision gate shared by the scanner
// and the pre-buy check. A silent regression here changes what every agent buys, so it's the
// highest-value place for a test net. Node's built-in runner — zero dependencies.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { scoreDipReversal } = require('../lib/scoring');

// A candidate that clears every hard gate: shallow dip, modest sustained bounce, real activity,
// enough liquidity. (Note: real signature is scoreDipReversal(c, cfg), and txns are objects.)
const base = () => ({
  priceChange5m: 2, priceChange1h: -4, priceChange6h: -2, priceChange24h: 0,
  liquidity: 150_000, volume1h: 50_000,
  txns5m: { buys: 30, sells: 10 }, txns1h: { buys: 100, sells: 60 },
  sustainedBounce: true,
});
const cfg = { strategy: { minLiquidity: 50_000 } };

test('a clean dip-reversal candidate passes with a bounded score + a pattern', () => {
  const r = scoreDipReversal(base(), cfg);
  assert.equal(r.passed, true);
  assert.equal(typeof r.pattern, 'string');
  assert.ok(r.score >= 0 && r.score <= 100, `score ${r.score} out of range`);
});

test('a corrupt candle (implausible % move) is rejected, not scored as a huge bounce', () => {
  const r = scoreDipReversal({ ...base(), priceChange5m: 5000 }, cfg);
  assert.equal(r.passed, false);
  assert.equal(r.pattern, null);
  assert.equal(r.score, 0);
});

test('a non-negative 1h (not a dip) is gated out', () => {
  assert.equal(scoreDipReversal({ ...base(), priceChange1h: 2 }, cfg).passed, false);
});

test('a deeper dip requires a stronger bounce to clear the gate', () => {
  const weak   = scoreDipReversal({ ...base(), priceChange1h: -12, priceChange5m: 2 }, cfg);
  const strong = scoreDipReversal({ ...base(), priceChange1h: -12, priceChange5m: 3.5 }, cfg);
  assert.equal(weak.passed, false);   // 2% < the deep-dip 3% bounce floor
  assert.equal(strong.passed, true);  // 3.5% clears it
});

test('liquidity below the configured floor is gated out', () => {
  assert.equal(scoreDipReversal({ ...base(), liquidity: 10_000 }, cfg).passed, false);
});

test('missing fields do not throw', () => {
  assert.doesNotThrow(() => scoreDipReversal({}, {}));
});
