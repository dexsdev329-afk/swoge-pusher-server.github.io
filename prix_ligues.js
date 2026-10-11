'use strict';
/*
 * LES CHAMPIONNATS AU PRIX DU MARCHE — la liste seule, sans dependance
 * (09/10/2026).
 *
 * Deux fichiers doivent lire la MEME liste : `prix_marche.js` (le releve et
 * l'import) et `paris.js` (la porte de vente, `ouvert`). `paris.js` ne peut
 * pas requerir `prix_marche.js` : celui-ci requiert `cotes.js`, qui requiert
 * `paris.js`. D'ou ce module, qui ne requiert rien.
 */

/* Les six grands championnats, ceux ou l'argent se pose et ou l'Elo perd le
   plus. `PARIS_PRIX_LIGUES` vide COUPE tout (retour a l'Elo partout). Depuis le
   09/10/2026, la production pose aussi les onze championnats secondaires
   (EXPLOITATION.md 8.8quinquies). */
const LIGUES_DEFAUT = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_uefa_champs_league'];

/* ---- LES SEPARATEURS : VIRGULE, POINT-VIRGULE, ESPACES ----
 * Relecture du 09/10 : une liste collee avec des « ; » devenait UNE seule cle
 * fausse — les dix-sept championnats, les six grands compris, repassaient a
 * l'Elo, et rien ne l'ecrivait au journal (le joker `tennis=*` taisait meme
 * l'avertissement des cles inconnues). Une cle The Odds API ne contient ni
 * espace ni point-virgule : les accepter comme separateurs ne coute rien. */
function decoupe(v) {
  return String(v === undefined || v === null ? '' : v).split(/[\s,;]+/).filter(Boolean);
}

/* La valeur se relit a chaque appel (une variable change au redemarrage, et
   les essais la posent en cours de route), mais le decoupage se garde tant
   qu'elle ne change pas : `ouvert` l'appelle pour chaque rencontre. */
const MEMO = new Map();
function lue(nom, defaut) {
  const v = process.env[nom];
  const k = nom + '\u0000' + (v === undefined ? '\u0001' : v);
  let s = MEMO.get(k);
  if (!s) {
    s = v === undefined ? new Set(defaut) : new Set(decoupe(v));
    if (MEMO.size > 64) MEMO.clear();
    MEMO.set(k, s);
  }
  return s;
}

/* ---- LES COUPES N'ENTRENT PAS PAR LES DEUX LISTES DES CHAMPIONNATS (lot 6, 11/10/2026) ----
 * Une cle de coupe (COUPES, plus bas) posee dans PARIS_PRIX_LIGUES ou
 * PARIS_PRIX_OBSERVE en est RETIREE, et c'est dit au demarrage
 * (`clesIgnorees`) : une coupe ne passe que par ses deux variables a elle,
 * PARIS_COUPES (la vente, lot 10) et PARIS_COUPES_OBSERVE (l'inventaire et
 * l'observation). Vendue comme un championnat, une coupe prendrait les six
 * marches derives du modele de buts — jamais mesure sur des coupes — et sa
 * releve passerait en priorite. Sans cle de coupe dans la liste (la
 * production du 09/10 : les 17 championnats, EXPLOITATION 8.8quinquies),
 * l'ensemble rendu est le MEME objet qu'avant ce lot : rien ne change. */
const DERIVE = new WeakMap();   /* l'ensemble lu -> le meme, prive des coupes (garde tant que la valeur ne change pas) */
function sansCoupes(nom, defaut) {
  const brut = lue(nom, defaut);
  let s = DERIVE.get(brut);
  if (!s) {
    s = [...brut].some(estCoupe) ? new Set([...brut].filter((x) => !estCoupe(x))) : brut;
    DERIVE.set(brut, s);
  }
  return s;
}
/** Ce qui se VEND au prix du marche. Ne pas modifier l'ensemble rendu.
    Lot 6 : PARIS_PRIX_LIGUES prive des coupes, plus les coupes VENDUES
    (`coupes()`, toujours vide dans ce lot : la vente est le lot 10). */
