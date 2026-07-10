# LP Optimizer — Phase 2 Feature

The LP Optimizer is an independent 1-hour loop that manages Solana LP positions separately from the trading portfolio. It automatically harvests fees and rebalances positions when out of balance.

## Features

- **Fee Harvesting**: Automatically claims unclaimed LP fees when they exceed a USD threshold
- **Position Rebalancing**: Rebalances LP positions when token ratios drift beyond 15% from 50/50 target
- **Separate State Management**: LP positions tracked independently from trading positions
- **Telegram Alerts**: Notifies on significant events (harvest, rebalance)
- **Audit Logs**: Append-only execution log for compliance and debugging

## Configuration

Enable in `config/agent.json` under `strategy`:

```json
{
  "strategy": {
    "lpOptimizeEnabled": false,
    "lpOptimizeIntervalMs": 3600000,
    "lpHarvestEnabled": true,
    "lpRebalanceEnabled": true,
    "lpHarvestThresholdUsd": 5.0,
    "lpRebalanceThreshold": 0.15,
    "lpPositions": []
  }
}
```

### Configuration Options

- `lpOptimizeEnabled`: Enable/disable LP optimizer (default: false)
- `lpOptimizeIntervalMs`: Cycle interval in milliseconds (default: 3600000 = 1 hour)
- `lpHarvestEnabled`: Auto-harvest unclaimed fees (default: true)
- `lpRebalanceEnabled`: Auto-rebalance imbalanced positions (default: true)
- `lpHarvestThresholdUsd`: Minimum unclaimed fees to trigger harvest (default: $5 USD)
- `lpRebalanceThreshold`: Ratio delta threshold for rebalance (default: 0.15 = 15%)
- `lpPositions`: Array of LP positions to monitor

## LP Position Schema

Each LP position in `lpPositions` array requires:

```json
{
  "dex": "orca",
  "tokenA": "EPjFWaLb3odccxFSrv3C5651y45r1AF5ZYZQp59gEYw",
  "tokenB": "So11111111111111111111111111111111111111112",
  "mint": "EVjFWaLb3odccxFSrv3C5651y45r1AF5ZYZQp59gEYu",
  "liquidity": 1000,
  "unclaimed": 0,
  "ratio": 0.5,
  "lastHarvest": "2026-07-10T08:00:00.000Z",
  "lastRebalance": "2026-07-09T08:00:00.000Z"
}
```

Fields:
- `dex`: DEX name (orca, raydium)
- `tokenA`: Token A mint address (e.g., USDC)
- `tokenB`: Token B mint address (e.g., SOL)
- `mint`: LP position mint address
- `liquidity`: Position liquidity in USD
- `unclaimed`: Unclaimed fees in USD (queried from chain)
- `ratio`: Current token A ratio (0-1, 0.5 = 50/50)
- `lastHarvest`: Timestamp of last harvest
- `lastRebalance`: Timestamp of last rebalance

## Data Files

### data/lp_positions.json
Active LP positions being monitored. Updated after each cycle.

### data/lp_executions.json
Append-only audit log of all harvest and rebalance actions:

```json
[
  {
    "timestamp": "2026-07-10T08:15:00.000Z",
    "action": "harvest",
    "mint": "EVjFWaLb3odccxFSrv3C5651y45r1AF5ZYZQp59gEYu",
    "unclaimedUsd": 12.50,
    "txSig": "5gX9k3z...",
    "status": "pending"
  },
  {
    "timestamp": "2026-07-10T09:00:00.000Z",
    "action": "rebalance",
    "mint": "EVjFWaLb3odccxFSrv3C5651y45r1AF5ZYZQp59gEYu",
    "side": "A",
    "amountSol": 0.5,
    "beforeRatio": 0.62,
    "targetRatio": 0.5,
    "txSig": "4fW8j2y...",
    "status": "pending"
  }
]
```

### data/lp_health.json
Current health snapshot of all LP positions:

