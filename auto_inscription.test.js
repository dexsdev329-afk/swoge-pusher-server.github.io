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
    inscrits: async () => new Set(o.inscrits || ['scan_token']), exemples: { robinhood_token: { address: '0x' + '8a'.repeat(20) }, chat_completion: { messages: [{ role: 'user', content: 'hi' }] } } });
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
    const { A } = monde({ cle: 'pas-une-cle' });
    const r = await A.passe();
    ok(!r.ok && r.raison === 'X402_AUTO_CLE is not a valid private key' && A.etat().actif === false, 'une cle invalide : rien, et le message ne la repete pas');
    ok(!(await monde({ cle: '' }).A.passe()).ok, 'sans X402_AUTO_CLE : rien');
  }
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
