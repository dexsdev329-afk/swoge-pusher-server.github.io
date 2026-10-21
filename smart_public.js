'use strict';
/* ==================================================================
 * LES ALERTES SMART MONEY OUVERTES AUX JOUEURS (16/10/2026)
 * ==================================================================
 *
 * Decision du proprietaire (16/10) : « Ouvre les alertes smart money aux
 * joueurs. » Jusqu'ici chaque alerte du detecteur (smart_money.js,
 * smart_signaux.js, smart_lancements.js, smart_pons.js, smart_listes.js)
 * partait au proprietaire SEUL par tg.notifyPrive, en francais.
 *
 * Ce module ne change rien a ce chemin. Chaque alerte qui part au
 * proprietaire (`envoie` de smart_money.js, mode SMART_MONEY=1) est AUSSI
 * ecrite dans un JOURNAL PUBLIC borne (table `publiques`, base locale du
 * detecteur), sous une forme ANGLAISE construite par GABARIT a partir de
 * champs listes : verdict, jeton, age et etat, qui, promo, risque, plan.
 * Jamais le texte prive, jamais le texte du modele (l'analyste du brief peut
 * rediger avec un modele : ici seul le verdict DECIDE et ses faits comptent),
 * jamais une note interne, une cle ou l'URL du noeud. Une chaine venue de la
 * chaine (symbole, nom de groupe) est reduite a des caracteres surs.
 *
 * ---- LA MESURE, CE QUE GMGN NE DONNE PAS ----
 * Les etiquettes de GMGN sont « for reference only ». Ici chaque alerte
 * publique porte son RESULTAT : le prix au moment de l'alerte (courbe Pons
 * suivie, sinon DexScreener tokens/v1), puis a +5, +15, +30, +60 et +120 min,
 * le meilleur et le pire RELEVES depuis. Les releves se font au fil des
 * cycles existants (lancements toutes les 60 s, veille toutes les 5 min) :
 * aucune minuterie de plus, AU PLUS un appel DexScreener par cycle (30
 * jetons), PRIX_HTTP_H par heure. Un palier manque (serveur arrete, prix
 * illisible) reste MANQUANT : jamais interpole.
 *
 * Par categorie, un bilan : n alertes, part qui a monte a +30 min, mediane,
 * meilleur. Sous BILAN_ASSEZ alertes mesurees a +30 min, il REFUSE de
 * conclure (comme AUDIT_ASSEZ du site et AUDIT7_MIN de la colonie).
 *
 * ---- LE CANAL TELEGRAM ----
 * SMART_PUBLIC_TG_CHAT (vide = rien) : le meme texte anglais, par
 * telegram.notifyChat (meme file, meme cadence que les autres envois), au
 * plus SMART_PUBLIC_MAX_H par heure ; au-dela, l'alerte va au flux de la page
 * seulement, et c'est compte. SMART_PUBLIC_DELAI_S retarde la publication
 * (page ET canal) ; 0 par decision du proprietaire (EXPLOITATION.md).
 *
 * Interrupteurs : actif quand SMART_MONEY=1 ; SMART_PUBLIC=0 eteint tout le
 * public (flux et canal) ; SMART_MONEY=observe n'envoie rien au public.
 * ================================================================== */

const SRC = require('./smart_sources');
const L = require('./smart_listes');
const SS = require('./smart_signaux');

/* Les paliers : ceux des ombres de la colonie s'arretent a 120 min
   (ai_colonie.js) ; +5 et +15 disent le tout debut, ou se joue un lancement
   sur courbe (le brief v2 : T+2). CHOISI. */
const PALIERS = [5, 15, 30, 60, 120];
/* Un palier X se lit dans [X, X + tolerance] : 5 min jusqu'a +15 (la veille,
   seule quand SMART_LANCEMENTS=0, passe toutes les 5 min), 25 % au-dela
   (+30 : 30-37,5 min ; +120 : 120-150). La minute REELLE du releve est gardee
   et montree. CHOISI. */
const tolerance = (x) => (x <= 15 ? 5 : x * 0.25);
const FIN_MIN = 120 + tolerance(120);
/* entre deux paliers, un releve toutes les 5 min au plus pour le meilleur et
   le pire : ce sont des RELEVES, pas le vrai plus haut (dit sur la page). CHOISI */
const OBS_MIN = 5;
/* le prix de reference : lu a l'alerte, sinon au cycle suivant, au plus 3 min
   apres ; au-dela l'alerte n'a pas de reference et n'entre pas au bilan. CHOISI */
const REF_RETARD_MAX_S = 180;
/* La reference DIFFEREE (21/10/2026) : une alerte posee avant tout marche (IGNITION alerte au
   deploiement du contrat : releve du 21/10, 63 alertes publiques, 0 mesuree — aucun prix dans les
   180 s) prend pour reference son PREMIER prix lu dans les 6 h, et ses paliers comptent depuis ce
   prix-la (la page dit combien de temps apres l'alerte il a ete lu). Une alerte sans prix en 6 h
   reste sans mesure. 6 h : CHOISI, la fenetre ou un suiveur aurait encore l'alerte en tete. */
const REF_DIFFEREE_S = 6 * 3600;
/* Le vert se GAGNE par la mesure (21/10/2026). Releve du 21/10 : la ligne de la colonie
   « smart launch: pons » (les verts publics de la categorie pons) : 343 observations, 14 % de
   montees a +30 min contre 27 % pour « achete ou retenu », moyenne -30 % — publiees en vert.
   Une categorie dont la ligne verte a au moins SMART_ACHAT_MIN_OBS (100) observations et monte
   MOINS souvent que ce que la colonie achete part en JAUNE, avec sa mesure ecrite dans l'alerte.
   Reversible : la colonie continue de recevoir le vert (son ombre), donc la ligne continue de se
   mesurer, et l'alerte redevient verte le jour ou elle bat la reference. Jamais l'inverse : la
   mesure ne promeut rien. La correspondance categorie -> source v2 (ai_colonie.js SMART_LIGNES_V2). */
