// tests/tier-validation.js — Validate Tier 4, 5, 7 impact claims before building
'use strict';

const test = require('node:test');
const dataLoader = require('../lib/analysis/data-loader');
const clusterer = require('../lib/analysis/clusterer');
const regimeDetector = require('../lib/analysis/regime-detector');
const gateLearner = require('../lib/analysis/gate-learner');
const holderPredictor = require('../lib/analysis/holder-predictor');

test('TIER 4 VALIDATION: Multi-Regime Gate Learning', async () => {
  console.log('\n' + '='.repeat(80));
  console.log('🔬 TIER 4 VALIDATION: Do regime-stratified gates beat global gates?');
  console.log('='.repeat(80) + '\n');

  const trades = dataLoader.loadSwarmTrades();
  const enriched = dataLoader.enrichTrades(trades, {});

  // Current approach: Global gates (all regimes use same threshold)
  const clusterStats = clusterer.clusterTrades(enriched);
  const gateRecommendations = gateLearner.learnGates(enriched, clusterStats);

  // New approach: Regime-stratified gates
  const regimeStats = regimeDetector.regimeStats(enriched);
  const regimeStratified = {};

  // Group clusters by regime, learn gates per regime
  const tradesByRegime = {};
  enriched.forEach(t => {
    const detectedRegime = regimeDetector._detectRegime(t);
    const regime = detectedRegime.regime || 'consolidation';
    if (!tradesByRegime[regime]) tradesByRegime[regime] = [];
    tradesByRegime[regime].push(t);
  });

  console.log('TRADE DISTRIBUTION BY REGIME:');
  Object.entries(tradesByRegime).forEach(([regime, trades]) => {
    const wins = trades.filter(t => t.netPnlPct > 0).length;
    console.log(`  ${regime.padEnd(15)} : ${trades.length} trades, ${(wins/trades.length*100).toFixed(1)}% WR`);
  });

  // Now analyze: would regime-specific gates be different?
  console.log('\nGATE RECOMMENDATIONS (Global vs Per-Regime):\n');

  let regimeGatesDiffer = 0;
  let regimeGatesBetter = 0;
  let regimeGatesWorse = 0;

  Object.entries(gateRecommendations).forEach(([cluster, rec]) => {
    const [pattern, timeOfDay, liquidity] = cluster.split('|');
    const tradesInCluster = enriched.filter(t =>
      t._pattern === pattern &&
      (t._timeOfDay || 'unknown') === timeOfDay
    );

    if (!tradesInCluster.length) return;

    // Check if gate differs by regime
    const byRegime = {};
    tradesInCluster.forEach(t => {
      const detectedRegime = regimeDetector._detectRegime(t);
      const regime = detectedRegime.regime || 'consolidation';
      if (!byRegime[regime]) byRegime[regime] = [];
      byRegime[regime].push(t);
    });

    const regimeGates = {};
    Object.entries(byRegime).forEach(([regime, trades]) => {
      if (trades.length < 3) return;
      const wins = trades.filter(t => t.netPnlPct > 0).length;
      const wr = wins / trades.length;
      // Recommend tighter gate in bad regimes
      regimeGates[regime] = wr > 0.50 ? 75 : wr > 0.25 ? 60 : 40;
    });

    const globalGate = rec.recommended;
    const allSame = Object.values(regimeGates).every(g => g === globalGate);

    if (!allSame) {
      regimeGatesDiffer++;
      console.log(`${cluster}:`);
      console.log(`  Global gate: ${globalGate}%`);
      Object.entries(regimeGates).forEach(([regime, gate]) => {
        if (gate !== globalGate) {
          console.log(`  ${regime.padEnd(15)} : ${gate}% (${gate > globalGate ? '↑ LOOSER' : '↓ TIGHTER'})`);
          if (gate > globalGate) regimeGatesWorse++;
          else regimeGatesBetter++;
        }
      });
      console.log();
    }
  });

  console.log(`\nRESULT:`);
  console.log(`  Clusters with different regime gates: ${regimeGatesDiffer}`);
  console.log(`  Would be better (tighter in bad regimes): ${regimeGatesBetter}`);
  console.log(`  Would be worse (looser in bad regimes): ${regimeGatesWorse}`);

  const verdict = regimeGatesBetter > regimeGatesWorse ? '✅ TIER 4 WORTH BUILDING' : '❌ TIER 4 MARGINAL';
  console.log(`\n${verdict}: Regime-stratified gates show ${regimeGatesBetter > 0 ? 'promise' : 'no clear benefit'}\n`);
});

