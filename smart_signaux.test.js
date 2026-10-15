'use strict';
/*
 * Le verdict du brief du proprietaire (smart_signaux.js, smart_listes.js, 15/10/2026).
 *
 * L'intention, dans l'ordre ou elle coute de l'argent :
 *  1. la table : chaque wallet du brief, son role, sa source ; les adresses
 *     partielles reconnues par PREFIXE, et seulement elles ;
 *  2. chaque regle du brief, une par une : ce qu'elle voit, ce qu'elle rend ;
 *  3. FAIL CLOSED : un « inconnu » sur n'importe quelle condition interdit
 *     ACHETER, et un danger observe rend EVITER ;
 *  4. les detecteurs : bundle de la 1re minute, « bon dev », airdrop ;
 *  5. le texte au format du brief, avec et sans modele — et un modele qui
 *     change le verdict n'est pas cru.
 */
const assert = require('assert');
const L = require('./smart_listes');
const SS = require('./smart_signaux');
const { BRIEF } = require('./smart_brief');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) { n++; console.log('  ok   ' + m); } else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || JSON.stringify(a) === JSON.stringify(b), `${m} (lu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)})`);

const SNIPER = '0x7632bd8e72767ed67a724c564c42ceea98e81180';
const SUIVI_FORT = '0x1ad70bc7ac98539dada8f97360d353687f6c29d6';
const SUIVI_FAIBLE = '0xc8b580755bf30d1dcce76bfcfe29e8129637460e';
const BOT = '0x2fd1887e5d99014cb0b8884f06560ed20d65003d';
const EQUIPE = '0xe1e514008f797303634c28ea2e6bb8fe2968350c';
const JETON = '0x' + 'ab'.repeat(20);
const T = 1_790_000_000_000;
const min = (m) => m * 60000;

/** Le jeton IDEAL du brief : tout est vrai. Chaque essai en change UNE chose. */
function ideal(o) {
  return Object.assign({
    jeton: JETON, symbole: 'GOOD', maintenant: T, lanceT: T - min(20), mcUsd: 20000, liqUsd: 8000, miseUsd: 100,
    achats: [{ wallet: SNIPER, t: T - min(2), tx: '0x01' }],
    premiereMinute: { n: 4, acheteurs: [] }, devPart: 5, rugger: false, lp: { tenue: 'contrat' }, taxe: { achat: 0, vente: 0 },
    multiple: 1.8, devVend: false, dev: { achatLancementEth: 0.05, claims: null, rachats: [] }, airdrop: false,
  }, o || {});
}
const etatDe = (v, cle) => v.conditions.acheter.concat(v.conditions.eviter).find((c) => c.cle === cle).etat;

