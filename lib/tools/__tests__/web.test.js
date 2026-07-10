// lib/tools/__tests__/web.test.js — test suite for web search tool
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const web = require('../web');

const testCacheDir = path.join(__dirname, '../../..', 'data');
const cacheFile = path.join(testCacheDir, 'web_search_cache.json');

function cleanupCache() {
  if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
  }
  // Force reload of cache on next call
  web._internal._resetCache();
}

function getCacheContents() {
  if (!fs.existsSync(cacheFile)) return null;
  return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
}

test('Cache TTL Logic', async (t) => {
  await t.test('should store results in cache with timestamp', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query = 'bitcoin price';
    const results = [
      { title: 'Bitcoin Price Today', url: 'https://example.com', snippet: 'Price info' },
    ];

    web._internal._setCachedResult(query, results, 3600000);

    const cache = web._internal._loadSearchCache();
    assert.strictEqual(cache.queries.length, 1);
    assert.strictEqual(cache.queries[0].query, query);
    assert(cache.queries[0].timestamp);
    assert.deepStrictEqual(cache.queries[0].results, results);
  });

  await t.test('should retrieve results within TTL', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query = 'ethereum';
    const results = [
      { title: 'Ethereum News', url: 'https://example.com', snippet: 'News' },
    ];

    web._internal._setCachedResult(query, results, 3600000);
    const cached = web._internal._getCachedResult(query, 3600000);

    assert.deepStrictEqual(cached, results);
  });

  await t.test('should not retrieve results after TTL expires', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query = 'solana';
    const results = [
      { title: 'Solana Info', url: 'https://example.com', snippet: 'Info' },
    ];

    const ttlMs = 100; // 100ms TTL
    web._internal._setCachedResult(query, results, ttlMs);

    // Check that it's available immediately
    const cachedImmediate = web._internal._getCachedResult(query, ttlMs);
    assert(cachedImmediate);

    // Check that it's NOT available when querying with 0 TTL (already expired)
    const cachedExpired = web._internal._getCachedResult(query, 0);
    assert.strictEqual(cachedExpired, null);
  });

  await t.test('should normalize queries for cache matching', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query1 = 'Bitcoin PRICE';
    const query2 = 'bitcoin price';
    const results = [
      { title: 'Result', url: 'https://example.com', snippet: 'Snippet' },
    ];

    web._internal._setCachedResult(query1, results, 3600000);
    const cached = web._internal._getCachedResult(query2, 3600000);

    assert.deepStrictEqual(cached, results);
  });

  await t.test('should handle cache with leading/trailing whitespace', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query1 = '  bitcoin price  ';
    const query2 = 'bitcoin price';
    const results = [
      { title: 'Result', url: 'https://example.com', snippet: 'Snippet' },
    ];

    web._internal._setCachedResult(query1, results, 3600000);
    const cached = web._internal._getCachedResult(query2, 3600000);

    assert.deepStrictEqual(cached, results);
  });
});

test('Rate Limiting', async (t) => {
  await t.test('should prevent searches after rate limit', async () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const ctx = { config: { search: { rateLimit: 2, cacheTtlMs: 3600000 } } };
    const log = () => {};

    const result1 = await web.HANDLERS.web_search(
      { query: 'test 1' },
      ctx,
      log,
    );
    const parsed1 = JSON.parse(result1);
    assert(!parsed1.error || parsed1.error.includes('Search failed') || parsed1.error.includes('rate limit'));

    const result2 = await web.HANDLERS.web_search(
      { query: 'test 2' },
      ctx,
      log,
    );
    const parsed2 = JSON.parse(result2);
    assert(!parsed2.error || parsed2.error.includes('Search failed') || parsed2.error.includes('rate limit'));

    const result3 = await web.HANDLERS.web_search(
      { query: 'test 3' },
      ctx,
      log,
    );
    const parsed3 = JSON.parse(result3);
    assert(parsed3.error);
    assert(parsed3.error.includes('rate limit'));
  });
});

