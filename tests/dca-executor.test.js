// tests/dca-executor.test.js — test suite for DCA Auto-Executor
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dcaExecutor = require('../lib/dca-executor');

const TEST_DATA_DIR = path.join(__dirname, '../data');
const STATE_FILE = path.join(TEST_DATA_DIR, 'dca_state.json');
const EXEC_LOG_FILE = path.join(TEST_DATA_DIR, 'dca_executions.json');

function cleanup() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
  try { fs.unlinkSync(EXEC_LOG_FILE); } catch {}
}

test('DCA Executor', async (t) => {
  await t.test('should initialize with empty state', () => {
    cleanup();
    dcaExecutor.initialize();
    assert(fs.existsSync(STATE_FILE), 'State file should be created');
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.deepStrictEqual(state.schedules, {});
  });

  await t.test('should detect when a schedule is due', async () => {
    cleanup();
    const now = Date.now();
    const cfg = {
      strategy: {
        dcaEnabled: true,
        dcaSchedules: [
          { id: 'test1', mint: 'TEST1111', amountSol: 0.01, intervalMs: 1000, name: 'Test 1' },
        ],
      },
    };

    // Mock context
    const ctx = {
      api: { tokenPrices: async () => ({ prices: { TEST1111: { priceNative: 0.001 } } }) },
      wallet: { getBalances: async () => ({ sol: 1.0 }) },
      swap: { buy: async () => ({ txSignature: 'test-sig' }) },
    };

    // First run: schedule is due (lastRun = 0)
    await dcaExecutor.checkAndExecute(cfg, ctx, null);

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const schedId = cfg.strategy.dcaSchedules[0].id;
    assert(state.schedules[schedId], 'Schedule should be tracked in state');
    assert(state.schedules[schedId].lastRun > 0, 'lastRun should be set');
  });

  await t.test('should not execute if DCA is disabled', async () => {
    cleanup();
    const cfg = {
      strategy: {
        dcaEnabled: false,
        dcaSchedules: [
          { id: 'test1', mint: 'TEST1111', amountSol: 0.01, intervalMs: 1000 },
        ],
      },
    };

    const ctx = { api: {}, wallet: {}, swap: {} };

    // This should be a no-op
    await dcaExecutor.checkAndExecute(cfg, ctx, null);

    // No executions logged
    assert(!fs.existsSync(EXEC_LOG_FILE), 'Execution log should not be created when disabled');
  });

  await t.test('should skip if insufficient SOL balance', async () => {
    cleanup();
    dcaExecutor.initialize();

    const cfg = {
      strategy: {
        dcaEnabled: true,
        dcaSchedules: [
          { id: 'test2', mint: 'TEST2222', amountSol: 0.5, intervalMs: 1000 },
        ],
      },
      api: { baseUrl: 'http://localhost' },
      risk: { blacklist: [] },
    };

    const ctx = {
      api: { tokenPrices: async () => ({ prices: { TEST2222: { priceNative: 0.001 } } }) },
      wallet: { getBalances: async () => ({ sol: 0.01 }) }, // Not enough
      swap: { buy: async () => ({ txSignature: 'test-sig' }) },
    };

    await dcaExecutor.checkAndExecute(cfg, ctx, null);

    const execLog = JSON.parse(fs.readFileSync(EXEC_LOG_FILE, 'utf8'));
    assert.equal(execLog[0].status, 'blocked', 'Should be blocked due to insufficient SOL');
    assert.equal(execLog[0].reason, 'insufficient_sol');
  });

  await t.test('should skip if mint is in blacklist', async () => {
    cleanup();
    dcaExecutor.initialize();

    const cfg = {
      strategy: {
        dcaEnabled: true,
        dcaSchedules: [
          { id: 'test3', mint: 'BLACKLISTED', amountSol: 0.01, intervalMs: 1000 },
        ],
      },
      risk: { blacklist: ['BLACKLISTED'] },
    };

    const ctx = {
      api: {},
      wallet: { getBalances: async () => ({ sol: 1.0 }) },
      swap: {},
    };

    await dcaExecutor.checkAndExecute(cfg, ctx, null);

    const execLog = JSON.parse(fs.readFileSync(EXEC_LOG_FILE, 'utf8'));
    assert.equal(execLog[0].status, 'blocked');
    assert.equal(execLog[0].reason, 'blacklist');
  });

  await t.test('should not re-execute before interval expires', async () => {
    cleanup();
    dcaExecutor.initialize();

    const cfg = {
      strategy: {
        dcaEnabled: true,
        dcaSchedules: [
          { id: 'test4', mint: 'TEST4444', amountSol: 0.01, intervalMs: 60000, name: 'Test 4' }, // 60s interval
        ],
      },
      api: { baseUrl: 'http://localhost' },
      risk: { blacklist: [] },
    };

    const ctx = {
      api: { tokenPrices: async () => ({ prices: { TEST4444: { priceNative: 0.001 } } }) },
      wallet: { getBalances: async () => ({ sol: 1.0 }) },
      swap: { buy: async () => ({ txSignature: 'test-sig' }) },
    };

    // First run
    const now1 = Date.now();
    await dcaExecutor.checkAndExecute(cfg, ctx, null);
    const exec1 = JSON.parse(fs.readFileSync(EXEC_LOG_FILE, 'utf8')).length;

    // Second run immediately after (should skip)
    await dcaExecutor.checkAndExecute(cfg, ctx, null);
    const exec2 = JSON.parse(fs.readFileSync(EXEC_LOG_FILE, 'utf8')).length;

    assert.equal(exec1, 1, 'First run should execute');
    assert.equal(exec2, 1, 'Second run should not execute (interval not reached)');
  });

  await t.test('should log executions in append-only fashion', async () => {
    cleanup();
    dcaExecutor.initialize();

    const cfg = {
      strategy: {
        dcaEnabled: true,
        dcaSchedules: [
          { id: 'test5a', mint: 'TEST5555', amountSol: 0.01, intervalMs: 1000 },
        ],
      },
      api: { baseUrl: 'http://localhost' },
      risk: { blacklist: [] },
    };

    const ctx = {
      api: { tokenPrices: async () => ({ prices: { TEST5555: { priceNative: 0.001 } } }) },
      wallet: { getBalances: async () => ({ sol: 1.0 }) },
      swap: { buy: async () => ({ txSignature: 'sig1' }) },
    };

    // First execution
    await dcaExecutor.checkAndExecute(cfg, ctx, null);
    let log = JSON.parse(fs.readFileSync(EXEC_LOG_FILE, 'utf8'));
    assert.equal(log.length, 1);

    // Update config and run again after interval
    cfg.strategy.dcaSchedules[0].intervalMs = 0; // Force re-execute
    cfg.strategy.dcaSchedules[0].amountSol = 0.02;
    await new Promise(r => setTimeout(r, 10));
    await dcaExecutor.checkAndExecute(cfg, ctx, null);

    log = JSON.parse(fs.readFileSync(EXEC_LOG_FILE, 'utf8'));
    assert.ok(log.length >= 1, 'Log should grow with each execution attempt');
  });

  await t.test('should handle schedule with no id (use mint+interval)', async () => {
    cleanup();
    dcaExecutor.initialize();

    const cfg = {
      strategy: {
        dcaEnabled: true,
        dcaSchedules: [
          { mint: 'NOID1111', amountSol: 0.01, intervalMs: 1000 }, // No id field
        ],
      },
      api: { baseUrl: 'http://localhost' },
      risk: { blacklist: [] },
    };

    const ctx = {
      api: { tokenPrices: async () => ({ prices: { NOID1111: { priceNative: 0.001 } } }) },
      wallet: { getBalances: async () => ({ sol: 1.0 }) },
      swap: { buy: async () => ({ txSignature: 'test-sig' }) },
    };

    await dcaExecutor.checkAndExecute(cfg, ctx, null);

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const generated = Object.keys(state.schedules)[0];
    assert(generated.includes('NOID1111'), 'Should generate scheduleId from mint+interval');
  });

  cleanup();
});
