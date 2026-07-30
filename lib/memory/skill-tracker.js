// lib/memory/skill-tracker.js — measure whether a loaded skill actually helps.
//
// Written by lib/tools/web.js (every load_skill call appends here) and pruned by
// reflect.js. Grading is pull-based: lib/dashboard.js calls getSummary().
//
// Attribution model
// -----------------
// A skill can only have influenced a trade the agent decided on *after* loading
// it, in the same reasoning round. So every entry carries the `decisionId` of the
// round that opened it (lib/processor.js mints it, lib/tools/trading.js stamps it
// onto the position), and a trade is attributed to exactly the skills loaded in
// that round.
//
// The comparison is against other model-initiated trades that did *not* have the
// skill loaded — never against the autonomous scanner's trades. Buys from
// auto-scanner / smart-money / watches have no decisionId and no skill in context;
// including them would measure "did the model decide this" rather than "did the
// skill help".
//
// This replaces a same-day correlation that could not work: it bucketed by
// calendar day and gave every skill loaded that day the identical day win-rate,
// so skills loaded together were mathematically indistinguishable, and it
// attributed by exit time, crediting skills for positions entered days earlier.
//
// Known limits — read grades as a prompt to look, never as proof:
//   * Co-linearity. Two skills loaded in the same rounds every time still score
//     identically; nothing in observational data can separate them. Only loading
//     them apart can.
//   * No causal claim. The model chooses when to load a skill, so a skill may
//     simply mark the setups it gets reached for. This measures association.
//   * Small samples. The thresholds below are effect-size guards, not
//     significance tests. Double-digit trade counts are still noisy.
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const SKILL_LOG = path.join(DATA_DIR, 'skill_performance.jsonl');

const RETENTION_DAYS = 30;   // how long usage events are kept
const GRADE_WINDOW_DAYS = 14; // how far back grading looks

// Below these counts a verdict is noise. Reported as INSUFFICIENT_DATA instead of
// a grade — a wrong "DISABLE" on four trades is worse than saying nothing.
const MIN_SKILL_TRADES    = 8;
const MIN_BASELINE_TRADES = 8;

// Effect size a lift must clear before it counts as a signal rather than jitter.
// A heuristic guard, not a significance test — with samples this small nothing
// here should be read as statistically established.
const WIN_RATE_MARGIN = 0.10;  // 10 percentage points
const PNL_MARGIN      = 1.0;   // 1 percentage point of P&L

/**
 * Log a skill being loaded or used.
 * @param {string} skillName — e.g. "dip-reversal"
 * @param {string} context — 'loaded' | 'tool_called' | 'recommendation_made'
 * @param {object} data — { decisionId, source, ... }
 * @returns {boolean} whether the event was written
 */
function logSkillUsage(skillName, context, data = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      skillName,
      context,
      decisionId: data.decisionId ?? null,
      data,
    };
    fs.appendFileSync(SKILL_LOG, JSON.stringify(entry) + '\n');
    return true;
  } catch (err) {
    console.warn(`[SKILLS] Failed to log usage: ${err.message}`);
    return false;
  }
}

