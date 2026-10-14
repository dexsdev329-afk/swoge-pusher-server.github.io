'use strict';
/*
 * RECHARGER LE CREDIT EN SOL OU EN USDT (credit_depot.js, 14/10/2026)
 *
 * Tout est FAUX ici : un faux Relay (HTTP local) et un faux noeud Base (JSON-RPC local). Aucun
 * appel ne part vers Relay ni vers une chaine ; aucune cle reelle.
 *
 * ---- CE QUE L'ESSAI TIENT ----
 *   1. la commande : liste fermee, bornes a la cotation (2 $, 10 $ Ethereum, 50 $, plafond du
 *      solde avec les commandes en cours), corps envoye a Relay (strict, refundTo natif,
 *      destinataire = payTo, USDC Base, EXACT_INPUT), ecrite sur le disque AVANT la reponse ;
 *   2. un succes credite la session qui a cree la commande, UNE fois, du montant LU dans le recu
 *      (au-dessus ou au-dessous de la cotation) ; une relecture ne credite rien ;
 *   3. Relay dit « success » mais le recu manque (on attend), est en echec, porte un autre jeton
 *      ou un autre destinataire : rien n'est credite ;
 *   4. remboursement ou echec : rien, et un message ;
 *   5. un redemarrage au milieu : la commande relue sur le disque est creditee quand meme ;
 *   6. le vrai serveur : session seulement, une autre session ne voit rien (404), un id ou une
 *      adresse fournis par le client ne changent rien, la cle Relay ne sort jamais (reponses,
 *      journaux), Relay en panne → 503 sur les nouvelles commandes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const D = require('./credit_depot');
const Cr = require('./credits');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const CLE = 'relay-CLE-SECRETE-qui-ne-sort-jamais-77';
const PAYTO = '0x7777777777777777777777777777777777777777';
const AUTRE = '0x8888888888888888888888888888888888888888';
const USDC = D.USDC_BASE;
const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const TX = (i) => '0x' + String(i).padStart(64, 'c');

/* ---- LE FAUX RELAY ---- */
function fauxRelay() {
  const R = { cotations: [], lectures: [], cles: new Set(), requetes: {}, panne: false, seq: 0, prixSol: '160000000' };
  R.serveur = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      R.cles.add(req.headers['x-api-key']);
      const rep = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (R.panne) return rep(503, { message: 'down, your key ' + req.headers['x-api-key'] });
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/quote/v2' && req.method === 'POST') {
        const q = JSON.parse(b);
        R.cotations.push(q);
        const sol = q.originCurrency === '11111111111111111111111111111111';
        /* 1 SOL = 160 USDC ; un stable : 1 pour 1 moins 2 %. */
        const out = sol ? (BigInt(q.amount) * BigInt(R.prixSol) / 10n ** 9n) * 98n / 100n : BigInt(q.amount) * 98n / 100n;
        if (!q.useDepositAddress) return rep(200, { details: { currencyIn: { currency: { address: q.originCurrency }, amount: q.amount }, currencyOut: { currency: { address: USDC.toLowerCase(), chainId: 8453 }, amount: String(BigInt(q.amount) * BigInt(R.prixSol) / 10n ** 9n) } }, steps: [] });
        const dep = q.originChainId === 792703809 ? 'DepoSoL' + String(++R.seq).padStart(37, '1') : '0x' + String(++R.seq).padStart(40, 'd');
        const id = '0x' + String(R.seq).padStart(64, 'e');
        return rep(200, { requestId: id, steps: [{ id: 'deposit', requestId: id, depositAddress: R.adresseForcee || dep }],
          details: { recipient: q.recipient, currencyIn: { currency: { address: R.jetonForce || q.originCurrency }, amount: q.amount },
            currencyOut: { currency: { address: USDC.toLowerCase(), chainId: 8453 }, amount: String(out), minimumAmount: String(out * 97n / 100n) } } });
      }
      if (u.pathname === '/requests/v3') {
        const a = u.searchParams.get('depositAddress');
        R.lectures.push(a);
        return rep(200, { requests: R.requetes[a] || [] });
      }
      rep(404, { message: 'nope' });
    });
  });
  return new Promise((ok2) => R.serveur.listen(0, '127.0.0.1', () => { R.url = 'http://127.0.0.1:' + R.serveur.address().port; ok2(R); }));
}
/* Une demande « success » livree sur Base par `tx`. */
const succes = (dep, tx, extra) => Object.assign({ id: '0x1', status: 'success', recipient: PAYTO, depositAddress: { address: dep },
  data: { outTxs: [{ txHash: tx, chainId: 8453, status: 'success', stateChanges: [] }] } }, extra || {});

