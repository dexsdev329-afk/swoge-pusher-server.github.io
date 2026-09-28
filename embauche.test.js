'use strict';
/* embauche.js : l'agent embauche un service x402 du catalogue, sur le solde du
   joueur. Tout garde-fou joue AVANT la signature ; le joueur n'est facture que
   sur un 200 ; la signature EIP-3009 est la vraie. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const E = require('./embauche');
const X = require('./x402_client');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const CLE = '0x' + '11'.repeat(32);
const W = new ethers.Wallet(CLE);
const PAYTO = '0x' + 'ab'.repeat(20);
const USDC = X.USDC_BASE;
const offre = (amount, o) => Object.assign({ scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: String(amount), payTo: PAYTO, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } }, o || {});
const item = (url, amount, o) => Object.assign({ x402Version: 2, type: 'http', resource: url, description: 'Weather service', accepts: [offre(amount)],
  extensions: { bazaar: { info: { input: { type: 'http', method: 'GET', queryParams: { city: 'Paris' } } } } } }, o || {});
const CAT = [
  item('https://meteo.example/forecast', 10000, { description: 'Weather forecast for any city' }),
  item('https://cheap.example/weather', 5000, { description: 'Weather now, cheap' }),
  item('https://v1.example/weather', 1000, { x402Version: 1 }),
  item('https://sol.example/weather', 1000, { accepts: [offre(1000, { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })] }),
  item('https://cher.example/weather', 500000),
  item('http://clair.example/weather', 1000),
  item('https://api.moi.example/agentic/call/scan_token', 1000),
  item('https://interne.example/weather', 1000),
  item('https://renvoi.example/weather', 1000),
  item('https://panne.example/weather', 1000),
  item('https://panne2.example/weather', 1000),
  item('https://appat.example/weather', 1000),
  item('https://gratuit.example/weather', 1000),
  /* x402 v1 : reseau nomme, maxAmountRequired, offres dans le corps (specs/x402-specification-v1.md). */
  { x402Version: 1, type: 'http', resource: 'https://vieux.example/weather', description: 'Weather v1',
    accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '2000', asset: USDC, payTo: PAYTO, resource: 'https://vieux.example/weather', description: 'w', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] },
];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const rep = (status, corps, h) => new Response(typeof corps === 'string' ? corps : JSON.stringify(corps), { status, headers: Object.assign({ 'content-type': 'application/json' }, h || {}) });
const vus = [];
/* Le faux reseau : chaque service a sa facon de repondre. */
async function fauxFetch(url, o) {
  const u = new URL(url), sig = (o.headers || {})['payment-signature'];
  vus.push({ url, sig: !!sig, method: o.method, redirect: o.redirect });
  const req = (amount) => ({ x402Version: 2, resource: { url: u.origin + u.pathname }, accepts: [offre(amount)] });
  if (u.hostname === 'renvoi.example') return rep(302, '', { location: 'http://169.254.169.254/' });
  if (u.hostname === 'gratuit.example') return rep(200, { free: true });
  if (u.hostname === 'vieux.example') {
    const xp = (o.headers || {})['x-payment'];
    if (!xp) return rep(402, { x402Version: 1, error: 'X-PAYMENT header is required', accepts: CAT[CAT.length - 1].accepts });
    fauxFetch.v1 = JSON.parse(Buffer.from(xp, 'base64').toString());
    return rep(200, { tempC: 18 }, { 'x-payment-response': b64({ success: true, transaction: '0xv1tx', network: 'base' }) });
  }
  if (u.hostname === 'appat.example') return sig ? rep(200, {}) : rep(402, '', { 'payment-required': b64(req(90000000)) });
  if (!sig) return rep(402, { error: 'payment required' }, { 'payment-required': b64(req(u.hostname === 'cheap.example' ? 5000 : 10000)) });
  const p = JSON.parse(Buffer.from(sig, 'base64').toString());
  fauxFetch.dernier = p;
  if (u.hostname === 'panne.example') return rep(500, { error: 'boom' }, { 'payment-response': b64({ success: true, transaction: '0xpaye' }) });
  if (u.hostname === 'panne2.example') return rep(402, { error: 'invalid' });
  return rep(200, { city: u.searchParams.get('city'), tempC: 21 }, { 'payment-response': b64({ success: true, transaction: '0x' + 'cd'.repeat(32) }) });
}
const resout = async (h) => (h === 'interne.example' ? ['10.0.0.5'] : ['93.184.215.14']);

