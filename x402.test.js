'use strict';
/*
 * x402 — PAYER UN OUTIL SANS COMPTE (x402.js), avec de VRAIES signatures
 * (ethers : Permit2 avec témoin, permit EIP-2612) contre une fausse chaîne :
 *   1. le prix : outil + gaz, jamais sous 0,02 $ ; le 402 dit tout ce qu'il faut signer ;
 *   2. un paiement valide : vérifié, servi, réglé une fois, reçu PAYMENT-RESPONSE ;
 *   3. ce qui est refusé SANS rien régler : rejeu, autre montant, autre
 *      destinataire, autre dépensier, échéance passée, signature d'un autre,
 *      solde trop bas, nonce déjà pris, devis inconnu ;
 *   4. l'ordre qui protège le payeur : outil en panne → rien réglé ; règlement
 *      en échec → le résultat n'est PAS rendu ;
 *   5. la première fois, sans allowance : l'extension EIP-2612 (settleWithPermit) ;
 *   6. deux requêtes simultanées avec la même signature : une seule passe.
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const { ethers } = require('ethers');
const X = require('./x402');

const SWOGE = '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817';
const TRESOR = ethers.Wallet.createRandom().address;
const B = ethers.BigNumber;
const de64 = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));

/* La fausse chaîne : ce que la vraie répondrait, et le relevé de ce qu'on lui envoie. */
function fausseChaine(o) {
  /* Les valeurs lues vivent dans `v` (modifiable par l'essai) ; les fonctions sont celles de chaineEthers. */
  const v = Object.assign({ gp: B.from(28000000), gaz: ethers.utils.parseEther('0.001'), solde: ethers.utils.parseEther('1000000000'),
    allowance: ethers.constants.MaxUint256, noncesJeton: '0', libre: true, simuleEchoue: null, regleEchoue: null }, o || {});
  const c = { v, regles: [], simules: [], porteGaz: '0x' + '11'.repeat(20) };
  c.gazPrix = async () => v.gp; c.soldeGaz = async () => v.gaz;
  c.solde = async () => v.solde; c.allowance = async () => v.allowance; c.noncesJeton = async () => v.noncesJeton;
  c.nonceLibre = async () => v.libre;
  c.soldeUsdg = async () => (v.soldeUsdg !== undefined ? v.soldeUsdg : B.from(1000000000)); c.autorisationLibre = async () => (v.autorisationLibre !== undefined ? v.autorisationLibre : true);
  c.simule = async (m) => { c.simules.push(m); if (v.simuleEchoue) throw new Error(v.simuleEchoue); return []; };
  c.regle = async (m, a) => { await new Promise((r) => setTimeout(r, 20)); if (v.regleEchoue) return { ok: false, erreur: v.regleEchoue }; c.regles.push({ m, a }); return { ok: true, hash: '0x' + String(c.regles.length).padStart(64, '0'), gasUsed: '91234' }; };
  return c;
}

function monde(o) {
  const chaine = fausseChaine(o && o.chaine);
  let t = 1790000000000;
  const journal = [];
  const x = X.cree({ asset: SWOGE, usdg: (o && o.usdg) || null, payTo: TRESOR, chaine, cours: (o && o.cours) || (async () => 0.00002493), ethUsd: async () => 2688.57,
    prixOutilUsd: (outil) => ({ scan_token: 0.01, swoge_economy: 0.001, wallet_intel: 0.02 })[outil] || null,
    maintenant: () => t, journal: (l) => journal.push(l) });
  return { x, chaine, journal, avance: (ms) => { t += ms; }, s: () => Math.floor(t / 1000) };
}

