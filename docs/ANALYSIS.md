# Adaptive Trading Intelligence System

circuit-agent includes a comprehensive **5-component analysis system** that learns trading patterns from historical data and generates data-driven recommendations. This guide explains how it works, how to use it, and what the results mean.

## Overview

The system analyzes your trade history (and swarm history) to discover:
- **Which patterns actually work** — clustering by entry type, time of day, market regime
- **Optimal entry thresholds** — buyRatio caps tuned per pattern-regime combination
- **Exit timing** — when positions are likely to blow up based on holder behavior
- **Market regime effects** — how bull vs. consolidation vs. recovery markets change entry quality

All analysis is **quantified and backtested** on real trade data before recommendations are generated.

## Components

### 1. Clusterer (`lib/analysis/clusterer.js`)

Groups trades into **decision buckets** and ranks them by win rate.

**What it does:**
- Reads all trades (local + swarm)
- Classifies each by: `pattern` (dip-reversal / momentum / bounce / scalp), `timeOfDay` (morning/afternoon/evening/night), `liquidity` (high/medium/low)
- Computes win rate, P&L, hold time, and variance for each cluster
- Outputs ranked list: best clusters first

**Example output:**
```
momentum | evening | medium       → 61.5% WR (n=13, avg +0.002 SOL)
other | afternoon | medium        → 30.9% WR (n=64, avg -0.0001 SOL)
momentum | morning | medium        →  0.0% WR (n=6, avg -0.0002 SOL)
```

**Use case:** "Which types of trades actually win?" This is your baseline for what to bias and what to avoid.

---

### 2. Regime Detector (`lib/analysis/regime-detector.js`)

Classifies **market state at each trade entry** and measures win rates by regime.

**What it does:**
- Reconstructs market regime from trade metadata: peak P&L, hold time, exit price vs. entry
- Classifies as: `bull` (strong uptrend), `consolidation` (flat), `recovery` (bouncing from dump), `dump` (sharp downtrend)
- Groups all trades by detected regime
- Computes win rate per regime

**Example output:**
```
bull         → 53.3% WR (n=15)
consolidation → 26.4% WR (n=812)
dump         → 28.6% WR (n=21)
recovery     →  0.0% WR (n=103)
```

**Use case:** "Which market conditions are favorable?" Entering in recovery regime is 0%, bull is 53% — regime matters hugely for entry quality.

---

### 3. Gate Learner (`lib/analysis/gate-learner.js`)

Optimizes **entry thresholds** (buyRatio caps) per pattern-regime combo.

**What it does:**
- For each cluster, simulates different buyRatio thresholds (40%, 50%, 60%, 70%, 80%)
- Measures: which threshold maximizes wins while minimizing losses for that cluster?
- Generates recommendations with confidence scores
- Outputs: "For momentum|evening|medium, current 65% → recommended 75%" (more permissive because it wins)

**Example recommendations:**
```
momentum | evening | medium
  Current: 65% → Recommended: 75% (confidence 87%, n=13)
  Reasoning: 8/13 trades at >65% buyRatio, 7 won. Tighten threshold would filter winners.

momentum | morning | medium
  Current: 65% → Recommended: 40% (confidence 85%, n=6)
  Reasoning: 0/6 trades won regardless of buyRatio. Already losing; tighten to reduce entry freq.
```

**Use case:** "What buyRatio cap works best for each pattern?" Auto-tune gates instead of hand-tweaking.

---

### 4. Holder Predictor (`lib/analysis/holder-predictor.js`)

Models **when positions will exit badly** (peaked high then dumped).

**What it does:**
- Analyzes trades that peaked high but exited negative (likely holder dumps)
- Computes typical hold times for bad exits vs. good exits
- Generates risk profiles and exit-timing predictions
- Outputs: "If peaked but fading after 100+ minutes, likely a whale exit in progress"

**Example output:**
```
Bad exit profile (peaked high, ended negative):
  Count: 6 trades
  Avg hold time: 106.5 minutes
  Pattern: Peaked hard then faded to loss

Good exit profile (peaked and held gains):
  Count: 27 trades
  Avg hold time: 28.9 minutes
  Pattern: Peaked then stayed profitable
```

**Use case:** "How long can I safely hold?" Trades that hold >90 min after peak are more likely to dump. Tighten stops if you're past the typical exit window.

---

### 5. Intelligence Generator (`lib/analysis/intelligence-generator.js`)

**Synthesizes all signals** into actionable recommendations.

**What it does:**
- Reads outputs from all 4 above components
- Ranks winning clusters, identifies losing clusters
- Computes cost breakdowns (fees as % of P&L)
- Generates prioritized recommendations with confidence
- Outputs: structured report with actions

