// lib/telegram.js — Telegram channel client for circuit-agent
// Writes incoming messages to queue/incoming/, polls queue/outgoing/ for responses.
// Uses grammY (lightweight Telegram bot framework).
//
// Only responds to private chats (not groups) for security.
// Ownership: first /start claim locks the bot to that chat ID.
// Commands: /reset, /wallet, /status, /scan, /pause, /resume, /reflect, /help
'use strict';

const fs   = require('fs');
const path = require('path');

const { enqueue, QUEUE_OUTGOING } = require('./processor');
const { pauseTrading, resumeTrading, pauseStatus } = require('./pause');

const LOG_FILE   = path.join(__dirname, '../logs/telegram.log');
const OWNER_FILE = path.join(__dirname, '../data/telegram_owner.json');

// ── Owner persistence ─────────────────────────────────────────────────────────

function _loadOwner() {
  try {
    if (!fs.existsSync(OWNER_FILE)) return null;
    return JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')).chatId ?? null;
  } catch { return null; }
}

function _saveOwner(chatId) {
  fs.mkdirSync(path.dirname(OWNER_FILE), { recursive: true });
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ chatId, claimedAt: new Date().toISOString() }));
}

let _ownerChatId = _loadOwner();

function log(level, msg, data = {}) {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  const out  = `[${ts}] [TG] [${level.toUpperCase()}] ${line}\n`;
  process.stdout.write(out);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, out);
  } catch { /* ignore */ }
}

// ── Poll outgoing queue for responses addressed to telegram ──────────────────

function pollResponses(bot) {
  try {
    const files = fs.readdirSync(QUEUE_OUTGOING).filter(f => f.startsWith('telegram_') && f.endsWith('.json'));
    for (const file of files) {
      const fpath = path.join(QUEUE_OUTGOING, file);
      try {
        const data = JSON.parse(fs.readFileSync(fpath, 'utf8'));

        if (!data.senderId) {
          fs.unlinkSync(fpath);
          log('warn', 'Response missing senderId', { file });
          continue;
        }

        // Delete AFTER successful send — on Markdown failure, retry as plain text
        const _consume = () => { try { fs.unlinkSync(fpath); } catch { /* already gone */ } };
        bot.api.sendMessage(data.senderId, data.message, { parse_mode: 'Markdown' })
          .then(_consume)
          .catch(err => {
            if (err.description?.includes('parse') || err.description?.includes("can't parse")) {
              bot.api.sendMessage(data.senderId, data.message).then(_consume).catch(_consume);
            } else {
              _consume();
            }
            log('warn', `Send failed: ${err.message}`);
          });

        log('info', `Response queued to ${data.sender} (${data.senderId.toString().slice(0, 6)}…)`);
      } catch (err) {
        log('warn', `Response file error: ${err.message}`, { file });
      }
    }
  } catch (err) {
    log('warn', `Poll error: ${err.message}`);
  }
}

// ── Start Telegram bot ────────────────────────────────────────────────────────

