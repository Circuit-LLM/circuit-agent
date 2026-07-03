// tests/memory.test.js — the pure functions in the read-back memory system. These are new and
// easy to regress silently (they shape what the LLM sees in its briefs), so they get the net too.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const recall     = require('../lib/memory/recall');
const procedural = require('../lib/memory/procedural');

test('recall.rank surfaces the lexically-relevant entry, not just the newest', () => {
  const eps = [
    { gist: 'operator prefers tight stop losses on volatile tokens', savedAt: '2026-07-01T00:00:00Z' },
    { gist: 'chat about sol price and fear greed today',              savedAt: '2026-07-03T00:00:00Z' },
  ];
  const top = recall.rank(eps, 'what stop loss should I use', e => e.gist, { k: 1 });
  assert.equal(top.length, 1);
  assert.match(top[0].gist, /stop loss/);
});

test('recall.rank with an empty query returns the most-recent k', () => {
  const eps = [{ gist: 'a', savedAt: '2026-01-01T00:00:00Z' }, { gist: 'b', savedAt: '2026-02-01T00:00:00Z' }];
  assert.deepEqual(recall.rank(eps, '', e => e.gist, { k: 1 }).map(e => e.gist), ['b']);
});

test('procedural keeps a per-param history instead of overwriting', () => {
  const s = [];
  for (const v of [3, 4, 5]) procedural.appendWithHistory(s, { param: 'stopLossPct', suggestedValue: v });
  assert.equal(s.filter(e => e.param === 'stopLossPct').length, 3);
});

test('procedural caps per-param history at 8, keeping the newest', () => {
  const s = [];
  for (let i = 0; i < 12; i++) procedural.appendWithHistory(s, { param: 'minScanScore', suggestedValue: i });
  const hist = s.filter(e => e.param === 'minScanScore');
  assert.equal(hist.length, 8);
  assert.equal(hist[hist.length - 1].suggestedValue, 11); // newest survives the trim
});

test('procedural.priorChanges reads back the trail (applied vs proposed)', () => {
  const s = [];
  procedural.appendWithHistory(s, { param: 'stopLossPct', suggestedValue: 3, applied: true });
  procedural.appendWithHistory(s, { param: 'stopLossPct', suggestedValue: 4, applied: false });
  const line = procedural.priorChanges(s, 'stopLossPct');
  assert.match(line, /3 \(applied\)/);
  assert.match(line, /4 \(proposed\)/);
});
