'use strict';
/* achats.js : l'agent propose une eSIM, le joueur confirme, la maison paie CHIPS en
   USDC sur Solana, le joueur est facture en $SWOGE sur un 200 seulement, et le code
   d'activation n'est rendu qu'a lui. Le faux CHIPS suit le contrat de
   https://vamoschips.com/openapi.json (lu le 28/09/2026). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const A = require('./achats');
const X = require('./x402_client');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const kp = crypto.generateKeyPairSync('ed25519');
const graine = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32);
const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
const CLE = ethers.utils.base58.encode(Buffer.concat([graine, pub]));
const MOI = ethers.utils.base58.encode(pub);
const PAYTO = '8NaSRBmqA12sVwf7d9QoK11CriReCGbwoNagsZuCo13a', FEE = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';
const BASE = 'https://vamoschips.com';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const rep = (status, corps, h) => new Response(typeof corps === 'string' ? corps : JSON.stringify(corps), { status, headers: Object.assign({ 'content-type': 'application/json' }, h || {}) });

const G = 1073741824;
const PLANS = [
  { slug: 'europe-1gb-day-x1', name: 'Europe 1GB/Day', isDaily: true, dataBytes: null, dailyDataBytes: G, durationDays: null },
  { slug: 'europe-3gb-30days-x3', name: 'Europe 3GB 30Days', isDaily: false, dataBytes: 3 * G, durationDays: 30, speed: '4G/5G' },
  { slug: 'europe-1gb-7days-x2', name: 'Europe 1GB 7Days', isDaily: false, dataBytes: G, durationDays: 7, speed: '4G/5G', activationRule: 'first-network-connection' },
  { slug: 'europe-20gb-30days-x4', name: 'Europe 20GB 30Days', isDaily: false, dataBytes: 20 * G, durationDays: 30 },
  { slug: 'europe-5gb-30days-panne', name: 'Europe 5GB 30Days', isDaily: false, dataBytes: 5 * G, durationDays: 30 },
  { slug: 'Mauvais Slug', name: 'Bad', isDaily: false, dataBytes: 2 * G, durationDays: 10 },
];
const PRIX = { 'europe-1gb-7days-x2': 5800581, 'europe-3gb-30days-x3': 12500000, 'europe-20gb-30days-x4': 40000000, 'europe-5gb-30days-panne': 9000000 };
const CH = { idem: [], payes: [], installs: [], pasPret: 0, horsHote: [] };
async function fauxChips(url, o) {
  const u = new URL(url);
  if (u.origin !== BASE) { CH.horsHote.push(url); return rep(404, {}); }
  const h = o.headers || {};
  if (u.pathname === '/api/v1/destinations') return rep(200, { total: 3, limit: 100, offset: 0, items: [
    { slug: 'europe-region', kind: 'region', name: 'Europe', countryCodes: ['FR', 'DE', 'ES'] },
    { slug: 'fr-country', kind: 'country', name: 'France', countryCodes: ['FR'] },
    { slug: 'us-country', kind: 'country', name: 'United States', countryCodes: ['US'] }] });
  if (u.pathname === '/api/v1/destinations/us-country/plans') return rep(200, { total: 0, limit: 100, offset: 0, items: [] });
  if (u.pathname === '/api/v1/destinations/fr-country/plans') return rep(200, { total: PLANS.length, limit: 100, offset: 0, items: PLANS });
  if (u.pathname === '/api/v1/x402/orders' && o.method === 'POST') {
    const b = JSON.parse(o.body);
    CH.idem.push(h['idempotency-key']);
    if (!b.acceptTerms || !b.quote || !PRIX[b.quote.planSlug]) return rep(400, { error: { code: 'INVALID' } });
    const amount = String(PRIX[b.quote.planSlug]);
    const req = { x402Version: 2, resource: { url: BASE + '/api/v1/x402/orders' }, accepts: [
      { scheme: 'exact', network: X.RESEAU_SOLANA, asset: X.USDC_SOLANA, amount, payTo: PAYTO, maxTimeoutSeconds: 120, extra: { feePayer: FEE } },
      { scheme: 'exact', network: 'eip155:8453', asset: X.USDC_BASE, amount, payTo: '0x' + '10'.repeat(20), maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } }] };
    if (!h['payment-signature']) return rep(402, {}, { 'payment-required': b64(req) });
    const p = JSON.parse(Buffer.from(h['payment-signature'], 'base64').toString());
    CH.payes.push({ plan: b.quote.planSlug, cle: h['idempotency-key'], reseau: p.accepted && p.accepted.network, montant: p.accepted && p.accepted.amount });
    if (b.quote.planSlug === 'europe-5gb-30days-panne') return rep(503, { error: { code: 'LANE_CLOSED' } });
    const id = '0f0e0d0c-0b0a-4908-8706-0504030201' + String(CH.payes.length).padStart(2, '0');
    return rep(200, { x402Version: 2, order: { publicId: id, status: 'provider_ordering', totalMinor: 580 },
      delivery: { grantToken: 'grant-' + id, installUrl: BASE + '/api/v1/x402/orders/' + id + '/install' } }, { 'payment-response': b64({ success: true, transaction: 'solTx' + CH.payes.length }) });
  }
  const m = u.pathname.match(/^\/api\/v1\/x402\/orders\/([0-9a-f-]+)\/install$/);
  if (m && o.method === 'POST') {
    CH.installs.push(h.authorization);
    if (h.authorization !== 'Bearer grant-' + m[1]) return rep(401, { error: { code: 'BAD_GRANT' } });
    if (CH.pasPret > 0) { CH.pasPret--; return rep(409, { error: { code: 'NOT_READY' } }); }
    return rep(200, { order: { publicId: m[1], status: 'delivered' }, activationUri: 'LPA:1$smdp.example.net$ACT-' + m[1].slice(-4), activationCode: 'ACT-' + m[1].slice(-4),
      smdpAddress: 'smdp.example.net', iccidLast4: '4242', revealCount: 1 });
  }
  return rep(404, {});
}

(async () => {
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'achats-'));
  let horloge = Date.UTC(2026, 8, 28, 17, 0);
  let usdcMaison = 50e6;
  const rpc = async (m) => { if (m !== 'getTokenAccountsByOwner') throw new Error('?');
    return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(usdcMaison) } } } } } }] }; };
  const mk = (o) => A.cree(Object.assign({ cle: CLE, fetch: fauxChips, resout: async () => ['104.21.3.4'], dossier: dos, maintenant: () => horloge, rpcSolana: rpc,
    blockhash: async () => ({ ok: true, blockhash: ethers.utils.base58.encode(Buffer.alloc(32, 9)) }) }, o || {}));
  const H = mk();
  let solde = 100;
  const factu = [];
  const F = { reserve: async (usd) => { if (usd > solde) return { ok: false, raison: 'your balance is too low for this eSIM' }; solde -= usd; factu.push(['reserve', usd]); return { ok: true, jeton: usd }; },
    regle: async (j, usd) => { solde += j - usd; factu.push(['regle', j, usd]); } };
  const J = H.pour('0xJOUEUR', F);

  console.log('\n-- chercher : le pays, les forfaits a duree fixe, leur prix (402 non paye) --');
  const f = await J.forfaits({ pays: 'france' });
  ok(f.ok && f.destination.nom === 'France' && f.destination.autres.includes('Europe') && !f.destination.autres.includes('United States'),
     'France (le pays) d abord ; Europe, la region qui couvre la France, proposee aussi ; pas les Etats-Unis');
  ok(f.forfaits.map((x) => x.plan).join(',') === 'europe-5gb-30days-panne,europe-3gb-30days-x3,europe-1gb-7days-x2',
     'forfaits a duree fixe, le moins cher par Go d abord ; sans le forfait par jour, sans le slug invalide, sans celui au-dessus de 15 $ : ' + f.forfaits.map((x) => x.plan).join(','));
  const p1 = f.forfaits.find((x) => x.plan === 'europe-1gb-7days-x2');
  ok(p1.usd === 5.800581 && p1.factureUsd === 6.09061 && p1.go === 1 && p1.jours === 7, 'le prix lu dans le 402 (5,800581 $), facture +5 % (6,09061 $), 1 Go, 7 jours');
  ok(CH.payes.length === 0 && new Set(CH.idem).size === CH.idem.length, 'chercher ne paie rien ; chaque sonde a sa propre Idempotency-Key');
  const f3 = await J.forfaits({ pays: 'fr', go: 3 });
  ok(f3.ok && f3.destination.nom === 'France' && f3.forfaits.length === 2 && f3.forfaits.every((x) => x.go >= 3), 'le code pays et « au moins 3 Go » filtrent');
  ok((await J.forfaits({ pays: 'us' })).destination.nom === 'United States', '« us » est un code pays, pas un bout de nom (ni Austria, ni Australia)');
  ok(!(await J.forfaits({ pays: 'atlantide' })).ok, 'un pays inconnu : dit, rien d invente');

  console.log('\n-- proposer : seulement un forfait trouve, dans les plafonds --');
  ok(/find_esim_plans/.test((await J.propose({ plan: 'europe-99gb-x9' })).raison), 'un forfait que la recherche n a pas rendu : refuse');
  const pr = await J.propose({ plan: 'europe-1gb-7days-x2' });
  ok(pr.ok && pr.offre.factureUsd === 6.09061 && pr.offre.expire === horloge + A.OFFRE_MS && /legal\/terms/.test(pr.offre.conditions) && !('cle' in pr.offre),
     'l offre : prix facture, 15 min, les conditions du vendeur, sans la cle interne');
  ok(CH.payes.length === 0 && factu.length === 0, 'proposer ne paie rien et ne reserve rien');

  console.log('\n-- confirmer : le joueur seul, une fois, au prix vu --');
  const autre = H.pour('0xAUTRE', F);
  ok(/not yours/.test((await autre.confirme(pr.offre.id)).raison) && CH.payes.length === 0, 'un autre joueur ne peut pas confirmer l offre');
  const [c1, c2] = await Promise.all([J.confirme(pr.offre.id), J.confirme(pr.offre.id)]);
  const bon = c1.ok ? c1 : c2, double = c1.ok ? c2 : c1;
  ok(bon.ok && !double.ok && CH.payes.length === 1, 'un double clic : un seul paiement');
  ok(CH.payes[0].reseau === X.RESEAU_SOLANA && CH.payes[0].montant === '5800581', 'paye en USDC sur Solana, le montant du 402');
  const cles = CH.idem.slice(-2);
  ok(cles[0] === cles[1] && cles[0] === CH.payes[0].cle, 'le 402 et le paiement portent la MEME Idempotency-Key');
  ok(bon.livree && bon.achat.activation && bon.achat.activation.uri.startsWith('LPA:1$smdp.example.net$') && bon.achat.activation.iccid4 === '4242' && bon.achat.tx === 'solTx1',
     'livre : le code d activation (LPA), l ICCID, la transaction');
  ok(CH.installs[0] === 'Bearer grant-' + '0f0e0d0c-0b0a-4908-8706-050403020101', 'le code est demande avec le jeton de livraison du vendeur');
  ok(Math.abs(solde - (100 - 6.09061)) < 1e-9 && factu.slice(-1)[0][2] === 6.09061, 'facture au prix montre, apres le 200');
  ok(!JSON.stringify(J.liste()).includes('grant-') && !JSON.stringify(J.liste()).includes('swoge-'), 'le joueur ne voit ni le jeton de livraison ni la cle interne');
  ok(autre.liste().length === 0 && !(await autre.livre(bon.achat.id)).ok, 'un autre joueur ne voit ni ne recupere l eSIM');
  ok(/already used/.test((await J.confirme(pr.offre.id)).raison), 'une offre payee ne se repaie pas');

  console.log('\n-- les refus, tous avant de payer --');
  let o = await J.propose({ plan: 'europe-3gb-30days-x3' });
  horloge += A.OFFRE_MS + 1;
  ok(/expired/.test((await J.confirme(o.offre.id)).raison), 'une offre de plus de 15 min : refusee');
  o = await J.propose({ plan: 'europe-3gb-30days-x3' });
  PRIX['europe-3gb-30days-x3'] = 12700000;
  const k0 = CH.payes.length;
  ok(/price changed/.test((await J.confirme(o.offre.id)).raison) && CH.payes.length === k0, 'le prix monte de plus de 1 % entre l offre et le clic : rien paye');
  PRIX['europe-3gb-30days-x3'] = 12500000;
  o = await J.propose({ plan: 'europe-3gb-30days-x3' });
  const sol0 = solde; solde = 1;
  const pauvre = await J.confirme(o.offre.id);
  ok(!pauvre.ok && /balance is too low/.test(pauvre.raison) && CH.payes.length === k0, 'solde trop bas : refuse, rien paye');
  solde = sol0;
  ok((await J.confirme(o.offre.id)).ok, 'la meme offre reste confirmable une fois le solde remis');
  const pn = await J.propose({ plan: 'europe-5gb-30days-panne' });
  const sp = solde;
  const rp = await J.confirme(pn.offre.id);
  ok(!rp.ok && /not charged/.test(rp.raison) && solde === sp, 'le vendeur refuse apres la signature (503) : le joueur n est pas facture');
  usdcMaison = 1e6;
  horloge += 61e3;
  ok(/short on funds/.test((await J.propose({ plan: 'europe-1gb-7days-x2' })).raison), 'le portefeuille de la boutique n a pas assez d USDC : dit avant l offre');
  usdcMaison = 50e6;

  console.log('\n-- les plafonds --');
  const b = J.budget();
  ok(Math.abs(b.depenseUsd - (5.800581 + 12.5)) < 1e-6, 'le plafond du jour compte les achats payes et livres, pas le refus du vendeur : ' + b.depenseUsd);
  ok(/daily purchase limit/.test((await J.propose({ plan: 'europe-3gb-30days-x3' })).raison), 'au-dela de 30 $ par jour et par joueur : refuse des l offre');
  process.env.ACHAT_MAX_USD = '5';
  ok(/above the 5 \$ limit/.test((await autre.forfaits({ pays: 'france' }), await autre.propose({ plan: 'europe-1gb-7days-x2' })).raison), 'ACHAT_MAX_USD : le plafond par achat');
  delete process.env.ACHAT_MAX_USD;

  console.log('\n-- livraison en retard, puis redemarrage --');
  horloge += 24 * 3600e3;
  CH.pasPret = 1;
  const o2 = await J.propose({ plan: 'europe-1gb-7days-x2' });
  const tard = await J.confirme(o2.offre.id);
  ok(tard.ok && !tard.livree && tard.achat.etat === 'paye' && tard.achat.activation === null, 'paye mais pas encore pret (409) : facture, en attente de livraison');
  const lv = await J.livre(tard.achat.id);
  ok(lv.ok && lv.achat.activation && lv.achat.etat === 'livre', 'le joueur redemande : le code arrive');
  const H2 = mk();
  const J2 = H2.pour('0xJOUEUR', F);
  ok(J2.liste().length === 3 && J2.liste().every((a) => a.activation) && Math.abs(J2.budget().depenseUsd - 5.800581) < 1e-6, 'relu depuis achats.jsonl : trois eSIM, avec leur code ; le plafond du jour aussi');
  const lignes = fs.readFileSync(path.join(dos, 'achats.jsonl'), 'utf8');
  ok(!lignes.includes(CLE) && !lignes.includes(graine.toString('hex')), 'la cle du portefeuille n est jamais au registre');
  ok(CH.horsHote.length === 0, 'aucune requete ailleurs que chez le vendeur');

  console.log('\n-- sans cle, ou coupe --');
  ok(!mk({ cle: '' }).actif() && !(await mk({ cle: '' }).pour('0xj', F).propose({ plan: 'x' })).ok, 'sans AGENT_BUDGET_CLE : rien ne s achete');
  process.env.ACHATS = '0';
  ok(!mk().actif(), 'ACHATS=0 coupe les achats');
  delete process.env.ACHATS;
  ok(!A.cree({ cle: '0x' + '11'.repeat(32), dossier: dos }).actif(), 'une cle EVM : pas d achat (le vendeur est paye sur Solana dans cette version)');

  fs.rmSync(dos, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
