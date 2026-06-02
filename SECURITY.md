# Security

circuit-agent holds a real Solana wallet and executes real trades. Security matters.

---

## Private Key Safety

**Your private key is in `.env` as `AGENT_KEYPAIR` (Base58 encoded).**

- `.env` is gitignored — it will never be committed to the repo
- Never paste your private key into Telegram, logs, or any issue report
- Never share your `.env` file
- The `read_file` tool explicitly blocks reading `.env` — even the LLM cannot see it
- The `run_script` tool strips `AGENT_KEYPAIR` from the child process environment — scripts cannot sign transactions

### Recommended: Use Infisical for Secret Management

[Infisical](https://infisical.com) is a secrets manager that lets you store and inject secrets (like `AGENT_KEYPAIR`) into your environment without ever having them sit in plaintext `.env` files on disk.

Instead of a static `.env` file, Infisical injects secrets at runtime:

```bash
infisical run -- node agent.js
```

Benefits for circuit-agent deployments:
- Secrets are encrypted at rest and in transit — your private key never lives in a plaintext file on your server
- Secrets are centrally managed — rotate your key once, all agents pick it up automatically
- Audit log — you can see exactly when and where your secrets were accessed
- Works with systemd: set `ExecStart=infisical run -- node agent.js` in your service unit

Infisical has a free tier that covers personal and small-team use. See their [quick-start docs](https://infisical.com/docs/getting-started/overview) to get set up.

If you believe your key has been exposed:
1. Stop the agent immediately: `systemctl --user stop circuit-agent`
2. Transfer all funds to a new wallet
3. Generate a new wallet: `node agent.js init`

---

## What Has Access to Your Wallet

| Component | Can sign transactions? |
|-----------|----------------------|
| `lib/swap.js` | Yes — direct Jupiter Ultra calls |
| `lib/wallet.js` | No — read-only balance queries |
| LLM (`buy_token` tool) | Yes — through `swap.buy()` |
| `run_script` tool | No — key is stripped from env |
| All other tools | No |

The LLM can call `buy_token` and `sell_token`, but:
- Only one buy is allowed per LLM tool-use loop (`_buyExecutedThisRound` flag)
- Confirmed rug mints are blocked at the tool layer (swarm blacklist check)
- `entryBudgetSol` caps how much SOL can be spent per trade

---

## Rug Protection

Before every auto-scanner buy:
1. RugCheck API is called — `DANGER` verdict blocks the buy
2. Swarm blacklist is checked — any vote blocks the buy
3. Swarm consensus is checked — rug_alert from peers blocks the buy

The LLM `buy_token` tool also enforces a blacklist check as a hard gate regardless of LLM reasoning.

---

## API Keys

Keys stored in `.env`:
- `CIRCUIT_RPC_URL` — Solana RPC (read access to chain data)
- `OPENROUTER_API_KEY` — LLM inference spend
- `TELEGRAM_BOT_TOKEN` — controls your bot
- `JUPITER_API_KEY` — optional, higher rate limits
- `CIRCUIT_INTERNAL_KEY` — self-hosters only

Keep these out of logs and issue reports.

---

## Telegram Bot Security

The bot only responds to `heartbeatChatId` (your user ID) by default. If you want to allow other users, set `allowedUserIds` in your config. Unknown users get no response.

---

## Reporting Vulnerabilities

If you find a security issue — especially anything involving wallet access, key exposure, or trade manipulation — please report it privately:

- **Telegram DM:** [@circuitdev](https://t.me/circuitdev)

Please do not open a public GitHub issue for security vulnerabilities. Give us a chance to patch before disclosure.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Your suggested fix (if any)

We aim to respond within 48 hours and will credit researchers who report valid issues.

---

## Disclaimer

circuit-agent trades real money. You are responsible for:
- Funding the wallet with an amount you can afford to lose
- Understanding the trading strategy and risk parameters
- Monitoring the agent's behavior, especially early in deployment
- Complying with local laws and regulations around automated trading

This software is provided as-is under the MIT license with no warranty. See `LICENSE`.
