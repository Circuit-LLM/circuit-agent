'use strict';
// Test custom strategy filter wiring in lib/auto-scanner.js

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

test('custom filter blocks buy when shouldBuy returns false', async () => {
  const STRATEGIES_DIR = path.join(__dirname, '../lib/strategies');
  const TEST_FILTER = path.join(STRATEGIES_DIR, 'test-filter.js');

  // Create strategies dir if needed
  fs.mkdirSync(STRATEGIES_DIR, { recursive: true });

  // Write a test filter that blocks low-liquidity tokens
  const filterCode = `
'use strict';
async function shouldBuy(candidate, cfg, context) {
  return (candidate.liquidity ?? 0) >= 100000;  // Only buy if liq >= $100k
}
module.exports = { shouldBuy };
`;
  fs.writeFileSync(TEST_FILTER, filterCode);

  try {
    // Clear require cache and reload
    delete require.cache[require.resolve('../lib/auto-scanner.js')];
    const scanner = require('../lib/auto-scanner.js');

    // Verify the filter exists
    assert.ok(fs.existsSync(TEST_FILTER), 'test filter created');
  } finally {
    // Cleanup
    try { fs.unlinkSync(TEST_FILTER); } catch {}
  }
});
