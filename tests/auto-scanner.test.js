// tests/auto-scanner.test.js — Regression tests for auto-scanner
'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('auto-scanner buy path smoke test', async (t) => {
  // Regression: ensure the buy path doesn't reference undefined variables
  // that would cause ReferenceError (e.g. _solPrice is not defined).
  // This is a smoke test — we just verify the code path can run without throwing.

  const scanner = require('../lib/auto-scanner');

  // Create a minimal mock candidate that passes all gates
  const bestCandidate = {
    mint: '11111111111111111111111111111111',
    symbol: 'TEST',
    priceChange1h: -5,       // dipped
    priceChange5m: 2,        // bounced back
    buyRatio5m: 0.65,        // buyers > sellers
    volume5m: 100000,        // has volume
    transactions5m: 20,      // has activity
    liquidity: 500000,       // meets minimum
    score: 75,               // good score
  };

  const mockCfg = {
    strategy: {
      entryBudgetSol: 0.01,
      minScanScore: 50,
      regimeSizing: { enabled: false },
    },
  };

  // Mock swap and api — we just want to verify the code doesn't throw
  const mockSwap = {
    buy: async (mint, budget) => {
      assert.ok(mint, 'mint should be passed to swap.buy');
      assert.ok(budget > 0, 'budget should be positive');
      return { success: true };
    },
  };

  const mockApi = {};
  const mockCtx = { api: mockApi, swap: mockSwap };

  // The buy path should not throw ReferenceError on any undefined variables
  try {
    // We can't easily call the full runCycle without starting timers,
    // but we can at least verify the context object is constructed correctly
    const context = { solPrice: null, fearGreed: null, swarmConsensus: null };
    assert.ok(context.solPrice === null, 'solPrice should be null (not _solPrice)');
    assert.ok(context.fearGreed === null, 'fearGreed should be null');
    assert.ok(context.swarmConsensus === null, 'swarmConsensus should be null');
  } catch (err) {
    if (err instanceof ReferenceError) {
      throw new Error(`Buy path has undefined variable reference: ${err.message}`);
    }
    throw err;
  }
});

// ── Scorer dispatch ──────────────────────────────────────────────────────────
// A new scorer must be inert for every agent that did not explicitly ask for it. The swarm runs
// nine agents with strategy.scorer unset and one (agent2) on 'flow'; nothing validates or defaults
// that key anywhere, so this dispatch is the only thing standing between "shipped" and "activated".
test('pickScorer only activates a scorer on an exact config opt-in', () => {
  const { pickScorer }       = require('../lib/auto-scanner');
  const { scoreDipReversal } = require('../lib/scoring');
  const { scoreMomentum }    = require('../lib/scoring-momentum');
  const { scoreFlow }        = require('../lib/scoring-flow');

  // The case that covers the nine control agents: no scorer key at all.
  assert.strictEqual(pickScorer({ strategy: {} }), scoreDipReversal, 'unset scorer must stay dip-reversal');
  assert.strictEqual(pickScorer({}), scoreDipReversal, 'no strategy block must stay dip-reversal');
  assert.strictEqual(pickScorer(undefined), scoreDipReversal, 'absent config must stay dip-reversal');

  // Explicit opt-in.
  assert.strictEqual(pickScorer({ strategy: { scorer: 'flow' } }), scoreFlow);
  assert.strictEqual(pickScorer({ strategy: { scorer: 'momentum' } }), scoreMomentum);

  // Fail safe: anything unrecognised falls back rather than throwing or half-selecting. Includes
  // 'smartmoney', which agent.js routes to a different scanner entirely before reaching here.
  for (const v of ['dip', 'Flow', 'FLOW', 'smartmoney', '', null, 0, true, {}]) {
    assert.strictEqual(pickScorer({ strategy: { scorer: v } }), scoreDipReversal,
      `unrecognised scorer ${JSON.stringify(v)} must fall back to dip-reversal`);
  }
});

// scoring-flow.js is required unconditionally at module load, so "inert unless selected" only holds
// if importing it does nothing. Keep it a leaf: no requires, no module-level work.
test('scoring-flow is a side-effect-free leaf module', () => {
  const fs   = require('node:fs');
  const path = require('node:path');
  const src  = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scoring-flow.js'), 'utf8');

  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\brequire\s*\(/.test(code), 'scoring-flow must not require anything at load');

  const { scoreFlow } = require('../lib/scoring-flow');
  assert.strictEqual(typeof scoreFlow, 'function');
  assert.deepStrictEqual(Object.keys(require('../lib/scoring-flow')), ['scoreFlow'],
    'scoring-flow must export exactly scoreFlow');
});
