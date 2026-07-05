'use strict';
// Regression for lib/tools/self.js: a MANUAL set_session_strategy (the chat/Telegram tool) must
// stamp a FRESH setAt and NOT inherit the previous strategy's set-time. Before the fix, saveStrategy's
// `...current` spread made the manual write keep the old setAt, which merged plan-grading windows and
// skipped grading the outgoing strategy. planGrading is left OFF here so the test is deterministic
// (no trade-history dependency) — it asserts only the setAt stamping the bug was about.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const { HANDLERS } = require('../lib/tools/self');
const { STRATEGY_FILE, saveStrategy } = require('../lib/agent-loop');

test('manual set_session_strategy stamps a fresh setAt (does not inherit the previous)', async () => {
  const backup = fs.existsSync(STRATEGY_FILE) ? fs.readFileSync(STRATEGY_FILE, 'utf8') : null;
  try {
    const OLD = '2020-01-01T00:00:00.000Z';
    saveStrategy({ mode: 'active', buysThisSession: 0, sessionGoal: 'seed', reasoning: 'seed', setAt: OLD });
    assert.equal(JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8')).setAt, OLD, 'seeded setAt');

    const before = Date.now();
    await HANDLERS.set_session_strategy(
      { mode: 'selective', sessionGoal: 'g', reasoning: 'r' },
      { cfg: { memory: { enabled: false } } },   // grading off → deterministic
      () => {},
    );

    const after = JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8'));
    assert.notEqual(after.setAt, OLD, 'setAt must be re-stamped, not inherited from the previous strategy');
    assert.ok(new Date(after.setAt).getTime() >= before, 'setAt must be a fresh, current timestamp');
    assert.equal(after.mode, 'selective', 'the new strategy was written');
  } finally {
    if (backup != null) fs.writeFileSync(STRATEGY_FILE, backup);
    else { try { fs.unlinkSync(STRATEGY_FILE); } catch {} }
  }
});