/* Ce qu'un client x402 signe à partir d'un 402 (spec v2, schéma exact, méthode permit2). */
async function signe(w, req, o) {
  o = o || {};
  const acc = Object.assign({}, req.accepts[0], o.accepted || {});
  const maintenant = o.s;
  const auth = { from: w.address, permitted: { token: o.token || acc.asset, amount: o.montantSigne || acc.amount },
    spender: o.spender || X.PROXY, nonce: o.nonce || B.from(ethers.utils.randomBytes(32)).toString(),
    deadline: String(o.deadline || maintenant + 100), witness: { to: o.to || acc.payTo, validAfter: String(o.validAfter || maintenant - 600) } };
  const signataire = o.autre || w;
  const signature = await signataire._signTypedData(X.domainePermit2(), X.TYPES_PERMIT2,
    { permitted: auth.permitted, spender: auth.spender, nonce: auth.nonce, deadline: auth.deadline, witness: auth.witness });
  const p = { x402Version: 2, resource: req.resource, accepted: acc, payload: { signature, permit2Authorization: auth } };
  if (o.permit2612) {
    const v = { owner: w.address, spender: X.PERMIT2, value: o.permit2612.value || auth.permitted.amount, nonce: o.permit2612.nonce || '0', deadline: String(maintenant + 600) };
    const sig = await (o.permit2612.autre || w)._signTypedData(Object.assign({ chainId: X.CHAIN_ID, verifyingContract: SWOGE }, X.DOMAINE_JETON), X.TYPES_2612, v);
    p.extensions = { eip2612GasSponsoring: { info: { from: w.address, asset: SWOGE, spender: X.PERMIT2, amount: v.value, nonce: v.nonce, deadline: v.deadline, signature: sig, version: '1' } } };
  }
  return { entete: X.b64(p), auth };
}