// ================================================== 1. la table
console.log('-- 1. les wallets du brief --');
{
  egal(L.WALLETS.length, 18, '18 lignes : Sniper 1 + 2 lies, 3 suivis, 3 du groupe, 6 bots, 1 sniper perdant, 1 equipe, 1 dev');
  ok(L.WALLETS.every((w) => w.source.startsWith('brief du proprietaire du 15/10/2026')), 'chaque ligne porte sa source : le brief du 15/10/2026');
  const r = (a) => (L.roleDe(a) || {}).role;
  egal(r(SNIPER), 'SNIPER_1', 'Sniper 1');
  ok(/29 %/.test(L.roleDe(SNIPER).source) && L.roleDe(SNIPER).mesure.partGagnants === 29 && L.roleDe(SNIPER).mesure.jetons === 100, 'Sniper 1 garde les chiffres du brief : 29 % de gagnants sur ~100 jetons');
  egal(r('0x381d02f5578a1d5872d095006fcc2dfeacb7b60c') + r('0x3ef061aa8a4b83699a2a1c63049e147a4b4000c1'), 'SNIPER_1_LIESNIPER_1_LIE', 'les deux wallets probablement au meme proprietaire');
  egal([SUIVI_FORT, '0xb255c02311fea12523d8d15c4938f0a53d2a2870', SUIVI_FAIBLE].map((a) => r(a) + ':' + L.roleDe(a).signal).join(), 'SUIVRE:fort,SUIVRE:fort,SUIVRE:faible',
    'les trois suivis ; 0xc8b58075 n\'est PAS dans la regle 3 : signal faible');
  egal(L.roleDe(SUIVI_FORT).mesure.partGagnants, 34, '0x1ad70bc7 : 34 % de gagnants (brief)');
  egal(r('0x84b68f5785a29435f17d2d3857a0d378a1489f36'), 'GROUPE_A_TESTER', 'groupe a tester, adresse entiere');
  egal(L.duRole('BOT_RAPIDE').length, 6, 'six bots rapides');
  ok(L.duRole('BOT_RAPIDE').every((a) => L.roleDe(a).signal === 'neutre'), 'bots : neutres (« leur achat ne prouve rien »)');
  egal(r('0xcc00d47039dc20754eaeb3a21f7891226d52534c') + ':' + L.roleDe('0xcc00d47039dc20754eaeb3a21f7891226d52534c').signal, 'SNIPER_PERDANT:neutre', 'sniper du 1er bloc, perdant');
  egal(r(EQUIPE) + ':' + L.roleDe(EQUIPE).signal, 'BUNDLE:negatif', 'equipe de lancement : signal NEGATIF');
  egal(r('0x7d17bfa7383e42e8df00ae042dcaf24748dd69b9') + ':' + L.roleDe('0x7d17bfa7383e42e8df00ae042dcaf24748dd69b9').mesure.fraisReclamesEth, 'DEV_IGNITION:34.75', 'dev IGNITION, 34,75 ETH reclames (brief)');
  /* les adresses PARTIELLES */
  const p1 = L.roleDe('0x5aafc1f2' + '0'.repeat(32));
  ok(p1 && p1.role === 'GROUPE_A_TESTER' && p1.partielle === true, '0x5aafc1f2… : reconnue par prefixe, et dite partielle');
  ok(L.roleDe('0xAD01C20D' + 'f'.repeat(32)) && L.roleDe('0xAD01C20D' + 'f'.repeat(32)).partielle, '0xad01c20d… : prefixe, majuscules comprises');
  egal(L.roleDe('0x5aafc1f3' + '0'.repeat(32)), null, 'un chiffre de plus ou de moins : rien');
  egal(L.roleDe('0x5aafc1f2'), null, 'le prefixe seul n\'est pas une adresse');
  egal(L.roleDe('pas une adresse'), null, 'une chaine quelconque : rien');
  egal(L.adressesCompletes().length, 16, 'les adresses ENTIERES (filtre du noeud) : 16, sans les deux partielles');
  ok(L.adressesCompletes().every((a) => /^0x[0-9a-f]{40}$/.test(a)), 'toutes au format');
  ok(BRIEF.startsWith('Tu es un analyste de memecoins sur Robinhood Chain (chain id 4663') && BRIEF.endsWith('Termine par « Pas un conseil financier. »'), 'le brief est garde mot pour mot (debut et fin)');
  ok(L.adressesCompletes().every((a) => BRIEF.includes(a)), 'chaque adresse entiere de la table est dans le brief');
}

