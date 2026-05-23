# Skill: Yield Farming & DeFi

You are allocating idle capital into yield-generating positions on Solana. This is a capital efficiency play — idle SOL earns nothing; deployed capital compounds.

## When to use this

- You have SOL sitting idle with no strong trade setups (scan score < 55 for all candidates)
- CIRCUIT balance is healthy (> 100k) and you want to compound without active trading
- Market is ranging or bearish and directional trades carry too much risk
- User asks about staking, yield, or passive income

## Yield options ranked by risk

### 1. Liquid Staking (lowest risk, lowest yield)

Swap SOL → LST via Jupiter. These are 1:1 redeemable and hold their SOL peg well.

| Token | Approx APY | Mint |
|-------|-----------|------|
| jitoSOL | ~8-9% | J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn |
| mSOL | ~7-8% | mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So |
| bSOL | ~8% | bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1 |
| jupSOL | ~8% | jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v |

**When to use**: Bear market, no trade setups, SOL idle for >4h. Small position (never commit all SOL to LST — keep trading float).

**How**: Use `buy_token(mint, solAmount)` to swap SOL → LST. Monitor with `token_price(mint)`.

### 2. LP Positions (medium risk, higher yield)

You cannot directly LP in this agent version. Flag for user if they want to manually add liquidity on Orca or Raydium. Useful context: top pools via `top_pools` — this shows where real volume and fees are flowing.

When discussing LP with a user:
- Concentrated liquidity (Orca Whirlpools) = higher APY, higher impermanent loss risk
- SOL/USDC pools are safest (both assets you understand)
- Meme/volatile pairs: APY can be 100%+ but IL destroys you in a pump

### 3. Lending (medium risk, medium yield)

**Kamino Finance** — the dominant Solana lending protocol. Users can deposit SOL or USDC and earn supply APY (typically 3-8% for SOL, 6-12% for stablecoins). You cannot directly interact with Kamino's smart contracts in this agent version without the SDK.

**Flag to user**: If idle SOL >0.1 SOL and no trades incoming, suggest Kamino lending as an option.

### 4. CIRCUIT accumulation (strategic)

The `circuit-reinvest` module auto-converts 25% of trade profits to CIRCUIT. This is passive yield on wins — treat it as a compounding layer on top of trading.

//update this// Current CIRCUIT cost: check `token_price(mint=ndkshj822kkjfjJGHKDFmCM)`

## DeFi overview workflow

When a user asks about DeFi opportunities:

1. `defi_overview` — get current TVL by protocol, find where capital is flowing
2. `staking_yields` — compare current LST APYs before recommending one
3. `oracle_prices` — confirm SOL price trend before committing capital to LSTs
4. Recommend the best fit based on their risk tolerance and hold period

## Capital allocation rules

- **Never put all SOL into LSTs** — always keep minimum trading float (cfg.survival.minSolWarning + entry budget)
- **LST position sizing**: max 50% of idle SOL
- **Rebalance trigger**: If a strong dip-reversal score (>70) appears, sell LST → SOL → buy token
- **Track LST as a position**: Open a position entry for any LST purchase so you can monitor and exit

## Key numbers to check

- Current best LST APY: `staking_yields`
- Where liquidity is going: `top_pools` (volume leaders = real yield)
- Macro context before deploying: `market_sentiment` — if Fear & Greed < 25, great time for yield. If > 75, prioritize trading over yield.
