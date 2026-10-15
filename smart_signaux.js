'use strict';
/* ==================================================================
 * LE VERDICT DU BRIEF (15/10/2026) — DETERMINISTE, ET IL REFUSE SANS DONNEE
 * ==================================================================
 *
 * Le proprietaire a ecrit un brief d'analyste (smart_brief.js) : ACHETER /
 * SURVEILLER / EVITER selon des regles chiffrees. Ce module les applique
 * TELLES QU'ECRITES, chacune comme une fonction qui rend ce qu'elle a vu :
 *
 *   { cle, regle, etat: 'ok' | 'echec' | 'inconnu', valeur, attendu }
 *
 * « ok » veut toujours dire « bon pour acheter » ; « echec », que la
 * condition est observee contre ; « inconnu », que la donnee manque.
 *
 * ---- FAIL CLOSED ----
 * ACHETER exige que TOUTES les conditions d'achat ET toutes celles d'evitement
 * soient « ok ». Un seul « inconnu » — une taxe non lue, une liquidite dont on
 * ne sait pas qui la tient — et ce n'est pas ACHETER. Un danger OBSERVE (taxe,
 * dev a 25 %+, liquidite tenue par un wallet, bundle massif, rugger connu)
 * rend EVITER : le brief les range sous « aucun danger » pour acheter ; on ne
 * les range pas sous SURVEILLER.
 *
 * Le modele de langage, s'il y en a un, ne DECIDE rien : il recoit le verdict
 * et les faits, et les met en mots au format du brief (`redige`). Sa reponse
 * est verifiee ; si elle ne porte pas le verdict recu, ou qu'elle en porte un
 * autre, c'est le gabarit qui part.
 *
 * Fonctions pures, sauf `redige` (un appel HTTP injectable).
 * ================================================================== */

const L = require('./smart_listes');
const { BRIEF } = require('./smart_brief');

// ------------------------------------------------------------ les seuils du brief
/* Tous ecrits par le proprietaire dans son brief du 15/10/2026 : ce sont SES
   mesures (Sniper 1 : gagne entre 10 et 60 min, perd apres 6 h — 3 gagnants
   sur 26 —, perd au-dessus de 100 k$ — 1 sur 14). Aucun n'a ete remesure ici. */
const AGE_MIN_MIN = 10;              // regle 1
const AGE_MAX_MIN = 60;              // regle 1
const CAP_ACHAT_MAX = 35000;         // regle 2
const RECENT_MIN = 5;                // regle 3 : « vient d'acheter (moins de 5 min) »
const LIQ_MIN = 5000;                // regle 4
const IMPACT_MAX = 5;                // regle 4, en %
const DEV_PART_MAX = 25;             // regle 5, en % de l'offre
const CAP_SURVEILLER_MAX = 100000;   // SURVEILLER 35-100 k$ ; EVITER au-dessus
const AGE_EVITER_MIN = 6 * 60;       // EVITER : « plus de 6 h apres le lancement »
const MULTIPLE_EVITER = 3;           // EVITER : « deja ×3 »
/* « pas de bundle d'equipe massif » : le brief parle de « la quinzaine de
   wallets qui ont achete VANTOR et BORRO dans la premiere minute ». 15 est donc
   un CHIFFRE DU BRIEF (deux jetons), PAS une mesure de seuil. A cote, la seule
   mesure du depot (smart_calcul.js, ROBOTS_MIN, 13/10) : acheteurs distincts de
   la 1re minute = TROLL 18, astro 9, NILF 5, PEPONS 4, HM 2, BRODIE 1, CPU 0 —
   sept jetons, aucun classe « bundle » ou non. A remesurer avant d'y croire. */
const BUNDLE_MIN = 15;
/* La mise fixe pour l'impact : « environ 100 $ par jeton » (recette de Sniper 1
   dans le brief). Reglable (SMART_MISE_USD). */
const MISE_USD_DEFAUT = 100;
/* « liquidite pas gardee par un wallet », pour une paire v2 (jeton de
   liquidite) : au moins 95 % brules ou verrouilles. CHOISI, aucune mesure : en
   dessous, un wallet peut retirer une part. Une piscine v4 se juge sur le
   proprietaire du NFT de position (contrat ou wallet), lu dans la tx de
   lancement (sonde du 15/10 : 0x2abd55…, NFT #334 au contrat 0x6120…). */
