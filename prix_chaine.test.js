'use strict';
/* ============================================================================
 * LA LECTURE DE CHAINE DES POSITIONS — CE QUE CET ESSAI FIGE (17/10/2026)
 *
 * La mesure : DexScreener sert le prix de la chaine 30 a 60 s en retard (une
 * piscine v3, onze mises a jour), et les regles de sortie ne tournent qu'une
 * fois par tour. Avant de laisser une boucle rapide declencher une sortie
 * (lot 2), on l'OBSERVE (lot 1). Cet essai tient les quatre promesses de
 * l'observation :
 *
 *   1. les lecteurs rendent le bon prix — v2, v3, v4, token0/token1 dans les
 *      deux ordres, decimales differentes, clef v4 recalculee au bit pres ;
 *   2. la boucle est eteinte par defaut, ne lit rien sans position, tient son
 *      plafond d'appels et son delai, se tait sur un 429 ;
 *   3. elle ne touche JAMAIS une position (gelee : la moindre ecriture leve) ;
 *   4. l'audit : sur un chemin de prix ecrit a la main, l'arret suiveur part
 *      sur la chaine N secondes avant le tour — la ligne dit N et les points.
 * ==========================================================================*/
const fs = require('fs');
const { ethers } = require('ethers');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');
const proche = (a, b, tol, m) => ok(typeof a === 'number' && Math.abs(a - b) <= tol, m + ' [' + a + ' ~ ' + b + ']');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/prixchaine-');
process.env.AI_COLONIE = '0';
delete process.env.COLONIE_PRIX_CHAINE;
const PC = require('./prix_chaine');

/* ---------------------------------------------------------- la fausse chaine */
const h64 = (x) => BigInt(x).toString(16).padStart(64, '0');
const motAdr = (a) => '000000000000000000000000' + a.toLowerCase().slice(2);
const ETH4 = '0x0000000000000000000000000000000000000000';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const BASE = '0x8a19d2f16b17e77380eb48a5272dc6f59e607652';    /* > WETH : token1 en v3 */
const BAS = '0x0000000000000000000000000000000000000abc';     /* < tout : token0 */
const USD6 = '0xffff00000000000000000000000000000000ffff';    /* une monnaie a 6 decimales */
const V2A = '0x1111111111111111111111111111111111111111';
const V2B = '0x2222222222222222222222222222222222222222';
const V3 = '0x3333333333333333333333333333333333333333';
const ALGEBRA = '0x4444444444444444444444444444444444444444';
const sqrtDe = (p10) => BigInt(Math.round(Math.sqrt(p10) * Math.pow(2, 96)));
const CLE4 = [ETH4, BASE, 3000, 60, ETH4];
const ID4 = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['(address,address,uint24,int24,address)'], [CLE4]));

