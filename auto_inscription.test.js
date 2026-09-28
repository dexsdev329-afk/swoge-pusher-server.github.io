'use strict';
/* L'inscription automatique au catalogue PayAI (auto_inscription.js) : il ne paie
   que NOTRE serveur vers NOTRE tresorerie, sous ses plafonds, une fois par outil,
   et la cle ne sort jamais. Un faux serveur verifie la VRAIE signature EIP-3009. */
const fs = require('fs'), os = require('os'), path = require('path');
const { ethers } = require('ethers');
const AI = require('./auto_inscription');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const API = 'https://web-production-220a3.up.railway.app';
const TRESOR = '0xE81C67c086c83997b41673e1e41e481c14D756F6';
const W = ethers.Wallet.createRandom();

function serveur(o) {
  o = o || {};
  const vus = { demandes: [], paiements: [] };
  const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64');
  const fetch = async (url, init) => {
    const outil = url.split('/').pop(), sig = init.headers['payment-signature'];
    vus.demandes.push({ url, outil, sig: !!sig, corps: JSON.parse(init.body) });
    const req = { x402Version: 2, resource: { url: (o.autreRessource || API) + '/agentic/call/' + outil },
      accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: o.autreActif || AI.USDC_BASE, payTo: o.autrePayTo || TRESOR, amount: String((o.prix || {})[outil] || 10000), maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } }],
      extensions: { bazaar: {} } };
    if (!sig) return { status: 402, headers: new Map([['payment-required', b64(req)]]), json: async () => ({}) };
    const p = JSON.parse(Buffer.from(sig, 'base64').toString());
    const qui = ethers.utils.verifyTypedData(AI.DOMAINE, AI.TYPES_3009, p.payload.authorization, p.payload.signature);
    vus.paiements.push({ outil, qui, to: p.payload.authorization.to, value: p.payload.authorization.value });
    if (o.refus) return { status: 402, headers: new Map(), json: async () => ({ ok: false, raison: 'invalid_exact_evm_payload_signature' }) };
    return { status: 200, headers: new Map([['payment-response', b64({ success: true, transaction: '0x' + 'ab'.repeat(32) })]]), json: async () => ({ ok: true }) };
  };
  return { fetch, vus };
}
const monde = (o) => {
  const S = serveur(o), dossier = o.dossier || fs.mkdtempSync(path.join(os.tmpdir(), 'autoinsc-')), journal = [];
  const A = AI.cree({ cle: o.cle === undefined ? W.privateKey : o.cle, api: API, payTo: TRESOR, fetch: S.fetch, dossier, journal: (x) => journal.push(x),
    outils: () => o.outils || ['scan_token', 'token_verdict', 'robinhood_token', 'chat_completion'],
    inscrits: async () => new Set(o.inscrits || ['scan_token']), prepares: o.prepares,
    exemples: { robinhood_token: { address: '0x' + '8a'.repeat(20) }, chat_completion: { messages: [{ role: 'user', content: 'hi' }] }, fair_draw: { commitment_id: 'mort', client_seed: 'agent-42' } } });
  return { A, S, dossier, journal };
};

