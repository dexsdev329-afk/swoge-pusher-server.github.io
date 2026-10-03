'use strict';
/* ============================================================================
 * L'OBSERVATOIRE SOLANA / ETHEREUM (observatoire.js) — ETAPE 1, OBSERVER SEULEMENT
 *
 * Ce qu'il DOIT tenir :
 *   1. il decouvre les nouveaux pools (GeckoTerminal), une fois chacun ;
 *   2. il lit la securite sans GoPlus : Solana (frappe, GEL, Token-2022, frais ;
 *      porteurs seulement avec un noeud prive), Ethereum (honeypot.is, 5 essais
 *      pour un pool que le service ne connait pas encore) ; un 429 arrete la
 *      lecture du cycle et se compte ;
 *   3. premier prix et prix a 30 min par le MEME service (DexScreener) ; monte a
 *      +20 %, effondre a -30 % (les seuils de la colonie) ; un pool disparu se
 *      compte a part, jamais en -100 % invente ; un jeton jamais indexe sort
 *      sans entrer dans les bilans ;
 *   4. tout est garde (jsonl par jour, etat qui survit au redemarrage) ;
 *   5. il ne parle qu'aux quatre services lus — aucune cle, aucune signature ;
 *   6. la vue est en anglais, et une case sous 30 observations ne conclut pas.
 * ==========================================================================*/
const fs = require('fs'), path = require('path'), os = require('os');
const O = require('./observatoire');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const MIN = 60e3;
let T = Date.UTC(2026, 8, 27, 12, 0, 0);
const hotes = new Set();
/* Le monde : des pools neufs, leurs prix (modifiables), leur securite. */
const M = {
  gt: { robinhood: [], solana: [], eth: [] }, prix: {}, mcs: {}, crees: {}, pools: {}, info: {}, sol: {}, hp: {}, hpTrouve: {}, top: {}, devDe: {},
  quota: { rpc: false, gecko: false },
};
const reponse = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });
async function faux(u, o) {
  const url = new URL(u); hotes.add(url.host);
  if (url.host === 'api.geckoterminal.com') {
    if (M.quota.gecko) return reponse(429, {});
    const c = url.pathname.split('/')[4];
    return reponse(200, { data: M.gt[c].map((a) => ({ attributes: { address: M.pools[a], pool_created_at: new Date(M.crees[a]).toISOString() },
      relationships: { base_token: { data: { id: c + '_' + a } }, dex: { data: { id: c === 'solana' ? 'pump-fun' : 'uniswap-v4' } } } })) });
  }
  if (url.host === 'api.dexscreener.com') {
    const adrs = url.pathname.split('/')[4].split(',');
    const out = [];
    for (const a of adrs) {
      if (!(M.prix[a] > 0)) continue;
      out.push({ chainId: 'x', dexId: 'pumpswap', pairAddress: M.pools[a], baseToken: { address: a }, quoteToken: { symbol: 'SOL' },
        priceUsd: String(M.prix[a]), liquidity: { usd: 30000 }, marketCap: M.mcs[a] || 60000, pairCreatedAt: M.crees[a], info: M.info[a] || null });
      /* une paire plus ancienne du meme jeton (courbe de lancement) : c est elle qui date le jeton */
      out.push({ dexId: 'pumpfun', pairAddress: 'courbe-' + a, baseToken: { address: a }, priceUsd: String(M.prix[a]), liquidity: { usd: 10 }, pairCreatedAt: M.crees[a] - 20 * MIN });
    }
    return reponse(200, out);
  }
  if (url.host === 'api.honeypot.is') {
    const a = url.searchParams.get('address');
    M.hp[a] = (M.hp[a] || 0) + 1;
    if (!M.hpTrouve[a]) return reponse(404, { code: 404, error: 'pair not found' });
    return reponse(200, M.hpTrouve[a]);
  }
  if (url.host === 'rpc.mainnet.chain.robinhood.com' || url.host === 'ethereum-rpc.publicnode.com') {
    const b = JSON.parse(o.body);
    if (b.method === 'eth_blockNumber') return reponse(200, { result: '0x1000000' });
    if (b.method === 'eth_getLogs') {
      const a = b.params[0].address;
      return reponse(200, { result: M.devDe[a] ? [{ transactionHash: '0xtx' + a }] : [] });
    }
    if (b.method === 'eth_getTransactionByHash') {
      const a = b.params[0].slice(4);
      return reponse(200, { result: { from: M.devDe[a], to: '0xLanceur' } });
    }
  }
  if (/solana|rpc\.prive/.test(url.host)) {
    const b = JSON.parse(o.body);
    if (M.quota.rpc) return reponse(200, { jsonrpc: '2.0', error: { code: 429, message: 'Too many requests for a specific RPC call' } });
    const a = b.params[0];
    if (b.method === 'getAccountInfo') {
      const s = M.sol[a]; if (!s) return reponse(200, { result: { value: null } });
      return reponse(200, { result: { value: { owner: s.t22 ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        data: { parsed: { info: { mintAuthority: s.frappe ? 'Auth1' : null, freezeAuthority: s.gel ? 'Auth2' : null, supply: '1000000',
          extensions: s.frais ? [{ extension: 'transferFeeConfig' }] : [] } } } } } });
    }
    if (b.method === 'getTokenLargestAccounts') return reponse(200, { result: { value: (M.top[a] || []).map((x) => ({ amount: String(x) })) } });
  }
  return reponse(500, {});
}
const nouveau = (c, a, prix, t) => { M.gt[c].push(a); M.pools[a] = 'pool-' + a; M.crees[a] = t; M.prix[a] = prix; };

