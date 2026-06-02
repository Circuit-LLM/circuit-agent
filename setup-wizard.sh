#!/bin/bash
# circuit-agent setup wizard
# Usage:
#   ./setup-wizard.sh                              — interactive setup
#   ./setup-wizard.sh --keypair KEY --address ADDR — called by: node agent.js init

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
CFG_BASE="$SCRIPT_DIR/config/agent.json"
CFG_LOCAL="$SCRIPT_DIR/config/agent.local.json"

GREEN='\033[0;32m'
BRIGHT_GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# ── Parse flags ───────────────────────────────────────────────────────────────

KEYPAIR_ARG=""
ADDRESS_ARG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --keypair) KEYPAIR_ARG="$2"; shift 2 ;;
    --address) ADDRESS_ARG="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

_env_get() {
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d "'\""
}

_local_get() {
  # Read a dotted key from agent.local.json, e.g. "llm.model"
  python3 -c "
import json, sys
try:
  d = json.load(open('$CFG_LOCAL'))
  keys = '$1'.split('.')
  v = d
  for k in keys: v = v[k]
  print(v)
except: print('')
" 2>/dev/null
}

_base_get() {
  python3 -c "
import json, sys
try:
  d = json.load(open('$CFG_BASE'))
  keys = '$1'.split('.')
  v = d
  for k in keys: v = v[k]
  print(v)
except: print('')
" 2>/dev/null
}

_cfg_get() {
  # local overrides base
  local val
  val=$(_local_get "$1")
  [ -z "$val" ] && val=$(_base_get "$1")
  echo "$val"
}

step_header() {
  local step=$1 total=$2 title=$3
  echo ""
  echo -e "  ${CYAN}${title}${NC}  ${DIM}──────────────────────────────────────── ${step} of ${total}${NC}"
  echo ""
}

# ── Banner ────────────────────────────────────────────────────────────────────

echo ""
echo -e "  ${DIM}─────────────────────────────────────────────────────${NC}"
echo -e "  ${BRIGHT_GREEN} ██████╗██╗██████╗  ██████╗ ██╗   ██╗██╗████████╗${NC}"
echo -e "  ${BRIGHT_GREEN}██╔════╝██║██╔══██╗██╔════╝ ██║   ██║██║╚══██╔══╝${NC}"
echo -e "  ${BRIGHT_GREEN}██║     ██║██████╔╝██║      ██║   ██║██║   ██║   ${NC}"
echo -e "  ${BRIGHT_GREEN}██║     ██║██╔══██╗██║      ██║   ██║██║   ██║   ${NC}"
echo -e "  ${BRIGHT_GREEN}╚██████╗██║██║  ██║╚██████╔╝╚██████╔╝██║   ██║   ${NC}"
echo -e "  ${BRIGHT_GREEN} ╚═════╝╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝   ╚═╝  ${NC}"
echo ""
echo -e "  ${DIM}autonomous solana agent runtime  ·  agent setup${NC}"
echo -e "  ${DIM}─────────────────────────────────────────────────────${NC}"
echo ""

if [ -n "$ADDRESS_ARG" ]; then
  echo -e "  ${YELLOW}▸  new wallet address (save this!)${NC}"
  echo -e "  ${BRIGHT_GREEN}${ADDRESS_ARG}${NC}"
  echo ""
fi

# Warn if stdin is not a terminal (non-interactive — all prompts will use defaults)
if [ ! -t 0 ]; then
  echo -e "  ${YELLOW}⚠  Non-interactive mode detected — using defaults for all prompts.${NC}"
  echo -e "  ${DIM}  Re-run: node agent.js setup   to change settings.${NC}"
  echo ""
fi

# ── Step 1: Helius RPC URL ────────────────────────────────────────────────────

step_header 1 5 "HELIUS RPC URL"
echo -e "  ${DIM}Used for all Solana queries: wallet balance, token accounts, swap execution.${NC}"
echo -e "  ${DIM}A free Helius key gives you 50k credits/day — plenty for normal operation.${NC}"
echo -e "  ${DIM}Get one (takes 30 seconds):${NC} ${YELLOW}https://helius.dev${NC} ${DIM}→ sign up → copy RPC URL${NC}"
echo ""
EXISTING_RPC=$(_env_get "CIRCUIT_RPC_URL")
if [ -n "$EXISTING_RPC" ]; then
  echo -e "  ${DIM}current:${NC}  ${YELLOW}${EXISTING_RPC:0:55}…${NC}"
  read -rp "  New URL (Enter to keep): " CIRCUIT_RPC_URL
  CIRCUIT_RPC_URL="${CIRCUIT_RPC_URL:-$EXISTING_RPC}"
