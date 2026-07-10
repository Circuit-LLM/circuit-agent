// lib/lp-optimizer.js — LP position management for circuit-agent
// Runs every 1h: harvests fees, rebalances imbalanced positions
//
// State files:
//   data/lp_positions.json  — active LP positions
//   data/lp_executions.json — append-only audit log
//   data/lp_health.json     — current health snapshot
'use strict';

const fs   = require('fs');
const path = require('path');

const LP_POSITIONS_FILE = path.join(__dirname, '../data/lp_positions.json');
const LP_EXECUTIONS_FILE = path.join(__dirname, '../data/lp_executions.json');
const LP_HEALTH_FILE = path.join(__dirname, '../data/lp_health.json');

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [LPOPT] [${level.toUpperCase()}] ${line}\n`);
};

function _loadJsonSafe(file, defaults = null) {
  try {
    if (!fs.existsSync(file)) return defaults;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('warn', `Failed to load ${path.basename(file)}: ${e.message}`);
    return defaults;
  }
}

function _saveJsonAtomic(file, data) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, file);
    return true;
  } catch (e) {
    log('error', `Failed to save ${path.basename(file)}: ${e.message}`);
    return false;
  }
}

function _appendExecution(execution) {
  try {
    const executions = _loadJsonSafe(LP_EXECUTIONS_FILE, []);
    executions.push(execution);
    _saveJsonAtomic(LP_EXECUTIONS_FILE, executions);
  } catch (e) {
    log('error', `Failed to append execution: ${e.message}`);
  }
}

function _validateRatio(ratio) {
  if (typeof ratio !== 'number' || !isFinite(ratio)) return 0;
  if (ratio < 0 || ratio > 1) return 0;
  return ratio;
}

function _computeImbalance(ratio) {
  const target = 0.5;
  const delta = Math.abs(ratio - target);
  return delta;
}

function _isImbalanced(ratio, threshold = 0.15) {
  return _computeImbalance(ratio) > threshold;
}

async function _queryChainPosition(mint, wallet, api) {
  try {
    if (!api || typeof api.getLpPosition !== 'function') {
      return null;
    }
    const pos = await api.getLpPosition(mint, wallet.address);
    if (!pos) return null;
    return {
      mint,
      liquidity: pos.liquidity ?? 0,
      unclaimed: pos.unclaimedFeesUsd ?? 0,
      ratio: _validateRatio(pos.tokenARatio ?? 0.5),
      lastUpdated: new Date().toISOString(),
    };
  } catch (e) {
    log('warn', `Query chain failed for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

