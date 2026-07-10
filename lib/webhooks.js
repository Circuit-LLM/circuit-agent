// lib/webhooks.js — Dispatch outbound webhooks on trading events
// Fire-and-forget async: POST JSON to configured URLs, never blocks a trade
'use strict';

const https = require('https');
const http = require('http');

/**
 * Dispatch a webhook event to configured URLs.
 * Fire-and-forget: async POST, timeout 5s, logs failures but never throws.
 * URLs can be HTTP or HTTPS; supports Discord webhooks (just POST-JSON-to-URL).
 *
 * @param {string} event — event type ('trade_opened', 'trade_closed', 'daily_brief')
 * @param {object} payload — JSON payload to POST
 * @param {object} cfg — config block (webhooks.urls, webhooks.events, webhooks.enabled)
 */
async function dispatchWebhook(event, payload, cfg = {}) {
  const webhooks = cfg.webhooks ?? {};
  if (!webhooks.enabled) return;

  const urls = webhooks.urls ?? [];
  if (!Array.isArray(urls) || urls.length === 0) return;

  // Event allow-list — defaults to all three types
  const allowedEvents = webhooks.events ?? ['trade_opened', 'trade_closed', 'daily_brief'];
  if (!allowedEvents.includes(event)) return;

  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    payload,
  });

  // Fire all URLs in parallel, never block
  urls.forEach(url => {
    _dispatchToUrl(url, body, event).catch(() => {
      // Errors already logged in _dispatchToUrl, safe to swallow here
    });
  });
}

/**
 * POST JSON to a single URL.
 * @private
 */
async function _dispatchToUrl(url, body, event) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 5000,  // 5s timeout
        },
        (res) => {
          // Consume response (required to free the connection)
          let responseData = '';
          res.on('data', chunk => { responseData += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 400) {
              console.warn(`[WEBHOOK] ${event} → ${url} failed (HTTP ${res.statusCode})`);
            } else {
              console.log(`[WEBHOOK] ${event} → ${url} ok`);
            }
            resolve();
          });
        }
      );

      req.on('error', (err) => {
        console.warn(`[WEBHOOK] ${event} → ${url} error: ${err.message}`);
        resolve();  // Resolve, don't reject — failure must not break the caller
      });

      req.on('timeout', () => {
        req.destroy();
        console.warn(`[WEBHOOK] ${event} → ${url} timeout`);
        resolve();
      });

      req.write(body);
      req.end();
    } catch (err) {
      console.warn(`[WEBHOOK] ${event} → ${url} error: ${err.message}`);
      resolve();
    }
  });
}

module.exports = {
  dispatchWebhook,
};