const LP_LIBRE_MIN = 95;
/* Le detecteur du « bon dev » (recette du brief : petit achat au lancement,
   reclamations regulieres, rachats apres reclamation). Les trois nombres sont
   CHOISIS, aucune mesure : 0,1 ETH (le seul lancement sonde le 15/10,
   0x2abd55…, portait 0,0625 ETH d'achat du dev), 2 reclamations au moins, un
   rachat dans les 30 min qui suivent une reclamation. */
const PETIT_ACHAT_DEV_ETH = 0.1;
const CLAIMS_REGULIERS_MIN = 2;
const RACHAT_APRES_CLAIM_MIN = 30;

/* Le plan de sortie du brief, dans la forme que `rejoue` (ai_colonie.js) lit :
   coupe a -30 %, a ×2 (+100 %) vendre 75 % (milieu de « 70 a 80 % »), garder
   25 % avec un stop suiveur LARGE — 100 points de recul depuis le plus haut,
   la largeur que la variante « paliers hauts » appelle deja large (CHOISI) —
   et sortir au dernier jalon lu. Les jalons de la colonie s'arretent a
   120 min : « rien apres 3 a 4 h, sortir » n'est donc PAS observable ici, le
   rejeu ferme a 2 h (borne basse du brief, dit). */
const PLAN_BRIEF = { actif: true, p1: 100, v1: 75, p2: 0, v2: 0, p3: 0, v3: 0,
  suivDepart: 100, suivEcart: 100, suivSerre: 100, suivSerreA: 1e12, coupe: 30 };

const VERDICTS = { ACHETER: 'ACHETER', SURVEILLER: 'SURVEILLER', EVITER: 'EVITER' };
const EMOJI = { ACHETER: '🟢', SURVEILLER: '🟡', EVITER: '🔴' };
const LIBELLE = { ACHETER: 'ACHETER', SURVEILLER: 'SURVEILLER', EVITER: 'ÉVITER' };
/* Les conditions dont un echec est un DANGER (regle 5) : elles rendent EVITER. */
const DANGERS = new Set(['dev_moins_25', 'pas_rugger', 'lp_pas_wallet', 'pas_taxe', 'pas_bundle']);

// ------------------------------------------------------------ petits outils
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const court = (a) => (a ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : '?');
const C = (cle, regle, etat, valeur, attendu) => ({ cle, regle, etat, valeur: valeur === undefined ? null : valeur, attendu });
const minutesDepuis = (t, maintenant) => (num(t) === null || num(maintenant) === null ? null : (maintenant - t) / 60000);

/** L'impact de prix d'un achat de `mise` $ sur une piscine a produit constant
 *  de liquidite totale `liq` $ (la moitie cote ETH) : mise / (liq/2 + mise),
 *  en %. Une estimation : une piscine v3/v4 concentree peut faire mieux ou
 *  pire. */
function impactAchat(mise, liq) {
  if (!(num(mise) > 0) || !(num(liq) > 0)) return null;
  return Math.round(mise / (liq / 2 + mise) * 1000) / 10;
}

/** Le multiple de prix entre deux sqrtPriceX96 de la meme piscine (lancement,
 *  puis plus tard). `ethEst0` : l'ETH est token0. null sans les deux. */
function multipleSqrt(sqrt0, sqrt1, ethEst0) {
  try {
    const a = BigInt(sqrt0), b = BigInt(sqrt1);
    if (a <= 0n || b <= 0n) return null;
    /* prix jeton en ETH = (sqrtP^2) si ETH est token1, (1/sqrtP^2) sinon */
    const r = Number((b * 1000000n) / a) / 1e6;
    const m = ethEst0 ? 1 / (r * r) : r * r;
    return isFinite(m) && m > 0 ? Math.round(m * 100) / 100 : null;
  } catch (e) { return null; }
}

