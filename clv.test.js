'use strict';
/*
 * LA VALEUR DE CLOTURE (CLV) PAR PARIEUR — COLLECTE SEULE (lot 2 de la cle
 * 20K, 10/10/2026).
 *
 * ---- ce que l'essai tient ----
 *
 * Chaque garde-fou a sa verification, qui tombe s'il est retire (liste et
 * passe de mutation : EXPLOITATION 8.8octies).
 *  §1  probaIssue : 1-N-2 = p[choix] ; double chance verifiee sur les COTES
 *      de cotes.marchesDuMarche (habilleUnMarche sur nos sommes redonne ses
 *      cotes), pas sur son texte ; derives -> null ; la categorie d'issue.
 *  §2  la vente au prix du marche : p survit a paris.valide (et seulement
 *      sain) ; la jambe garde ev, pv, tv, ref, pm ; double chance ; btts sans
 *      pv ; a l'Elo, AUCUN champ clv.
 *  §3  rien de vendu ne change : PARIS_CLV=0 contre collecte, memes cotes,
 *      rapports, soldes, engagement, jambes identiques une fois clv retire ;
 *      prix malforme : le pari passe ; aLaVente ne leve jamais.
 *  §4  rien chez le joueur : mesParis, ticketPublic (pariPose), parisOuverts,
 *      paris.vue ; server.js envoie ticketPublic.
 *  §5  le gel au reglement, sur un vrai index de cloture (prix_journal) :
 *      mesuree, combine deja perdu ailleurs, orientation (une equipe suffit),
 *      absente, reportee (borne des 3 h), deplacee, retiree (pc =
 *      l'avant-derniere), sans mouvement, panne, rembourse, une seule fois,
 *      PARIS_CLV=0 ; la MEME source que la vente (refChangee sinon) ; le
 *      controle exact (ctl) ; chaque garde de figeJambe appelee seule.
 *  §6  le paiement ne depend jamais de la CLV : index qui leve, index
 *      illisible, collecte coupee -> memes gagnants, memes soldes ; [clv] dit ;
 *      un index illisible ne fige rien, le reglement suivant REPREND.
 *  §7  le bilan sur des tickets faits a la main : formule, 39/40 rencontres,
 *      40 paris sur UN match = 1, chaque condition de la porte 1 des deux
 *      cotes de sa borne (14 j, 100, 90 %, controle 60 et 99 %), un gros
 *      parieur fin ne ferme plus la porte, verdicts (beats, sharper, inline),
 *      Bonferroni et incertitude de la foule, la foule SANS l'adresse jugee,
 *      favori sans talent, nul qui derive, ponderation par la mise, valeur
 *      concedee, a part (retiree, deplacee, refChangee), vente a moins de
 *      5 min du coup d'envoi (pas une panne), hors mesure compte par compte,
 *      aucun chiffre sous son seuil, porte 4 aux bornes, detail.
 *  §8  la route : un vrai serveur, la cle dans l'en-tete, no-store, ?addr=
 *      (casse ignoree, borne a 100 caracteres).
 *  §9  l'index de cloture : lisCloturesEtat (absent, illisible, version, ok),
 *      cloture, un index qui ne se decode pas est MIS DE COTE et dit, une
 *      lecture refusee n'ecrase rien, trois mises de cote gardees.
 *  §10 la carte du panneau : sous 40 aucun chiffre, aucun verdict avant la
 *      porte 1, tout echappe, a sa place dans la vue « jeux », la valeur
 *      concedee a cote du verdict, « no crowd » sans foule.
 *
 * Aucun reseau. La derniere ligne dit « clv.test.js : N verifications OK ».
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

/* DATA_DIR AVANT tout require : prix_marche (et donc l'index de cloture)
   fige son dossier au premier require, journal.js aussi. */
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-clv-'));
/* le bac part aussi quand l'essai tombe (passe de mutation : 96 bacs laisses
   par des executions rouges) */
process.on('exit', () => { try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* deja parti */ } });
process.env.DATA_DIR = BAC;
process.env.RPC_URL = '';
delete process.env.PARIS_CLV;
delete process.env.PARIS_PRIX_LIGUES;

const { ethers } = require('ethers');
const cfg = require('./config');
const paris = require('./paris');
const cotes = require('./cotes');
const pm = require('./prix_marche');
const pj = require('./prix_journal');
const clv = require('./clv');
const { Game } = require('./game');

const H = 3600000, MIN = 60000, JOUR = 86400000;
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ' [' + a + ' vs ' + b + ']'); n++; console.log('  ok   ' + m); };
const proche = (a, b, tol, m) => { assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tol, m + ' [' + a + ' vs ' + b + ']'); n++; console.log('  ok   ' + m); };
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r4t = (x) => Math.round(x * 1e4) / 1e4;
function capture(fn) {
  const dits = [], avant = console.log;
  console.log = (...a) => { dits.push(a.join(' ')); };
  try { fn(); } finally { console.log = avant; }
  return dits;
}

// ------------------------------------------------------------ outils
const T0 = Date.now();
const DEBUT = T0 + 2 * H, TV = T0 - H, TC = T0 + 30 * MIN;
const PV = { 1: 0.5, N: 0.27, 2: 0.23 };
const PC = { 1: 0.55, N: 0.25, 2: 0.2 };
function lots(p) {
  const out = {};
  for (const [k, v] of Object.entries(cotes.marchesDuMarche('foot', p))) out[k] = { cotes: v.cotes };
  return out;
}
/* une rencontre au prix du marche (le catalogue tel que l'import l'ecrit) */
function auMarche(id, ev, o) {
  const x = o || {};
  return { id, sport: 'foot', competition: 'Premier League', domicile: x.dom || ('Home ' + id), exterieur: x.ext || ('Away ' + id),
           debut: new Date(x.debut || DEBUT).toISOString(), marches: lots(x.p || PV),
           source: { fournisseur: 'the-odds-api', ligue: 'soccer_epl', evenement: ev }, cotesGenerees: true,
           prixMarche: { ref: x.ref || 'betfair', t: new Date(x.tv || TV).toISOString(), livres: 5, p: x.pBrut || x.p || PV } };
}
/* une rencontre a l'Elo : ni prixMarche ni championnat vendu */
function aLElo(id) {
  return { id, sport: 'foot', competition: 'Elo League', domicile: 'Elo ' + id, exterieur: 'Rival ' + id,
           debut: new Date(DEBUT).toISOString(), marches: { '1n2': lots({ 1: 0.45, N: 0.28, 2: 0.27 })['1n2'] },
           source: { fournisseur: 'the-odds-api', ligue: 'soccer_nowhere', evenement: 'elo-' + id }, cotesGenerees: false };
}
let NCAT = 0;
function charge(matchs) {
  const f = path.join(BAC, 'catalogue-' + (++NCAT) + '.json');
  fs.writeFileSync(f, JSON.stringify({ sports: [{ cle: 'foot', nom: 'Football', actif: true }], matchs }));
  return paris.charge(f);
}
function joueur(g, a, solde) { g._p(a).betBalance = W(solde || 10000000); return a; }
/* une ligne du journal (format v1 du lot 1) et ses entrees */
const ligne = (t, e) => ({ v: 1, m: 'h2h', t, l: 'soccer_epl', q: 'avant', c: 120, av: 1, am: 2160, n: e.length, e });
const E = (id, debut, p, ref) => [id, debut, ref || 'b', [p[1], p.N, p[2]], null, null, null, 5, null, null];
const X = (id, debut) => [id, debut, 'x'];

// =================================================================== §1
console.log('\n-- §1. la proba de l issue choisie, verifiee sur les cotes de cotes.js --');
{
  let g = 4242; const alea = () => { g = (g * 16807) % 2147483647; return (g - 1) / 2147483646; };
  let vus = 0, dcVus = 0, ecart = 0;
  for (let k = 0; k < 200; k++) {
    const a = 0.12 + alea() * 0.6, b = 0.12 + alea() * (0.82 - a);
    const p = { 1: r5(a), N: r5(b), 2: r5(1 - a - b) };
    if (!(p[2] > 0.05)) continue;
    const mm = cotes.marchesDuMarche('foot', p);
    if (!mm) continue;
    vus++;
    for (const i of ['1', 'N', '2']) if (clv.probaIssue('1n2', i, p) !== p[i]) ecart++;
    if (mm.dc) {
      dcVus++;
      /* nos trois sommes, habillees par cotes.js lui-meme, doivent redonner
         SES cotes de double chance : la meme proba par issue que la vente */
      const nous = { '1X': clv.probaIssue('dc', '1X', p), 12: clv.probaIssue('dc', '12', p), X2: clv.probaIssue('dc', 'X2', p) };
      const lot = cotes.habilleUnMarche(nous, paris.MARCHES.dc.issues('foot'), paris.MARCHES.dc.couverture);
      if (JSON.stringify(lot.cotes) !== JSON.stringify(mm.dc.cotes)) ecart++;
    }
  }
  ok(vus > 150 && dcVus > 100, `200 tirages : ${vus} rencontres cotees, ${dcVus} avec double chance`);
  eq(ecart, 0, '1-N-2 = p[choix] ; double chance : nos sommes redonnent les cotes de cotes.marchesDuMarche, issue par issue');
  /* une somme fausse se verrait : '1X' pris pour 1 + 2 change les cotes */
  {
    const p = { 1: 0.5, N: 0.27, 2: 0.23 }, mm = cotes.marchesDuMarche('foot', p);
    const faux = cotes.habilleUnMarche({ '1X': 0.73, 12: 0.77, X2: 0.5 }, paris.MARCHES.dc.issues('foot'), paris.MARCHES.dc.couverture);
    ok(JSON.stringify(faux.cotes) !== JSON.stringify(mm.dc.cotes), 'la verification n est pas aveugle : 1X et X2 echanges donnent d autres cotes');
  }
  for (const [m, c] of [['btts', 'oui'], ['ou25', 'plus'], ['score', '1-0'], ['hand', '1']]) eq(clv.probaIssue(m, c, PV), null, m + ' : null (le modele n expose pas sa proba)');
  eq(clv.probaIssue('1n2', 'X', PV), null, 'une issue inconnue : null');
  eq(clv.probaIssue('1n2', 'N', { 1: 0.5, N: 1.5, 2: 0.2 }), null, 'une proba hors ]0;1[ : null');
  eq(clv.probaIssue('dc', '1X', { 1: 0.7, N: 0.4, 2: 0.1 }), null, 'une double chance a 1 ou plus : null');
  /* les bornes ]0 ; 1[ sont strictes, partout (une proba de 0 ou 1 n'est pas un prix) */
  eq(clv.probaIssue('1n2', '1', { 1: 1, N: 0.5, 2: 0.5 }), null, 'une proba de 1 : null');
  eq(clv.vecteur({ 1: 0, N: 0.5, 2: 0.5 }), null, 'une proba de 0 : vecteur null');
  ok(!clv.obsValide([T0, 'avant', 'b', [0, 0.5, 0.5]]) && !clv.obsValide([T0, 'avant', 'x']), 'une observation avec une proba nulle, ou un retrait : invalide');
  eq(clv.categorie('1n2', '1', [0.5, 0.27, 0.23]), 'fav', 'le 1 a 50 % contre 23 % : favori');
  eq(clv.categorie('1n2', '2', [0.5, 0.27, 0.23]), 'out', 'le 2 : outsider');
  eq(clv.categorie('1n2', 'N', [0.5, 0.27, 0.23]), 'nul', 'le nul : nul');
  eq(clv.categorie('dc', 'X2', [0.2, 0.3, 0.5]), 'dcFav', 'X2 quand le 2 est favori : double chance du favori');
  eq(clv.categorie('dc', '1X', [0.2, 0.3, 0.5]), 'dcOut', '1X quand le 2 est favori : double chance de l outsider');
  eq(clv.categorie('dc', '12', [0.2, 0.3, 0.5]), 'dc12', '12 : a part');
}