async function _harvestFees(position, swap, wallet, cfg, notify) {
  const harvestThreshold = (cfg.strategy?.lpHarvestThresholdUsd ?? 5.0);
  if (position.unclaimed < harvestThreshold) {
    return null;
  }

  try {
    if (!swap || typeof swap.harvestLpFees !== 'function') {
      log('warn', `Harvest not available for ${position.mint.slice(0, 8)}`);
      return null;
    }

    const txSig = await swap.harvestLpFees(position.mint, wallet.keypair, {
      slippageBps: cfg.strategy?.slippageBps ?? 100,
    });

    const execution = {
      timestamp: new Date().toISOString(),
      action: 'harvest',
      mint: position.mint,
      unclaimedUsd: position.unclaimed,
      txSig,
      status: 'pending',
    };
    _appendExecution(execution);

    if (notify) {
      notify(`LP harvest on ${position.mint.slice(0, 8)}… — $${position.unclaimed.toFixed(2)} claimed`);
    }
    log('info', 'Harvested LP fees', { mint: position.mint.slice(0, 8), usd: position.unclaimed.toFixed(2), tx: txSig.slice(0, 8) });

    return { action: 'harvest', txSig, unclaimedUsd: position.unclaimed };
  } catch (e) {
    log('error', `Harvest failed for ${position.mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

async function _rebalance(position, swap, wallet, cfg, notify) {
  const threshold = cfg.strategy?.lpRebalanceThreshold ?? 0.15;
  if (!_isImbalanced(position.ratio, threshold)) {
    return null;
  }

  const imbalance = _computeImbalance(position.ratio);
  const target = 0.5;
  const current = position.ratio;
  const side = current > target ? 'A' : 'B';
  const amount = position.liquidity * imbalance * 0.5;

  try {
    if (!swap || typeof swap.rebalanceLpPosition !== 'function') {
      log('warn', `Rebalance not available for ${position.mint.slice(0, 8)}`);
      return null;
    }

    const txSig = await swap.rebalanceLpPosition(position.mint, side, amount, wallet.keypair, {
      slippageBps: cfg.strategy?.slippageBps ?? 100,
    });

    const execution = {
      timestamp: new Date().toISOString(),
      action: 'rebalance',
      mint: position.mint,
      side,
      amountSol: amount,
      beforeRatio: current,
      targetRatio: target,
      txSig,
      status: 'pending',
    };
    _appendExecution(execution);

    if (notify) {
      const pct = ((current - target) * 100).toFixed(1);
      notify(`LP rebalance on ${position.mint.slice(0, 8)}… — side ${side}, ${pct}% off target`);
    }
    log('info', 'Rebalanced LP position', {
      mint: position.mint.slice(0, 8),
      side,
      ratio: current.toFixed(3),
      imbalance: imbalance.toFixed(3),
      tx: txSig.slice(0, 8),
    });

    return { action: 'rebalance', txSig, side, amount, beforeRatio: current };
  } catch (e) {
    log('error', `Rebalance failed for ${position.mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

async function checkLpPositions(cfg, ctx, telegramBot) {
  const lpPositions = _loadJsonSafe(LP_POSITIONS_FILE, []);
  if (!lpPositions.length) {
    log('info', 'No LP positions configured — skipping cycle');
    return;
  }

  const harvestEnabled = cfg.strategy?.lpHarvestEnabled ?? true;
  const rebalanceEnabled = cfg.strategy?.lpRebalanceEnabled ?? true;
  const notify = telegramBot && typeof telegramBot.sendMessage === 'function'
    ? (msg) => telegramBot.sendMessage(msg).catch(() => {})
    : null;

  const health = {
    timestamp: new Date().toISOString(),
    positions: [],
    summary: { total: 0, harvested: 0, rebalanced: 0, errors: 0 },
  };

  for (const position of lpPositions) {
    try {
      const chain = await _queryChainPosition(position.mint, ctx.wallet, ctx.api);
      if (!chain) {
        health.summary.errors++;
        health.positions.push({
          mint: position.mint,
          error: 'Query failed',
          lastHarvest: position.lastHarvest,
          lastRebalance: position.lastRebalance,
        });
        continue;
      }

      let harvested = false;
      let rebalanced = false;

      if (harvestEnabled) {
        const result = await _harvestFees(chain, ctx.swap, ctx.wallet, cfg, notify);
        if (result) {
          harvested = true;
          health.summary.harvested++;
          position.lastHarvest = new Date().toISOString();
        }
      }

      if (rebalanceEnabled) {
        const result = await _rebalance(chain, ctx.swap, ctx.wallet, cfg, notify);
        if (result) {
          rebalanced = true;
          health.summary.rebalanced++;
          position.lastRebalance = new Date().toISOString();
        }
      }

      health.positions.push({
        mint: position.mint,
        dex: position.dex,
        liquidity: chain.liquidity,
        unclaimed: chain.unclaimed,
        ratio: chain.ratio,
        imbalanced: _isImbalanced(chain.ratio, cfg.strategy?.lpRebalanceThreshold ?? 0.15),
        harvested,
        rebalanced,
        lastHarvest: position.lastHarvest,
        lastRebalance: position.lastRebalance,
      });
      health.summary.total++;
    } catch (e) {
      log('error', `Cycle error for ${position.mint.slice(0, 8)}: ${e.message}`);
      health.summary.errors++;
      health.positions.push({
        mint: position.mint,
        error: e.message,
        lastHarvest: position.lastHarvest,
        lastRebalance: position.lastRebalance,
      });
    }
  }

  _saveJsonAtomic(LP_POSITIONS_FILE, lpPositions);
  _saveJsonAtomic(LP_HEALTH_FILE, health);

  if (health.summary.total > 0) {
    log('info', 'LP cycle complete', health.summary);
  }
}

function start(cfg, ctx, telegramBot) {
  if (!cfg.strategy?.lpOptimizeEnabled) {
    log('info', 'LP optimizer disabled in config');
    return;
  }

  const intervalMs = cfg.strategy?.lpOptimizeIntervalMs ?? (60 * 60_000);
  log('info', `LP optimizer starting (${(intervalMs / 60_000).toFixed(0)}min cycle)`);

  setInterval(() => {
    checkLpPositions(cfg, ctx, telegramBot)
      .catch(e => log('error', `LP cycle crashed: ${e.message}`));
  }, intervalMs);

  checkLpPositions(cfg, ctx, telegramBot)
    .catch(e => log('error', `Initial LP check failed: ${e.message}`));
}

module.exports = {
  checkLpPositions,
  start,
  _loadJsonSafe,
  _saveJsonAtomic,
  _validateRatio,
  _computeImbalance,
  _isImbalanced,
};