// ================================================== 2. les regles une par une
console.log('-- 2. chaque regle du brief --');
{
  const v0 = SS.verdict(ideal());
  egal(v0.verdict, 'ACHETER', 'le jeton ideal : ACHETER');
  egal(v0.inconnues, [], 'aucune inconnue');
  // regle 1 : age 10-60
  egal(etatDe(SS.verdict(ideal({ lanceT: T - min(9) })), 'age_10_60'), 'echec', 'regle 1 : 9 min, trop tot');
  egal(SS.verdict(ideal({ lanceT: T - min(9) })).verdict, 'SURVEILLER', '9 min avec Sniper 1 : SURVEILLER');
  egal(etatDe(SS.verdict(ideal({ lanceT: T - min(10) })), 'age_10_60'), 'ok', 'regle 1 : 10 min, borne comprise');
  egal(etatDe(SS.verdict(ideal({ lanceT: T - min(60) })), 'age_10_60'), 'ok', 'regle 1 : 60 min, borne comprise');
  egal(etatDe(SS.verdict(ideal({ lanceT: T - min(61) })), 'age_10_60'), 'echec', 'regle 1 : 61 min');
  egal(SS.verdict(ideal({ lanceT: T - min(6 * 60 + 1) })).verdict, 'EVITER', 'plus de 6 h : EVITER');
  egal(SS.verdict(ideal({ lanceT: T - min(6 * 60) })).verdict, 'SURVEILLER', '6 h pile : pas encore EVITER');
  // regle 2 : capi < 35 k$
  egal(SS.verdict(ideal({ mcUsd: 34999 })).verdict, 'ACHETER', 'regle 2 : 34 999 $');
  egal(SS.verdict(ideal({ mcUsd: 35000 })).verdict, 'SURVEILLER', 'regle 2 : 35 000 $ -> SURVEILLER (35-100 k$)');
  egal(SS.verdict(ideal({ mcUsd: 100000 })).verdict, 'SURVEILLER', '100 000 $ : encore SURVEILLER');
  egal(SS.verdict(ideal({ mcUsd: 100001 })).verdict, 'EVITER', 'au-dessus de 100 k$ : EVITER');
  // regle 3 : signal recent
  egal(SS.verdict(ideal({ achats: [{ wallet: SNIPER, t: T - min(5), tx: '0x1' }] })).verdict, 'ACHETER', 'regle 3 : Sniper 1 il y a 5 min pile');
  const vieux = SS.verdict(ideal({ achats: [{ wallet: SNIPER, t: T - min(6), tx: '0x1' }] }));
  egal(vieux.verdict + ':' + etatDe(vieux, 'signal_recent'), 'SURVEILLER:inconnu', 'regle 3 : Sniper 1 il y a 6 min, rachat du dev non lu -> inconnu, SURVEILLER');
  egal(SS.verdict(ideal({ achats: [{ wallet: SUIVI_FORT, t: T - min(1), tx: '0x1' }] })).verdict, 'ACHETER', 'regle 3 : 0x1ad70bc7 il y a 1 min');
  egal(SS.verdict(ideal({ achats: [{ wallet: '0xb255c02311fea12523d8d15c4938f0a53d2a2870', t: T - min(1), tx: '0x1' }] })).verdict, 'ACHETER', 'regle 3 : 0xb255c023 il y a 1 min');
  const faible = SS.verdict(ideal({ achats: [{ wallet: SUIVI_FAIBLE, t: T - min(1), tx: '0x1' }] }));
  egal(faible.verdict, 'SURVEILLER', 'un seul signal faible (0xc8b58075) : SURVEILLER, jamais ACHETER');
  egal(SS.verdict(ideal({ achats: [{ wallet: '0x5aafc1f2' + '1'.repeat(32), t: T - min(1), tx: '0x1' }] })).verdict, 'SURVEILLER', 'le groupe a tester (adresse partielle) : SURVEILLER');
  egal(SS.verdict(ideal({ achats: [{ wallet: '0x381d02f5578a1d5872d095006fcc2dfeacb7b60c', t: T - min(1), tx: '0x1' }] })).verdict, 'SURVEILLER', 'un wallet lie a Sniper 1 : signal faible');
  // le rachat du dev apres reclamation, regle 3
  const rachat = SS.verdict(ideal({ achats: [], dev: { achatLancementEth: 0.05, claims: [T - min(10)], rachats: [T - min(3)] } }));
  egal(etatDe(rachat, 'signal_recent'), 'ok', 'regle 3 : le dev rachete 7 min apres une reclamation, il y a 3 min');
  egal(rachat.verdict, 'SURVEILLER', '... mais sans aucun achat de la liste, « pas que des bots » reste inconnu : pas ACHETER');
  // regle 4 : liquidite et impact
  egal(etatDe(SS.verdict(ideal({ liqUsd: 4999 })), 'liquidite_5k'), 'echec', 'regle 4 : 4 999 $ de liquidite');
  egal(SS.impactAchat(100, 5000), 3.8, 'impact de 100 $ sur 5 000 $ de liquidite : 3,8 % (100 / (2 500 + 100))');
  egal(SS.impactAchat(100, 3800), 5, 'impact de 100 $ sur 3 800 $ : 5,0 %');
  egal(etatDe(SS.verdict(ideal({ liqUsd: 6000, miseUsd: 200 })), 'impact_5pct'), 'echec', 'regle 4 : 200 $ sur 6 000 $ = 6,3 % -> echec');
  egal(SS.verdict(ideal({ liqUsd: 6000, miseUsd: 200 })).verdict, 'SURVEILLER', 'impact trop fort : SURVEILLER');
  egal(etatDe(SS.verdict(ideal({ impactPct: 5 })), 'impact_5pct'), 'ok', 'un impact donne (5 %) est pris tel quel');
  // regle 5 : dangers observes -> EVITER
  egal(SS.verdict(ideal({ devPart: 25 })).verdict, 'EVITER', 'regle 5 : le dev tient 25 % -> EVITER');
  egal(SS.verdict(ideal({ devPart: 24.9 })).verdict, 'ACHETER', 'regle 5 : 24,9 % passe');
  egal(SS.verdict(ideal({ rugger: true })).verdict, 'EVITER', 'regle 5 : rugger connu -> EVITER');
  egal(SS.verdict(ideal({ lp: { tenue: 'wallet' } })).verdict, 'EVITER', 'regle 5 : liquidite tenue par un wallet -> EVITER');
  egal(SS.verdict(ideal({ lp: { partLibre: 94 } })).verdict, 'EVITER', 'paire v2 : 94 % brules ou verrouilles -> un wallet peut retirer le reste');
  egal(SS.verdict(ideal({ lp: { partLibre: 95 } })).verdict, 'ACHETER', 'paire v2 : 95 % -> ok');
  egal(SS.verdict(ideal({ taxe: { achat: 0, vente: 1 } })).verdict, 'EVITER', 'regle 5 : 1 % de taxe a la vente -> EVITER');
  egal(SS.verdict(ideal({ premiereMinute: { n: 15 } })).verdict, 'EVITER', 'regle 5 : 15 acheteurs dans la 1re minute -> bundle, EVITER');
  egal(SS.verdict(ideal({ premiereMinute: { n: 14 } })).verdict, 'ACHETER', '14 acheteurs : pas un bundle massif');
  // EVITER
  egal(SS.verdict(ideal({ multiple: 3 })).verdict, 'EVITER', 'deja ×3 -> EVITER');
  egal(SS.verdict(ideal({ multiple: 2.99 })).verdict, 'ACHETER', '×2,99 : pas encore');
  egal(SS.verdict(ideal({ devVend: true })).verdict, 'EVITER', 'le dev vend -> EVITER');
  const bots = SS.verdict(ideal({ achats: [{ wallet: BOT, t: T - min(1), tx: '0x1' }] }));
  egal(bots.verdict + ':' + bots.raisons.join(), 'EVITER:pas_que_bots', 'seulement un bot rapide -> EVITER (« leur achat ne prouve rien »)');
  const equipe = SS.verdict(ideal({ achats: [{ wallet: EQUIPE, t: T - min(1), tx: '0x1' }] }));
  ok(equipe.verdict === 'EVITER' && equipe.raisons.includes('pas_que_bots') && equipe.raisons.includes('pas_bundle'), 'seulement l\'equipe de lancement -> EVITER, et c\'est un bundle');
  const mele = SS.verdict(ideal({ achats: [{ wallet: SNIPER, t: T - min(1), tx: '0x1' }, { wallet: EQUIPE, t: T - min(1), tx: '0x2' }] }));
  egal(mele.verdict + ':' + mele.raisons.join(), 'EVITER:pas_bundle', 'Sniper 1 ET l\'equipe de lancement : le signal negatif l\'emporte (EVITER)');
  egal(SS.verdict(ideal({ achats: [{ wallet: SNIPER, t: T - min(1) }, { wallet: BOT, t: T - min(1) }] })).verdict, 'ACHETER', 'Sniper 1 et un bot : le bot ne prouve rien, il n\'empeche rien');
  egal(SS.verdict(ideal({ airdrop: true })).verdict, 'EVITER', 'jeton recu en airdrop -> EVITER');
  egal(SS.verdict(ideal({ achats: [] })).verdict + ':' + SS.verdict(ideal({ achats: [] })).raisons.join(), 'EVITER:aucun_signal', 'aucun wallet de la liste : EVITER, « aucun signal »');
  egal(SS.verdict(ideal({ achats: [{ wallet: '0x' + '12'.repeat(20), t: T - min(1) }] })).achats.length, 0, 'un acheteur hors liste est ignore');
}

