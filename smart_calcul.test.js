'use strict';
/*
 * Les calculs du detecteur smart money (smart_calcul.js, 13/10/2026).
 *
 * GAIN et SCORE D'ABORD, sur des VALEURS REELLES : des journaux bruts de NILF et
 * BRODIE lus sur le noeud public (cache de la sonde du 13/10, vies entieres
 * jusqu'au bloc 83 886 079), figes dans essais/smart_money/. Les nombres
 * attendus ont ete calcules par un script Python INDEPENDANT
 * (smart_build/calibre/gain_independant.py : son propre decodage, sa propre
 * regle du beneficiaire, son propre gain), pas par le code essaye.
 * Puis : signes v2/v3/v4 (un recu v3 lu le 13/10), beneficiaire, premiers
 * acheteurs, marques aux deux bords de leur seuil, alertes, createur (recus
 * reels de BRODIE et astro), textes Verified / Not verified.
 */
const fs = require('fs');
const path = require('path');
const K = require('./smart_calcul');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) n++; else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || (typeof a === 'bigint' && typeof b === 'bigint' && a === b) || String(a) === String(b), `${m} (lu ${a}, attendu ${b})`);
const proche = (a, b, eps, m) => ok(a != null && Math.abs(a - b) <= eps, `${m} (lu ${a}, attendu ${b})`);
const ESS = path.join(__dirname, 'essais', 'smart_money');
const EX = JSON.parse(fs.readFileSync(path.join(ESS, 'extraits_reels.json'), 'utf8'));
const PR = JSON.parse(fs.readFileSync(path.join(ESS, 'premiers_nilf_brodie.json'), 'utf8'));
const OB = JSON.parse(fs.readFileSync(path.join(ESS, 'objets_reels.json'), 'utf8'));
const W = (n) => '0x' + String(n).padStart(40, '0');
const T = (a) => K.pad32(a);
const hex = (x) => '0x' + BigInt(x).toString(16);
const mot = (x) => { let v = BigInt(x); if (v < 0n) v += 2n ** 256n; return v.toString(16).padStart(64, '0'); };
const E = 10n ** 18n;

/** Les echanges d'un extrait reel. */
function echangesDe(e) {
  const evts = e.logs.map(K.decode).filter(Boolean);
  const piscine = { pool: e.pool, version: 4, ethEst0: true, hook: e.hook };
  return { evts, trades: K.echanges({ jeton: e.jeton, piscines: [piscine], evts }) };
}

