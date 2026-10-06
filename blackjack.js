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

/* Les stratégies de MISE proposées au joueur (il choisit). Chacune ne touche QUE
 * la mise, jamais le jeu des cartes (toujours basic strategy). */
const STRATEGIES = {
  plat: 'Flat — same bet every hand',
  martingale: 'Martingale — double after a loss, back to base after a win',
  paroli: 'Paroli (anti-martingale) — double after a WIN, back to base after a loss',
  dalembert: "D'Alembert — +1 unit after a loss, -1 after a win",
};

/** Normalise le nom de stratégie ; défaut 'martingale'. */
function litStrategie(x) {
  const t = String(x || '').toLowerCase().trim();
  if (t === 'plat' || t === 'flat' || t === 'fixe' || t === 'none') return 'plat';
  if (t === 'paroli' || t === 'anti' || t === 'anti-martingale' || t === 'antimartingale' || t === 'pirolie' || t === 'reverse') return 'paroli';
  if (t === 'dalembert' || t === "d'alembert" || t === 'alembert') return 'dalembert';
  return 'martingale';
}

/**
 * prochaineMise({ base, cap, mise, issue, strategie }) : la mise de la PROCHAINE main.
 *   base  — la mise de départ (défaut 1) ;
 *   cap   — le plafond de mise (défaut base*64) ;
 *   mise  — la mise de la main qui vient de finir (défaut base) ;
 *   issue — 'win' | 'lose' | 'push' | 'blackjack' (ou null : inchangée) ;
 *   strategie — 'plat' | 'martingale' | 'paroli' | 'dalembert' (défaut martingale).
 * Un push (ou rien de rapporté) ne change jamais la mise. Au-delà du plafond, la
 * progression casse et repart de la base.
 */
function prochaineMise(o) {
  o = o || {};
  const base = nombrePositif(o.base, 1);
  const cap = Math.max(base, nombrePositif(o.cap, base * 64));
  const mise = Math.min(cap, nombrePositif(o.mise, base));
  const issue = litIssue(o.issue);
  const s = litStrategie(o.strategie);
  if (!issue || issue === 'push') return mise;
  const gagne = issue === 'win' || issue === 'blackjack';
  if (s === 'plat') return base;
  if (s === 'paroli') { if (gagne) { const d = mise * 2; return d > cap ? base : d; } return base; }
  if (s === 'dalembert') { return gagne ? Math.max(base, mise - base) : Math.min(cap, mise + base); }
  /* martingale (défaut) */
  if (gagne) return base;
  const d = mise * 2; return d > cap ? base : d;
}

/** La mise d'ouverture : toujours la base. */
function premiereMise(o) { return nombrePositif((o || {}).base, 1); }

module.exports = { prochaineMise, premiereMise, litIssue, litStrategie, STRATEGIES, ISSUES };
