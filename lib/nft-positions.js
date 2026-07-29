// lib/nft-positions.js — NFT holdings + trade history (Phase 2).
//
// Mirrors lib/positions.js's atomic-write persistence, keyed by NFT mint (assetId).
// NFTs are illiquid, so this store also answers the two caps the guards care about:
//   heldSol()      — total SOL locked in open NFT positions (standing exposure)
//   dailySpentSol()— gross SOL spent on NFT buys since UTC midnight (daily flow)
'use strict';

const fs   = require('fs');
const path = require('path');

const POSITIONS_FILE = path.join(__dirname, '../data/nft_positions.json');
const HISTORY_FILE   = path.join(__dirname, '../data/nft_trade_history.json');

function _loadJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function _atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function _load()  { return _loadJson(POSITIONS_FILE, {}); }
function _save(p) { _atomicWrite(POSITIONS_FILE, p); }

// Open an NFT position. data: { collection, collectionName, solSpent, listState, txSig, floorAtBuySol, paper }
function openNft(mint, data = {}) {
  const positions = _load();
  positions[mint] = {
    mint,
    collection:      data.collection ?? null,
    collectionName:  data.collectionName ?? null,
    solSpent:        Number(data.solSpent) || 0,
    listState:       data.listState ?? null,
    floorAtBuySol:   data.floorAtBuySol ?? null,
    txSig:           data.txSig ?? null,
    paper:           !!data.paper,
    buyTs:           Date.now(),
  };
  _save(positions);
  return positions[mint];
}

// Close (sold/removed) — move to history. exitData: { solReceived, txSig, reason }
function closeNft(mint, exitData = {}) {
  const positions = _load();
  const pos = positions[mint];
  if (!pos) return null;
  delete positions[mint];
  _save(positions);

  const history = _loadJson(HISTORY_FILE, []);
  const solReceived = Number(exitData.solReceived) || 0;
  history.unshift({
    ...pos,
    exitTs:      Date.now(),
    solReceived,
    pnlSol:      +(solReceived - pos.solSpent).toFixed(6),
    exitTxSig:   exitData.txSig ?? null,
    exitReason:  exitData.reason ?? null,
  });
  _atomicWrite(HISTORY_FILE, history.slice(0, 500));
  return pos;
}

function getAll() { return _load(); }
function get(mint) { return _load()[mint] ?? null; }
function count() { return Object.keys(_load()).length; }

// Total SOL locked in open NFT positions (for maxHeldSol).
function heldSol() {
  return Object.values(_load()).reduce((s, p) => s + (Number(p.solSpent) || 0), 0);
}

// Gross SOL spent on NFT buys since UTC midnight (open + closed-today), for dailyBuyLimitSol.
function dailySpentSol() {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  let sum = 0;
  for (const p of Object.values(_load())) if ((p.buyTs ?? 0) >= t0) sum += Number(p.solSpent) || 0;
  for (const h of _loadJson(HISTORY_FILE, [])) if ((h.buyTs ?? 0) >= t0) sum += Number(h.solSpent) || 0;
  return sum;
}

function getHistory(limit = 50) { return _loadJson(HISTORY_FILE, []).slice(0, limit); }

module.exports = { openNft, closeNft, getAll, get, count, heldSol, dailySpentSol, getHistory };
