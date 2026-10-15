#!/bin/bash
# TOUTES les suites des deux depots, la colonie SEULE d abord, un verdict par
# ligne, code de sortie vert seulement si tout passe. Journaux dans _logs/<nom>.log.
# Le nombre de suites lancees et la duree totale s impriment a la fin : les
# ecrire ici les a rendus faux (cet en-tete disait « les cinq » et « ~1 min »
# quand la liste en comptait deja 223 — 12/10/2026).
#   ./verifie.sh            tout, colonie comprise (la colonie seule : ~20 min)
#   ./verifie.sh --vite     sans les sept suites lentes marquees `[ $VITE -eq 1 ] ||`
#                           (colonie, releve perp, page colonie, page perp, deux
#                           chaines reelles, page portefeuille)
#   SITE_DIR=/chemin/du/site ./verifie.sh   pour verifier une copie du site
#                           (git worktree) au lieu de /home/user/SWOGE.github.io
set -uo pipefail
SRV="$(cd "$(dirname "$0")" && pwd)"; SITE="${SITE_DIR:-/home/user/SWOGE.github.io}"
PW="${PW_DIR:-$HOME/.swoge-pw}"
export NODE_PATH="${NODE_PATH:-$PW/node_modules:$SRV/node_modules}"
mkdir -p "$SRV/_logs"; VITE=0; [ "${1:-}" = "--vite" ] && VITE=1
RATE=0; T0=$(date +%s); NB=0
lance() {  # nom · dossier · commande…
  local nom=$1 dossier=$2; shift 2; local log="$SRV/_logs/$nom.log"; local t=$(date +%s); NB=$((NB + 1))
  (cd "$dossier" && "$@" > "$log" 2>&1); local code=$?
  local fin; fin=$(grep -E "verifications OK|verifications passees|tout passe|^RATES" "$log" | tail -1)
  printf '  %-8s %-6s %4ss  %s\n' "$nom" "$([ $code -eq 0 ] && echo vert || echo ROUGE)" "$(( $(date +%s) - t ))" "${fin:-$(tail -1 "$log")}"
  [ $code -eq 0 ] || { RATE=1; grep -m3 "  RATE \|EXCEPTION\|Error" "$log" | sed 's/^/           /'; }
}
# Les suites du monde ecrivent leur etat : chacune recoit un DATA_DIR neuf.
# Mesure du 12/10/2026 : sans lui, boutique, classement_monde, marche, perso,
# potions, rachat, skins et xp ecrivaient dans ./data du depot (journaux de
# joueurs fictifs). Celles qui posent deja le leur l ecrasent, rien ne change.
lance_monde() {  # nom · fichier
  local d; d=$(mktemp -d /tmp/verifie-monde-XXXXXX) || { RATE=1; return; }
  lance "$1" "$SRV" env DATA_DIR="$d" node "$2"
  # Rien a garder : le journal est dans _logs/. Sans cette ligne chaque passage
  # laissait 58 dossiers d etat fictif (234 dans /tmp le 12/10 au soir).
  case "$d" in /tmp/verifie-monde-?*) rm -rf -- "$d" ;; esac
}
[ $VITE -eq 1 ] || lance colonie "$SRV" node ai_colonie_serveur.test.js
lance etalonnage "$SRV" node etalonnage_boot.test.js
lance tv_vues "$SRV" node tv_vues.test.js
lance x_post  "$SRV" node x_post.test.js
lance tg_cmd  "" node tg_commandes.test.js
lance tglance  "$SRV" node tg_lance.test.js   # /launch sur Telegram : un lien a signer (jamais une signature), les refus de l agent, annonce SEULEMENT apres relecture du recu sur la chaine, une fois
lance notif   "$SRV" node notif.test.js   # annonces de gains des tables, vrai serveur : benefice et non retour brut, seuil ; depuis le 11/10 les gains $SWOGEBET de TOUS les jeux tokenises s annoncent en « $SWOGEBET » (Crash synchronise sur les manches), $SWOGE inchange, coffre $SWOGE intact ; Buy Bonus du Volcano compte sur son COUT (une perte ne parle plus) ; maison du module communaute (COMPTES_MAISON, deployeur V4) ; route /communaute/image (chemin brut ../ refuse) et ligne ETEINT
lance communaute "$SRV" node communaute.test.js   # new holder / believer / paper hand + releve (11/10, relu le 12/10) : vide = 0 requete 0 minuterie 0 fichier ; beneficiaire et non signataire, piscines trouvees (token0/token1, jamais sans verdict), brule hors offre, maison/contrats/poussiere/liquidite muets, 7702 = personne ; liquidite et sens lus dans les RECUS (jamais le PoolManager v4 entier), conversions $SWOGEBET/launchpad muettes ; construction ratee sans trace, 503 reessaye ; livre recoupe avec balanceOf (ecart = rien ne part, persistant = reconstruction) ; reprise sans doublon ; 10/25/25 $, 24 h par adresse et par famille, 4/h + 1 groupe, retard 30 min muet ; « new »/« left » = marche seulement ; releve 13:00 Paris une fois, chiffres calcules ; images une fois, essais bornes, texte seul ; suite du 12/10 : sac avant/apres, gain/perte en ETH contre le prix d achat moyen (Sync de la paire depuis la frappe, jamais sans les deux jambes), partielles 25 $ et 10 % du sac famille a part, fresh wallet (signe, nonce <= 2, jamais vu), relies par envoi direct (degre <= 5, groupe de 5), resume 24 h / 7 jours, cours 7 jours ETH et $ (v3 WETH/USDG), migration d un etat ancien sans rien re-dire ; verifications du 12/10 : migration bornee au curseur, 30 min au plus (l ecart du redeploiement annonce), liens >= 1 000 $SWOGE (poussiere et 0 jeton hors du groupe, comptes au degre), achat garde en partie au prorata, vente melee illisible, frais du vendeur comptes, releve <= 1 024 signes a l envoi, 7 jours en portefeuilles, % du cours arrondi ; 13/10 : ligne d entree des paper hands (achat ou envoyeur seul, achat d origine et la part qu il couvre a un saut, deux sauts pour un sac entier, maison reverifiee a l annonce, heure UTC de l en-tete a la minute et a moins de 2 h, lecture courte, rien d invente, schema 3 reconstruit)
lance smartcal "$SRV" node smart_calcul.test.js   # smart money (13/10, revue du 14/10) : GAIN et SCORE sur des journaux REELS de NILF et BRODIE, FRAIS lus dans les recus (crochet, routeur ; attendus calcules en Python a part), signes v2/v3/v4, beneficiaire, marques aux deux bords (groupe, paire repetee, co-entree, relais, renvoi, finance), taux de base sans le wallet ni les marques, aucun verdict sous 10 issues connues, alertes, createur, Verified / Not verified
lance smartrpc "$SRV" node smart_rpc.test.js   # smart money : tranches ADAPTATIVES (coupe en deux au refus, au plafond de lignes, a une reponse de plus de 16 Mio et au delai depasse), cache gzip immuable sous la pointe sure (cellules, en-tetes, recus), 403/429/non-JSON -> 15 s, 60 s, abandon puis pause partagee, une requete en vol pour tous les clients, plafond du jour, l URL du noeud jamais dans un message, lecture seule
lance smartdb  "$SRV" node smart_base.test.js   # smart money : sql.js, montants exacts en TEXT, sauvegarde atomique, migrations, base illisible mise de cote
lance smartmod "$SRV" node smart_money.test.js   # smart money de bout en bout : eteint = rien ; passe sur un monde fige (roles retrouves, frais du crochet lus, initie jamais smart) ; veille : alertes au proprietaire seul, sans doublon, lanceur automatique sans alerte ; naissance v2 hors fenetre, jeton sous 1 M$ hors score, URL secrete jamais servie, veille ratee visible ; budget, lecture par acheteur, rapport ; routes du vrai serveur
lance smartsig "$SRV" node smart_signaux.test.js   # le brief du proprietaire (15/10) : les 18 wallets et leurs roles, adresses partielles par prefixe, chaque regle ACHETER/SURVEILLER/EVITER a ses bornes, FAIL CLOSED (une inconnue interdit ACHETER, un danger observe rend EVITER), bundle de la 1re minute, « bon dev », airdrop, le texte au format du brief avec et sans modele (un modele qui change le verdict n est pas cru)
lance smartana "$SRV" node smart_analyste.test.js   # l analyste dans la veille smart money : un lancement comme celui sonde le 15/10 (lanceur 0xa37e4343…), Sniper 1 achete -> ACHETER au proprietaire seul et a la colonie ; LP tenue par un wallet -> EVITER, rien ne part ; faits de marche absents -> SURVEILLER ; airdrop et bot seul -> aucun verdict ; observe -> garde, n envoie rien ; lecture seule
lance tgrepli "$SRV" node tg_repli.test.js   # telegram.js : notifyPhoto sans image, refusee ou injoignable -> la legende part en texte (les annonces de communaute en dependent)
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
lance navig   "$SRV" node navigateur.test.js   # le navigateur Browse : vrai Chromium, rien d interne, flux d images, gestes qui n attendent plus (02/10)
lance navsortie "$SRV" node navigateur_sortie.test.js   # la sortie par proxy amont (NAVIGATEUR_SORTIE, IP bresilienne) : HTTP et CONNECT confies au proxy avec auth, la garde anti-SSRF refuse le prive AVANT le proxy, direct sans la variable
lance navrel  "$SRV" node navigateur_relais.test.js   # le relais : le joueur de la SESSION, deux images en vol au plus, durees sans adresse
lance pilote  "$SRV" node navigateur_pilote.test.js   # le pilote (02/10) : budget d IA jamais depasse, Stop sans geste apres, rien tape que le joueur n a ecrit, la session seule
lance blackjack "$SRV" node blackjack.test.js   # les strategies de mise du mode blackjack : martingale, paroli, d alembert, plate ; plafond casse -> base, issues lues, serie
lance casino  "$SRV" node casino.test.js   # Three Card et Casino Hold'em : retours mesures sur 300 000 mains, commission maison
lance deuxcoffres "$SRV" node casino_deux_coffres.test.js   # casino a deux coffres (08/10) : une manche $SWOGEBET ne touche AUCUNE economie $SWOGE (net du jour, jackpot, revenu, volume, record) ; MEME jeton entree/sortie ; conservation du coffre des paris sur chaque jeu ; le Boulier reste $SWOGE-only
lance crash   "$SRV" node crash.test.js   # le moteur du Crash : point de rupture provably-fair, retour mesure
lance crashjeu "$SRV" node crash_game.test.js   # le Crash cable au solde : debit a la mise, credit au retrait (ou jamais), reconnexion, redemarrage
lance vaultbet "$SRV" node vault_swogebet.test.js   # les paris sportifs en $SWOGEBET uniquement : les deux coffres isoles, le ticket paye dans sa propre monnaie, signature dans le bon domaine
lance bilanparis "$SRV" node bilan_paris.test.js   # le bilan des paris : mises/rendus, le jeton de chaque ticket
# Les paris eux-memes n'etaient PAS dans cette boucle (08/10/2026) : cotes, reglement, import, scores
# gratuits — exactement la panne de miroir_reel. L'essai du direct de la page etait rouge depuis fin
# septembre (un mois ecrit en dur), et personne ne l'avait vu.
lance paris    "$SRV" node paris.test.js          # le pari se vend, se regle sur le score, se paie dans sa monnaie
lance pariferme "$SRV" node paris_fermeture.test.js   # UN critere « ouvert » : coup d envoi, rencontre fermee par l import (deplacee), commencee selon ESPN
lance pariauto "$SRV" node paris_auto.test.js     # le reglement automatique et ses verrous
lance parihors "$SRV" node paris_hors_calendrier.test.js   # une rencontre sortie du calendrier reste affichable et reglable
lance pariimp  "$SRV" node paris_import.test.js   # l import : credits, ODDS_API_FIN passee, rencontre deplacee fermee, foot de The Odds API a la main
lance espn     "$SRV" node scores_espn.test.js    # scores gratuits : jours/mois (plus de fenetre), 90 minutes, match le plus proche d une serie, refus comptes
lance cricket  "$SRV" node scores_espn_cricket.test.js   # le cricket par l en-tete ESPN (12/10) : jamais 8039, un jour par requete J-1..J+1, lettre sur id 1 « post » seul (un vainqueur, des runs des deux cotes, notre orientation), egalite/sans resultat/abandon a la main, forfait/« Final » vide/reporte = rien, format de la cle (l ODI de la meme tournee refuse) ; relecture du soir : la plus proche a MOINS DE 2 H et a 2 h de moins que la suivante (jumelle absente, point milieu), deux des notres jamais sur la meme rencontre ESPN, ESPN avant notre heure = la main, AUTO_DELAI_MIN depuis la premiere lecture (ODI a 490 min), une ligne de journal quand l issue change ; 502 = panne jamais liste vide (redemande une fois, budget 60 s), jamais « 0-0 »/N par releve, une requete a la fois espacees
lance tennisverrou "$SRV" node tennis_verrou.test.js   # le verrou d heure reelle du tennis (11/10) : tableaux atp/wta (simple du circuit seul, « pre » seulement sous STATUS_SCHEDULED sans score), appariement (ordre, accents, initiales, homonyme ambigu, autre jour), un refus = circuit en panne, PARIS_TENNIS_VERROU vide/observe = rien ne change, actif : vendu ferme sans appariement « pre » de moins de 150 s, ferme a in/post et a l heure ESPN - 60 s, recul sur tout 403/429 ESPN, carnet et portes T1/T2/T3, deux vrais serveurs (actif, vide)
lance cadence  "$SRV" node reglement_cadence.test.js   # reglement (lot 4) : ombre ESPN de 2 h qui ne regle rien et ne paie rien (observe), regle = 0 credit, jamais un mois, une seule releve a la fois, corrections (score, statut, retour, disparition, pas une panne), journal sur le volume, gain contrefactuel, journal en panne = memes reglements, --reglement sans reseau, carte Settlement
lance gardes   "$SRV" node reglement_gardes.test.js    # garde-fous du reglement (relecture du lot 4) : bornes des variables, cadence programmee, panne partielle et trou, fin de fenetre non vue, portes A et B sur journaux fabriques (couts indecidables, mur courant), deduction (delai, credit en vol, compteur remis a zero), coupe au format fini, recul sur les refus ESPN
lance prixmarche "$SRV" node prix_marche.test.js   # le prix du marche : reference Betfair/Pinnacle/mediane, AUCUNE issue gagnante au prix de reference, sans prix frais = suspendue, 1 credit/jour/championnat ecrit sur le volume
lance socle    "$SRV" node socle.test.js   # le socle de la cle 20K : drapeaux vides, sortie du chemin des prix IDENTIQUE octet pour octet a main d avant (essais/reference, refus compris) ; classes 0-3 et reserves 0/0/80/160 ; info d un appel ; delai 15 s, compte par prudence s il est payant ; compteur relu avant ecriture, credits en vol ; priorite aux seules cles vendues ; apresNote apres le carnet, chacun sa copie ; compte par classe (porte des reserves)
lance prixjournal "$SRV" node prix_journal.test.js   # journal des releves payees (lot 1) : 0 credit et rien de vendu ne bouge (journal actif contre coupe, octet pour octet), une ligne par releve avec sa cause (avant / demande separees), borne 3-60 j et purge horaire, jamais bloquant ; tic par causes = ancien appel groupe (memes appels, memes credits) ; mesure hors serveur = cotes du vrai chemin de vente, k le plus recent, porte 3 h/3 h, jours complets, regime c/av/am, G2 jamais non sans la puissance sous tau, G1 a la borne exacte, sans bascule ; route admin, index de cloture 7 j refait depuis le journal
lance clv      "$SRV" node clv.test.js   # CLV, collecte seule (lot 2) : la jambe garde le prix vendu (pv, tv), rien de vendu ne change (PARIS_CLV=0 contre collecte), rien chez le joueur, cloture figee au reglement depuis l index du journal sur la MEME source (orientation, retiree, deplacee, refChangee, sans mouvement, panne, vente a 5 min), le paiement ne depend jamais d elle, index illisible : rien de fige puis reprise, 40 rencontres distinctes, aucun verdict avant la porte 1 (controle exact 60 / 99 %, pas la moyenne de r), talent sur r contre la foule de sa categorie SANS lui, Bonferroni, route admin no-store, index illisible mis de cote (3 gardes), lecture refusee sans ecrasement
lance prixdeux "$SRV" node prix_deux_issues.test.js   # deux issues en OBSERVATION (lot 3) : reference Betfair/Pinnacle/mediane sur {1,2}, un livre a nul jamais la reference, sans sport (ou cricket) rien note ni paye a t comme a t+30 min, la cle observee coute 1 credit et reste a l Elo, jamais prioritaire, cadence 12 h jamais sous la vente, joker tennis_atp_*/tennis_wta_* seul et sans _winner, bascule simulee sans issue gagnante et porte paris.ouvert, 3-3 refuse au hockey, PARIS_ELO_ENGAGEMENT_MAX vide = rien ne change
lance prixobs  "$SRV" node prix_observe.test.js   # carnet d observation (lot 3) : moneyline DraftKings close seul, oriente sur homeAway, rien apres le coup d envoi, 15/70 et borne 13,4 % sur les 35 rencontres du 09/10, aucune conclusion sous 40, P3 sur l historique, P5 comparee a l Elo, tennis jamais basculable, carnet relu/purge/deux temps/illisible mis de cote/lecture refusee jamais gardee, 0 requete
lance plafondelo "$SRV" node plafond_elo.test.js   # le plafond des cotes Elo au prix du marche observe (11/10) : variable vide = catalogue identique octet pour octet ; posee : ne fait que BAISSER (min, jamais l autre issue remontee), tennis seul (EPL, NHL non listee, football observe intacts), aLElo/plafond d engagement/CLV inchanges ; inverse, sans prix, sans equipes, autre rencontre ou autre cle : rien, compte ; repli au rabot au-dela de 96 % ; page = vente (Game, puis un vrai serveur : parisListe puis parie ; la page ouverte recoit la liste repoussee quand le catalogue recharge change, jamais sans changement ni sur une socket qui ne l a pas demandee) ; appariement d un seul nom refuse ; pari pris fige ; jamais cumule, sur les deux chemins de l import ; l observation juge l Elo brut ; memes requetes avec et sans (fetch espionne) ; une erreur garde l Elo et la rencontre
lance soldebas "$SRV" node alerte_solde.test.js   # alerte de solde bas : classement documente des erreurs, Odds/Venice sur le solde lu, une par 24 h, JAMAIS le canal public
lance cotes    "$SRV" node cotes.test.js
lance cotesbuts "$SRV" node cotes_buts.test.js
lance cotesligue "$SRV" node cotes_ligue.test.js   # le total du championnat (paris_buts.json) : la grille rend le 1-N-2 vendu (au marche le total cede, a l Elo l ecart est dit), double chance sur le 1-N-2 vendu, PARIS_BUTS_LIGUE=0 remet l ancien, table de moins de 400 jours, rien de partiel ecrit
lance cotestot "$SRV" node cotes_totaux.test.js   # le total des totaux du marche dans la grille (lot 5) : totalDuMarche inverse de plusDeLigne (x,5 seulement), P(plus 2,5) du marche rendu, 1-N-2 vendu reproduit (RHO_DU_MARCHE, cede:false), aucun lot de scores au-dessus de son cout, sans total octet pour octet 29b6160, garde de coherence (au-dela d un point : le chemin d avant), l ombre compte a part, total de plus de 48 h ignore
lance totgarde "$SRV" node totaux_gardes.test.js  # les garde-fous du lot 5 que la mutation laissait passer : regle 48 h/12 h/30 credits, fenetre de cloture 20-75 min et 2 h, strates et raisons, delai note, retour arriere sur une rencontre conservee, reference VENDUE au journal, audit de DP_MAX (ombre des refusees, dp), fuite prouvee ou non (et la puissance), fermee ou sans p h2h ne relance rien, age 0 = rien servi, J0 par championnat, minuteries hors des tics des prix, portes 1 et 2 jugees
lance totaux   "$SRV" node totaux_marche.test.js  # totaux en OBSERVATION (lot 5) : drapeaux vides = 0 appel et 0 minuterie, reference Betfair/Pinnacle/mediane x,5 et garde 0,25 but, 1 credit markets=totals jamais spreads, regle 48 h/48 h/12 h, essais a 48 h seulement et plafonnes, plafond du mois, classes 3/1/2 jamais prioritaire, observation = catalogue identique octet pour octet, vente sans issue gagnante (ligne 2,5, 1-N-2 qui a bouge, perime : rien), cloture qui n ecrit jamais un total, mesure stratifiee qui refuse de conclure, lecture gardee
lance coupes   "$SRV" node coupes.test.js   # coupes (lot 6) : rien par defaut (reference figee du socle octet pour octet, listes par defaut sans coupe), inventaire 0 credit (/events seul, catalogue et carnet identiques, ESPN par releve : non appariees + noms du meme jour, sans drapeau, doublons, panne qui ne conclut rien), observation 48 h classe 3 jamais prioritaire, forcee T-45/T-20 classe 2 une fois par creneau, jamais au catalogue (conservee = suspendue), PARIS_COUPES ignoree, calibre saute les coupes, 90 minutes, suivi hors note() (jamais apres le coup d envoi, lecture refusee = rien ecrit), porte E/C/A/D seuil par seuil, derive sur le journal (memes jours, meme reference, DC coupee a 0,93)
lance coupgard "$SRV" node coupes_gardes.test.js   # les garde-fous du lot 6 que la mutation laissait passer : coupe non observee jamais payee, classe bornee 2|3, coupes apres les vendus, forcee par planifie().avantMatch (age minimal et classe), rencontre commencee, fenetre T-45/T-20 sur le plus tardif, appariement ESPN qui ne redescend pas et repart a zero sur une autre affiche, E/C/A construits, derive par rencontre (tranches, ko, reference vendue, par coupe), jokers de la production (/sports lu et en panne), --coupes a 0 credit, hygiene des fichiers, ordre des causes, fenetre de 1 h
lance enjeu    "$SRV" node paris_en_jeu.test.js   # direct en jeu, OBSERVATION (lot 7) : eteint par defaut (0 appel, 0 fichier, `vendre` inerte), un appel par championnat en classe 2 (part - 80 refuse le direct, laisse passer le prix), plafonds 400/jour et 3 000 sans prolongation, porte par evenement : journal sain -> verte, bourse en retard de 60 s -> rouge (G2), bourse figee -> rouge (G1), bourse ET ESPN en retard (60 s, 45 s) -> jamais verte (borne du retard d ESPN), datation contre la verite, 15 gardes retirees une a une et leurs sous-conditions, chaque condition seule rouge, porte ecrite d avance cle par cle, compteur illisible ferme apres redeploiement
lance enjeucab "$SRV" node paris_en_jeu_cablage.test.js   # le cablage du direct dans le vrai serveur (lot 7) : cle, appel du socle, part du jour et reserve de la classe 2, passe ESPN PARTAGEE (prendre du module, cache de l affichage, second verrou qui ferme), un tic de bout en bout sans reseau, /paris/import -> enJeu, rencontre reglee lue reglee, second serveur SANS cle = inerte, SIGTERM arrete le direct
lance cotesnoms "$SRV" node cotes_noms.test.js
lance cotesrisq "$SRV" node cotes_risque.test.js
lance betachat "$SRV" node swogebet_achats.test.js
lance profilparis "$SRV" node profil_paris.test.js   # le profil paris d un joueur (ignore proprement si moins de 3 matchs au calendrier)
lance pilotetables "$SRV" node pilote_tables.test.js   # ce que le pilote apprend d une table (par URL) : cle normalisee, reperes bornes, dedoublonnes, durables
lance osinttel "$SRV" node osint_tel.test.js   # le plan de numerotation FR : type + region, deterministes, sans cle
lance osintrte "$SRV" node osint_route.test.js   # un vrai serveur : la route publique du releve
lance bugb    "$SRV" node bugbounty.test.js   # bug bounty + osint : la garde d autorisation (programme ou case attestee), le pre-audit statique
lance bugbrte "$SRV" node bugbounty_route.test.js   # la route /bugbounty : refus sans autorisation avant tout appel, case attestee journalisee
lance tor     "$SRV" node tor.test.js   # .onion defensif : desactive sans Tor, meme garde que le bug bounty, lecture seule (GET)
lance repere  "$SRV" node repere.test.js   # bancs papier pre-enregistres + repere sans risque (chasse a l edge, 04/10)
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
lance credsol  "$SRV" node credit_solana_attente.test.js   # recharge Solana « en attente » (14/10) : retenue 10 min, reprise de la MEME transaction par la MEME session, relue sur la chaine (destinataire, montant, payeur verifie), creditee une fois
lance creddep  "$SRV" node credit_depot.test.js   # credit recharge en SOL/USDT par adresse de depot Relay stricte (14/10, faux Relay et faux noeud Base) : liste fermee, bornes a la cotation, commande sur le disque avant la reponse, credite une fois ce que le RECU Base montre (pas la cotation), recu absent/statut 0/autre jeton/autre destinataire = rien, rembourse/echec = rien, reprise apres redemarrage, session seulement, cle jamais dans une reponse ni un journal, panne = 503
lance clescred "$SRV" node cles_credit.test.js   # cle swg_ au credit en dollars : payeur choisi par la session, debit et plafond en dollars, reponse sans $SWOGE, passerelle sur le credit, video refusee
lance store    "$SRV" node store_agents.test.js   # fiches de l Agent Store : agents exterieurs seulement, aucun taux sous 10 tentatives, permissions et paiements vrais, aucune note inventee
lance passeport "$SRV" node passeport.test.js   # passeport d une cle : signe Ed25519 par une cle dediee, verifiable avec la seule cle publique, un champ change casse la signature, prive par defaut
lance preuves  "$SRV" node preuves_x402.test.js   # paiements verifiables : agents exterieurs seulement, reseaux de production, payeur tronque, lien de la transaction
lance polycol  "$SRV" node poly_papier.test.js   # Polymarket AI papier : achat au prix demande en remontant le carnet, frais officiels lus sur le marche, TWAP 60 s, temoin Coin, Brier, aucun verdict sous 100
lance depv4   "$SRV" node deploiement_v4.test.js   # launchpad V4 et jumeau WETH : portefeuille dedie, parametres relus, une transaction jamais renvoyee, listage, deux envois de valeur seulement, cle jamais rendue
lance lancv4  "$SRV" node lancement_v4.test.js   # l agent PREPARE un lancement V4 : copies d actions, grands symboles, « SWOGE » et liens douteux refuses ; offert a la page seulement
lance solpump "$SRV" node solana_pump.test.js    # lancer sur Solana via Pump.fun (PumpPortal) : non custodial, metadataIpfs + offreCreation (create pool=pump), refus propres, fetch injecte
lance agjeton "$SRV" node agent_jeton.test.js   # un agent par jeton lance : un seul par jeton, seul le createur le modifie, pouvoirs d argent inertes, du selon la cadence, persistance
lance agposte "$SRV" node agent_poste.test.js   # l agent d un jeton compose un post dans sa persona : faits recus seulement (aucun chiffre invente), fetch injectable, reserve sans cle, liens nettoyes
lance agfaits "$SRV" node agent_faits.test.js   # les faits live d un jeton : une valeur absente ne cree aucun fait, GoPlus tri-etat (inconnu != vert), une source qui tombe n efface pas les autres
lance agdemo  "$SRV" node agent_demo.test.js    # apercu d un post d agent : registre -> faits -> compositeur (+ image a pattes), rien publie, pause/sans-agent refuses, recolte/image en panne n arretent pas
lance agrte   "$SRV" node agent_route.test.js   # /agent/* de bout en bout : lecture publique, attach/toggle/preview reserves ADMIN, apercu relie marche+GoPlus sans publier, reserve sans cle IA, pause refusee ; self-service createur signe (attach_createur) jamais en aveugle
lance agcrea  "$SRV" node agent_createur.test.js # le createur se sert lui-meme : signature + lecture du createur on-chain, imposteur refuse (403), jeton hors launchpad (404), RPC muet (503), fenetre temporelle bornee, pool pris de la chaine
lance agfeed  "$SRV" node agent_feed.test.js    # le mur d un agent : plus recent en tete, borne, texte vide/adresse invalide refuses, mur global, persistance
lance aghorl  "$SRV" node agent_horloge.test.js # l ordonnanceur : seulement les dus, post sur le mur (surX si compte relie, jamais le maison), precedents transmis, un echec n arrete pas les autres, planifie inerte sans actif
lance agx     "$SRV" node agent_x.test.js       # compte X par jeton : creds chiffrees (fail-closed sans cle), handle public jamais les secrets, publication signee app+jeton, refus propres
lance agxoauth "$SRV" node agent_x_oauth.test.js # liaison X cote createur : tango OAuth 1.0a PIN (request_token sans jeton + oauth_callback oob, puis access_token + oauth_verifier), refus propres, aucun secret ecrit
lance agtg    "$SRV" node agent_tg.test.js      # bot Telegram par jeton : jeton du bot chiffre (fail-closed sans cle), groupe public jamais le secret, poste + epingle, formes refusees, refus propres
lance agfuel  "$SRV" node agent_fuel.test.js    # le carburant par jeton : versement de bienvenue une fois, credite (volume/versement) / debite au cout, jamais a credit, peutPenser garde l avance, persistance
lance agcaisse "$SRV" node agent_caisse.test.js # la caisse : cascade carburant d abord / tresor / rachat en paliers cumulatifs, somme exacte au centime, autonomie (runway)
lance agfin   "$SRV" node agent_finance.test.js # auto-financement du carburant depuis les frais (vague 1 #6) : cascade reutilisee, idempotent (curseur), ESSAI par defaut (mesurer avant de crediter), fail-closed
lance parefeu "$SRV" node pare_feu.test.js      # pare-feu de prompt (8b papier) : bloque fonds/cles/injection/usurpation/cache, retire les adresses, deux classifieurs fail-closed
lance policy  "$SRV" node policy_argent.test.js # policy engine (8b papier) : liste blanche, plafonds action/heure/jour, impact-prix, cooldown, tresor ; deterministe et persistant
lance signerp "$SRV" node signer_papier.test.js # signer isole (8b papier) : resimule, ne signe que l approuve (meme pool, impact borne), journal papier, aucune cle ni envoi reel
lance traderp "$SRV" node trader_papier.test.js # la boucle trader EN PAPIER (8b-ii) : pare-feu -> policy -> signer -> compta, pool du registre jamais de l intention, refus a chaque etage, cooldown
lance agdevis "$SRV" node agent_devis.test.js   # le vrai devis (8c piece 1, LECTURE SEULE) : impact-prix estime (prix reel vs marginal), grandit avec la taille, refus si zero, aucune cle
lance exereel "$SRV" node executeur_reel.test.js # l executeur REEL (8c piece 2) INERTE : refuse sans drapeau+cle dediee+jeton d essai+envoyeur cable ; rachat-et-brule seulement ; cle isolee de MIROIR_CLE ; jamais la cle rendue ; l envoyeur jamais appele sur un refus
lance agesprit "$SRV" node agent_esprit.test.js # l esprit autonome : choisit ses outils (lecture puis action), au plus 1 post/1 rachat par pulse, finance par le carburant, rachat via la boucle trader seulement si active, aucune cle
lance agmodele "$SRV" node agent_modele.test.js # le modele de l esprit (tool-use Anthropic) : choisit un outil ou s arrete, persona+regles dans le systeme, option media du post, fail-safe sans cle, bout en bout
lance agmem   "$SRV" node agent_memoire.test.js # la memoire d un agent : note/rappel durables et bornes, anti-repetition (mots en commun) qui refuse le quasi-doublon mais laisse passer le neuf, seuls les posts comptent
lance agevt   "$SRV" node agent_evenements.test.js # les evenements d un jeton : prix h1 net seulement, pression acheteuse (assez d obs + domination), palier de holders franchi une fois vers le haut, tri par force, aucun faux evenement
lance voix    "$SRV" node studio_voix.test.js # le vocal du chat : transcription compatible OpenAI (Groq defaut), facture la duree RENDUE (pas celle annoncee), minimum facturable, 503/413/502, jamais sous le cout
lance passkey "$SRV" node wallet_passkey.test.js # le verrou biometrique du wallet (WebAuthn, @simplewebauthn) : defi a usage unique + expire, cle en base64url, fail-closed ; NE garde JAMAIS les fonds (verrou de confort)
lance passkeyrte "$SRV" node wallet_passkey_route.test.js # les routes /wallet/passkey/* sur le vrai serveur : origine en liste blanche, preuve de propriete (signature) AVANT le WebAuthn, 404 sans passkey
lance agmesure "$SRV" node agent_mesure.test.js # la mesure : agrege impressions/likes, meilleur post, classement par format SEULEMENT si assez d observations, aucun chiffre invente
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
lance klingedit "$SRV" node kling_edition.test.js   # Kling O1 edition : corps de la doc (refer_image + base_video par URL, son original), refus avant envoi, clip efface a la fin/au delai/au refus
lance klingedrte "$SRV" node kling_edition_route.test.js   # edition Kling sur un vrai serveur : 403 avant le corps, clip servi a Kling par son nom puis efface, fin journalisee une fois
lance wan     "$SRV" node wan_remplace.test.js   # Wan 2.2 Animate Replace (fal) : 16 i/s avant l envoi, prix images/16, son d origine remis par ffmpeg, entrees effacees
lance wanrte  "$SRV" node wan_route.test.js   # Wan sur un vrai serveur : proprietaire seul, resultat final servi avec la session seulement, cle fal jamais montree
lance klingent  "$SRV" node kling_entier.test.js   # video entiere Kling O1 (vrai ffmpeg) : coupures de plan puis parts egales 3-9,5 s, prix au pire et plafond avant tout appel, 2 a la fois, 1303 attend, relance d une part, reprise apres redemarrage (id Kling, id externe), recollage a la longueur et au son d origine, hotes Kling seuls
lance klingentrte "$SRV" node kling_entier_route.test.js   # video entiere sur un vrai serveur : 403 avant le corps, 413 annonce, plan avant paiement, prix confirme, morceaux servis a Kling puis plus, resultat avec la session seulement
lance klinganime "$SRV" node kling_anime.test.js   # Animate my still (15/10) : first_frame + feature_video (jamais base_video), duration = seconde entamee, audio off, pas d aspect_ratio, images + elements <= 4 image fixe comprise, refus de Kling rendu tel quel ; clip seul = un morceau, son d origine et longueur exacte (vrai ffmpeg) ; video entiere : morceau n part de la derniere image du resultat n-1 coupe a sa longueur, un a la fois, un rate bloque la suite, relance avec la meme image, reprise apres redemarrage ; jamais en public
lance klinganirte "$SRV" node kling_anime_route.test.js   # Animate my still sur un vrai serveur : 401/403 avant le corps, mode inconnu 400, un morceau, prix avant envoi, requete Kling (first_frame base64 + feature_video par URL publique), resultat a la session avec le son d origine, passeAnime a part
lance swogeel  "$SRV" node swoge_element.test.js   # element SWOGE et premiere image (15/10) : corps de la doc (frontal_image + refer_images[{image_url}], element_id en chaine, effacement), { type: element, id: element_1 } a la PLACE des deux images (clip, video entiere, Swap SWOGE), jamais avec des images a soi ou d un joueur, images + elements <= 4, @element_1 exige ; vues depuis le meme, plafond du jour, hotes Kling ; id ecrit et relu au redemarrage, recreation, effacement ; premiere image (vrai ffmpeg) : 2 candidats, personne visee seule, choisie par son adresse, derniere refer_image + « The first frame … »
lance swogeelrte "$SRV" node swoge_element_route.test.js   # element SWOGE et premiere image sur un vrai serveur : 403/401 avant Kling, vues lues avec la session, element cree puis envoye, efface puis repli sur les images, premiere image extraite et envoyee, jamais la cle
lance swap      "$SRV" node swap.test.js   # SWOGE Swap, le moteur public (vrai ffmpeg, Kling simule, vrai credits.js) : prix = pire cas x SWAP_MARGE au cent, toute adresse avec la case, images/texte du joueur REFUSES, 402 sans debit, reserve durable reglee sur les morceaux livres, relance gratuite une fois puis image d origine rendue, rien livre = tout rendu, une passe par adresse, file SWAP_PARALLELE, plafond du jour, resultat a son adresse seule, reprise des reserves au redemarrage, proprietaire inchange
lance swaprte   "$SRV" node swap_route.test.js   # SWOGE Swap sur un vrai serveur : 401/400 (case)/413 avant le corps, joueur quelconque, plan et prix avant paiement, images/texte refuses, 402, credit reserve et regle, file, plafond du jour, morceaux servis a Kling puis plus, resultat avec la session seule, route du proprietaire toujours 403
lance swapapercu "$SRV" node swap_apercu.test.js   # SWOGE Swap v2 (15/10 soir) : l image d abord (OpenAI images/edits) — multipart image[] plan puis personnage, consigne « seulement la personne visee », taille au rapport de la video puis cotes exactes, reserve avant l appel, usage x marge, refus rendu, porte, plafonds, proprietaire 30/jour, Animate seulement depuis un apercu du serveur, reprise
lance swapaperte "$SRV" node swap_apercu_route.test.js   # SWOGE Swap v2 sur un vrai serveur : ?mode=anime, apercu paye au credit, image a la session seule, lance { apercu } = first_frame octet pour octet, proprietaire 403 pour les autres, aucune cle dans une reponse
lance observ  "$SRV" node observatoire.test.js   # Solana/Ethereum/Robinhood, observer seulement : moyenne bornee a +300 % et recalculee depuis les .jsonl, devs qui poussent sur lancements plausibles, decouverte unique, securite sans GoPlus, prix a 30 min par le meme service, disparus a part, rien que 4 services
lance banque  "$SRV" node banque_papier.test.js   # banque papier : achat seulement sur devis d achat ET de revente, temoin et bras, ventes a 10/30/60 min, invendable = 0, panne != pas de route, aucune signature
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
lance derniere "$SRV" node derniere_image.test.js   # la derniere image d une video (ffmpeg) pour enchainer les scenes : la bonne image, fournisseurs seulement (CHAQUE saut de redirection), 80 Mo comptes en flux, null sans ffmpeg
lance essai   "$SRV" node essai_montage.test.js   # essai de montage xAI : longueur lue dans les boites MP4, clip efface apres fini/rate/delai, cout des ticks, plafond du jour
lance essairte "$SRV" node essai_montage_route.test.js   # essai de montage sur le vrai serveur : proprietaire seul, 403 avant le corps, faux xAI, aucun debit, cle jamais montree
lance planches "$SRV" node planches_chaine.test.js   # planches iso : faux clips H.264 du mannequin a travers TOUTE la chaine (planche du jeu + HD sans perte) ; le vrai passe, un monstre SYMETRIQUE en vraies vues aussi ; 25 defauts fabriques (copie retournee, arme dans l autre main, vue qui se tourne, zoom en attaque, direction qui flotte, ciseaux, trainee grise, ombre qui clignote, taille, jambes, sol, boucle, glissade, franges ; et sur TOUT le clip : le baton qui change de main en marchant, SW = SE et NW = NE retournes pour un monstre symetrique) font tomber CHACUN son controle ; P6 sur une toile retournee (~7 min)
lance plposes "$SRV" node planches_poses.test.js   # poses OpenAI : plafond 2,50 $ verifie AVANT l appel (reserves en vol comprises), envoye avant / cout apres, ARRET (usage absent, cout > reserve, calibrage, coupure apres reception, 5xx), journal a chemin fixe quel que soit --dossier, cle jamais ecrite
lance plroute "$SRV" node planches_route.test.js   # /studio/planches sur le vrai serveur : 403 avant le corps, pire cas au tarif 720p (+ images d entree), lot refuse au plafond SANS appel, image = last_frame, 720p 5:2 muet, journal envoi/sent/cout, fichiers (et HD) au seul proprietaire, redirection hors x.ai refusee, deux Run simultanes = 429 sans appel, coupure = reserve + ARRET, journal inecrivable = aucun appel, reprise pendant la finition, plafond qui ne peut que baisser
lance vgroute "$SRV" node vignettes_route.test.js   # /studio/vignettes (cartes animees de studio.html) : 403 avant le corps, SON plafond 1,25 $ (env ne fait que baisser), pire cas lite 480p + image, refus SANS appel (plafond, sha256, pas un JPEG, texte libre, modele, format, carte en double), lite 480p 16:9 muet sans last_frame + JPEG du site + NOTRE consigne, « envoi » au journal AVANT l appel, cout des ticks, boucle aller-retour MP4 + WebM (vrai ffmpeg) au seul proprietaire, hote hors x.ai refuse, deux Run = 429, coupure/5xx = reserve + ARRET, 4xx = 0 $, journal inecrivable = aucun appel, reprise ; le vignettes.json PUBLIE tient dans le plafond
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
# ---- LE MONDE ET LES OBJETS (12/10/2026) ----
# Cinquante-sept suites qui n etaient dans AUCUNE boucle — exactement la panne de
# miroir_reel —, plus annonces_monde, nee le meme jour. Une ligne complete
# repondait « server error » a son gagnant (ReferenceError sur `base0`) et sept
# fruits disaient « undefined » sur leur fiche, sans qu un seul essai lance par
# ce script ne le voie. Le bloc entier : ~4 min (236 s mesurees le 12/10).
# Trois d entre elles chargeaient './node_modules/ethers' en dur et tombaient
# dans une copie git sans node_modules : elles passent par NODE_PATH comme les
# autres.
lance_monde appels      appels.test.js
lance_monde balise      balise.test.js
lance_monde objets      boutique.test.js           # « boutique » est deja pris (boutique_esim)
lance_monde braises     braises.test.js
lance_monde butin       butin.test.js
lance_monde cartes      cartes.test.js
lance_monde cartesrv    cartes_serveur.test.js
lance_monde cave        cave.test.js               # les pirates rendent du rare : mesure sur le plan, pas sur la table
lance_monde choc        choc.test.js
lance_monde classmonde  classement_monde.test.js
lance_monde coffrenotif coffre_notif.test.js
lance_monde coffreoff   coffre_offert.test.js
lance_monde coffresac   coffre_sac.test.js
lance_monde deuxmondes  deux_mondes.test.js
lance_monde deuxonglets deux_onglets.test.js
lance_monde donjon      donjon.test.js
lance_monde donjonsrv   donjon_serveur.test.js     # ligne de tir libre choisie et affirmee (un rocher la coupait 4 fois sur 64)
lance_monde donjonsens  donjons_ensemble.test.js
lance_monde echange     echange.test.js
lance_monde egide       egide.test.js
lance_monde equipstock  equipement_stock.test.js
lance_monde famcombat   familier_combat.test.js
lance_monde famsoutien  familier_soutien.test.js
lance_monde famzone     familier_zone.test.js
lance_monde fiche       fiche_complete.test.js
lance_monde fioles      fioles.test.js
lance_monde marche      marche.test.js
lance_monde marchanim   marche_animaux.test.js
lance_monde marchpot    marche_potions.test.js
lance_monde marchsig    marche_signal.test.js
lance_monde monde       monde.test.js
lance_monde mondesouv   mondes_ouverts.test.js
lance_monde nexusmulti  nexus_multi.test.js
lance_monde obstacles   obstacles.test.js
lance_monde oeufs       oeufs.test.js
lance_monde optimus     optimus.test.js
lance_monde parole      parole.test.js
lance_monde passifs     passifs.test.js            # dont : aucune phrase vide ni « undefined » sur les 180 objets
lance_monde perso       perso.test.js
lance_monde persos      personnages.test.js
lance_monde portail     portail.test.js
lance_monde potions     potions.test.js
lance_monde pvp         pvp.test.js
lance_monde quetes      quetes.test.js
lance_monde rachat      rachat.test.js
lance_monde ramassage   ramassage_auto.test.js
lance_monde realm       realm.test.js
lance_monde realmsrv    realm_serveur.test.js
lance_monde rejoint     rejoint.test.js
lance_monde repas       repas.test.js
lance_monde skins       skins.test.js
lance_monde skinsed     skins_edition.test.js
lance_monde solnexus    sol_nexus.test.js          # dont : la couleur du sac suit son contenu
lance_monde tircourse   tir_course.test.js
lance_monde ville       ville.test.js
lance_monde xp          xp.test.js
lance_monde zones       zones.test.js
lance_monde annmonde    annonces_monde.test.js     # les quatre chemins d une ligne complete, les quatre portes, faux Telegram
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
lance klingpage "$SITE" node kling_edition_page.test.js   # kling_essai.html « Edit a clip » : Kling O1 et Wan sur le meme clip, duree refusee dans la page, resultat Wan lu avec la session, 320 px
lance klingentpage "$SITE" node kling_entier_page.test.js   # kling_essai.html « Whole video » : video brute, plan et prix au pire avant paiement, plafond ferme le bouton, 4 references, relance d une part, resultat lu avec la session, lien seulement apres
lance klinganipage "$SITE" node kling_anime_page.test.js   # kling_essai.html « Animate my still » : selecteur de mode (l edition intacte par defaut), image fixe avec apercu, clip 12 s refuse dans la page, ?mode=anime-clip / ?mode=anime, prix du serveur avant Run, Run = {still, resolution, confirmeUsd, note}, parts a la suite et reste estime, Retry, resultat en blob puis Download ; 320/390/1280 px
lance klingswogepage "$SITE" node kling_swoge_page.test.js   # kling_essai.html « SWOGE character » (vues, element, blob avec la session), « Who to replace » (= texte du serveur), « Prepare first frame » ; 320/390/1280 px
lance swappage "$SITE" node swap_page.test.js   # studio.html#swap (SWOGE Swap v2, 15/10 soir ; Cinema n a plus qu un lien) : rien demande avant l approche, video brute + x-swap-rights + ?mode=anime, cible requise, prix du serveur, recharge, apercu {personnage|image sha, cible, qui} seulement, image en blob, Regenerate, Use this picture, Animate {apercu, resolution, confirmeUsd}, video en blob + Download, reprise, 320/390/1280 px
lance animerpage "$SITE" node kling_animer_page.test.js   # kling_animer.html (proprietaire) : image + video, prix du serveur, et l etape facultative « Make the picture from the video (ChatGPT) » : apercu, Regenerate, Use this picture = le still envoye
lance connexionclic "$SITE" node connexion_clic.test.js   # formulaire « Sign in » de stakebubble : le centre de chaque bouton recoit son clic (14/10 : .x::after global couvrait « Connect wallet »)
lance agentpage "$SITE" node agent_page.test.js   # SwogeAgentic : chaque geste visible, echappe, jeton jamais adresse, reprise par rid
lance agentqr  "$SITE" node agent_qr.test.js   # le QR de la carte eSIM = le generateur prouve du portefeuille (200 empreintes segno), jamais un faux QR
lance esimpage "$SITE" node esim_page.test.js   # boutique eSIM : chercher, payer Base (EIP-3009) ou Solana, lien secret, QR, ?order= retrouve, echappe, 320 px
lance storepage "$SITE" node agent_store.test.js   # Agent Store : usage mesure avec son effectif, aucun taux sous 10, mission preremplie, services x402 tels que sondes, https seulement, 360 px
lance polypage "$SITE" node polymarket_page.test.js   # Polymarket Edge Check : tri par date (jamais les gros gains d abord), pertes non encaissees reintegrees, aucun verdict sous 100, teneur de marche dit, texte seulement, 360 px
lance polyai   "$SITE" node polymarket_ai_page.test.js   # Polymarket AI : cinq agents avec effectif, temoin Coin marque, calibration sans gagnant sous 100, liens polymarket.com seulement, 360 px
lance colpage "$SITE" node colonies_page.test.js   # Solana & ETH : barre de Bonferroni sur les cases jugees, moyenne bornee > 0 exigee, « not enough » sous 30, pousseurs avec lien explorateur seulement pour une adresse valide, 360 px
lance smartpg  "$SITE" node smart_money_page.test.js   # Smart Money : chaque chiffre Verified / Not verified avec sa source (liens GeckoTerminal), la PREUVE de chaque ligne (bloc, tx, marques), « no verdict under 10 known outcomes », perime et panne dits, ?server= ferme, aucun bouton d achat, echappe, 320/390/768/1440 px, aucune erreur console, aucun texte francais ; ECHOUE sans Playwright
lance onglets "$SITE" node onglets_ia.test.js   # les cinq pages AI Trading portent la meme barre, rien ne deborde a 360 px
lance lancepage "$SITE" node lance_v4.test.js   # carte de lancement : le portefeuille du joueur signe ; offres truquees refusees ; frais $SWOGE autorise au montant exact, frais ETH en valeur
lance dexmc   "$SITE" node dexscreener_mcap.test.js   # capitalisation : le chiffre de DexScreener tel quel, aucun dollar invente, le taux choisi par l actif de cotation (V3 et V4 $SWOGE)
[ $VITE -eq 1 ] || lance lpv3 "$SITE" node launchpad_v3.test.js   # VRAIE chaine : frais V3 lu sur le contrat, grille V2/V3, cotation ETH d un V2
[ $VITE -eq 1 ] || lance lpv4ch "$SITE" node launchpad_v4_frais.test.js   # VRAIE chaine : les jetons V4 dans Explore et dans l echange (actif de cotation, 50 %), Collect vers le bon launchpad
lance lpv4page "$SITE" node launchpad_v4_page.test.js   # launchpad.html : choix du pool ($SWOGE, ETH, V3), fiche GoPlus lue (cases vides dites « not readable »), copies refusees par le vrai propose, kit du createur, portefeuille de la page
lance passpage "$SITE" node agent_passport.test.js   # Agent Passport : champs en texte, signature verifiee dans le navigateur (ou par le serveur, dit), passeport modifie refuse, publier par la session
lance navliens "$SITE" node nav_liens.test.js   # aucun lien muet sur les pages qui eteignent leurs liens par defaut ; chaque entree du menu recoit un VRAI clic, 1280 et 390 px
lance menurang "$SITE" node menu_rangee.test.js   # sous 1360 px le menu commun est une rangee qui defile (14/10) : les neuf entrees, Studio compris, recoivent le clic sur les 36 pages a colonne, 320 a 1360 px, sans faire defiler la page en largeur ; colonne au-dessus
lance x402page "$SITE" node x402_essai_page.test.js   # payer un appel en USDC sur Base depuis son portefeuille : offre Base du 402, EIP-3009 signe et verifie, resultat echappe, 320 px
lance x402sol "$SITE" node x402_solana.test.js   # la transaction Solana de la page : octet pour octet celle de web3.js (vecteurs figes), comptes USDC associes, memo aleatoire
lance paieatt "$SITE" node x402_paie_attente.test.js   # apres la signature : un reglement Solana en attente est represente (la MEME signature) ; « already presented » d un serveur d avant ne fait ni conclure ni resigner
lance ecopage "$SITE" node economie_page.test.js   # la carte $SWOGE ECONOMY et le whitepaper suivent /economie.json
lance predictpage "$SITE" node predict_page.test.js
lance accueil  "$SITE" node accueil_refonte.test.js      # accueil en douze sections : tout ce qui vivait reste, colonie lue avec son effectif, aucune promesse inverifiable, 360 px
lance fusion   "$SITE" node agents_fusion.test.js   # swoge_agents.html = ses sources (identifiants ag-, styles bornes)
lance creddepp "$SITE" node credit_depot_page.test.js   # recharge SOL/USDT dans les dialogues (studio, swolemind, swoge_agents) : provenances du serveur et leurs bornes, une requete {origin, amountUsd} seulement, adresse + montant exact + reseau + send only + estimation contre ce qui arrive + plateformes d echange, Copy, suivi jusqu a credited, rembourse dit, reprise d une commande ouverte, rien en stockage local, 320 px
[ $VITE -eq 1 ] || lance walletpg "$SITE" node wallet_page.test.js   # portefeuille : la feuille de connexion ATTEIGNABLE a cinq tailles de fenetre ; rouge le 03/10 sans que la boucle le voie (elle ne le lancait pas)
lance vitrine  "$SITE" node wallet_vitrine.test.js      # portefeuille : six cartes a cote du telephone sans le couvrir, rien d invente (« -- »), la visite au defilement s arrete au premier geste
lance walassist "$SITE" node wallet_assistant_page.test.js   # l assistant du portefeuille dans la page : comprend et pre-remplit (send/swap/burn), jamais de signature, phrase sans adresse = aucun envoi
lance walpk    "$SITE" node wallet_passkey_page.test.js   # le verrou Face ID dans la page : voile a la reprise d un portefeuille a passkey, Face ID le retire, l interrupteur SECURITY le pose ; fail-open sans @simplewebauthn ; le verrou cache l ecran, il ne garde JAMAIS les fonds
lance walapercu "$SITE" node wallet_apercu_page.test.js   # l apercu avant signature : la revue rejoue l envoi (estimateGas) — « expected to succeed » + gaz reel, ou « would FAIL » + la raison du revert AVANT de signer ; la page montre, le bouton reste actif
lance fond     "$SITE" node fond_anime.test.js         # fond d ecran anime : sur les neuf pages du menu, il JOUE, derriere tout, dans son budget ; rien sous 700 px ni pour moins de mouvement
# Elle criait dans le vide : 30 echecs sur 617, jamais lus, parce qu elle
# n etait pas dans cette boucle — exactement la panne de miroir_reel.test.js.
lance reference "$SITE" node referencement.test.js
lance coffre  "$SITE" node coffre.test.js   # le choix du coffre sur les jeux casino : cache sans $SWOGEBET (defaut $SWOGE), apparait avec, retombe sur $SWOGE si le bet vault se vide, choix retenu
lance casinopages "$SITE" node casino_coffre_pages.test.js   # les 9 pages casino de bout en bout (faux serveur) : chaque mise d ouverture porte le jeton du coffre choisi ; un joueur a 0 $SWOGE / 500 $SWOGEBET peut miser ; sans $SWOGEBET, rien ne change
# monde_page lit la page ET ce serveur : elle ne tient que si les deux portent le meme lot.
# Mesure du 12/10/2026 : la page d avant le lot « le drop se lit » contre ce serveur = 19 rates
# sur le seul bloc du drop. On integre donc le site d abord, ou l on pose SITE_DIR sur sa copie.
lance mondepage "$SITE" env SWOGE_SERVEUR="$SRV" node monde_page.test.js   # le monde vu de la page, contre CE serveur
lance paripage "$SITE" node paris_page.test.js   # la page des paris
lance paridirect "$SITE" node paris_direct.test.js   # le score en direct, du tableau d ESPN jusqu a la ligne de la page ; aucun bouton sur un match commence
lance pariaccueil "$SITE" node paris_accueil.test.js
lance spritelab "$SITE" node sprite_lab.test.js   # sprite_lab.html : bouger le monstre (clavier et VRAI toucher), la ligne DESSINEE suit la direction, il avance le long de son axe iso, repos a l arret, attaque une fois, HD, WASD apres un reglage, manette visible sans defiler, ?server= ne recoit jamais le jeton, 320/390/1440 sans defilement
lance plpage "$SITE" node planches_essai_page.test.js   # planches_essai.html : les lots de demandes.json, pire cas et reste du serveur, Run grise sans session, hors proprietaire, au-dessus du reste, entree invalide, ARRET ou lot en cours ; POST {lot} seul avec le jeton, suivi jusqu a la fin, fichiers lus avec le jeton (blob), refus echappe, ?server= ne recoit jamais le jeton, 320 px
lance vgpage "$SITE" node vignettes_essai_page.test.js   # vignettes_essai.html : lots du vrai vignettes.json avec l image d entree de chaque carte, Run grise sans session / hors proprietaire / au-dessus du reste / ARRET ; POST {lot} seul avec le jeton, boucles .webm/.mp4 et brut lus avec le jeton (blob) et nommes pour media/studio/, pire cas au dix-millieme, refus echappe, ?server= ne recoit jamais le jeton, 320 px
lance studiovg "$SITE" node studio_vignettes_page.test.js   # studio.html, cartes animees : video muette en boucle preload none sur l image (poster = l image, meme cadrage), WebM puis MP4, joue SEULEMENT visible, rien telecharge hors ecran, gris des cartes a venir, fichier absent ou illisible = l image, prefers-reduced-motion = l image ; chaque entree de VIDEOS a ses deux fichiers
lance marqueur "$SITE" node cache_marqueur.test.js
lance minifie "$SITE" node minifie.test.js
echo "  $NB suites · $(( $(date +%s) - T0 )) s au total · $([ $RATE -eq 0 ] && echo 'TOUT VERT : on peut commettre' || echo 'ROUGE : on ne commet pas')"
exit $RATE
