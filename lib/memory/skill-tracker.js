// lib/memory/skill-tracker.js — Track which skills help vs hurt performance
// Loaded by agent-loop/reflect to learn which loaded skills are actually useful
'use strict';

const fs   = require('fs');
const path = require('path');

const SKILL_LOG = path.join(__dirname, '../../data/skill_performance.jsonl');

/**
 * Log a skill being loaded or used.
 * @param {string} skillName — e.g. "dip-reversal", "momentum-trading"
 * @param {string} context — 'loaded' | 'tool_called' | 'recommendation_made'
 * @param {object} data — context-specific (e.g., { toolName, result: 'approved' })
 */
function logSkillUsage(skillName, context, data = {}) {
  try {
    const entry = {
      timestamp:  new Date().toISOString(),
      skillName,
      context,
      data,
    };
    fs.appendFileSync(SKILL_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.warn(`[SKILLS] Failed to log usage: ${err.message}`);
  }
}

/**
 * Grade skills based on outcome correlation.
 * Analyzes trades + skill usage to see which skills correlate with wins/losses.
 * Called periodically by reflect.js.
 */
function gradeSkills(trades = []) {
  if (!fs.existsSync(SKILL_LOG)) return [];

  try {
    const lines = fs.readFileSync(SKILL_LOG, 'utf8').trim().split('\n');
    const usages = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    if (!usages.length || !trades.length) return [];

    const day = 24 * 3600_000;
    const week = Date.now() - 7 * day;
    const recentUsages = usages.filter(u => new Date(u.timestamp).getTime() >= week);
    const recentTrades = trades.filter(t => new Date(t.exitTime ?? t.entryTime).getTime() >= week);

    if (!recentTrades.length) return [];

    // Group trades by day, correlate with which skills were loaded that day
    const tradesByDay = {};
    recentTrades.forEach(t => {
      const tradeDay = new Date(t.exitTime ?? t.entryTime).toDateString();
      if (!tradesByDay[tradeDay]) tradesByDay[tradeDay] = [];
      tradesByDay[tradeDay].push(t);
    });

    const skillGrades = {};
    const skillsByDay = {};

    recentUsages.forEach(u => {
      const usageDay = new Date(u.timestamp).toDateString();
      if (!skillsByDay[usageDay]) skillsByDay[usageDay] = new Set();
      skillsByDay[usageDay].add(u.skillName);
    });

    // For each day with skill usage, see if it correlates with better/worse trading
    Object.entries(skillsByDay).forEach(([day, skills]) => {
      const dayTrades = tradesByDay[day] || [];
      if (!dayTrades.length) return;

      const dayWinRate = dayTrades.filter(t => (t.pnlPct ?? 0) > 0).length / dayTrades.length;
      const dayAvgPnl = dayTrades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / dayTrades.length;

      skills.forEach(skill => {
        if (!skillGrades[skill]) {
          skillGrades[skill] = { days: 0, winRates: [], avgPnls: [], usageCount: 0 };
        }
        skillGrades[skill].days++;
        skillGrades[skill].winRates.push(dayWinRate);
        skillGrades[skill].avgPnls.push(dayAvgPnl);
        skillGrades[skill].usageCount += 1;
      });
    });

    // Compute average grades
    const graded = Object.entries(skillGrades)
      .map(([name, data]) => {
        const avgWinRate = data.winRates.reduce((a, b) => a + b, 0) / data.winRates.length;
        const avgPnl = data.avgPnls.reduce((a, b) => a + b, 0) / data.avgPnls.length;
        const performanceScore = (avgWinRate * 100 + avgPnl * 10) / 2; // Simple composite

        return {
          skillName: name,
          avgWinRate: parseFloat(avgWinRate.toFixed(3)),
          avgPnl: parseFloat(avgPnl.toFixed(3)),
          performanceScore: parseFloat(performanceScore.toFixed(1)),
          daysActive: data.days,
          usageCount: data.usageCount,
          recommendation: performanceScore > 25 ? 'KEEP' : performanceScore > 10 ? 'MONITOR' : 'DISABLE',
        };
      })
      .sort((a, b) => b.performanceScore - a.performanceScore);

    return graded;
  } catch (err) {
    console.warn(`[SKILLS] Failed to grade: ${err.message}`);
    return [];
  }
}

/**
 * Get performance summary for dashboard.
 */
function getSummary() {
  const grades = gradeSkills();
  const strong = grades.filter(g => g.recommendation === 'KEEP');
  const weak = grades.filter(g => g.recommendation === 'DISABLE');

  return {
    totalSkillsTracked: grades.length,
    strongPerformers: strong.slice(0, 3),
    underperformers: weak.slice(0, 3),
    allGrades: grades,
  };
}

/**
 * Clear old entries.
 */
function prune() {
  if (!fs.existsSync(SKILL_LOG)) return;

  try {
    const lines = fs.readFileSync(SKILL_LOG, 'utf8').trim().split('\n');
    const month = Date.now() - 30 * 86_400_000;
    const fresh = lines
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(e => e && new Date(e.timestamp).getTime() >= month);

    fs.writeFileSync(SKILL_LOG, fresh.map(e => JSON.stringify(e)).join('\n') + (fresh.length ? '\n' : ''));
  } catch (err) {
    console.warn(`[SKILLS] Failed to prune: ${err.message}`);
  }
}

module.exports = {
  logSkillUsage,
  gradeSkills,
  getSummary,
  prune,
};