function fausseChaine(opt) {
  const o = opt || {};
  const ch = {
    appels: [], requetes: 0, statut: o.statut || 200,
    decimales: Object.assign({ [BASE]: 18, [BAS]: 18, [WETH]: 18, [USD6]: 6 }, o.decimales || {}),
    pools: Object.assign({
      [V2A]: { ver: 'v2', t0: BASE, t1: USD6, r0: 1000n * 10n ** 18n, r1: 2000n * 10n ** 6n },      /* base token0 : 2 USD6 */
      [V2B]: { ver: 'v2', t0: BAS, t1: USD6, r0: 1000n * 10n ** 18n, r1: 500n * 10n ** 6n },      /* 0,5 USD6 */
      [V3]: { ver: 'v3', t0: WETH, t1: BASE, sqrt: sqrtDe(1e7) },                                   /* base token1 : 1e-7 WETH */
      [ALGEBRA]: { ver: 'autre', t0: WETH, t1: BASE },
    }, o.pools || {}),
    v4: { [ID4]: { cle: CLE4, sqrt: sqrtDe(1 / 4e-8) } },                                           /* ETH token0, base token1 : 4e-8 ETH */
    attend: o.attend || null,
  };
  const err = { code: -32000, message: 'execution reverted' };
  function repond(q) {
    ch.appels.push({ t: ch.horloge ? ch.horloge() : Date.now(), m: q.method });
    if (q.method === 'eth_blockNumber') return { result: '0x' + (91317000).toString(16) };
    if (q.method === 'eth_getLogs') {
      const f = q.params[0];
      if (f.address.toLowerCase() !== PC.PM4 || f.topics[0] !== PC.SUJET_INIT) return { result: [] };
      const x = ch.v4[String(f.topics[1]).toLowerCase()];
      if (!x || parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) + 1 > 10000000) return x ? { error: { code: -32000, message: 'only 10000000 are allowed' } } : { result: [] };
      const data = ethers.utils.defaultAbiCoder.encode(['uint24', 'int24', 'address', 'uint160', 'int24'], [x.cle[2], x.cle[3], x.cle[4], x.sqrt, 0]);
      return { result: [{ topics: [PC.SUJET_INIT, f.topics[1], '0x' + motAdr(x.cle[0]), '0x' + motAdr(x.cle[1])], data }] };
    }
    if (q.method !== 'eth_call') return { error: { code: -32601, message: 'method not found' } };
    const to = q.params[0].to.toLowerCase(), d = q.params[0].data;
    const s4 = d.slice(0, 10);
    if (to === PC.STATE_VIEW && s4 === PC.SEL.getSlot0) {
      const x = ch.v4['0x' + d.slice(10).toLowerCase()];
      return x ? { result: '0x' + h64(x.sqrt) + h64(0) + h64(0) + h64(3000) } : { result: '0x' + h64(0).repeat(4) };
    }
    if (s4 === PC.SEL.decimals && ch.decimales[to] !== undefined) return { result: '0x' + h64(ch.decimales[to]) };
    const p = ch.pools[to];
    if (!p) return { error: err };
    if (s4 === PC.SEL.token0) return { result: '0x' + motAdr(p.t0) };
    if (s4 === PC.SEL.token1) return { result: '0x' + motAdr(p.t1) };
    if (s4 === PC.SEL.slot0 && p.ver === 'v3') return { result: '0x' + h64(p.sqrt) + h64(0).repeat(6) };
    if (s4 === PC.SEL.getReserves && p.ver === 'v2') return { result: '0x' + h64(p.r0) + h64(p.r1) + h64(1) };
    return { error: err };
  }
  ch.fetch = async (url, opts) => {
    ch.requetes++;
    ch.urls = (ch.urls || []).concat(url);
    if (ch.attend) {
      await new Promise((ok2, ko) => { opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; ko(e); }); });
    }
    const corps = JSON.parse(opts.body);
    const statut = ch.statut;
    return { status: statut, json: async () => (statut === 429 ? { error: { code: 429, message: 'Too Many Requests' } }
      : corps.map((q) => Object.assign({ jsonrpc: '2.0', id: q.id }, repond(q)))) };
  };
  return ch;
}
const muettes = { danger: () => null, suiveur: () => null, paliers: () => [], prise: () => null, min: -99, max: 900 };
function instance(o) {
  const E = { positions: o.positions || [] };
  let t = o.t0 || 1e12;
  const ch = o.chaine || fausseChaine();
  ch.horloge = () => t;
  const I = PC.cree({ env: o.env === undefined ? { COLONIE_PRIX_CHAINE: 'observe' } : o.env, etat: () => E,
    positions: () => E.positions, regles: o.regles || muettes, fetch: ch.fetch, maintenant: () => t,
    noeud: () => ({ url: 'http://tete', cle: 'chaine' }), noeudJournaux: () => ({ url: 'http://journaux', cle: 'chaine' }) });
  return { I, E, ch, avance: (ms) => { t += ms; }, maintenant: () => t };
}
const position = (adr, pool, prix0, extra) => Object.assign({ sym: 'T' + pool.slice(2, 5), adr, pool, prix0, t0: 1e12 - 1000, liq0: 5000, mise: 50 }, extra || {});