else
  read -rp "  Helius RPC URL (Enter to use public): " CIRCUIT_RPC_URL
fi
if [ -z "$CIRCUIT_RPC_URL" ]; then
  CIRCUIT_RPC_URL="https://api.mainnet-beta.solana.com"
  echo ""
  echo -e "  ${YELLOW}⚠  Using Solana public RPC${NC}"
  echo -e "  ${DIM}  This works but is heavily rate-limited — you may see:${NC}"
  echo -e "  ${DIM}  · Slow balance checks and price lookups${NC}"
  echo -e "  ${DIM}  · Failed swap transactions during high traffic${NC}"
  echo -e "  ${DIM}  · Missed position exits if RPC times out${NC}"
  echo -e "  ${DIM}  Add CIRCUIT_RPC_URL to .env later to upgrade.${NC}"
fi
echo -e "  ${GREEN}✓  RPC configured${NC}"

# ── Step 2: LLM provider ──────────────────────────────────────────────────────

step_header 2 5 "LLM PROVIDER"
echo -e "  ${DIM}The AI brain — used for Telegram chat, reflection, and exception handling.${NC}"
echo ""
echo -e "  ${GREEN}1${NC}  ${BOLD}OpenRouter${NC}  ${DIM}·  cloud, 100+ models, API key required${NC}"
echo -e "  ${GREEN}2${NC}  ${BOLD}Ollama${NC}      ${DIM}·  local model, no API cost, GPU recommended${NC}"
echo ""
EXISTING_PROVIDER=$(_cfg_get "llm.provider")
read -rp "  Choose [1-2]  (Enter = ${EXISTING_PROVIDER:-openrouter}): " PROVIDER_CHOICE

case "$PROVIDER_CHOICE" in
  2) LLM_PROVIDER="ollama" ;;
  1) LLM_PROVIDER="openrouter" ;;
  *) LLM_PROVIDER="${EXISTING_PROVIDER:-openrouter}" ;;
esac

OPENROUTER_KEY=""
OLLAMA_BASE_URL=""

if [ "$LLM_PROVIDER" = "openrouter" ]; then
  echo ""
  echo -e "  ${DIM}Get a free key at${NC} ${YELLOW}https://openrouter.ai/keys${NC}"
  EXISTING_OR=$(_env_get "OPENROUTER_API_KEY")
  if [ -n "$EXISTING_OR" ]; then
    echo -e "  ${DIM}current:${NC}  ${YELLOW}${EXISTING_OR:0:14}…${NC}"
    read -rp "  New key (Enter to keep): " OPENROUTER_KEY
    OPENROUTER_KEY="${OPENROUTER_KEY:-$EXISTING_OR}"
  else
    read -rp "  OpenRouter API key (sk-or-…): " OPENROUTER_KEY
  fi
  [ -z "$OPENROUTER_KEY" ] && echo -e "  ${YELLOW}⚠  No key set — LLM features disabled until added${NC}"
else
  echo ""
  echo -e "  ${DIM}Install a model first:${NC}  ollama pull qwen2.5:7b"
  EXISTING_OLLAMA_URL=$(_cfg_get "llm.baseUrl")
  read -rp "  Ollama URL (Enter = http://localhost:11434/v1): " OLLAMA_BASE_URL
  OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-${EXISTING_OLLAMA_URL:-http://localhost:11434/v1}}"
fi
echo -e "  ${GREEN}✓  Provider: ${BRIGHT_GREEN}${LLM_PROVIDER}${NC}"

# ── Step 3: AI model ──────────────────────────────────────────────────────────

step_header 3 5 "AI MODEL"

if [ "$LLM_PROVIDER" = "ollama" ]; then
  echo -e "  ${DIM}Model must be pulled first:${NC}  ollama pull <name>"
  echo ""
  echo -e "  ${GREEN}1${NC}  qwen2.5:7b    ${DIM}·  best tool use    ·  4.7 GB${NC}"
  echo -e "  ${GREEN}2${NC}  llama3.2:3b   ${DIM}·  fastest          ·  2 GB${NC}"
  echo -e "  ${GREEN}3${NC}  qwen2.5:14b   ${DIM}·  best quality     ·  9 GB${NC}"
  echo -e "  ${GREEN}4${NC}  llama3.1:8b   ${DIM}·  reliable         ·  4.7 GB${NC}"
  echo -e "  ${GREEN}5${NC}  Custom        ${DIM}·  enter any Ollama model name${NC}"
  echo ""
  read -rp "  Choose [1-5]  (Enter = 1): " MODEL_CHOICE
  case "$MODEL_CHOICE" in
    2) AGENT_MODEL="llama3.2:3b" ;;
    3) AGENT_MODEL="qwen2.5:14b" ;;
    4) AGENT_MODEL="llama3.1:8b" ;;
    5) read -rp "  Model name: " AGENT_MODEL ;;
    *) AGENT_MODEL="qwen2.5:7b" ;;
  esac
