'use strict';
/*
 * Les annonces de la communaute $SWOGE (communaute.js, 11/10/2026).
 *
 * Aucune requete reelle : un FAUX NOEUD (eth_getLogs, eth_getCode, eth_call,
 * en-tetes de bloc, lots, refus 429) sert une chaine ecrite ici, DexScreener
 * et OpenAI sont simules dans le meme `prendre`, Telegram est un espion. Le
 * temps est une horloge qu on avance. Ce qui est verifie, c est l INTENTION :
 *  - TG_COMMUNAUTE vide = rien (0 requete, 0 minuterie, 0 fichier) ;
 *  - le classement par BENEFICIAIRE (jamais le signataire), les piscines
 *    trouvees par token0/token1 (jamais devinees), le brule hors de l offre,
 *    la maison, les contrats, la poussiere et la liquidite jamais annonces,
 *    l EIP-7702 compte comme une personne ;
 *  - la reprise apres redemarrage sans doublon et sans rejouer un Transfer ;
 *  - l anti-bruit (dollars, 24 h par adresse et par famille, 4 par heure +
 *    UN message groupe, rattrapage muet au-dela de 30 min) ;
 *  - le releve quotidien a 13:00 Europe/Paris, une fois, changement d heure
 *    compris ;
 *  - les images : une par genre, generees une fois, essais bornes, texte seul
 *    en cas d echec, adresse envoyee seulement si le fichier existe.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TG_COMMUNAUTE = '';          // le module lit deps.env ; on s assure que rien ne fuit de l environnement
const M = require('./communaute');
const cfg = require('./config');

let n = 0, rates = 0;
function ok(c, m) {
  if (c) { n++; return; }
  rates++; console.log('  RATE ' + m);
}
const egal = (a, b, m) => ok(a === b, m + ` (attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)})`);

// ------------------------------------------------------------ les adresses
const TOKEN = String(cfg.SWOGE_TOKEN).toLowerCase();
const A = (c) => '0x' + c.repeat(40 / c.length);
const PAIRE = M.PAIRE_PRIX;                     // v2 SWOGE/WETH (token0 WETH, token1 SWOGE)
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const V3 = A('c3'), FAUSSE = A('cc'), MUET = A('cd'), ROUTEUR = A('ae'), AGREG = A('ad');
const V3W = A('c4');                             // une v3 SWOGE/WETH : une piscine de MARCHE (l autre jeton est une valeur)
const SWOGEBET = '0xc0aed547862fba5d7d9fbf3cb14204cd756c8bea', LANCE = A('5a');   // un jeton du launchpad (v4)
const FRAIS = A('fe'), MAISON = A('aa'), LP = A('b0');
const E1 = A('e1'), U1 = A('01'), U2 = A('02'), U3 = A('03'), U4 = A('04'), U5 = A('05');
const N = (i) => '0x' + ('7' + String(i)).padStart(40, '7');
const ZERO = '0x' + '0'.repeat(40), MORT = '0x000000000000000000000000000000000000dead';
const PM4 = M.PM4;

// ------------------------------------------------------------ le faux noeud
const CAD = M.CADENCE_MS;
const BASE_B = 80000000, BASE_T = Date.parse('2026-10-01T00:00:00Z');
const hex = (x) => '0x' + Number(x).toString(16);
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function chaine(cadence) {
  const CADC = cadence || CAD;                  // la cadence REELLE du faux noeud (le module, lui, suppose 103,54 ms)
  const C = { logs: [], recus: {}, codes: {}, tokens: {}, now: 0, appels: [], prix: 0.0000458, mains: false,
              casse: null, refus: 0, vieux: false, images: 0, visions: 0, dex: 0,
              panne503: 0, panne503Methode: null, panne503Saute: 0, erreurElement: null, oublie: 0 };
  const blocA = (t) => BASE_B + Math.floor((t - BASE_T) / CADC);
  const tDe = (b) => BASE_T + (b - BASE_B) * CADC;
  C.blocA = blocA; C.tDe = tDe;
  let k = 0;
  /** Une transaction : [[de, vers, jetons]], au temps t (ms) ou au bloc donne.
   *  o.liquidite : la piscine qui emet un evenement de liquidite (Mint v2, ou
   *  ModifyLiquidity si c est le PoolManager v4) ; o.autres : [[jeton, de, vers]]
   *  des Transfer d AUTRES jetons dans le meme recu ; o.swapV4 : un Swap du
   *  PoolManager dans le recu. */
  C.tx = (t, transferts, o) => {
    const b = t < 1e11 ? t : blocA(t);
    const h = '0x' + (++k).toString(16).padStart(64, '0');
    transferts.forEach(([de, vers, q], i) => C.logs.push({
      address: TOKEN, topics: [M.TOPIC_TRANSFER, pad(de), pad(vers)],
      data: '0x' + (BigInt(Math.round(q * 1e6)) * 10n ** 12n).toString(16).padStart(64, '0'),
      blockNumber: hex(b), transactionHash: h, transactionIndex: '0x0', logIndex: hex(i), blockTimestamp: '0x0', removed: false }));
    const plus = C.recus[h] = [];
    if (o && o.liquidite) plus.push({ address: o.liquidite, topics: [o.liquidite === PM4 ? M.TOPIC_MODIFY_V4 : M.TOPICS_LIQUIDITE[0], pad(A('99'))], data: '0x', transactionHash: h });
    if (o && o.autres) for (const [jt, de, vers] of o.autres) plus.push({ address: jt, topics: [M.TOPIC_TRANSFER, pad(de), pad(vers)], data: '0x' + '1'.padStart(64, '0'), transactionHash: h });
    if (o && o.swapV4) plus.push({ address: PM4, topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', pad(A('99'))], data: '0x', transactionHash: h });
    return h;
  };
  /* le solde rejoue PAR LE FAUX NOEUD (sa verite), au bloc donne */
  C.solde = (adr, bloc) => {
    let s = 0n;
    for (const l of C.logs) {
      if (parseInt(l.blockNumber, 16) > bloc) continue;
      const v = BigInt(l.data);
      if (('0x' + l.topics[1].slice(26)) === adr) s -= v;
      if (('0x' + l.topics[2].slice(26)) === adr) s += v;
    }
    return s;
  };
  function repond(c) {
    const m = c.method, p = c.params;
    const multi = m === 'eth_getLogs' && (Array.isArray(p[0].address) || (p[0].topics || []).some((x) => Array.isArray(x) && x.length > 1));
    C.appels.push(m + (m === 'eth_getLogs' ? (multi ? ':multi' : p[0].address !== TOKEN ? ':autre:' + p[0].address : ':' + parseInt(p[0].fromBlock, 16)) : ''));
    if (C.casse === m) return { __err: 'panne simulee' };
    const tip = blocA(C.now);
    if (m === 'eth_getBlockByNumber') { const b = p[0] === 'latest' ? tip : parseInt(p[0], 16); return { number: hex(b), timestamp: hex(Math.floor(tDe(b) / 1000)) }; }
    if (m === 'eth_getLogs') {
      const f = p[0], de = parseInt(f.fromBlock, 16), a = parseInt(f.toBlock, 16);
      /* la regle du VRAI noeud (sonde du 12/10) : plusieurs valeurs dans une position = 100 000 blocs au plus */
      if (multi && a - de + 1 > 100000) return { __err: `query spans ${a - de + 1} blocks (${de} to ${a}), but only 100000 are allowed for this request; narrow the block range, or send one value per position` };
      if (a - de + 1 > M.FENETRE_LOGS) return { __err: `query spans ${a - de + 1} blocks, but only 10000000 are allowed for this request; narrow the block range` };
      if (f.address !== TOKEN) return [];
      /* une replique en retard : [] SANS erreur (comme le vrai noeud au-dela de sa pointe) */
      if (C.oublie > 0) { C.oublie--; return []; }
      /* un noeud qui rend AUSSI des journaux d avant fromBlock : le module ne doit rien rejouer */
      return C.logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return (C.vieux || b >= de) && b <= a && b <= tip; });
    }
    if (m === 'eth_getTransactionReceipt') {
      const logs = C.logs.filter((l) => l.transactionHash === p[0]);
      if (!logs.length) return null;
      /* le bruit du PoolManager : des ModifyLiquidity d AUTRES pools v4 n entrent jamais dans un recu du $SWOGE */
      return { transactionHash: p[0], status: '0x1', logs: logs.concat(C.recus[p[0]] || []) };
    }
    if (m === 'eth_getCode') return C.codes[p[0]] || '0x';
    if (m === 'eth_call') {
      if (p[0].data.startsWith('0x70a08231') && p[0].to === TOKEN) {
        const bloc = p[1] === 'latest' ? tip : parseInt(p[1], 16);
        if (bloc < tip - 1000) return { __err: 'historical state 4009c3a2 is not available' };
        return '0x' + C.solde('0x' + p[0].data.slice(34), bloc).toString(16);
      }
      if (C.erreurElement && C.erreurElement.to === p[0].to && C.erreurElement.n > 0) { C.erreurElement.n--; return { __err: 'request timed out' }; }
      const t = C.tokens[p[0].to];
      if (!t) return { __err: 'execution reverted' };
      return pad(p[0].data === '0x0dfe1681' ? t[0] : t[1]);
    }
    return { __err: 'methode inconnue ' + m };
  }
  const env = (c) => { const r = repond(c); return r && r.__err ? { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: r.__err } } : { jsonrpc: '2.0', id: c.id, result: r }; };
  C.prendre = async (url, opt) => {
    const u = String(url);
    if (u.includes('dexscreener')) { C.dex++; return { ok: true, status: 200, json: async () => ({ pairs: [{ priceUsd: String(C.prix) }] }) }; }
    if (u.includes('api.openai.com/v1/images')) { C.images++; C.dernierPrompt = JSON.parse(opt.body).prompt; return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }], usage: { output_tokens: 6893 } }) }; }
    if (u.includes('api.openai.com/v1/chat')) { C.visions++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hands: C.mains, why: 'test' }) } }] }) }; }
    if (u.includes('telegram') || u.includes('blockscout')) throw new Error('requete interdite dans l essai : ' + u);
    if (C.refus > 0) { C.refus--; C.appels.push('429'); return { ok: false, status: 429, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too Many Requests' } }) }; }
    const corps = JSON.parse(opt.body);
    /* une passerelle en panne : HTTP 503 et une page HTML, pas de JSON */
    const methodes = (Array.isArray(corps) ? corps : [corps]).map((x) => x.method);
    if (C.panne503 > 0 && (!C.panne503Methode || methodes.includes(C.panne503Methode))) {
      if (C.panne503Saute > 0) C.panne503Saute--;
      else { C.panne503--; C.appels.push('503'); return { ok: false, status: 503, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } }; }
    }
    const out = Array.isArray(corps) ? corps.map(env) : env(corps);
    return { ok: true, status: 200, json: async () => out };
  };
  /* le decor fixe : piscines, contrats, 7702 */
  C.tokens[PAIRE] = [WETH, TOKEN];
  C.tokens[V3] = [TOKEN, SWOGEBET];
  C.tokens[V3W] = [TOKEN, WETH];
  C.tokens[FAUSSE] = [WETH, SWOGEBET];   // une piscine… d autres jetons
  for (const c of [PAIRE, V3, V3W, FAUSSE, MUET, ROUTEUR, AGREG, PM4]) C.codes[c] = '0x6080604052';
  C.codes[U3] = '0xef0100' + 'ab'.repeat(20);                                 // EIP-7702 : une personne
  return C;
}

