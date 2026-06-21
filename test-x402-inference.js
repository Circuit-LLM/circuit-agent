// test-x402-inference.js — one-shot validation of the x402-paid inference loop.
//
// Loads a funded wallet (AGENT_KEYPAIR + CIRCUIT_RPC_URL env) and runs ONE real
// CIRC-paid chat completion through the inference gateway: 402 → pay CIRC → retry
// with X-Payment-Signature → completion. Prints the payment tx + the engine reply.
//
// REAL on-chain payment — use a wallet you control.  Run:
//   AGENT_KEYPAIR=<base58> CIRCUIT_RPC_URL=<rpc> node test-x402-inference.js
'use strict';

const { loadWallet }    = require('./lib/wallet');
const { CircuitClient } = require('./lib/circuit');

const RPC     = process.env.CIRCUIT_RPC_URL || 'https://api.mainnet-beta.solana.com';
const GATEWAY = process.env.GATEWAY_URL     || 'http://localhost:18970/v1';

(async () => {
  const wallet = loadWallet(RPC);
  const api = new CircuitClient({ wallet: { keypair: wallet.keypair, connection: wallet.connection } });
  console.log('wallet :', wallet.keypair.publicKey.toBase58());

  const circ        = await api._getCircuitBalance();
  const solLamports = await wallet.connection.getBalance(wallet.keypair.publicKey, 'confirmed');
  console.log(`balance: ${circ} CIRC | ${(solLamports / 1e9).toFixed(4)} SOL`);
  if (circ < 17)               { console.error('ABORT: need >= 17 CIRC for one inference call'); process.exit(1); }
  if (solLamports < 1_000_000) { console.error('ABORT: need some SOL for gas'); process.exit(1); }

  console.log('\n-- making ONE x402-paid inference call (pays 17 CIRC) --');
  const t0  = Date.now();
  const res = await api.chatCompletion(
    [{ role: 'user', content: 'In one short sentence, what is decentralized inference?' }],
    { baseUrl: GATEWAY, model: 'Qwen/Qwen2.5-32B-Instruct-AWQ', maxTokens: 28 },
  );

  console.log('\n=== RESULT ===');
  console.log('payment tx :', res.paymentTx);
  console.log('reply      :', JSON.stringify(res.content));
  console.log('usage      :', JSON.stringify(res.usage));
  console.log('elapsed    :', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('\nx402-paid inference loop VERIFIED — agent paid CIRC and got a completion.');
})().catch(e => { console.error('\nTEST FAILED:', e.message); process.exit(1); });