test('TIER 5 VALIDATION: Holder-Predictor Accuracy', async () => {
  console.log('\n' + '='.repeat(80));
  console.log('🔬 TIER 5 VALIDATION: Does holder-predictor predict actual whale dumps?');
  console.log('='.repeat(80) + '\n');

  const trades = dataLoader.loadSwarmTrades();
  const enriched = dataLoader.enrichTrades(trades, {});

  // Build holder model
  const holderModel = holderPredictor.buildHolderModel(enriched);

  console.log('HOLDER MODEL PROFILE:');
  console.log(`  Bad exits (peaked then dumped):`);
  console.log(`    Count: ${holderModel.bad_exit_profile.count}`);
  console.log(`    Avg hold: ${holderModel.bad_exit_profile.avg_hold_minutes.toFixed(1)} min`);
  console.log(`    Pattern: ${holderModel.bad_exit_profile.pattern}`);
  console.log();
  console.log(`  Good exits (peaked then held gains):`);
  console.log(`    Count: ${holderModel.good_exit_profile.count}`);
  console.log(`    Avg hold: ${holderModel.good_exit_profile.avg_hold_minutes.toFixed(1)} min`);
  console.log(`    Pattern: ${holderModel.good_exit_profile.pattern}`);

  // Now test: can we predict bad exits by hold time?
  const holdThreshold = holderModel.bad_exit_profile.avg_hold_minutes;
  const predictions = enriched.map(t => {
    const predicted = t.holdMinutes > holdThreshold ? 'bad' : 'good';
    const actual = (t.peakPnlPct - t.netPnlPct) > 2 ? 'bad' : 'good'; // peaked but lost
    return { predicted, actual, holdMinutes: t.holdMinutes, match: predicted === actual };
  });

  const correct = predictions.filter(p => p.match).length;
  const accuracy = (correct / predictions.length * 100).toFixed(1);
  const precisionBad = predictions.filter(p => p.predicted === 'bad' && p.actual === 'bad').length /
                       Math.max(1, predictions.filter(p => p.predicted === 'bad').length);

  console.log('\nPREDICTION ACCURACY (using hold time threshold):');
  console.log(`  Threshold: ${holdThreshold.toFixed(1)} min`);
  console.log(`  Overall accuracy: ${accuracy}%`);
  console.log(`  Precision (predicting bad): ${(precisionBad * 100).toFixed(1)}%`);

  const verdict = accuracy > 60 ? '✅ TIER 5 WORTH BUILDING' : accuracy > 50 ? '⚠️ TIER 5 RISKY' : '❌ TIER 5 NOT PREDICTIVE';
  console.log(`\n${verdict}: Predictor accuracy is ${accuracy}% (threshold: >60% to be useful)\n`);
});

test('TIER 7 VALIDATION: Dynamic Position Sizing Impact', async () => {
  console.log('\n' + '='.repeat(80));
  console.log('🔬 TIER 7 VALIDATION: Does dynamic sizing beat fixed sizing?');
  console.log('='.repeat(80) + '\n');

  const trades = dataLoader.loadSwarmTrades();
  const enriched = dataLoader.enrichTrades(trades, {});
  const regimeStats = regimeDetector.regimeStats(enriched);

  // Baseline: fixed 0.005 SOL entry
  const baselineSize = 0.005;
  const baselineP = enriched.reduce((sum, t) => sum + (t.netPnlSol ?? 0), 0);
  const baselineTrades = enriched.length;

  // Dynamic sizing: scale by regime
  const sizeMultipliers = {
    bull: 1.5,
    consolidation: 1.0,
    recovery: 0.3,
    dump: 0.0
  };

  const dynamicTrades = enriched.map(t => {
    const detectedRegime = regimeDetector._detectRegime(t);
    const regime = detectedRegime.regime || 'consolidation';
    const sizeMultiplier = sizeMultipliers[regime] ?? 1.0;
    const dynamicSize = baselineSize * sizeMultiplier;
    return {
      ...t,
      dynamicSize,
      dynamicNetPnl: (t.netPnlSol ?? 0) * sizeMultiplier, // scale P&L by size
    };
  });

  const dynamicP = dynamicTrades.reduce((sum, t) => sum + t.dynamicNetPnl, 0);

  console.log('POSITION SIZING COMPARISON:');
  console.log(`  Fixed size: ${baselineSize} SOL → ${baselineP.toFixed(4)} SOL P&L`);
  console.log(`  Dynamic size (regime-scaled) → ${dynamicP.toFixed(4)} SOL P&L`);
  console.log(`  Difference: ${(dynamicP - baselineP).toFixed(4)} SOL (${((dynamicP - baselineP) / Math.abs(baselineP) * 100).toFixed(1)}%)`);

  console.log('\nBREAKDOWN BY REGIME:');
  Object.entries(sizeMultipliers).forEach(([regime, mult]) => {
    const regimeWins = regimeStats[regime];
    if (!regimeWins) return;
    console.log(`  ${regime.padEnd(15)} : ${mult}× size, ${regimeWins.winRate}% WR (${regimeWins.n} trades)`);
  });

  // Account for risk: would smaller sizes in bad regimes actually help?
  const recoveryTrades = enriched.filter(t => regimeDetector._detectRegime(t).regime === 'recovery');
  const recoveryLosses = recoveryTrades.reduce((sum, t) => sum + Math.min(0, t.netPnlSol ?? 0), 0);
  const recoveryLossesAvoided = recoveryLosses * (1 - 0.3); // 0.3× size = 70% losses avoided

  console.log('\nRISK MITIGATION:');
  console.log(`  Recovery trades: ${recoveryTrades.length}`);
  console.log(`  Current losses in recovery: ${recoveryLosses.toFixed(4)} SOL`);
  console.log(`  Potential savings (0.3× sizing): ${recoveryLossesAvoided.toFixed(4)} SOL`);

  const verdict = Math.abs(dynamicP) < Math.abs(baselineP) ? '✅ TIER 7 WORTH BUILDING' : '❌ TIER 7 NO CLEAR WIN';
  console.log(`\n${verdict}: Dynamic sizing ${Math.abs(dynamicP) < Math.abs(baselineP) ? 'improves' : 'does not improve'} net P&L\n`);
});

console.log('\n' + '='.repeat(80));
console.log('VALIDATION SUMMARY');
console.log('='.repeat(80));
console.log('Run this test to see which tiers are actually worth building.');
console.log('If a tier shows ❌, we skip it and save effort.');
console.log('If a tier shows ✅, we proceed with confidence.\n');