function ligues() {
  const s = sansCoupes('PARIS_PRIX_LIGUES', LIGUES_DEFAUT);
  const v = coupes();
  return v.size ? new Set([...s, ...v]) : s;
}
/** Ce qu'on RELEVE sans le vendre (`PARIS_PRIX_OBSERVE`), prive des coupes. */
function observees() { return sansCoupes('PARIS_PRIX_OBSERVE', []); }

/* ---- LE JOKER DU TENNIS (deux issues, lot 3, 10/10/2026) ----
 * Les cles du tennis sont par TOURNOI et tournent chaque semaine (le joker
 * `tennis=*` de paris_import suit les cles actives, liste du 18/09/2026) : on
 * ne peut pas les ecrire d'avance dans une variable. `tennis_atp_*` et
 * `tennis_wta_*` couvrent donc les cles actives de leur circuit, JAMAIS un
 * classement (`_winner`, aucune rencontre dedans). Aucun autre joker : un
 * championnat s'ecrit en clair — `basketball_*` ou `tennis_*` suivraient des
 * dizaines de cles d'un coup, a un credit chacune, sans que personne l'ait
 * decide. Un joker refuse ne couvre RIEN et se dit au demarrage
 * (`refusees`). */
const JOKER_PERMIS = /^tennis_(atp|wta)_\*$/;
/* ---- LE CRICKET EST REFUSE (decision du 09/10/2026) ----
 * Aucune cle cricket n'est cochee « Scores & Results » chez The Odds API
 * (https://the-odds-api.com/sports-odds-data/sports-apis.html, lu le 09/10),
 * et le nul comme le « no result » existent en cricket : notre registre lui
 * donne deux issues (paris.js), un livre a trois prix le dirait autrement.
 * Une cle cricket n'est donc jamais OBSERVEE (aucun credit) et jamais notee
 * au carnet (prix_marche.issuesDe) : posee dans PARIS_PRIX_OBSERVE elle est
 * ignoree et dite au demarrage. Posee dans PARIS_PRIX_LIGUES, elle reste
 * « vendue » pour la porte de vente (paris.ouvert la ferme faute de prix,
 * exactement comme avant ce lot ou aucun livre a deux prix n'etait retenu),
 * sans jamais coûter un credit. */
const REFUSEE = /^cricket_/;
/** Cette cle est-elle refusee au prix du marche (cricket) ? */
function refusee(cle) { return REFUSEE.test(String(cle || '')); }
/* ---- LE TENNIS NE SE VEND PAS AU MARCHE SANS VERROU D'HEURE REELLE (decision du 09/10/2026) ----
 * La fermeture d'une rencontre repose sur deux verrous : son heure au
 * catalogue, et l'heure REELLE lue sur le tableau d'ESPN (paris.ouvert,
 * HEURES_REELLES). Le tennis n'a que le premier : scores_espn.CHEMINS n'a
 * aucune cle tennis, et /odds rend aussi les matchs EN COURS (« Returns a list
 * of upcoming and live games », https://the-odds-api.com/liveapi/guides/v4/,
 * lu le 09/10) — une releve pourrait noter une cote de direct sur une
 * rencontre que le catalogue croit a venir. Le tennis s'OBSERVE donc
 * (PARIS_PRIX_OBSERVE, P1-P3 seulement : ni DK ni seconde source gratuite pour
 * P4-P5), mais aucune bascule n'est possible : une cle tennis posee dans
 * PARIS_PRIX_LIGUES n'est jamais relevee ni notee — ses rencontres restent
 * SUSPENDUES (le resultat d'avant ce lot, ou aucun livre a deux prix n'etait
 * retenu), jamais vendues au marche ni rendues a l'Elo — et c'est dit au
 * demarrage. Lever ce verrou demande du CODE (un chemin ESPN du tennis, puis
 * retirer cette regle), pas une variable. */
