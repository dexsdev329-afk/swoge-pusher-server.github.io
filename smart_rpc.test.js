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
const { fauxNoeud, journal, pad, hex } = require('./essais/smart_money/faux_noeud');

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
    /* 45 recus dont 44 sous la pointe sure (bloc 5) et 1 au-dessus (bloc 999 > sure 500) */
    const recus = {}; for (let k = 1; k <= 45; k++) recus[tx(k)] = { transactionHash: tx(k), blockNumber: hex(k === 45 ? 999 : 5), logs: [] };
    const G = fauxNoeud({ logs: [], pointe: 1500, recus });
    const r2 = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier });
    const m = await r2.recus(Object.keys(recus), 500);
    egal(m.size, 45, '45 recus');
    egal(G.etat.http, 3, 'en lots de 20 : 3 requetes HTTP');
    egal(r2.etat.appels + ':' + r2.etat.rpc, '3:45', 'compte double : 3 requetes HTTP, 45 appels JSON-RPC (revue N9 : le lot compte chaque appel)');
    await r2.recus(Object.keys(recus), 500);
    egal(G.etat.http, 4, 'les 44 recus sous la pointe sure viennent du cache ; celui du bloc 999 (au-dessus) est relu : 1 requete');
    ok(!fs.existsSync(path.join(dossier, 'brut', 'R_' + tx(45) + '.json.gz')), 'un recu au-dessus de la pointe sure n\'est JAMAIS ecrit (revue N7)');
    const r2b = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier });
    const avantSans = G.etat.http;
    await r2b.recus([tx(46)].concat([]), undefined);
    ok(!fs.existsSync(path.join(dossier, 'brut', 'R_' + tx(46) + '.json.gz')) && G.etat.http === avantSans + 1, 'sans pointe sure donnee : rien n\'est ecrit');
    /* la veille : prefixe V, purge apres 24 h ; ceux de la passe restent */
    const rv = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier, prefixeHash: 'V' });
    await rv.recus([tx(3), tx(4)], 500);
    const fv = path.join(dossier, 'brut', 'VR_' + tx(3) + '.json.gz');
    ok(fs.existsSync(fv), 'la veille ecrit sous son propre prefixe (VR_)');
    egal(rv.purgeVeille(24 * 3600e3), 0, 'purge : rien de plus vieux que 24 h');
    const vieux = (T.now - 25 * 3600e3) / 1000; fs.utimesSync(fv, vieux, vieux);
    egal(rv.purgeVeille(24 * 3600e3), 1, 'purge : le recu de veille de plus de 24 h part (revue N8)');
    ok(!fs.existsSync(fv) && fs.existsSync(path.join(dossier, 'brut', 'R_' + tx(3) + '.json.gz')), 'celui de la passe (R_) reste');
    const rp = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier, cacheMaxOctets: 1 });
    ok(!rp.cacheEcrit('plein', { a: 1 }) && rp.etat.cachePlein === true, 'cache plein : rien n\'est ecrit, et etat.cachePlein le DIT');
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

  // ================================================== 9. reponse trop lourde (revue N1)
  console.log('-- 9. une reponse de plus de corpsMax : coupee en deux, telechargee UNE fois, jamais un refus --');
  {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-lourd-'));
    /* 400 lignes sur 4 000 blocs ; ~450 octets par ligne ; plafond de corps 20 000 octets : une cellule de plus de ~40 lignes est trop lourde,
       bien sous le plafond de 10 000 LIGNES du noeud (le cas reel : 16 822 846 octets pour une cellule L22 de la rampe 0x1eef) */
    const blocs = []; for (let b = 1000; b < 5000; b += 10) blocs.push([b, 1]);
    const logs = chaine(blocs);
    const F = fauxNoeud({ logs, pointe: 200000 });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, dossier, corpsMax: 20000 });
    const o = { pointe: 199990, sure: 198990 };
    const res = await r.lisLogs({ address: JETON, topics: [TR] }, 0, 100000, o);
    egal(res.logs.length, 400, 'toutes les lignes sont lues malgre les reponses trop lourdes');
    ok(res.stats.refusLourds >= 1 && res.stats.coupes >= 1, `les cellules trop lourdes sont COUPEES (${res.stats.refusLourds} reponses trop lourdes)`);
    const vues = new Map();
    for (const q of F.etat.requetes.filter((x) => x.method === 'eth_getLogs')) { const k = JSON.stringify(q.params); vues.set(k, (vues.get(k) || 0) + 1); }
    egal(Math.max(...vues.values()), 1, 'aucune cellule n\'est telechargee deux fois');
    ok(!T.attentes.some((x) => x >= 15000) && r.etat.reculs === 0 && r.etat.refus === 0, 'ce n\'est PAS un refus : aucun recul de 15 s ni de 60 s');
    ok(fs.readdirSync(path.join(dossier, 'brut')).some((f) => /_trop\.json\.gz$/.test(f)), 'la cellule fermee trop lourde est memorisee (_trop)');
    const avant = F.etat.http;
    const res2 = await r.lisLogs({ address: JETON, topics: [TR] }, 0, 100000, o);
    egal(res2.logs.length, 400, 'deuxieme passe : memes lignes');
    egal(F.etat.http - avant, 0, 'deuxieme passe : 0 telechargement (avant : 3 x 16,8 Mo a CHAQUE passe)');
    /* un seul bloc trop lourd : erreur dite, pas de boucle */
    const G = fauxNoeud({ logs: chaine([[50, 80]]), pointe: 1000 });
    const rg = R.cree({ prendre: G.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, corpsMax: 20000 });
    let e = null; try { await rg.lisLogs({ address: JETON, topics: [TR] }, 0, 900, { pointe: 990, sure: 0 }); } catch (x) { e = x; }
    ok(e && /un seul bloc/.test(e.message), 'un seul bloc trop lourd : erreur dite, pas de boucle');
    /* Content-Length annonce trop gros : rien n'est lu */
    const H = fauxNoeud({ logs: [], pointe: 1000 });
    const lourdEnTete = async (u, i) => { const x = await H.prendre(u, i); return Object.assign({}, x, { headers: { get: (k) => (k === 'content-length' ? '99999999' : null) } }); };
    const rh = R.cree({ prendre: lourdEnTete, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, corpsMax: 20000 });
    let e2 = null; try { await rh.appel('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1', address: JETON, topics: [TR] }]); } catch (x) { e2 = x; }
    ok(e2 instanceof R.TropLourd, 'Content-Length au-dela du plafond : TropLourd, sans rien lire');
    fs.rmSync(dossier, { recursive: true, force: true });
  }
  // ================================================== 10. delai depasse (revue N4)
  console.log('-- 10. « log query timed out » et delai depasse : la tranche est coupee, finit dans la meme passe --');
  {
    const blocs = []; for (let b = 1000; b < 900000; b += 5000) blocs.push([b, 1]);
    const logs = chaine(blocs);
    /* le faux noeud expire au-dela de 2^18 blocs (message exact du vrai noeud) */
    const F = fauxNoeud({ logs, pointe: 1000000, surRequete: (q) => (q.method === 'eth_getLogs' && parseInt(q.params[0].toBlock, 16) - parseInt(q.params[0].fromBlock, 16) + 1 > 2 ** 18 ? { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'log query timed out' } } : null) });
    const T = temps();
    const r = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0 });
    const res = await r.lisLogs({ address: JETON, topics: [TR] }, 0, 950000, { pointe: 999990, sure: 998990 });
    egal(res.logs.length, logs.length, '« log query timed out » : toutes les lignes lues dans la MEME passe');
    ok(res.stats.refusLourds >= 1, 'la cellule est coupee (avant : la passe finissait en « erreur », la suivante redemandait la meme largeur)');
    ok(r.etat.reculs === 0, 'aucun recul (ce n\'est pas un refus de politesse)');
    /* le delai cote client (viem TimeoutError) sur un getLogs : meme chose, jamais rejoue a l'identique */
    const G = fauxNoeud({ logs, pointe: 1000000 });
    const lent = (u, i) => {
      const q = JSON.parse(i.body);
      if (q.method === 'eth_getLogs' && parseInt(q.params[0].toBlock, 16) - parseInt(q.params[0].fromBlock, 16) + 1 > 2 ** 18) {
        return new Promise((ok2, ko) => { i.signal.addEventListener('abort', () => ko(Object.assign(new Error('aborted'), { name: 'AbortError' })));   /* comme fetch (undici) : une AbortError */ });
      }
      return G.prendre(u, i);
    };
    const r2 = R.cree({ prendre: lent, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, delaiMs: 40 });
    const res2 = await r2.lisLogs({ address: JETON, topics: [TR] }, 0, 950000, { pointe: 999990, sure: 998990 });
    egal(res2.logs.length, logs.length, 'delai depasse cote client : toutes les lignes lues');
    ok(r2.etat.reculs === 0 && r2.etat.coupesLourdes >= 1, `coupee, sans recul ni reprise a l'identique (${r2.etat.coupesLourdes} delais)`);
  }
  // ================================================== 11. un seul noeud, une requete a la fois (revue N2, N3)
  console.log('-- 11. deux clients, un rythme : une requete en vol, l\'espacement tenu, le recul partage, la pause --');
  {
    const F = fauxNoeud({ logs: chaine([[100, 1]]), pointe: 1000 });
    const T = temps();
    let enVol = 0, maxEnVol = 0; const traces = [];
    const prendre = async (u, i) => {
      enVol++; maxEnVol = Math.max(maxEnVol, enVol);
      const debut = T.now;
      await new Promise((ok2) => setTimeout(ok2, 3));
      T.now += 200;                                   // 200 ms de reseau
      enVol--; traces.push([debut, T.now]);
      return F.prendre(u, i);
    };
    const rythme = R.nouveauRythme();
    const A2 = R.cree({ prendre, horloge: T.horloge, dors: T.dors, rythme });
    const B2 = R.cree({ prendre, horloge: T.horloge, dors: T.dors, rythme, budgetAppels: 60 });
    await Promise.all([A2.pointe(), B2.pointe(), A2.pointe(), B2.pointe(), A2.lisLogs({ address: JETON, topics: [TR] }, 0, 900, { pointe: 990, sure: 0 }), B2.pointe()]);
    egal(maxEnVol, 1, 'une seule requete en vol pour les deux clients (avant : 2, et 222 chevauchements dans la passe reelle)');
    traces.sort((a, b) => a[0] - b[0]);
    let mini = Infinity; for (let k = 1; k < traces.length; k++) mini = Math.min(mini, traces[k][0] - traces[k - 1][1]);
    ok(mini >= R.ESPACE_LEGER_MS, `au moins 1,5 s entre la FIN d'une requete et le DEBUT de la suivante, quel que soit le client (mini ${mini} ms)`);
    /* N3 : un 429 recu par A fait reculer B aussi */
    const G = fauxNoeud({ logs: [], pointe: 1000, pannes: [429] });
    const T3 = temps(); const departs = [];
    const p3 = async (u, i) => { departs.push(T3.now); return G.prendre(u, i); };
    const ry = R.nouveauRythme();
    const A3 = R.cree({ prendre: p3, horloge: T3.horloge, dors: T3.dors, rythme: ry, espaceLegerMs: 0, espaceLourdMs: 0 });
    const B3 = R.cree({ prendre: p3, horloge: T3.horloge, dors: T3.dors, rythme: ry, espaceLegerMs: 0, espaceLourdMs: 0 });
    await Promise.all([A3.pointe(), B3.pointe(), B3.pointe()]);
    ok(departs.length === 4 && departs.slice(1).every((t) => t >= departs[0] + 15000), `apres le 429 recu par A, B n'envoie rien avant la fin du recul de 15 s (departs ${departs.map((t) => t - departs[0]).join(', ')} ms)`);
    /* la pause apres un abandon, partagee, croissante, remise a zero au premier succes */
    const H = fauxNoeud({ logs: [], pointe: 1000, pannes: [429, 429, 429] });
    const T4 = temps(); const ry4 = R.nouveauRythme();
    const A4 = R.cree({ prendre: H.prendre, horloge: T4.horloge, dors: T4.dors, rythme: ry4, espaceLegerMs: 0, espaceLourdMs: 0 });
    const B4 = R.cree({ prendre: H.prendre, horloge: T4.horloge, dors: T4.dors, rythme: ry4, espaceLegerMs: 0, espaceLourdMs: 0 });
    let e = null; try { await A4.pointe(); } catch (x) { e = x; }
    ok(e instanceof R.AbandonPasse, 'trois refus : abandon');
    const http = H.etat.http;
    let e2 = null; try { await B4.pointe(); } catch (x) { e2 = x; }
    ok(e2 instanceof R.AbandonPasse && H.etat.http === http, 'pendant la pause de 30 min, l\'AUTRE client n\'appelle pas le noeud non plus');
    T4.now += 30 * 60e3 + 1;
    egal((await B4.pointe()).pointe, 1000, 'apres 30 min, le noeud est rappele');
    egal(ry4.abandons, 0, 'et le premier succes remet le compte des abandons a zero');
    const K2 = fauxNoeud({ logs: [], pointe: 1000, pannes: [429, 429, 429, 429, 429, 429] });
    const T5 = temps(); const ry5 = R.nouveauRythme();
    const A5 = R.cree({ prendre: K2.prendre, horloge: T5.horloge, dors: T5.dors, rythme: ry5, espaceLegerMs: 0, espaceLourdMs: 0 });
    try { await A5.pointe(); } catch (x) { /* abandon 1 */ }
    T5.now += 30 * 60e3 + 1;
    try { await A5.pointe(); } catch (x) { /* abandon 2 */ }
    egal(Math.round((ry5.pause - T5.now) / 60e3), 120, 'deux abandons de suite : la pause passe a 2 h');
  }
  // ================================================== 12. plafond du jour (revue N9)
  console.log('-- 12. plafond quotidien, partage par les clients du meme noeud --');
  {
    const F = fauxNoeud({ logs: [], pointe: 1000 });
    const T = temps(); const ry = R.nouveauRythme();
    const A2 = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, rythme: ry, espaceLegerMs: 0, espaceLourdMs: 0, plafondJourHttp: 3 });
    const B2 = R.cree({ prendre: F.prendre, horloge: T.horloge, dors: T.dors, rythme: ry, espaceLegerMs: 0, espaceLourdMs: 0, plafondJourHttp: 3 });
    await A2.pointe(); await B2.pointe(); await A2.pointe();
    let e = null; try { await B2.pointe(); } catch (x) { e = x; }
    ok(e instanceof R.BudgetEpuise && /du jour/.test(e.message) && F.etat.http === 3, 'le 4e appel du jour (tous clients confondus) ne part pas');
    T.now += 24 * 3600e3;
    egal((await B2.pointe()).pointe, 1000, 'le lendemain, le compte repart');
    ok(R.PLAFOND_JOUR_HTTP > 0 && R.PLAFOND_JOUR_OCTETS > 0, 'un plafond quotidien par defaut existe');
  }
  // ================================================== 13. l'URL du noeud ne sort jamais (revue N5)
  console.log('-- 13. l\'URL du noeud n\'apparait dans aucun message --');
  {
    const SECRET = 'https://noeud-prive.example/v2/CLE-SECRETE-123';
    const muet = (u, i) => new Promise((ok2, ko) => { i.signal.addEventListener('abort', () => ko(Object.assign(new Error('aborted'), { name: 'AbortError' })));   /* comme fetch (undici) : une AbortError */ });
    const T = temps();
    const r = R.cree({ url: SECRET, prendre: muet, horloge: T.horloge, dors: T.dors, espaceLegerMs: 0, espaceLourdMs: 0, delaiMs: 20, reculs: [1, 1] });
    let e = null; try { await r.pointe(); } catch (x) { e = x; }
    ok(e instanceof R.AbandonPasse, 'noeud muet : abandon');
    ok(e && !/CLE-SECRETE|noeud-prive/.test(e.message) && /timeout/.test(e.message), 'le message dit « timeout », jamais l\'URL (' + (e && e.message) + ')');
    egal(R.libelle({ name: 'HttpRequestError', message: 'HTTP request failed. URL: ' + SECRET }), 'network', 'libelle fixe pour une erreur reseau de viem');
    ok(!/CLE-SECRETE/.test(r.masque('x URL: ' + SECRET + ' y ' + SECRET)), 'masque() retire toute trace de l\'URL');
  }

  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`smart_rpc.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
