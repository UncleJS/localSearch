#!/usr/bin/env bash
# =============================================================================
#  localSearch — one-shot installer
#  Tested on: Linux (AMD Radeon 780M / RDNA3 iGPU with ROCm KFD)
# =============================================================================
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

log()  { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
die()  { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

echo -e "\n${BOLD}localSearch Installer${RESET}"
echo "============================================"

# ── 1. OS check ───────────────────────────────────────────────────────────────
[[ "$(uname)" == "Linux" ]] || die "This installer is for Linux only."
log "OS: Linux"

# ── 2. Check Bun ──────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
log "Bun $(bun --version)"

# ── 3. Install Ollama ─────────────────────────────────────────────────────────
if ! command -v ollama &>/dev/null; then
  info "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
  log "Ollama installed"
else
  log "Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown version')"
fi

# ── 4. AMD 780M ROCm workaround ───────────────────────────────────────────────
# The Radeon 780M (HawkPoint / gfx1103) requires an HSA version override so
# Ollama's ROCm build recognizes and uses the GPU.
PROFILE_FILE="/etc/profile.d/ollama-amd.sh"
HSA_OVERRIDE="HSA_OVERRIDE_GFX_VERSION=11.0.0"

if [[ -f /dev/kfd ]]; then
  info "AMD KFD device found — applying ROCm RDNA3 override..."

  # System-wide (requires sudo)
  if sudo -n true 2>/dev/null; then
    echo "export ${HSA_OVERRIDE}" | sudo tee "${PROFILE_FILE}" > /dev/null
    log "Written ${PROFILE_FILE}"
  else
    warn "No passwordless sudo — writing to ~/.bashrc instead"
  fi

  # User session (always write to ensure it's active now)
  if ! grep -q "HSA_OVERRIDE_GFX_VERSION" "$HOME/.bashrc" 2>/dev/null; then
    echo "" >> "$HOME/.bashrc"
    echo "# localSearch — AMD 780M ROCm override" >> "$HOME/.bashrc"
    echo "export ${HSA_OVERRIDE}" >> "$HOME/.bashrc"
  fi

  export HSA_OVERRIDE_GFX_VERSION=11.0.0
  log "HSA_OVERRIDE_GFX_VERSION=11.0.0 set (current shell + ~/.bashrc)"
else
  warn "No AMD KFD device found — Ollama will use CPU inference"
fi

# ── 5. Start Ollama service ───────────────────────────────────────────────────
info "Starting Ollama service..."

# Try systemd user service first
if systemctl --user is-active ollama &>/dev/null 2>&1; then
  log "Ollama user service already running"
elif systemctl --user list-unit-files ollama.service &>/dev/null 2>&1; then
  systemctl --user start ollama
  log "Ollama user service started"
else
  # Start as background process
  if ! pgrep -x ollama &>/dev/null; then
    HSA_OVERRIDE_GFX_VERSION=11.0.0 ollama serve &>/tmp/ollama.log &
    disown
    log "Ollama started in background (log: /tmp/ollama.log)"
  else
    log "Ollama process already running"
  fi
fi

# Wait for Ollama API to be ready
info "Waiting for Ollama API..."
for i in {1..30}; do
  if curl -sf http://localhost:11434/api/tags &>/dev/null; then
    log "Ollama API ready"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    die "Ollama API did not become ready in 30s. Check: ollama serve"
  fi
done

# ── 6. Pull models ────────────────────────────────────────────────────────────
bash "$(dirname "$0")/scripts/ollama-setup.sh"

# ── 7. Install dependencies ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
info "Installing Node/Bun dependencies..."
bun install --cwd "${SCRIPT_DIR}"
log "Dependencies installed"

# ── 8. Create default config ──────────────────────────────────────────────────
CONFIG_DIR="$HOME/.config/localsearch"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" << 'EOF'
{
  "defaultPath": "~/Documents",
  "dbPath": "~/.config/localsearch/localsearch.db",
  "ollamaUrl": "http://localhost:11434",
  "embeddingModel": "nomic-embed-text",
  "chatModel": "llama3.2:3b",
  "chunkSize": 512,
  "chunkOverlap": 64,
  "topK": 5,
  "apiPort": 5003,
  "webPort": 5002
}
EOF
  log "Created default config at $CONFIG_FILE"
else
  log "Config already exists at $CONFIG_FILE"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installation complete!${RESET}"
echo ""
echo "  Next steps:"
echo ""
echo -e "  ${CYAN}1. Index your documents:${RESET}"
echo "     bun run cli index ~/Documents"
echo ""
echo -e "  ${CYAN}2. Start the API server (terminal 1):${RESET}"
echo "     bun run api"
echo ""
echo -e "  ${CYAN}3. Start the web UI (terminal 2):${RESET}"
echo "     bun run web"
echo ""
echo -e "  ${CYAN}4. Open in browser:${RESET}"
echo "     http://localhost:5002"
echo ""
echo -e "  ${CYAN}5. Or query from CLI:${RESET}"
echo "     bun run cli query \"What are my documents about?\""
echo ""
echo -e "  ${CYAN}API docs:${RESET}  http://localhost:5003/swagger"
echo ""
