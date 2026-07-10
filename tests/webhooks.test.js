// tests/webhooks.test.js — Outbound webhook dispatcher unit tests
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const webhooks = require('../lib/webhooks');

// Mock server to receive webhooks
let mockServer = null;
let receivedRequests = [];
let mockServerPort = 0;

async function startMockServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          receivedRequests.push({
            method: req.method,
            headers: req.headers,
            body: JSON.parse(body),
            url: req.url,
          });
        } catch {}
        res.writeHead(200);
        res.end();
      });
    });
    mockServer.listen(0, () => {
      mockServerPort = mockServer.address().port;
      resolve();
    });
  });
}

async function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => {
        mockServer = null;
        mockServerPort = 0;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

test('webhooks: disabled config returns immediately', async () => {
  receivedRequests = [];
  const cfg = { webhooks: { enabled: false, urls: ['http://localhost:19999/test'] } };
  await webhooks.dispatchWebhook('trade_opened', { symbol: 'TEST' }, cfg);
  // Give async a moment to fail if it were to proceed
  await new Promise(r => setTimeout(r, 100));
  assert.equal(receivedRequests.length, 0);
});

test('webhooks: no URLs configured returns immediately', async () => {
  receivedRequests = [];
  const cfg = { webhooks: { enabled: true, urls: [] } };
  await webhooks.dispatchWebhook('trade_opened', { symbol: 'TEST' }, cfg);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(receivedRequests.length, 0);
});

test('webhooks: event not in allow-list is filtered out', async () => {
  receivedRequests = [];
  await startMockServer();
  const cfg = {
    webhooks: {
      enabled: true,
      urls: [`http://localhost:${mockServerPort}/test`],
      events: ['trade_opened', 'daily_brief'],  // exclude trade_closed
    }
  };
  await webhooks.dispatchWebhook('trade_closed', { symbol: 'TEST' }, cfg);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(receivedRequests.length, 0);
  await stopMockServer();
});

test('webhooks: allowed event sends webhook', async () => {
  receivedRequests = [];
  await startMockServer();
  const cfg = {
    webhooks: {
      enabled: true,
      urls: [`http://localhost:${mockServerPort}/test`],
      events: ['trade_opened'],
    }
  };
  await webhooks.dispatchWebhook('trade_opened', { symbol: 'TEST', mint: 'abc123' }, cfg);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(receivedRequests.length, 1);
  assert.equal(receivedRequests[0].method, 'POST');
  assert.equal(receivedRequests[0].headers['content-type'], 'application/json');
  assert.equal(receivedRequests[0].body.event, 'trade_opened');
  assert.equal(receivedRequests[0].body.payload.symbol, 'TEST');
  assert.ok(receivedRequests[0].body.timestamp);
  await stopMockServer();
});

test('webhooks: multiple URLs receive webhook', async () => {
  receivedRequests = [];
  await startMockServer();
  const cfg = {
    webhooks: {
      enabled: true,
      urls: [`http://localhost:${mockServerPort}/test1`, `http://localhost:${mockServerPort}/test2`],
      events: ['trade_opened', 'trade_closed', 'daily_brief'],
    }
  };
  await webhooks.dispatchWebhook('trade_opened', { symbol: 'TEST' }, cfg);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(receivedRequests.length, 2);
  assert.equal(receivedRequests[0].body.event, 'trade_opened');
  assert.equal(receivedRequests[1].body.event, 'trade_opened');
  await stopMockServer();
});

test('webhooks: dead URL does not throw', async () => {
  receivedRequests = [];
  const cfg = {
    webhooks: {
      enabled: true,
      urls: ['http://localhost:19999/deadmachine'],  // no server listening
      events: ['trade_opened'],
    }
  };
  // Should not throw
  await webhooks.dispatchWebhook('trade_opened', { symbol: 'TEST' }, cfg);
  await new Promise(r => setTimeout(r, 200));
  // Should reach here without error
  assert.ok(true);
});

test('webhooks: invalid URL string does not throw', async () => {
  receivedRequests = [];
  const cfg = {
    webhooks: {
      enabled: true,
      urls: ['not-a-valid-url'],
      events: ['trade_opened'],
    }
  };
  // Should not throw
  await webhooks.dispatchWebhook('trade_opened', { symbol: 'TEST' }, cfg);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(true);
});

test('webhooks: payload shape is correct', async () => {
  receivedRequests = [];
  await startMockServer();
  const cfg = {
    webhooks: { enabled: true, urls: [`http://localhost:${mockServerPort}/test`] }
  };
  const payload = { symbol: 'TEST', mint: 'abc123', pnl: 123.45 };
  await webhooks.dispatchWebhook('daily_brief', payload, cfg);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(receivedRequests.length, 1);
  assert.ok(receivedRequests[0].body.event);
  assert.ok(receivedRequests[0].body.timestamp);
  assert.deepEqual(receivedRequests[0].body.payload, payload);
  await stopMockServer();
});

test('webhooks: default events include all three types', async () => {
  receivedRequests = [];
  await startMockServer();
  const cfg = {
    webhooks: { enabled: true, urls: [`http://localhost:${mockServerPort}/test`] }
    // No events specified — should default to all three
  };
  await webhooks.dispatchWebhook('trade_opened', { test: 1 }, cfg);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(receivedRequests.length, 1);
  await stopMockServer();
});
