// lib/trade-lock.js — shared in-flight guards for buy and sell operations
//
// Problem: monitor.js and tools/trading.js both run as async operations within
// the same Node.js process. setInterval does not await async callbacks, so a
// monitor sell tick can overlap with an LLM tool sell_token call, or a scanner
// buy can overlap with an LLM buy_token call. Both paths pass their respective
// guards (positions.get / positions.count) because the state hasn't changed yet.
//
// Shared Sets here act as a process-wide mutex for each mint.
'use strict';

const _sellInFlight = new Set(); // mints with an active sell in progress
const _buyInFlight  = new Set(); // mints with an active buy in progress

function acquireSellLock(mint) {
  if (_sellInFlight.has(mint)) return false;
  _sellInFlight.add(mint);
  return true;
}

function releaseSellLock(mint) {
  _sellInFlight.delete(mint);
}

function isSellInFlight(mint) {
  return _sellInFlight.has(mint);
}

function acquireBuyLock(mint) {
  if (_buyInFlight.has(mint)) return false;
  _buyInFlight.add(mint);
  return true;
}

function releaseBuyLock(mint) {
  _buyInFlight.delete(mint);
}

function isBuyInFlight(mint) {
  return _buyInFlight.has(mint);
}

module.exports = {
  acquireSellLock, releaseSellLock, isSellInFlight,
  acquireBuyLock,  releaseBuyLock,  isBuyInFlight,
};