else
  echo -e "  ${DIM}Recommended models:${NC}"
  echo ""
  echo -e "  ${GREEN}1${NC}  anthropic/claude-sonnet-4-6   ${DIM}·  best reasoning + tool use${NC}"
  echo -e "  ${GREEN}2${NC}  x-ai/grok-4.1-fast            ${DIM}·  very fast, strong analysis${NC}"
  echo -e "  ${GREEN}3${NC}  google/gemini-2.0-flash       ${DIM}·  free tier, capable${NC}"
  echo -e "  ${GREEN}4${NC}  Custom                        ${DIM}·  enter any OpenRouter model ID${NC}"
  echo ""
  read -rp "  Choose [1-4]  (Enter = 1): " MODEL_CHOICE
  case "$MODEL_CHOICE" in
    2) AGENT_MODEL="x-ai/grok-4.1-fast" ;;
    3) AGENT_MODEL="google/gemini-2.0-flash" ;;
    4) read -rp "  Model ID: " AGENT_MODEL ;;
    *) AGENT_MODEL="anthropic/claude-sonnet-4-6" ;;
  esac
fi
echo -e "  ${GREEN}✓  Model: ${BRIGHT_GREEN}${AGENT_MODEL}${NC}"

# ── Step 4: Telegram bot token ────────────────────────────────────────────────

step_header 4 5 "TELEGRAM  (optional)"
echo -e "  ${DIM}Chat interface, trade alerts, and heartbeat messages.${NC}"
echo -e "  ${DIM}Create a bot:${NC}  Telegram → ${YELLOW}@BotFather${NC} → /newbot"
echo ""
EXISTING_TG=$(_env_get "TELEGRAM_BOT_TOKEN")
if [ -n "$EXISTING_TG" ]; then
  echo -e "  ${DIM}current:${NC}  ${YELLOW}${EXISTING_TG:0:12}…${NC}"
  read -rp "  New token (Enter to keep): " TG_TOKEN
  TG_TOKEN="${TG_TOKEN:-$EXISTING_TG}"
else
  read -rp "  Bot token (Enter to skip): " TG_TOKEN
fi

TG_CHAT_ID=""
if [ -n "$TG_TOKEN" ]; then
  echo ""
  echo -e "  ${DIM}Your Telegram user ID — used to receive heartbeat messages.${NC}"
  echo -e "  ${DIM}Get it:${NC}  Telegram → ${YELLOW}@userinfobot${NC} → /start"
  read -rp "  Your Telegram user ID (Enter to skip): " TG_CHAT_ID
  echo -e "  ${GREEN}✓  Telegram enabled${NC}"
else
  echo -e "  ${DIM}Skipped — add TELEGRAM_BOT_TOKEN to .env later to enable.${NC}"
fi

# ── Step 5: CIRCUIT Data API ────────────────────────────────────────────────────

step_header 5 5 "CIRCUIT DATA API"
echo -e "  ${DIM}Market data, rug checks, swarm intelligence, and token analysis.${NC}"
echo ""
echo -e "  ${GREEN}public${NC}       ${BOLD}https://api.circuitllm.xyz${NC}  ${DIM}·  requires CIRCUIT balance${NC}"
echo -e "  ${GREEN}self-hosted${NC}  http://localhost:18700  ${DIM}·  free if running circuit-data-api locally${NC}"
echo ""
EXISTING_BASE=$(_cfg_get "api.baseUrl")
echo -e "  ${DIM}current:${NC}  ${YELLOW}${EXISTING_BASE:-https://api.circuitllm.xyz}${NC}"
read -rp "  API base URL (Enter to keep): " API_BASE
API_BASE="${API_BASE:-${EXISTING_BASE:-https://api.circuitllm.xyz}}"

