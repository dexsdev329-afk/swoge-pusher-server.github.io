'use strict';
/*
 * Les calculs du detecteur smart money (smart_calcul.js, 13/10/2026).
 *
 * GAIN et SCORE D'ABORD, sur des VALEURS REELLES : les 50 premiers de NILF et
 * BRODIE relus le 14/10 apres la revue (base de controle remesuree), et TOUS les
 * journaux de leurs tx — Transfer, Swap, retenues du crochet et frais du routeur
 * lus dans les recus — figes dans essais/smart_money/premiers_reels.json.gz.
 * Les nombres attendus (attendus_python.json) sont calcules par un script Python
 * INDEPENDANT (essais/smart_money/gain_independant.py : son propre decodage, sa
 * propre regle du beneficiaire, ses propres frais), pas par le code essaye ; il
 * s'accorde avec la base sur les 100 wallets. L'ancien attendu (revue C1) prenait
 * le montant du Swap pour ce que le wallet recoit : un cas l'interdit.
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
const RE = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(ESS, 'premiers_reels.json.gz'))));
const PY = JSON.parse(fs.readFileSync(path.join(ESS, 'attendus_python.json'), 'utf8'));
const OB = JSON.parse(fs.readFileSync(path.join(ESS, 'objets_reels.json'), 'utf8'));
const RF = JSON.parse(fs.readFileSync(path.join(ESS, 'recus_frais_reels.json'), 'utf8'));
const W = (n) => '0x' + String(n).padStart(40, '0');
const T = (a) => K.pad32(a);
const hex = (x) => '0x' + BigInt(x).toString(16);
const mot = (x) => { let v = BigInt(x); if (v < 0n) v += 2n ** 256n; return v.toString(16).padStart(64, '0'); };
const E = 10n ** 18n;

/** Les echanges d'un jeton reel (frais compris, recus lus = frais connus). */
function echangesDe(e) {
  const evts = e.logs.map(K.decode).filter(Boolean);
  const piscine = { pool: e.pool, version: 4, ethEst0: e.ethEst0, hook: e.hook };
  return { evts, trades: K.echanges({ jeton: e.jeton, piscines: [piscine], evts, txLues: new Set(e.recusLus) }) };
}