// ================================================== 3. fail closed
console.log('-- 3. fail closed : une inconnue interdit ACHETER --');
{
  const inconnues = {
    age_10_60: { lanceT: null }, cap_sous_35k: { mcUsd: null }, liquidite_5k: { liqUsd: null }, dev_moins_25: { devPart: null }, pas_rugger: { rugger: null },
    lp_pas_wallet: { lp: null }, pas_taxe: { taxe: null }, pas_bundle: { premiereMinute: null }, pas_deja_x3: { multiple: null }, dev_ne_vend_pas: { devVend: null },
  };
  for (const [cle, o] of Object.entries(inconnues)) {
    const v = SS.verdict(ideal(o));
    ok(v.verdict !== 'ACHETER' && v.inconnues.includes(cle), `${cle} inconnu : ${v.verdict}, jamais ACHETER`);
  }
  egal(SS.verdict(ideal({ taxe: { achat: 0, vente: null } })).verdict, 'SURVEILLER', 'une taxe a moitie lue : inconnue, SURVEILLER');
  egal(SS.verdict(ideal({ lp: { tenue: null } })).verdict, 'SURVEILLER', 'le code du detenteur de la LP non lu : SURVEILLER');
  const tout = SS.verdict({ jeton: JETON, maintenant: T, achats: [{ wallet: SNIPER, t: T - min(1) }] });
  egal(tout.verdict, 'SURVEILLER', 'rien d\'autre que Sniper 1 : SURVEILLER (rien ne prouve un danger, rien ne l\'exclut)');
  ok(tout.inconnues.length >= 9, 'et chaque donnee manquante est nommee (' + tout.inconnues.length + ')');
  for (const d of SS.DANGERS) ok(SS.verdict(ideal()).conditions.acheter.find((c) => c.cle === d), 'le danger ' + d + ' est une condition d\'achat');
}