// =================================================================== §2
console.log('\n-- §2. la vente au prix du marche --');
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
{
  charge([auMarche('vente-1', 'ev-v1'), aLElo('vente-elo'),
          auMarche('vente-mal', 'ev-vmal', { pBrut: { 1: 0.5, N: 1.5, 2: 0.2 } })]);
  const m = paris.match('vente-1');
  ok(m.prixMarche && m.prixMarche.p && m.prixMarche.p[1] === 0.5 && m.prixMarche.p.N === 0.27, 'paris.valide garde prixMarche.p (il le jetait)');
  eq(paris.match('vente-mal').prixMarche.p, null, 'un p malforme (N = 1,5) n est pas garde : null');
  const g = new Game(); joueur(g, A);
  const p1 = g.parieSur(A, 'vente-1', '1n2', '1', 1000, T0);
  const c = p1.jambes[0].clv;
  ok(c && c.pv === 0.5 && c.tv === TV && c.ref === 'betfair' && c.ev === 'ev-v1', 'la jambe 1-N-2 garde pv = p[1], tv = date du prix, ref, ev');
  eq(JSON.stringify(c.pm), JSON.stringify([0.5, 0.27, 0.23]), 'et le vecteur du marche (la marge vendue se recalcule depuis lui)');
  const p2 = g.parieSur(A, 'vente-1', 'dc', 'X2', 1000, T0);
  eq(p2.jambes[0].clv.pv, r5(0.27 + 0.23), 'double chance X2 : pv = pN + p2');
  const p3 = g.parieSur(A, 'vente-1', 'btts', 'oui', 1000, T0);
  ok(p3.jambes[0].clv && p3.jambes[0].clv.pv === null && p3.jambes[0].clv.pm === null, 'btts : clv present, pv null (hors mesure)');
  const p4 = g.parieSur(A, 'vente-elo', '1n2', '1', 1000, T0);
  ok(!('clv' in p4.jambes[0]) && JSON.stringify(p4).indexOf('"clv"') < 0, 'a l Elo : AUCUN champ clv, pas meme une cle vide');
  const p5 = g.parieSur(A, 'vente-mal', '1n2', '1', 1000, T0);
  ok(p5 && p5.jambes[0].clv && p5.jambes[0].clv.pv === null, 'prix malforme : le pari passe, pv null');
  /* paris.valide : bornes strictes (une issue a 1 et deux a 0 ne sont pas un marche) */
  charge([auMarche('vente-01', 'ev-v01', { pBrut: { 1: 1, N: 0, 2: 0 } })]);
  eq(paris.match('vente-01').prixMarche.p, null, 'p avec une issue a 1 et deux a 0 : non garde');
  /* aLaVente : chaque garde, seule */
  const mk = (o) => Object.assign({ prixMarche: { ref: 'betfair', t: new Date(TV).toISOString(), livres: 5, p: PV }, source: { evenement: 'e' } }, o);
  eq(clv.aLaVente(mk({ source: { fournisseur: 'the-odds-api' } }), '1n2', '1'), null, 'rencontre au marche SANS evenement : null');
  eq(clv.aLaVente(mk({ prixMarche: 'abc' }), '1n2', '1'), null, 'prixMarche qui n est pas un objet : null');
  eq(clv.aLaVente(mk({ prixMarche: { p: PV, t: 'pas une date', ref: 'b' } }), '1n2', '1').tv, null, 'date du prix illisible : tv null (et non NaN)');
}

// =================================================================== §3
console.log('\n-- §3. rien de vendu ne change --');
{
  charge([auMarche('meme-1', 'ev-m1'), auMarche('meme-2', 'ev-m2', { p: { 1: 0.3, N: 0.3, 2: 0.4 } }), aLElo('meme-elo')]);
  const joue = () => {
    const g = new Game(); joueur(g, A); joueur(g, B);
    const t = [g.parieSur(A, 'meme-1', '1n2', '2', 2500, T0), g.parieSur(B, 'meme-1', 'dc', '1X', 4000, T0),
               g.parieCombine(A, [{ match: 'meme-1', choix: '1' }, { match: 'meme-2', marche: 'dc', choix: '12' }, { match: 'meme-elo', choix: 'N' }], 1000, T0)];
    return { g, t };
  };
  process.env.PARIS_CLV = '0';
  const coupe = joue();
  delete process.env.PARIS_CLV;
  const actif = joue();
  ok(coupe.t.every((p) => p.jambes.every((j) => !('clv' in j))), 'PARIS_CLV=0 : aucune jambe ne porte clv');
  ok(actif.t.every((p) => p.jambes.some((j) => 'clv' in j)), 'collecte : chaque ticket au marche porte clv');
  const sans = (p) => Object.assign({}, p, { id: null, jambes: p.jambes.map((j) => { const c = Object.assign({}, j); delete c.clv; return c; }) });
  for (let i = 0; i < 3; i++) {
    assert.deepStrictEqual(sans(actif.t[i]), sans(coupe.t[i]));
    n++; console.log('  ok   ticket ' + (i + 1) + ' : cote ' + actif.t[i].cote + ', rapport, mise, jambes identiques une fois clv retire');
  }
  eq(actif.g.betBalanceStr(A), coupe.g.betBalanceStr(A), 'meme solde des paris');
  eq(actif.g.engagementMatch('meme-1'), coupe.g.engagementMatch('meme-1'), 'meme engagement sur la rencontre');
  eq(JSON.stringify(actif.g.parisOuverts(T0)), JSON.stringify(coupe.g.parisOuverts(T0)), 'memes rencontres ouvertes, meme place');
  /* aLaVente ne leve jamais */
  const piege = auMarche('piege-1', 'ev-piege');
  Object.defineProperty(piege, 'prixMarche', { get() { throw new Error('boum'); } });
  eq(clv.aLaVente(piege, '1n2', '1'), null, 'un prixMarche qui leve : aLaVente rend null, sans lever');
  const mal = clv.aLaVente({ prixMarche: { p: { 1: 0.5, N: 1.5, 2: 0.2 }, t: 'x' }, source: { evenement: 'e' } }, '1n2', '1');
  ok(mal.pv === null && mal.tv === null && mal.pm === null, 'un p malforme sans passer par valide : pv null, tv null, pm null');
}

// =================================================================== §4
console.log('\n-- §4. rien chez le joueur --');
{
  charge([auMarche('joueur-1', 'ev-j1', { p: { 1: 0.43219, N: 0.28765, 2: 0.28016 } })]);
  const g = new Game(); joueur(g, A);
  const pari = g.parieCombine(A, [{ match: 'joueur-1', choix: '1' }], 1000, T0);
  const pv = String(pari.jambes[0].clv.pv);
  eq(pv, '0.43219', 'la jambe garde bien pv au serveur');
  const mes = JSON.stringify(g.mesParis(A));
  ok(mes.indexOf('"clv"') < 0 && mes.indexOf(pv) < 0, 'mesParis (connexion, pariPose, historique) : ni clv ni la valeur de pv');
  const pub = JSON.stringify(g.ticketPublic(pari));
  ok(pub.indexOf('"clv"') < 0 && pub.indexOf(pv) < 0, 'ticketPublic : ni clv ni pv');
  ok(pari.jambes[0].clv && pari.jambes[0].clv.pv === 0.43219, 'et le ticket du serveur, lui, n a pas ete touche (copie)');
  const ouv = JSON.stringify(g.parisOuverts(T0));
  ok(ouv.indexOf('prixMarche') < 0 && ouv.indexOf(pv) < 0, 'les rencontres ouvertes envoyees aux pages : ni prixMarche ni pv');
  const v = JSON.stringify(paris.vue(paris.match('joueur-1'), T0));
  ok(v.indexOf('prixMarche') < 0 && v.indexOf(pv) < 0, 'paris.vue ne recopie pas prixMarche');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const envoi = src.slice(src.indexOf("type: 'pariPose'"), src.indexOf("type: 'pariPose'") + 120);
  ok(/pari: game\.ticketPublic\(pari\)/.test(envoi), 'server.js : pariPose envoie game.ticketPublic(pari)');
  ok(/game\.mesParis\(ws\.addr, 5000\)/.test(src), 'server.js : l historique passe par mesParis (deja nettoye)');
}

