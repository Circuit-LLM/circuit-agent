# Skill: NFT Markets

Reading Solana NFT collections the way a disciplined trader does — floors, listings,
standing bids, and the spread between them — and knowing which "opportunities" are real
and which are traps. This is the trading loop pointed at NFTs: **survey → spot → vet →
decide**. All data is computed on-chain by circuit-node (Tensor), no third-party API.

## The one rule

**A gross spread is not a profit.** Every arb number these tools return is the raw
floor-to-bid gap, *before* creator royalties (0–10%), marketplace fees (~1.5%), and the
risk that the bid is stale or the collection can't be exited. Subtract those in your head
*every single time* before you call something an opportunity. A confident "free money"
read on a gross number is how you lose money.

---

## When to load this skill

- The user asks about an NFT collection, floor price, or NFT opportunities.
- The user wants to accumulate an NFT collection at a target price.
- You're asked to find NFT arbitrage / mispricing.
- A market survey turns up NFT activity worth a look.

Do **not** load it for fungible token trading — that's `market-analysis` / `momentum-trading`.

## What's different about NFTs

There is no deep fungible order book. You cannot trade an NFT collection like a token —
you can't scale in and out at a mid price. So the game is **opportunity-hunting and
patient accumulation**, not momentum-chasing:

- **Floor** = the cheapest open listing. It's the buy price, and a rough (lower-bound) mark.
- **Standing collection bid** = someone's live offer to buy *any* NFT from the collection.
  It's the instant sell price — if it's real and you can hit it.
- **Liquidity** = how many listings exist (`listed`) and how deep the bids are. Thin = trapped.

## The tools

| tool | returns | use it to |
|---|---|---|
| `nft_arb` | every collection where floor ≤ best bid, ranked by gross spread | **find** mark-to-market arb in one call |
| `nft_collection` | one collection: floor, listed count, cheapest listings, top bid, `spreadSol`, `floorBelowBid` | **vet** a specific collection or accumulation target |
| `nft_floors` | all collection floors + listing counts, sortable | **survey** the market / find the most-liquid collections |

## The three plays

### 1. Mark-to-market arb — `nft_arb`

Buy the floor, sell instantly into a standing collection bid that sits above it. `nft_arb`
returns these ranked by gross spread. **This is where most of the traps live** — work the
vetting checklist below on every candidate before you believe it.

### 2. Accumulation — `nft_collection`, watching a target

The user wants collection X and will buy as the floor comes to them. Pull `nft_collection`,
compare `floorSol` to the target. Floor ≤ target = a ladder trigger — **not a bottom call.**
Ladder in; a floor that hit your target can keep falling.

### 3. Survey — `nft_floors`

`sort: 'listed'` surfaces the most-liquid collections (safest to operate in). `sort: 'floor'`
finds the cheapest, `-floor` the priciest. Use it to orient before drilling in.

---

## Vetting checklist — run on EVERY arb candidate

1. **Net it out.** `netSpread ≈ spreadSol − floorSol × (royaltyPct + ~0.015)`. If you don't
   know the royalty, assume 5–10%. If the net isn't clearly positive, it's not an opportunity.
2. **Stale-bid smell test.** A bid *far* above floor (e.g. `spreadPct` in the hundreds) is
   almost never free money — it's usually a stale bid left from a higher floor, a spoof, or a
   margin bid that can't actually fill. The bigger the ratio, the more suspicious, not less.
3. **Liquidity check.** Look at `listed` and the top bids. One bid + two listings = you may not
   be able to buy the floor *and* sell into the bid before the state changes. Thin collections
   are traps even when the math looks good.
4. **Freshness.** Floors and bids refresh on a ~30-minute reconciliation; the arb scan caches
   ~60s. Treat every number as a lead to confirm on-chain at the moment of action, not a fill price.
5. **Coverage.** Bid/arb data covers the voc-based (verified-collection) subset. A collection
   *absent* from `nft_arb` isn't guaranteed to have no bid — it may just not be joined yet. Absence
   is not a signal.

## Interpreting the fields

- `floorBelowBid: true` → floor is at/below the top bid (arb candidate). Necessary, not sufficient.
- `spreadSol` → gross floor→bid gap. `spreadPct` → same as % of floor (a *huge* % is a red flag, see #2).
- `topBidSol` / `topBids` → the standing collection bids you'd sell into. Depth matters.
- `listed` → open listings; your liquidity proxy. `cheapest` → the actual buyable listings at floor.

## What this skill can and can't do

It **reads and reasons** — it surfaces opportunities and tells the user what's real. It does
**not** execute: buying, selling, or listing an NFT is a separate, custodial capability the agent
does not have. So the honest output is *"here's a candidate and why it does / doesn't survive the
checklist,"* never *"I bought it."* If the user wants to act, hand them the vetted facts and say so.

## Saying "no"

The disciplined default on an arb signal is **skepticism**. Most gross spreads evaporate under
royalties, fees, and stale bids, and most fat-percentage bids are not fillable. Reporting "I found
three floor-below-bid collections but none survive the net/liquidity/stale checks" is a *correct,
valuable* answer — far better than presenting a gross number as profit.
