# Skill: Market Analysis

Understanding the macro regime before placing any trade. The same token setup that wins in a bull market fails in a bear. Read the room first.

## The market regime framework

Every trading session starts with regime identification. Run these tools in sequence:

```
oracle_prices → market_sentiment → defi_overview → staking_yields
```

Then classify the current regime (below). Everything after flows from this classification.

## Regime types

### Bull — deploy aggressively

**Signals:**
- SOL > 0% on 24h AND > 0% on 7d
- Fear & Greed index > 60
- Solana DeFi TVL trending up week-over-week
- Top pools showing increasing volume
- Swarm feed dominated by buy_signals

**Behavior in Bull:**
- Accept lower scan scores (threshold: 35 vs 55)
- Target momentum AND dip-reversal setups
- Hold winners longer, trail loosely
- Max positions (fill all 3 slots)
- LST yield < trading opportunity — prioritize trading

---

### Ranging — selective, patient

**Signals:**
- SOL ±5% 24h, oscillating
- Fear & Greed 40-60 (neutral)
- TVL flat, volume steady but not rising
- Mixed swarm feed (buys and sells in equal proportion)

**Behavior in Ranging:**
- Stick to score >= 55 (standard threshold)
- Prefer dip-reversals over momentum (ranges punish chasers)
- Take profits earlier (+12-15% vs waiting for full take-profit)
- Keep 1 slot free for opportunities
- Consider yield position with idle capital

---

### Bear — defensive, survival-focused

**Signals:**
- SOL < -5% 24h OR < -10% 7d
- Fear & Greed < 35
- TVL declining
- Swarm feed has rug_alerts, sell_signals dominating
- Most tokens showing negative 6h AND 24h

**Behavior in Bear:**
- Score threshold: 55+ (only high-conviction setups)
- Only DEEP-REVERSAL pattern (1h drop > -10%) with strong bounce
- Tight stops: reduce stop-loss to -4% (don't wait for -6%)
- Max 2 open positions, never 3
- Allocate idle SOL to LSTs rather than forcing trades
- Check `defi_overview` — if TVL is collapsing, even "good" setups fail

---

### Crash — sit out or hedge

**Signals:**
- SOL < -15% in 24h
- Fear & Greed < 20 (extreme fear)
- Multiple rug alerts across swarm
- News: regulatory action, exchange hack, macro shock

**Behavior in Crash:**
- No new entries. Close all positions at market if possible.
- Swap to jitoSOL or hold SOL (LSTs hold peg during crashes)
- Run `get_news` to understand the cause
- Wait for Fear & Greed to recover above 30 before re-entering
- Publish a bear_signal to the swarm

---

## Macro correlation tools

### oracle_prices — the anchor

Pyth oracle prices are the most reliable SOL price source. Check:
- Is SOL making higher highs or lower highs intraday?
- BTC direction — Solana tokens follow BTC on a 30-60min lag
- ETH vs SOL divergence can signal Solana-specific catalysts

### market_sentiment — crowd positioning

The Fear & Greed index measures:
- > 75: extreme greed → momentum works, but watch for reversals
- 50-75: greed → normal bull mode
- 25-50: fear → only strong setups, smaller sizes
- < 25: extreme fear → sit out OR contrarian high-conviction only

**Contrarian signal**: When Fear & Greed hits < 15 and SOL holds support, this is historically one of the best entry points. The crowd is capitulating — you accumulate.

### defi_overview — where money is moving

TVL (Total Value Locked) tells you where smart money is:
- TVL rising while price flat → accumulation phase, bullish setup
- TVL falling while price flat → distribution, bearish setup
- TVL rising AND price rising → strong bull confirmation
- TVL collapsing → exit everything, risk-off

Top protocols to watch:
- **Raydium / Orca**: DEX volume = speculation appetite
- **Kamino**: Lending activity = leverage in the system (rising = bullish conviction)
- **Marinade**: mSOL growth = long-term holders accumulating SOL

### staking_yields — opportunity cost

When staking yields rise above 9%, capital naturally rotates from risky tokens into LSTs. This suppresses meme/degen trading volume. If yields are low (< 7%), more capital chases speculative opportunities.

Use this to calibrate: is the yield-farming alternative attractive enough to park idle capital?

## Pre-session checklist

Before your first trade of any session:

1. `oracle_prices` → Note SOL 24h direction
2. `market_sentiment` → Note Fear & Greed score
3. `defi_overview` → Note whether TVL is rising or falling
4. Classify regime: **Bull / Ranging / Bear / Crash**
5. Recall relevant notes: `recall_notes` with query "regime" or "macro"
6. Adjust your thresholds for this session

Write the regime to notes: `save_note(key="current_regime", value="Bear: SOL -8% 24h, F&G=28, TVL flat")`

This way, every heartbeat and reflect cycle knows the macro context without re-running all tools.

## Sector rotation on Solana

Different token types perform differently across regimes:

| Sector | Bull | Ranging | Bear |
|--------|------|---------|------|
| Meme/degen | Best | OK | Worst |
| DeFi protocol tokens | Good | Good | Bad |
| LSTs (mSOL, jitoSOL) | Steady | Steady | Best |
| Gaming/NFT | High beta | Weak | Very bad |
| RWA/stablecoin-adjacent | Low return | OK | Best |

In a ranging market, rotate toward DeFi protocol tokens (lower volatility, real revenue). In a bull market, memes outperform everything. In a bear, LSTs are the only safe harbor.

## Swarm as sentiment signal

The swarm feed is a real-time sentiment indicator:
- Count buy_signals vs sell_signals in the last 15 entries
- If > 70% are buy_signals → swarm is bullish, confirms Bull regime
- If > 50% are sell_signals or rug_alerts → swarm is bearish, confirms Bear
- Mixed → Ranging

Cross-reference swarm sentiment with your macro regime read. When they diverge, weight the macro data more heavily (swarm can overreact short-term; macro trends are slower but more reliable).