(async () => {
  {
    const { A, S, dossier, journal } = monde({});
    const r = await A.passe();
    ok(r.ok && S.vus.paiements.map((p) => p.outil).join() === 'token_verdict,robinhood_token,chat_completion', 'paie les 3 outils absents du catalogue, pas scan_token (deja inscrit)');
    ok(S.vus.paiements.every((p) => p.qui === W.address && p.to === TRESOR && p.value === '10000'), 'chaque autorisation se verifie : signee par le portefeuille dedie, vers la tresorerie, le montant du 402');
    ok(S.vus.demandes.find((d) => d.outil === 'chat_completion').corps.arguments.messages[0].content === 'hi', 'avec les arguments d exemple de chaque outil');
    ok(A.etat().depenseUsd === 0.03 && A.etat().adresse === W.address, '0,03 $ depenses, l adresse publique est montree');
    const tout = JSON.stringify(A.etat()) + JSON.stringify(journal) + fs.readFileSync(path.join(dossier, 'auto_inscription.json'), 'utf8');
    ok(!tout.includes(W.privateKey.slice(2)) && !tout.toLowerCase().includes(W.privateKey.slice(2, 20).toLowerCase()), 'la cle privee n apparait NULLE PART (etat, journal, fichier)');
    const B = monde({ dossier });
    await B.A.passe();
    ok(B.S.vus.paiements.length === 0, 'au redemarrage (meme dossier) : rien n est repaye');
  }
  {
    const { A, S } = monde({ autrePayTo: '0x000000000000000000000000000000000000dEaD' });
    const r = await A.passe();
    ok(S.vus.paiements.length === 0 && /someone else/.test(r.faits[0].raison), 'un 402 qui paie quelqu un d autre que la tresorerie : refuse, RIEN n est signe');
  }
  {
    const { A, S } = monde({ autreRessource: 'https://evil.example' });
    const r = await A.passe();
    ok(S.vus.paiements.length === 0 && /not ours/.test(r.faits[0].raison), 'une ressource qui n est pas notre serveur : refuse');
  }
  {
    const { A, S } = monde({ autreActif: '0x0000000000000000000000000000000000000001' });
    await A.passe();
    ok(S.vus.paiements.length === 0, 'un actif qui n est pas l USDC de Base : refuse');
  }
  {
    const { A, S } = monde({ prix: { token_verdict: 50000 } });
    const r = await A.passe();
    ok(!S.vus.paiements.some((p) => p.outil === 'token_verdict') && /AUTO_MAX_APPEL_USD/.test(r.faits[0].raison), 'un appel a 0,05 $ (> 0,03 $ par appel) : refuse');
  }
  {
    process.env.AUTO_MAX_TOTAL_USD = '0.02';
    const { A, S } = monde({});
    const r = await A.passe();
    delete process.env.AUTO_MAX_TOTAL_USD;
    ok(S.vus.paiements.length === 2 && r.faits.length === 3 && /AUTO_MAX_TOTAL_USD/.test(r.faits[2].raison), 'plafond total 0,02 $ : 2 paiements, le 3e refuse et le passage s arrete');
  }
  {
    const { A, S, dossier } = monde({ refus: true, outils: ['token_verdict'] });
    await A.passe();
    ok(A.etat().depenseUsd === 0 && A.etat().faits.token_verdict.etat === 'echec', 'refuse au verify (rien debite) : la depense comptee est rendue');
    const B = monde({ refus: true, outils: ['token_verdict'], dossier }); await B.A.passe();
    const C = monde({ refus: true, outils: ['token_verdict'], dossier }); await C.A.passe();
    ok(B.S.vus.paiements.length === 1 && C.S.vus.paiements.length === 0, 'deux essais rates au plus par outil, puis plus jamais');
  }
  {
    /* fair_draw (28/09) : l'exemple publie ne designe aucun engagement vivant ; 2 essais rates en production. */
    const { A, dossier } = monde({ refus: true, outils: ['fair_draw'] });
    await A.passe(); await monde({ refus: true, outils: ['fair_draw'], dossier }).A.passe();
    let n = 0;
    const prepares = { fair_draw: { version: 'v1', args: async (a) => Object.assign(a, { commitment_id: 'vivant-' + (++n) }) } };
    const P = monde({ outils: ['fair_draw'], dossier, prepares });
    await P.A.passe();
    const d = P.S.vus.demandes.filter((x) => x.outil === 'fair_draw');
    ok(P.S.vus.paiements.length === 1 && d.every((x) => x.corps.arguments.commitment_id === 'vivant-1' && x.corps.arguments.client_seed === 'agent-42'),
       'une preparation versionnee : les essais rates avec l exemple mort ne comptent plus, l engagement vivant part (et le reste de l exemple)');
    const fic = path.join(dossier, fs.readdirSync(dossier).find((x) => /\.json$/.test(x)));
    const e0 = JSON.parse(fs.readFileSync(fic, 'utf8')); e0.faits.fair_draw.raison = 'HTTP 400 - vieux'; fs.writeFileSync(fic, JSON.stringify(e0));
    const Q = monde({ outils: ['fair_draw'], dossier, prepares }); await Q.A.passe();
    ok(Q.A.etat().faits.fair_draw.raison === null, 'une fiche payee ecrite avant la correction : sa vieille raison d echec est effacee au chargement');
    ok(Q.S.vus.demandes.length === 0 && P.A.etat().faits.fair_draw.etat === 'paye' && P.A.etat().faits.fair_draw.raison === null, 'paye une fois : plus jamais, et l ancienne raison d echec effacee');
    const R1 = monde({ refus: true, outils: ['fair_draw'], prepares: { fair_draw: { version: 'v2', args: async (a) => a } } });
    await R1.A.passe(); await monde({ refus: true, outils: ['fair_draw'], dossier: R1.dossier, prepares: { fair_draw: { version: 'v2', args: async (a) => a } } }).A.passe();
    const R3 = monde({ refus: true, outils: ['fair_draw'], dossier: R1.dossier, prepares: { fair_draw: { version: 'v2', args: async (a) => a } } }); await R3.A.passe();
    ok(R3.S.vus.demandes.length === 0, 'la meme version : deux essais rates au plus, comme les autres');
  }
  {
    /* Le Bazaar de Coinbase (28/09 au soir) : un second etat, la liste lue page par page. */
    const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'autoinsc-'));
    const P = monde({ outils: ['token_verdict'], dossier: dos, inscrits: [] }); await P.A.passe();
    const Z = AI.cree({ nom: 'bazaar', cle: W.privateKey, api: API, payTo: TRESOR, fetch: serveur({}).fetch, dossier: dos, outils: () => ['token_verdict'], inscrits: async () => new Set() });
    ok(P.A.etat().faits.token_verdict.etat === 'paye' && Z.etat().faits.token_verdict === undefined && fs.existsSync(path.join(dos, 'auto_inscription_bazaar.json')) === false,
       'l inscription du Bazaar a son propre etat : un outil paye chez PayAI reste a payer chez Coinbase');
    await Z.passe();
    ok(Z.etat().faits.token_verdict.etat === 'paye' && fs.existsSync(path.join(dos, 'auto_inscription_bazaar.json')) && P.A.etat().depenseUsd === 0.01 && Z.etat().depenseUsd === 0.01,
       'chacune son fichier et son plafond');
    const pages = [];
    const fz = async (u) => { pages.push(u); const off = Number(/offset=(\d+)/.exec(u)[1]);
      const items = off === 0 ? Array.from({ length: 1000 }, (_, i) => ({ resource: i === 7 ? API + '/agentic/call/scan_token' : 'https://autre.example/' + i }))
        : [{ resource: API + '/agentic/call/ask_agent' }, { resource: API + '/agentic/call2/x' }];
      return { ok: true, json: async () => ({ items }) }; };
    const noms = await AI.inscritsCdp(API, fz);
    ok([...noms].sort().join() === 'ask_agent,scan_token' && pages.length === 2 && /limit=1000&offset=1000/.test(pages[1]) && /^https:\/\/api\.cdp\.coinbase\.com\/platform\/v2\/x402\/discovery\/resources/.test(pages[0]),
       'le Bazaar lu par pages de 1 000 : seulement NOS outils');
    let refus = null; try { await AI.inscritsCdp(API, async () => ({ ok: false, status: 503 })); } catch (e) { refus = e.message; }
    ok(/503/.test(refus || ''), 'le Bazaar en panne : une erreur, jamais « rien d inscrit » (sinon on repaierait tout)');
    const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    ok(/AUTO_ADRESSE_BASE = [^\n]*w\.type !== 'solana'/.test(srv) && /versCdp: \(a\) => !!AUTO_ADRESSE_BASE/.test(srv) && /nom: 'bazaar'[^\n]*X402_AUTO_CLE_BASE/.test(srv)
       && /inscrits: \(\) => AI\.inscritsCdp/.test(srv) && /AUTO_ADRESSE_BASE \? \[AUTO_ADRESSE_BASE\]/.test(srv),
       'serveur : X402_AUTO_CLE_BASE (EVM seulement) aiguille vers Coinbase, lit le Bazaar, compte comme la maison');
  }
  {
    const { A } = monde({ cle: 'pas-une-cle' });
    const r = await A.passe();
    ok(!r.ok && r.raison === 'X402_AUTO_CLE is not a valid private key' && A.etat().actif === false, 'une cle invalide : rien, et le message ne la repete pas');
    ok(!(await monde({ cle: '' }).A.passe()).ok, 'sans X402_AUTO_CLE : rien');
  }
  /* ---- Une cle SOLANA (27/09 : le proprietaire a mis une cle Solana et ses USDC sur Solana) ---- */
  {
    const crypto = require('crypto');
    const Sol = require('./x402_solana');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const graine = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32), pub = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
    const ADR = ethers.utils.base58.encode(pub), PHANTOM = ethers.utils.base58.encode(Buffer.concat([graine, pub]));
    ok(AI.portefeuille(PHANTOM).type === 'solana' && AI.portefeuille(PHANTOM).address === ADR, 'la cle exportee de Phantom (base58, 64 octets) : un portefeuille Solana, la bonne adresse');
    ok(AI.portefeuille(JSON.stringify(Array.from(Buffer.concat([graine, pub])))).address === ADR && AI.portefeuille(ethers.utils.base58.encode(graine)).address === ADR,
       'le tableau JSON du CLI (64 nombres) et la graine seule (32 octets) : la meme adresse');
    const faux = Buffer.concat([graine, crypto.randomBytes(32)]);
    ok(AI.portefeuille(ethers.utils.base58.encode(faux)) === null, '64 octets dont la moitie publique ne correspond pas : refuse');
    const PAYTO_SOL = 'CFg86EW2ZSAgGpf4o2XAt3gU59fgMfsuZyM6QDuDTmoM', FEE = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww', BH = '9zJ3sY2qvAoMYrgkXYWkrvBWTTjvP6T9BGFsMwAGrFg6';
    const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64');
    const recus = [];
    const fetch = async (url, init) => {
      const outil = url.split('/').pop(), sig = init.headers['payment-signature'];
      const req = { x402Version: 2, resource: { url: API + '/agentic/call/' + outil },
        accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: AI.USDC_BASE, payTo: TRESOR, amount: '6000', maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } },
          { scheme: 'exact', network: AI.RESEAU_SOLANA, asset: AI.USDC_SOLANA, payTo: PAYTO_SOL, amount: '6000', maxTimeoutSeconds: 120, extra: { feePayer: FEE } }], extensions: {} };
      if (!sig) return { status: 402, headers: new Map([['payment-required', b64(req)]]), json: async () => ({}) };
      const p = JSON.parse(Buffer.from(sig, 'base64').toString()), tx = Buffer.from(p.payload.transaction, 'base64');
      recus.push({ outil, reseau: p.accepted.network, tx });
      return { status: 200, headers: new Map([['payment-response', b64({ success: true, transaction: '5' + 'A'.repeat(87) })]]), json: async () => ({ ok: true }) };
    };
    const A = AI.cree({ cle: PHANTOM, api: API, payTo: TRESOR, payToSolana: PAYTO_SOL, fetch, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'autoinsc-')),
      blockhash: async () => ({ ok: true, blockhash: BH }), outils: () => ['token_verdict'], inscrits: async () => new Set() });
    const r = await A.passe();
    const t = recus[0] && recus[0].tx, msg = t && t.slice(1 + 128);
    const cle = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
    ok(r.ok && recus.length === 1 && recus[0].reseau === AI.RESEAU_SOLANA && A.etat().reseau === 'solana', 'une cle Solana paie l offre SOLANA du 402 (pas Base)');
    ok(t && t[0] === 2 && t.slice(1, 65).every((x) => x === 0) && crypto.verify(null, msg, cle, t.slice(65, 129)), 'la transaction : la signature du feePayer vide, celle du payeur valide (ed25519)');
    const attendu = await Sol.construit({ amount: '6000', asset: AI.USDC_SOLANA, payTo: PAYTO_SOL, extra: { feePayer: FEE } }, { payeur: ADR, blockhash: BH, memo: msg.slice(msg.length - 33, msg.length - 1).toString() });
    ok(Buffer.from(attendu.message).equals(msg), 'le message signe : feePayer du 402, 6 000 (0,006 USDC) vers le compte USDC de NOTRE adresse, le blockhash de notre noeud');
    const B = AI.cree({ cle: PHANTOM, api: API, payTo: TRESOR, payToSolana: 'Autre1111111111111111111111111111111111111', fetch, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'autoinsc-')),
      blockhash: async () => ({ ok: true, blockhash: BH }), outils: () => ['token_verdict'], inscrits: async () => new Set() });
    const rb = await B.passe();
    ok(recus.length === 1 && /someone else/.test(rb.faits[0].raison), 'Solana aussi : un 402 qui paie une autre adresse que la notre est refuse, rien signe');
    const C = AI.cree({ cle: PHANTOM, api: API, payTo: TRESOR, payToSolana: PAYTO_SOL, fetch, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'autoinsc-')),
      blockhash: async () => ({ ok: false, raison: 'node down' }), outils: () => ['token_verdict'], inscrits: async () => new Set() });
    const rc = await C.passe();
    ok(recus.length === 1 && /no recent Solana blockhash \(node down\)/.test(rc.faits[0].raison) && C.etat().depenseUsd === 0, 'sans blockhash de notre noeud : rien signe, rien compte');
    const tout = JSON.stringify(A.etat()) + JSON.stringify(r);
    ok(!tout.includes(PHANTOM) && !tout.includes(PHANTOM.slice(0, 20)), 'la cle Solana n apparait nulle part');
  }
  /* Le constructeur Solana est le MEME fichier que celui de la page de test (site) : une seule verite. */
  {
    const site = path.join(__dirname, '..', 'SWOGE.github.io', 'x402_solana.js');
    if (fs.existsSync(site)) ok(fs.readFileSync(site, 'utf8') === fs.readFileSync(path.join(__dirname, 'x402_solana.js'), 'utf8'), 'x402_solana.js : identique au fichier du site (sinon : le recopier)');
  }
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
