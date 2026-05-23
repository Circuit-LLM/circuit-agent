# Skill: Playwright Browser Automation

> **Optional upgrade.** Playwright is not installed or required by default. Use this skill when you need to research tokens or protocols on sites that block plain HTTP fetches (Cloudflare-protected pages, JS-rendered content). Install it when needed: `npx playwright install --with-deps chromium`. Most research tasks work fine with `web_search` and `fetch_url` — only reach for Playwright when those fail.

Use this skill to research tokens, protocols, or any web resource that requires a real browser. Playwright controls a headless Chromium browser — it must be installed first (`npx playwright install chromium`).

## When to use this skill

- Researching a token's website, social presence, or whitepaper
- Checking if a project's GitHub repo is active
- Scraping on-chain explorer pages (Solscan, Explorer)
- Checking a protocol's TVL, docs, or announcement pages
- Investigating whether a token contract is verified or has team dox
- Any web source that a plain HTTP fetch won't work on (Cloudflare, JS-rendered)

## How to run a Playwright script

Write to a temp file, then execute:

```bash
cat << 'SCRIPT' > /tmp/pw_research.js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  await page.goto('https://example.com');
  await page.waitForTimeout(7000 + Math.floor(Math.random() * 2000)); // Anti-bot wait

  const text = await page.locator('body').innerText();
  console.log(text.substring(0, 2000));

  await browser.close();
})();
SCRIPT
node /tmp/pw_research.js
```

## Anti-bot rules (mandatory)

1. **Wait 7-9 seconds after page load** before interacting — Cloudflare needs this
2. **Use `pressSequentially()` not `fill()`** for any login fields
3. **Hover before clicking** sensitive buttons
4. **Add random delays** (50-150ms between keystrokes, 500-1000ms between actions)
5. **Set realistic viewport + user-agent** as shown above

## Token research workflow

When investigating a token before buying:

```bash
cat << 'SCRIPT' > /tmp/pw_token_research.js
const { chromium } = require('playwright');
const mint = process.argv[2];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Check Solscan
  await page.goto(`https://solscan.io/token/${mint}`);
  await page.waitForTimeout(8000);
  const solscanText = await page.locator('body').innerText();
  console.log('SOLSCAN:', solscanText.substring(0, 1000));

  // Check RugCheck
  await page.goto(`https://rugcheck.xyz/tokens/${mint}`);
  await page.waitForTimeout(8000);
  const rugText = await page.locator('body').innerText();
  console.log('RUGCHECK:', rugText.substring(0, 1000));

  await browser.close();
})();
SCRIPT
node /tmp/pw_token_research.js <MINT>
```

## Extracting structured data

```javascript
// Extract all links from a page
const links = await page.locator('a').evaluateAll(els =>
  els.map(el => ({ text: el.textContent?.trim(), href: el.href })).filter(l => l.href)
);

// Extract table data
const rows = await page.locator('table tr').evaluateAll(rows =>
  rows.map(row => Array.from(row.querySelectorAll('td,th')).map(cell => cell.textContent?.trim()))
);

// Check if element exists
const exists = await page.locator('#some-element').count() > 0;

// Wait for content and extract
await page.waitForSelector('.token-price', { timeout: 10000 });
const price = await page.locator('.token-price').textContent();
```

## Screenshot for evidence

```javascript
await page.screenshot({ path: '/tmp/token_evidence.png', fullPage: true });
// Share the path in your analysis
```

## Session storage

Save authenticated sessions for repeated use:
```
data/sessions/
```
Example: `data/sessions/solscan-auth.json`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Browser won't launch | `npx playwright install --with-deps chromium` |
| Cloudflare blocks | Increase wait to 10-12 seconds |
| Element not found | Use `waitFor({ timeout: 15000 })` |
| Timeout | Add `{ timeout: 60000 }` to goto/waitFor |
| JS-heavy pages | Use `waitForLoadState('networkidle')` |