const SANS_VERROU_REEL = /^tennis_/;
/** L'ensemble `ens` couvre-t-il `cle` ? En clair, ou par un joker permis. */
function couvre(ens, cle) {
  const k = String(cle || '');
  if (!k || k.indexOf('*') >= 0) return false;
  if (ens.has(k)) return true;
  if (/_winner$/.test(k)) return false;
  for (const e of ens) if (JOKER_PERMIS.test(e) && k.startsWith(e.slice(0, -1))) return true;
  return false;
}
/** Cette cle se VEND-elle au prix du marche ? (remplace `ligues().has(k)` :
    meme reponse sur une cle ecrite en clair, et le joker du tennis en plus) */
function vendue(cle) { return couvre(ligues(), cle); }
/** Cette cle est-elle OBSERVEE (relevee sans etre vendue) ? Jamais le cricket. */
function observee(cle) { return !vendue(cle) && !refusee(cle) && couvre(observees(), cle); }
/** Vendue, mais sans verrou d'heure reelle (le tennis) : jamais relevee ni notee, donc suspendue. */
function venteImpossible(cle) { return vendue(cle) && SANS_VERROU_REEL.test(String(cle || '')); }
/** Ce qui est ecrit dans les deux listes et ne sera jamais releve : un joker
    autre que tennis_atp_* / tennis_wta_*, une cle cricket. Dit au demarrage. */
function refusees() {
  const out = [];
  for (const [nom, ens] of [['PARIS_PRIX_LIGUES', ligues()], ['PARIS_PRIX_OBSERVE', observees()]]) {
    for (const e of ens) {
      if (e.indexOf('*') >= 0 && !JOKER_PERMIS.test(e)) out.push(nom + ' ' + e + ' (joker refuse : seuls tennis_atp_* et tennis_wta_*)');
      else if (refusee(e)) out.push(nom + ' ' + e + ' (cricket refuse : ni scores The Odds API, ni issue pour le nul)');
      else if (nom === 'PARIS_PRIX_LIGUES' && SANS_VERROU_REEL.test(e)) out.push(nom + ' ' + e + ' (tennis : aucune vente au marche sans verrou d heure reelle — ses rencontres restent SUSPENDUES)');
    }
  }
  return out;
}

/* ---- LE PLUS/MOINS 2,5 AU PRIX DES TOTAUX DU MARCHE (lot 5, 10/10/2026) ----
 * Deux listes de plus, sur le meme decoupage et le meme memo, VIDES par
 * defaut : un deploiement ne releve rien, ne paie rien, ne change rien de ce
 * qui est vendu. Elles vivent ici pour la meme raison que les deux premieres :
 * `cotes.js` (la porte d'age du total, `butsDe`) et `totaux_marche.js` (le
 * releve et le carnet) doivent lire les memes, et ce module ne requiert rien.
 *   PARIS_TOTAUX_OBSERVE : on RELEVE les totaux (classe 3), rien n'est vendu ;
 *   PARIS_TOTAUX_LIGUES  : la grille prend le total du marche (classe 1).
 * Football seulement (`soccer_*`), jamais de joker : une cle s'ecrit en
 * clair, et un joker ne couvre RIEN (dit au demarrage par `totauxRefusees`).
 * Ne rien mettre dans PARIS_TOTAUX_LIGUES avant les portes 0, 1 et 2
 * d'EXPLOITATION 8.8decies. */