/** Les acheteurs DISTINCTS d'une fenetre de blocs : par tx, l'adresse dont le
 *  solde net du jeton monte (beneficiaire, jamais le routeur qui fait suivre),
 *  hors infrastructure (`exclus` : piscine, PoolManager, crochet, jeton,
 *  brulage, createur). `transferts` : [{ tx, bloc, de, vers, valeur (BigInt) }]. */
function acheteursFenetre(transferts, o) {
  const ex = new Set(((o && o.exclus) || []).map((a) => String(a).toLowerCase()));
  const de = o && num(o.blocDebut) !== null ? o.blocDebut : -Infinity;
  const a = o && num(o.blocFin) !== null ? o.blocFin : Infinity;
  const parTx = new Map();
  for (const t of transferts || []) {
    if (!t || t.bloc < de || t.bloc > a) continue;
    let m = parTx.get(t.tx); if (!m) { m = new Map(); parTx.set(t.tx, m); }
    const v = typeof t.valeur === 'bigint' ? t.valeur : BigInt(t.valeur || 0);
    const d = String(t.de).toLowerCase(), r = String(t.vers).toLowerCase();
    m.set(d, (m.get(d) || 0n) - v);
    m.set(r, (m.get(r) || 0n) + v);
  }
  const out = new Set();
  for (const m of parTx.values()) for (const [x, n] of m) if (n > 0n && !ex.has(x)) out.add(x);
  return [...out];
}

/** Un jeton RECU sans jamais etre achete : un airdrop (le brief : « les
 *  nouveaux jetons qu'il recoit sont des airdrops de spam : a ignorer »).
 *  `recus` : transferts vers le wallet ; `achats` : achats ou il est le
 *  beneficiaire d'un echange. */
function estAirdrop(recus, achats) {
  return (recus || []).length > 0 && (achats || []).length === 0;
}

/** Le « bon dev » du brief : petit achat au lancement, reclamations de frais
 *  regulieres, rachat apres reclamation. Chaque morceau vaut true / false /
 *  null (non lu). `claims` et `rachats` : instants (ms). */
function detecteBonDev(d) {
  d = d || {};
  const achat = num(d.achatLancementEth);
  const petitAchat = achat === null ? null : achat > 0 && achat <= PETIT_ACHAT_DEV_ETH;
  const claims = Array.isArray(d.claims) ? d.claims.slice().sort((x, y) => x - y) : null;
  const rachats = Array.isArray(d.rachats) ? d.rachats : null;
  const claimsReguliers = claims === null ? null : claims.length >= CLAIMS_REGULIERS_MIN;
  let rachatApresClaim = null;
  if (claims !== null && rachats !== null) {
    rachatApresClaim = claims.some((c) => rachats.some((r) => r >= c && r - c <= RACHAT_APRES_CLAIM_MIN * 60000));
  }
  const morceaux = [petitAchat, claimsReguliers, rachatApresClaim];
  const bon = morceaux.some((x) => x === false) ? false : morceaux.every((x) => x === true) ? true : null;
  /* le dernier rachat apres reclamation, pour la regle 3 (« le dev rachete apres avoir reclame ») */
  let dernierRachat = null;
  if (rachatApresClaim) for (const c of claims) for (const r of rachats) if (r >= c && r - c <= RACHAT_APRES_CLAIM_MIN * 60000 && (dernierRachat === null || r > dernierRachat)) dernierRachat = r;
  return { petitAchat, claimsReguliers, rachatApresClaim, bon, dernierRachat };
}

// ------------------------------------------------------------ les conditions

/** Les achats des wallets de la liste, avec leur role : [{ wallet, t, tx,
 *  role, signal, nom, partielle, minutes }]. Les adresses hors liste sont
 *  ignorees. */
function achatsListes(achats, maintenant) {
  const out = [];
  for (const a of achats || []) {
    const w = L.roleDe(a.wallet);
    if (!w) continue;
    out.push({ wallet: String(a.wallet).toLowerCase(), t: a.t, tx: a.tx || null, role: w.role, signal: w.signal, nom: w.nom, partielle: !!w.partielle,
      minutes: minutesDepuis(a.t, maintenant) });
  }
  out.sort((x, y) => (y.t || 0) - (x.t || 0));
  return out;
}