(async () => {
  console.log('-- les lecteurs, a la main --');
  {
    proche(PC.prixV2(1000n * 10n ** 18n, 2000n * 10n ** 6n, 18, 6, true), 2, 1e-12, 'v2, base token0 (18 dec) contre 6 dec : 2');
    proche(PC.prixV2(2000n * 10n ** 6n, 1000n * 10n ** 18n, 6, 18, false), 2, 1e-12, 'v2, base token1 : le meme prix, ordre inverse');
    eq(PC.prixV2(0n, 5n, 18, 18, true), null, 'v2, reserve vide : pas de prix (jamais zero)');
    proche(PC.prixSqrt(sqrtDe(1e7), 18, 18, false) / 1e-7, 1, 1e-9, 'v3, base token1 : 1e-7 depuis sqrtPriceX96');
    proche(PC.prixSqrt(sqrtDe(1e7), 18, 18, true) / 1e7, 1, 1e-9, 'v3, base token0 : l inverse');
    proche(PC.prixSqrt(sqrtDe(2 * 1e12), 6, 18, true) / 2, 1, 1e-9, 'v3, decimales 6/18 : le facteur 10^(d0-d1) est applique');
    const log = { topics: [PC.SUJET_INIT, ID4, '0x' + motAdr(ETH4), '0x' + motAdr(BASE)],
                  data: ethers.utils.defaultAbiCoder.encode(['uint24', 'int24', 'address', 'uint160', 'int24'], [3000, 60, ETH4, 1n, 0]) };
    const k = PC.cleV4DuJournal(log, ID4);
    ok(k && k.c0 === ETH4 && k.c1 === BASE, 'v4 : la clef du journal Initialize se recompose en l identifiant');
    const faux = Object.assign({}, log, { data: ethers.utils.defaultAbiCoder.encode(['uint24', 'int24', 'address', 'uint160', 'int24'], [500, 60, ETH4, 1n, 0]) });
    eq(PC.cleV4DuJournal(faux, ID4), null, 'v4 : un journal dont la clef ne recompose pas l identifiant est refuse');
    eq(PC.SEL.getSlot0, '0xc815641c', 'selecteur StateView.getSlot0(bytes32) (keccak, verifie sur la chaine le 17/10)');
    eq(PC.SEL.slot0 + PC.SEL.getReserves, '0x3850c7bd0x0902f1ac', 'selecteurs slot0() et getReserves()');
  }

  console.log('\n-- eteinte par defaut --');
  {
    const x = instance({ env: {}, positions: [position(BASE, V3, 1)] });
    ok(!x.I.actif(), 'sans COLONIE_PRIX_CHAINE, la boucle est eteinte');
    await x.I.passage();
    eq(x.ch.requetes, 0, 'eteinte : aucune requete');
    ok(!x.I.demarre(), 'eteinte : demarre() ne pose aucune minuterie');
    const y = instance({ env: { COLONIE_PRIX_CHAINE: '1' }, positions: [position(BASE, V3, 1)] });
    ok(!y.I.actif() && y.I.vue().valeurInconnue, '« 1 » n allume pas : seul « observe » allume, et la vue dit la valeur inconnue');
    eq(PC.reglages({ COLONIE_PRIX_CHAINE: 'observe', COLONIE_PRIX_CHAINE_MS: '200' }).ms, 1000, 'la cadence a un plancher de 1 s');
    eq(PC.reglages({}).ms, 2000, 'la cadence par defaut : 2 s');
    process.env.COLONIE_PRIX_CHAINE = '';
  }

  console.log('\n-- sans position, aucun appel --');
  {
    const x = instance({ positions: [] });
    for (let i = 0; i < 10; i++) { await x.I.passage(); x.avance(2000); }
    eq(x.ch.requetes, 0, 'dix passages sans position : zero requete');
  }

  console.log('\n-- v2, v3, v4 de bout en bout, un lot par passage --');
  {
    /* Le meme jeton dans plusieurs piscines : des t0 differents, des positions differentes. */
    const ps = [position(BASE, V2A, 1, { t0: 1 }), position(BAS, V2B, 1, { t0: 2 }), position(BASE, V3, 1, { t0: 3 }),
                position(BASE, ID4, 1, { t0: 4 }), position(BASE, ALGEBRA, 1, { t0: 5 }), position(BASE, '0xpasunepiscine', 1, { t0: 6 })];
    const x = instance({ positions: ps });
    /* La note DexScreener de chaque piscine : le facteur en dollars et la coherence. */
    x.I.noteDex({ pool: V2A, usd: 1, natif: 2 });
    x.I.noteDex({ pool: V2B, usd: 1, natif: 0.5 });
    x.I.noteDex({ pool: V3, usd: 1, natif: 1e-7, eth: true });
    x.I.noteDex({ pool: ID4, usd: 1, natif: 4e-8, eth: true });
    for (let i = 0; i < 8; i++) { await x.I.passage(); x.avance(2000); }
    const O2 = Object.values(x.I._ombres());
    const parPool = (pool) => { const o = O2.find((z) => z.pool === pool.toLowerCase()); return o && o.ech.length ? o.ech[o.ech.length - 1].nat : null; };
    proche(parPool(V2A), 2, 1e-9, 'v2, base token0 : 2 lus sur la chaine');
    proche(parPool(V2B), 0.5, 1e-9, 'v2, base token0 18 dec contre 6 dec : 0,5');
    proche(parPool(V3) / 1e-7, 1, 1e-9, 'v3, base token1 contre WETH : 1e-7');
    proche(parPool(ID4) / 4e-8, 1, 1e-9, 'v4 par StateView, clef retrouvee dans le journal : 4e-8');
    const F = x.I._fiches();
    eq(F[ALGEBRA].etat, 'type inconnu', 'une piscine qui n est ni v2 ni v3 est ecartee, et comptee');
    eq(F['0xpasunepiscine'].etat, 'type inconnu', 'une adresse illisible aussi');
    eq((x.I.vue().piscines.ecartees || {})['type inconnu'], 2, 'la vue compte les deux');
    ok(x.ch.urls.filter((u) => u === 'http://journaux').length === 2, 'v4 : le bloc de tete et le journal vont au noeud des journaux, une fois chacun');
    /* En regime : un lot par passage, une lecture par position prete. */
    const avant = x.ch.appels.length, r0 = x.ch.requetes;
    await x.I.passage();
    eq(x.ch.requetes - r0, 1, 'en regime : UNE requete par passage');
    eq(x.ch.appels.length - avant, 4, 'et un eth_call par position prete (quatre)');
    const r = (pool) => { const o = O2.find((z) => z.pool === pool.toLowerCase()); return o.ech[o.ech.length - 1].r; };
    proche(r(V3), 0, 1e-6, 'la conversion par le facteur de DexScreener : chaine = DexScreener -> 0 % d ecart, aucun saut');
  }

  console.log('\n-- une lecture incoherente ne devient jamais un declenchement --');
  {
    const x = instance({ positions: [position(BASE, V3, 1)] });
    x.I.noteDex({ pool: V3, usd: 1, natif: 1e-7 * 1e12, eth: true });   /* une note qui dit 1e12 fois plus */
    for (let i = 0; i < 4; i++) { await x.I.passage(); x.avance(2000); }
    eq(x.I._fiches()[V3].etat, 'incoherent', 'facteur 1e12 contre DexScreener sur la meme piscine : ecartee');
    eq(Object.keys(x.I._ombres()).length, 0, 'et aucune ombre ne reste');
    const y = instance({ positions: [position(BASE, V3, 1)] });
    for (let i = 0; i < 3; i++) { await y.I.passage(); y.avance(2000); }
    const o = Object.values(y.I._ombres())[0];
    ok(o && o.ech.length >= 1 && o.joue === 0, 'sans note DexScreener : on lit, on garde, on ne rejoue RIEN');
  }

  console.log('\n-- le plafond d appels, le delai, le 429 --');
  {
    const ps = [position(BASE, V3, 1), position(BAS, V2B, 1)];
    const x = instance({ positions: ps, env: { COLONIE_PRIX_CHAINE: 'observe', COLONIE_PRIX_CHAINE_MAX_MIN: '7' } });
    x.I.noteDex({ pool: V3, usd: 1, natif: 1e-7, eth: true }); x.I.noteDex({ pool: V2B, usd: 1, natif: 0.5 });
    for (let i = 0; i < 90; i++) { await x.I.passage(); x.avance(2000); }
    const T = x.ch.appels.map((a) => a.t);
    let pire = 0;
    for (const t of T) pire = Math.max(pire, T.filter((u) => u >= t && u < t + 60000).length);
    ok(pire <= 7, 'jamais plus de 7 eth_call sur 60 s glissantes avec un plafond de 7 [' + pire + ']');
    ok(x.I.vue().appels.plafond > 0, 'les passages refuses par le plafond sont comptes');
    ok(T.length > 7, 'et la lecture reprend quand la minute se libere [' + T.length + ']');

    const y = instance({ positions: [position(BASE, V3, 1)], chaine: fausseChaine({ attend: true }),
                         env: { COLONIE_PRIX_CHAINE: 'observe', COLONIE_PRIX_CHAINE_DELAI_MS: '200' } });
    const t0 = Date.now();
    await y.I.passage();
    ok(Date.now() - t0 < 1500, 'un noeud qui ne repond pas : le passage rend la main au delai (' + (Date.now() - t0) + ' ms)');
    eq(y.I.vue().appels.delais, 1, 'et le delai est compte');

    const z = instance({ positions: [position(BASE, V3, 1)], chaine: fausseChaine({ statut: 429 }) });
    await z.I.passage();
    const r1 = z.ch.requetes;
    for (let i = 0; i < 25; i++) { z.avance(2000); await z.I.passage(); }
    eq(z.ch.requetes, r1, 'apres un 429 : silence pendant une minute');
    z.ch.statut = 200; z.avance(12000); await z.I.passage();
    eq(z.ch.requetes, r1 + 1, 'puis on reprend');
  }

  /* ------------------------------------------------------------- la colonie */
  process.env.COLONIE_PRIX_CHAINE = 'observe';
  const A = require('./ai_colonie');
  const P = A.prixChaine;
  const vraies = { danger: A.dangerSentinelle, suiveur: A.arretSuiveur, paliers: A.paliersFranchis, prise: A.avisDePrise, min: A.REND_MIN, max: A.REND_MAX };

  console.log('\n-- la colonie : la regle coupee en deux rend la meme chose --');
  {
    ok(A.prixChaine.actif(), 'COLONIE_PRIX_CHAINE=observe allume l instance de la colonie');
    eq(A.paliersFranchis({ paliers: { 1: true } }, 50).map((x) => x.k).join(','), '2', 'paliersFranchis : +50 % franchit le 2, pas le 1 deja vendu, pas le 3');
    eq(A.avisDePrise({}, 10), null, 'avisDePrise : sous GAIN_EXPLORE, rien');
    const av = A.avisDePrise({}, 30);
    ok(av && av.sur === false && av.cas.sortie === 'gain pris a +20-35%', 'avisDePrise : sans releve, un essai (pas une decision)');
    const S = A._etat();
    const e0 = S.sortieEssais || 0;
    A.avisDePrise({}, 30); A.avisDePrise({}, 30);
    eq(S.sortieEssais || 0, e0, 'avisDePrise ne fait pas avancer le compteur des essais');
    const r3 = [A.veutPrendre({}, 30), A.veutPrendre({}, 30), A.veutPrendre({}, 30)];
    eq(r3.filter(Boolean).length, 1, 'veutPrendre : toujours une fois sur trois');
    eq(A.regleDeSortie({ raison: 'trailing stop: fallen 21.0 points below its peak (+30.0%)' }), 'arret suiveur', 'la raison du suiveur se relit');
    eq(A.regleDeSortie({ raison: 'down 41% since entry — caught by the 45 s watch' }), 'sol coupe', 'la coupe du Veilleur aussi');
    eq(A.regleDeSortie({ par: 'closer' }), 'echeance', 'et l echeance');
  }

  console.log('\n-- elle ne touche JAMAIS une position --');
  {
    const gele = (o) => { Object.freeze(o); for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') gele(o[k]); return o; };
    const p = gele(position(BASE, V3, 1, { hautR: 12, paliers: {}, traits: { a: 'b' }, traj: [{ dt: 0, r: 0 }] }));
    const avant = JSON.stringify(p);
    const x = instance({ positions: [p], regles: vraies });
    x.I.noteDex({ pool: V3, usd: 1, natif: 1e-7, eth: true });
    const pas = [0, 30, 50, 90, 20, -50];   /* paliers, suiveur, gain, coupe : tout y passe */
    let leve = null;
    try {
      for (const r of pas) { x.ch.pools[V3].sqrt = sqrtDe(1 / (1e-7 * (1 + r / 100))); for (let i = 0; i < 3; i++) { await x.I.passage(); x.avance(2000); } }
    } catch (e) { leve = e; }
    eq(leve, null, 'une position GELEE : aucun passage ne leve (aucune ecriture tentee)');
    eq(JSON.stringify(p), avant, 'la position est identique au caractere pres');
    const o = Object.values(x.I._ombres())[0];
    ok(o && o.premiers['arret suiveur'] && o.premiers['sol coupe'] && o.premiers['palier 1'], 'et pourtant l ombre a vu le suiveur, la coupe et le palier');
  }

  console.log('\n-- l audit : le suiveur part sur la chaine N s avant le tour --');
  {
    const E = A._etat();
    const ch = fausseChaine();
    let horloge = Date.now();
    ch.horloge = () => horloge;
    P._pose({ fetch: ch.fetch, maintenant: () => horloge, oublie: true });
    const T0 = Date.now() - 80000;
    horloge = T0;
    const p = { sym: 'TST', adr: BASE, pool: V3, prix0: 0.0002, t0: T0 - 5000, prixLu: T0, mise: 50, liq0: 5000,
                traits: {}, tenueMin: 20, tenueBase: 20, score: 60, mcAchat: 10000, offre0: 5e7, traj: [] };
    E.positions = [p];
    /* DexScreener : 1e-7 ETH = 0,0002 $, soit l ETH a 2 000 $ ; la note a l entree. */
    P.noteDex({ pool: V3, usd: 0.0002, natif: 1e-7, eth: true });
    /* Le chemin de la chaine, en points depuis l entree, toutes les 2 s. */
    const chemin = [0, 5, 12, 25, 30, 20, 12, 9, 8, 6, 5, 4];
    const sec = {};
    for (let s = 0; s <= 78; s += 2) {
      const r = s / 2 < chemin.length ? chemin[s / 2] : 2;
      sec[s] = r;
      horloge = T0 + s * 1000;
      ch.pools[V3].sqrt = sqrtDe(1 / (1e-7 * (1 + r / 100)));
      if (s === 40) P.noteDex({ pool: V3, usd: 0.0002 * 1.30, natif: 1e-7 * 1.30, eth: true });   /* DexScreener sert le +30 de t=8 s */
      await P.passage();
    }
    const o = Object.values(P._ombres())[0];
    const f = o.premiers['arret suiveur'];
    ok(f && Math.abs(f.t - (T0 + 14000)) < 1, 'sur la chaine, le suiveur part a t=14 s (pic +30, redescendu a +9)');
    proche(f && f.r, 9, 1e-6, 'a +9 %');
    ok(o.premiers['palier 1'] && o.premiers['palier 1'].t === T0 + 6000, 'le palier +15 % est vu a t=6 s (+25)');
    /* Le tour : DexScreener voit encore le pic a +30 (le plus haut connu du
       tour d avant), puis +5 — le suiveur part au tour, maintenant. */
    p.hautR = 30;
    p.paliers = { 1: true, 2: false };
    const marche = { [BASE]: { prix: 0.0002 * 1.05, liq: 5000, src: 'DexScreener', lu: Date.now() } };
    const fermees = A.regle(marche);
    eq(fermees, 1, 'le tour ferme la position par l arret suiveur');
    const V = A.vue().prixChaine;
    const L = V.audit.find((a) => a.regle === 'arret suiveur');
    ok(L && L.n === 1 && L.cle === 'chain view · trailing stop', 'la ligne d audit du suiveur existe, n=1');
    ok(L && /too few exits to conclude \(1\/100\)/.test(L.verdict) && L.ptsMoyen === null, 'et elle refuse de conclure : chiffres caches sous 5, verdict sous 100');
    const l = V.lignes.find((x) => x.regle === 'arret suiveur');
    const N = (Date.now() - (T0 + 14000)) / 1000;
    proche(l && l.avance, N, 1, 'la ligne dit N : la chaine aurait declenche ' + Math.round(N) + ' s avant le tour');
    eq(l && l.rChaine, 9, 'rendement au declenchement sur la chaine : +9');
    eq(l && l.rChaineSortie, 2, 'rendement de la chaine au moment de la vraie sortie : +2');
    eq(l && l.pts, 7, 'points : +7 qu un ordre reel aurait touches de plus');
    eq(l && l.ptsLivre, 4, 'et +4 contre le rendement inscrit (+5, DexScreener)');
    const pr = V.audit.find((a) => a.regle === 'premiere regle');
    ok(pr && pr.n === 1, 'la ligne « premiere regle, toutes sorties » compte aussi cette sortie');
    ok(V.ecart.n > 10 && V.ecart.medianePct > 0, 'l ecart chaine/DexScreener est releve a chaque passage (n=' + V.ecart.n + ', mediane ' + V.ecart.medianePct + ' %)');
    const ret = (E.prixChaine.retards || [])[0];
    ok(ret && ret[0] === 32 && ret[1] === 32, 'le retard : DexScreener lu a 40 s sert le prix que la chaine avait a 8 s -> 32 s [' + JSON.stringify(ret) + ']');
    eq(Object.keys(P._ombres()).length, 0, 'l ombre de la position fermee est rendue');
    ok(/too few/.test(V.retard.verdict) && /too few/.test(V.ecart.verdict), 'sous 100 lectures, ecart et retard refusent de conclure aussi');
  }

  console.log('\n-- eteinte, la colonie ne garde rien --');
  {
    P._pose({ env: {}, oublie: true });
    const E = A._etat();
    delete E.prixChaine;
    const p = { sym: 'OFF', adr: BAS, pool: V2B, prix0: 1, t0: Date.now() - 60000, prixLu: Date.now(), mise: 50, liq0: 5000,
                traits: {}, tenueMin: 20, tenueBase: 20, hautR: 30, paliers: {} };
    E.positions = [p];
    P.noteDex({ pool: V2B, usd: 1, natif: 0.5 });
    await P.passage();
    A.regle({ [BAS]: { prix: 1.05, liq: 5000 } });
    eq(E.prixChaine, undefined, 'aucune ligne, aucun compteur, aucun etat : E.prixChaine n existe pas');
    eq(A.vue().prixChaine.mode, 'off', 'la vue dit « off »');
  }

  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log(rates ? `\nprix_chaine.test.js : RATES : ${rates}/${n}` : `\nprix_chaine.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