// =================================================================== §5
console.log('\n-- §5. la cloture figee au reglement --');
let G5 = null;
const N5 = 16;      // jambes collectees de A au §5 (le detail de ?addr=)
{
  /* le carnet : equipes du fournisseur (orientation) */
  const carnet = { evenements: {
    'e5-or': { t: TC, ref: 'betfair', p: PC, dom: 'Away mfive-or', ext: 'Home mfive-or', debut: DEBUT, ligue: 'soccer_epl' },
    'e5-ok': { t: TC, ref: 'betfair', p: PC, dom: 'Home mfive-ok', ext: 'Away mfive-ok', debut: DEBUT, ligue: 'soccer_epl' } },
    ligues: {}, couverture: {} };
  fs.writeFileSync(pm.fichier(), JSON.stringify(carnet));
  const ids = ['a', 'b', 'or', 'ab', 'rp', 'dp', 'rt', 'sm', 'pa', 'rb', 'ok', 'off', 'bt', 'rc', 'rs', 'ct'];
  charge(ids.map((k) => auMarche('mfive-' + k, 'e5-' + k)).concat([aLElo('mfive-elo')]));
  /* l'index de cloture, ecrit par le VRAI ecrivain du lot 1 */
  const avantVente = ['a', 'b', 'or', 'rp', 'dp', 'rt', 'sm', 'rb', 'ok', 'off', 'bt', 'rc', 'rs'].map((k) => E('e5-' + k, DEBUT, PV));
  /* 'ct' : l'index a note a la date de la vente un AUTRE vecteur que celui vendu */
  avantVente.push(E('e5-ct', DEBUT, { 1: 0.48, N: 0.29, 2: 0.23 }));
  pj.majClotures(ligne(TV - 2 * H, [E('e5-pa', DEBUT, PV)]));
  pj.majClotures(ligne(TV, avantVente));
  const vPC = [PC[1], PC.N, PC[2]], vPin = [0.6, 0.22, 0.18];
  pj.majClotures(ligne(TC, [E('e5-a', DEBUT, PC), E('e5-b', DEBUT, PC), E('e5-or', DEBUT, PC), E('e5-ok', DEBUT, PC),
                            E('e5-off', DEBUT, PC), E('e5-rb', DEBUT, PC), E('e5-rp', DEBUT + 4 * H, PC),
                            E('e5-dp', DEBUT + H, PC), X('e5-rt', DEBUT), E('e5-ct', DEBUT, PC),
                            /* la cloture vendue est pinnacle ; la vente etait betfair */
                            ['e5-rc', DEBUT, 'p', vPin, null, vPin, null, 5, null, null],          // betfair absent a la cloture
                            ['e5-rs', DEBUT, 'p', vPin, vPC, vPin, null, 5, null, null]]));       // betfair encore la
  const g = new Game(); joueur(g, A); joueur(g, B);
  G5 = g;
  const simple = {};
  for (const k of ['a', 'b', 'or', 'ab', 'rp', 'dp', 'rt', 'sm', 'pa', 'rb', 'ok', 'off', 'rc', 'rs', 'ct']) simple[k] = g.parieSur(A, 'mfive-' + k, '1n2', '1', 1000, T0);
  const bt = g.parieSur(A, 'mfive-bt', 'btts', 'oui', 1000, T0);
  const combi = g.parieCombine(B, [{ match: 'mfive-a', choix: '1' }, { match: 'mfive-b', marche: 'dc', choix: '1X' }], 1000, T0);
  const elo = g.parieSur(B, 'mfive-elo', '1n2', '1', 1000, T0);
  /* A se regle par un 0-1 : le combine est PERDU (regle = true) */
  const dits = capture(() => g.regleMatch('mfive-a', '0-1'));
  ok(combi.regle === true && combi.gagne === false, 'le combine est perdu sur mfive-a : regle = true');
  ok(dits.some((s) => /^\[clv\] mfive-a : 2 jambe\(s\) figee\(s\), 0 sans cloture$/.test(s)), 'la ligne [clv] du reglement est dite');
  const c = simple.a.jambes[0].clv;
  ok(c.pc === PC[1] && c.tc === TC && c.refc === 'b' && c.sans === null, 'mesuree : pc = p1 de cloture, tc, refc, sans = null');
  eq(c.ori, 0, 'carnet sans la rencontre : orientation non verifiee (ori = 0)');
  eq(c.ctl, 1, 'controle exact : l index a note a la date de la vente le vecteur vendu, meme source (ctl = 1)');
  capture(() => g.regleMatch('mfive-b', '1-1'));
  const jb = combi.jambes[1].clv;
  eq(jb.pc, r5(PC[1] + PC.N), 'le combine DEJA perdu ailleurs voit quand meme sa jambe B figee (1X = p1 + pN de cloture)');
  for (const k of ['or', 'ab', 'rp', 'dp', 'rt', 'sm', 'pa', 'ok', 'bt', 'elo', 'rc', 'rs', 'ct']) capture(() => g.regleMatch('mfive-' + k, '2-0'));
  const s = (k) => simple[k].jambes[0].clv;
  ok(s('or').sans === 'orientation' && s('or').pc === null, 'le carnet dit les equipes a l envers : orientation, pas de pc');
  ok(s('ok').sans === null && s('ok').ori === 1 && s('ok').pc === PC[1], 'le carnet dit les memes equipes : mesuree, ori = 1');
  ok(s('ab').sans === 'absente' && s('ab').pc === null, 'pas dans l index : absente');
  ok(s('rp').sans === 'reportee' && s('rp').pc === null, 'coup d envoi deplace de 4 h : reportee, pas de pc');
  ok(s('dp').sans === 'deplacee' && s('dp').pc === PC[1], 'deplace d 1 h : deplacee, pc garde (compte a part)');
  ok(s('rt').sans === 'retiree' && s('rt').pc === PV[1] && s('rt').tc === TV, 'retiree : pc = le dernier prix valide (l avant-derniere)');
  ok(s('sm').sans === 'sansMouvement' && s('sm').pc === PV[1] && s('sm').tc === TV && s('sm').ctl === 1, 'pari pose apres la derniere releve : sans mouvement (tc = tv), et controle (ctl = 1)');
  ok(s('pa').sans === 'sansMouvement' && s('pa').tc < s('pa').tv && !('ctl' in s('pa')), 'l index a manque la releve de vente : tc < tv (panne), rien a controler');
  /* la MEME source que la vente (relecture du 10/10) */
  ok(s('rs').sans === null && s('rs').refc === 'b' && s('rs').pc === PC[1], 'cloture vendue pinnacle, betfair encore la : pc lu sur betfair (la source de la vente), mesuree');
  ok(s('rc').sans === 'refChangee' && s('rc').refc === 'p' && s('rc').pc === vPin[0], 'betfair absent a la cloture : pc sur pinnacle, mais refChangee (a part, hors verdicts)');
  ok(s('ct').ctl === 0 && s('ct').sans === null, 'l index a note a la date de la vente un autre vecteur : ctl = 0 (le gel n en decide rien, la porte 1(d) si)');
  ok(!('pc' in bt.jambes[0].clv), 'btts (pv null) : rien a figer');
  ok(!('clv' in elo.jambes[0]), 'Elo : rien a figer');
  /* rembourse : rien ne se fige, le bilan l'exclut */
  g.rembourseMatch('mfive-rb');
  ok(!('pc' in s('rb')), 'rembourseMatch ne fige rien');
  /* une seule fois */
  const avant = JSON.stringify(s('ok'));
  assert.throws(() => g.regleMatch('mfive-ok', '0-0'), /already settled/); n++;
  pj.majClotures(ligne(TC + 10 * MIN, [E('e5-ok', DEBUT, { 1: 0.7, N: 0.2, 2: 0.1 })]));
  g._figeClotures('mfive-ok');
  eq(JSON.stringify(s('ok')), avant, 'deja reglee : un second reglement refuse, et _figeClotures ne refige pas une jambe figee');
  ok(!('pc' in s('rb')), '...ni une jambe d un match rembourse (la reprise les saute)');
  /* collecte coupee au reglement */
  process.env.PARIS_CLV = '0';
  try { capture(() => g.regleMatch('mfive-off', '1-0')); } finally { delete process.env.PARIS_CLV; }
  ok(!('pc' in s('off')), 'PARIS_CLV=0 au reglement : rien n est lu ni fige');
  /* le bilan reel de ce match */
  const b = g.clvParAdresse({ now: T0 + 3 * H, addr: A });
  ok(b.actif && b.instrument.valide === false, 'le bilan rend la structure ; instrument non valide (premier jour)');
  eq(b.horsMesure.rembourse, 1, 'rembourse compte hors mesure');
  ok(b.horsMesure.orientation === 1 && b.horsMesure.absente === 1 && b.horsMesure.reportee === 1, 'orientation, absente, reportee : hors mesure, une chacune sous SON nom');
  ok(b.population.aPart.retiree.jambes === 1 && b.population.aPart.deplacee.jambes === 1 && b.population.aPart.refChangee.jambes === 1, 'retiree, deplacee, refChangee : a part, pas jetees');
  eq(b.instrument.pannes, 1, 'la panne est comptee');
  eq(b.population.sansMouvement.jambes, 2, 'les jambes sans mouvement (la tardive et la panne) sont comptees, pas mesurees');
  eq(b.horsMesure.nonFigee, 1, 'la jambe reglee collecte coupee : non figee, comptee contre la couverture');
  /* controlees (la releve de vente encore dans l'index) : a, b, dp, rt, sm, ok, rc, rs, ct pour A, et
     les deux jambes du combine de B ; ct seule differe. Ni or, ab, rp (sortis avant), ni pa (releve purgee). */
  ok(b.instrument.controle.jambes === 11 && b.instrument.controle.conformes === 10 && b.instrument.controle.taux === null,
     'le controle exact : ' + b.instrument.controle.conformes + ' conformes sur ' + b.instrument.controle.jambes + ' (taux tu sous 60)');
  ok(b.detail && b.detail.jambes.length === N5 && b.detail.jambes.every((x) => !('addr' in x)), '?addr= : le detail des jambes de l adresse');
  ok(b.detail.jambes.some((x) => x.ctl === 0) && b.detail.jambes.some((x) => x.ctl === 1), 'et le controle de chaque jambe');
}
/* figeJambe : chaque garde, appelee seule */
{
  const J = (o) => Object.assign({ match: 'm', marche: '1n2', choix: '1', cote: 2, domicile: 'H', exterieur: 'A', debut: DEBUT,
                                   clv: { ev: 'e', pv: 0.5, tv: TV, ref: 'betfair', pm: [0.5, 0.27, 0.23] } }, o || {});
  const obs = (t, p, ref) => [t, 'avant', ref || 'b', [p[1], p.N, p[2]]];
  const REC = (o) => Object.assign({ l: 'soccer_epl', debut: DEBUT, d: obs(TC, PC), a: obs(TV, { 1: 0.5, N: 0.27, 2: 0.23 }) }, o || {});
  eq(clv.figeJambe(J(), REC(), { rembourse: true }, null).sans, 'rembourse', 'match rembourse au gel : sans = rembourse');
  eq(clv.figeJambe(J(), { debut: DEBUT, a: obs(TV, PV) }, null, null).sans, 'absente', 'entree sans derniere observation (d) : absente, pas retiree');
  eq(clv.figeJambe(J(), REC(), null, { dom: 'H', ext: 'Autre' }).sans, 'orientation', 'UNE equipe differente (exterieur) suffit : orientation');
  eq(clv.figeJambe(J(), REC(), null, { dom: 'Autre', ext: 'A' }).pc, null, 'domicile seul different : pas de pc');
  eq(clv.figeJambe(J(), REC({ debut: undefined }), null, null).sans, 'reportee', 'coup d envoi illisible dans l index : reportee');
  const a = clv.figeJambe(J(), REC({ debut: DEBUT + 2.5 * H }), null, null);
  ok(a.sans === 'deplacee' && a.pc === PC[1], 'deplace de 2 h 30 : deplacee, pc garde');
  eq(clv.figeJambe(J(), REC({ debut: DEBUT + 3 * H }), null, null).sans, 'deplacee', 'deplace de 3 h pile : deplacee (borne incluse)');
  eq(clv.figeJambe(J(), REC({ debut: DEBUT + 3 * H + MIN }), null, null).sans, 'reportee', '3 h 01 : reportee');
  eq(clv.figeJambe(J({ clv: { ev: 'e', pv: 0.5, tv: null, ref: 'betfair', pm: [0.5, 0.27, 0.23] } }), REC(), null, null).sans, 'sansMouvement',
     'heure du prix vendu inconnue : sans mouvement (pas mesuree)');
  /* le controle exact, seul */
  eq(clv.figeJambe(J(), REC(), null, null).ctl, 1, 'controle : la releve de vente (avant-derniere) porte le vecteur vendu : 1');
  eq(clv.figeJambe(J(), REC({ a: obs(TV, { 1: 0.27, N: 0.5, 2: 0.23 }) }), null, null).ctl, 0, 'deux issues echangees a la date de vente : 0');
  eq(clv.figeJambe(J(), REC({ a: obs(TV, { 1: 0.5, N: 0.23, 2: 0.27 }) }), null, null).ctl, 0, 'le 1 identique, N et 2 echanges : 0 (les trois issues comptent)');
  eq(clv.figeJambe(J(), REC({ a: [TV, 'avant', 'b', null] }), null, null).ctl, 0, 'une observation a l instant de la vente sans vecteur : 0, sans lever');
  eq(clv.figeJambe(J(), REC({ a: obs(TV, { 1: 0.5, N: 0.27, 2: 0.23 }, 'p') }), null, null).ctl, 0, 'meme vecteur, autre source (pinnacle contre betfair) : 0');
  eq(clv.figeJambe(J(), REC({ a: obs(TV + 1, { 1: 0.5, N: 0.27, 2: 0.23 }) }), null, null).ctl, undefined, 'aucune releve a la milliseconde de la vente : pas de controle');
  eq(clv.figeJambe(J(), REC({ a: obs(TV, { 1: 0.50001, N: 0.27, 2: 0.22999 }) }), null, null).ctl, 0, 'un pas d arrondi (1e-5) d ecart : 0');
  eq(clv.figeJambe(J({ clv: { ev: 'e', pv: 0.5, tv: TV, ref: '', pm: [0.5, 0.27, 0.23] } }), REC(), null, null).sans, 'refChangee', 'source de la vente inconnue : refChangee (jamais mesuree sans meme source)');
  eq(clv.figeJambe(J({ clv: { ev: 'e', pv: 0.5, tv: TV, ref: '', pm: [0.5, 0.27, 0.23] } }), REC({ d: obs(TV, PV), a: null }), null, null).sans, 'sansMouvement',
     'sans mouvement d abord : une cloture qui n a pas bouge n est jamais « refChangee »');
  eq(clv.figeJambe(J(), REC({ a: [TV, 'avant', 'x'] }), null, null).ctl, 0, 'un retrait note a l instant meme de la vente : 0, sans lever');
  /* la lettre de chaque source = celle que le journal ecrit (prix_journal.ligneDe) */
  for (const [ref, lettre] of Object.entries(clv.LETTRE)) {
    const l = pj.ligneDe({ ligue: 'soccer_epl', t: TV, quoi: 'avant', evs: [], refs: [{ id: 'z', debut: DEBUT, ref, p: PV, livres: 5 }], ecrit: true });
    eq(l.e[0][2], lettre, ref + ' : lettre « ' + lettre + ' » dans le journal et dans clv.LETTRE');
  }
  eq(clv.AVANT_CLOTURE_MS, pj.AVANT_CLOTURE_MS, 'la borne des 5 min est celle de l index (prix_journal.AVANT_CLOTURE_MS)');
}