/**
 * Toutes les conditions du brief sur `faits` :
 *   maintenant (ms), lanceT (ms|null), mcUsd, liqUsd, miseUsd, impactPct
 *   (sinon calcule), achats [{ wallet, t, tx }], premiereMinute { n,
 *   acheteurs } | null, devPart (%) | null, rugger (bool|null), lp { tenue:
 *   'contrat'|'wallet'|null, partLibre, detail }, taxe { achat, vente } | null,
 *   multiple | null, devVend (bool|null), dev { achatLancementEth, claims,
 *   rachats }, airdrop (bool)
 * Rend { acheter: [...], eviter: [...], achats: [...] }.
 */
function conditions(faits) {
  const f = faits || {};
  const maintenant = num(f.maintenant) !== null ? f.maintenant : Date.now();
  const age = minutesDepuis(f.lanceT, maintenant);
  const mc = num(f.mcUsd), liq = num(f.liqUsd);
  const mise = num(f.miseUsd) !== null ? f.miseUsd : MISE_USD_DEFAUT;
  const impact = num(f.impactPct) !== null ? f.impactPct : impactAchat(mise, liq);
  const ach = achatsListes(f.achats, maintenant);
  const forts = ach.filter((a) => a.signal === 'fort');
  const recents = forts.filter((a) => a.minutes !== null && a.minutes >= 0 && a.minutes <= RECENT_MIN);
  const bd = detecteBonDev(f.dev);
  const rachatRecent = bd.dernierRachat !== null && (maintenant - bd.dernierRachat) / 60000 <= RECENT_MIN;
  const arrondi = (x) => (x === null ? null : Math.round(x * 10) / 10);

  const acheter = [];
  acheter.push(C('age_10_60', 1, age === null ? 'inconnu' : age >= AGE_MIN_MIN && age <= AGE_MAX_MIN ? 'ok' : 'echec', arrondi(age), AGE_MIN_MIN + '-' + AGE_MAX_MIN + ' min'));
  acheter.push(C('cap_sous_35k', 2, mc === null ? 'inconnu' : mc < CAP_ACHAT_MAX ? 'ok' : 'echec', mc, '< ' + CAP_ACHAT_MAX + ' $'));
  {
    /* fort recent, OU rachat du dev apres reclamation ; un rachat non lu ne
       rend « inconnu » que s'il n'y a pas de signal fort recent */
    let etat;
    if (recents.length || rachatRecent) etat = 'ok';
    else if (bd.rachatApresClaim === null) etat = 'inconnu';
    else etat = 'echec';
    acheter.push(C('signal_recent', 3, etat, recents.length ? recents.map((a) => ({ wallet: a.wallet, role: a.role, minutes: arrondi(a.minutes) }))
      : (rachatRecent ? 'dev buyback after a claim' : (forts.length ? forts.map((a) => ({ wallet: a.wallet, role: a.role, minutes: arrondi(a.minutes) })) : null)),
      'Sniper 1, 0x1ad70bc7 or 0xb255c023 bought < ' + RECENT_MIN + ' min ago, or a dev buyback after a fee claim'));
  }
  acheter.push(C('liquidite_5k', 4, liq === null ? 'inconnu' : liq >= LIQ_MIN ? 'ok' : 'echec', liq, '>= ' + LIQ_MIN + ' $'));
  acheter.push(C('impact_5pct', 4, impact === null ? 'inconnu' : impact <= IMPACT_MAX ? 'ok' : 'echec', impact, '<= ' + IMPACT_MAX + ' % for $' + mise));
  acheter.push(C('dev_moins_25', 5, num(f.devPart) === null ? 'inconnu' : f.devPart < DEV_PART_MAX ? 'ok' : 'echec', num(f.devPart), '< ' + DEV_PART_MAX + ' % of supply'));
  acheter.push(C('pas_rugger', 5, f.rugger === true ? 'echec' : f.rugger === false ? 'ok' : 'inconnu', f.rugger === undefined ? null : f.rugger, 'no known rugger'));
  {
    const lp = f.lp || {};
    let etat = 'inconnu';
    if (lp.tenue === 'wallet') etat = 'echec';
    else if (lp.tenue === 'contrat') etat = 'ok';
    else if (num(lp.partLibre) !== null) etat = lp.partLibre >= LP_LIBRE_MIN ? 'ok' : 'echec';
    acheter.push(C('lp_pas_wallet', 5, etat, lp.tenue || (num(lp.partLibre) !== null ? lp.partLibre : null), 'liquidity not held by a wallet'));
  }
  {
    const t = f.taxe;
    const etat = !t || num(t.achat) === null || num(t.vente) === null ? 'inconnu' : t.achat === 0 && t.vente === 0 ? 'ok' : 'echec';
    acheter.push(C('pas_taxe', 5, etat, t ? { achat: num(t.achat), vente: num(t.vente) } : null, '0 % buy and sell tax'));
  }
  {
    const pm = f.premiereMinute;
    const equipe = ach.filter((a) => a.signal === 'negatif');
    let etat;
    if (equipe.length || (pm && num(pm.n) !== null && pm.n >= BUNDLE_MIN)) etat = 'echec';
    else if (!pm || num(pm.n) === null) etat = 'inconnu';
    else etat = 'ok';
    acheter.push(C('pas_bundle', 5, etat, { premiereMinute: pm && num(pm.n) !== null ? pm.n : null, equipe: equipe.map((a) => a.wallet) }, '< ' + BUNDLE_MIN + ' buyers in the first minute, no launch-team wallet'));
  }

  const eviter = [];
  eviter.push(C('cap_sous_100k', 'avoid', mc === null ? 'inconnu' : mc <= CAP_SURVEILLER_MAX ? 'ok' : 'echec', mc, '<= ' + CAP_SURVEILLER_MAX + ' $'));
  eviter.push(C('age_sous_6h', 'avoid', age === null ? 'inconnu' : age <= AGE_EVITER_MIN ? 'ok' : 'echec', arrondi(age), '<= ' + AGE_EVITER_MIN + ' min'));
  eviter.push(C('pas_deja_x3', 'avoid', num(f.multiple) === null ? 'inconnu' : f.multiple < MULTIPLE_EVITER ? 'ok' : 'echec', num(f.multiple), '< ×' + MULTIPLE_EVITER + ' since launch'));
  eviter.push(C('dev_ne_vend_pas', 'avoid', f.devVend === true ? 'echec' : f.devVend === false ? 'ok' : 'inconnu', f.devVend === undefined ? null : f.devVend, 'the dev is not selling'));
  {
    const utiles = ach.filter((a) => a.signal === 'fort' || a.signal === 'faible');
    const autres = ach.filter((a) => a.signal === 'neutre' || a.signal === 'negatif');
    eviter.push(C('pas_que_bots', 'avoid', utiles.length ? 'ok' : autres.length ? 'echec' : 'inconnu', { utiles: utiles.length, botsOuEquipe: autres.length }, 'not only fast bots or the launch team'));
  }
  eviter.push(C('pas_airdrop', 'avoid', f.airdrop === true ? 'echec' : 'ok', !!f.airdrop, 'not received as an airdrop'));
  return { acheter, eviter, achats: ach, bonDev: bd, impact, age, mise };
}