const SOURCE_DE_CAT = { pons: 'lancement', dev: 'dev', ignition: 'ignition', copie: 'copie', rebond: 'rebond' };
/* Le bilan refuse de conclure sous 40 alertes mesurees a +30 min : AUDIT_ASSEZ
   (swoge_ai.html, « une part de montees sous 40 jetons est du bruit ») et
   AUDIT7_MIN (ai_colonie.js) — la meme question, une part de montees. */
const BILAN_ASSEZ = 40;
const PALIER_BILAN = 30;
/* 3 000 alertes gardees (~quelques semaines au rythme du 15/10 : quelques
   dizaines par jour). Les plus anciennes MESUREES partent d'abord. CHOISI */
const JOURNAL_MAX = 3000;
/* DexScreener : 300 appels/min sur tokens/v1 (doc, smart_sources.js) ; ici au
   plus 1 par cycle et 90 par heure, references comprises. CHOISI */
const PRIX_HTTP_H = 90;
const LOT_DS = 30;
const DS_DELAI_MS = 8000;
const MAX_H_DEFAUT = 12;
const DELAI_MAX_S = 24 * 3600;
const ROUTE_DERNIERES = 30, ROUTE_NOUVELLES_MAX = 50;
const SITE = 'https://swoleeswoge.dog/swoge_smart_money.html';
const EXPLORER_DEFAUT = 'https://robinhoodchain.blockscout.com';
const DEXSCREENER = 'https://dexscreener.com/robinhood/';
const CATEGORIES = ['dev', 'pons', 'ignition', 'copie', 'rebond', 'analyste', 'smart'];
const LIBELLE_CAT = { dev: 'Known dev', pons: 'Pons launch', ignition: 'IGNITION', copie: 'Wallet copy', rebond: 'Bounce', analyste: 'Analyst', smart: 'Smart wallets', rouge: 'Red flags (avoid / exit)' };
const EMOJI = { vert: '🟢', jaune: '🟡', rouge: '🔴' };
const FIN = 'Not financial advice.';

/** Le verdict public d'apres la mesure de sa ligne (pure). `m` : ai_colonie.mesureSourceSmart.
 *  Sous les seuils (min de la ligne, refMin de la reference) : rien ne change, rien n'est dit. */
function jugeParMesure(verdict, m) {
  if (verdict !== 'vert' || !m || !fini(m.n) || m.n < (m.min || 100) || !fini(m.partMontes)
      || !m.ref || !fini(m.ref.n) || m.ref.n < (m.refMin || 12) || !fini(m.ref.partMontes)) return { verdict, mesure: null };
  const retrograde = !(m.partMontes > m.ref.partMontes);
  const texte = m.n + ' past green alerts of this kind: ' + m.partMontes + '% were up ' + (m.horizon || 30) + ' min later, vs ' + m.ref.partMontes + '% for what the SWOGE AI colony buys'
    + (retrograde ? ' — shown yellow until it beats that' : '');
  return { verdict: retrograde ? 'jaune' : verdict, mesure: { n: m.n, part: m.partMontes, ref: m.ref.partMontes, retrograde, texte } };
}

// ------------------------------------------------------------ reglages
function entier(x, d, max) { const s = String(x == null ? '' : x).trim(); if (!/^\d{1,9}$/.test(s)) return d; const n = Number(s); return n > max ? max : n; }
function config(env) {
  const e = env || process.env;
  const sm = String(e.SMART_MONEY || '').trim();
  const sp = String(e.SMART_PUBLIC == null ? '' : e.SMART_PUBLIC).trim();
  const actif = sm === '1' && sp !== '0';
  const raison = actif ? null : sm === 'observe' ? 'observe mode' : sm !== '1' ? 'detector off' : 'public alerts off';
  const chat = String(e.SMART_PUBLIC_TG_CHAT || '').trim();
  const lien = String(e.SMART_PUBLIC_TG_LIEN || '').trim();
  return {
    actif, raison, tgChat: chat || null,
    /* un lien t.me de forme sure, sinon rien (la page ne fait de lien qu'avec lui) */
    tgLien: /^https:\/\/t\.me\/[A-Za-z0-9_+][A-Za-z0-9_+\/-]{0,63}$/.test(lien) ? lien : null,
    maxH: entier(e.SMART_PUBLIC_MAX_H, MAX_H_DEFAUT, 1000),
    delaiS: entier(e.SMART_PUBLIC_DELAI_S, 0, DELAI_MAX_S),
  };
}

