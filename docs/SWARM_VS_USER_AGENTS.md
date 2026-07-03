# Swarm Agents vs User-Run Agents

> **Updated 2026-07-02 (P4).** The swarm was reconfigured to be a **true user-mirror**: its
> localhost + internal-key shortcuts are now **disabled**, so it reaches everything through the
> public API, pays CIRC via x402 for paid products, reads the **free public** swarm feed, and
> authenticates by wallet signature — exactly like a user agent. This **inverts this doc's old
> premise**: the swarm is now a *good* stand-in for a correctly-configured user, not a poor one.
> It's still physically on the VPS (lower latency; 10 agents share one egress IP), but the **data
> path is identical** to a user's. Use it as the reference for what a correct user setup looks like.

## Why this doc exists

When a user reports a problem, it's tempting to check the swarm, see it's healthy, and chase the bug
into the code. Most mystery issues are a **misconfigured endpoint, an unfunded wallet, a weak model,
or a full disk** — not the code. Since P4 the swarm mirrors a correct user setup, so it's a reliable
reference: if the swarm works and the user doesn't, the user's config has drifted. Start here.

## The one-line difference (post-P4)

- **Swarm agent** — runs *on the VPS, beside the services*, but is now **configured like a user**:
  public API only, x402 for paid data, the free public feed for coordination, wallet-signature auth.
  The only real differences left are **physical** — lowest latency, and 10 agents sharing one egress IP.
- **User agent** — runs *anywhere else*; same public API, same x402, same signatures; one agent per IP.

## What changed in P4 (the shortcuts are gone)

The swarm used to take two shortcuts, both now **disabled** in every agent's `.env`:

- `PRICE_FEED_URL=127.0.0.1:18941` — **commented out.** The swarm now reads prices/scan through the
  public `…/api/price-feed`, same as a user.
- `CIRCUIT_INTERNAL_KEY` — **commented out.** The swarm no longer skips payment/auth. It reads the
  **free public `/api/swarm/feed-public`** for coordination (via `swarmFeedPublic()`), pays x402 for
  paid products (token-info, ohlcv, …), and writes with wallet signatures only.

To let 10 agents on one IP go fully public without hitting limits, the free rate limits were raised —
these are per-IP and help **any** real fleet, not a privilege: `freeLimiter` 30→**300/min**,
`priceFeedLimiter` 60→**600/min**.

## Side-by-side (post-P4)

| | Swarm agent (co-located) | User agent (external) |
|---|---|---|
| Where it runs | VPS, `~/circuit-swarm/agentN/` | user's own machine |
| Data API (`baseUrl`) | `https://api.circuitllm.xyz` | `https://api.circuitllm.xyz` (same) |
| Price feed route | **public `…/api/price-feed`** (`PRICE_FEED_URL` disabled) | **public `…/api/price-feed`** (same) |
| Internal key | **disabled** (was set) | none (same) |
| Paid data reads (token-info, ohlcv, …) | pays x402 | pays x402 (same) |
| Prices (token-price/-prices) | **free** (un-gated in P3a) | **free** (same) |
| Swarm feed reads | **free public `feed-public`** | **free public `feed-public`** (same) |
| Writes (signals / heartbeat) | wallet signature | wallet signature (same) |
| Rate limits | free 300/min, feed 600/min — **shared by 10 agents on 1 IP** | free 300/min, feed 600/min — own IP |
| Latency to price feed | lower (same box, public proxy hop) | higher (remote) |

The data path is now identical; the residual differences are **latency** and **one-IP rate-limit
pressure** (10 agents share the fleet's egress IP).

## Known real gaps that hit users — and now the swarm too

Because the swarm is on the public path, it now shares the user's exposure to these, which makes it a
*better* early-warning proxy than before:

- **CIRC / pump.fun price 502 in a trading lull.** The paid `token-price` endpoint proxies
  **circuit-node**, which can't price pump.fun tokens once the 120s `circuit:price-sol:{mint}` Redis
  key expires between trades. (Mitigated: `token-price` now falls back to the price-feed, and the
  swarm's monitor reads `/api/price-feed/prices`, which has an RPC fallback.) See
  `project_circuit_token_price_pumpswap_gap`.
- **x402 verify race:** a correctly-paid call can be rejected ("Payment Verification Failed") if the
  CIRC/USD price ticks between the quote and the payment — strict amount check, no tolerance. Hits
  users and swarm alike, intermittently.

## User-agent config checklist

When a user reports an issue, compare **their** config to a correct user setup (which the swarm now
matches):

- [ ] `api.baseUrl` = `https://api.circuitllm.xyz`
      (NOT `localhost:18700` — that's *pisky-data-api*, a different project; a common bad override)
- [ ] **No** `PRICE_FEED_URL` pointing at localhost (unless they're genuinely co-located)
- [ ] `CIRCUIT_INTERNAL_KEY` only if they legitimately have one (most users don't)
- [ ] Wallet (`AGENT_KEYPAIR`) funded: **SOL** for gas **and** **CIRC** for x402
- [ ] Model is tool-capable (weak models loop → "stuck in my thinking")
- [ ] Disk not full (a full disk breaks the file-queue chat → "stuck in my thinking")
- [ ] Chat x402 toggle **OFF** for data questions (ON = Circuit DLLM, which has **no tools**)

## Common user symptom → likely real cause

| Symptom | Check first |
|---|---|
| "I got stuck in my thinking" | disk full, weak model looping, or a data call failing under it |
| can't fetch ANY token data | wrong `baseUrl` (localhost:18700), unfunded wallet, or x402 toggle ON |
| CIRC / pump.fun price "unavailable" (502) | known node price gap in lulls — not the user's fault |
| paid call rejected after paying | x402 verify race (CIRC price moved between quote and pay) |
| swarm feed empty | free `feed-public` unreachable, or all signals filtered out — no longer a key issue |
| prices slower than expected | public-proxy latency + rate limits (600/min feed) |

## Bottom line

Since P4 the swarm is configured **like a correct user agent** — public API, x402, free public feed,
signature auth. It's now a **reliable reference** for what a working user setup looks like. When a
user has a problem the swarm doesn't, the difference is almost always the **user's config** (checklist
above) or a **physical** factor (their latency, their wallet funding) — not the shared code.