// ================================================== 1. GAIN, valeurs reelles
console.log('-- 1. GAIN = sorti - entre + solde x prix (NILF, BRODIE : journaux reels) --');
{
  /* calcul independant (Python) : gain_independant.py, 13/10/2026 */
  const ATTENDU = {
    '0x90924c7d483cb1e1060c8de34acdf72aa54c738b': { entre: 297000000000000000n, sorti: 342300343441280946n, valeur: 0n, gain: 45300343441280946n, issue: 'gagnant', achats: 2, ventes: 2 },
    '0xa723a2421c4a1e11d3e02509815ad375de345869': { entre: 99000000000000000n, sorti: 95507114512463392n, valeur: 0n, gain: -3492885487536608n, issue: 'perdant', achats: 1, ventes: 1 },
    '0x6d9b561eb7fec2961b07a50bc864841404bdaac9': { entre: 91575000000000000n, sorti: 88262422144229221n, valeur: 0n, gain: -3312577855770779n, issue: 'perdant', achats: 2, ventes: 1 },
    '0x4e2683428a263e676268137e58250e028e9cddae': { entre: 76847680800000000n, sorti: 72248221050593249n, valeur: 0n, gain: -4599459749406751n, issue: 'perdant', achats: 2, ventes: 2 },
    '0x1865b0d8bc8ef6cc65cf4c655b139a5174c3dcba': { entre: 13464000000000000n, sorti: 0n, valeur: 2191087531466961n, gain: -11272912468533039n, issue: 'perdant', achats: 1, ventes: 0 },
    '0x62245f9a6bfee95c4dde8f9790f6122bfe712a25': { entre: 3514124648352682654n, sorti: 3246688524825332n, valeur: 2940802669428169774n, gain: -570075290399687548n, issue: 'inconnu', achats: 9, ventes: 1 },
  };
  let vus = 0;
  for (const [nom, e] of Object.entries(EX)) {
    const { evts, trades } = echangesDe(e);
    const prix = { num: BigInt(e.prix.num), den: BigInt(e.prix.den) };
    for (const w of e.wallets) {
      const A = ATTENDU[w.qui]; if (!A) continue; vus++;
      const tr = evts.filter((x) => x.genre === 'transfer' && x.jeton === e.jeton && (x.de === w.qui || x.vers === w.qui));
      const pos = K.position(w.qui, trades, tr);
      const solde = BigInt(w.solde);
      const g = K.gain({ entre: pos.entre, sorti: pos.sorti, solde, prix });
      egal(pos.entre, A.entre, `${nom} ${w.qui.slice(0, 8)} : ETH entre`);
      egal(pos.sorti, A.sorti, `${nom} ${w.qui.slice(0, 8)} : ETH sorti`);
      egal(K.valeur(solde, prix), A.valeur, `${nom} ${w.qui.slice(0, 8)} : solde x prix`);
      egal(g, A.gain, `${nom} ${w.qui.slice(0, 8)} : GAIN au wei pres`);
      egal(K.issue(pos, g), A.issue, `${nom} ${w.qui.slice(0, 8)} : issue`);
      egal(trades.filter((t) => t.qui === w.qui && t.sens === 'achat').length, A.achats, `${nom} ${w.qui.slice(0, 8)} : nombre d'achats dont il est le beneficiaire`);
      egal(trades.filter((t) => t.qui === w.qui && t.sens === 'vente').length, A.ventes, `${nom} ${w.qui.slice(0, 8)} : nombre de ventes`);
    }
  }
  egal(vus, 6, 'les 6 wallets reels sont tous verifies');
  /* le solde COMPTE : 0x1865b0… tient encore 12 442,9 BRODIE ; sans eux, sa perte serait la mise entiere */
  const e = EX.BRODIE, prix = { num: BigInt(e.prix.num), den: BigInt(e.prix.den) };
  const g1 = K.gain({ entre: 13464000000000000n, sorti: 0n, solde: 12442887828962965660948n, prix });
  ok(g1 > -13464000000000000n, 'GAIN : le solde au prix du dernier Swap reduit la perte (-0,0113 ETH, pas -0,0135)');
  egal(K.gain({ entre: 10n * E, sorti: 3n * E, solde: 0n, prix: null }), -7n * E, 'GAIN : solde nul -> pas besoin de prix');
  egal(K.gain({ entre: 1n, sorti: 0n, solde: 5n, prix: null }), null, 'GAIN : un solde sans prix -> null (jamais devine)');
  egal(K.gain({ entre: 1n, sorti: 0n, solde: null, prix: { num: 1n, den: 1n } }), null, 'GAIN : balanceOf illisible -> null');
  egal(K.gain({ entre: 2n * E, sorti: 1n * E, solde: 4000n * E, prix: { num: 1n, den: 1000n } }), 3n * E, 'GAIN : 1 - 2 + 4 000 x 0,001 = +3 ETH');
  egal(K.issue({ coutConnu: true }, 0n), 'perdant', 'ISSUE : gain nul = perdant (il faut gagner)');
  egal(K.issue({ coutConnu: false }, 5n), 'inconnu', 'ISSUE : sac recu hors marche = cout inconnu, jamais gagnant');
}