// ------------------------------------------------------------ petits outils
const lc = (x) => String(x == null ? '' : x).toLowerCase();
const fini = (x) => typeof x === 'number' && isFinite(x);
const num = (x) => (fini(x) ? x : null);
const adr = (a) => (/^0x[0-9a-f]{40}$/.test(lc(a)) ? lc(a) : null);
/* une chaine venue de la chaine ou d'une liste : caracteres surs, courte */
const sur = (s, n) => String(s == null ? '' : s).replace(/[^A-Za-z0-9 $._\/+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, n || 32);
const symbolePropre = (s) => { const x = sur(s, 16).replace(/[\/+]/g, ''); return x || null; };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const s_ = (n) => (n === 1 ? '' : 's');
function usd(u) { if (!fini(u)) return '?'; if (u >= 1e9) return '$' + (u / 1e9).toFixed(2) + 'B'; if (u >= 1e6) return '$' + (u / 1e6).toFixed(2) + 'M'; if (u >= 1e3) return '$' + Math.round(u / 1e3) + 'k'; return '$' + Math.round(u); }
function ethTxt(e) { return !fini(e) ? '?' : e >= 1 ? e.toFixed(2) : e.toFixed(3); }
function duree(min) { if (!fini(min)) return '?'; if (min < 1) return Math.max(0, Math.round(min * 60)) + ' s'; if (min < 120) return Math.round(min) + ' min'; if (min < 48 * 60) return Math.round(min / 60) + ' h'; return Math.round(min / 1440) + ' d'; }
function mediane(l) { if (!l.length) return null; const a = l.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
const arrondi = (x, d) => (fini(x) ? Math.round(x * 10 ** (d || 1)) / 10 ** (d || 1) : null);

// ------------------------------------------------------------ les noms (anglais, par role)
const ROLE_NOM = { SNIPER_1: 'Sniper 1', SNIPER_1_LIE: 'Sniper 1 (linked wallet)', SUIVRE: 'Tracked wallet', GROUPE_A_TESTER: 'Group under test',
  BOT_RAPIDE: 'Fast bot', SNIPER_PERDANT: 'First-block sniper', BUNDLE: 'Launch-team wallet', DEV_IGNITION: 'IGNITION dev' };
const ROLE_QUI = { deployer: 'Deployer', tx_from: 'Sender', creator: 'Known creator', buyer: 'Wallet', smart: 'Smart wallet (owner’s rule)', ignition_wallet: 'IGNITION team wallet' };
/* 16/10, decision du proprietaire : des noms NEUTRES et AUCUNE adresse de
   wallet ou de dev dans le public (« Known dev #1 », « Smart wallet A ») : sa
   liste privee ne se lit pas dans le flux. Le numero et la lettre sont STABLES
   (ordre des listes), pour qu'un joueur puisse suivre « Smart wallet A » d'une
   alerte a l'autre sans savoir qui c'est. Seule l'adresse du JETON reste. */
const DEV_NUM = new Map(L.BRIEF2.DEVS.map((g, i) => [g.groupe, i + 1]));
const SUIVIS = [...new Set(L.WALLETS.filter((w) => w.adresse && (w.signal === 'fort' || w.signal === 'faible')).map((w) => w.adresse)
  .concat(L.BRIEF2.COPIE.map((w) => w.adresse)))];
function lettre(i) { let t = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; t = String.fromCharCode(65 + r) + t; i = Math.floor((i - 1) / 26); } return t; }
const SUIVI_LETTRE = new Map(SUIVIS.map((a, i) => [a, lettre(i)]));
function devNeutre(groupe) { return 'Known dev #' + (DEV_NUM.get(groupe) || '?'); }
/** Le nom court PUBLIC d'une adresse : neutre, construit sur son role, jamais
 *  le nom de la liste du proprietaire. */
function nomPublic(a, role) {
  const dc = L.devConnu(a);
  if (dc) return devNeutre(dc.groupe);
  if (a === L.BRIEF2.IGNITION.wallet) return 'IGNITION team wallet';
  if (SUIVI_LETTRE.has(a)) return 'Smart wallet ' + SUIVI_LETTRE.get(a);
  const v2 = L.roleV2(a);
  if (v2 && v2.role === 'copie') return 'Smart wallet';
  const v1 = L.roleDe(a);
  if (v1 && (v1.signal === 'fort' || v1.signal === 'faible')) return 'Smart wallet';
  if (v1 && ROLE_NOM[v1.role] && !/^(SNIPER_1|SUIVRE|GROUPE)/.test(v1.role)) return ROLE_NOM[v1.role];
  return ROLE_QUI[role] || 'Wallet';
}

// ------------------------------------------------------------ les gabarits (anglais)
const SIGNAL_TITRE = {
  dev_connu: (v) => 'Known dev launch' + (v ? ' (' + devNeutre(v) + ')' : ''),
  usine_ignition: () => 'Launch on an IGNITION factory',
  wallet_ignition: () => 'Launch by the IGNITION team wallet',
  finance_relay: () => 'Launch by a wallet funded from IGNITION Solana wallets',
  image_ignition: () => 'Launch with an image hosted by IGNITION',
  dev_2eth: (v) => 'Dev buys ' + ethTxt(v) + ' ETH at launch',
  plateforme: (v) => (sur(v && v.nom, 16) || 'Platform') + ' launch with ' + ethTxt(v && v.eth) + ' ETH from the dev',
  relais: () => 'Launch through a graduation-factory relay',
};
function titre(t) {
  const c = (t && t.cle) || '', v = t ? t.val : null;
  switch (c) {
    case 'lancement': { const s = v && SIGNAL_TITRE[v.cle]; return s ? s(v.val) : 'New launch'; }
    case 't2': return 'Strong start at T+2 min (' + (fini(v && v.acheteurs) ? v.acheteurs : '?') + ' buyer' + s_(v && v.acheteurs) + ', ' + ethTxt(v && v.eth) + ' ETH)';
    case 'sortie': return 'EXIT: the dev is selling';
    case 'ignition_usine': return 'IGNITION launch on their factory';
    case 'ignition_contrat': return 'IGNITION wallet deployed a new ' + (v ? 'token' : 'contract');
    case 'copie': return (v && v.nom ? sur(v.nom, 32) || 'Smart wallet' : 'Smart wallet') + ' buys' + (v && v.courbe ? ' on the curve' : '');
    case 'rebond': return 'Bounce: -' + (fini(v && v.chute) ? Math.round(v.chute) : '?') + '% from the high, +' + (fini(v && v.rebond) ? Math.round(v.rebond) : '?') + '% from the low';
    case 'analyste': return v === SS.VERDICTS.ACHETER ? 'Analyst: entry setup met' : 'Analyst: watch';
    case 'createur': return 'Known creator launched a new token';
    case 'smart': return (fini(v && v.n) ? v.n : '?') + ' smart wallets bought within ' + (fini(v && v.min) ? v.min : '?') + ' min';
    default: return 'Smart money alert';
  }
}
const NON_LU = { achat_dev: 'dev buy', exemptions: 'anti-snipe exemptions', meta: 'token metadata', taxe: 'tax', usd: 'buy size', cap: 'market cap', age: 'token age', marche: 'market' };
/* l'analyste du brief : ses cles (smart_signaux.js), en anglais */
const A_RISQUE = {
  age_10_60: 'Age outside 10-60 min.', cap_sous_35k: 'Market cap not under $35k.', signal_recent: 'No buy under 5 min old from the tracked snipers.',
  liquidite_5k: 'Liquidity under $5,000.', impact_5pct: 'Buy impact above 5%.', dev_moins_25: 'The dev holds 25% or more of the supply.',
  pas_rugger: 'Dev known for pulling liquidity.', lp_pas_wallet: 'Liquidity held by a wallet.', pas_taxe: 'Buy or sell tax.',
  pas_bundle: 'Launch-team bundle in the first minute.', cap_sous_100k: 'Market cap above $100k.', age_sous_6h: 'More than 6 h after launch.',
  pas_deja_x3: 'Already 3x since launch.', dev_ne_vend_pas: 'The dev is selling.', pas_que_bots: 'Only fast bots or the launch team bought.',
  pas_airdrop: 'Received as an airdrop.', aucun_signal: 'No signal from the tracked wallets.',
};
const A_INCONNU = {
  age_10_60: 'token age', cap_sous_35k: 'market cap', signal_recent: 'dev buyback after a fee claim', liquidite_5k: 'liquidity', impact_5pct: 'buy impact',
  dev_moins_25: 'dev share of supply', pas_rugger: 'dev history', lp_pas_wallet: 'liquidity holder', pas_taxe: 'tax', pas_bundle: 'first-minute buyers',
  cap_sous_100k: 'market cap', age_sous_6h: 'token age', pas_deja_x3: 'multiple since launch', dev_ne_vend_pas: 'dev sales', pas_que_bots: 'tracked buys',
};
function risque(r) {
  const c = (r && r.cle) || '', v = r ? r.val : null;
  switch (c) {
    case 'dev_vend': return 'The dev or their wallets are selling: exit.';
    case 'relais': return 'A graduation-factory relay is involved: bundles, sell fast.';
    case 'plateforme_petit': return 'Launched through ' + (sur(v, 16) || 'a platform') + ' without 1 ETH from the dev.';
    case 'achat_dev_minuscule': return v === 0 || !fini(v) ? 'No dev buy at launch.' : 'Tiny dev buy (' + v.toFixed(4) + ' ETH).';
    case 'exemptions': return 'Only ' + (fini(v) ? v : '?') + ' anti-snipe exemption' + s_(v) + '.';
    case 'logo_sniper': return 'Logo taken from a sniper tool.';
    case 'pas_de_x': return 'No X (Twitter) link.';
    case 'taxe': return 'Creator tax of ' + (fini(v) ? v : '?') + '%.';
    case 'copieur_ignition': return 'Gas signature of an IGNITION copycat.';
    case 'inconnues': return 'Not read: ' + ((Array.isArray(v) ? v : []).map((x) => NON_LU[x]).filter(Boolean).join(', ') || 'some facts') + '.';
    case 'rebond': return 'A bounce can fall back under the low: stop just below it.';
    case 'sans_marche': return 'No market until a pool is created.';
    case 'pas_jeton': return 'A contract is not a token (no symbol).';
    case 'retraits': return 'This creator pulled the liquidity on ' + (fini(v) ? v : '?') + ' earlier token' + s_(v) + '.';
    case 'drapeaux': return (fini(v) ? v : '?') + ' red flag' + s_(v) + ' on this creator’s tokens.';
    case 'smart_regle': return '“Smart” is the owner’s rule on past tokens, not a prediction.';
    case 'analyste': return A_RISQUE[v] || 'About 7 trades in 10 lose: keep the stake small and fixed.';
    case 'analyste_inconnu': return 'Unknown ' + (A_INCONNU[v] || 'fact') + ': this danger cannot be ruled out.';
    case 'sept_sur_dix': return 'About 7 trades in 10 lose: keep the stake small and fixed.';
    default: return 'Most launches fall 60-90% after their first peak.';
  }
}
/** Le risque principal du verdict de l'analyste, en CODE : meme ordre que
 *  smart_signaux.risquePrincipal (danger observe, donnee manquante d'un danger,
 *  aucun signal, sinon 7 sur 10). */
function risqueAnalyste(v) {
  const k = v && v.conditions; if (!k) return { cle: 'sept_sur_dix' };
  const tout = k.acheter.concat(k.eviter);
  const echec = tout.find((c) => c.etat === 'echec' && (SS.DANGERS.has(c.cle) || c.regle === 'avoid'));
  if (echec) return { cle: 'analyste', val: echec.cle };
  const inc = tout.find((c) => c.etat === 'inconnu' && (SS.DANGERS.has(c.cle) || c.regle === 'avoid'));
  if (inc) return { cle: 'analyste_inconnu', val: inc.cle };
  if (v.verdict === SS.VERDICTS.EVITER && v.raisons && v.raisons[0] === 'aucun_signal') return { cle: 'analyste', val: 'aucun_signal' };
  return { cle: 'sept_sur_dix' };
}
const OBJECTIF = 'sell 75% at 2x, keep 25% for a rare 10x';
const OBJECTIF_A = 'at 2x sell 70-80%, keep 20-30% with a wide trailing stop; nothing after 3-4 h: exit';
function plan(p) {
  const c = (p && p.cle) || 'jaune', v = (p && p.val) || {};
  if (c === 'rouge') return { entree: 'none', stop: '-', objectif: v.sortie ? 'exit now' : '-' };
  if (c === 'vert') return { entree: 'small fixed stake' + (fini(v.prixCap) ? ' (market cap ~' + usd(v.prixCap) + ')' : ''), stop: fini(v.stopCap) ? 'market cap ' + usd(v.stopCap) + ' (5% under the low)' : '30% trailing stop', objectif: OBJECTIF };
  if (c === 'analyste_vert') return { entree: 'small fixed stake' + (fini(v.mise) ? ' (~$' + Math.round(v.mise) + ')' : ''), stop: '-30%', objectif: OBJECTIF_A };
  if (c === 'analyste_jaune') return { entree: 'none yet, watch', stop: '-30% if you enter', objectif: OBJECTIF_A };
  return { entree: 'none yet, watch', stop: '30% trailing if you enter', objectif: OBJECTIF };
}
function promoTexte(p, maintenant) {
  if (p === undefined) return 'not checked';
  if (!p || typeof p !== 'object') return 'not read';
  const il = (t) => (fini(t) ? ' ' + duree((maintenant - t) / 60000) + ' ago' : '');
  const pubs = Array.isArray(p.pubs) ? p.pubs.length : 0;
  const parts = [p.profil ? 'paid profile' + il(p.profil.t) : 'no paid profile', pubs ? pubs + ' ad' + s_(pubs) : 'no ads',
    fini(p.boosts) && p.boosts ? p.boosts + ' boost' + s_(p.boosts) + (p.boostsRecents ? ', ' + p.boostsRecents + ' in 24 h' : '') : 'no boosts'];
  return parts.join(' · ') + (p.pousse ? ' - the team is pushing (scams pay too)' : '');
}
function etatTexte(f) {
  const l = [fini(f.age_min) ? duree(f.age_min) + ' old' : 'age unknown'];
  if (f.courbe) {
    if (f.courbe.gradue) l.push('curve graduated');
    else if (fini(f.courbe.eth) && fini(f.courbe.seuil_eth) && f.courbe.seuil_eth > 0) l.push('curve ' + ethTxt(f.courbe.eth) + ' / ' + ethTxt(f.courbe.seuil_eth) + ' ETH (' + Math.round(f.courbe.eth / f.courbe.seuil_eth * 100) + '%)');
    else l.push('on the Pons curve');
  }
  if (fini(f.cap_usd)) l.push('market cap ' + usd(f.cap_usd) + ' (' + (f.cap_source === 'curve' ? 'curve, last trade' : 'DexScreener, not verified') + ')');
  return l.join(' · ');
}
function quiDetail(q) {
  const d = [];
  if (fini(q.eth)) d.push('dev buy ' + ethTxt(q.eth) + ' ETH');
  if (fini(q.usd)) d.push('bought for ' + usd(q.usd));
  if (fini(q.apresLancementMin)) d.push(duree(q.apresLancementMin) + ' after launch');
  if (fini(q.ilYaMin)) d.push(duree(Math.max(0, q.ilYaMin)) + ' ago');
  if (fini(q.lancements)) d.push(q.lancements + ' earlier launch' + (q.lancements === 1 ? '' : 'es') + ' read');
  return d.join(', ');
}

/**
 * La FICHE publique : les seuls champs que le joueur voit, tous construits
 * ici. `pub` (de l'appelant) : categorie, verdict, titre {cle, val}, symbole,
 * ageMin, courbe {eth, seuilEth, gradue}, capUsd, capSource ('curve'|'dex'),
 * qui [{ adresse, role, eth, usd, apresLancementMin, ilYaMin, lancements }],
 * promo (objet | null | undefined), risque {cle, val}, plan {cle, val}.
 */
function construitFiche(jeton, pub, o) {
  const p = pub || {};
  const j = adr(jeton);
  const expl = /^https:\/\/[a-z0-9.-]+$/.test(String((o && o.explorer) || '').replace(/\/$/, '')) ? String(o.explorer).replace(/\/$/, '') : EXPLORER_DEFAUT;
  const verdict = ['vert', 'jaune', 'rouge'].includes(p.verdict) ? p.verdict : 'jaune';
  const categorie = CATEGORIES.includes(p.categorie) ? p.categorie : 'pons';
  const f = {
    v: 1, categorie, verdict, titre: titre(p.titre), symbole: symbolePropre(p.symbole), jeton: j,
    age_min: arrondi(num(p.ageMin), 1),
    courbe: p.courbe ? { eth: num(p.courbe.eth), seuil_eth: num(p.courbe.seuilEth), gradue: !!p.courbe.gradue } : null,
    cap_usd: num(p.capUsd) !== null ? Math.round(p.capUsd) : null, cap_source: p.capSource === 'curve' ? 'curve' : num(p.capUsd) !== null ? 'dex' : null,
    qui: (Array.isArray(p.qui) ? p.qui : []).map((q) => ({ a: adr(q && q.adresse), q })).filter((x) => x.a).slice(0, 6)
      .map(({ a, q }) => ({ nom: nomPublic(a, q.role), adresse: null, detail: quiDetail(q) || null })),
    promo: promoTexte(p.promo, (o && o.maintenant) || Date.now()),
    risque: risque(p.risque),
    plan: plan(p.plan),
    liens: j ? { dexscreener: DEXSCREENER + j, explorer: expl + '/token/' + j } : null,
  };
  const jm = jugeParMesure(f.verdict, o && o.mesure);
  if (jm.mesure) { f.verdict = jm.verdict; f.mesure = jm.mesure; }
  if (p.refDifferee) f.ref_differee = true;
  f.etat = etatTexte(f);
  return f;
}
/** Le texte Telegram (HTML) et le texte brut, depuis la fiche SEULE. */
function textes(f) {
  const nom = f.symbole ? '$' + f.symbole.replace(/^\$/, '') : (f.jeton ? f.jeton.slice(0, 8) + '…' : '?');
  const qui = f.qui.length ? f.qui.map((q) => q.nom + (q.adresse ? ' ' + q.adresse : '') + (q.detail ? ' (' + q.detail + ')' : '')).join('; ') : 'no tracked wallet or known dev';
  const p = f.plan;
  const corps = [
    ['Age and state', f.etat], ['Who', qui], ['DexScreener promo', f.promo], ['Main risk', f.risque],
    ['Plan', 'entry ' + p.entree + '; stop ' + p.stop + '; target ' + p.objectif],
  ];
  if (f.mesure && f.mesure.texte) corps.push(['Track record', f.mesure.texte]);
  const html = [`${EMOJI[f.verdict]} <b>${esc(f.titre)} — ${esc(nom)}</b>`];
  const brut = [`${EMOJI[f.verdict]} ${f.titre} — ${nom}`];
  if (f.jeton) { html.push(`<code>${f.jeton}</code>`); brut.push(f.jeton); }
  for (const [k, v] of corps) { html.push(`• ${k}: ${esc(v)}`); brut.push(`• ${k}: ${v}`); }
  if (f.liens) { html.push(`<a href="${esc(f.liens.dexscreener)}">DexScreener</a> · <a href="${esc(f.liens.explorer)}">Explorer</a>`); brut.push('DexScreener: ' + f.liens.dexscreener, 'Explorer: ' + f.liens.explorer); }
  html.push(`Results after each alert: <a href="${SITE}">swoleeswoge.dog</a>`); brut.push('Results after each alert: ' + SITE);
  html.push(FIN); brut.push(FIN);
  return { html: html.join('\n'), brut: brut.join('\n') };
}

// ------------------------------------------------------------ la mesure (pure)
/** Une ligne -> sa mesure publique (pourcentages contre la reference). */
function mesureVue(r) {
  const m = jsonOu(r.mesures, {});
  const ref = num(r.ref_prix) !== null && r.ref_prix > 0 ? r.ref_prix : null;
  const pct = (x) => (ref && fini(x) ? arrondi((x / ref - 1) * 100, 1) : null);
  const paliers = {};
  for (const x of PALIERS) {
    const v = m[x];
    paliers[x] = !v ? null : v.manque ? { manque: true } : { pct: pct(v.p), min: v.m, source: v.s };
  }
  const differee = !!(jsonOu(r.fiche, {}) || {}).ref_differee;
  return { id: r.id, ref: ref ? { prix: ref, source: r.ref_source, retard_s: fini(r.ref_t) && fini(r.t) ? r.ref_t - r.t : null, differee: differee && fini(r.ref_t) && fini(r.t) && r.ref_t - r.t > REF_RETARD_MAX_S } : null,
    ref_differee: differee,
    paliers, meilleur_pct: pct(r.haut), pire_pct: pct(r.bas), releves: r.obs_n || 0, fini: !!r.fini };
}
/** Le bilan par categorie. Une alerte ROUGE (eviter, sortir) n'entre pas dans
 *  sa categorie : la part qui « monte » y dirait l'inverse ; elles ont leur
 *  propre ligne. Sous BILAN_ASSEZ mesures a +30 : aucune conclusion. */
function bilan(rows) {
  const out = {};
  const ligne = (l) => {
    const avec = l.map(mesureVue).filter((x) => x.ref);
    const a30 = avec.map((x) => x.paliers[PALIER_BILAN]).filter((x) => x && fini(x.pct)).map((x) => x.pct);
    const assez = a30.length >= BILAN_ASSEZ;
    const meilleurs = avec.map((x) => x.meilleur_pct).filter(fini);
    return { n: l.length, mesurees: avec.length, n30: a30.length, assez, seuil: BILAN_ASSEZ,
      part_montee30: assez ? arrondi(a30.filter((x) => x > 0).length / a30.length * 100, 1) : null,
      mediane30: assez ? arrondi(mediane(a30), 1) : null,
      meilleur_pct: assez && meilleurs.length ? Math.max(...meilleurs) : null };
  };
  for (const c of CATEGORIES) out[c] = Object.assign({ libelle: LIBELLE_CAT[c] }, ligne(rows.filter((r) => r.categorie === c && r.verdict !== 'rouge')));
  out.rouge = Object.assign({ libelle: LIBELLE_CAT.rouge }, ligne(rows.filter((r) => r.verdict === 'rouge')));
  out.tout = Object.assign({ libelle: 'All green and yellow alerts' }, ligne(rows.filter((r) => r.verdict !== 'rouge')));
  return out;
}
function jsonOu(s, d) { try { return s == null ? d : (typeof s === 'string' ? JSON.parse(s) : s); } catch (e) { return d; } }

// ------------------------------------------------------------ l'instance
/**
 * deps :
 *   base()        -> la base smart money (smart_base) ou null (pas encore ouverte)
 *   horloge, prendre (fetch), env, explorer, note(genre, texte)
 *   tg            { notifyChat(chat, texte) -> Promise<bool> }
 *   prixCourbe(j) -> { prix } | null   (la courbe Pons suivie, sans reseau)
 */
function cree(deps) {
  const C = config(deps.env);
  const B = () => (typeof deps.base === 'function' ? deps.base() : deps.base) || null;
  const maintenantS = () => Math.floor(deps.horloge() / 1000);
  const note = (g, t) => { try { if (deps.note) deps.note(g, t); } catch (e) { /* rien */ } };
  const compteurs = () => Object.assign({ publiees: 0, tg_envoyees: 0, tg_plafond: 0, tg_refusees: 0, tg_sans_canal: 0, http_prix: 0, http_refusees: 0 }, B().meta('public_compteurs') || {});
  const compte = (k, n) => { const c = compteurs(); c[k] = (c[k] || 0) + (n || 1); B().meta('public_compteurs', c); };
  /* fenetres glissantes d'une heure, gardees dans la meta (survivent au redemarrage) */
  const fenetre = (cle, now) => (B().meta(cle) || []).filter((x) => now - x < 3600);

  async function envoieTg(texte, now) {
    if (!C.tgChat) { compte('tg_sans_canal'); return 'sans_canal'; }
    const l = fenetre('public_tg_envois', now);
    if (l.length >= C.maxH) { compte('tg_plafond'); return 'plafond'; }
    l.push(now); B().meta('public_tg_envois', l);
    let ok = false;
    try { ok = !!(deps.tg && typeof deps.tg.notifyChat === 'function' && await deps.tg.notifyChat(C.tgChat, texte)); } catch (e) { ok = false; }
    compte(ok ? 'tg_envoyees' : 'tg_refusees');
    return ok ? 'envoye' : 'refuse';
  }

  /** Prix USD par jeton, DexScreener tokens/v1, UN appel (30 jetons au plus). */
  async function prixDs(jetons) {
    const out = new Map();
    const l = [...new Set(jetons.map(adr).filter(Boolean))].slice(0, LOT_DS);
    if (!l.length) return out;
    const now = maintenantS();
    const f = fenetre('public_http', now);
    if (f.length >= PRIX_HTTP_H) { compte('http_refusees'); return out; }
    f.push(now); B().meta('public_http', f); compte('http_prix');
    try {
      const r = await deps.prendre(SRC.DS + '/tokens/v1/robinhood/' + l.join(','), { headers: { accept: 'application/json', 'user-agent': 'swoge-smart-money/1.0 (read-only)' }, signal: AbortSignal.timeout(DS_DELAI_MS) });
      if (!r || !r.ok) return out;
      for (const p of SRC.pairesDs(JSON.parse(await r.text()))) {
        const j = p.base && p.base.adresse;
        if (!l.includes(j) || !(p.prixUsd > 0)) continue;
        const d = out.get(j);
        if (!d || (p.liquiditeUsd || 0) > d.liq) out.set(j, { prix: p.prixUsd, liq: p.liquiditeUsd || 0, source: 'dex' });
      }
    } catch (e) { /* un prix illisible reste illisible : rien d'invente */ }
    return out;
  }
  function prixCourbe(j) {
    try { const x = typeof deps.prixCourbe === 'function' ? deps.prixCourbe(j) : null; return x && x.prix > 0 && !x.gradue ? { prix: x.prix, source: 'curve' } : null; } catch (e) { return null; }
  }

  /** Une alerte partie au proprietaire : la ligne publique, une fois par cle. */
  async function publie(genre, cle, jeton, pub) {
    if (!C.actif || !B() || !pub) return null;
    if (B().un('SELECT id FROM publiques WHERE cle = ?', [cle])) return null;
    const now = maintenantS();
    let mesure = null;
    const src = SOURCE_DE_CAT[pub.categorie];
    if (src && pub.verdict === 'vert' && typeof deps.mesure === 'function') { try { mesure = deps.mesure(src); } catch (e) { mesure = null; } }
    const f = construitFiche(jeton, pub, { explorer: deps.explorer, maintenant: deps.horloge(), mesure });
    if (f.mesure && f.mesure.retrograde) compte('retrogradees');
    const tx = textes(f);
    /* le prix de reference : celui que l'appelant a lu, la courbe suivie, sinon DexScreener */
    let ref = num(pub.prixUsd) !== null && pub.prixUsd > 0 ? { prix: pub.prixUsd, source: pub.capSource === 'curve' ? 'curve' : 'dex' } : (f.jeton ? prixCourbe(f.jeton) : null);
    if (!ref && f.jeton) ref = (await prixDs([f.jeton])).get(f.jeton) || null;
    const publieT = now + C.delaiS;
    const tg = C.delaiS > 0 ? (C.tgChat ? 'attente' : 'sans_canal') : await envoieTg(tx.html, now);
    if (C.delaiS > 0 && !C.tgChat) compte('tg_sans_canal');
    B().pose('publiques', { t: now, publie_t: publieT, cle, genre, categorie: f.categorie, verdict: f.verdict, jeton: f.jeton, fiche: f, texte: tx.brut, tg,
      ref_prix: ref ? ref.prix : null, ref_t: ref ? now : null, ref_source: ref ? ref.source : null, mesures: {}, haut: ref ? ref.prix : null, bas: ref ? ref.prix : null,
      obs_t: ref ? now : null, obs_n: ref ? 1 : 0, fini: 0 });
    compte('publiees');
    /* borne : les plus anciennes MESUREES partent d'abord */
    const n = (B().un('SELECT count(*) n FROM publiques') || {}).n || 0;
    if (n > JOURNAL_MAX) B().ecris('DELETE FROM publiques WHERE id IN (SELECT id FROM publiques WHERE fini = 1 ORDER BY id ASC LIMIT ?)', [n - JOURNAL_MAX]);
    note('public', `${genre} ${f.jeton || ''} publiee (${f.categorie}, ${f.verdict}), canal : ${tg}`);
    return { fiche: f, texte: tx, tg };
  }

  /** Au fil des cycles : les envois retardes, puis les releves de prix. */
  let enCours = false;
  async function tic() {
    if (!C.actif || !B()) return { fait: 'off' };
    if (enCours) return { fait: 'deja' };
    enCours = true;
    const bilanTic = { envoyes: 0, releves: 0, fermees: 0, http: 0 };
    try {
      const now = maintenantS();
      /* 1. le canal, pour les alertes dont le delai est passe */
      for (const r of B().tous("SELECT id, texte, fiche, publie_t FROM publiques WHERE tg = 'attente' AND publie_t <= ? ORDER BY id ASC LIMIT 20", [now])) {
        const tg = await envoieTg(textes(jsonOu(r.fiche, {})).html, now);
        B().ecris('UPDATE publiques SET tg = ? WHERE id = ?', [tg, r.id]);
        bilanTic.envoyes++;
      }
      /* 2. les releves */
      const vivantes = B().tous('SELECT * FROM publiques WHERE fini = 0 ORDER BY id ASC');
      const dues = [];
      for (const r of vivantes) {
        /* reference differee : rien ne court avant le premier prix ; puis les paliers comptent depuis lui */
        const differee = !!(jsonOu(r.fiche, {}) || {}).ref_differee;
        if (differee && r.ref_prix == null) {
          if (now - r.t > REF_DIFFEREE_S) { B().ecris('UPDATE publiques SET fini = 1 WHERE id = ?', [r.id]); bilanTic.fermees++; continue; }
          if (r.jeton && (!r.obs_t || now - r.obs_t >= OBS_MIN * 60)) dues.push({ r, m: jsonOu(r.mesures, {}), age: 0, ouvert: null, rang: 1, differee });
          continue;
        }
        const age = (now - (differee && fini(r.ref_t) ? r.ref_t : r.t)) / 60;
        const m = jsonOu(r.mesures, {});
        let change = false;
        for (const x of PALIERS) if (!m[x] && age > x + tolerance(x)) { m[x] = { manque: true }; change = true; }
        if (age > FIN_MIN) { B().ecris('UPDATE publiques SET mesures = ?, fini = 1 WHERE id = ?', [JSON.stringify(m), r.id]); bilanTic.fermees++; continue; }
        if (change) B().ecris('UPDATE publiques SET mesures = ? WHERE id = ?', [JSON.stringify(m), r.id]);
        const ouvert = PALIERS.find((x) => !m[x] && age >= x && age <= x + tolerance(x)) || null;
        const sansRef = r.ref_prix == null && now - r.t <= REF_RETARD_MAX_S;
        const relire = r.ref_prix != null && (!r.obs_t || now - r.obs_t >= OBS_MIN * 60);
        if (r.jeton && (ouvert || sansRef || relire)) dues.push({ r, m, age, ouvert, rang: ouvert ? 0 : sansRef ? 1 : 2 });
      }
      dues.sort((a, b) => a.rang - b.rang || (a.r.obs_t || 0) - (b.r.obs_t || 0));
      const lot = dues.slice(0, LOT_DS);
      const prix = new Map();
      for (const d of lot) { const c = prixCourbe(d.r.jeton); if (c) prix.set(d.r.jeton, c); }
      const reste = lot.filter((d) => !prix.has(d.r.jeton)).map((d) => d.r.jeton);
      if (reste.length) { bilanTic.http++; for (const [k, v] of await prixDs(reste)) prix.set(k, v); }
      for (const d of lot) {
        const p = prix.get(d.r.jeton);
        /* une alerte differee sans prix : l'essai est note (obs_t), pour ne la relire que toutes les OBS_MIN */
        if (!p) { if (d.differee) B().ecris('UPDATE publiques SET obs_t = ? WHERE id = ?', [now, d.r.id]); continue; }
        const r = d.r;
        let ref = r.ref_prix, refT = r.ref_t, refS = r.ref_source;
        /* une reference lue plus de REF_RETARD_MAX_S apres l'alerte n'en est pas une — sauf differee */
        if (ref == null && (d.differee || now - r.t <= REF_RETARD_MAX_S)) { ref = p.prix; refT = now; refS = p.source; }
        if (d.ouvert) d.m[d.ouvert] = { p: p.prix, m: arrondi(d.age, 1), s: p.source };
        const haut = ref == null ? null : Math.max(r.haut == null ? p.prix : r.haut, p.prix), bas = ref == null ? null : Math.min(r.bas == null ? p.prix : r.bas, p.prix);
        B().ecris('UPDATE publiques SET ref_prix = ?, ref_t = ?, ref_source = ?, mesures = ?, haut = ?, bas = ?, obs_t = ?, obs_n = ? WHERE id = ?',
          [ref, refT, refS, JSON.stringify(d.m), haut, bas, now, (r.obs_n || 0) + 1, r.id]);
        bilanTic.releves++;
      }
    } catch (e) { note('public', 'releves : ' + String((e && e.message) || e).slice(0, 120)); }
    finally { enCours = false; }
    return bilanTic;
  }

  /** La route publique : GET /ai/smart/alertes?depuis=<id>. */
  function vue(depuis) {
    const base = { actif: false, raison: C.raison || 'not ready', alertes: [], vivantes: [], bilan: null, paliers: PALIERS, palier_bilan: PALIER_BILAN, seuil: BILAN_ASSEZ, tg: null };
    if (!C.actif) return base;
    if (!B()) return Object.assign(base, { raison: 'not ready' });
    const now = maintenantS();
    const d = Number.isSafeInteger(depuis) && depuis > 0 ? depuis : 0;
    const ligne = (r) => ({ id: r.id, t: r.t, categorie: r.categorie, verdict: r.verdict, fiche: jsonOu(r.fiche, null), texte: r.texte, mesure: mesureVue(r) });
    const alertes = d ? B().tous('SELECT * FROM publiques WHERE id > ? AND publie_t <= ? ORDER BY id DESC LIMIT ?', [d, now, ROUTE_NOUVELLES_MAX])
      : B().tous('SELECT * FROM publiques WHERE publie_t <= ? ORDER BY id DESC LIMIT ?', [now, ROUTE_DERNIERES]);
    /* les alertes deja recues dont la mesure avance encore (ou vient de finir) */
    const vivantes = d ? B().tous('SELECT * FROM publiques WHERE id <= ? AND publie_t <= ? AND (fini = 0 OR t >= ?) ORDER BY id DESC LIMIT ?', [d, now, now - (FIN_MIN + 10) * 60, ROUTE_NOUVELLES_MAX]) : [];
    const visibles = B().tous('SELECT id, t, categorie, verdict, ref_prix, ref_t, ref_source, mesures, haut, bas, obs_n, fini FROM publiques WHERE publie_t <= ?', [now]);
    const dernier = (B().un('SELECT max(id) m FROM publiques WHERE publie_t <= ?', [now]) || {}).m || 0;
    const c = compteurs();
    return { actif: true, t: now, dernier_id: dernier, alertes: alertes.map(ligne), vivantes: vivantes.map(mesureVue), bilan: bilan(visibles),
      paliers: PALIERS, palier_bilan: PALIER_BILAN, seuil: BILAN_ASSEZ, fin_min: FIN_MIN, tg: C.tgLien ? { lien: C.tgLien } : null,
      compteurs: { publiees: c.publiees, retrogradees: c.retrogradees || 0, canal_envoyees: c.tg_envoyees, canal_plafond: c.tg_plafond, canal_refusees: c.tg_refusees }, max_h: C.maxH };
  }

  return { config: C, publie, tic, vue };
}

/** `depuis` de la requete : entier >= 0, sinon null (400). */
function litDepuis(q) {
  if (q == null || q === '') return 0;
  return /^\d{1,12}$/.test(String(q)) ? Number(q) : null;
}

module.exports = { config, cree, construitFiche, textes, bilan, mesureVue, risque, risqueAnalyste, titre, plan, nomPublic, litDepuis, tolerance,
  jugeParMesure, PALIERS, FIN_MIN, OBS_MIN, BILAN_ASSEZ, PALIER_BILAN, JOURNAL_MAX, PRIX_HTTP_H, LOT_DS, MAX_H_DEFAUT, REF_RETARD_MAX_S, REF_DIFFEREE_S, SOURCE_DE_CAT, CATEGORIES, FIN, SITE };