(async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
  const mk = (x) => O.cree(Object.assign({ dossier, fetch: faux, maintenant: () => T }, x || {}));

  console.log('-- 1. decouverte et securite --');
  nouveau('solana', 'SOLok', 1.0, T - 2 * MIN); M.sol.SOLok = { frappe: false, gel: false };
  nouveau('solana', 'SOLgel', 1.0, T - 2 * MIN); M.sol.SOLgel = { frappe: true, gel: true, t22: true, frais: true };
  nouveau('solana', 'SOLjamais', 0, T - 2 * MIN);
  nouveau('eth', '0xethok', 2.0, T - 3 * MIN); M.hpTrouve['0xethok'] = { honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 } };
  nouveau('eth', '0xpiege', 2.0, T - 3 * MIN); M.hpTrouve['0xpiege'] = { honeypotResult: { isHoneypot: true }, simulationResult: { buyTax: 0, sellTax: 99 } };
  nouveau('eth', '0xinconnu', 2.0, T - 3 * MIN);
  let ob = mk();
  await ob.cycle();
  await ob.cycle();
  const S = ob._etat('solana'), X = ob._etat('eth');
  ok(Object.keys(S.suivis).length === 3 && Object.keys(X.suivis).length === 3 && S.compte.decouverts === 3, 'chaque pool est decouvert une fois, meme revu a chaque cycle');
  ok(S.suivis.SOLok.secu.lu && !S.suivis.SOLok.secu.frappe && !S.suivis.SOLok.secu.gel && !S.suivis.SOLok.secu.t22, 'Solana : frappe et gel renonces, SPL Token');
  const g = S.suivis.SOLgel.secu;
  ok(g.frappe && g.gel && g.t22 && g.frais, 'Solana : autorite de frappe, autorite de GEL, Token-2022 et frais de transfert lus');
  ok(g.top10 === null, 'sur le noeud public, les porteurs ne sont pas demandes (il rend 429) : inconnus');
  ok(X.suivis['0xpiege'].secu.piege === true && X.suivis['0xpiege'].secu.taxeVente === 99 && X.suivis['0xethok'].secu.taxeVente === 0, 'Ethereum : honeypot.is lu (piege, taxe de vente)');
  ok(!X.suivis['0xinconnu'].secu.lu && M.hp['0xinconnu'] === 2, 'un pool que honeypot.is ne connait pas encore est redemande au cycle suivant');
  for (let i = 0; i < 5; i++) await ob.cycle();
  ok(M.hp['0xinconnu'] === 5, 'et abandonne apres 5 essais, pas plus [' + M.hp['0xinconnu'] + ']');
  ok(S.suivis.SOLok.p0 === 1 && S.suivis.SOLok.age0 === 22 && S.suivis.SOLok.quote === 'SOL', 'premier prix par DexScreener ; l age est celui du JETON (sa plus ancienne paire : 22 min)');

  console.log('\n-- 2. trente minutes plus tard --');
  T += 31 * MIN;
  M.prix.SOLok = 1.25;           /* +25 % : monte */
  M.prix.SOLgel = 0.55;          /* -45 % : effondre */
  M.prix['0xethok'] = 2.1;       /* +5 % */
  M.prix['0xpiege'] = 0;         /* disparu de DexScreener */
  M.prix['0xinconnu'] = 1.0;     /* -50 % */
  await ob.cycle();
  const B = S.bilans, BX = X.bilans;
  ok(B['all tokens'].n === 2 && B['all tokens'].montes === 1 && B['all tokens'].effondres === 1 && Math.abs(B['all tokens'].s - (25 - 45)) < 1e-9,
     'Solana : +25 % compte monte, -45 % compte effondre (seuils de la colonie : +20 / -30)');
  ok(B['Freeze authority = freeze authority active'].n === 1 && B['Freeze authority = freeze authority active'].effondres === 1, 'la case « freeze authority active » garde son effondrement');
  ok(B['Top 10 holders = holders unknown'] && B['Top 10 holders = holders unknown'].n === 2, 'les porteurs inconnus ont leur case, dite telle quelle');
  ok(BX['all tokens'].n === 2 && BX['all tokens'].disparus === 1 && X.compte.disparus === 1, 'Ethereum : le pool disparu est compte a part, pas en -100 %');
  ok(BX['Sell simulation = sell unknown'] && BX['Sell simulation = sell unknown'].n === 1 && BX['Sell simulation = sell unknown'].effondres === 1, 'le jeton que honeypot.is n a jamais lu tombe dans « sell unknown »');
  ok(Object.keys(S.suivis).length === 1 && S.suivis.SOLjamais, 'seul le jeton jamais indexe reste en attente');
  T += 40 * MIN;
  await ob.cycle();
  ok(S.compte.jamaisIndexes === 1 && !S.suivis.SOLjamais && B['all tokens'].n === 2, 'apres une heure sans prix, il sort, compte « jamais indexe », hors des bilans');

  console.log('\n-- 3. tout est garde --');
  const f = path.join(dossier, 'solana', new Date(T).toISOString().slice(0, 10) + '.jsonl');
  const lignes = fs.readFileSync(f, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  const l = lignes.find((x) => x.addr === 'SOLgel');
  ok(lignes.length === 3 && l && l.r30 === -45 && l.secu.gel === true && l.p0 === 1 && l.liq1 === 30000, 'une ligne complete par jeton observe (traits, prix, resultat a 30 min), jamais indexe compris');
  const ob2 = mk();
  ok(ob2._etat('solana').bilans['all tokens'].n === 2 && ob2._etat('eth').compte.disparus === 1, 'l etat survit au redemarrage');

  console.log('\n-- 4. quotas, porteurs, et les seuls services lus --');
  M.quota.rpc = true;
  nouveau('solana', 'SOLq1', 1, T); nouveau('solana', 'SOLq2', 1, T);
  await ob2.cycle();
  ok((ob2._etat('solana').compte.erreurs.rpc429 || 0) === 1, 'un 429 du noeud Solana arrete les lectures du cycle et se compte une fois');
  /* Un noeud prive qui refuse (cle mal collee) : le motif se lit d ici, jamais l adresse (elle porte la cle). */
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs4-'));
  const refuse = async (u, o) => (/cle-secrete/.test(u) ? { status: 401, ok: false, json: async () => ({}) } : faux(u, o));
  const ob4 = O.cree({ dossier: d4, fetch: refuse, maintenant: () => T, chaines: ['solana'], solanaRpc: 'https://noeud.example/?api-key=cle-secrete' });
  M.quota.rpc = false;
  await ob4.cycle();
  const c4 = ob4._etat('solana').compte;
  ok(c4.erreurs.rpc >= 1 && c4.motifs.rpc === 'HTTP 401' && !JSON.stringify(ob4.vue()).includes('cle-secrete'),
     'un noeud qui refuse : « ' + c4.motifs.rpc + ' » dans la vue, et la cle n y apparait nulle part');
  M.quota.rpc = false;
  M.gt.solana = []; M.gt.eth = [];
  nouveau('solana', 'SOLtop', 1, T); M.sol.SOLtop = { frappe: false, gel: false }; M.top.SOLtop = [400000, 100000];
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs3-'));
  const ob3 = O.cree({ dossier: d3, fetch: faux, maintenant: () => T, solanaRpc: 'https://rpc.prive.example' });
  await ob3.cycle();
  ok(ob3._etat('solana').suivis.SOLtop.secu.top10 === 50, 'avec un noeud prive (SOLANA_RPC_URL), les 10 plus gros porteurs sont lus : 50 %');
  ok([...hotes].every((h) => ['api.geckoterminal.com', 'api.dexscreener.com', 'api.honeypot.is', 'api.mainnet-beta.solana.com', 'rpc.prive.example',
    'rpc.mainnet.chain.robinhood.com', 'ethereum-rpc.publicnode.com'].includes(h)),
     'il ne parle qu aux services lus : ' + [...hotes].join(', '));
  const src = fs.readFileSync(path.join(__dirname, 'observatoire.js'), 'utf8');
  ok(!/gopluslabs|privateKey|signTransaction|sendTransaction|MIROIR_CLE/.test(src), 'ni GoPlus (son quota revient a la colonie), ni cle, ni signature dans le module');
  M.quota.gecko = true;
  await ob3.cycle();
  ok((ob3._etat('solana').compte.erreurs.gecko429 || 0) === 1, 'GeckoTerminal en 429 : le cycle continue, et c est compte');

  console.log('\n-- 5. le registre des devs (Robinhood) --');
  {
    const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs5-'));
    M.quota.gecko = false; M.gt.solana = []; M.gt.eth = []; M.gt.robinhood = [];
    const DEV = '0xdev0000000000000000000000000000000000001';
    const t5 = T;
    nouveau('robinhood', '0xrh1', 1.0, T); M.devDe['0xrh1'] = DEV; M.mcs['0xrh1'] = 50000;
    nouveau('robinhood', '0xrh2', 1.0, T); M.devDe['0xrh2'] = DEV; M.mcs['0xrh2'] = 40000;
    nouveau('robinhood', '0xrhsans', 1.0, T);                     /* frappe hors de la plage : dev inconnu */
    const ob5 = O.cree({ dossier: d5, fetch: faux, maintenant: () => T, chaines: ['robinhood'] });
    await ob5.cycle();
    const R = ob5._etat('robinhood');
    ok(R.suivis['0xrh1'].dev === DEV.toLowerCase() && R.suivis['0xrh1'].lanceur === '0xlanceur' && R.suivis['0xrhsans'].dev === null,
       'le dev est l expediteur de la premiere frappe (et le lanceur est garde) ; sans frappe dans la plage, dev inconnu');
    ok(R.suivis['0xrh1'].devHist === 'first token we see from this dev' && !R.suivis['0xrh1'].secu, 'son passe devient un trait ; la securite Robinhood reste a la colonie');
    T += 31 * MIN; M.mcs['0xrh1'] = 150000; M.mcs['0xrh2'] = 90000; M.prix['0xrh1'] = 3; M.prix['0xrh2'] = 2.25;
    await ob5.cycle();
    ok(!R.suivis['0xrhsans'] && R.suivis['0xrh1'] && R.suivis['0xrh1'].jalon === 1, 'a 30 min : sans dev, il sort ; avec dev, il est suivi jusqu a 24 h');
    ok(R.bilans['Dev history = first token we see from this dev'] && R.bilans['Dev history = first token we see from this dev'].n === 2, 'le trait « Dev history » est mesure a 30 min comme les autres');
    T += 90 * MIN; M.mcs['0xrh1'] = 400000; M.mcs['0xrh2'] = 60000; await ob5.cycle();
    T += 240 * MIN; M.mcs['0xrh1'] = 200000; M.prix['0xrh2'] = 0; await ob5.cycle();
    T += 1080 * MIN; M.mcs['0xrh1'] = 120000; await ob5.cycle();
    const fiche = ob5.dev('robinhood', DEV);
    console.log('   ' + JSON.stringify(fiche));
    ok(fiche && fiche.tokens === 2 && fiche.vanished === 1 && fiche.reached100k === 1, 'le dev : 2 jetons, 1 disparu (rug), 1 passe 100 k$');
    ok(fiche.avgPeakCapUsd === Math.round((400000 + 90000) / 2), 'la moyenne des plus hauts OBSERVES aux jalons (400 k$ et 90 k$) : ' + fiche.avgPeakCapUsd);
    ok(Object.keys(R.suivis).length === 0, 'et apres 24 h, plus rien en suivi');
    nouveau('robinhood', '0xrh3', 1.0, T); M.devDe['0xrh3'] = DEV;
    await ob5.cycle();
    ok(R.suivis['0xrh3'].devHist === 'dev: half or more of past tokens vanished', 'son jeton suivant porte son passe : « ' + R.suivis['0xrh3'].devHist + ' »');
    ok(ob5.dev('robinhood', '0x' + '9'.repeat(40)) === null && ob5.vue().chaines.robinhood.devs.recorded === 1, 'un dev inconnu rend null ; la vue compte les devs');
    T = t5;
  }

  console.log('\n-- 5 bis. Jev, en test fantome --');
  {
    const d6 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs6-'));
    M.gt.solana = []; M.gt.eth = []; M.gt.robinhood = [];
    const questions = [];
    const jevFaux = { actif: () => true, MESURE: { appels: 0 }, demande: async (state, q) => { questions.push({ state, q }); return { ok: true, answers: { hausse: { type: 'noul', noul: 0.62 }, chute: { type: 'noul', noul: 0.04 } } }; } };
    nouveau('solana', 'SOLjev', 1.0, T); M.sol.SOLjev = { frappe: false, gel: false };
    const ob6 = O.cree({ dossier: d6, fetch: faux, maintenant: () => T, chaines: ['solana'], jev: jevFaux });
    await ob6.cycle();
    const J6 = ob6._etat('solana').suivis.SOLjev;
    ok(J6.jev && J6.jev.hausse === 0.62 && J6.jev.chute === 0.04 && questions.length === 1, 'au premier prix, Jev donne deux probabilites (monter de 20 %, s effondrer)');
    ok(questions[0].q.hausse.type === 'noul' && questions[0].state.chain === 'Solana' && questions[0].state.security.freeze_authority === 'renounced', 'la situation envoyee : la chaine, les traits, la securite lue');
    T += 31 * MIN; M.prix.SOLjev = 1.3;
    await ob6.cycle();
    const B6 = ob6._etat('solana').bilans;
    ok(B6['Jev: rise probability = 50%+'] && B6['Jev: rise probability = 50%+'].n === 1 && B6['Jev: rise probability = 50%+'].montes === 1, 'a 30 min, sa probabilite est une case comme les autres (« 50%+ » : 1 observation, montee)');
    ok(questions.length === 1, 'un jeton deja relu n est plus questionne');
    nouveau('solana', 'SOLtard', 1.0, T); M.sol.SOLtard = { frappe: false, gel: false };
    await ob6.cycle();                                   /* premier prix pose, dans les 5 min : questionne */
    const avant = questions.length;
    const S6 = ob6._etat('solana');
    S6.suivis.SOLtard.jev = undefined; S6.suivis.SOLtard.t0 = T - 6 * MIN;
    await ob6.cycle();
    ok(questions.length === avant, 'plus de 5 min apres le premier prix : plus de question (une part des 30 min serait deja jouee)');
    T -= 31 * MIN;
  }

  console.log('\n-- 6. la vue --');
  const v = ob.vue();
  const sol = v.chaines.solana;
  ok(/Observation only/.test(v.note) && /\+20%/.test(v.note) && /-30%/.test(v.note), 'la vue dit ce qu elle est, et les seuils');
  ok(sol.cases[0].trait === 'all tokens' && sol.cases[0].n === 2 && sol.cases[0].avgCapped === -10 && !('moyenne' in sol.cases[0]) && sol.cases[0].assez === false, 'la reference d abord ; sous 30 observations, « assez » est faux');
  ok(/unknown: the public Solana node/.test(sol.holders) && v.chaines.eth.holders === null, 'elle dit pourquoi les porteurs Solana sont inconnus');
  ok(!/[àâçéèêëîïôûùüÿœ]/i.test(JSON.stringify(v)), 'tout en anglais');

  console.log('\n-- 7. la moyenne bornee (03/10) --');
  {
    /* Releve du 03/10 : la « moyenne » Solana valait +4 393 112 750 % sur 29 730 jetons — quelques
       premiers prix quasi nuls. Bornee a +PLAFOND, elle redevient une mesure. */
    const b = { n: 0 };
    [-50, -10, 0, 5, 1e9].forEach((r) => O.noteBorne(b, r));
    const l = O.lisBorne(b);
    ok(l.avgCapped === Math.round((-50 - 10 + 0 + 5 + O.PLAFOND) / 5 * 10) / 10 && l.nCapped === 5, 'un rendement d un milliard de % compte pour +' + O.PLAFOND + ' % (moyenne ' + l.avgCapped + ')');
    ok(l.median === '+0 to +2%' || l.median === '0 to +2%', 'la mediane est la tranche du milieu (' + l.median + ')');
    ok(typeof l.t === 'number', 'et la case porte son t (' + l.t + ')');
    /* Le recalcul unique : des bilans d avant (sans bornes) relus dans les lignes du disque. */
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-bornes-'));
    fs.mkdirSync(path.join(dir2, 'solana'), { recursive: true });
    const vieux = { chaine: 'solana', depuis: Date.now(), cycles: 1, suivis: {}, finis: [], devs: {}, derniers: [],
      compte: { decouverts: 2, observes: 2, jamaisIndexes: 0, disparus: 0, pleins: 0, erreurs: {} },
      bilans: { 'all tokens': { n: 2, s: 1e9 + 20, montes: 2, effondres: 0, disparus: 0 } } };
    fs.writeFileSync(path.join(dir2, 'solana.json'), JSON.stringify(vieux));
    fs.writeFileSync(path.join(dir2, 'solana', '2026-10-01.jsonl'), JSON.stringify({ addr: 'A', r30: 1e9 }) + '\n' + JSON.stringify({ addr: 'B', r30: 20 }) + '\n' + JSON.stringify({ addr: 'C', r30: null, rug: true }) + '\n');
    const ob2 = O.cree({ dossier: dir2, chaines: ['solana'], fetch: async () => { throw new Error('hors ligne'); } });
    const c0 = ob2.vue().chaines.solana.cases[0];
    ok(c0.nCapped === 2 && c0.avgCapped === Math.round((O.PLAFOND + 20) / 2 * 10) / 10 && ob2.vue().chaines.solana.recompute.relus === 2,
       'au demarrage, les bilans d avant sont relus UNE fois dans les fichiers : ' + c0.avgCapped + ' % au lieu de 500 millions');
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log('\n-- 8. qui pousse vraiment ses jetons (03/10) --');
  {
    /* Releve du 03/10 : le « plus haut moyen » mettait en tete des jetons nes a 15 000 milliards de $. */
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-devs-'));
    const ob3 = O.cree({ dossier: dir3, chaines: ['robinhood'], fetch: async () => { throw new Error('hors ligne'); } });
    const S = ob3._etat('robinhood');
    const j = (mc0, pic, rug) => ({ addr: '0x' + Math.random().toString(16).slice(2).padEnd(40, '0'), mc0, pic, r30: 0, rug: !!rug, t0: 1 });
    S.devs['0xfaux'] = { n: 4, athSomme: 6e13, au100k: 4, rugs: 4, jetons: [j(6e13, 6e13, true), j(5e13, 5e13, true), j(4e13, 4e13, true), j(3e13, 3e13, true)], vu: 1 };
    S.devs['0xpousse'] = { n: 4, athSomme: 0, au100k: 1, rugs: 0, jetons: [j(10000, 50000), j(20000, 45000), j(15000, 160000), j(30000, 31000)], vu: 1 };
    S.devs['0xtiede'] = { n: 3, athSomme: 0, au100k: 0, rugs: 1, jetons: [j(50000, 52000), j(40000, 41000), j(60000, 0, true)], vu: 1 };
    const dv = ob3.vue().chaines.robinhood.devs;
    ok(dv.pushers[0].dev === '0xpousse' && dv.pushers[0].doubled === 3 && dv.pushers[0].plausibleLaunches === 4 && dv.pushers[0].medianMultiple === 2.25,
       'en tete : le dev dont 3 lancements sur 4 ont au moins double (multiple median ' + dv.pushers[0].medianMultiple + ')');
    ok(!dv.pushers.some((x) => x.dev === '0xfaux') && !dv.bestAvgPeak.some((x) => x.dev === '0xfaux'), 'les jetons nes a 60 000 milliards de $ ne classent personne');
    ok(dv.pushers.find((x) => x.dev === '0xtiede').doubled === 0, 'un rug compte zero, un jeton plat ne double pas');
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