// ================================================== 2. SCORE, valeurs reelles
console.log('-- 2. SCORE : taux de base et z (50 premiers reels de NILF et BRODIE) --');
{
  const bases = new Map(), parts = new Map();
  for (const [nom, r] of Object.entries(PR)) {
    const l = r.premiers.map((x) => ({ jeton: r.jeton, qui: x.qui, tot: x.minutes != null && x.minutes <= 60, issue: x.issue, gain: x.gain == null ? null : BigInt(x.gain), minutes: x.minutes, marques: x.groupe ? [{ type: 'groupe' }] : [] }));
    const b = K.tauxBase(l);
    bases.set(r.jeton, b);
    for (const p of l) { if (!parts.has(p.qui)) parts.set(p.qui, []); parts.get(p.qui).push(p); }
    if (nom === 'NILF') { egal(b.n, 50, 'NILF : 50 entrants de la 1re heure a issue connue'); egal(b.gagnants, 27, 'NILF : 27 gagnants'); proche(b.p, 0.54, 1e-12, 'NILF : taux de base 54 %'); }
    else { egal(b.n, 37, 'BRODIE : 37 a issue connue (10 couts inconnus, 3 hors de la 1re heure)'); egal(b.gagnants, 12, 'BRODIE : 12 gagnants'); proche(b.p, 12 / 37, 1e-12, 'BRODIE : taux de base 32,4 %'); }
  }
  /* les deux wallets presents dans les 50 premiers des deux jetons (calcul Python independant) */
  const s1 = K.score(parts.get('0xa723a2421c4a1e11d3e02509815ad375de345869'), bases);
  egal(s1.projets, 2, 'SCORE 0xa723… : 2 projets (entre dans la 1re heure des deux)');
  egal(s1.gagnants, 1, 'SCORE 0xa723… : 1 gagnant (BRODIE)');
  proche(s1.attendu, 0.8643243243243244, 1e-12, 'SCORE 0xa723… : attendu = 0,54 + 0,324');
  proche(s1.z, 0.19842368428785392, 1e-12, 'SCORE 0xa723… : z = +0,20');
  egal(s1.gainTotal, 128321780860478n, 'SCORE 0xa723… : gain total au wei pres');
  proche(s1.delaiMoyen, 11.9, 1e-9, 'SCORE 0xa723… : delai moyen 11,9 min (en-tetes lus)');
  egal(s1.verdict, 'pas_assez', 'SCORE 0xa723… : aucun verdict sous 10 projets');
  egal(s1.smart, false, 'SCORE 0xa723… : 1 gagnant sur 2, pas smart');
  const s2 = K.score(parts.get('0x27bbe36c44f5125b27f7c6b74d3e5e16087bf59a'), bases);
  egal(s2.gainTotal, -17525753519511846n, 'SCORE 0x27bb… : gain total -0,0175 ETH');
  proche(s2.delaiMoyen, 14.275, 1e-9, 'SCORE 0x27bb… : delai moyen 14,3 min');
  /* les 17 wallets marques « groupe » de NILF ne sont jamais smart */
  const marques = PR.NILF.premiers.filter((x) => x.groupe).map((x) => x.qui);
  egal(marques.length, 17, 'NILF : 17 des 50 premiers achetent en groupe (>= 3 wallets, meme bloc, +/- 2 %)');
  ok(marques.every((q) => K.score(parts.get(q), bases).initie), 'un wallet marque est « initie »');

  /* la regle du proprietaire, et le z qui la remet a sa place */
  const fab = (k, p, g) => { const b = new Map(), l = []; for (let i = 0; i < k; i++) { const j = 'J' + i; b.set(j, { p }); l.push({ jeton: j, tot: true, issue: i < g ? 'gagnant' : 'perdant', gain: i < g ? E : -E, minutes: 5, marques: [] }); } return { l, b }; };
  let x = fab(12, 0.5, 10);
  let s = K.score(x.l, x.b);
  egal(s.smart, true, 'regle : 10 gagnants sur 12, aucune marque -> smart');
  proche(s.z, 4 / Math.sqrt(3), 1e-12, 'z = (10 - 6) / racine(3) = 2,31 a un taux de base de 50 %');
  egal(s.verdict, 'mieux_que_la_base', 'z >= 2 et >= 10 projets -> « beats the base rate »');
  x = fab(12, 0.9, 10); s = K.score(x.l, x.b);
  egal(s.smart, true, 'regle : toujours smart au sens du proprietaire...');
  ok(s.z < 0, '...mais a 90 % de taux de base, 10 sur 12 est SOUS l\'attendu (10,8) : z < 0');
  egal(s.verdict, 'comme_la_base', '...et le verdict le dit');
  x = fab(12, 0.5, 10); x.l[3].marques = [{ type: 'relais' }]; s = K.score(x.l, x.b);
  egal(s.smart, false, 'une seule marque d\'initie -> jamais smart');
  egal(s.verdict, 'initie', 'verdict « initie »');
  x = fab(3, 0.5, 3); s = K.score(x.l, x.b);
  egal(s.smart, true, 'regle : 3 jetons gagnants suffisent (demande du proprietaire)');
  egal(s.verdict, 'pas_assez', 'mais 3 projets : aucun verdict sur le z');
  x = fab(3, 0.5, 2); s = K.score(x.l, x.b);
  egal(s.smart, false, '2 gagnants : pas smart');
  x = fab(4, 0.5, 4); x.l[0].tot = false; x.l[1].tot = false; s = K.score(x.l, x.b);
  egal(s.projets, 2, 'un jeton ou il est entre apres la 1re heure ne compte pas');
  egal(s.smart, false, 'gagnant sur 4 mais tot sur 2 seulement : pas smart');
  x = fab(12, 0.5, 10); s = K.score(x.l, new Map());
  egal(s.z, null, 'sans taux de base, pas de z (jamais un z contre 0)');
  egal(s.verdict, 'comme_la_base', 'et pas de « beats the base rate » sans base');
}

