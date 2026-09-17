#!/bin/bash
# Crochet de demarrage (Claude Code sur le web) : les dependances des essais.
# Idempotent. Sur une machine locale, il ne fait rien.
set -euo pipefail
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then exit 0; fi

SRV=/home/user/swoge-pusher-server.github.io
PW="$HOME/.swoge-pw"                     # Playwright + ws, hors des depots

# Les dependances du serveur (ethers, ws…), pour les essais du serveur ET de la page.
if [ -f "$SRV/package.json" ]; then (cd "$SRV" && npm install --no-audit --no-fund --loglevel=error); fi

# Playwright, une fois : les navigateurs sont deja dans PLAYWRIGHT_BROWSERS_PATH.
if [ ! -d "$PW/node_modules/playwright" ]; then
  mkdir -p "$PW" && cd "$PW"
  [ -f package.json ] || echo '{ "name": "swoge-pw", "private": true }' > package.json
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --loglevel=error playwright@1.56.1 ws@8
fi

# Ce que les suites de page attendent : voir CLAUDE.md.
echo "export NODE_PATH=\"$PW/node_modules:$SRV/node_modules\"" >> "$CLAUDE_ENV_FILE"
echo "[crochet] dependances pretes · NODE_PATH pose"