// ================================================== 4. les detecteurs
console.log('-- 4. bundle, bon dev, airdrop --');
{
  const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951', R = '0x' + '77'.repeat(20);
  const tr = [];
  /* 16 acheteurs dans la 1re minute, chacun par un routeur qui fait suivre ; un 17e apres */
  for (let i = 0; i < 16; i++) { const q = '0x' + (0x10 + i).toString(16).padStart(2, '0').repeat(20); tr.push({ tx: 't' + i, bloc: 100 + i * 10, de: PM, vers: R, valeur: 1000n }, { tx: 't' + i, bloc: 100 + i * 10, de: R, vers: q, valeur: 1000n }); }
  tr.push({ tx: 'tard', bloc: 100 + 700, de: PM, vers: R, valeur: 5n }, { tx: 'tard', bloc: 800, de: R, vers: '0x' + 'ee'.repeat(20), valeur: 5n });
  /* le dev vend dans la 1re minute : il ne compte pas comme acheteur */
  const DEV = '0x' + 'de'.repeat(20);
  tr.push({ tx: 'dv', bloc: 120, de: DEV, vers: PM, valeur: 9n });
  const a = SS.acheteursFenetre(tr, { exclus: [PM, DEV], blocDebut: 100, blocFin: 700 });
  egal(a.length, 16, '16 acheteurs distincts dans la 1re minute (le routeur qui fait suivre n\'en est pas un)');
  ok(!a.includes(R), 'le routeur est un relais (net nul), pas un acheteur');
  ok(!a.includes('0x' + 'ee'.repeat(20)), 'l\'acheteur d\'apres la minute n\'y est pas');
  egal(SS.verdict(ideal({ premiereMinute: { n: a.length } })).verdict, 'EVITER', '16 acheteurs dans la minute : bundle massif, EVITER');
  // le bon dev
  const bd = SS.detecteBonDev({ achatLancementEth: 0.0625, claims: [T - min(120), T - min(60)], rachats: [T - min(50)] });
  egal([bd.petitAchat, bd.claimsReguliers, bd.rachatApresClaim, bd.bon].join(), 'true,true,true,true', 'bon dev : petit achat (0,0625 ETH), 2 reclamations, rachat 10 min apres');
  egal(SS.detecteBonDev({ achatLancementEth: 0.5, claims: [T], rachats: [T] }).petitAchat, false, '0,5 ETH au lancement : pas un « petit » achat (seuil 0,1 ETH, choisi)');
  egal(SS.detecteBonDev({ achatLancementEth: 0, claims: [], rachats: [] }).bon, false, 'aucun achat au lancement : pas la recette');
  egal(SS.detecteBonDev({ achatLancementEth: 0.05, claims: [T - min(120)], rachats: [T - min(60)] }).rachatApresClaim, false, 'rachat 60 min apres la reclamation : trop tard (30 min, choisi)');
  egal(SS.detecteBonDev({ achatLancementEth: 0.05, claims: null, rachats: [T] }).bon, null, 'reclamations non lues : le detecteur ne conclut pas');
  // l'airdrop
  egal(SS.estAirdrop([{ tx: '0x1' }], []), true, 'recu, jamais achete : airdrop (ignore)');
  egal(SS.estAirdrop([{ tx: '0x1' }], [{ tx: '0x1' }]), false, 'recu ET achete : un achat');
  egal(SS.estAirdrop([], []), false, 'rien recu : rien');
  // le multiple depuis le lancement
  const Q = 1n << 96n;
  egal(SS.multipleSqrt(Q, Q * 2n, false), 4, 'sqrtP ×2 (ETH token1) : le prix fait ×4');
  egal(SS.multipleSqrt(Q * 2n, Q, true), 4, 'sqrtP /2 (ETH token0) : le prix du jeton fait ×4');
  egal(SS.multipleSqrt(0n, Q, true), null, 'sans prix de lancement : null');
}

