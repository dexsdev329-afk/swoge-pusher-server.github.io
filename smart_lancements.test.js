'use strict';
/*
 * Le brief v2 du proprietaire (15/10/2026, apres JUDGEBOT) : lancements Pons et
 * IGNITION lus sur la chaine, devs connus, T+2, copie, rebond, promo
 * DexScreener (smart_pons.js, smart_lancements.js, branches dans smart_money.js).
 *
 * Un faux noeud aux regles du vrai (essais/smart_money/faux_noeud.js), un faux
 * Relay, un faux DexScreener. L'intention :
 *  0. les regles pures : chaque seuil du brief a ses bornes ; les topics sont
 *     ceux que la chaine emet (keccak et vrais journaux de JUDGEBOT) ;
 *  1. JUDGEBOT REJOUE sur les vrais blocs de son lancement (sonde du 15/10) :
 *     la nouvelle methode l'aurait signale, a quelle heure, au proprietaire
 *     SEUL, et a la colonie comme signal OBSERVE ;
 *  2. le dev qui achete >= 2 ETH, la plateforme, les relais, les mauvais signes ;
 *  3. le T+2 : bon signe, et le dev qui vend = sortir ;
 *  4. IGNITION : son usine, les contrats de son wallet, les wallets finances
 *     par Relay, la signature des copieurs ;
 *  5. la copie (sections 4 et 6) : exclusions, tx.from, airdrop
 *     multi-destinataires, seuils, une voix par groupe, Sniper 1 et sa fenetre ;
 *  6. le rebond (section 7) ;
 *  7. budget, rattrapage borne, interrupteurs, pannes de Relay et de
 *     DexScreener, lecture seule.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { utils } = require('ethers');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) { n++; console.log('  ok   ' + m); } else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || String(a) === String(b), `${m} (lu ${a}, attendu ${b})`);
async function muet(fn) { const lignes = []; const l = console.log; console.log = (...a) => lignes.push(a.join(' ')); try { return [await fn(), lignes]; } finally { console.log = l; } }
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-lancements-'));
delete process.env.ANTHROPIC_API_KEY;

const SP = require('./smart_pons');
const SLZ = require('./smart_lancements');
const SL = require('./smart_listes');
const SR = require('./smart_rpc');
const M = require('./smart_money');
const { fauxNoeud, journal, pad } = require('./essais/smart_money/faux_noeud');
const FIX = require('./essais/smart_money/judgebot_rejeu.json');

const A = (s) => '0x' + s.repeat(40 / s.length).slice(0, 40);
const E18 = 10n ** 18n;
const eth = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const J = '0xa922cdffb07148313103ed10c3c44603acbc3da4';
const CRAWL = '0x58ea497c16422a344a50785f6f23ca92082e2e03';
const SNIPER = '0x7632bd8e72767ed67a724c564c42ceea98e81180';
const SLOT0 = '0x000000000000000000000000000000000000000000033f4627501fdd572fe565' + 'f'.repeat(58) + 'cf98a' + '0'.repeat(62) + '49' + '0'.repeat(60) + '2a39' + '0'.repeat(64 * 3);
const abi = utils.defaultAbiCoder;
const chaine = (s) => abi.encode(['string'], [s]);
const socials = (x) => abi.encode(['string', 'string', 'string', 'string', 'string'], [x || '', '', '', '', '']);

// ------------------------------------------------------------ un monde ecrit par l'essai
function monde(o) {
  o = o || {};
  const w = { logs: [], txs: {}, metas: {}, codes: {}, taxes: {}, nonce: o.nonce == null ? 91 : o.nonce, pointe: o.pointe || 1000000, idx: 1, ds: o.ds || {}, relay: o.relay || {}, relayPanne: false, dsPanne: false };
  w.tx = (h, t) => { w.txs[h] = Object.assign({ hash: h, value: '0x0', gas: '0x58c1c0', maxFeePerGas: '0x1dcd650' }, t); };
  w.lance = (x) => {   // un lancement Pons : jeton, courbe, dep, bloc, h, cote, seuil, from, to, value, devAchat (ETH), exemptions
    const h = x.h || '0x' + (w.idx++).toString(16).padStart(64, 'a');
    w.logs.push(journal(SP.ADR.USINE_PONS, [SP.TOPIC.LANCE_PONS, pad(x.jeton), pad(x.courbe), pad(x.dep)], [BigInt(x.cote || 0), 0n, x.seuil == null ? eth(4.2) : x.seuil], x.bloc, h, w.idx++));
    for (let k = 0; k < (x.exemptions == null ? 2 : x.exemptions); k++) w.logs.push(journal(x.courbe, [SP.TOPIC.EXEMPTION, pad(x.dep)], [], x.bloc, h, w.idx++));
    if (x.devAchat) w.logs.push(journal(x.courbe, [SP.TOPIC.ACHAT, pad(SP.ADR.ENTREE_PONS), pad(x.dep)], [eth(x.devAchat), 10n ** 24n, 0n, 0n], x.bloc, h, w.idx++));
    w.tx(h, { from: x.from || x.dep, to: x.to || SP.ADR.ENTREE_PONS, value: '0x' + (x.value != null ? eth(x.value) : eth((x.devAchat || 0) + 0.0005)).toString(16), gas: x.gas, maxFeePerGas: x.maxFee, blockNumber: '0x' + x.bloc.toString(16) });
    w.taxes[x.courbe] = x.taxeBps == null ? 200 : x.taxeBps;       // creatorTaxBps() de la courbe (JUDGEBOT : 200)
    w.metas[x.jeton] = x.meta === null ? null : Object.assign({ logo: 'ipfs://bafy', x: 'https://x.com/projet', description: 'un projet', symbole: x.sym || 'TOK' }, x.meta || {});
    return h;
  };
  w.achat = (courbe, de, vers, montant, bloc, o2) => { const h = (o2 && o2.h) || '0x' + (w.idx++).toString(16).padStart(64, 'b'); w.logs.push(journal(courbe, [SP.TOPIC.ACHAT, pad(de), pad(vers)], [eth(montant), (o2 && o2.jetons) || 10n ** 24n, 0n, 0n], bloc, h, w.idx++)); if (!w.txs[h]) w.tx(h, { from: (o2 && o2.from) || vers, to: courbe }); return h; };
  w.vente = (courbe, de, vers, montant, bloc) => { const h = '0x' + (w.idx++).toString(16).padStart(64, 'c'); w.logs.push(journal(courbe, [SP.TOPIC.VENTE, pad(de), pad(vers)], [10n ** 23n, eth(montant), 0n, 0n], bloc, h, w.idx++)); w.tx(h, { from: de, to: courbe }); return h; };
  w.ignition = (x) => { const h = '0x' + (w.idx++).toString(16).padStart(64, 'd'); w.logs.push(journal(x.usine, [SP.TOPIC.LANCE_IGNITION, pad(x.jeton), pad(x.crochet || A('44'))], [BigInt(x.createur), 10n ** 27n, 10n ** 15n], x.bloc, h, w.idx++)); w.tx(h, { from: x.from || x.createur, to: x.usine }); w.metas[x.jeton] = { logo: x.logo || 'ipfs://i', x: 'https://x.com/ign', description: 'ign', symbole: 'IGN' }; return h; };
  const surRequete = (q) => {
    const rep = (result) => ({ jsonrpc: '2.0', id: q.id, result });
    if (q.method === 'eth_getTransactionCount') return rep('0x' + w.nonce.toString(16));
    if (q.method === 'eth_getCode') return rep(w.codes[String(q.params[0]).toLowerCase()] || '0x');
    if (q.method === 'eth_call') {
      const to = String(q.params[0].to).toLowerCase(), d = q.params[0].data;
      if (to === SP.ADR.REF_ETH_USDG && d === SP.SELECTEUR.SLOT0) return rep(SLOT0);
      if (d === SP.SELECTEUR.CREATOR_TAX && w.taxes[to] != null) return rep('0x' + w.taxes[to].toString(16).padStart(64, '0'));
      const m = w.metas[to];
      if (m) {
        if (d === SP.SELECTEUR.LOGO) return rep(chaine(m.logo));
        if (d === SP.SELECTEUR.SOCIALS) return rep(socials(m.x));
        if (d === SP.SELECTEUR.DESCRIPTION) return rep(chaine(m.description));
        if (d === SP.SELECTEUR.SYMBOL) return rep(chaine(m.symbole));
      }
      if (w.codes[to] && d === SP.SELECTEUR.SYMBOL && w.symboles && w.symboles[to]) return rep(chaine(w.symboles[to]));
      return { jsonrpc: '2.0', id: q.id, error: { code: 3, message: 'execution reverted' } };
    }
    return null;
  };
  w.F = fauxNoeud({ logs: () => w.logs, pointe: () => w.pointe, txs: w.txs, surRequete, pannes: o.pannes });
  w.dsAppels = []; w.relayAppels = []; w.autres = [];
  const reponse = (status, j) => ({ status, ok: status === 200, headers: { get: () => null }, text: async () => (typeof j === 'string' ? j : JSON.stringify(j)) });
  w.prendre = async (url, init) => {
    const u = String(url);
    if (u.startsWith(SR.URL_DEFAUT)) return w.F.prendre(u, init);
    if (u.startsWith(SLZ.DS_ORDERS)) { w.dsAppels.push(u); if (w.dsPanne) return reponse(500, 'oops'); return reponse(200, w.ds[u.slice(SLZ.DS_ORDERS.length).toLowerCase()] || { orders: [], boosts: [] }); }
    if (u.startsWith(SLZ.RELAY_URL)) { w.relayAppels.push(u); if (w.relayPanne) return reponse(429, 'Too Many Requests'); const user = /user=([^&]+)/.exec(u)[1]; return reponse(200, { requests: w.relay[user] || [], continuation: null, deprecation: { sunsetAt: '2026-11-24T00:00:00Z' } }); }
    w.autres.push(u); throw new Error('requete inattendue : ' + u);
  };
  return w;
}
/** Une instance du module sur ce monde : base en memoire (meta JSON), envois notes. */
function instance(w, o) {
  o = o || {};
  const meta = new Map();
  const B = { meta(k, v) { if (v === undefined) return meta.has(k) ? JSON.parse(meta.get(k)) : null; meta.set(k, JSON.stringify(v, (kk, x) => (typeof x === 'bigint' ? x.toString() : x))); }, pose() {}, sauve() {} };
  const T = { now: o.now || 1792000000000 };
  const R = SR.cree({ prendre: w.prendre, horloge: () => T.now, dors: async (ms) => { T.now += ms; }, budgetAppels: o.budgetAppels || SLZ.CYCLE_APPELS, budgetOctets: SLZ.CYCLE_OCTETS, jourPropre: true });
  const envoyes = [], signaux = [];
  const vus = new Set();
  const LZ = SLZ.cree({ R, B, horloge: () => T.now, dors: async (ms) => { T.now += ms; }, prendre: w.prendre, env: o.env || {}, explorer: 'https://robinhoodchain.blockscout.com',
    envoie: async (genre, cle, jeton, texte) => { if (vus.has(cle)) return false; vus.add(cle); envoyes.push({ genre, cle, jeton, texte, t: T.now }); return true; },
    note: (g, t) => { (o.notes || []).push(g + ' ' + t); }, faits: o.faits, surSignal: (v) => signaux.push(v), exclu: o.exclu });
  return { LZ, B, T, R, envoyes, signaux };
}

