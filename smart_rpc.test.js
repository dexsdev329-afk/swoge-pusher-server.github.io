'use strict';
/*
 * Le client du noeud du detecteur smart money (smart_rpc.js, 13/10/2026).
 * Aucune requete reelle : un FAUX NOEUD aux regles et aux messages du vrai
 * (essais/smart_money/faux_noeud.js, mesures de la sonde du 13/10).
 * L'intention :
 *  - TRANCHES ADAPTATIVES : on commence large, on coupe en deux sur un refus
 *    de plage ou de plafond de lignes, on regrossit ; le resultat est EXACTEMENT
 *    celui d'une lecture brute, en bien moins d'appels que 20 000 blocs fixes ;
 *  - une limite plus basse annoncee par le noeud est apprise ;
 *  - jamais une requete au-dela de la pointe ;
 *  - cache brut immuable (gzip), seulement sous la pointe sure, refus de
 *    plafond memorise, deuxieme lecture = 0 appel sur la partie fermee ;
 *  - 403, 429 (statut ou corps), non-JSON : recul 15 s puis 60 s, puis
 *    abandon ; viem ne relance JAMAIS en cachette ;
 *  - budgets d'appels et d'octets par passe ; espacement leger/lourd ;
 *  - aucune methode d'ecriture ne part, meme pas jusqu'au reseau.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const R = require('./smart_rpc');
const { fauxNoeud, journal, pad } = require('./essais/smart_money/faux_noeud');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) n++; else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || String(a) === String(b), `${m} (lu ${a}, attendu ${b})`);
const TR = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const JETON = '0x00000000000000000000000000000000000000aa';
const W = (k) => '0x' + k.toString(16).padStart(40, '0');
const tx = (k) => '0x' + k.toString(16).padStart(64, '0');
/** Une horloge qu'on avance, et un `dors` qui l'avance. */
function temps() {
  const T = { now: 1e12, attentes: [] };
  T.horloge = () => T.now;
  T.dors = async (ms) => { T.attentes.push(ms); T.now += ms; };
  return T;
}
/** Des Transfer du jeton : `densite(bloc)` lignes au bloc. */
function chaine(blocs) {
  const l = [];
  let k = 0;
  for (const [b, nb] of blocs) for (let i = 0; i < nb; i++) l.push(journal(JETON, [TR, pad(W(1 + (k % 50))), pad(W(100 + (k % 7)))], [1000n + BigInt(k)], b, tx(++k), i));
  return l;
}
const brut = (logs, de, a) => logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= de && b <= a; });
const cle = (l) => l.transactionHash + ':' + l.logIndex;

