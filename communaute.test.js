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
 *    en cas d echec, adresse envoyee seulement si le fichier existe ;
 *  - depuis la suite du 12/10 (section 12) : le faux noeud sert aussi les
 *    Sync de la paire v2, la jambe WETH et le signataire dans les recus, le
 *    nonce d une tx, les Swap de la v3 WETH/USDG. Le sac avant/apres, le gain
 *    ou la perte en ETH contre le prix d achat moyen (jamais sans les deux
 *    jambes, « unknown » sinon, « break-even » dans ±1 %), les ventes
 *    partielles (25 $ et 10 % du sac, famille a part), « fresh wallet »
 *    (signe, nonce <= 2, jamais vu), les portefeuilles relies (envoi direct
 *    entre personnes, ni carrefour ni maison ni piscine, groupe de 5), le
 *    resume des 24 h et des 7 jours, le cours sur 7 jours en ETH et en $, la
 *    longueur au pire, la reprise et la migration d un etat ancien ;
 *  - section 13 (les trois verifications du 12/10) : poussiere et Transfer de
 *    0 jeton hors des liens, carrefours (poudreur, six vrais envois), maison
 *    cote envoyeur, envoi a soi-meme, exclusion posee apres coup ; achat garde
 *    en partie, achat complete par un envoi, vente melee, frais du vendeur,
 *    deux vendeurs, raison de la vente illisible ; seuils fresh (nonce 3, 0
 *    appel pour un muet) et partielles (7 %, 15 $, image du papier) ; cours
 *    (reference, maintenant, purge, ETH/USD de J−7 illisible, dernier Swap,
 *    semaine calme, arrondi) ; resume en portefeuilles (24 h et 7 jours) ;
 *    migration bornee au curseur (l ecart annonce une fois, l heure gardee,
 *    minuit, jamais plus de 30 min derriere la pointe) ; legende du releve
 *    jamais au-dela de 1 024 signes ;
 *  - section 16 (13/10) : la ligne d entree de la paper hand — achat (meme a
 *    travers un routeur), envoi (le plus gros envoyeur, dans les deux ordres),
 *    achat d origine a un et deux sauts, aller-retour, heure UTC de l en-tete
 *    a la minute (fuseau du processus a UTC+13:45, noeud a 90 ms par bloc),
 *    lien du PASSAGE de 1 000, rien d invente (entree inconnue, ancien format,
 *    frais pris dans l echange d un autre, envoi d un contrat, conversion hors
 *    fenetre, en-tete illisible), schema 3 reconstruit, longueur au pire. Le
 *    faux noeud sait rendre les en-tetes illisibles (C.entetesCasses) ou faux
 *    (C.entetesFaux). Relecture du 13/10 (R4 reecrit, R12 a R18) : un envoi n a
 *    qu un envoyeur (deux nets negatifs : personne n est nomme), l origine dit
 *    quelle part de l envoi l achat lie couvre (« and N more times », « part of
 *    it »), deux sauts seulement pour un sac entier, maison et exclus reverifies
 *    a l annonce, en-tete invraisemblable refuse, lecture courte des en-tetes,
 *    frais dans la vente d un autre, aucun en-tete lu pour une annonce tue.
 */
const assert = require('assert');
/* Le prompt d'un appel images OpenAI : JSON (generations) ou FormData (edits, avec la reference). */
const promptDe = (b) => (b && typeof b.get === 'function' ? String(b.get('prompt') || '') : JSON.parse(b).prompt);
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

const WU = M.PISCINE_ETH_USD;                    // v3 WETH/USDG (le cours de l ETH en $)
const SYNC = M.TOPIC_SYNC, SWAP3 = M.TOPIC_SWAP_V3;
const RELAIS = A('9e');                          // le signataire par defaut : un relais, jamais l acheteur

function chaine(cadence) {
  const CADC = cadence || CAD;                  // la cadence REELLE du faux noeud (le module, lui, suppose 103,54 ms)
  /* prixW : le prix en ETH d un echange a la paire quand l essai ne donne pas sa
     jambe (0,0000458 $ / 2 544 $ = 1,8e-8 ETH) ; ethUsd(bloc) : le cours de
     l ETH lu dans la v3 WETH/USDG */
  const C = { logs: [], recus: {}, codes: {}, tokens: {}, now: 0, appels: [], prix: 0.0000458, mains: false,
              casse: null, refus: 0, vieux: false, images: 0, visions: 0, dex: 0,
              panne503: 0, panne503Methode: null, panne503Saute: 0, erreurElement: null, oublie: 0,
              meta: {}, prixW: 1.8e-8, ethUsd: () => 2500, wuMuet: false, txCasse: false };
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
    /* o.weth : la jambe ETH a la paire (+ entre dans la paire), o.from : le
       signataire, o.nonce : son nonce pour cette tx */
    C.meta[h] = { weth: o && o.weth, from: o && o.from, nonce: o && o.nonce, liqPaire: !!(o && o.liquidite === PAIRE) };
    return h;
  };
  /** La verite du faux noeud sur la paire v2 : un Sync par tx qui la touche
   *  (reserve0 = ETH cumule, reserve1 = $SWOGE de la paire), et la jambe ETH
   *  de chaque tx (C.jambes). Par defaut, une tx sans jambe donnee echange au
   *  prix C.prixW ; une liquidite apporte les deux jetons dans le meme sens. */
  C.syncs = () => {
    const par = new Map();
    for (const l of C.logs) {
      if (!par.has(l.transactionHash)) par.set(l.transactionHash, { h: l.transactionHash, b: parseInt(l.blockNumber, 16), logs: [] });
      par.get(l.transactionHash).logs.push(l);
    }
    const txs = [...par.values()].sort((x, y) => x.b - y.b || (x.h < y.h ? -1 : 1));
    let r0 = 0n, r1 = 0n;
    const out = [];
    C.jambes = {};
    for (const tx of txs) {
      let nP = 0n;
      for (const l of tx.logs) {
        const v = BigInt(l.data);
        if (('0x' + l.topics[1].slice(26)) === PAIRE) nP -= v;
        if (('0x' + l.topics[2].slice(26)) === PAIRE) nP += v;
      }
      const m = C.meta[tx.h] || {};
      if (nP === 0n && m.weth === undefined) continue;
      const w = m.weth !== undefined ? m.weth : (m.liqPaire ? 1 : -1) * Number(nP) / 1e18 * C.prixW;
      const dW = BigInt(Math.round(w * 1e18));
      r0 += dW; r1 += nP;
      C.jambes[tx.h] = dW;
      out.push({ address: PAIRE, topics: [SYNC], data: '0x' + r0.toString(16).padStart(64, '0') + r1.toString(16).padStart(64, '0'),
                 blockNumber: hex(tx.b), transactionHash: tx.h, transactionIndex: '0x0', logIndex: '0x63', blockTimestamp: '0x0', removed: false });
    }
    return out;
  };
  /** Le prix en ETH lu dans le dernier Sync au bloc donne (la verite, pour comparer). */
  C.prixAu = (bloc) => {
    let p = null;
    for (const s of C.syncs()) if (parseInt(s.blockNumber, 16) <= bloc) { const d = s.data.slice(2); p = Number(BigInt('0x' + d.slice(0, 64)) * 10n ** 18n / BigInt('0x' + d.slice(64))) / 1e18; }
    return p;
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
    C.appels.push(m + (m === 'eth_getLogs' ? (multi ? ':multi' : p[0].address !== TOKEN ? ':autre:' + p[0].address + ':' + ((p[0].topics || [])[0] || 'tout') : ':' + parseInt(p[0].fromBlock, 16)) : ''));
    if (C.casse === m) return { __err: 'panne simulee' };
    const tip = blocA(C.now);
    /* C.entetesCasses : les en-tetes des blocs passes sont illisibles (la pointe reste lue) */
    if (m === 'eth_getBlockByNumber' && C.entetesCasses && p[0] !== 'latest') return { __err: 'header not found' };
    /* C.entetesFaux(bloc) : l en-tete que rendrait un noeud fautif (la pointe reste juste) */
    if (m === 'eth_getBlockByNumber' && C.entetesFaux && p[0] !== 'latest') return C.entetesFaux(parseInt(p[0], 16));
    if (m === 'eth_getBlockByNumber') { const b = p[0] === 'latest' ? tip : parseInt(p[0], 16); return { number: hex(b), timestamp: hex(Math.floor(tDe(b) / 1000)) }; }
    if (m === 'eth_getLogs') {
      const f = p[0], de = parseInt(f.fromBlock, 16), a = parseInt(f.toBlock, 16);
      /* la regle du VRAI noeud (sonde du 12/10) : plusieurs valeurs dans une position = 100 000 blocs au plus */
      if (multi && a - de + 1 > 100000) return { __err: `query spans ${a - de + 1} blocks (${de} to ${a}), but only 100000 are allowed for this request; narrow the block range, or send one value per position` };
      if (a - de + 1 > M.FENETRE_LOGS) return { __err: `query spans ${a - de + 1} blocks, but only 10000000 are allowed for this request; narrow the block range` };
      if (f.address === PAIRE && (f.topics || [])[0] === SYNC) return C.syncs().filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= de && b <= a && b <= tip; });
      if (f.address === WU && (f.topics || [])[0] === SWAP3) {
        if (C.wuMuet) return { __err: 'request timed out' };
        if (C.wuVide) return [];                      // aucun Swap dans la fenetre : rien a lire, sans erreur
        const b = Math.min(a, tip);
        if (b < de) return [];
        /* sqrtPriceX96 = sqrt(prix USDG par WETH / 10^12) × 2^96 (WETH 18 decimales, USDG 6) */
        const sq = BigInt(Math.round(Math.sqrt(C.ethUsd(b) / 1e12) * 2 ** 96));
        const w = (x) => x.toString(16).padStart(64, '0');
        /* C.wuDeux(bloc) : un Swap PLUS ANCIEN dans la fenetre, a un autre cours (le dernier fait foi) */
        if (C.wuDeux) {
          const sq0 = BigInt(Math.round(Math.sqrt(C.wuDeux(b) / 1e12) * 2 ** 96));
          return [{ address: WU, topics: [SWAP3, pad(A('99')), pad(A('99'))], data: '0x' + w(0n) + w(0n) + w(sq0) + w(1n) + w(0n), blockNumber: hex(Math.max(de, b - 1)), transactionHash: '0x' + 'e'.repeat(64), logIndex: '0x0', removed: false },
                  { address: WU, topics: [SWAP3, pad(A('99')), pad(A('99'))], data: '0x' + w(0n) + w(0n) + w(sq) + w(1n) + w(0n), blockNumber: hex(b), transactionHash: '0x' + 'f'.repeat(64), logIndex: '0x1', removed: false }];
        }
        return [{ address: WU, topics: [SWAP3, pad(A('99')), pad(A('99'))], data: '0x' + w(0n) + w(0n) + w(sq) + w(1n) + w(0n),
                  blockNumber: hex(b), transactionHash: '0x' + 'f'.repeat(64), logIndex: '0x0', removed: false }];
      }
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
      /* la jambe ETH (Transfer WETH vers ou depuis la paire) et le Sync de la paire, comme sur la vraie chaine */
      const sy = C.syncs().filter((l) => l.transactionHash === p[0]);
      const dW = C.jambes[p[0]], plusW = [];
      if (dW !== undefined && dW !== 0n) {
        const [de, vers] = dW > 0n ? [A('99'), PAIRE] : [PAIRE, A('99')];
        plusW.push({ address: WETH, topics: [M.TOPIC_TRANSFER, pad(de), pad(vers)], data: '0x' + (dW > 0n ? dW : -dW).toString(16).padStart(64, '0'), transactionHash: p[0] });
      }
      const m = C.meta[p[0]] || {};
      return { transactionHash: p[0], status: '0x1', from: m.from || RELAIS, logs: logs.concat(C.recus[p[0]] || [], plusW, sy) };
    }
    if (m === 'eth_getTransactionByHash') {
      if (C.txCasse) return { __err: 'panne simulee' };
      const mm = C.meta[p[0]];
      if (!mm) return null;
      return { hash: p[0], from: mm.from || RELAIS, nonce: hex(mm.nonce !== undefined ? mm.nonce : 7) };
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
    /* /v1/images/edits (image de reference, x_post.js) part en multipart : le prompt se lit dans le FormData. */
    if (u.includes('api.openai.com/v1/images')) { C.images++; C.dernierPrompt = promptDe(opt.body); return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }], usage: { output_tokens: 6893 } }) }; }
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
  C.tx(M.BLOC_FRAPPE + 168, [[TOKEN, PAIRE, 1e9]], { weth: 18 });                  // lancement : 1 G et 18 ETH dans la paire
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

/* ------------------------------------------------------------ le releve, format du 12/10
   Le proprietaire, 12/10, apres le premier releve : « parle pas des 570 wallets
   de l airdrop, juste des reels holders, faut que ca soit positif et simple a
   comprendre ». Ce que le releve montre encore est verifie dans le nouveau
   texte avec les MEMES nombres qu avant ; ce qu il ne dit plus (tableau par
   jour, poussiere, compte brut, premieres fois, sorties, ventes partielles,
   transferts, ETH a cote du $, definition du cours) est verifie absent du
   releve et, quand le module le calcule encore, la ou il vit : les photos et le
   journal des jours (etat), le fil des 24 h (S.evts), chiffres(), la variante
   ETH de la ligne du cours. */
