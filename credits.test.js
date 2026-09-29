'use strict';
/* credits.js : le credit en dollars. Une recharge x402 n'est creditee qu'apres le
   reglement (200), une fois par transaction, a l'adresse de SESSION ; le chat et l'agent
   s'y debitent au cout reel (reserve, facture, reste rendu) ; une reserve ouverte a
   l'arret est rendue au demarrage ; le serveur n'envoie jamais des dollars sous les
   noms $SWOGE. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('./credits');
const C = require('./studio_chat');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-'));
  const vus = [];
  let issue = 'paye', tx = '0xT1';
  /* Un faux x402 : sans en-tete, le 402 ; avec, sert(payeur) puis le reglement selon `issue`. */
  const x402 = { baseActif: () => true, traite: async (o) => {
    vus.push(o);
    if (!o.entete) return { status: 402, entetes: { 'payment-required': 'e' }, corps: JSON.stringify({ ok: false, accepts: [{ amount: String(o.args.usd * 1e6) }] }) };
    const r = await o.sert('0xPAYEUR_AUTRE');
    if (!r.ok) return { status: 502, entetes: {}, corps: JSON.stringify({ ok: false }) };
    if (issue === 'reglement') return { status: 402, entetes: {}, corps: JSON.stringify({ ok: false, raison: 'the payment could not be settled' }) };
    if (issue === 'attente') return { status: 402, entetes: { 'payment-response': 'p' }, corps: JSON.stringify({ ok: false, error: 'payment pending' }) };
    return { status: 200, entetes: { 'payment-response': 'x' }, corps: JSON.stringify(Object.assign({}, r, { x402: { transaction: tx, network: 'eip155:8453', amount: '5001000' } })) };
  } };
  let S = K.cree({ dossier, x402: () => x402, url: 'https://srv/credit/topup' });
  const A = '0xAbC0000000000000000000000000000000000001';

  console.log('\n-- le montant --');
  ok(S.montant(0.05) === null && S.montant(0.1) === 0.1 && S.montant(50) === 50 && S.montant(50.01) === null && S.montant('abc') === null && S.montant(1.234) === 1.23,
     '0,10 $ a 50 $, au cent ; le reste refuse');
  ok(S.prixUsd({ usd: 5 }) === 5 && S.prixUsd({}) === null, 'le prix x402 de la recharge est son montant');

  console.log('\n-- la recharge --');
  let r = await S.recharge({ entete: null, usd: 5, addr: A, qui: 'ip' });
  ok(r.status === 402 && S.soldeUsd(A) === 0 && vus[0].outil === 'credit' && vus[0].args.usd === 5, 'sans signature : le 402, rien de credite');
  ok((await S.recharge({ entete: null, usd: 500, addr: A })).status === 400, 'un montant hors bornes : 400 avant tout 402');
  issue = 'reglement';
  r = await S.recharge({ entete: 'sig', usd: 5, addr: A });
  ok(r.status === 402 && S.soldeUsd(A) === 0, 'reglement rate : rien de credite (sert ne credite jamais)');
  issue = 'attente';
  r = await S.recharge({ entete: 'sig', usd: 5, addr: A });
  ok(r.status === 402 && S.soldeUsd(A) === 0, 'reglement en attente : rien de credite tant que la chaine n\'a pas tranche');
  issue = 'paye';
  r = await S.recharge({ entete: 'sig', usd: 5, addr: A });
  let c = JSON.parse(r.corps);
  ok(r.status === 200 && c.ok && c.creditedUsd === 5 && c.balanceUsd === 5 && S.soldeUsd(A) === 5, 'reglement paye : 5 $ credites');
  ok(S.soldeUsd(A.toLowerCase()) === 5 && S.soldeUsd('0xPAYEUR_AUTRE') === 0, 'credite a l\'adresse de SESSION, jamais au payeur');
  r = await S.recharge({ entete: 'sig', usd: 5, addr: A });
  c = JSON.parse(r.corps);
  ok(c.alreadyCredited && c.creditedUsd === 0 && S.soldeUsd(A) === 5, 'la meme transaction representee : pas credite deux fois');
  process.env.CREDIT_MAX_USD = '8';
  tx = '0xT2';
  ok((await S.recharge({ entete: 'sig', usd: 5, addr: A })).status === 400 && S.soldeUsd(A) === 5, 'au-dela du plafond du credit : refuse');
  delete process.env.CREDIT_MAX_USD;

  console.log('\n-- le chat se debite au cout reel --');
  C.RYTHME.clear();
  const usage = { input_tokens: 1200, output_tokens: 600 };
  const q = (x) => Object.assign({ addr: A, modele: 'sonnet-5', messages: [{ role: 'user', content: 'hi' }], recherche: false, maintenant: Date.now() }, x || {});
  let s = S.soldeChat('chat:sonnet-5');
  r = await C.repond(q(), { cours: s.cours, solde: { reserve: s.reserve, regle: s.regle }, fournisseur: async () => ({ texte: 'ok', usage, stop: 'end_turn' }) });
  const attendu = C.factureUsd(C.coutUsd(C.modele('sonnet-5'), usage));
  ok(r.ok && Math.abs((5 - S.soldeUsd(A)) - attendu) <= 2e-6, 'debite de la facture reelle (' + attendu.toFixed(6) + ' $), le reste de la reserve rendu');
  ok(r.factureUsd === Number(attendu.toFixed(5)) && Math.abs(Number(r.solde) - S.soldeUsd(A)) < 1e-9, 'la reponse porte la facture et le nouveau credit');
  const avant = S.soldeUsd(A);
  C.RYTHME.clear();
  r = await C.repond(q(), { cours: s.cours, solde: { reserve: s.reserve, regle: s.regle }, fournisseur: async () => { throw new Error('overloaded'); } });
  ok(!r.ok && S.soldeUsd(A) === avant && S.etat().ouvertes === 0, 'le fournisseur echoue : tout rendu, aucune reserve ouverte');
  const B = '0xb000000000000000000000000000000000000002';
  C.RYTHME.clear();
  r = await C.repond(q({ addr: B }), { cours: s.cours, solde: { reserve: s.reserve, regle: s.regle }, fournisseur: async () => ({ texte: 'ok', usage }) });
  ok(!r.ok && r.code === 402 && Number(r.requisSwoge) > 0 && S.soldeUsd(B) === 0, 'credit vide : 402, le montant a reserver rendu (en dollars)');

  console.log('\n-- les embauches de l\'agent --');
  const F = S.factu(A, 'hire this service');
  const a0 = S.soldeUsd(A);
  const j = await F.reserve(0.05);
  ok(j.ok && Math.abs(S.soldeUsd(A) - (a0 - 0.05)) < 1e-9, 'la reserve d\'une embauche est prise sur le credit');
  await F.regle(j.jeton, 0.012);
  ok(Math.abs(S.soldeUsd(A) - (a0 - 0.012)) < 1e-9, 'regle au prix du recu, le reste rendu');
  const jb = await S.factu(B, 'buy this eSIM').reserve(2);
  ok(!jb.ok && /credit is too low to buy this eSIM \(\$2\.00 needed\)/.test(jb.raison), 'credit insuffisant : la raison dit combien et comment recharger');

  console.log('\n-- l\'arret du serveur --');
  const ouverte = await S.factu(A, 'x').reserve(1);
  const a1 = S.soldeUsd(A);
  ok(ouverte.ok && S.etat().ouvertes === 1, 'une reserve ouverte');
  S = K.cree({ dossier, x402: () => x402, url: 'u' });
  ok(Math.abs(S.soldeUsd(A) - (a1 + 1)) < 1e-9 && S.etat().ouvertes === 0 && S.MESURE.rendusAuDemarrage === 1, 'au redemarrage, la reserve ouverte est rendue');
  tx = '0xT1';
  ok(JSON.parse((await S.recharge({ entete: 'sig', usd: 1, addr: A })).corps).alreadyCredited, 'les transactions deja creditees survivent au redemarrage');

  console.log('\n-- l\'historique --');
  const h = S.historique(A, 50);
  ok(h.length >= 4 && h.some((x) => x.kind === 'top-up' && x.usd === 5 && x.tx === '0xt1') && h.some((x) => x.kind === 'spent' && x.what === 'chat:sonnet-5') && h.some((x) => x.kind === 'refund'),
     'recharges, depenses et rendus, en anglais, les plus recents d\'abord');
  ok(S.historique(B, 50).length === 0, 'chacun son historique');

  console.log('\n-- le serveur --');
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const route = srv.slice(srv.indexOf("if (path === '/credit' || path === '/credit/topup')"), srv.indexOf("if (path === '/esim/plans' || path === '/esim/buy'"));
  ok(/sessionJoueur\.lire\(game\.sessionSecret, jeton\)/.test(route) && /recharge\(\{ entete: req\.headers\['payment-signature'\], usd: q\.usd, addr, qui/.test(route) && !/q\.addr/.test(route),
     '/credit/topup credite la session, jamais une adresse du corps');
  ok(/o === 'credit' \? credits\(\)\.prixUsd\(a\)/.test(srv), 'le prix x402 de la recharge vient du module');
  ok((srv.match(/const pay = payeurDe\(addr, q\.payeur/g) || []).length === 2 && (srv.match(/if \(pay\.credit\) r = enCredit\(r, addr\);/g) || []).length === 3,
     'l\'agent, le chat et les images : le payeur choisi, et la reponse en dollars quand c\'est le credit');
  ok(/const pay = path === '\/studio\/media\/image' \? payeurDe\(addr, q\.payeur, 'image'\) : \{ credit: false \};/.test(srv), 'une video reste en $SWOGE (ses reserves survivent a un redemarrage)');
  ok(/embauche\(\)\.pour\(addr, pay\.factu\(\)\)/.test(srv) && /achats\(\)\.pour\(addr, pay\.factu\('buy this eSIM'\)\)/.test(srv), 'les embauches de l\'agent paient comme l\'agent');
  const ec = srv.slice(srv.indexOf('function enCredit'), srv.indexOf('let AUTO_INSCRIPTION'));
  ok(/delete o\.solde; delete o\.factureSwoge; delete o\.requisSwoge;/.test(ec), 'jamais des dollars sous les noms $SWOGE');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