/** L histoire jusqu au 10/10 : frappe, lancement, piscines, brule, poussiere, detenteurs. */
function histoire(C) {
  const j = (s) => Date.parse(s);
  C.tx(M.BLOC_FRAPPE, [[ZERO, TOKEN, 1e9]]);
  C.tx(M.BLOC_FRAPPE + 168, [[TOKEN, PAIRE, 1e9]]);
  C.tx(j('2026-09-20T10:00:00Z'), [[PAIRE, E1, 300e6]]);                            // gros achat ancien
  C.tx(j('2026-09-20T11:00:00Z'), [[E1, V3, 100e6]], { liquidite: V3 });            // liquidite v3
  C.tx(j('2026-09-20T11:30:00Z'), [[E1, V3W, 20e6]], { liquidite: V3W });          // liquidite v3 SWOGE/WETH
  C.tx(j('2026-09-20T12:00:00Z'), [[E1, PM4, 50000]], { liquidite: PM4 });           // liquidite v4
  C.tx(j('2026-09-21T10:00:00Z'), [[E1, MORT, 10e6]]);                               // brulage
  for (let i = 0; i < 12; i++) C.tx(j('2026-09-22T10:00:00Z') + i * 60000, [[E1, A('d' + (i % 10)).slice(0, 40) + String(i % 10).repeat(2), 278.294]]);   // poussiere d airdrop
  C.tx(j('2026-09-23T10:00:00Z'), [[E1, MUET, 1e6]]);                                // un contrat qui tient
  C.tx(j('2026-09-23T11:00:00Z'), [[E1, FAUSSE, 500000]]);                           // un contrat-piscine d autres jetons
  C.tx(j('2026-09-25T10:00:00Z'), [[PAIRE, U5, 2e6]]);                              // U5 detient AVANT la fenetre…
  C.tx(j('2026-10-07T10:00:00Z'), [[U5, PAIRE, 2e6]]);                              // …et ne fait que vendre dedans
  C.tx(j('2026-10-03T10:00:00Z'), [[PAIRE, ROUTEUR, 5e6], [ROUTEUR, U1, 5e6]]);   // U1 entre le 03/10
  C.tx(j('2026-10-04T10:00:00Z'), [[PAIRE, U2, 2e6]]);                              // U2 entre le 04/10
  C.tx(j('2026-10-05T10:00:00Z'), [[PAIRE, U3, 3e6]]);                              // U3 (7702) entre le 05/10
  C.tx(j('2026-10-06T10:00:00Z'), [[PAIRE, U4, 2e6]]);                              // U4 entre le 06/10…
  C.tx(j('2026-10-08T10:00:00Z'), [[U4, PAIRE, 2e6]]);                              // …et sort le 08/10
  C.tx(j('2026-10-09T10:00:00Z'), [[PAIRE, MAISON, 4e6]]);                          // la maison achete
  C.tx(j('2026-10-09T11:00:00Z'), [[E1, LP, 6e6]]);                                 // LP recoit (transfert, pas achat)
}

function monde(o) {
  const C = chaine(o && o.cadence);
  histoire(C);
  C.now = Date.parse((o && o.depart) || '2026-10-10T08:00:00Z');                    // 10:00 a Paris
  const dossier = (o && o.dossier) || fs.mkdtempSync(path.join(os.tmpdir(), 'communaute-essai-'));
  const envois = [];
  const tg = {
    notify: (t) => envois.push({ photo: null, texte: t, fichier: lit(dossier) }),
    notifyPhoto: (p, t) => envois.push({ photo: p, texte: t, fichier: lit(dossier) }),
  };
  const fabrique = (env, plus) => M.cree(Object.assign({
    tg, prendre: C.prendre, dors: async () => {}, horloge: () => C.now, dossier,
    env: Object.assign({ TG_COMMUNAUTE: '1' }, env || {}), maison: () => [MAISON],
    publicUrl: 'https://serveur.exemple', explorer: 'https://explorateur.exemple', imageCle: false,
  }, plus || {}));
  return { C, dossier, envois, tg, fabrique };
}
function lit(dossier) { try { return JSON.parse(fs.readFileSync(path.join(dossier, 'communaute.json'), 'utf8')); } catch (e) { return null; } }
const MIN = 60000, H = 3600000;
const muet = async (f) => { const l = console.log, lignes = []; console.log = (...a) => lignes.push(a.join(' ')); try { return [await f(), lignes]; } finally { console.log = l; } };

