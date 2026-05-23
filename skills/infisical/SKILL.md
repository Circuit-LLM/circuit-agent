# Skill: Secrets Management

> **Optional upgrade.** The standard `.env` file is sufficient for most single-agent deployments and is what the setup wizard configures. This skill covers Infisical — a centralized secrets manager useful for teams, multi-agent swarms, or production environments where rotating credentials or shared secrets management is needed. You do not need this to run circuit-agent.

How to manage secrets for circuit-agent. The `.env` file is the primary mechanism for most deployments. Infisical is an optional upgrade for teams, multi-agent setups, or production environments that need centralized secret management.

## Standard setup — .env file

circuit-agent loads secrets from `.env` at startup. This is sufficient for most single-agent deployments.

```bash
# .env (never commit this file — it's in .gitignore)
AGENT_KEYPAIR=your_base58_private_key
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-v1-...
TELEGRAM_BOT_TOKEN=1234567890:AAH...
JUPITER_API_KEY=optional
CIRCUIT_INTERNAL_KEY=only_if_self_hosting
```

Re-run the setup wizard at any time: `node agent.js setup`

---

## Infisical — advanced, server-side setup

Infisical uses **machine identities** for headless/server authentication — not the interactive `infisical login` browser flow. You need:

1. A project in [infisical.com](https://infisical.com)
2. A Machine Identity created in your project (Project Settings → Machine Identities)
3. The Machine Identity's `Client ID` and `Client Secret`
4. Your `Project ID` (visible in project settings URL)

### Install infisical CLI

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' | sudo bash
sudo apt install infisical
```

### Create the credentials config

Store credentials in a protected file (never commit this):

```bash
cat > ~/.circuit-agent/infisical-config.env << 'EOF'
INFISICAL_CLIENT_ID=your_machine_identity_client_id
INFISICAL_CLIENT_SECRET=your_machine_identity_client_secret
INFISICAL_PROJECT_ID=your_project_id
INFISICAL_ENVIRONMENT=prod
INFISICAL_TOKEN=
EOF
chmod 600 ~/.circuit-agent/infisical-config.env
```

### Generate an access token

```bash
source ~/.circuit-agent/infisical-config.env
INFISICAL_TOKEN=$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_CLIENT_ID" \
  --client-secret="$INFISICAL_CLIENT_SECRET" \
  --plain --silent)
```

Then save that token back into `infisical-config.env`.

### Fetch a secret (headless)

```bash
#!/bin/bash
source ~/.circuit-agent/infisical-config.env

infisical secrets get "$1" \
  --env="$INFISICAL_ENVIRONMENT" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --token="$INFISICAL_TOKEN" \
  --plain 2>/dev/null
```

### Run agent with all secrets injected

```bash
source ~/.circuit-agent/infisical-config.env
infisical run \
  --env="$INFISICAL_ENVIRONMENT" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --token="$INFISICAL_TOKEN" \
  -- node agent.js start
```

---

## Security rules

- **NEVER log or print `AGENT_KEYPAIR`** — leaking it = losing all wallet funds
- `infisical-config.env` should be `chmod 600` — readable only by owner
- Never write secrets to files that get committed to git (`.env` and `infisical-config.env` are in `.gitignore`)
- Tokens expire — regenerate if you get auth errors

## Which to use?

| Scenario | Recommendation |
|----------|----------------|
| Single agent on a VPS | `.env` file — simple and sufficient |
| Multiple agents sharing secrets | Infisical machine identity |
| Team with rotating credentials | Infisical with short-lived tokens |
| CI/CD pipeline deployment | Infisical machine identity tokens |
