'use strict';
/*
 * UNE RECHARGE DU CREDIT PAYEE EN USDC SOLANA, DONT LE REGLEMENT RESTE « EN ATTENTE »
 *
 * ---- LE DEFAUT (revue du Studio, 13/10/2026) ----
 *
 * « Le credit d une recharge Solana en attente n est jamais ajoute cote serveur ;
 * seul Base passe par enAttente/reconcilie. » Rejoue ici sur le code d avant :
 * PayAI rend une signature, notre noeud ne la voit pas encore confirmee dans les
 * 30 s, la page recoit « payment pending - retry the same request with the same
 * PAYMENT-SIGNATURE » ; elle represente la meme transaction, et x402 la refuse
 * (« this nonce was already presented ») : l USDC est parti, le credit ne vient
 * jamais.
 *
 * ---- CE QUE L ESSAI TIENT ----
 *   1. en attente : rien de credite, et la reprise de la MEME transaction ne la
 *      fait ni reverifier ni regler une seconde fois ;
 *   2. confirmee plus tard sur la chaine : creditee UNE fois, a la session qui a
 *      demande la recharge ;
 *   3. rejouee ensuite : jamais une seconde fois ;
 *   4. la transaction est relue sur la chaine (getTransaction) : bon destinataire
 *      (le compte USDC de payTo), bon montant, bon payeur (celui que PayAI a
 *      verifie), sans erreur — sinon rien n est credite ;
 *   5. une autre session qui represente la transaction n y gagne rien et ne la
 *      consomme pas : la session d origine est creditee ;
 *   6. une attente de plus de 10 min est oubliee, comme sur Base.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('./x402');
const C = require('./credits');
const ATA = require('./solana_ata');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const de64 = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));

const PAYTO_SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const FEE = 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd';
const PAYEUR = 'PaYeR1111111111111111111111111111111111111';
const SIG = (i) => '5' + String(i).padStart(3, '1') + 'A'.repeat(84);
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const DEST = ATA.ata(PAYTO_SOL, X.USDC_SOLANA);

/* Le monde : un x402 avec Solana seul (PayAI simule), un noeud Solana simule, et le credit reel. */
function monde() {
  /* L horloge avance avec la vraie (la relecture de la chaine attend 30 ms en temps reel), plus ce
     que l essai lui ajoute. */
  const t0 = Date.now(); let t = t0;
  const maintenant = () => t + (Date.now() - t0);
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-sol-'));
  const S = { verifies: [], regles: [], regleReps: [], verifyRep: { etat: 'valide', payer: PAYEUR }, nom: 'payai' };
  S.supported = async () => ({ ok: true, kinds: [{ x402Version: 2, scheme: 'exact', network: X.RESEAU_SOLANA, extra: { feePayer: FEE } }] });
  S.verify = async (p, e) => { S.verifies.push({ p, e }); return Object.assign({ ms: 3 }, S.verifyRep); };
  /* La signature d une transaction Solana ne depend que de son message et des cles (ed25519 est
     deterministe) : la meme transaction reglee deux fois porte la meme signature. */
  const sigDe = new Map();
  S.regle = async (p, e) => {
    S.regles.push({ p, e });
    const tx = p.payload.transaction, rep = S.regleReps.length ? S.regleReps.shift() : { etat: 'paye', hash: sigDe.get(tx) || SIG(S.regles.length) };
    if (rep.hash) sigDe.set(tx, rep.hash);
    return Object.assign({ ms: 5 }, rep);
  };
  /* Le noeud : `statuts[sig]` (absent = pas encore vue) et `txs[sig]` (getTransaction jsonParsed). */
  const R = { statuts: {}, txs: {}, appels: [] };
  R.f = async (m, p) => {
    R.appels.push(m);
    if (m === 'getAccountInfo') return { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } };
    if (m === 'getSignatureStatuses') return { value: [R.statuts[p[0][0]] || null] };
    if (m === 'getTransaction') return R.txs[p[0]] || null;
    throw new Error('methode inattendue ' + m);
  };
  let credits = null;
  const x = X.cree({ asset: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', usdg: null, payTo: '0x' + '77'.repeat(20),
    chaine: { gazPrix: async () => 1, soldeGaz: async () => 1 }, cours: async () => 0.00002493, ethUsd: async () => 2688.57,
    prixOutilUsd: (o, a) => (o === 'credit' ? credits.prixUsd(a) : null), maintenant,
    solana: { reseau: X.RESEAU_SOLANA, usdc: X.USDC_SOLANA, payTo: PAYTO_SOL, facilitateur: S, rpc: R.f, attenteMs: 30, cadenceMs: 5 } });
  credits = C.cree({ dossier, x402: () => x, url: 'https://api/credit/topup', maintenant });
  return { x, S, R, credits, avance: (ms) => { t += ms; } };
}

