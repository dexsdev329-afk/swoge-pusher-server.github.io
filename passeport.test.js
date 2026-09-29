'use strict';
/* passeport.js : le passeport d'une cle swg_. Ce qu'il dit vient des cles et de la chaine
   d'audit ; il est signe en Ed25519 par une cle dediee ; n'importe qui le verifie avec la
   cle publique SANS nous ; un changement d'un seul champ casse la signature ; il expire en
   24 h ; il est prive tant que le proprietaire ne le publie pas. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const K = require('./agentic_cles');
const P = require('./passeport');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passeport-'));
let t = Date.UTC(2026, 8, 29, 12, 0);
const cles = K.cree({ fichier: path.join(dir, 'cles.json'), maintenant: () => t });
const A = '0xab00000000000000000000000000000000000001', B = '0xcd00000000000000000000000000000000000002';
const c1 = cles.nouvelle(A, 'research-bot', null, { payeur: 'credit', plafondUsd: 2 });
const k1 = cles.resout(c1.cle);
cles.depense(k1.h, 0.02, { id: 'r1', outil: 'scan_token', usd: 0.02 });
cles.depense(k1.h, 0.01, { id: 'r2', outil: 'web_search', usd: 0.01 });
cles.fixePaiement(A, k1.id, { actif: true, maxAppelUsd: 0.05, hotes: ['api.example.com'] });
const LIGNES = [{ seq: 3, h: 'c'.repeat(64), statut: 'refuse' }, { seq: 2, h: 'b'.repeat(64), statut: 'paye' }, { seq: 1, h: 'a'.repeat(64), statut: 'paye' }];
const S = P.cree({ dossier: dir, cles, audit: (addr, id) => (addr === A && id === k1.id ? { lignes: LIGNES, chaine: { ok: true, lignes: 3 } } : { lignes: [], chaine: { ok: true } }),
  api: 'https://api', site: 'https://site', maintenant: () => t });

console.log('-- 1. ce que dit le passeport --');
const p = S.passeport(k1.id);
ok(p.type === 'swoge.agent-passport' && p.agent.id === k1.id && p.agent.name === 'research-bot' && p.agent.active && p.owner.wallet === A, 'l identite : l identifiant public, le nom, le portefeuille proprietaire');
ok(!JSON.stringify(p).includes(c1.cle) && !JSON.stringify(p).includes(k1.h), 'jamais la cle, ni son empreinte complete');
ok(p.wallet.paysFrom === 'dollar credit' && p.wallet.dailyCap.usd === 2 && p.wallet.spentToday.usd === 0.03, 'le portefeuille : paye au credit, plafond du jour, depense du jour');
ok(p.permissions.readTools && p.permissions.buysSellsOrSigns === false && p.permissions.manageKeys === false && p.permissions.payOtherServices.enabled
   && p.permissions.payOtherServices.maxPerCallUsd === 0.05 && p.permissions.payOtherServices.allowedSites.join() === 'api.example.com', 'les permissions, telles que le proprietaire les a mises');
ok(p.history.toolCalls === 2 && p.history.billedUsd === 0.03 && p.history.gateway.paid === 2 && p.history.gateway.refused === 1 && p.history.gateway.head.seq === 3 && p.history.gateway.chainIntact,
   'l historique : appels comptes, facture, paiements de la passerelle, tete de la chaine d audit');
ok(p.public === false && Date.parse(p.expiresAt) - Date.parse(p.issuedAt) === 24 * 3600e3, 'prive par defaut ; un instantane qui expire en 24 h');

console.log('\n-- 2. la signature --');
const env = S.signe(p);
ok(env.signature.alg === 'Ed25519' && /^[0-9a-f]{16}$/.test(env.signature.keyId) && S.verifie(env).ok && !S.verifie(env).expired, 'signe par la cle dediee, et verifie');
const pub = S.clePublique();
const seul = crypto.verify(null, Buffer.from(P.canonique(env.passport), 'utf8'), pub.publicKeyPem, Buffer.from(env.signature.value, 'base64url'));
ok(seul && pub.keyId === env.signature.keyId && /canonical JSON/.test(pub.howToVerify), 'n importe qui verifie avec la cle publique SEULE, sans nous (Node crypto)');
const reordonne = JSON.parse(JSON.stringify({ signature: env.signature, passport: Object.fromEntries(Object.entries(env.passport).reverse()) }));
ok(S.verifie(reordonne).ok, 'l ordre des champs ne change rien (JSON canonique)');
const triche = JSON.parse(JSON.stringify(env)); triche.passport.wallet.dailyCap.usd = 1000;
ok(!S.verifie(triche).ok && /changed after SWOGE signed it/.test(S.verifie(triche).raison), 'un seul champ change (le plafond) : la signature casse');
const autre = JSON.parse(JSON.stringify(env)); autre.signature.keyId = '0'.repeat(16);
ok(!S.verifie(autre).ok && !S.verifie({}).ok && !S.verifie(null).ok, 'une autre cle, ou rien : refuse');
t += 25 * 3600e3;
ok(S.verifie(env).ok && S.verifie(env).expired === true, 'apres 24 h : la signature tient, mais le passeport est dit expire');
const mode = fs.statSync(path.join(dir, 'passeport_ed25519.pem')).mode & 0o777;
const S2 = P.cree({ dossier: dir, cles, api: 'https://api', site: 'https://site' });
ok(mode === 0o600 && S2.clePublique().keyId === pub.keyId && S2.verifie(env).ok, 'la cle privee est gardee (0600) et relue : meme cle apres un redemarrage');

console.log('\n-- 3. prive, puis public --');
ok(cles.publie(B, k1.id, true).code === 404 && cles.parId(k1.id).c.passeportPublic !== true, 'un autre portefeuille ne publie pas MON passeport');
ok(cles.publie(A, k1.id, true).ok && S.passeport(k1.id).public === true && cles.liste(A)[0].passeportPublic === true, 'le proprietaire le publie');
ok(cles.parId('zz') === null && cles.parId('0'.repeat(12)) === null && S.passeport('0'.repeat(12)) === null, 'un identifiant inconnu ou mal forme : rien');

console.log('\n-- 4. le serveur --');
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const r = srv.slice(srv.indexOf("if (path.startsWith('/agentic/passport/'))"), srv.indexOf("if (path === '/agentic/recus')"));
ok(/x\.c\.passeportPublic && !x\.c\.revoquee/.test(r) && /\(session && x\.c\.addr === session\) \|\| \(cle && cle\.id === id\)/.test(r) && (r.match(/no public passport with this id/g) || []).length === 1,
   'un passeport prive se lit par son proprietaire ou sa cle ; sinon la meme reponse qu un identifiant inconnu');
const iPub = srv.indexOf("/^\\/agentic\\/cles\\/[0-9a-f]{12}\\/passeport$/"), iSess = srv.indexOf("if (!session) return json(401, { ok: false, raison: 'sign in with your wallet first (API keys cannot manage keys)' });");
ok(iPub > iSess && iSess > 0 && /agenticCles\.publie\(session,/.test(srv), 'publier : la session seulement, jamais une cle');
ok(/path === '\/\.well-known\/swoge-passport\.json'/.test(srv) && /passeports\(\)\.clePublique\(\)/.test(srv), 'la cle publique est publiee');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