// ================================================== 3. signes et decodage
console.log('-- 3. signes des Swap v2 / v3 / v4 --');
{
  /* v4 reel : le 1er achat de 0x90924c… sur NILF */
  const e = EX.NILF; const sw = e.logs.map(K.decode).filter((x) => x && x.genre === 'swap');
  const a = sw.find((x) => x.u0 < 0n);
  ok(a && a.u1 > 0n, 'v4 reel : achat = ETH (amount0) negatif, jeton positif (cote utilisateur)');
  egal(K.jambe(a, { ethEst0: true }).sens, 'achat', 'v4 reel : la jambe dit « achat »');
  /* v3 reel : recu du 13/10, piscine 0x9b35… (token0 = WETH) : le WETH SORT de la piscine (amount0 < 0) et le jeton y entre */
  const v3 = { address: '0x9b3554e6c26e06ebe55a7aec4e86e486379c5f6b', topics: [K.TOPIC.SWAP_V3, T(W(1)), T(W(2))], data: '0x' + mot(-4830073961851293n) + mot(719271128781595937440n) + mot(1n << 96n) + mot(1n) + mot(0n), blockNumber: '0x1', transactionHash: '0x' + 'a'.repeat(64), logIndex: '0x0' };
  const d3 = K.decode(v3);
  egal(d3.u0, 4830073961851293n, 'v3 : variation COTE PISCINE retournee (le WETH sort = +ETH pour l\'utilisateur)');
  const j3 = K.jambe(d3, { ethEst0: true });
  egal(j3.sens, 'vente', 'v3 reel : le jeton entre, le WETH sort -> vente');
  egal(j3.eth, 4830073961851293n, 'v3 : ETH recu');
  const v2 = { address: W(9), topics: [K.TOPIC.SWAP_V2, T(W(1)), T(W(2))], data: '0x' + mot(5n * E) + mot(0n) + mot(0n) + mot(1000n * E), blockNumber: '0x1', transactionHash: '0x' + 'b'.repeat(64), logIndex: '0x1' };
  const j2 = K.jambe(K.decode(v2), { ethEst0: true });
  egal(j2.sens, 'achat', 'v2 : amount0In (WETH) entre, amount1Out (jeton) sort -> achat');
  egal(j2.eth, 5n * E, 'v2 : 5 ETH payes');
  const v2b = Object.assign({}, v2, { data: '0x' + mot(5n * E) + mot(5n * E) + mot(0n) + mot(0n) });
  egal(K.jambe(K.decode(v2b), { ethEst0: true }), null, 'v2 : deux montants du meme signe (les deux entrent) -> ni achat ni vente');
  const nft = { address: W(9), topics: [K.TOPIC.TRANSFER, T(W(1)), T(W(2)), T(W(3))], data: '0x', blockNumber: '0x1', transactionHash: '0x' + 'c'.repeat(64), logIndex: '0x2' };
  egal(K.decode(nft), null, 'un Transfer a 4 topics (ERC-721) n\'est pas un jeton fongible');
  const ini = K.decode(OB.init_nilf[0]);
  egal(ini.c0, K.ADR.ETH_NATIF, 'Initialize reel de NILF : currency0 = ETH natif');
  egal(ini.hook, '0x332f85e7e323214b2d55286414b059ebb1f2a044', 'Initialize reel de NILF : crochet 0x332f…');
  const p = K.piscineEth(ini, '0xdb97b2aefd6816485a757ae49280d598a5c9c848');
  ok(p && p.ethEst0 === true && p.bloc === 49878889, 'piscineEth : ETH en currency0, bloc de lancement 49 878 889');
  egal(K.piscineEth(ini, W(5)), null, 'piscineEth : un jeton absent de la piscine -> null');
  const px = K.prixDepuisSqrt(1n << 96n, true);
  egal(K.valeur(7n, px), 7n, 'prix : sqrtP = 2^96 -> 1 wei par unite');
}

