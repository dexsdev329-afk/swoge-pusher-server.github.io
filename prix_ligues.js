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

/** Ce qui se VEND au prix du marche. Ne pas modifier l'ensemble rendu. */
function ligues() { return lue('PARIS_PRIX_LIGUES', LIGUES_DEFAUT); }
/** Ce qu'on RELEVE sans le vendre (`PARIS_PRIX_OBSERVE`). */
function observees() { return lue('PARIS_PRIX_OBSERVE', []); }

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

module.exports = { LIGUES_DEFAUT, decoupe, ligues, observees, JOKER_PERMIS, couvre, vendue, observee, refusee, refusees, venteImpossible, SANS_VERROU_REEL };