/* ---- LE FAUX NOEUD BASE ---- */
function fauxBase() {
  const N = { recus: {}, bloc: 1000, appels: 0 };
  N.recu = async (h) => { N.appels++; return N.recus[h] || null; };
  N.blocNum = async () => N.bloc;
  N.serveur = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const q = JSON.parse(b); N.appels++;
      const result = q.method === 'eth_getTransactionReceipt' ? (N.recus[q.params[0]] || null) : q.method === 'eth_blockNumber' ? '0x' + N.bloc.toString(16) : null;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
    });
  });
  return new Promise((ok2) => N.serveur.listen(0, '127.0.0.1', () => { N.url = 'http://127.0.0.1:' + N.serveur.address().port; ok2(N); }));
}
/* Un recu : `transferts` = [{ vers, micro, jeton? }] */
const recu = (transferts, o) => Object.assign({ status: '0x1', blockNumber: '0x' + (990).toString(16), logs: transferts.map((x, i) => ({
  address: x.jeton || USDC, topics: [T, pad('0x' + '99'.repeat(20)), pad(x.vers || PAYTO)], data: hex(x.micro), logIndex: '0x' + (i + 3).toString(16), removed: false })) }, o || {});

function monde(R, N, dossier, horloge) {
  dossier = dossier || fs.mkdtempSync(path.join(os.tmpdir(), 'depot-'));
  const maintenant = horloge ? () => horloge.t : Date.now;
  const credits = Cr.cree({ dossier, x402: () => null, url: 'u', maintenant });
  const d = D.cree({ dossier, credits, payTo: PAYTO, api: R.url, cle: CLE, rpc: { recu: N.recu, bloc: N.blocNum }, maintenant, log: () => {} });
  return { d, credits, dossier };
}

