#!/bin/bash
# Les cinq suites, dans l ordre impose (la colonie SEULE d abord), un verdict par
# ligne, code de sortie vert seulement si tout passe. Journaux dans _logs/.
#   ./verifie.sh            les cinq (~25 min)
#   ./verifie.sh --vite     sans la colonie ni la page (~1 min) : pour un changement
#                           qui ne touche que le miroir ou le marqueur
set -uo pipefail
SRV="$(cd "$(dirname "$0")" && pwd)"; SITE=/home/user/SWOGE.github.io
PW="${PW_DIR:-$HOME/.swoge-pw}"
export NODE_PATH="${NODE_PATH:-$PW/node_modules:$SRV/node_modules}"
mkdir -p "$SRV/_logs"; VITE=0; [ "${1:-}" = "--vite" ] && VITE=1
RATE=0; T0=$(date +%s)
lance() {  # nom · dossier · commande…
  local nom=$1 dossier=$2; shift 2; local log="$SRV/_logs/$nom.log"; local t=$(date +%s)
  (cd "$dossier" && "$@" > "$log" 2>&1); local code=$?
  local fin; fin=$(grep -E "verifications OK|tout passe|^RATES" "$log" | tail -1)
  printf '  %-8s %-6s %4ss  %s\n' "$nom" "$([ $code -eq 0 ] && echo vert || echo ROUGE)" "$(( $(date +%s) - t ))" "${fin:-$(tail -1 "$log")}"
  [ $code -eq 0 ] || { RATE=1; grep -m3 "  RATE \|EXCEPTION\|Error" "$log" | sed 's/^/           /'; }
}
[ $VITE -eq 1 ] || lance colonie "$SRV" node ai_colonie_serveur.test.js
lance etalonnage "$SRV" node etalonnage_boot.test.js
lance tv_vues "$SRV" node tv_vues.test.js
lance x_post  "$SRV" node x_post.test.js
lance x_veille "$SRV" node x_reponse.test.js
lance tg_cmd  "" node tg_commandes.test.js
lance perp    "$SRV" node ai_perp.test.js
lance miroir  "$SRV" node miroir.test.js
lance reel    "$SRV" node miroir_reel.test.js
[ $VITE -eq 1 ] || lance page "$SITE" node ai_colonie.test.js
[ $VITE -eq 1 ] || lance perppage "$SITE" node perp_page.test.js
lance marqueur "$SITE" node cache_marqueur.test.js
lance minifie "$SITE" node minifie.test.js
echo "  $(( $(date +%s) - T0 )) s au total · $([ $RATE -eq 0 ] && echo 'TOUT VERT : on peut commettre' || echo 'ROUGE : on ne commet pas')"
exit $RATE