/* Ce qu'un client x402 signe pour l'USDG (EIP-3009, spec v2 « exact », méthode eip3009). */
async function signe3009(w, req, o) {
  o = o || {};
  const acc = Object.assign({}, req.accepts.find((a) => a.extra.assetTransferMethod === 'eip3009'), o.accepted || {});
  const auth = { from: w.address, to: o.to || acc.payTo, value: o.value || acc.amount, validAfter: String(o.validAfter || o.s - 600),
    validBefore: String(o.validBefore || o.s + 100), nonce: o.nonce || ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
  const signature = await (o.autre || w)._signTypedData(Object.assign({ chainId: X.CHAIN_ID, verifyingContract: acc.asset }, X.DOMAINE_USDG), X.TYPES_3009, auth);
  if (o.nonceApres) auth.nonce = o.nonceApres;      /* un en-tete fabrique a la main : ethers refuse de signer un tel nonce */
  return { entete: X.b64({ x402Version: 2, resource: req.resource, accepted: acc, payload: { signature, authorization: auth } }), auth, acc };
}

const sert = (compte) => async () => { compte.n = (compte.n || 0) + 1; return { ok: true, outil: 'scan_token', resultat: { token: 'SWOGE' }, texte: 'x' }; };

(async () => {
  console.log('-- 1. le prix et le 402 --');
  {
    const M = monde();
    const p = await M.x.prix('scan_token');
    /* gaz : 0,028 gwei × 200 000 × 2 688,57 $ = 0,01506 $ ; outil 0,01 $ → 0,02506 $ */
    ok(Math.abs(p.gazUsd - 0.028e-9 * X.GAZ_UNITES * 2688.57) < 1e-6, 'le gaz du reglement : ' + p.gazUsd + ' $ (0,028 gwei releve le 26 septembre)');
    ok(Math.abs(p.usd - (0.01 + p.gazUsd)) < 1e-6, 'le prix = outil + gaz : ' + p.usd + ' $');
    const pe = await M.x.prix('swoge_economy');
    eq(pe.usd, 0.02, 'un outil a 0,001 $ + gaz 0,015 $ reste au MINIMUM de 0,02 $');
    const M2 = monde({ chaine: { gp: B.from(1000000) } });
    eq((await M2.x.prix('scan_token')).usd, 0.02, 'gaz presque nul : le minimum tient encore');
    const attendu = ethers.utils.parseUnits((p.usd / 0.00002493).toFixed(18), 18);
    ok(B.from(p.montant).sub(attendu).abs().lt(ethers.utils.parseUnits('1', 18)), 'le montant en unites atomiques de $SWOGE : ' + ethers.utils.formatUnits(p.montant, 18));
    eq(await M.x.prix('ask_agent'), null, 'un outil sans prix fixe n a pas de prix x402');

    const r = await M.x.traite({ outil: 'scan_token', url: 'https://api/agentic/call/scan_token', sert: sert({}) });
    eq(r.status, 402, 'sans PAYMENT-SIGNATURE : 402');
    const req = de64(r.entetes['payment-required']);
    const a = req.accepts[0];
    ok(req.x402Version === 2 && a.scheme === 'exact' && a.network === 'eip155:4663' && a.asset === SWOGE && a.payTo === TRESOR,
       'PAYMENT-REQUIRED : version 2, exact, eip155:4663, le vrai $SWOGE, la tresorerie');
    ok(a.extra.assetTransferMethod === 'permit2' && a.extra.name === 'Swole Doge' && a.extra.version === '1' && a.maxTimeoutSeconds === 120,
       'extra : permit2, domaine EIP-712 du jeton (Swole Doge, 1)');
    ok(req.extensions.eip2612GasSponsoring && req.extensions.eip2612GasSponsoring.schema.required.includes('signature'), 'l extension eip2612GasSponsoring est annoncee');
    ok(/minimum \$0\.02/.test(req.resource.description), 'la description dit le prix et le minimum');
    ok(JSON.parse(r.corps).accepts[0].amount === a.amount, 'le corps porte aussi les exigences (clients sans en-tetes)');
    const sansCours = X.cree({ asset: SWOGE, payTo: TRESOR, chaine: fausseChaine(), cours: async () => null, ethUsd: async () => 2688, prixOutilUsd: () => 0.01 });
    eq((await sansCours.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).status, 503, 'sans cours du $SWOGE : 503, pas un prix invente');
  }

  console.log('\n-- 2. un paiement valide --');
  {
    const M = monde();
    const w = ethers.Wallet.createRandom();
    const req = de64((await M.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).entetes['payment-required']);
    const { entete, auth } = await signe(w, req, { s: M.s() });
    const compte = {};
    const r = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert(compte) });
    eq(r.status, 200, 'paye : 200');
    eq(compte.n, 1, 'l outil est servi une fois');
    eq(M.chaine.regles.length, 1, 'le paiement est regle une fois sur la chaine');
    const reg = M.chaine.regles[0];
    ok(reg.m === 'settle' && reg.a[1] === w.address && reg.a[2].to === TRESOR && reg.a[0].permitted.amount === req.accepts[0].amount && reg.a[3] === de64(entete).payload.signature,
       'settle(permit, owner = le payeur, witness.to = la tresorerie, signature du payeur)');
    ok(M.chaine.simules[0] === 'settle', 'le reglement a ete simule avant de servir');
    const pr = de64(r.entetes['payment-response']);
    ok(pr.success === true && pr.network === 'eip155:4663' && pr.payer === w.address && /^0x[0-9a-f]{64}$/.test(pr.transaction), 'PAYMENT-RESPONSE : succes, transaction, reseau, payeur');
    const c = JSON.parse(r.corps);
    ok(c.ok && c.resultat.token === 'SWOGE' && c.x402.amount === req.accepts[0].amount, 'le corps : le resultat de l outil et le montant paye');
    ok(M.journal.length === 1 && M.journal[0].payer === w.address && M.journal[0].gasUsed === '91234', 'le journal note le paiement et le gaz reel');
    ok(M.x.MESURE.payes === 1 && M.x.MESURE.gasUsed[0] === 91234, 'MESURE : un paye, le gasUsed reel garde pour remplacer l estimation');
    void auth;
  }

  console.log('\n-- 3. refuse sans rien regler --');
  {
    const M = monde();
    const w = ethers.Wallet.createRandom();
    const req = de64((await M.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).entetes['payment-required']);
    const essai = async (m, o, attendu, chaineO) => {
      Object.assign(M.chaine.v, chaineO || {});
      const { entete } = await signe(w, req, Object.assign({ s: M.s() }, o));
      const compte = {};
      const r = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert(compte) });
      const raison = JSON.parse(r.corps).raison;
      ok(r.status === 402 && !compte.n && M.chaine.regles.length === 0 && (!attendu || attendu.test(raison)) && r.entetes['payment-required'],
         m + ' → 402 ' + raison + ', rien servi, rien regle, un nouveau PAYMENT-REQUIRED');
      Object.assign(M.chaine.v, { solde: ethers.utils.parseEther('1000000000'), libre: true, simuleEchoue: null, gaz: ethers.utils.parseEther('0.001'), allowance: ethers.constants.MaxUint256 });
    };
    const moins = B.from(req.accepts[0].amount).sub(1).toString();
    await essai('un montant signe plus bas que le devis', { montantSigne: moins }, /value_mismatch/);
    await essai('un montant jamais devise (accepted modifie)', { accepted: { amount: moins }, montantSigne: moins }, /invalid_payment_requirements/);
    await essai('un autre destinataire que la tresorerie', { to: ethers.Wallet.createRandom().address }, /recipient_mismatch/);
    await essai('un autre depensier que le proxy canonique', { spender: ethers.Wallet.createRandom().address }, /invalid_payload/);
    await essai('un autre jeton (le clone 0xDB87…)', { token: '0xDB87393727b666c43f5aecB03d8B419bA54D9b03' }, /invalid_payload/);
    await essai('une echeance passee', { deadline: M.s() - 1 }, /valid_before/);
    await essai('une echeance a plus d une heure', { deadline: M.s() + 4000 }, /invalid_payload/);
    await essai('pas encore valide (validAfter futur)', { validAfter: M.s() + 60 }, /valid_after/);
    await essai('signe par un AUTRE portefeuille que « from »', { autre: ethers.Wallet.createRandom() }, /signature/);
    await essai('un solde trop bas', {}, /insufficient_funds/, { solde: B.from(1) });
    await essai('un nonce Permit2 deja utilise sur la chaine', {}, /invalid_transaction_state/, { libre: false });
    await essai('une simulation qui revert', {}, /invalid_transaction_state/, { simuleEchoue: 'TRANSFER_FROM_FAILED' });
    await essai('le portefeuille de gaz vide', {}, /unexpected_verify_error/, { gaz: B.from(0) });
    await essai('sans allowance ni extension EIP-2612', {}, /permit2_allowance_required/, { allowance: B.from(0) });
    const r1 = await M.x.traite({ outil: 'scan_token', url: 'u', entete: 'pas du base64 json', sert: sert({}) });
    ok(r1.status === 402 && /invalid_payload/.test(JSON.parse(r1.corps).raison), 'un en-tete illisible → 402 invalid_payload');
    const { entete: pourAutre } = await signe(w, req, { s: M.s() });
    ok((await M.x.traite({ outil: 'wallet_intel', url: 'u', entete: pourAutre, sert: sert({}) })).status === 402, 'un paiement devise pour scan_token ne paie pas wallet_intel');

    console.log('\n   rejeu :');
    const { entete } = await signe(w, req, { s: M.s() });
    const c1 = {}, c2 = {};
    eq((await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert(c1) })).status, 200, 'la premiere presentation passe');
    const re = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert(c2) });
    ok(re.status === 402 && !c2.n && M.chaine.regles.length === 1, 'la MEME signature rejouee → 402, rien servi, un seul reglement');
    M.avance(121000);
    const { entete: vieux } = await signe(w, req, { s: M.s() });
    ok(/invalid_payment_requirements/.test(JSON.parse((await M.x.traite({ outil: 'scan_token', url: 'u', entete: vieux, sert: sert({}) })).corps).raison), 'un devis de plus de 120 s ne se paie plus (un nouveau 402 le remplace)');
  }

  console.log('\n-- 4. l ordre qui protege le payeur --');
  {
    const M = monde();
    const w = ethers.Wallet.createRandom();
    const req = de64((await M.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).entetes['payment-required']);
    const { entete } = await signe(w, req, { s: M.s() });
    const panne = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: async () => ({ ok: false, code: 502, raison: 'the tool failed — nothing was charged' }) });
    ok(panne.status === 502 && M.chaine.regles.length === 0 && JSON.parse(panne.corps).paye === false, 'l outil en panne : 502, la signature n est JAMAIS soumise');
    const jette = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: async () => { throw new Error('boom'); } });
    ok(jette.status === 502 && M.chaine.regles.length === 0, 'un outil qui jette : pareil — et la meme signature reste utilisable (rien n a ete pris)');
    const bonne = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert({}) });
    eq(bonne.status, 200, 'rejouee apres la panne, elle paie enfin, une fois');

    const M2 = monde({ chaine: { regleEchoue: 'nonce too low' } });
    const req2 = de64((await M2.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).entetes['payment-required']);
    const { entete: e2 } = await signe(w, req2, { s: M2.s() });
    const rr = await M2.x.traite({ outil: 'scan_token', url: 'u', entete: e2, sert: sert({}) });
    const c = JSON.parse(rr.corps);
    const pr = de64(rr.entetes['payment-response']);
    ok(rr.status === 402 && !c.resultat && pr.success === false && pr.errorReason === 'unexpected_settle_error', 'le reglement echoue : 402, le resultat est RETENU, PAYMENT-RESPONSE en echec');
    ok(M2.x.MESURE.echecsReglement === 1 && M2.journal.length === 0, 'compte comme echec de reglement, rien au journal des paiements');
  }

  console.log('\n-- 5. la premiere fois : EIP-2612 sans gaz pour le payeur --');
  {
    const M = monde({ chaine: { allowance: B.from(0), noncesJeton: '3' } });
    const w = ethers.Wallet.createRandom();
    const req = de64((await M.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).entetes['payment-required']);
    const faux = await signe(w, req, { s: M.s(), permit2612: { nonce: '3', autre: ethers.Wallet.createRandom() } });
    ok(/eip2612 signature/.test(JSON.parse((await M.x.traite({ outil: 'scan_token', url: 'u', entete: faux.entete, sert: sert({}) })).corps).detail), 'un permit signe par un autre : refuse');
    const vieux = await signe(w, req, { s: M.s(), permit2612: { nonce: '2' } });
    ok(/nonce/.test(JSON.parse((await M.x.traite({ outil: 'scan_token', url: 'u', entete: vieux.entete, sert: sert({}) })).corps).detail), 'un permit avec un nonce perime du jeton : refuse');
    /* Relevé sur la chaîne le 26 septembre 2026 : le proxy déployé revert
       Permit2612AmountMismatch() si value != montant — un permit « illimité »,
       usuel ailleurs, ferait échouer le règlement APRÈS avoir servi. */
    const illimite = await signe(w, req, { s: M.s(), permit2612: { nonce: '3', value: ethers.constants.MaxUint256.toString() } });
    ok(/exactly/.test(JSON.parse((await M.x.traite({ outil: 'scan_token', url: 'u', entete: illimite.entete, sert: sert({}) })).corps).detail) && M.chaine.regles.length === 0,
       'un permit illimite (MaxUint256) : refuse AVANT de servir — le proxy deploye exige value = montant exact');
    const { entete } = await signe(w, req, { s: M.s(), permit2612: { nonce: '3' } });
    const r = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert({}) });
    eq(r.status, 200, 'le permit du payeur vers Permit2 : paye');
    const reg = M.chaine.regles[0];
    const p2612 = reg && reg.a[0];
    const sp = ethers.utils.splitSignature(de64(entete).extensions.eip2612GasSponsoring.info.signature);
    ok(reg && reg.m === 'settleWithPermit' && p2612.r === sp.r && p2612.s === sp.s && p2612.v === sp.v && p2612.value === req.accepts[0].amount,
       'settleWithPermit({value, deadline, r, s, v}, permit, owner, witness, signature)');
    ok(M.chaine.simules.includes('settleWithPermit'), 'simule avant de servir');
  }

  console.log('\n-- 6. deux requetes simultanees, meme signature --');
  {
    const M = monde();
    const w = ethers.Wallet.createRandom();
    const req = de64((await M.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).entetes['payment-required']);
    const { entete } = await signe(w, req, { s: M.s() });
    const compte = {};
    const [a, b] = await Promise.all([1, 2].map(() => M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert(compte) })));
    ok([a.status, b.status].sort().join() === '200,402' && compte.n === 1 && M.chaine.regles.length === 1, 'une seule passe, un seul service, un seul reglement [' + a.status + ',' + b.status + ']');
    const e1 = (await signe(w, req, { s: M.s() })).entete, e2 = (await signe(w, req, { s: M.s() })).entete;
    const ordre = [];
    const lent = M.chaine.regle;
    M.chaine.regle = async (m, x) => { ordre.push('debut'); const r = await lent(m, x); ordre.push('fin'); return r; };
    await Promise.all([e1, e2].map((e) => M.x.traite({ outil: 'scan_token', url: 'u', entete: e, sert: sert({}) })));
    eq(ordre.join(','), 'debut,fin,debut,fin', 'deux paiements distincts se reglent l un apres l autre (un seul nonce de gaz)');
  }

  console.log('\n-- 7. payer en USDG (EIP-3009) --');
  {
    const M = monde({ usdg: X.USDG });
    const p = await M.x.prix('scan_token');
    ok(Number(p.montantUsdg) >= (0.01 + p.gazUsd) * 1e6 - 1 && Number(p.montantUsdg) - (0.01 + p.gazUsd) * 1e6 < 2, 'le prix en USDG (6 decimales) au micro-dollar superieur : ' + p.montantUsdg + ' pour ' + (0.01 + p.gazUsd).toFixed(8) + ' $');
    eq((await M.x.prix('swoge_economy')).montantUsdg, '20000', 'le minimum de 0,02 $ = 20 000 unites d USDG, exactement');
    const r = await M.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) });
    const req = de64(r.entetes['payment-required']);
    ok(req.accepts.length === 2 && req.accepts[0].asset === X.USDG && req.accepts[0].extra.assetTransferMethod === 'eip3009'
       && req.accepts[0].extra.name === 'Global Dollar' && req.accepts[0].extra.version === '1' && req.accepts[1].asset === SWOGE,
       'le 402 propose l USDG d abord (eip3009, domaine Global Dollar v1), puis le $SWOGE (permit2)');
    ok(/USDG or \$SWOGE/.test(req.resource.description), 'la description le dit');
    const sans = monde({ usdg: X.USDG, cours: async () => null });
    const rs = de64((await sans.x.traite({ outil: 'scan_token', url: 'u', sert: sert({}) })).entetes['payment-required']);
    ok(rs.accepts.length === 1 && rs.accepts[0].asset === X.USDG, 'sans cours du $SWOGE, l USDG reste payable (le prix en $ ne depend pas de notre jeton)');

    const w = ethers.Wallet.createRandom();
    const { entete, auth } = await signe3009(w, req, { s: M.s() });
    const compte = {};
    const ok1 = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert(compte) });
    eq(ok1.status, 200, 'paye en USDG : 200');
    const reg = M.chaine.regles[0];
    const sp = ethers.utils.splitSignature(de64(entete).payload.signature);
    ok(reg.m === 'transferWithAuthorization' && reg.a[0] === w.address && reg.a[1] === TRESOR && reg.a[2] === req.accepts[0].amount
       && reg.a[5] === auth.nonce && reg.a[6] === sp.v && reg.a[7] === sp.r && reg.a[8] === sp.s,
       'transferWithAuthorization(from = le payeur, to = la tresorerie, le montant du devis, nonce, v, r, s)');
    ok(M.chaine.simules[0] === 'transferWithAuthorization' && compte.n === 1, 'simule avant de servir, servi une fois');
    const c1 = JSON.parse(ok1.corps);
    ok(c1.x402.asset === X.USDG && M.journal[0].asset === X.USDG && M.journal[0].methode === 'transferWithAuthorization', 'le recu et le journal disent USDG');
    ok(M.x.MESURE.gazParMethode.transferWithAuthorization.length === 1, 'le gaz reel est range par methode');
    const rej = await M.x.traite({ outil: 'scan_token', url: 'u', entete, sert: sert({}) });
    ok(rej.status === 402 && M.chaine.regles.length === 1, 'la meme autorisation rejouee : 402, un seul reglement');

    const essai = async (m, o, attendu, v) => {
      Object.assign(M.chaine.v, v || {});
      const { entete: e } = await signe3009(w, req, Object.assign({ s: M.s() }, o));
      const cc = {}, avant = M.chaine.regles.length;
      const rr = await M.x.traite({ outil: 'scan_token', url: 'u', entete: e, sert: sert(cc) });
      const raison = JSON.parse(rr.corps).raison;
      ok(rr.status === 402 && !cc.n && M.chaine.regles.length === avant && attendu.test(raison), m + ' → 402 ' + raison + ', rien servi, rien regle');
      Object.assign(M.chaine.v, { soldeUsdg: undefined, autorisationLibre: undefined, simuleEchoue: null });
    };
    const moins = String(Number(req.accepts[0].amount) - 1);
    await essai('un montant signe plus bas que le devis', { value: moins }, /value_mismatch/);
    await essai('un montant jamais devise', { accepted: { amount: moins }, value: moins }, /invalid_payment_requirements/);
    await essai('le montant $SWOGE presente comme de l USDG', { accepted: { amount: req.accepts[1].amount }, value: req.accepts[1].amount }, /invalid_payment_requirements/);
    await essai('un autre destinataire', { to: ethers.Wallet.createRandom().address }, /recipient_mismatch/);
    await essai('expiree (validBefore passe)', { validBefore: M.s() - 1 }, /valid_before/);
    await essai('validBefore a plus d une heure', { validBefore: M.s() + 4000 }, /invalid_payload/);
    await essai('pas encore valide', { validAfter: M.s() + 60 }, /valid_after/);
    await essai('signee par un AUTRE que « from »', { autre: ethers.Wallet.createRandom() }, /signature/);
    await essai('un nonce qui n est pas un bytes32', { nonceApres: '0x1234' }, /invalid_payload/);
    await essai('un solde USDG trop bas', {}, /insufficient_funds/, { soldeUsdg: B.from(1) });
    await essai('une autorisation deja utilisee sur la chaine', {}, /invalid_transaction_state/, { autorisationLibre: false });
    await essai('une simulation qui revert (InsufficientFunds)', {}, /invalid_transaction_state/, { simuleEchoue: 'InsufficientFunds()' });
    const autreJeton = await signe3009(w, req, { s: M.s(), accepted: { asset: '0x' + '22'.repeat(20) } });
    ok(/invalid_payment_requirements/.test(JSON.parse((await M.x.traite({ outil: 'scan_token', url: 'u', entete: autreJeton.entete, sert: sert({}) })).corps).raison), 'un autre jeton que le vrai USDG : refuse');

    const { entete: ep } = await signe3009(w, req, { s: M.s() });
    const avant = M.chaine.regles.length;
    const panne = await M.x.traite({ outil: 'scan_token', url: 'u', entete: ep, sert: async () => ({ ok: false, code: 502, raison: 'x' }) });
    ok(panne.status === 502 && M.chaine.regles.length === avant, 'outil en panne : l autorisation USDG n est jamais soumise');
    eq((await M.x.traite({ outil: 'scan_token', url: 'u', entete: ep, sert: sert({}) })).status, 200, 'et elle reste utilisable ensuite, une fois');
    const [a2, b2] = await Promise.all([1, 2].map(async () => M.x.traite({ outil: 'scan_token', url: 'u', entete: (await signe3009(w, req, { s: M.s(), nonce: '0x' + 'ab'.repeat(32) })).entete, sert: sert({}) })));
    ok([a2.status, b2.status].sort().join() === '200,402', 'meme nonce EIP-3009 en simultane : une seule passe [' + a2.status + ',' + b2.status + ']');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
