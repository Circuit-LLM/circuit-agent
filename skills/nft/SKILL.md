# Skill: NFT Markets

Reading Solana NFT collections the way a disciplined trader does — floors, listings,
standing bids, and the spread between them — and knowing which "opportunities" are real
and which are traps. This is the trading loop pointed at NFTs: **survey → spot → vet →
decide**. All data is computed on-chain by circuit-node (Tensor), no third-party API.

## The one rule

**Judge on `netSpreadSol`, never `spreadSol`.** `spreadSol` is the raw floor→bid gap; `netSpreadSol`
already subtracts the collection's real creator royalty (`royaltyBps`) and Tensor fees on both legs —
it's the number that survives to your pocket. A big positive `spreadSol` with a **negative
`netSpreadSol`** is a trap the gross number hides. And even a positive net is only a *lead*: a standing
bid can be stale, spoofed, or too thin to actually fill (see the checklist). "Free money" off a gross
number is how you lose money.

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
| `nft_search` | collection NAME → address (+ floor) | **start here** whenever the user names a collection — everything else needs the address |
| `nft_market` | global snapshot: #collections, #listings, bid coverage, live arb count, median floor | **read the macro** before drilling in |
| `nft_arb` | every collection where floor ≤ best bid, ranked by gross spread | **find** mark-to-market arb in one call |
| `nft_collection` | one collection: floor, listed count, cheapest listings, top bid, `spreadSol`, `floorBelowBid` | **vet** a specific collection or accumulation target |
| `nft_bids` | full standing collection-bid depth (highest first) | **check bid depth** before trusting an arb — is it one bid or a wall? |
| `nft_floors` | all collection floors + listing counts, sortable | **survey** the market / find the most-liquid collections |
| `nft_asset` | one NFT by mint: listed?, price, collection, floor, top bid, `sellableIntoBid` | inspect a **specific NFT** / "is this listed / what's it worth" |
| `wallet_nfts` | a wallet's NFTs + floor **mark-to-market** total | value or manage a **portfolio** |
| `nft_sales` | recent listing **activity** (fills/delists) at last price + avg/median | gauge how **active/liquid** a collection is (velocity), *not* exact sale prices |

**`nft_sales` is activity, not confirmed sales.** It reports listings that *left the book* (sold **or**
delisted) at their last list price — a liquidity/velocity read. Don't quote its numbers as "the collection
sold for X"; use it to judge whether a collection is churning (safer to trade) or dead (a trap).

**Names, not addresses.** Users and their prompts say "Mad Lads," not `EAUom…`. Always `nft_search`
first to turn a name into the address the other tools need. If search returns several matches, confirm
which one (compare floors/listing counts) rather than guessing.

## The plays

### 0. Orient — `nft_market`, then `nft_floors`

Before any specific call, `nft_market` tells you the shape of the market (how many collections/listings
are indexed, whether *any* arbs exist right now, the median floor). If the arb count is 0, don't go
hunting arbs this pass. `nft_floors` then surfaces the most-liquid collections to work in.

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

### 4. Portfolio — `wallet_nfts`, `nft_asset`

`wallet_nfts` values a wallet at the sum of collection floors (`markToMarketSol`) — a **lower bound**;
trait-rare items are worth more, and unindexed collections show held-but-unvalued. `nft_asset` inspects
one NFT: is it listed, and `sellableIntoBid` tells you if there's a standing bid to exit into *right now*.
For "should I sell holding X," combine `nft_asset` (its collection + is there a bid) with `nft_bids`
(how deep that bid side is).

---

## Vetting checklist — run on EVERY arb candidate

1. **Net it out.** Use the `netSpreadSol` the tools return — it's already net of `royaltyBps` + fees.
   If `netInTheMoney` is false (net ≤ 0), it is **not** an opportunity, however fat the gross looks.
   (`royaltyBps` null means royalty wasn't indexed yet and net assumed ~6% — treat as lower-confidence.)
2. **Stale-bid smell test.** A bid *far* above floor (e.g. `spreadPct` in the hundreds) is
   almost never free money — it's usually a stale bid left from a higher floor, a spoof, or a
   margin bid that can't actually fill. The bigger the ratio, the more suspicious, not less.
3. **Liquidity check.** Look at `listed`, and call `nft_bids` to see the bid *depth*. One lonely bid +
   two listings = you may not be able to buy the floor *and* sell into the bid before the state changes.
   A single fat bid over a thin listing book is the classic trap. Thin collections are traps even when
   the math looks good.
4. **Freshness.** Floors and bids refresh on a ~30-minute reconciliation; the arb scan caches
   ~60s. Treat every number as a lead to confirm on-chain at the moment of action, not a fill price.
5. **Coverage.** Bid/arb data covers the voc-based (verified-collection) subset. A collection
   *absent* from `nft_arb` isn't guaranteed to have no bid — it may just not be joined yet. Absence
   is not a signal.

## Interpreting the fields

- `netSpreadSol` → **the one that matters** — floor→bid gap after royalty + fees, both legs. `netInTheMoney`.
- `royaltyBps` → the collection's creator royalty (200 = 2%). null = not indexed (net assumed ~6%).
- `floorBelowBid: true` → floor is at/below the top bid (GROSS arb candidate). Necessary, not sufficient.
- `spreadSol` → gross floor→bid gap. `spreadPct` → same as % of floor (a *huge* % is a red flag, see #2).
- `topBidSol` / `topBids` → the standing collection bids you'd sell into. Depth matters.
- `listed` → open listings; your liquidity proxy. `cheapest` → the actual buyable listings at floor.

## Buying — `nft_buy` (self-custody, paper-first)

The agent CAN now buy — self-custody, through `nft_buy`. Give it a **collection** (buys the cheapest
listing) or a specific **mint**, and an optional **`maxSol`** price ceiling. It goes through a hard safety
gate and, in **paper mode** (`nft.paperTrading`, the default), simulates against a virtual balance.

Discipline the tool enforces for you — don't fight it:
- **Caps:** `maxBuySol` (per-buy), `maxOpenNfts` (holdings), `dailyBuyLimitSol` (gross/day), and
  `maxHeldSol` — the **standing NFT exposure** cap (illiquid capital; the one that stops the wallet
  becoming a bag of unsellable JPEGs). Plus the shared wallet **survival floor**.
- **Overpay guard:** `maxSol` is a hard ceiling — a buy is refused/fails if the listing price is above it.
- **Fail-closed:** un-indexed or blacklisted collections are refused.
- **Accumulate, don't chase:** to ladder into a collection, use the accumulator (config `nft.watch`), not
  repeated `nft_buy` calls — a floor that hit your target can keep falling.

**Still no selling/listing** — a later, separate capability. A buy is a *commitment of illiquid capital*:
only buy what survives the vetting checklist (net spread, liquidity, stale-bid, freshness), prefer paper
until the user explicitly moves to live, and when you do buy, say what it cost and why.

## Saying "no"

The disciplined default on an arb signal is **skepticism**. Most gross spreads evaporate under
royalties, fees, and stale bids, and most fat-percentage bids are not fillable. Reporting "I found
three floor-below-bid collections but none survive the net/liquidity/stale checks" is a *correct,
valuable* answer — far better than presenting a gross number as profit.