const NOTE_RELEVE = '<i>Holders = wallets with 1,000+ $SWOGE.</i>';
/** Ce que le releve ne dit plus : l airdrop, la poussiere, les traqueurs, les portefeuilles sous 1 000, la colonne « Left ». */
const RETIRES_RELEVE = /airdrop|dust|trackers|wallets under 1,000|\bLeft\b/i;
/** Les entrees de la ligne 📅 : les 7 jours finis, puis maintenant ; null sans ligne. */
const suiteReleve = (t) => { const m = String(t).match(/\n📅 ([^\n]*)/); return m ? m[1].split(' → ') : null; };
/** Les 7 jours d un releve (J−7 … J−1, jours de Paris), comme les compte le module. */
const joursReleve = (now) => { const auj = M.jourParis(now), l = []; for (let k = M.JOURS_RELEVE; k >= 1; k--) l.push(new Date(Date.parse(auj + 'T12:00:00Z') - k * 24 * H).toISOString().slice(0, 10)); return l; };
/** Les adresses d un champ du journal des jours (S.jours) sur les 7 jours du releve. */
const septJournal = (S, now, f) => new Set(joursReleve(now).flatMap((j) => (S.jours[j] && S.jours[j][f]) || []));
/** Les ventes partielles des dernieres 24 h dans le fil (S.evts), la ou le releve les comptait. */
const partielles24h = (S, now) => (S.evts || []).filter(([t, g]) => g === 'partielle' && t >= now - 24 * H && t <= now).length;
/** Meme ensemble, sans ordre. */
const memes = (s, l) => s.size === l.length && l.every((a) => s.has(a));

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
       ni a plusieurs valeurs par position (100 000 blocs au plus) ; la liquidite se lit dans les RECUS.
       Depuis la suite du 12/10 (prix d achat, cours) : AUSSI les Sync de la paire v2 seule, depuis la frappe
       — une adresse, un sujet. Rien d autre. */
    const autres = W.C.appels.filter((a) => /eth_getLogs:autre/.test(a));
    ok(!W.C.appels.some((a) => /eth_getLogs:multi/.test(a)) && autres.every((a) => a === 'eth_getLogs:autre:' + PAIRE + ':' + SYNC),
       'construction : eth_getLogs sur le jeton et sur les Sync de la paire seulement, une valeur par position, jamais le PoolManager : ' + W.C.appels.filter((a) => /getLogs/.test(a)).join(','));
    ok(autres.length >= 1 && W.C.appels.includes('eth_getLogs:' + M.BLOC_FRAPPE), 'construction : les Sync de la paire sont lus (le prix d achat de tout l historique)');
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
    /* 12/10 au soir : la part hors piscines (« outside pools ») est detaillee par piscine, et le $SWOGE de la piscine ETH est dit ;
       l intention demeure : detenteurs, nouveaux du jour et part tenue hors piscines sur chaque annonce */
    ok(/👥 6 holders \(.+ in 24h\) · 🆕 1 new today\n🌊 [\d.]+% held by wallets · pools: [\d.]+% ETH · [\d.]+% \$SWOGEBET\n🛒 [\d.,]+[kMB]? \$SWOGE available to buy in the ETH pools?\n/.test(r.msg[0].texte), 'la ligne de communaute : ' + r.msg[0].texte.split('\n').slice(2, 5).join(' | '));
    ok(r.msg[0].texte.includes('https://explorateur.exemple/tx/' + r.h), 'le lien de la transaction');
    egal(r.msg[0].photo, null, 'pas d image sur le disque : texte seul');
    ok(r.msg[0].fichier && r.msg[0].fichier.annonces[r.h], 'l etat (transaction marquee) est ECRIT avant l envoi');

    const N2 = N(2);
    r = await pas([[PAIRE, AGREG, 1.5e6], [AGREG, N2, 1.485e6], [AGREG, FRAIS, 15000]]);
    egal(r.msg.length, 1, 'achat relaye avec frais : UNE annonce');
    ok(r.msg[0].texte.includes(N2) && !r.msg[0].texte.includes(FRAIS), 'le portefeuille de frais n est jamais pris pour l acheteur');

    /* « now holds » est devenu (12/10, « dire s il rajoute dans son wallet ») : le sac d avant, celui
       d apres, et la hausse — l intention reste : on voit ce qu il tient maintenant */
    r = await pas([[PAIRE, U1, 1e6]]);
    ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && /👜 Added to bag: 5\.0M → <b>6\.0M \$SWOGE<\/b> \(\+20%\)/.test(r.msg[0].texte), 'achat d un detenteur : Believer, sac 5 M → 6 M (+20 %) : ' + (r.msg[0] || {}).texte);

    r = await pas([[U2, ROUTEUR, 2e6], [ROUTEUR, PAIRE, 1.98e6], [ROUTEUR, FRAIS, 20000]]);
    ok(r.msg.length === 1 && /^🧻 <b>Paper hand<\/b>/.test(r.msg[0].texte) && r.msg[0].texte.includes(U2) && /and left/.test(r.msg[0].texte), 'vente totale : Paper hand, le vendeur et non le routeur');

    /* Jusqu au 12/10 une partielle etait muette ; le proprietaire demande « s il lui en reste encore ».
       L intention de l essai demeure : une vente qui laisse >= 1 000 n est JAMAIS une Paper hand. Au-dessus
       du seuil (25 $ et 10 % du sac, sonde du 12/10) elle s annonce « Partial sell … still holds ». */
    r = await pas([[U1, PAIRE, 1e6]]);
    ok(r.msg.length === 1 && /^✂️ <b>Partial sell<\/b>/.test(r.msg[0].texte) && !/Paper hand/.test(r.msg[0].texte) && /17% of the bag · still holds <b>5\.0M<\/b>/.test(r.msg[0].texte),
       'vente partielle (1 M sur 6 M, ~46 $) : « Partial sell », 17 % du sac, still holds 5 M, jamais Paper hand : ' + (r.msg[0] || {}).texte);
    ok(I.etat().compteurs.genre_partielle === 1, 'la vente partielle est comptee');
    r = await pas([[E1, PAIRE, 2e6]]);
    egal(r.msg.length, 0, 'vente partielle de 1 % du sac (2 M sur ~164 M, ~92 $) : sous 10 % du sac, pas annoncee');
    egal(I.etat().compteurs.petitePart_partielle, 1, 'compte petitePart_partielle');

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
    ok(/📈 <b>\$SWOGE community · daily report<\/b>\n👥 <b>5 holders<\/b>/.test(t), 'releve : detenteurs maintenant (5, juste sous le titre) : ' + t.split('\n')[1]);
    /* la part des portefeuilles, puis le detail des piscines par jeton d en face, puis ce qui reste a acheter cote ETH */
    ok(/\n🌊 <b>[\d.]+%<\/b> of supply held by wallets · pools: [\d.]+% ETH · [\d.]+% \$SWOGEBET\n🛒 <b>[\d.,]+[kMB]? \$SWOGE<\/b> available to buy in the ETH pools?\n\n/.test(t),
       'releve : portefeuilles, detail des piscines, reste cote ETH : ' + t.split('\n').filter((l) => /🌊|🛒/.test(l)).join(' | '));
    /* le tableau par jour est devenu la ligne 📅 : les detenteurs de fin de journee des 7 jours, puis maintenant */
    const S7 = J.etat(), suite = suiteReleve(t) || [];
    const jours7 = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    jours7.forEach((j, i) => ok(S7.photos[j] && suite[i] === String(S7.photos[j].detenteurs),
      `releve : le ${j.slice(8)}/10 dans la ligne 📅, a sa place (${i + 1}e), avec sa photo de fin de journee (${S7.photos[j] && S7.photos[j].detenteurs}) : ${suite.join(' → ')}`));
    ok(suite.length === 8 && suite[7] === String(J.chiffres().detenteurs) && suite[7] === '5' && !(S7.photos['2026-10-10'] || {}).t &&
       S7.photos['2026-10-02'] && suite[0] !== String(S7.photos['2026-10-02'].detenteurs),
       'releve : sept jours complets (03/10 → 09/10), ni le 02/10 ni une photo d aujourd hui, puis maintenant (5) : ' + suite.join(' → '));
    ok(Number(suite[5]) - Number(suite[4]) === -1 && S7.photos['2026-10-08'].entrees === 0 && S7.photos['2026-10-08'].sorties === 1,
       'releve : le 08/10, -1 detenteur (ligne 📅) ; 0 entree, 1 sortie dans sa photo, la ou elles vivent : ' + suite.join(' → ') + ' ; ' + JSON.stringify(S7.photos['2026-10-08']));
    /* le bilan des 7 jours, avec les believers depuis le 12/10 (portefeuilles distincts) ; la croissance : la fin du 09/10 contre la fin du 02/10 */
    const croit = S7.photos['2026-10-09'].detenteurs - S7.photos['2026-10-02'].detenteurs;
    ok(new RegExp(`\\n<b>This week</b>\\n👥 <b>${croit > 0 ? '\\+' + croit : croit === 0 ? '±0' : croit}</b> holders · 🆕 \\d+ new · 💎 \\d+ believers?\\n📅 `).test(t),
       'releve : le bilan des 7 jours (' + croit + ' detenteurs) : ' + t);
    ok(!/first-time|\bleft\b|partial sell|by transfer|<pre>/i.test(t) && jours7.every((j) => ['premieres', 'sorties', 'recus', 'partis', 'partielles'].every((f) => typeof S7.photos[j][f] === 'number')),
       'releve : premieres fois, sorties, transferts et ventes partielles ne sont plus dans le releve ; chaque photo des 7 jours les garde');
    /* relecture du 12/10 : « ~540 » et « ~700 » etaient ecrits en dur (les chiffres du 11/10). Ils sont CALCULES :
       le compte brut (tout solde > 0, comme GoPlus) et les personnes sous 1 000 — par chiffres(), plus par le releve. */
    {
      let brut = 0, pouss = 0;
      for (const [a, b] of S7.soldes) {
        if (a === ZERO) continue;
        if (b > 0n) brut++;
        if (b > 0n && b < M.SEUIL_DETENTEUR && S7.codes[a] === 'p') pouss++;
      }
      ok(pouss >= 10 && brut > pouss, `releve : il y a de la poussiere (${pouss}) et un compte brut (${brut}) dans le decor`);
      ok(t.endsWith('\n\n' + NOTE_RELEVE) && /1,000\+ \$SWOGE/.test(t), 'releve : la definition des detenteurs (1,000+ $SWOGE) termine le releve : ' + t.split('\n').pop());
      const c7 = J.chiffres();
      ok(c7.poussiere === pouss && c7.brut === brut, `releve : poussiere et compte brut restent CALCULES, la ou ils vivent (chiffres() : ${c7.poussiere} et ${c7.brut}, attendus ${pouss} et ${brut})`);
      /* 12/10, le proprietaire : « parle pas des 570 wallets de l airdrop, juste des reels holders » — et la poussiere est la, dans le decor */
      const nombreSeul = (n) => new RegExp('(^|[^\\d.,])' + n + '(?![\\d.,%])').test(t.replace(/<[^>]*>/g, ''));
      ok(!nombreSeul(pouss) && !nombreSeul(brut), `releve : ni la poussiere (${pouss}) ni le compte brut (${brut}) n apparaissent, sous aucun mot (verification du 12/10 : « 🫧 N small balances » passait)`);
      ok(!RETIRES_RELEVE.test(t) && !/~540|~700|Not counted|every balance/.test(t) && !t.includes(`${pouss} wallets`) && !t.includes(`show ${brut}`),
         'releve : ni airdrop, ni dust, ni trackers, ni « wallets under 1,000 », ni colonne « Left », ni le compte brut : ' + (t.match(RETIRES_RELEVE) || [''])[0]);
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
    G.C.prendre = async (u, o) => { if (String(u).includes('/v1/images')) prompts.push(promptDe(o.body)); return vrai(u, o); };
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
      /* en regime, le seul eth_getLogs hors du jeton est celui du releve sur la v3 WETH/USDG (cours de l ETH) */
      ok(!X.C.appels.some((a) => /eth_getLogs:multi/.test(a) || a.includes(PM4)) &&
         X.C.appels.filter((a) => /eth_getLogs:autre/.test(a)).every((a) => a === 'eth_getLogs:autre:' + WU + ':' + SWAP3),
         'RL2 en regime : aucune requete de journaux sur le PoolManager ni a plusieurs valeurs : ' + X.C.appels.filter((a) => /eth_getLogs:autre/.test(a)).join(','));
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
      /* le releve du 11/10 : la ligne 📅 porte le -1 du 10/10 (04/10 → 10/10, puis maintenant) ; « Left » et les
         transferts ne sont plus dans le releve : la photo du 10/10 et le journal des 7 jours les gardent */
      const E5 = IX.etat(), suite = suiteReleve(rel && rel.texte) || [];
      const p10 = E5.photos['2026-10-10'] || {};
      ok(rel && suite.length === 8 && suite[6] === String(p10.detenteurs) && Number(suite[6]) - Number(suite[5]) === -1 && p10.entrees === 0 && p10.sorties === 0 && p10.partis === 1,
         'RL5 le releve : -1 detenteur le 10/10 (ligne 📅) mais 0 « Left » ce jour-la (sa photo : 0 entree, 0 sortie, 1 parti) : ' + suite.join(' → ') + ' ; ' + JSON.stringify(p10));
      const now5 = Date.parse('2026-10-11T11:00:30Z');
      ok(memes(septJournal(E5, now5, 'sorties'), [U5, U4]) && memes(septJournal(E5, now5, 'partis'), [U2]) &&
         memes(new Set([...septJournal(E5, now5, 'recus')].filter((a) => a !== MAISON)), [LP]),
         'RL5 sur 7 jours (journal) : 2 ventes (U5, U4), 1 envoi recu (LP, la maison n est pas une personne), 1 depot au coffre (U2)');
      ok(rel && !RETIRES_RELEVE.test(rel.texte) && !/by transfer|partial sell/.test(rel.texte), 'RL5 le releve ne parle ni de « Left » ni de transferts ni de ventes partielles');
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
      C.tx(M.BLOC_FRAPPE + 168, [[TOKEN, PAIRE, 1e9]], { weth: 18 });
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

  // ================================================== 12. la suite du 12/10 : sac, gain/perte, neuf, relies, resume, cours
  {
    const nombre = (s) => Number(String(s).replace(/,/g, ''));
    /* --- S1 gain ou perte contre le prix d achat moyen DE CE portefeuille, en ETH (jamais sans les deux jambes) --- */
    {
      const { W: X, I: IX, pas } = await scene();
      await pas([[PAIRE, N(100), 2e6]], { weth: 0.036 });                 // 1,8e-8 ETH le jeton
      let r = await pas([[N(100), PAIRE, 2e6]], { weth: -0.072 });        // 3,6e-8 : le double
      ok(r.msg.length === 1 && /^🧻 <b>Paper hand<\/b>/.test(r.msg[0].texte) && /💰 Sold in profit: <b>\+100%<\/b> vs\. average buy price, in ETH/.test(r.msg[0].texte),
         'S1 vente au double du prix d achat : « Sold in profit: +100% … in ETH » : ' + (r.msg[0] || {}).texte);
      await pas([[PAIRE, N(101), 4e6]], { weth: 0.072 });
      r = await pas([[N(101), PAIRE, 2e6]], { weth: -0.018 });            // 0,9e-8 : la moitie
      ok(r.msg.length === 1 && /^✂️ <b>Partial sell<\/b>/.test(r.msg[0].texte) && /50% of the bag · still holds <b>2\.0M<\/b>/.test(r.msg[0].texte) && /🔻 Sold at a loss: <b>-50%<\/b>/.test(r.msg[0].texte),
         'S1 vente partielle a moitie prix : 50 % du sac, still holds 2 M, « Sold at a loss: -50% » : ' + (r.msg[0] || {}).texte);
      await pas([[PAIRE, N(102), 2e6]], { weth: 0.036 });
      r = await pas([[N(102), PAIRE, 2e6]], { weth: -0.0361 });           // +0,28 % : sous le bruit des frais
      ok(r.msg.length === 1 && /⚖️ About break-even \(within ±1%\)/.test(r.msg[0].texte) && !/Sold in profit|Sold at a loss/.test(r.msg[0].texte),
         'S1 +0,28 % : « about break-even », jamais un signe dans le bruit des frais : ' + (r.msg[0] || {}).texte);
      await pas([[U2, N(103), 2e6]]);                                     // recu par envoi : cout inconnu
      r = await pas([[N(103), PAIRE, 2e6]]);
      ok(r.msg.length === 1 && /❔ Profit or loss unknown: buy price unknown \(tokens received by transfer or another pool\)/.test(r.msg[0].texte) && !/Sold in|break-even/.test(r.msg[0].texte),
         'S1 sac recu par envoi : « buy price unknown », aucun pourcentage : ' + (r.msg[0] || {}).texte);
      await pas([[PAIRE, N(104), 2e6]], { weth: 0.036 });
      r = await pas([[N(104), PM4, 2e6]], { swapV4: true });              // vendu en ETH natif par le v4 : jambe illisible
      ok(r.msg.length === 1 && /❔ Profit or loss unknown: sale price not readable on-chain/.test(r.msg[0].texte),
         'S1 vente par le PoolManager v4 : prix de vente illisible, dit tel quel : ' + (r.msg[0] || {}).texte);
      await pas([[U3, N(105), 100000]]);                                  // 100 k recus par envoi…
      await pas([[PAIRE, N(105), 2e6]], { weth: 0.036 });                 // …puis 2 M achetes : 95 % du sac a cout connu
      r = await pas([[N(105), PAIRE, 2.1e6]], { weth: -0.0756 });
      ok(r.msg.length === 1 && /buy price unknown/.test(r.msg[0].texte), 'S1 sac a 95 % de cout connu (< 99 %) : inconnu, jamais un % approche : ' + (r.msg[0] || {}).texte);
      await pas([[PAIRE, N(106), 1e6], [PM4, N(106), 1e6]], { weth: 0.018, swapV4: true });   // la moitie par la paire, la moitie par le v4 en ETH natif
      r = await pas([[N(106), PAIRE, 2e6]], { weth: -0.072 });
      ok(r.msg.length === 1 && /buy price unknown/.test(r.msg[0].texte) && !/Sold in profit/.test(r.msg[0].texte),
         'S1 achat partage entre la paire et le v4 : la jambe ETH ne couvre pas tout, cout inconnu (jamais « +100 % » sur la moitie du prix) : ' + (r.msg[0] || {}).texte);
      const c = IX.etat().couts;
      ok(!c[N(100)] && !c[N(102)], 'S1 un portefeuille vide n a plus de ligne de cout');
      ok(c[N(101)] && Math.abs(c[N(101)][0] - 2e6) < 1 && Math.abs(c[N(101)][1] - 0.036) < 1e-9 && c[N(101)][2] === 0, 'S1 apres la partielle : la moitie du sac et la moitie du cout restent : ' + JSON.stringify(c[N(101)]));
    }
    /* --- S2 le cout de l historique vient des Sync (construction) et colle a la jambe des recus (regime) --- */
    {
      /* N(190) achete le 24/09, envoie tout a N(191) le 26/09 et ne tient plus rien : la construction doit
         lire SON code (les deux bouts d un envoi direct), sinon le lien de N(191) disparait */
      const { W: X, I: IX, pas } = await scene({ avant: (C) => {
        C.tx(Date.parse('2026-09-24T10:00:00Z'), [[PAIRE, N(190), 3e6]]);
        C.tx(Date.parse('2026-09-26T10:00:00Z'), [[N(190), N(191), 3e6]]);
        /* N(192) retire de la liquidite v2 le 27/09 (les deux reserves baissent) : ni achat ni prix d achat */
        C.tx(Date.parse('2026-09-27T10:00:00Z'), [[PAIRE, N(192), 4e6]], { liquidite: PAIRE, weth: -0.072 });
      } });
      ok(IX.etat().codes[N(190)] === 'p' && (IX.etat().liens[N(191)] || []).includes(N(190)), 'S2 construction : le code d un bout vide d un envoi direct est lu, le lien existe');
      const rq = await pas([[N(192), PAIRE, 4e6]], { weth: -0.144 });
      ok(rq.msg.length === 1 && /buy price unknown/.test(rq.msg[0].texte), 'S2 jetons sortis d un retrait de liquidite (avant la fenetre des recus, vu par le sens des reserves) : cout inconnu : ' + (rq.msg[0] || {}).texte);
      const rl = await pas([[PAIRE, N(191), 2e6]]);
      ok(rl.msg.length === 1 && /🔗 Linked by direct \$SWOGE transfers: .*\(0\) · <b>5\.0M \$SWOGE<\/b> across 2 wallets/.test(rl.msg[0].texte), 'S2 relie a un portefeuille vide aujourd hui : « (0) », total 5 M : ' + (rl.msg[0] || {}).texte);
      const c = IX.etat().couts;
      ok(c[U1] && c[U1][0] > 0 && c[U1][2] === 0, 'S2 construction : U1 a achete a la paire (routeur) le 03/10, cout connu : ' + JSON.stringify(c[U1]));
      ok(c[LP] && c[LP][0] === 0 && c[LP][2] > 0, 'S2 construction : LP n a recu que par envoi, cout inconnu : ' + JSON.stringify(c[LP]));
      ok(c[E1] && c[E1][0] > 0 && c[E1][2] === 0, 'S2 construction : E1, achat du 20/09 (avant la fenetre des recus), cout connu par les Sync');
      const r = await pas([[U1, PAIRE, 5e6]], { weth: -5e6 * 3.6e-8 });   // U1 a paye 1,8e-8 (jambe par defaut) : revend au double
      ok(r.msg.length === 1 && /Sold in profit: <b>\+100%<\/b>/.test(r.msg[0].texte), 'S2 achat lu dans les Sync, vente lue dans le recu : +100 % : ' + (r.msg[0] || {}).texte);
      ok(!X.C.appels.some((a) => /getLogs:autre:.*/.test(a) && !a.includes(PAIRE) && !a.includes(WU)), 'S2 aucune autre requete de journaux');
    }
    /* --- S3 les portefeuilles relies : un envoi direct entre personnes, jamais un carrefour, la maison, une piscine --- */
    {
      const { W: X, I: IX, pas } = await scene();
      await pas([[U2, N(110), 1e6]]);
      let r = await pas([[PAIRE, N(110), 2e6]]);
      ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && /👜 Added to bag: 1\.0M → <b>3\.0M \$SWOGE<\/b> \(\+200%\)/.test(r.msg[0].texte) &&
         /🔗 Linked by direct \$SWOGE transfers: <a href="[^"]+\/address\/0x0202020202020202020202020202020202020202">0x0202…0202<\/a> \(1\.0M\) · <b>4\.0M \$SWOGE<\/b> across 2 wallets/.test(r.msg[0].texte),
         'S3 achat d un portefeuille alimente par U2 : sac 1 M → 3 M, relie a U2 (1 M), 4 M sur 2 portefeuilles : ' + (r.msg[0] || {}).texte);
      /* l envoi d essai de 1 000 pile vers un portefeuille neuf (3 envois reels sur 164, sonde du 12/10) relie ;
         999 non (SEUIL_LIEN = 1 000, le seul envoi reel plus petit pesait 0,03 jeton) */
      await pas([[U3, N(111), 1000]]);
      r = await pas([[PAIRE, N(111), 2e6]]);
      ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && /🔗 Linked by direct \$SWOGE transfers: .*0x0303…0303.* across 2 wallets \(not proof of a single owner\)/.test(r.msg[0].texte),
         'S3 alimente de 1 000 jetons pile par U3 (envoi d essai ; il tient deja 1 000 : believer) : relie, sans affirmer un meme proprietaire : ' + (r.msg[0] || {}).texte);
      await pas([[U3, N(117), 999]]);
      r = await pas([[PAIRE, N(117), 2e6]]);
      ok(r.msg.length === 1 && /^🆕 <b>New holder<\/b>/.test(r.msg[0].texte) && !/🔗/.test(r.msg[0].texte) && IX.groupe(N(117)).length === 0,
         'S3 alimente de 999 jetons (sous SEUIL_LIEN) : aucun lien : ' + (r.msg[0] || {}).texte);
      await pas([[E1, N(112), 500]]);                                     // E1 a envoye a 14 portefeuilles : un carrefour
      r = await pas([[PAIRE, N(112), 2e6]]);
      ok(r.msg.length === 1 && !/🔗/.test(r.msg[0].texte) && IX.groupe(N(112)).length === 0, 'S3 alimente par un carrefour (degre > 5, l airdrop) : aucun lien affiche : ' + (r.msg[0] || {}).texte);
      await pas([[MAISON, N(113), 500]]);
      r = await pas([[PAIRE, N(113), 2e6]]);
      ok(r.msg.length === 1 && !/🔗/.test(r.msg[0].texte), 'S3 alimente par la maison : aucun lien');
      r = await pas([[PAIRE, N(114), 2e6], [N(114), N(115), 1e6]]);       // achat et envoi dans la MEME tx : une piscine y est
      ok(IX.groupe(N(114)).length === 0 && IX.groupe(N(115)).length === 0, 'S3 un envoi dans une tx qui touche une piscine n est pas un lien');
      r = await pas([[N(110), PAIRE, 3e6]]);
      ok(r.msg.length === 1 && /Paper hand/.test(r.msg[0].texte) && !/🔗/.test(r.msg[0].texte), 'S3 une vente ne porte pas la ligne des relies (demande : « quand il achete »)');
      /* une chaine de 7 portefeuilles : le groupe s arrete a 5 (la taille maximale mesuree), 3 adresses + « +1 more » */
      const P = [140, 141, 142, 143, 144, 145, 146].map(N);
      await pas(P.map((a) => [PAIRE, a, 2000]));                          // alimentes par la piscine : pas de lien
      await pas(P.slice(1).map((a, i) => [a, P[i], 1000]));               // P2 → P1, P3 → P2, … dans une tx sans piscine
      r = await pas([[PAIRE, P[0], 2e6]]);
      ok(r.msg.length === 1 && / \+1 more · <b>[\d.]+[kM]? \$SWOGE<\/b> across 5 wallets/.test(r.msg[0].texte) && IX.groupe(P[0]).length === 4,
         'S3 une chaine de 7 : le groupe s arrete a 5 portefeuilles, 3 adresses montrees + « +1 more » : ' + (r.msg[0] || {}).texte);
      ok(Object.values(IX.etat().liens).every((l) => l.length <= M.DEGRE_MAX + 1), 'S3 aucun portefeuille ne garde plus de DEGRE_MAX + 1 voisins (carrefour)');
      /* une etoile : Q a envoye a cinq portefeuilles (degre 5, pas un carrefour) ; le groupe s arrete quand meme a 5 */
      const Q = N(200), F = [201, 202, 203, 204, 205].map(N);
      await pas([[PAIRE, Q, 6000]]);
      await pas(F.map((a) => [Q, a, 1000]));
      r = await pas([[PAIRE, Q, 2e6]]);
      ok(r.msg.length === 1 && / \+1 more · <b>[\d.]+[kM]? \$SWOGE<\/b> across 5 wallets/.test(r.msg[0].texte) && IX.groupe(Q).length === 4,
         'S3 une etoile de degre 5 : le groupe s arrete a 5 portefeuilles : ' + (r.msg[0] || {}).texte);
      /* le degre ne compte que des PERSONNES (sonde : « voisins personnes distincts ») : un portefeuille relie a U1
         qui depose aussi au coffre de la maison et envoie a cinq contrats n est pas un carrefour */
      await pas([[U1, N(180), 1000]]);
      await pas([[N(180), MAISON, 10], [N(180), MUET, 10], [N(180), ROUTEUR, 10], [N(180), AGREG, 10], [N(180), FAUSSE, 10]]);
      r = await pas([[PAIRE, N(180), 2e6]]);
      ok(r.msg.length === 1 && /🔗 Linked by direct \$SWOGE transfers: .*0x0101…0101/.test(r.msg[0].texte), 'S3 des envois a la maison et a des contrats ne font ni lien ni carrefour : ' + (r.msg[0] || {}).texte);
      ok(!(IX.etat().liens[N(180)] || []).some((a) => [MAISON, MUET, ROUTEUR, AGREG, FAUSSE].includes(a)), 'S3 aucun contrat ni la maison dans les voisins');
    }
    /* --- S4 « Fresh wallet » : signe par l acheteur, nonce <= 2, premiere apparition ; 1 appel, rien dit s il echoue --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const nTx = () => X.C.appels.filter((a) => a === 'eth_getTransactionByHash').length;
      X.C.appels.length = 0;
      let r = await pas([[PAIRE, N(120), 2e6]], { from: N(120), nonce: 0 });
      ok(r.msg.length === 1 && /🐣 Fresh wallet: this buy is its first transaction on this chain/.test(r.msg[0].texte), 'S4 nonce 0, signe par l acheteur, jamais vu : Fresh wallet : ' + (r.msg[0] || {}).texte);
      r = await pas([[PAIRE, N(121), 2e6]], { from: N(121), nonce: 2 });
      ok(r.msg.length === 1 && /🐣 Fresh wallet: only 2 transactions on this chain before this buy/.test(r.msg[0].texte), 'S4 nonce 2 : encore neuf (coupure mesuree entre 2 et 6)');
      r = await pas([[PAIRE, N(122), 2e6]], { from: N(122), nonce: 6 });
      ok(r.msg.length === 1 && !/Fresh/.test(r.msg[0].texte), 'S4 nonce 6 : pas neuf');
      const avantRelais = nTx();
      r = await pas([[PAIRE, N(123), 2e6]], { nonce: 0 });                // achat RELAYE : le nonce ne dit rien
      ok(r.msg.length === 1 && !/Fresh/.test(r.msg[0].texte) && nTx() === avantRelais, 'S4 achat relaye (signataire = un relais) : jamais « fresh », aucun appel');
      const D5 = A('d5').slice(0, 40) + '55';                             // poussiere d airdrop : deja vue sur le $SWOGE
      r = await pas([[PAIRE, D5, 2e6]], { from: D5, nonce: 0 });
      ok(r.msg.length === 1 && /New holder/.test(r.msg[0].texte) && !/Fresh/.test(r.msg[0].texte), 'S4 nonce 0 mais deja passe par le $SWOGE (airdrop) : pas « fresh »');
      r = await pas([[PAIRE, U4, 2e6]], { from: U4, nonce: 0 });
      ok(r.msg.length === 1 && /welcome back/.test(r.msg[0].texte) && !/Fresh/.test(r.msg[0].texte), 'S4 un retour n est jamais « fresh »');
      X.C.txCasse = true;
      r = await pas([[PAIRE, N(124), 2e6]], { from: N(124), nonce: 0 });
      X.C.txCasse = false;
      ok(r.msg.length === 1 && /New holder/.test(r.msg[0].texte) && !/Fresh/.test(r.msg[0].texte) && IX.etat().compteurs.noncesIllisibles === 1,
         'S4 nonce illisible : l annonce part, sans rien affirmer, et c est compte');
      egal(nTx(), 4, 'S4 un eth_getTransactionByHash par candidat annonce (signe et jamais vu), pas plus');
    }
    /* --- S5 le resume quotidien : 24 h, 7 jours, cours sur 7 jours, une seule publication --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T08:00:00Z' } });
      X.C.ethUsd = (b) => (b <= X.C.blocA(Date.parse('2026-10-06T00:00:00Z')) ? 2700 : 2540);
      await pas([[PAIRE, N(130), 2e6]], { ecart: 20 * MIN });
      await pas([[PAIRE, U1, 1e6]], { ecart: 20 * MIN });
      await pas([[U2, PAIRE, 2e6]], { ecart: 20 * MIN });
      await pas([[U3, PAIRE, 1e6]], { ecart: 20 * MIN });
      await pas([[PAIRE, U1, 1e6]], { ecart: 20 * MIN });                 // le meme believer : un portefeuille
      X.C.now = Date.parse('2026-10-10T11:00:30Z');
      const d0 = X.envois.length; await muet(() => IX.tic());
      const rel = X.envois.slice(d0).filter((m) => /daily report/.test(m.texte));
      egal(rel.length, 1, 'S5 13:00 : UNE publication (le resume tient dans le releve)');
      const t = (rel[0] || {}).texte || '';
      ok(/\n<b>Last 24h<\/b>\n🆕 1 new holder · 💎 1 believer · 🧻 1 paper hand\n/.test(t), 'S5 dernieres 24 h : portefeuilles distincts (U1 a achete deux fois) : ' + t);
      /* la vente partielle n est plus dans le releve : elle est annoncee seule, et le fil des 24 h la garde */
      ok(!/partial sell/i.test(t) && partielles24h(IX.etat(), X.C.now) === 1, 'S5 dernieres 24 h : 1 vente partielle (U3), dans le fil des 24 h, plus dans le releve');
      /* le $ seul quand il se lit (12/10 : simple a comprendre) ; l ETH vit dans la variante ETH de la ligne (coursEth, sans cours passe) */
      const m = t.match(/📊 Chart: <b>([+-][\d.,]+)%<\/b> this week\n/);
      const now = X.C.now, cur = IX.etat().curseur;
      const me = IX.texteReleve(now).match(/📊 Chart: <b>([+-][\d.,]+)%<\/b> this week \(in ETH\)\n/);
      const p1 = X.C.prixAu(cur), p0 = X.C.prixAu(X.C.blocA(now - 7 * 24 * H));
      const eth = 100 * (p1 / p0 - 1), usd = 100 * (p1 * 2540 / (p0 * 2700) - 1);
      ok(m && me && !/in ETH/.test(t) && Math.abs(nombre(me[1]) - eth) < 0.6 && Math.abs(nombre(m[1]) - usd) < 0.6,
         `S5 le cours : dernier Sync contre le dernier Sync d avant −168 h, en ETH (${eth.toFixed(2)}), × ETH/USD de la v3 (${usd.toFixed(2)} en $) : ` + (m ? m[0] : t) + ' | ' + (me ? me[0] : ''));
      ok(t.replace(/<[^>]*>/g, '').length < 1024, 'S5 sous 1 024 signes : ' + t.replace(/<[^>]*>/g, '').length);
      ok(X.C.appels.filter((a) => a === 'eth_getLogs:autre:' + WU + ':' + SWAP3).length === 2, 'S5 deux lectures de l ETH/USD (maintenant, il y a 7 jours)');
      /* le lendemain : les 24 h sont vides, les 7 jours portent le 10/10 */
      X.C.now = Date.parse('2026-10-11T11:00:30Z');
      const d1 = X.envois.length; await muet(() => IX.tic());
      const t2 = (X.envois.slice(d1).find((x) => /daily report/.test(x.texte)) || {}).texte || '';
      ok(/\n<b>Last 24h<\/b>\n🆕 0 new holders · 💎 0 believers · 🧻 0 paper hands\n/.test(t2) && partielles24h(IX.etat(), X.C.now) === 0 && / · 💎 1 believer\n📅 /.test(t2),
         'S5 le lendemain : 24 h vides (0 partielle au fil) ; 7 jours : 1 believer (distinct) : ' + t2);
      {
        const S = IX.etat(), parts = joursReleve(X.C.now).reduce((n, j) => n + ((S.photos[j] || {}).partielles || 0), 0);
        ok(memes(septJournal(S, X.C.now, 'sorties'), [U5, U4, U2]) && parts === 1 && !/\bleft\b|partial sell/i.test(t2),
           'S5 le lendemain, sur 7 jours : 3 sorties (U5, U4, U2) au journal, 1 partielle aux photos, ni l une ni l autre dans le releve : ' + parts);
      }
      /* sans ETH/USD lisible : le % en ETH seul, et c est compte */
      X.C.wuMuet = true;
      X.C.now = Date.parse('2026-10-12T11:00:30Z');
      const d2 = X.envois.length; await muet(() => IX.tic());
      const t3 = (X.envois.slice(d2).find((x) => /daily report/.test(x.texte)) || {}).texte || '';
      ok(/📊 Chart: <b>[+-][\d.,]+%<\/b> this week \(in ETH\)\n/.test(t3) && !/this week\n/.test(t3) && IX.etat().compteurs.ethUsdIllisible >= 1,
         'S5 v3 WETH/USDG muette : le cours en ETH seul, jamais un $ invente : ' + t3.split('\n')[2]);
      /* aucun Swap dans la fenetre (reponse vide, sans erreur), puis un cours absurde : jamais un « NaN % » ni un $ faux */
      X.C.wuMuet = false; X.C.wuVide = true;
      X.C.now = Date.parse('2026-10-13T11:00:30Z');
      const d3 = X.envois.length; await muet(() => IX.tic());
      const t4 = (X.envois.slice(d3).find((x) => /daily report/.test(x.texte)) || {}).texte || '';
      ok(/📊 Chart: <b>[+-][\d.,]+%<\/b> this week \(in ETH\)\n/.test(t4) && !/NaN|this week\n/.test(t4), 'S5 aucun Swap dans la fenetre : le cours en ETH seul : ' + t4.split('\n')[2]);
      X.C.wuVide = false; X.C.ethUsd = () => 3;      // 3 $ l ETH : hors de la garde de vraisemblance
      X.C.now = Date.parse('2026-10-14T11:00:30Z');
      const d4 = X.envois.length; await muet(() => IX.tic());
      const t5 = (X.envois.slice(d4).find((x) => /daily report/.test(x.texte)) || {}).texte || '';
      ok(/📊 Chart: <b>[+-][\d.,]+%<\/b> this week \(in ETH\)\n/.test(t5) && !/this week\n/.test(t5), 'S5 un ETH/USD absurde (3 $) n est pas lu : ETH seul : ' + t5.split('\n')[2]);
      /* sans Sync d avant −168 h : pas de ligne */
      IX.etat().coursW = [[now, 1e-8]];
      ok(!/📊 Chart/.test(IX.texteReleve(Date.parse('2026-10-12T11:00:30Z'))), 'S5 aucune reference a −168 h : aucune ligne de cours');
    }
    /* --- S6 la longueur au pire : chiffres a 3 chiffres partout (production : 121 detenteurs, 541 sous 1 000, 713 au compte brut) --- */
    {
      const { W: X, I: IX } = await scene();
      const S = IX.etat(), now = X.C.now;
      const adr = (p, i) => '0x' + p + String(i).padStart(39, '0');
      for (let i = 0; i < 994; i++) { S.soldes.set(adr('a', i), 2000n * 10n ** 18n); S.codes[adr('a', i)] = 'p'; }   // 999 detenteurs avec ceux du decor
      for (let i = 0; i < 9999; i++) { S.soldes.set(adr('b', i), 278n * 10n ** 18n); S.codes[adr('b', i)] = 'p'; }
      const auj = M.jourParis(now);
      for (let k = 1; k <= 8; k++) {
        const j = new Date(Date.parse(auj + 'T12:00:00Z') - k * 24 * H).toISOString().slice(0, 10);
        /* 142 par jour : 994 sur 7 jours, trois chiffres partout */
        S.photos[j] = { detenteurs: 999, horsPools: 66.5, entrees: 142, premieres: 142, sorties: 142, recus: 142, partis: 142, believers: 142, partielles: 142, t: now };
        delete S.jours[j];
      }
      S.horaires = [{ t: now - 24 * H, n: 900 }];
      S.evts = [];
      for (let i = 0; i < 994; i++) for (const g of ['nouveau', 'believer', 'paper', 'partielle']) S.evts.push([now - H, g, adr('a', i)]);
      /* les piscines au pire : trois familles a deux chiffres (ETH, $SWOGEBET, autre) et le reste cote ETH
         au format le plus long de fmtJetons (« 99.9M ») ; production le 12/10 : 20.6 % ETH, 11.8 % $SWOGEBET */
      const e18 = 10n ** 18n;
      for (const [a, v] of [[PAIRE, 60e6], [V3W, 39.9e6], [V3, 118e6], [PM4, 100e6]]) S.soldes.set(a, BigInt(v) * e18);
      ok([PAIRE, V3W, V3, PM4].every((a) => S.pools.has(a)), 'S6 les quatre piscines du pire sont bien des piscines');
      const t = IX.texteReleve(now, { eth: -12.34, usd: 1234.5, p0: 1, p1: 1 });
      const n0 = t.replace(/<[^>]*>/g, '').length;
      ok(n0 < 1024, 'S6 au pire (999 detenteurs, 994 par case sur 7 jours, 9 999 sous 1 000, ~11 000 au compte brut, +1 234 % en $) : sous 1 024 signes : ' + n0);
      /* tout ce que le releve montre encore, avec les memes nombres ; l ETH (-12 %) dans la variante ETH de la ligne ;
         premieres fois, sorties, partielles et transferts (994 chacun) ne sont plus dans le releve */
      const tEth = IX.texteReleve(now, { eth: -12.34, usd: null, p0: 1, p1: 1 });
      ok(/👥 <b>999 holders<\/b> \(\+99 in 24h\)\n📊 Chart: <b>\+1,235%<\/b> this week\n🌊 <b>[\d.]+%<\/b> of supply held by wallets · pools: [\d.]+% ETH · [\d.]+% \$SWOGEBET · [\d.]+% other\n🛒 <b>[\d.,]+[kMB]? \$SWOGE<\/b> available to buy in the ETH pools?\n\n/.test(t) &&
         /📊 Chart: <b>-12%<\/b> this week \(in ETH\)\n/.test(tEth) &&
         /\n<b>Last 24h<\/b>\n🆕 994 new holders · 💎 994 believers · 🧻 994 paper hands\n/.test(t) &&
         /\n<b>This week<\/b>\n👥 <b>±0<\/b> holders · 🆕 994 new · 💎 994 believers\n📅 999 → 999 → 999 → 999 → 999 → 999 → 999 → 999\n/.test(t) &&
         t.endsWith('\n\n' + NOTE_RELEVE) && !/first-time|\bleft\b|partial sell|by transfer/i.test(t),
         'S6 le texte au pire est complet, note comprise : ' + t.split('\n').filter((l) => /Chart|🆕|📅/.test(l)).join(' | ') + ' | ' + tEth.split('\n')[2]);
      /* une photo d avant le 12/10 (sans believers) et sans journal : « – », jamais 0 */
      for (const j of Object.keys(S.photos)) delete S.photos[j].believers;
      ok(/ · 💎 – believers\n📅 /.test(IX.texteReleve(now)), 'S6 photos sans believers (avant le 12/10) : « – believers », jamais 0');
    }
    /* --- S7 reprise : couts, liens, vus, cours et fil des 24 h survivent au redemarrage --- */
    {
      const { W: X, I: IX, pas } = await scene();
      await pas([[U2, N(150), 1e6]]);
      await pas([[PAIRE, N(150), 2e6]], { weth: 0.036 });
      const a = IX.etat();
      const cles = ['couts', 'liens', 'coursW', 'evts', 'schema'];
      const I2 = X.fabrique();
      X.C.now += MIN; await muet(() => I2.tic());
      const b = I2.etat();
      ok(cles.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) && a.vus.size === b.vus.size && [...a.vus].every((x) => b.vus.has(x)),
         'S7 apres redemarrage : ' + cles.join(', ') + ' et vus identiques');
      ok(Object.keys(b.couts).length > 5 && b.liens[N(150)] && b.coursW.length > 1 && b.evts.length > 1 && b.schema === M.SCHEMA, 'S7 et non vides');
      const r = await pas([[N(150), PAIRE, 3e6]], { weth: -0.054, inst: I2 });
      ok(r.msg.length === 1 && /❔ Profit or loss unknown: buy price unknown/.test(r.msg[0].texte), 'S7 apres redemarrage, le cout (1 M recu par envoi, 2 M achetes : 67 % connu) est relu : inconnu : ' + (r.msg[0] || {}).texte);
    }
    /* --- S8 migration : un etat d avant le 12/10 est reconstruit UNE fois, sans rien re-dire --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T08:00:00Z' } });
      await pas([[PAIRE, N(160), 2e6]]);
      X.C.now = Date.parse('2026-10-10T11:00:30Z'); await muet(() => IX.tic());   // le releve du jour est parti
      const f = lit(X.dossier);
      for (const k of ['schema', 'couts', 'liens', 'vus', 'coursW', 'evts']) delete f[k];
      fs.writeFileSync(path.join(X.dossier, 'communaute.json'), JSON.stringify(f));
      const d = X.envois.length;
      const I2 = X.fabrique();
      X.C.now += 30 * MIN;
      const [r] = await muet(() => I2.tic());
      const s = I2.etat();
      ok(r.fait === 'construit' && s.schema === M.SCHEMA && s.compteurs.migrations === 1, 'S8 etat sans schema : reconstruit une fois : ' + JSON.stringify(r).slice(0, 80));
      ok(Object.keys(s.couts).length > 5 && s.coursW.length > 1 && s.evts.some((e) => e[2] === N(160)), 'S8 couts, cours et fil des 24 h reconstruits depuis la chaine');
      ok(s.releves['2026-10-10'] && Object.keys(s.annonces).length === Object.keys(f.annonces).length && JSON.stringify(s.dernier) === JSON.stringify(f.dernier),
         'S8 ce qui a ete dit est garde : releve du jour, annonces, recharges');
      X.C.now += MIN; await muet(() => I2.tic());
      egal(X.envois.length - d, 0, 'S8 rien n est re-annonce, pas de second releve le meme jour');
      const [r2] = await muet(() => X.fabrique().tic());
      ok(r2.fait !== 'construit' && lit(X.dossier).schema === M.SCHEMA, 'S8 au redemarrage suivant : pas de seconde reconstruction');
      const p = await pas([[PAIRE, N(161), 2e6]]);
      ok(p.msg.length === 1 && p.msg[0].texte.includes(N(161)), 'S8 apres la migration : les annonces reprennent');
    }
    /* --- S9 famille a part : une partielle ne fait pas taire la sortie totale qui suit ; le groupe compte les partielles --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const a = await pas([[U3, PAIRE, 1e6]]);
      const b = await pas([[U3, PAIRE, 2e6]], { ecart: 2 * MIN });
      ok(a.msg.length === 1 && /Partial sell/.test(a.msg[0].texte) && b.msg.length === 1 && /Paper hand/.test(b.msg[0].texte),
         'S9 partielle puis sortie totale deux minutes plus tard (0x1d4342, 07/10) : les deux sont dites');
      const h0 = Math.floor(X.C.now / H) * H + H;
      X.C.now = h0 + 5 * MIN;
      for (let i = 0; i < 4; i++) X.C.tx(X.C.now - (30 - i) * 1000, [[PAIRE, N(170 + i), 2e6]]);
      X.C.tx(X.C.now - 20 * 1000, [[U1, PAIRE, 2e6]]);                   // la 5e de l heure : une partielle (40 % du sac)
      await muet(() => IX.tic());
      X.C.now = h0 + H + MIN;
      const d = X.envois.length; await muet(() => IX.tic());
      const g = sansReleve(X.envois.slice(d));
      ok(g.length === 1 && /📊 <b>\+1 more in the last hour<\/b>\n1 partial sell\n/.test(g[0].texte), 'S9 le message groupe nomme les partielles : ' + (g[0] || {}).texte);
    }
    /* --- S10 les constantes : sujets recalcules, piscine ETH/USD ordonnee comme le dit la sonde --- */
    {
      const id = require('ethers').utils.id;
      egal(M.TOPIC_SYNC, id('Sync(uint112,uint112)'), 'S10 le sujet Sync v2, recalcule');
      egal(M.TOPIC_SWAP_V3, id('Swap(address,address,int256,int256,uint160,uint128,int24)'), 'S10 le sujet Swap v3, recalcule');
      ok(M.WETH < M.USDG, 'S10 v3 WETH/USDG : token0 = WETH (tri des adresses), le prix lu est des USDG par WETH');
      ok(M.WETH < TOKEN, 'S10 paire v2 : token0 = WETH, reserve0 / reserve1 = prix en ETH');
    }
  }

  // ================================================== 13. les trois verifications du 12/10 : chaque constat, l essai qui l aurait attrape
  {
    const releveDe = (X, d) => (X.envois.slice(d).find((m) => /daily report/.test(m.texte)) || {}).texte || '';
    /* le % tel que le module l ecrit (pct) : une decimale sous 10 %, entier au-dela */
    const pctT = (x) => { const a = Math.abs(x), s = a < 10 ? a.toFixed(1) : Math.round(a).toLocaleString('en-US'); return (x < 0 && s !== '0.0' ? '-' : '+') + s + '%'; };
    const visibleT = (t) => t.replace(/<[^>]*>/g, '').length;
    const voisins = (IX, a) => (IX.etat().liens[a] || []).map((x) => x.replace(/^~/, ''));
    /* --- T1 liens : 0 jeton, poussiere d un tiers, poudreur-carrefour, maison cote envoyeur, acheteur carrefour, envoi a soi-meme --- */
    {
      const { W: X, I: IX, pas } = await scene();
      await pas([[PAIRE, N(116), 2e6]]);
      await pas([[U2, N(116), 0]]);                                        // un Transfer de 0 jeton : faisable SANS la signature de l envoyeur
      ok(!IX.etat().liens[N(116)] && !voisins(IX, U2).includes(N(116)), 'T1 un Transfer de 0 jeton ne compte ni comme lien ni pour le degre : ' + JSON.stringify(IX.etat().liens[N(116)]));
      let r = await pas([[PAIRE, N(116), 2e6]]);
      ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && !/🔗/.test(r.msg[0].texte), 'T1 apres un Transfer de 0 jeton : aucune ligne de relies : ' + (r.msg[0] || {}).texte);
      /* la poussiere d un tiers (mutation du 12/10 : 0,000001 $SWOGE suffisait a entrer dans la ligne 🔗 et le total) */
      await pas([[PAIRE, N(141), 2e6]]);
      await pas([[U2, N(141), 0.000001]]);
      await pas([[PAIRE, N(142), 2e6]]);
      await pas([[U2, N(142), 0.000001]]);
      r = await pas([[PAIRE, N(142), 2e6]]);
      ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && !/🔗/.test(r.msg[0].texte) && IX.groupe(N(142)).length === 0 && IX.groupe(N(141)).length === 0,
         'T1 un tiers qui envoie 0,000001 $SWOGE a deux acheteurs : ni dans leur ligne, ni dans leur total, ni ne les relie entre eux : ' + (r.msg[0] || {}).texte);
      ok((IX.etat().liens[N(142)] || []).includes('~' + U2), 'T1 la poussiere compte pour le DEGRE (« ~ ») : ' + JSON.stringify(IX.etat().liens[N(142)]));
      /* de la poussiere PUIS un vrai envoi entre les memes deux portefeuilles : le vrai envoi relie */
      await pas([[U2, N(188), 0.000001]]);
      await pas([[U2, N(188), 1e6]]);
      r = await pas([[PAIRE, N(188), 2e6]]);
      ok(r.msg.length === 1 && /🔗 Linked by direct \$SWOGE transfers: .*0x0202…0202/.test(r.msg[0].texte) && (IX.etat().liens[N(188)] || []).includes(U2),
         'T1 poussiere puis 1 M du meme envoyeur : le lien existe (la poussiere ne le bloque pas) : ' + (r.msg[0] || {}).texte);
      /* un poudreur qui vise six adresses devient un carrefour : meme son vrai envoi ne relie plus */
      const D = A('d6'), cibles = [181, 182, 183, 184, 185, 186].map(N);
      await pas([[PAIRE, D, 1e6]]);
      await pas(cibles.map((a) => [D, a, 0.000001]));
      await pas([[D, N(187), 5000]]);
      r = await pas([[PAIRE, N(187), 2e6]]);
      ok(r.msg.length === 1 && !/🔗/.test(r.msg[0].texte) && IX.groupe(N(187)).length === 0 && (IX.etat().liens[D] || []).length === M.DEGRE_MAX + 1,
         'T1 un poudreur de 6 adresses est un carrefour : son envoi de 5 000 ne relie pas : ' + JSON.stringify(IX.etat().liens[D]));
      /* la maison COTE ENVOYEUR : rien de stocke, ni chez le receveur ni chez elle */
      await pas([[MAISON, N(113), 1500]]);
      ok(!voisins(IX, N(113)).includes(MAISON) && !IX.etat().liens[MAISON], 'T1 un envoi de la maison n est stocke ni chez le receveur ni chez la maison');
      /* un acheteur CARREFOUR (E1 : 10 voisins par l airdrop de l histoire) qui ajoute 1 % a son sac (92 $) : annonce, sans relies */
      r = await pas([[PAIRE, E1, 2e6]]);
      ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && !/🔗/.test(r.msg[0].texte) && IX.groupe(E1).length === 0,
         'T1 un carrefour qui achete 1 % de son sac : annonce (le seuil de part ne vaut que pour les partielles), sans relies : ' + (r.msg[0] || {}).texte);
      /* un carrefour aux six VRAIS envois (>= 1 000) qui achete : aucune ligne de relies (ses voisins, eux, ne sont pas des carrefours) */
      const Hc = A('d7'), six = [191, 192, 193, 194, 195, 196].map(N);
      await pas([[PAIRE, Hc, 1e6]]);
      await pas(six.map((a) => [Hc, a, 1000]));
      r = await pas([[PAIRE, Hc, 2e6]]);
      ok(r.msg.length === 1 && /^💎 <b>Believer<\/b>/.test(r.msg[0].texte) && !/🔗/.test(r.msg[0].texte) && IX.groupe(Hc).length === 0 && IX.groupe(six[0]).length === 0,
         'T1 un carrefour de six vrais envois qui achete : sans relies, et il ne relie pas ses six receveurs entre eux : ' + (r.msg[0] || {}).texte);
      /* un envoi a soi-meme n est pas un voisin : une etoile de degre 5 reste une etoile */
      const Q = N(210), F = [211, 212, 213, 214, 215].map(N);
      await pas([[PAIRE, Q, 6000]]);
      await pas(F.map((a) => [Q, a, 1000]));
      await pas([[Q, Q, 100]]);
      ok(IX.groupe(Q).length === 4 && !voisins(IX, Q).includes(Q), 'T1 un envoi a soi-meme ne compte pas dans le degre : ' + JSON.stringify(IX.etat().liens[Q]));
    }
    /* --- T2 une exclusion posee APRES le lien (TG_COMMUNAUTE_EXCLUS, le cas de 0x49ee…) : plus jamais montree --- */
    {
      const { W: X, I: IX, pas } = await scene();
      await pas([[U2, N(110), 1e6]]);
      const I2 = X.fabrique({ TG_COMMUNAUTE_EXCLUS: U2 });
      const r = await pas([[PAIRE, N(110), 2e6]], { inst: I2 });
      ok(r.msg.length === 1 && !/🔗/.test(r.msg[0].texte) && I2.groupe(N(110)).length === 0, 'T2 U2 exclu apres coup : plus montre comme relie : ' + (r.msg[0] || {}).texte);
    }
    /* --- T3 le prix d achat : achat garde en partie, achat complete par un envoi, vente melee, frais du vendeur, plusieurs piscines, part connue --- */
    {
      const { W: X, I: IX, pas } = await scene();
      /* l acheteur garde la moitie, l autre moitie part dans la meme tx (mutation du 12/10 : -50 % pour une revente au meme prix) */
      await pas([[PAIRE, N(150), 2e6], [N(150), N(151), 1e6]], { weth: 0.036 });
      const c150 = IX.etat().couts[N(150)], c151 = IX.etat().couts[N(151)];
      ok(c150 && Math.abs(c150[0] - 1e6) < 1 && Math.abs(c150[1] - 0.018) < 1e-9 && c150[2] === 0, 'T3 achat garde a moitie : 1 M a 0,018 ETH (sa part de la jambe), jamais 0,036 : ' + JSON.stringify(c150));
      ok(c151 && c151[0] === 0 && Math.abs(c151[2] - 1e6) < 1, 'T3 le receveur d un envoi dans la tx d achat : cout inconnu : ' + JSON.stringify(c151));
      let r = await pas([[N(150), PAIRE, 1e6]], { weth: -0.018 });
      ok(r.msg.length === 1 && /⚖️ About break-even/.test(r.msg[0].texte), 'T3 revente au meme prix : « about break-even », jamais « -50% » : ' + (r.msg[0] || {}).texte);
      /* l acheteur recoit plus que le flux (un envoi dans la meme tx) : le surplus est a cout inconnu */
      await pas([[PAIRE, N(152), 1e6], [U2, N(152), 1e6]], { weth: 0.018 });
      const c152 = IX.etat().couts[N(152)];
      ok(c152 && Math.abs(c152[0] - 1e6) < 1 && Math.abs(c152[1] - 0.018) < 1e-9 && Math.abs(c152[2] - 1e6) < 1, 'T3 achat de 1 M + 1 M recus dans la meme tx : 1 M a cout connu, 1 M inconnu : ' + JSON.stringify(c152));
      /* vente melee : 1 M a la paire et 1 M envoye ailleurs dans la meme tx */
      await pas([[PAIRE, N(153), 2e6]], { weth: 0.036 });
      r = await pas([[N(153), PAIRE, 1e6], [N(153), N(154), 1e6]], { weth: -0.018 });
      ok(r.msg.length === 1 && /❔ Profit or loss unknown: sale price not readable on-chain \(tokens also sent elsewhere in the same transaction\)/.test(r.msg[0].texte) && !/Sold at a loss/.test(r.msg[0].texte),
         'T3 vente melee (cede 2 × le flux) : prix de vente illisible, dit tel quel, jamais « -50% » : ' + (r.msg[0] || {}).texte);
      /* les frais d interface du vendeur (1 % pris en $SWOGE) sont COMPTES : +98 %, pas +100 % */
      await pas([[PAIRE, N(155), 2e6]], { weth: 0.036 });
      r = await pas([[N(155), PAIRE, 1e6], [N(155), FRAIS, 10000]], { weth: -0.036 });
      ok(r.msg.length === 1 && /✂️ <b>Partial sell<\/b>/.test(r.msg[0].texte) && /💰 Sold in profit: <b>\+98%<\/b>/.test(r.msg[0].texte),
         'T3 frais du vendeur en $SWOGE (1 %) : comptes dans le prix de vente, +98 % : ' + (r.msg[0] || {}).texte);
      /* deux vendeurs dans la meme tx : le plus gros ne cede que 1,5 M des 2 M du flux ; prix = jambe / flux, +100 %, jamais +167 % */
      await pas([[PAIRE, N(158), 2e6]], { weth: 0.036 });
      await pas([[PAIRE, N(159), 1e6]], { weth: 0.018 });
      r = await pas([[N(158), PAIRE, 1.5e6], [N(159), PAIRE, 5e5]], { weth: -0.072 });
      ok(r.msg.length === 1 && /✂️ <b>Partial sell<\/b>/.test(r.msg[0].texte) && /💰 Sold in profit: <b>\+100%<\/b>/.test(r.msg[0].texte),
         'T3 deux vendeurs dans la tx : le prix est celui de la paire (jambe / flux), +100 % : ' + (r.msg[0] || {}).texte);
      /* vendu par la paire ET une autre piscine de marche : la raison dite est la bonne */
      await pas([[PAIRE, N(156), 2e6]], { weth: 0.036 });
      r = await pas([[N(156), PAIRE, 1e6], [N(156), V3W, 1e6]], { weth: -0.018 });
      ok(r.msg.length === 1 && /sale price not readable on-chain \(sold through several pools\)/.test(r.msg[0].texte) && !/not sold on the v2 pair/.test(r.msg[0].texte),
         'T3 vendu par la paire et une v3 : « sold through several pools », jamais « not sold on the v2 pair » : ' + (r.msg[0] || {}).texte);
      await pas([[PAIRE, N(157), 2e6]], { weth: 0.036 });
      r = await pas([[N(157), PM4, 2e6]], { swapV4: true });
      ok(r.msg.length === 1 && /sale price not readable on-chain \(not sold on the v2 pair\)/.test(r.msg[0].texte), 'T3 vendu par le v4 seul : « not sold on the v2 pair » : ' + (r.msg[0] || {}).texte);
      /* la part connue : 98,5 % = inconnu (seuil 99 %) ; un suivi incomplet = inconnu (rapporte au solde reel) */
      await pas([[U3, N(108), 30000]]);
      await pas([[PAIRE, N(108), 1.97e6]], { weth: 0.03546 });
      r = await pas([[N(108), PAIRE, 2e6]], { weth: -0.072 });
      ok(r.msg.length === 1 && /buy price unknown/.test(r.msg[0].texte), 'T3 98,5 % du sac a cout connu (< 99 %) : inconnu : ' + (r.msg[0] || {}).texte);
      await pas([[PAIRE, N(107), 2e6]], { weth: 0.036 });
      IX.etat().couts[N(107)] = [1e6, 0.018, 0];                           // le suivi ne connait que la moitie du sac reel
      r = await pas([[N(107), PAIRE, 2e6]], { weth: -0.072 });
      ok(r.msg.length === 1 && /buy price unknown/.test(r.msg[0].texte), 'T3 suivi incomplet (1 M sur 2 M reels) : inconnu, jamais +100 % : ' + (r.msg[0] || {}).texte);
    }
    /* --- T4 « Fresh wallet » : nonce 3 dehors ; aucun appel pour un candidat muet --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const nTx = () => X.C.appels.filter((a) => a === 'eth_getTransactionByHash').length;
      let r = await pas([[PAIRE, N(125), 2e6]], { from: N(125), nonce: 3 });
      ok(r.msg.length === 1 && /New holder/.test(r.msg[0].texte) && !/Fresh/.test(r.msg[0].texte), 'T4 nonce 3 : pas neuf (coupure mesuree entre 2 et 6, seuil 2) : ' + (r.msg[0] || {}).texte);
      const n0 = nTx();
      r = await pas([[PAIRE, N(126), 2e5]], { from: N(126), nonce: 0 });  // ~9 $ : sous 10 $, muet
      ok(r.msg.length === 0 && nTx() === n0, 'T4 candidat neuf muet (9 $) : 0 eth_getTransactionByHash (1 appel par candidat ANNONCE)');
    }
    /* --- T5 ventes partielles : 7 % du sac muette, 15 $ muette, l image du papier --- */
    {
      const { W: X, I: IX, pas } = await scene();
      await pas([[PAIRE, N(127), 20e6]]);
      let r = await pas([[N(127), PAIRE, 1.4e6]]);
      ok(r.msg.length === 0 && IX.etat().compteurs.petitePart_partielle >= 1, 'T5 partielle de 7 % du sac (64 $) : muette (seuil 10 %)');
      await pas([[PAIRE, N(128), 2e6]]);
      r = await pas([[N(128), PAIRE, 330000]]);
      ok(r.msg.length === 0 && IX.etat().compteurs.sousSeuil_partielle >= 1, 'T5 partielle de 15 $ (16 % du sac) : muette (seuil 25 $)');
    }
    {
      const X = monde({ depart: '2026-10-10T08:00:00Z' });
      const J = X.fabrique({}, { imageCle: true, genereImage: async () => ({ png: PNG, jetons: 6893, controle: 'pattes ok' }) });
      await muet(() => J.images());
      await muet(() => J.tic());
      X.C.now += 70 * MIN; X.C.tx(X.C.now - 2 * MIN, [[U3, PAIRE, 1e6]]);
      const a = X.envois.length; await muet(() => J.tic());
      const m = sansReleve(X.envois.slice(a))[0];
      ok(m && /Partial sell/.test(m.texte) && m.photo === 'https://serveur.exemple/communaute/image/paper-v1.png', 'T5 une partielle porte l image du papier (aucune image nouvelle) : ' + JSON.stringify(m && m.photo));
    }
    /* --- T6 le cours : la bonne reference, le bon « maintenant », la bonne source, la purge, l arrondi, la note --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T08:00:00Z' }, avant: (C) => {
        C.tx(Date.parse('2026-10-03T18:00:00Z'), [[PAIRE, N(131), 1e6]], { weth: 9 });   // un saut de prix 7 h APRES −168 h
      } });
      await pas([[PAIRE, N(132), 1e6]], { weth: 6 });                     // un saut de prix dans les dernieres 24 h (regime)
      await pas([[PAIRE, U1, 1e6]], { ecart: 20 * MIN });                 // U1 believer le 10/10
      X.C.now = Date.parse('2026-10-10T11:00:30Z');
      let d = X.envois.length; await muet(() => IX.tic());
      const t = releveDe(X, d);
      const eth = 100 * (X.C.prixAu(IX.etat().curseur) / X.C.prixAu(X.C.blocA(X.C.now - 7 * 24 * H)) - 1);
      const attendu = `📊 Chart: <b>${pctT(eth)}</b> this week`, attenduEth = `📊 Chart: <b>${pctT(eth)}</b> this week (in ETH)`;
      ok(t.includes('\n' + attendu + '\n') && IX.texteReleve(X.C.now).includes('\n' + attenduEth + '\n') && Math.abs((Math.abs(eth) % 1) - 0.5) > 0.02,
         `T6 dernier Sync (regime compris) contre le dernier d avant −168 h, ETH/USD egal aux deux bouts : ${eth.toFixed(3)} → « ${attendu} » (et « ${attenduEth} ») : ` + (t.split('\n')[2] || t));
      /* 12/10 : la definition du cours (« Chart = now vs. 7×24h ago ») et la phrase « Not counted… » ont quitte le releve ;
         la note qui reste (la definition des detenteurs) est entiere a la taille de production */
      ok(!/Chart = |7×24h|Not counted/.test(t) && t.endsWith('\n\n' + NOTE_RELEVE), 'T6 la definition du cours n est plus dans la note, la note est entiere a la taille de production : ' + t.split('\n').pop());
      X.C.ethUsd = (b) => (b <= X.C.blocA(Date.parse('2026-10-05T00:00:00Z')) ? 3 : 2540);   // ETH/USD illisible a J−7 seulement
      X.C.now = Date.parse('2026-10-11T09:40:00Z');
      await pas([[PAIRE, U1, 1e6]]);                                      // U1 believer le 10/11 aussi
      X.C.now = Date.parse('2026-10-11T10:59:00Z'); await muet(() => IX.tic());   // un tic avant le releve : la purge passe
      X.C.now = Date.parse('2026-10-11T11:00:30Z');
      d = X.envois.length; await muet(() => IX.tic());
      const t2 = releveDe(X, d);
      ok(/📊 Chart: <b>[+-][\d.,]+%<\/b> this week \(in ETH\)\n/.test(t2) && !/this week\n/.test(t2),
         'T6 ETH/USD de J−7 illisible : ETH seul, jamais le cours du jour a sa place ; la purge de 10:59 garde la reference : ' + (t2.split('\n')[2] || t2));
      X.C.ethUsd = () => 2500;
      X.C.wuDeux = (b) => (b <= X.C.blocA(Date.parse('2026-10-06T00:00:00Z')) ? 3000 : 2000);   // un Swap plus ancien dans la fenetre
      X.C.now = Date.parse('2026-10-12T11:00:30Z');
      d = X.envois.length; await muet(() => IX.tic());
      const t3 = releveDe(X, d);
      const m3 = t3.match(/📊 Chart: <b>([+-][\d.,]+%)<\/b> this week\n/), e3 = IX.texteReleve(X.C.now).match(/📊 Chart: <b>([+-][\d.,]+%)<\/b> this week \(in ETH\)\n/);
      ok(m3 && e3 && m3[1] === e3[1], 'T6 ETH/USD = le DERNIER Swap de la fenetre (2 500 aux deux bouts : $ = ETH) : ' + (m3 ? m3[0] : t3) + ' | ' + (e3 ? e3[0] : ''));
      ok(/\n<b>This week<\/b>\n👥 <b>[^<]*<\/b> holders · 🆕 \d+ new · 💎 1 believer\n/.test(t3), 'T6 U1 believer le 10/10 et le 10/11 : 1 believer sur 7 jours (portefeuilles) : ' + (t3.split('\n').find((l) => /💎 \S+ believers?\n?$/.test(l) && /🆕 \d+ new ·/.test(l)) || t3));
    }
    /* --- T7 une semaine sans echange : la reference est le dernier Sync d avant 8 jours --- */
    {
      const { W: X, I: IX } = await scene({ monde: { depart: '2026-10-20T08:00:00Z' } });
      X.C.now = Date.parse('2026-10-20T11:00:30Z');
      const d = X.envois.length; await muet(() => IX.tic());
      const t = releveDe(X, d);
      ok(/\n📊 Chart: <b>\+0\.0%<\/b> this week\n/.test(t) && /\n📊 Chart: <b>\+0\.0%<\/b> this week \(in ETH\)\n/.test(IX.texteReleve(X.C.now)),
         'T7 aucun echange depuis 11 jours : +0.0 % en $ (et en ETH), la ligne est la : ' + (t.split('\n')[2] || t));
    }
    /* --- T8 le resume en PORTEFEUILLES : sorti deux fois en 24 h = 1 ; entre deux jours de suite = 1 sur 7 jours --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T06:00:00Z' } });
      await pas([[PAIRE, N(133), 2e6]], { ecart: 20 * MIN });
      await pas([[N(133), PAIRE, 2e6]], { ecart: 20 * MIN });
      await pas([[PAIRE, N(133), 2e6]], { ecart: 20 * MIN });
      await pas([[N(133), PAIRE, 2e6]], { ecart: 20 * MIN });
      X.C.now = Date.parse('2026-10-10T11:00:30Z');
      let d = X.envois.length; await muet(() => IX.tic());
      const t = releveDe(X, d);
      ok(/\n<b>Last 24h<\/b>\n🆕 1 new holder · 💎 0 believers · 🧻 1 paper hand\n/.test(t) && partielles24h(IX.etat(), X.C.now) === 0,
         'T8 entre et sorti deux fois en 24 h : 1 new, 1 paper hand (0 partielle au fil des 24 h) : ' + (t.split('\n').find((l) => /^🆕/.test(l)) || t));
      /* le lendemain il rentre et ressort ; au releve du 12/10, les 7 jours (05/10 → 11/10) : U3, U4, N133 entres ;
         U5, U4, N133 sortis — 3 et 3 portefeuilles, jamais 4 et 4 (la somme des jours) */
      X.C.now = Date.parse('2026-10-11T06:00:00Z');
      await pas([[PAIRE, N(133), 2e6]], { ecart: 20 * MIN });
      await pas([[N(133), PAIRE, 2e6]], { ecart: 20 * MIN });
      X.C.now = Date.parse('2026-10-12T11:00:30Z');
      d = X.envois.length; await muet(() => IX.tic());
      const t2 = releveDe(X, d);
      ok(/\n<b>This week<\/b>\n👥 <b>[^<]*<\/b> holders · 🆕 3 new · 💎 0 believers\n/.test(t2), 'T8 7 jours en portefeuilles distincts (N133 entre et sort le 10/10 et le 11/10) : ' + (t2.split('\n').find((l) => /🆕 \d+ new ·/.test(l) && /believers?$/.test(l)) || t2));
      /* « first-time » et « left » ont quitte le releve : le journal des 7 jours les garde, en portefeuilles distincts */
      {
        const S = IX.etat();
        ok(memes(septJournal(S, X.C.now, 'premieres'), [U3, U4, N(133)]) && memes(septJournal(S, X.C.now, 'sorties'), [U5, U4, N(133)]) && !/first-time|\bleft\b/i.test(t2),
           'T8 7 jours au journal : 3 premieres fois (U3, U4, N133), 3 sorties (U5, U4, N133), jamais 4 et 4 ; ni l un ni l autre dans le releve');
      }
    }
    /* --- T9 migration : la reconstruction s arrete au curseur de l ancien etat ; l ecart est annonce une fois --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T08:00:00Z' } });
      await pas([[PAIRE, N(165), 2e6]]);                                  // l ancien processus a annonce
      const f = lit(X.dossier);
      for (const k of ['schema', 'couts', 'liens', 'vus', 'coursW', 'evts']) delete f[k];
      fs.writeFileSync(path.join(X.dossier, 'communaute.json'), JSON.stringify(f));
      /* l ancien s arrete ; pendant le redeploiement, N166 achete (apres son curseur) */
      X.C.now += 3 * MIN;
      X.C.tx(X.C.now - MIN, [[PAIRE, N(166), 2e6]]);
      const I2 = X.fabrique();
      const d = X.envois.length;
      const [r] = await muet(() => I2.tic());
      ok(r.fait === 'construit' && I2.etat().curseur === f.curseur && X.envois.length === d, 'T9 migration : construite jusqu au curseur de l ancien etat, rien d annonce pendant : ' + JSON.stringify([r.fait, I2.etat().curseur, f.curseur]));
      ok(JSON.stringify(I2.etat().heure) === JSON.stringify(f.heure), 'T9 le plafond de l heure est garde (4/h, surplus en attente) : ' + JSON.stringify(I2.etat().heure));
      X.C.now += MIN;
      await muet(() => I2.tic());
      const m = sansReleve(X.envois.slice(d));
      ok(m.length === 1 && m[0].texte.includes(N(166)) && /New holder/.test(m[0].texte), 'T9 l achat fait pendant le redeploiement est annonce au tic suivant, une fois : ' + m.map((x) => x.texte.split('\n')[1]).join(' | '));
      X.C.now += MIN; await muet(() => I2.tic());
      egal(sansReleve(X.envois.slice(d)).length, 1, 'T9 et pas deux fois');
    }
    /* --- T9c un ancien etat arrete depuis deux jours : la borne ne recule pas de plus de 30 min (rien de plus vieux
           ne serait annonce), les journees d entre-deux ont leur photo, l achat d il y a 10 min est annonce --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T08:00:00Z' } });
      await pas([[PAIRE, N(176), 2e6]]);
      const f = lit(X.dossier);
      for (const k of ['schema', 'couts', 'liens', 'vus', 'coursW', 'evts']) delete f[k];
      fs.writeFileSync(path.join(X.dossier, 'communaute.json'), JSON.stringify(f));
      X.C.tx(Date.parse('2026-10-12T07:50:00Z'), [[PAIRE, N(178), 2e6]]);   // aucun echange le 11/10
      X.C.now = Date.parse('2026-10-12T08:00:00Z');
      const I2 = X.fabrique();
      const d = X.envois.length;
      const [r] = await muet(() => I2.tic());
      const plancher = X.C.blocA(X.C.now) - M.CONFIRMATIONS - Math.ceil(M.RETARD_MAX_MS / M.CADENCE_MS);
      ok(r.fait === 'construit' && I2.etat().curseur === plancher && X.envois.length === d, 'T9c construite jusqu a pointe − 30 min, pas jusqu au curseur d il y a deux jours : ' + JSON.stringify([r.fait, I2.etat().curseur, plancher, f.curseur]));
      ok(I2.etat().photos['2026-10-10'] && I2.etat().photos['2026-10-11'], 'T9c les journees d entre-deux (10/10, 11/10 sans echange) ont leur photo');
      X.C.now += MIN; await muet(() => I2.tic());
      const m = sansReleve(X.envois.slice(d));
      ok(m.length === 1 && m[0].texte.includes(N(178)), 'T9c l achat d il y a 10 min est annonce, une fois : ' + m.map((x) => x.texte.split('\n')[1]).join(' | '));
    }
    /* --- T9b migration bornee juste avant minuit (Paris) : la veille est photographiee ecart compris --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { depart: '2026-10-10T20:00:00Z' } });
      await pas([[PAIRE, N(167), 2e6]]);                                  // 21:08 UTC, l ancien processus
      const f = lit(X.dossier);
      for (const k of ['schema', 'couts', 'liens', 'vus', 'coursW', 'evts']) delete f[k];
      fs.writeFileSync(path.join(X.dossier, 'communaute.json'), JSON.stringify(f));
      X.C.tx(Date.parse('2026-10-10T21:59:00Z'), [[PAIRE, N(168), 2e6]]);   // 23:59 a Paris, le 10/10
      X.C.tx(Date.parse('2026-10-10T22:01:00Z'), [[PAIRE, N(169), 2e6]]);   // 00:01 a Paris, le 11/10
      X.C.now = Date.parse('2026-10-10T22:03:00Z');
      const I2 = X.fabrique();
      await muet(() => I2.tic());
      ok(I2.etat().jourCourant === '2026-10-10' && !(I2.etat().photos['2026-10-10'] || {}).t, 'T9b construite au curseur de 21:10 : la journee du 10/10 reste ouverte : ' + I2.etat().jourCourant);
      X.C.now += MIN; await muet(() => I2.tic());
      const p = I2.etat().photos['2026-10-10'];
      ok(p && p.entrees === 2 && I2.etat().jourCourant === '2026-10-11', 'T9b la photo du 10/10 compte l entree de 23:59 lue apres la migration (N167, N168) : ' + JSON.stringify(p && p.entrees));
    }
    /* --- T10 la legende du releve ne depasse jamais 1 024 signes (au-dela, Telegram refuse la photo) --- */
    {
      const { W: X, I: IX } = await scene();
      const S = IX.etat(), now = X.C.now;
      const adr = (p, i) => '0x' + p + String(i).padStart(39, '0');
      for (let i = 0; i < 994; i++) { S.soldes.set(adr('a', i), 2000n * 10n ** 18n); S.codes[adr('a', i)] = 'p'; }
      for (let i = 0; i < 9999; i++) { S.soldes.set(adr('b', i), 278n * 10n ** 18n); S.codes[adr('b', i)] = 'p'; }
      const auj = M.jourParis(now);
      for (let k = 1; k <= 8; k++) {
        const j = new Date(Date.parse(auj + 'T12:00:00Z') - k * 24 * H).toISOString().slice(0, 10);
        /* un jour extreme (+999 en 24 h, % a 4 chiffres, +700 en 7 jours) : 1 027 signes avec la note entiere de l ancien
           format ; 347 au format du 12/10, note comprise */
        S.photos[j] = { detenteurs: 999 - 100 * k, horsPools: 66.5, entrees: 999, premieres: 999, sorties: 999, recus: 999, partis: 999, believers: 999, partielles: 999, t: now };
        delete S.jours[j];
      }
      S.horaires = [{ t: now - 24 * H, n: 0 }];
      S.evts = [];
      for (let i = 0; i < 994; i++) for (const g of ['nouveau', 'believer', 'paper', 'partielle']) S.evts.push([now - H, g, adr('a', i)]);
      const avant = S.compteurs.releveSansNote || 0;
      const t = IX.texteReleve(now, { eth: 1456.7, usd: 9999.9, p0: 1, p1: 1 });
      ok(visibleT(t) <= 1024 && t.endsWith('\n\n' + NOTE_RELEVE) && (S.compteurs.releveSansNote || 0) === avant && !S.compteurs.releveNoteCourte,
         'T10 un jour extreme : la note (une seule phrase depuis le 12/10) reste entiere, la legende tient (' + visibleT(t) + ' signes), rien ne tombe ni ne se compte');
      const tEth = IX.texteReleve(now, { eth: 1456.7, usd: null, p0: 1, p1: 1 });
      ok(/\n📊 Chart: <b>\+10,000%<\/b> this week\n/.test(t) && /\n📊 Chart: <b>\+1,457%<\/b> this week \(in ETH\)\n/.test(tEth) && /\n🆕 994 new holders · /.test(t) &&
         /\n👥 <b>\+700<\/b> holders · /.test(t) && /\n📅 299 → 399 → 499 → 599 → 699 → 799 → 899 → 999\n/.test(t),
         'T10 les chiffres restent tous : ' + t.split('\n').filter((l) => /Chart|🆕|👥|📅/.test(l)).join(' | ') + ' | ' + tEth.split('\n')[2]);
      /* le plus long qu un NOMBRE puisse ecrire (mesure du 12/10) : des detenteurs a 21 chiffres (au-dela, String passe en
         « 1e+21 »), +1,8e308 % en $, +1e21 en 24 h : 854 signes, la note tient encore. Au format du 12/10, aucun nombre
         n atteint la derniere marche */
      const photos0 = JSON.stringify(S.photos), horaires0 = S.horaires;
      Object.keys(S.photos).sort().forEach((j, i) => { S.photos[j].detenteurs = i % 2 ? 999999999999999900000 : 1; });
      S.horaires = [{ t: now - 24 * H, n: -999999999999999900000 }];
      const tMax = IX.texteReleve(now, { eth: 1456.7, usd: Number.MAX_VALUE, p0: 1, p1: 1 });
      ok(visibleT(tMax) <= 1024 && tMax.endsWith('\n\n' + NOTE_RELEVE) && /\n📅 999999999999999900000 → 1 → /.test(tMax) && (S.compteurs.releveSansNote || 0) === avant,
         'T10 colonnes a 21 chiffres et +1,8e308 % : la note tient encore, la legende aussi (' + visibleT(tMax) + ' signes)');
      S.photos = JSON.parse(photos0); S.horaires = horaires0;
      /* hors de toute echelle, seulement pour exercer la derniere marche : des comptes ecrits sur L chiffres (des chaines),
         L croissant. La note entiere tombe au premier L ou elle ne tient plus, jamais avant, c est compte une fois,
         et aucun chiffre ne tombe */
      let L = 3, t2 = '', tAvant = '';
      for (; L <= 200; L++) {
        for (const j of Object.keys(S.photos)) S.photos[j].detenteurs = '9'.repeat(L);
        tAvant = t2; t2 = IX.texteReleve(now, { eth: 1456.7, usd: 9999.9, p0: 1, p1: 1 });
        if (!t2.endsWith(NOTE_RELEVE)) break;
      }
      const neufs = '9'.repeat(L);
      ok(L <= 200 && visibleT(t2) <= 1024 && !/<i>/.test(t2) && visibleT(t2 + '\n\n' + NOTE_RELEVE) > 1024 &&
         tAvant.endsWith('\n\n' + NOTE_RELEVE) && visibleT(tAvant) <= 1024 && S.compteurs.releveSansNote === avant + 1 &&
         /\n📊 Chart: <b>\+10,000%<\/b> this week\n/.test(t2) && /\n🆕 994 new holders · 💎 994 believers · 🧻 994 paper hands\n/.test(t2) &&
         /\n<b>This week<\/b>\n👥 <b>±0<\/b> holders · 🆕 \d+ new · 💎 \d+ believers\n/.test(t2) &&
         t2.endsWith('\n📅 ' + Array(7).fill(neufs).join(' → ') + ' → 999'),
         'T10 comptes a ' + L + ' chiffres : la note tombe au premier pas ou elle ne tient plus, la legende tient (' + visibleT(t2) + ' signes, ' + visibleT(tAvant) + ' avec la note au pas d avant), tous les chiffres restent');
    }
    /* --- T11 la ligne 📅 (12/10) : les detenteurs de fin de journee des 7 jours finis, dans l ordre, puis MAINTENANT ;
           « – » pour un jour sans photo (jamais 0, jamais le voisin) ; ni J−8 ni une photo d aujourd hui --- */
    {
      const { W: X, I: IX } = await scene();
      const S = IX.etat(), now = X.C.now, auj = M.jourParis(now), jours = joursReleve(now);
      const photo = (n) => ({ detenteurs: n, horsPools: 66.5, entrees: 1, premieres: 1, sorties: 0, recus: 0, partis: 0, believers: 0, partielles: 0, t: now });
      const j8 = new Date(Date.parse(auj + 'T12:00:00Z') - 8 * 24 * H).toISOString().slice(0, 10);
      S.photos[j8] = photo(801);                                         // J−8 : la reference de la croissance, pas une entree
      jours.forEach((j, i) => { S.photos[j] = photo(811 + 10 * i); });   // J−7 … J−1 : 811, 821, … 871
      S.photos[auj] = photo(999);                                        // une photo d aujourd hui ne doit jamais etre lue
      const n = IX.chiffres().detenteurs;
      ok(n !== 999 && n !== 871, 'T11 maintenant (' + n + ') differe de la photo d aujourd hui et de J−1 : l essai distingue les trois');
      const ligne = (t) => (String(t).match(/\n📅 [^\n]*/) || [''])[0].slice(1);
      let t = IX.texteReleve(now, null);
      ok(ligne(t) === `📅 811 → 821 → 831 → 841 → 851 → 861 → 871 → ${n}` && /\n<b>This week<\/b>\n👥 [^\n]*\n📅 [^\n]*\n\n<i>/.test(t),
         'T11 sept photos : J−7 → J−1 dans l ordre, puis maintenant ; sous « This week », avant la note : ' + ligne(t));
      delete S.photos[jours[2]];                                         // J−5 sans photo
      t = IX.texteReleve(now, null);
      ok(ligne(t) === `📅 811 → 821 → – → 841 → 851 → 861 → 871 → ${n}`, 'T11 un jour sans photo au milieu : « – » a sa place, ni 0 ni un voisin : ' + ligne(t));
      delete S.photos[jours[0]]; delete S.photos[jours[6]];              // les deux bouts manquent aussi
      t = IX.texteReleve(now, null);
      ok(ligne(t) === `📅 – → 821 → – → 841 → 851 → 861 → – → ${n}` && (suiteReleve(t) || []).length === 8,
         'T11 J−7 et J−1 sans photo : « – » aux deux bouts, toujours 8 entrees, maintenant a la fin : ' + ligne(t));
    }
  }

  // ================================================== 14. depuis quand il tenait, et la phrase de la paper hand (12/10, soir)
  /* Le proprietaire, sur une annonce reelle : « tu pourrais rajouter ca fait combien de jours qu il hold,
     ou une phrase drole du genre ». Intention : la duree dite est celle de CETTE tenue (depuis le dernier
     passage au-dessus de 1 000), juste meme pour un detenteur entre bien avant la fenetre et sur un noeud
     dont la cadence n est pas celle supposee ; la phrase suit le gain ou la perte LUS, sans insulte. */
  {
    const toutes = [].concat(...Object.values(M.BLAGUES_PAPER));
    const blague = (t) => ((String(t).match(/\n<i>([^<]+)<\/i>\n/) || [])[1]) || null;
    /* --- P1 les fonctions pures --- */
    egal(M.dureeTenue(30 * 1000), '1 minute', 'P1 une vente dans la minute : « 1 minute », jamais « 0 minutes »');
    egal(M.dureeTenue(45 * MIN), '45 minutes', 'P1 sous 2 h : en minutes');
    egal(M.dureeTenue(2 * H), '2 hours', 'P1 a 2 h : en heures');
    egal(M.dureeTenue(47 * H), '47 hours', 'P1 sous 48 h : en heures');
    egal(M.dureeTenue(12.4 * 24 * H), '12 days', 'P1 au-dela : en jours arrondis');
    ok(['gain', 'perte', 'autre'].every((f) => M.BLAGUES_PAPER[f].length >= 3), 'P1 trois phrases au moins par famille');
    ok(toutes.every((b) => !/\b(ass|fuck|shit|bitch|idiot|stupid|loser|scam|rug)/i.test(b) && !/[<>&]/.test(b) && b.length <= 80),
       'P1 aucune phrase grossiere ni accusatrice, rien qui casse le HTML, 80 signes au plus');
    const hx = (i) => '0x' + (0x100000 + i).toString(16).padStart(64, 'a');
    ok(M.blaguePaper({ h: hx(7), venteLue: true, pnl: 90 }) === M.blaguePaper({ h: hx(7), venteLue: true, pnl: 90 }), 'P1 la meme tx donne la meme phrase (rejeu, reconstruction)');
    const fam = (ev) => Object.keys(M.BLAGUES_PAPER).find((f) => M.BLAGUES_PAPER[f].includes(M.blaguePaper(ev)));
    egal(fam({ h: hx(1), venteLue: true, pnl: 90 }), 'gain', 'P1 vendu en gain : une phrase de la famille « gain »');
    egal(fam({ h: hx(1), venteLue: true, pnl: -30 }), 'perte', 'P1 vendu a perte : « perte » (jamais « sold low » a qui a gagne, et l inverse)');
    egal(fam({ h: hx(1), venteLue: true, pnl: 0.5 }), 'autre', 'P1 a l equilibre (±1 %) : « autre »');
    egal(fam({ h: hx(1), venteLue: false, pnl: 90 }), 'autre', 'P1 prix de vente illisible : « autre », le gain suppose n est pas lu');
    egal(fam({ h: hx(1), venteLue: true, pnl: null }), 'autre', 'P1 prix d achat inconnu : « autre »');
    egal(new Set(Array.from({ length: 30 }, (_, i) => M.blaguePaper({ h: hx(i), venteLue: true, pnl: 90 }))).size, M.BLAGUES_PAPER.gain.length,
         'P1 sur 30 tx, toutes les phrases d une famille sortent (le choix tourne)');
    /* --- P2 au tic : entree puis sortie 70 min plus tard ; au retour, la duree repart de la nouvelle entree --- */
    {
      const { I: IX, pas } = await scene();
      const Q = N(200);
      const r0 = await pas([[PAIRE, Q, 2e6]]);
      ok(r0.msg.length === 1 && /New holder/.test(r0.msg[0].texte) && !/and left after|<i>/.test(r0.msg[0].texte), 'P2 un achat ne porte ni duree ni phrase');
      const entree1 = IX.etat().tenue[Q];
      /* depuis le schema 4 (13/10) l entree est un objet : son heure est `t` (voir section 16) */
      ok(entree1 && typeof entree1.t === 'number', 'P2 l achat qui passe le seuil pose l heure d entree');
      let r = await pas([[Q, PAIRE, 2e6]]);
      ok(r.msg.length === 1 && /^🧻 <b>Paper hand<\/b>/.test(r.msg[0].texte) && /and left after (69|70|71) minutes\n/.test(r.msg[0].texte),
         'P2 sortie 70 min apres l entree : « and left after 70 minutes » : ' + (r.msg[0] || {}).texte);
      ok(toutes.includes(blague(r.msg[0].texte)), 'P2 la phrase, en italique, tiree de BLAGUES_PAPER : ' + blague(r.msg[0].texte));
      ok(!(Q in IX.etat().tenue), 'P2 la sortie efface l heure d entree');
      await pas([[PAIRE, Q, 3e6]]);          // le retour (son « welcome back » se tait : meme famille dans les 24 h)
      ok((IX.etat().tenue[Q] || {}).t > entree1.t + 2 * H - 5 * MIN, 'P2 le retour pose une NOUVELLE heure d entree');
      r = await pas([[Q, PAIRE, 3e6]], { ecart: 25 * H });
      ok(r.msg.length === 1 && /and left after 25 hours\n/.test(r.msg[0].texte),
         'P2 au retour, la duree compte depuis la nouvelle entree (25 h), pas depuis la premiere : ' + (r.msg[0] || {}).texte);
    }
    /* --- P3 un detenteur entre AVANT la fenetre, sur un noeud a 90 ms (le module suppose 103,54) : les ancres depuis la frappe --- */
    {
      const { I: IX, pas } = await scene({ monde: { cadence: 90 } });
      const S = IX.etat();
      ok(S.ancres.length > 10 && S.ancres[0][0] === M.BLOC_FRAPPE && S.ancres.every((a, i) => i === 0 || a[0] > S.ancres[i - 1][0]),
         'P3 les ancres partent de la frappe, dans l ordre des blocs (' + S.ancres.length + ')');
      const ecart = (a, quand) => Math.abs((S.tenue[a] || {}).t - Date.parse(quand)) / H;
      ok(ecart(U2, '2026-10-04T10:00:00Z') < 2, 'P3 U2 (entre le 04/10) : heure d entree lue a moins de 2 h : ' + ecart(U2, '2026-10-04T10:00:00Z').toFixed(2) + ' h');
      ok(ecart(E1, '2026-09-20T10:00:00Z') < 2, 'P3 E1 (entre le 20/09, avant les 9 ancres quotidiennes) : a moins de 2 h, pas a ~40 h comme une extrapolation depuis la pointe : ' + ecart(E1, '2026-09-20T10:00:00Z').toFixed(2) + ' h');
      const r = await pas([[U2, PAIRE, 2e6]]);
      ok(r.msg.length === 1 && /and left after 6 days\n/.test(r.msg[0].texte), 'P3 U2 vend le 10/10 : « and left after 6 days » : ' + (r.msg[0] || {}).texte);
      delete S.tenue[U1];
      const r2 = await pas([[U1, PAIRE, 5e6]]);
      ok(r2.msg.length === 1 && /and left\n/.test(r2.msg[0].texte) && !/and left after/.test(r2.msg[0].texte), 'P3 heure d entree inconnue : « and left », sans duree inventee : ' + (r2.msg[0] || {}).texte);
    }
    /* --- P4 un etat au schema 2 (sans `tenue`) est reconstruit une fois et recoit les heures d entree --- */
    {
      const { W: X, pas } = await scene();
      await pas([[PAIRE, N(210), 2e6]]);
      const f = lit(X.dossier); f.schema = 2; delete f.tenue;
      fs.writeFileSync(path.join(X.dossier, 'communaute.json'), JSON.stringify(f));
      const I2 = X.fabrique();
      X.C.now += 30 * MIN;
      const [r] = await muet(() => I2.tic());
      const s2 = I2.etat();
      ok(r.fait === 'construit' && s2.schema === M.SCHEMA && M.SCHEMA >= 3 && typeof (s2.tenue[N(210)] || {}).t === 'number' && typeof (s2.tenue[U2] || {}).t === 'number',
         'P4 schema 2 sans heures d entree : reconstruit, et les heures d entree sont posees : ' + JSON.stringify(r).slice(0, 60));
      ok(typeof (lit(X.dossier).tenue[N(210)] || {}).t === 'number', 'P4 et ecrites sur le disque');
    }
  }

  // ================================================== 15. les piscines detaillees, et ce qui reste a acheter cote ETH (12/10, soir)
  /* Le proprietaire, sur le relevé : « 67.5% outside pools alors que je vois 20 % qui reste dans le pool ;
     0xc129… contient du swoge car c est quand t achetes du $SWOGEBET », puis « rajoute combien il reste dans
     le pool disponible a acheter ». Intention : chaque piscine est rangee sous le jeton d EN FACE (WETH →
     « ETH », $SWOGEBET → « $SWOGEBET », le reste → « other »), les parts somment avec les portefeuilles a
     100 %, et le reste a acheter est le solde des SEULES piscines ETH — celles ou l on paie en ETH. */
  {
    /* --- Q1 les fonctions pures --- */
    egal(M.SWOGEBET, SWOGEBET, 'Q1 le $SWOGEBET du module est le jeton du launchpad');
    egal(M.detailPools(null), '', 'Q1 sans circulation : rien, jamais « pools: »');
    egal(M.detailPools({ eth: 20.64, swogebet: 11.83, autre: 0.0049 }), ' · pools: 20.6% ETH · 11.8% $SWOGEBET',
         'Q1 les chiffres du 12/10 : ETH puis $SWOGEBET, « other » sous 0,05 % : cache');
    egal(M.detailPools({ eth: 0.04, swogebet: 0, autre: 0 }), '', 'Q1 toutes sous 0,05 % : aucune liste vide');
    egal(M.detailPools({ eth: 1, swogebet: 2, autre: 3 }), ' · pools: 1.0% ETH · 2.0% $SWOGEBET · 3.0% other', 'Q1 chaque etiquette sur sa part');
    /* --- Q2 dans un monde construit : les parts sont les soldes des piscines, rangees par jeton d en face --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const r = await pas([[PAIRE, N(220), 2e6]]);
      const S = IX.etat(), tok = (a) => Number((S.soldes.get(a) || 0n) / 10n ** 12n) / 1e6;
      const circ = -tok(ZERO) - tok(MORT), eth = tok(PAIRE) + tok(V3W), bet = tok(V3);
      ok(S.autres[PAIRE] === WETH && S.autres[V3W] === WETH && S.autres[V3] === SWOGEBET && bet > 0 && Math.abs(eth / bet - 1) > 0.5,
         'Q2 le decor : deux piscines ETH, une $SWOGEBET, aux soldes assez differents pour qu une etiquette echangee se voie');
      const l = ((r.msg[0] || {}).texte || '').match(/🌊 ([\d.]+)% held by wallets · pools: ([\d.]+)% ETH · ([\d.]+)% \$SWOGEBET( · ([\d.]+)% other)?\n🛒 ([^ ]+) \$SWOGE available to buy in the ETH pools\n/);
      ok(!!l, 'Q2 la ligne detaillee est la : ' + ((r.msg[0] || {}).texte || '').split('\n').filter((x) => /🌊|🛒/.test(x)).join(' | '));
      if (l) {
        const [w, pe, pb, po] = [l[1], l[2], l[3], l[5] || '0'].map(Number);
        ok(Math.abs(pe - 100 * eth / circ) <= 0.05, `Q2 la part ETH est le solde des deux piscines ETH (${pe} contre ${(100 * eth / circ).toFixed(2)})`);
        ok(Math.abs(pb - 100 * bet / circ) <= 0.05, `Q2 la part $SWOGEBET est le solde de la v3 $SWOGEBET (${pb} contre ${(100 * bet / circ).toFixed(2)})`);
        ok(Math.abs(w + pe + pb + po - 100) <= 0.2, `Q2 portefeuilles + piscines = 100 % (${w} + ${pe} + ${pb} + ${po})`);
        egal(l[6], M.fmtJetons(eth), 'Q2 le reste a acheter est le solde des piscines ETH, pas celui de la $SWOGEBET');
      }
      /* --- Q3 une seule piscine ETH garnie : « pool » au singulier ; aucune : pas de ligne 🛒 --- */
      /* le livre est confronte a la chaine a chaque tic : on vide la v3 SWOGE/WETH SUR la chaine (retrait de liquidite) */
      const rl = await pas([[V3W, E1, 20e6]], { liquidite: V3W });
      egal(rl.x && rl.x.fait !== 'erreur' && rl.msg.length, 0, 'Q3 le retrait de liquidite passe, sans annonce');
      const r3 = await pas([[PAIRE, N(221), 2e6]]);
      ok(/\n🛒 [^ ]+ \$SWOGE available to buy in the ETH pool\n/.test((r3.msg[0] || {}).texte || ''), 'Q3 une seule piscine ETH garnie : « pool » : ' + ((r3.msg[0] || {}).texte || '').split('\n').filter((x) => /🛒/.test(x)));
      /* le releve se calcule sur le livre, sans tic : on y vide aussi la paire pour le cas « aucune » */
      IX.etat().soldes.set(PAIRE, 0n);
      const tr = IX.texteReleve(X.C.now);
      ok(!/🛒/.test(tr) && / of supply held by wallets · pools: [\d.]+% \$SWOGEBET\n\n/.test(tr),
         'Q3 aucune piscine ETH garnie : ni ligne 🛒, ni « 0.0% ETH » : ' + tr.split('\n').filter((x) => /🌊|🛒/.test(x)).join(' | '));
    }
  }

  // ================================================== 16. par quelle tx il etait entre, et a quelle heure UTC (13/10)
  /* Le proprietaire, sur l annonce reelle « 0x7a1d…165f sold 21.7M $SWOGE (~$745) and left after 9 days » :
     « donne le wallet ou ca a ete achete, la ca a ete transfere d un wallet vers un autre et ensuite il a
     seulement vendu ; dis a quelle heure, comme ca on retrouve la TX dans l explorateur ». Intention : sous
     « and left after », une ligne qui dit QUAND il est entre — l heure UTC du bloc, a la minute, lue dans son
     en-tete (jamais l heure locale du serveur, jamais l interpolation des ancres) — avec le lien de la tx
     d entree, et COMMENT : achete (le beneficiaire d un achat, meme a travers un routeur), ou recu d une
     personne (le plus gros envoyeur de la tx, son adresse, et l achat d origine s il est connu, a un saut ou
     plus). Rien d invente : sans entree connue, aucune ligne ; une donnee illisible n empeche jamais
     l annonce ; le message reste sous la limite de la legende. */
  {
    const TZ0 = process.env.TZ;
    process.env.TZ = 'Pacific/Chatham';            // UTC+13:45 : une heure locale ne tombe jamais sur l heure UTC
    const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    /* l oracle : la minute UTC de l en-tete du bloc (le faux noeud ecrit des secondes), lue dans l ISO */
    const heureBloc = (C, b) => { const iso = new Date(Math.floor(C.tDe(b) / 1000) * 1000).toISOString(); return `${MOIS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(11, 16)} UTC`; };
    const blocTx = (C, h) => parseInt(C.logs.find((l) => l.transactionHash === h).blockNumber, 16);
    const ligneE = (t) => (String(t).match(/\n(📥 [^\n]*)/) || [])[1] || null;
    const lienT = (h, mot) => `<a href="https://explorateur.exemple/tx/${h}">${mot} ↗</a>`;
    const lienA = (a) => `<a href="https://explorateur.exemple/address/${a}">${a.slice(0, 6)}…${a.slice(-4)}</a>`;
    const papier = (r) => ((r && r.msg) || []).find((m) => /^🧻 <b>Paper hand<\/b>/.test(m.texte)) || { texte: '' };
    const visibleT = (t) => t.replace(/<[^>]*>/g, '').replace(/&(lt|gt|amp|quot);/g, '_').length;

    /* --- R1 les fonctions pures : UTC a la minute, sans arrondi, l annee seulement si elle change --- */
    egal(M.heureUtc(Date.parse('2026-10-03T22:03:01Z'), Date.parse('2026-10-12T23:11:33Z')), 'Oct 3, 22:03 UTC',
         'R1 le cas reel (bloc 79 424 425) : « Oct 3, 22:03 UTC », jamais l heure locale (TZ ' + process.env.TZ + ')');
    egal(M.heureUtc(Date.parse('2026-10-03T22:03:59.999Z'), Date.parse('2026-10-12T00:00:00Z')), 'Oct 3, 22:03 UTC', 'R1 22:03:59 reste 22:03 : la minute du bloc, pas un arrondi');
    egal(M.heureUtc(Date.parse('2026-07-08T09:05:00Z'), Date.parse('2026-10-12T00:00:00Z')), 'Jul 8, 09:05 UTC', 'R1 jour sans zero, heure sur deux chiffres');
    egal(M.heureUtc(Date.parse('2025-12-31T23:59:00Z'), Date.parse('2026-01-01T00:10:00Z')), 'Dec 31, 2025, 23:59 UTC', 'R1 une autre annee : ecrite');
    ok(JSON.stringify(M.entreeDe(1.76e12)) === '{"t":1760000000000}' && M.entreeDe(null) === null && M.entreeDe({ h: '0x1' }) === null && M.entreeDe(NaN) === null,
       'R1 un nombre (etat du schema 3) se lit { t } ; un objet sans heure ne vaut rien');

    /* --- R2 entre par un ACHAT a travers un routeur (le cas reel : le jeton arrive « du » routeur) --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const Q = N(300);
      const r1 = await pas([[PAIRE, ROUTEUR, 2e6], [ROUTEUR, Q, 2e6]]);
      const e = IX.etat().tenue[Q] || {};
      ok(e.h === r1.h && e.b === blocTx(X.C, r1.h) && e.comment === 'achat' && !('de' in e) && !('origine' in e),
         'R2 l entree : cette tx, son bloc, « achat », aucun envoyeur (le routeur est un contrat) : ' + JSON.stringify(e));
      const m = papier(await pas([[Q, PAIRE, 2e6]]));
      egal(ligneE(m.texte), `📥 In since ${heureBloc(X.C, blocTx(X.C, r1.h))} · ${lienT(r1.h, 'bought')}`, 'R2 la ligne : l heure UTC de l en-tete, « bought », le lien de l ACHAT');
      ok(/ and left after \d+ minutes\n📥 [^\n]*\n(💰|🔻|⚖️|❔)/.test(m.texte), 'R2 juste sous « and left after », avant le gain ou la perte : ' + m.texte.split('\n').slice(1, 4).join(' | '));
      ok(!m.texte.includes(ROUTEUR), 'R2 le routeur n apparait jamais comme un wallet');
    }

    /* --- R3 entre par ENVOI d un portefeuille qui avait achete ; l envoyeur sort dans la meme tx --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const P = N(301), Q = N(302);
      const r1 = await pas([[PAIRE, P, 3e6]]);
      const r2 = await pas([[P, Q, 3e6]]);
      const e = IX.etat().tenue[Q] || {};
      ok(e.comment === 'envoi' && e.de === P && e.h === r2.h && e.origine && e.origine.h === r1.h && e.origine.qui === P && e.origine.b === blocTx(X.C, r1.h),
         'R3 l entree de Q : l envoi, de P, et l achat d origine de P (lu avant que l envoi n efface P) : ' + JSON.stringify(e));
      ok(!(P in IX.etat().tenue), 'R3 P, sorti par son envoi, n a plus d entree');
      const r3 = await pas([[Q, PAIRE, 3e6]]);
      egal(ligneE(papier(r3).texte),
           `📥 In since ${heureBloc(X.C, blocTx(X.C, r2.h))} · ${lienT(r2.h, 'received')} from ${lienA(P)}, who ${lienT(r1.h, 'bought on ' + heureBloc(X.C, blocTx(X.C, r1.h)))}`,
           'R3 la ligne : recu (lien de l envoi) de P (lien d adresse), qui avait achete (heure UTC et lien de SON achat)');
      ok(!/sold|dump|scam/i.test(ligneE(papier(r3).texte) || 'x'), 'R3 la ligne decrit des tx, n accuse personne');
    }

    /* --- R4 deux envoyeurs dans la meme tx. Intention : la ligne ne nomme JAMAIS un wallet qui n a pas envoye
       a l entrant. Relecture du 13/10 (A1, E5) : « le plus gros net negatif » nommait P1 quand P1 envoyait a X
       et P2 a Q (« received from P1, who bought … »). Un envoi n a desormais qu UNE adresse a net negatif (0 tx
       sans piscine a plusieurs dans l histoire) : a deux envoyeurs, personne n est nomme — que P1 envoie a Q,
       a une autre personne ou a un contrat, dans les deux ordres --- */
    for (const vers of ['Q', 'une personne', 'un contrat']) for (const ordre of ['P1 d abord', 'P2 d abord']) {
      const { W: X, I: IX, pas } = await scene();
      const P1 = N(310), P2 = N(311), Q = N(312), Xp = N(313);
      await pas([[PAIRE, P1, 5e6]]);
      await pas([[PAIRE, P2, 3e6]]);
      const q1 = vers === 'Q' ? 1500 : 5e6;
      const envois = [[P1, vers === 'Q' ? Q : vers === 'une personne' ? Xp : MUET, q1], [P2, Q, 3e6]];
      const r3 = await pas(ordre === 'P2 d abord' ? envois.reverse() : envois);
      const e = IX.etat().tenue[Q] || {};
      ok(e.h === r3.h && !('comment' in e) && !('de' in e) && !('origine' in e),
         `R4 (P1 vers ${vers}, ${ordre}) deux envoyeurs : l entree de Q garde sa tx, sans envoyeur ni origine : ` + JSON.stringify(e));
      const l = ligneE(papier(await pas([[Q, PAIRE, 3e6 + (vers === 'Q' ? q1 : 0)]])).texte) || '';
      egal(l, `📥 In since ${heureBloc(X.C, blocTx(X.C, r3.h))} · ${lienT(r3.h, 'tx')}`, `R4 (P1 vers ${vers}, ${ordre}) la ligne : l heure et la tx, ni P1 ni P2`);
    }

    /* --- R5 deux sauts (A achete, envoie a B, B envoie a C), et l aller-retour --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const A_ = N(320), B = N(321), C_ = N(322);
      const r1 = await pas([[PAIRE, A_, 4e6]]);
      await pas([[A_, B, 4e6]]);
      const r3 = await pas([[B, C_, 4e6]]);
      const e = IX.etat().tenue[C_] || {};
      ok(e.de === B && e.origine && e.origine.h === r1.h && e.origine.qui === A_, 'R5 C : recu de B, origine = l achat de A, deux sauts plus haut : ' + JSON.stringify(e));
      egal(ligneE(papier(await pas([[C_, PAIRE, 4e6]])).texte),
           `📥 In since ${heureBloc(X.C, blocTx(X.C, r3.h))} · ${lienT(r3.h, 'received')} from ${lienA(B)} · ${lienT(r1.h, 'bought on ' + heureBloc(X.C, blocTx(X.C, r1.h)))} by ${lienA(A_)}`,
           'R5 la ligne : de B, « bought … by » A — jamais « B who bought », jamais « first » (relecture du 13/10, E1 : le lien n est pas toujours le premier achat)');
      const D = N(323), E_ = N(324);
      const s1 = await pas([[PAIRE, D, 2e6]]);
      await pas([[D, E_, 2e6]]);
      const s3 = await pas([[E_, D, 2e6]]);
      egal(ligneE(papier(await pas([[D, PAIRE, 2e6]])).texte),
           `📥 In since ${heureBloc(X.C, blocTx(X.C, s3.h))} · ${lienT(s3.h, 'received')} from ${lienA(E_)} · ${lienT(s1.h, 'bought on ' + heureBloc(X.C, blocTx(X.C, s1.h)))} by this wallet`,
           'R5 l aller-retour (D achete, envoie a E, E renvoie) : « bought … by this wallet »');
    }

    /* --- R6 la minute est celle de l EN-TETE, sur un noeud a 90 ms par bloc (le module en suppose 103,54) --- */
    {
      const { W: X, I: IX, pas } = await scene({ monde: { cadence: 90 } });
      const S = IX.etat();
      /* une entree de la construction (U2, achat du 04/10). La cadence du faux noeud est constante :
         l interpolation entre ses ancres y tombe juste (sur la vraie chaine, 27 minutes justes sur 140,
         voir ENTREE) ; c est l entree estimee au tic, plus bas, qui discrimine. */
      const bU2 = X.C.blocA(Date.parse('2026-10-04T10:00:00Z'));
      const minute = (t) => Math.floor(t / 60000);
      ok(S.tenue[U2] && S.tenue[U2].b === bU2 && S.tenue[U2].comment === 'achat', 'R6 U2 : son entree de la construction porte son bloc : ' + JSON.stringify(S.tenue[U2]));
      const l1 = ligneE(papier(await pas([[U2, PAIRE, 2e6]])).texte) || '';
      ok(l1.startsWith(`📥 In since ${heureBloc(X.C, bU2)} · `) && heureBloc(X.C, bU2) === 'Oct 4, 10:00 UTC', 'R6 U2 : « Oct 4, 10:00 UTC », lu dans l en-tete : ' + l1);
      /* une entree du tic (estimee depuis la pointe), a 09:42:05 reels : l estimation tombe a 09:41 */
      const cible = Date.parse('2026-10-10T19:42:05Z'), Q = N(330);
      const r = await pas([[PAIRE, Q, 2e6]], { ecart: cible + 2 * MIN - X.C.now });
      const bQ = blocTx(X.C, r.h);
      ok(minute(S.tenue[Q].t) !== minute(Math.floor(X.C.tDe(bQ) / 1000) * 1000) && heureBloc(X.C, bQ) === 'Oct 10, 19:42 UTC',
         'R6 le decor discrimine : l heure estimee au tic (' + new Date(S.tenue[Q].t).toISOString().slice(11, 19) + ') n est pas la minute du bloc');
      const l2 = ligneE(papier(await pas([[Q, PAIRE, 2e6]])).texte) || '';
      ok(l2.startsWith('📥 In since Oct 10, 19:42 UTC · '), 'R6 Q : « Oct 10, 19:42 UTC », la minute de l en-tete : ' + l2);
      ok(S.compteurs.heuresEntreeLues >= 2, 'R6 un lot d en-tetes par paper hand annoncee, compte');
    }

    /* --- R7 le lien est celui du PASSAGE de 1 000 : ni la poussiere d avant, ni les achats ou envois d apres, ni la vente --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const Q = N(340);
      const r0 = await pas([[E1, Q, 500]]);                  // poussiere : sous le seuil
      ok(!(Q in IX.etat().tenue), 'R7 500 jetons recus : pas d entree');
      const r1 = await pas([[PAIRE, Q, 2e6]]);               // le passage
      const r2 = await pas([[PAIRE, Q, 1e6]]);               // believer : deja detenteur
      const r3 = await pas([[E1, Q, 2000]]);                 // un envoi de plus
      const r4 = await pas([[Q, PAIRE, 3e6 + 2500]]);
      const l = ligneE(papier(r4).texte) || '';
      egal(l, `📥 In since ${heureBloc(X.C, blocTx(X.C, r1.h))} · ${lienT(r1.h, 'bought')}`, 'R7 la ligne pointe l achat qui a passe 1 000');
      ok(![r0.h, r2.h, r3.h, r4.h].some((h) => l.includes(h)), 'R7 aucune autre tx dans la ligne (poussiere, believer, envoi, la vente elle-meme)');
    }

    /* --- R8 rien d invente : entree inconnue, ancien format, entree dans l echange d un autre, envoi d un contrat, en-tete illisible --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const Q1 = N(350), Q2 = N(351), Q3 = N(352), Q4 = N(353), Q5 = N(354), B = N(355);
      await pas([[PAIRE, Q1, 2e6]]);
      delete IX.etat().tenue[Q1];
      const m1 = papier(await pas([[Q1, PAIRE, 2e6]]));
      ok(/ and left\n/.test(m1.texte) && !ligneE(m1.texte), 'R8 entree inconnue : « and left », aucune ligne 📥 : ' + m1.texte.split('\n')[1]);
      await pas([[PAIRE, Q2, 2e6]]);
      IX.etat().tenue[Q2] = IX.etat().tenue[Q2].t;          // l ancien format (schema 3) : l heure seule
      const m2 = papier(await pas([[Q2, PAIRE, 2e6]]));
      ok(/ and left after 70 minutes\n/.test(m2.texte) && !ligneE(m2.texte), 'R8 heure seule (schema 3) : la duree, mais aucune ligne 📥 sans la tx : ' + m2.texte.split('\n')[1]);
      /* Q3 passe 1 000 en recevant 1 500 dans l achat de B (des frais) : ni « bought » ni « received » */
      const r3 = await pas([[PAIRE, B, 4e6], [B, Q3, 1500]]);
      await pas([[E1, Q3, 1e6]]);
      ok(!('comment' in (IX.etat().tenue[Q3] || { comment: 1 })), 'R8 entre dans l echange d un autre : pas de comment');
      egal(ligneE(papier(await pas([[Q3, PAIRE, 1e6 + 1500]])).texte), `📥 In since ${heureBloc(X.C, blocTx(X.C, r3.h))} · ${lienT(r3.h, 'tx')}`,
           'R8 la ligne : l heure et la tx, sans dire comment');
      /* Q4 recoit d un CONTRAT (MUET) : pas « received from » un wallet */
      const r4 = await pas([[MUET, Q4, 1e6]]);
      /* l entree elle-meme ne dit pas « envoi » : le compte entree_envoi (mode observe) ne la range pas
         parmi les envois, meme si la ligne reverifie personne() a l annonce (relecture du 13/10, A2) */
      const e4 = IX.etat().tenue[Q4] || { comment: 1 };
      ok(e4.h === r4.h && !('comment' in e4) && !('de' in e4), 'R8 envoi d un contrat : l entree garde sa tx, sans « envoi » ni envoyeur : ' + JSON.stringify(e4));
      egal(ligneE(papier(await pas([[Q4, PAIRE, 1e6]])).texte), `📥 In since ${heureBloc(X.C, blocTx(X.C, r4.h))} · ${lienT(r4.h, 'tx')}`,
           'R8 envoi d un contrat : l heure et la tx, jamais « received from » un contrat');
      /* en-tete illisible : l annonce part, la ligne garde son lien, sans heure */
      const r5 = await pas([[PAIRE, Q5, 2e6]]);
      X.C.entetesCasses = true;
      const r6 = await pas([[Q5, PAIRE, 2e6]]);
      X.C.entetesCasses = false;
      ok(r6.msg.length === 1, 'R8 en-tete illisible : la paper hand part quand meme');
      egal(ligneE(papier(r6).texte), `📥 Entry · ${lienT(r5.h, 'bought')}`, 'R8 en-tete illisible : le lien, aucune heure inventee');
      ok(IX.etat().compteurs.heuresEntreeIllisibles >= 1, 'R8 l echec est compte');
    }

    /* --- R9 un etat au schema 3 (l heure seule) est reconstruit UNE fois et recoit tx, comment, origine --- */
    {
      const { W: X, pas } = await scene();
      const P = N(360), Q = N(361);
      const r1 = await pas([[PAIRE, P, 3e6]]);
      const r2 = await pas([[P, Q, 2e6]]);
      const f = lit(X.dossier);
      f.schema = 3;
      for (const a of Object.keys(f.tenue)) f.tenue[a] = f.tenue[a].t;
      fs.writeFileSync(path.join(X.dossier, 'communaute.json'), JSON.stringify(f));
      const I2 = X.fabrique();
      ok(typeof I2.etat().tenue[Q] === 'number', 'R9 l ancien etat se lit (des nombres)');
      X.C.now += 30 * MIN;
      const [r] = await muet(() => I2.tic());
      const s = I2.etat(), eQ = s.tenue[Q] || {}, eP = s.tenue[P] || {};
      ok(r.fait === 'construit' && M.SCHEMA === 4 && s.schema === 4 && s.compteurs.migrations === 1, 'R9 schema 3 : reconstruit une fois : ' + JSON.stringify(r).slice(0, 60));
      ok(eP.h === r1.h && eP.comment === 'achat' && eQ.h === r2.h && eQ.comment === 'envoi' && eQ.de === P && eQ.origine && eQ.origine.h === r1.h,
         'R9 apres reconstruction : tx, comment et origine poses depuis la frappe : ' + JSON.stringify(eQ));
      ok((lit(X.dossier).tenue[Q] || {}).h === r2.h, 'R9 et ecrits sur le disque');
      /* hors de la fenetre des recus (8 jours), la construction classe sans recu : E1 a achete le 20/09 a la
         paire (piscine de marche par son autre jeton) ; E1 → LP le 09/10 est un envoi qui porte cet achat */
      const eE1 = s.tenue[E1] || {}, eLP = s.tenue[LP] || {};
      ok(eE1.comment === 'achat' && eE1.b === X.C.blocA(Date.parse('2026-09-20T10:00:00Z')) && eLP.comment === 'envoi' && eLP.de === E1 && eLP.origine && eLP.origine.h === eE1.h,
         'R9 l achat d avant la fenetre (E1, 20/09) est un achat, et l origine de l envoi E1 → LP : ' + JSON.stringify(eLP));
      X.C.now += 70 * MIN;
      const [r2b] = await muet(() => I2.tic());
      ok(r2b.fait !== 'construit' && I2.etat().compteurs.migrations === 1, 'R9 au tic suivant : pas de seconde reconstruction');
    }

    /* --- R11 hors de la fenetre des recus, une CONVERSION ($SWOGEBET → $SWOGE a la v3) n est pas un achat --- */
    {
      const Q = N(380), quand = Date.parse('2026-09-25T12:00:00Z');
      let hC = null;
      const { W: X, I: IX, pas } = await scene({ avant: (C) => { hC = C.tx(quand, [[V3, Q, 2e6]]); } });
      const e = IX.etat().tenue[Q] || {};
      ok(e.h === hC && !('comment' in e), 'R11 la conversion du 25/09 (hors fenetre) : l entree garde sa tx, sans « achat » : ' + JSON.stringify(e));
      egal(ligneE(papier(await pas([[Q, PAIRE, 2e6]])).texte), `📥 In since ${heureBloc(X.C, blocTx(X.C, hC))} · ${lienT(hC, 'tx')}`,
           'R11 la ligne : l heure et la tx, jamais « bought » pour une conversion');
    }

    /* --- R10 la longueur au pire : les deux lignes les plus longues (deux sauts, un autre wallet a l origine ;
       un saut, l envoyeur ayant achete plusieurs fois — « and N more times »), la vente melee (la ligne de
       gain/perte la plus longue), un reste, puis chaque champ chiffre a sa largeur maximale : sous les 1 024
       signes de la legende --- */
    for (const forme of ['deux sauts', 'un saut, plusieurs achats']) {
      const { W: X, pas } = await scene();
      const A_ = N(370), B = N(371), Q = N(372), Z = N(373);
      if (forme === 'deux sauts') {
        await pas([[PAIRE, A_, 3000999]]);
        await pas([[A_, B, 3000999]]);
      } else {
        await pas([[PAIRE, B, 1000999]]);
        await pas([[PAIRE, B, 1e6]]);
        await pas([[PAIRE, B, 1e6]]);
      }
      await pas([[B, Q, 3000999]]);
      const m = papier(await pas([[Q, PAIRE, 2e6], [Q, Z, 1e6]]));
      const l = ligneE(m.texte) || '';
      const decor = forme === 'deux sauts' ? /<\/a> · <a [^>]*>bought on [^<]*<\/a> by <a /.test(l) : /, who <a [^>]*>bought on [^<]*<\/a> and 2 more times$/.test(l);
      ok(decor && /tokens also sent elsewhere/.test(m.texte) && /\(kept 999\)/.test(m.texte), `R10 le decor (${forme}), vente melee, un reste : ` + m.texte.split('\n').slice(1, 4).join(' | '));
      const lignes = m.texte.split('\n');
      const comm = lignes.filter((x) => /^(👥|🌊|🛒)/.test(x)).join('\n');
      const commMax = '👥 99999 holders (+99999 in 24h) · 🆕 9999 new today\n🌊 100.0% held by wallets · pools: 99.9% ETH · 99.9% $SWOGEBET · 99.9% other\n🛒 999M $SWOGE available to buy in the ETH pools';
      /* au pire : la ligne de communaute la plus large, deux annees ecrites (« , 2026 » × 2), un montant et un
         $ plus larges (« 999M », « ~$999,999 »), la plus longue des phrases (80 signes au plus, P1) et, pour
         un saut, un compte d achats a 6 chiffres (« 999999 » contre « 2 ») */
      const pire = visibleT(m.texte) - visibleT(comm) + visibleT(commMax) + 2 * ', 2026'.length + 12 + 80 + (forme === 'deux sauts' ? 0 : 5);
      ok(pire <= 1024, `R10 (${forme}) le message entier au pire : ${pire} signes visibles (mesure ${visibleT(m.texte)}, ligne 📥 ${visibleT(l)}) <= 1 024`);
      console.log(`  R10 (${forme}) : au pire ${pire}, mesure ${visibleT(m.texte)}, ligne 📥 ${visibleT(l)}`);
    }

    /* --- R12 (relecture du 13/10, E1) deux sauts : l origine n est reprise que pour un sac ENTIER recu et
       renvoye. Le cas reel du 07/08 : 0x176a… entre par 35 097 jetons de 0x1d1c…, achete lui-meme 757 728,
       envoie le tout a 0x838a… qui vend ; l annonce nommait 0x2197… (l acheteur d origine de 0x1d1c…) pour un
       sac achete a 95,6 % par 0x176a…. La ligne de C s arrete a « received from B » : ni A, ni « bought » --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const A_ = N(390), B = N(391), C_ = N(392);
      await pas([[PAIRE, A_, 3e6]]);
      await pas([[A_, B, 35097.57]]);
      await pas([[PAIRE, B, 757728]]);
      const eB = IX.etat().tenue[B] || {};
      ok(eB.comment === 'envoi' && eB.de === A_ && eB.origine && eB.origine.part === 'entiere' && eB.n === 1 && eB.q === '35097570000000000000000',
         'R12 B : recu de A (35 097,57, sac de A couvert), puis UN achat compte : ' + JSON.stringify(eB));
      const r4 = await pas([[B, C_, 792825.57]]);
      const eC = IX.etat().tenue[C_] || {};
      ok(eC.comment === 'envoi' && eC.de === B && !('origine' in eC), 'R12 C : recu de B, sans origine (B n avait recu que 35k de A) : ' + JSON.stringify(eC));
      const l = ligneE(papier(await pas([[C_, PAIRE, 792825.57]])).texte) || '';
      egal(l, `📥 In since ${heureBloc(X.C, blocTx(X.C, r4.h))} · ${lienT(r4.h, 'received')} from ${lienA(B)}`, 'R12 la ligne de C : « received from B », et rien de plus');
      ok(!l.includes(A_) && !/bought|first/.test(l), 'R12 ni A, ni « bought », ni « first » : ' + l);
    }

    /* --- R12b (relecture du 13/10, E1) deux sauts : un sac que l achat d origine ne couvrait pas (A a achete
       deux fois avant d envoyer : « and 1 more time » a un saut) ne se reprend pas plus loin. La ligne de C
       s arrete a « received from B » --- */
    for (const cas of ['deux achats', 'un achat et un envoi recu']) {
      const { W: X, I: IX, pas } = await scene();
      const A_ = N(385), B = N(386), C_ = N(387);
      await pas([[PAIRE, A_, 1e6]]);
      await pas(cas === 'deux achats' ? [[PAIRE, A_, 1e6]] : [[E1, A_, 1e6]]);
      await pas([[A_, B, 2e6]]);
      const oB = (IX.etat().tenue[B] || {}).origine || {};
      ok(oB.qui === A_ && oB.part === (cas === 'deux achats' ? 'achats' : 'partie'), `R12b (${cas}) B : l origine de A, sa part : ` + JSON.stringify(oB));
      const r4 = await pas([[B, C_, 2e6]]);
      const eC = IX.etat().tenue[C_] || {};
      ok(eC.comment === 'envoi' && eC.de === B && !('origine' in eC), `R12b (${cas}) C : recu de B, sans origine reprise : ` + JSON.stringify(eC));
      const l = ligneE(papier(await pas([[C_, PAIRE, 2e6]])).texte) || '';
      egal(l, `📥 In since ${heureBloc(X.C, blocTx(X.C, r4.h))} · ${lienT(r4.h, 'received')} from ${lienA(B)}`, `R12b (${cas}) la ligne de C : « received from B », sans « by A »`);
    }

    /* --- R13 (relecture du 13/10, E2) un saut : « who bought on X » seulement si l achat lie couvre l envoi
       (R3) ; l envoyeur a achete plusieurs fois pendant sa tenue et ses achats couvrent l envoi : « and N more
       times » ; son sac a ete complete autrement (un envoi recu) : « bought part of it ». Mesure : 54, 82 et 1
       des 137 entrees a un saut de l histoire ; avant, le lien montrait le premier achat seul dans 83 cas --- */
    for (const cas of ['trois achats', 'un achat et un envoi recu', 'deux achats et un envoi recu']) {
      const { W: X, I: IX, pas } = await scene();
      const P = N(395), Q = N(396);
      const r1 = await pas([[PAIRE, P, 1e6]]);
      if (cas === 'trois achats') { await pas([[PAIRE, P, 1e6]]); await pas([[PAIRE, P, 1e6]]); }
      else if (cas === 'un achat et un envoi recu') await pas([[E1, P, 2e6]]);
      else { await pas([[PAIRE, P, 1e6]]); await pas([[E1, P, 2e6]]); }
      const tot = cas === 'deux achats et un envoi recu' ? 4e6 : 3e6;
      const r3 = await pas([[P, Q, tot]]);
      const o = (IX.etat().tenue[Q] || {}).origine || {};
      ok(o.h === r1.h && o.qui === P && o.part === (cas === 'trois achats' ? 'achats' : 'partie') && (cas !== 'trois achats' || o.n === 2),
         `R13 (${cas}) l origine : le premier achat de P, et sa part : ` + JSON.stringify(o));
      const l = ligneE(papier(await pas([[Q, PAIRE, tot]])).texte) || '';
      const achat = (mots) => lienT(r1.h, `${mots} on ${heureBloc(X.C, blocTx(X.C, r1.h))}`);
      const fin = cas === 'trois achats' ? `, who ${achat('bought')} and 2 more times` : `, who ${achat('bought part of it')}`;
      egal(l, `📥 In since ${heureBloc(X.C, blocTx(X.C, r3.h))} · ${lienT(r3.h, 'received')} from ${lienA(P)}${fin}`, `R13 (${cas}) la ligne`);
    }

    /* --- R14 (relecture du 13/10, A2) la maison et les exclus du JOUR : l envoyeur et l acheteur d origine
       repassent par personne() au moment d annoncer. Une adresse devenue maison apres l entree (deps.maison :
       inscription, deployeur V4 cree plus tard) ou ajoutee a TG_COMMUNAUTE_EXCLUS au redeploiement — le seul
       reglage du proprietaire pour cacher une adresse — n est jamais nommee, comme dans les liens (groupe) --- */
    {
      const maisonDyn = [MAISON];
      const { W: X, pas } = await scene({ plus: { maison: () => maisonDyn } });
      const Hm = N(400), Q = N(401);
      await pas([[PAIRE, Hm, 3e6]]);
      const r2 = await pas([[Hm, Q, 3e6]]);
      maisonDyn.push(Hm);
      const l = ligneE(papier(await pas([[Q, PAIRE, 3e6]])).texte) || '';
      egal(l, `📥 In since ${heureBloc(X.C, blocTx(X.C, r2.h))} · ${lienT(r2.h, 'tx')}`, 'R14 envoyeur devenu maison : l heure et la tx, jamais son adresse');
    }
    {
      const { W: X, pas } = await scene();
      const A_ = N(402), B = N(403), C_ = N(404);
      await pas([[PAIRE, A_, 3e6]]);
      await pas([[A_, B, 3e6]]);
      const r3 = await pas([[B, C_, 3e6]]);
      const I2 = X.fabrique({ TG_COMMUNAUTE_EXCLUS: A_ });
      const l = ligneE(papier(await pas([[C_, PAIRE, 3e6]], { inst: I2 })).texte) || '';
      egal(l, `📥 In since ${heureBloc(X.C, blocTx(X.C, r3.h))} · ${lienT(r3.h, 'received')} from ${lienA(B)}`,
           'R14 l acheteur d origine ajoute aux exclus au redeploiement : « received from B », sans « by A »');
    }

    /* --- R15 (relecture du 13/10, A3) un en-tete invraisemblable n ecrit aucune date : mauvais numero de bloc,
       horodatage 0 (« Jan 1, 1970 »), demesure (« NaN »), illisible, a 3 h de l heure gardee ; a 1 h 50 il est
       lu (l ecart mesure va jusqu a 54 min, la borne est a 2 h) --- */
    for (const [nom, faux, lu] of [
      ['mauvais numero', (C, b) => ({ number: hex(b + 1), timestamp: hex(Math.floor(C.tDe(b) / 1000)) }), false],
      ['horodatage 0', (C, b) => ({ number: hex(b), timestamp: '0x0' }), false],
      ['horodatage demesure', (C, b) => ({ number: hex(b), timestamp: '0xffffffffffffff' }), false],
      ['horodatage illisible', (C, b) => ({ number: hex(b), timestamp: 'demain' }), false],
      ['a 3 h de l heure gardee', (C, b) => ({ number: hex(b), timestamp: hex(Math.floor(C.tDe(b) / 1000) + 3 * 3600) }), false],
      ['a 1 h 50 de l heure gardee', (C, b) => ({ number: hex(b), timestamp: hex(Math.floor(C.tDe(b) / 1000) + 110 * 60) }), true]]) {
      const { W: X, I: IX, pas } = await scene();
      const Q = N(405);
      const r1 = await pas([[PAIRE, Q, 2e6]]);
      const ill0 = IX.etat().compteurs.heuresEntreeIllisibles || 0;
      X.C.entetesFaux = (b) => faux(X.C, b);
      const r = await pas([[Q, PAIRE, 2e6]]);
      X.C.entetesFaux = null;
      const bQ = blocTx(X.C, r1.h);
      const attendu = lu ? `📥 In since ${heureBloc({ tDe: (b) => X.C.tDe(b) + 110 * 60000 }, bQ)} · ${lienT(r1.h, 'bought')}` : `📥 Entry · ${lienT(r1.h, 'bought')}`;
      ok(r.msg.length === 1, `R15 (${nom}) la paper hand part`);
      egal(ligneE(papier(r).texte), attendu, `R15 (${nom}) la ligne`);
      ok(((IX.etat().compteurs.heuresEntreeIllisibles || 0) - ill0) === (lu ? 0 : 1), `R15 (${nom}) ${lu ? 'aucun echec compte' : 'l echec est compte'}`);
    }

    /* --- R16 (relecture du 13/10, A4) la lecture des en-tetes est COURTE (LECTURE_COURTE) : un noeud en
       panne (503) coute 2 essais et 2 s de recul, jamais les 5 essais et les 155 s de recul de rpcBrut (avec
       un noeud qui pend : ~455 s par paper hand, 4 par tic) ; l annonce part, la ligne sans heure --- */
    {
      const doses = [];
      const { W: X, I: IX, pas } = await scene({ plus: { dors: async (ms) => { doses.push(ms); } } });
      const Q = N(410);
      const r1 = await pas([[PAIRE, Q, 2e6]]);
      const d0 = doses.length, a0 = X.C.appels.length, ill0 = IX.etat().compteurs.heuresEntreeIllisibles || 0;
      /* la pointe (« latest ») passe, les en-tetes tombent en 503 sans JSON */
      X.C.panne503 = 9; X.C.panne503Methode = 'eth_getBlockByNumber'; X.C.panne503Saute = 1;
      const r = await pas([[Q, PAIRE, 2e6]]);
      X.C.panne503 = 0; X.C.panne503Methode = null; X.C.panne503Saute = 0;
      const pannes = X.C.appels.slice(a0).filter((m) => m === '503').length, reculs = doses.slice(d0).filter((ms) => ms >= M.RECUL_429_MS);
      ok(r.msg.length === 1, 'R16 en-tetes en panne : la paper hand part');
      egal(ligneE(papier(r).texte), `📥 Entry · ${lienT(r1.h, 'bought')}`, 'R16 la ligne garde son lien, sans heure');
      ok(pannes === M.LECTURE_COURTE.essais && M.LECTURE_COURTE.essais === 2 && !reculs.length && doses.slice(d0).includes(M.LECTURE_COURTE.reculMs),
         `R16 ${M.LECTURE_COURTE.essais} essais et ${M.LECTURE_COURTE.reculMs} ms de recul, aucun recul de ${M.RECUL_429_MS} ms ou plus : ${pannes} essais, reculs ${JSON.stringify(reculs)}`);
      ok(M.LECTURE_COURTE.delaiMs <= 10000, 'R16 le delai d un essai : 10 s au plus (' + M.LECTURE_COURTE.delaiMs + ' ms)');
      ok((IX.etat().compteurs.heuresEntreeIllisibles || 0) === ill0 + 1, 'R16 l echec est compte');
    }

    /* --- R17 (relecture du 13/10, A5) des frais pris dans la VENTE d une personne : P paie le routeur, qui
       paie la paire et 10 000 au portefeuille de frais F. Une piscine est dans la tx : F n a ni « bought » ni
       « received from » P (le mutant qui ote la condition de piscine survivait a la suite) --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const P = N(420), F = N(421);
      await pas([[PAIRE, P, 5e6]]);
      const rv = await pas([[P, ROUTEUR, 5e6], [ROUTEUR, PAIRE, 4.99e6], [ROUTEUR, F, 1e4]]);
      const e = IX.etat().tenue[F] || {};
      ok(e.h === rv.h && !('comment' in e) && !('de' in e) && !('origine' in e), 'R17 F : l entree garde sa tx, sans comment, envoyeur ni origine : ' + JSON.stringify(e));
    }

    /* --- R18 (relecture du 13/10, A5) l en-tete ne se lit que pour une paper hand qui PART : sous les 25 $,
       aucun eth_getBlockByNumber hors de la pointe ; au-dessus, la pointe et UN en-tete (une entree par achat
       n a pas d origine). La promesse « ~2,7 lots par jour, rien pour celles que les seuils taisent » --- */
    {
      const { W: X, I: IX, pas } = await scene();
      const Q = N(430), Q2 = N(431);
      await pas([[PAIRE, Q, 1e5]]);                       // 4,58 $ : le New holder se tait aussi
      const lus0 = IX.etat().compteurs.heuresEntreeLues || 0, tus0 = IX.etat().compteurs.sousSeuil_paper || 0;
      const a0 = X.C.appels.length;
      const r = await pas([[Q, PAIRE, 1e5]]);
      const entetes = X.C.appels.slice(a0).filter((m) => m === 'eth_getBlockByNumber').length;
      ok(r.msg.length === 0 && (IX.etat().compteurs.sousSeuil_paper || 0) === tus0 + 1, 'R18 la paper hand de 4,58 $ est tue par le seuil');
      ok(entetes === 1 && (IX.etat().compteurs.heuresEntreeLues || 0) === lus0, `R18 sous le seuil : la pointe seule, aucun en-tete d entree (${entetes} eth_getBlockByNumber)`);
      await pas([[PAIRE, Q2, 2e6]]);
      const a1 = X.C.appels.length;
      const r2 = await pas([[Q2, PAIRE, 2e6]]);
      const entetes2 = X.C.appels.slice(a1).filter((m) => m === 'eth_getBlockByNumber').length;
      ok(r2.msg.length === 1 && entetes2 === 2 && (IX.etat().compteurs.heuresEntreeLues || 0) === lus0 + 1, `R18 au-dessus : la pointe et un en-tete (${entetes2})`);
    }
    process.env.TZ = TZ0 === undefined ? '' : TZ0;
    if (TZ0 === undefined) delete process.env.TZ;
  }

  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`communaute.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