const TOTAUX_PERMIS = /^soccer_[a-z0-9_]+$/;
/** Ce dont la grille prend le total du marche (vendu). */
function totauxLigues() { return lue('PARIS_TOTAUX_LIGUES', []); }
/** Ce dont on releve les totaux sans rien vendre. */
function totauxObservees() { return lue('PARIS_TOTAUX_OBSERVE', []); }
/** Cette cle VEND-elle le total du marche ? */
function totalVendu(cle) { const k = String(cle || ''); return TOTAUX_PERMIS.test(k) && totauxLigues().has(k); }
/** Cette cle est-elle OBSERVEE (releve sans vente) ? */
function totalObserve(cle) { const k = String(cle || ''); return !totalVendu(k) && TOTAUX_PERMIS.test(k) && totauxObservees().has(k); }
/** Les cles dont on releve les totaux : vendues puis observees. */
function totauxARelever() {
  const out = new Set();
  for (const k of [...totauxLigues(), ...totauxObservees()]) if (TOTAUX_PERMIS.test(k)) out.add(k);
  return out;
}
/** Ce qui est ecrit dans les deux listes et ne sera jamais releve (autre que soccer_*, joker). */
function totauxRefusees() {
  const out = [];
  for (const [nom, ens] of [['PARIS_TOTAUX_LIGUES', totauxLigues()], ['PARIS_TOTAUX_OBSERVE', totauxObservees()]]) {
    for (const e of ens) if (!TOTAUX_PERMIS.test(e)) out.push(nom + ' ' + e + ' (football seulement, cle en clair : soccer_...)');
  }
  return out;
}
/* ---- L'AGE D'UN TOTAL QUI SE VEND ENCORE ----
 * PARIS_TOTAUX_AGE_MAX_H, 48 h par defaut ET au plus. Le banc qui fonde le
 * gain (D2_match_rho40, 0,13 % d'issues plus/moins battables) lit les cotes
 * « pre-closing » de football-data : relevees le vendredi apres-midi pour le
 * week-end, le mardi pour le milieu de semaine (swogebet/fd/notes.txt:48 et
 * :198), soit un age median de 1,13 j et un p90 de 2,19 j sur 15 988
 * rencontres (age_fd.js, relecture du 09/10). La regle 48 h / 48 h donne au
 * coup d'envoi un age median de 1,0 j et un p90 de 2,0 j (sim_regle.js sur le
 * calendrier du 09/10, 609 rencontres, 0 sans total). 168 h n'est mesure nulle
 * part : au-dessus de 48, la variable est ramenee a 48 (et dit au demarrage).
 * En dessous, permis (plus strict), fractions comprises (0,5 h). Le reglage
 * ECHOUE FERME (relecture du 10/10) : 0 ou une valeur negative veut dire
 * qu'aucun total n'est servi (0 h), jamais 48 ; seules une variable absente,
 * vide ou illisible valent 48. Avant, « 0 » et « 0.5 » devenaient 48, la
 * valeur la plus permissive. */
const TOTAUX_AGE_MAX_H = 48;
function totauxAgeMaxH() {
  const brut = process.env.PARIS_TOTAUX_AGE_MAX_H;
  /* Number('') vaut 0 : une variable vide n'est pas un « 0 » ecrit */
  if (brut === undefined || String(brut).trim() === '') return TOTAUX_AGE_MAX_H;
  const h = Number(brut);
  if (!isFinite(h)) return TOTAUX_AGE_MAX_H;
  return h > 0 ? Math.min(h, TOTAUX_AGE_MAX_H) : 0;
}
function totauxAgeMaxMs() { return totauxAgeMaxH() * 3600000; }

