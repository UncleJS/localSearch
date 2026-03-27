#!/usr/bin/env bash
# =============================================================================
#  Pull required Ollama models for localSearch
# =============================================================================
set -euo pipefail

GREEN="\033[32m"
CYAN="\033[36m"
RESET="\033[0m"

log()  { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }

EMBEDDING_MODEL="nomic-embed-text"
CHAT_MODEL="llama3.2:3b"

info "Pulling embedding model: ${EMBEDDING_MODEL}..."
ollama pull "${EMBEDDING_MODEL}"
log "Pulled ${EMBEDDING_MODEL}"

info "Pulling chat model: ${CHAT_MODEL}..."
ollama pull "${CHAT_MODEL}"
log "Pulled ${CHAT_MODEL}"

echo ""
echo "Models ready:"
ollama list