EXISTING_IK=$(_env_get "CIRCUIT_INTERNAL_KEY")
read -rp "  Internal key for self-hosted bypass (Enter to skip): " _IK_INPUT
if [[ -n "$_IK_INPUT" ]]; then
  if [[ "$_IK_INPUT" == pnk_* ]] || [[ "$_IK_INPUT" == MCow* ]]; then
    echo -e "  ${RED}✗  That looks like a node keypair (pnk_/MCow…), not an internal key.${NC}"
    echo -e "  ${DIM}  Find your key: circuit-data-api/.env → CIRCUIT_DATA_API_INTERNAL_KEY${NC}"
    echo -e "  ${DIM}  Keeping previous value.${NC}"
    CIRCUIT_INTERNAL_KEY="$EXISTING_IK"
  else
    CIRCUIT_INTERNAL_KEY="$_IK_INPUT"
  fi
else
  CIRCUIT_INTERNAL_KEY="$EXISTING_IK"
fi
echo -e "  ${GREEN}✓  API: ${BRIGHT_GREEN}${API_BASE}${NC}"

# ── Write .env ────────────────────────────────────────────────────────────────

echo ""
echo -e "  ${DIM}writing .env …${NC}"

KEYPAIR="${KEYPAIR_ARG:-$(_env_get "AGENT_KEYPAIR")}"
EXISTING_JUP=$(_env_get "JUPITER_API_KEY")

cat > "$ENV_FILE" << EOF
# circuit-agent environment — updated $(date -u +%Y-%m-%dT%H:%M:%SZ)
AGENT_KEYPAIR=${KEYPAIR}
CIRCUIT_RPC_URL=${CIRCUIT_RPC_URL}
OPENROUTER_API_KEY=${OPENROUTER_KEY}
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
CIRCUIT_INTERNAL_KEY=${CIRCUIT_INTERNAL_KEY}
JUPITER_API_KEY=${EXISTING_JUP}
EOF

echo -e "  ${GREEN}✓  .env written${NC}"

# ── Write config/agent.local.json ─────────────────────────────────────────────
# User settings go to agent.local.json — never touching the repo-tracked agent.json

node --input-type=module << JSEOF
import { readFileSync, writeFileSync, existsSync } from 'fs';

const localPath = '${CFG_LOCAL}';
let local = {};
try { if (existsSync(localPath)) local = JSON.parse(readFileSync(localPath, 'utf8')); } catch {}

// Merge in settings from this wizard run
local.llm = local.llm ?? {};
local.llm.model    = '${AGENT_MODEL}';
local.llm.provider = '${LLM_PROVIDER}';
if ('${OLLAMA_BASE_URL}') local.llm.baseUrl = '${OLLAMA_BASE_URL}';

local.telegram = local.telegram ?? {};
if ('${TG_CHAT_ID}') local.telegram.heartbeatChatId = '${TG_CHAT_ID}';

local.api = local.api ?? {};
local.api.baseUrl = '${API_BASE}';

writeFileSync(localPath, JSON.stringify(local, null, 2) + '\n');
console.log('  \x1b[32m✓\x1b[0m  config/agent.local.json updated');
JSEOF

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo ""
echo -e "  ${DIM}─────────────────────────────────────────────────${NC}"
echo -e "  ${BRIGHT_GREEN}✓  AGENT READY${NC}"
echo -e "  ${DIM}─────────────────────────────────────────────────${NC}"
echo ""

if [ -n "$ADDRESS_ARG" ]; then
  echo -e "  ${YELLOW}┌─  FUND YOUR AGENT WALLET  ─────────────────────────────────┐${NC}"
  echo -e "  ${YELLOW}│${NC}  ${BRIGHT_GREEN}${ADDRESS_ARG}${NC}"
  echo -e "  ${YELLOW}│${NC}"
  echo -e "  ${YELLOW}│${NC}  Send at least ${BOLD}0.05 SOL${NC} to this address before starting"
  echo -e "  ${YELLOW}│${NC}  (covers transaction fees + a few initial trades)"
  echo -e "  ${YELLOW}└────────────────────────────────────────────────────────────┘${NC}"
  echo ""
  echo -e "  ${DIM}⚠  Back up your private key:${NC}  grep AGENT_KEYPAIR .env"
  echo ""
fi

echo -e "  ${DIM}next steps${NC}"
echo -e "  ${CYAN}  1.${NC} Fund the wallet above with SOL"
echo -e "  ${CYAN}  2.${NC} ${BRIGHT_GREEN}node agent.js start${NC}  — launch the agent"
echo -e "  ${CYAN}  3.${NC} ${BRIGHT_GREEN}node agent.js setup${NC}  — change any settings later"
echo ""
echo -e "  ${DIM}optional${NC}"
echo -e "  ${DIM}  personality${NC}   cp soul.md soul.local.md"
echo -e "  ${DIM}  as service${NC}    systemctl --user enable --now circuit-agent"
echo ""
