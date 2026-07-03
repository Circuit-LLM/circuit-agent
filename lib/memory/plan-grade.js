// lib/memory/plan-grade.js — grade each expiring 90-min strategy against the trades that
// closed during its window, keep a rolling record, and expose a compact summary the strategy
// brief injects. The READ side (agent-loop's buildBrief) is what closes the loop — a grade
// nothing reads back is just another dead store.
'use strict';

const fs   = require('fs');
const path = require('path');

const GRADES_FILE  = path.join(__dirname, '../../data/strategy_grades.json');
const HISTORY_FILE = path.join(__dirname, '../../data/trade_history.json');
const GRADES_MAX   = 50;

function _load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }
function _atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Grade the strategy about to be replaced, using trades closed since it was set (setAt).
function gradeExpiredStrategy(strategy) {
  if (!strategy?.setAt) return null;                 // pre-migration strategy: no set-time yet — skip
  const from = new Date(strategy.setAt).getTime();
  if (!Number.isFinite(from)) return null;

  const grades = _load(GRADES_FILE);
  // The LLM-unavailable extend path can hand us the same strategy twice — record each window once.
  if (grades.length && grades[grades.length - 1].setAt === strategy.setAt) return null;

  const closed  = _load(HISTORY_FILE).filter(t => new Date(t.exitTime).getTime() >= from);
  const sane    = p => (Number.isFinite(p) && Math.abs(p) < 1000) ? p : 0;  // drop corrupt outliers
  const pnlPct  = +closed.reduce((a, t) => a + sane(t.pnlPct), 0).toFixed(2);
  const wins    = closed.filter(t => sane(t.pnlPct) > 0).length;
  const verdict = !closed.length ? 'no-fills' : pnlPct > 1 ? 'worked' : pnlPct < -1 ? 'hurt' : 'flat';

  grades.push({
    setAt:            strategy.setAt,
    mode:             strategy.mode,
    patternFilter:    strategy.patternFilter ?? [],
    minScoreOverride: strategy.minScoreOverride ?? null,
    trades:           closed.length,
    wins,
    pnlPct,
    verdict,
    gradedAt:         new Date().toISOString(),
  });
  _atomicWrite(GRADES_FILE, grades.slice(-GRADES_MAX));
  return grades[grades.length - 1];
}

// READ-BACK: compact block the brief injects so the LLM chooses the next strategy with the
// last few outcomes in view. Returns '' when there are no grades yet (nothing added to the brief).
function recentGradeSummary(n = 5) {
  const grades = _load(GRADES_FILE).slice(-n);
  if (!grades.length) return '';
  const rows = grades.map(g => {
    const pat  = (g.patternFilter ?? []).join('+') || 'any';
    const sign = g.pnlPct >= 0 ? '+' : '';
    return `  - ${g.mode}/${pat}: ${g.verdict} (${sign}${g.pnlPct}% over ${g.trades} trades)`;
  });
  return `Recent strategy outcomes (most recent last — favour what worked, avoid what hurt):\n${rows.join('\n')}`;
}

module.exports = { gradeExpiredStrategy, recentGradeSummary };
