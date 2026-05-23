# Custom Strategies

This directory is for custom strategy scripts — modules that extend or replace the built-in dip-reversal logic.

---

## What belongs here

- Custom entry filters (e.g. only trade during specific hours, or based on swarm consensus thresholds)
- Alternative scoring algorithms
- Portfolio-level logic (e.g. sector diversification, max exposure per category)
- Utility scripts the LLM can call via `run_script` or `require()` into the main agent

---

## Script conventions

Scripts in this directory can be:

**1. Require-able modules** — exported as a Node.js module, imported by `agent.js` or `lib/auto-scanner.js`:

```js
// lib/strategies/my-filter.js
'use strict';

/**
 * Custom entry filter. Called with a scored candidate before each buy.
 * Return true to allow the buy, false to skip.
 */
async function shouldBuy(candidate, cfg, context) {
  // candidate: { mint, symbol, score, priceChange1h, priceChange5m, liquidity, ... }
  // cfg: merged agent config
  // context: { solPrice, fearGreed, swarmConsensus }

  // Example: skip if Fear & Greed is in extreme fear
  if (context.fearGreed?.value < 20) return false;

  // Example: require swarm to be bullish
  if (context.swarmConsensus?.direction !== 'bullish') return false;

  return true;
}

module.exports = { shouldBuy };
```

**2. Standalone scripts** — run directly via `node lib/strategies/my-script.js` or via the `run_script` LLM tool:

```js
// lib/strategies/morning-report.js
'use strict';

// Standalone script — called by the LLM or cron
// Always write output to a file (stdout is captured but LLM has length limits)

const fs = require('fs');
const path = require('path');

async function main() {
  // ... your logic ...

  const result = { /* ... */ };
  fs.writeFileSync(path.join(__dirname, '../../data/morning_report.json'), JSON.stringify(result, null, 2));
  console.log('PREFIX_RESULT:', JSON.stringify({ ok: true, report: result }));
}

main().catch(err => { console.error(err); process.exit(1); });
```

---

## Hooking into the scanner

To use a custom filter in the auto-scanner, import it in `lib/auto-scanner.js` and call it before the buy:

```js
// In lib/auto-scanner.js, near the buy decision:
const { shouldBuy } = require('./strategies/my-filter');

if (!await shouldBuy(best, cfg, context)) {
  log('info', `Custom filter blocked buy: ${best.symbol}`);
  return;
}
```

Or write the filter to `lib/strategies/my-filter.js` and tell the agent about it — it can load and use it via the `load_skill` + `run_script` tools without any code changes.

---

## Installed packages

If your strategy needs an external package, install it and add it to `package.json`:

```bash
npm install @marinade.finance/marinade-ts-sdk
```

Or let the LLM install it for you via the `install_package` tool.
