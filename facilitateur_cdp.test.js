'use strict';
/*
 * LE FACILITATEUR DE COINBASE (facilitateur_cdp.js) contre un FAUX Coinbase
 * local qui parle ses vraies formes (contrat base_design/CONTRAT.md §F.1,
 * 27 septembre 2026) :
 *   1. le jeton : un par requête, vérifié ICI avec la clé publique de l'essai
 *      (crypto.verify seul) — en-tête, revendications, `uris` exacts, 120 s,
 *      Ed25519 et P-256 (PKCS#8, SEC1, « \n » écrit), barre finale tolérée ;
 *   2. les mauvaises clés jettent, et aucun message ne contient le secret ;
 *   3. les réponses : verify valide / refusé (200 et 400) / 403 kyt ;
 *      settle payé / échec / ambigu / 402 / « en attente » sous 500 ET 400
 *      (renvoyé UNE fois, mêmes octets) / délai (JAMAIS rejoué) ;
 *      le vrai 401 (text/plain « Unauthorized\n ») ;
 *   4. avec x402.js : un 401 SUSPEND Base (pas une « erreur inattendue »), un
 *      402 aussi, un 403 kyt ne refuse QUE ce paiement ; EXTENSION-RESPONSES
 *      est lu et compté sur verify ET settle, et ne revient JAMAIS au payeur.
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { ethers } = require('ethers');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const F = require('./facilitateur_cdp');
const X = require('./x402');
const b64u = (b) => Buffer.from(b).toString('base64url');
const de64u = (t) => JSON.parse(Buffer.from(t, 'base64url').toString('utf8'));
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- DES CLÉS JETABLES, FAITES ICI ---- */
function cleEd25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const j = privateKey.export({ format: 'jwk' });
  const secret = Buffer.concat([Buffer.from(j.d, 'base64url'), Buffer.from(j.x, 'base64url')]).toString('base64');
  return { secret, pub: publicKey, alg: 'EdDSA' };
}
function cleP256() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }), sec1: privateKey.export({ format: 'pem', type: 'sec1' }), pub: publicKey, alg: 'ES256' };
}

/* ---- LE FAUX COINBASE ----
 * /platform/v2/x402/{supported,verify,settle}. Vérifie le jeton avec la clé
 * publique de l'essai : mauvais, expiré ou mal adressé → 401 text/plain
 * « Unauthorized\n » (le vrai format, relevé le 26 septembre 2026). Garde
 * chaque requête (corps en OCTETS, jeton). Les réponses se choisissent par essai. */
function fauxCoinbase(cles) {
  const S = { requetes: [], refus: 0, verify: [], settle: [], ext: null, pendre: false };
  const jetonOk = (tok, attendu) => {
    try {
      const [h, c, sg] = String(tok || '').split('.');
      const en = de64u(h), co = de64u(c);
      const k = cles.find((x) => x.kid === en.kid);
      if (!k || en.alg !== k.alg || en.typ !== 'JWT' || !/^[0-9a-f]{32}$/.test(en.nonce)) return false;
      const t = Math.floor(Date.now() / 1000);
      if (co.sub !== k.kid || co.iss !== 'cdp' || JSON.stringify(co.uris) !== JSON.stringify([attendu]) || !(co.exp > t) || co.nbf > t + 5 || co.exp - co.nbf !== 120) return false;
      const sig = Buffer.from(sg, 'base64url');
      return k.alg === 'EdDSA' ? crypto.verify(null, Buffer.from(h + '.' + c), k.pub, sig)
        : sig.length === 64 && crypto.verify('sha256', Buffer.from(h + '.' + c), { key: k.pub, dsaEncoding: 'ieee-p1363' }, sig);
    } catch (e) { return false; }
  };
  const srv = http.createServer((req, res) => {
    const bouts = [];
    req.on('data', (d) => bouts.push(d));
    req.on('end', async () => {
      const corps = Buffer.concat(bouts);
      const op = req.url.split('/').pop();
      const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!jetonOk(tok, req.method + ' ' + req.headers.host + req.url)) {
        S.refus++;
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Unauthorized\n');
      }
      S.requetes.push({ op, url: req.url, methode: req.method, corps, tok, entetes: req.headers });
      const envoie = (statut, o, h) => { res.writeHead(statut, Object.assign({ 'content-type': 'application/json' }, S.ext ? { 'extension-responses': Buffer.from(JSON.stringify(S.ext)).toString('base64') } : {}, h || {})); res.end(JSON.stringify(o)); };
      if (op === 'supported') return envoie(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: ['bazaar'], signers: {} });
      const liste = op === 'verify' ? S.verify : S.settle;
      const r = liste.length > 1 ? liste.shift() : liste[0];
      if (!r) return envoie(500, { errorType: 'internal' });
      if (r.pendre) { await dort(r.pendre); }
      if (r.texte !== undefined) { res.writeHead(r.statut, { 'content-type': 'text/plain' }); return res.end(r.texte); }
      return envoie(r.statut, r.corps);
    });
  });
  return { srv, S };
}