// =================================================================== §6
console.log('\n-- §6. le paiement ne depend jamais de la CLV --');
{
  charge([auMarche('paie-1', 'ev-p1'), auMarche('paie-2', 'ev-p2')]);
  pj.majClotures(ligne(TC, [E('ev-p1', DEBUT, PC), E('ev-p2', DEBUT, PC)]));
  const joue = () => {
    const g = new Game(); joueur(g, A, 50000); joueur(g, B, 50000);
    g.parieSur(A, 'paie-1', '1n2', '1', 3000, T0);
    g.parieSur(B, 'paie-1', '1n2', '2', 2000, T0);
    g.parieSur(B, 'paie-1', 'dc', '1X', 1500, T0);
    g.parieCombine(A, [{ match: 'paie-1', choix: '1' }, { match: 'paie-2', choix: '2' }], 1000, T0);
    return g;
  };
  const regle = (g) => { let r; const dits = capture(() => { r = g.regleMatch('paie-1', '2-1'); }); return { g, r, dits, a: g.betBalanceStr(A), b: g.betBalanceStr(B) }; };
  process.env.PARIS_CLV = '0';
  const ref = regle(joue());
  delete process.env.PARIS_CLV;
  const vraie = pj.lisCloturesEtat;
  let leve;
  pj.lisCloturesEtat = () => { throw new Error('index en panne'); };
  try { leve = regle(joue()); } finally { pj.lisCloturesEtat = vraie; }
  const sig = (x) => JSON.stringify([x.r.gagnants, x.r.perdus, x.r.enAttente, x.r.paye, x.r.mise, x.a, x.b]);
  eq(sig(leve), sig(ref), 'index qui leve : memes gagnants, perdus, en attente, paye, soldes que collecte coupee');
  ok(leve.dits.some((s) => s === '[clv] paie-1 : index en panne'), 'et l echec est dit au journal de l hote');
  /* un index illisible a l'instant du reglement : RIEN n'est fige (avant :
     'absente' pour toujours), le reglement suivant reprend */
  fs.writeFileSync(pj.fichierClotures(), '{"v":1,"ev":{"ev-p1"');
  const illisible = regle(joue());
  eq(sig(illisible), sig(ref), 'index illisible : memes paiements');
  ok(illisible.dits.some((s) => s === '[clv] paie-1 : index de cloture illisible (json), rien de fige : 4 jambe(s) reprise(s) au prochain reglement'),
     'rien n est fige, et c est dit');
  const jambesP1 = illisible.g.paris.map((p) => p.jambes[0]).filter((j) => j.match === 'paie-1');
  ok(jambesP1.length === 4 && jambesP1.every((j) => !('pc' in j.clv)), 'les 4 jambes de paie-1 restent sans cloture (pas « absente » pour toujours)');
  /* la releve suivante met l'index illisible de cote et repart ; le reglement suivant reprend paie-1 */
  capture(() => pj.majClotures(ligne(TC + MIN, [E('ev-p1', DEBUT, PC), E('ev-p2', DEBUT, PC)])));
  const dits2 = capture(() => illisible.g.regleMatch('paie-2', '0-1'));
  ok(dits2.some((s) => /^\[clv\] paie-2 : 5 jambe\(s\) figee\(s\), 0 sans cloture ; 4 reprise\(s\) d un reglement precedent$/.test(s)), 'le reglement de paie-2 reprend les 4 jambes de paie-1 : ' + dits2.join(' | '));
  ok(jambesP1.every((j) => j.clv.tc === TC + MIN && j.clv.pc !== null), 'figees sur la cloture de l index refait');
  /* un index ABSENT, lui, fige 'absente' (journal coupe, volume neuf : rien a attendre) */
  fs.rmSync(pj.fichierClotures());
  const absent = regle(joue());
  ok(absent.dits.some((s) => /^\[clv\] paie-1 : 0 jambe\(s\) figee\(s\), 4 sans cloture \(absente 4\)$/.test(s)), 'index absent : les jambes sont dites absentes');
  eq(sig(absent), sig(ref), 'et les memes paiements');
  /* un index d'une AUTRE version (un deploiement a venir) : rien de fige non plus */
  fs.writeFileSync(pj.fichierClotures(), JSON.stringify({ v: 99, ev: {} }));
  const autre = regle(joue());
  ok(autre.dits.some((s) => /^\[clv\] paie-1 : index de cloture version, rien de fige/.test(s))
     && autre.g.paris.every((p) => p.jambes.every((j) => !j.clv || !('pc' in j.clv))), 'index d une autre version : rien de fige, dit');
  fs.rmSync(pj.fichierClotures());
  for (const f of fs.readdirSync(BAC)) if (f.indexOf('paris_prix_clotures.json.illisible-') === 0) fs.rmSync(path.join(BAC, f));
}

// =================================================================== §7
console.log('\n-- §7. le bilan --');
const NOW = T0 + 30 * JOUR;
let SEQ = 0;
/* une jambe faite a la main. Une jambe figee AVEC une cloture porte par
   defaut le controle exact reussi (ctl = 1, comme une releve de vente encore
   dans l'index) ; o.ctl le change, ctl: null l'omet. */