/* Une transaction confirmee, telle que getTransaction jsonParsed la rend (TransferChecked de spl-token). */
function txChaine(o) {
  o = o || {};
  return {
    slot: 1, blockTime: 1, meta: { err: o.err || null, fee: 10001 },
    transaction: { signatures: [o.sig], message: { instructions: [
      { programId: 'ComputeBudget111111111111111111111111111111', data: 'x' },
      { program: 'spl-token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transferChecked', info: {
        source: 'SoUrCe1111111111111111111111111111111111111', mint: o.mint || X.USDC_SOLANA, destination: o.destination || DEST,
        authority: o.authority || PAYEUR, tokenAmount: { amount: String(o.montant), decimals: 6 } } } },
    ] } },
  };
}

const recharge = (M, usd, addr, entete) => M.credits.recharge({ entete, usd, addr, qui: 'ip', client: 'essai' });
/* Le client : lit le 402, signe (ici, une transaction opaque), renvoie l en-tete. */
async function signe(M, usd, addr) {
  const r = await recharge(M, usd, addr, null);
  const req = de64(r.entetes['payment-required']);
  const acc = req.accepts.find((a) => a.network === X.RESEAU_SOLANA);
  const tx = Buffer.from('tx-solana-' + Math.random()).toString('base64');
  return { status: r.status, acc, entete: X.b64({ x402Version: 2, resource: req.resource, accepted: acc, payload: { transaction: tx } }) };
}
const corps = (r) => { try { return JSON.parse(r.corps); } catch (e) { return {}; } };