// ================================================== 1. GAIN, valeurs reelles
console.log('-- 1. GAIN = ETH recu - ETH paye (frais lus) + solde x prix : les 100 premiers reels de NILF et BRODIE --');
{
  for (const [nom, e] of Object.entries(RE)) {
    const { evts, trades } = echangesDe(e);
    const prix = { num: BigInt(e.prix.num), den: BigInt(e.prix.den) };
    let pareils = 0;
    e.wallets.forEach((w, k) => {
      const A = PY[nom][k];
      const tr = evts.filter((x) => x.genre === 'transfer' && x.jeton === e.jeton && (x.de === w.qui || x.vers === w.qui));
      const pos = K.position(w.qui, trades, tr);
      const g = K.gain({ entre: pos.entre, sorti: pos.sorti, solde: w.solde == null ? null : BigInt(w.solde), prix });
      if (A.qui === w.qui && String(pos.entre) === A.entre && String(pos.sorti) === A.sorti && String(g) === String(A.gain) && K.issue(pos, g) === A.issue
        && trades.filter((t) => t.qui === w.qui && t.sens === 'achat').length === A.achats && trades.filter((t) => t.qui === w.qui && t.sens === 'vente').length === A.ventes) pareils++;
      else ok(false, `${nom} ${w.qui} : lu ${pos.entre}/${pos.sorti}/${g}/${K.issue(pos, g)}, Python ${A.entre}/${A.sorti}/${A.gain}/${A.issue}`);
    });
    egal(pareils, 50, `${nom} : les 50 premiers — entre, sorti, gain au wei pres, issue, achats et ventes — egaux au calcul Python independant`);
  }
  /* le cas qui ECHOUE si `sorti` vaut le montant du Swap (revue C1) : NILF 0x90924c…, deux ventes */
  {
    const e = RE.NILF, q = '0x90924c7d483cb1e1060c8de34acdf72aa54c738b';
    const { trades } = echangesDe(e);
    const ventes = trades.filter((t) => t.qui === q && t.sens === 'vente');
    const swap = ventes.reduce((s2, t) => s2 + t.ethSwap, 0n);
    egal(swap, 342300343441280946n, 'NILF 0x90924c… : les deux Swap de vente valent 0,3423 ETH (l\'ancien « sorti »)');
    const pos = K.position(q, trades, []);
    egal(pos.sorti, 335488566606799456n, 'mais le wallet n\'a RECU que 0,33549 ETH : 1 % retenu par le crochet et ~0,99 % pris par le routeur sur chaque vente');
    ok(pos.sorti < swap, 'sorti < somme des Swap : un code qui recopie le Swap echoue ici');
    egal(pos.entre, 299000000000000000n, 'et il a PAYE 0,299 ETH : 0,297 au Swap plus 1 % au routeur');
  }
  /* revue C2, reel : BRODIE #33, 0x95158f8a… achete 54 135 BRODIE puis envoie tout a 0x18c0… */
  const w33 = RE.BRODIE.wallets.find((w) => w.qui === '0x95158f8ac082cba832427734ae8cc396362ffbad');
  egal(w33 && w33.rang + ':' + PY.BRODIE[RE.BRODIE.wallets.indexOf(w33)].issue, '33:inconnu', 'BRODIE #33 (tout envoye hors marche) : « inconnu », plus « perdant » a -0,058 ETH');
  /* le solde COMPTE */
  const prix = { num: BigInt(RE.BRODIE.prix.num), den: BigInt(RE.BRODIE.prix.den) };
  const g1 = K.gain({ entre: 13464000000000000n, sorti: 0n, solde: 12442887828962965660948n, prix });
  ok(g1 > -13464000000000000n, 'GAIN : le solde au prix du dernier Swap reduit la perte');
  egal(K.gain({ entre: 10n * E, sorti: 3n * E, solde: 0n, prix: null }), -7n * E, 'GAIN : solde nul -> pas besoin de prix');
  egal(K.gain({ entre: 1n, sorti: 0n, solde: 5n, prix: null }), null, 'GAIN : un solde sans prix -> null (jamais devine)');
  egal(K.gain({ entre: 1n, sorti: 0n, solde: null, prix: { num: 1n, den: 1n } }), null, 'GAIN : balanceOf illisible -> null');
  egal(K.gain({ entre: 2n * E, sorti: 1n * E, solde: 4000n * E, prix: { num: 1n, den: 1000n } }), 3n * E, 'GAIN : 1 - 2 + 4 000 x 0,001 = +3 ETH');
  egal(K.issue({ coutConnu: true }, 0n), 'perdant', 'ISSUE : gain nul = perdant (il faut gagner)');
  egal(K.issue({ coutConnu: false }, 5n), 'inconnu', 'ISSUE : sac recu hors marche = cout inconnu, jamais gagnant');
  /* revue C2 : un achat suivi d'un ENVOI hors marche (relais, envoi a soi-meme, vente par une piscine non lue) -> inconnu, jamais perdant */
  {
    const q = W(0x95), dest = W(0x18);
    const tr = [{ tx: 'a', bloc: 1, i: 0, sens: 'achat', qui: q, eth: 58217702732141111n, jetons: 54135n * E, net: 54135n * E }];
    const env = [{ tx: 'b', bloc: 9, de: q, vers: dest, valeur: 54135n * E }];
    const pos = K.position(q, tr, env);
    egal(pos.envoyeHorsMarche, 54135n * E, 'position : l\'envoi hors marche est lu');
    egal(pos.coutConnu, false, 'achat puis envoi de tout le sac : cout NON connu');
    egal(K.issue(pos, K.gain({ entre: pos.entre, sorti: pos.sorti, solde: 0n, prix: null })), 'inconnu', 'issue « inconnu », jamais « perdant » a -100 % (BRODIE #33, 0x9515… : -0,058218 ETH avant)');
    const pos1 = K.position(q, tr, [{ tx: 'b', bloc: 9, de: q, vers: dest, valeur: 54135n * E / 100n }]);
    egal(pos1.coutConnu, true, 'un envoi de 1 % du sac : cout encore connu (bord)');
    const pos2 = K.position(q, tr, [{ tx: 'b', bloc: 9, de: q, vers: dest, valeur: 54135n * E / 100n + 1n }]);
    egal(pos2.coutConnu, false, 'au-dela de 1 % : inconnu');
  }
  /* revue C7 : l'offre en unites, exacte a toutes les decimales */
  for (const [d, o] of [[0, 1000000n], [2, 100000000n], [6, 10n ** 12n], [9, 10n ** 15n], [18, 10n ** 24n]]) egal(K.unites(o, d), 1e6, `offre de 1 000 000 de jetons a ${d} decimales -> 1e6 unites`);
}