/** Le verdict, et pourquoi. Rend { verdict, raisons: [cle], conditions,
 *  achats, inconnues: [cle] }. */
function verdict(faits) {
  const k = conditions(faits);
  const tout = k.acheter.concat(k.eviter);
  const evites = k.eviter.filter((c) => c.etat === 'echec');
  const dangers = k.acheter.filter((c) => DANGERS.has(c.cle) && c.etat === 'echec');
  const inconnues = tout.filter((c) => c.etat === 'inconnu').map((c) => c.cle);
  const base = { conditions: k, achats: k.achats, inconnues, bonDev: k.bonDev };
  if (evites.length || dangers.length) return Object.assign(base, { verdict: VERDICTS.EVITER, raisons: evites.concat(dangers).map((c) => c.cle) });
  if (tout.every((c) => c.etat === 'ok')) return Object.assign(base, { verdict: VERDICTS.ACHETER, raisons: [] });
  const signaux = k.achats.filter((a) => a.signal === 'fort' || a.signal === 'faible');
  if (signaux.length || k.bonDev.rachatApresClaim) {
    return Object.assign(base, { verdict: VERDICTS.SURVEILLER, raisons: tout.filter((c) => c.etat !== 'ok').map((c) => c.cle) });
  }
  /* Ni danger, ni signal de la liste : le brief ne dit rien ; on n'y va pas
     (complement du depot, dit dans EXPLOITATION.md). */
  return Object.assign(base, { verdict: VERDICTS.EVITER, raisons: ['aucun_signal'] });
}