function jambe(o) {
  const marche = o.marche || '1n2', choix = o.choix || '1';
  const p = (o.pm || [0.5, 0.25, 0.25]).slice();
  const pv = o.pv !== undefined ? o.pv : clv.probaIssue(marche, choix, { 1: p[0], N: p[1], 2: p[2] });
  const tv = o.tv || NOW - 20 * JOUR;
  const j = { match: o.match || ('m-' + o.ev), marche, choix, cote: o.cote, domicile: 'H', exterieur: 'A', debut: o.debut || tv + 3 * H,
              clv: { ev: o.ev, pv, tv, ref: 'betfair', pm: p } };
  if (o.figee !== false) {
    Object.assign(j.clv, { pc: o.pc === undefined ? null : o.pc, tc: o.tc || tv + H, refc: 'b', sans: o.sans === undefined ? null : o.sans, ori: 1 });
    const ctl = o.ctl !== undefined ? o.ctl : (j.clv.pc !== null ? 1 : null);
    if (ctl !== null) j.clv.ctl = ctl;
  }
  return j;
}
function ticket(addr, j, o) {
  const x = o || {};
  return { id: 'b' + (++SEQ), addr, t: x.t || NOW - 20 * JOUR, mise: x.mise || 1000, cote: j.cote, rapport: j.cote * (x.mise || 1000),
           regle: true, gagne: x.gagne === undefined ? false : x.gagne, jambes: [j] };
}
const reglesDe = (ts, rembourses) => {
  const R = {};
  for (const t of ts) for (const j of t.jambes) R[j.match] = { t: NOW, resultat: '1' };
  for (const m of rembourses || []) R[m] = { t: NOW, resultat: null, rembourse: true };
  return R;
};
/* une adresse : `k` rencontres distinctes ; r et clv alternent autour de leur moyenne */
function adresse(addr, k, o) {
  const x = o || {};
  const out = [];
  for (let i = 0; i < k; i++) {
    const sg = i % 2 ? 1 : -1;
    const pv = x.pv || 0.5, r = (x.r || 0) + sg * (x.dr === undefined ? 0.02 : x.dr);
    const pc = r5(pv * (1 + r));
    const cote = x.clv !== undefined ? (1 + x.clv + sg * (x.dclv || 0)) / pc : (x.cote || 0.9 / pv);
    out.push(ticket(addr, jambe({ ev: addr.slice(0, 6) + '-' + i, cote: Math.round(cote * 1e6) / 1e6, pv: undefined, pc,
                                    pm: x.pm || [pv, (1 - pv) / 2, (1 - pv) / 2], choix: x.choix || '1',
                                    ctl: x.ctl ? x.ctl(i) : undefined }), { mise: x.mise, t: x.t }));
  }
  return out;
}
const bilan = (ts, o) => clv.bilan(ts, (o && o.regles) || reglesDe(ts, o && o.rembourses), Object.assign({ now: NOW }, o || {}));
const raison = (b, cle) => b.instrument.raisons.some((r) => r.cle === cle);
{
  /* la formule */
  const t1 = ticket('0xf0', jambe({ ev: 'f1', cote: 2, pc: 0.55, pm: [0.5, 0.25, 0.25] }));
  const b1 = bilan([t1], { addr: '0xf0' });
  proche(b1.detail.jambes[0].clv, 0.10, 1e-9, 'cote 2,00 et pc 0,55 : CLV +10,0 %');
  proche(b1.detail.jambes[0].r, 0.10, 1e-4, 'r = pc / pv - 1 = +10 %');

  /* la population de reference, VALIDE : six adresses de 40 favoris, r symetrique */
  const foule = [];
  for (let a = 0; a < 6; a++) foule.push(...adresse('0xc' + a + 'c0', 40, { r: 0, dr: 0.02 }));
  const b0 = bilan(foule);
  ok(b0.instrument.valide, 'une population de FAVORIS seulement est validee (r ne porte pas la marge) : ' + JSON.stringify(b0.instrument.raisons));
  eq(b0.population.observations, 240, '240 observations avec mouvement');
  ok(b0.instrument.controle.jambes === 240 && b0.instrument.controle.conformes === 240 && b0.instrument.controle.taux === 1, 'controle exact : 240 sur 240');
  ok(b0.adresses.every((x) => x.verdict && x.verdict.talent === 'inline' && x.verdict.argent === null), 'sans talent : « in line », jamais « beats »');
  ok(b0.adresses.every((x) => x.partFoule === r4t(40 / 240) && x.rencontresComparees === 40), 'chaque adresse : sa part de la foule (1/6), 40 rencontres comparees');
  ok(!('margeRecalculee' in b0.instrument) && !('R_MAX' in clv) && !('recoteParDefaut' in clv), 'plus de marge recalculee (la cote vendue elle-meme), plus de porte sur la moyenne de r');

  /* 39 contre 40, dans une population valide */
  const t39 = adresse('0x3939', 39, { r: 0, dr: 0.01, clv: 0.2, dclv: 0.01 });
  const t40 = adresse('0x4040', 40, { r: 0, dr: 0.01, clv: 0.2, dclv: 0.01 });
  const b2 = bilan(foule.concat(t39, t40));
  ok(b2.instrument.valide, 'toujours valide');
  const x39 = b2.adresses.find((x) => x.addr === '0x3939'), x40 = b2.adresses.find((x) => x.addr === '0x4040');
  ok(x39.moyenne === null && x39.verdict === null && x39.manque === 1 && x39.ecartFoule === null && x39.valeurConcedee === null, '39 rencontres : ni moyenne, ni verdict, ni ecart, ni valeur ; il en manque 1');
  ok(x39.demiLargeur > 0, 'mais la demi-largeur de son IC est dite (de combien on est loin)');
  const v40 = t40.map((t) => t.jambes[0].cote * t.jambes[0].clv.pc - 1);
  const m40 = v40.reduce((s, v) => s + v, 0) / 40;
  const sd40 = Math.sqrt(v40.reduce((s, v) => s + (v - m40) ** 2, 0) / 39);
  proche(x40.moyenne, m40, 1e-4, '40 rencontres : la moyenne');
  proche(x40.ic95[0], m40 - 1.959964 * sd40 / Math.sqrt(40), 1e-4, 'et l IC 95 % = m ± 1,96 e.-t. / racine de n (borne basse)');
  proche(x40.ic95[1], m40 + 1.959964 * sd40 / Math.sqrt(40), 1e-4, '(borne haute)');
  ok(x40.verdict.argent === 'beats' && x40.verdict.talent === 'inline', '+20 % de CLV sans mouvement propre : « beats the closing line », talent « in line »');
  ok(x40.verdict.aProposer === true && x40.valeurConcedee > 0, 'porte 3 : a proposer (beats ET valeur concedee > 0), rien d automatique');
  /* « beats » sur des miettes, mais l'argent perdu sur le gros pari : rien a proposer */
  const miettes = adresse('0x4242', 40, { r: 0, dr: 0.01, clv: 0.2, dclv: 0.01, mise: 100 });
  const gros = miettes[0].jambes[0];
  gros.cote = Math.round((0.9 / gros.clv.pc) * 1e6) / 1e6;
  miettes[0].mise = 1000000;
  const bm = bilan(foule.concat(t39, t40, miettes));
  const x42 = bm.adresses.find((x) => x.addr === '0x4242');
  ok(bm.instrument.valide && x42.verdict.argent === 'beats' && x42.valeurConcedee < 0 && x42.verdict.aProposer === false,
     'porte 3 : « beats » par rencontre, mais valeur concedee ' + x42.valeurConcedee + ' (le gros pari a -10 %) : rien a proposer');

  /* 40 paris identiques sur UNE rencontre */
  const quarante = [];
  for (let i = 0; i < 40; i++) quarante.push(ticket('0x4141', jambe({ ev: 'meme', match: 'm-meme', cote: 2.4, pc: 0.6, pm: [0.5, 0.25, 0.25] })));
  const b3 = bilan(foule.concat(quarante));
  const x41 = b3.adresses.find((x) => x.addr === '0x4141');
  ok(x41.rencontres === 1 && x41.jambesBrutes === 40 && x41.verdict === null, '40 paris identiques sur un match : 1 rencontre, 40 jambes, aucun verdict');
  ok(x41.partFoule === r4t(1 / 241) && b3.adresses.find((x) => x.addr === '0xc0c0').partFoule === r4t(40 / 241),
     'la part de la foule se compte en OBSERVATIONS (1 et 40 sur 241), pas en tickets (280)');

  /* chaque condition de la porte 1, des deux cotes de sa borne */
  const fouleT = (dt) => { const f = []; for (let a = 0; a < 6; a++) f.push(...adresse('0xd' + a + 'd0', 40, { r: 0, t: NOW - dt })); return f; };
  const invalide = (b, cle, quoi) => {
    ok(!b.instrument.valide && raison(b, cle), quoi + ' : non valide, raison « ' + cle + ' » — '
       + (b.instrument.raisons.find((r) => r.cle === cle) || {}).texte);
    ok(b.adresses.every((x) => x.verdict === null && x.moyenne === null && x.ecartFoule === null), '...et aucune moyenne, aucun ecart, aucun verdict, meme a 40 rencontres');
    /* sinon la carte dirait « k address(es) tested » avant toute validation */
    ok(b.comparaisons.adressesJugees === 0 && b.comparaisons.fauxPositifsSansCorrection === 0, '...ni aucune adresse « jugee »');
  };
  invalide(bilan(fouleT(3 * JOUR)), 'jours', '(a) 3 jours de collecte');
  invalide(bilan(fouleT(13.9 * JOUR)), 'jours', '(a) 13,9 jours');
  ok(bilan(fouleT(14 * JOUR)).instrument.valide, '(a) 14 jours pile : valide (borne incluse)');
  invalide(bilan(foule.slice(0, 99)), 'observations', '(b) 99 observations');
  ok(bilan(foule.slice(0, 100)).instrument.valide, '(b) 100 : valide');
  const trous = [];
  for (let i = 0; i < 27; i++) trous.push(ticket('0xe0e0', jambe({ ev: 'tr' + i, cote: 1.8, pc: null, sans: 'absente', pm: [0.5, 0.25, 0.25] })));
  invalide(bilan(foule.concat(trous)), 'couverture', '(c) 240 couvertes sur 267 (89,9 %)');
  ok(bilan(foule.concat(trous.slice(0, 26))).instrument.valide, '(c) 240 sur 266 (90,2 %) : valide');
  /* la panne (tc < tv) ne compte pas comme couverte... */
  const tardives = (k, avantKo) => {
    const l = [];
    for (let i = 0; i < k; i++) l.push(ticket('0xe1e1', jambe({ ev: 'pn' + avantKo + '-' + i, cote: 1.8, pc: 0.5, sans: 'sansMouvement',
      tv: NOW - 20 * JOUR, tc: NOW - 20 * JOUR - H, debut: NOW - 20 * JOUR + avantKo, pm: [0.5, 0.25, 0.25], ctl: null })));
    return l;
  };
  const bp = bilan(foule.concat(tardives(27, 3 * H)));
  ok(bp.instrument.pannes === 27 && raison(bp, 'couverture'), '(c) une panne (tc < tv, vente 3 h avant le coup d envoi) ne compte pas comme couverte');
  /* ...sauf une vente a moins de 5 min du coup d'envoi : l'index ne garde rien la, par construction */
  const bq = bilan(foule.concat(tardives(27, 4 * MIN)));
  ok(bq.instrument.valide && bq.instrument.pannes === 0 && bq.instrument.venteApresCloture === 27 && bq.population.sansMouvement.jambes === 27,
     '(c) vendue a 4 min du coup d envoi : sans mouvement, couverte, PAS une panne (relecture du 10/10)');
  const bb = bilan(foule.concat(tardives(1, clv.AVANT_CLOTURE_MS), tardives(1, clv.AVANT_CLOTURE_MS + 1)));
  ok(bb.instrument.venteApresCloture === 1 && bb.instrument.pannes === 1, '(c) la borne : 5 min pile = apres la cloture indexable ; 5 min et 1 ms = panne');
  /* (d) le CONTROLE EXACT : assez de jambes controlees, et conformes */
  const fouleC = (fn) => { const f = []; for (let a = 0; a < 6; a++) f.push(...adresse('0xf' + a + 'c0', 40, { r: 0, ctl: (i) => fn(a * 40 + i) })); return f; };
  invalide(bilan(fouleC(() => null)), 'controle', '(d) aucune jambe controlable (releves de vente sorties de l index)');
  invalide(bilan(fouleC((k) => (k < 59 ? 1 : null))), 'controle', '(d) 59 jambes controlees');
  const c60 = bilan(fouleC((k) => (k < 60 ? 1 : null)));
  ok(c60.instrument.valide && c60.instrument.controle.taux === 1, '(d) 60 controlees, toutes conformes : valide');
  invalide(bilan(fouleC((k) => (k < 60 ? (k === 7 ? 0 : 1) : null))), 'ecart', '(d) 60 controlees dont une differente (98,3 %)');
  ok(bilan(fouleC((k) => (k < 100 ? (k === 7 ? 0 : 1) : null))).instrument.valide, '(d) 100 controlees dont une differente (99 %) : valide');
  invalide(bilan(fouleC((k) => (k < 100 ? (k === 7 || k === 8 ? 0 : 1) : null))), 'ecart', '(d) 100 controlees dont deux differentes (98 %)');
  invalide(bilan(fouleC((k) => (k < 199 ? (k === 7 || k === 8 ? 0 : 1) : null))), 'ecart', '(d) 199 controlees dont deux differentes (98,99 %, sous 99 %)');
  ok(bilan(fouleC((k) => (k < 200 ? (k === 7 || k === 8 ? 0 : 1) : null))).instrument.valide, '(d) 200 controlees dont deux differentes (99 % pile) : valide');
  /* (d) n'est plus la moyenne de r : une foule qui bat le marche ne ferme plus la porte */
  const haut = []; for (let a = 0; a < 6; a++) haut.push(...adresse('0xa' + a + 'a0', 40, { r: 0.05 }));
  const bh = bilan(haut);
  ok(bh.instrument.valide && bh.instrument.moyenneR === 0.05, 'r = +5 % partout : valide (l ancienne porte se fermait), la moyenne de r reste dite : ' + bh.instrument.moyenneR);
  ok(bh.adresses.every((x) => x.verdict.talent === 'inline'), '...et chacun « in line » contre les autres (personne ne bat la foule)');

  /* ---- LE CAS QUE L'INSTRUMENT DOIT ATTRAPER (relecture du 10/10) ----
     un parieur qui bat la cloture (+8 points de r) et pese la MOITIE de la
     foule : l'ancienne porte (|moyenne de r| <= 1 point) ne s'ouvrait jamais */
  const fin8 = adresse('0xf1f1', 200, { r: 0.08, dr: 0.07, cote: 1.9 });
  const autres = []; for (let a = 0; a < 5; a++) autres.push(...adresse('0x2' + a + '20', 40, { r: 0, dr: 0.07, cote: 1.9 }));
  const bf = bilan(fin8.concat(autres));
  const xf8 = bf.adresses.find((x) => x.addr === '0xf1f1');
  ok(bf.instrument.valide && bf.population.moyenneR > 0.03, 'gros parieur fin a 50 % de 400 observations : instrument VALIDE (moyenne de r ' + bf.population.moyenneR + ')');
  ok(xf8.verdict.argent === 'beats' && xf8.verdict.talent === 'sharper', '...et il est vu : « beats the closing line », « sharper than the crowd »');
  ok(xf8.partFoule === 0.5 && Math.abs(xf8.ecartFoule - 0.08) < 1e-9, '...sa part de la foule (50 %) est dite, et son ecart a la foule est entier (+8 points, pas (1 - 0,5) x 8)');

  /* « sharper » : r au-dessus de la foule de SA categorie */
  const fin = adresse('0x5555', 40, { r: 0.10, dr: 0.02 });
  const fouleB = []; for (let a = 0; a < 6; a++) fouleB.push(...adresse('0xb' + a + 'b0', 40, { r: -0.0167, dr: 0.02 }));
  const b4 = bilan(fouleB.concat(fin));
  ok(b4.instrument.valide, 'valide');
  const x55 = b4.adresses.find((x) => x.addr === '0x5555');
  ok(x55.verdict.talent === 'sharper', 'r = +10 % contre ~-1,7 % pour la foule des favoris : « sharper than the crowd »');
  ok(b4.adresses.filter((x) => x.addr !== '0x5555').every((x) => x.verdict.talent === 'inline'), 'la foule : « in line »');

  /* la foule SANS l'adresse jugee : une adresse qui pese 60 % de sa categorie */
  const nulsAutres = adresse('0x2c2c', 40, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0, dr: 0.02 });
  const grosNul = adresse('0x6c6c', 60, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0.03, dr: 0.01 });
  const bl = bilan(foule.concat(nulsAutres, grosNul));
  const xg = bl.adresses.find((x) => x.addr === '0x6c6c');
  ok(bl.instrument.valide && Math.abs(xg.ecartFoule - 0.03) < 1e-9 && xg.rencontresComparees === 60,
     '60 % des nuls : ecart a la foule +3,0 points, mesure contre les 40 AUTRES nuls (avec lui : (1 - 0,6) x 3 = 1,2)');
  /* la VARIANCE de la foule aussi, sans lui : 400 nuls tres reguliers a
     +2 points contre 40 autres a 0 ; avec ses propres jambes dans la variance
     de la foule (0,0041 au lieu de 1e-6), l'erreur type passait a 0,010 et
     « sharper » tombait */
  const bv = bilan(adresse('0x7c7c', 400, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0.02, dr: 0.001 })
    .concat(adresse('0x8c8c', 40, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0, dr: 0.001 })));
  ok(bv.instrument.valide && bv.adresses.find((x) => x.addr === '0x7c7c').verdict.talent === 'sharper', '+2 points tres reguliers sur 400 nuls contre 40 autres a 0 : « sharper » (variance de la foule sans lui)');
  /* une categorie sans foule de 40 jambes (sans lui) ne se compare pas */
  const b39 = bilan(foule.concat(nulsAutres.slice(0, 39), grosNul));
  const x39n = b39.adresses.find((x) => x.addr === '0x6c6c');
  ok(x39n.verdict.talent === null && x39n.ecartFoule === null && x39n.rencontresComparees === 0, 'foule des nuls sans lui : 39 jambes -> aucune comparaison (« no crowd »)');
  ok(Number.isFinite(x39n.moyenne) && x39n.verdict.argent !== undefined, '...le verdict d argent, lui, reste (il ne depend pas de la foule)');
  /* categories melees : 30 favoris (une foule) et 10 nuls (aucune) -> 30 rencontres comparees, sous 40 : pas de talent */
  const mele = adresse('0x9c9c', 30, { r: 0, dr: 0.02 }).concat(adresse('0x9c9d', 10, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0.05 })
    .map((t) => Object.assign(t, { addr: '0x9c9c' })));
  const xm = bilan(foule.concat(mele)).adresses.find((x) => x.addr === '0x9c9c');
  ok(xm.rencontres === 40 && xm.rencontresComparees === 30 && xm.verdict.talent === null, '40 rencontres dont 30 comparables : aucun verdict de talent sous 40 comparees');

  /* le parieur de favoris SANS talent, dans une foule d'outsiders (sceptique) */
  const out = []; for (let a = 0; a < 4; a++) out.push(...adresse('0x0' + a + '0f', 40, { pv: 0.2, choix: '2', pm: [0.6, 0.2, 0.2], cote: 3.5, r: 0, dr: 0.02 }));
  const favs = []; for (let a = 0; a < 2; a++) favs.push(...adresse('0x1' + a + '1f', 40, { pv: 0.6, pm: [0.6, 0.2, 0.2], cote: 1.58, r: 0, dr: 0.02 }));
  const fav = adresse('0xfafa', 40, { pv: 0.6, pm: [0.6, 0.2, 0.2], cote: 1.58, r: 0, dr: 0.02 });
  const b5 = bilan(out.concat(favs, fav));
  const xf = b5.adresses.find((x) => x.addr === '0xfafa');
  ok(b5.instrument.valide && xf.ic95[0] > b5.population.moyenne, 'le favori a une CLV bien au-dessus de la foule (l ancienne regle l aurait dit « sharper »)');
  eq(xf.verdict.talent, 'inline', '...mais r juge sans la marge, contre les autres favoris : « in line » (sceptique : 97,1 % de faux « sharper » avec l ancienne regle)');
  eq(bilan(out.concat(fav)).adresses.find((x) => x.addr === '0xfafa').verdict.talent, null, 'seul parieur de favoris : aucune foule a qui comparer, jamais « sharper »');

  /* le nul qui derive (mesure du 10/10 : +1,52 % a 3 jours) : la foule de SA categorie */
  const fouleF = []; for (let a = 0; a < 6; a++) fouleF.push(...adresse('0x7' + a + '70', 40, { r: 0, dr: 0.02 }));
  const nuls = []; for (let a = 0; a < 2; a++) nuls.push(...adresse('0x8' + a + '80', 30, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0.015, dr: 0.01 }));
  const tnul = adresse('0x9090', 60, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0.015, dr: 0.01 });
  const b6 = bilan(fouleF.concat(nuls, tnul));
  const xn = b6.adresses.find((x) => x.addr === '0x9090');
  ok(b6.instrument.valide && xn.ic95R[0] > b6.population.moyenneR, 'le parieur de nuls depasse la moyenne de r de TOUTE la foule (borne basse ' + xn.ic95R[0] + ' > ' + b6.population.moyenneR + ')');
  eq(xn.verdict.talent, 'inline', '...mais pas celle des nuls : « in line » (31,5 % de faux « sharper » a n = 40 sans la categorie)');
  ok(b6.population.parCategorie.nul.jambes === 120 && b6.population.parCategorie.nul.moyenneR > 0.01, 'la derive par categorie est rapportee');

  /* Bonferroni : passe a 1,96, pas au z corrige */
  const borde = adresse('0xbdbd', 40, { r: 0, dr: 0.01, clv: 0.02, dclv: 0.0568 });
  const b7 = bilan(foule.concat(borde));
  const xb = b7.adresses.find((x) => x.addr === '0xbdbd');
  const k = b7.comparaisons.adressesJugees;
  eq(k, 7, '7 adresses jugees');
  proche(b7.comparaisons.z, clv.quantileNormal(1 - 0.05 / 14), 1e-4, 'z de Bonferroni = quantile(1 - 0,05 / 2k)');
  ok(xb.ic95[0] > 0 && xb.verdict.argent === null, 'borne basse a 1,96 > 0, mais pas au z corrige : pas de « beats »');
  proche(b7.comparaisons.fauxPositifsSansCorrection, 7 * 0.025, 1e-9, 'la ligne « k adresses, ~x faux positifs sans correction »');
  /* « sharper » aussi : Bonferroni ET l'incertitude de la moyenne de la foule.
     Foule de 80 jambes a ±5 points ; +1,25 % tres regulier sur 40 : passe a
     z = 1,96 (0,0125 - 1,96 x 0,0056 > 0), pas au z de 3 adresses (2,39), et
     passerait sans l'erreur type de la foule (la sienne seule : 0,0002) */
  const bs = bilan(adresse('0xc1', 40, { r: 0, dr: 0.05 }).concat(adresse('0xc2', 40, { r: 0, dr: 0.05 }), adresse('0xf1', 40, { r: 0.0125, dr: 0.001 })));
  ok(bs.instrument.valide && bs.comparaisons.adressesJugees === 3, 'foule de 80 jambes a ±5 points, 3 adresses jugees');
  eq(bs.adresses.find((a) => a.addr === '0xf1').verdict.talent, 'inline', '+1,25 % sur 40 contre cette foule : « in line » (Bonferroni et incertitude de la foule)');

  /* la mise : CLV ponderee et valeur concedee, sur les jambes qui ont bouge */
  const pond = adresse('0x6060', 40, { r: 0, dr: 0.01, clv: 0.05, dclv: 0.03, mise: 1000 });
  pond[0].mise = 100000;
  const tard = ticket('0x6060', jambe({ ev: 'tard', cote: 2.2, pc: 0.5, sans: 'sansMouvement', pm: [0.5, 0.25, 0.25] }), { mise: 500000 });
  const b8 = bilan(foule.concat(pond, [tard]));
  const xp = b8.adresses.find((x) => x.addr === '0x6060');
  const vp = pond.map((t) => ({ m: t.mise, v: t.jambes[0].cote * t.jambes[0].clv.pc - 1 }));
  const conc = vp.reduce((s, x) => s + x.m * x.v, 0), mises = vp.reduce((s, x) => s + x.m, 0);
  proche(xp.clvPonderee, conc / mises, 1e-4, 'CLV ponderee par la mise');
  eq(xp.valeurConcedee, Math.round(conc), 'valeur concedee = somme mise x CLV, sur les jambes qui ont bouge (la jambe tardive exclue)');
  ok(xp.sansMouvement.jambes === 1 && xp.sansMouvement.mise === 500000 && Math.abs(xp.sansMouvement.partMise - 500000 / (500000 + mises)) < 1e-4,
     'la jambe sans mouvement : comptee a part, en nombre ET en part de mise');

  /* a part, hors mesure, remboursements */
  const divers = [
    ticket('0x1111', jambe({ ev: 'rt', cote: 1.8, pc: 0.52, sans: 'retiree' }), { mise: 700 }),
    ticket('0x1111', jambe({ ev: 'dp', cote: 1.8, pc: 0.52, sans: 'deplacee' }), { mise: 300 }),
    ticket('0x1111', jambe({ ev: 'rc', cote: 1.8, pc: 0.52, sans: 'refChangee' }), { mise: 200 }),
    ticket('0x1111', jambe({ ev: 'rb', match: 'm-rb', cote: 1.8, pc: null })),
    ticket('0x1111', jambe({ ev: 'tr', cote: 1.8, pc: 0.52 }), { gagne: null }),
    ticket('0x1111', jambe({ ev: 'at', match: 'm-pas-regle', cote: 1.8, figee: false })),
    ticket('0x1111', jambe({ ev: 'bt', marche: 'btts', choix: 'oui', cote: 1.9, pv: null, figee: false })),
    ticket('0x1111', jambe({ ev: 'nf', cote: 1.8, figee: false })),
    { id: 'vieux', addr: '0x1111', t: NOW - 25 * JOUR, mise: 100, cote: 2, rapport: 200, regle: true, gagne: false, jambes: [{ match: 'm-vieux', choix: '1', cote: 2 }] },
    { id: 'elo', addr: '0x1111', t: NOW - 10 * JOUR, mise: 100, cote: 2, rapport: 200, regle: true, gagne: false, jambes: [{ match: 'm-elo', choix: '1', cote: 2 }] },
  ];
  const R9 = reglesDe(divers.filter((t) => t.jambes[0].match !== 'm-pas-regle'), ['m-rb']);
  const b9 = bilan(foule.concat(divers), { regles: Object.assign(reglesDe(foule), R9), addr: '0x1111' });
  ok(b9.population.aPart.retiree.jambes === 1 && b9.population.aPart.retiree.mise === 700 && b9.population.aPart.deplacee.mise === 300
     && b9.population.aPart.refChangee.jambes === 1 && b9.population.aPart.refChangee.mise === 200, 'retiree, deplacee, refChangee : a part, nombre et mise');
  eq(b9.horsMesure.rembourse, 2, 'match rembourse ET ticket rembourse : exclus');
  eq(b9.horsMesure.enAttente, 1, 'match pas encore regle : en attente');
  eq(b9.horsMesure.marche.btts, 1, 'btts : hors mesure (marche)');
  eq(b9.horsMesure.nonFigee, 1, 'reglee mais jamais figee : comptee (contre la couverture)');
  ok(b9.horsMesure.avantMesure === 1 && b9.horsMesure.elo === 1, 'sans clv : avant la premiere jambe collectee, ou a l Elo apres');
  eq(b9.detail.jambes.length, 8, '?addr= : les 8 jambes collectees de l adresse');
  const x11 = b9.adresses.find((x) => x.addr === '0x1111');
  ok(x11.aPart.retiree.jambes === 1 && x11.aPart.refChangee.jambes === 1 && x11.rencontres === 0, 'par adresse aussi ; les jambes a part ne comptent pas dans les rencontres');
  /* chaque classe hors mesure comptee sous SON nom */
  const d27 = [ticket('0x2727', jambe({ ev: 'o1', cote: 1.8, pc: null, sans: 'orientation' })),
               ticket('0x2727', jambe({ ev: 'a1', cote: 1.8, pc: null, sans: 'absente' })),
               ticket('0x2727', jambe({ ev: 'r1', cote: 1.8, pc: null, sans: 'reportee' }))];
  const b27 = bilan(foule.concat(d27));
  ok(b27.horsMesure.orientation === 1 && b27.horsMesure.absente === 1 && b27.horsMesure.reportee === 1, 'orientation, absente, reportee : 1 chacune (pas seulement leur somme)');
  /* une jambe sans etiquette mais tc <= tv : le bilan la revoit sans mouvement */
  const b31 = bilan(foule.concat([ticket('0x3131', jambe({ ev: 'c31', cote: 1.8, pc: 0.55, sans: null, tc: NOW - 20 * JOUR }))]));
  eq(b31.adresses.find((x) => x.addr === '0x3131').sansMouvement.jambes, 1, 'tc = tv sans etiquette : comptee sans mouvement par le bilan lui-meme');

  /* aucun chiffre sous son seuil */
  const b10 = bilan(foule.slice(0, 60));
  ok(b10.population.moyenne === null && b10.population.ic95 === null && b10.population.manque === 40, 'sous 100 observations : aucune moyenne de population, il en manque 40');
  ok(b10.instrument.moyenneR === null && b10.instrument.evVente === null, 'ni de moyenne de r, ni de marge vendue (60 jambes eligibles)');
  ok(bilan(foule.slice(0, 100)).instrument.evVente !== null, '...qui se montre a 100');
  eq(bilan(foule.slice(0, 59)).instrument.controle.taux, null, 'taux du controle tu sous 60 jambes controlees');
  eq(bilan(foule.concat([divers[0]])).population.aPart.retiree.moyenneClv, null, '1 jambe retiree : pas de moyenne');
  const n39 = adresse('0x5353', 39, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3, r: 0, dr: 0.01 });
  ok(bilan(foule.concat(n39)).population.parCategorie.nul.moyenneR === null, '39 nuls : pas de moyenne de categorie');
  ok(bilan(foule.concat(n39, adresse('0x5454', 1, { pv: 0.3, choix: 'N', pm: [0.4, 0.3, 0.3], cote: 3 }))).population.parCategorie.nul.moyenneR !== null, '40 : la moyenne de categorie se montre');

  /* porte 4 : rapportee, jamais agie */
  eq(clv.PORTE4.DERIVE_P90_MIN, cotes.MARGE_ISSUE_MIN, 'porte 4 : la derive exigee = la plus petite marge par issue de cotes.js');
  const idx = { v: 1, ev: {} };
  for (let i = 0; i < 20; i++) {
    const d0 = NOW - 2 * JOUR + i * H;
    idx.ev['ix' + i] = { l: 'soccer_epl', debut: d0, d: [d0 - (60 + i) * MIN, 'avant', 'b', [0.5, 0.25, 0.25]],
                         a: [d0 - (200 + i) * MIN, 'periodique', 'b', [i < 17 ? 0.49 : 0.45, 0.255, 0.255]] };
  }
  idx.ev.futur = { l: 'soccer_epl', debut: NOW + H, d: [NOW - H, 'avant', 'b', [0.5, 0.25, 0.25]], a: null };
  idx.ev.obs = { l: 'soccer_x', o: 1, debut: NOW - H, d: [NOW - 3 * H, 'avant', 'b', [0.5, 0.25, 0.25]], a: null };
  const d = clv.decritIndex(idx, NOW);
  ok(d.rencontres === 20 && d.ageMedianMin === 69.5, 'age de cloture : 20 rencontres commencees (ni a venir, ni observees), mediane 69,5 min');
  ok(d.derive.rencontres === 20 && d.derive.p90 > 0.1 && d.derive.mediane < 0.03, 'derive entre les deux dernieres releves : mediane et 90e centile');
  const sm = (k0) => { const l = []; for (let i = 0; i < k0; i++) l.push(ticket('0x3333', jambe({ ev: 'sm' + i, cote: 1.8, pc: 0.5, sans: 'sansMouvement' }), { mise: 1000 })); return l; };
  const b11 = bilan(foule.concat(sm(100)), { index: idx });
  ok(b11.porte4.atteinte === true && b11.porte4.rencontresPariees === 340 && b11.porte4.partMiseSansMouvement > 0.25,
     'porte 4 atteinte (340 rencontres pariees, ' + b11.porte4.partMiseSansMouvement + ' de la mise sans mouvement, derive p90 ' + b11.porte4.deriveP90 + ') : a PROPOSER');
  const b12 = bilan(foule.concat(sm(68)), { index: idx });
  ok(b12.porte4.partMiseSansMouvement > 0.2 && b12.porte4.partMiseSansMouvement < 0.25 && b12.porte4.atteinte === false && b12.porte4.manque.indexOf('stake without move') >= 0,
     'a 68 jambes sans mouvement (' + b12.porte4.partMiseSansMouvement + ', sous 25 %) : non atteinte');
  const p99 = bilan(foule.slice(0, 60).concat(sm(39)), { index: idx });
  ok(p99.porte4.rencontresPariees === 99 && p99.porte4.manque.indexOf('fixtures') >= 0, '99 rencontres pariees : non atteinte (fixtures)');
  const p100 = bilan(foule.slice(0, 60).concat(sm(40)), { index: idx });
  ok(p100.porte4.rencontresPariees === 100 && p100.porte4.atteinte === true, '100 rencontres pariees : atteinte');
  ok(b0.clotures === null && b0.porte4.manque.indexOf('price drift') >= 0, 'sans index : pas de derive, porte 4 non atteinte');
  eq(b0.limites, clv.LIMITES, 'la limite est dite : football au prix du marche, 1-N-2 et double chance');

  /* collecte coupee : la route ne calcule rien */
  process.env.PARIS_CLV = '0';
  let rc;
  try { rc = new Game().clvParAdresse({ now: NOW }); } finally { delete process.env.PARIS_CLV; }
  ok(rc.actif === false && !('adresses' in rc) && !('instrument' in rc), 'PARIS_CLV=0 : actif false, aucun bilan calcule');
}

