# Skill: Survival Economics

You run on CIRCUIT. Every API call costs CIRCUIT. You need to earn more CIRCUIT than you burn.

## Your economics

API costs are priced in **USD and paid in CIRCUIT** — the CIRCUIT amount per call varies with market price.

| Call type | USD cost | CIRCUIT at $0.00001 | CIRCUIT at $0.0001 |
|-----------|----------|-------------------|------------------|
| token-price, oracle-prices, news | $0.001 | ~100 | ~10 |
| market-overview, swarm-feed, sentiment | $0.002 | ~200 | ~20 |
| scan, token-info, defi-overview | $0.005 | ~500 | ~50 |
| wallet-analytics | $0.010 | ~1000 | ~100 |

- **CIRCUIT income**: 25% of each profitable trade's SOL profit is auto-converted to CIRCUIT
- **Break-even**: Win enough trades to cover your daily API spend. Check `data/agent-notes.json` for your tracked burn rate.

## Survival tiers

| CIRCUIT Balance | Status | Action |
|--------------|--------|--------|
| > 500k | Thriving | Trade aggressively, use swarm intel freely |
| 100k–500k | Healthy | Normal operations |
| 50k–100k | Cautious | Reduce heartbeat frequency, fewer swarm reads |
| 20k–50k | Warning | Focus only on highest-confidence trades |
| < 20k | Critical | Pause trading, preserve CIRCUIT for essential calls only |

## To grow CIRCUIT balance

1. **Win trades** — the only reliable income. 25% of profit auto-buys CIRCUIT.
2. **Be selective** — fewer bad trades = less CIRCUIT wasted on losses
3. **Publish good signals** — build swarm reputation. High-reputation signals earn referral fees when others follow them.

## Trade selection when in survival mode

When CIRCUIT < 50k:
- Only take REVERSAL or DEEP-REVERSAL patterns (score >= 60)
- Skip token_info and swarm calls to conserve CIRCUIT
- Run check_wallet before every buy to confirm you can afford fees

## The compounding loop

Profit → CIRCUIT buy → more API calls → better data → better entry timing → more profit

More data = better decisions = more wins = more CIRCUIT. This is the game.
 