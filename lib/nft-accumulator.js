// lib/nft-accumulator.js — scheduled NFT floor accumulator (Phase 2).
//
// Mirrors lib/dca-executor.js: an independent loop, separate from the token scanner. For each watched
// collection (cfg.nft.watch = { "<collection>": [targetSol rungs...] }) it reads the live floor and,
// when the floor has come down to/below a rung not yet bought, buys ONE floor NFT through the same
// safety gate + executor as the nft_buy tool. Each rung fires at most once (state-tracked). Buys at
// most one NFT per cycle (conservative). Paper or live is decided by the executor in ctx.
'use strict';

const fs   = require('fs');
const path = require('path');
const { checkNftBuy } = require('./nft-guards');
const { acquireBuyLock, releaseBuyLock } = require('./trade-lock');
const nftPositions = require('./nft-positions');

const STATE_FILE = path.join(__dirname, '../data/nft_accumulator_state.json');

const _log = (msg, data = {}) => {
  const ts = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [NFT-ACC] [INFO] ${line}\n`);
};

function _loadState() {
  try { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function _saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

async function checkAndExecute(cfg, ctx, telegramBot = null) {
  const notify = telegramBot?.api?.sendMessage
    ? (msg) => telegramBot.api.sendMessage(cfg.telegram?.chatId, msg, { parse_mode: 'Markdown' }).catch(() => {})
    : null;
  const n = cfg?.nft ?? {};
  const watch = n.watch && typeof n.watch === 'object' ? n.watch : {};
  const collections = Object.keys(watch);
  if (!collections.length) return { checked: 0, bought: 0 };
  const nftSwap = ctx.nftSwap;
  if (!nftSwap) return { checked: 0, bought: 0, reason: 'no-executor' };

  const state = _loadState();
  let bought = 0;

  for (const collection of collections) {
    const rungs = (Array.isArray(watch[collection]) ? watch[collection] : [])
      .map(Number).filter((r) => r > 0).sort((a, b) => b - a);   // descending target floors
    if (!rungs.length) continue;

    let data;
    try { data = await ctx.api.nftCollection(collection, { listings: 1 }); } catch { continue; }
    const floor = Number(data?.floorSol);
    const cheap = data && Array.isArray(data.cheapest) ? data.cheapest[0] : null;
    if (!(floor > 0) || !cheap) continue;

    const boughtRungs = (state[collection] && state[collection].boughtRungs) || [];
    // Highest rung the floor has reached (floor ≤ rung) that hasn't fired yet.
    const rung = rungs.find((r) => floor <= r && !boughtRungs.includes(r));
    if (rung == null) continue;

    const listing = { mint: cheap.assetId, collection: data.collection, collectionName: data.collectionName, priceSol: cheap.priceSol, listState: null, floorSol: floor };
    if (nftPositions.get(listing.mint)) continue;
    if (listing.priceSol > rung) continue;                       // cheapest listing above the rung target

    const g = await checkNftBuy({ collection: listing.collection, priceSol: listing.priceSol, ctx });
    if (!g.ok) { _log(`skip ${listing.collectionName || collection.slice(0, 8)} rung ${rung} — ${g.reason}`); continue; }

    if (!acquireBuyLock(listing.mint)) continue;
    let result;
    try { result = await nftSwap.buy(listing, rung); }
    catch (e) { releaseBuyLock(listing.mint); _log(`buy failed ${listing.mint.slice(0, 8)}: ${e.message}`); continue; }
    releaseBuyLock(listing.mint);

    nftPositions.openNft(listing.mint, {
      collection: listing.collection, collectionName: listing.collectionName,
      solSpent: result.solSpent, listState: listing.listState, floorAtBuySol: floor,
      txSig: result.txSig, paper: !!nftSwap.paperMode,
    });
    state[collection] = state[collection] || { boughtRungs: [] };
    state[collection].boughtRungs.push(rung);
    _saveState(state);
    bought++;
    const line = `NFT accumulator${nftSwap.paperMode ? ' (paper)' : ''}: bought ${listing.collectionName || collection.slice(0, 8)} floor @ ${listing.priceSol} SOL (rung ${rung}) → ${result.txSig}`;
    _log(line);
    if (notify) { try { await notify(`🖼️ ${line}`); } catch {} }
    break;                                                       // one buy per cycle
  }

  return { checked: collections.length, bought };
}

// Self-scheduling loop (matches the other agent loops: start(cfg, ctx, telegramBot)).
function start(cfg, ctx, telegramBot = null) {
  const interval = cfg?.nft?.scanIntervalMs ?? 120_000;
  const watched = Object.keys(cfg?.nft?.watch ?? {}).length;
  const tick = async () => { try { await checkAndExecute(cfg, ctx, telegramBot); } catch (e) { _log(`tick error: ${e.message}`); } };
  const t = setInterval(tick, interval);
  if (t.unref) t.unref();
  _log(`accumulator scheduled — every ${Math.round(interval / 1000)}s, ${watched} watched collection(s), mode=${ctx.nftSwap?.paperMode ? 'paper' : 'live'}`);
}

module.exports = { checkAndExecute, start };
