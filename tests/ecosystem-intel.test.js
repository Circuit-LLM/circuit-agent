// tests/ecosystem-intel.test.js — test suite for Ecosystem Intel Feed
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ecosystemIntel = require('../lib/ecosystem-intel');

const TEST_DATA_DIR = path.join(__dirname, '../data');
const HEALTH_FILE = path.join(TEST_DATA_DIR, 'ecosystem_health.json');
const ALERTS_FILE = path.join(TEST_DATA_DIR, 'ecosystem_alerts.json');

function cleanup() {
  try { fs.unlinkSync(HEALTH_FILE); } catch {}
  try { fs.unlinkSync(ALERTS_FILE); } catch {}
}

test('Ecosystem Intel', async (t) => {
  await t.test('should initialize with empty health/alerts', () => {
    cleanup();
    ecosystemIntel.initialize();
    assert(fs.existsSync(HEALTH_FILE), 'Health file should be created');
    assert(fs.existsSync(ALERTS_FILE), 'Alerts file should be created');
    const health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    const alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    assert.deepStrictEqual(health.history, []);
    assert.deepStrictEqual(alerts.alerts, []);
  });

  await t.test('should not run if ecosystem monitoring is disabled', async () => {
    cleanup();
    ecosystemIntel.initialize();

    const cfg = { strategy: { ecosystemEnabled: false } };
    const ctx = { wallet: null };

    await ecosystemIntel.checkHealth(cfg, ctx, null);

    // Files should remain untouched (only history, no current entry)
    const health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    assert(!health.current, 'Should not have current entry if disabled');
  });

  await t.test('should skip if no wallet context', async () => {
    cleanup();
    ecosystemIntel.initialize();

    const cfg = { strategy: { ecosystemEnabled: true } };
    const ctx = { wallet: null };

    await ecosystemIntel.checkHealth(cfg, ctx, null);

    const health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    assert(!health.current, 'Should not record health without wallet');
  });

  await t.test('should record health check with score', async () => {
    cleanup();
    ecosystemIntel.initialize();

    const cfg = {
      strategy: {
        ecosystemEnabled: true,
        ecosystemMinTps: 400,
        ecosystemMaxMevPercent: 25,
        ecosystemMinValidators: 400,
      },
    };

    const ctx = {
      wallet: {
        connection: {
          getRecentPrioritizationFees: async () => [50000, 75000, 100000],
          getClusterNodes: async () => Array(420).fill({ vote: true }),
          getBlockHeight: async () => 123456789,
          getSlot: async () => 234567890,
        },
      },
    };

    await ecosystemIntel.checkHealth(cfg, ctx, null);

    const health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    assert(health.current, 'Current health should be recorded');
    assert.equal(typeof health.current.score, 'number');
    assert.ok(health.current.score >= 0 && health.current.score <= 100);
    assert.ok(Array.isArray(health.current.breakdown));
    assert.ok(health.history.length > 0);
  });

  await t.test('should alert when validators fall below threshold', async () => {
    cleanup();
    ecosystemIntel.initialize();

    const cfg = {
      strategy: {
        ecosystemEnabled: true,
        ecosystemMinTps: 400,
        ecosystemMaxMevPercent: 25,
        ecosystemMinValidators: 400,
      },
      telegram: { chatId: '123' },
    };

    // First run with healthy validator count
    const ctx1 = {
      wallet: {
        connection: {
          getRecentPrioritizationFees: async () => [50000],
          getClusterNodes: async () => Array(420).fill({ vote: true }),
          getBlockHeight: async () => 123456789,
          getSlot: async () => 234567890,
        },
      },
    };

    await ecosystemIntel.checkHealth(cfg, ctx1, null);

    // Second run with degraded validator count
    const ctx2 = {
      wallet: {
        connection: {
          getRecentPrioritizationFees: async () => [50000],
          getClusterNodes: async () => Array(250).fill({ vote: true }), // Below 400
          getBlockHeight: async () => 123456789,
          getSlot: async () => 234567891, // Different slot
        },
      },
    };

    await ecosystemIntel.checkHealth(cfg, ctx2, null);

    const alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    assert.ok(alerts.recent?.length > 0 || alerts.alerts?.length > 0, 'Alerts should be generated for low validators');
  });

  await t.test('should detect validator count below threshold', async () => {
    cleanup();
    ecosystemIntel.initialize();

    const cfg = {
      strategy: {
        ecosystemEnabled: true,
        ecosystemMinValidators: 400,
        ecosystemMinTps: 400,
        ecosystemMaxMevPercent: 25,
      },
    };

    const ctx = {
      wallet: {
        connection: {
          getRecentPrioritizationFees: async () => [50000],
          getClusterNodes: async () => Array(300).fill({ vote: true }), // Below 400
          getBlockHeight: async () => 123456789,
          getSlot: async () => 234567890,
        },
      },
    };

    await ecosystemIntel.checkHealth(cfg, ctx, null);

    const health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    assert(health.current.score < 100, 'Score should be reduced for low validator count');
    assert.ok(health.current.breakdown.some(b => b.includes('Validators')));
  });

  await t.test('should calculate health score correctly', async () => {
    cleanup();
    ecosystemIntel.initialize();

    const cfg = {
      strategy: {
        ecosystemEnabled: true,
        ecosystemMinTps: 400,
        ecosystemMaxMevPercent: 25,
        ecosystemMinValidators: 400,
      },
    };

    // Healthy network
    const ctx = {
      wallet: {
        connection: {
          getRecentPrioritizationFees: async () => [30000, 40000, 50000],
          getClusterNodes: async () => Array(450).fill({ vote: true }),
          getBlockHeight: async () => 123456789,
          getSlot: async () => 234567890,
        },
      },
    };

    await ecosystemIntel.checkHealth(cfg, ctx, null);

    let health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    const healthyScore = health.current.score;
    assert.ok(healthyScore >= 80, 'Healthy network should have high score');

    // Degraded network (manually set stats)
    fs.unlinkSync(HEALTH_FILE);
    ecosystemIntel.initialize();

    // Mock degraded conditions
    ctx.wallet.connection.getClusterNodes = async () => Array(250).fill({ vote: true }); // Very low
    ctx.wallet.connection.getRecentPrioritizationFees = async () => Array(10).fill(200000); // High fees

    await ecosystemIntel.checkHealth(cfg, ctx, null);

    health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    const degradedScore = health.current.score;
    assert.ok(degradedScore < healthyScore, 'Degraded network should have lower score');
  });

  await t.test('should maintain alert history', async () => {
    cleanup();
    ecosystemIntel.initialize();

    const cfg = {
      strategy: {
        ecosystemEnabled: true,
        ecosystemMinTps: 400,
        ecosystemMaxMevPercent: 25,
        ecosystemMinValidators: 400,
      },
    };

    // Trigger multiple health checks with varying conditions
    const baseCtx = (validatorCount = 450) => ({
      wallet: {
        connection: {
          getRecentPrioritizationFees: async () => [50000],
          getClusterNodes: async () => Array(validatorCount).fill({ vote: true }),
          getBlockHeight: async () => 123456789 + Math.random() * 100,
          getSlot: async () => 234567890 + Math.random() * 100,
        },
      },
    });

    await ecosystemIntel.checkHealth(cfg, baseCtx(450), null);
    await ecosystemIntel.checkHealth(cfg, baseCtx(350), null);
    await ecosystemIntel.checkHealth(cfg, baseCtx(300), null);

    const alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    assert.ok(Array.isArray(alerts.alerts));
  });

  cleanup();
});