// ================================================== 5. le texte
console.log('-- 5. le format du brief, avec et sans modele --');
(async () => {
  const v = SS.verdict(ideal());
  const g = SS.texteGabarit(v, ideal());
  ok(g.startsWith('<b>🟢 ACHETER — GOOD</b>'), 'gabarit : la ligne du verdict avec son emoji');
  ok(/Âge et capitalisation : 20 min · 20 k\$/.test(g), 'gabarit : age et capitalisation');
  ok(/Sniper 1 \(0x7632…1180\) il y a 2 min/.test(g), 'gabarit : quel wallet de la liste, et quand');
  ok(/Risque principal : /.test(g), 'gabarit : le risque principal');
  ok(/stop −30 %/.test(g) && /à ×2 vendre 70 à 80 %/.test(g) && /garder 20 à 30 % avec un stop suiveur large/.test(g) && /rien après 3 à 4 h : sortir/.test(g), 'gabarit : le plan du brief (stop, objectif, part gardee, sortie)');
  ok(/entrée : petite mise fixe \(~100 \$\)/.test(g), 'gabarit : l\'entree, la mise fixe');
  ok(g.trim().endsWith('Pas un conseil financier.'), 'gabarit : finit par « Pas un conseil financier. »');
  const s = SS.texteGabarit(SS.verdict(ideal({ mcUsd: 50000 })), ideal({ mcUsd: 50000 }));
  ok(s.startsWith('<b>🟡 SURVEILLER') && /entrée : aucune pour l’instant/.test(s), 'SURVEILLER : pas d\'entree maintenant, et pourquoi');
  const e = SS.texteGabarit(SS.verdict(ideal({ taxe: { achat: 5, vente: 5 } })), ideal());
  ok(e.startsWith('<b>🔴 ÉVITER') && /taxe/.test(e), 'EVITER : le risque principal est le danger observe (la taxe)');
  const x = SS.texteGabarit(SS.verdict(ideal({ symbole: '<script>' })), ideal({ symbole: '<script>' }));
  ok(!x.includes('<script>') && x.includes('&lt;script&gt;'), 'le symbole (choisi par le createur) est echappe');

  // sans cle : aucun appel
  let appels = 0;
  const r0 = await SS.redige(v, ideal(), { cleAnthropic: '', fetch: async () => { appels++; } });
  egal(r0.par + ':' + appels, 'gabarit:0', 'sans cle : le gabarit, aucun appel');
  // avec cle : le modele met en mots
  let corps = null;
  const bon = '🟢 ACHETER — GOOD\n• âge 20 min, capi 20 k$\n• Sniper 1 il y a 2 min\n• risque : 7 trades sur 10 perdent\n• plan : stop −30 %, ×2 vendre 75 %, garder 25 %\nPas un conseil financier.';
  const fauxModele = (texte, status) => async (url, init) => { appels++; corps = JSON.parse(init.body); return { ok: (status || 200) === 200, status: status || 200, json: async () => ({ content: [{ type: 'text', text: texte }] }) }; };
  const r1 = await SS.redige(v, ideal(), { cleAnthropic: 'k', fetch: fauxModele(bon) });
  egal(r1.par, 'modele', 'avec cle : le modele redige');
  egal(corps.system, BRIEF, 'son systeme est le brief, mot pour mot');
  egal(corps.model, require('./agent_modele').MODELE_DEFAUT, 'le modele est celui de agent_modele.js (aucun nouveau client)');
  ok(/DÉJÀ décidé/.test(corps.messages[0].content) && /🟢 ACHETER/.test(corps.messages[0].content), 'il recoit le verdict DEJA decide');
  ok(r1.texte.includes('Pas un conseil financier.') && r1.texte.startsWith('<b>🟢 ACHETER'), 'le texte rendu garde le verdict et la phrase finale');
  const r2 = await SS.redige(v, ideal(), { cleAnthropic: 'k', fetch: fauxModele(bon.replace('🟢 ACHETER', '🟡 SURVEILLER')) });
  egal(r2.par, 'gabarit', 'un modele qui CHANGE le verdict n\'est pas cru : gabarit');
  const r3 = await SS.redige(v, ideal(), { cleAnthropic: 'k', fetch: fauxModele(bon.replace('Pas un conseil financier.', '')) });
  egal(r3.par, 'gabarit', 'sans « Pas un conseil financier. » : gabarit');
  const r4 = await SS.redige(v, ideal(), { cleAnthropic: 'k', fetch: fauxModele(bon + '\nÉVITER plutôt ?\nPas un conseil financier.') });
  egal(r4.par, 'gabarit', 'un second verdict dans le texte : gabarit');
  const r5 = await SS.redige(v, ideal(), { cleAnthropic: 'k', fetch: fauxModele(bon, 500) });
  egal(r5.par + ':' + /500/.test(r5.raison), 'gabarit:true', 'HTTP 500 : gabarit, et la raison');
  const r6 = await SS.redige(v, ideal(), { cleAnthropic: 'k', fetch: async () => { throw new Error('reseau'); } });
  egal(r6.par, 'gabarit', 'erreur reseau : gabarit');
  const r7 = await SS.redige(v, ideal(), { cleAnthropic: 'k', desactive: true, fetch: fauxModele(bon) });
  egal(r7.par, 'gabarit', 'SMART_ANALYSTE_LLM=0 : gabarit');
  egal(SS.texteGabarit(v, ideal()), r0.texte, 'le gabarit est le meme texte que la reponse sans cle');
  const c = SS.pourLaColonie(v, ideal());
  ok(c.verdict === 'ACHETER' && c.jeton === JETON && c.wallets[0].role === 'SNIPER_1' && !JSON.stringify(c).match(/[éèàù]/), 'ce que recoit la colonie : des codes, aucune phrase francaise (page publique)');
  // le plan du brief, dans la forme du rejeu
  egal([SS.PLAN_BRIEF.coupe, SS.PLAN_BRIEF.p1, SS.PLAN_BRIEF.v1, SS.PLAN_BRIEF.suivDepart, SS.PLAN_BRIEF.suivEcart].join(), '30,100,75,100,100', 'plan du brief : coupe -30 %, ×2 vend 75 %, stop suiveur de 100 points apres ×2');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + (n + rates) : 'tout passe : ' + n + ' verifications'));
  process.exitCode = rates ? 1 : 0;
})().catch((e) => { console.log('EXCEPTION : ' + (e && e.stack || e)); process.exitCode = 1; });
