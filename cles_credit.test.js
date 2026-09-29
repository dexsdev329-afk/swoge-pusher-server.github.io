'use strict';
/* Une clé swg_ payée au crédit en dollars (29/09/2026) : « sortir le $SWOGE du chemin des
   agents ». Le propriétaire (sa SESSION) choisit le payeur de chaque clé ; au crédit, chaque
   appel se débite en dollars (réserve, coût réel, reste rendu), le plafond du jour est en
   dollars, la réponse ne parle jamais de $SWOGE, la passerelle paie sur le crédit, et une
   clé peut lire et recharger le crédit de son propriétaire (l'argent ne fait qu'entrer). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('./agentic_cles');
const A = require('./agentic');
const Cr = require('./credits');
const Pa = require('./passerelle');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cles-credit-'));
  let t = Date.UTC(2026, 8, 29, 12, 0);
  const cles = K.cree({ fichier: path.join(dir, 'cles.json'), maintenant: () => t });
  const x402 = { traite: async (o) => {
    if (!o.entete) return { status: 402, entetes: {}, corps: '{}' };
    const r = await o.sert('0xpayeur');
    return { status: 200, entetes: {}, corps: JSON.stringify(Object.assign({}, r, { x402: { transaction: o.entete, network: 'eip155:8453' } })) };
  } };
  const credits = Cr.cree({ dossier: dir, x402: () => x402, url: 'u' });
  const ADDR = '0xab00000000000000000000000000000000000001', AUTRE = '0xcd00000000000000000000000000000000000002';

  console.log('-- 1. la cle et son payeur --');
  ok(!cles.nouvelle(ADDR, 'bot', null, { payeur: 'credit', plafondUsd: 0.001 }).ok && !cles.nouvelle(ADDR, 'bot', null, { payeur: 'credit', plafondUsd: 5000 }).ok,
     'au credit, un plafond du jour entre 0,01 $ et 1 000 $');
  const c1 = cles.nouvelle(ADDR, 'bot', null, { payeur: 'credit', plafondUsd: 2 });
  ok(c1.ok && c1.cleVue.payeur === 'credit' && c1.cleVue.plafondUsd === 2, 'une cle creee au credit, plafond 2 $ par jour');
  const k1 = cles.resout(c1.cle);
  ok(k1.payeur === 'credit' && k1.addr === ADDR, 'la cle presentee dit son payeur');
  const c2 = cles.nouvelle(ADDR, 'old', 50000);
  ok(c2.ok && c2.cleVue.payeur === 'swoge' && cles.resout(c2.cle).payeur === 'swoge', 'sans payeur : $SWOGE, comme les cles d\'avant');
  ok(cles.fixePayeur(AUTRE, c2.cleVue.id, { payeur: 'credit', plafondUsd: 1 }).code === 404, 'une autre adresse ne change pas le payeur de MA cle');

  console.log('\n-- 2. un outil a prix fixe, paye au credit --');
  await credits.ajoute(ADDR, 1, { transaction: '0xt1' });
  const sol = { reserves: 0 };
  const api = A.cree({ cles, cours: async () => 0.00002801, solde: { reserve: () => { sol.reserves++; return true; }, regle: () => '0' },
    outils: { scan_token: async (e) => ({ texte: 'Token ' + e.address, carte: {}, sources: [] }) }, actifs: () => ({ recherche: false }),
    credit: (addr) => { const s = credits.soldeChat('key'); return { credit: true, cours: s.cours, solde: { reserve: s.reserve, regle: s.regle } }; },
    agent: async (q) => ({ ok: true, texte: 'Answer.', sources: [], factureSwoge: q.payeur === 'credit' ? '0.0126' : '450', factureUsd: 0.0126, solde: q.payeur === 'credit' ? String(credits.soldeUsd(ADDR) - 0.0126) : '1', etapes: 1, vu: q }),
    video: async () => ({ ok: true, id: 'v1' }) });
  const adr = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
  const prix = A.prixUsd ? A.prixUsd('scan_token') : null;
  let r = await api.appelle({ cle: k1, outil: 'scan_token', args: { address: adr }, canal: 'rest' });
  const debit = Math.round((1 - credits.soldeUsd(ADDR)) * 1e6) / 1e6;
  ok(r.ok && sol.reserves === 0 && debit > 0 && (prix == null || Math.abs(debit - prix) < 1e-6), 'debite du CREDIT (' + debit + ' $), jamais du solde $SWOGE');
  ok(r.facture && r.facture.paidWith === 'dollar credit' && !('swoge' in r.facture) && !('solde' in r) && Math.abs(r.creditUsd - credits.soldeUsd(ADDR)) < 1e-9,
     'la reponse dit dollars et le credit restant, jamais $SWOGE');
  const recu = cles.recus(ADDR)[0];
  ok(recu.payeur === 'credit' && !('swoge' in recu) && recu.usd > 0, 'le recu dit « credit » et des dollars');
  ok(Math.abs(cles.liste(ADDR).find((x) => x.id === k1.id).depenseAujourdhui - debit) < 1e-9, 'la depense du jour de la cle est comptee en dollars');

  console.log('\n-- 3. le plafond du jour et le credit vide --');
  cles.fixePayeur(ADDR, k1.id, { payeur: 'credit', plafondUsd: 0.01 });
  r = await api.appelle({ cle: cles.resout(c1.cle), outil: 'scan_token', args: { address: adr }, canal: 'rest' });
  ok(!r.ok && r.code === 402 && /daily spending cap/.test(r.raison), 'au-dela du plafond du jour en dollars : refuse, rien debite');
  cles.fixePayeur(ADDR, k1.id, { payeur: 'credit', plafondUsd: 5 });
  const B = '0xb000000000000000000000000000000000000003';
  const cb = cles.nouvelle(B, 'b', null, { payeur: 'credit', plafondUsd: 5 });
  r = await api.appelle({ cle: cles.resout(cb.cle), outil: 'scan_token', args: { address: adr }, canal: 'rest' });
  ok(!r.ok && r.code === 402 && /dollar credit is too low/.test(r.raison) && /POST \/credit\/topup/.test(r.raison) && r.requisUsd > 0 && !('requisSwoge' in r),
     'credit vide : 402, comment recharger (page ou POST /credit/topup), le montant en dollars');

  console.log('\n-- 4. ask_agent et la video --');
  r = await api.appelle({ cle: cles.resout(c1.cle), outil: 'ask_agent', args: { task: 'hello' }, canal: 'rest' });
  ok(r.ok && r.facture.usd === 0.0126 && r.facture.paidWith && !('solde' in r), 'ask_agent au credit : facture en dollars');
  r = await api.appelle({ cle: cles.resout(c1.cle), outil: 'generate_video', args: { prompt: 'a dog' }, canal: 'rest' });
  ok(!r.ok && r.code === 400 && /videos are paid in \$SWOGE/.test(r.raison), 'une video au credit : refusee clairement (elle reste en $SWOGE)');
  r = await api.appelle({ cle: null, outil: 'scan_token', args: {}, devis: true, canal: 'rest', qui: 'ip' });
  ok(r.ok && r.quote, 'le devis sans cle ne change pas');

  console.log('\n-- 5. revenir au $SWOGE --');
  ok(cles.fixePayeur(ADDR, k1.id, { payeur: 'swoge', plafondSwoge: 1000 }).ok && cles.resout(c1.cle).payeur === 'swoge', 'le proprietaire remet la cle en $SWOGE');
  const avant = credits.soldeUsd(ADDR);
  r = await api.appelle({ cle: cles.resout(c1.cle), outil: 'scan_token', args: { address: adr }, canal: 'rest' });
  ok(r.ok && sol.reserves === 1 && credits.soldeUsd(ADDR) === avant && 'swoge' in r.facture, 'en $SWOGE : le solde de jeu, le credit intact');

  console.log('\n-- 6. la passerelle paie sur le credit --');
  cles.fixePayeur(ADDR, k1.id, { payeur: 'credit', plafondUsd: 0.06 });
  cles.fixePaiement(ADDR, k1.id, { actif: true, maxAppelUsd: 0.1 });
  const vus = [];
  const P = Pa.cree({ cles, dossier: dir, maintenant: () => t,
    embauche: () => ({ pour: (addr, factu) => ({ embauche: async () => {
      const j = await factu.reserve(0.05); if (!j.ok) return { ok: false, raison: j.raison };
      await factu.regle(j.jeton, 0.05); return { ok: true, resultat: { x: 1 }, recu: { usd: 0.05, factureUsd: 0.05, tx: '0xabc' } }; } }) }),
    factuPour: (addr, cle) => { vus.push(cle && cle.payeur); return cle && cle.payeur === 'credit' ? credits.factu(addr, 'pay') : { reserve: async () => ({ ok: false, raison: 'swoge' }), regle: async () => {} }; },
    cours: async (cle) => (cle && cle.payeur === 'credit' ? 1 : 0.00002801) });
  const c0 = credits.soldeUsd(ADDR);
  let x = await P.paie(cles.resout(c1.cle), { url: 'https://api.example.com/x' }, 'idem-000001');
  ok(x.code === 200 && vus[0] === 'credit' && Math.abs(c0 - credits.soldeUsd(ADDR) - 0.05) < 1e-9, 'un service paye par la cle : 0,05 $ debites du credit');
  x = await P.paie(cles.resout(c1.cle), { url: 'https://api.example.com/x' }, 'idem-000002');
  ok(!x.corps.ok && /daily spending cap/.test(x.corps.raison), 'le plafond du jour de la cle (0,06 $) tient, en dollars');

  console.log('\n-- 7. le serveur --');
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const route = srv.slice(srv.indexOf("if (path === '/credit' || path === '/credit/topup')"), srv.indexOf("if (path === '/esim/plans' || path === '/esim/buy'"));
  ok(/agenticCles\.resout\(cleT\)/.test(route) && /cleC && cleC\.addr/.test(route) && !/q\.addr/.test(route), '/credit : une cle lit et recharge le credit de SON proprietaire, jamais une adresse du corps');
  const iPayeur = srv.indexOf("/^\\/agentic\\/cles\\/[0-9a-f]{12}\\/payeur$/"), iSession = srv.indexOf("if (!session) return json(401, { ok: false, raison: 'sign in with your wallet first (API keys cannot manage keys)' });");
  ok(iPayeur > 0 && iSession > 0 && iPayeur > iSession && /agenticCles\.fixePayeur\(session,/.test(srv), 'changer le payeur : la session seulement, apres le refus des cles (une cle ne gere pas les cles)');
  ok(/credit: \(addr\) => payeurDe\(addr, 'credit', 'key'\)/.test(srv) && /cours: \(cle\) => \(cle && cle\.payeur === 'credit' \? 1 :/.test(srv), 'agentic et passerelle branches sur le credit');
  const mcp = fs.readFileSync(path.join(__dirname, 'agentic_mcp.js'), 'utf8');
  ok(/billed \$' \+ r\.facture\.usd \+ ' from your dollar credit/.test(mcp), 'MCP : le pied dit « from your dollar credit »');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