(async () => {
  const R = await fauxRelay(), N = await fauxBase();
  const H = { t: Date.UTC(2026, 9, 14, 12, 0) };

  console.log('-- 1. la commande --');
  {
    const M = monde(R, N, null, H);
    let r = await M.d.nouvelle(A, { origin: 'tron', amountUsd: 10 });
    ok(r.status === 400 && R.cotations.length === 0, 'une provenance hors liste (TRON) : 400, aucun appel a Relay');
    r = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 1.99 });
    ok(r.status === 400 && /\$2/.test(r.corps.raison), 'USDT Solana sous 2 $ : 400 (« ' + r.corps.raison + ' »)');
    r = await M.d.nouvelle(A, { origin: 'usdt_eth', amountUsd: 9 });
    ok(r.status === 400 && /\$10/.test(r.corps.raison), 'USDT Ethereum sous 10 $ : 400');
    r = await M.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 50.01 });
    ok(r.status === 400 && R.cotations.length === 0, 'plus de 50 $ : 400, aucune cotation');
    r = await M.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 10, depositAddress: '0xEVIL', recipient: AUTRE, requestId: '0xbad' });
    const q = R.cotations[R.cotations.length - 1];
    ok(r.status === 200 && r.corps.depositAddress && r.corps.send === '10' && r.corps.token === 'USDT' && r.corps.network === 'Base', 'USDT Base 10 $ : une adresse, « send 10 USDT on Base »');
    ok(q.strict === true && q.useDepositAddress === true && q.refundTo === '0x0000000000000000000000000000000000000000' && q.user === q.refundTo,
       'strict, refundTo = l adresse native (remboursement a l envoyeur), user = repere');
    ok(q.recipient === PAYTO && q.destinationChainId === 8453 && q.destinationCurrency === USDC && q.tradeType === 'EXACT_INPUT' && q.amount === '10000000' && q.originCurrency === USDT_BASE,
       'destinataire = payTo, USDC sur Base, EXACT_INPUT, 10 000 000 unites ; rien du corps du client');
    ok(r.corps.depositAddress !== '0xEVIL' && Math.abs(r.corps.estimateUsd - 9.8) < 1e-9, 'l adresse et l estimation viennent de Relay (9,80 $), pas du client');
    const disque = JSON.parse(fs.readFileSync(path.join(M.dossier, 'credit_depots.json'), 'utf8'));
    const c = disque.commandes[r.corps.id];
    ok(c && c.addr === A && c.depot === r.corps.depositAddress && c.coteMicro === 9800000 && c.statut === 'attente' && c.requestId,
       'la commande est sur le disque a la reponse (adresse, session, requestId, 9 800 000 micro cotes)');
    ok(!JSON.stringify(r.corps).includes(CLE) && !JSON.stringify(disque).includes(CLE), 'la cle n est ni dans la reponse ni sur le disque');
    /* SOL : 5 $ a 160 $ le SOL = 0,03125 SOL, arrondi au-dessus a 0,0001 → 0,0313 */
    r = await M.d.nouvelle(A, { origin: 'sol', amountUsd: 5 });
    const qs = R.cotations[R.cotations.length - 1];
    ok(r.status === 200 && r.corps.send === '0.0313' && qs.amount === '31300000' && qs.refundTo === '11111111111111111111111111111111' && qs.originChainId === 792703809,
       'SOL 5 $ : 0,0313 SOL (cours d une cotation sans depot, arrondi au-dessus), refundTo = 1111…1111');
    /* Le plafond du solde compte les commandes en cours : 100 $ - (9,80 + 4,9..) */
    await M.credits.ajoute(A, 80, { transaction: '0xdeja' });
    r = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 10 });
    ok(r.status === 400 && /above \$100/.test(r.corps.raison), 'solde 80 $ + 14,7 $ en cours + 10 $ > 100 $ : refuse a la cotation');
    r = await M.d.nouvelle(B, { origin: 'usdt_sol', amountUsd: 2 });
    ok(r.status === 200, 'une autre session a ses propres bornes');
    await M.d.nouvelle(B, { origin: 'usdt_sol', amountUsd: 2 }); await M.d.nouvelle(B, { origin: 'usdt_sol', amountUsd: 2 });
    r = await M.d.nouvelle(B, { origin: 'usdt_sol', amountUsd: 2 });
    ok(r.status === 429, 'une quatrieme commande ouverte pour la meme session : 429');
    ok(M.d.lit(A, r.corps.id) === null && M.d.liste(A).every((x) => x.id) && M.d.liste(B).length === 3, 'chaque session ne liste que les siennes');
    R.jetonForce = '0x' + 'ab'.repeat(20);
    r = await M.d.nouvelle('0x' + 'c3'.repeat(20), { origin: 'usdt_base', amountUsd: 3 });
    delete R.jetonForce;
    ok(r.status === 502, 'une cotation qui ne porte pas le jeton demande est refusee (502), rien d enregistre');
  }

  console.log('\n-- 2. succes : credite une fois, le montant lu --');
  {
    const M = monde(R, N, null, H);
    const r = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 10 });
    const dep = r.corps.depositAddress;
    H.t += 10000;
    await M.d.tour();
    ok(M.credits.soldeUsd(A) === 0 && M.d.lit(A, r.corps.id).status === 'waiting', 'rien encore chez Relay : en attente, rien credite');
    R.requetes[dep] = [succes(dep, TX(1))];
    N.recus[TX(1)] = recu([{ micro: 9961986 }]);
    H.t += 30000;
    await M.d.tour();
    ok(M.credits.soldeMicro(A) === 9961986, 'succes, recu lu : 9,961986 $ credites (le journal, pas la cotation de 9,80 $)');
    const v = M.d.lit(A, r.corps.id);
    ok(v.status === 'credited' && v.creditedUsd === 9.961986, 'la commande dit « credited », 9,961986 $');
    ok(M.credits.soldeUsd(B) === 0, 'l autre session n a rien');
    H.t += 30000;
    await M.d.tour();
    ok(M.credits.soldeMicro(A) === 9961986, 'une commande close n est plus relue ; rien de plus');
    ok(M.credits.ajoute(A, null, { cle: 'relay:' + TX(1) + ':3', micro: 9961986, transaction: TX(1) }) === null, 'rejouer la meme cle (relay:<tx>:<index>) ne credite rien');
    ok(M.credits.ajoute(A, 9.96, { transaction: TX(1), network: 'eip155:8453' }) === null && M.credits.soldeMicro(A) === 9961986, 'la meme transaction presentee par x402 ensuite ne credite rien non plus');
    const h = M.credits.historique(A, 5)[0];
    ok(h.kind === 'top-up' && h.tx === TX(1) && h.network === 'relay:usdt_sol' && h.usd === 9.961986, 'l historique dit top-up, la transaction Base et la provenance');
    /* au-dessous de la cotation */
    const r2 = await M.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 2 });
    R.requetes[r2.corps.depositAddress] = [succes(r2.corps.depositAddress, TX(2))];
    N.recus[TX(2)] = recu([{ micro: 1500000 }]);
    H.t += 30000;
    await M.d.tour(); await M.d.tour();
    ok(M.credits.soldeMicro(A) === 9961986 + 1500000, 'une arrivee AU-DESSOUS de la cotation (1,50 $ pour 1,96 $) : 1,50 $ credites, pas la cotation');
  }

  console.log('\n-- 3. Relay dit success, notre lecture non --');
  {
    const M = monde(R, N, null, H);
    const cas = [
      ['recu absent (Relay a vu le depot, notre noeud pas encore la livraison)', null, 'processing'],
      ['statut 0', recu([{ micro: 5000000 }], { status: '0x0' }), 'review'],
      ['autre jeton', recu([{ micro: 5000000, jeton: USDT_BASE }]), 'review'],
      ['autre destinataire', recu([{ micro: 5000000, vers: AUTRE }]), 'review'],
    ];
    let i = 10;
    for (const [nom, rc, attendu] of cas) {
      const who = '0x' + String(i).padStart(40, '4');
      const r = await M.d.nouvelle(who, { origin: 'usdt_base', amountUsd: 5 });
      R.requetes[r.corps.depositAddress] = [succes(r.corps.depositAddress, TX(i))];
      if (rc) N.recus[TX(i)] = rc;
      H.t += 30000;
      await M.d.tour();
      const v = M.d.lit(who, r.corps.id);
      ok(M.credits.soldeUsd(who) === 0 && v.status === attendu, nom + ' : rien credite, « ' + v.status + ' »' + (v.message ? ' (' + v.message.slice(0, 60) + '…)' : ''));
      i++;
    }
    /* Trop frais : 1 confirmation seulement */
    const r = await M.d.nouvelle('0x' + '5'.repeat(40), { origin: 'usdt_base', amountUsd: 5 });
    R.requetes[r.corps.depositAddress] = [succes(r.corps.depositAddress, TX(30))];
    N.recus[TX(30)] = recu([{ micro: 4900000 }], { blockNumber: '0x' + (1000).toString(16) });
    H.t += 30000; await M.d.tour();
    ok(M.credits.soldeUsd('0x' + '5'.repeat(40)) === 0, 'un recu dans le dernier bloc (1 confirmation sur ' + D.CONFIRMATIONS + ') : on attend');
    N.bloc = 1001; H.t += 30000; await M.d.tour();
    ok(M.credits.soldeMicro('0x' + '5'.repeat(40)) === 4900000, 'un bloc plus tard : credite');
    N.bloc = 1000;
    /* Une transaction deja creditee par x402 (meme hash) ne l est pas une seconde fois. */
    const w = '0x' + '6'.repeat(40);
    await M.credits.ajoute(w, 1, { transaction: TX(31) });
    const r3 = await M.d.nouvelle(w, { origin: 'usdt_base', amountUsd: 5 });
    R.requetes[r3.corps.depositAddress] = [succes(r3.corps.depositAddress, TX(31))];
    N.recus[TX(31)] = recu([{ micro: 4900000 }]);
    H.t += 30000; await M.d.tour();
    ok(M.credits.soldeMicro(w) === 1000000, 'une transaction deja creditee par x402 ne credite rien par Relay');
    /* Deux transferts vers payTo dans un recu : l indice de Relay departage, sinon rien. */
    const x = '0x' + '7'.repeat(39) + '1';
    const r4 = await M.d.nouvelle(x, { origin: 'usdt_base', amountUsd: 5 });
    R.requetes[r4.corps.depositAddress] = [succes(r4.corps.depositAddress, TX(32), { data: { outTxs: [{ txHash: TX(32), chainId: 8453, stateChanges: [{ address: PAYTO, change: { data: { tokenAddress: USDC.toLowerCase() }, balanceDiff: '4800000' } }] }] } })];
    N.recus[TX(32)] = recu([{ micro: 7000000 }, { micro: 4800000 }]);
    H.t += 30000; await M.d.tour();
    ok(M.credits.soldeMicro(x) === 4800000, 'deux transferts vers payTo dans la livraison : seul celui que Relay attribue (4,80 $), lu dans le recu');
  }

  console.log('\n-- 4. remboursement, echec --');
  {
    const M = monde(R, N, null, H);
    const r = await M.d.nouvelle(A, { origin: 'sol', amountUsd: 3 });
    R.requetes[r.corps.depositAddress] = [{ status: 'refund', depositAddress: { address: r.corps.depositAddress }, data: { failReason: 'AMOUNT_TOO_LOW', outTxs: [{ txHash: '5abc', chainId: 792703809 }] } }];
    H.t += 30000; await M.d.tour();
    const v = M.d.lit(A, r.corps.id);
    ok(M.credits.soldeUsd(A) === 0 && v.status === 'refunded' && /sent back/.test(v.message), 'rembourse : rien credite, « ' + v.message.slice(0, 50) + '… »');
    const r2 = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 3 });
    R.requetes[r2.corps.depositAddress] = [{ status: 'failure', depositAddress: { address: r2.corps.depositAddress }, data: { failReason: 'SWAP_FAILED' } }];
    H.t += 30000; await M.d.tour();
    ok(M.credits.soldeUsd(A) === 0 && M.d.lit(A, r2.corps.id).status === 'failed', 'echec : rien credite, « failed »');
    const r3 = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 3 });
    R.requetes[r3.corps.depositAddress] = [succes(r3.corps.depositAddress, TX(40), { depositAddress: { address: 'AutreAdresse111111111111111111111' } })];
    N.recus[TX(40)] = recu([{ micro: 2900000 }]);
    H.t += 30000; await M.d.tour();
    ok(M.credits.soldeUsd(A) === 0, 'une demande d une AUTRE adresse de depot rendue par Relay est ignoree');
    H.t += 8 * 24 * 3600 * 1000; await M.d.tour(5);
    ok(M.d.lit(A, r3.corps.id).status === 'expired', 'rien en 7 jours : close (« expired »)');
  }

  console.log('\n-- 5. redemarrage au milieu --');
  {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-reprise-'));
    const M1 = monde(R, N, dossier, H);
    const r = await M1.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 20 });
    M1.d.arrete();
    /* le serveur s arrete ; Relay livre pendant l arret */
    R.requetes[r.corps.depositAddress] = [succes(r.corps.depositAddress, TX(50))];
    N.recus[TX(50)] = recu([{ micro: 19950000 }]);
    const M2 = monde(R, N, dossier, H);
    H.t += 60000;
    await M2.d.tour();
    ok(M2.credits.soldeMicro(A) === 19950000 && M2.d.lit(A, r.corps.id).status === 'credited', 'relue sur le disque apres un redemarrage : creditee (19,95 $)');
    const M3 = monde(R, N, dossier, H);
    H.t += 60000; await M3.d.tour();
    ok(M3.credits.soldeMicro(A) === 19950000, 'un second redemarrage ne credite rien de plus');
  }

  console.log('\n-- 6. le vrai serveur --');
  {
    const port = 8840 + (process.pid % 50);
    const SECRET = 'secret-de-session-essai-depot';
    const session = require('./session');
    const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-srv-'));
    let traces = '';
    const lance = () => new Promise((res) => {
      const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: bac, SESSION_SECRET: SECRET, RPC_URL: 'http://127.0.0.1:1', VAULT_ADDRESS: '', SWOGE_TOKEN: '',
        AI_COLONIE: '0', TG_BOT_TOKEN: '', TG_CHAT_ID: '', ODDS_API_KEY: '', MONITEUR_URL: '', POLY_PAPIER: '0', DEPLOIEMENT_V4: '0',
        RELAY_API: R.url, RELAY_API_KEY: CLE, X402_BASE_PAYTO: PAYTO, X402_PAYTO: '', X402_CLE: '', X402_BASE_RPC: N.url,
        CREDIT_DEPOT_CADENCE_MS: '200', CREDIT_DEPOT_TOUR_MS: '100' });
      const p = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', (d) => { traces += d; }); p.stderr.on('data', (d) => { traces += d; });
      const t = setInterval(async () => { try { if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) { clearInterval(t); res(p); } } catch (e) {} }, 120);
    });
    const tue = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGKILL'); });
    let p = await lance();
    process.on('exit', () => { try { p.kill('SIGKILL'); } catch (e) {} });
    const ja = session.emettre(SECRET, A, 3600), jb = session.emettre(SECRET, B, 3600);
    const api = async (j, chemin, corps) => { const r = await fetch('http://127.0.0.1:' + port + chemin, { method: corps ? 'POST' : 'GET', headers: Object.assign({ 'content-type': 'application/json' }, j ? { authorization: 'Bearer ' + j } : {}), body: corps ? JSON.stringify(corps) : undefined }); const t = await r.text(); return { status: r.status, t, j: (() => { try { return JSON.parse(t); } catch (e) { return {}; } })() }; };
    const tout = [];
    let x = await api(null, '/credit/deposit', { origin: 'usdt_base', amountUsd: 5 }); tout.push(x.t);
    ok(x.status === 401, 'sans session : 401');
    x = await api('swg_' + 'x'.repeat(30), '/credit/deposit', { origin: 'usdt_base', amountUsd: 5 }); tout.push(x.t);
    ok(x.status === 401, 'une cle swg_ ne commande pas de depot : session seulement');
    x = await api(ja, '/credit/deposit'); tout.push(x.t);
    ok(x.status === 200 && x.j.available === true && x.j.origins.map((o) => o.id).join() === 'sol,usdt_sol,usdt_base,usdt_eth', 'GET : disponible, quatre provenances');
    x = await api(ja, '/credit/deposit', { origin: 'usdt_base', amountUsd: 5, addr: B, depositAddress: '0xEVIL', id: 'd' + '0'.repeat(24) }); tout.push(x.t);
    const id = x.j.id, dep = x.j.depositAddress;
    ok(x.status === 200 && /^d[0-9a-f]{24}$/.test(id) && dep && dep !== '0xEVIL' && x.j.sendExactly === '5 USDT', 'POST : une commande a soi (5 USDT sur Base), id et adresse du serveur');
    x = await api(jb, '/credit/deposit/' + id); tout.push(x.t);
    ok(x.status === 404, 'la commande de A lue par B : 404');
    x = await api(jb, '/credit/deposit'); tout.push(x.t);
    ok(x.j.orders.length === 0, 'B ne voit pas la commande de A dans sa liste');
    R.requetes[dep] = [succes(dep, TX(60))];
    N.recus[TX(60)] = recu([{ micro: 4900000 }]);
    let v = null;
    for (let i = 0; i < 40 && !(v && v.status === 'credited'); i++) { await new Promise((r) => setTimeout(r, 150)); v = (await api(ja, '/credit/deposit/' + id)).j; }
    tout.push(JSON.stringify(v));
    ok(v && v.status === 'credited' && v.creditedUsd === 4.9 && v.balanceUsd === 4.9, 'le suivi du serveur credite A : 4,90 $ (« credited »)');
    x = await api(jb, '/credit'); tout.push(x.t);
    ok(x.j.balanceUsd === 0, 'B : 0 $');
    /* une commande ouverte, puis le serveur tombe, Relay livre, le serveur revient */
    x = await api(ja, '/credit/deposit', { origin: 'sol', amountUsd: 2 }); tout.push(x.t);
    const id2 = x.j.id, dep2 = x.j.depositAddress;
    await tue(p);
    R.requetes[dep2] = [succes(dep2, TX(61))];
    N.recus[TX(61)] = recu([{ micro: 1960000 }]);
    p = await lance();
    for (let i = 0; i < 40 && !(v && v.status === 'credited' && v.id === id2); i++) { await new Promise((r) => setTimeout(r, 150)); v = (await api(ja, '/credit/deposit/' + id2)).j; }
    x = await api(ja, '/credit'); tout.push(x.t);
    ok(v.status === 'credited' && Math.abs(x.j.balanceUsd - 6.86) < 1e-9, 'redemarrage au milieu : relue, creditee (4,90 + 1,96 = 6,86 $)');
    await new Promise((r) => setTimeout(r, 600));
    x = await api(ja, '/credit'); tout.push(x.t);
    ok(Math.abs(x.j.balanceUsd - 6.86) < 1e-9, 'et rien de plus aux lectures suivantes');
    /* Relay en panne : trois echecs, puis 503 sans meme appeler */
    R.panne = true;
    for (let i = 0; i < 3; i++) { x = await api(ja, '/credit/deposit', { origin: 'usdt_sol', amountUsd: 2 }); tout.push(x.t); }
    const avant = R.cotations.length;
    x = await api(ja, '/credit/deposit', { origin: 'usdt_sol', amountUsd: 2 }); tout.push(x.t);
    ok(x.status === 503 && R.cotations.length === avant, 'Relay en panne : 503 sur les nouvelles commandes (« ' + x.j.raison + ' »)');
    R.panne = false;
    ok(!tout.some((t) => String(t).includes(CLE)), 'la cle Relay n apparait dans aucune reponse (' + tout.length + ' relues)');
    ok(!traces.includes(CLE) && /\[depot\] order d/.test(traces), 'ni dans les journaux du serveur (alors que Relay l a renvoyee dans un message d erreur)');
    ok([...R.cles].every((k) => k === CLE), 'chaque appel a Relay porte la cle en en-tete x-api-key');
    await tue(p);
  }

  R.serveur.close(); N.serveur.close();
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
