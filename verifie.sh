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
lance rejeu   "$SRV" node perp_rejeu.test.js   # la porte perp : sans chevauchement, frais reels, aucune fuite du futur, une marche aleatoire ne passe jamais
[ $VITE -eq 1 ] || lance releve "$SRV" node perp_releve.test.js   # mille melanges par decoupage : ~1 min
lance quotajeune "$SRV" node quota_jeune.test.js
lance scanpub   "$SRV" node scan_public.test.js
lance cartescan "$SRV" node carte_scan.test.js   # la carte du scan : chaque trait nomme en anglais, aucune cle brute ni libelle francais, aucun doublon, lines = la carte
lance secuws  "$SRV" node securite_ws.test.js   # un vrai serveur, deux comptes, les gestes d argent
lance osint   "$SRV" node osint.test.js
lance noyau   "$SRV" node osint_noyau.test.js   # le noyau : faits, connecteurs, planificateur, regles
lance identite "$SRV" node osint_identite.test.js   # un nom rend des candidats SEPARES, jamais fusionnes ; ASN, CVE
lance tgcanal "$SRV" node tg_canal.test.js   # canaux Telegram publics : Robinhood seulement, paires resolues, v4 sans fausse adresse, rejets retenus 6 h, liste a chaud
lance tgappel "$SRV" node tg_appels.test.js   # les appels Telegram : prix a la detection, frais seulement, aucun score sous 10, une requete pour 30
lance tgdecouv "$SRV" node tg_decouverte.test.js   # nouveaux canaux sur mesure : public, actif 48 h, >= 2 jetons Robinhood, max 10, retrait apres 7 jours
lance goplus  "$SRV" node goplus_mesure.test.js   # GoPlus : appels reseau vs cache, deux lectures simultanees = un appel, delai silence -> reponse
lance osinttel "$SRV" node osint_tel.test.js   # le plan de numerotation FR : type + region, deterministes, sans cle
lance osintrte "$SRV" node osint_route.test.js   # un vrai serveur : la route publique du releve
lance osintv2 "$SRV" node osint_v2.test.js   # un vrai serveur : la route v2, exports, historique
lance studio  "$SRV" node studio.test.js   # le paiement : double depense, fausse confirmation
lance studiochat "$SRV" node studio_chat.test.js   # SWOGE AI Chat : jamais sous le cout, tout rendu si le fournisseur echoue, bout en bout
lance courschaine "$SRV" node cours_chaine.test.js   # cours $SWOGE sur la chaine quand DexScreener se tait : piscine connue, clone refuse, pompe sans effet
lance compat  "$SRV" node studio_compat.test.js   # le chat ChatGPT et Grok : requete conforme, usage lu, cout exact xAI, 503 sans cle
lance jeton   "$SRV" node studio_jeton.test.js    # une adresse de jeton dans le chat : piscine la plus profonde, GoPlus tri-etat, colonie avec effectifs
lance pieces  "$SRV" node studio_pieces.test.js   # photo ou PDF joint : en-tetes lus, pire cas borne, PDF a Claude seul sur compte exact
lance histo   "$SRV" node studio_histo.test.js    # historique par portefeuille : chacun son fichier, la plus recente gagne, jamais un vide sur un illisible
lance agent   "$SRV" node studio_agent.test.js    # SwogeAgentic : boucle bornee, usage additionne, pire cas tenu, outils de lecture seulement
lance arret   "$SRV" node studio_arret.test.js    # arreter une reponse : place liberee tout de suite, reserve gardee, fournisseur coupe, rien facture avant le modele
lance agentic "$SRV" node agentic.test.js    # API des autres agents : cles (empreinte, plafond), devis, recu, MCP deux epoques
lance agenticrte "$SRV" node agentic_route.test.js   # de bout en bout : vrai serveur, vrai wallet, une cle ne gere pas les cles, debit exact au wei
lance x402    "$SRV" node x402.test.js    # payer sans compte : vraies signatures Permit2/EIP-2612, rejeu, montant exact, outil en panne → rien regle
lance x402rte "$SRV" node x402_route.test.js   # x402 de bout en bout : vrai serveur, faux noeud qui decode settle, la cle de gaz jamais montree
lance facil   "$SRV" node facilitateur_cdp.test.js   # le facilitateur CDP : jeton verifie par la cle publique, 401 text/plain, pending renvoye une fois, delai jamais rejoue, secret jamais dit
lance x402base "$SRV" node x402_base_route.test.js   # USDC sur Base de bout en bout : sonde au demarrage, Base d abord, x402 sur MCP (objet, base64, en-tete), en attente sans accepts, secret CDP jamais montre
lance solata "$SRV" node solana_ata.test.js   # le compte USDC associe d une adresse Solana (payTo), contre les vecteurs de web3.js : sans lui, pas de Solana dans le 402
lance verdict "$SRV" node verdict_jeton.test.js   # token_verdict : GoPlus en rouge ou prudence, piscine sous 13 000 $ (mesure du carnet), traits de la colonie a 30 obs et plus ; jamais « safe », inconnu = inconnu
lance portef "$SRV" node portefeuilles.test.js   # smart money mesuree : acheteurs d avant le regard credites a 30 min, une fois ; aucun verdict sous 10 jetons ; montees ET effondrements contre un acheteur au hasard
lance roast   "$SRV" node roast.test.js   # roast_token : les faits seuls, pas de scam sans drapeau, texte nettoye et borne, modele muet = gabarit vrai, carte PNG relue par son id
lance embauche "$SRV" node embauche.test.js   # l agent embauche un service x402 : catalogue seulement, pas d adresse privee ni de redirection, plafonds appel/joueur/jour, reserve avant, facture sur 200 seulement, vraie signature EIP-3009
lance achats "$SRV" node achats.test.js   # l eSIM : l agent propose, seul le joueur confirme ; prix reverifie, un double clic ne paie qu une fois, facture sur 200, code rendu au seul payeur
lance boutique "$SRV" node boutique_esim.test.js   # boutique eSIM sans compte : x402 depuis le portefeuille, eSIM achetee AVANT le reglement, prix qui monte refuse, code par lien secret seulement
lance fondsesim "$SRV" node fonds_esim.test.js   # fonds de la page eSIM : 3 images Kling faites une fois, jamais refaites, jamais sans Kling, une reponse qui n est pas une image jamais gardee
lance passerelle "$SRV" node passerelle.test.js   # passerelle de depense : un agent paie un service avec SA cle, permission du proprietaire, plafond par appel et par jour, Idempotency-Key, audit chaine
lance mcpextras "$SRV" node mcp_extras.test.js   # MCP : eSIM (gratuite, sans cle) et passerelle (cle + idempotency_key) listees ; la consigne nomme la seule exception a « rien n achete »
lance credits  "$SRV" node credits.test.js   # credit en dollars : credite apres le reglement seulement, une fois par transaction, a la session ; debit au cout reel, reste rendu ; reserve ouverte rendue au redemarrage
lance clescred "$SRV" node cles_credit.test.js   # cle swg_ au credit en dollars : payeur choisi par la session, debit et plafond en dollars, reponse sans $SWOGE, passerelle sur le credit, video refusee
lance store    "$SRV" node store_agents.test.js   # fiches de l Agent Store : agents exterieurs seulement, aucun taux sous 10 tentatives, permissions et paiements vrais, aucune note inventee
lance passeport "$SRV" node passeport.test.js   # passeport d une cle : signe Ed25519 par une cle dediee, verifiable avec la seule cle publique, un champ change casse la signature, prive par defaut
lance preuves  "$SRV" node preuves_x402.test.js   # paiements verifiables : agents exterieurs seulement, reseaux de production, payeur tronque, lien de la transaction
lance polycol  "$SRV" node poly_papier.test.js   # Polymarket AI papier : achat au prix demande en remontant le carnet, frais officiels lus sur le marche, TWAP 60 s, temoin Coin, Brier, aucun verdict sous 100
lance depv4   "$SRV" node deploiement_v4.test.js   # launchpad V4 et jumeau WETH : portefeuille dedie, parametres relus, une transaction jamais renvoyee, listage, deux envois de valeur seulement, cle jamais rendue
lance lancv4  "$SRV" node lancement_v4.test.js   # l agent PREPARE un lancement V4 : copies d actions, grands symboles, « SWOGE » et liens douteux refuses ; offert a la page seulement
lance acces   "$SRV" node acces.test.js   # portes privees fermees sans cle, gestes d argent en POST seulement ; /credit partage entre le robinet admin et le credit en dollars (29/09)
lance famille  "$SRV" node famille_client.test.js   # qui demande un prix : famille du client en code fixe, sonde ou demande, jamais le User-Agent brut ni l IP
lance sondes   "$SRV" node sonde_services.test.js   # catalogue x402 note sans payer : une sonde par service et par 20 h, raison de chaque echec, aucun verdict sous 3 sondes, paiements reels comptes
lance annonces "$SRV" node annonces.test.js   # un outil nouveau : un post Telegram (tweet + image haussiere), une fois, groupe 10 min, espace 3 h, sans promesse de prix ni partenariat
lance hasard  "$SRV" node hasard.test.js   # hasard prouvable : engagement avant tirage, un tirage par engagement, le code publie refait les memes nombres, sans biais (chi2), sabot du casino
lance baselanc "$SRV" node base_lancements.test.js   # lancements Base (Clanker, Zora) lus sur la chaine : echanges apres le bloc de lancement, 1 h / 24 h, bilan du deployeur contre tous, fenetre dite
lance actions  "$SRV" node actions_rh.test.js   # actions tokenisees : l officielle contre la copie (liste Robinhood), ecart piscine/Chainlink sans republier la valeur de l oracle
lance relx402  "$SRV" node releve_x402.test.js   # experience de prix : baisses contre temoins avant/apres, exterieur seul, jour mele exclu, rien sous 1 000 demandes
lance lecturesrh "$SRV" node lectures_rh.test.js   # robinhood_rpc/token/wallet/tx : lecture seule, bornes, le seau (la colonie d abord), decodage sur un faux noeud aux vrais encodages
lance chatx402 "$SRV" node chat_x402.test.js   # chat_completion : devis = pire cas (ASCII a 1/2, le reste a ses octets) x X402_CHAT_MARGE, modele brut, sortie OpenAI, un echec jamais regle
lance autoinsc "$SRV" node auto_inscription.test.js   # inscription PayAI automatique : notre serveur et notre tresorerie seulement, plafonds, une fois par outil, la cle ne sort jamais
lance compteurs "$SRV" node compteurs.test.js   # compteurs durables : un fichier par jour UTC, survivent au redemarrage et a SIGTERM, maison a part, jamais l IP
lance klingjev "$SRV" node kling_jev.test.js   # Kling (nouveau standard, cle API, grille officielle) et Jev (systemone, probabilites, cout) : rien ne part sans cle, jamais la cle dans une reponse
lance klingrte "$SRV" node kling_route.test.js   # essai Kling sur un vrai serveur : proprietaire seul, 403 avant Kling, journalise, aucun debit
lance klingtg "$SRV" node kling_telegram.test.js   # image Kling postee sur Telegram a heure fixe : une fois, jamais en retard, rien sur le canal si Kling echoue
lance observ  "$SRV" node observatoire.test.js   # Solana/Ethereum, observer seulement : decouverte unique, securite sans GoPlus, prix a 30 min par le meme service, disparus a part, rien que 4 services
lance sortie  "$SRV" node epreuve_sortie.test.js   # can_i_sell : verdict du Cobaye, facture seulement une reponse, 60 s de cache, 2 en vol, journal sans payeur
lance alerte  "$SRV" node alerte_usage.test.js   # alerte Telegram d un appel paye : scan_token par defaut, jamais les arguments, 12/h puis resume, notre wallet dit tel quel
lance fermes  "$SRV" node fermetures.test.js   # 27/09 : SWOGE FLIX servi vide et ferme a l ajout (manga/series intacts) ; staking ferme aux nouvelles mises, reclamer et sortir ouverts
lance cinesrv "$SRV" node cinema_serveur.test.js   # le mecanisme des salles derriere l interrupteur (SWOGE_FLIX=1 pose par l essai)
lance decouv  "$SRV" node decouverte.test.js   # se faire trouver : openapi.json, /.well-known/x402, preuve de propriete verifiee, fiche MCP au schema
lance caisse  "$SRV" node caisse.test.js    # la caisse : 5 % rachetent du $SWOGE, jamais partage deux fois, tout a la tresorerie, jamais l ETH
lance caisrte "$SRV" node x402_caisse_route.test.js   # mode caisse sur le vrai serveur : payTo = portefeuille de gaz, preuve signee par le serveur
lance studiomedia "$SRV" node studio_media.test.js   # Studio images/videos Grok Imagine : cout reel, tout rendu, proprietaire seul, bout en bout
lance comprend "$SRV" node studio_comprend.test.js   # image comprise : reference SWOGE, fil repris, reecriture facturee sous sa reserve
lance prod    "$SRV" node studio_production.test.js   # series et pubs : memes references dans le meme ordre a chaque scene, images a leur adresse seule
lance prodrte "$SRV" node studio_production_route.test.js   # series et pubs sur le vrai serveur : faux xAI, memes reference_images/audios, debit exact
lance imagine "$SRV" node studio_imagine.test.js   # bouton magique SwoleMind : images de reference et brouillon envoyes, cout compte, borne par jour, panne sans cout
lance derniere "$SRV" node derniere_image.test.js   # la derniere image d une video (ffmpeg) pour enchainer les scenes : la bonne image, fournisseurs seulement, null sans ffmpeg
lance essai   "$SRV" node essai_montage.test.js   # essai de montage xAI : longueur lue dans les boites MP4, clip efface apres fini/rate/delai, cout des ticks, plafond du jour
lance essairte "$SRV" node essai_montage_route.test.js   # essai de montage sur le vrai serveur : proprietaire seul, 403 avant le corps, faux xAI, aucun debit, cle jamais montree
lance reprises "$SRV" node reprises.test.js   # une reponse retrouvee apres rechargement : par adresse de session seulement
lance economie "$SRV" node economie.test.js   # la carte $SWOGE ECONOMY : offre, brule, coffre lus sur la chaine
lance marches "$SRV" node perp_marches.test.js   # decouverte multi-exchange, forme unique
lance perpws  "$SRV" node perp_ws.test.js   # le vrai WS Hyperliquid : live ou ignore, jamais simule
lance predict "$SITE" node predict_moteur.test.js   # indicateurs, martingale, risque, backtest
lance predsrv "$SRV" node predict_serveur.test.js   # le releve papier PARTAGE : round, win/raté, banque, persistance
lance pancake "$SRV" node predict_pancake.test.js   # etage 1 PancakeSwap : côte parimutuel, porte EV, résolution — papier
lance pancakereel "$SRV" node predict_pancake_reel.test.js   # etage 2 PancakeSwap : vrais BNB sur fausse chaine — cle, verrous, martingale, stop
lance pkjournal "$SRV" node predict_pancake_journal.test.js   # journal Pancake en ajout seul (decision / regle separes), remplissage borne lent reprenable, ombres : egalite perdue, annule rembourse, verdict a t >= 2,7
lance pkrejeu "$SRV" node predict_pancake_rejeu.test.js   # la porte Pancake ACTUELLE rejouee sur 30 004 rounds stockes : 0 pari (mode direct : 18 279, le rejeu n est pas vide)
lance miroir  "$SRV" node miroir.test.js
lance reel    "$SRV" node miroir_reel.test.js
[ $VITE -eq 1 ] || lance page "$SITE" node ai_colonie.test.js
[ $VITE -eq 1 ] || lance perppage "$SITE" node perp_page.test.js
lance scanpage "$SITE" node scan_page.test.js
lance osintpage "$SITE" node osint_page.test.js
lance studiopage "$SITE" node studio_page.test.js
lance chatpage "$SITE" node chat_page.test.js   # SWOGE AI Chat : jeton et jamais adresse, texte echappe, 320 px
lance prodpage "$SITE" node production_page.test.js   # SwoleMind series et pubs : jeton jamais adresse, photo reduite, echappe, 320 px
lance essaipage "$SITE" node essai_montage_page.test.js   # SwoleMind essai de montage : proprietaire seul, longueur refusee dans la page, jeton jamais adresse, 320 px
lance agentpage "$SITE" node agent_page.test.js   # SwogeAgentic : chaque geste visible, echappe, jeton jamais adresse, reprise par rid
lance agentqr  "$SITE" node agent_qr.test.js   # le QR de la carte eSIM = le generateur prouve du portefeuille (200 empreintes segno), jamais un faux QR
lance esimpage "$SITE" node esim_page.test.js   # boutique eSIM : chercher, payer Base (EIP-3009) ou Solana, lien secret, QR, ?order= retrouve, echappe, 320 px
lance storepage "$SITE" node agent_store.test.js   # Agent Store : usage mesure avec son effectif, aucun taux sous 10, mission preremplie, services x402 tels que sondes, https seulement, 360 px
lance polypage "$SITE" node polymarket_page.test.js   # Polymarket Edge Check : tri par date (jamais les gros gains d abord), pertes non encaissees reintegrees, aucun verdict sous 100, teneur de marche dit, texte seulement, 360 px
lance polyai   "$SITE" node polymarket_ai_page.test.js   # Polymarket AI : cinq agents avec effectif, temoin Coin marque, calibration sans gagnant sous 100, liens polymarket.com seulement, 360 px
lance lancepage "$SITE" node lance_v4.test.js   # carte de lancement : le portefeuille du joueur signe ; offres truquees refusees ; frais $SWOGE autorise au montant exact, frais ETH en valeur
lance passpage "$SITE" node agent_passport.test.js   # Agent Passport : champs en texte, signature verifiee dans le navigateur (ou par le serveur, dit), passeport modifie refuse, publier par la session
lance navliens "$SITE" node nav_liens.test.js   # aucun lien muet sur les pages qui eteignent leurs liens par defaut ; chaque entree du menu recoit un VRAI clic, 1280 et 390 px
lance x402page "$SITE" node x402_essai_page.test.js   # payer un appel en USDC sur Base depuis son portefeuille : offre Base du 402, EIP-3009 signe et verifie, resultat echappe, 320 px
lance x402sol "$SITE" node x402_solana.test.js   # la transaction Solana de la page : octet pour octet celle de web3.js (vecteurs figes), comptes USDC associes, memo aleatoire
lance ecopage "$SITE" node economie_page.test.js   # la carte $SWOGE ECONOMY et le whitepaper suivent /economie.json
lance predictpage "$SITE" node predict_page.test.js
# Elle criait dans le vide : 30 echecs sur 617, jamais lus, parce qu elle
# n etait pas dans cette boucle — exactement la panne de miroir_reel.test.js.
lance reference "$SITE" node referencement.test.js
lance marqueur "$SITE" node cache_marqueur.test.js
lance minifie "$SITE" node minifie.test.js
echo "  $(( $(date +%s) - T0 )) s au total · $([ $RATE -eq 0 ] && echo 'TOUT VERT : on peut commettre' || echo 'ROUGE : on ne commet pas')"
exit $RATE