function start(token, agentCtx) {
  if (!token) {
    log('warn', 'No Telegram bot token — Telegram channel disabled');
    return;
  }

  const { Bot } = require('grammy');
  const bot = new Bot(token);
  const { positions, wallet } = agentCtx;

  // ── Commands ───────────────────────────────────────────────────────────────

  bot.command('start', ctx => {
    if (ctx.chat?.type !== 'private') return;
    const chatId = String(ctx.from?.id);

    // First /start claims ownership
    if (!_ownerChatId) {
      _ownerChatId = chatId;
      _saveOwner(chatId);
      log('info', `Owner claimed by ${ctx.from?.username ?? chatId}`);
      ctx.reply(
        '*circuit\\-agent online*\n\nYou are now the owner of this agent\\. Only you can send commands\\.\n\n' +
        '*What I do automatically:*\n' +
        '• Scan for dip\\-reversal opportunities every 5 min\n' +
        '• Monitor open positions every 30s \\(stop\\-loss / take\\-profit / trailing\\-stop\\)\n' +
        '• Reflect on performance every 4h and tune my own config\n\n' +
        '*Commands:*\n' +
        '/wallet — SOL \\+ CIRCUIT balances\n' +
        '/status — open positions\n' +
        '/scan — run a market scan now\n' +
        '/pause \\[minutes\\] — pause new buys\n' +
        '/resume — re\\-enable buying\n' +
        '/reflect — run a reflect cycle now\n' +
        '/reset — clear conversation\n' +
        '/help — this message\n\n' +
        'Or just send any message\\.',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    if (chatId !== _ownerChatId) {
      ctx.reply('This agent already has an owner.');
      log('warn', `Unauthorized /start from ${ctx.from?.username ?? chatId}`);
      return;
    }

    // Owner re-starting — show help
    ctx.reply(
      '*circuit\\-agent online*\n\n' +
      '*Commands:*\n' +
      '/wallet — SOL \\+ CIRCUIT balances\n' +
      '/status — open positions\n' +
      '/scan — run a market scan now\n' +
      '/pause \\[minutes\\] — pause new buys\n' +
      '/resume — re\\-enable buying\n' +
      '/reflect — run a reflect cycle now\n' +
      '/reset — clear conversation\n' +
      '/help — this message\n\n' +
      'Or just send any message\\.',
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── Owner gate helper ──────────────────────────────────────────────────────
  const isOwner = ctx => {
    if (ctx.chat?.type !== 'private') return false;
    if (!_ownerChatId) return false;
    return String(ctx.from?.id) === _ownerChatId;
  };

  bot.command('help', ctx => {
    if (!isOwner(ctx)) return;
    ctx.reply(
      '*circuit\\-agent commands*\n\n' +
      '/wallet — check SOL \\+ CIRCUIT balances\n' +
      '/status — show open positions \\+ P\\&L\n' +
      '/scan — run a market scan\n' +
      '/pause \\[minutes\\] — pause new buys \\(monitor keeps running\\)\n' +
      '/resume — re\\-enable new buys\n' +
      '/reflect — trigger a reflect cycle now\n' +
      '/reset — clear conversation history\n' +
      '/help — this message\n\n' +
      'Or just send a message in plain text\\.',
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.command('reset', ctx => {
    if (!isOwner(ctx)) return;
    const resetFlag = path.join(__dirname, '../data/reset_flag');
    try { fs.writeFileSync(resetFlag, '1'); } catch { /* ignore */ }
    ctx.reply('Conversation cleared. Fresh start.');
    log('info', `Reset requested by ${ctx.from?.username ?? ctx.from?.id}`);
  });

  bot.command('wallet', async ctx => {
    if (!isOwner(ctx)) return;
    try {
      const b = await wallet.getBalances();
      const msg = `*Wallet*\n\`${b.address.slice(0,8)}…${b.address.slice(-6)}\`\n\nSOL: \`${b.sol.toFixed(4)}\`\nCIRCUIT: \`${b.circuit.toLocaleString()}\``;
      ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`Wallet error: ${err.message}`);
    }
  });

  bot.command('status', async ctx => {
    if (!isOwner(ctx)) return;
    try {
      const held = positions.getAll();
      const keys = Object.keys(held);
      if (!keys.length) return ctx.reply('No open positions.');
      const lines = Object.values(held).map(p => {
        const mins = Math.round(positions.holdMinutes(p));
        return `*${p.symbol}* — held ${mins}min, peak P&L +${p.peakPnlPct.toFixed(1)}%`;
      });
      ctx.reply(`*Open positions (${keys.length})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`Status error: ${err.message}`);
    }
  });

  bot.command('scan', async ctx => {
    if (!isOwner(ctx)) return;
    // Queue a scan message — the processor will call scan_tokens and respond
    const sender   = ctx.from?.first_name ?? ctx.from?.username ?? String(ctx.from?.id);
    const senderId = String(ctx.from?.id);
    enqueue('telegram', sender, senderId, 'Run a market scan and tell me the top opportunities right now.', `scan_${Date.now()}`);
    ctx.reply('Scanning markets…');
  });

  bot.command('pause', ctx => {
    if (!isOwner(ctx)) return;
    const arg = ctx.message?.text?.split(' ')[1];
    const minutes = arg && /^\d+$/.test(arg) ? parseInt(arg, 10) : null;
    const state = pauseTrading('user command', minutes);
    const until = state.until
      ? `Auto-resumes in ${minutes} min.`
      : 'Use /resume to re\\-enable\\.';
    ctx.reply(
      `*Trading paused* — no new buys\\.\n${until}\nMonitor still running — existing positions are watched\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    log('info', `Trading paused by user${minutes ? ` for ${minutes}min` : ''}`);
  });

  bot.command('resume', ctx => {
    if (!isOwner(ctx)) return;
    const was = pauseStatus();
    resumeTrading();
    ctx.reply(was.paused
      ? 'Trading resumed — auto\\-scanner will buy on the next scan cycle\\.'
      : 'Trading was not paused\\.',
      { parse_mode: 'MarkdownV2' }
    );
    log('info', 'Trading resumed by user');
  });

  bot.command('reflect', ctx => {
    if (!isOwner(ctx)) return;
    const sender   = ctx.from?.first_name ?? ctx.from?.username ?? String(ctx.from?.id);
    const senderId = String(ctx.from?.id);
    // Load the reflect prompt and queue it through the LLM
    let prompt = 'You are reviewing your own performance. Run the full reflect cycle: check wallet, review trades, read swarm intel, save a note, update config if warranted, share an insight.';
    try {
      const reflectFile = path.join(__dirname, '../config/reflect.md');
      if (fs.existsSync(reflectFile)) prompt = fs.readFileSync(reflectFile, 'utf8').trim() || prompt;
    } catch { /* use default */ }
    enqueue('reflect', sender, senderId, prompt, `reflect_cmd_${Date.now()}`);
    ctx.reply('Reflect cycle started — I\'ll report back when done\\. Usually takes 1\\-2 min\\.', { parse_mode: 'MarkdownV2' });
    log('info', `Manual reflect triggered by ${sender}`);
  });

  // ── Text messages ──────────────────────────────────────────────────────────

  bot.on('message:text', ctx => {
    if (!isOwner(ctx)) return;

    const text     = ctx.message?.text?.trim();
    if (!text || text.startsWith('/')) return; // commands handled above

    const sender   = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ')
                  || ctx.from?.username
                  || String(ctx.from?.id);
    const senderId = String(ctx.from?.id);

    log('info', `Message from ${sender}: ${text.slice(0, 60)}`);

    // Enqueue for processor
    const msgId = `telegram_${ctx.message.message_id}_${Date.now()}`;
    enqueue('telegram', sender, senderId, text, msgId);
  });

  // ── Error handler ──────────────────────────────────────────────────────────

  bot.catch(err => {
    log('error', `Bot error: ${err.message}`);
  });

  // ── Start bot + poll outgoing queue ───────────────────────────────────────

  bot.start({
    onStart: info => {
      log('info', `Telegram bot started: @${info.username}`);
      if (_ownerChatId) {
        log('info', `Owner set — locked to chat ID ${_ownerChatId.slice(0, 4)}…`);
      } else {
        log('warn', 'No owner set — send /start in Telegram to claim this agent');
      }
    },
  }).catch(err => log('error', `Bot start failed: ${err.message}`));

  // Poll outgoing queue every 500ms
  setInterval(() => pollResponses(bot), 500);

  log('info', 'Telegram client initialized');
  return bot;
}

module.exports = { start };