// ================================================== 1 bis. FRAIS, recus reels (revue C1)
console.log('-- 1 bis. FRAIS : ce que le wallet recoit, lu dans 4 recus reels (13/10) --');
{
  const CROCHET = '0x332f85e7e323214b2d55286414b059ebb1f2a044';
  const P = {
    NILF: ['0xdb97b2aefd6816485a757ae49280d598a5c9c848', '0x08eb047c87b25e52936fd60201e74aaf385706bace2ecb2df3d6b9c3f4fff174'],
    BRODIE: ['0x737054bd706cba68eaf4661411fede5f6c2952e5', '0xb6eae9d1f1838c4302d500e80d7aa854e45a6455f502215c7b970745b62d4b76'],
    HM: ['0x359645eabf181101ddb9b90787b9e8480c923e55', '0xa8119e5e0ace22bd0c7c25dbf0e2d8100779211437beae894bb7c8cc40939e3a'],
    TROLL: ['0x2a13008cc2f5a853f6fb21cbd90841806c64b247', '0xe519f39c1f867539983be78a1ed036097a545f4379b08203f6e592e153f52c90'],
  };
  const vente = (h, nom) => { const ev = RF[h].logs.map(K.decode).filter(Boolean); return K.echanges({ jeton: P[nom][0], piscines: [{ pool: P[nom][1], version: 4, ethEst0: true, hook: CROCHET }], evts: ev })[0]; };
  /* NILF, wallet 0x90924c…, tx 0x13fb9218… : Swap 244 824 639 242 251 239 ; crochet 2 448 246 392 422 512 ; routeur
     2 423 763 928 498 287 ; le routeur REMET au wallet (0x8619026a, mot 1) 239 952 628 921 330 440 = Swap - crochet - routeur */
  const v1 = vente('0x13fb9218c87bd9d77973bb92a1bd546a625cc9f7e2ddb6096a37a929f0ae2bd5', 'NILF');
  egal(v1.ethSwap, 244824639242251239n, 'NILF : le Swap vaut 0,24482 ETH');
  egal(v1.eth, 239952628921330440n, 'NILF : ce que le WALLET recoit = ce que le routeur lui remet, au wei pres (Swap - 1 % crochet - frais routeur)');
  ok(v1.eth !== v1.ethSwap, 'sorti n\'est JAMAIS le montant du Swap quand des frais sont lus (l\'erreur de la revue C1)');
  const remis = (h) => { const l = RF[h].logs.find((x) => String(x.topics[0]).startsWith('0x8619026a')); return l ? BigInt('0x' + l.data.slice(66, 130)) : null; };
  const v2 = vente('0x5c10fd7f56f62aac1a04d72c1c63f578cb52598be60c70d054c6f1a18fb87fed', 'BRODIE');
  egal(v2.eth, remis('0x5c10fd7f56f62aac1a04d72c1c63f578cb52598be60c70d054c6f1a18fb87fed'), 'BRODIE (0xc468…) : idem, au wei pres');
  for (const [h, nom] of [['0x34f0ecec3a48eb23b88a40913428fde8f26e004bcddf61cd6720770da5b2fee2', 'TROLL'], ['0xaf63ff14d3c8ec3d01789711e388149632dc2f534ec0cde5b75205b3a929e7d0', 'HM']]) {
    const v = vente(h, nom);
    egal(v.frais * 10000n / v.ethSwap, 99n, `${nom} : le crochet retient 0,9999 % de l'ETH de la vente (hors du Swap)`);
    egal(v.eth, v.ethSwap - v.frais, `${nom} : sorti = Swap - retenue du crochet`);
  }
  /* bords : un crochet AUTRE que celui de la piscine ne compte pas ; un routeur inconnu n'est pas decode ; un achat paie les frais du routeur */
  const ev = RF['0x13fb9218c87bd9d77973bb92a1bd546a625cc9f7e2ddb6096a37a929f0ae2bd5'].logs.map(K.decode).filter(Boolean);
  const autre = K.echanges({ jeton: P.NILF[0], piscines: [{ pool: P.NILF[1], version: 4, ethEst0: true, hook: W(0x44) }], evts: ev })[0];
  egal(autre.eth, 244824639242251239n - 2423763928498287n, 'un evenement d\'un crochet qui n\'est pas celui de la piscine : ignore');
  const faux = Object.assign({}, RF['0x13fb9218c87bd9d77973bb92a1bd546a625cc9f7e2ddb6096a37a929f0ae2bd5'].logs.find((l) => String(l.topics[0]).startsWith('0x205442d6')), { address: W(0x66) });
  egal(K.decode(faux), null, 'l\'evenement de frais d\'un routeur inconnu n\'est pas cru');
  const J = W(0xabc), POOL = '0x' + '1'.repeat(64), PM = K.ADR.POOL_MANAGER_V4, A = W(0xa1);
  const lg = (k, i, adresse, topics, mots) => ({ address: adresse, topics, data: '0x' + mots.map(mot).join(''), blockNumber: '0x64', transactionHash: '0x' + 'f'.repeat(63) + k, logIndex: hex(i) });
  const achat = K.echanges({ jeton: J, piscines: [{ pool: POOL, version: 4, ethEst0: true, hook: null }], evts: [
    lg(1, 0, PM, [K.TOPIC.SWAP_V4, POOL, T(W(0x77))], [-792n * 10n ** 14n, 1000n * E, 1n << 96n, 1n, 0n, 0n]),
    lg(1, 1, J, [K.TOPIC.TRANSFER, T(PM), T(A)], [1000n * E]),
    lg(1, 2, K.ADR.ROUTEUR_FRAIS, [K.TOPIC.FRAIS_ROUTEUR, T(K.ADR.ETH_NATIF), T(A)], [8n * 10n ** 14n, 0n]),
  ].map(K.decode) })[0];
  egal(achat.eth, 8n * 10n ** 16n, 'un achat paie Swap + frais du routeur : 0,0792 + 0,0008 = 0,08 ETH (NOVAAI tx 0xd63628a1… : 80 000 000 000 000 000 payes)');
  const pos = K.position(A, [achat], []);
  egal(pos.entre + ':' + pos.frais, 8n * 10n ** 16n + ':' + 8n * 10n ** 14n, 'position : entre = ce que le wallet a paye, frais gardes a part');
  egal(K.position(A, [Object.assign({}, achat, { fraisLus: false })], []).fraisLus, false, 'un echange dont le recu n\'a pas ete lu : frais NON lus (dit « Not verified »)');
}

