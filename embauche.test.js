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
  ok(!urls.some((x) => /v1\.example|sol\.example|cher\.example|http:\/\/|api\.moi\.example/.test(x)),
     'exclus : x402 v1, un autre reseau que le notre, au-dessus de 0,10 $, http en clair, notre propre serveur');
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

  console.log('\n-- les plafonds du jour --');
  const b = J.budget();
  ok(Math.abs(b.depenseUsd - 0.02) < 1e-9, 'le budget du joueur compte le paye (0,01 $) et la perte (0,01 $), pas le rendu : ' + b.depenseUsd);
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

  console.log('\n-- le registre survit a un redemarrage --');
  horloge -= 24 * 3600e3;
  const H2 = mk(CLE);
  ok(Math.abs(H2.pour('0xJOUEUR', F).budget().depenseUsd - 0.02) < 1e-9, 'relu depuis embauches.jsonl : la depense du jour est la meme');
  const lignes = fs.readFileSync(path.join(dos, 'embauches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok(lignes.some((l) => l.etat === 'paye' && l.tx) && lignes.some((l) => l.etat === 'perte') && lignes.some((l) => l.etat === 'rendu') && !JSON.stringify(lignes).includes(CLE.slice(2)),
     'chaque embauche est au registre (paye, perte, rendu), et la cle n y est jamais');
  const S = mk('');
  ok(!(await S.pour('0xJ', F).embauche({ url: 'https://meteo.example/forecast' })).ok && S.etat().actif === false, 'sans AGENT_BUDGET_CLE : rien ne s embauche');
  ok(E.privee('127.0.0.1') && E.privee('169.254.169.254') && E.privee('::1') && E.privee('fd00::1') && E.privee('100.64.1.1') && !E.privee('93.184.215.14'), 'les adresses privees, locales et reservees sont reconnues');
  fs.rmSync(dos, { recursive: true, force: true });

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
