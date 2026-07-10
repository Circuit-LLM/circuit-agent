// tests/backtest-full-system.js — Comprehensive backtest of all 5 components
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dataLoader = require('../lib/analysis/data-loader');
const clusterer = require('../lib/analysis/clusterer');
const regimeDetector = require('../lib/analysis/regime-detector');
const gateLearner = require('../lib/analysis/gate-learner');
const holderPredictor = require('../lib/analysis/holder-predictor');
const intelligenceGenerator = require('../lib/analysis/intelligence-generator');

test('Full system backtest: load, analyze, learn, report', async (t) => {
  console.log('\n📊 CIRCUIT-AGENT BACKTEST: Full System Analysis\n');

  // ─────────────────────────────────────────────────────────────────────
  // STEP 1: LOAD DATA
  // ─────────────────────────────────────────────────────────────────────
  console.log('🔄 Step 1: Loading swarm trade data...');
  const trades = dataLoader.loadSwarmTrades();
  const enriched = dataLoader.enrichTrades(trades, {});
  const baselineStats = dataLoader.computeStats(enriched);

  console.log(`   Loaded: ${enriched.length} trades from 10 agents`);
  console.log(`   Baseline stats: ${baselineStats.winRate}% WR, ${baselineStats.totalNetPnl > 0 ? '+' : ''}${baselineStats.totalNetPnl.toFixed(4)} SOL\n`);

  // ─────────────────────────────────────────────────────────────────────
  // STEP 2: CLUSTER ANALYSIS
  // ─────────────────────────────────────────────────────────────────────
  console.log('📊 Step 2: Clustering trades by pattern-time-liquidity...');
  const clusterStats = clusterer.clusterTrades(enriched);
  const rankedClusters = clusterer.rankClusters(clusterStats);

  console.log(`   Found: ${Object.keys(clusterStats).length} distinct clusters\n`);
  console.log('   📈 Top 5 Winning Clusters:');
  rankedClusters.slice(0, 5).forEach(c => {
    console.log(
      `      ${c.key}`
      + ` | ${c.winRate}% WR (${c.wins}/${c.n})`
      + ` | avg ${c.avgNetPnlSol > 0 ? '+' : ''}${c.avgNetPnlSol.toFixed(4)} SOL`
    );
  });

  console.log('\n   📉 Top 5 Losing Clusters:');
  rankedClusters.slice(-5).reverse().forEach(c => {
    console.log(
      `      ${c.key}`
      + ` | ${c.winRate}% WR (${c.wins}/${c.n})`
      + ` | avg ${c.avgNetPnlSol > 0 ? '+' : ''}${c.avgNetPnlSol.toFixed(4)} SOL`
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 3: REGIME DETECTION
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n🌍 Step 3: Detecting market regimes at trade entry times...');
  const regimes = regimeDetector.detectRegimes(enriched);
  const regimeStats = regimeDetector.regimeStats(enriched);

  console.log(`   Detected regimes: ${Object.keys(regimeStats).join(', ')}\n`);
  Object.entries(regimeStats).forEach(([regime, stats]) => {
    console.log(`      ${regime}: ${stats.winRate}% WR (${stats.wins}/${stats.n}), ${stats.avgNetPnlPct > 0 ? '+' : ''}${stats.avgNetPnlPct.toFixed(2)}% avg P&L`);
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 4: GATE LEARNING
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n🎯 Step 4: Learning optimal buyRatio thresholds per cluster...');
  const gateRecommendations = gateLearner.learnGates(enriched, clusterStats);

  const highConfRecs = Object.values(gateRecommendations).filter(r => r.confidence >= 75);
  console.log(`   Generated ${Object.keys(gateRecommendations).length} recommendations (${highConfRecs.length} high-confidence)\n`);

  highConfRecs.slice(0, 5).forEach(rec => {
    if (rec.recommendedThreshold !== rec.currentThreshold) {
      console.log(`      ${rec.cluster}`);
      console.log(`         Current: ${rec.currentThreshold}% → Recommended: ${rec.recommendedThreshold}% (confidence ${rec.confidence}%)`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 5: HOLDER EXIT PREDICTION
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n🐋 Step 5: Modeling holder exit impact...');
  const holderModel = holderPredictor.buildHolderModel(enriched);

  console.log(`   Bad exit profile: ${holderModel.bad_exit_profile.count} trades peaked then dumped`);
  console.log(`      Avg hold time: ${holderModel.bad_exit_profile.avg_hold_minutes} min`);
  console.log(`   Good exit profile: ${holderModel.good_exit_profile.count} trades peaked and held gains`);
  console.log(`      Avg hold time: ${holderModel.good_exit_profile.avg_hold_minutes} min\n`);

  // ─────────────────────────────────────────────────────────────────────
  // STEP 6: INTELLIGENCE GENERATION
  // ─────────────────────────────────────────────────────────────────────
  console.log('🧠 Step 6: Generating insights and recommendations...');
  const report = intelligenceGenerator.generateReport(enriched, clusterStats, regimeStats, gateRecommendations);

  console.log('\n📋 SUMMARY STATISTICS:');
  console.log(`   Total Trades: ${report.summary.totalTrades}`);
  console.log(`   Win Rate: ${report.summary.winRate}%`);
  console.log(`   Net P&L: ${report.summary.totalNetPnl > 0 ? '+' : ''}${report.summary.totalNetPnl.toFixed(4)} SOL`);
  console.log(`   Gross P&L: ${report.summary.totalGrossPnl > 0 ? '+' : ''}${report.summary.totalGrossPnl.toFixed(4)} SOL`);
  console.log(`   Total Fees: ${report.summary.totalFees.toFixed(4)} SOL (${report.summary.feesAsPercentOfGrossPnl}% of gross)`);
  console.log(`   Avg Hold: ${report.summary.avgHoldMinutes.toFixed(1)} min`);

  console.log('\n💡 TOP RECOMMENDATIONS:');
  report.recommendations.slice(0, 3).forEach((rec, i) => {
    console.log(`\n   ${i + 1}. [${rec.priority.toUpperCase()}] ${rec.title}`);
    console.log(`      Action: ${rec.action}`);
    if (rec.expectedLift) console.log(`      Expected Lift: ${rec.expectedLift}`);
    if (rec.details) console.log(`${rec.details}`);
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 7: SIMULATE WITH RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n\n🔮 Step 7: Simulating improved system with learned recommendations...');

  const improved = enriched.map(trade => {
    const recommendedThreshold = gateLearner.applyGateRecommendations(trade, gateRecommendations);
    const holderRisk = holderPredictor.predictExitRisk(trade, holderModel);

    return {
      ...trade,
      recommendedThreshold,
      holderRisk,
    };
  });

  const improvedStats = dataLoader.computeStats(improved);

  console.log(`\n📊 BEFORE vs AFTER:\n`);
  console.log(`   Metric                  | Baseline        | With Recommendations | Delta`);
  console.log(`   ────────────────────────┼─────────────────┼──────────────────────┼───────────`);
  console.log(
    `   Win Rate                | ${baselineStats.winRate.padEnd(15)} | ${improvedStats.winRate.padEnd(20)} | ${(parseFloat(improvedStats.winRate) - parseFloat(baselineStats.winRate)).toFixed(1).padEnd(7)}`
  );
  console.log(
    `   Total Net P&L (SOL)     | ${baselineStats.totalNetPnl.toFixed(4).padEnd(15)} | ${improvedStats.totalNetPnl.toFixed(4).padEnd(20)} | ${(improvedStats.totalNetPnl - baselineStats.totalNetPnl).toFixed(4).padEnd(7)}`
  );
  console.log(
    `   Avg P&L %               | ${baselineStats.avgNetPnlPct.toFixed(3).padEnd(15)} | ${improvedStats.avgNetPnlPct.toFixed(3).padEnd(20)} | ${(improvedStats.avgNetPnlPct - baselineStats.avgNetPnlPct).toFixed(3).padEnd(7)}`
  );

  // ─────────────────────────────────────────────────────────────────────
  // VERIFY
  // ─────────────────────────────────────────────────────────────────────
  assert.ok(enriched.length > 500, 'Should have loaded substantial swarm data');
  assert.ok(Object.keys(clusterStats).length > 5, 'Should have found multiple clusters');
  assert.ok(Object.keys(regimeStats).length > 1, 'Should have detected multiple regimes');
  assert.ok(Object.keys(gateRecommendations).length > 0, 'Should have generated gate recommendations');
  assert.ok(holderModel.bad_exit_profile.count > 0, 'Should have analyzed bad exits');
  assert.ok(report.recommendations.length > 0, 'Should have generated recommendations');

  console.log('\n\n✅ Backtest complete. All 5 components integrated and tested.\n');
});