// ================================================== 2. SCORE, valeurs reelles
console.log('-- 2. SCORE : taux de base et z (50 premiers reels de NILF et BRODIE, remesures le 14/10) --');
{
  const bases = new Map(), parts = new Map();
  for (const [nom, e] of Object.entries(RE)) {
    const l = e.wallets.map((x, k) => ({ jeton: e.jeton, qui: x.qui, tot: x.tot, issue: PY[nom][k].issue, gain: PY[nom][k].gain == null ? null : BigInt(PY[nom][k].gain), minutes: x.minutes, marques: x.marques }));
    const b = K.tauxBase(l);
    bases.set(e.jeton, b);
    for (const p of l) { if (!parts.has(p.qui)) parts.set(p.qui, []); parts.get(p.qui).push(p); }
    const avec = K.tauxBase(l.map((p) => Object.assign({}, p, { marques: [] })));
    /* avant la revue : NILF 27/50 (54 %) et BRODIE 12/37 (32 %), frais ignores et marques comptes */
    if (nom === 'NILF') { egal(avec.gagnants + '/' + avec.n, '17/50', 'NILF, frais lus, marques comprises : 17 gagnants sur 50 (54 % -> 34 %)'); egal(b.gagnants + '/' + b.n, '10/27', 'NILF, sans les 23 wallets marques : 10 sur 27 (37 %)'); }
    else { egal(avec.gagnants + '/' + avec.n, '10/35', 'BRODIE, frais lus, marques comprises : 10 sur 35 (7 issues inconnues de plus : envois hors marche)'); egal(b.gagnants + '/' + b.n, '10/30', 'BRODIE, sans les 5 wallets marques : 10 sur 30 (33 %)'); }
  }
  /* les deux wallets presents dans les 50 premiers des deux jetons (issues du calcul Python independant) */
  const s1 = K.score(parts.get('0xa723a2421c4a1e11d3e02509815ad375de345869'), bases);
  egal(s1.projets + ':' + s1.connus + ':' + s1.jugeables, '2:2:2', 'SCORE 0xa723… : 2 projets, 2 issues connues, 2 jetons a taux jugeable');
  egal(s1.gagnants, 0, 'SCORE 0xa723… : 0 gagnant (BRODIE bascule : +0,0036 ETH sans les frais, -0,0063 avec)');
  const att = 10 / 26 + 10 / 29;
  proche(s1.attendu, att, 1e-12, 'SCORE 0xa723… : attendu = 10/26 + 10/29 (lui-meme retire de chaque base)');
  proche(s1.z, -att / Math.sqrt(10 / 26 * 16 / 26 + 10 / 29 * 19 / 29), 1e-12, 'SCORE 0xa723… : z = (0 - attendu) / ecart type');
  egal(s1.gainTotal, -4447956632661241n - 6315004804286884n, 'SCORE 0xa723… : gain total au wei pres');
  proche(s1.delaiMoyen, (1 / 60 + 23.783333333333335) / 2, 1e-9, 'SCORE 0xa723… : delai moyen 11,9 min (en-tetes lus)');
  egal(s1.verdict, 'pas_assez', 'SCORE 0xa723… : aucun verdict sous 10 issues connues');
  egal(s1.smart, false, 'SCORE 0xa723… : pas smart');
  const s2 = K.score(parts.get('0x27bbe36c44f5125b27f7c6b74d3e5e16087bf59a'), bases);
  egal(s2.gainTotal, 3782481568832115n - 32220977553148841n, 'SCORE 0x27bb… : gain total -0,0284 ETH');
  proche(s2.delaiMoyen, 14.275, 1e-9, 'SCORE 0x27bb… : delai moyen 14,3 min');
  /* les 17 wallets marques « groupe » de NILF, les 6 « paire » (revue INI-04), ne sont jamais smart */
  const groupe = RE.NILF.wallets.filter((x) => x.marques.some((m) => m.type === 'groupe')).map((x) => x.qui);
  egal(groupe.length, 17, 'NILF : 17 des 50 premiers achetent en groupe (>= 3 wallets, meme bloc, +/- 2 %)');
  const paire = RE.NILF.wallets.filter((x) => x.marques.some((m) => m.type === 'paire')).map((x) => x.qui);
  egal(paire.length, 6, 'NILF : 6 autres en paires repetees (revue INI-04 : 0x6db1… + 0xe5ee…, 0xdcbe… + 0x420d…)');
  ok(['0x6db1ffeb', '0xe5eebaf6', '0xdcbeaefd', '0x420dc884'].every((p) => paire.some((q) => q.startsWith(p))), 'dont les deux paires de la revue');
  ok(groupe.concat(paire).every((q) => K.score(parts.get(q), bases).initie), 'un wallet marque est « initie »');

  /* la regle du proprietaire, et le z qui la remet a sa place */
  /* une base de 1 000 000 d'issues : retirer le wallet juge n'y change rien au millionieme */
  const fab = (k, p, g) => { const b = new Map(), l = []; for (let i = 0; i < k; i++) { const j = 'J' + i; b.set(j, { n: 1e6, gagnants: Math.round(p * 1e6) }); l.push({ jeton: j, tot: true, issue: i < g ? 'gagnant' : 'perdant', gain: i < g ? E : -E, minutes: 5, marques: [] }); } return { l, b }; };
  let x = fab(12, 0.5, 10);
  let s = K.score(x.l, x.b);
  egal(s.smart, true, 'regle : 10 gagnants sur 12, aucune marque -> smart');
  proche(s.z, 4 / Math.sqrt(3), 1e-5, 'z = (10 - 6) / racine(3) = 2,31 a un taux de base de 50 %');
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
  egal(s.verdict, 'pas_assez', 'et aucun verdict sans base jugeable (jamais « beats the base rate »)');
  /* revue C3 : le seuil compte les issues CONNUES, pas les projets */
  x = fab(10, 0.1, 9); x.l[9].issue = 'inconnu'; s = K.score(x.l, x.b);
  egal(s.projets + ':' + s.connus + ':' + s.verdict, '10:9:pas_assez', '10 projets dont 9 issues connues : pas de verdict (avant : z +6 et « beats the base rate » des 10 projets)');
  ok(/no verdict under 10 known outcomes \(9 so far\)/.test(K.verdictTexte(s)), 'texte : « no verdict under 10 known outcomes (9 so far) »');
  x = fab(10, 0.1, 9); s = K.score(x.l, x.b);
  egal(s.connus + ':' + s.verdict, '10:mieux_que_la_base', '10 issues connues : le verdict est rendu');
  x = fab(10, 0.1, 9); for (let i = 0; i < 8; i++) x.l[i].issue = 'inconnu'; s = K.score(x.l, x.b);
  egal(s.verdict, 'pas_assez', 'le cas de la revue : 10 projets, 2 issues connues -> aucun verdict');
  /* revue C6 : le taux de base sans le wallet juge et sans les wallets marques ; aucun z sous BASE_ASSEZ */
  const parts20 = (g) => Array.from({ length: K.BASE_ASSEZ }, (_, i) => ({ jeton: 'J', tot: true, issue: i < g ? 'gagnant' : 'perdant', marques: [] }));
  let tb = K.tauxBase(parts20(10).concat([{ jeton: 'J', tot: true, issue: 'gagnant', marques: [{ type: 'groupe' }] }]));
  egal(tb.n + ':' + tb.gagnants, K.BASE_ASSEZ + ':10', 'tauxBase : un wallet marque ne compte pas dans la reference');
  const moi = { jeton: 'J', tot: true, issue: 'gagnant', marques: [], minutes: 1, gain: 1n };
  let sc = K.score([moi], new Map([['J', K.tauxBase(parts20(10).concat([moi]))]]));
  proche(sc.attendu, 10 / K.BASE_ASSEZ, 1e-12, 'score : le wallet juge est RETIRE de sa propre base (10/20, pas 11/21)');
  sc = K.score([moi], new Map([['J', K.tauxBase(parts20(10).slice(1).concat([moi]))]]));
  egal(sc.jugeables + ':' + sc.z, '0:null', `sous ${K.BASE_ASSEZ} issues connues (lui retire), le jeton n'a pas de taux jugeable : aucun z (NOVAAI : p = 3/5)`);
  egal(sc.connus, 1, 'mais l\'issue reste comptee comme connue');
}

