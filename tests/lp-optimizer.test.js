// tests/lp-optimizer.test.js — LP optimizer unit tests
// Tests: ratio validation, imbalance detection, fee threshold logic, state tracking
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  _validateRatio,
  _computeImbalance,
  _isImbalanced,
  _loadJsonSafe,
  _saveJsonAtomic,
} = require('../lib/lp-optimizer');

const tmpDir = path.join(__dirname, '../data/test-lp');

test('_validateRatio accepts valid 0-1 ratios', () => {
  assert.equal(_validateRatio(0.5), 0.5);
  assert.equal(_validateRatio(0), 0);
  assert.equal(_validateRatio(1), 1);
  assert.equal(_validateRatio(0.25), 0.25);
  assert.equal(_validateRatio(0.75), 0.75);
});

test('_validateRatio rejects invalid ratios', () => {
  assert.equal(_validateRatio(-0.5), 0);
  assert.equal(_validateRatio(1.5), 0);
  assert.equal(_validateRatio(NaN), 0);
  assert.equal(_validateRatio(Infinity), 0);
  assert.equal(_validateRatio(-Infinity), 0);
  assert.equal(_validateRatio(null), 0);
  assert.equal(_validateRatio(undefined), 0);
  assert.equal(_validateRatio('0.5'), 0);
});

test('_computeImbalance calculates delta from 50/50 target', () => {
  assert.equal(_computeImbalance(0.5), 0);
  assert.ok(Math.abs(_computeImbalance(0.6) - 0.1) < 1e-10);
  assert.ok(Math.abs(_computeImbalance(0.4) - 0.1) < 1e-10);
  assert.equal(_computeImbalance(0), 0.5);
  assert.equal(_computeImbalance(1), 0.5);
});

test('_isImbalanced detects positions beyond threshold', () => {
  assert.equal(_isImbalanced(0.5, 0.15), false);
  assert.equal(_isImbalanced(0.6, 0.15), false);
  assert.equal(_isImbalanced(0.4, 0.15), false);
  assert.equal(_isImbalanced(0.65, 0.15), true);
  assert.equal(_isImbalanced(0.35, 0.15), true);
  assert.equal(_isImbalanced(0.8, 0.15), true);
});

test('_isImbalanced uses default threshold 0.15', () => {
  assert.equal(_isImbalanced(0.65), true);
  assert.equal(_isImbalanced(0.64), false);
  assert.equal(_isImbalanced(0.36), false);
  assert.equal(_isImbalanced(0.35), true);
});

test('_isImbalanced with tight threshold', () => {
  assert.equal(_isImbalanced(0.56, 0.05), true);
  assert.equal(_isImbalanced(0.50, 0.05), false);
  assert.equal(_isImbalanced(0.52, 0.05), false);
});

test('_loadJsonSafe returns defaults for missing files', () => {
  const result = _loadJsonSafe('/nonexistent/path.json', { fallback: true });
  assert.deepEqual(result, { fallback: true });
});

test('_loadJsonSafe parses valid JSON', () => {
  const testFile = path.join(tmpDir, 'valid.json');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(testFile, JSON.stringify({ test: 'data' }));
  const result = _loadJsonSafe(testFile);
  assert.deepEqual(result, { test: 'data' });
  fs.unlinkSync(testFile);
});

test('_loadJsonSafe returns defaults for corrupt JSON', () => {
  const testFile = path.join(tmpDir, 'corrupt.json');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(testFile, 'not valid json {');
  const result = _loadJsonSafe(testFile, { fallback: 'corrupt' });
  assert.deepEqual(result, { fallback: 'corrupt' });
  fs.unlinkSync(testFile);
});

test('_saveJsonAtomic writes and atomically replaces', () => {
  const testFile = path.join(tmpDir, 'atomic.json');
  fs.mkdirSync(tmpDir, { recursive: true });
  const data = { atomic: true, value: 42 };
  const success = _saveJsonAtomic(testFile, data);
  assert.equal(success, true);
  assert.equal(fs.existsSync(testFile), true);
  const read = JSON.parse(fs.readFileSync(testFile, 'utf8'));
  assert.deepEqual(read, data);
  fs.unlinkSync(testFile);
});

test('_saveJsonAtomic creates directories', () => {
  const testFile = path.join(tmpDir, 'nested/deep/path.json');
  const data = { nested: 'dir' };
  const success = _saveJsonAtomic(testFile, data);
  assert.equal(success, true);
  assert.equal(fs.existsSync(testFile), true);
  fs.unlinkSync(testFile);
  fs.rmdirSync(path.dirname(testFile));
  fs.rmdirSync(path.dirname(path.dirname(testFile)));
});

test('_saveJsonAtomic cleans up tmp file on success', () => {
  const testFile = path.join(tmpDir, 'cleanup.json');
  fs.mkdirSync(tmpDir, { recursive: true });
  _saveJsonAtomic(testFile, { test: 'cleanup' });
  const tmpFile = testFile + '.tmp';
  assert.equal(fs.existsSync(tmpFile), false);
  fs.unlinkSync(testFile);
});

test('imbalance calculation edge cases', () => {
  assert.equal(_computeImbalance(0.5), 0);
  assert.ok(Math.abs(_computeImbalance(0.500001) - 0.000001) < 1e-8);
  assert.equal(_isImbalanced(0.500001, 0.15), false);
  assert.equal(_isImbalanced(0.650001, 0.15), true);
});

test('ratio validation with type coercion', () => {
  assert.equal(_validateRatio(true), 0);
  assert.equal(_validateRatio(false), 0);
  assert.equal(_validateRatio({}), 0);
  assert.equal(_validateRatio([]), 0);
});

test('threshold boundary conditions', () => {
  const threshold = 0.15;
  assert.equal(_isImbalanced(0.64, threshold), false);
  assert.equal(_isImbalanced(0.66, threshold), true);
  assert.equal(_isImbalanced(0.36, threshold), false);
  assert.equal(_isImbalanced(0.34, threshold), true);
});

// Cleanup
test('cleanup test fixtures', () => {
  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {}
  assert.ok(true);
});
