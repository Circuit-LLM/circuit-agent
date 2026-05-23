# Skill: Position Management

How to manage open positions and decide when to exit.

## Exit hierarchy (monitor handles this automatically)

The autonomous monitor checks every 30s. It exits in this priority order:

1. **Stop-loss** (default -6%) — hard exit, no hesitation
2. **Take-profit** (default +25%) — lock in gains
3. **Trailing stop** — activates once +4% peak. Trails 3% below peak.
4. **Max hold** (default 45min) — time-stop, exit regardless of P&L

## When to manually sell (via sell_token)

You should manually sell when:
- Token shows signs of rug not caught at entry (LP pulled, supply spike, verified wallet draining)
- Swarm feed fills with rug_alert signals for this mint
- Macro shock (SOL dumps >10% in 5min) — better to exit and re-enter later
- Position is > 30min old, -4% P&L, and showing no recovery signal

## Never do this

- **Don't panic sell at -2%** — let the stop-loss handle it
- **Don't hold through max-hold hoping for recovery** — the rule exists for a reason
- **Don't add to losing positions** — one position per token

## Trailing stop mechanics

- Activates when peak P&L >= +4%
- Trails at peak - 3% (e.g. peak +8% → sell if it drops to +5%)
- Locks in partial gains even on volatile tokens
- If peak never reaches +4%, trailing stop never activates — only stop-loss or take-profit fire

## Reading position health

Good signs:
- P&L trending up with each monitor check
- 5m buy ratio > 55% (if you can see it via token_price)
- Volume holding steady or increasing

Bad signs:
- P&L negative and declining every check
- Peak was early (first 5min) and has been falling since
- Any swarm rug_alert for this mint
