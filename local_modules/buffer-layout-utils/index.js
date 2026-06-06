'use strict';

// Drop-in replacement for @solana/buffer-layout-utils 0.2.0
// Uses native Node.js BigInt (Node >= 18) instead of the bigint-buffer C native addon.
// Eliminates GHSA-3gc7-fjrx-p6mg from the dependency tree while maintaining
// full API compatibility with the original package.

const { blob, u8 } = require('@solana/buffer-layout');
const { PublicKey } = require('@solana/web3.js');
const BigNumber = require('bignumber.js');

// ── Native BigInt helpers ────────────────────────────────────────────────────

function toBigIntLE(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length === 0) return 0n;
  if (b.length === 8) return b.readBigUInt64LE(0);
  let result = 0n;
  for (let i = b.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(b[i]);
  return result;
}

function toBufferLE(val, length) {
  const buf = Buffer.alloc(length);
  if (length === 8) { buf.writeBigUInt64LE(BigInt.asUintN(64, val), 0); return buf; }
  let v = BigInt.asUintN(length * 8, val);
  for (let i = 0; i < length; i++) { buf[i] = Number(v & 0xFFn); v >>= 8n; }
  return buf;
}

function toBigIntBE(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length === 0) return 0n;
  if (b.length === 8) return b.readBigUInt64BE(0);
  let result = 0n;
  for (let i = 0; i < b.length; i++) result = (result << 8n) | BigInt(b[i]);
  return result;
}

function toBufferBE(val, length) {
  const buf = Buffer.alloc(length);
  if (length === 8) { buf.writeBigUInt64BE(BigInt.asUintN(64, val), 0); return buf; }
  let v = BigInt.asUintN(length * 8, val);
  for (let i = length - 1; i >= 0; i--) { buf[i] = Number(v & 0xFFn); v >>= 8n; }
  return buf;
}

// ── encodeDecode ─────────────────────────────────────────────────────────────

const encodeDecode = (layout) => ({
  decode: layout.decode.bind(layout),
  encode: layout.encode.bind(layout),
});

// ── bigInt / bigIntBE layout factories ───────────────────────────────────────

const bigInt = (length) => (property) => {
  const layout = blob(length, property);
  const { encode, decode } = encodeDecode(layout);
  layout.decode = (buffer, offset) => toBigIntLE(Buffer.from(decode(buffer, offset)));
  layout.encode = (val, buffer, offset) => encode(toBufferLE(val, length), buffer, offset);
  return layout;
};

const bigIntBE = (length) => (property) => {
  const layout = blob(length, property);
  const { encode, decode } = encodeDecode(layout);
  layout.decode = (buffer, offset) => toBigIntBE(Buffer.from(decode(buffer, offset)));
  layout.encode = (val, buffer, offset) => encode(toBufferBE(val, length), buffer, offset);
  return layout;
};

// ── bool layout ──────────────────────────────────────────────────────────────

const bool = (property) => {
  const layout = u8(property);
  const { encode, decode } = encodeDecode(layout);
  layout.decode = (buffer, offset) => !!decode(buffer, offset);
  layout.encode = (val, buffer, offset) => encode(Number(val), buffer, offset);
  return layout;
};

// ── publicKey layout ─────────────────────────────────────────────────────────

const publicKey = (property) => {
  const layout = blob(32, property);
  const { encode, decode } = encodeDecode(layout);
  layout.decode = (buffer, offset) => new PublicKey(decode(buffer, offset));
  layout.encode = (pk, buffer, offset) => encode(pk.toBuffer(), buffer, offset);
  return layout;
};

// ── decimal / WAD ─────────────────────────────────────────────────────────────

const WAD = new BigNumber('1e+18');

const decimal = (property) => {
  const layout = bigInt(16)(property);
  const { encode, decode } = encodeDecode(layout);
  layout.decode = (buffer, offset) => new BigNumber(decode(buffer, offset).toString()).div(WAD);
  layout.encode = (val, buffer, offset) => encode(BigInt(val.times(WAD).integerValue().toString()), buffer, offset);
  return layout;
};

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  encodeDecode,
  bigInt,
  bigIntBE,
  u64:    bigInt(8),
  u64be:  bigIntBE(8),
  u128:   bigInt(16),
  u128be: bigIntBE(16),
  u192:   bigInt(24),
  u192be: bigIntBE(24),
  u256:   bigInt(32),
  u256be: bigIntBE(32),
  bool,
  publicKey,
  WAD,
  decimal,
};
