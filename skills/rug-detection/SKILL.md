# Skill: Rug Detection

How to detect rug-pull risk before and after buying a token.

## Pre-buy rug check (via circuit-data-api)

Call `token_info` — it includes RugCheck risk data:

```
token_info(mint)
→ rugcheck.riskLevel: "LOW" | "WARN" | "DANGER"
→ rugcheck.risks: [{ name, description, level }]
→ rugcheck.score (0=safe, 100=dangerous)
```

**Hard rule**: Skip any token with `riskLevel === "DANGER"`. No exceptions.

## Red flags to look for in `token_info`

### Liquidity risks
- `"Liquidity not locked"` — LP can be pulled anytime
- Liquidity < $50k — too thin, one whale pull = rug
- LP lock expiry < 30 days out — about to unlock

### Supply risks
- `"Mint authority not revoked"` — dev can print infinite tokens
- `"Freeze authority enabled"` — dev can freeze your wallet
- Top 10 holders > 50% of supply — heavy concentration
- One address holds > 20% — sniper/dev whale

### Trading risks
- `"No trading activity"` — dead or just launched
- Buy/sell ratio in last 5m < 30% — heavy sell pressure
- Volume spike with price drop = distribution

### Social risks
- Token age < 2 hours — too new, no track record
- No social links, no website — anon team
- Copied/cloned contract bytecode

## Real-time rug signals during a hold

Check `read_swarm_feed` for `rug_alert` type signals:

```
read_swarm_feed(type="rug_alert", limit=20)
→ Any signal with mint matching your position = EXIT IMMEDIATELY
```

Signs to watch in the position monitor:
- P&L drops > 3% in a single 30s cycle → sell pressure
- Volume spikes while price drops → whales distributing
- Peak was in first 5 min and declining since → failed pump

## Rug alert timing

Rugs usually follow this pattern:
1. **Pump** — aggressive buys push price up (often bots)
2. **Distribution** — dev/whale wallets sell into pump
3. **Pull** — LP removed or massive sell dump
4. **Dead** — price at 0, no liquidity

If you're in a token and see step 2 (buy ratio dropping while price still high), exit.

## Publishing a rug alert to the swarm

If you detect a rug, alert other agents:

```
publish_signal({
  type: "rug_alert",
  mint: "<MINT>",
  symbol: "<SYMBOL>",
  note: "LP pulled / mint authority used / dev wallet draining",
  confidence: 85
})
```

This protects other agents from entering the same rug.

## Decision matrix

| Signal | Action |
|--------|--------|
| riskLevel DANGER | Hard skip — never buy |
| riskLevel WARN + score >= 45 | Buy with reduced size (50%) |
| Swarm rug_alert for this mint | Hard skip or immediate exit |
| LP not locked + mint not revoked | Skip unless score >= 65 |
| Top holder > 30% | Skip |
| Mint age < 30 min | Skip (too early, high volatility) |
| All clear | Normal entry |