// ================================================== 4. beneficiaire
console.log('-- 4. le beneficiaire, jamais le signataire --');
{
  const J = W(0xabc), POOL = '0x' + '1'.repeat(64), PM = K.ADR.POOL_MANAGER_V4, HOOK = W(0x44), ROUTEUR = W(0x77);
  const tx = (k) => '0x' + String(k).padStart(64, '0');
  const tr = (k, i, de, vers, v) => K.decode({ address: J, topics: [K.TOPIC.TRANSFER, T(de), T(vers)], data: '0x' + mot(v), blockNumber: hex(100 + k), transactionHash: tx(k), logIndex: hex(i) });
  const sw = (k, i, u0, u1) => K.decode({ address: PM, topics: [K.TOPIC.SWAP_V4, POOL, T(ROUTEUR)], data: '0x' + mot(u0) + mot(u1) + mot(1n << 96n) + mot(1n) + mot(0n) + mot(0n), blockNumber: hex(100 + k), transactionHash: tx(k), logIndex: hex(i) });
  const piscines = [{ pool: POOL, version: 4, ethEst0: true, hook: HOOK }];
  const A = W(0xa1), B2 = W(0xb2);
  /* 1 : PM -> routeur -> A (le routeur a un net nul), crochet 1 % */
  const evts = [sw(1, 0, -E, 1000n * E), tr(1, 1, PM, HOOK, 10n * E), tr(1, 2, PM, ROUTEUR, 990n * E), tr(1, 3, ROUTEUR, A, 990n * E)];
  /* 2 : achat ou seul le 1 % du crochet sort (jetons restes dans le PoolManager) : sans beneficiaire */
  evts.push(sw(2, 0, -E, 1000n * E), tr(2, 1, PM, HOOK, 10n * E));
  /* 3 : A ne garde que 40 % du flux : moins de la moitie -> rien */
  evts.push(sw(3, 0, -E, 1000n * E), tr(3, 1, PM, A, 400n * E), tr(3, 2, PM, B2, 300n * E), tr(3, 3, PM, W(0xc3), 300n * E));
  /* 4 : vente de B2 */
  evts.push(sw(4, 0, 2n * E, -500n * E), tr(4, 1, B2, PM, 500n * E));
  const t = K.echanges({ jeton: J, piscines, evts });
  egal(t.length, 2, '4 tx de Swap, 2 echanges avec beneficiaire');
  egal(t[0].qui, A, 'le beneficiaire est A, pas le routeur qui signe');
  egal(t[0].eth, E, 'ETH paye : |amount0|');
  egal(t[1].sens, 'vente', 'la vente de B2');
  egal(t[1].qui, B2, 'le vendeur');
  ok(!t.some((x) => x.qui === HOOK), 'le crochet ne devient jamais acheteur');
  const t2 = K.echanges({ jeton: J, piscines, evts: [sw(5, 0, -E, 1000n * E), tr(5, 1, PM, ROUTEUR, 1000n * E)], infra: [ROUTEUR] });
  egal(t2.length, 0, 'une adresse d\'infrastructure (fabrique, migrateur) n\'est jamais beneficiaire');
}

// ================================================== 5. les 50 premiers
console.log('-- 5. les premiers acheteurs distincts --');
{
  const tr = [];
  for (let k = 0; k < 70; k++) tr.push({ sens: 'achat', qui: W(k % 60), bloc: 10 + k, i: 0, tx: 't' + k, eth: k === 3 ? 10n ** 15n : 10n ** 17n, jetons: 1n });
  tr.push({ sens: 'vente', qui: W(99), bloc: 1, i: 0, tx: 'v', eth: E, jetons: 1n });
  const p = K.premiersAcheteurs(tr, { exclus: [W(7)] });
  egal(p.length, 50, '50 au plus');
  ok(!p.some((x) => x.qui === W(3)), 'une mise de 0,001 ETH (< 0,01) n\'entre pas');
  ok(!p.some((x) => x.qui === W(7)), 'le createur et ses adresses sont exclus');
  ok(!p.some((x) => x.qui === W(99)), 'une vente n\'est pas un achat');
  egal(new Set(p.map((x) => x.qui)).size, 50, 'distincts');
  egal(K.premiersAcheteurs(tr).length, 50, 'N_ACHETEURS = 50 par defaut (demande du proprietaire)');
}