// ------------------------------------------------------------ les textes (proprietaire, en francais)

const esc = (x) => String(x == null ? '' : x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const k$ = (u) => (num(u) === null ? '?' : u >= 1e6 ? (u / 1e6).toFixed(2).replace('.', ',') + ' M$' : u >= 1e3 ? Math.round(u / 1e3) + ' k$' : Math.round(u) + ' $');
const PHRASES = {
  age_10_60: 'âge hors de 10-60 min', cap_sous_35k: 'capitalisation pas sous 35 k$', signal_recent: 'pas d’achat de Sniper 1 / 0x1ad70bc7 / 0xb255c023 depuis moins de 5 min',
  liquidite_5k: 'liquidité sous 5 000 $', impact_5pct: 'impact de l’achat au-dessus de 5 %', dev_moins_25: 'le dev tient 25 % ou plus de l’offre',
  pas_rugger: 'dev connu pour avoir retiré la liquidité', lp_pas_wallet: 'liquidité tenue par un wallet', pas_taxe: 'taxe à l’achat ou à la vente',
  pas_bundle: 'bundle d’équipe (achats groupés de la 1re minute ou wallet de l’équipe de lancement)', cap_sous_100k: 'capitalisation au-dessus de 100 k$',
  age_sous_6h: 'plus de 6 h après le lancement', pas_deja_x3: 'déjà ×3 depuis le lancement', dev_ne_vend_pas: 'le dev vend', pas_que_bots: 'achats seulement de bots rapides ou de l’équipe',
  pas_airdrop: 'jeton reçu en airdrop', aucun_signal: 'aucun signal de la liste',
};
const INCONNU = {
  age_10_60: 'âge inconnu', cap_sous_35k: 'capitalisation inconnue', signal_recent: 'rachat du dev après réclamation non lu', liquidite_5k: 'liquidité inconnue',
  impact_5pct: 'impact inconnu', dev_moins_25: 'part du dev non lue', pas_rugger: 'dev inconnu', lp_pas_wallet: 'détenteur de la liquidité non lu', pas_taxe: 'taxe non lue',
  pas_bundle: 'acheteurs de la 1re minute non lus', cap_sous_100k: 'capitalisation inconnue', age_sous_6h: 'âge inconnu', pas_deja_x3: 'multiple depuis le lancement non lu',
  dev_ne_vend_pas: 'ventes du dev non lues', pas_que_bots: 'aucun achat de la liste', pas_airdrop: '',
};
/** Le risque principal : le premier danger observe, sinon la premiere donnee
 *  manquante d'un danger, sinon la verite du brief (7 trades sur 10 perdent). */
function risquePrincipal(v) {
  const k = v.conditions, tout = k.acheter.concat(k.eviter);
  const echec = tout.find((c) => c.etat === 'echec' && (DANGERS.has(c.cle) || c.regle === 'avoid'));
  if (echec) return PHRASES[echec.cle];
  const inc = tout.find((c) => c.etat === 'inconnu' && (DANGERS.has(c.cle) || c.regle === 'avoid'));
  if (inc) return INCONNU[inc.cle] + ' : on ne peut pas exclure ce danger';
  if (v.verdict === VERDICTS.EVITER && v.raisons[0] === 'aucun_signal') return PHRASES.aucun_signal;
  return 'environ 7 trades sur 10 perdent (le brief) : la mise doit rester petite et fixe';
}
function planTexte(v, mise) {
  const sortie = 'stop −30 % ; à ×2 vendre 70 à 80 % (la mise est remboursée) ; garder 20 à 30 % avec un stop suiveur large ; rien après 3 à 4 h : sortir ; ne jamais renforcer une perte';
  if (v.verdict === VERDICTS.ACHETER) return 'entrée : petite mise fixe (~' + mise + ' $) ; ' + sortie;
  if (v.verdict === VERDICTS.SURVEILLER) return 'entrée : aucune pour l’instant (' + v.raisons.map((r) => PHRASES[r] || r).slice(0, 3).join(' ; ') + ') ; si elle vient : ' + sortie;
  return 'entrée : aucune.';
}
function walletsTexte(v) {
  if (!v.achats.length) return 'aucun wallet de la liste';
  return v.achats.slice(0, 6).map((a) => esc(a.nom) + ' (' + court(a.wallet) + (a.partielle ? ', adresse partielle du brief' : '') + ') '
    + (a.minutes === null ? 'heure inconnue' : 'il y a ' + Math.max(0, Math.round(a.minutes)) + ' min')).join(' ; ');
}

/** Le texte au format du brief, sans modele. HTML Telegram (notifyPrive). */
function texteGabarit(v, faits, o) {
  const f = faits || {}, k = v.conditions;
  const sym = esc(f.symbole || court(f.jeton));
  const age = k.age === null ? 'âge inconnu' : Math.round(k.age) + ' min';
  const lignes = [
    `<b>${EMOJI[v.verdict]} ${LIBELLE[v.verdict]} — ${sym}</b> <code>${esc(f.jeton || '')}</code>`,
    `• Âge et capitalisation : ${age} · ${k$(f.mcUsd)} (DexScreener, non vérifié)`,
    `• Wallets de la liste : ${walletsTexte(v)}`,
    `• Risque principal : ${esc(risquePrincipal(v))}`,
    `• Plan : ${esc(planTexte(v, k.mise))}`,
  ];
  const marques = k.acheter.concat(k.eviter).filter((c) => c.cle !== 'pas_airdrop')
    .map((c) => (c.etat === 'ok' ? '✓' : c.etat === 'echec' ? '✗' : '?') + ' ' + c.cle).join(' ');
  lignes.push(`<i>Règles : ${esc(marques)}</i>`);
  if (o && o.lien) lignes.push(`<a href="https://dexscreener.com/robinhood/${esc(f.jeton)}">DexScreener</a>`);
  lignes.push('Pas un conseil financier.');
  return lignes.join('\n');
}

// ------------------------------------------------------------ le modele : il met en mots, il ne decide pas

/** Le message au modele : le verdict decide, les faits, rien d'autre. */
function demandeModele(v, faits) {
  const f = faits || {}, k = v.conditions;
  const faitsCourts = {
    jeton: f.jeton, symbole: f.symbole || null, age_min: k.age === null ? null : Math.round(k.age), capitalisation_usd: num(f.mcUsd), liquidite_usd: num(f.liqUsd),
    impact_pct: k.impact, mise_usd: k.mise,
    wallets: v.achats.map((a) => ({ nom: a.nom, adresse: a.wallet, role: a.role, signal: a.signal, il_y_a_min: a.minutes === null ? null : Math.round(a.minutes) })),
    conditions: k.acheter.concat(k.eviter).map((c) => ({ cle: c.cle, etat: c.etat, valeur: c.valeur })),
    risque_principal: risquePrincipal(v),
  };
  return 'Le verdict est DÉJÀ décidé par les règles du brief, appliquées par le serveur : ' + EMOJI[v.verdict] + ' ' + LIBELLE[v.verdict] + '. Tu ne le changes pas.\n'
    + 'Faits (les SEULS chiffres que tu peux écrire) : ' + JSON.stringify(faitsCourts) + '\n'
    + 'Écris la réponse au format du brief, en français, en quelques lignes : la ligne du verdict, l’âge et la capitalisation, quels wallets de la liste ont acheté et quand, le risque principal, le plan (entrée, stop, objectif, part gardée). N’invente aucun chiffre, aucune adresse. Termine par « Pas un conseil financier. »';
}

/** Une reponse du modele est-elle acceptable ? Elle doit commencer par le
 *  verdict recu, n'en nommer aucun autre, finir par la phrase du brief. */
function reponseValide(texte, v) {
  const t = String(texte || '').trim();
  if (!t || t.length > 1800) return false;
  const premiere = t.split('\n')[0];
  if (premiere.indexOf(LIBELLE[v.verdict]) < 0) return false;
  for (const x of Object.keys(LIBELLE)) if (x !== v.verdict && (t.indexOf(LIBELLE[x]) >= 0 || (x === 'EVITER' && /\bEVITER\b/.test(t)))) return false;
  if (!/Pas un conseil financier\.\s*$/.test(t)) return false;
  return true;
}

/**
 * Le texte au proprietaire. Avec une cle Anthropic, le modele de
 * agent_modele.js (MODELE_DEFAUT) met en mots ; sans cle, sur une erreur ou
 * une reponse qui ne porte pas le verdict, le gabarit. Rend { texte, par:
 * 'modele' | 'gabarit', raison }.
 * deps : { cleAnthropic, fetch, modele, desactive }
 */
async function redige(v, faits, deps) {
  deps = deps || {};
  const gabarit = (raison) => ({ texte: texteGabarit(v, faits), par: 'gabarit', raison });
  const cle = deps.cleAnthropic !== undefined ? deps.cleAnthropic : (process.env.ANTHROPIC_API_KEY || '');
  if (deps.desactive || String(process.env.SMART_ANALYSTE_LLM || '').trim() === '0') return gabarit('modele desactive');
  const f = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!cle || !f) return gabarit('sans cle');
  try {
    const r = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: deps.modele || require('./agent_modele').MODELE_DEFAUT, max_tokens: 500, system: BRIEF,
        messages: [{ role: 'user', content: demandeModele(v, faits) }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return gabarit('modele : HTTP ' + r.status);
    const j = await r.json();
    const t = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!reponseValide(t, v)) return gabarit('modele : reponse sans le verdict decide');
    const sym = esc((faits && faits.symbole) || court(faits && faits.jeton));
    return { texte: `<b>${EMOJI[v.verdict]} ${LIBELLE[v.verdict]} — ${sym}</b> <code>${esc((faits && faits.jeton) || '')}</code>\n` + esc(t), par: 'modele', raison: null };
  } catch (e) { return gabarit('modele : ' + String((e && e.message) || e).slice(0, 60)); }
}

