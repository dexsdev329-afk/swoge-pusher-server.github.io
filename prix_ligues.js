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

module.exports = { LIGUES_DEFAUT, decoupe, ligues, observees };