// =================================================================== §8
console.log('\n-- §8. la route, un vrai serveur --');
function lance(port, cle, dossier, extra) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: dossier,
    RPC_URL: 'http://127.0.0.1:1', VAULT_ADDRESS: '', SWOGE_TOKEN: '',
    AI_COLONIE: '0', TG_BOT_TOKEN: '', TG_CHAT_ID: '', ODDS_API_KEY: '', MONITEUR_URL: '',
    POLY_PAPIER: '0', DEPLOIEMENT_V4: '0',
  }, extra || {});
  if (cle) env.ADMIN_KEY = cle; else delete env.ADMIN_KEY;
  delete env.PARIS_CLV;
  const p = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let traces = '';
  p.stdout.on('data', (x) => { traces += x; });
  p.stderr.on('data', (x) => { traces += x; });
  return new Promise((res, rej) => {
    const fin = setTimeout(() => { clearInterval(t); try { p.kill('SIGKILL'); } catch (e) {} rej(new Error('serveur muet : ' + traces.slice(-800))); }, 60000);
    const t = setInterval(async () => {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/health');
        if (r.ok) { clearInterval(t); clearTimeout(fin); res({ p, traces: () => traces }); }
      } catch (e) { /* pas encore */ }
    }, 150);
  });
}

(async () => {
  {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-clv-route-'));
    /* l'etat du §5 (tickets figes) et l'index de cloture, tels que le volume les garde */
    fs.writeFileSync(path.join(dossier, 'state.json'), JSON.stringify(G5.serialize()));
    const CLE = 'cle-clv-essai-7c1e';
    const s = await lance(8797, CLE, dossier);
    try {
      const r = await fetch('http://127.0.0.1:8797/paris/clv', { headers: { 'x-admin-key': CLE } });
      eq(r.status, 200, 'GET /paris/clv avec la cle dans l en-tete : 200');
      /* elle nomme des joueurs et leurs mises : aucun cache ne doit la garder */
      eq(r.headers.get('cache-control'), 'no-store', 'cache-control: no-store');
      const j = await r.json();
      ok(j.actif === true && j.seuil === 40 && j.seuilProvisoire === true, 'actif, seuil 40 (provisoire)');
      ok(j.instrument && j.instrument.valide === false && Array.isArray(j.instrument.raisons) && j.instrument.raisons.length >= 2,
         'l instrument dit pourquoi il n est pas valide : ' + j.instrument.raisons.map((x) => x.cle).join(', '));
      ok(Array.isArray(j.adresses) && j.adresses.some((x) => x.addr === A && x.verdict === null && x.moyenne === null), 'l adresse est listee, sans chiffre ni verdict');
      ok(j.horsMesure && j.population && j.comparaisons && j.porte4 && j.limites, 'population, comparaisons, porte 4, hors mesure, limites');
      ok(!('detail' in j), 'sans addr : pas de detail');
      const r2 = await fetch('http://127.0.0.1:8797/paris/clv?addr=' + A.toUpperCase(), { headers: { 'x-admin-key': CLE } });
      const j2 = await r2.json();
      ok(j2.detail && j2.detail.addr === A && j2.detail.jambes.length === N5, '?addr= (casse ignoree) : le detail des ' + N5 + ' jambes collectees');
      const j3 = await (await fetch('http://127.0.0.1:8797/paris/clv?addr=0x' + 'a'.repeat(5000), { headers: { 'x-admin-key': CLE } })).json();
      ok(j3.detail && j3.detail.addr.length === 100 && j3.detail.jambes.length === 0, '?addr= de 5 002 caracteres : borne a 100, aucun detail');
      eq(await (await fetch('http://127.0.0.1:8797/paris/clv')).status, 401, 'sans la cle : 401');
      eq(await (await fetch('http://127.0.0.1:8797/paris/clv', { headers: { 'x-admin-key': CLE + 'x' } })).status, 401, 'une cle presque juste : 401');
    } finally { try { s.p.kill('SIGKILL'); } catch (e) {} fs.rmSync(dossier, { recursive: true, force: true }); }
  }
  ok(/'\/paris\/clv'/.test(fs.readFileSync(path.join(__dirname, 'acces.test.js'), 'utf8')), 'acces.test.js la compte parmi les portes privees (503 sans ADMIN_KEY, 401 sans cle)');
  ok(/lance clv +"\$SRV" node clv\.test\.js/.test(fs.readFileSync(path.join(__dirname, 'verifie.sh'), 'utf8')), 'verifie.sh lance cet essai');

  // ================================================================= §9
  console.log('\n-- §9. l index de cloture, lu et mis de cote --');
  {
    const F = pj.fichierClotures();
    try { fs.rmSync(F); } catch (e) { /* deja absent */ }
    eq(pj.lisClotures(), null, 'absent : null');
    eq(pj.lisCloturesEtat().etat, 'absent', '...et dit « absent » (le gel fige alors « absente »)');
    /* le premier index (fichier absent) n'est pas un index illisible */
    const dits0 = capture(() => pj.majClotures(ligne(TC, [E('lu-1', DEBUT, PC)])));
    ok(!dits0.some((x) => /illisible/.test(x)), 'premier index (fichier absent) : aucun « illisible » au journal');
    eq(pj.lisCloturesEtat().etat, 'ok', 'ecrit : « ok »');
    const c1 = pj.cloture('lu-1');
    ok(c1 && c1.d[0] === TC && c1.debut === DEBUT, 'cloture(ev) : la derniere observation d avant-match');
    c1.d[0] = 0;
    eq(pj.cloture('lu-1').d[0], TC, 'relue du disque a chaque appel : modifier l objet rendu ne touche pas l index');
    eq(pj.cloture('inconnu'), null, 'une rencontre absente : null');
    fs.writeFileSync(F, JSON.stringify({ v: 0, ev: { 'lu-1': {} } }));
    ok(pj.lisClotures() === null && pj.lisCloturesEtat().etat === 'version', 'une autre version : null, « version » (le gel attend)');
    fs.writeFileSync(F, '{"v":1,"ev":{"lu-1"');
    ok(pj.lisClotures() === null && pj.lisCloturesEtat().etat === 'illisible' && pj.lisCloturesEtat().erreur === 'json', 'illisible : null, sans lever, « illisible (json) »');
    const T9 = TC + 5 * MIN;
    const dits = capture(() => pj.majClotures(ligne(T9, [E('lu-2', DEBUT, PC)])));
    const cote = F + '.illisible-' + T9;
    ok(fs.existsSync(cote) && fs.readFileSync(cote, 'utf8') === '{"v":1,"ev":{"lu-1"', 'l index illisible est MIS DE COTE, intact, sous .illisible-<t>');
    ok(dits.some((x) => /index de cloture illisible .*mis de cote sous paris_prix_clotures\.json\.illisible-/.test(x)), 'et c est dit au journal de l hote');
    ok(pj.lisClotures().ev['lu-2'] && !pj.lisClotures().ev['lu-1'], 'le nouvel index repart de cette releve');
    fs.rmSync(cote);
    /* une LECTURE refusee (ici : un dossier a la place du fichier, EISDIR) ne
       dit rien du contenu : ni mise de cote, ni ecrasement */
    fs.rmSync(F); fs.mkdirSync(F);
    const echecsAvant = pj.etat().echecs.clotures || 0;
    let rendu;
    capture(() => { rendu = pj.majClotures(ligne(T9 + MIN, [E('lu-3', DEBUT, PC)])); });
    ok(rendu === false && fs.statSync(F).isDirectory() && !fs.existsSync(F + '.illisible-' + (T9 + MIN)), 'lecture refusee : rien de mis de cote, rien d ecrase, la releve est sautee');
    eq(pj.etat().echecs.clotures, echecsAvant + 1, 'et l echec est compte (dit au journal de l hote, une fois par heure)');
    ok(pj.lisCloturesEtat().etat === 'illisible' && pj.lisCloturesEtat().erreur === 'EISDIR', 'lisCloturesEtat : « illisible (EISDIR) » (le gel attend, ne fige pas « absente »)');
    fs.rmSync(F, { recursive: true, force: true });
    /* trois mises de cote gardees, les plus recentes */
    for (const t of [1, 2, 3, 4]) fs.writeFileSync(F + '.illisible-' + (T9 - t * MIN), 'x');
    fs.writeFileSync(F, '{"v":1,');
    capture(() => pj.majClotures(ligne(T9 + 2 * MIN, [E('lu-4', DEBUT, PC)])));
    const gardes = fs.readdirSync(path.dirname(F)).filter((x) => x.indexOf(path.basename(F) + '.illisible-') === 0);
    eq(JSON.stringify(gardes.map((x) => Number(x.split('.illisible-')[1])).sort((x, y) => x - y)),
       JSON.stringify([T9 - 2 * MIN, T9 - MIN, T9 + 2 * MIN]), pj.ILLISIBLES_GARDES + ' mises de cote gardees, les plus recentes (les deux plus vieilles purgees)');
    for (const x of gardes) fs.rmSync(path.join(path.dirname(F), x));
  }

  // ================================================================= §10
  console.log('\n-- §10. la carte du panneau --');
  {
    const admin = require('./admin');
    const page = admin.page('jeton');
    const iPan = page.indexOf('id="clvPan"'), iParis = page.indexOf('&#127942; Sports bets'), iFruit = page.indexOf('The fruit collection');
    ok(iPan > iParis && iPan < iFruit, 'la carte est entre « Sports bets » et « The fruit collection »');
    ok(/<div data-vue="jeux"[^>]*id="clvPan"/.test(page), 'dans la vue « jeux » (admin_vues.test.js verifie qu elle a son onglet)');
    ok(page.replace(/\s+/g, ' ').indexOf('Our margin runs from about 5% on a favourite to over 30% on an outsider; talent is judged on how the price moved, not on our margin.') > 0,
       'le sous-titre corrige (plus de « -9 % » faux)');
    ok(/clvCase\(p\.address\)/.test(page.slice(page.indexOf('function parisResume('), page.indexOf('function parisResume(') + 2500)), 'la fiche joueur porte la case CLV');
    const debut = page.indexOf('var CLVMAP='), fin = page.indexOf('async function loadClv(');
    ok(debut > 0 && fin > debut, 'la page porte clvRend');
    const ctx = { esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
                  ent: (v) => Math.round(Number(v) || 0).toLocaleString('en-US'), short: (a) => a.slice(0, 6) + '…' + a.slice(-4) };
    vm.createContext(ctx);
    vm.runInContext(page.slice(debut, fin), ctx);
    const sous = { actif: true, seuil: 40, instrument: { valide: false, raisons: [{ cle: 'jours', texte: 'Collecting for 2 day(s); 14 needed <b>.' }] },
                   population: { observations: 12, manque: 88, moyenne: null, sansMouvement: { jambes: 3, partMise: 0.4 } },
                   comparaisons: { adressesJugees: 0 },
                   adresses: [{ addr: A, nom: '<img src=x onerror=alert(1)>', rencontres: 12, demiLargeur: 0.031, moyenne: null, ic95: null, verdict: null }] };
    const x = vm.runInContext('clvRend(' + JSON.stringify(sous) + ')', ctx);
    ok(/Too few to judge &mdash; 12 of 40 fixtures measured/.test(x.corps), 'sous 40 : « Too few to judge — 12 of 40 fixtures measured »');
    ok(!/Beats|Sharper|In line/.test(x.corps + x.haut), 'aucun verdict');
    ok(/Not validated yet/.test(x.haut) && x.haut.indexOf('&lt;b&gt;') > 0, 'instrument non valide : dit, raisons echappees');
    ok(x.corps.indexOf('<img') < 0 && x.corps.indexOf('&lt;img') >= 0, 'le nom du joueur est echappe');
    ok(/12 fixture observation\(s\) with a price move &mdash; 88 more before any average/.test(x.haut), 'la population : n et ce qui manque, aucune moyenne');
    const cellules = x.corps.split('<td').slice(3, 5).join('');
    ok(cellules.indexOf('%') < 0, 'les cases CLV et IC sont vides (« — »), seule la demi-largeur parle');
    const valide = { actif: true, seuil: 40, instrument: { valide: true, observations: 240, couverture: 0.97, jours: 20, controle: { jambes: 180, conformes: 179 } },
                     population: { observations: 240, moyenne: -0.1, ic95: [-0.11, -0.09], moyenneR: 0.001, sansMouvement: {} },
                     comparaisons: { adressesJugees: 7, z: 2.6901, fauxPositifsSansCorrection: 0.175 },
                     adresses: [{ addr: B, nom: 'Bo', rencontres: 41, demiLargeur: 0.01, moyenne: 0.2, ic95: [0.19, 0.21], evVente: 0.2, ecartFoule: 0,
                                  valeurConcedee: 123456, clvPonderee: 0.187, partFoule: 0.1708, verdict: { argent: 'beats', talent: 'inline' } },
                                { addr: A, nom: 'Al', rencontres: 40, demiLargeur: 0.01, moyenne: -0.1, ic95: [-0.11, -0.09], evVente: -0.1, ecartFoule: 0.1,
                                  valeurConcedee: -4000, clvPonderee: -0.1, partFoule: 0.1667, verdict: { argent: null, talent: 'sharper' } },
                                { addr: '0x' + 'c'.repeat(40), nom: 'Cy', rencontres: 40, demiLargeur: 0.01, moyenne: -0.05, ic95: [-0.06, -0.04], evVente: -0.05, ecartFoule: null,
                                  valeurConcedee: -2000, clvPonderee: -0.05, partFoule: 0.1667, verdict: { argent: null, talent: null } }] };
    const y = vm.runInContext('clvRend(' + JSON.stringify(valide) + ')', ctx);
    ok(/Beats the closing line/.test(y.corps) && /Sharper than the crowd/.test(y.corps) && /In line with the crowd/.test(y.corps), 'valide : les verdicts en anglais');
    ok(/No crowd of 40 legs to compare with/.test(y.corps), 'sans foule a qui comparer : « No crowd of 40 legs to compare with », jamais « in line »');
    ok(/\+20\.0%/.test(y.corps) && /-11\.0% to -9\.0%/.test(y.corps), 'la moyenne et l IC');
    ok(/conceded \+123,456 \(stake-weighted CLV \+18\.7%\)/.test(y.corps) && /conceded -4,000/.test(y.corps), 'la valeur concedee (porte 3) et la CLV ponderee a cote du verdict');
    ok(/17\.1% of all observations/.test(y.corps), 'la part de la foule de chaque adresse');
    ok(/179 of 180 legs matched the price index at the moment of sale/.test(y.haut), 'l instrument valide dit son controle exact');
    ok(/7 address\(es\) tested: at the usual 95% bar about 0\.175 would be flagged by luck alone, so the bar is raised to z = 2\.6901 \(Bonferroni\)/.test(y.haut), 'la ligne des comparaisons multiples');
    const z = vm.runInContext('clvRend({actif:false,seuil:40})', ctx);
    ok(/collection is <b>OFF<\/b> \(PARIS_CLV=0\)/.test(z.haut), 'collecte coupee : dit');
    vm.runInContext('CLVMAP=' + JSON.stringify({ [A]: { rencontres: 12, moyenne: null }, [B]: { rencontres: 41, moyenne: 0.2 } }), ctx);
    eq(vm.runInContext('clvCase(' + JSON.stringify(A.toUpperCase()) + ')', ctx), '<div><i>CLV</i><b>12 of 40 fixtures</b></div>', 'la case de la fiche : sous le seuil, le compte, pas de chiffre');
    eq(vm.runInContext('clvCase(' + JSON.stringify(B) + ')', ctx), '<div><i>CLV</i><b>+20.0% over 41 fixtures</b></div>', 'au-dessus : la moyenne et son n');
  }

  fs.rmSync(BAC, { recursive: true, force: true });
  console.log('\nclv.test.js : ' + n + ' verifications OK');
  process.exit(0);
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