// ================================================== 6. marques d'initie
console.log('-- 6. les 4 marques, aux deux bords de leur seuil --');
{
  const a = (q, bloc, eth) => ({ qui: W(q), bloc, eth, tx: 'x' + q });
  let G = K.marqueGroupes([a(1, 5, 1000n), a(2, 5, 1010n), a(3, 5, 1020n)]);
  egal(G.size, 3, 'groupe : 3 wallets, meme bloc, a +2 % du plus petit -> marques');
  G = K.marqueGroupes([a(1, 5, 1000n), a(2, 5, 1010n), a(3, 5, 1021n)]);
  egal(G.size, 0, 'groupe : le 3e a +2,1 % -> rien');
  G = K.marqueGroupes([a(1, 5, 1000n), a(2, 5, 1000n)]);
  egal(G.size, 0, 'groupe : 2 wallets (paire) -> rien (calibrage : >= 3)');
  G = K.marqueGroupes([a(1, 5, 1000n), a(2, 6, 1000n), a(3, 7, 1000n)]);
  egal(G.size, 0, 'groupe : 3 blocs differents -> rien');
  G = K.marqueGroupes([a(1, 5, 1000n), a(1, 5, 1000n), a(2, 5, 1000n)]);
  egal(G.size, 0, 'groupe : deux achats du MEME wallet ne font pas deux wallets');
  /* reel : NILF, bloc 49 880 350, 4 wallets a 0,06187 ETH par le meme routeur */
  const reel = PR.NILF.premiers.filter((x) => x.groupe === 49880350);
  egal(reel.length, 4, 'NILF bloc 49 880 350 : 4 des 50 premiers marques « groupe » (meme mise, meme routeur)');

  const pos = { premierAchat: { bloc: 100 }, achetes: 10000n };
  egal(!!K.marqueRelais(pos, [{ vers: W(5), valeur: 9900n, bloc: 6100, tx: 'r' }]), true, 'relais : 99 % renvoye a 6 000 blocs -> marque');
  egal(K.marqueRelais(pos, [{ vers: W(5), valeur: 9899n, bloc: 200, tx: 'r' }]), null, 'relais : 98,99 % -> rien');
  egal(K.marqueRelais(pos, [{ vers: W(5), valeur: 10000n, bloc: 6101, tx: 'r' }]), null, 'relais : 6 001 blocs apres -> rien');
  egal(K.marqueRelais({ premierAchat: null, achetes: 0n }, []), null, 'relais : sans achat, rien');
  const tr = [{ de: W(1), vers: W(9), bloc: 3, tx: 'z' }];
  egal(K.marqueRenvoi(W(1), tr, [W(9)]).tx, 'z', 'renvoi au createur : marque, avec sa tx');
  egal(K.marqueRenvoi(W(1), tr, [W(8)]), null, 'renvoi a un autre : rien');
  const f = [{ de: W(9), vers: W(1), bloc: 50, tx: 'f' }];
  egal(K.marqueFinance(W(1), 60, f, [W(9)]).tx, 'f', 'finance par le createur avant son achat : marque');
  egal(K.marqueFinance(W(1), 40, f, [W(9)]), null, 'finance APRES son achat : rien');
  const m = K.marques({ qui: W(1), groupes: new Map([[W(1), { bloc: 1 }]]), relais: null, renvoi: { tx: 'z' }, finance: null });
  egal(m.map((x) => x.type).join(','), 'groupe,renvoi', 'les marques sont listees avec leur preuve');
}

// ================================================== 7. alertes
console.log('-- 7. alertes --');
{
  const S = new Set([W(1), W(2), W(3)]);
  let al = K.alertesSmart([{ qui: W(1), jeton: 'J', t: 1000, bloc: 1, tx: 'a' }, { qui: W(2), jeton: 'J', t: 1000 + 3600, bloc: 2, tx: 'b' }], S);
  egal(al.length, 1, '2 smart a 60 min d\'ecart sur le meme jeton -> alerte');
  egal(al[0].wallets.length, 2, 'l\'alerte nomme les 2 wallets');
  al = K.alertesSmart([{ qui: W(1), jeton: 'J', t: 1000, bloc: 1, tx: 'a' }, { qui: W(2), jeton: 'J', t: 1000 + 3601, bloc: 2, tx: 'b' }], S);
  egal(al.length, 0, '2 smart a 60 min 01 s -> rien');
  al = K.alertesSmart([{ qui: W(1), jeton: 'J', t: 1000, bloc: 1, tx: 'a' }, { qui: W(1), jeton: 'J', t: 1100, bloc: 2, tx: 'b' }], S);
  egal(al.length, 0, 'UN seul wallet smart, deux achats -> rien');
  al = K.alertesSmart([{ qui: W(1), jeton: 'J', t: 1000, bloc: 1, tx: 'a' }, { qui: W(7), jeton: 'J', t: 1001, bloc: 2, tx: 'b' }], S);
  egal(al.length, 0, 'un smart + un wallet ordinaire -> rien');
  al = K.alertesSmart([{ qui: W(1), jeton: 'J', t: 1000, bloc: 1, tx: 'a' }, { qui: W(2), jeton: 'K', t: 1001, bloc: 2, tx: 'b' }], S);
  egal(al.length, 0, 'deux smart sur deux jetons differents -> rien');
  const connus = new Map([[W(5), { lancements: 3 }]]);
  ok(K.alerteCreateur({ qui: W(5), role: 'deployeur', verifie: true, jeton: 'J', bloc: 1, tx: 't' }, connus), 'createur connu, deployeur verifie -> alerte');
  ok(K.alerteCreateur({ qui: W(5), role: 'lanceur', verifie: true, jeton: 'J', bloc: 1, tx: 't' }, connus), 'createur connu, lance par une rampe -> alerte');
  egal(K.alerteCreateur({ qui: W(5), role: 'migration', verifie: true, jeton: 'J' }, connus), null, 'operateur d\'une migration -> jamais « createur connu »');
  egal(K.alerteCreateur({ qui: W(5), role: 'inconnu', verifie: false, jeton: 'J' }, connus), null, 'role non verifie (1re frappe par un autre, cas PAPER) -> rien');
  egal(K.alerteCreateur({ qui: W(6), role: 'deployeur', verifie: true, jeton: 'J' }, connus), null, 'createur inconnu -> rien');
}