(async () => {
  // ================================================== 1. variable vide = rien
  {
    const C = chaine();
    let appels = 0;
    const espion = async (...a) => { appels++; return C.prendre(...a); };
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'communaute-vide-'));
    const si = global.setInterval, st = global.setTimeout;
    let minuteries = 0;
    global.setInterval = (...a) => { minuteries++; return si(...a); };
    global.setTimeout = (...a) => { minuteries++; return st(...a); };
    let p, lignes;
    try {
      [p, lignes] = await muet(async () => M.planifie({ env: { TG_COMMUNAUTE: '' }, prendre: espion, dossier, tg: { notify() { appels++; }, notifyPhoto() { appels++; } } }));
    } finally { global.setInterval = si; global.setTimeout = st; }
    ok(p.actif === false, 'variable vide : module inerte');
    ok(lignes.some((l) => /\[communaute\] ETEINT \(TG_COMMUNAUTE vide\) : aucune requete, aucune annonce/.test(l)), 'variable vide : la ligne de demarrage le dit : ' + lignes.join(' | '));
    egal(minuteries, 0, 'variable vide : aucune minuterie');
    const r = await p.tic(); await p.images();
    egal(r.fait, 'off', 'variable vide : le tic ne fait rien');
    egal(appels, 0, 'variable vide : 0 requete, 0 message');
    egal(fs.readdirSync(dossier).length, 0, 'variable vide : aucun fichier ecrit');
    const [q, l2] = await muet(async () => M.planifie({ env: { TG_COMMUNAUTE: 'oui' }, prendre: espion, dossier, minuteries: false }));
    ok(q.actif === false && l2.some((l) => /inconnu/.test(l)), 'valeur inconnue : inerte, et dit pourquoi');
    egal(M.config({}).mode, 'off', 'config : rien pose = off');
    egal(M.config({ TG_COMMUNAUTE: 'observe' }).mode, 'observe', 'config : observe');
    egal(M.config({ TG_COMMUNAUTE: '1' }).mode, 'annonce', 'config : 1 = annonce');
    egal(M.config({ TG_COMMUNAUTE: '1', TG_COMMUNAUTE_HEURE: '25:99' }).heure, '13:00', 'heure illisible : 13:00 par defaut');
    egal(M.config({ TG_COMMUNAUTE: '1', TG_COMMUNAUTE_HEURE: '9:30' }).heure, '9:30', 'heure reglable');
  }

  // ================================================== 2. construction : chiffres, piscines, exclusions
  const W = monde();
  const I = W.fabrique();
  {
    const [r] = await muet(() => I.tic());
    egal(r.fait, 'construit', 'premier tic : construction');
    egal(W.envois.length, 0, 'la construction n annonce RIEN de l historique');
    ok(W.C.appels.includes('eth_getLogs:' + M.BLOC_FRAPPE), 'le rejeu part de la frappe (bloc 3 747 598)');
    ok(!W.C.appels.some((a) => /blockscout/.test(a)), 'aucun appel a Blockscout');
    /* relecture du 12/10 : JAMAIS de requete de journaux sur le PoolManager v4 (toute la chaine v4)
       ni a plusieurs valeurs par position (100 000 blocs au plus) ; la liquidite se lit dans les RECUS */
    ok(!W.C.appels.some((a) => /eth_getLogs:(multi|autre)/.test(a)), 'construction : eth_getLogs seulement sur le jeton, une valeur par position : ' + W.C.appels.filter((a) => /getLogs/.test(a)).join(','));
    ok(W.C.appels.includes('eth_getTransactionReceipt'), 'construction : la liquidite et le sens se lisent dans les recus des echanges de la fenetre');
    const S = I.etat();
    ok(S.pools.has(PAIRE) && S.pools.has(V3) && S.pools.has(V3W) && S.pools.has(PM4), 'piscines TROUVEES : v2 (token1), v3 (token0), PoolManager v4');
    egal(S.autres[PAIRE], WETH, 'l autre jeton de la paire v2 est lu (WETH) : une piscine de marche');
    egal(S.autres[V3], SWOGEBET, 'l autre jeton de la v3 est lu ($SWOGEBET) : une piscine de conversion');
    ok(!S.pools.has(FAUSSE) && !S.pools.has(MUET), 'un contrat dont token0/token1 ne sont pas le $SWOGE, ou qui echoue, n est pas une piscine');
    egal(S.codes[U3], 'p', 'EIP-7702 (0xef0100…) : une personne');
    const c = I.chiffres();
    /* personnes >= 1 000 : E1, U1, U2, U3 (7702), LP — pas la maison, pas MUET/FAUSSE, pas la poussiere, pas U4 (sorti) */
    egal(c.detenteurs, 5, 'detenteurs : personnes a 1 000 ou plus, hors maison, contrats, piscines, poussiere');
    egal(Math.round(c.brule), 10e6, 'le brule (0x…dEaD) est compte');
    egal(Math.round(c.circulation), 990e6, 'offre en circulation = frappe - brule');
    /* la paire : 1 G - E1 300 M - U1 5 M - U2 2 M - U3 3 M - U4 2 M + U4 2 M - maison 4 M ; v3 100 M ; v3 WETH 20 M ; v4 50 000 */
    const pools = 1e9 - 300e6 - 5e6 - 2e6 - 3e6 - 2e6 + 2e6 - 4e6 + 100e6 + 20e6 + 50000;
    egal(Math.round(c.pools), pools, 'solde des piscines = v2 + v3 + v3 WETH + v4');
    ok(Math.abs(c.horsPools - 100 * (1 - pools / 990e6)) < 0.001, `part hors piscines = 1 - piscines / circulation (${c.horsPools} contre ${100 * (1 - pools / 990e6)})`);
    let brut = 0; for (const [, b] of S.soldes) if (b > 0n) brut++;
    ok(brut > c.detenteurs + 10, `le compte « brut » (GoPlus, Blockscout : tout solde > 0) est bien plus grand que le notre : ${brut} contre ${c.detenteurs}`);
    const f = lit(W.dossier);
    ok(f && f.curseur === W.C.blocA(W.C.now) - M.CONFIRMATIONS, 'le curseur est pose a la pointe moins 50 blocs, sur le disque');
    /* photos reconstruites : U4 entre le 06/10 et sort le 08/10, U3 entre le 05/10 */
    egal(S.photos['2026-10-08'] && S.photos['2026-10-08'].sorties, 1, 'photo reconstruite : 1 sortie le 08/10');
    egal(S.photos['2026-10-05'] && S.photos['2026-10-05'].entrees, 1, 'photo reconstruite : 1 entree le 05/10');
    egal(S.photos['2026-10-09'] && S.photos['2026-10-09'].detenteurs, 5, 'photo reconstruite : 5 detenteurs fin 09/10 (la maison ne compte pas)');
    /* U5 tenait avant la fenetre et n y fait que vendre : son code doit etre lu, sinon il manque aux photos d avant sa sortie */
    egal(S.photos['2026-10-06'] && S.photos['2026-10-06'].detenteurs, 6, 'photo reconstruite : 6 detenteurs fin 06/10 (U5, sorti depuis, compte)');
    egal(S.photos['2026-10-07'] && S.photos['2026-10-07'].sorties, 1, 'photo reconstruite : la sortie de U5 le 07/10');
  }

  // ================================================== 3. le classement, une heure entre chaque
  const pas = async (transferts, o) => {
    W.C.now += 70 * MIN;
    const h = W.C.tx(W.C.now - 2 * MIN, transferts, o);
    const avant = W.envois.length;
    await muet(() => I.tic());
    /* le releve de 13:00 peut tomber dans le meme tic : on le met a part */
    return { h, msg: W.envois.slice(avant).filter((m) => !/daily report/.test(m.texte)) };
  };
  {
    W.C.now += MIN; await muet(() => I.tic());
    egal(W.envois.length, 0, 'un tic sans echange : rien');
    const N1 = N(1);
    let r = await pas([[PAIRE, ROUTEUR, 2e6], [ROUTEUR, N1, 2e6]]);
    egal(r.msg.length, 1, 'premier achat d un portefeuille vide : une annonce');
    ok(/^🆕 <b>New holder<\/b>\n/.test(r.msg[0].texte) && !/welcome back/.test(r.msg[0].texte), 'New holder : ' + r.msg[0].texte);
    ok(r.msg[0].texte.includes(N1) && !r.msg[0].texte.includes(ROUTEUR), 'le BENEFICIAIRE est annonce, jamais le routeur');
    ok(/bought <b>2\.0M \$SWOGE<\/b> \(~\$92\)/.test(r.msg[0].texte), 'montant en jetons et en dollars (2 M × 0,0000458 $)');
    ok(/👥 6 holders \(.+ in 24h\) · 🆕 1 new today · 🌊 [\d.]+% of supply outside pools/.test(r.msg[0].texte), 'la ligne de communaute : ' + r.msg[0].texte.split('\n')[2]);
    ok(r.msg[0].texte.includes('https://explorateur.exemple/tx/' + r.h), 'le lien de la transaction');
    egal(r.msg[0].photo, null, 'pas d image sur le disque : texte seul');
    ok(r.msg[0].fichier && r.msg[0].fichier.annonces[r.h], 'l etat (transaction marquee) est ECRIT avant l envoi');

    const N2 = N(2);
    r = await pas([[PAIRE, AGREG, 1.5e6], [AGREG, N2, 1.485e6], [AGREG, FRAIS, 15000]]);
    egal(r.msg.length, 1, 'achat relaye avec frais : UNE annonce');
    ok(r.msg[0].texte.includes(N2) && !r.msg[0].texte.includes(FRAIS), 'le portefeuille de frais n est jamais pris pour l acheteur');

    r = await pas([[PAIRE, U1, 1e6]]);
    ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && /now holds 6\.0M/.test(r.msg[0].texte), 'achat d un detenteur : Believer : ' + (r.msg[0] || {}).texte);

    r = await pas([[U2, ROUTEUR, 2e6], [ROUTEUR, PAIRE, 1.98e6], [ROUTEUR, FRAIS, 20000]]);
    ok(r.msg.length === 1 && /^🧻 <b>Paper hand<\/b>/.test(r.msg[0].texte) && r.msg[0].texte.includes(U2) && /and left/.test(r.msg[0].texte), 'vente totale : Paper hand, le vendeur et non le routeur');

    r = await pas([[U1, PAIRE, 1e6]]);
    egal(r.msg.length, 0, 'vente partielle (reste >= 1 000) : PAS annoncee');
    ok(I.etat().compteurs.genre_partielle === 1, 'la vente partielle est comptee');

    /* un contrat achete 100 M ; un portefeuille de frais NEUF touche 1 % (1 M ~ 46 $, au-dessus du seuil) :
       il ne porte pas la moitie du flux, ce n est pas un acheteur — jamais un faux New holder */
    r = await pas([[PAIRE, MUET, 99e6], [PAIRE, A('fd'), 1e6]]);
    egal(r.msg.length, 0, 'achat d un contrat, 1 % au portefeuille de frais : rien (le frais ne porte pas la moitie du flux)');
    ok(I.etat().compteurs.genre_sansBeneficiaire >= 1, 'compte « sans beneficiaire »');
    r = await pas([[PAIRE, MAISON, 3e6]]);
    egal(r.msg.length, 0, 'un achat de la maison : jamais annonce');
    r = await pas([[PAIRE, MUET, 3e6]]);
    egal(r.msg.length, 0, 'un achat par un contrat : jamais annonce');
    r = await pas([[PAIRE, U3, 1e6]]);
    ok(r.msg.length === 1 && /Believer/.test(r.msg[0].texte) && r.msg[0].texte.includes(U3), 'portefeuille EIP-7702 : une personne, annoncee');
    r = await pas([[PAIRE, AGREG, 1e6], [AGREG, V3, 1e6]]);
    egal(r.msg.length, 0, 'arbitrage entre deux piscines (net des piscines nul) : rien');
    r = await pas([[LP, PAIRE, 5e6]], { liquidite: PAIRE });
    egal(r.msg.length, 0, 'ajout de liquidite (Mint sur la piscine) : ni vente ni paper hand');
    ok(I.etat().compteurs.liquidite === 1, 'la liquidite est comptee a part');
    const N3 = N(3);
    r = await pas([[PAIRE, N3, 100000]]);
    egal(r.msg.length, 0, 'achat sous le minimum (100 k ~ 4,58 $ < 10 $) : pas annonce');
    ok(I.etat().compteurs.sousSeuil_nouveau === 1, 'compte sous le seuil, par genre');
    r = await pas([[PAIRE, A('99'), 500]]);
    egal(r.msg.length, 0, 'achat qui reste sous 1 000 jetons : poussiere, jamais « New holder »');
    r = await pas([[PAIRE, U4, 2e6]]);
    ok(r.msg.length === 1 && /New holder<\/b> · welcome back/.test(r.msg[0].texte), 'retour d un ancien detenteur : New holder · welcome back');
    /* Relecture du 12/10 : un echange $SWOGEBET → $SWOGE n est pas un achat contre de la valeur —
       swogebet_achats.js annonce deja les echanges de la v3. Avant, il etait « New holder » : l intention
       (« un achat a une piscine v3 s annonce aussi ») vaut pour une v3 de MARCHE (SWOGE/WETH). */
    const N4 = N(4);
    r = await pas([[V3, N4, 3e6]]);
    egal(r.msg.length, 0, '$SWOGEBET → $SWOGE (piscine v3 SWOGE/SWOGEBET) : une conversion, rien d annonce');
    egal(I.etat().compteurs.genre_conversion, 1, 'la conversion est comptee');
    ok(I.etat().jours[M.jourParis(W.C.now)].recus.includes(N4) && !I.etat().jours[M.jourParis(W.C.now)].entrees.includes(N4), 'une conversion qui passe le seuil : « moved in », jamais « new »');
    const N8 = N(8);
    r = await pas([[V3W, N8, 3e6]]);
    ok(r.msg.length === 1 && /New holder/.test(r.msg[0].texte) && r.msg[0].texte.includes(N8), 'achat a une piscine v3 SWOGE/WETH (marche) : annonce aussi');
  }

  // ================================================== 4. reprise apres redemarrage
  {
    const avant = W.envois.length, c0 = I.chiffres();
    W.C.appels.length = 0;
    W.C.now += 5 * MIN;
    const I2 = W.fabrique();
    await muet(() => I2.tic());
    egal(W.envois.length, avant, 'apres redemarrage : rien n est re-annonce');
    ok(!W.C.appels.includes('eth_getLogs:' + M.BLOC_FRAPPE), 'apres redemarrage : pas de rejeu depuis la frappe (reprise au curseur)');
    egal(I2.chiffres().detenteurs, c0.detenteurs, 'apres redemarrage : memes detenteurs');
    /* un noeud qui renvoie AUSSI de vieux journaux : rien n est rejoue deux fois */
    W.C.vieux = true; W.C.now += 2 * MIN;
    await muet(() => I2.tic());
    W.C.vieux = false;
    egal(I2.chiffres().detenteurs, c0.detenteurs, 'des journaux deja traites rendus par le noeud ne sont pas re-appliques');
    egal(Math.round(I2.chiffres().pools), Math.round(c0.pools), 'ni le solde des piscines');
    egal(W.envois.length, avant, 'ni re-annonces');
    /* une panne au milieu d un tic : l etat est relu du disque, l echange part UNE fois */
    W.C.now += 70 * MIN;
    const N5 = N(5);
    W.C.tx(W.C.now - 2 * MIN, [[PAIRE, N5, 2e6]]);
    W.C.casse = 'eth_getCode';
    const [rp] = await muet(() => I2.tic());
    egal(rp.fait, 'erreur', 'panne du noeud pendant le tic : le tic echoue proprement');
    W.C.casse = null; W.C.now += MIN;
    await muet(() => I2.tic());
    egal(W.envois.slice(avant).filter((m) => m.texte.includes(N5)).length, 1, 'apres la panne : annonce une fois, pas zero, pas deux');
    egal(I2.chiffres().detenteurs, c0.detenteurs + 1, 'apres la panne : le Transfer est applique une fois');
    /* une adresse dont le code reste illisible : 4 tics reportes, le 5e passe (jamais de blocage definitif) */
    W.C.now += 70 * MIN;
    W.C.tx(W.C.now - 2 * MIN, [[PAIRE, N(6), 2e6]]);
    W.C.casse = 'eth_getCode';
    const faits = [];
    for (let i = 0; i < 5; i++) { W.C.now += MIN; const [x] = await muet(() => I2.tic()); faits.push(x.fait); }
    W.C.casse = null;
    egal(faits.join(','), 'erreur,erreur,erreur,erreur,tic', 'code illisible : quatre tics reportes, le cinquieme continue');
    ok(lit(W.dossier).curseur >= W.C.blocA(W.C.now) - M.CONFIRMATIONS - 1, 'le curseur avance apres le cinquieme tic');
    /* un refus 429 : recul puis reprise */
    W.C.refus = 2; W.C.now += MIN;
    const [r429] = await muet(() => I2.tic());
    egal(r429.fait, 'tic', 'deux refus 429 : on recule et on reprend');
    ok(I2.etat().refus429 >= 2, 'les refus 429 sont comptes');
  }

  // ================================================== 5. anti-bruit
  {
    const V = monde();
    const J = V.fabrique();
    await muet(() => J.tic());
    /* 24 h par adresse ET par famille */
    V.C.now += 70 * MIN;
    V.C.tx(V.C.now - 2 * MIN, [[PAIRE, U1, 1e6]]);
    await muet(() => J.tic());
    V.C.now += 70 * MIN;
    V.C.tx(V.C.now - 2 * MIN, [[PAIRE, U1, 1e6]]);
    await muet(() => J.tic());
    egal(V.envois.filter((m) => /Believer/.test(m.texte)).length, 1, 'meme believer deux fois en 24 h : une annonce');
    ok(J.etat().compteurs.recharge_believer === 1, 'la seconde est comptee « recharge »');
    V.C.now += 70 * MIN;
    V.C.tx(V.C.now - 2 * MIN, [[U1, PAIRE, 7e6]]);
    await muet(() => J.tic());
    egal(V.envois.filter((m) => /Paper hand/.test(m.texte)).length, 1, 'le meme portefeuille qui sort : sa paper hand passe (autre famille)');
    V.C.now += 24 * H;
    V.C.tx(V.C.now - 2 * MIN, [[PAIRE, U2, 1e6]]);
    await muet(() => J.tic());
    V.C.now += 70 * MIN;
    V.C.tx(V.C.now - 2 * MIN, [[PAIRE, U2, 1e6]]);
    await muet(() => J.tic());
    V.C.now += 24 * H;
    V.C.tx(V.C.now - 2 * MIN, [[PAIRE, U2, 1e6]]);
    await muet(() => J.tic());
    egal(V.envois.filter((m) => /Believer/.test(m.texte) && m.texte.includes(U2)).length, 2, 'apres 24 h, le meme believer parle de nouveau');
    /* 4 par heure, puis UN message groupe */
    const debut = V.envois.length;
    const hh = Math.floor(V.C.now / H) * H + H;            // le debut d une heure neuve
    V.C.now = hh + 5 * MIN;
    for (let i = 10; i < 16; i++) V.C.tx(V.C.now - (30 - i) * 1000, [[PAIRE, N(i), 2e6]]);
    await muet(() => J.tic());
    egal(V.envois.length - debut, 4, 'six achats dans l heure : quatre annonces');
    V.C.now = hh + H + MIN;
    await muet(() => J.tic());
    const g = V.envois.slice(debut + 4);
    ok(g.length === 1 && /📊 <b>\+2 more in the last hour<\/b>\n2 buys \(2 new holders\)\n👥/.test(g[0].texte), 'le surplus part en UN message groupe a l heure suivante : ' + (g[0] || {}).texte);
    egal(J.etat().compteurs.messagesGroupes, 1, 'un message groupe compte');
    /* un surplus laisse en plan par une coupure ne part pas trois heures plus tard sous « the last hour » */
    {
      const Q = monde();
      const JQ = Q.fabrique();
      await muet(() => JQ.tic());
      const h0 = Math.floor(Q.C.now / H) * H + H;
      Q.C.now = h0 + 5 * MIN;
      for (let i = 80; i < 86; i++) Q.C.tx(Q.C.now - (30 - (i - 80)) * 1000, [[PAIRE, N(i), 2e6]]);
      await muet(() => JQ.tic());
      const dq = Q.envois.length;
      Q.C.now = h0 + 3 * H + MIN;
      await muet(() => Q.fabrique().tic());
      ok(!Q.envois.slice(dq).some((m) => /more in the last hour/.test(m.texte)), 'surplus perime apres 3 h de coupure : pas de « +2 more in the last hour »');
      ok(lit(Q.dossier).compteurs.groupesPerimes === 1, 'il est compte « groupesPerimes »');
    }
    /* le rattrapage apres une coupure : muet au-dela de 30 min */
    const d2 = V.envois.length;
    const vieux = V.C.now + 10 * MIN, recent = V.C.now + 115 * MIN;
    V.C.tx(vieux, [[PAIRE, N(30), 2e6]]);
    V.C.tx(recent, [[PAIRE, N(31), 2e6]]);
    V.C.now += 2 * H;                                       // le serveur etait coupe
    const K = V.fabrique();
    await muet(() => K.tic());
    const r = V.envois.slice(d2);
    ok(r.length === 1 && r[0].texte.includes(N(31)), 'apres 2 h de coupure : seul l echange de moins de 30 min est annonce');
    ok(K.etat().compteurs.retard_nouveau === 1, 'l echange trop vieux est compte « retard »');
    ok(K.etat().soldes.get(N(30)) > 0n, '…et il est bien dans le grand livre');
    /* sans prix (DexScreener muet depuis plus de 6 h) : rien d annonce */
    V.C.prendreDex = V.C.prendre;
    const P = V.fabrique(null, { prendre: async (u, o) => { if (String(u).includes('dexscreener')) throw new Error('muet'); return V.C.prendre(u, o); } });
    const st = P.etat(); st.prix = { usd: 0.0000458, t: V.C.now - 7 * H };
    V.C.now += 70 * MIN; V.C.tx(V.C.now - 2 * MIN, [[PAIRE, N(40), 2e6]]);
    const d3 = V.envois.length;
    await muet(() => P.tic());
    egal(V.envois.length - d3, 0, 'sans cours depuis plus de 6 h : aucune annonce (pas de seuil en dollars sans dollar)');
    ok(P.etat().compteurs.sansPrix_nouveau === 1, 'compte « sansPrix »');
  }

  // ================================================== 6. observe : calcule et journalise, n envoie rien
  {
    const O = monde();
    const J = O.fabrique({ TG_COMMUNAUTE: 'observe' }, { imageCle: true });
    await muet(() => J.tic());
    O.C.now += 70 * MIN; O.C.tx(O.C.now - 2 * MIN, [[PAIRE, N(50), 2e6]]);
    const [, lignes] = await muet(() => J.tic());
    egal(O.envois.length, 0, 'observe : rien ne part sur Telegram');
    ok(lignes.some((l) => /OBSERVATION · nouveau : 🆕 New holder/.test(l)), 'observe : l annonce est journalisee : ' + lignes.join(' | '));
    const gi = await J.images();
    ok(gi.fait === 'rien' && O.C.images === 0, 'observe : aucune image generee (0 $)');
  }

  // ================================================== 7. le releve quotidien, 13:00 Europe/Paris
  {
    const R = monde({ depart: '2026-10-10T09:00:00Z' });
    const J = R.fabrique();
    await muet(() => J.tic());
    R.C.now = Date.parse('2026-10-10T10:59:00Z');           // 12:59 a Paris (CEST)
    await muet(() => J.tic());
    egal(R.envois.filter((m) => /daily report/.test(m.texte)).length, 0, '12:59 a Paris : pas de releve');
    R.C.now = Date.parse('2026-10-10T11:00:30Z');           // 13:00 a Paris
    await muet(() => J.tic());
    const rel = R.envois.filter((m) => /daily report/.test(m.texte));
    egal(rel.length, 1, '13:00 a Paris : le releve part');
    const t = rel[0].texte;
    ok(/📈 <b>\$SWOGE community · daily report<\/b>\n<b>5<\/b> holders now/.test(t), 'releve : detenteurs maintenant');
    ok(/<b>[\d.]+%<\/b> of supply outside pools/.test(t), 'releve : part hors piscines');
    for (const j of ['Oct 03', 'Oct 04', 'Oct 05', 'Oct 06', 'Oct 07', 'Oct 08', 'Oct 09']) ok(t.includes(j), 'releve : la ligne du ' + j);
    ok(!t.includes('Oct 10') && !t.includes('Oct 02 '), 'releve : sept jours complets, ni aujourd hui ni le 02/10');
    ok(/Oct 08 +\d+ \(-1\) +0 +1 /.test(t), 'releve : le 08/10, -1 detenteur, 0 entree, 1 sortie : ' + t);
    ok(/7 days: <b>[+±\-\d]+<\/b> holders · \d+ new \(\d+ first-time\) · \d+ left · \d+ partial sells/.test(t), 'releve : le bilan des 7 jours');
    /* relecture du 12/10 : « ~540 » et « ~700 » etaient ecrits en dur (les chiffres du 11/10). Ils sont CALCULES :
       le compte brut (tout solde > 0, comme GoPlus) et les personnes sous 1 000. */
    {
      const S7 = J.etat();
      let brut = 0, pouss = 0;
      for (const [a, b] of S7.soldes) {
        if (a === ZERO) continue;
        if (b > 0n) brut++;
        if (b > 0n && b < M.SEUIL_DETENTEUR && S7.codes[a] === 'p') pouss++;
      }
      ok(pouss >= 10 && brut > pouss, `releve : il y a de la poussiere (${pouss}) et un compte brut (${brut}) dans le decor`);
      ok(/1,000\+ \$SWOGE/.test(t) && t.includes(`and ${pouss} wallets under 1,000`) && t.includes(`trackers that count every balance show ${brut}.`) && !/~540|~700/.test(t),
         'releve : la definition, et les chiffres publics CALCULES (poussiere, compte brut) : ' + t.split('\n').pop());
    }
    ok(t.replace(/<[^>]*>/g, '').length < 1024, 'releve : sous la limite de legende de Telegram (1 024) : ' + t.replace(/<[^>]*>/g, '').length);
    R.C.now += 30 * MIN; await muet(() => J.tic());
    const J2 = R.fabrique(); R.C.now += MIN; await muet(() => J2.tic());
    egal(R.envois.filter((m) => /daily report/.test(m.texte)).length, 1, 'une seule fois par jour, redemarrage compris');
    R.C.now = Date.parse('2026-10-11T11:00:30Z'); await muet(() => J2.tic());
    egal(R.envois.filter((m) => /daily report/.test(m.texte)).length, 2, 'le lendemain a 13:00 : le suivant');
    /* le changement d heure du 25/10/2026 : 13:00 a Paris = 12:00 UTC (CET) */
    R.C.now = Date.parse('2026-10-24T11:00:30Z'); await muet(() => J2.tic());
    egal(R.envois.filter((m) => /daily report/.test(m.texte)).length, 3, '24/10, 11:00 UTC = 13:00 CEST : releve');
    R.C.now = Date.parse('2026-10-25T11:00:30Z'); await muet(() => J2.tic());
    egal(R.envois.filter((m) => /daily report/.test(m.texte)).length, 3, '25/10, 11:00 UTC = 12:00 CET : pas encore');
    R.C.now = Date.parse('2026-10-25T12:00:30Z'); await muet(() => J2.tic());
    egal(R.envois.filter((m) => /daily report/.test(m.texte)).length, 4, '25/10, 12:00 UTC = 13:00 CET : releve');
    /* demarre a 17:30 : le releve du jour est saute (plus de 3 h de retard), celui du lendemain part */
    const T = monde({ depart: '2026-10-10T15:30:00Z' });
    const K = T.fabrique();
    await muet(() => K.tic()); T.C.now += MIN; await muet(() => K.tic());
    egal(T.envois.filter((m) => /daily report/.test(m.texte)).length, 0, 'demarre a 17:30 Paris : pas de releve en retard de 4 h');
    T.C.now = Date.parse('2026-10-11T11:01:00Z'); await muet(() => K.tic());
    egal(T.envois.filter((m) => /daily report/.test(m.texte)).length, 1, 'le lendemain a 13:00 : releve');
    /* la photo d une journee se prend AVANT le premier echange du lendemain, meme si les deux tombent dans le meme tic */
    const X = monde({ depart: '2026-10-10T21:50:00Z' });     // 23:50 a Paris
    const KX = X.fabrique();
    await muet(() => KX.tic());
    X.C.now = Date.parse('2026-10-10T21:58:00Z'); await muet(() => KX.tic());
    X.C.tx(Date.parse('2026-10-10T22:00:30Z'), [[PAIRE, N(70), 2e6]]);   // 00:00:30 a Paris, le 11/10
    X.C.now = Date.parse('2026-10-10T22:01:40Z'); await muet(() => KX.tic());
    egal(KX.etat().photos['2026-10-10'] && KX.etat().photos['2026-10-10'].detenteurs, 5, 'photo du 10/10 prise avant l achat de 00:00:30 (5, pas 6)');
    ok((KX.etat().jours['2026-10-11'] || {}).entrees.includes(N(70)), 'l achat de 00:00:30 compte pour le 11/10');
    /* un achat de 23:59:59, encore sous les 50 blocs de marge au tic de 00:00:02, appartient a la VEILLE */
    const Y = monde({ depart: '2026-10-10T21:50:00Z' });
    const KY = Y.fabrique();
    await muet(() => KY.tic());
    Y.C.tx(Date.parse('2026-10-10T21:59:59Z'), [[PAIRE, N(71), 2e6]]);
    Y.C.now = Date.parse('2026-10-10T22:00:02Z'); await muet(() => KY.tic());
    Y.C.now = Date.parse('2026-10-10T22:01:00Z'); await muet(() => KY.tic());
    const py = KY.etat().photos['2026-10-10'];
    ok(py && py.detenteurs === 6 && py.entrees === 1, 'photo du 10/10 : l achat de 23:59:59 traite apres minuit y est (6 detenteurs, 1 entree) : ' + JSON.stringify(py));
    egal(KY.etat().jourCourant, '2026-10-11', 'la journee courante ne recule jamais');
    /* un noeud plus rapide que la cadence mesuree (90 ms au lieu de 103,54) : un echange d apres minuit,
       traite dix minutes plus tard, est date AVANT minuit par l interpolation — la veille ne se rouvre pas */
    const Z9 = monde({ depart: '2026-10-10T21:50:00Z', cadence: 90 });
    const KZ = Z9.fabrique();
    await muet(() => KZ.tic());
    Z9.C.now = Date.parse('2026-10-10T22:00:10Z'); await muet(() => KZ.tic());
    Z9.C.tx(Z9.C.blocA(Z9.C.now) - 40, [[PAIRE, N(72), 2e6]]);
    Z9.C.now = Date.parse('2026-10-10T22:10:00Z'); await muet(() => KZ.tic());
    egal(KZ.etat().jourCourant, '2026-10-11', 'noeud a 90 ms : la journee courante reste le 11/10');
    ok(!KZ.etat().photos['2026-10-11'], 'noeud a 90 ms : aucune photo d une journee pas finie');
    egal(M.minuitParis('2026-10-25'), Date.parse('2026-10-24T22:00:00Z'), 'minuit a Paris le 25/10 = 22:00 UTC la veille (CEST)');
    egal(M.minuitParis('2026-10-26'), Date.parse('2026-10-25T23:00:00Z'), 'minuit a Paris le 26/10 = 23:00 UTC la veille (CET)');
  }

  // ================================================== 8. les images
  {
    /* le vrai chemin x_post (genereImageVerifiee + controle des pattes), OpenAI simule */
    process.env.OPENAI_API_KEY = 'sk-essai-factice';
    const G = monde();
    const J = G.fabrique({}, { imageCle: true });
    const prompts = [];
    const vrai = G.C.prendre;
    G.C.prendre = async (u, o) => { if (String(u).includes('/v1/images')) prompts.push(JSON.parse(o.body).prompt); return vrai(u, o); };
    const J1 = G.fabrique({}, { imageCle: true, prendre: G.C.prendre });
    const [r] = await muet(() => J1.images());
    egal(r.faites.join(','), 'nouveau,believer,paper,releve', 'quatre images, une par genre');
    egal(G.C.images, 4, 'quatre generations (une par genre, pattes ok)');
    egal(G.C.visions, 4, 'chacune controlee (pattes de chien, pas de mains)');
    for (const g of M.GENRES_IMAGE) ok(fs.existsSync(path.join(G.dossier, 'communaute_images', g + '-v1.png')), 'image ' + g + ' sur le volume');
    ok(prompts.every((p) => /furry dog paws with paw pads, never human hands/.test(p)), 'chaque prompt porte le personnage SWOGE et ses pattes');
    ok(/confetti/.test(prompts[0]) && /diamond/.test(prompts[1]) && /paper/.test(prompts[2]) && /chalk bar chart/.test(prompts[3]), 'prompts dedies : fete, diamant, papier qui s envole, tableau de croissance');
    ok(/no digits, no letters/.test(prompts[3]), 'le graphique est demande explicitement, sans chiffres ni lettres');
    const jr = J1.journalImages();
    ok(jr['nouveau-v1'] && jr['nouveau-v1'].essais === 1 && jr['nouveau-v1'].jetons === 6893 && jr['nouveau-v1'].coutUsd === 0.221 && jr['nouveau-v1'].pattes === 'pattes ok', 'journal des images : essais, jetons, cout, controle');
    const J2 = G.fabrique({}, { imageCle: true, prendre: G.C.prendre });
    await muet(() => J2.images());
    egal(G.C.images, 4, 'au redemarrage : aucune image refaite');
    /* les annonces portent l image de leur genre, par l adresse publique */
    await muet(() => J2.tic());
    G.C.now += 70 * MIN; G.C.tx(G.C.now - 2 * MIN, [[PAIRE, N(60), 2e6]]);
    G.C.now += 1; await muet(() => J2.tic());
    const m = G.envois[G.envois.length - 1];
    egal(m.photo, 'https://serveur.exemple/communaute/image/nouveau-v1.png', 'New holder : son image, servie par la route publique');
    G.C.now += 70 * MIN; G.C.tx(G.C.now - 2 * MIN, [[N(60), PAIRE, 2e6]]);
    await muet(() => J2.tic());
    egal(G.envois[G.envois.length - 1].photo, 'https://serveur.exemple/communaute/image/paper-v1.png', 'Paper hand : son image');
    egal(M.litImage('nouveau-v1', G.dossier).length, PNG.length, 'la route lit le fichier');
    egal(M.litImage('../communaute', G.dossier), null, 'la route refuse un nom douteux');
    egal(M.litImage('absent-v1', G.dossier), null, 'la route : absent = null (404)');

    /* un generateur qui voit toujours des mains : essais bornes, texte seul, jamais en boucle */
    const B = monde();
    B.C.mains = true;
    const K = B.fabrique({}, { imageCle: true });
    await muet(() => K.images());
    await muet(() => B.fabrique({}, { imageCle: true }).images());
    await muet(() => B.fabrique({}, { imageCle: true }).images());
    egal(B.C.images, 4 * 2 * 2, 'mains humaines a chaque fois : 2 appels × 2 generations par genre, puis plus jamais (redemarrages compris)');
    const jb = K.journalImages();
    ok(M.GENRES_IMAGE.every((g) => jb[g + '-v1'].essais === 2 && /mains humaines/.test(jb[g + '-v1'].erreur)), 'journal : deux essais par genre, et pourquoi');
    ok(!fs.existsSync(path.join(B.dossier, 'communaute_images', 'nouveau-v1.png')), 'aucune image a mains humaines sur le volume');
    await muet(() => K.tic());
    B.C.now += 70 * MIN; B.C.tx(B.C.now - 2 * MIN, [[PAIRE, N(61), 2e6]]);
    await muet(() => K.tic());
    egal(B.envois[B.envois.length - 1].photo, null, 'sans image : l annonce part en texte seul');
    /* sans cle OpenAI : rien n est tente */
    const Z = monde();
    await muet(() => Z.fabrique({}, { imageCle: false }).images());
    egal(Z.C.images, 0, 'OPENAI_API_KEY absente : aucune generation');
    delete process.env.OPENAI_API_KEY;
  }

  // ================================================== 9. les constantes qui viennent d ailleurs
  {
    egal(M.PM4, require('./miroir').PM4.toLowerCase(), 'PM4 = le PoolManager v4 de miroir.js');
    egal(M.PAIRE_PRIX, '0x2dc0fb72d9284228046cc95910eeaabebfe48456', 'la paire du prix = la paire v2 de cours_chaine.js');
    egal(require('./cours_chaine').POOL.toLowerCase(), M.PAIRE_PRIX, 'meme paire que cours_chaine.js');
    ok(M.SEUIL_DETENTEUR === 1000n * 10n ** 18n, 'detenteur : 1 000 $SWOGE');
    ok(M.BRULES.has(ZERO) && M.BRULES.has(MORT) && M.BRULES.has('0x0000000000000000000000000000000000000009'), 'brule : 0x0, 0x…dEaD, 0x…01 a 09');
    egal(M.WETH, require('./miroir').WETH.toLowerCase(), 'la valeur WETH = le WETH de miroir.js');
    egal(M.USDG, require('./x402').USDG.toLowerCase(), 'la valeur USDG = l USDG de x402.js');
    ok(M.VALEUR.size === 2 && !M.VALEUR.has(SWOGEBET), 'le $SWOGEBET n est pas une valeur hors de l ecosysteme');
    egal(M.TOPIC_MODIFY_V4, require('ethers').utils.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'), 'le sujet ModifyLiquidity v4, recalcule');
  }

  // ================================================== 10. la relecture du 12/10 : chaque constat, l essai qui l aurait attrape
  const sansReleve = (l) => l.filter((m) => !/daily report/.test(m.texte));
  /** Un monde neuf, construit, et un pas d une heure dix entre deux echanges. */
  async function scene(o) {
    const S0 = monde(o && o.monde);
    if (o && o.avant) o.avant(S0.C);
    const I0 = S0.fabrique(o && o.env, o && o.plus);
    const [r0] = await muet(() => I0.tic());
    const pasS = async (transferts, opt) => {
      S0.C.now += (opt && opt.ecart) || 70 * MIN;
      const h = S0.C.tx(S0.C.now - 2 * MIN, transferts, opt);
      const avant = S0.envois.length;
      const [x] = await muet(() => ((opt && opt.inst) || I0).tic());
      return { h, x, msg: sansReleve(S0.envois.slice(avant)) };
    };
    return { W: S0, I: I0, pas: pasS, r0 };
  }
  {
    /* --- RL1 (bloquant) : une construction ratee ne fige JAMAIS la paire hors des piscines --- */
    // un seul 503 sans JSON au 2e lot eth_getCode : reessaye, la construction aboutit
    {
      const { W: X, I: IX, r0 } = await scene({ avant: (C) => { C.panne503 = 1; C.panne503Methode = 'eth_getCode'; C.panne503Saute = 1; } });
      ok(X.C.appels.includes('503'), 'RL1 le 503 a bien ete servi au 2e lot de codes');
      egal(r0.fait, 'construit', 'RL1 un 503 sans JSON : on recule et on redemande, la construction aboutit');
      ok(IX.etat().pools.has(PAIRE) && IX.etat().pools.has(V3), 'RL1 apres un 503 : la paire et la v3 sont des piscines');
      ok(IX.chiffres().horsPools < 90, 'RL1 apres un 503 : la part hors piscines n est pas « 100 % » : ' + IX.chiffres().horsPools);
      ok(IX.etat().compteurs.pannesNoeud >= 1, 'RL1 la panne est comptee');
    }
    // cinq 503 d affilee : la construction echoue PROPREMENT (rien sur le disque), la suivante repart de zero et trouve les piscines
    {
      const S0 = monde();
      S0.C.panne503 = 5; S0.C.panne503Methode = 'eth_getCode'; S0.C.panne503Saute = 1;
      const IX = S0.fabrique();
      const [r1] = await muet(() => IX.tic());
      egal(r1.fait, 'echec', 'RL1 cinq 503 : la construction echoue');
      egal(lit(S0.dossier), null, 'RL1 une construction ratee n ecrit rien (aucun code ni piscine a moitie lus)');
      ok(Object.keys(IX.etat().codes).length === 0 && IX.etat().pools.size === 0, 'RL1 …et ne laisse rien en memoire');
      S0.C.now += 11 * MIN;
      const [r2] = await muet(() => IX.tic());
      egal(r2.fait, 'construit', 'RL1 10 min plus tard : la construction repart de zero et aboutit');
      ok(IX.etat().pools.has(PAIRE) && IX.etat().pools.has(V3) && lit(S0.dossier).pools.includes(PAIRE), 'RL1 la paire est une piscine, sur le disque aussi');
      S0.C.now += 70 * MIN; S0.C.tx(S0.C.now - 2 * MIN, [[PAIRE, N(20), 2e6]]);
      const d = S0.envois.length; await muet(() => IX.tic());
      ok(sansReleve(S0.envois.slice(d)).some((m) => /New holder/.test(m.texte) && m.texte.includes(N(20))), 'RL1 un achat a la paire apres la reprise : annonce');
    }
    // une erreur d ELEMENT sur token0 de la paire (ni adresse, ni revert) : pas de verdict, construction refusee puis reprise
    {
      const S0 = monde();
      S0.C.erreurElement = { to: PAIRE, n: 1 };
      const IX = S0.fabrique();
      const [r1] = await muet(() => IX.tic());
      ok(r1.fait === 'echec' && /sans verdict/.test(r1.erreur), 'RL1 token0 de la paire en panne : construction refusee, jamais « pas une piscine » : ' + JSON.stringify(r1));
      S0.C.now += 11 * MIN;
      const [r2] = await muet(() => IX.tic());
      ok(r2.fait === 'construit' && IX.etat().pools.has(PAIRE), 'RL1 au second essai : la paire est une piscine');
    }
    // la paire du prix qui ne serait pas reconnue (token0/token1 qui « revert ») : construction refusee
    {
      const S0 = monde();
      delete S0.C.tokens[PAIRE];
      const IX = S0.fabrique();
      const [r1] = await muet(() => IX.tic());
      ok(r1.fait === 'echec' && /paire du prix/.test(r1.erreur) && lit(S0.dossier) === null, 'RL1 la paire du prix hors des piscines : on refuse de conclure : ' + JSON.stringify(r1));
    }
    // en regime : un contrat neuf dont token0 tombe en panne reste SANS verdict et est redemande (jamais classe « pas une piscine »)
    {
      const { W: X, I: IX, pas } = await scene();
      const NV = A('c7');
      X.C.codes[NV] = '0x6080604052'; X.C.tokens[NV] = [TOKEN, WETH];
      X.C.erreurElement = { to: NV, n: 1 };
      let r = await pas([[E1, NV, 3e6]], { liquidite: NV });
      ok(!(NV in IX.etat().codes), 'RL1 en regime : token0 en panne, l adresse reste sans verdict');
      X.C.now += MIN; await muet(() => IX.tic());
      ok(IX.etat().pools.has(NV), 'RL1 en regime : redemandee au tic suivant, la nouvelle piscine est reconnue');
      r = await pas([[NV, N(21), 2e6]]);
      ok(r.msg.length === 1 && /New holder/.test(r.msg[0].texte), 'RL1 un achat a cette piscine (SWOGE/WETH) : annonce');
    }

    /* --- RL2 (bloquant) : la liquidite v4 se lit dans le recu, jamais sur tout le PoolManager --- */
    {
      const { W: X, I: IX, pas } = await scene();
      X.C.appels.length = 0;
      let r = await pas([[LP, PM4, 1e6]], { liquidite: PM4 });
      egal(r.msg.length, 0, 'RL2 ajout de liquidite v4 (ModifyLiquidity, le $SWOGE entre au PoolManager) : rien');
      egal(IX.etat().compteurs.liquidite, 1, 'RL2 compte liquidite');
      r = await pas([[PAIRE, N(22), 2e6]], { liquidite: PM4 });
      ok(r.msg.length === 1 && r.msg[0].texte.includes(N(22)), 'RL2 un ModifyLiquidity v4 d un AUTRE pool dans la tx d un achat v2 (le $SWOGE ne touche pas le PoolManager) : l achat est annonce');
      r = await pas([[PM4, N(23), 2e6]], { swapV4: true });
      ok(r.msg.length === 1 && /New holder/.test(r.msg[0].texte) && r.msg[0].texte.includes(N(23)), 'RL2 un achat v4 contre de l ETH natif : New holder');
      ok(!X.C.appels.some((a) => /eth_getLogs:(multi|autre)/.test(a)), 'RL2 en regime : aucune requete de journaux sur le PoolManager ni a plusieurs valeurs');
      egal(X.C.appels.filter((a) => a === 'eth_getTransactionReceipt').length, 3, 'RL2 un recu par echange qui touche une piscine, pas plus');
    }

    /* --- RL3 (important) : une conversion $SWOGE ↔ $SWOGEBET ou jeton du launchpad n est ni paper hand ni achat --- */
    {
      const { W: X, I: IX, pas } = await scene();
      let r = await pas([[U1, V3, 5e6]]);
      egal(r.msg.length, 0, 'RL3 tout son $SWOGE converti en $SWOGEBET : PAS de « Paper hand » (swogebet_achats.js dit deja « New $SWOGEBET buy »)');
      egal(IX.etat().compteurs.genre_conversion, 1, 'RL3 compte conversion');
      const jj = IX.etat().jours[M.jourParis(X.C.now)];
      ok(jj.partis.includes(U1) && !jj.sorties.includes(U1), 'RL3 la conversion : « moved out », jamais « left »');
      r = await pas([[U2, PM4, 2e6]], { autres: [[LANCE, PM4, U2]], swapV4: true });
      egal(r.msg.length, 0, 'RL3 $SWOGE → jeton du launchpad (v4) : une conversion, pas une paper hand');
      r = await pas([[PM4, N(24), 2e6]], { autres: [[LANCE, N(24), PM4]], swapV4: true });
      egal(r.msg.length, 0, 'RL3 jeton du launchpad → $SWOGE (v4) : pas un « New holder »');
      r = await pas([[PM4, N(25), 2e6]], { autres: [[WETH, N(25), PM4]], swapV4: true });
      ok(r.msg.length === 1 && r.msg[0].texte.includes(N(25)), 'RL3 WETH → $SWOGE par le v4 : un achat (WETH est une valeur)');
      egal(IX.etat().compteurs.genre_conversion, 3, 'RL3 trois conversions comptees');
    }

    /* --- RL4 (important) : le grand livre est recoupe avec la chaine ; une derive se repare, rien de faux ne part --- */
    {
      const { W: X, I: IX } = await scene();
      const h0 = Math.floor(X.C.now / H) * H;
      const c0 = IX.chiffres().detenteurs;
      // une replique en retard : la plage qui contient l achat de NX revient vide, SANS erreur
      X.C.now = h0 + 20 * MIN; X.C.tx(X.C.now - 2 * MIN, [[PAIRE, N(26), 2e6]]);
      X.C.oublie = 1;
      await muet(() => IX.tic());
      ok(lit(X.dossier).curseur >= X.C.blocA(X.C.now) - M.CONFIRMATIONS - 1 && IX.chiffres().detenteurs === c0, 'RL4 l achat oublie par la replique : le curseur est passe dessus, le livre ne le connait pas');
      // l echange suivant : le controle voit l ecart, RIEN ne part, le tic est rejoue
      X.C.now += 5 * MIN; X.C.tx(X.C.now - 2 * MIN, [[PAIRE, N(27), 2e6]]);
      const d = X.envois.length;
      const [a] = await muet(() => IX.tic());
      ok(a.fait === 'erreur' && /livre different de la chaine/.test(a.erreur), 'RL4 ecart livre / chaine : le tic s arrete : ' + JSON.stringify(a));
      egal(X.envois.length - d, 0, 'RL4 rien n est publie avec un livre faux');
      X.C.now += MIN;
      const [b] = await muet(() => IX.tic());
      egal(b.fait, 'reconstruction', 'RL4 l ecart persiste au tic suivant : reconstruction depuis la frappe');
      egal(X.envois.length - d, 0, 'RL4 toujours rien de publie');
      X.C.now += MIN;
      const [c] = await muet(() => IX.tic());
      egal(c.fait, 'construit', 'RL4 reconstruit');
      egal(IX.chiffres().detenteurs, c0 + 2, 'RL4 apres reconstruction : les deux acheteurs sont des detenteurs');
      egal(String(IX.etat().soldes.get(PAIRE)), String(X.C.solde(PAIRE, IX.etat().curseur)), 'RL4 apres reconstruction : la paire du livre = balanceOf au curseur');
      egal(IX.etat().compteurs.reconstructions, 1, 'RL4 compte reconstructions');
      ok(IX.etat().compteurs.constructions === 2 && Object.keys(IX.etat().annonces).length === 0 && lit(X.dossier).construit === true, 'RL4 la reconstruction garde les compteurs et n annonce rien');
      X.C.now += 70 * MIN; X.C.tx(X.C.now - 2 * MIN, [[PAIRE, N(28), 2e6]]);
      const d2 = X.envois.length; await muet(() => IX.tic());
      ok(sansReleve(X.envois.slice(d2)).some((m) => m.texte.includes(N(28))), 'RL4 apres la reconstruction : les annonces reprennent');
    }
    // un ecart PASSAGER (une seule lecture fausse) : rien ne part a ce tic, l annonce part une fois au suivant
    {
      const { W: X, I: IX, pas } = await scene();
      const vrai = X.C.solde;
      let ment = 1;
      X.C.solde = (adr, b) => { const s = vrai(adr, b); if (ment > 0 && adr === PAIRE) { ment--; return s + 1n; } return s; };
      const r = await pas([[PAIRE, N(29), 2e6]]);
      ok(r.x.fait === 'erreur' && r.msg.length === 0, 'RL4 ecart passager : rien ne part a ce tic');
      X.C.now += MIN; const d = X.envois.length; await muet(() => IX.tic());
      egal(sansReleve(X.envois.slice(d)).filter((m) => m.texte.includes(N(29))).length, 1, 'RL4 au tic suivant, livre et chaine d accord : l annonce part, une fois');
    }
    // etat ancien illisible (le noeud n est pas une archive) : on ne conclut pas sur une panne, l annonce part
    {
      const { W: X, I: IX } = await scene();
      const vrai = X.C.prendre;
      X.C.prendre = async (u, o) => {
        if (!String(u).includes('dexscreener') && o && o.body && /0x70a08231/.test(o.body)) {
          const corps = JSON.parse(o.body);
          return { ok: true, status: 200, json: async () => corps.map((x) => ({ jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'historical state 4009c3a2 is not available' } })) };
        }
        return vrai(u, o);
      };
      const JX = X.fabrique(null, { prendre: X.C.prendre });
      X.C.now += 70 * MIN; X.C.tx(X.C.now - 2 * MIN, [[PAIRE, N(32), 2e6]]);
      const d = X.envois.length; await muet(() => JX.tic());
      ok(sansReleve(X.envois.slice(d)).some((m) => m.texte.includes(N(32))) && JX.etat().compteurs.controlesIllisibles >= 1, 'RL4 balanceOf illisible : compte, ne bloque pas');
    }
    // au moins une fois par heure, meme sans echange
    {
      const { W: X, I: IX } = await scene();
      const k0 = IX.etat().compteurs.controles || 0;
      X.C.now = Math.floor(X.C.now / H) * H + H + MIN; await muet(() => IX.tic());
      X.C.now += MIN; await muet(() => IX.tic());
      egal((IX.etat().compteurs.controles || 0) - k0, 1, 'RL4 une heure neuve sans echange : un controle, pas un par tic');
    }

    /* --- RL5 a (mineur) : un depot au coffre du casino n est pas un « Left » --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T08:00:00Z' } });
      const r = await pas([[U2, MAISON, 2e6]]);
      egal(r.msg.length, 0, 'RL5 tout deposer au coffre (la maison) : rien d annonce');
      const jj = IX.etat().jours[M.jourParis(X.C.now)];
      ok(jj.partis.includes(U2) && !jj.sorties.includes(U2), 'RL5 le depot : « moved out by transfer », jamais « left »');
      X.C.now = Date.parse('2026-10-11T11:00:30Z'); const d = X.envois.length; await muet(() => IX.tic());
      const rel = X.envois.slice(d).find((m) => /daily report/.test(m.texte));
      ok(rel && /Oct 10 +\d+ \(-1\) +0 +0 /.test(rel.texte) && /· 2 left · \d+ partial sells · 1 in \/ 1 out by transfer/.test(rel.texte),
         'RL5 le releve : -1 detenteur le 10/10 mais 0 « Left » ce jour-la ; sur 7 jours, 2 ventes (U5, U4), 1 envoi recu (LP), 1 depot au coffre : ' + (rel && rel.texte));
      ok(rel && rel.texte.replace(/<[^>]*>/g, '').length < 1024, 'RL5 le releve reste sous 1 024 caracteres : ' + (rel && rel.texte.replace(/<[^>]*>/g, '').length));
    }

    /* --- RL7 (mineur) : un airdrop au-dessus du seuil change le compte, jamais « new today » --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const c0 = IX.chiffres().detenteurs;
      await pas([[E1, N(33), 1500], [E1, N(34), 1500], [E1, N(35), 1500]]);
      egal(IX.chiffres().detenteurs, c0 + 3, 'RL7 airdrop de 1 500 jetons a trois portefeuilles : +3 detenteurs (le compte est honnete)');
      const r = await pas([[PAIRE, N(36), 2e6]], { ecart: 5 * MIN });
      ok(r.msg.length === 1 && /🆕 1 new today/.test(r.msg[0].texte), 'RL7 …mais « new today » ne compte que les ACHETEURS : ' + (r.msg[0] && r.msg[0].texte.split('\n')[2]));
      const jj = IX.etat().jours[M.jourParis(X.C.now)];
      ok([N(33), N(34), N(35)].every((a) => jj.recus.includes(a) && !jj.entrees.includes(a)), 'RL7 les trois : « moved in by transfer »');
    }
  }

  // ================================================== 11. les mutants survivants du 12/10 : une assertion par intention
  {
    const D5 = A('d5').slice(0, 40) + '55';                 // une adresse de poussiere d airdrop (278,294)
    { // C09 : la poussiere d airdrop qui achete est un NEW HOLDER, pas un believer
      const { pas } = await scene();
      const r = await pas([[PAIRE, D5, 2e6]]);
      ok(r.msg.length === 1 && /^🆕 <b>New holder<\/b>\n/.test(r.msg[0].texte) && !/Believer|welcome back/.test(r.msg[0].texte),
         'K01 poussiere d airdrop (278,294) qui achete 2 M : New holder, jamais Believer : ' + JSON.stringify(r.msg.map((m) => m.texte.split('\n')[0])));
    }
    { // C10 : un achat qui reste sous 1 000 n est jamais un New holder, meme quand 500 jetons valent plus de 10 $
      const { W: X, I: IX, pas } = await scene();
      X.C.prix = 0.05;                                       // 500 jetons = 25 $
      const r = await pas([[PAIRE, A('99'), 500]]);
      egal(r.msg.length, 0, 'K02 achat de 500 jetons a 25 $ : poussiere, jamais New holder');
      egal(IX.etat().compteurs.genre_poussiere, 1, 'K02 compte genre_poussiere');
    }
    { // C13 : paper hand = vente qui laisse MOINS de 1 000, pas seulement 0 pile
      const { pas } = await scene();
      const r = await pas([[U1, PAIRE, 5e6 - 500]]);
      ok(r.msg.length === 1 && /^🧻 <b>Paper hand<\/b>/.test(r.msg[0].texte) && r.msg[0].texte.includes(U1),
         'K03 vente qui laisse 500 jetons : Paper hand : ' + JSON.stringify(r.msg.map((m) => m.texte.split('\n')[0])));
    }
    { // C17 : le frais journalise AVANT l acheteur ne vole pas l annonce
      const { pas } = await scene();
      const r = await pas([[PAIRE, AGREG, 1.5e6], [AGREG, FRAIS, 15000], [AGREG, N(2), 1.485e6]]);
      ok(r.msg.length === 1 && r.msg[0].texte.includes(N(2)) && !r.msg[0].texte.includes(FRAIS),
         'K04 frais journalise avant l acheteur : l acheteur est annonce');
    }
    { // C20 : believer sous 25 $ muet
      const { I: IX, pas } = await scene();
      const r = await pas([[PAIRE, U1, 300000]]);            // 300 k x 0,0000458 = 13,7 $
      egal(r.msg.length, 0, 'K05 believer de 13,7 $ (< 25 $) : pas annonce');
      egal(IX.etat().compteurs.sousSeuil_believer, 1, 'K05 compte sousSeuil_believer');
    }
    { // C21 : paper hand sous 25 $ muette
      const { I: IX, pas } = await scene();
      await pas([[PAIRE, N(40), 400000]]);                   // 18,3 $ : New holder (seuil 10 $)
      const r = await pas([[N(40), PAIRE, 400000]]);
      egal(r.msg.length, 0, 'K06 paper hand de 18,3 $ (< 25 $) : pas annoncee');
      egal(IX.etat().compteurs.sousSeuil_paper, 1, 'K06 compte sousSeuil_paper');
    }
    { // C22 : welcome back sous 10 $ muet
      const { I: IX, pas } = await scene();
      const r = await pas([[PAIRE, U4, 100000]]);            // U4 a deja tenu ; 4,58 $
      egal(r.msg.length, 0, 'K07 welcome back de 4,58 $ (< 10 $) : pas annonce');
      egal(IX.etat().compteurs.sousSeuil_retour, 1, 'K07 compte sousSeuil_retour');
    }
    { // C24 : entree, sortie, re-entree en 24 h : UNE annonce d entree (famille « entree »)
      const { I: IX, pas } = await scene();
      const a = await pas([[PAIRE, N(41), 2e6]]), b = await pas([[N(41), PAIRE, 2e6]]), c = await pas([[PAIRE, N(41), 2e6]]);
      ok(a.msg.length === 1 && b.msg.length === 1 && c.msg.length === 0, 'K08 new, paper, re-entree en 24 h : la re-entree se tait : ' + [a, b, c].map((x) => x.msg.length).join(','));
      egal(IX.etat().compteurs.recharge_retour, 1, 'K08 compte recharge_retour');
    }
    { // C65, C66 : l ecart sur 24 h, exact, et tenu en regime (releve horaire)
      const { W: X, I: IX } = await scene();
      X.C.now += 70 * MIN; X.C.tx(X.C.now - 2 * MIN, [[PAIRE, N(42), 2e6]]); await muet(() => IX.tic());   // 6 detenteurs
      for (let k = 0; k < 27; k++) { X.C.now += H; await muet(() => IX.tic()); }
      const avant = X.envois.length;
      X.C.now += 10 * MIN; X.C.tx(X.C.now - 2 * MIN, [[PAIRE, N(43), 2e6]]); await muet(() => IX.tic()); // 7 detenteurs
      const m = sansReleve(X.envois.slice(avant))[0];
      ok(m && /👥 7 holders \(\+1 in 24h\)/.test(m.texte), 'K09 ecart 24 h exact (6 il y a 24 h, 7 maintenant) : ' + (m && m.texte.split('\n')[2]));
    }
    { // C68 : « new today » = personnes DISTINCTES
      const { pas } = await scene();
      await pas([[PAIRE, N(44), 2e6]]); await pas([[N(44), PAIRE, 2e6]]); await pas([[PAIRE, N(44), 2e6]]);
      const r = await pas([[PAIRE, N(45), 2e6]]);
      ok(r.msg.length === 1 && /🆕 2 new today/.test(r.msg[0].texte), 'K10 meme portefeuille entre deux fois le meme jour : compte une fois : ' + (r.msg[0] && r.msg[0].texte.split('\n')[2]));
    }
    { // C36 : apres redemarrage, un ancien detenteur reste « welcome back »
      const { W: X, pas } = await scene();
      const I2 = X.fabrique();
      const r = await pas([[PAIRE, U4, 2e6]], { inst: I2 });
      ok(r.msg.length === 1 && /New holder<\/b> · welcome back/.test(r.msg[0].texte), 'K11 redemarrage : le retour reste « welcome back »');
    }
    { // C37 : la recharge de 24 h survit au redemarrage
      const { W: X, pas } = await scene();
      const a = await pas([[PAIRE, U1, 1e6]]);
      const I2 = X.fabrique();
      const b = await pas([[PAIRE, U1, 1e6]], { inst: I2 });
      ok(a.msg.length === 1 && b.msg.length === 0, 'K12 meme believer, redemarrage entre les deux : une annonce : ' + a.msg.length + ',' + b.msg.length);
      egal(I2.etat().compteurs.recharge_believer, 1, 'K12 compte recharge_believer apres redemarrage');
    }
    { // C50 : l essai d image est sur le disque AVANT que le generateur reponde (un redeploiement en pleine generation compte)
      const X = monde();
      const J = X.fabrique({}, { imageCle: true, genereImage: () => new Promise(() => {}) });
      J.images();
      await new Promise((r) => setImmediate(r));
      let j = null; try { j = JSON.parse(fs.readFileSync(path.join(X.dossier, 'communaute_images', 'journal.json'), 'utf8')); } catch (e) {}
      ok(j && j['nouveau-v1'] && j['nouveau-v1'].essais === 1, 'K13 l essai est compte sur le disque avant la reponse du generateur : ' + JSON.stringify(j));
    }
    { // C53, C54, C55 : chaque genre porte SON image, le releve aussi
      const X = monde({ depart: '2026-10-10T08:00:00Z' });
      const J = X.fabrique({}, { imageCle: true, genereImage: async () => ({ png: PNG, jetons: 6893, controle: 'pattes ok' }) });
      await muet(() => J.images());
      await muet(() => J.tic());
      const suivant = async (tr) => { X.C.now += 70 * MIN; X.C.tx(X.C.now - 2 * MIN, tr); const a = X.envois.length; await muet(() => J.tic()); return sansReleve(X.envois.slice(a))[0]; };
      const b = await suivant([[PAIRE, U1, 1e6]]);
      egal(b && b.photo, 'https://serveur.exemple/communaute/image/believer-v1.png', 'K14 Believer : son image (diamant)');
      const wb = await suivant([[PAIRE, U4, 2e6]]);
      egal(wb && wb.photo, 'https://serveur.exemple/communaute/image/nouveau-v1.png', 'K14 welcome back : l image du New holder');
      X.C.now = Date.parse('2026-10-10T11:00:30Z'); const a = X.envois.length; await muet(() => J.tic());
      const rel = X.envois.slice(a).find((m) => /daily report/.test(m.texte));
      egal(rel && rel.photo, 'https://serveur.exemple/communaute/image/releve-v1.png', 'K14 releve quotidien : son image (tableau de croissance)');
    }
    { // C57 : TG_COMMUNAUTE_HEURE regle l heure du releve
      const X = monde({ depart: '2026-10-10T06:00:00Z' });    // 08:00 a Paris
      const J = X.fabrique({ TG_COMMUNAUTE_HEURE: '9:30' });
      await muet(() => J.tic());
      const nb = () => X.envois.filter((m) => /daily report/.test(m.texte)).length;
      X.C.now = Date.parse('2026-10-10T07:29:00Z'); await muet(() => J.tic());
      egal(nb(), 0, 'K15 09:29 a Paris : pas encore');
      X.C.now = Date.parse('2026-10-10T07:30:30Z'); await muet(() => J.tic());
      egal(nb(), 1, 'K15 TG_COMMUNAUTE_HEURE=9:30 : le releve part a 09:30 Paris');
      X.C.now = Date.parse('2026-10-10T11:00:30Z'); await muet(() => J.tic());
      egal(nb(), 1, 'K15 et pas une seconde fois a 13:00');
    }
    { // C07 : TG_COMMUNAUTE_EXCLUS retire une adresse des detenteurs et des annonces
      const { I: IX, pas } = await scene({ env: { TG_COMMUNAUTE_EXCLUS: U1 } });
      egal(IX.chiffres().detenteurs, 4, 'K16 U1 exclu par la variable : 4 detenteurs au lieu de 5');
      const r = await pas([[PAIRE, U1, 1e6]]);
      egal(r.msg.length, 0, 'K16 un achat d une adresse exclue : jamais annonce');
    }
    { // C73 : une ecriture d etat ratee ne perd pas l annonce
      const { W: X, I: IX } = await scene();
      const r0 = fs.renameSync; let casse = true;
      fs.renameSync = (a, b) => { if (casse && String(b).endsWith('communaute.json')) { casse = false; throw new Error('disque plein'); } return r0(a, b); };
      X.C.now += 70 * MIN; X.C.tx(X.C.now - 2 * MIN, [[PAIRE, N(46), 2e6]]);
      let x;
      try { [x] = await muet(() => IX.tic()); } finally { fs.renameSync = r0; }
      X.C.now += MIN; await muet(() => IX.tic());
      egal(x.fait, 'erreur', 'K17 le tic dont l ecriture rate echoue');
      egal(X.envois.filter((m) => m.texte.includes(N(46))).length, 1, 'K17 apres une ecriture ratee : annonce une fois, pas zero');
      egal(IX.chiffres().detenteurs, 6, 'K17 et le Transfer applique une fois');
    }
    { // C71 : PoolManager v4 VIDE a la construction, alimente ensuite : toujours une piscine
      const C = chaine();
      const j = (s) => Date.parse(s);
      C.tx(M.BLOC_FRAPPE, [[ZERO, TOKEN, 1e9]]);
      C.tx(M.BLOC_FRAPPE + 168, [[TOKEN, PAIRE, 1e9]]);
      C.tx(j('2026-09-20T10:00:00Z'), [[PAIRE, E1, 300e6]]);
      C.now = Date.parse('2026-10-10T08:00:00Z');
      const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'communaute-pm4-'));
      const envois = [];
      const IX = M.cree({ tg: { notify: (t) => envois.push(t), notifyPhoto: (p, t) => envois.push(t) }, prendre: C.prendre, dors: async () => {}, horloge: () => C.now, dossier,
        env: { TG_COMMUNAUTE: '1' }, maison: () => [], publicUrl: 'https://s.ex', explorer: 'https://e.ex', imageCle: false });
      await muet(() => IX.tic());
      C.now += 70 * MIN; C.tx(C.now - 2 * MIN, [[E1, PM4, 5e6]], { liquidite: PM4 }); await muet(() => IX.tic());
      C.now += 70 * MIN; C.tx(C.now - 2 * MIN, [[PM4, N(47), 2e6]], { swapV4: true }); await muet(() => IX.tic());
      ok(IX.etat().pools.has(PM4), 'K18 PM4 apparu apres la construction : reconnu comme piscine');
      ok(envois.filter((t) => !/daily report/.test(t)).some((t) => /New holder/.test(t) && t.includes(N(47))), 'K18 achat via le v4 : annonce');
    }
    { // C43 : cree() sans TG_COMMUNAUTE : le tic lui-meme ne fait rien (defense en profondeur)
      const C = chaine(); let appels = 0;
      const IX = M.cree({ env: { TG_COMMUNAUTE: '' }, prendre: async (...a) => { appels++; return C.prendre(...a); }, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'communaute-v-')), tg: { notify() { appels++; }, notifyPhoto() { appels++; } } });
      const r = await IX.tic();
      ok(r.fait === 'off' && appels === 0, 'K19 cree() eteint : tic = off, 0 requete');
    }
    { // C74 : litImage refuse un nom qui sort du dossier, meme quand le fichier vise EXISTE
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'communaute-route-'));
      fs.mkdirSync(path.join(d, 'communaute_images'), { recursive: true });
      fs.writeFileSync(path.join(d, 'fuite.png'), PNG);
      egal(M.litImage('../fuite', d), null, 'K20 litImage(../fuite) : refuse, le fichier existe pourtant hors du dossier');
    }
  }

  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`communaute.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
