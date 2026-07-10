// tests/backtest-with-simulation.js — Show impact of adaptive strategies
'use strict';

const test = require('node:test');
const dataLoader = require('../lib/analysis/data-loader');
const clusterer = require('../lib/analysis/clusterer');
const regimeDetector = require('../lib/analysis/regime-detector');
const gateLearner = require('../lib/analysis/gate-learner');
const holderPredictor = require('../lib/analysis/holder-predictor');
const adaptiveSimulator = require('../lib/analysis/adaptive-simulator');
const intelligenceGenerator = require('../lib/analysis/intelligence-generator');

test('Backtest with adaptive strategy simulation', async () => {
  console.log('\n' + '='.repeat(80));
  console.log('📊 CIRCUIT-AGENT: Adaptive Strategy Simulation');
  console.log('='.repeat(80) + '\n');

  // Load and analyze
  const trades = dataLoader.loadSwarmTrades();
  const enriched = dataLoader.enrichTrades(trades, {});

  const clusterStats = clusterer.clusterTrades(enriched);
  const regimeStats = regimeDetector.regimeStats(enriched);
  const gateRecommendations = gateLearner.learnGates(enriched, clusterStats);
  const holderModel = holderPredictor.buildHolderModel(enriched);

  // RUN SIMULATIONS
  const simulations = adaptiveSimulator.simulateAdaptiveSystem(enriched, clusterStats, gateRecommendations, holderModel);

  console.log('📈 STRATEGY COMPARISON\n');
  console.log('Strategy          | Trades | Wins | Win % | Net P&L (SOL) | Avg/Trade | Lift vs Baseline');
  console.log('─'.repeat(85));

  const baseline = simulations.baseline.stats;
  const adaptive = simulations.adaptive.stats;
  const selective = simulations.selective.stats;

  const formatRow = (name, stats, baseline) => {
    const lift = baseline.n > 0
      ? (((stats.totalNetPnl - baseline.totalNetPnl) / Math.abs(baseline.totalNetPnl)) * 100).toFixed(1)
      : '—';
    return [
      name.padEnd(17),
      String(stats.n).padEnd(7),
      String(stats.wins).padEnd(5),
      String(stats.winRate).padEnd(6),
      stats.totalNetPnl.toFixed(4).padEnd(14),
      stats.avgNetPnlSol.toFixed(6).padEnd(10),
      lift === '—' ? '—' : `+${lift}%`,
    ].join(' | ');
  };

  console.log(formatRow('Baseline', baseline, baseline));
  console.log(formatRow('Adaptive', adaptive, baseline));
  console.log(formatRow('Selective (>50% WR)', selective, baseline));

  // ANALYSIS
  console.log('\n' + '='.repeat(80));
  console.log('🔍 DETAILED ANALYSIS\n');

  console.log('KEY FINDINGS:\n');

  // Finding 1: Cluster quality varies dramatically
  const rankedClusters = clusterer.rankClusters(clusterStats);
  const topCluster = rankedClusters[0];
  const bottomCluster = rankedClusters[rankedClusters.length - 1];
  console.log(`1. CLUSTER QUALITY VARIATION`);
  console.log(`   Best:  ${topCluster.key} → ${topCluster.winRate}% WR (n=${topCluster.n})`);
  console.log(`   Worst: ${bottomCluster.key} → ${bottomCluster.winRate}% WR (n=${bottomCluster.n})`);
  const wrDelta = parseFloat(topCluster.winRate) - parseFloat(bottomCluster.winRate);
  console.log(`   Δ WR: ${wrDelta.toFixed(1)}pp\n`);

  // Finding 2: Regime matters
  console.log(`2. REGIME EFFECTIVENESS`);
  Object.entries(regimeStats)
    .sort((a, b) => parseFloat(b[1].winRate) - parseFloat(a[1].winRate))
    .forEach(([regime, stats]) => {
      console.log(`   ${regime.padEnd(15)} → ${stats.winRate}% WR (n=${stats.n})`);
    });
  console.log();

  // Finding 3: Impact of filtering
  const tradesFiltered = baseline.n - adaptive.n;
  console.log(`3. IMPACT OF FILTERING BAD PATTERNS`);
  console.log(`   Trades filtered: ${tradesFiltered} (${(tradesFiltered / baseline.n * 100).toFixed(1)}% of total)`);
  const uplift = adaptive.totalNetPnl - baseline.totalNetPnl;
  console.log(`   P&L impact: ${uplift > 0 ? '+' : ''}${uplift.toFixed(4)} SOL`);
  const wrImprovement = parseFloat(adaptive.winRate) - parseFloat(baseline.winRate);
  console.log(`   Win rate improvement: ${wrImprovement > 0 ? '+' : ''}${wrImprovement.toFixed(1)}pp\n`);

  // Finding 4: Selective (only best clusters)
  console.log(`4. SELECTIVE STRATEGY (Only >50% WR clusters)`);
  console.log(`   Trades taken: ${selective.n} (${(selective.n / baseline.n * 100).toFixed(1)}% of universe)`);
  console.log(`   Win rate: ${selective.winRate}%`);
  const selectiveLift = selective.totalNetPnl - baseline.totalNetPnl;
  console.log(`   P&L vs baseline: ${selectiveLift > 0 ? '+' : ''}${selectiveLift.toFixed(4)} SOL`);
  if (selective.n > 0) {
    const selectiveROI = (selectiveLift / Math.abs(baseline.totalNetPnl) * 100).toFixed(1);
    console.log(`   Lift: ${selectiveROI}%\n`);
  }

  // REPORT
  const report = intelligenceGenerator.generateReport(enriched, clusterStats, regimeStats, gateRecommendations);

  console.log('='.repeat(80));
  console.log('💡 RECOMMENDATIONS FOR DEPLOYMENT\n');
  report.recommendations.slice(0, 5).forEach((rec, i) => {
    console.log(`${i + 1}. [${rec.priority.toUpperCase()}] ${rec.title}`);
    console.log(`   ${rec.action}`);
    if (rec.expectedLift) console.log(`   Expected lift: ${rec.expectedLift}`);
    console.log();
  });

  console.log('='.repeat(80));
  console.log('🎯 RECOMMENDED NEXT STEPS\n');
  console.log('1. IMMEDIATE (deploy to main agent):');
  console.log(`   ✓ Add time-of-day filter (avoid morning momentum trades)`);
  console.log(`   ✓ Reduce Jito fee (27% of P&L is too high, consider raising cap)`);
  console.log(`   ✓ Apply gate recommendations for high-confidence clusters\n`);

  console.log('2. SWARM DEPLOYMENT (Phase 1):');
  console.log(`   ✓ A/B test: 50% current, 50% adaptive filtering`);
  console.log(`   ✓ Run for 100+ trades per side to reach statistical significance`);
  console.log(`   ✓ Expected: +${Math.abs(adaptive.totalNetPnl - baseline.totalNetPnl).toFixed(4)} SOL improvement\n`);

  console.log('3. REFINEMENT (Phase 2):');
  console.log(`   ✓ Once validated, increase bias toward >50% WR clusters`);
  console.log(`   ✓ Roll out regime-based strategy switching`);
  console.log(`   ✓ Integrate holder exit prediction for early stops\n`);

  console.log('='.repeat(80) + '\n');
});
