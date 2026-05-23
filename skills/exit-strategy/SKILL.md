# Skill: Exit Strategy

Knowing when and how to exit is harder than knowing when to enter. Most losses come from holding too long. Most missed gains come from exiting too early. This skill covers the full range.

## The core principle

**Your job after buying is to protect capital, not to maximize profit.** A 6% gain that you actually close is better than a 20% gain that became a 10% loss because you waited.

## Exit tiers

### Hard exits (automatic, no thinking required)

These trigger via the position monitor — they should NEVER be overridden by the LLM:

| Rule | Value | Action |
|------|-------|--------|
| Stop-loss | cfg.stopLossPct (default -6%) | Sell 100% immediately |
| Take-profit | cfg.takeProfitPct (default +25%) | Sell 100% immediately |
| Max hold | cfg.maxHoldMinutes (default 45min) | Sell 100% — time is up |
| Trailing stop | peaks then drops cfg.trailingStopDistancePct | Sell 100% |

**Never talk yourself out of a stop-loss.** "It'll recover" is how -6% becomes -30%.

### Soft exits (LLM judgment during position review)

These are situations where you should exit even if hard rules haven't triggered:

1. **Swarm flip**: Majority of swarm signals flipped from bullish to bearish on your token → exit now, even at a small gain or loss
2. **Rug indicators late-emerge**: Whale exit detected in `token_holders`, LP drain in progress → exit immediately
3. **Better opportunity**: A score 80+ dip-reversal appears and you're at 3 open positions → exit your weakest position to free capital
4. **Macro deterioration**: SOL drops >5% while you're in a meme position → the rising tide just reversed, exit

### Partial exits (the smart middle ground)

You don't have to sell 100% at once. Use `sell_token(mint, pct)` with pct < 1.0:

| Scenario | Action |
|----------|--------|
| At +12%, strong momentum continues | Sell 50% (lock half), let 50% ride |
| At +20%, near take-profit, showing hesitation | Sell 75%, trail remaining 25% |
| At -3%, uncertain direction | Sell 50% (reduce exposure), watch for recovery |
| Near max hold time but still green | Sell 50% before the clock forces a full exit |

**Partial sell rule**: After a partial exit, update your mental stop on the remaining position to breakeven. You've locked profit — now let the house money run.

## Reading the exit signal

Use `token_chart` to check the last 4-8 candles before deciding:

**Exit signals:**
- Volume declining while price rises → distribution, exit approaching
- Price making lower highs on consecutive candles → trend broken
- Buy ratio falling below 50% → sellers taking over
- Sharp single candle spike up with no follow-through → fake breakout, often reverses

**Hold signals:**
- Volume increasing with price → real demand
- Each dip is bought quickly → strong accumulation
- Buy ratio staying above 60% → buyers in control
- Swarm still bullish consensus on your token

## Managing winners vs losers differently

### A winner at +10-15%:
- Ask: is momentum still intact? (check buy ratio, volume)
- If yes: trail with tight stop, let it run to take-profit
- If no: take 50-75% off now, trail the rest

### A loser at -3 to -4%:
- Ask: is this a dip or a trend break?
- Dip (still above entry price support, buy ratio recovering): hold, your stop is -6%
- Trend break (lower lows, sellers dominating): exit now at -4% instead of -6%
- "Early exit on a loser" is not weakness — it's capital preservation

### A flat position at 0% after 20+ min:
- This is a failed setup. Capital is stuck, opportunity cost is real.
- Exit if no clear catalyst incoming. Take the small fee loss and redeploy.

## Time-based exit escalation

| Time held | Green position | Flat position | Red position |
|-----------|---------------|---------------|--------------|
| < 15 min | Let it run | Wait | Hold (stop active) |
| 15-30 min | Partial take at TP/2 | Exit if no momentum | Hold or cut early |
| 30-40 min | Sell 75%, trail 25% | Exit now | Exit before stop |
| > 40 min | Trail aggressively | Exit | Exit (approaching max hold) |

## After the exit

Always `save_note` what happened:
- Was the exit on a rule or judgment?
- Did price continue in your direction after exit? (over-exited)
- Did price reverse after exit? (exit was right)
- What would you do differently?

This is how your exit timing improves over sessions.
