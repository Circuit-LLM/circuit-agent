// lib/tools/trading.js — trade execution tool definitions and handlers
// Tools: check_wallet, buy_token, sell_token, send_token, pause_trading, resume_trading
'use strict';

const { loadIdentity } = require('../profile');
const { acquireSellLock, releaseSellLock, acquireBuyLock, releaseBuyLock } = require('../trade-lock');

// Fire-and-forget swarm signal publish. Errors never block a trade.
async function _publishSwarmSignal(api, type, opts = {}) {
  const { agentId, address } = loadIdentity();
  if (!agentId && !address) return;
  await api.swarmPublish({
    agentId,
    address,
    type,
    mint:       opts.mint       ?? undefined,
    symbol:     opts.symbol     ?? undefined,
    confidence: opts.confidence ?? 0.7,
    data:       opts.data       ?? {},
  });
}

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'check_wallet',
      description: 'Check your agent wallet: SOL balance, CIRCUIT balance, and all open trading positions with current P&L.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_token',
      description: 'Buy a Solana token using SOL via Jupiter Ultra. Execute autonomously based on your analysis — no user confirmation needed. Returns transaction signature on success.',
      parameters: {
        type: 'object',
        properties: {
          mint:      { type: 'string', description: 'Token mint address to buy' },
          solAmount: { type: 'number', description: 'Amount of SOL to spend (e.g. 0.01)' },
        },
        required: ['mint', 'solAmount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sell_token',
      description: 'Sell a held token position back to SOL via Jupiter Ultra. Execute autonomously based on your analysis — no user confirmation needed. Returns transaction signature on success.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address to sell' },
          pct:  { type: 'number', description: 'Fraction to sell: 1.0 = 100%, 0.5 = 50% (default 1.0)' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_token',
      description: 'Send SPL or Token-2022 tokens directly from your wallet to another Solana address. Use this to transfer CIRCUIT or any other held token to swarm agents or other wallets. The destination associated token account is created automatically if needed (costs ~0.002 SOL in rent). Returns transaction signature on success.',
      parameters: {
        type: 'object',
        properties: {
          mint:      { type: 'string', description: 'Token mint address (e.g. CIRCUIT mint)' },
          toAddress: { type: 'string', description: 'Destination Solana wallet address (base58)' },
          amount:    { type: 'number', description: 'Amount to send in token UI units (e.g. 1000 for 1000 CIRCUIT)' },
        },
        required: ['mint', 'toAddress', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_trading',
      description: 'Pause the auto-scanner from making new buys. The position monitor keeps running — existing positions are still watched and exits still fire. Use when the user wants to stop new entries temporarily or when market conditions are too risky.',
      parameters: {
        type: 'object',
        properties: {
          reason:  { type: 'string', description: 'Why you are pausing (e.g. "bear market", "user request", "high volatility")' },
          minutes: { type: 'number', description: 'Auto-resume after this many minutes. Omit to pause until manually resumed.' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_trading',
      description: 'Resume the auto-scanner after a pause. Call this when the user wants to re-enable new buy entries.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const HANDLERS = {
  async check_wallet(_args, ctx, _log) {
    const { wallet, positions } = ctx;
    const [balances, held] = await Promise.all([
      wallet.getBalances(),
      Promise.resolve(positions.getAll()),
    ]);
    const positionList = Object.values(held).map(p => ({
      symbol:     p.symbol,
      mint:       p.mint,
      solSpent:   p.solSpent,
      peakPnlPct: p.peakPnlPct,
      heldMins:   Math.round(positions.holdMinutes(p)),
      entryTime:  p.entryTime,
    }));
    return JSON.stringify({
      sol:           balances.sol,
      circuit:         balances.circuit,
      address:       balances.address,
      openPositions: positionList.length,
      positions:     positionList,
    });
  },

  async buy_token(args, ctx, log) {
    const { mint, solAmount } = args;
    const { api, swap, positions, wallet } = ctx;
    if (!mint || !solAmount) return JSON.stringify({ error: 'mint and solAmount required' });

    // One buy per processor round
    if (ctx._buyExecutedThisRound) {
      log('warn', 'buy_token blocked — already executed a buy this round');
      return JSON.stringify({ error: 'One buy per conversation round. A buy was already executed this session turn. Review the position and decide in the next message.' });
    }

    log('info', `Tool: buy_token ${mint.slice(0, 8)} ${solAmount} SOL`);

    // SOL balance + survival floor — mirrors the guard in auto-scanner.js.
    // Prevents wallet drain if the LLM is asked to buy multiple tokens in sequence.
    const minSolPause = ctx.cfg?.survival?.minSolPause ?? 0.01;
    let solBalance = 0;
    try {
      solBalance = await wallet.getSolBalance();
    } catch (err) {
      return JSON.stringify({ error: `Cannot verify SOL balance before buying: ${err.message}` });
    }
    if (solBalance - solAmount < minSolPause) {
      return JSON.stringify({
        error: `Insufficient SOL. Balance: ${solBalance.toFixed(4)} SOL, needed: ${solAmount} + ${minSolPause} reserve. Top up or reduce buy size.`,
      });
    }

    // Hard blacklist gate — enforced regardless of LLM reasoning
    try {
      const bl = await api.blacklistCheck(mint);
      if (bl?.blacklisted) {
        log('warn', `buy_token blocked — mint on swarm blacklist`, { mint: mint.slice(0, 8), votes: bl.votes });
        return JSON.stringify({ error: `Buy blocked: ${mint.slice(0, 8)} is on the swarm blacklist (${bl.votes ?? '?'} votes). Do not buy this token.` });
      }
    } catch { /* blacklist unavailable — proceed; scanner pre-filters */ }

    // Block concurrent buy if the scanner is already buying this mint
    if (!acquireBuyLock(mint)) {
      return JSON.stringify({ error: 'Buy already in progress for this mint — scanner is executing a buy. Retry in a few seconds.' });
    }

    let result;
    try {
      result = await swap.buy(mint, solAmount);
    } finally {
      releaseBuyLock(mint);
    }

    // Get decimals from RPC — but use Jupiter's outAmount for tokenAmount.
    // RPC balance often returns 0 right after buy (account not yet indexed).
    let tokenDecimals = 6;
    try {
      const bal = await swap.getTokenBalance(mint);
      if (bal.decimals > 0) tokenDecimals = bal.decimals;
    } catch (_) {}

    positions.openPosition(mint, {
      symbol:        args.symbol ?? mint.slice(0, 6),
      entryPrice:    result.pricePerToken ?? 0,
      solSpent:      result.inAmount,
      tokenAmount:   result.outAmount,
      tokenDecimals,
      txSig:         result.txSig,
    });

    _publishSwarmSignal(api, 'buy_signal', {
      mint, symbol: args.symbol,
      confidence: 0.75,
      data: { entryBudgetSol: result.inAmount, txSig: result.txSig },
    }).catch(() => {});

    // Count against the session buy cap so maxBuysThisSession is enforced globally,
    // regardless of whether the buy came from the scanner or an LLM tool call.
    try { require('../agent-loop').incrementSessionBuy(); } catch { /* non-fatal */ }
    ctx._buyExecutedThisRound = true;
    return JSON.stringify({
      success:   true,
      txSig:     result.txSig,
      solSpent:  result.inAmount,
      tokensOut: result.outAmount,
      mint,
    });
  },

  async sell_token(args, ctx, log) {
    const { mint, pct = 1.0, reason = 'manual' } = args;
    const { api, swap, positions } = ctx;
    if (!mint) return JSON.stringify({ error: 'mint required' });
    log('info', `Tool: sell_token ${mint.slice(0, 8)} ${(pct * 100).toFixed(0)}%`);

    const pos = positions.get(mint);
    if (!pos) return JSON.stringify({ error: 'No open position for this mint' });

    // Block concurrent sell if the monitor is already selling this mint
    if (!acquireSellLock(mint)) {
      return JSON.stringify({ error: 'Sell already in progress for this mint — monitor is executing a sell. The position will be closed shortly; check status in a few seconds.' });
    }

    let result, rawBalance;
    try {
      const bal = await swap.getTokenBalance(mint);
      if (!bal.rawAmount || bal.rawAmount === BigInt(0)) {
        releaseSellLock(mint);
        return JSON.stringify({ error: 'Token balance is zero or unavailable — position may already be closed or RPC is lagging. Check status before retrying.' });
      }
      rawBalance = Number(bal.rawAmount);
      result = await swap.sell(mint, rawBalance, pct);
    } catch (err) {
      releaseSellLock(mint);
      throw err;
    }

    let pnlPct = null;
    if (pct >= 1.0) {
      const pnlSol = (result.solReceived ?? 0) - pos.solSpent;
      pnlPct       = (pnlSol / pos.solSpent) * 100;
      positions.closePosition(mint, {
        solReceived: result.solReceived,
        pnlSol,
        pnlPct,
        reason,
        txSig: result.txSig,
      });

      _publishSwarmSignal(api, 'sell_signal', {
        mint, symbol: pos.symbol,
        confidence: 0.9,
        data: { pnlPct: +pnlPct.toFixed(2), pnlSol: +(((result.solReceived ?? 0) - pos.solSpent)).toFixed(5), reason, txSig: result.txSig },
      }).catch(() => {});
    } else {
      // Partial sell — update stored tokenAmount so the monitor uses the correct
      // remaining balance for P&L and stop/TP calculations going forward.
      const soldRaw   = Math.floor(rawBalance * pct);
      const remaining = rawBalance - soldRaw;
      positions.updateTokenAmount(mint, remaining);
    }

    releaseSellLock(mint);
    return JSON.stringify({
      success:     true,
      txSig:       result.txSig,
      solReceived: result.solReceived,
      mint,
      soldPct:     pct,
      pnlPct,
    });
  },

  async send_token(args, ctx, log) {
    const { mint, toAddress, amount } = args;
    const { wallet } = ctx;

    if (!mint || !toAddress || amount == null) {
      return JSON.stringify({ error: 'mint, toAddress, and amount are required' });
    }
    if (amount <= 0) return JSON.stringify({ error: 'amount must be greater than zero' });

    const { PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
    const {
      TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
      createTransferCheckedInstruction, getAccount, getMint,
    } = require('@solana/spl-token');

    // Validate destination address
    let toPubkey;
    try { toPubkey = new PublicKey(toAddress); }
    catch { return JSON.stringify({ error: `Invalid destination address: ${toAddress}` }); }

    if (toAddress === wallet.address) {
      return JSON.stringify({ error: 'Cannot send tokens to yourself' });
    }

    let mintPubkey;
    try { mintPubkey = new PublicKey(mint); }
    catch { return JSON.stringify({ error: `Invalid mint address: ${mint}` }); }

    const conn = wallet.connection;

    // Detect which token program owns this mint (try Token-2022 first, then standard)
    let tokenProgramId;
    let mintInfo;
    try {
      mintInfo = await getMint(conn, mintPubkey, 'confirmed', TOKEN_2022_PROGRAM_ID);
      tokenProgramId = TOKEN_2022_PROGRAM_ID;
    } catch {
      try {
        mintInfo = await getMint(conn, mintPubkey, 'confirmed', TOKEN_PROGRAM_ID);
        tokenProgramId = TOKEN_PROGRAM_ID;
      } catch (e) {
        return JSON.stringify({ error: `Cannot fetch mint info: ${e.message}` });
      }
    }

    const decimals  = mintInfo.decimals;
    const rawAmount = BigInt(Math.round(amount * (10 ** decimals)));

    const sourceAta = getAssociatedTokenAddressSync(mintPubkey, wallet.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const destAta   = getAssociatedTokenAddressSync(mintPubkey, toPubkey,         false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    const tx = new Transaction();

    // Create destination ATA if it doesn't exist yet
    try {
      await getAccount(conn, destAta, 'confirmed', tokenProgramId);
    } catch {
      log('info', `send_token: creating destination ATA for ${toAddress.slice(0, 8)}…`);
      tx.add(createAssociatedTokenAccountInstruction(
        wallet.publicKey,   // payer
        destAta,
        toPubkey,
        mintPubkey,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
    }

    tx.add(createTransferCheckedInstruction(
      sourceAta,
      mintPubkey,
      destAta,
      wallet.publicKey,
      rawAmount,
      decimals,
      [],
      tokenProgramId,
    ));

    log('info', `Tool: send_token ${amount} → ${toAddress.slice(0, 8)}…`, { mint: mint.slice(0, 8) });

    let txSig;
    try {
      txSig = await sendAndConfirmTransaction(conn, tx, [wallet.keypair], { commitment: 'confirmed' });
    } catch (e) {
      return JSON.stringify({ error: `Transaction failed: ${e.message}` });
    }

    return JSON.stringify({ success: true, txSig, mint, toAddress, amount });
  },

  async pause_trading(args, _ctx, _log) {
    const { pauseTrading } = require('../pause');
    const state = pauseTrading(args.reason ?? 'agent request', args.minutes ?? null);
    const msg = args.minutes
      ? `Trading paused for ${args.minutes} minutes (auto-resumes at ${new Date(state.until).toUTCString()}). Monitor still running — existing positions are watched.`
      : `Trading paused (${args.reason}). Call resume_trading to re-enable new buys. Monitor still running.`;
    return JSON.stringify({ paused: true, ...state, message: msg });
  },

  async resume_trading(_args, _ctx, _log) {
    const { resumeTrading, pauseStatus } = require('../pause');
    const was = pauseStatus();
    resumeTrading();
    return JSON.stringify({ paused: false, message: was.paused ? 'Trading resumed — auto-scanner will buy on next scan cycle.' : 'Trading was not paused.' });
  },
};

module.exports = { DEFINITIONS, HANDLERS };