/* ============ LES COUPES (lot 6 de la cle 20K, 11/10/2026) ============
 *
 * Huit cles, liste FERMEE : les deux coupes europeennes sous la Ligue des
 * champions et les six coupes nationales des pays dont on vend deja le
 * championnat. Les huit existent chez The Odds API et y sont cochees
 * « scores » (https://the-odds-api.com/sports-odds-data/sports-apis.html, lu
 * le 09/10/2026) ; leurs tableaux ESPN repondent tous (8 x HTTP 200 le
 * 11/10/2026, scores_espn.CHEMINS). Une autre cle n'est jamais une coupe ici :
 * posee dans PARIS_COUPES* elle est ignoree et dite (`clesIgnorees`).
 *
 * Trois variables, VIDES ou a zero par defaut — un deploiement ne releve
 * rien, ne paie rien et ne change rien de ce qui est vendu :
 *   PARIS_COUPES_OBSERVE    les coupes INVENTORIEES : /events (gratuit) et
 *                           appariement ESPN (gratuit). Aucune rencontre de
 *                           coupe n'entre au catalogue ;
 *   PARIS_COUPES_OBSERVE_H  0 (defaut) = inventaire seul, 0 credit ; N > 0 =
 *                           releve PAYANTE des coupes observees (classe 3,
 *                           jamais prioritaire) quand une rencontre commence
 *                           dans les N h, plus la releve forcee T-45/T-20
 *                           (classe 2). 48 est la valeur du plan ;
 *   PARIS_COUPES            la VENTE, construite au lot 10 seulement, apres
 *                           la porte d'EXPLOITATION 8.11. Dans ce lot elle est
 *                           LUE pour etre dite, et ignoree : `coupes()` est
 *                           toujours vide (VENTE_COUPES_CONSTRUITE). Sans les
 *                           gardes du lot 10 (1-N-2 et double chance seuls,
 *                           jamais l'Elo, appariement ESPN exige, plafond
 *                           propre), vendre une coupe offrirait les six
 *                           marches du modele de buts sur un prix jamais
 *                           observe. */
const COUPES = Object.freeze(['soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league',
  'soccer_fa_cup', 'soccer_england_efl_cup', 'soccer_germany_dfb_pokal', 'soccer_spain_copa_del_rey',
  'soccer_italy_coppa_italia', 'soccer_france_coupe_de_france']);
const COUPES_EUROPEENNES = Object.freeze(['soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league']);
const ENS_COUPES = new Set(COUPES);
/** Cette cle est-elle une des huit coupes ? */
function estCoupe(cle) { return ENS_COUPES.has(String(cle || '')); }
/** Les deux marches qu'une coupe vendra au lot 10 (1-N-2 et double chance). */
const MARCHES_COUPE = Object.freeze(['1n2', 'dc']);
/* La vente des coupes n'est PAS construite dans ce lot. Passer ce drapeau a
   vrai sans le code du lot 10 vendrait les coupes comme des championnats :
   coupes.test.js le tient (§5). */
const VENTE_COUPES_CONSTRUITE = false;
const VIDE = new Set();
/** Les coupes demandees a la VENTE (PARIS_COUPES), dans la liste fermee. */
function coupesDemandees() { return new Set([...lue('PARIS_COUPES', [])].filter(estCoupe)); }
/** Les coupes VENDUES. Toujours vide dans ce lot (la vente est le lot 10). */
function coupes() {
  if (!VENTE_COUPES_CONSTRUITE) { VIDE.clear(); return VIDE; }
  return coupesDemandees();
}
/** Les coupes OBSERVEES (inventaire, puis releve si la fenetre est ouverte) :
    PARIS_COUPES_OBSERVE dans la liste fermee, privee des coupes vendues. */
function coupesObservees() {
  const v = coupes();
  return new Set([...lue('PARIS_COUPES_OBSERVE', [])].filter((k) => estCoupe(k) && !v.has(k)));
}
/* ---- LA FENETRE DE LA RELEVE PAYANTE D'UNE COUPE OBSERVEE ----
 * PARIS_COUPES_OBSERVE_H, en heures. 0 par defaut : l'inventaire seul, 0
 * credit. Le reglage ECHOUE FERME, comme PARIS_TOTAUX_AGE_MAX_H : absente,
 * vide, illisible, nulle ou negative, la variable vaut 0 (aucune releve),
 * jamais une fenetre ouverte par defaut. Bornee a 168 h (l'horizon de 7 jours
 * de l'import). 48 h : la fenetre du plan du 09/10 — la simulation de la
 * saison 2025-26 sur les coups d'envoi ESPN (8 coupes, releve de 2 h
 * seulement a moins de 48 h, plus l'avant-match) donne 3 078 credits, 142 a
 * 473 par mois, contre 8 294 a l'horizon de 7 jours. */
