// tests/skill-attribution.integration.test.js
//
// End-to-end proof of the skill feedback loop: a reasoning round loads a skill,
// opens a position in that same round, the position closes, and the tracker
// attributes the closed trade back to the skill.
//
// The pieces used to exist without being connected — load_skill never logged,
// so grading never had an input. This exercises the whole chain rather than each
// link on its own.
//
// lib/positions.js and lib/memory/skill-tracker.js both write to fixed paths
// under data/, so each is loaded as a copy pointed at a temp directory. The real
// data/ is never touched.
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

/** Load a lib module with its data paths redirected into `dir`. */
function sandboxed(relPath, dir, replacements) {
  const src = require.resolve(relPath);
  let code = fs.readFileSync(src, 'utf8');

  for (const [from, to] of replacements) {
    assert.ok(code.includes(from), `${relPath}: expected to find ${from} — module layout changed`);
    code = code.split(from).join(to);
  }
  // Keep sibling requires resolving against the real lib/ directory.
  const libDir = path.dirname(src);
  code = code.replace(/require\('(\.\.?\/[^']+)'\)/g,
    (_m, p) => `require(${JSON.stringify(path.resolve(libDir, p))})`);

  const out = path.join(dir, path.basename(relPath).replace(/\.js$/, '') + '-sandboxed.js');
  fs.writeFileSync(out, code);
  return require(out);
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-'));

  const positions = sandboxed('../lib/positions', dir, [
    ["const DATA_FILE    = path.join(__dirname, '../data/positions.json');",
     `const DATA_FILE    = ${JSON.stringify(path.join(dir, 'positions.json'))};`],
    ["const HISTORY_FILE = path.join(__dirname, '../data/trade_history.json');",
     `const HISTORY_FILE = ${JSON.stringify(path.join(dir, 'trade_history.json'))};`],
  ]);

  const tracker = sandboxed('../lib/memory/skill-tracker', dir, [
    ["const DATA_DIR = path.join(__dirname, '../../data');",
     `const DATA_DIR = ${JSON.stringify(dir)};`],
  ]);

  return { dir, positions, tracker };
}

function teardown(dir) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir)) delete require.cache[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** One reasoning round: load skills, buy, later sell. */
function round(positions, tracker, { decisionId, skills, mint, solSpent, solReceived }) {
  for (const s of skills) tracker.logSkillUsage(s, 'loaded', { decisionId, source: 'test' });

  positions.openPosition(mint, {
    symbol: mint, entryPrice: 1, solSpent, tokenAmount: '1000', tokenDecimals: 6,
    decisionId,                                    // stamped by lib/tools/trading.js
  });
  positions.closePosition(mint, { solReceived, reason: 'test', exitTime: new Date().toISOString() });
}

test('skill attribution: load → buy → close → grade', async (t) => {
  const { dir, positions, tracker } = setup();

  try {
    // Two rounds load `risk-management` and win; two load `yolo` and lose.
    round(positions, tracker, { decisionId: 'd1', skills: ['risk-management'], mint: 'AAA', solSpent: 1, solReceived: 1.3 });
    round(positions, tracker, { decisionId: 'd2', skills: ['risk-management'], mint: 'BBB', solSpent: 1, solReceived: 1.2 });
    round(positions, tracker, { decisionId: 'd3', skills: ['yolo'], mint: 'CCC', solSpent: 1, solReceived: 0.7 });
    round(positions, tracker, { decisionId: 'd4', skills: ['yolo'], mint: 'DDD', solSpent: 1, solReceived: 0.8 });

    // A buy the autonomous scanner made — no decision, no skill in context.
    positions.openPosition('EEE', { symbol: 'EEE', entryPrice: 1, solSpent: 1, tokenAmount: '1000', tokenDecimals: 6 });
    positions.closePosition('EEE', { solReceived: 0.1, reason: 'stop', exitTime: new Date().toISOString() });

    const trades = positions.getTradeHistory(100, 30);

    await t.test('decisionId survives open → close → history', () => {
      assert.strictEqual(trades.length, 5);
      const byMint = Object.fromEntries(trades.map(t => [t.mint, t]));
      assert.strictEqual(byMint.AAA.decisionId, 'd1');
      assert.strictEqual(byMint.EEE.decisionId, null, 'autonomous buy should carry no decisionId');
    });

    const grades = tracker.gradeSkills(trades, { minSkillTrades: 2, minBaselineTrades: 2 });

    await t.test('each skill is graded against the other, not against itself', () => {
      const rm = grades.find(g => g.skillName === 'risk-management');
      const yolo = grades.find(g => g.skillName === 'yolo');

      assert.strictEqual(rm.attributedTrades, 2);
      assert.strictEqual(rm.baselineTrades, 2, 'baseline should be the two yolo trades only');
      assert.strictEqual(rm.winRate, 1);
      assert.strictEqual(rm.baselineWinRate, 0);
      assert.ok(rm.pnlLift > 0, `expected positive lift, got ${rm.pnlLift}`);
      assert.strictEqual(rm.recommendation, 'KEEP');

      assert.strictEqual(yolo.recommendation, 'REVIEW');
      assert.ok(yolo.pnlLift < 0);
    });

    await t.test('the scanner trade is excluded from both sides', () => {
      // EEE lost 90%. If it leaked into the baseline it would flatter both skills.
      for (const g of grades) {
        assert.strictEqual(g.attributedTrades + g.baselineTrades, 4,
          `${g.skillName} counted the autonomous trade`);
      }
    });

    await t.test('a skill nobody loaded is not graded', () => {
      assert.ok(!grades.some(g => g.skillName === 'scalping'));
    });
  } finally {
    teardown(dir);
  }
});

test('skill attribution: verdicts are withheld until there is enough data', async (t) => {
  const { dir, positions, tracker } = setup();

  try {
    round(positions, tracker, { decisionId: 'd1', skills: ['thin'], mint: 'AAA', solSpent: 1, solReceived: 3 });
    round(positions, tracker, { decisionId: 'd2', skills: ['other'], mint: 'BBB', solSpent: 1, solReceived: 0.5 });

    const grades = tracker.gradeSkills(positions.getTradeHistory(100, 30));

    await t.test('a 1-trade skill reports INSUFFICIENT_DATA despite a 200% win', () => {
      const thin = grades.find(g => g.skillName === 'thin');
      assert.strictEqual(thin.attributedTrades, 1);
      assert.strictEqual(thin.recommendation, 'INSUFFICIENT_DATA');
      assert.strictEqual(thin.advisory, true);
    });

    await t.test('no grade is ever an instruction to disable', () => {
      assert.ok(!grades.some(g => g.recommendation === 'DISABLE'));
      assert.ok(grades.every(g => g.advisory === true));
    });
  } finally {
    teardown(dir);
  }
});