// ================================================== 3. signes et decodage
console.log('-- 3. signes des Swap v2 / v3 / v4 --');
{
  /* v4 reel : le 1er achat de 0x90924c… sur NILF */
  const e = RE.NILF; const sw = e.logs.map(K.decode).filter((x) => x && x.genre === 'swap');
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
  const reel = RE.NILF.wallets.filter((x) => x.marques.some((m) => m.type === 'groupe' && m.bloc === 49880350));
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
  /* revue INI-12 : une tx ou le wallet est beneficiaire d'un echange n'est jamais un renvoi */
  egal(K.marqueRenvoi(W(1), tr, [W(9)], new Set(['z'])), null, 'renvoi : pas dans une tx d\'echange du wallet');
  /* revue INI-03 et INI-09 : la preuve du groupe dit sa taille reelle et les acheteurs du bloc */
  G = K.marqueGroupes([a(1, 5, 1000n), a(2, 5, 1010n), a(3, 5, 1020n), a(4, 5, 5000n), a(5, 5, 9000n), a(6, 5, 20000n)]);
  egal(G.get(W(1)).n + ':' + G.get(W(1)).acheteursBloc, '3:6', 'groupe : n = 3 dans le groupe, 6 acheteurs dans le bloc');
  ok(G.get(W(1)).acheteursBloc > K.BLOC_CHARGE, `bloc de plus de ${K.BLOC_CHARGE} acheteurs : « same-block pattern »`);
  /* revue INI-04 : paires repetees, aux deux bords */
  let Pr = K.marquePaires([a(1, 5, 1000n), a(2, 5, 1010n), a(1, 9, 990n), a(2, 9, 1000n)]);
  egal(Pr.size, 2, 'paire : meme bloc et meme mise (+/- 2 %), dans 2 blocs -> les deux sont marques');
  egal(Pr.get(W(1)).avec + ':' + Pr.get(W(1)).blocs.length, W(2) + ':2', 'avec sa preuve : l\'autre wallet et les 2 blocs');
  Pr = K.marquePaires([a(1, 5, 1000n), a(2, 5, 1010n)]);
  egal(Pr.size, 0, 'une paire UNIQUE -> rien (peut etre le hasard)');
  Pr = K.marquePaires([a(1, 5, 1000n), a(2, 5, 1010n), a(1, 9, 1000n), a(2, 9, 1030n)]);
  egal(Pr.size, 0, 'la 2e fois a +3 % -> rien');
  Pr = K.marquePaires([{ qui: W(1), cle: 'A:5', bloc: 5, eth: 99n, tx: 'p' }, { qui: W(2), cle: 'A:5', bloc: 5, eth: 99n, tx: 'q' }, { qui: W(1), cle: 'B:7', bloc: 7, eth: 99n, tx: 'r' }, { qui: W(2), cle: 'B:7', bloc: 7, eth: 99n, tx: 's' }]);
  egal(Pr.size, 2, 'paire repetee d\'un jeton a l\'autre (cle jeton:bloc) -> marquee');
  /* revue INI-01 : la co-entree, aux deux bords */
  const pr = (w, jeton, bloc) => ({ wallet: W(w), jeton, bloc, tx: 't' + w + jeton });
  let Co = K.marqueCoentree([pr(1, 'A', 10), pr(2, 'A', 10), pr(3, 'A', 10), pr(1, 'B', 20), pr(2, 'B', 20), pr(3, 'B', 20)]);
  egal(Co.size, 3, 'co-entree : 3 wallets dans un meme bloc sur 2 jetons -> marques, quelles que soient les mises');
  egal(Co.get(W(1)).blocs.length + ':' + Co.get(W(1)).membres.length, '2:3', 'preuve : les 2 blocs et les 3 membres');
  Co = K.marqueCoentree([pr(1, 'A', 10), pr(2, 'A', 10), pr(3, 'A', 10), pr(1, 'B', 20), pr(2, 'B', 20), pr(3, 'B', 21)]);
  egal(Co.size, 0, 'deux seulement ensemble sur le 2e jeton -> rien');
  Co = K.marqueCoentree([pr(1, 'A', 10), pr(2, 'A', 10), pr(3, 'A', 10), pr(1, 'A', 30), pr(2, 'A', 30), pr(3, 'A', 30)]);
  egal(Co.size, 0, 'deux blocs du MEME jeton -> rien (il faut 2 jetons)');
}