```json
{
  "timestamp": "2026-07-10T10:00:00.000Z",
  "positions": [
    {
      "mint": "EVjFWaLb3odccxFSrv3C5651y45r1AF5ZYZQp59gEYu",
      "dex": "orca",
      "liquidity": 1000,
      "unclaimed": 2.30,
      "ratio": 0.51,
      "imbalanced": false,
      "harvested": false,
      "rebalanced": false,
      "lastHarvest": "2026-07-10T08:15:00.000Z",
      "lastRebalance": "2026-07-09T08:00:00.000Z"
    }
  ],
  "summary": {
    "total": 1,
    "harvested": 0,
    "rebalanced": 0,
    "errors": 0
  }
}
```

## Rebalancing Logic

### Imbalance Detection
A position is considered imbalanced when:
```
|ratio - 0.5| > threshold
```

Where:
- `ratio` = current token A percentage (e.g., 0.62 = 62% A, 38% B)
- `threshold` = `lpRebalanceThreshold` (default 0.15 = 15%)

Example:
- Ratio 0.62 is 12% off from 0.5 → NOT imbalanced (12% < 15%)
- Ratio 0.66 is 16% off from 0.5 → IMBALANCED (16% > 15%)

### Rebalance Execution
When imbalanced:
1. Determine which side is overweighted (A if ratio > 0.5, B if ratio < 0.5)
2. Swap the overweighted token for the underweighted token
3. Swap amount = liquidity × imbalance × 0.5
4. Log execution with before/after ratios

## Harvest Logic

1. Query on-chain for unclaimed fees in USD
2. If unclaimed > `lpHarvestThresholdUsd`:
   - Execute harvest transaction via SwapExecutor
   - Log transaction signature
   - Update `lastHarvest` timestamp
3. Continue to next position

## Error Handling

- Query failures: Logged and skipped (position not updated)
- Harvest/rebalance failures: Logged, position continues with next cycle
- Invalid ratios: Rejected and logged
- Corrupt JSON files: Loaded with safe defaults, no crash

## Testing

Run LP optimizer tests:
```bash
npm test -- tests/lp-optimizer.test.js
```

Tests cover:
- Ratio validation (0-1 bounds, NaN/Infinity rejection)
- Imbalance detection (threshold logic, edge cases)
- Fee threshold detection (harvest triggers)
- State persistence (atomic file writes, cleanup)
- File I/O safety (missing files, corrupt JSON)

## Integration

The LP Optimizer integrates into agent startup:

1. Check `lpOptimizeEnabled` config flag
2. If enabled, start periodic 1-hour loop via `lpOptimizer.start()`
3. Loop runs independently from:
   - Trading entry/exit logic
   - Position monitoring
   - Market scanning
4. All state stored in separate data files
5. Telegram notifications sent for significant events

## Example Configuration

To enable LP optimization on one USDC/SOL Orca position:

```json
{
  "strategy": {
    "lpOptimizeEnabled": true,
    "lpOptimizeIntervalMs": 3600000,
    "lpHarvestEnabled": true,
    "lpRebalanceEnabled": true,
    "lpHarvestThresholdUsd": 5.0,
    "lpRebalanceThreshold": 0.15,
    "lpPositions": [
      {
        "dex": "orca",
        "tokenA": "EPjFWaLb3odccxFSrv3C5651y45r1AF5ZYZQp59gEYw",
        "tokenB": "So11111111111111111111111111111111111111112",
        "mint": "YOUR_LP_MINT_ADDRESS_HERE",
        "liquidity": 1000,
        "unclaimed": 0,
        "ratio": 0.5,
        "lastHarvest": null,
        "lastRebalance": null
      }
    ]
  }
}
```

## Future Enhancements

- LP yield estimation and APY tracking
- Multi-pool diversification strategy
- Dynamic harvest threshold based on gas prices
- Concentration alerts (warn when ratio drifts)
- LP performance analytics dashboard
