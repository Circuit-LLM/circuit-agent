// lib/feedBase.js — single source of truth for locating circuit-price-feed.
//
// Same request paths whether pointing at localhost:18941 (agents co-located with the feed
// on the VPS) or https://api.circuitllm.xyz/api/price-feed (agents running off-box, reached
// through the circuit-data-api proxy). Both lib/circuit.js (scan + entry price check) and
// lib/monitor.js (position price/exit math) resolve the feed through here so they can never
// drift onto different hosts — the bug that left the scanner hitting a dead localhost while
// the monitor correctly used the remote feed.
//
// Precedence:
//   1. PRICE_FEED_URL env         — explicit operator override (co-located swarm pins localhost)
//   2. priceFeedUrl config        — explicit per-agent config override
//   3. derived from the API base  — localhost API ⇒ direct feed :18941; else ${base}/api/price-feed
'use strict';

const DEFAULT_LOCAL_FEED = 'http://127.0.0.1:18941';

function deriveFeedBase({ priceFeedUrl, baseUrl } = {}) {
  const strip = (u) => u.replace(/\/+$/, '');
  if (process.env.PRICE_FEED_URL) return strip(process.env.PRICE_FEED_URL);
  if (priceFeedUrl)               return strip(priceFeedUrl);

  const base = strip(baseUrl ?? 'https://api.circuitllm.xyz');
  // Same-VPS agents point their API at localhost — talk to circuit-price-feed directly (no
  // proxy hop, no public rate limit, and the richer /active universe endpoint is reachable).
  if (base.includes('localhost') || base.includes('127.0.0.1')) return DEFAULT_LOCAL_FEED;
  return `${base}/api/price-feed`;
}

module.exports = { deriveFeedBase, DEFAULT_LOCAL_FEED };