(async () => {
  const ed = cleEd25519(), ec = cleP256();
  const cles = [{ kid: 'k-ed', alg: 'EdDSA', pub: ed.pub }, { kid: 'k-ec', alg: 'ES256', pub: ec.pub }, { kid: 'k-sec1', alg: 'ES256', pub: ec.pub }, { kid: 'k-nl', alg: 'ES256', pub: ec.pub }];
  const fc = fauxCoinbase(cles);
  const port = await libre();
  await new Promise((r) => fc.srv.listen(port, '127.0.0.1', r));
  const URL0 = 'http://127.0.0.1:' + port + '/platform/v2/x402';
  const S = fc.S;
  const HASH = '0x' + 'ab'.repeat(32);
  const secretsTous = [ed.secret, ec.pkcs8, ec.sec1];

  console.log('-- 1. le jeton, verifie avec la cle publique de l essai --');
  for (const [nom, kid, secret] of [['Ed25519', 'k-ed', ed.secret], ['P-256 PKCS#8', 'k-ec', ec.pkcs8], ['P-256 SEC1', 'k-sec1', ec.sec1], ['P-256, \\n ecrit sur une ligne', 'k-nl', ec.pkcs8.replace(/\n/g, '\\n')]]) {
    const f = F.cree({ url: URL0, cleId: kid, cleSecrete: secret });
    S.requetes.length = 0; S.refus = 0;
    const sup = await f.supported();
    S.verify = [{ statut: 200, corps: { isValid: true, payer: '0x' + '11'.repeat(20) } }];
    S.settle = [{ statut: 200, corps: { success: true, payer: '0x' + '11'.repeat(20), transaction: HASH, network: 'eip155:8453', amount: '20000' } }];
    const v = await f.verify({ x402Version: 2 }, { network: 'eip155:8453' });
    const g = await f.regle({ x402Version: 2 }, { network: 'eip155:8453' });
    ok(sup.ok && v.etat === 'valide' && g.etat === 'paye' && g.hash === HASH && S.refus === 0 && S.requetes.length === 3, nom + ' : supported, verify, settle acceptes par le faux Coinbase (jeton verifie avec crypto.verify)');
    const [a, b2, c] = S.requetes.map((q) => q.tok.split('.'));
    const h = de64u(a[0]), cl = [a, b2, c].map((x) => de64u(x[1]));
    ok(h.alg === (kid === 'k-ed' ? 'EdDSA' : 'ES256') && h.kid === kid && h.typ === 'JWT' && /^[0-9a-f]{32}$/.test(h.nonce), nom + ' : en-tete { alg, kid, typ JWT, nonce 32 hex }');
    ok(cl.every((x) => x.sub === kid && x.iss === 'cdp' && x.exp - x.nbf === 120 && x.iat === x.nbf)
       && JSON.stringify(cl.map((x) => x.uris)) === JSON.stringify([['GET 127.0.0.1:' + port + '/platform/v2/x402/supported'], ['POST 127.0.0.1:' + port + '/platform/v2/x402/verify'], ['POST 127.0.0.1:' + port + '/platform/v2/x402/settle']]),
       nom + ' : sub = id, iss cdp, 120 s, iat = nbf, uris EXACTS par operation (GET supported, POST verify, POST settle)');
    if (kid !== 'k-ed') ok(Buffer.from(a[2], 'base64url').length === 64, nom + ' : signature ES256 en r||s, 64 octets');
    ok(new Set(S.requetes.map((q) => JSON.parse(Buffer.from(q.tok.split('.')[0], 'base64url')).nonce)).size === 3 && new Set(S.requetes.map((q) => q.tok)).size === 3,
       nom + ' : un jeton NEUF par requete (nonces tous differents)');
  }
  {
    const f = F.cree({ url: URL0 + '/', cleId: 'k-ed', cleSecrete: ed.secret });
    S.requetes.length = 0; S.refus = 0;
    const v = await f.verify({ x402Version: 2 }, {});
    ok(v.etat === 'valide' && S.refus === 0 && S.requetes[0].url === '/platform/v2/x402/verify' && !/\/\//.test(S.requetes[0].url)
       && de64u(S.requetes[0].tok.split('.')[1]).uris[0] === 'POST 127.0.0.1:' + port + '/platform/v2/x402/verify',
       'CDP_FACILITATOR_URL avec une barre finale : ni le chemin ni `uris` n ont de double barre (sinon 401)');
    eq(F.URL_DEFAUT, 'https://api.cdp.coinbase.com/platform/v2/x402', 'l adresse par defaut : celle du SDK (x402/facilitator.ts:10)');
    ok(F.adresse(F.URL_DEFAUT, 'verify').uri === 'api.cdp.coinbase.com/platform/v2/x402/verify', 'uri reelle : « POST api.cdp.coinbase.com/platform/v2/x402/verify »');
  }

  console.log('\n-- 2. les mauvaises cles jettent, sans jamais dire le secret --');
  {
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    const e2 = cleEd25519();
    const raw = Buffer.from(e2.secret, 'base64');
    const autrePub = Buffer.from(cleEd25519().secret, 'base64').subarray(32);
    const incoherent = Buffer.concat([raw.subarray(0, 32), autrePub]).toString('base64');
    const court = raw.subarray(0, 63).toString('base64');
    for (const [nom, sec] of [['63 octets', court], ['P-384', p384], ['charabia', 'not-a-key-at-all-QmFzZTY0'], ['Ed25519 dont la moitie publique ne va pas avec la graine', incoherent]]) {
      let err = null;
      try { F.cree({ url: URL0, cleId: 'k', cleSecrete: sec }); } catch (e) { err = e; }
      const m = err ? String(err.message) + String(err.stack) : '';
      ok(err && !m.includes(sec.trim()) && !m.includes(sec.trim().slice(0, 20)) && /not an Ed25519 or P-256 key/.test(m), nom + ' : refusee (' + (err && err.message) + '), le secret absent du message');
    }
    let e3 = null;
    try { F.lisSecret(incoherent); } catch (e) { e3 = e; }
    ok(e3 && /public half does not match seed/.test(e3.message), 'la moitie publique est VERIFIEE contre la graine (Node signerait avec la graine seule)');
  }

  console.log('\n-- 3. les reponses de Coinbase, lues statut d abord --');
  const f = F.cree({ url: URL0, cleId: 'k-ed', cleSecrete: ed.secret, delaiSettleMs: 300, delaiVerifyMs: 300 });
  const P = { x402Version: 2, accepted: {}, payload: { signature: '0x', authorization: { validBefore: String(Math.floor(Date.now() / 1000) + 100) } } };
  const E = { scheme: 'exact', network: 'eip155:8453', amount: '20000' };
  {
    S.requetes.length = 0;
    S.verify = [{ statut: 200, corps: { isValid: true, payer: '0xabc' } }];
    await f.verify(P, E);
    const cj = JSON.parse(S.requetes[0].corps.toString());
    ok(JSON.stringify(Object.keys(cj)) === '["x402Version","paymentPayload","paymentRequirements"]' && cj.x402Version === 2 && JSON.stringify(cj.paymentRequirements) === JSON.stringify(E),
       'le corps : { x402Version: 2, paymentPayload, paymentRequirements }');
    ok(S.requetes[0].entetes['content-type'] === 'application/json' && S.requetes[0].entetes.accept === 'application/json' && /^Bearer ey/.test(S.requetes[0].entetes.authorization),
       'en-tetes : Content-Type et Accept JSON, Authorization: Bearer <jeton>');
    S.verify = [{ statut: 400, corps: { isValid: false, invalidReason: 'insufficient_funds', invalidMessage: 'not enough', payer: '0xabc' } }];
    const v1 = await f.verify(P, E);
    S.verify = [{ statut: 200, corps: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: '0xabc' } }];
    const v2 = await f.verify(P, E);
    S.verify = [{ statut: 403, corps: { errorType: 'kyt_risk_detected', errorMessage: 'screened' } }];
    const v3 = await f.verify(P, E);
    S.verify = [{ statut: 403, corps: { errorType: 'request_blocked_by_location' } }];
    const v4 = await f.verify(P, E);
    ok(v1.etat === 'refuse' && v1.raison === 'insufficient_funds' && v2.etat === 'refuse' && v2.raison === 'invalid_exact_evm_payload_signature',
       'verify refuse (isValid false) sous 400 ET sous 200 : la raison de Coinbase');
    ok(v3.etat === 'kyt' && v4.etat === 'lieu', 'verify 403 : kyt_risk_detected et request_blocked_by_location reconnus');
    S.verify = [{ statut: 502, texte: '<html>bad gateway</html>' }];
    eq((await f.verify(P, E)).etat, 'inconnu', 'verify 5xx sans JSON : unexpected_verify_error (inconnu)');
  }
  {
    const fMal = F.cree({ url: URL0, cleId: 'k-ed', cleSecrete: cleEd25519().secret });
    const vM = await fMal.verify(P, E);
    const gM = await fMal.regle(P, E);
    ok(vM.etat === 'cle' && vM.statut === 401 && gM.etat === 'echec' && gM.pause === 'cle', 'une MAUVAISE cle : le vrai 401 text/plain lu comme un probleme de cle (pas une erreur inattendue)');
    const fVieux = F.cree({ url: URL0, cleId: 'k-ed', cleSecrete: ed.secret, maintenant: () => Date.now() - 600000 });
    eq((await fVieux.verify(P, E)).etat, 'cle', 'un jeton EXPIRE : 401, probleme de cle');
    /* Un jeton fait pour verify, presente a settle : le faux Coinbase le refuse comme le vrai (uris). */
    const tokV = F.jeton({ cleId: 'k-ed', lu: F.lisSecret(ed.secret), methode: 'POST', uri: '127.0.0.1:' + port + '/platform/v2/x402/verify' });
    const rA = await fetch(URL0 + '/settle', { method: 'POST', headers: { authorization: 'Bearer ' + tokV, 'content-type': 'application/json' }, body: '{}' });
    ok(rA.status === 401 && /text\/plain/.test(rA.headers.get('content-type')) && (await rA.text()) === 'Unauthorized\n', 'un jeton mal ADRESSE (uris de verify, envoye a settle) : 401 text/plain « Unauthorized\\n »');
  }
  {
    const cas = async (reps) => { S.requetes.length = 0; S.settle = reps.slice(); return f.regle(P, E); };
    let g = await cas([{ statut: 400, corps: { success: false, errorReason: 'invalid_payload', errorMessage: 'nonce used', transaction: '', network: 'eip155:8453', payer: '0xabc' } }]);
    ok(g.etat === 'echec' && g.erreur === 'invalid_payload' && S.requetes.length === 1, 'settle 400 invalid_payload : echec definitif, un seul appel');
    g = await cas([{ statut: 400, corps: { success: false, errorReason: 'settle_exact_node_failure', transaction: '', network: 'eip155:8453' } }]);
    ok(g.etat === 'ambigu' && g.erreur === 'settle_exact_node_failure' && S.requetes.length === 1, 'settle_exact_node_failure : AMBIGU (relire la chaine), pas rejoue');
    g = await cas([{ statut: 402, corps: { errorType: 'payment_method_required', errorMessage: 'add a card' } }]);
    ok(g.etat === 'echec' && g.pause === 'carte' && g.erreur === 'payment_method_required', 'settle 402 payment_method_required : echec, et Base a suspendre (carte)');
    for (const st of [500, 400]) {
      g = await cas([{ statut: st, corps: { success: false, errorReason: 'settlement_pending', transaction: HASH, network: 'eip155:8453' } },
        { statut: st, corps: { success: false, errorReason: 'settlement_pending', transaction: HASH, network: 'eip155:8453' } },
        { statut: 200, corps: { success: true, transaction: HASH } }]);
      ok(g.etat === 'attente' && g.hash === HASH && S.requetes.length === 2 && S.requetes[0].corps.equals(S.requetes[1].corps) && S.requetes[0].tok !== S.requetes[1].tok,
         'settlement_pending sous ' + st + ' : renvoye UNE fois, les MEMES octets (jeton neuf), puis on s arrete — en attente avec le hash');
      g = await cas([{ statut: st, corps: { success: false, errorReason: 'settlement_pending', transaction: HASH, network: 'eip155:8453' } },
        { statut: 200, corps: { success: true, transaction: HASH, network: 'eip155:8453' } }]);
      ok(g.etat === 'paye' && g.hash === HASH && S.requetes.length === 2, 'settlement_pending sous ' + st + ', puis paye au renvoi : paye');
    }
    g = await cas([{ statut: 200, pendre: 800, corps: { success: true, transaction: HASH } }]);
    await dort(900);
    ok(g.etat === 'inconnu' && !g.hash && S.requetes.length === 1, 'un settle sans reponse dans le delai : inconnu, sans hash, JAMAIS rejoue (' + S.requetes.length + ' appel)');
    g = await cas([{ statut: 503, texte: 'upstream error' }]);
    ok(g.etat === 'inconnu' && S.requetes.length === 1, 'settle 5xx sans JSON : chemin sans hash, pas de rejeu');
  }
  {
    S.ext = { bazaar: { status: 'rejected', rejectedReason: 'schema mismatch' } };
    S.verify = [{ statut: 200, corps: { isValid: true } }];
    S.settle = [{ statut: 200, corps: { success: true, transaction: HASH } }];
    const v = await f.verify(P, E), g = await f.regle(P, E);
    S.ext = null;
    ok(v.extension && v.extension.bazaar.status === 'rejected' && g.extension && g.extension.bazaar.rejectedReason === 'schema mismatch', 'EXTENSION-RESPONSES decode sur verify ET sur settle');
  }

  console.log('\n-- 4. avec x402.js : suspendre Base, compter la fiche, ne rien rendre --');
  {
    const TRESOR = ethers.Wallet.createRandom().address;
    const w = ethers.Wallet.createRandom();
    const rpc = { code: async () => '0x', recu: async () => null, journaux: async () => [], bloc: async () => 1000 };
    const monde = (fac) => X.cree({ asset: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', usdg: X.USDG, payTo: TRESOR,
      chaine: { gazPrix: async () => ethers.BigNumber.from(28000000), soldeGaz: async () => ethers.utils.parseEther('1') }, cours: async () => 0.00002493, ethUsd: async () => 2688,
      prixOutilUsd: () => 0.01, bazaar: () => ({ info: { input: { type: 'http', method: 'POST' } }, schema: { type: 'object' } }),
      base: { reseau: X.RESEAU_BASE, chainId: 8453, usdc: X.USDC_BASE, domaine: X.DOMAINE_USDC_BASE, payTo: TRESOR, facilitateur: fac, rpc, attenteMs: 20, cadenceMs: 5 } });
    const paieBase = async (x) => {
      const r0 = await x.traite({ outil: 'scan_token', url: 'https://api/agentic/call/scan_token', sert: async () => ({ ok: true, resultat: { t: 1 } }), args: {} });
      const req = JSON.parse(Buffer.from(r0.entetes['payment-required'], 'base64').toString());
      const acc = req.accepts[0];
      const s = Math.floor(Date.now() / 1000);
      const auth = { from: w.address, to: acc.payTo, value: acc.amount, validAfter: String(s - 600), validBefore: String(s + 100), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
      const sig = await w._signTypedData(Object.assign({ chainId: 8453, verifyingContract: X.USDC_BASE }, X.DOMAINE_USDC_BASE), X.TYPES_3009, auth);
      const e = X.b64({ x402Version: 2, resource: req.resource, accepted: acc, payload: { signature: sig, authorization: auth } });
      return { req, r: await x.traite({ outil: 'scan_token', url: 'https://api/agentic/call/scan_token', entete: e, sert: async () => ({ ok: true, resultat: { t: 1 } }), args: {} }) };
    };
    const x = monde(f);
    ok(await x.sondeBase() && x.MESURE.base.etat === 'on', 'la sonde /supported du faux Coinbase allume Base');
    S.verify = [{ statut: 403, corps: { errorType: 'kyt_risk_detected' } }];
    const k = await paieBase(x);
    ok(k.req.accepts[0].network === 'eip155:8453' && k.r.status === 402 && /kyt_risk_detected/.test(JSON.parse(k.r.corps).raison) && x.MESURE.base.etat === 'on',
       '403 kyt_risk_detected : CE paiement refuse, Base reste allumee');
    S.ext = { bazaar: { status: 'success' } };
    S.verify = [{ statut: 200, corps: { isValid: true } }];
    S.settle = [{ statut: 200, corps: { success: true, transaction: HASH, network: 'eip155:8453' } }];
    const p = await paieBase(x);
    S.ext = null;
    const tout = JSON.stringify(p.r);
    ok(p.r.status === 200 && x.MESURE.base.bazaar.success === 2 && !/extension-responses/i.test(tout) && !/"bazaar":\{"status"/.test(tout),
       'EXTENSION-RESPONSES compte sur verify ET settle (' + x.MESURE.base.bazaar.success + '), jamais rendu au payeur (ni en-tete ni corps)');
    const xMal = monde(F.cree({ url: URL0, cleId: 'k-ed', cleSecrete: ed.secret }));
    await xMal.sondeBase();
    /* La cle change sous nos pieds (revoquee) : verify recoit le vrai 401. */
    const fRevoquee = F.cree({ url: URL0, cleId: 'k-ed', cleSecrete: cleEd25519().secret });
    const xR = monde(fRevoquee);
    xR.MESURE.base.etat = 'on';
    const pr = await paieBase(xR);
    await dort(50);
    ok(pr.r.status === 402 && /unexpected_verify_error/.test(JSON.parse(pr.r.corps).raison) && xR.MESURE.base.etat !== 'on',
       'un 401 text/plain en verify : Base SUSPENDUE et la cle re-sondee (etat ' + xR.MESURE.base.etat + ', raison ' + xR.MESURE.base.raison + ')');
    const x2 = monde(f);
    await x2.sondeBase();
    S.verify = [{ statut: 200, corps: { isValid: true } }];
    S.settle = [{ statut: 402, corps: { errorType: 'payment_method_required' } }];
    const c = await paieBase(x2);
    const rep = JSON.parse(Buffer.from(c.r.entetes['payment-response'], 'base64').toString());
    ok(c.r.status === 402 && rep.success === false && rep.errorReason === 'payment_method_required' && x2.MESURE.base.etat === 'suspendu' && x2.MESURE.base.jusqua - Date.now() > 3500000,
       'settle 402 : echec, resultat retenu, Base suspendue UNE HEURE');
    ok(!JSON.parse(c.r.corps).accepts.some((a) => a.network === 'eip155:8453'), 'et le nouveau 402 ne propose plus Base');
    ok(!secretsTous.some((sec) => tout.includes(sec.trim().slice(0, 24)) || JSON.stringify(c.r).includes(sec.trim().slice(0, 24))), 'aucun secret dans ce qui est rendu');
  }

  fc.srv.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