(async () => {
  // ================================================== 0. les regles pures
  console.log('-- 0. les topics, le decodage, les seuils --');
  {
    egal(utils.id('TokenLaunched(address,address,address,address,uint256,uint256)'), SP.TOPIC.LANCE_PONS, 'keccak de TokenLaunched (Pons) = le topic0 du brief');
    egal(utils.id('TokenLaunched(address,address,address,uint256,uint256)'), SP.TOPIC.LANCE_IGNITION, 'keccak de TokenLaunched (IGNITION) = le topic0 du brief');
    egal(utils.id('CurveBuy(address,address,uint256,uint256,uint256,uint256)'), SP.TOPIC.ACHAT, 'CurveBuy : le nom du bytecode (openchain) redonne le topic retrouve dans les journaux');
    egal(utils.id('CurveSell(address,address,uint256,uint256,uint256,uint256)'), SP.TOPIC.VENTE, 'CurveSell : idem');
    egal(utils.id('SnipeTaxExempted(address)'), SP.TOPIC.EXEMPTION, 'SnipeTaxExempted : idem');
    egal(utils.id('CurveCompleted(address,uint256,uint256)'), SP.TOPIC.GRADUATION_COURBE, 'la graduation : CurveCompleted (et non CreatorFeeRecipientUpdated 0x2cc664e1…)');
    egal(utils.id('creatorTaxBps()').slice(0, 10), SP.SELECTEUR.CREATOR_TAX, 'creatorTaxBps() : le selecteur');
    ok(SP.decodeCourbe({ address: A('cd'), topics: [SP.TOPIC.GRADUATION_COURBE], data: '0x' + '0'.repeat(192), blockNumber: '0x1', transactionHash: '0x' + '1'.repeat(64), logIndex: '0x0' }).genre === 'graduation', 'CurveCompleted (sans topic indexe) : decode comme graduation');
    const topics0 = new Set(FIX.courbe.map((l) => l.topics[0]).concat(FIX.recu.logs.map((l) => l.topics[0])));
    ok(SP.TOPIC.ACHAT.startsWith('0xec36bf57') && topics0.has(SP.TOPIC.ACHAT), 'achat 0xec36bf57… : complet, lu dans les vrais journaux de la courbe de JUDGEBOT');
    ok(SP.TOPIC.VENTE.startsWith('0x8113d738') && topics0.has(SP.TOPIC.VENTE), 'vente 0x8113d738… : idem');
    ok(SP.TOPIC.EXEMPTION.startsWith('0xe4b7e48f') && topics0.has(SP.TOPIC.EXEMPTION), 'exemption 0xe4b7e48f… : idem (tx de lancement)');
    const l = FIX.usine.map(SP.decodeLancementPons).find((x) => x && x.jeton === J);
    ok(l && l.courbe === '0x3d74fc75a251e6c0456a1ed637350ae15f78b7d8' && l.deployer === CRAWL && l.cote === SP.ADR.ETH && l.seuil === eth(4.2) && l.bloc === FIX.lancementBloc,
      'TokenLaunched de JUDGEBOT : jeton, courbe (topic 2), deployer, cote ETH, seuil 4,2 ETH, bloc ' + (l && l.bloc));
    const achatDev = FIX.recu.logs.map(SP.decodeCourbe).find((e) => e && e.genre === 'achat');
    ok(achatDev && achatDev.destinataire === CRAWL && achatDev.cote === eth(0.028), 'le Buy du dev dans la tx de lancement : destinataire le dev, 0,028 ETH');
    egal(SP.versEth(BigInt(FIX.txs[FIX.recu.transactionHash].value)), 0.0285, 'tx.value = 0,0285 ETH : achat + droit de lancement de 0,0005');
    const so = SP.decodeSocials(socials('https://x.com/sopersone'));
    ok(so && so.length === 1 && SP.lienX(so) === 'https://x.com/sopersone', 'socials() : cinq chaines, le lien X lu');
    ok(Math.abs(SP.ethUsdDepuisSlot0(SLOT0) - 2455) < 1, 'ETH/USD lu dans slot0 de WETH/USDG : ' + SP.ethUsdDepuisSlot0(SLOT0));
    const d = (x) => SP.jugeLancement(Object.assign({ lancement: { plateforme: 'pons', deployer: A('d1'), cote: SP.ADR.ETH }, tx: { from: A('d1'), to: SP.ADR.ENTREE_PONS, value: '0x0' }, achatDevEth: 0.5, exemptions: 2,
      meta: { logo: 'ipfs://x', socials: ['https://x.com/a'] }, finances: new Set() }, x));
    egal(d({ achatDevEth: 1.99 }).alerte, false, 'dev a 1,99 ETH : pas d’alerte');
    ok(d({ achatDevEth: 2 }).alerte && d({ achatDevEth: 2 }).signaux[0].cle === 'dev_2eth', 'dev a 2 ETH : alerte (brief : >= 2 ETH)');
    ok(d({ lancement: { plateforme: 'pons', deployer: A('d1'), cote: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }, achatDevEth: 3 }).alerte === false, 'cote en USDG : le montant n’est pas de l’ETH, pas de « dev 2 ETH »');
    ok(d({ tx: { from: '0xd74321415c4ba41f07b6175739961b2b9865acd9', to: SP.ADR.ENTREE_PONS, value: '0x0' } }).devConnu.groupe === 'CrawlScan', 'dev connu par tx.from (le 2e wallet CrawlScan)');
    ok(d({ lancement: { plateforme: 'pons', deployer: '0x3f50f64ec6f233fc5cdfa2ed03b2d5de2a2b0722', cote: SP.ADR.ETH }, achatDevEth: 1 }).signaux.some((s) => s.cle === 'plateforme'), 'FOMOPAD (deployer) avec 1 ETH du dev : signal');
    ok(!d({ lancement: { plateforme: 'pons', deployer: A('d1'), cote: SP.ADR.ETH }, tx: { from: A('d1'), to: '0x1a66d8ecc2274fc8887ab386e35d7da981ba2f37', value: '0x0' }, achatDevEth: 0.9 }).alerte, 'Nosh (tx.to) avec 0,9 ETH du dev : pas de signal');
    const re = d({ lancement: { plateforme: 'pons', deployer: '0x8234222a80abebc5df729cf00ba7db0960a8724e', cote: SP.ADR.ETH } });
    ok(re.alerte && re.verdict === 'jaune' && /vendre vite/.test(re.risque), 'relais de l’usine a graduation : alerte jaune, « vendre vite »');
    const k = (x) => d(Object.assign({ lancement: { plateforme: 'pons', deployer: CRAWL, cote: SP.ADR.ETH } }, x));
    egal(k({}).verdict, 'vert', 'dev connu, achat 0,5 ETH, 2 exemptions, logo ipfs, lien X : vert');
    egal(k({ achatDevEth: 0.009 }).mauvais[0].cle, 'achat_dev_minuscule', 'achat de 0,009 ETH : minuscule (seuil choisi 0,01)');
    egal(k({ achatDevEth: 0 }).mauvais[0].texte, 'aucun achat du dev', 'aucun achat du dev');
    egal(k({ exemptions: 1 }).mauvais[0].cle, 'exemptions', '<= 1 exemption : mauvais signe');
    egal(k({ meta: { logo: 'https://axiomtrading-v2.axiom-cdn.io/x.png', socials: ['https://x.com/a'] } }).mauvais[0].cle, 'logo_sniper', 'logo axiom : mauvais signe');
    egal(k({ meta: { logo: 'https://pbs.twimg.com/x.jpg', socials: ['https://x.com/a'] } }).verdict, 'jaune', 'logo twimg : jaune');
    egal(k({ meta: { logo: 'ipfs://x', socials: ['https://t.me/x'] } }).mauvais[0].cle, 'pas_de_x', 'pas de lien X : mauvais signe');
    egal(k({ taxe: 6 }).mauvais[0].cle, 'taxe', 'taxe de 6 % : mauvais signe');
    egal(k({ taxe: 5 }).verdict, 'vert', 'taxe de 5 % : rien');
    egal(k({ devVend: true }).verdict, 'rouge', 'le dev vend : rouge');
    egal(k({ meta: null }).verdict, 'jaune', 'meta non lues : jamais vert (fail closed)');
    const t = (x) => SP.jugeT2(Object.assign({ acheteurs: 0, achete: 0n, ventesDev: 0, gradue: false }, x));
    egal(t({ acheteurs: 19, achete: eth(1.49) }).bon, false, 'T+2 : 19 acheteurs et 1,49 ETH : rien');
    egal(t({ acheteurs: 20 }).bon, true, 'T+2 : 20 acheteurs uniques : bon signe');
    egal(t({ achete: eth(1.5) }).bon, true, 'T+2 : 1,5 ETH achetes : bon signe');
    egal(SP.jugeT2({ acheteurs: 1, achete: eth(9), ventesDev: 0, gradue: false }, { coteEth: false }).bon, false, 'T+2 hors ETH : le montant ne compte pas');
    egal(t({ acheteurs: 30, gradue: true }).bon, false, 'T+2 : deja gradue, plus sur la courbe');
    egal(t({ ventesDev: 1 }).sortir, true, 'T+2 : le dev vend = sortir');
    /* sections 4 et 6 */
    const c = (x) => SP.filtreCopie(Object.assign({ wallet: '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', txFrom: '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', listeMemeTx: 1, usd: 100, capUsd: 50000, ageMin: 20, marche: true }, x));
    ok(c({}).garde, 'un achat de 100 $ a 50 k$ par 0x1ad70bc7, signe par lui : garde');
    ok(/excluded/.test(c({ wallet: '0x9c4d5bd19f9acfe75610860b17cf7471b7ce462a', txFrom: '0x9c4d5bd19f9acfe75610860b17cf7471b7ce462a' }).raison), 'un wallet de la section 5 : ne compte pas');
    ok(/excluded/.test(c({ wallet: '0x9bf265c742d96aacf1083ef24c9110240af0bea9', txFrom: '0x9bf265c742d96aacf1083ef24c9110240af0bea9' }).raison), '0x9bf265c7… (groupe de la section 4 ET exclu de la 5) : exclu, l’exclusion l’emporte');
    ok(/not sent by/.test(c({ txFrom: A('99') }).raison), 'tx.from different du wallet : ignore');
    ok(/airdrop/.test(c({ listeMemeTx: 2 }).raison), 'une tx vers 2 wallets de la liste : airdrop');
    ok(/under \$50/.test(c({ usd: 49 }).raison) && c({ usd: 50 }).garde, '49 $ : ignore ; 50 $ : garde');
    ok(/0\.02%/.test(c({ usd: 60, capUsd: 400000 }).raison) && c({ usd: 80, capUsd: 400000 }).garde, '60 $ sur 400 k$ (0,015 %) : ignore ; 80 $ (0,02 %) : garde');
    ok(/over \$1M/.test(c({ capUsd: 1000001, usd: 1000 }).raison), 'jeton a plus de 1 M$ : ignore');
    ok(/stablecoin/.test(c({ exclusJeton: 'stablecoin or ETH' }).raison), 'stablecoin : ignore');
    ok(/no market/.test(c({ marche: false }).raison), 'sans marche ni courbe active : ignore');
    const s1 = (x) => c(Object.assign({ wallet: SNIPER, txFrom: SNIPER }, x));
    ok(s1({ ageMin: 5, capUsd: 34999 }).garde && s1({ ageMin: 60, capUsd: 20000 }).garde, 'Sniper 1 a 5 et 60 min sous 35 k$ : garde');
    ok(!s1({ ageMin: 4.9 }).garde && !s1({ ageMin: 61 }).garde && !s1({ capUsd: 35000 }).garde, 'Sniper 1 a 4,9 min, 61 min, ou a 35 k$ : ignore');
    ok(c({}).inconnues.length === 0 && c({ usd: null }).garde && c({ usd: null }).inconnues.includes('usd'), 'un prix inconnu ne filtre pas mais se DIT (inconnue)');
    egal(SP.voix([{ voix: 'groupe1' }, { voix: 'groupe1' }, { voix: SNIPER }]), 2, 'groupe {0x3add, 0xc08a, 0x2091} : une seule voix');
    egal(SP.listeMemeTx([SNIPER, '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', A('12')]), 2, 'destinataires de la liste dans une meme tx : 2');
    /* section 7 */
    let e = null; const pas = (mc, liq) => { const r = SP.suitRebond(e, { mc, liq }); e = r.etat; return r.signal; };
    pas(100000); pas(51000); ok(e.creux === null, 'chute de 49 % : pas encore de creux');
    pas(50000); ok(e.creux === 50000, 'chute de 50 % : creux pose');
    pas(40000); egal(e.creux, 40000, 'nouveau creux');
    ok(!pas(47900, 9000), 'rebond de 19,75 % : rien');
    ok(!pas(48000, 7999), 'rebond de 20 % mais liquidite 7 999 $ : rien');
    const sg = pas(48000, 8000);
    ok(sg && sg.stop === 38000 && sg.chutePct === 60 && sg.rebondPct === 20, 'rebond de 20 % avec 8 000 $ : signal, stop 5 % sous le creux (38 000)');
    ok(!pas(60000, 9000), 'une seule fois');
    /* la promo */
    const now = 1792100000000;
    const p = SP.promo({ orders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: now - 3600e3 }, { type: 'tokenAd', status: 'approved', paymentTimestamp: now - 600e3 }], boosts: [{ amount: 30, paymentTimestamp: now - 1800e3 }, { amount: 10, paymentTimestamp: now - 3 * 86400e3 }] }, now);
    ok(p.profil && p.profil.recent && p.pubs.length === 1 && p.boosts === 2 && p.boostsRecents === 1 && p.pousse, 'orders/v1 : profil recent, une pub, deux boosts dont un en 24 h : « l’equipe pousse »');
    egal(SP.promoTexte(p, now), 'profil payé il y a 60 min · 1 pub (tokenAd) · 2 boosts, 1 en 24 h — l’équipe pousse (les arnaques paient aussi)', 'le texte de la promo');
    egal(SP.promo({ pairs: null }, now), null, 'une reponse d’une autre forme : non lue');
    /* le format */
    const tx = SP.texteAlerte({ verdict: 'vert', titre: 'LANCEMENT — dev connu : CrawlScan', symbole: 'JUDGEBOT', jeton: J, ageMin: 0.5, courbe: { eth: 0.028, seuilEth: 4.2 }, qui: ['deployer 0x58ea…2e03'],
      promo: { profil: null, pubs: [], boosts: 0, boostsRecents: 0, pousse: false }, risque: 'r', plan: SP.plan('vert'), lienX: 'https://x.com/sopersone' }, now);
    const lignes = tx.split('\n');
    ok(lignes[0] === '<b>🟢 LANCEMENT — dev connu : CrawlScan — JUDGEBOT</b>' && lignes[1] === '<code>' + J + '</code>', 'ligne 1 : verdict, titre, symbole ; ligne 2 : l’adresse entiere');
    ok(/^• Âge et état : 30 s · courbe 0,028 \/ 4,20 ETH \(1 %\)$/.test(lignes[2]), 'l’age et l’etat de la courbe : ' + lignes[2]);
    ok(lignes[3].startsWith('• Qui : ') && lignes[4] === '• Promo DexScreener : aucun profil payé · aucune pub · aucun boost' && lignes[5].startsWith('• Risque principal : '), 'qui, promo, risque');
    ok(/^• Plan : entrée petite mise fixe ; stop suiveur de 30 % ; objectif vendre 75 % à ×2, garder 25 % pour ×10$/.test(lignes[6]), 'le plan : entree, stop, objectif');
    ok(/x\.com\/sopersone/.test(lignes[8]) && tx.endsWith('Pas un conseil financier.'), 'la verification de l’adresse par la bio X, et « Pas un conseil financier. » a la fin');
    ok(!/<script/.test(SP.texteAlerte({ verdict: 'vert', titre: '<script>', symbole: '<b>x', jeton: J, qui: [], risque: '' }, now).replace(/<\/?(b|code|a)( [^>]*)?>/g, '')), 'les textes lus sur la chaine sont echappes');
  }

  // ================================================== 1. JUDGEBOT rejoue
  console.log('-- 1. JUDGEBOT rejoue sur les vrais blocs de son lancement (sonde du 15/10) --');
  const L0 = FIX.lancementBloc, t0 = FIX.horodatages[L0];
  const sPar = (FIX.horodatages[L0 + 6000] - t0) / 6000;      // 0,1012 s par bloc (sonde)
  const rejeu = async (phase) => {
    const w = monde();
    w.logs = FIX.usine.concat(FIX.courbe);
    Object.assign(w.txs, FIX.txs);
    w.metas[J] = { logo: 'ipfs://bafkreidt7bxxrc425fvksys4li5red76tbdciarpr6sfwdfj2ddvjyvzay', x: 'https://x.com/sopersone', description: 'A real time on chain smart money radar', symbole: 'JUDGEBOT' };
    const prives = [], publics = [], colonie = [];
    const T = { now: (t0 + phase) * 1000 };
    w.pointe = L0;
    const blocA = () => L0 + Math.floor((T.now / 1000 - t0) / sPar);
    const F = fauxNoeud({ logs: () => w.logs, pointe: () => blocA(), txs: w.txs, surRequete: (q) => (q.method === 'eth_getTransactionCount' ? { jsonrpc: '2.0', id: q.id, result: '0x5b' } : q.method === 'eth_call' && q.params[0].to === SP.ADR.REF_ETH_USDG ? { jsonrpc: '2.0', id: q.id, result: SLOT0 }
      : q.method === 'eth_call' && q.params[0].data === SP.SELECTEUR.CREATOR_TAX && String(q.params[0].to).toLowerCase() === '0x3d74fc75a251e6c0456a1ed637350ae15f78b7d8' ? { jsonrpc: '2.0', id: q.id, result: '0x' + (200).toString(16).padStart(64, '0') }
      : q.method === 'eth_call' && String(q.params[0].to).toLowerCase() === J ? { jsonrpc: '2.0', id: q.id, result: ({ [SP.SELECTEUR.LOGO]: chaine(w.metas[J].logo), [SP.SELECTEUR.SOCIALS]: socials(w.metas[J].x), [SP.SELECTEUR.DESCRIPTION]: chaine(w.metas[J].description), [SP.SELECTEUR.SYMBOL]: chaine('JUDGEBOT') })[q.params[0].data] } : null) });
    const prendre = async (u, init) => (String(u).startsWith(SR.URL_DEFAUT) ? F.prendre(u, init) : w.prendre(u, init));
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-judgebot-'));
    const I = M.cree({ env: { SMART_MONEY: '1', SMART_MONEY_HEURE: '23:59', SMART_RELAY: '0' }, prendre, horloge: () => T.now, dors: async (ms) => { T.now += ms; }, dossier, actions: async () => new Map(),
      tg: { notifyPrive: async (t) => { prives.push({ t: T.now, texte: t }); return true; }, notify: async (t) => { publics.push(t); return true; } }, surSignalV2: (v) => colonie.push(v), explorer: 'https://robinhoodchain.blockscout.com' });
    const cycles = [];
    for (let k = 0; k < 4; k++) { const debut = T.now; const [b] = await muet(() => I.lancements()); cycles.push(Object.assign({ debut }, b)); T.now = debut + 60000; }
    return { I, F, prives, publics, colonie, cycles, w };
  };
  {
    /* phase favorable : un cycle 30 s avant le lancement, le suivant 30 s apres */
    const r = await rejeu(-30);
    const al = r.prives[0];
    ok(al && al.texte.startsWith('<b>🟢 LANCEMENT — dev connu : CrawlScan — JUDGEBOT</b>'), 'JUDGEBOT : alerte VERTE « dev connu : CrawlScan »');
    const dt = al ? Math.round(al.t / 1000 - t0) : null;
    ok(dt !== null && dt >= 30 && dt <= 50, 'au cycle qui suit le lancement (un cycle dure ~11 s : 2 s entre appels legers, 3 s apres un lourd) : ' + new Date(t0 * 1000).toISOString().slice(11, 19) + ' UTC le lancement, ' + (al && new Date(al.t).toISOString().slice(11, 19)) + ' UTC l’alerte (+' + dt + ' s)');
    console.log('     REJEU ' + JSON.stringify({ lancement: new Date(t0 * 1000).toISOString(), alerte: al && new Date(al.t).toISOString(), ecart_s: dt }));
    const ec = al && /• Âge et état : (\d+) s · courbe ([0-9,]+) \/ 4,20 ETH \((\d+) %\)/.exec(al.texte);
    ok(ec && Number(ec[1]) >= 20 && Number(ec[1]) <= 40, 'l’age lu sur les blocs : ' + (ec && ec[1]) + ' s ; la courbe : ' + (ec && ec[2]) + ' / 4,20 ETH (' + (ec && ec[3]) + ' %)');
    ok(al && /deployer 0x58ea…2e03 \(dev connu : CrawlScan\)/.test(al.texte) && /achat du dev 0,028 ETH \(curve Buy\)/.test(al.texte), 'qui : le deployer, son groupe, son achat lu dans le Buy de la courbe');
    ok(al && /Promo DexScreener : aucun profil payé · aucune pub · aucun boost/.test(al.texte), 'la promo DexScreener (orders/v1 vide, comme le 15/10)');
    ok(al && /x\.com\/sopersone/.test(al.texte) && al.texte.endsWith('Pas un conseil financier.'), 'le lien X lu par socials(), « Pas un conseil financier. »');
    egal(r.publics.length, 0, 'RIEN sur le canal public');
    egal(r.prives.length, 1, 'une seule alerte sur 4 cycles (T+2 : 9 acheteurs et 0,065 ETH, pas de bon signe : rien de plus)');
    const c = r.colonie[0] || {};
    ok(r.colonie.length === 1 && c.source === 'dev' && c.verdict === 'ACHETER' && c.courbe === true && c.fraisPct === SP.FRAIS_COURBE_AR_PCT && c.jeton === J, 'la colonie : signal OBSERVE, source « dev », sur la courbe, frais d’aller-retour');
    const pc = r.I.prixCourbe(J);
    ok(pc && pc.prix > 0 && pc.liq === null, 'le prix de la courbe pour l’ombre : ' + (pc && pc.prix.toExponential(3)) + ' $');
    const t2 = r.cycles.find((x) => x.t2 > 0);
    ok(t2, 'le T+2 est evalue (cycle de ' + (t2 && new Date(t2.debut).toISOString().slice(11, 19)) + ')');
    ok(r.F.etat.requetes.every((q) => SR.METHODES.has(q.method)), 'LECTURE SEULE : aucune methode hors de la liste fermee');
    const co = r.cycles.map((x) => x.appels);
    ok(r.cycles.every((x) => x.statut === 'ok' && x.appels <= 7), 'chaque cycle dans son budget : ' + co.join(', ') + ' requetes HTTP');
    egal(r.w.dsAppels.length, 1, 'une seule lecture DexScreener orders (au lancement)');
    egal(r.w.autres.length, 0, 'aucune autre requete exterieure');
    const v = r.I.vue().lancements;
    ok(v && v.courbes.suivies === 1 && v.ignition.nonce === 91, 'la vue : une courbe suivie, le nonce d’IGNITION');
    ok(!JSON.stringify(r.I.vue()).includes('Pas un conseil'), 'la vue publique ne porte aucun texte d’alerte');
    /* phase defavorable : un cycle 1 s apres le lancement, avant les 20 confirmations */
    const r2 = await rejeu(1);
    const dt2 = r2.prives[0] ? Math.round(r2.prives[0].t / 1000 - t0) : null;
    ok(dt2 !== null && dt2 >= 61 && dt2 <= 75, 'le pire cas : un cycle juste avant les 20 confirmations, l’alerte au suivant (+' + dt2 + ' s)');
    console.log('     REJEU pire cas ' + JSON.stringify({ alerte: r2.prives[0] && new Date(r2.prives[0].t).toISOString(), ecart_s: dt2 }));
  }

  // ================================================== 2. le dev qui achete, la plateforme, les relais
  console.log('-- 2. le dev a 2,5 ETH, FOMOPAD, les relais, les mauvais signes --');
  {
    const w = monde();
    const B0 = w.pointe - 300;
    w.lance({ jeton: A('a1'), courbe: A('c1'), dep: A('d1'), bloc: B0, devAchat: 2.5, sym: 'GROS' });
    w.lance({ jeton: A('a2'), courbe: A('c2'), dep: A('d2'), bloc: B0 + 1, devAchat: null, value: 2.5005, sym: 'VAL' });       // pas de Buy lu : tx.value
    w.lance({ jeton: A('a3'), courbe: A('c3'), dep: '0x3f50f64ec6f233fc5cdfa2ed03b2d5de2a2b0722', from: A('d3'), bloc: B0 + 2, devAchat: 1.2, sym: 'FOMO' });
    w.lance({ jeton: A('a4'), courbe: A('c4'), dep: '0x3f50f64ec6f233fc5cdfa2ed03b2d5de2a2b0722', from: A('d4'), bloc: B0 + 3, devAchat: 0.5, sym: 'PETIT' });
    w.lance({ jeton: A('a5'), courbe: A('c5'), dep: '0x619af567afd627f560a55d03cb722e0ed86a3a84', bloc: B0 + 4, devAchat: 0.1, sym: 'BUND' });
    w.lance({ jeton: A('a6'), courbe: A('c6'), dep: CRAWL, bloc: B0 + 5, devAchat: 0.3, exemptions: 1, sym: 'MAUV', meta: { logo: 'https://gmgn.ai/x.png', x: '' } });
    w.lance({ jeton: A('a7'), courbe: A('c7'), dep: A('d7'), bloc: B0 + 6, devAchat: 0.3, sym: 'RIEN' });
    w.lance({ jeton: A('a8'), courbe: A('c8'), dep: CRAWL, bloc: B0 + 7, devAchat: 0.3, sym: 'TAXE', taxeBps: 600 });
    w.ds[A('a1')] = { orders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 1792000000000 - 3600e3 }], boosts: [{ amount: 30, paymentTimestamp: 1792000000000 - 600e3 }] };
    const s = instance(w);
    const [b] = await muet(() => s.LZ.cycle());
    ok(b.statut === 'ok' && b.lancements === 8, '8 lancements lus en un cycle');
    const par = (j) => s.envoyes.find((x) => x.jeton === j);
    ok(par(A('a1')) && /🟢 LANCEMENT — le dev achète 2,50 ETH — GROS/.test(par(A('a1')).texte), 'le dev achete 2,5 ETH : alerte verte');
    ok(/profil payé il y a 60 min · aucune pub · 1 boost, 1 en 24 h/.test(par(A('a1')).texte), 'avec sa promo DexScreener');
    ok(par(A('a2')) && /le dev achète 2,50 ETH/.test(par(A('a2')).texte) && /\(tx\.value\)/.test(par(A('a2')).texte), 'sans Buy lu : tx.value moins le droit de lancement (2,5 ETH), et c’est dit');
    ok(par(A('a3')) && /plateforme FOMOPAD avec 1,20 ETH du dev/.test(par(A('a3')).texte), 'FOMOPAD avec 1,2 ETH du dev : alerte');
    ok(!par(A('a4')), 'FOMOPAD avec 0,5 ETH : pas d’alerte');
    ok(par(A('a5')) && /^<b>🟡/.test(par(A('a5')).texte) && /vendre vite/.test(par(A('a5')).texte), 'un relais de l’usine a graduation : alerte jaune, « vendre vite »');
    ok(par(A('a6')) && /^<b>🟡 LANCEMENT — dev connu : CrawlScan/.test(par(A('a6')).texte) && /1 exemption anti-snipe/.test(par(A('a6')).texte), 'dev connu, mais 1 exemption, logo gmgn, pas de X : jaune, risque nomme');
    ok(!par(A('a7')), 'un lancement sans signal : rien');
    ok(par(A('a8')) && /^<b>🟡/.test(par(A('a8')).texte) && /taxe de 6 %/.test(par(A('a8')).texte), 'creatorTaxBps() = 600 sur la courbe : taxe de 6 % (> 5 %), jaune');
    ok(/^<b>🟢/.test(par(A('a1')).texte), 'creatorTaxBps() = 200 (2 %, comme JUDGEBOT) : rien');
    egal(s.envoyes.length, 6, 'six alertes');
    ok(s.signaux.length === 6 && s.signaux.every((x) => x.courbe && ['lancement', 'dev'].includes(x.source)), 'six signaux observes pour la colonie (sources lancement / dev)');
    egal(s.signaux.find((x) => x.jeton === A('a6')).verdict, 'SURVEILLER', 'le jaune va a la colonie en SURVEILLER');
    await muet(() => s.LZ.cycle());
    egal(s.envoyes.length, 6, 'le cycle suivant ne repete rien');
  }

  // ================================================== 3. le T+2 et la sortie
  console.log('-- 3. T+2 : bon signe, puis le dev vend --');
  {
    const w = monde();
    const B0 = w.pointe - 2000;
    w.lance({ jeton: A('b1'), courbe: A('e1'), dep: A('f1'), bloc: B0, devAchat: 0.2, sym: 'VITE' });
    for (let k = 0; k < 21; k++) w.achat(A('e1'), SP.ADR.ENTREE_PONS, A('7' + k.toString(16).padStart(2, '0')), 0.02, B0 + 10 + k * 50);
    w.lance({ jeton: A('b2'), courbe: A('e2'), dep: A('f2'), bloc: B0, devAchat: 0.2, sym: 'LENT' });
    for (let k = 0; k < 19; k++) w.achat(A('e2'), SP.ADR.ENTREE_PONS, A('8' + k.toString(16).padStart(2, '0')), 0.02, B0 + 10 + k * 50);
    w.achat(A('e2'), SP.ADR.ENTREE_PONS, A('81'), 0.5, B0 + SP.BLOCS_2MIN + 5);        // apres T+2 : ne compte pas
    w.pointe = B0 + 400;   // le 1er cycle voit le lancement, pas encore T+2
    const s = instance(w);
    await muet(() => s.LZ.cycle());
    egal(s.envoyes.length, 0, 'aucun signal au lancement : aucune alerte');
    w.pointe = B0 + 2000;
    const [b] = await muet(() => s.LZ.cycle());
    egal(b.t2, 2, 'les deux T+2 evalues');
    egal(s.envoyes.length, 0, 'un bon signe SEUL a T+2 ne part pas au proprietaire (12 % des lancements, sonde : ~200 par jour)');
    const sg = s.signaux.find((x) => x.jeton === A('b1'));
    ok(sg && sg.source === 'lancement' && sg.conditions[0].cle === 't2_bon' && sg.conditions[0].valeur.acheteurs === 21, 'il va a la colonie (21 acheteurs uniques), source « lancement »');
    ok(!s.signaux.some((x) => x.jeton === A('b2')), '19 acheteurs avant T+2 (le 20e apres) : rien');
    /* avec SMART_T2_ALERTE=1 */
    const w2 = monde(); const C0 = w2.pointe - 2000;
    w2.lance({ jeton: A('b3'), courbe: A('e3'), dep: A('f3'), bloc: C0, devAchat: 0.2, sym: 'T2' });
    w2.achat(A('e3'), SP.ADR.ENTREE_PONS, A('91'), 1.6, C0 + 100);
    const s2 = instance(w2, { env: { SMART_T2_ALERTE: '1' } });
    s2.B.meta('lance_bloc', C0 - 1);
    await muet(() => s2.LZ.cycle());
    const a = s2.envoyes[0];
    ok(a && /T\+2 — bon signe \(1 acheteur, 1,60 ETH\)/.test(a.texte) && a.texte.endsWith('Pas un conseil financier.'), 'SMART_T2_ALERTE=1 : 1,6 ETH achetes a T+2 par un autre que le dev (ses 0,2 ETH ne comptent pas) -> alerte « bon signe »');
    /* le dev vend sur une courbe suivie */
    w2.vente(A('e3'), A('f3'), A('f3'), 0.1, C0 + 2100);
    w2.pointe = C0 + 2600;
    await muet(() => s2.LZ.cycle());
    const so = s2.envoyes.find((x) => x.genre === 'sortie');
    ok(so && /^<b>🔴 SORTIR — le dev vend — T2/.test(so.texte) && /entrée aucune ; stop — ; objectif sortir maintenant/.test(so.texte), 'le dev vend : 🔴 SORTIR');
  }

  // ================================================== 4. IGNITION
  console.log('-- 4. IGNITION : usine, contrats du wallet, Relay, copieurs --');
  {
    const w = monde({ nonce: 91 });
    const B0 = w.pointe - 300;
    w.ignition({ usine: '0x8a2a38b19ec21b355eef45ab47cb58d0520bbada', jeton: A('91'), createur: A('92'), bloc: B0 });
    w.ignition({ usine: A('66'), jeton: A('93'), createur: A('94'), bloc: B0 });     // meme evenement, pas une usine d'IGNITION
    w.relay['B5JszNrk5NZWsvbfXfeGRJkCmWjhrwjDX75nsW1dKSze'] = [
      { recipient: '0x157F21A62aEf6341BcAA1965C42A8897E4961b2B', createdAt: '2026-10-14T12:02:20.412Z', data: { metadata: { currencyIn: { currency: { chainId: 792703809 } }, currencyOut: { currency: { chainId: 4663 }, amountFormatted: '0.639' } } } },
      { recipient: 'B5JszNrk5NZWsvbfXfeGRJkCmWjhrwjDX75nsW1dKSze', data: { metadata: { currencyIn: { currency: { chainId: 4663 } }, currencyOut: { currency: { chainId: 792703809 } } } } },
      { recipient: '0x86Bcc8294e37Be1111a96846D4dCFD12fE0FEeAB', data: { metadata: { currencyIn: { currency: { chainId: 792703809 } }, currencyOut: { currency: { chainId: 8453 } } } } },
    ];
    const notes = [];
    const s = instance(w, { notes, now: Date.parse('2026-10-15T12:00:00Z') });
    const rr = await s.LZ.relay();
    ok(rr.lus === 1 && rr.envois === 1 && rr.nouveaux === 1, 'Relay : UN wallet par appel (B5Js… d’abord), un envoi Solana -> 4663 (pas l’envoi vers Base, pas le retour)');
    for (let i = 1; i < 6; i++) await s.LZ.relay();
    egal(w.relayAppels.map((u) => /user=(\w{4})/.exec(u)[1]).join(','), 'B5Js,7Be6,Bqyr,Dx7W,2j2U,5zZc', 'en rotation : les six wallets en six appels (un toutes les 20 s, chacun toutes les 2 min)');
    egal(w.relayAppels[0], SLZ.RELAY_URL + '?user=B5JszNrk5NZWsvbfXfeGRJkCmWjhrwjDX75nsW1dKSze&limit=' + SLZ.RELAY_LIMITE, 'l’URL : v2, user, limit=5, aucune cle');
    egal(s.LZ.vue().relay.retrait, '2026-11-24', 'la date de retrait de la v2 est gardee (deprecation)');
    w.lance({ jeton: A('95'), courbe: A('96'), dep: '0x157f21a62aef6341bcaa1965c42a8897e4961b2b', bloc: B0 + 2, devAchat: 0.005, sym: 'FIN', meta: { logo: 'https://launchcri-assets.netlify.app/f/x.png' } });
    w.lance({ jeton: A('97'), courbe: A('98'), dep: '0x7d17bfa7383e42e8df00ae042dcaf24748dd69b9', bloc: B0 + 3, devAchat: 0.2, sym: 'DEVI', gas: '0x4c4b40', maxFee: '0xbebc200' });
    const [b] = await muet(() => s.LZ.cycle());
    egal(b.ignition, 1, 'un lancement sur l’usine d’IGNITION (pas celui d’une autre adresse qui emet le meme evenement)');
    ok(!SL.BRIEF2.IGNITION.usines.includes('0x573397b04250a092515ef1362b24f4c3ab8dc00b') && SL.BRIEF2.IGNITION.crochetNonUsine === '0x573397b04250a092515ef1362b24f4c3ab8dc00b', '0x573397b0… (« probable V5 » du brief) : un crochet v4, pas une usine — jamais lu comme usine');
    const ig = s.envoyes.find((x) => x.jeton === A('91'));
    ok(ig && /^<b>🟡 IGNITION — lancement sur leur usine/.test(ig.texte) && /créateur 0x9292…9292/.test(ig.texte), 'alerte IGNITION (jaune) : le createur decode de la data');
    const fin = s.envoyes.find((x) => x.jeton === A('95'));
    ok(fin && /wallet financé par Relay/.test(fin.texte) && /launchcri-assets\.netlify\.app/.test(fin.texte), 'un wallet finance par Relay lance sur Pons : alerte, image IGNITION nommee');
    ok(fin && /minuscule/.test(fin.texte) && /^<b>🟡/.test(fin.texte), '... jaune : achat du dev minuscule');
    const cp = s.envoyes.find((x) => x.jeton === A('97'));
    ok(cp && /copieur d’IGNITION/.test(cp.texte), 'le dev IGNITION avec maxFee 0,2 gwei et gaz 5 M : signature d’un copieur, dite');
    ok(s.signaux.filter((x) => x.source === 'ignition').length === 3, 'trois signaux « ignition » a la colonie');
    /* les contrats du wallet */
    ok(s.B.meta('ignition_nonce') === 91, '1er cycle : le nonce est note, l’histoire n’alerte pas');
    const a91 = utils.getContractAddress({ from: SL.BRIEF2.IGNITION.wallet, nonce: 91 }).toLowerCase(), a92 = utils.getContractAddress({ from: SL.BRIEF2.IGNITION.wallet, nonce: 92 }).toLowerCase();
    w.nonce = 94; w.codes[a92] = '0x6080'; w.symboles = { [a92]: 'NEWIGN' }; w.pointe += 600;
    const n0 = s.envoyes.length;
    await muet(() => s.LZ.cycle());
    const nv = s.envoyes.slice(n0);
    ok(nv.length === 1 && nv[0].jeton === a92 && /nouveau jeton déployé par son wallet — NEWIGN/.test(nv[0].texte), 'nonce 91 -> 94 : le contrat du nonce 92 a un symbol() : « nouveau jeton » ; ' + a91.slice(0, 8) + '… (pas de code) : rien');
    egal(s.B.meta('ignition_nonce'), 94, 'le nonce avance');
    /* panne de Relay : une requete, pause, aucune relance */
    w.relayPanne = true;
    const n1 = w.relayAppels.length;
    const rp = await s.LZ.relay();
    ok(rp.statut === 'pause' && w.relayAppels.length === n1 + 1, 'Relay en panne : UNE requete, puis pause (aucune relance en boucle)');
    const rp2 = await s.LZ.relay();
    ok(rp2.fait === 'pause' && w.relayAppels.length === n1 + 1, 'pendant la pause : aucune requete');
    w.pointe += 600;
    const [b2] = await muet(() => s.LZ.cycle());
    ok(b2.statut === 'ok' && b2.de, 'une panne de Relay ne bloque pas le cycle');
  }

  // ================================================== 5. la copie
  console.log('-- 5. la copie sur la courbe et sur un DEX --');
  {
    const w = monde();
    const B0 = w.pointe - 9000;
    w.lance({ jeton: A('c1'), courbe: A('e9'), dep: A('f9'), bloc: B0, devAchat: 0.1, sym: 'COP' });
    const s = instance(w);
    w.pointe = B0 + 2000;
    await muet(() => s.LZ.cycle());                                    // le lancement est connu, pas de signal
    const ici = B0 + 6000;                                              // ~10 min apres le lancement
    w.achat(A('e9'), SP.ADR.ENTREE_PONS, SNIPER, 0.05, ici, { jetons: 10n ** 25n });                       // 123 $, cap ~12 k$
    w.achat(A('e9'), SP.ADR.ENTREE_PONS, '0x9c4d5bd19f9acfe75610860b17cf7471b7ce462a', 0.5, ici);         // exclu (section 5)
    w.achat(A('e9'), SP.ADR.ENTREE_PONS, '0x0d3f171bfbdb3f5acb1d2b5c8088c83365382b51', 0.05, ici, { from: A('5e') });   // tx.from different
    const hd = w.achat(A('e9'), A('5d'), '0xf19c46c5014bcba4d0cc602f6f771b50422aa71c', 0.05, ici, { from: '0xf19c46c5014bcba4d0cc602f6f771b50422aa71c' });
    w.achat(A('e9'), A('5d'), '0x48d8a72f4e1471ab737baae71d5f4fd51f0556f7', 0.05, ici, { h: hd });     // meme tx, 2 wallets de la liste
    w.achat(A('e9'), SP.ADR.ENTREE_PONS, '0x3add78a28de6f0077d750e18ee6a4ceeb2db3366', 0.05, ici);
    w.achat(A('e9'), SP.ADR.ENTREE_PONS, '0xc08a47f5111ae27100fb18106e929537ea97f838', 0.05, ici);      // meme groupe
    w.achat(A('e9'), SP.ADR.ENTREE_PONS, '0x72ff82dbf9ffa5fbbcd27ee327e01989a1fafcf2', 0.01, ici);      // 24,5 $
    w.pointe = ici + 100;
    const [b] = await muet(() => s.LZ.cycle());
    const cps = s.envoyes.filter((x) => x.genre === 'copie');
    ok(cps.some((x) => /COPIE — Sniper 1 achète sur la courbe/.test(x.texte) && /Sniper 1 \(0x7632…1180\) pour 123 \$, 10 min après le lancement/.test(x.texte)), 'Sniper 1 a 10 min, ~12 k$ : alerte de copie (123 $)');
    ok(b.ignores['excluded (section 5)'] === undefined && b.ignores.exclu === 1, 'le wallet exclu : compte, ignore');
    ok(Object.keys(b.ignores).some((k) => /not sent by the wallet/.test(k)), 'tx.from different : ignore');
    ok(Object.keys(b.ignores).some((k) => /airdrop/.test(k)), 'une tx vers deux wallets de la liste : airdrop, ignore');
    ok(Object.keys(b.ignores).some((k) => /under \$50/.test(k)), '24,5 $ : ignore');
    egal(cps.filter((x) => /Groupe|0x3add|0xc08a/.test(x.texte)).length, 1, 'le groupe {0x3add, 0xc08a} : une seule alerte (une voix)');
    ok(s.signaux.filter((x) => x.source === 'copie').length === 2, 'deux signaux « copie » a la colonie (Sniper 1, le groupe)');
    /* Sniper 1 trop tot */
    const w2 = monde(); const C0 = w2.pointe - 3000;
    w2.lance({ jeton: A('c2'), courbe: A('ea'), dep: A('fa'), bloc: C0, devAchat: 0.1 });
    const s2 = instance(w2);
    s2.B.meta('lance_bloc', C0 - 1);
    w2.achat(A('ea'), SP.ADR.ENTREE_PONS, SNIPER, 0.05, C0 + 1000, { jetons: 10n ** 25n });    // ~1,7 min
    const [b2] = await muet(() => s2.LZ.cycle());
    ok(Object.keys(b2.ignores).some((k) => /Sniper 1: token age outside 5-60/.test(k)) && !s2.envoyes.some((x) => x.genre === 'copie'), 'Sniper 1 a 1,7 min : hors de sa fenetre (5-60 min), ignore');
    /* une courbe que le cycle n'a pas vue naitre : l'usine la confirme, ou pas */
    const w3 = monde(); const D0 = w3.pointe - 20000;
    w3.lance({ jeton: A('c3'), courbe: A('eb'), dep: A('fb'), bloc: D0, devAchat: 0.1 });
    w3.achat(A('eb'), SP.ADR.ENTREE_PONS, '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', 0.05, w3.pointe - 100, { jetons: 10n ** 25n });
    w3.achat(A('ec'), SP.ADR.ENTREE_PONS, '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', 0.05, w3.pointe - 100);     // pas une courbe Pons
    const s3 = instance(w3);
    const [b3] = await muet(() => s3.LZ.cycle());
    ok(s3.envoyes.some((x) => x.jeton === A('c3') && x.genre === 'copie') && b3.ignores.pasPons === 1, 'courbe ancienne : confirmee par l’usine (TokenLaunched, topic 2) ; une fausse « courbe » : ignoree');
    /* la copie DEX, lue par la veille */
    const w4 = monde();
    const s4 = instance(w4, { faits: async (j) => ({ [A('d1')]: { mc: 2e6, liq: 1e5, sym: 'GROS' }, [A('d2')]: { mc: 30000, liq: 9000, sym: 'BON' }, [A('d3')]: { mc: 900000, liq: 50000, sym: 'MOY' } })[j] || null,
      exclu: (j) => (j === A('d4') ? 'tokenized stock' : null) });
    await muet(() => s4.LZ.cycle());       // le prix de l'ETH
    const W2 = '0x0d3f171bfbdb3f5acb1d2b5c8088c83365382b51';          // de la v2 seulement
    const achats = [A('d1'), A('d2'), A('d3'), A('d4')].map((j, i) => ({ jeton: j, wallet: W2, tx: '0x' + String(i).repeat(64), bloc: 1, eth: eth(0.05) }));
    const txs = new Map(achats.map((x) => [x.tx, { from: W2 }]));
    const bd = await s4.LZ.copieDex(achats, { transactions: async () => txs, ageMin: () => 30 });
    ok(bd.gardes === 1 && bd.ignores['token over $1M'] === 1 && bd.ignores['buy under 0.02% of the market cap'] === 1 && bd.ignores['tokenized stock'] === 1, 'DEX : > 1 M$, < 0,02 % de la capitalisation (123 $ sur 900 k$), action tokenisee : ignores ; le 4e garde');
    ok(s4.envoyes.some((x) => /COPIE — Copie 0x0d3f171b achète — BON/.test(x.texte) && /capitalisation 30 k\$ \(DexScreener, non vérifié\)/.test(x.texte)), 'l’alerte DEX : capitalisation de DexScreener, dite non verifiee');
    /* 0x1ad70bc7 est aussi un wallet « fort » du 1er brief : sur un DEX, l'analyste l'a deja juge et alerte */
    const n4 = s4.envoyes.length, g4 = s4.signaux.length;
    const v1 = { jeton: A('d5'), wallet: '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', tx: '0x' + '9'.repeat(64), bloc: 1, eth: eth(0.05) };
    const s4f = { faits: async () => ({ mc: 30000, liq: 9000, sym: 'V1' }) };
    const bv = await s4.LZ.copieDex([v1], Object.assign({ transactions: async () => new Map([[v1.tx, { from: v1.wallet }]]), ageMin: () => 30 }, s4f));
    ok(bv.silencieux === 1 && s4.envoyes.length === n4 && s4.signaux.length === g4 + 1 && s4.signaux[g4].source === 'copie', 'un wallet fort du 1er brief achete sur un DEX : pas de 2e alerte (l’analyste l’a faite), mais un signal sur la ligne « copie »');
  }

  // ================================================== 6. le rebond
  console.log('-- 6. le rebond apres une alerte --');
  {
    const w = monde();
    const B0 = w.pointe - 300;
    w.lance({ jeton: A('e1'), courbe: A('ee'), dep: A('fe'), bloc: B0, devAchat: 2.2, sym: 'REB' });
    /* il gradue : la courbe sort du suivi, le prix passe a DexScreener (sur la courbe, pas de liquidite DEX : jamais de signal) */
    w.logs.push(journal(A('ee'), [SP.TOPIC.GRADUATION_COURBE], [BigInt(A('31')), eth(4.2), 10n ** 26n], B0 + 50, '0x' + 'ab'.repeat(32), 9));   // CurveCompleted, emis par la courbe
    const suite = [{ mc: 100000, liq: 20000 }, { mc: 40000, liq: 9000 }, { mc: 49000, liq: 9000 }];
    let k = 0;
    const s = instance(w, { faits: async () => suite[Math.min(k++, suite.length - 1)] });
    await muet(() => s.LZ.cycle());
    ok(s.envoyes.length === 1 && s.LZ.vue().rebond === 1, 'l’alerte de lancement met le jeton en surveillance');
    w.F.etat.requetes.length = 0;
    for (let i = 0; i < 3; i++) { s.T.now += 5 * 60e3 + 1; w.pointe += 3000; await muet(() => s.LZ.cycle()); }
    const rb = s.envoyes.find((x) => x.genre === 'rebond');
    ok(rb && /🟢 REBOND — −60 % depuis le plus haut, \+23 % depuis le creux — REB/.test(rb.texte) && /stop capitalisation 38 k\$ \(5 % sous le creux\)/.test(rb.texte), 'chute de 60 % puis +23 % avec 9 000 $ de liquidite : signal, stop sous le creux');
    ok(s.signaux.some((x) => x.source === 'rebond' && x.verdict === 'ACHETER'), 'la colonie recoit le rebond (sa propre ligne)');
  }

  // ================================================== 7. budget, rattrapage, interrupteurs, pannes
  console.log('-- 7. budget, rattrapage borne, interrupteurs, pannes --');
  {
    const w = monde();
    const notes = [];
    const s = instance(w, { notes });
    s.B.meta('lance_bloc', w.pointe - 50000);
    const [b] = await muet(() => s.LZ.cycle());
    ok(b.saute > 0 && b.a - b.de + 1 === SLZ.FENETRE_MAX && notes.some((x) => /blocs sautes/.test(x)), 'curseur 50 000 blocs en arriere : saute au-dela de 18 000, le dit, et lit 6 000 blocs au plus');
    const [b1] = await muet(() => s.LZ.cycle());
    ok(b1.de === b.a + 1, 'la reprise au dernier bloc lu');
    /* budget */
    const w2 = monde();
    const s2 = instance(w2, { budgetAppels: 2 });
    const [b2] = await muet(() => s2.LZ.cycle());
    ok(b2.statut === 'budget' && s2.B.meta('lance_bloc') === null, 'budget de 2 requetes : le cycle s’arrete, le curseur n’avance pas');
    /* SMART_LANCEMENTS=0 */
    const w3 = monde();
    const s3 = instance(w3, { env: { SMART_LANCEMENTS: '0' } });
    const r3 = await s3.LZ.cycle();
    ok(r3.fait === 'off' && w3.F.etat.http === 0, 'SMART_LANCEMENTS=0 : aucun cycle, aucune requete');
    const s3b = instance(monde(), { env: { SMART_IGNITION: '0' } });
    ok((await s3b.LZ.relay()).fait === 'off' && s3b.LZ.config.relay === false, 'SMART_IGNITION=0 : Relay eteint aussi');
    /* SMART_DS_ORDERS=0, et DexScreener en panne */
    const w4 = monde(); const B0 = w4.pointe - 300;
    w4.lance({ jeton: A('a1'), courbe: A('c1'), dep: CRAWL, bloc: B0, devAchat: 0.2 });
    const s4 = instance(w4, { env: { SMART_DS_ORDERS: '0' } });
    await muet(() => s4.LZ.cycle());
    ok(w4.dsAppels.length === 0 && /Promo DexScreener : non demandée/.test(s4.envoyes[0].texte), 'SMART_DS_ORDERS=0 : aucune lecture, « non demandée »');
    const w5 = monde(); const C0 = w5.pointe - 300;
    w5.lance({ jeton: A('a1'), courbe: A('c1'), dep: CRAWL, bloc: C0, devAchat: 0.2 });
    w5.dsPanne = true;
    const s5 = instance(w5);
    await muet(() => s5.LZ.cycle());
    ok(s5.envoyes.length === 1 && /Promo DexScreener : non lue/.test(s5.envoyes[0].texte), 'DexScreener en panne : l’alerte part, promo « non lue »');
    /* 429 du noeud : recul puis reprise */
    const w6 = monde({ pannes: [null, 429] }); const D0 = w6.pointe - 300;
    w6.lance({ jeton: A('a1'), courbe: A('c1'), dep: CRAWL, bloc: D0, devAchat: 0.2 });
    const s6 = instance(w6);
    const [b6] = await muet(() => s6.LZ.cycle());
    ok(b6.statut === 'ok' && s6.envoyes.length === 1 && s6.R.etat.reculs === 1, 'un 429 : recul de 15 s, puis le cycle finit');
    /* les getLogs : plafond de lignes -> coupe en deux */
    const w7 = monde(); const E0 = w7.pointe - 5000;
    for (let i = 0; i < 30; i++) w7.achat(A('cc'), SP.ADR.ENTREE_PONS, A('aa'), 0.01, E0 + i * 100);
    w7.F.etat.limites.lignes = 10;
    const s7 = instance(w7);
    const lg = await s7.LZ.logsExacts({ topics: [[SP.TOPIC.ACHAT]] }, E0, E0 + 4000);
    egal(lg.length, 30, 'plafond de 10 lignes : la plage est coupee en deux jusqu’a tout lire (30 lignes)');
  }

  // ================================================== 8. dans smart_money : eteint, minuteries
  console.log('-- 8. le branchement dans smart_money --');
  {
    const w = monde();
    const I = M.cree({ env: {}, prendre: w.prendre, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'smart-off-')) });
    ok(/ETEINT/.test(I.ligneDemarrage()) && I.prixCourbe(J) === null, 'SMART_MONEY vide : eteint, aucun prix de courbe');
    const I2 = M.cree({ env: { SMART_MONEY: 'observe', SMART_LANCEMENTS: '0', SMART_RELAY: '0' }, prendre: w.prendre, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'smart-obs-')) });
    ok(/lancements Pons ETEINTS \(SMART_LANCEMENTS=0\)/.test(I2.ligneDemarrage()) && /Relay non/.test(I2.ligneDemarrage()), 'la ligne de demarrage dit chaque interrupteur');
    const [p] = await muet(() => M.planifie({ env: { SMART_MONEY: 'observe' }, prendre: w.prendre, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'smart-pl-')), minuteries: false }));
    ok(p.actif && typeof p.lancements === 'function' && typeof p.relay === 'function', 'planifie expose lancements() et relay()');
    p.arrete();
  }

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + (n + rates) : 'tout passe : ' + n + ' verifications'));
  process.exitCode = rates ? 1 : 0;
})().catch((e) => { console.log('EXCEPTION : ' + (e && e.stack || e)); process.exitCode = 1; });