// ================================================== 6 bis. astro depuis son VRAI lancement (revue INI-02)
console.log('-- 6 bis. astro relu depuis son vrai lancement (bloc 57 852 996) : les marques du lancement reapparaissent --');
{
  const AS = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(ESS, 'astro_lancement.json.gz'))));
  const evts = AS.logs.map(K.decode).filter(Boolean);
  const tr = K.echanges({ jeton: AS.jeton, piscines: [{ pool: AS.pool, version: 2, ethEst0: AS.ethEst0, hook: null }], evts });
  egal(tr[0] && tr[0].bloc, 57852996, 'le 1er echange lu est au bloc 57 852 996 (tx 0xb31ee728…), pas 58 434 470 (16 h plus tard)');
  const heure = tr.filter((t) => t.sens === 'achat' && t.eth >= K.MISE_MIN_WEI && t.bloc <= AS.finHeure);
  const G = K.marqueGroupes(heure);
  const auLancement = [...G.values()].filter((p) => p.bloc === 57852996).length;
  ok(auLancement >= 13, `${auLancement} wallets marques « groupe » dans le bloc de lancement (la revue en compte 13 ; lu au mauvais lancement : 0)`);
  ok([...G.values()].some((p) => p.bloc === 57852996 && p.acheteursBloc > K.BLOC_CHARGE), 'un bloc de lancement charge : la page dit « same-block pattern »');
}