(async () => {
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'embauche-'));
  let horloge = Date.UTC(2026, 8, 28, 12);
  const mk = (cle) => E.cree({ cle, fetch: fauxFetch, catalogue: async () => CAT, dossier: dos, moi: 'https://api.moi.example', resout, maintenant: () => horloge });
  const H = mk(CLE);

  console.log('-- le catalogue : ce qu on sait payer, et rien d autre --');
  const C = await H.catalogue();
  const urls = C.liste.map((e) => e.url);
  ok(urls.includes('https://meteo.example/forecast') && urls.includes('https://cheap.example/weather'), 'les services v2, USDC sur Base, sous le plafond');
  ok(!urls.some((x) => /sol\.example|cher\.example|http:\/\/|api\.moi\.example/.test(x)),
     'exclus : un autre reseau que le notre, au-dessus de 0,10 $, http en clair, notre propre serveur');
  ok(urls.includes('https://v1.example/weather') === false && urls.includes('https://vieux.example/weather'),
     'x402 v1 (28/09, format verifie dans la specification) : pris quand l offre est sur notre reseau (« base »), pas quand elle est mal formee');
  const r0 = await H.cherche('weather forecast city', 3);
  ok(r0[0].url === 'https://meteo.example/forecast' && r0.every((e) => e.usd > 0), 'la recherche : le plus pertinent d abord (' + r0.map((e) => e.url.split('/')[2] + ' ' + e.usd + '$').join(', ') + ')');
  ok((await H.cherche('zz', 3)).length === 0, 'un besoin sans mot utile ne rend rien');

  console.log('\n-- une embauche : reserve, paiement signe, 200, facture --');
  const factu = [];
  let soldeUsd = 1;
  const F = { reserve: async (usd) => { if (usd > soldeUsd) return { ok: false, raison: 'balance too low to hire this service' }; soldeUsd -= usd; factu.push(['reserve', usd]); return { ok: true, jeton: usd }; },
    regle: async (jeton, usd) => { soldeUsd += jeton - usd; factu.push(['regle', jeton, usd]); } };
  const J = H.pour('0xJOUEUR', F);
  const r1 = await J.embauche({ url: 'https://meteo.example/forecast', query: { city: 'Lyon' } });
  ok(r1.ok && JSON.parse(r1.resultat).city === 'Lyon' && r1.recu.usd === 0.01 && Math.abs(r1.recu.factureUsd - 0.011) < 1e-9 && /^0xcd/.test(r1.recu.tx),
     'le service repond ; le recu dit 0,01 $ paye, 0,011 $ factures (marge 1,1), la transaction');
  ok(factu[0][0] === 'reserve' && Math.abs(factu[0][1] - 0.011) < 1e-9 && factu[1][0] === 'regle' && Math.abs(factu[1][2] - 0.011) < 1e-9, 'le solde est reserve AVANT le paiement, puis regle au prix du recu');
  const p = fauxFetch.dernier;
  const a = p.payload.authorization;
  const qui = ethers.utils.verifyTypedData(Object.assign({}, X.DOMAINE), X.TYPES_3009, a, p.payload.signature);
  ok(qui === W.address && a.to === PAYTO && a.value === '10000' && p.accepted.network === 'eip155:8453', 'la vraie signature EIP-3009 : notre portefeuille, vers le payTo du 402, le montant exact');
  ok(vus.every((v) => v.redirect === 'manual'), 'aucune redirection n est jamais suivie');

  console.log('\n-- x402 v1 : le 402 dans le corps, le paiement dans X-PAYMENT --');
  const rv = await J.embauche({ url: 'https://vieux.example/weather' });
  const v1 = fauxFetch.v1 || {};
  ok(rv.ok && rv.recu.usd === 0.002 && rv.recu.tx === '0xv1tx' && v1.x402Version === 1 && v1.scheme === 'exact' && v1.network === 'base'
     && v1.payload && v1.payload.authorization.value === '2000' && ethers.utils.verifyTypedData(X.DOMAINE, X.TYPES_3009, v1.payload.authorization, v1.payload.signature) === W.address,
     'X-PAYMENT = { x402Version 1, scheme, network « base », payload EIP-3009 } signe pour maxAmountRequired ; recu lu dans X-PAYMENT-RESPONSE');

  console.log('\n-- les refus, tous AVANT de signer --');
  const nSig = () => vus.filter((v) => v.sig).length;
  const avant = nSig();
  const pas = async (a2, re, msg) => { const r = await J.embauche(a2); ok(!r.ok && re.test(r.raison), msg + ' (« ' + r.raison + ' »)'); };
  await pas({ url: 'https://inconnu.example/x' }, /not in the catalogue/, 'une URL hors catalogue');
  await pas({ url: 'https://interne.example/weather' }, /public https address/, 'un hote qui se resout vers une adresse privee (10.0.0.5)');
  await pas({ url: 'https://renvoi.example/weather' }, /redirected/, 'une redirection (vers 169.254.169.254)');
  await pas({ url: 'https://appat.example/weather' }, /above the 0\.1 \$ per-call cap/, 'un 402 plus cher que le catalogue ne le disait');
  ok(nSig() === avant, 'aucun de ces cas n a signe quoi que ce soit');
  const pauvre = H.pour('0xPAUVRE', { reserve: async () => ({ ok: false, raison: 'balance too low to hire this service' }), regle: async () => {} });
  const rP = await pauvre.embauche({ url: 'https://cheap.example/weather' });
  ok(!rP.ok && /balance too low/.test(rP.raison) && nSig() === avant, 'solde trop bas : refuse, rien signe');

  console.log('\n-- le service tombe apres le paiement : le joueur ne paie pas --');
  const k0 = factu.length;
  const rp = await J.embauche({ url: 'https://panne.example/weather' });
  ok(!rp.ok && /you were not charged/.test(rp.raison) && rp.tx === '0xpaye' && factu[factu.length - 1][2] === 0, 'paye mais HTTP 500 : reserve rendue, la perte est a la maison (' + rp.tx + ')');
  const rp2 = await J.embauche({ url: 'https://panne2.example/weather' });
  ok(!rp2.ok && !rp2.tx && factu[factu.length - 1][2] === 0, 'refuse au reglement (pas de transaction) : rien paye, rien facture');
  const g = await J.embauche({ url: 'https://gratuit.example/weather' });
  ok(g.ok && g.gratuit && g.recu.usd === 0 && factu.length === k0 + 4, 'un service qui rend 200 sans paiement : rien reserve, rien paye');

  const hi = J.historique(10);
  ok(hi.length === 4 && hi[0].t >= hi[hi.length - 1].t && hi.some((x) => x.etat === 'paye' && x.hote === 'meteo.example' && x.factureUsd > 0 && x.tx)
     && hi.some((x) => x.etat === 'perte' && x.factureUsd === 0) && hi.some((x) => x.etat === 'rendu' && x.usd === 0) && !hi.some((x) => x.qui),
     'l historique du joueur : un etat par embauche payee ou tentee (paye x2, perte, rendu ; le service gratuit n y est pas), le plus recent d abord, sans l adresse des autres');
  ok(H.pour('0xAUTRE', F).historique().length === 0, 'un autre joueur ne voit rien des embauches de celui-ci');

  console.log('\n-- les plafonds du jour --');
  const b = J.budget();
  ok(Math.abs(b.depenseUsd - 0.022) < 1e-9, 'le budget du joueur compte les payes (0,01 $ en v2, 0,002 $ en v1) et la perte (0,01 $), pas le rendu : ' + b.depenseUsd);
  process.env.EMBAUCHE_JOUR_JOUEUR_USD = '0.02';
  await pas({ url: 'https://meteo.example/forecast' }, /daily hiring budget \(0\.02 \$\) is used up/, 'le plafond du joueur (0,02 $ ici) : refuse');
  delete process.env.EMBAUCHE_JOUR_JOUEUR_USD;
  process.env.EMBAUCHE_JOUR_USD = '0.015';
  const autre = H.pour('0xAUTRE', F);
  const ra = await autre.embauche({ url: 'https://meteo.example/forecast' });
  ok(!ra.ok && /agent's daily hiring budget/.test(ra.raison), 'le plafond de la maison vaut pour tous les joueurs');
  delete process.env.EMBAUCHE_JOUR_USD;
  horloge += 24 * 3600e3;
  ok(J.budget().depenseUsd === 0, 'le lendemain (jour UTC), le budget repart');

  console.log('\n-- le plafond que le joueur choisit --');
  ok(J.budget().jourUsd === 1 && J.budget().maxJoueurUsd === 1, 'sans choix du joueur, son plafond est celui du serveur (1 $)');
  ok(!J.fixe(1.5).ok && !J.fixe(-1).ok && !J.fixe('beaucoup').ok && J.budget().jourUsd === 1, 'au-dessus du plafond serveur, negatif ou illisible : refuse, rien ne change');
  const k1 = factu.length;
  ok(J.fixe(0).ok && J.budget().jourUsd === 0, 'le joueur coupe ses embauches (0 $)');
  const rc = await J.embauche({ url: 'https://meteo.example/forecast' });
  ok(!rc.ok && /switched paid hires off/.test(rc.raison) && factu.length === k1, 'coupees : refuse avant tout appel, rien reserve');
  ok(J.fixe(0.5).ok && J.budget().jourUsd === 0.5 && H.pour('0xAUTRE', F).budget().jourUsd === 1, 'le plafond choisi (0,50 $) ne vaut que pour ce joueur');
  process.env.EMBAUCHE_JOUR_JOUEUR_USD = '0.2';
  ok(J.budget().jourUsd === 0.2, 'le serveur baisse son plafond sous le choix du joueur : le plus bas des deux s applique');
  delete process.env.EMBAUCHE_JOUR_JOUEUR_USD;
  ok(mk(CLE).pour('0xJOUEUR', F).budget().jourUsd === 0.5, 'relu depuis embauche_plafonds.json apres un redemarrage');
  J.fixe(1);

  console.log('\n-- le registre survit a un redemarrage --');
  horloge -= 24 * 3600e3;
  const H2 = mk(CLE);
  ok(Math.abs(H2.pour('0xJOUEUR', F).budget().depenseUsd - 0.022) < 1e-9, 'relu depuis embauches.jsonl : la depense du jour est la meme');
  const lignes = fs.readFileSync(path.join(dos, 'embauches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok(lignes.some((l) => l.etat === 'paye' && l.tx) && lignes.some((l) => l.etat === 'perte') && lignes.some((l) => l.etat === 'rendu') && !JSON.stringify(lignes).includes(CLE.slice(2)),
     'chaque embauche est au registre (paye, perte, rendu), et la cle n y est jamais');
  /* Le 28/09, le serveur passait encore `fetch` : tout l'epinglage etait contourne en production. */
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const inst = (srv.match(/EMBAUCHE = require\('\.\/embauche'\)\.cree\(\{([^\n]*)/) || [])[1] || '';
  ok(inst && !/(^|[\s,{])fetch\s*:/.test(inst.split('catalogue:')[0]), 'server.js ne passe pas `fetch` a embauche : l appel part par la requete epinglee');
  const S = mk('');
  ok(!(await S.pour('0xJ', F).embauche({ url: 'https://meteo.example/forecast' })).ok && S.etat().actif === false, 'sans AGENT_BUDGET_CLE : rien ne s embauche');
  ok(E.privee('127.0.0.1') && E.privee('169.254.169.254') && E.privee('::1') && E.privee('fd00::1') && E.privee('100.64.1.1') && !E.privee('93.184.215.14'), 'les adresses privees, locales et reservees sont reconnues');
  fs.rmSync(dos, { recursive: true, force: true });

  console.log('\n-- un service qui ne renvoie pas de recu : la transaction est retrouvee sur la chaine (Solana) --');
  {
    /* Mesure du 28/09 : x402factory.ai (x402 v1, Solana) regle sans X-PAYMENT-RESPONSE. */
    const cr = require('crypto');
    const kp = cr.generateKeyPairSync('ed25519');
    const graine = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32);
    const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
    const CLE_SOL = ethers.utils.base58.encode(Buffer.concat([graine, pub]));
    const MOI_SOL = ethers.utils.base58.encode(pub);
    const PAYTO_SOL = 'AGENTxr77msTPAmGk4DwdumueVAa3SvtyrpTf6tWMeWD', FEE = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';
    const URL_SOL = 'https://prix.example/solana/coinprice';
    const offreSol = { scheme: 'exact', network: 'solana', maxAmountRequired: '1000', asset: X.USDC_SOLANA, payTo: PAYTO_SOL, resource: URL_SOL, maxTimeoutSeconds: 60, extra: { feePayer: FEE } };
    let envoyee = null;
    const fauxSol = async (url, o) => {
      const xp = (o.headers || {})['x-payment'];
      if (!xp) return rep(402, { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [offreSol] });
      envoyee = Buffer.from(JSON.parse(Buffer.from(xp, 'base64').toString()).payload.transaction, 'base64');
      return rep(200, { ok: true, price: 119.53 });                       /* aucun en-tete de recu */
    };
    const usdc = (owner, montant) => ({ owner, mint: X.USDC_SOLANA, uiTokenAmount: { amount: String(montant) } });
    const txAvec = (signes, sortie) => ({ transaction: { signatures: signes }, meta: { err: null, preTokenBalances: [usdc(MOI_SOL, 5000000)], postTokenBalances: [usdc(MOI_SOL, 5000000 - sortie)] } });
    let T0 = horloge;
    const rpcVus = [];
    let CHAINE = {};
    const fauxRpc = async (m, p) => {
      rpcVus.push(m);
      if (m === 'getSignaturesForAddress') return CHAINE.sigs.map((x) => ({ signature: x.id, blockTime: Math.floor(x.t / 1000), err: null }));
      if (m === 'getTransaction') { const x = CHAINE.sigs.find((y) => y.id === p[0]); return x ? x.tx() : null; }
      throw new Error('methode inattendue');
    };
    const dos3 = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-sol-'));
    const mkSol = () => E.cree({ cle: CLE_SOL, fetch: fauxSol, dossier: dos3, resout, maintenant: () => horloge, rpcSolana: fauxRpc,
      catalogue: async () => [{ x402Version: 1, type: 'http', resource: URL_SOL, description: 'Solana coin price', accepts: [offreSol] }],
      blockhash: async () => ({ ok: true, blockhash: ethers.utils.base58.encode(Buffer.alloc(32, 7)) }) });
    const HS = mkSol();
    const JS = HS.pour('0xsol', F);
    const rs = await JS.embauche({ url: URL_SOL });
    ok(rs.ok && rs.recu.usd === 0.001 && rs.recu.tx === null && HS.MESURE.sansRecu === 1, 'le service rend 200 sans recu : paye, la transaction est encore inconnue');
    const notre = envoyee ? ethers.utils.base58.encode(envoyee.slice(1 + 64, 1 + 128)) : null;
    /* Un leurre : meme heure, meme montant, mais pas notre signature. */
    CHAINE = { sigs: [
      { id: 'LEURRE', t: T0, tx: () => txAvec(['f1', 'autre'], 1000) },
      { id: 'LABONNE', t: T0, tx: () => txAvec(['f2', notre], 1000) }] };
    ok((await HS.rattrape()) === 1 && JS.historique()[0].tx === 'LABONNE', 'retrouvee par NOTRE signature (connue avant l envoi), pas par le leurre au meme montant');
    ok(Math.abs(JS.budget().depenseUsd - 0.001) < 1e-9 && JS.historique().length === 1, 'la transaction ajoutee ne compte pas deux fois dans le plafond du jour');
    const nRpc = rpcVus.length;
    ok((await HS.rattrape()) === 0 && rpcVus.length === nRpc, 'plus rien a rattraper : le noeud n est plus interroge');
    ok(!JSON.stringify(JS.historique()).includes(notre), 'la signature interne n est pas dans l historique montre au joueur');

    /* Une embauche d'avant la correction : pas de signature notee. On la reconnait par l'heure et le montant exact. */
    horloge += 3600e3; T0 = horloge;
    fs.appendFileSync(path.join(dos3, 'embauches.jsonl'), JSON.stringify({ id: 'vieille', t: T0, qui: '0xsol', url: URL_SOL, usd: 0.001, factureUsd: 0.0011, etat: 'paye', tx: null, reseau: X.RESEAU_SOLANA }) + '\n');
    CHAINE = { sigs: [
      { id: 'MAUVAISMONTANT', t: T0 - 5e3, tx: () => txAvec(['a', 'b'], 2000) },
      { id: 'TROPLOIN', t: T0 - 600e3, tx: () => txAvec(['c', 'd'], 1000) },
      { id: 'LABONNE', t: T0, tx: () => txAvec(['f2', notre], 1000) },
      { id: 'VIEILLE', t: T0 - 8e3, tx: () => txAvec(['e', 'g'], 1000) }] };
    const HS2 = mkSol();
    ok((await HS2.rattrape()) === 1 && HS2.pour('0xsol', F).historique().find((l) => l.t === T0).tx === 'VIEILLE',
       'sans signature : la transaction de notre portefeuille a moins de 3 min, au montant exact, pas deja prise (ni 0,002, ni 10 min avant, ni celle d une autre embauche)');
    /* Le cas reel du 28/09 : deux embauches au meme prix a 3 min d'ecart, sans signature. */
    horloge += 3600e3; const TA = horloge, TB = horloge + 175e3;
    for (const [id, t] of [['A', TA], ['B', TB]]) fs.appendFileSync(path.join(dos3, 'embauches.jsonl'), JSON.stringify({ id, t, qui: '0xsol', url: URL_SOL, usd: 0.001, factureUsd: 0.0011, etat: 'paye', tx: null, reseau: X.RESEAU_SOLANA }) + '\n');
    CHAINE = { sigs: [{ id: 'TXB', t: TB - 2e3, tx: () => txAvec(['h', 'i'], 1000) }, { id: 'TXA', t: TA - 2e3, tx: () => txAvec(['j', 'k'], 1000) }] };
    const HS4 = mkSol();
    const hA = () => HS4.pour('0xsol', F).historique();
    ok((await HS4.rattrape()) === 2 && hA().find((l) => l.t === TA).tx === 'TXA' && hA().find((l) => l.t === TB).tx === 'TXB',
       'deux embauches au meme prix a 3 min d ecart : chacune garde SA transaction (la plus proche, et avant le « paye »)');
    const HS3 = mkSol();
    ok(HS3.pour('0xsol', F).historique().every((l) => l.tx) && (await HS3.rattrape()) === 0, 'relu apres un redemarrage : toutes ont leur transaction, rien a refaire');
    const HB = E.cree({ cle: CLE_SOL, fetch: fauxSol, dossier: dos3, resout, maintenant: () => horloge, catalogue: async () => [] });
    ok((await HB.rattrape()) === 0, 'sans noeud Solana configure : rien ne se passe, rien ne casse');
    fs.rmSync(dos3, { recursive: true, force: true });
  }

  console.log('\n-- l appel part vers l adresse VERIFIEE, pas vers une seconde resolution DNS --');
  {
    const lk = E.lookupEpingle('93.184.215.14');
    let a1, a2;
    lk('x', {}, (e, ip) => { a1 = ip; }); lk('x', { all: true }, (e, l) => { a2 = l; });
    ok(a1 === '93.184.215.14' && a2[0].address === '93.184.215.14' && a2[0].family === 4, 'la resolution rendue a https.request est toujours l adresse epinglee');
    /* Un vrai serveur HTTPS local, un certificat pour « pin.example » — un nom qu aucun DNS ne connait :
       la requete doit l atteindre par l adresse epinglee, et verifier le certificat sur le nom. */
    const { execFileSync } = require('child_process');
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(d2, 'k.pem'), '-out', path.join(d2, 'c.pem'), '-days', '1', '-subj', '/CN=pin.example', '-addext', 'subjectAltName=DNS:pin.example'], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(d2, 'c.pem'));
    const srv = require('https').createServer({ key: fs.readFileSync(path.join(d2, 'k.pem')), cert }, (q, r) => { r.writeHead(402, { 'payment-required': b64({ x402Version: 2, accepts: [] }) }); r.end('{"host":"' + q.headers.host + '"}'); });
    await new Promise((s) => srv.listen(0, '127.0.0.1', s));
    const port = srv.address().port;
    const r = await E.requeteEpinglee('https://pin.example:' + port + '/w?x=1', { method: 'GET', ca: cert, signal: AbortSignal.timeout(5000) }, ['127.0.0.1']);
    const corps = await r.json();
    ok(r.status === 402 && corps.host === 'pin.example:' + port && r.headers.get('payment-required'), 'pin.example (sans DNS) atteint par 127.0.0.1, certificat verifie sur le nom, en-tetes lus');
    let refuse = false;
    try { await E.requeteEpinglee('https://autre.example:' + port + '/w', { method: 'GET', ca: cert, signal: AbortSignal.timeout(5000) }, ['127.0.0.1']); } catch (e) { refuse = true; }
    ok(refuse, 'un certificat qui ne porte pas le nom demande est refuse : epingler l adresse ne desactive pas TLS');
    srv.close(); fs.rmSync(d2, { recursive: true, force: true });
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