test('Cache Hit Detection', async (t) => {
  await t.test('should return cached result when available', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query = 'cached test';
    const results = [
      { title: 'Cached Result', url: 'https://example.com', snippet: 'Cached' },
    ];

    web._internal._setCachedResult(query, results, 3600000);

    const cached = web._internal._getCachedResult(query, 3600000);
    assert(cached);
    assert.deepStrictEqual(cached, results);
  });
});

test('Error Handling', async (t) => {
  await t.test('should handle disabled search', async () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const ctx = { config: { search: { enabled: false } } };
    const log = () => {};

    const result = await web.HANDLERS.web_search(
      { query: 'test' },
      ctx,
      log,
    );
    const parsed = JSON.parse(result);

    assert(parsed.error);
    assert(parsed.error.includes('disabled'));
  });

  await t.test('should reject empty query', async () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const ctx = { config: { search: { enabled: true, rateLimit: 10 } } };
    const log = () => {};

    const result = await web.HANDLERS.web_search(
      { query: '' },
      ctx,
      log,
    );
    const parsed = JSON.parse(result);

    assert(parsed.error);
    assert(parsed.error.includes('empty'));
  });

  await t.test('should handle config fallbacks', async () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const ctx = { config: { search: {} } };
    const log = () => {};

    const result = await web.HANDLERS.web_search(
      { query: 'fallback test' },
      ctx,
      log,
    );
    const parsed = JSON.parse(result);
    assert(parsed);
  });
});

test('Cache File Management', async (t) => {
  await t.test('should create cache file when saving results', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query = 'test';
    const results = [
      { title: 'Test', url: 'https://example.com', snippet: 'Test' },
    ];

    web._internal._setCachedResult(query, results, 3600000);

    assert(fs.existsSync(cacheFile));
  });

  await t.test('should load existing cache file', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const results1 = [
      { title: 'Result 1', url: 'https://example.com', snippet: 'First' },
    ];
    web._internal._setCachedResult('uniquequery1', results1, 3600000);

    const results2 = [
      { title: 'Result 2', url: 'https://example.com', snippet: 'Second' },
    ];
    web._internal._setCachedResult('uniquequery2', results2, 3600000);

    const cache = web._internal._loadSearchCache();
    assert(cache.queries.length >= 2);
    const hasQuery1 = cache.queries.some(e => e.query === 'uniquequery1');
    const hasQuery2 = cache.queries.some(e => e.query === 'uniquequery2');
    assert(hasQuery1);
    assert(hasQuery2);
  });

  await t.test('should limit cache size to prevent unbounded growth', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    // Add enough items to trigger pruning (1000+ items should trigger trim to 500)
    for (let i = 0; i < 1050; i++) {
      web._internal._setCachedResult(
        `uniquebigquery${i}`,
        [{ title: `Title ${i}`, url: 'https://example.com', snippet: `Snippet ${i}` }],
        3600000,
      );
    }

    const cache = web._internal._loadSearchCache();
    // After adding 1050 items, the cache should be trimmed
    // The implementation keeps the last 500 when size > 1000
    assert(cache.queries.length <= 600); // Allow some buffer for other test data
  });
});

test('Result Format', async (t) => {
  await t.test('should format results with title, url, snippet fields', () => {
    cleanupCache();
    web._internal._resetSessionCount();

    const query = 'format test';
    const results = [
      {
        title: 'Example Title',
        url: 'https://example.com/page',
        snippet: 'This is a test snippet.',
      },
    ];

    web._internal._setCachedResult(query, results, 3600000);
    const cached = web._internal._getCachedResult(query, 3600000);

    assert(cached);
    assert.strictEqual(cached[0].title, 'Example Title');
    assert.strictEqual(cached[0].url, 'https://example.com/page');
    assert.strictEqual(cached[0].snippet, 'This is a test snippet.');
  });
});
