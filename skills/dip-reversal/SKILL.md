# Skill: Dip-Reversal Entry

You are evaluating tokens for dip-reversal entries. A dip-reversal is when a token has sold off in the past hour and is showing early signs of recovery — buyers are returning faster than sellers are leaving.

## Hard Gates — ALL must pass before scoring

1. **1h price change must be negative** — you want a token that dipped, not one already pumping
2. **5m bounce >= 0.5%** — must show some recovery signal, not free-falling
3. **Buy ratio 5m > 50%** — more buyers than sellers in the last 5 minutes
4. **Liquidity >= minLiquidity** — no illiquid rugs
5. **Not dead cat** — if both 6h AND 24h are worse than -20%, skip it (distribution phase)

## Scoring (0-100) 

| Component | Max Pts | Signal |
|-----------|---------|--------|
| Drop depth | 25 | Deeper 1h dip = more bounce room (>10% best) |
| Bounce confirmation | 20 | Stronger 5m bounce = more conviction |
| Sentiment shift | 15 | 5m buy ratio > 1h buy ratio = buyers returning |
| Buy pressure | 10 | 65%+ buy ratio in 5m = strong demand |
| Activity | 15 | High 1h volume + transaction count |
| Trend alignment | 15 | Dip in uptrend (6h/24h green) = best; death spiral = penalize |

## Patterns

- **DEEP-REVERSAL** (1h < -10%): High risk, high reward. Only enter if 5m bounce is strong and buyers clearly returning.
- **REVERSAL** (-10% < 1h < -5%): Sweet spot. Strong dip with reversal signal.
- **DIP-BUY** (-5% < 1h < -3%): Mild dip. Need strong 5m confirmation.
- **SHALLOW-DIP** (1h > -3%): Weakest. Needs other strong signals.

## Decision rule

Score >= 55: **buy**. Score < 55: **skip**.

When in doubt: check the swarm. If multiple agents are signaling the same token bullish, add 10 to your confidence. If any rug_alert in swarm: hard skip.