(async () => {
  /* ---- 1 a 3 : en attente, puis confirmee, puis rejouee ---- */
  {
    const M = monde();
    await M.x.sondeBase();
    ok(M.x.solanaActif(), 'Solana allume (PayAI liste solana:5eykt… avec son feePayer, le compte USDC de payTo existe)');
    const s = await signe(M, 5, A);
    ok(s.status === 402 && s.acc && s.acc.payTo === PAYTO_SOL, 'le 402 de la recharge propose Solana (' + (s.acc && s.acc.amount) + ' unites, 5 $ + frais)');
    M.S.regleReps.push({ etat: 'attente', hash: SIG(1) });
    const r1 = await recharge(M, 5, A, s.entete);
    ok(r1.status === 402 && de64(r1.entetes['payment-response']).errorReason === 'settlement_pending' && M.credits.soldeUsd(A) === 0,
       'PayAI rend la signature, le noeud ne la voit pas confirmee : 402 « pending », rien de credite');
    const r2 = await recharge(M, 5, A, s.entete);
    ok(r2.status === 402 && de64(r2.entetes['payment-response'] || 'e30=').errorReason === 'settlement_pending' && M.credits.soldeUsd(A) === 0,
       'la meme transaction representee avant la chaine : encore « pending », rien de credite' + (r2.status !== 402 || !r2.entetes['payment-response'] ? ' [' + r2.status + ' ' + r2.corps + ']' : ''));
    ok(M.S.verifies.length === 1 && M.S.regles.length === 1, 'et ni reverifiee ni reglee une seconde fois (verify ' + M.S.verifies.length + ', settle ' + M.S.regles.length + ')');
    /* La chaine tranche : confirmee, le bon transfert. */
    M.R.statuts[SIG(1)] = { confirmationStatus: 'confirmed' };
    M.R.txs[SIG(1)] = txChaine({ sig: SIG(1), montant: s.acc.amount });
    M.avance(40000);
    const r3 = await recharge(M, 5, A, s.entete);
    const c3 = corps(r3);
    ok(r3.status === 200 && c3.creditedUsd === 5 && M.credits.soldeUsd(A) === 5,
       'confirmee plus tard : la reprise credite 5 $ a la session' + (r3.status !== 200 ? ' [' + r3.status + ' ' + r3.corps + ']' : ''));
    ok(M.R.appels.includes('getTransaction') && M.S.regles.length === 1, 'apres relecture de la transaction sur la chaine (getTransaction), sans nouveau reglement');
    const r4 = await recharge(M, 5, A, s.entete);
    ok(M.credits.soldeUsd(A) === 5 && !(r4.status === 200 && corps(r4).creditedUsd > 0), 'rejouee ensuite : jamais creditee une seconde fois (solde ' + M.credits.soldeUsd(A) + ' $)');
    M.avance(11 * 60 * 1000);
    await recharge(M, 5, A, s.entete);
    ok(M.credits.soldeUsd(A) === 5, 'ni apres l echeance des 10 minutes');
    const h = M.credits.historique(A, 5);
    ok(h.length === 1 && h[0].kind === 'top-up' && h[0].tx === SIG(1) && h[0].network === X.RESEAU_SOLANA, 'une seule ligne au journal : la recharge, avec sa signature Solana');
  }

  /* ---- 4 : la transaction relue ne correspond pas : rien n est credite ---- */
  for (const [quoi, o] of [['un autre destinataire', { destination: 'AuTrE1111111111111111111111111111111111111' }],
                           ['un autre montant', { montant: '1' }],
                           ['un autre payeur que celui verifie', { authority: 'AuTrEpAyEuR111111111111111111111111111111' }],
                           ['un autre jeton', { mint: 'So11111111111111111111111111111111111111112' }],
                           ['une transaction en erreur', { err: { InstructionError: [2, 'x'] } }]]) {
    const M = monde();
    await M.x.sondeBase();
    const s = await signe(M, 5, A);
    M.S.regleReps.push({ etat: 'attente', hash: SIG(7) });
    await recharge(M, 5, A, s.entete);
    M.R.statuts[SIG(7)] = { confirmationStatus: 'confirmed' };
    M.R.txs[SIG(7)] = txChaine(Object.assign({ sig: SIG(7), montant: s.acc.amount }, o));
    const r = await recharge(M, 5, A, s.entete);
    ok(r.status !== 200 && M.credits.soldeUsd(A) === 0, quoi + ' sur la chaine : rien de credite (' + r.status + ')');
  }

  /* ---- 5 : une autre session represente la transaction en attente ---- */
  {
    const M = monde();
    await M.x.sondeBase();
    const s = await signe(M, 5, A);
    M.S.regleReps.push({ etat: 'attente', hash: SIG(3) });
    await recharge(M, 5, A, s.entete);
    M.R.statuts[SIG(3)] = { confirmationStatus: 'confirmed' };
    M.R.txs[SIG(3)] = txChaine({ sig: SIG(3), montant: s.acc.amount });
    const rb = await recharge(M, 5, B, s.entete);
    ok(rb.status !== 200 && M.credits.soldeUsd(B) === 0 && M.credits.soldeUsd(A) === 0, 'une autre session represente la transaction : rien pour elle, rien consomme');
    const ra = await recharge(M, 5, A, s.entete);
    ok(ra.status === 200 && M.credits.soldeUsd(A) === 5 && M.credits.soldeUsd(B) === 0, 'la session d origine la represente ensuite : creditee, elle seule');
  }

  /* ---- Le chemin qui marchait deja : confirmee dans les 30 s ---- */
  {
    const M = monde();
    await M.x.sondeBase();
    const s = await signe(M, 2, A);
    M.R.statuts[SIG(1)] = { confirmationStatus: 'confirmed' };
    const r = await recharge(M, 2, A, s.entete);
    ok(r.status === 200 && M.credits.soldeUsd(A) === 2 && M.S.regles.length === 1, 'confirmee tout de suite : creditee au premier appel, comme avant');
  }

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