(async () => {
  // ================================================== 1. tranches adaptatives
  console.log('-- 1. tranches adaptatives : exactes, et bien moins d\'appels --');
  {
    /* une vie de jeton : une 1re heure dense (24 000 lignes en 36 000 blocs), puis eparse sur 20 M de blocs */
    const blocs = [];
    for (let b = 50000000; b < 50036000; b += 3) blocs.push([b, 2]);
    for (let b = 50036000; b < 70000000; b += 5000) blocs.push([b, 1]);
    const logs = chaine(blocs);
    const F = fauxNoeud({ logs, pointe: 80000000 });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    const res = await r.lisLogs({ address: JETON, topics: [TR] }, 50000000, 70000000, { pointe: 79999990, sure: 79998990 });
    const attendu = brut(logs, 50000000, 70000000);
    egal(res.logs.length, attendu.length, `toutes les lignes (${attendu.length}) sont rendues`);
    ok(res.logs.map(cle).join() === attendu.map(cle).join(), 'dans l\'ordre, sans doublon ni trou');
    ok(res.stats.refusLignes >= 1 && res.stats.coupes >= 1, `le plafond de 10 000 lignes a fait couper (${res.stats.refusLignes} refus, ${res.stats.coupes} coupes)`);
    ok(res.stats.appels <= 40, `adaptatif : ${res.stats.appels} appels (20 000 blocs fixes : ${Math.ceil(20000001 / 20000)})`);
    const reqs = F.etat.requetes.filter((q) => q.method === 'eth_getLogs').map((q) => parseInt(q.params[0].toBlock, 16) - parseInt(q.params[0].fromBlock, 16) + 1);
    ok(Math.max(...reqs) > 1000000, 'on commence LARGE (une requete de plus d\'1 M de blocs)');
    ok(reqs.every((s) => s <= 10000000), 'jamais plus que la limite du noeud pour un filtre simple');
  }
  // ================================================== 2. limites apprises, genres
  console.log('-- 2. genres de filtre et limite apprise --');
  {
    const logs = chaine([[1000, 1], [2000000, 1]]);
    const F = fauxNoeud({ logs, pointe: 5000000, limites: { simple: 1000000 } });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    const res = await r.lisLogs({ address: JETON, topics: [TR] }, 0, 4000000, { pointe: 4999990, sure: 4998990 });
    egal(res.logs.length, 2, 'limite plus basse : tout est lu quand meme');
    egal(res.stats.refusBlocs, 1, 'un seul refus de plage : « only 1000000 are allowed »');
    egal(r.etat.lmax.simple, 19, 'la limite est APPRISE (2^19 = 524 288 <= 1 000 000)');
    const avant = F.etat.requetes.length;
    await r.lisLogs({ address: W(77), topics: [TR] }, 0, 4000000, { pointe: 4999990, sure: 4998990 });
    ok(F.etat.requetes.slice(avant).every((q) => parseInt(q.params[0].toBlock, 16) - parseInt(q.params[0].fromBlock, 16) < 1000000), 'apprise, elle sert aux lectures suivantes : plus aucun refus de plage');
    const G = fauxNoeud({ logs: chaine([[100, 1]]), pointe: 900000 });
    const r2 = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    await r2.lisLogs({ topics: [TR, null, [pad(W(1)), pad(W(2))]] }, 0, 800000, { pointe: 899990, sure: 898990 });
    const spans = G.etat.requetes.filter((q) => q.method === 'eth_getLogs').map((q) => parseInt(q.params[0].toBlock, 16) - parseInt(q.params[0].fromBlock, 16) + 1);
    ok(spans.every((s) => s <= 30000) && G.etat.refus === 0, 'sans adresse : tranches <= 30 000 blocs d\'emblee (L14 = 16 384), 0 refus');
    const H = fauxNoeud({ logs: chaine([[100, 1]]), pointe: 900000 });
    const r3 = R.cree({ prendre: H.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    await r3.lisLogs({ address: JETON, topics: [TR, [pad(W(1)), pad(W(2))]] }, 0, 800000, { pointe: 899990, sure: 898990 });
    ok(H.etat.requetes.filter((q) => q.method === 'eth_getLogs').every((q) => parseInt(q.params[0].toBlock, 16) - parseInt(q.params[0].fromBlock, 16) + 1 <= 100000), 'une position en tableau : <= 100 000 blocs (L16)');
    egal(R.genre({ address: [JETON] }), 'simple', 'un tableau d\'une seule adresse reste « simple »');
  }
  // ================================================== 3. pointe
  console.log('-- 3. jamais au-dela de la pointe --');
  {
    const F = fauxNoeud({ logs: chaine([[100, 1], [999995, 1]]), pointe: 1000000 });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    const res = await r.lisLogs({ address: JETON, topics: [TR] }, 0, 5000000, { pointe: 999990, sure: 998990 });
    ok(F.etat.requetes.every((q) => q.method !== 'eth_getLogs' || parseInt(q.params[0].toBlock, 16) <= 999990), 'aucun toBlock au-dela de la pointe demandee');
    egal(res.logs.length, 1, 'la ligne au-dela de la pointe n\'est pas lue (elle le sera a la passe suivante)');
    const vide = await r.lisLogs({ address: JETON, topics: [TR] }, 2000000, 1000, { pointe: 999990, sure: 998990 });
    egal(vide.stats.appels, 0, 'de > a : 0 appel (le noeud rendrait [] sans erreur)');
  }
  // ================================================== 4. cache
  console.log('-- 4. cache brut immuable --');
  {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-rpc-'));
    const blocs = []; for (let b = 1000000; b < 1030000; b += 2) blocs.push([b, 1]);
    const logs = chaine(blocs);
    const F = fauxNoeud({ logs, pointe: 3000000 });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier });
    const o = { pointe: 2999990, sure: 2998990 };
    const a = await r.lisLogs({ address: JETON, topics: [TR] }, 0, 2999990, o);
    const fichiers = fs.readdirSync(path.join(dossier, 'brut'));
    ok(fichiers.length > 0 && fichiers.every((f) => /^L_[0-9a-f]{16}_L\d+_\d+(_trop)?\.json\.gz$/.test(f)), 'cles = empreinte du filtre + L + i (' + fichiers.length + ' fichiers)');
    ok(fichiers.some((f) => /_trop\.json\.gz$/.test(f)), 'le refus de plafond est memorise');
    const unF = fichiers.find((f) => !/_trop/.test(f));
    ok(Array.isArray(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dossier, 'brut', unF))))), 'gzip de la reponse brute');
    const mt = fichiers.map((f) => fs.statSync(path.join(dossier, 'brut', f)).mtimeMs);
    const avant = F.etat.http;
    const b = await r.lisLogs({ address: JETON, topics: [TR] }, 0, 2999990, o);
    egal(b.logs.length, a.logs.length, 'deuxieme lecture : memes lignes');
    egal(F.etat.http - avant, 1, 'deuxieme lecture : 1 appel (la queue ouverte, au-dessus de la pointe sure), 0 refus de plafond rejoue');
    ok(fichiers.every((f, k) => fs.statSync(path.join(dossier, 'brut', f)).mtimeMs === mt[k]), 'aucun fichier reecrit (immuable)');
    ok(!fs.readdirSync(path.join(dossier, 'brut')).some((f) => { const m = f.match(/_L(\d+)_(\d+)\.json/); return m && (Number(m[2]) + 1) * 2 ** Number(m[1]) - 1 > o.sure; }), 'rien n\'est mis en cache au-dessus de la pointe sure (pointe - 1 000)');
    /* une cellule qui finit ENTRE la pointe sure et la pointe : lue, jamais cachee */
    /* 8 lignes sous le bloc 2 097 151, 7 au-dessus, un plafond de 10 : le noeud refuse L23 et L22, la
       cellule L21 [0, 2 097 151] finit entre la pointe sure et la pointe */
    const G2 = fauxNoeud({ logs: chaine([[2000100, 8], [2097200, 7]]).map((l) => Object.assign(l, { topics: [TR, pad(W(1)), l.topics[2]] })), pointe: 2097300, limites: { lignes: 10 } });
    const r4 = R.cree({ prendre: G2.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier });
    const o4 = { pointe: 2097250, sure: 2097250 - 1000 };
    const f4 = { address: JETON, topics: [TR, pad(W(1))] };
    const lu4 = await r4.lisLogs(f4, 2000000, 2097250, o4);
    egal(lu4.logs.length, 15, 'les 15 lignes sont lues (coupe sous le plafond de 10)');
    const e4 = R.empreinte(f4);
    ok(!fs.readdirSync(path.join(dossier, 'brut')).filter((f) => f.startsWith('L_' + e4)).some((f) => { const m = f.match(/_L(\d+)_(\d+)\.json/); return m && (Number(m[2]) + 1) * 2 ** Number(m[1]) - 1 > o4.sure; }),
       'une cellule finie au-dessus de la pointe sure (bloc 2 097 151 > 2 096 250) n\'est pas mise en cache');
    r.cacheEcrit('essai', { a: 1 });
    ok(!r.cacheEcrit('essai', { a: 2 }) && r.cacheLit('essai').a === 1, 'une cle deja ecrite ne change plus');
    const recus = {}; for (let k = 1; k <= 45; k++) recus[tx(k)] = { transactionHash: tx(k), logs: [] };
    const G = fauxNoeud({ logs: [], pointe: 10, recus });
    const r2 = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier });
    const m = await r2.recus(Object.keys(recus));
    egal(m.size, 45, '45 recus');
    egal(G.etat.http, 3, 'en lots de 20 : 3 requetes HTTP');
    await r2.recus(Object.keys(recus));
    egal(G.etat.http, 3, 'les recus (immuables) viennent du cache ensuite : 0 requete');
    fs.rmSync(dossier, { recursive: true, force: true });
  }
  // ================================================== 5. refus, recul, abandon
  console.log('-- 5. 403 / 429 / non-JSON : recul 15 s puis 60 s, puis abandon --');
  for (const panne of [429, 403, 'html', 'json429']) {
    const F = fauxNoeud({ logs: [], pointe: 1000, pannes: [panne] });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    const p = await r.pointe();
    egal(p.pointe, 1000, `${panne} une fois : la lecture reussit apres le recul`);
    ok(T.attentes.includes(15000), `${panne} : recul de 15 s`);
    egal(F.etat.http, 2, `${panne} : exactement 2 requetes HTTP (viem ne relance pas en cachette)`);
  }
  {
    const F = fauxNoeud({ logs: [], pointe: 1000, pannes: [429, 429, 429, 429] });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    let e = null; try { await r.pointe(); } catch (x) { e = x; }
    ok(e instanceof R.AbandonPasse, 'trois refus de suite : la passe est ABANDONNEE');
    egal(T.attentes.filter((x) => x >= 15000).join(','), '15000,60000', 'apres les reculs de 15 s puis 60 s');
    egal(F.etat.http, 3, '3 requetes, pas une de plus');
  }
  // ================================================== 6. budgets et espacement
  console.log('-- 6. budgets et espacement --');
  {
    const F = fauxNoeud({ logs: [], pointe: 1000 });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, budgetAppels: 3 });
    await r.pointe(); await r.pointe(); await r.pointe();
    let e = null; try { await r.pointe(); } catch (x) { e = x; }
    ok(e instanceof R.BudgetEpuise && e.budget === 'appels', 'le 4e appel d\'une passe de 3 : BudgetEpuise');
    egal(F.etat.http, 3, 'et il ne part pas');
    r.nouvellePasse();
    await r.pointe();
    egal(F.etat.http, 4, 'nouvelle passe : le compteur repart');
    ok(T.attentes.every((x) => x === 1500) && T.attentes.length === 3, 'appels legers espaces de 1,5 s : ' + T.attentes.join(','));
    T.attentes.length = 0;
    await r.lisLogs({ address: JETON, topics: [TR] }, 0, 10, { pointe: 900, sure: 0 });
    await r.pointe();
    egal(T.attentes.slice(-1)[0], 3000, 'apres un getLogs (lourd) : 3 s');
    r.nouvellePasse({ appels: 100, octets: 10 });
    let e2 = null; try { await r.pointe(); await r.pointe(); } catch (x) { e2 = x; }
    ok(e2 instanceof R.BudgetEpuise && e2.budget === 'octets', 'budget d\'octets par passe');
    r.nouvellePasse();
    await r.pointe();
    ok(true, 'le budget borne d\'une passe ne colle pas a la suivante');
  }
  // ================================================== 7. lecture seule
  console.log('-- 7. lecture seule --');
  {
    const F = fauxNoeud({ logs: [], pointe: 1000 });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4']) {
      let e = null; try { await r.appel(m, []); } catch (x) { e = x; }
      ok(e instanceof R.MethodeInterdite, `${m} : refusee`);
    }
    egal(F.etat.http, 0, 'aucune n\'a atteint le reseau');
    ok(!R.METHODES.has('eth_sendRawTransaction') && R.METHODES.size === 10, 'liste fermee de 10 methodes de lecture');
  }
  // ================================================== 8. bords
  console.log('-- 8. bords : un bloc trop plein, maxLignes, premier, multicall --');
  {
    const F = fauxNoeud({ logs: chaine([[500, 12]]), pointe: 1000, limites: { lignes: 10 } });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    let e = null; try { await r.lisLogs({ address: JETON, topics: [TR] }, 0, 900, { pointe: 990, sure: 0 }); } catch (x) { e = x; }
    ok(e && /un seul bloc/.test(e.message), 'un seul bloc au-dessus du plafond : erreur dite, pas de boucle');
    const G = fauxNoeud({ logs: chaine([[100, 30], [200, 30]]), pointe: 1000 });
    const r2 = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    let e2 = null; try { await r2.lisLogs({ address: JETON, topics: [TR] }, 0, 900, { pointe: 990, sure: 0, maxLignes: 40 }); } catch (x) { e2 = x; }
    ok(e2 && e2.tropDeLignes, 'maxLignes : TropDeLignes (le lecteur bascule par acheteur)');
    const avantP = G.etat.http;
    const p = await r2.lisLogs({ address: W(0xbb), topics: [TR] }, 0, 900, { pointe: 990, sure: 0, premier: true });
    egal(p.logs.length, 0, '« premier » sur un filtre vide : rien');
    const p2 = await r2.lisLogs({ address: JETON, topics: [TR] }, 0, 900, { pointe: 990, sure: 0, premier: true, niveauDepart: 6 });
    ok(p2.logs.length && parseInt(p2.logs[0].blockNumber, 16) === 100 && p2.logs.every((l) => parseInt(l.blockNumber, 16) === 100), '« premier » : s\'arrete a la 1re cellule non vide, la 1re ligne est la plus ancienne');
    ok(G.etat.http - avantP <= 6, '« premier » : peu d\'appels (' + (G.etat.http - avantP) + ')');
    const H = fauxNoeud({ logs: [], pointe: 1000, contrat: (t, fn, a) => (fn === 'balanceOf' ? (a[0] === W(5) ? 123n : 0n) : fn === 'decimals' ? 9 : fn === 'totalSupply' ? 10n ** 18n : fn === 'symbol' ? 'ASTRO<script>' : fn === 'name' ? 'x' : null) });
    const r3 = R.cree({ prendre: H.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    const s = await r3.soldes(JETON, [W(5), W(6)]);
    egal(s.get(W(5)), 123n, 'balanceOf par Multicall3 (aggregate3)');
    const inf = await r3.infosJeton(JETON);
    egal(inf.decimales, 9, 'decimals lues (astro en a 9)');
    egal(inf.offre, 10n ** 18n, 'totalSupply en BigInt');
  }

  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`smart_rpc.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