// ================================================== 8. le createur, recus reels
console.log('-- 8. le createur : recus reels de BRODIE et astro (13/10) --');
{
  const M = new Map(OB.migrations.map((l) => K.decode(l)).map((e) => [e.nouveau, e]));
  egal(M.size, 12, '12 MigratorCreated lus sur la fabrique 0xc1dd…');
  const brodie = '0x737054bd706cba68eaf4661411fede5f6c2952e5';
  const a = K.attribueCreateur({ jeton: brodie, tx: OB.txs.brodie_graduation, recu: OB.recus.brodie_graduation, migration: M.get(brodie) });
  egal(a.role, 'migration', 'BRODIE : 0x84b8… a envoye une MIGRATION');
  egal(a.qui, '0x84b8affbd7728217f97c8eb47fe4bda07d97b8c1', 'BRODIE : l\'operateur');
  egal(a.bloc, 49296036, 'BRODIE : bloc 49 296 036');
  egal(a.ancien, '0x45f82ac5d507e988f7406935da8eefe495a360e0', 'BRODIE : l\'ancien jeton');
  const anc = K.attribueCreateur({ jeton: a.ancien, tx: OB.txs.brodie_ancien_creation, recu: OB.recus.brodie_ancien_creation });
  egal(anc.role, 'lanceur', 'ancien BRODIE : lance par une rampe');
  egal(anc.qui, '0xebc1188f54b8591eb3322b273391a2f4a714dbd4', 'ancien BRODIE : par 0xebc1…');
  egal(anc.bloc, 9141382, 'ancien BRODIE : bloc 9 141 382');
  const astro = K.attribueCreateur({ jeton: '0x5b81efe5e0ba2b31c0ed843b908a2c45fe6e14c5', tx: OB.txs.astro_creation, recu: OB.recus.astro_creation });
  egal(astro.role, 'deployeur', 'astro : creation directe (contractAddress du recu)');
  egal(astro.qui, '0xb760edab21dd2855327d2a72be90f86b523fba7d', 'astro : 0xb760…');
  egal(K.attribueCreateur({ jeton: W(1), tx: OB.txs.astro_creation, recu: OB.recus.astro_creation }).role, 'inconnu', 'une tx qui ne frappe pas le jeton : rien n\'est affirme');
  const ph = K.phrasesCreateur({ jeton: brodie, symbole: 'BRODIE', createur: { adresse: a.qui, role: a.role, bloc: a.bloc, tx: a.tx }, ancien: { jeton: a.ancien, createur: anc.qui, bloc: anc.bloc } });
  egal(ph.v[0], 'wallet 0x84b8…b8c1 sent the migration of BRODIE (block 49,296,036, tx 0x8c73…591c); the old token 0x45f8…60e0 was created by 0xebc1…dbd4 (block 9,141,382)', 'phrase Verified de la migration (contrôle d\'acceptation A)');
  ok(!/developer|5\/5/i.test(ph.v.concat(ph.nv).join(' ')), 'jamais « developer of », jamais « 5/5 »');
  const sortie = OB.recus.astro_sortie_dead.logs.map(K.decode).find((e) => e && e.genre === 'transfer' && e.de === K.ADR.MORT);
  egal(sortie.valeur, 973323411065236870n, 'astro : 973 323 411,07 jetons sortis de 0x…dead (9 decimales), lus dans le recu');
  egal(K.phraseDrapeau({ type: 'sortie_de_dead', valeur: String(sortie.valeur), decimales: 9, bloc: sortie.bloc, tx: sortie.tx }, 'astro'),
    '973.3M astro moved out of 0x…dead (block 67,639,726, tx 0x3ba2…e69e) — a burn address cannot sign', 'phrase du drapeau astro (contrôle d\'acceptation C)');
}

