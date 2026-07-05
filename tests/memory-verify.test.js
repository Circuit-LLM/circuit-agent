// tests/memory-verify.test.js — the integrity/consistency pass for the memory stores
// (lib/memory/verify.js). The flagship check is the grade↔trade_history cross-check: a strategy grade
// whose stored trades/pnl don't match the trades that actually closed in its window is exactly the
// corruption the setAt-merge bug produced, and nothing else watches for it. These tests seed that and
// assert it's both DETECTED and REPAIRED (recomputed from ground truth), plus the cursor-clamp path.
// Real data files are snapshotted and restored so the live trade_history is never clobbered.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const { verify, repair } = require('../lib/memory/verify');

const D       = f => path.join(__dirname, '../data', f);
const GRADES  = D('strategy_grades.json');
const TRADES  = D('trade_history.json');
const CURSOR  = D('chat_extract_state.json');
const ARCHIVE = D('conversation_archive.jsonl');
const PROPS   = D('suggested_config.json');
const EPS     = D('chat_episodes.json');

const ALL = [GRADES, TRADES, CURSOR, ARCHIVE, PROPS, EPS];
function snapshot(files) { return files.map(f => ({ f, c: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null })); }
function restore(snap)   { for (const { f, c } of snap) { if (c == null) { try { fs.unlinkSync(f); } catch {} } else fs.writeFileSync(f, c); } }
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

let snap;
test.before(() => {
  snap = snapshot(ALL);
  // Neutralise the stores these tests don't exercise so the only drift is what each test seeds.
  write(PROPS, []);
  try { fs.unlinkSync(EPS); } catch {}
});
test.after(() => restore(snap));

// Window layout shared by the grade tests: an OLDER trade closes before the grade's window (so it sets
// oldestExit < setAt → the window is "verifiable"), then 3 trades close inside the window: +5, +5, -10
// ⇒ trades=3, wins=2, pnlPct=0.00, verdict 'flat'.
const T0    = Date.parse('2026-06-01T00:00:00Z');            // grade.setAt (window start)
const HOUR  = 3_600_000;
function seedTrades() {
  write(TRADES, [
    { mint: 'OLD', exitTime: new Date(T0 - 48 * HOUR).toISOString(), pnlPct: -3, reason: 'stop-loss' }, // before window
    { mint: 'A',   exitTime: new Date(T0 + 1 * HOUR).toISOString(),  pnlPct:  5, reason: 'take-profit' },
    { mint: 'B',   exitTime: new Date(T0 + 2 * HOUR).toISOString(),  pnlPct:  5, reason: 'take-profit' },
    { mint: 'C',   exitTime: new Date(T0 + 3 * HOUR).toISOString(),  pnlPct: -10, reason: 'dead-money' },
  ]);
}

test('detects a grade whose trades/pnl do not match its window, and recomputes it on repair', () => {
  seedTrades();
  // Grade claims 1 trade / +5% / "worked" — but the window actually held 3 trades netting 0% (flat).
  write(GRADES, [{
    setAt: new Date(T0).toISOString(), mode: 'active', patternFilter: [], minScoreOverride: null,
    trades: 1, wins: 1, pnlPct: 5, verdict: 'worked', gradedAt: new Date(T0 + 3 * HOUR).toISOString(),
  }]);

  const rep = verify();
  const kinds = rep.drift.filter(d => d.store === 'strategy_grades.json').map(d => d.kind);
  assert.ok(kinds.includes('grade_trade_count_mismatch'), `expected count mismatch, got: ${kinds.join(', ') || 'none'}`);

  const result = repair(rep);
  assert.ok(result.applied.some(a => a.store === 'strategy_grades.json'), 'repair should touch the grades store');

  // Recomputed to ground truth.
  const [g] = JSON.parse(fs.readFileSync(GRADES, 'utf8'));
  assert.equal(g.trades, 3, 'trades recomputed from the window');
  assert.equal(g.wins, 2, 'wins recomputed');
  assert.equal(g.pnlPct, 0, 'pnlPct recomputed (5 + 5 - 10)');
  assert.equal(g.verdict, 'flat', 'verdict re-derived from the recomputed pnl');
  assert.equal(g.setAt, new Date(T0).toISOString(), 'identity fields preserved');

  // Re-verify: the grade store is now clean (repair converges).
  assert.equal(verify().drift.filter(d => d.store === 'strategy_grades.json').length, 0, 'no grade drift after repair');
});

test('a grade that already matches its window produces no drift', () => {
  seedTrades();
  write(GRADES, [{
    setAt: new Date(T0).toISOString(), mode: 'active', patternFilter: [], minScoreOverride: null,
    trades: 3, wins: 2, pnlPct: 0, verdict: 'flat', gradedAt: new Date(T0 + 3 * HOUR).toISOString(),
  }]);
  assert.equal(verify().drift.filter(d => d.store === 'strategy_grades.json').length, 0, 'correct grade → no drift');
});

test('flags a duplicate grade window (the setAt-merge fingerprint) and drops it on repair', () => {
  seedTrades();
  const iso = new Date(T0).toISOString();
  const base = { setAt: iso, mode: 'active', patternFilter: [], minScoreOverride: null, trades: 3, wins: 2, pnlPct: 0, verdict: 'flat', gradedAt: iso };
  write(GRADES, [base, { ...base }]);                          // same setAt graded twice
  assert.ok(verify().drift.some(d => d.kind === 'grade_duplicate_window'), 'duplicate window detected');
  repair();
  assert.equal(JSON.parse(fs.readFileSync(GRADES, 'utf8')).length, 1, 'duplicate dropped on repair');
});

test('clamps a chat-extraction cursor that ran past the archive', () => {
  write(GRADES, []); write(TRADES, []);                        // keep other stores clean
  fs.writeFileSync(ARCHIVE, 'a\nb\nc\n');                       // 3 lines
  write(CURSOR, { lastLine: 99 });                             // rotated/truncated → cursor past end

  const rep = verify();
  assert.ok(rep.drift.some(d => d.kind === 'cursor_past_end'), 'cursor past end detected');
  repair(rep);
  assert.equal(JSON.parse(fs.readFileSync(CURSOR, 'utf8')).lastLine, 3, 'cursor clamped to archive length');
  assert.ok(!verify().drift.some(d => d.kind === 'cursor_past_end'), 'no cursor drift after clamp');
});