// ================================================== 6 ter. co-entree, valeurs reelles (revue INI-01)
console.log('-- 6 ter. co-entree : les 300 premiers des 7 jetons du controle --');
{
  const PC = JSON.parse(fs.readFileSync(path.join(ESS, 'premiers_controle.json'), 'utf8'));
  const lignes = PC.lignes.map(([, wallet, jeton, bloc, tx]) => ({ wallet, jeton, bloc, tx }));
  egal(lignes.length, 300, '300 premiers (6 jetons x 50 ; CPU sans acheteur)');
  const Co = K.marqueCoentree(lignes);
  const CINQ = ['0xb0b72fd48bd4212c77e75756a7ec977165a41657', '0xf9d33b7def5d8d6015ce2784e6fcf82802e247dd', '0x762565c177986a09f091b32ac204aa262b3f200a', '0x873a6043fb89fdfaaa3f116b9526451836cbc892', '0xa580cdba20944a0d58e1198ff7e6e7e517f389dd'];
  egal([...Co.keys()].sort().join(), CINQ.slice().sort().join(), 'exactement les 5 wallets de la revue, et aucun autre');
  egal(Co.get(CINQ[0]).blocs.map((b) => b.bloc).join(), '49405103,66204136,74578365', 'leurs blocs communs : HM 49 405 103, PEPONS 66 204 136, TROLL 74 578 365');
  /* le contrefactuel de la revue : TROLL avec des mises ecartees (aucune marque « groupe ») ; la co-entree les marque quand meme */
  const sansTroll = K.marqueCoentree(lignes.filter((l) => l.jeton !== '0x2a13008cc2f5a853f6fb21cbd90841806c64b247'));
  egal(sansTroll.size, 5, 'sans TROLL du tout, HM et PEPONS suffisent : les 5 restent marques');
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
  /* revue INI-07 : un lanceur automatique ne declenche pas une alerte par jeton */
  ok(K.alerteCreateur({ qui: W(5), role: 'lanceur', verifie: true, jeton: 'J', bloc: 1, tx: 't' }, connus, { lancements24h: K.LANCEUR_AUTO - 1 }), `${K.LANCEUR_AUTO - 1} lancements en 24 h : alerte`);
  egal(K.alerteCreateur({ qui: W(5), role: 'lanceur', verifie: true, jeton: 'J', bloc: 1, tx: 't' }, connus, { lancements24h: K.LANCEUR_AUTO }), null, `${K.LANCEUR_AUTO} lancements en 24 h : lanceur automatique, pas d'alerte par jeton`);
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
  ok(/no verdict under 10 known outcomes/.test(t), 'le score dit « no verdict under 10 known outcomes »');
  ok(/^<b>Smart wallets on &lt;b&gt;EVIL&lt;\/b&gt; \(owner’s rule, no verdict yet\)<\/b>/.test(t), 'sous le seuil, le TITRE dit « owner’s rule, no verdict yet » (revue C8)');
  const t2 = K.texteAlerteSmart(al, { explorer: 'https://x', scores: new Map([[W(1), { projets: 12, connus: 12, jugeables: 12, gagnants: 10, z: 2.4, verdict: 'mieux_que_la_base' }], [W(2), { projets: 12, connus: 12, jugeables: 12, gagnants: 10, z: 2.4, verdict: 'mieux_que_la_base' }]]), symbole: 'X' });
  ok(/^<b>Smart wallets on X<\/b>/.test(t2), 'avec un verdict pour chacun : le titre seul');
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
    { jeton: 'A', createur: W(1), premiers: p(5), recette: { signature: 'bots-first-minute+paid-profile-3h' }, financeur: W(9) },
    { jeton: 'B', createur: W(1), premiers: p(5), recette: { signature: 'bots-first-minute+paid-profile-3h' }, ancien: 'Z', financeur: W(9) },
    { jeton: 'C', createur: W(2), premiers: p(4), recette: { signature: '' } },
  ]);
  ok(L.some((l) => l.type === 'meme_createur' && l.a === 'A' && l.b === 'B'), 'meme createur');
  ok(L.some((l) => l.type === 'memes_premiers' && l.detail === 5), '5 premiers en commun -> lien');
  ok(!L.some((l) => l.type === 'memes_premiers' && (l.a === 'C' || l.b === 'C')), '4 en commun -> pas de lien');
  ok(L.some((l) => l.type === 'meme_recette'), 'meme recette (signature non vide)');
  ok(!L.some((l) => l.type === 'meme_recette' && (l.a === 'C' || l.b === 'C')), 'une recette vide ne relie rien');
  ok(L.some((l) => l.type === 'migration' && l.a === 'B' && l.b === 'Z'), 'ancien jeton -> nouveau jeton');
  ok(L.every((l) => K.LIENS_TYPES.includes(l.type)) && !L.some((l) => l.type === 'meme_financeur'), 'aucun lien « meme financeur » : rien ne lit de financeur (revue INI-05)');
  const Lb = K.liens([{ jeton: 'A', recette: { signature: 'bots-first-minute' } }, { jeton: 'B', recette: { signature: 'bots-first-minute' } }]);
  egal(Lb.length, 0, 'une recette faite des seuls « bots-first-minute » ne relie rien (revue INI-13)');
  /* revue INI-06 : deux migrations d'un meme OPERATEUR, deux createurs d'origine differents */
  const Lm = K.liens([{ jeton: 'BRODIE', createur: W(0xeb), operateur: W(0x84) }, { jeton: 'NILF', createur: W(0x79), operateur: W(0x84) }]);
  ok(!Lm.some((l) => l.type === 'meme_createur'), 'deux migrations d\'un meme operateur : AUCUN lien « meme createur »');
  ok(Lm.some((l) => l.type === 'meme_operateur_migration' && l.detail === W(0x84)), 'mais un lien distinct « meme operateur de migration »');
  const r = K.recette({ achatCreateur: true, bruleParCreateur: true, robots: 5, profilApresS: 3 * 3600 });
  egal(r.signature, 'creator-buy-then-burn+bots-first-minute+paid-profile-3h', 'recette : les trois ingredients');
  egal(K.recette({ achatCreateur: true, bruleParCreateur: false, robots: 1, profilApresS: 3 * 3600 + 1 }).signature, '', 'achat sans brulure, 1 robot, profil a 3 h 00 min 01 s : rien');
  egal(K.recette({ robots: K.ROBOTS_MIN - 1 }).signature + '|' + K.recette({ robots: K.ROBOTS_MIN }).signature, '|bots-first-minute', `« robots » : ${K.ROBOTS_MIN} acheteurs dans la 1re minute, sa propre constante`);
}

if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
console.log(`smart_calcul.test.js : ${n} verifications OK`);