/** Ce que la colonie recoit (public via /ai/colonie) : des codes, pas de phrase. */
function pourLaColonie(v, faits) {
  const f = faits || {};
  return {
    jeton: String(f.jeton || '').toLowerCase(), sym: f.symbole || null, verdict: v.verdict, t: num(f.maintenant) !== null ? f.maintenant : Date.now(),
    conditions: v.conditions.acheter.concat(v.conditions.eviter).map((c) => ({ cle: c.cle, etat: c.etat, valeur: c.valeur })),
    wallets: v.achats.map((a) => ({ wallet: a.wallet, role: a.role, signal: a.signal, minutes: a.minutes === null ? null : Math.round(a.minutes * 10) / 10 })),
    inconnues: v.inconnues,
  };
}

module.exports = {
  AGE_MIN_MIN, AGE_MAX_MIN, CAP_ACHAT_MAX, RECENT_MIN, LIQ_MIN, IMPACT_MAX, DEV_PART_MAX, CAP_SURVEILLER_MAX, AGE_EVITER_MIN, MULTIPLE_EVITER,
  BUNDLE_MIN, MISE_USD_DEFAUT, LP_LIBRE_MIN, PETIT_ACHAT_DEV_ETH, CLAIMS_REGULIERS_MIN, RACHAT_APRES_CLAIM_MIN, PLAN_BRIEF,
  VERDICTS, EMOJI, LIBELLE, DANGERS,
  impactAchat, multipleSqrt, acheteursFenetre, estAirdrop, detecteBonDev, achatsListes, conditions, verdict,
  risquePrincipal, texteGabarit, demandeModele, reponseValide, redige, pourLaColonie,
};
