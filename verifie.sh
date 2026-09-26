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
lance tg_cmd  "" node tg_commandes.test.js
lance perp    "$SRV" node ai_perp.test.js
lance journal "$SRV" node perp_journal.test.js
[ $VITE -eq 1 ] || lance releve "$SRV" node perp_releve.test.js   # mille melanges par decoupage : ~1 min
lance quotajeune "$SRV" node quota_jeune.test.js
lance scanpub   "$SRV" node scan_public.test.js
lance secuws  "$SRV" node securite_ws.test.js   # un vrai serveur, deux comptes, les gestes d argent
lance osint   "$SRV" node osint.test.js
lance noyau   "$SRV" node osint_noyau.test.js   # le noyau : faits, connecteurs, planificateur, regles
lance identite "$SRV" node osint_identite.test.js   # un nom rend des candidats SEPARES, jamais fusionnes ; ASN, CVE
lance tgcanal "$SRV" node tg_canal.test.js   # un canal Telegram public comme source d'adresses (extraction, dedup, cache)
lance osinttel "$SRV" node osint_tel.test.js   # le plan de numerotation FR : type + region, deterministes, sans cle
lance osintrte "$SRV" node osint_route.test.js   # un vrai serveur : la route publique du releve
lance osintv2 "$SRV" node osint_v2.test.js   # un vrai serveur : la route v2, exports, historique
lance studio  "$SRV" node studio.test.js   # le paiement : double depense, fausse confirmation
lance studiochat "$SRV" node studio_chat.test.js   # SWOGE AI Chat : jamais sous le cout, tout rendu si le fournisseur echoue, bout en bout
lance economie "$SRV" node economie.test.js   # la carte $SWOGE ECONOMY : offre, brule, coffre lus sur la chaine
lance marches "$SRV" node perp_marches.test.js   # decouverte multi-exchange, forme unique
lance perpws  "$SRV" node perp_ws.test.js   # le vrai WS Hyperliquid : live ou ignore, jamais simule
lance predict "$SITE" node predict_moteur.test.js   # indicateurs, martingale, risque, backtest
lance predsrv "$SRV" node predict_serveur.test.js   # le releve papier PARTAGE : round, win/raté, banque, persistance
lance pancake "$SRV" node predict_pancake.test.js   # etage 1 PancakeSwap : côte parimutuel, porte EV, résolution — papier
lance pancakereel "$SRV" node predict_pancake_reel.test.js   # etage 2 PancakeSwap : vrais BNB sur fausse chaine — cle, verrous, martingale, stop
lance miroir  "$SRV" node miroir.test.js
lance reel    "$SRV" node miroir_reel.test.js
[ $VITE -eq 1 ] || lance page "$SITE" node ai_colonie.test.js
[ $VITE -eq 1 ] || lance perppage "$SITE" node perp_page.test.js
lance scanpage "$SITE" node scan_page.test.js
lance osintpage "$SITE" node osint_page.test.js
lance studiopage "$SITE" node studio_page.test.js
lance chatpage "$SITE" node chat_page.test.js   # SWOGE AI Chat : jeton et jamais adresse, texte echappe, 320 px
lance ecopage "$SITE" node economie_page.test.js   # la carte $SWOGE ECONOMY et le whitepaper suivent /economie.json
lance predictpage "$SITE" node predict_page.test.js
# Elle criait dans le vide : 30 echecs sur 617, jamais lus, parce qu elle
# n etait pas dans cette boucle — exactement la panne de miroir_reel.test.js.
lance reference "$SITE" node referencement.test.js
lance marqueur "$SITE" node cache_marqueur.test.js
lance minifie "$SITE" node minifie.test.js
echo "  $(( $(date +%s) - T0 )) s au total · $([ $RATE -eq 0 ] && echo 'TOUT VERT : on peut commettre' || echo 'ROUGE : on ne commet pas')"
exit $RATE
