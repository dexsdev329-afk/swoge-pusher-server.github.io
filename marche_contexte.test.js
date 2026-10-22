'use strict';
/*
 * LE CONTEXTE DE MARCHE BTC/ETH (22/10/2026), CoinGecko simule :
 *   1. la serie : UN point par heure, jamais deux ; le rattrapage de 90 jours une fois (deux
 *      appels, les deux ou rien — ETH refuse apres BTC lu : rien d'ecrit, repris au releve
 *      suivant —, jamais refaits) ; triee ; ecrite sur le disque ;
 *   2. contexteA, pur : exact a des instants choisis, null hors couverture (±2 h), un axe sans
 *      reference null — jamais invente ; les references ancrees sur l'instant du POINT RETENU et
 *      non sur t (un trou dans la serie ne cumule plus deux tolerances : 22 a 26 h au pire, plus
 *      20 a 28 h ; la tolerance de ±2 h sur la reference elle-meme reste, choisie) ;
 *      regimeDe et les tranches (±3 % sur 24 h, ±5 % sur 7 j) ;
 *   3. un redemarrage relit la serie et le rattrapage fait : rien n'est redemande ;
 *   4. un refus (429) ne casse rien, est compte, et le rattrapage se fait au releve suivant ;
 *      la reprise (minuteries injectees) : 5 min apres un refus, trois fois par heure au plus,
 *      l'heure suivante en permet de nouveau, une reussite n'en arme aucune, arrete() vide tout ;
 *   5. sans cle : l'hote public, aucun en-tete ; la cle sert et se DEBITE seulement quand la
 *      colonie est dans son budget ; la vue et les erreurs ne la citent jamais ; MARCHE_CONTEXTE=0 ;
 *   6. la vraie colonie decoupe son carnet (brut et net) par le marche a t0 via le fournisseur,
 *      et sert `marche` ; le serveur branche /ai/marche, le carnet des lancements et releve.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');
const MC = require('./marche_contexte');

const H_MS = 3600e3, J_MS = 86400e3;
const T0 = Date.parse('2026-10-22T12:30:00Z');
/* des prix lineaires par heure : BTC +10 $ et ETH +1 $ par heure, 50 000 $ et 5 000 $ a T0 (toujours positifs sur 90 j) */
const btcA = (t) => 50000 + Math.round((t - T0) / H_MS) * 10;
const ethA = (t) => 5000 + Math.round((t - T0) / H_MS);
const pc = (a, b) => Math.round((a / b - 1) * 10000) / 100;
function banc(o) {
  o = o || {};
  const dossier = o.dossier || fs.mkdtempSync(path.join(os.tmpdir(), 'marche-'));
  const H = { now: o.now || T0 };
  const appels = [];
  const prendre = async (url, init) => {
    appels.push({ url: String(url), entetes: (init && init.headers) || {} });
    if (o.jette) throw new Error(o.jette);
    if (o.statut) return { ok: false, status: o.statut, json: async () => ({ status: { error_message: 'Throttled' } }) };
    const u = new URL(String(url));
    if (o.statutEth && /\/coins\/ethereum\/market_chart$/.test(u.pathname)) return { ok: false, status: o.statutEth, json: async () => ({}) };
    if (u.pathname.endsWith('/coins/markets')) return { ok: true, status: 200, json: async () => [{ id: 'bitcoin', current_price: btcA(H.now) }, { id: 'ethereum', current_price: ethA(H.now) }] };
    const m = /\/coins\/(bitcoin|ethereum)\/market_chart$/.exec(u.pathname);
    if (m) {
      const f = m[1] === 'bitcoin' ? btcA : ethA, prices = [];
      for (let k = 0; k <= 90 * 24; k++) { const t = H.now - 90 * J_MS + k * H_MS; prices.push([t, f(t)]); }
      return { ok: true, status: 200, json: async () => ({ prices, market_caps: [], total_volumes: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const X = MC.cree(Object.assign({ dossier, prendre, horloge: () => H.now, dors: async () => {}, cle: o.cle, env: o.env || {} }, o.tempo || {}));
  return { X, H, appels, dossier };
}

(async () => {
  console.log('-- 1. la serie : un point par heure, le rattrapage une fois');
  const b = banc();
  let r = await b.X.releve();
  eq(r.etat, 'read', 'premier releve : read');
  ok(r.point === true, 'un point pour l heure courante');
  eq(r.backfill, 2160, 'rattrapage : 2 161 points horaires moins celui de l heure deja relevee');
  eq(b.appels.length, 3, 'trois appels : le releve, puis market_chart bitcoin et ethereum');
  ok(/\/coins\/markets\?vs_currency=usd&ids=bitcoin,ethereum$/.test(b.appels[0].url), 'la route du releve : /coins/markets, bitcoin et ethereum en UN appel, rien d autre dans l URL (seul current_price est lu)');
  ok(/\/coins\/bitcoin\/market_chart\?vs_currency=usd&days=90$/.test(b.appels[1].url) && /\/coins\/ethereum\/market_chart\?vs_currency=usd&days=90$/.test(b.appels[2].url), 'le rattrapage : market_chart days=90 (90 = le maximum horaire de la doc)');
  ok(b.appels.every((a) => a.url.startsWith(MC.HOTE_PUBLIC + '/') && !Object.keys(a.entetes).some((k) => /x-cg-/i.test(k))), 'sans cle : l hote public, aucun en-tete de cle');
  let v = b.X.vue();
  eq(v.points, 2161, '2 161 points');
  ok(v.backfill.fait === true && v.backfill.points === 2160 && v.backfill.essais === 1, 'rattrapage fait, compte');
  eq(v.compteurs.sansCle, 3, 'trois lectures sans la cle');
  eq(v.compteurs.doublonsHeure, 1, 'le point du rattrapage dans l heure deja relevee : un doublon compte, pas deux points');
  eq(v.porte, 'keyless', 'porte : keyless');
  ok(v.dernierPoint && v.dernierPoint.t === T0 && v.dernierPoint.btc === 50000 && v.dernierPoint.eth === 5000, 'le dernier point : T0, 50 000 $, 5 000 $');
  ok(v.premier === T0 - 90 * J_MS, 'le premier : il y a 90 jours');
  r = await b.X.releve();
  ok(r.etat === 'read' && r.point === false && r.backfill === null, 'releve dans la meme heure : aucun point, rattrapage pas refait');
  eq(b.appels.length, 4, 'un seul appel de plus');
  eq(b.X.vue().compteurs.doublonsHeure, 2, 'les doublons d heure sont comptes : le point du rattrapage dans l heure deja relevee, puis ce releve');
  b.H.now += 20 * 60e3; await b.X.releve();
  eq(b.X.vue().points, 2161, '12:50 : toujours l heure 12, pas de point');
  b.H.now += 40 * 60e3; await b.X.releve();
  eq(b.X.vue().points, 2162, '13:30 : une heure neuve, un point');
  const P = b.X._points();
  ok(P.every((p, i) => !i || p[0] > P[i - 1][0]), 'la serie est triee');
  eq(new Set(P.map((p) => Math.floor(p[0] / H_MS))).size, P.length, 'jamais deux points dans la meme heure');
  ok(fs.existsSync(path.join(b.dossier, 'marche', 'serie.json')) && !fs.existsSync(path.join(b.dossier, 'marche', 'serie.json.tmp')), 'ecrite sur le disque (atomique)');
  const c0 = b.X.contexteA(T0);
  ok(c0 && c0.btc24h === pc(btcA(T0), btcA(T0 - J_MS)) && c0.btc7d === pc(btcA(T0), btcA(T0 - 7 * J_MS)) && c0.eth24h === pc(ethA(T0), ethA(T0 - J_MS)) && c0.eth7d === pc(ethA(T0), ethA(T0 - 7 * J_MS)), 'contexteA(T0) depuis la serie relevee : ' + JSON.stringify(c0));
  const tr = T0 - 40 * J_MS + 17 * 60e3;   /* un trade d il y a 40 jours, a 12:47 */
  const cr = b.X.contexteA(tr);
  ok(cr && cr.t === T0 - 40 * J_MS && cr.btc24h === pc(btcA(tr), btcA(tr - J_MS)) && cr.eth7d === pc(ethA(tr), ethA(tr - 7 * J_MS)), 'retroactif, il y a 40 jours : le point de 12:30 (17 min avant) et ses references');

  console.log('-- 2. contexteA, pur : exact, null hors couverture');
  const T = Date.parse('2026-10-20T15:00:00Z');
  const dossier2 = fs.mkdtempSync(path.join(os.tmpdir(), 'marche2-'));
  fs.mkdirSync(path.join(dossier2, 'marche'));
  fs.writeFileSync(path.join(dossier2, 'marche', 'serie.json'), JSON.stringify({ v: 1, backfill: { fait: true, t: T, points: 3, essais: 1, derniereErreur: null }, points: [[T, 99, 9], [T - J_MS, 110, 8], [T - 7 * J_MS, 100, 10]] }));
  const Y = MC.cree({ dossier: dossier2, prendre: async () => { throw new Error('aucun reseau attendu'); }, horloge: () => T, env: {} });
  eq(Y.vue().points, 3, 'trois points relus');
  ok(Y._points()[0][0] === T - 7 * J_MS, 'et tries a la relecture');
  const c = Y.contexteA(T);
  ok(c && c.btc24h === -10 && c.btc7d === -1 && c.eth24h === 12.5 && c.eth7d === -10, 'a T : btc -10 % / -1 %, eth +12,5 % / -10 % : ' + JSON.stringify(c));
  ok(c.t === T && c.btc === 99 && c.eth === 9, 'le point et ses prix');
  const c2 = Y.contexteA(T + H_MS);
  ok(c2 && c2.t === T && c2.btc24h === -10 && c2.eth7d === -10, '1 h apres le dernier point : le meme point, les memes references');
  ok(Y.contexteA(T + 2 * H_MS) && Y.contexteA(T + 2 * H_MS).btc24h === -10, 'a 2 h exactement : encore couvert');
  eq(Y.contexteA(T + 2 * H_MS + 1), null, '2 h et 1 ms apres : null');
  eq(Y.contexteA(T - 7 * J_MS - 2 * H_MS - 1), null, 'avant le premier point : null');
  const c3 = Y.contexteA(T - 7 * J_MS - H_MS);
  ok(c3 && c3.btc === 100 && c3.btc24h === null && c3.btc7d === null && c3.eth24h === null && c3.eth7d === null, 'un point couvert mais sans reference a -24 h ni -7 j : les axes sont null, jamais inventes');
  eq(Y.contexteA(T - 3 * J_MS), null, 'dans un trou de six jours : null');
  /* le trou : [T-26h:100, T-24h:110, T:99] ; a T-2h le point retenu est T (a 2 h), et la reference 24 h
     doit etre celle de T-24h (110 → -10 %), pas celle de t-24h = T-26h (100 → -1 %) */
  const dossier2b = fs.mkdtempSync(path.join(os.tmpdir(), 'marche2b-'));
  fs.mkdirSync(path.join(dossier2b, 'marche'));
  fs.writeFileSync(path.join(dossier2b, 'marche', 'serie.json'), JSON.stringify({ v: 1, backfill: { fait: true, t: T, points: 3, essais: 1, derniereErreur: null }, points: [[T - 26 * H_MS, 100, 10], [T - J_MS, 110, 11], [T, 99, 9.9]] }));
  const Z = MC.cree({ dossier: dossier2b, prendre: async () => { throw new Error('aucun reseau attendu'); }, horloge: () => T, env: {} });
  const ct = Z.contexteA(T - 2 * H_MS);
  ok(ct && ct.t === T && ct.btc === 99, 'le trou : a T-2h, le point retenu est T (le premier apres, a 2 h)');
  ok(ct && ct.btc24h === -10 && ct.eth24h === -10, 'et la variation 24 h se lit contre T-24h (110, 11) : -10 % / -10 %, pas contre t-24h = T-26h (-1 %) : ' + JSON.stringify(ct));
  ok(ct && ct.btc7d === null && ct.eth7d === null, 'sans point a p.t-7 j : 7 j null');
  const ct2 = Z.contexteA(T - 23 * H_MS);
  ok(ct2 && ct2.t === T - J_MS && ct2.btc24h === null, 'a T-23h : le point T-24h est retenu, sa reference a T-48h manque : null, pas T-26h');
  /* la tolerance qui reste, choisie (TOLERANCE_MS = 2 h) : sans point a p.t-24h, celui de p.t-26h sert ; a 2 h et 1 ms, null */
  const serieBrute = (pts) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'marche2c-')); fs.mkdirSync(path.join(d, 'marche')); fs.writeFileSync(path.join(d, 'marche', 'serie.json'), JSON.stringify({ v: 1, backfill: { fait: true }, points: pts })); return MC.cree({ dossier: d, prendre: async () => { throw new Error('aucun reseau attendu'); }, horloge: () => T, env: {} }); };
  eq(serieBrute([[T - 26 * H_MS, 100, 10], [T, 99, 9.9]]).contexteA(T).btc24h, -1, 'sans point a p.t-24h : celui de p.t-26h sert (la seule tolerance, ±2 h) — une « variation 24 h » de 26 h au pire');
  eq(serieBrute([[T - 26 * H_MS - 1, 100, 10], [T, 99, 9.9]]).contexteA(T).btc24h, null, 'a 26 h et 1 ms : null, jamais 28 h');
  eq(Y.contexteA('abc'), null, 'un instant illisible : null');
  eq(Y.contexteA(undefined), null, 'sans instant : null');
  const rg = Y.regimeDe(c);
  ok(rg.btc24h === 'btc 24h < -3%' && rg.btc7d === 'btc 7d -5..0%' && rg.eth24h === 'eth 24h > 3%' && rg.eth7d === 'eth 7d < -5%', 'le regime : ' + JSON.stringify(rg));
  eq(MC.regimeDe(null), null, 'regime d un contexte nul : null');
  const rg2 = MC.regimeDe({ btc24h: -4, btc7d: null, eth24h: 0, eth7d: 7 });
  ok(rg2.btc24h === 'btc 24h < -3%' && rg2.btc7d === null && rg2.eth24h === 'eth 24h 0..3%' && rg2.eth7d === 'eth 7d > 5%', 'un axe null reste null');
  const vY = Y.vue();
  ok(vY.courant && vY.courant.btc24h === -10 && vY.courant.regime.btc24h === 'btc 24h < -3%', 'la vue porte le contexte courant et son regime');
  /* les tranches, bornes comprises : [-inf,-3[ [-3,0[ [0,3[ [3,+inf[ ; ±5 sur 7 j */
  eq(MC.trancheDe('btc24h', -3.01), 'btc 24h < -3%', '-3,01 : < -3 %');
  eq(MC.trancheDe('btc24h', -3), 'btc 24h -3..0%', '-3 exactement : -3..0 %');
  eq(MC.trancheDe('btc24h', -0.01), 'btc 24h -3..0%', '-0,01 : -3..0 %');
  eq(MC.trancheDe('btc24h', 0), 'btc 24h 0..3%', '0 : 0..3 %');
  eq(MC.trancheDe('btc24h', 2.99), 'btc 24h 0..3%', '2,99 : 0..3 %');
  eq(MC.trancheDe('btc24h', 3), 'btc 24h > 3%', '3 : > 3 %');
  eq(MC.trancheDe('eth7d', 5), 'eth 7d > 5%', 'eth 7 j, 5 : > 5 %');
  eq(MC.trancheDe('eth7d', -5), 'eth 7d -5..0%', 'eth 7 j, -5 : -5..0 %');
  eq(MC.trancheDe('eth7d', 4.99), 'eth 7d 0..5%', 'eth 7 j, 4,99 : 0..5 %');
  eq(MC.trancheDe('btc24h', null), null, 'sans valeur : null');
  eq(MC.trancheDe('cap24h', 1), null, 'un axe inconnu : null');
  eq(MC.libelles('btc24h').join('|'), 'btc 24h < -3%|btc 24h -3..0%|btc 24h 0..3%|btc 24h > 3%', 'les quatre etiquettes, dans l ordre');
  eq(MC.libelles('eth7d').join('|'), 'eth 7d < -5%|eth 7d -5..0%|eth 7d 0..5%|eth 7d > 5%', 'et pour 7 j');
  eq(MC.SANS, 'no market data', 'l etiquette de ce que la serie ne couvre pas');

  console.log('-- 3. le redemarrage');
  const b2 = banc({ dossier: b.dossier, now: T0 + 3 * H_MS });
  eq(b2.X.vue().points, 2162, 'la serie relue');
  ok(b2.X.vue().backfill.fait === true, 'le rattrapage relu comme fait');
  r = await b2.X.releve();
  ok(r.point === true && r.backfill === null && b2.appels.length === 1 && /\/coins\/markets/.test(b2.appels[0].url), 'au releve : un seul appel, aucun market_chart');
  eq(b2.X.vue().points, 2163, 'un point de plus');

  console.log('-- 4. un refus ne casse rien');
  const opts = { statut: 429 };
  const e = banc(opts);
  r = await e.X.releve();
  ok(r.etat === 'error' && r.statut === 429, 'releve : error 429');
  v = e.X.vue();
  eq(v.points, 0, 'aucun point');
  ok(v.backfill.fait === false && v.backfill.essais === 1 && /HTTP 429/.test(v.backfill.derniereErreur), 'rattrapage : pas fait, un essai, l erreur dite');
  eq(v.compteurs.erreurs, 2, 'deux erreurs comptees (releve, rattrapage)');
  ok(v.dernierReleve && v.dernierReleve.etat === 'error' && v.courant === null, 'dernier releve en erreur, contexte courant null');
  opts.statut = 0;
  e.H.now += H_MS;
  r = await e.X.releve();
  ok(r.etat === 'read' && r.point === true && r.backfill === 2160, 'au releve suivant : le point et le rattrapage');
  ok(e.X.vue().backfill.fait === true && e.X.vue().backfill.essais === 2 && e.X.vue().backfill.derniereErreur === null, 'rattrapage fait au deuxieme essai');
  /* les deux ou rien : BTC lu, ETH refuse → aucun point de BTC seul, l essai compte, repris au releve suivant */
  const op = { statutEth: 429 };
  const pe = banc(op);
  r = await pe.X.releve();
  ok(r.etat === 'read' && r.point === true && r.backfill === null && pe.appels.length === 3, 'BTC lu, ETH refuse : le point de l heure est la, le rattrapage non, trois appels');
  ok(pe.X.vue().points === 1 && pe.X.vue().backfill.fait === false && pe.X.vue().backfill.essais === 1 && /HTTP 429/.test(pe.X.vue().backfill.derniereErreur), 'les deux ou rien : aucun point de BTC seul, un essai compte, l erreur dite');
  op.statutEth = 0; pe.H.now += H_MS; r = await pe.X.releve();
  ok(r.point === true && r.backfill === 2159 && pe.X.vue().points === 2161 && pe.X.vue().backfill.fait === true && pe.X.vue().backfill.essais === 2, 'au releve suivant : les deux series, 2 161 points (deux heures deja relevees)');
  const pl = e.X.planifie();
  ok(pl && typeof pl.arrete === 'function', 'planifie rend { arrete }');
  pl.arrete();
  eq(e.X.vue().compteurs.releves, 2, 'rien de plus parti tout de suite (premier releve a 60 s)');

  console.log('-- 4 bis. la reprise : 5 min apres un refus, trois fois par heure au plus, puis l heure suivante');
  const file = [];   /* les minuteries armees : { k: 't'|'i', fn, ms, vive } */
  const tempo = {
    setTimeout: (fn, ms) => { const x = { k: 't', fn, ms, vive: true }; file.push(x); return x; },
    setInterval: (fn, ms) => { const x = { k: 'i', fn, ms, vive: true }; file.push(x); return x; },
    clearTimeout: (x) => { if (x) x.vive = false; }, clearInterval: (x) => { if (x) x.vive = false; },
  };
  const vivantes = () => file.filter((x) => x.vive);
  const reprisesArmees = () => vivantes().filter((x) => x.k === 't' && x.ms === MC.REPRISE_MS);
  const tire = async (x) => { if (x.k === 't') x.vive = false; await x.fn(); };
  const o4 = { statut: 429, tempo };
  const q = banc(o4);
  q.H.now = Date.parse('2026-10-22T14:00:30Z');
  const pq = q.X.planifie();
  ok(vivantes().length === 2 && vivantes()[0].k === 't' && vivantes()[0].ms === MC.PREMIER_MS && vivantes()[1].k === 'i' && vivantes()[1].ms === MC.HEURE_MS, 'arme : le premier releve a 60 s, puis la cadence horaire');
  q.H.now += MC.PREMIER_MS; await tire(vivantes()[0]);
  ok(q.X.vue().compteurs.releves === 1 && q.X.vue().dernierReleve.etat === 'error' && q.X.vue().dernierReleve.statut === 429, 'premier releve : refuse 429');
  eq(reprisesArmees().length, 1, 'une reprise armee, a 5 min');
  for (let i = 2; i <= 4; i++) { q.H.now += MC.REPRISE_MS; await tire(reprisesArmees()[0]); eq(q.X.vue().compteurs.releves, i, 'reprise ' + (i - 1) + ' : releve ' + i + ', refuse'); }
  eq(reprisesArmees().length, 0, 'trois reprises dans l heure : la quatrieme erreur n en arme aucune');
  ok(vivantes().length === 1 && vivantes()[0].k === 'i', 'il ne reste que la cadence horaire');
  ok(q.X.vue().erreurs.length === 5 && q.X.vue().erreurs.every((x) => /^(fetch|backfill): HTTP 429$/.test(x.txt)), 'la vue garde les 5 dernieres erreurs, en anglais : ' + q.X.vue().erreurs[0].txt);
  q.H.now = Date.parse('2026-10-22T15:00:30Z'); await tire(vivantes()[0]);
  ok(q.X.vue().compteurs.releves === 5 && reprisesArmees().length === 1, 'l heure suivante : la cadence releve (refuse) et une reprise est de nouveau permise');
  o4.statut = 0; q.H.now += MC.REPRISE_MS; await tire(reprisesArmees()[0]);
  ok(q.X.vue().dernierReleve.etat === 'read' && q.X.vue().points === 2161 && q.X.vue().backfill.fait === true, 'la reprise reussit : le point et le rattrapage');
  eq(reprisesArmees().length, 0, 'une reussite n arme aucune reprise');
  pq.arrete();
  eq(vivantes().length, 0, 'arrete() : plus rien d arme (minuteries injectees eteintes)');

  console.log('-- 5. la cle : seulement dans le budget, jamais citee');
  const CLE = 'SECRET-KEY-abc123xyz';
  let debits = 0, dans = false, porte = 'pro';
  const cle = { valeur: () => CLE, porte: () => porte, dansLeBudget: () => dans, debite: () => { debits++; } };
  const k = banc({ cle });
  await k.X.releve();
  ok(k.appels.every((a) => a.url.startsWith(MC.HOTE_PUBLIC + '/') && !a.entetes['x-cg-pro-api-key'] && !a.entetes['x-cg-demo-api-key']), 'hors budget : l hote public, sans en-tete, meme avec une cle et une porte Pro');
  eq(debits, 0, 'rien debite');
  eq(k.X.vue().porte, 'keyless', 'porte : keyless');
  dans = true; k.H.now += H_MS; k.appels.length = 0;
  await k.X.releve();
  ok(k.appels.length === 1 && k.appels[0].url.startsWith(MC.HOTE_PRO + '/') && k.appels[0].entetes['x-cg-pro-api-key'] === CLE, 'dans le budget, porte Pro : pro-api.coingecko.com avec x-cg-pro-api-key');
  eq(debits, 1, 'une reussite = un credit debite du compteur de la colonie');
  eq(k.X.vue().compteurs.parCle, 1, 'comptee par la cle');
  eq(k.X.vue().porte, 'pro', 'porte : pro');
  porte = 'demo'; k.H.now += H_MS; k.appels.length = 0;
  await k.X.releve();
  ok(k.appels[0].url.startsWith(MC.HOTE_PUBLIC + '/') && k.appels[0].entetes['x-cg-demo-api-key'] === CLE && !k.appels[0].entetes['x-cg-pro-api-key'], 'porte Demo : api.coingecko.com avec x-cg-demo-api-key');
  porte = 'libre'; k.H.now += H_MS; k.appels.length = 0;
  await k.X.releve();
  ok(!k.appels[0].entetes['x-cg-demo-api-key'] && !k.appels[0].entetes['x-cg-pro-api-key'] && debits === 2, 'porte libre (cle refusee par la colonie) : sans cle, rien debite');
  porte = null; k.H.now += H_MS; k.appels.length = 0;
  await k.X.releve();
  ok(!k.appels[0].entetes['x-cg-demo-api-key'] && !k.appels[0].entetes['x-cg-pro-api-key'], 'porte pas encore sondee : sans cle');
  ok(!JSON.stringify(k.X.vue()).includes(CLE), 'la vue ne cite jamais la cle');
  const kj = banc({ cle, jette: 'boom ' + CLE + ' refused' });
  r = await kj.X.releve();
  ok(r.etat === 'error' && !r.erreur.includes(CLE) && r.erreur.includes('<key>'), 'une erreur qui citerait la cle est masquee : ' + r.erreur);
  ok(!JSON.stringify(kj.X.vue()).includes(CLE) && kj.X.vue().erreurs.length === 2 && kj.X.vue().erreurs.every((x) => x.txt.includes('<key>')), 'et dans la vue aussi');
  const off = banc({ env: { MARCHE_CONTEXTE: '0' }, dossier: dossier2 });
  eq(off.X.planifie(), null, 'MARCHE_CONTEXTE=0 : rien d arme');
  eq((await off.X.releve()).etat, 'off', 'releve : off');
  eq(off.appels.length, 0, 'aucune requete');
  ok(off.X.vue().actif === false && off.X.vue().points === 3, 'la vue le dit, la serie du disque est la');
  ok(off.X.contexteA(T) && off.X.contexteA(T).btc24h === -10, 'et le contexte passe se lit encore');

  console.log('-- 6. la colonie decoupe son carnet par le marche a t0 ; les branchements');
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'marche-colonie-'));
  process.env.STUDIO_DEX = '0';
  const C = require('./ai_colonie');
  const etat0 = C._etat();
  const E = JSON.parse(JSON.stringify(etat0 || {}));
  const T1 = Date.parse('2026-10-01T10:00:00Z'), T2 = Date.parse('2026-10-05T10:00:00Z'), T3 = Date.parse('2026-09-01T10:00:00Z');
  const ligne = (t0, r, i) => ({ sym: 'TK' + i, adr: '0x' + String(i).padStart(40, '0'), t0, t: t0 + 60e3, tenue: 1, prix0: 1, prix: 1 + r / 100, mise: 40, r, gain: 0.4 * r, reste: 0, encaisse: 0, par: 'closer', raison: null, score: 0, traits: null, liq0: 10000, mcAchat: 20000, allerRetour: 2, aberrant: null });
  E.carnet = [ligne(T1, 10, 1), ligne(T1, 20, 2), ligne(T1, -6, 3), ligne(T2, -10, 4), ligne(T2, 4, 5), ligne(T3, 5, 6)];
  C._pose(E);
  C.fournisseurMarche(() => ({
    contexteA: (t) => (t === T1 ? { t, btc: 1, eth: 1, btc24h: -4, btc7d: 6, eth24h: 1, eth7d: 0 } : t === T2 ? { t, btc: 1, eth: 1, btc24h: 1, btc7d: -1, eth24h: -5, eth7d: 0 } : null),
    vue: () => ({ actif: true, points: 3, courant: { btc24h: 1, regime: { btc24h: 'btc 24h 0..3%' } } }),
  }));
  const cb = C.carnetBilan();
  ok(Array.isArray(cb.parBtc24h) && cb.parBtc24h.length === 3, 'parBtc24h : trois tranches');
  ok(cb.parBtc24h[0].tranche === 'btc 24h < -3%' && cb.parBtc24h[0].n === 3 && cb.parBtc24h[0].moyenne === 8, 'BTC < -3 % a t0 : 3 trades, +8 % en moyenne');
  ok(cb.parBtc24h[1].tranche === 'btc 24h 0..3%' && cb.parBtc24h[1].n === 2 && cb.parBtc24h[1].moyenne === -3, 'BTC 0..3 % : 2 trades, -3 %');
  ok(cb.parBtc24h[2].tranche === 'no market data' && cb.parBtc24h[2].n === 1 && cb.parBtc24h[2].moyenne === 5, 'hors couverture : « no market data », 1 trade — compte, jamais range ailleurs');
  const cles = (l) => l.map((x) => x.tranche + ':' + x.n).join('|');
  eq(cles(cb.parBtc7d), 'btc 7d -5..0%:2|btc 7d > 5%:3|no market data:1', 'parBtc7d dans l ordre des bornes');
  eq(cles(cb.parEth24h), 'eth 24h < -3%:2|eth 24h 0..3%:3|no market data:1', 'parEth24h');
  ok(cb.parLiq.length === 1 && cb.parLiq[0].n === 6 && cb.tout.n === 6, 'les autres decoupages ne bougent pas');
  const cn = C.carnetNet();
  ok(cn.parBtc24h && cn.parBtc24h[0].tranche === 'btc 24h < -3%' && cn.parBtc24h[0].n === 3 && cn.parBtc24h[0].net === 6, 'carnet net : BTC < -3 %, n=3, net +6 % (brut +8 moins 2 d aller-retour)');
  ok(cn.parBtc7d && cn.parBtc7d.length === 3 && cn.parBtc7d[2].tranche === 'no market data', 'carnet net par 7 j aussi');
  const vc = C.vue();
  ok(vc.marche && vc.marche.points === 3 && vc.marche.courant.regime.btc24h === 'btc 24h 0..3%', '/ai/colonie sert `marche` : la vue du fournisseur, contexte courant compris');
  ok(vc.carnet.parBtc24h.length === 3 && vc.carnetNet.parBtc24h.length === 3, 'et les decoupages dans carnet et carnetNet');
  C.fournisseurMarche(null);
  ok(C.carnetBilan().parBtc24h.length === 0 && C.carnetNet().parBtc24h.length === 0 && C.vue().marche === null, 'sans fournisseur : rien d invente');
  C._pose(etat0);
  const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const srv = src('server.js');
  ok(/path === '\/ai\/marche'/.test(srv) && /marcheContexte \? marcheContexte\.vue\(\) : \{ actif: false \}/.test(srv), 'la route /ai/marche');
  ok(/require\('\.\/marche_contexte'\)\.cree\(\{ dossier: cfg\.DATA_DIR,/.test(srv) && /marcheContexte\.planifie\(\);/.test(srv) && /aiColonie\.fournisseurMarche\(\(\) => marcheContexte\)/.test(srv), 'le serveur cree, planifie et fournit a la colonie');
  ok(/debite: \(\) => aiColonie\.debiteCg\(\)/.test(srv) && /dansLeBudget: \(\) => aiColonie\.cleDansLeBudget\(\)/.test(srv), 'la cle : le budget et le compteur de la colonie');
  ok(/marche: \(t\) => \(marcheContexte \? marcheContexte\.contexteA\(t\) : null\)/.test(srv), 'smart_money recoit contexteA pour le carnet des lancements');
  ok(/if \(marcheContexte\) marcheContexte\.arrete\(\);/.test(srv), 'arrete a l extinction');
  ok(/marche: typeof deps\.marche === 'function' \? deps\.marche : null/.test(src('smart_money.js')), 'smart_money passe deps.marche au carnet');
  ok(/parBtc24h: groupe\(\(f\) => trancheMarche\(f\.t, 'btc24h'\)\)/.test(src('lancements_carnet.js')), 'le carnet des lancements groupe par BTC 24 h a la naissance');
  const col = src('ai_colonie.js');
  ok(!/contexteA\(/.test(col.replace(/function parMarcheDe[\s\S]*?\n\}\n/, '')), 'AUCUNE regle de la colonie ne lit le marche : contexteA n apparait que dans parMarcheDe');
  const rl = src('releve.js');
  ok(/'parBtc24h', 'parBtc7d', 'parEth24h'/.test(rl) && /x\.tranche \?\? x\.de \?\? x\.par/.test(rl) && /console\.log\('marche    '/.test(rl), 'releve.js : la ligne marche et les decoupages');
  ok(/lance marche "\$SRV" node marche_contexte\.test\.js/.test(src('verifie.sh')), 'la suite est dans verifie.sh');

  console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