**Example recommendation:**
```
[HIGH] Bias winning patterns
  Action: Increase position sizing for "momentum | evening | medium" (61.5% WR)
  Expected lift: +18.8pp on future trades

[HIGH] Avoid losing patterns
  Action: Reduce entry frequency for "momentum | morning | medium" (0% WR)
  Expected lift: +12.0pp on future trades
```

---

## Backtest Simulator

`lib/analysis/adaptive-simulator.js` shows the **impact of applying recommendations**.

**Three scenarios:**
1. **Baseline** — all trades (current behavior)
2. **Adaptive** — filter out <15% WR clusters (avoid obvious losers)
3. **Selective** — only take >50% WR clusters (high-confidence only)

**Example results on 951 swarm trades:**

| Strategy | Trades | Win % | Net P&L | Lift |
|----------|--------|-------|---------|------|
| Baseline | 951 | 24.0% | -0.1297 SOL | — |
| Adaptive | 837 | 25.8% | -0.1052 SOL | +18.9% |
| Selective | 13 | 61.5% | -0.0049 SOL | +96.2% |

**Interpretation:**
- Filtering just 114 bad trades (12%) saves +0.0245 SOL
- Only 13 trades fit "very high confidence" criteria, but they're 61.5% WR
- Adaptive is realistic (deployable), Selective is aspirational (too conservative)

---

## Running Analysis

### View Full Analysis Report

```bash
npm test -- tests/backtest-full-system.js
```

Runs all 5 components on swarm data, outputs insights:
- Cluster rankings (best/worst patterns)
- Regime stats (win rates per regime)
- Gate recommendations (threshold adjustments)
- Holder exit profiles
- Actionable recommendations

### Simulate with Recommendations Applied

```bash
npm test -- tests/backtest-with-simulation.js
```

Shows before/after impact:
- Baseline vs. adaptive vs. selective strategies
- What filtering bad clusters would have saved
- Top recommendations with confidence levels

### Integrate into Agent (Planned)

Once validated on live swarm data:

```bash
# Enable adaptive gate learning
config/agent.local.json:
{
  "strategy": {
    "adaptiveGatesEnabled": true,
    "regimeDetectionEnabled": true,
    "holderExitPredictionEnabled": true
  }
}
```

Agent will auto-apply learned thresholds from each scan.

---

## Interpreting Recommendations

### Confidence Levels

- **High (85%+)**: Large sample size (n>10), clear statistical separation. Safe to apply.
- **Medium (60-85%)**: Smaller sample (n=5-10) or mixed signals. Apply cautiously.
- **Low (<60%)**: Tiny sample (n<5) or noisy data. Treat as exploratory only.

### Expected Lift

Projections are **conservative** — based on retrospective analysis, not forward guarantees:
- "*+18.8pp expected lift*" = if we'd filtered these clusters in the past, win rate would've been ~43% instead of 24%
- Actual live lift may be higher (market regime still favorable) or lower (conditions shifted)
- Always validate with A/B test on live data before committing fully

### False Positives

Beware:
- **Overfitting**: 951 trades isn't huge; some patterns may be noise
- **Regime shift**: If market conditions change (e.g., bull → bear), regime stats rot
- **Selection bias**: Time-of-day patterns might correlate with regime, not causally affect WR

**Mitigation:** Re-run analysis monthly, track recommendation accuracy live, start with conservative filtering.

---

## Configuration

Add to `config/agent.local.json`:

```json
{
  "analysis": {
    "enabled": true,
    "clusteringEnabled": true,
    "regimeDetectionEnabled": true,
    "gateOptimizationEnabled": true,
    "holderExitPredictionEnabled": true,
    "recommendationThreshold": "high"
  }
}
```

**recommendationThreshold** — which confidence levels to act on:
- `"high"` (85%+): Conservative. Few changes, high confidence.
- `"medium"` (60%+): Moderate. More changes, balanced risk.
- `"low"` (any): Aggressive. Act on all recommendations, including speculative ones.

---

## Data Privacy

All analysis runs **locally** on your trade history and swarm data. No analysis data is sent to external services.

## Next Steps

1. **Run backtest** — see what's in your historical data
2. **Review recommendations** — do the top patterns match your intuition?
3. **A/B test** — if deploying, run 50% baseline vs. 50% adaptive on your swarm agents
4. **Monitor accuracy** — track whether recommended regimes match reality
5. **Re-calibrate monthly** — market conditions change; re-run analysis quarterly

See **BUILDING.md** for how to extend the analysis system with custom metrics.