function _loadUsages() {
  if (!fs.existsSync(SKILL_LOG)) return [];
  try {
    return fs.readFileSync(SKILL_LOG, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(u => u && u.skillName && u.timestamp);
  } catch (err) {
    console.warn(`[SKILLS] Failed to read usage log: ${err.message}`);
    return [];
  }
}

/** Net-of-fees return when the trade recorded costs, else the gross figure. */
function _pnlPct(trade) {
  return trade.netPnlPct ?? trade.pnlPct ?? 0;
}

function _stats(trades) {
  if (!trades.length) return { n: 0, winRate: 0, avgPnlPct: 0 };
  const wins = trades.filter(t => _pnlPct(t) > 0).length;
  const sum  = trades.reduce((s, t) => s + _pnlPct(t), 0);
  return {
    n: trades.length,
    winRate: wins / trades.length,
    avgPnlPct: sum / trades.length,
  };
}

/**
 * Map decisionId → Set of skills loaded in that round.
 */
function _skillsByDecision(usages) {
  const byDecision = new Map();
  for (const u of usages) {
    if (!u.decisionId) continue;
    if (!byDecision.has(u.decisionId)) byDecision.set(u.decisionId, new Set());
    byDecision.get(u.decisionId).add(u.skillName);
  }
  return byDecision;
}

/**
 * Grade skills by comparing trades decided with the skill loaded against other
 * model-initiated trades decided without it.
 *
 * @param {Array} trades — closed trades (from positions.getTradeHistory)
 * @param {object} [opts] — { windowDays, minSkillTrades, minBaselineTrades, now }
 * @returns {Array} one entry per skill seen in the window, best lift first
 */
function gradeSkills(trades = [], opts = {}) {
  const windowDays       = opts.windowDays       ?? GRADE_WINDOW_DAYS;
  const minSkillTrades   = opts.minSkillTrades   ?? MIN_SKILL_TRADES;
  const minBaselineTrades = opts.minBaselineTrades ?? MIN_BASELINE_TRADES;
  const now              = opts.now              ?? Date.now();

  const usages = _loadUsages();
  if (!usages.length || !trades.length) return [];

  const cutoff = now - windowDays * 86_400_000;
  const recentUsages = usages.filter(u => new Date(u.timestamp).getTime() >= cutoff);
  if (!recentUsages.length) return [];

  const byDecision = _skillsByDecision(recentUsages);

  // Population: model-initiated trades entered inside the window. Autonomous
  // scanner buys carry no decisionId and are excluded on both sides.
  const population = trades.filter(t => {
    if (!t.decisionId) return false;
    const entryTs = new Date(t.entryTime ?? t.exitTime).getTime();
    return Number.isFinite(entryTs) && entryTs >= cutoff;
  });

  // Load counts and recency come from the whole window, even for skills that have
  // no attributable trade yet — the operator still wants to see they were used.
  const loadCounts = new Map();
  const lastUsed   = new Map();
  for (const u of recentUsages) {
    loadCounts.set(u.skillName, (loadCounts.get(u.skillName) ?? 0) + 1);
    const ts = u.timestamp;
    if (!lastUsed.has(u.skillName) || ts > lastUsed.get(u.skillName)) lastUsed.set(u.skillName, ts);
  }

  const graded = [...loadCounts.keys()].map(skillName => {
    const withSkill = population.filter(t => byDecision.get(t.decisionId)?.has(skillName));
    const without   = population.filter(t => !byDecision.get(t.decisionId)?.has(skillName));

    const s = _stats(withSkill);
    const b = _stats(without);

    const winRateLift = s.n && b.n ? s.winRate - b.winRate : 0;
    const pnlLift     = s.n && b.n ? s.avgPnlPct - b.avgPnlPct : 0;

    let recommendation;
    if (s.n < minSkillTrades || b.n < minBaselineTrades) {
      recommendation = 'INSUFFICIENT_DATA';
    } else if (winRateLift > WIN_RATE_MARGIN && pnlLift > PNL_MARGIN) {
      recommendation = 'KEEP';
    } else if (winRateLift < -WIN_RATE_MARGIN && pnlLift < -PNL_MARGIN) {
      recommendation = 'REVIEW';
    } else {
      recommendation = 'MONITOR';
    }

    return {
      skillName,
      usageCount:        loadCounts.get(skillName),
      lastUsedAt:        lastUsed.get(skillName),
      attributedTrades:  s.n,
      baselineTrades:    b.n,
      winRate:           parseFloat(s.winRate.toFixed(3)),
      baselineWinRate:   parseFloat(b.winRate.toFixed(3)),
      winRateLift:       parseFloat(winRateLift.toFixed(3)),
      avgPnlPct:         parseFloat(s.avgPnlPct.toFixed(2)),
      baselineAvgPnlPct: parseFloat(b.avgPnlPct.toFixed(2)),
      pnlLift:           parseFloat(pnlLift.toFixed(2)),
      recommendation,
      // No code acts on this. It is a prompt for a human to look, nothing more —
      // see ARCHITECTURE.md "Tier 3".
      advisory: true,
    };
  });

  // Skills with a verdict first, then by measured lift; unrated ones by usage.
  return graded.sort((a, b) => {
    const rated = x => (x.recommendation === 'INSUFFICIENT_DATA' ? 0 : 1);
    if (rated(a) !== rated(b)) return rated(b) - rated(a);
    if (rated(a)) return b.pnlLift - a.pnlLift;
    return b.usageCount - a.usageCount;
  });
}

/**
 * Performance summary for the dashboard.
 */
function getSummary(opts = {}) {
  try {
    const positions = require('../positions');
    const windowDays = opts.windowDays ?? GRADE_WINDOW_DAYS;
    const trades = positions.getTradeHistory(200, windowDays);
    const grades = gradeSkills(trades, opts);

    const rated = grades.filter(g => g.recommendation !== 'INSUFFICIENT_DATA');

    return {
      totalSkillsTracked: grades.length,
      ratedSkills:        rated.length,
      pendingData:        grades.length - rated.length,
      strongPerformers:   grades.filter(g => g.recommendation === 'KEEP').slice(0, 3),
      underperformers:    grades.filter(g => g.recommendation === 'REVIEW').slice(0, 3),
      allGrades:          grades,
      windowDays,
      minSkillTrades:     opts.minSkillTrades ?? MIN_SKILL_TRADES,
      advisoryOnly:       true,
    };
  } catch (err) {
    console.warn(`[SKILLS] getSummary() error: ${err.message}`);
    return {
      totalSkillsTracked: 0,
      ratedSkills: 0,
      pendingData: 0,
      strongPerformers: [],
      underperformers: [],
      allGrades: [],
      advisoryOnly: true,
      error: err.message,
    };
  }
}

/**
 * Drop usage events older than the retention window.
 * @returns {number} events removed
 */
function prune() {
  if (!fs.existsSync(SKILL_LOG)) return 0;

  try {
    const usages = _loadUsages();
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const fresh  = usages.filter(u => new Date(u.timestamp).getTime() >= cutoff);
    const removed = usages.length - fresh.length;
    if (!removed) return 0;

    // Write via a temp file so a crash mid-write cannot truncate the log.
    const tmp = SKILL_LOG + '.tmp';
    fs.writeFileSync(tmp, fresh.map(e => JSON.stringify(e)).join('\n') + (fresh.length ? '\n' : ''));
    fs.renameSync(tmp, SKILL_LOG);
    return removed;
  } catch (err) {
    console.warn(`[SKILLS] Failed to prune: ${err.message}`);
    return 0;
  }
}

module.exports = {
  logSkillUsage,
  gradeSkills,
  getSummary,
  prune,
  SKILL_LOG,
  _internal: { _loadUsages, _stats, _skillsByDecision, _pnlPct },
};