// ================================================== 9. textes
console.log('-- 9. textes : Verified / Not verified, echappes, aucun achat --');
{
  const al = { jeton: W(0xaa), wallets: [{ qui: W(1), t: 10, bloc: 1234567, tx: '0x' + 'd'.repeat(64) }, { qui: W(2), t: 70, bloc: 1234570, tx: '0x' + 'e'.repeat(64) }], t0: 10, t1: 70 };
  const scores = new Map([[W(1), { projets: 4, gagnants: 3, z: 0.4, verdict: 'pas_assez' }]]);
  const t = K.texteAlerteSmart(al, { explorer: 'https://robinhoodchain.blockscout.com', scores, symbole: '<b>EVIL</b>' });
  ok(/<b>Verified<\/b> \(read on chain\):/.test(t) && /<b>Not verified<\/b>/.test(t), 'deux sections, toujours separees');
  ok(t.indexOf('Verified</b> (read') < t.indexOf('Not verified'), 'le verifie d\'abord');
  ok(/block 1,234,567/.test(t) && /tx 0xdddd…dddd/.test(t), 'chaque fait verifie porte son bloc et sa tx');
  ok(!/<b>EVIL<\/b>/.test(t) && /&lt;b&gt;EVIL/.test(t), 'le symbole (choisi par le createur) est echappe');
  ok(t.includes('https://dexscreener.com/robinhood/' + al.jeton), 'lien DexScreener');
  ok(/nothing is bought/.test(t), 'le message dit qu\'aucun achat n\'est fait');
  ok(/no verdict under 10 projects/.test(t), 'le score dit « no verdict under 10 projects »');
  const tc = K.texteAlerteCreateur({ createur: W(5), jeton: W(6), bloc: 99, tx: '0x' + 'f'.repeat(64), role: 'deployeur', palmares: { lancements: 4, reussites: 2, retraits: 1, drapeaux: 0 } }, { explorer: 'https://x', symbole: 'NEW' });
  ok(/deployed NEW \(block 99/.test(tc) && /1 of them had 90%\+ of their liquidity removed/.test(tc), 'createur connu : ce qui est lu sur la chaine est « Verified »');
  ok(/Not verified[^]*closed a day above \$1M/.test(tc), 'la capitalisation (prix exterieur) est « Not verified »');
  egal(K.eth(-3492885487536608n), '-0.0035 ETH', 'format ETH signe');
  egal(K.quantite('973323411065236870', 9), '973.3M', 'quantite a 9 decimales');
}

// ================================================== 10. liens et recette
console.log('-- 10. liens et recette --');
{
  const p = (k) => Array.from({ length: k }, (_, i) => W(1000 + i));
  const L = K.liens([
    { jeton: 'A', createur: W(1), premiers: p(5), recette: { signature: 'bots-first-minute' } },
    { jeton: 'B', createur: W(1), premiers: p(5), recette: { signature: 'bots-first-minute' }, ancien: 'Z' },
    { jeton: 'C', createur: W(2), premiers: p(4), recette: { signature: '' } },
  ]);
  ok(L.some((l) => l.type === 'meme_createur' && l.a === 'A' && l.b === 'B'), 'meme createur');
  ok(L.some((l) => l.type === 'memes_premiers' && l.detail === 5), '5 premiers en commun -> lien');
  ok(!L.some((l) => l.type === 'memes_premiers' && (l.a === 'C' || l.b === 'C')), '4 en commun -> pas de lien');
  ok(L.some((l) => l.type === 'meme_recette'), 'meme recette (signature non vide)');
  ok(!L.some((l) => l.type === 'meme_recette' && (l.a === 'C' || l.b === 'C')), 'une recette vide ne relie rien');
  ok(L.some((l) => l.type === 'migration' && l.a === 'B' && l.b === 'Z'), 'ancien jeton -> nouveau jeton');
  const r = K.recette({ achatCreateur: true, bruleParCreateur: true, robots: 5, profilApresS: 3 * 3600 });
  egal(r.signature, 'creator-buy-then-burn+bots-first-minute+paid-profile-3h', 'recette : les trois ingredients');
  egal(K.recette({ achatCreateur: true, bruleParCreateur: false, robots: 1, profilApresS: 3 * 3600 + 1 }).signature, '', 'achat sans brulure, 1 robot, profil a 3 h 00 min 01 s : rien');
}

if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
console.log(`smart_calcul.test.js : ${n} verifications OK`);
