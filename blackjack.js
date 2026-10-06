'use strict';
/* ==================================================================
 * LE MODE BLACKJACK DU PILOTE — LA MARTINGALE, TENUE PAR LE SERVEUR
 * ==================================================================
 * Signalé par le propriétaire : en pilote libre, le modèle « oublie de doubler
 * la mise après une perte, ou de revenir à 1 $ après un gain ». C'est la
 * progression de mise (martingale), qui est DÉTERMINISTE : on ne la laisse donc
 * pas au LLM. Le serveur tient la mise courante et, à chaque main finie, calcule
 * la suivante ; le pilote DIT au modèle la mise exacte à poser. Le modèle ne
 * décide plus la mise : il lit l'écran, place ce qu'on lui dit, et joue.
 *
 * Règle, telle que demandée : départ à la mise de base ; après une PERTE on
 * double ; après un GAIN (ou un blackjack) on revient à la base ; une ÉGALITÉ
 * (push) ne change rien. Si doubler dépasse le plafond, la progression est
 * cassée : on repart de la base (et la limite « stop after losing » du pilote,
 * elle, arrête la session — ici on ne fait que gérer la mise).
 *
 * Pur et injectable : aucune lecture d'écran, aucun hasard, aucun effet de bord.
 * ================================================================== */

const ISSUES = { win: 1, lose: 1, push: 1, blackjack: 1 };

function nombrePositif(x, defaut) {
  const n = Number(x);
  return n > 0 && Number.isFinite(n) ? n : defaut;
}

/** Normalise ce que le modèle rapporte en une issue connue, ou null. */
function litIssue(x) {
  const t = String(x || '').toLowerCase().trim();
  if (t === 'win' || t === 'won' || t === 'gagne' || t === 'gagné') return 'win';
  if (t === 'blackjack' || t === 'bj') return 'blackjack';
  if (t === 'lose' || t === 'lost' || t === 'loss' || t === 'perdu' || t === 'bust') return 'lose';
  if (t === 'push' || t === 'tie' || t === 'egalite' || t === 'égalité' || t === 'draw') return 'push';
  return null;
}

/**
 * prochaineMise({ base, cap, mise, issue }) : la mise de la PROCHAINE main.
 *   base  — la mise de départ (défaut 1) ;
 *   cap   — le plafond de mise (défaut base*64) ;
 *   mise  — la mise de la main qui vient de finir (défaut base) ;
 *   issue — 'win' | 'lose' | 'push' | 'blackjack' (ou null : inchangée).
 * Perte -> double (ou retour base si ça dépasse le plafond) ; gain/blackjack ->
 * base ; push/inconnu -> inchangée.
 */
function prochaineMise(o) {
  o = o || {};
  const base = nombrePositif(o.base, 1);
  const cap = Math.max(base, nombrePositif(o.cap, base * 64));
  const mise = Math.min(cap, nombrePositif(o.mise, base));
  const issue = litIssue(o.issue);
  if (issue === 'lose') { const d = mise * 2; return d > cap ? base : d; }
  if (issue === 'win' || issue === 'blackjack') return base;
  return mise;   /* push, ou rien de rapporté : on ne bouge pas */
}

/** La mise d'ouverture : toujours la base. */
function premiereMise(o) { return nombrePositif((o || {}).base, 1); }

module.exports = { prochaineMise, premiereMise, litIssue, ISSUES };