const COUPES_OBSERVE_H_MAX = 168;
function observeCoupesH() {
  const brut = process.env.PARIS_COUPES_OBSERVE_H;
  if (brut === undefined || String(brut).trim() === '') return 0;
  const h = Number(brut);
  if (!isFinite(h) || !(h > 0)) return 0;
  return Math.min(h, COUPES_OBSERVE_H_MAX);
}
function observeCoupesMs() { return observeCoupesH() * 3600000; }
/** Ce qui est ecrit et ne sera jamais pris comme coupe, avec la raison. Dit
    au demarrage (paris_import.planifie). */
function clesIgnorees() {
  const out = [];
  for (const nom of ['PARIS_PRIX_LIGUES', 'PARIS_PRIX_OBSERVE']) {
    for (const e of lue(nom, nom === 'PARIS_PRIX_LIGUES' ? LIGUES_DEFAUT : [])) {
      if (estCoupe(e)) out.push(nom + ' ' + e + ' (une coupe ne passe que par PARIS_COUPES_OBSERVE / PARIS_COUPES)');
    }
  }
  for (const nom of ['PARIS_COUPES', 'PARIS_COUPES_OBSERVE']) {
    for (const e of lue(nom, [])) {
      if (!estCoupe(e)) out.push(nom + ' ' + e + ' (hors des huit coupes : ' + COUPES.join(', ') + ')');
      else if (nom === 'PARIS_COUPES' && !VENTE_COUPES_CONSTRUITE) out.push(nom + ' ' + e + ' (vente des coupes pas construite : lot 10, apres la porte d EXPLOITATION 8.11 — rien n est vendu)');
    }
  }
  return out;
}

/* ---- LA PROLONGATION POSSIBLE, PAR CLE (deplacee de paris_import, lot 6) ----
 * Ou le score final peut compter la prolongation ou les tirs au but : la
 * Ligue des champions et les coupes europeennes (barrages et elimination
 * directe), les series MLS (meme cle que la saison reguliere), et toute
 * coupe. Une liste, pas une devinette : une cle inconnue qui ressemble a une
 * coupe compte comme une coupe. Les huit COUPES y sont toutes : UEL et UECL
 * par la liste, les six nationales par l'expression (`_fa_`, `cup`, `pokal`,
 * `copa`, `coppa`, `coupe`). Ici parce que paris.js (la page, lot 10) devra
 * la lire, et qu'il ne requiert que ce module. */
const PROLONGATION_LIGUES = new Set(['soccer_uefa_champs_league', 'soccer_uefa_europa_league',
  'soccer_uefa_europa_conference_league', 'soccer_usa_mls']);
function prolongationPossibleLigue(cle) {
  const l = String(cle || '');
  return PROLONGATION_LIGUES.has(l) || /cup|copa|coupe|pokal|coppa|trophy|playoff|knockout|_fa_|super_?cup/i.test(l);
}

module.exports = { LIGUES_DEFAUT, decoupe, ligues, observees, JOKER_PERMIS, couvre, vendue, observee, refusee, refusees, venteImpossible, SANS_VERROU_REEL,
                   TOTAUX_PERMIS, totauxLigues, totauxObservees, totalVendu, totalObserve, totauxARelever, totauxRefusees,
                   TOTAUX_AGE_MAX_H, totauxAgeMaxH, totauxAgeMaxMs,
                   /* les coupes (lot 6, 11/10/2026) : la liste fermee, l'observation, la vente (vide), la prolongation */
                   COUPES, COUPES_EUROPEENNES, estCoupe, MARCHES_COUPE, VENTE_COUPES_CONSTRUITE, coupesDemandees, coupes, coupesObservees,
                   COUPES_OBSERVE_H_MAX, observeCoupesH, observeCoupesMs, clesIgnorees, PROLONGATION_LIGUES, prolongationPossibleLigue };
