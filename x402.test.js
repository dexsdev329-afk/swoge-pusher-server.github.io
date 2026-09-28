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
 *   6. deux requêtes simultanées avec la même signature : une seule passe ;
 *   10. (lot Base, 27 septembre 2026) l'USDC sur Base réglé par Coinbase : Base
 *      d'abord, montants du contrat §A.2, ASCII, tailles d'en-têtes, NOS
 *      conditions envoyées à Coinbase, signature décidée par le code du
 *      signataire, « en attente » et ambigu décidés par la CHAÎNE (jamais
 *      authorizationState), jamais dans la file du portefeuille de gaz ;
 *      (revue du 27 septembre 2026) la reprise d'une attente réservée au MÊME
 *      paiement pour le MÊME appel, l'emballage ERC-6492 laissé à Coinbase, le
 *      registre des pertes d'ask_agent appelé dans les quatre cas, et la preuve
 *      sur la chaîne en NÉGATIF (Transfer ailleurs, mauvais montant, revert).
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
    /* L'extension bazaar (audit AgentCash du 26 septembre 2026 : 16 erreurs, toutes a
       extensions.bazaar) : posee par deps.bazaar, jamais bloquante. */
    ok(!('bazaar' in req.extensions), 'sans deps.bazaar : aucune extension bazaar (rien d invente)');
    const BZ = { info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: { arguments: {} } }, output: { type: 'json' } }, schema: { type: 'object' } };
    const vus = [];
    const avecBz = X.cree({ asset: SWOGE, payTo: TRESOR, chaine: fausseChaine(), cours: async () => 0.00002493, ethUsd: async () => 2688, prixOutilUsd: () => 0.01,
      bazaar: (o) => { vus.push(o); return BZ; } });
    const rb = await avecBz.traite({ outil: 'scan_token', url: 'u', sert: sert({}), args: { address: '0x' + 'ee'.repeat(20) } });
    const eb = de64(rb.entetes['payment-required']);
    ok(rb.status === 402 && JSON.stringify(eb.extensions.bazaar) === JSON.stringify(BZ) && JSON.stringify(JSON.parse(rb.corps).extensions.bazaar) === JSON.stringify(BZ)
       && eb.extensions.eip2612GasSponsoring && vus.join() === 'scan_token',
       'deps.bazaar : l extension bazaar dans le 402 (en-tete ET corps), a cote d eip2612GasSponsoring, demandee par NOM d outil seulement');
    const casse = X.cree({ asset: SWOGE, payTo: TRESOR, chaine: fausseChaine(), cours: async () => 0.00002493, ethUsd: async () => 2688, prixOutilUsd: () => 0.01,
      bazaar: () => { throw new Error('casse'); } });
    const rc = await casse.traite({ outil: 'scan_token', url: 'u', sert: sert({}) });
    ok(rc.status === 402 && !('bazaar' in de64(rc.entetes['payment-required']).extensions) && de64(rc.entetes['payment-required']).accepts.length === 1,
       'un bazaar qui echoue ne bloque jamais le 402 : payable sans lui');
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

  console.log('\n-- 8. un devis vaut pour CES arguments (images a prix fixe) --');
  {
    const chaine = fausseChaine();
    let t = 1790000000000;
    const servis = [];
    const x = X.cree({ asset: SWOGE, usdg: X.USDG, payTo: TRESOR, chaine, cours: async () => 0.00002493, ethUsd: async () => 2688.57,
      prixOutilUsd: (o, a) => (o === 'generate_image' ? 0.06 * Number((a && a.count) || 1) : null), maintenant: () => t });
    const w = ethers.Wallet.createRandom();
    const petit = { prompt: 'a cat', count: 1 }, gros = { prompt: 'a cat', count: 4 };
    const reqP = de64((await x.traite({ outil: 'generate_image', url: 'u', args: petit, sert: async () => ({ ok: true }) })).entetes['payment-required']);
    const reqG = de64((await x.traite({ outil: 'generate_image', url: 'u', args: gros, sert: async () => ({ ok: true }) })).entetes['payment-required']);
    ok(Number(reqG.accepts[0].amount) > 3 * Number(reqP.accepts[0].amount), 'le prix suit les arguments : ' + reqP.accepts[0].amount + ' pour 1 image, ' + reqG.accepts[0].amount + ' pour 4');
    const sert = (a) => async (payeur) => { servis.push({ a, payeur }); return { ok: true, resultat: a }; };
    const { entete: e1 } = await signe3009(w, reqP, { s: Math.floor(t / 1000) });
    const triche = await x.traite({ outil: 'generate_image', url: 'u', args: gros, entete: e1, sert: sert(gros) });
    ok(triche.status === 402 && /invalid_payment_requirements/.test(JSON.parse(triche.corps).raison) && !servis.length && !chaine.regles.length,
       'payer le devis d UNE image puis demander QUATRE : refuse, rien servi, rien regle');
    const memes = { count: 1, prompt: 'a cat' };      /* memes arguments, autre ordre des cles */
    const bon = await x.traite({ outil: 'generate_image', url: 'u', args: memes, entete: e1, sert: sert(memes) });
    ok(bon.status === 200 && servis.length === 1 && chaine.regles.length === 1, 'les MEMES arguments (cles dans un autre ordre) : paye, servi, regle');
    eq(servis[0].payeur, w.address, 'l outil sait QUI a paye (une image au nom du payeur, pas d une adresse du corps)');
  }

  console.log('\n-- 9. le devis sans cle et les compteurs durables (26 septembre 2026) --');
  {
    const chaine = fausseChaine();
    chaine.regle = async (m, a) => { chaine.regles.push({ m, a }); return { ok: true, hash: '0x' + String(chaine.regles.length).padStart(64, '0'), gasUsed: '91234', gazPrix: '28000000' }; };
    const t = 1790000000000, notes = [];
    const x = X.cree({ asset: SWOGE, usdg: X.USDG, payTo: TRESOR, chaine, cours: async () => 0.00002493, ethUsd: async () => 2688.57,
      prixOutilUsd: (o) => ({ scan_token: 0.01 })[o] || null, maintenant: () => t, note: (e, i) => notes.push(Object.assign({ e }, i)) });
    const d0 = x.MESURE.devis;
    const q = await x.exige('scan_token', 'u', null, {}, { devis: true });
    ok(q && q.accepts.length === 2 && x.MESURE.devis === d0 && !notes.length, 'exige(…, {devis: true}) : les exigences, sans compter un 402 emis');
    const w = ethers.Wallet.createRandom();
    const { entete, acc } = await signe3009(w, q, { s: Math.floor(t / 1000) });
    const r = await x.traite({ outil: 'scan_token', url: 'u', entete, args: {}, sert: sert({}), canal: 'rest', qui: 'ip:1' });
    eq(r.status, 200, 'les exigences d un DEVIS se paient telles quelles (le devis est enregistre comme emis)');
    const p = notes.find((y) => y.e === 'paye_x402');
    ok(p && p.qui === w.address && p.canal === 'rest' && p.outil === 'scan_token' && p.usd === Number(acc.amount) / 1e6 && p.sorte === 'USDG',
       'compte paye_x402 : l adresse VERIFIEE du payeur (pas l IP), le montant exact en USDG (' + (p && p.usd) + ' $)');
    ok(p && Math.abs(p.coutUsd - 91234 * 28e6 / 1e18 * 2688.57) < 1e-9, 'et le cout reel : le gaz du reglement (91 234 × 0,028 gwei × ETH = ' + (p && p.coutUsd.toFixed(5)) + ' $)');
    notes.length = 0;
    await x.traite({ outil: 'scan_token', url: 'u', args: {}, sert: sert({}), canal: 'rest', qui: 'ip:2', sonde: true });
    await x.traite({ outil: 'scan_token', url: 'u', args: { address: '0x' + '1'.repeat(40) }, sert: sert({}), canal: 'rest', qui: 'ip:2' });
    await x.traite({ outil: 'scan_token', url: 'u', entete, args: {}, sert: sert({}), canal: 'rest', qui: 'ip:3' });
    eq(notes.map((y) => y.e + ':' + y.qui + ':' + (y.sorte || '')).join(' | '), 'demande402:ip:2:sonde | demande402:ip:2:demande | echec:ip:3:paiement_refuse:invalid_payload',
       'compte chaque 402 (sonde ou demande, par empreinte d IP) et chaque paiement refuse, avec sa raison x402');
  }

  /* ==================================================================
   * 10. BASE : L'USDC REGLE PAR COINBASE (lot Base, contrat §F.2, 27 septembre 2026)
   * Un faux Coinbase (objet), un faux RPC de Base (lecture), de VRAIES
   * signatures EIP-3009 sur le domaine de l'USDC de Base (USD Coin, 2, 8453).
   * ================================================================== */
  console.log('\n-- 10. Base : l USDC regle par Coinbase --');
  {
    const A = require('./agentic'), D = require('./decouverte');
    const HASH = (i) => '0x' + String(i).padStart(64, 'c');
    const dort = (ms) => new Promise((r) => setTimeout(r, ms));
    const pad32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
    /* Le faux Coinbase : ce qu'il recoit, et ce qu'il repond (a choisir par essai). */
    function fauxFac() {
      const F = { verifies: [], regles: [], sup: { ok: true, kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] }, verifyRep: { etat: 'valide' }, regleReps: [] };
      F.supported = async () => F.sup;
      F.verify = async (p, e) => { F.verifies.push({ p: JSON.parse(JSON.stringify(p)), e: JSON.parse(JSON.stringify(e)) }); return Object.assign({ ms: 3 }, typeof F.verifyRep === 'function' ? F.verifyRep(p, e) : F.verifyRep); };
      F.regle = async (p, e) => {
        F.regles.push({ p: JSON.parse(JSON.stringify(p)), e: JSON.parse(JSON.stringify(e)) });
        const r = F.regleReps.length ? F.regleReps.shift() : { etat: 'paye', hash: HASH(F.regles.length) };
        if (r.attendMs) await dort(r.attendMs);
        return Object.assign({ ms: 7 }, r);
      };
      return F;
    }
    /* Le faux RPC de Base : codes, recus, journaux — ce que la chaine dirait. */
    function fauxRpc() {
      const R = { codes: {}, recus: {}, logs: [], blocN: 5000, lus: [] };
      R.code = async (a) => { R.lus.push('code'); return R.codes[String(a).toLowerCase()] || '0x'; };
      R.recu = async (h) => { R.lus.push('recu'); return R.recus[h] || null; };
      R.journaux = async (f) => { R.lus.push('logs'); return R.logs.filter((l) => l.address.toLowerCase() === f.address.toLowerCase() && f.topics.every((t, i) => !t || String(l.topics[i] || '').toLowerCase() === String(t).toLowerCase())); };
      R.bloc = async () => R.blocN;
      /* Un reglement reussi sur la chaine : AuthorizationUsed(from, nonce) + Transfer(from → payTo, montant), status 1. */
      R.paye = (h, from, nonce, to, montant) => {
        const logs = [{ address: X.USDC_BASE, topics: [X.TOPIC_AUTH_USED, pad32(from), nonce], data: '0x', transactionHash: h },
          { address: X.USDC_BASE, topics: [X.TOPIC_TRANSFER, pad32(from), pad32(to)], data: ethers.utils.hexZeroPad(ethers.BigNumber.from(montant).toHexString(), 32), transactionHash: h }];
        R.recus[h] = { status: '0x1', transactionHash: h, logs };
        R.logs.push(...logs);
      };
      R.annule = (from, nonce) => R.logs.push({ address: X.USDC_BASE, topics: [X.TOPIC_AUTH_CANCELED, pad32(from), nonce], data: '0x', transactionHash: HASH(999) });
      return R;
    }
    const BZ = (o) => D.bazaar(o, A.definitions({ recherche: true }).find((d) => d.name === o));
    async function mondeBase(o) {
      o = o || {};
      const chaine = fausseChaine(o.chaine);
      let t = o.t0 || Date.now();
      const journal = [], notes = [], F = o.F || fauxFac(), R = o.R || fauxRpc();
      const x = X.cree({ asset: SWOGE, usdg: X.USDG, payTo: TRESOR, chaine, cours: async () => 0.00002493, ethUsd: o.ethUsd || (async () => 2688.57),
        prixOutilUsd: o.prix || ((outil, a) => A.prixX402Usd(outil, a)), maintenant: () => t, journal: (l) => journal.push(l), note: (e, i) => notes.push(Object.assign({ e }, i)),
        bazaar: BZ, description: (n2) => ((A.definitions({ recherche: true }).find((d) => d.name === n2)) || {}).description,
        service: { nom: 'SwogeAgentic', etiquettes: (n2) => D.ETIQUETTES_OUTIL[n2], icone: D.ICONE },
        agent: o.agent,
        solana: o.sol,
        base: o.sansBase ? undefined : { reseau: X.RESEAU_BASE, chainId: 8453, usdc: X.USDC_BASE, domaine: X.DOMAINE_USDC_BASE, payTo: TRESOR, facilitateur: F, rpc: R, attenteMs: 40, cadenceMs: 5,
          second: o.S, partSecond: o.part, versSecond: o.versSecond, versCdp: o.versCdp } });
      if (!o.sansBase) { await x.sondeBase(); await dort(10); }
      return { x, chaine, journal, notes, F, R, avance: (ms) => { t += ms; }, s: () => Math.floor(t / 1000) };
    }
    const entete402 = async (M, outil, args) => de64((await M.x.traite({ outil, url: 'https://api/agentic/call/' + outil, args: args || {}, sert: sert({}) })).entetes['payment-required']);
    /* Ce qu'un client x402 signe pour Base (EIP-3009, domaine USD Coin v2 sur 8453). */
    async function signeBase(w, req, o) {
      o = o || {};
      const acc = Object.assign({}, req.accepts.find((a) => a.network === 'eip155:8453'), o.accepted || {});
      const auth = { from: w.address, to: o.to || acc.payTo, value: o.value || acc.amount, validAfter: String(o.validAfter || o.s - 600),
        validBefore: String(o.validBefore || o.s + 100), nonce: o.nonce || ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
      const dom = Object.assign({ chainId: o.chainId || 8453, verifyingContract: o.contrat || X.USDC_BASE }, o.domaine || X.DOMAINE_USDC_BASE);
      const signature = await (o.autre || w)._signTypedData(dom, X.TYPES_3009, auth);
      const p = { x402Version: 2, resource: o.resource || req.resource, accepted: acc, payload: { signature, authorization: auth }, extensions: o.extensions || req.extensions };
      return { entete: X.b64(p), objet: p, auth, acc };
    }
    const paie = (M, outil, entete, args, s2) => M.x.traite({ outil, url: 'https://api/agentic/call/' + outil, entete, args: args || {}, sert: s2 || sert({}) });

    /* ---- le 402, Base allumee ---- */
    process.env.X402_AGENT = '1'; process.env.TG_APPELS_VENTE = '1'; process.env.STUDIO_MARGE = '1.5'; delete process.env.AGENTIC_PRIX;
    const M = await mondeBase();
    ok(M.x.baseActif() && M.x.MESURE.base.etat === 'on', 'la sonde /supported liste eip155:8453 : Base allumee');
    const req = await entete402(M, 'scan_token', { address: '0x' + 'ee'.repeat(20) });
    ok(req.accepts.map((a) => a.network + ':' + (a.extra.assetTransferMethod || 'base')).join() === 'eip155:8453:base,eip155:4663:eip3009,eip155:4663:permit2',
       'les options : [USDC Base, USDG, $SWOGE] — Base d abord, Robinhood ensuite dans son ordre');
    ok(JSON.stringify(req.accepts[0].extra) === '{"name":"USD Coin","version":"2"}' && req.accepts[0].asset === X.USDC_BASE && req.accepts[0].payTo === TRESOR && req.accepts[0].maxTimeoutSeconds === 120,
       'Base : extra EXACTEMENT {name: USD Coin, version: 2}, sans assetTransferMethod ; l USDC de Base ; la tresorerie ; 120 s');
    /* §A.2 : les montants, calcules par la fonction du depot (prix_base_calc.js, 27 septembre 2026). */
    /* La baisse du 28/09 (agentic.js, PRIX_DEFAUT ; x402.PLANCHER_FACILITE) : new_launches 0,006 $ (0,005 + 0,001),
       wallet_intel, osint_lookup et web_search au plancher de 0,01 $. Les temoins restent a 0,02 $. */
    const attendus = [['scan_token', undefined, '20000'], ['colony_activity', undefined, '20000'], ['swoge_economy', undefined, '20000'], ['new_launches', undefined, '6000'],
      ['wallet_intel', undefined, '10000'], ['osint_lookup', undefined, '10000'], ['telegram_calls', undefined, '20000'], ['web_search', undefined, '10000'],
      ['generate_image', { prompt: 'a dog', provider: 'grok', quality: 'speed', count: 1 }, '91000'], ['generate_image', { prompt: 'a dog', provider: 'grok', quality: 'quality', count: 1 }, '181000'],
      ['generate_image', { prompt: 'swoge on a boat', provider: 'grok', quality: 'quality', count: 1 }, '365725'], ['generate_image', { prompt: 'a dog', provider: 'openai', quality: 'quality', count: 1 }, '556000'],
      ['generate_image', { prompt: 'swoge on a boat', provider: 'openai', quality: 'quality', count: 4 }, '2324725'], ['ask_agent', undefined, '541000']];
    const lus = [];
    for (const [o, a, m] of attendus) { const p = await M.x.prix(o, a); lus.push(o + (a ? '(' + a.provider + ',' + a.quality + ',' + a.count + ')' : '') + '=' + (p && p.montantBase)); ok(p && p.montantBase === m, 'prix Base de ' + lus[lus.length - 1] + ' (attendu ' + m + ', tableau §A.2)'); }
    /* Chaque outil payable : description, ASCII, taille des en-tetes. */
    const payables = A.definitions({ recherche: true }).map((d) => d.name).filter((o) => A.prixX402Usd(o, o === 'generate_image' ? { prompt: 'x' } : undefined) > 0);
    let pire = { n: 0 }, pireSig = { n: 0 };
    const w0 = ethers.Wallet.createRandom();
    for (const o of payables) {
      const a = o === 'generate_image' ? { prompt: 'swoge on a boat', provider: 'openai', quality: 'quality', count: 4 } : {};
      const r = await M.x.traite({ outil: o, url: 'https://web-production-220a3.up.railway.app/agentic/call/' + o, args: a, sert: sert({}) });
      const h = r.entetes['payment-required'], e = de64(h);
      const d = e.resource.description;
      ok(d.length <= 500 && !d.includes('…') && /Price: \$[0-9.]+ in USDC on Base, or \$[0-9.]+ in USDG or \$SWOGE on Robinhood Chain/.test(d) && e.resource.serviceName === 'SwogeAgentic'
         && Array.isArray(e.resource.tags) && e.resource.tags.length <= 5 && e.resource.tags.every((x) => x.length <= 32) && e.resource.iconUrl === D.ICONE,
         o + ' : description ' + d.length + ' car. (<= 500, sans « … »), premiere phrase + prix par reseau ; serviceName, tags, iconUrl');
      const brut = JSON.stringify({ resource: e.resource, accepts: e.accepts, extensions: e.extensions });
      const horsAscii = brut.match(/[^\x20-\x7e]/g);
      ok(!horsAscii, o + ' : AUCUN caractere hors 0x20-0x7E dans resource, accepts et extensions (btoa de Cloudflare)' + (horsAscii ? ' — ' + JSON.stringify(horsAscii.slice(0, 5)) : ''));
      ok(h.length < 8192, o + ' : en-tete PAYMENT-REQUIRED ' + h.length + ' caracteres, sous 8 192');
      if (h.length > pire.n) pire = { n: h.length, o };
      /* Le plus gros PAYMENT-SIGNATURE realiste : resource, accepted, bazaar complet renvoyes par le client. */
      const sg = await signeBase(w0, e, { s: M.s() });
      const sig = Buffer.byteLength(sg.entete) + Buffer.byteLength('payment-signature: \r\n');
      if (sig > pireSig.n) pireSig = { n: sig, o };
    }
    ok(pireSig.n < 12288, 'le plus gros PAYMENT-SIGNATURE (' + pireSig.o + ') : ' + pireSig.n + ' octets, bien sous les 16 384 de Node pour TOUS les en-tetes (75 % au plus)');
    console.log('       (plus gros PAYMENT-REQUIRED : ' + pire.o + ', ' + pire.n + ' caracteres)');
    ok(!('bazaar' in (req.extensions.eip2612GasSponsoring || {})) && req.extensions.bazaar && req.extensions.eip2612GasSponsoring, 'extensions : eip2612GasSponsoring (pour le $SWOGE) et bazaar, gardees');

    /* ---- Base eteinte : les options Robinhood d'aujourd'hui ---- */
    const M0 = await mondeBase({ sansBase: true });
    const req0 = await entete402(M0, 'scan_token', { address: '0x' + 'ee'.repeat(20) });
    ok(JSON.stringify(req0.accepts) === JSON.stringify(req.accepts.slice(1)) && /^SwogeAgentic tool scan_token — \$[0-9.]+ in USDG or \$SWOGE \(tool price \+ settlement gas, minimum \$0\.02\)$/.test(req0.resource.description)
       && !req0.resource.serviceName && req0.extensions.bazaar.info.output.example,
       'Base eteinte : les options Robinhood IDENTIQUES a celles d apres Base, la description d avant mot pour mot ; seul ajout : bazaar.info.output.example');
    const M0x = await mondeBase({ F: Object.assign(fauxFac(), { sup: { ok: false, statut: 401 } }) });
    ok(!M0x.x.baseActif() && (await entete402(M0x, 'scan_token')).accepts.every((a) => a.network === 'eip155:4663'), 'une sonde /supported en 401 : Base eteinte, aucune option Base');

    /* ---- l'independance des deux facons de payer ---- */
    const Mi = await mondeBase({ chaine: { gp: null }, ethUsd: async () => { throw new Error('ETH muet'); } });
    Mi.chaine.gazPrix = async () => { throw new Error('RPC Robinhood coupe'); };
    const ri = await Mi.x.traite({ outil: 'scan_token', url: 'u', args: {}, sert: sert({}) });
    const qi = de64(ri.entetes['payment-required']);
    const pi = await Mi.x.prix('scan_token');
    ok(ri.status === 402 && qi.accepts.length === 1 && qi.accepts[0].network === 'eip155:8453' && pi.usd === null && pi.usdBase === 0.02,
       'Robinhood en panne (gaz et ETH inconnus) : Base reste offerte seule, usd = null, usdBase = 0.02');
    const ann = await D.prixX402Annonces({ noms: ['scan_token', 'wallet_intel'], prix: (o, a) => Mi.x.prix(o, a), base: A.prixX402Usd, minUsd: 0.02 });
    ok(ann.scan_token && ann.scan_token.min === 0.02 && ann.scan_token.max === 0.02 && ann.wallet_intel.min === 0.01, 'prixX402Annonces avec usd null : le prix Base (avant : l outil disparaissait)');
    const annB = await D.prixX402Annonces({ noms: ['scan_token'], prix: (o, a) => M.x.prix(o, a), base: A.prixX402Usd, minUsd: 0.02 });
    ok(annB.scan_token.min === 0.02 && annB.scan_token.max === (await M.x.prix('scan_token')).usd, 'deux reseaux : min = Base, max = Robinhood');
    const Mr = await mondeBase({ sansBase: true });
    Mr.chaine.gazPrix = async () => { throw new Error('RPC Robinhood coupe'); };
    eq((await Mr.x.traite({ outil: 'scan_token', url: 'u', args: {}, sert: sert({}) })).status, 503, 'Base eteinte et Robinhood en panne : 503, comme avant');

    /* ---- la duree d'un devis, par option ---- */
    {
      const Ma = await mondeBase({ prix: (o) => ({ ask_agent: 0.54, scan_token: 0.01 })[o] || null, agent: { dureeMaxS: 150, enVolMax: 3, bloque: () => false } });
      const w = ethers.Wallet.createRandom();
      const qa = await entete402(Ma, 'ask_agent', { task: 'x' });
      const qs = await entete402(Ma, 'scan_token', {});
      ok(qa.accepts.every((a) => a.maxTimeoutSeconds === 300) && qs.accepts.every((a) => a.maxTimeoutSeconds === 120) && qa.accepts[0].amount === '541000',
         'ask_agent : 300 s sur CHAQUE option (Base 541000) ; un outil fixe : 120 s');
      Ma.avance(200000);
      const sa = await signeBase(w, qa, { s: Ma.s(), validBefore: Ma.s() + 250 });
      const ra = await paie(Ma, 'ask_agent', sa.entete, { task: 'x' });
      const ss = await signeBase(w, qs, { s: Ma.s() });
      const rs = await paie(Ma, 'scan_token', ss.entete, {});
      ok(ra.status === 200 && rs.status === 402 && /invalid_payment_requirements/.test(JSON.parse(rs.corps).raison),
         'paye a t = 200 s : le devis ask_agent (300 s) passe, celui d un outil fixe (120 s) est refuse');
      const sc = await signeBase(w, await entete402(Ma, 'ask_agent', { task: 'x' }), { s: Ma.s(), validBefore: Ma.s() + 170 });
      const rc = await paie(Ma, 'ask_agent', sc.entete, { task: 'x' });
      ok(rc.status === 402 && /valid_before/.test(JSON.parse(rc.corps).raison) && /180 s/.test(JSON.parse(rc.corps).detail), 'ask_agent signe pour moins de 150 + 30 s : refuse (« at least 180 s ahead »)');
    }

    /* ---- payer sur Base ---- */
    {
      const Mp = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(Mp, 'scan_token', { address: '0x' + 'ee'.repeat(20) });
      const triche = { maxTimeoutSeconds: 99999, extra: { name: 'USDC', version: '9', assetTransferMethod: 'permit2' } };
      const sg = await signeBase(w, q, { s: Mp.s(), accepted: triche, resource: { url: 'https://evil.example/x', description: 'free stuff' },
        extensions: Object.assign({}, q.extensions, { bazaar: { info: { evil: true } }, autre: { x: 1 } }) });
      const compte = {};
      const r = await paie(Mp, 'scan_token', sg.entete, { address: '0x' + 'ee'.repeat(20) }, sert(compte));
      const pr = de64(r.entetes['payment-response']);
      ok(r.status === 200 && pr.success === true && pr.network === 'eip155:8453' && pr.payer === w.address && pr.transaction === HASH(1) && compte.n === 1,
         'paye sur Base : 200, PAYMENT-RESPONSE eip155:8453, la transaction de Coinbase, servi une fois');
      const v = Mp.F.verifies[0], g = Mp.F.regles[0];
      ok(v && g && JSON.stringify(v.e) === JSON.stringify({ scheme: 'exact', network: 'eip155:8453', asset: X.USDC_BASE, amount: '20000', payTo: TRESOR, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } })
         && JSON.stringify(v.p.accepted) === JSON.stringify(v.e) && JSON.stringify(g.e) === JSON.stringify(v.e),
         'Coinbase recoit NOS conditions (maxTimeoutSeconds et extra triches par le client : ignores), en paymentRequirements ET en accepted');
      ok(v.p.resource.url === 'https://api/agentic/call/scan_token' && /Price: \$0\.02 in USDC on Base/.test(v.p.resource.description) && JSON.stringify(v.p.extensions) === JSON.stringify({ bazaar: BZ('scan_token') })
         && !('eip2612GasSponsoring' in v.p.extensions) && JSON.stringify(v.p.payload) === JSON.stringify(sg.objet.payload),
         'et NOTRE ressource, NOTRE bloc bazaar, aucune autre extension (ni eip2612GasSponsoring) ; la signature telle quelle');
      ok(Mp.journal[0] && Mp.journal[0].network === 'eip155:8453' && Mp.journal[0].asset === X.USDC_BASE && !('gasUsed' in Mp.journal[0]) && Mp.chaine.regles.length === 0,
         'le journal dit eip155:8453, sans gasUsed ; rien envoye sur Robinhood Chain');
      const n = Mp.notes.find((y) => y.e === 'paye_x402');
      ok(n && n.usd === 0.02 && n.coutUsd === 0.001 && n.sorte === 'USDC_BASE' && n.qui === w.address, 'compteur paye_x402 : 0,02 $, cout 0,001 $ (Coinbase), sorte USDC_BASE');
      ok(Mp.x.MESURE.parReseau['eip155:8453'].payes === 1 && Mp.x.MESURE.parReseau['eip155:8453'].msVerify[0] === 3 && Mp.x.MESURE.parReseau['eip155:8453'].msSettle[0] === 7
         && Mp.x.MESURE.parReseau['eip155:4663'].devis === 1 && !Mp.x.MESURE.parReseau['eip155:4663'].payes, 'MESURE.parReseau : les comptes separes par reseau, et les durees verify / settle');
      const rej = await paie(Mp, 'scan_token', sg.entete, { address: '0x' + 'ee'.repeat(20) });
      ok(rej.status === 402 && Mp.F.regles.length === 1 && de64(rej.entetes['payment-required']).accepts[0].network === 'eip155:8453', 'le MEME paiement rejoue : 402, un seul reglement, une nouvelle demande');
      /* L'objet (MCP _meta) : meme chemin. */
      const sg2 = await signeBase(w, q, { s: Mp.s() });
      const rp = await Mp.x.paie({ outil: 'scan_token', url: 'https://api/mcp', paiement: sg2.objet, args: { address: '0x' + 'ee'.repeat(20) }, sert: sert({}), bazaar: { info: { mcp: 1 } } });
      const vd = Mp.F.verifies[Mp.F.verifies.length - 1];
      ok(rp.etape === 'paye' && Mp.F.verifies.length === 2 && vd.p.resource.url === 'https://api/mcp' && JSON.stringify(vd.p.extensions) === '{"bazaar":{"info":{"mcp":1}}}',
         'un paiement OBJET (MCP) : paye ; Coinbase recoit l adresse /mcp et le bloc bazaar du canal MCP (un devis vaut sur tous les canaux)');
    }

    /* ---- la signature : decidee par le CODE du signataire ---- */
    {
      const Ms = await mondeBase();
      const w = ethers.Wallet.createRandom(), autre = ethers.Wallet.createRandom();
      const q = await entete402(Ms, 'scan_token', {});
      Ms.R.codes[w.address.toLowerCase()] = '0x6080604052';
      const sc = await signeBase(w, q, { s: Ms.s(), autre });
      const rc = await paie(Ms, 'scan_token', sc.entete, {});
      ok(rc.status === 200 && Ms.F.verifies.length === 1 && Ms.R.lus.includes('code'), 'un signataire AVEC du code (Safe, 7702) : 65 octets qui ne retrouvent pas from → pas refuse ici, Coinbase decide (EIP-1271)');
      delete Ms.R.codes[w.address.toLowerCase()];
      const sn = await signeBase(w, q, { s: Ms.s(), autre });
      const rn = await paie(Ms, 'scan_token', sn.entete, {});
      ok(rn.status === 402 && /invalid_exact_evm_payload_signature/.test(JSON.parse(rn.corps).raison) && Ms.F.verifies.length === 1, 'SANS code : refuse ici, Coinbase jamais appele');
    }

    /* ---- refuse SANS appeler Coinbase ---- */
    {
      const Mr2 = await mondeBase({ agent: { dureeMaxS: 150, enVolMax: 3, bloque: (a) => a.toLowerCase() === BLOQUE.address.toLowerCase() }, prix: (o) => ({ ask_agent: 0.54, scan_token: 0.01 })[o] || null });
      const BLOQUE = ethers.Wallet.createRandom();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(Mr2, 'scan_token', {});
      const essai = async (m, o, re, outil, args, q2) => {
        const s0 = await signeBase(o.w || w, q2 || q, Object.assign({ s: Mr2.s() }, o));
        const avant = Mr2.F.verifies.length, regles = Mr2.F.regles.length, c = {};
        const r = await paie(Mr2, outil || 'scan_token', s0.entete, args || {}, sert(c));
        const raison = JSON.parse(r.corps).raison;
        ok(r.status === 402 && re.test(raison) && Mr2.F.verifies.length === avant && Mr2.F.regles.length === regles && !c.n, m + ' → 402 ' + raison + ', Coinbase jamais appele, rien servi');
        return s0;
      };
      await essai('signe pour la chaine 4663', { chainId: 4663 }, /signature/);
      await essai('signe pour le contrat USDG', { contrat: X.USDG }, /signature/);
      await essai('signe avec le nom « USDC » (domaine faux sur mainnet)', { domaine: { name: 'USDC', version: '2' } }, /signature/);
      await essai('un autre destinataire', { to: ethers.Wallet.createRandom().address }, /recipient_mismatch/);
      await essai('un montant different du devis', { value: '19999' }, /value_mismatch/);
      await essai('expiree', { validBefore: Mr2.s() - 1 }, /valid_before/);
      await essai('aucun devis pour ce montant', { accepted: { amount: '19999' }, value: '19999' }, /invalid_payment_requirements/);
      const deja = await signeBase(w, q, { s: Mr2.s() });
      eq((await paie(Mr2, 'scan_token', deja.entete, {})).status, 200, '(une premiere presentation passe)');
      const av = Mr2.F.verifies.length;
      const rj = await paie(Mr2, 'scan_token', deja.entete, {});
      ok(rj.status === 402 && /already presented/.test(JSON.parse(rj.corps).detail) && Mr2.F.verifies.length === av, 'un nonce deja presente : refuse ici, Coinbase jamais rappele');
      const qa = await entete402(Mr2, 'ask_agent', { task: 'x' });
      await essai('ask_agent paye par un payeur BLOQUE', { w: BLOQUE, validBefore: Mr2.s() + 250 }, /payer_blocked/, 'ask_agent', { task: 'x' }, qa);
    }

    /* ---- l'ordre qui protege le payeur ---- */
    {
      const Mo = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(Mo, 'scan_token', {});
      const s1 = await signeBase(w, q, { s: Mo.s() });
      const panne = await paie(Mo, 'scan_token', s1.entete, {}, async () => ({ ok: false, code: 502, raison: 'the tool failed — nothing was charged' }));
      ok(panne.status === 502 && Mo.F.regles.length === 0, 'l outil en panne : /settle JAMAIS appele');
      Mo.F.regleReps.push({ etat: 'echec', erreur: 'invalid_payload', statut: 400 });
      const s2 = await signeBase(w, q, { s: Mo.s() });
      const rf = await paie(Mo, 'scan_token', s2.entete, {});
      const cf = JSON.parse(rf.corps), pf = de64(rf.entetes['payment-response']);
      ok(rf.status === 402 && !cf.resultat && pf.success === false && pf.errorReason === 'invalid_payload' && pf.transaction === '' && pf.network === 'eip155:8453' && pf.payer === w.address
         && rf.entetes['payment-required'] && de64(rf.entetes['payment-required']).accepts.length === 3,
         'echec definitif (400 invalid_payload) : resultat RETENU, PAYMENT-RESPONSE en echec, et un NOUVEAU PAYMENT-REQUIRED');
    }

    /* ---- ambigu : la chaine decide ---- */
    for (const surChaine of [true, false]) {
      const Mb = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(Mb, 'scan_token', {});
      const sb = await signeBase(w, q, { s: Mb.s() });
      if (surChaine) Mb.R.paye(HASH(77), w.address, sb.auth.nonce, TRESOR, '20000');
      Mb.F.regleReps.push({ etat: 'ambigu', erreur: 'settle_exact_node_failure', statut: 400 });
      const r = await paie(Mb, 'scan_token', sb.entete, {});
      const c = JSON.parse(r.corps);
      ok(surChaine ? r.status === 200 && c.x402.transaction === HASH(77) : r.status === 402 && !c.resultat && !c.accepts && !r.entetes['payment-required'],
         '400 settle_exact_node_failure (ambigu), ' + (surChaine ? 'AuthorizationUsed + Transfer lus sur la chaine : le resultat est rendu' : 'rien sur la chaine : le resultat est RETENU'));
    }

    /* ---- en attente, puis la chaine confirme ---- */
    {
      const Me = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(Me, 'scan_token', {});
      const se = await signeBase(w, q, { s: Me.s() });
      Me.F.regleReps.push({ etat: 'attente', hash: HASH(55), erreur: 'settlement_pending' });
      const c1 = {};
      const r1 = await paie(Me, 'scan_token', se.entete, {}, sert(c1));
      const p1 = de64(r1.entetes['payment-response']), b1 = JSON.parse(r1.corps);
      ok(r1.status === 402 && p1.success === false && p1.errorReason === 'settlement_pending' && p1.transaction === HASH(55) && !r1.entetes['payment-required'] && !b1.accepts && !b1.resultat
         && /retry the same request with the same PAYMENT-SIGNATURE/.test(b1.error),
         'en attente : 402, PAYMENT-RESPONSE settlement_pending + le hash, AUCUN PAYMENT-REQUIRED, aucun accepts, resultat retenu');
      const lusAvant = Me.R.lus.length;
      const r1b = await paie(Me, 'scan_token', se.entete, {});
      ok(r1b.status === 402 && de64(r1b.entetes['payment-response']).errorReason === 'settlement_pending' && Me.F.verifies.length === 1 && Me.F.regles.length === 1 && Me.R.lus.length > lusAvant,
         'represente AVANT la confirmation : toujours en attente, la chaine relue, ni verify ni settle de plus');
      Me.R.paye(HASH(55), w.address, se.auth.nonce, TRESOR, '20000');
      const r2 = await paie(Me, 'scan_token', se.entete, {});
      ok(r2.status === 200 && JSON.parse(r2.corps).x402.transaction === HASH(55) && c1.n === 1 && Me.F.verifies.length === 1 && Me.F.regles.length === 1,
         'le recu arrive (status 1, AuthorizationUsed(from, nonce), Transfer(from → tresorerie, montant)) : le resultat GARDE est rendu, sans nouveau verify ni settle, l outil servi une seule fois');
      const r3 = await paie(Me, 'scan_token', se.entete, {});
      ok(r3.status === 402 && Me.F.regles.length === 1 && Me.x.MESURE.payes === 1, 'rendu UNE fois : represente encore, refuse');
    }

    /* ---- en attente, puis le payeur ANNULE ---- */
    {
      const Mc = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(Mc, 'scan_token', {});
      const sa = await signeBase(w, q, { s: Mc.s() });
      Mc.F.regleReps.push({ etat: 'attente', hash: HASH(66), erreur: 'settlement_pending' });
      await paie(Mc, 'scan_token', sa.entete, {});
      Mc.R.annule(w.address, sa.auth.nonce);
      /* authorizationState serait VRAI ici (une annulation le met a vrai) : on ne le lit jamais. */
      const rc = await paie(Mc, 'scan_token', sa.entete, {});
      const bc = JSON.parse(rc.corps);
      ok(rc.status === 402 && !bc.resultat && rc.entetes['payment-required'] && bc.accepts.length === 3 && /authorization_canceled/.test(bc.raison) && Mc.x.MESURE.payes === 0,
         'AuthorizationCanceled vu : le resultat n est JAMAIS rendu ; un 402 normal, avec une nouvelle demande de paiement');
    }

    /* ---- settle sans reponse (pas de hash) : jamais rejoue, les journaux decident ---- */
    for (const trouve of [true, false]) {
      const Mt = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(Mt, 'scan_token', {});
      const st = await signeBase(w, q, { s: Mt.s() });
      if (trouve) Mt.R.paye(HASH(88), w.address, st.auth.nonce, TRESOR, '20000');
      Mt.F.regleReps.push({ etat: 'inconnu', erreur: 'unexpected_settle_error' });
      const r = await paie(Mt, 'scan_token', st.entete, {});
      const pr = de64(r.entetes['payment-response']);
      ok(Mt.F.regles.length === 1 && (trouve ? r.status === 200 && pr.transaction === HASH(88)
        : r.status === 402 && pr.errorReason === 'unexpected_settle_error' && pr.transaction === '' && !r.entetes['payment-required']),
        'settle en delai, sans hash : AUCUN rejeu ; ' + (trouve ? 'eth_getLogs trouve AuthorizationUsed : rendu' : 'rien trouve : unexpected_settle_error, transaction vide, pas de nouvelle demande'));
    }

    /* ---- Base ne passe jamais par la file du portefeuille de gaz ---- */
    {
      const Mf = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const lent = Mf.chaine.regle;
      Mf.chaine.regle = async (m, a) => { await dort(300); return lent(m, a); };
      const q = await entete402(Mf, 'scan_token', {});
      const sR = await signe3009(w, q, { s: Mf.s() });
      const sB = await signeBase(w, q, { s: Mf.s() });
      const fin = [];
      const pR = paie(Mf, 'scan_token', sR.entete, {}).then((r) => fin.push('robinhood:' + r.status));
      await dort(20);
      const pB = paie(Mf, 'scan_token', sB.entete, {}).then((r) => fin.push('base:' + r.status));
      await Promise.all([pR, pB]);
      eq(fin.join(','), 'base:200,robinhood:200', 'un reglement Robinhood tenu 300 ms : le paiement Base, parti APRES, finit AVANT (jamais dans enFile)');
      ok(Mf.journal.map((l) => l.network).sort().join() === 'eip155:4663,eip155:8453' && Mf.x.MESURE.parReseau['eip155:4663'].payes === 1 && Mf.x.MESURE.parReseau['eip155:8453'].payes === 1,
         'journal et MESURE.parReseau : un paiement par reseau');
    }
    /* ---- en attente : SEUL le meme paiement, pour le meme appel, reprend le resultat retenu ----
       (revue du 27 septembre 2026 : `from` et `nonce` sont publics des que Coinbase diffuse la
       transaction ; avant, les presenter suffisait a emporter le resultat d un autre, pour
       n importe quel outil, et la victime recevait ensuite « nonce already presented ».) */
    {
      const Mv = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const argsV = { address: '0x' + 'ab'.repeat(20) };
      const q = await entete402(Mv, 'wallet_intel', argsV);
      const sv = await signeBase(w, q, { s: Mv.s() });
      Mv.F.regleReps.push({ etat: 'attente', hash: HASH(44), erreur: 'settlement_pending' });
      const cv = {};
      const secret = async () => { cv.n = (cv.n || 0) + 1; return { ok: true, outil: 'wallet_intel', resultat: { secret: 'VICTIM PRIVATE RESULT' }, texte: 'x' }; };
      const r0 = await paie(Mv, 'wallet_intel', sv.entete, argsV, secret);
      ok(r0.status === 402 && de64(r0.entetes['payment-response']).errorReason === 'settlement_pending' && cv.n === 1, '(la victime paie wallet_intel : servi, reglement en attente, resultat retenu)');
      const forge = (pl, outil, args) => paie(Mv, outil, X.b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453' }, payload: pl }), args || {});
      const essaisForges = async (quand) => {
        const tentatives = [
          ['signature vide, un autre outil', { signature: '0x', authorization: { from: w.address, nonce: sv.auth.nonce } }, 'swoge_economy', {}],
          ['signature 0x00, le meme outil, d autres arguments', { signature: '0x00', authorization: { from: w.address, nonce: sv.auth.nonce } }, 'wallet_intel', { address: '0x' + 'cd'.repeat(20) }],
          ['une autre signature, le meme appel', { signature: '0x' + '11'.repeat(65), authorization: sv.auth }, 'wallet_intel', argsV],
          ['la VRAIE signature et autorisation (lisibles sur la chaine), un autre outil', sv.objet.payload, 'swoge_economy', {}],
          ['la vraie signature, le meme outil, d autres arguments', sv.objet.payload, 'wallet_intel', { address: '0x' + 'cd'.repeat(20) }],
          ['la vraie signature, une autorisation retouchee (value)', { signature: sv.objet.payload.signature, authorization: Object.assign({}, sv.auth, { value: '1' }) }, 'wallet_intel', argsV],
        ];
        for (const [m, pl, o, a] of tentatives) {
          const avant = { v: Mv.F.verifies.length, g: Mv.F.regles.length, p: Mv.x.MESURE.payes };
          const r = await forge(pl, o, a);
          ok(r.status === 402 && !/VICTIM/.test(r.corps) && !/VICTIM/.test(JSON.stringify(r.entetes)) && /already presented/.test(JSON.parse(r.corps).detail || '')
             && Mv.F.verifies.length === avant.v && Mv.F.regles.length === avant.g && Mv.x.MESURE.payes === avant.p && cv.n === 1,
             quand + ', ' + m + ' (meme from et nonce) : 402, AUCUN resultat retenu, ni verify ni settle');
        }
      };
      await essaisForges('en attente');
      Mv.R.paye(HASH(44), w.address, sv.auth.nonce, TRESOR, sv.auth.value);
      await essaisForges('confirme sur la chaine');
      const rv = await paie(Mv, 'wallet_intel', sv.entete, argsV);
      const bv = JSON.parse(rv.corps);
      ok(rv.status === 200 && bv.resultat && bv.resultat.secret === 'VICTIM PRIVATE RESULT' && bv.x402.transaction === HASH(44) && cv.n === 1 && Mv.x.MESURE.payes === 1 && Mv.F.regles.length === 1,
         'et la victime, avec SA signature, SON outil, SES arguments : le resultat retenu lui est rendu, l outil servi une seule fois');
      /* Le meme paiement represente par MCP (objet), memes arguments : meme identite. */
      const Mv2 = await mondeBase();
      const q2 = await entete402(Mv2, 'scan_token', {});
      const s2 = await signeBase(w, q2, { s: Mv2.s() });
      Mv2.F.regleReps.push({ etat: 'attente', hash: HASH(45), erreur: 'settlement_pending' });
      await paie(Mv2, 'scan_token', s2.entete, {});
      Mv2.R.paye(HASH(45), w.address, s2.auth.nonce, TRESOR, '20000');
      const rm = await Mv2.x.paie({ outil: 'scan_token', url: 'https://api/mcp', paiement: s2.objet, args: {}, sert: sert({}) });
      ok(rm.etape === 'paye' && rm.recu.transaction === HASH(45), 'le meme paiement represente en OBJET (MCP), meme outil et memes arguments : rendu');
    }

    /* ---- un portefeuille intelligent PAS ENCORE deploye (emballage ERC-6492) : Coinbase decide ----
       (contrat §A.4 etape 2 et §G.7 : jamais refuse ici ; sans code a `from`, par definition). */
    {
      const M6 = await mondeBase();
      const w = ethers.Wallet.createRandom();
      const q = await entete402(M6, 'scan_token', {});
      const MAGIE = '6492'.repeat(16);
      const emballe = async (queue) => {
        const s0 = await signeBase(w, q, { s: M6.s() });
        const p = JSON.parse(JSON.stringify(s0.objet));
        /* usine (20 octets) + appel + signature interne, puis le suffixe magique : la forme ERC-6492. */
        p.payload.signature = '0x' + '5f'.repeat(20) + 'ab'.repeat(100) + s0.objet.payload.signature.slice(2) + queue;
        return { entete: X.b64(p), objet: p };
      };
      const codesAvant = M6.R.lus.filter((x) => x === 'code').length;
      const s6 = await emballe(MAGIE);
      const r6 = await paie(M6, 'scan_token', s6.entete, {});
      ok(r6.status === 200 && M6.F.verifies.length === 1 && M6.F.verifies[0].p.payload.signature === s6.objet.payload.signature
         && M6.R.lus.filter((x) => x === 'code').length === codesAvant && !M6.R.codes[w.address.toLowerCase()],
         'signature ERC-6492 (suffixe 0x6492...6492), AUCUN code a from : pas refusee ici, passee telle quelle a Coinbase (eth_getCode pas lu)');
      M6.F.verifyRep = { etat: 'refuse', raison: 'invalid_exact_evm_payload_undeployed_smart_wallet' };
      const s7 = await emballe(MAGIE.toUpperCase());
      const r7 = await paie(M6, 'scan_token', s7.entete, {});
      const b7 = JSON.parse(r7.corps);
      ok(r7.status === 402 && b7.raison === 'invalid_exact_evm_payload_undeployed_smart_wallet' && /not deployed on Base yet/.test(b7.detail) && M6.F.verifies.length === 2,
         'Coinbase repond undeployed_smart_wallet : l agent recoit ce code et la phrase claire en anglais (suffixe en majuscules reconnu aussi)');
      const s8 = await emballe('6492'.repeat(15) + '0000');
      const r8 = await paie(M6, 'scan_token', s8.entete, {});
      ok(r8.status === 402 && /invalid_exact_evm_payload_signature/.test(JSON.parse(r8.corps).raison) && M6.F.verifies.length === 2,
         'une longue signature SANS le suffixe magique, sans code a from : toujours refusee ici, Coinbase jamais appele');
    }

    /* ---- ask_agent servi mais PAS encaisse : le registre des pertes est appele, chaque fois ----
       (contrat §D.6 : le plafond du jour est la seule vraie borne ; ces quatre branchements
       n etaient tenus par aucun essai — revue du 27 septembre 2026.) */
    {
      const appels = [];
      const agent = { dureeMaxS: 150, enVolMax: 3, bloque: () => false, nonRegle: (from, usd, raison) => appels.push([from, usd, raison]) };
      const T = { task: 'x' };
      const sertA = async () => ({ ok: true, outil: 'ask_agent', resultat: { answer: 'a' }, texte: 'a', _coutUsd: 0.3 });
      const Mn = await mondeBase({ prix: (o) => ({ ask_agent: 0.54, scan_token: 0.01 })[o] || null, agent });
      const w = ethers.Wallet.createRandom();
      const unSeul = (m, raison, av, r) => ok(r.status === 402 && !JSON.parse(r.corps).resultat && appels.length === av + 1 && appels[av][0] === w.address && appels[av][1] === 0.3 && appels[av][2] === raison,
        m + ' : 402, resultat retenu, nonRegle(payeur, 0,3 $, « ' + raison + ' ») UNE fois ' + JSON.stringify(appels.slice(av)));
      /* (a) Base, echec definitif du reglement. */
      let av = appels.length;
      Mn.F.regleReps.push({ etat: 'echec', erreur: 'invalid_payload', statut: 400 });
      const sa = await signeBase(w, await entete402(Mn, 'ask_agent', T), { s: Mn.s(), validBefore: Mn.s() + 250 });
      unSeul('(a) Base, 400 invalid_payload au reglement', 'invalid_payload', av, await paie(Mn, 'ask_agent', sa.entete, T, sertA));
      /* (b) Base, en attente, puis le payeur annule : la reprise avec la meme signature. */
      av = appels.length;
      Mn.F.regleReps.push({ etat: 'attente', hash: HASH(31), erreur: 'settlement_pending' });
      const sb = await signeBase(w, await entete402(Mn, 'ask_agent', T), { s: Mn.s(), validBefore: Mn.s() + 250 });
      const rb1 = await paie(Mn, 'ask_agent', sb.entete, T, sertA);
      ok(rb1.status === 402 && appels.length === av, '(b) en attente : PAS encore au registre (l issue est inconnue)');
      Mn.R.annule(w.address, sb.auth.nonce);
      unSeul('(b) puis AuthorizationCanceled, la meme signature representee', 'authorization canceled', av, await paie(Mn, 'ask_agent', sb.entete, T, sertA));
      /* (c) Base, en attente, jamais resolu : oublie apres 10 min, et compte. */
      av = appels.length;
      Mn.F.regleReps.push({ etat: 'attente', hash: HASH(32), erreur: 'settlement_pending' });
      const sc = await signeBase(w, await entete402(Mn, 'ask_agent', T), { s: Mn.s(), validBefore: Mn.s() + 250 });
      await paie(Mn, 'ask_agent', sc.entete, T, sertA);
      ok(appels.length === av, '(c) en attente : pas encore au registre');
      Mn.avance(600001);
      const rx = await paie(Mn, 'scan_token', X.b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453' }, payload: {} }), {});
      ok(rx.status === 402 && appels.length === av + 1 && appels[av][0] === w.address && appels[av][1] === 0.3 && appels[av][2] === 'pending expired',
         '(c) 10 min plus tard, a la verification Base suivante (quelle qu elle soit) : l attente expiree va au registre ' + JSON.stringify(appels.slice(av)));
      /* (d) Robinhood (USDG), le reglement sur la chaine rejette. */
      av = appels.length;
      const regleAvant = Mn.chaine.regle;
      Mn.chaine.regle = async () => { throw new Error('RPC Robinhood coupe'); };
      const sd = await signe3009(w, await entete402(Mn, 'ask_agent', T), { s: Mn.s(), validBefore: Mn.s() + 250 });
      unSeul('(d) Robinhood USDG, chaine.regle rejette', 'settlement failed', av, await paie(Mn, 'ask_agent', sd.entete, T, sertA));
      /* Jamais pour un outil a prix fixe (rien n a ete depense chez un fournisseur). */
      av = appels.length;
      const sertS = async () => ({ ok: true, outil: 'scan_token', resultat: {}, texte: 'x', _coutUsd: 0.3 });
      Mn.F.regleReps.push({ etat: 'echec', erreur: 'invalid_payload', statut: 400 });
      const qs = await entete402(Mn, 'scan_token', {});
      const r1 = await paie(Mn, 'scan_token', (await signeBase(w, qs, { s: Mn.s() })).entete, {}, sertS);
      const r2 = await paie(Mn, 'scan_token', (await signe3009(w, qs, { s: Mn.s() })).entete, {}, sertS);
      Mn.F.regleReps.push({ etat: 'attente', hash: HASH(33), erreur: 'settlement_pending' });
      const s3 = await signeBase(w, qs, { s: Mn.s() });
      await paie(Mn, 'scan_token', s3.entete, {}, sertS);
      Mn.R.annule(w.address, s3.auth.nonce);
      const r3 = await paie(Mn, 'scan_token', s3.entete, {}, sertS);
      ok(r1.status === 402 && r2.status === 402 && r3.status === 402 && appels.length === av, 'scan_token (Base en echec, Robinhood en echec, Base annulee) : nonRegle JAMAIS appele');
      Mn.chaine.regle = regleAvant;
    }

    /* ---- la preuve sur la chaine, en NEGATIF (revue du 27 septembre 2026) ----
       Un AuthorizationUsed(from, nonce) ne vaut pas paiement : l USDC partage UN espace de
       nonces entre transferWithAuthorization et receiveWithAuthorization (circlefin
       contracts/v2/EIP3009.sol:48, :205, :335-336) — pendant l attente, le payeur peut
       consommer le meme nonce vers lui-meme. Il faut le Transfer(from -> payTo, montant) ET status 1. */
    {
      const AUTRE = ethers.Wallet.createRandom().address;
      const logAuth = (h, from, nonce) => ({ address: X.USDC_BASE, topics: [X.TOPIC_AUTH_USED, pad32(from), nonce], data: '0x', transactionHash: h });
      const logTr = (h, from, to, montant) => ({ address: X.USDC_BASE, topics: [X.TOPIC_TRANSFER, pad32(from), pad32(to)], data: ethers.utils.hexZeroPad(ethers.BigNumber.from(montant).toHexString(), 32), transactionHash: h });
      const recu = (R, h, status, logs) => { R.recus[h] = { status, transactionHash: h, logs }; R.logs.push(...logs); };
      const cas = [
        ['recu status 1 de la transaction de Coinbase : AuthorizationUsed(from, nonce), mais le Transfer va a UNE AUTRE adresse',
          (R, w, nonce) => recu(R, HASH(61), '0x1', [logAuth(HASH(61), w.address, nonce), logTr(HASH(61), w.address, AUTRE, '20000')])],
        ['recu status 1 : AuthorizationUsed(from, nonce), Transfer a la tresorerie du MAUVAIS montant (19999)',
          (R, w, nonce) => recu(R, HASH(61), '0x1', [logAuth(HASH(61), w.address, nonce), logTr(HASH(61), w.address, TRESOR, '19999')])],
        ['le payeur consomme le nonce par receiveWithAuthorization (autre transaction, Transfer vers lui-meme)',
          (R, w, nonce) => recu(R, HASH(62), '0x1', [logAuth(HASH(62), w.address, nonce), logTr(HASH(62), w.address, w.address, '20000')])],
        ['recu status 0x0 (revert) de la transaction de Coinbase',
          (R) => recu(R, HASH(61), '0x0', [])],
      ];
      for (const [m, pose] of cas) {
        const Mk = await mondeBase();
        const w = ethers.Wallet.createRandom();
        const q = await entete402(Mk, 'scan_token', {});
        const sk = await signeBase(w, q, { s: Mk.s() });
        Mk.F.regleReps.push({ etat: 'attente', hash: HASH(61), erreur: 'settlement_pending' });
        const ck = {};
        const r1 = await paie(Mk, 'scan_token', sk.entete, {}, sert(ck));
        ok(r1.status === 402 && de64(r1.entetes['payment-response']).errorReason === 'settlement_pending', '(en attente : ' + m.slice(0, 40) + '...)');
        pose(Mk.R, w, sk.auth.nonce);
        const r = await paie(Mk, 'scan_token', sk.entete, {});
        const b = JSON.parse(r.corps);
        ok(r.status === 402 && !b.resultat && !b.x402 && !r.entetes['payment-response'] && r.entetes['payment-required'] && b.accepts && b.accepts.length === 3
           && Mk.x.MESURE.payes === 0 && Mk.F.regles.length === 1 && ck.n === 1,
           m + ' : le resultat n est JAMAIS rendu ; echec definitif, 402 avec une NOUVELLE demande de paiement, MESURE.payes inchange');
      }
    }
    /* ---- PayAI, second facilitateur de Base (27/09/2026) ----
       Leur catalogue (6 968 services) ne liste que ce qui passe par leur facilitateur
       avec l'extension bazaar. Une part des paiements y passe ; chacun est verifie ET
       regle au meme endroit ; PayAI muet ou a court de credits : pause, Coinbase reprend. */
    {
      const S = Object.assign(fauxFac(), { nom: 'payai' });
      const Mq = await mondeBase({ S, part: 1 });
      ok(Mq.x.MESURE.base.second.etat === 'on' && Mq.x.MESURE.base.second.nom === 'payai', 'PayAI liste eip155:8453 dans /supported : allume');
      const w = ethers.Wallet.createRandom();
      const paye = async () => { const q = await entete402(Mq, 'scan_token', {}); const sg = await signeBase(w, q, { s: Mq.s() }); return paie(Mq, 'scan_token', sg.entete, {}); };
      const r1 = await paye();
      ok(r1.status === 200 && S.verifies.length === 1 && S.regles.length === 1 && Mq.F.verifies.length === 0 && Mq.F.regles.length === 0,
         'part 1 : verifie ET regle chez PayAI, Coinbase ne voit rien');
      ok(S.verifies[0].p.extensions.bazaar && S.verifies[0].p.resource.url === 'https://api/agentic/call/scan_token' && S.verifies[0].e.payTo === TRESOR,
         'avec NOTRE bloc bazaar, notre ressource et la tresorerie : c est ce qui nous inscrit dans son catalogue');
      ok(Mq.x.MESURE.base.parFacilitateur.payai.payes === 1 && Mq.x.MESURE.base.parFacilitateur.payai.valides === 1, 'compte par facilitateur (payai : 1 valide, 1 paye)');
      S.verifyRep = { etat: 'carte' };
      const r2 = await paye();
      ok(r2.status === 200 && S.verifies.length === 2 && S.regles.length === 1 && Mq.F.verifies.length === 1 && Mq.F.regles.length === 1,
         'credits PayAI epuises (402) : le MEME paiement est verifie puis regle chez Coinbase');
      ok(Mq.x.MESURE.base.second.etat === 'suspendu' && /credits exhausted/.test(Mq.x.MESURE.base.second.raison) && Mq.x.MESURE.base.parFacilitateur.payai.replis === 1 && Mq.x.baseActif(),
         'PayAI en pause (Base reste allumee), le repli est compte');
      const r3 = await paye();
      ok(r3.status === 200 && S.verifies.length === 2 && Mq.F.regles.length === 2, 'pendant la pause, les paiements vont directement a Coinbase');
      const S2 = Object.assign(fauxFac(), { nom: 'payai' });
      S2.regleReps.push({ etat: 'echec', erreur: 'payment_method_required', pause: 'carte' });
      const Mr = await mondeBase({ S: S2, part: 1 });
      const q4 = await entete402(Mr, 'scan_token', {}); const s4 = await signeBase(w, q4, { s: Mr.s() });
      const r4 = await paie(Mr, 'scan_token', s4.entete, {});
      ok(r4.status === 402 && S2.regles.length === 1 && Mr.F.regles.length === 0 && Mr.x.MESURE.base.second.etat === 'suspendu' && Mr.x.baseActif(),
         'un refus au REGLEMENT chez PayAI : jamais regle ailleurs (pas deux fois), PayAI en pause, Base reste allumee');
      const S3 = Object.assign(fauxFac(), { nom: 'payai' });
      const M0p = await mondeBase({ S: S3, part: 0 });
      const q5 = await entete402(M0p, 'scan_token', {}); const s5 = await signeBase(w, q5, { s: M0p.s() });
      ok((await paie(M0p, 'scan_token', s5.entete, {})).status === 200 && S3.verifies.length === 0 && M0p.F.regles.length === 1, 'part 0 : tout reste chez Coinbase');
      /* Le proprietaire va TOUJOURS chez PayAI, meme a part 0 : c est son premier
         reglement qui inscrit un outil au catalogue. Les autres gardent la part. */
      const S5 = Object.assign(fauxFac(), { nom: 'payai' });
      const proprio = ethers.Wallet.createRandom();
      const Mo = await mondeBase({ S: S5, part: 0, versSecond: (adr) => String(adr).toLowerCase() === proprio.address.toLowerCase() });
      const q7 = await entete402(Mo, 'scan_token', {}); const s7 = await signeBase(proprio, q7, { s: Mo.s() });
      const r7 = await paie(Mo, 'scan_token', s7.entete, {});
      ok(r7.status === 200 && S5.verifies.length === 1 && S5.regles.length === 1 && Mo.F.verifies.length === 0 && S5.verifies[0].p.extensions.bazaar,
         'part 0, payeur proprietaire : verifie ET regle chez PayAI, avec le bloc bazaar');
      const q8 = await entete402(Mo, 'scan_token', {}); const s8 = await signeBase(w, q8, { s: Mo.s() });
      ok((await paie(Mo, 'scan_token', s8.entete, {})).status === 200 && S5.verifies.length === 1 && Mo.F.regles.length === 1,
         'part 0, un autre payeur : Coinbase, comme avant');
      /* Le portefeuille d'inscription au Bazaar : maison lui aussi, mais TOUJOURS chez Coinbase
         (le Bazaar n'inscrit qu'au reglement par Coinbase), meme a part 1. */
      const S6 = Object.assign(fauxFac(), { nom: 'payai' });
      const bazaar = ethers.Wallet.createRandom();
      const Mb = await mondeBase({ S: S6, part: 1, versSecond: () => true, versCdp: (adr) => String(adr).toLowerCase() === bazaar.address.toLowerCase() });
      const qb = await entete402(Mb, 'scan_token', {}); const sb = await signeBase(bazaar, qb, { s: Mb.s() });
      ok((await paie(Mb, 'scan_token', sb.entete, {})).status === 200 && S6.verifies.length === 0 && Mb.F.regles.length === 1 && Mb.F.verifies[0].p.extensions.bazaar,
         'le portefeuille du Bazaar (X402_AUTO_CLE_BASE) : regle chez Coinbase, avec le bloc bazaar, meme maison et part 1');
      const qb2 = await entete402(Mb, 'scan_token', {}); const sb2 = await signeBase(proprio, qb2, { s: Mb.s() });
      ok((await paie(Mb, 'scan_token', sb2.entete, {})).status === 200 && S6.regles.length === 1, 'la maison ordinaire : PayAI, comme avant');
      S5.verifyRep = { etat: 'carte' };
      const q9 = await entete402(Mo, 'scan_token', {}); const s9 = await signeBase(proprio, q9, { s: Mo.s() });
      ok((await paie(Mo, 'scan_token', s9.entete, {})).status === 200 && Mo.F.regles.length === 2 && Mo.x.MESURE.base.second.etat === 'suspendu',
         'PayAI a court de credits : le proprietaire est servi par Coinbase, PayAI en pause');
      const S4 = Object.assign(fauxFac(), { nom: 'payai', sup: { ok: true, kinds: [{ x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }] } });
      const Ms = await mondeBase({ S: S4, part: 1 });
      const q6 = await entete402(Ms, 'scan_token', {}); const s6 = await signeBase(w, q6, { s: Ms.s() });
      ok(Ms.x.MESURE.base.second.etat === 'off' && (await paie(Ms, 'scan_token', s6.entete, {})).status === 200 && S4.verifies.length === 0,
         'PayAI qui ne liste pas Base : eteint, Coinbase regle tout');
      /* le client sans cle : aucun en-tete Authorization */
      let entetes = null;
      const FP = require('./facilitateur_cdp').cree({ sansCle: true, nom: 'payai', url: 'https://facilitator.payai.network', fetch: async (u, o) => { entetes = { u, h: o.headers }; return { status: 200, text: async () => '{"kinds":[]}', headers: new Map() }; } });
      await FP.supported();
      ok(entetes.u === 'https://facilitator.payai.network/supported' && !('Authorization' in entetes.h) && FP.nom === 'payai', 'le client PayAI : https://facilitator.payai.network/supported, SANS en-tete Authorization');
    }
    /* ---- Solana, par PayAI (27/09/2026, etape 2) ---- */
    {
      const PAYTO_SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
      const FEE = 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd';
      const SIG = (i) => '5' + String(i).padStart(3, '1') + 'A'.repeat(84);
      const fauxSol = (o) => {
        const S = Object.assign(fauxFac(), { nom: 'payai' });
        S.sup = { ok: true, kinds: [{ x402Version: 2, scheme: 'exact', network: X.RESEAU_SOLANA, extra: o && o.sansFee ? {} : { feePayer: FEE } }] };
        S.verifyRep = { etat: 'valide', payer: 'PaYeR1111111111111111111111111111111111111' };
        S.regle = async (p, e) => { S.regles.push({ p: JSON.parse(JSON.stringify(p)), e: JSON.parse(JSON.stringify(e)) }); return Object.assign({ ms: 5 }, S.regleReps.length ? S.regleReps.shift() : { etat: 'paye', hash: SIG(S.regles.length) }); };
        return S;
      };
      const rpc = (statut) => { const R = { appels: 0 }; R.f = async (m, params) => { R.appels++; return { value: [statut === 'rien' ? null : statut === 'err' ? { err: { InstructionError: [2, 'x'] } } : { confirmationStatus: statut }] }; }; return R; };
      const monde = async (o) => {
        const S = o.S || fauxSol(o), R = o.R === undefined ? rpc('confirmed') : o.R;
        const M = await mondeBase({ sol: { reseau: X.RESEAU_SOLANA, usdc: X.USDC_SOLANA, payTo: PAYTO_SOL, facilitateur: S, rpc: R ? R.f : null, attenteMs: 30, cadenceMs: 5 } });
        return Object.assign(M, { S, R });
      };
      const signeSol = (req, tx) => { const acc = req.accepts.find((a) => a.network === X.RESEAU_SOLANA);
        return { acc, entete: X.b64({ x402Version: 2, resource: req.resource, accepted: acc, payload: { transaction: tx || Buffer.from('tx-' + Math.random()).toString('base64') }, extensions: req.extensions }) }; };
      const Ms = await monde({});
      ok(Ms.x.solanaActif() && Ms.x.MESURE.solana.feePayer === FEE, 'Solana allume : PayAI liste solana:5eykt… et donne son feePayer');
      /* Le blockhash pour un payeur sans noeud (le RPC public refuse les pages web, 27/09) */
      {
        let appels = 0, rep = { value: { blockhash: '9zJ3sY2qvAoMYrgkXYWkrvBWTTjvP6T9BGFsMwAGrFg6', lastValidBlockHeight: 300 } };
        const R = { f: async (m) => { if (m === 'getLatestBlockhash') { appels++; if (rep === 'panne') throw new Error('x'); return rep; } return { value: [{ confirmationStatus: 'confirmed' }] }; } };
        const Mb = await monde({ R });
        const [b1, b2] = await Promise.all([Mb.x.blockhashSolana(), Mb.x.blockhashSolana()]);
        ok(b1.ok && b1.blockhash === rep.value.blockhash && b1.lastValidBlockHeight === 300 && b2.blockhash === b1.blockhash && appels === 1,
           'blockhash : rendu depuis NOTRE noeud, deux demandes simultanees = un seul appel');
        Mb.avance(4000); await Mb.x.blockhashSolana();
        ok(appels === 1, 'moins de 5 s apres : le meme, sans rappeler le noeud');
        Mb.avance(2000); rep = { value: { blockhash: 'EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k', lastValidBlockHeight: 400 } };
        ok((await Mb.x.blockhashSolana()).blockhash === 'EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k' && appels === 2, 'apres 5 s : un blockhash frais');
        Mb.avance(6000); rep = 'panne';
        const bp = await Mb.x.blockhashSolana();
        Mb.avance(100); rep = { value: { blockhash: 'EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k', lastValidBlockHeight: 401 } };
        ok(!bp.ok && bp.code === 502 && (await Mb.x.blockhashSolana()).ok, 'noeud muet : 502, et l echec n est pas garde en cache');
        const Mn = await monde({ R: null });
        ok((await Mn.x.blockhashSolana()).code === 503, 'sans SOLANA_RPC_URL : 503, rien a rendre');
      }
      /* Le compte USDC de payTo (mesure du 27/09 : celui du proprietaire n existait pas) */
      {
        const ATA = require('./solana_ata').ata(PAYTO_SOL, X.USDC_SOLANA);
        const vus = [];
        let existe = false;
        const R = { f: async (m, params) => { vus.push([m, params[0]]); if (m === 'getAccountInfo') return { value: existe ? { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } : null }; return { value: [{ confirmationStatus: 'confirmed' }] }; } };
        const Mc = await monde({ R });
        const qc = await entete402(Mc, 'scan_token', {});
        ok(!Mc.x.solanaActif() && !qc.accepts.some((a) => a.network === X.RESEAU_SOLANA) && vus.some((v) => v[0] === 'getAccountInfo' && v[1] === ATA),
           'payTo sans compte USDC (getAccountInfo ' + ATA.slice(0, 6) + '… : rien) : Solana eteint, absent du 402');
        ok(/no USDC account on Solana yet/.test(Mc.x.MESURE.solana.raison) && Mc.x.MESURE.solana.compteExiste === false && Mc.x.MESURE.solana.compteUsdc === ATA,
           'la raison le dit, avec l adresse du compte a creer');
        existe = true;
        await Mc.x.sondeBase();
        ok(Mc.x.solanaActif() && Mc.x.MESURE.solana.compteExiste === true && (await entete402(Mc, 'scan_token', {})).accepts.some((a) => a.network === X.RESEAU_SOLANA),
           'le compte cree : la sonde suivante rallume Solana');
        const n0 = vus.filter((v) => v[0] === 'getAccountInfo').length;
        await Mc.x.sondeBase();
        ok(vus.filter((v) => v[0] === 'getAccountInfo').length === n0, 'une fois vu, le compte n est plus relu');
        const Rm = { f: async (m) => { if (m === 'getAccountInfo') throw new Error('rpc muet'); return { value: [{ confirmationStatus: 'confirmed' }] }; } };
        const Mm = await monde({ R: Rm });
        ok(Mm.x.solanaActif() && Mm.x.MESURE.solana.compteExiste === null, 'un noeud muet ne ferme pas Solana (compte : pas su)');
      }
      const q = await entete402(Ms, 'scan_token', {});
      const so = q.accepts.find((a) => a.network === X.RESEAU_SOLANA), iSo = q.accepts.indexOf(so);
      const p0 = await Ms.x.prix('scan_token', {});
      ok(so && iSo === 1 && so.asset === X.USDC_SOLANA && so.payTo === PAYTO_SOL && so.extra.feePayer === FEE && so.amount === p0.montantSolana && Number(so.amount) >= 20000,
         'le 402 : Solana juste apres Base, USDC, notre adresse, le feePayer de PayAI, ' + so.amount + ' (prix + 0,002 $, minimum 0,02 $)');
      ok(/in USDC on Base or Solana/.test(q.resource.description), 'la description le dit : « in USDC on Base or Solana »');
      /* Le plancher de token_verdict (27/09) : 0,01 $ sur Base et Solana (le facilitateur paie le gaz),
         0,02 $ sur Robinhood Chain ; les autres outils gardent 0,02 $ partout. */
      const pv = await Ms.x.prix('token_verdict', {}), ps = await Ms.x.prix('scan_token', {});
      ok(pv.montantBase === '10000' && pv.montantSolana === '10000' && pv.usd >= 0.02 && ps.montantBase === '20000' && ps.montantSolana === '20000',
         'token_verdict : 0,01 $ sur Base et Solana, ' + pv.usd + ' $ sur Robinhood Chain (gaz) ; scan_token reste a 0,02 $');
      /* chat_completion (27/09) : le prix suit CETTE demande (modele, entree, max_tokens), plancher 0,005 $. */
      const petit = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 }, gros = { model: 'opus-5-5', messages: [{ role: 'user', content: 'x'.repeat(8000) }], max_tokens: 4000 };
      const [cp, cg] = [await Ms.x.prix('chat_completion', petit), await Ms.x.prix('chat_completion', gros)];
      const attenduG = String(Math.ceil(Math.round((require('./chat_x402').prixUsd(gros) + 0.001) * 1e9) / 1e3));
      ok(cp.montantBase === '5000' && cg.montantBase === attenduG && Number(cg.montantBase) > 100000 && Number(cg.montantSolana) === Number(attenduG) + 1000,
         'chat_completion : une ligne a Haiku = le plancher (0,005 $) ; Opus, 8 000 caracteres, 4 000 jetons = ' + Number(cg.montantBase) / 1e6 + ' $ sur Base (devis + 0,001), +0,001 sur Solana');
      const pr = await Promise.all(['robinhood_rpc', 'robinhood_token', 'robinhood_wallet', 'robinhood_tx'].map((o) => Ms.x.prix(o, {})));
      ok(pr.every((x) => x.montantBase === '5000' && x.montantSolana === '5000' && x.usd >= 0.02), 'les 4 lectures Robinhood (baisse du 28/09) : 0,005 $ sur Base et Solana (le plancher, au-dessus du reglement le plus cher), 0,02 $ et plus sur Robinhood Chain (gaz)');
      const qa = await entete402(Ms, 'ask_agent', { task: 'x' });
      ok(!qa.accepts.some((a) => a.network === X.RESEAU_SOLANA), 'ask_agent : pas de Solana (sa transaction expirerait avant la fin du travail)');
      const s1 = signeSol(q);
      const r1 = await paie(Ms, 'scan_token', s1.entete, {});
      const pr1 = de64(r1.entetes['payment-response']);
      ok(r1.status === 200 && pr1.network === X.RESEAU_SOLANA && pr1.transaction === SIG(1) && pr1.payer === 'PaYeR1111111111111111111111111111111111111' && Ms.S.verifies.length === 1 && Ms.S.regles.length === 1,
         'un paiement Solana : verifie puis regle par PayAI, 200, PAYMENT-RESPONSE solana avec la signature');
      const v1 = Ms.S.verifies[0];
      ok(v1.e.payTo === PAYTO_SOL && v1.e.extra.feePayer === FEE && v1.p.extensions.bazaar && v1.p.resource.url === 'https://api/agentic/call/scan_token' && v1.p.payload.transaction === JSON.parse(Buffer.from(s1.entete, 'base64')).payload.transaction,
         'PayAI recoit NOS conditions (payTo, feePayer), notre ressource, notre bloc bazaar, et la transaction du payeur telle quelle');
      ok(Ms.R.appels >= 1 && Ms.x.MESURE.solana.confirmes === 1 && Ms.x.MESURE.parReseau[X.RESEAU_SOLANA].payes === 1, 'le reglement est relu sur la chaine (confirmed) avant de livrer');
      const rj = await paie(Ms, 'scan_token', s1.entete, {});
      ok(rj.status === 402 && Ms.S.regles.length === 1 && /already presented|no current quote/.test(JSON.parse(rj.corps).detail || JSON.parse(rj.corps).raison), 'la MEME transaction representee : refusee, jamais reglee deux fois');
      const faux = JSON.parse(Buffer.from(signeSol(await entete402(Ms, 'scan_token', {})).entete, 'base64'));
      faux.accepted.payTo = 'AutreAdresse1111111111111111111111111111111';
      ok(JSON.parse((await paie(Ms, 'scan_token', X.b64(faux), {})).corps).raison === 'invalid_payment_requirements', 'une autre adresse de reception : refusee avant PayAI');
      ok(JSON.parse((await paie(Ms, 'scan_token', signeSol(await entete402(Ms, 'scan_token', {}), 'pas du base64 !').entete, {})).corps).raison === 'invalid_payload', 'une transaction qui n est pas du base64 : refusee');
      Ms.S.regleReps.push({ etat: 'echec', erreur: 'transaction_simulation_failed' });
      const rE = await paie(Ms, 'scan_token', signeSol(await entete402(Ms, 'scan_token', {})).entete, {});
      ok(rE.status === 402 && !JSON.parse(rE.corps).resultat && de64(rE.entetes['payment-response']).success === false && rE.entetes['payment-required'], 'reglement refuse : le resultat est retenu, un nouveau 402');
      const Me = await monde({ R: rpc('err') });
      const rr = await paie(Me, 'scan_token', signeSol(await entete402(Me, 'scan_token', {})).entete, {});
      ok(rr.status === 402 && !JSON.parse(rr.corps).resultat, 'PayAI dit paye mais la chaine dit echec : rien n est livre');
      const Mn = await monde({ R: null });
      const rn = await paie(Mn, 'scan_token', signeSol(await entete402(Mn, 'scan_token', {})).entete, {});
      ok(rn.status === 200 && Mn.x.MESURE.solana.nonConfirmes === 1, 'sans noeud Solana : on croit PayAI, et on le compte (nonConfirmes)');
      const Mp = await monde({ R: rpc('rien') });
      Mp.S.regleReps.push({ etat: 'inconnu', erreur: 'unexpected_settle_error' });
      const rp = await paie(Mp, 'scan_token', signeSol(await entete402(Mp, 'scan_token', {})).entete, {});
      ok(rp.status === 402 && !JSON.parse(rp.corps).resultat, 'issue inconnue sans signature : rien de livre (la transaction expire d elle-meme)');
      const Mc = await monde({});
      Mc.S.verifyRep = { etat: 'carte' };
      const rc = await paie(Mc, 'scan_token', signeSol(await entete402(Mc, 'scan_token', {})).entete, {});
      ok(rc.status === 402 && !Mc.x.solanaActif() && /credits exhausted/.test(Mc.x.MESURE.solana.raison) && !(await entete402(Mc, 'scan_token', {})).accepts.some((a) => a.network === X.RESEAU_SOLANA),
         'credits PayAI epuises : Solana se met en pause et disparait du 402');
      const Mf = await monde({ sansFee: true });
      ok(!Mf.x.solanaActif() && /no feePayer/.test(Mf.x.MESURE.solana.raison), 'sans feePayer dans /supported : Solana reste eteint');
    }
    delete process.env.X402_AGENT; delete process.env.TG_APPELS_VENTE;
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
