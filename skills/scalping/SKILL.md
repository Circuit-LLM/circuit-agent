# Skill: Scalping

Scalping is high-frequency, short-duration trading — entering on a short burst of momentum and exiting within minutes. Smaller gains per trade, more trades, requires strong signal discipline.

## When scalping makes sense

- Volatile market session (SOL ±3%+ intraday, high network TPS)
- Strong burst momentum on a token (5m spike > +5%, buy ratio > 70%)
- You have a winning streak and want to compound aggressively
- Fear & Greed > 65 — greed phase means momentum lasts longer

**Do NOT scalp when:**
- Fear & Greed < 35 (fear kills follow-through)
- Network is slow (TPS < 1500) — your tx may confirm late, slippage hurts you
- You have 3 open positions already (you need headroom to exit fast)

## Scalp entry criteria

These are stricter than dip-reversal because timing is everything.

| Signal | Threshold | Why |
|--------|-----------|-----|
| 5m price change | > +3% | Momentum must be live NOW |
| 1m direction | positive | Not reversing already |
| Buy ratio 5m | > 65% | Buyers dominating |
| Volume 5m | rising vs 1h avg | Acceleration, not decay |
| Liquidity | > $200k | Thin liquidity = slippage kills you |
| RugCheck | safe | No exceptions, even on speed trades |

**Ignore**: 1h trend, 6h trend, 24h trend. Scalps live and die on 5m data.

## Position sizing for scalps

**Smaller than normal**. Scalps have higher miss rate — you're catching bursts, not recoveries.

- Default: 60% of `entryBudgetSol`
- Max: standard `entryBudgetSol` (never go bigger on a scalp)
- Rationale: if the burst fades in 30s, you need to exit fast without a large loss

## Scalp exit rules (tighter than standard)

| Trigger | Value | Rationale |
|---------|-------|-----------|
| Take-profit | +5 to +8% | Take it fast — momentum fades |
| Stop-loss | -3% | Tighter than standard -6% |
| Max hold | 8-12 min | After 10min it's not a scalp anymore |
| Trailing activate | +3% | Start trailing earlier |
| Trailing distance | 2% | Tighter trail on momentum trades |

**Partial exits**: At +5%, sell 50%. Let the remaining 50% trail to +10% or -2% from peak. This locks profit while leaving upside open.

## Reading 5m momentum

High-conviction scalp signals (use `token_price` + `token_chart`):

- Price spiked on volume 3-5x normal → real demand, not manipulation
- Buy ratio went from 50% to 75%+ in last 5m → order flow flipping bullish
- Price holding gains after first 2 min → buyers absorbing sells, not dumping

Weak scalp signals (skip):
- Price spike with falling volume → exit trap
- Buy ratio 55-60% → not dominant enough
- Large holder just moved tokens → check `token_holders`

## Scalp cadence

**One scalp at a time**. You cannot manage two 8-minute exits simultaneously. Wait for the first to close before entering another.

Between scalp cycles: run `scan_tokens` and check if your dip-reversal scanner has better opportunities. Scalping is opportunistic, not your primary strategy.

## After a scalp

Win or loss, run `get_trade_history` after 3 scalps to check your hit rate. If you're losing >60% of scalps, switch back to dip-reversal (slower, more reliable). Scalping only works when your read on momentum is accurate.

Save the pattern that worked or failed with `save_note`.
