'use strict';
/*
 * DEPOSER AUX PARIS EN SOL, USDT OU ETH (bet_depot.js, 17/10/2026)
 *
 * Tout est FAUX ici : un faux Relay (HTTP local) et un faux noeud Robinhood Chain (JSON-RPC
 * local). Aucun appel ne part vers Relay ni vers une chaine ; aucune cle reelle. Le jeu, lui, est
 * le VRAI (game.js) : le credit passe par creditBetDeposit, son seenTx et son journal.
 *
 * ---- CE QUE L'ESSAI TIENT ----
 *   1. la commande : liste fermee (SOL, USDC, USDT, ETH), 5 $..50 $ (10 $ depuis Ethereum), compte maison refuse, corps envoye a Relay (strict,
 *      refundTo natif, destinataire = LE COFFRE DES PARIS, $SWOGEBET sur 4663, EXACT_INPUT),
 *      cours du SOL/ETH vers l'USDC de Base, ecrite sur le disque AVANT la reponse, frais fige ;
 *   2. SOL : credite 95 % de ce que le RECU montre (pas la cotation), le frais compte a part,
 *      la session qui a cree la commande et elle seule ; une relecture ne credite rien ;
 *   3. recu absent, statut 0, autre jeton, autre destinataire : rien ; deux transferts : l'indice ;
 *   4. remboursement (sous-paiement), echec : rien, et un message ;
 *   5. un arret entre le credit du jeu et l'ecriture de la commande : rattrape, une seule fois ;
 *   6. le frais : 0..1000, illisible = plus de nouvelle commande, les ouvertes gardent le leur ;
 *      inerte sans coffre, sans cle ;
 *   7. le vrai serveur : session seulement, une adresse du corps ne change rien, une autre
 *      session ne voit rien (404), compte maison 403, credit + message WebSocket betDeposit,
 *      la cle Relay ne sort jamais, BET_DEPOT=0 eteint.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'betdepot-jeu-'));
process.env.DATA_DIR = DATA;
const { ethers } = require('ethers');
const { Game } = require('./game');
const D = require('./bet_depot');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const CLE = 'relay-CLE-SECRETE-paris-qui-ne-sort-jamais-91';
const VAULT = require('ethers').ethers.utils.getAddress('0x' + 'be7'.repeat(13) + 'b');
const SWB = '0xc0aed547862fba5d7d9fbf3cb14204cd756c8bea';
const AUTRE = '0x8888888888888888888888888888888888888888';
const AUTRE_JETON = '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), MAISON = '0x' + 'c4'.repeat(20);
const TX = (i) => '0x' + String(i).padStart(64, 'c');
const E18 = 10n ** 18n;
const W = (x) => BigInt(x) * E18;
const txt = (wei) => D.enTexte(wei, 18);
const LISTE = 'sol,usdc_sol,usdt_sol,usdc_base,usdt_base,eth_base,eth,usdc_eth,usdt_eth';

/* ---- LE FAUX RELAY ----
   Cotation : SOL 100 $ ; ETH 2 400 $ ; vers $SWOGEBET, 39 000 jetons par $ (mesure du 17/10). */
function fauxRelay() {
  const R = { cotations: [], lectures: [], cles: new Set(), requetes: {}, panne: false, seq: 0 };
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
        const natifEvm = q.originCurrency === '0x0000000000000000000000000000000000000000';
        /* la valeur en micro-dollars de ce qui est envoye */
        const micro = sol ? BigInt(q.amount) * 100000000n / 10n ** 9n : natifEvm ? BigInt(q.amount) * 2400000000n / E18 : BigInt(q.amount);
        if (q.destinationChainId === 8453) {
          return rep(200, { details: { currencyIn: { currency: { address: q.originCurrency }, amount: q.amount }, currencyOut: { currency: { address: D.USDC_BASE.toLowerCase(), chainId: 8453 }, amount: String(micro) } }, steps: [] });
        }
        if (!q.useDepositAddress) return rep(400, { message: 'expected a deposit address request' });
        const out = micro * 39000n * E18 / 1000000n;
        const dep = q.originChainId === 792703809 ? 'DepoSoL' + String(++R.seq).padStart(37, '1') : '0x' + String(++R.seq).padStart(40, 'd');
        const id = '0x' + String(R.seq).padStart(64, 'e');
        return rep(200, { requestId: id, steps: [{ id: 'deposit', requestId: id, depositAddress: dep }],
          details: { recipient: R.destForce || q.recipient, currencyIn: { currency: { address: q.originCurrency }, amount: q.amount },
            currencyOut: { currency: { address: R.sortieForcee || SWB, chainId: 4663 }, amount: String(out), minimumAmount: String(out * 97n / 100n) } } });
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
const succes = (dep, tx, extra) => Object.assign({ id: '0x1', status: 'success', recipient: VAULT, depositAddress: { address: dep },
  data: { outTxs: [{ txHash: tx, chainId: 4663, status: 'success', stateChanges: [] }] } }, extra || {});

/* ---- LE FAUX NOEUD ROBINHOOD CHAIN ---- (assez d'ethers pour que le vrai serveur demarre) */
function fauxRH() {
  const N = { recus: {}, bloc: 1000, appels: 0 };
  N.recu = async (h) => { N.appels++; return N.recus[h] || null; };
  N.blocNum = async () => N.bloc;
  N.serveur = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let q; try { q = JSON.parse(b); } catch (e) { q = {}; }
      const un = (x) => {
        N.appels++;
        const r = x.method === 'eth_getTransactionReceipt' ? (N.recus[x.params[0]] || null)
          : x.method === 'eth_blockNumber' ? '0x' + N.bloc.toString(16)
          : x.method === 'eth_chainId' ? '0x1237' : x.method === 'net_version' ? '4663'
          : x.method === 'eth_getLogs' ? [] : x.method === 'eth_call' ? '0x' + '0'.repeat(64) : null;
        return { jsonrpc: '2.0', id: x.id, result: r };
      };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? q.map(un) : un(q)));
    });
  });
  return new Promise((ok2) => N.serveur.listen(0, '127.0.0.1', () => { N.url = 'http://127.0.0.1:' + N.serveur.address().port; ok2(N); }));
}
/* Un recu : `transferts` = [{ vers, wei, jeton? }] */
const recu = (transferts, o) => Object.assign({ status: '0x1', blockNumber: '0x' + (990).toString(16), logs: transferts.map((x, i) => ({
  address: x.jeton || SWB, topics: [T, pad('0x' + '99'.repeat(20)), pad(x.vers || VAULT)], data: hex(x.wei), logIndex: '0x' + (i + 3).toString(16), removed: false })) }, o || {});

/* Le monde : le VRAI jeu, branche comme server.js le branche. */
function monde(R, N, o) {
  o = o || {};
  const dossier = o.dossier || fs.mkdtempSync(path.join(os.tmpdir(), 'betdepot-'));
  const g = o.jeu || new Game();
  const vus = [];
  const d = D.cree({ dossier, vault: o.vault === undefined ? VAULT : o.vault, jeton: SWB, api: R.url, cle: o.cle === undefined ? CLE : o.cle,
    fraisBps: o.fraisBps, rpc: { recu: N.recu, bloc: N.blocNum },
    credite: o.credite || (({ player, amountWei, tx }) => { const f = g.creditBetDeposit({ player, amount: ethers.BigNumber.from(amountWei), tx }); if (f) vus.push(player); return f; }),
    dejaVu: (k) => g.seenTx.has(k), estMaison: (a) => a === MAISON,
    maintenant: o.horloge ? () => o.horloge.t : Date.now, log: () => {} });
  const solde = (a) => BigInt(ethers.utils.parseUnits(g.betBalanceStr(a), 18).toString());
  return { d, g, dossier, solde, vus };
}

(async () => {
  const R = await fauxRelay(), N = await fauxRH();
  const H = { t: Date.UTC(2026, 9, 17, 12, 0) };

  console.log('-- 1. la commande --');
  {
    const M = monde(R, N, { horloge: H });
    let r = await M.d.nouvelle(A, { origin: 'tron', amountUsd: 10 });
    ok(r.status === 400 && R.cotations.length === 0, 'une provenance hors liste (TRON) : 400, aucun appel a Relay');
    r = await M.d.nouvelle(A, { origin: '__proto__', amountUsd: 10 });
    ok(r.status === 400, 'un nom d origine piege (__proto__) : 400');
    r = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 4.99 });
    ok(r.status === 400 && /\$5/.test(r.corps.raison), 'sous 5 $ : 400 (« ' + r.corps.raison + ' »)');
    r = await M.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 50.01 });
    ok(r.status === 400 && /\$50/.test(r.corps.raison) && R.cotations.length === 0, 'plus de 50 $ : 400, aucune cotation');
    r = await M.d.nouvelle(MAISON, { origin: 'usdt_base', amountUsd: 10 });
    ok(r.status === 403 && R.cotations.length === 0, 'un compte maison : 403, aucune cotation');
    r = await M.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 10, recipient: AUTRE, depositAddress: '0xEVIL', addr: B, fraisBps: 0 });
    const q = R.cotations[R.cotations.length - 1];
    ok(r.status === 200 && r.corps.depositAddress && r.corps.depositAddress !== '0xEVIL' && r.corps.send === '10' && r.corps.token === 'USDT' && r.corps.network === 'Base',
       'USDT Base 10 $ : une adresse de Relay, « send 10 USDT on Base »');
    ok(q.strict === true && q.useDepositAddress === true && q.refundTo === '0x0000000000000000000000000000000000000000' && q.user === q.refundTo,
       'strict, refundTo = l adresse native (remboursement a l envoyeur), user = repere');
    ok(q.recipient === VAULT && q.destinationChainId === 4663 && q.destinationCurrency === SWB && q.tradeType === 'EXACT_INPUT' && q.amount === '10000000',
       'destinataire = le coffre des paris, $SWOGEBET sur 4663, EXACT_INPUT ; rien du corps du client');
    ok(r.corps.feeBps === 500 && r.corps.estimateSwogebet === '390000' && r.corps.estimateCreditedSwogebet === '370500',
       'frais 5 % (le corps qui demandait 0 est ignore) ; estimation 390 000, dont 370 500 au joueur');
    const disque = JSON.parse(fs.readFileSync(path.join(M.dossier, 'bet_depots.json'), 'utf8'));
    const c = disque.commandes[r.corps.id];
    ok(c && c.addr === A && c.depot === r.corps.depositAddress && c.fraisBps === 500 && c.statut === 'attente' && c.coteWei === String(W(390000)),
       'la commande est sur le disque a la reponse (session A, frais fige, cotation en wei)');
    ok(!JSON.stringify(r.corps).includes(CLE) && !JSON.stringify(disque).includes(CLE), 'la cle n est ni dans la reponse ni sur le disque');
    /* SOL : 7 $ a 100 $ le SOL = 0,07 SOL ; le cours vient d une cotation vers l USDC de Base */
    const avant = R.cotations.length;
    r = await M.d.nouvelle(A, { origin: 'sol', amountUsd: 7 });
    const prix = R.cotations[avant], qs = R.cotations[R.cotations.length - 1];
    ok(prix.destinationChainId === 8453 && prix.destinationCurrency === D.USDC_BASE && !prix.useDepositAddress && prix.amount === '1000000000',
       'le cours du SOL : 1 SOL cote vers l USDC de Base, sans adresse de depot (pas la piscine mince du $SWOGEBET)');
    ok(r.status === 200 && r.corps.send === '0.07' && qs.amount === '70000000' && qs.refundTo === '11111111111111111111111111111111' && qs.originChainId === 792703809,
       'SOL 7 $ : 0,07 SOL, refundTo = 1111…1111');
    let nq = R.cotations.length;
    r = await M.d.nouvelle(B, { origin: 'eth', amountUsd: 9.99 });
    const r9 = await M.d.nouvelle(B, { origin: 'usdt_eth', amountUsd: 9.99 }), r9c = await M.d.nouvelle(B, { origin: 'usdc_eth', amountUsd: 9.99 });
    ok(r.status === 400 && r9.status === 400 && r9c.status === 400 && /\$10 and \$50 for ETH on Ethereum/.test(r.corps.raison) && R.cotations.length === nq,
       'depuis Ethereum (ETH, USDT, USDC) sous 10 $ : 400, aucune cotation (« ' + r.corps.raison + ' »)');
    r = await M.d.nouvelle(B, { origin: 'eth', amountUsd: 10.5 });
    const qe = R.cotations[R.cotations.length - 1];
    /* 10,5 / 2 400 = 0,004375 ETH, arrondi au-dessus a 0,00001 → 0,00438 */
    ok(r.status === 200 && r.corps.send === '0.00438' && qe.originChainId === 1 && qe.amount === '4380000000000000', 'ETH Ethereum 10,50 $ : 0,00438 ETH (arrondi au-dessus a 0,00001)');
    r = await M.d.nouvelle(B, { origin: 'eth_base', amountUsd: 5 });
    ok(r.status === 200 && R.cotations[R.cotations.length - 1].originChainId === 8453, 'ETH Base : chaine 8453, 5 $ accepte');
    /* USDC et USDT : le jeton et la chaine de la liste, 1 pour 1 en unites a 6 decimales */
    const C2 = '0x' + 'c6'.repeat(20), C3 = '0x' + 'c7'.repeat(20);
    const attendus = { usdc_sol: [792703809, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'], usdc_base: [8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      usdc_eth: [1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'], usdt_eth: [1, '0xdAC17F958D2ee523a2206206994597C13D831ec7'] };
    let bons = 0;
    for (const [i, id] of Object.keys(attendus).entries()) {
      const x = await M.d.nouvelle(i < 2 ? C2 : C3, { origin: id, amountUsd: 12 });
      const qq = R.cotations[R.cotations.length - 1];
      if (x.status === 200 && qq.originChainId === attendus[id][0] && qq.originCurrency === attendus[id][1] && qq.amount === '12000000' && qq.recipient === VAULT && x.corps.send === '12') bons++;
    }
    ok(bons === 4, 'USDC Solana, USDC Base, USDC Ethereum, USDT Ethereum a 12 $ : le bon jeton, la bonne chaine, 12 000 000 unites, vers le coffre');
    await M.d.nouvelle(B, { origin: 'usdt_sol', amountUsd: 5 });
    r = await M.d.nouvelle(B, { origin: 'usdt_sol', amountUsd: 5 });
    ok(r.status === 429, 'une quatrieme commande ouverte pour la meme session : 429');
    ok(M.d.lit(B, M.d.liste(A)[0].id) === null && M.d.liste(B).length === 3 && M.d.liste(A).length === 2, 'chaque session ne lit et ne liste que les siennes');
    R.sortieForcee = AUTRE_JETON;
    r = await M.d.nouvelle('0x' + 'c3'.repeat(20), { origin: 'usdt_base', amountUsd: 6 });
    delete R.sortieForcee;
    ok(r.status === 502, 'une cotation qui ne livre pas du $SWOGEBET est refusee (502), rien d enregistre');
    R.destForce = AUTRE;
    r = await M.d.nouvelle('0x' + 'c5'.repeat(20), { origin: 'usdt_base', amountUsd: 6 });
    delete R.destForce;
    ok(r.status === 502, 'une cotation vers un autre destinataire que le coffre est refusee (502)');
    const org = M.d.origines();
    ok(org.map((o) => o.id).join() === LISTE && org.every((o) => o.maxUsd === 50 && o.minUsd === (o.network === 'Ethereum' ? 10 : 5)), 'neuf provenances, 5 $ (10 $ depuis Ethereum) a 50 $');
  }

  console.log('\n-- 2. SOL : 95 % de ce qui arrive, une fois --');
  {
    const M = monde(R, N, { horloge: H });
    const r = await M.d.nouvelle(A, { origin: 'sol', amountUsd: 20 });
    const dep = r.corps.depositAddress;
    H.t += 10000; await M.d.tour();
    ok(M.solde(A) === 0n && M.d.lit(A, r.corps.id).status === 'waiting', 'rien encore chez Relay : en attente, rien credite');
    R.requetes[dep] = [succes(dep, TX(1))];
    /* Arrive : 690 000,5 jetons — MOINS que la cotation (780 000) : c'est ce qui arrive qui compte. */
    const arrive = W(690000) + E18 / 2n;
    N.recus[TX(1)] = recu([{ wei: arrive }]);
    H.t += 30000; await M.d.tour();
    const net = arrive * 9500n / 10000n, frais = arrive - net;
    ok(M.solde(A) === net, 'credite ' + txt(net) + ' $SWOGEBET = 95 % de ' + txt(arrive) + ' (le journal, pas la cotation)');
    const v = M.d.lit(A, r.corps.id);
    ok(v.status === 'credited' && v.creditedSwogebet === txt(net) && v.feeSwogebet === txt(frais), 'la commande dit « credited », la part et le frais');
    ok(M.d.etat().fraisCumules === txt(frais) && M.d.etat().arrive === txt(arrive) && M.d.etat().credite === txt(net), 'le frais est compte a part (' + M.d.etat().fraisCumules + '), arrive = credite + frais');
    ok(M.solde(B) === 0n, 'l autre session n a rien');
    ok(M.g.seenTx.has('relay:' + TX(1) + ':3') && M.g._p(A).betDeposited.toString() === net.toString(), 'le jeu a vu la cle relay:<tx>:<index> ; betDeposited = la part du joueur');
    const j = fs.readFileSync(path.join(DATA, 'journal', A + '.jsonl'), 'utf8');
    ok(/"k":"depb"/.test(j) && j.includes('relay:' + TX(1) + ':3'), 'le journal du joueur porte le depot (depb, la cle)');
    H.t += 30000; await M.d.tour();
    ok(M.solde(A) === net, 'une commande close n est plus relue ; rien de plus');
    ok(M.g.creditBetDeposit({ player: A, amount: ethers.BigNumber.from(1), tx: 'relay:' + TX(1) + ':3' }) === false, 'rejouer la meme cle dans le jeu ne credite rien');
    /* La meme livraison vue par une SECONDE commande (Relay la rend sous deux adresses) : rien. */
    const r2 = await M.d.nouvelle(B, { origin: 'usdt_base', amountUsd: 10 });
    R.requetes[r2.corps.depositAddress] = [succes(r2.corps.depositAddress, TX(1))];
    H.t += 30000; await M.d.tour();
    ok(M.solde(B) === 0n && M.solde(A) === net && M.d.lit(B, r2.corps.id).status === 'review', 'la meme livraison sous une autre commande : rien, « review »');
  }

  console.log('\n-- 3. Relay dit success, notre lecture non --');
  {
    const M = monde(R, N, { horloge: H });
    const cas = [
      ['recu absent', null, 'processing'],
      ['statut 0', recu([{ wei: W(100000) }], { status: '0x0' }), 'review'],
      ['autre jeton', recu([{ wei: W(100000), jeton: AUTRE_JETON }]), 'review'],
      ['autre destinataire', recu([{ wei: W(100000), vers: AUTRE }]), 'review'],
    ];
    let i = 10;
    for (const [nom, rc, attendu] of cas) {
      const who = '0x' + String(i).padStart(40, '4');
      const r = await M.d.nouvelle(who, { origin: 'usdt_base', amountUsd: 5 });
      R.requetes[r.corps.depositAddress] = [succes(r.corps.depositAddress, TX(i))];
      if (rc) N.recus[TX(i)] = rc;
      H.t += 30000; await M.d.tour();
      const v = M.d.lit(who, r.corps.id);
      ok(M.solde(who) === 0n && v.status === attendu, nom + ' : rien credite, « ' + v.status + ' »');
      i++;
    }
    const w = '0x' + '5'.repeat(40);
    const r = await M.d.nouvelle(w, { origin: 'usdt_base', amountUsd: 5 });
    R.requetes[r.corps.depositAddress] = [succes(r.corps.depositAddress, TX(30))];
    N.recus[TX(30)] = recu([{ wei: W(190000) }], { blockNumber: '0x' + (1000).toString(16) });
    H.t += 30000; await M.d.tour();
    ok(M.solde(w) === 0n, 'un recu dans le dernier bloc (1 confirmation sur ' + D.CONFIRMATIONS + ') : on attend');
    N.bloc = 1001; H.t += 30000; await M.d.tour();
    ok(M.solde(w) === W(180500), 'un bloc plus tard : 180 500 (95 % de 190 000)');
    N.bloc = 1000;
    const x = '0x' + '7'.repeat(39) + '1';
    const r4 = await M.d.nouvelle(x, { origin: 'usdt_base', amountUsd: 5 });
    R.requetes[r4.corps.depositAddress] = [succes(r4.corps.depositAddress, TX(32), { data: { outTxs: [{ txHash: TX(32), chainId: 4663, stateChanges: [{ address: VAULT.toLowerCase(), change: { data: { tokenAddress: SWB }, balanceDiff: String(W(200000)) } }] }] } })];
    N.recus[TX(32)] = recu([{ wei: W(300000) }, { wei: W(200000) }]);
    H.t += 30000; await M.d.tour();
    ok(M.solde(x) === W(190000), 'deux transferts vers le coffre : seul celui que Relay attribue (200 000 → 190 000), lu dans le recu');
    /* Une transaction deja comptee comme Deposit du coffre (meme hash) ne l est pas par Relay. */
    const y = '0x' + '8'.repeat(39) + '2';
    M.g.creditBetDeposit({ player: y, amount: ethers.BigNumber.from(W(1)), tx: TX(33) });
    const r5 = await M.d.nouvelle(y, { origin: 'usdt_base', amountUsd: 5 });
    R.requetes[r5.corps.depositAddress] = [succes(r5.corps.depositAddress, TX(33))];
    N.recus[TX(33)] = recu([{ wei: W(190000) }]);
    H.t += 30000; await M.d.tour();
    ok(M.solde(y) === W(1), 'une transaction deja creditee comme depot du coffre ne credite rien de plus');
  }

  console.log('\n-- 4. remboursement (sous-paiement), echec --');
  {
    const M = monde(R, N, { horloge: H });
    const r = await M.d.nouvelle(A, { origin: 'sol', amountUsd: 10 });
    R.requetes[r.corps.depositAddress] = [{ status: 'refund', depositAddress: { address: r.corps.depositAddress }, data: { failReason: 'AMOUNT_TOO_LOW', outTxs: [{ txHash: '5abc', chainId: 792703809 }] } }];
    H.t += 30000; await M.d.tour();
    const v = M.d.lit(A, r.corps.id);
    ok(M.solde(A) === 0n && v.status === 'refunded' && /sent back/.test(v.message) && M.d.etat().fraisCumules === '0', 'sous-paye, rembourse : rien credite, aucun frais (« ' + v.message.slice(0, 50) + '… »)');
    const r2 = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 10 });
    R.requetes[r2.corps.depositAddress] = [{ status: 'failure', depositAddress: { address: r2.corps.depositAddress }, data: { failReason: 'SWAP_FAILED' } }];
    H.t += 30000; await M.d.tour();
    ok(M.solde(A) === 0n && M.d.lit(A, r2.corps.id).status === 'failed', 'echec : rien credite, « failed »');
    const r3 = await M.d.nouvelle(A, { origin: 'usdt_sol', amountUsd: 10 });
    R.requetes[r3.corps.depositAddress] = [succes(r3.corps.depositAddress, TX(40), { depositAddress: { address: 'AutreAdresse111111111111111111111' } })];
    N.recus[TX(40)] = recu([{ wei: W(390000) }]);
    H.t += 30000; await M.d.tour();
    ok(M.solde(A) === 0n, 'une demande d une AUTRE adresse de depot rendue par Relay est ignoree');
    H.t += 8 * 24 * 3600 * 1000; await M.d.tour(5);
    ok(M.d.lit(A, r3.corps.id).status === 'expired', 'rien en 7 jours : close (« expired »)');
  }

  console.log('\n-- 5. un arret entre le credit du jeu et l ecriture de la commande --');
  {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'betdepot-reprise-'));
    const g = new Game();
    /* Le premier serveur credite le jeu puis « tombe » : l ecriture de la commande ne se fait pas
       (on la simule en relisant le disque d AVANT le credit). */
    const M1 = monde(R, N, { horloge: H, dossier, jeu: g });
    const r = await M1.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 20 });
    R.requetes[r.corps.depositAddress] = [succes(r.corps.depositAddress, TX(50))];
    N.recus[TX(50)] = recu([{ wei: W(780000) }]);
    const fichier = path.join(dossier, 'bet_depots.json');
    let instantane = null;
    const M1b = monde(R, N, { horloge: H, dossier, jeu: g, credite: ({ player, amountWei, tx }) => {
      instantane = fs.readFileSync(fichier, 'utf8');            /* l intention est deja ecrite */
      return g.creditBetDeposit({ player, amount: ethers.BigNumber.from(amountWei), tx });
    } });
    H.t += 60000; await M1b.d.tour();
    ok(M1b.solde(A) === W(741000), 'premier passage : 741 000 credites (95 % de 780 000)');
    ok(instantane && JSON.parse(instantane).cles['relay:' + TX(50) + ':3'] === r.corps.id, 'l intention (cle → commande) etait sur le disque AVANT le credit du jeu');
    fs.writeFileSync(fichier, instantane);                     /* le disque tel qu au moment de l arret */
    const M2 = monde(R, N, { horloge: H, dossier, jeu: g });
    H.t += 60000; await M2.d.tour();
    ok(M2.solde(A) === W(741000) && M2.d.lit(A, r.corps.id).status === 'credited' && M2.d.MESURE.reprises === 1,
       'apres le redemarrage : la commande se dit creditee, le jeu n a rien credite de plus (une reprise)');
    ok(M2.d.etat().fraisCumules === '39000', 'et le frais est compte une fois (39 000)');
    const M3 = monde(R, N, { horloge: H, dossier, jeu: g });
    H.t += 60000; await M3.d.tour();
    ok(M3.solde(A) === W(741000) && M3.d.etat().fraisCumules === '39000', 'un second redemarrage ne change rien');
    /* Et l inverse : l etat du JEU perdu (redemarre sans le credit), l intention sur le disque. */
    const g2 = new Game();
    const r2 = await M3.d.nouvelle(B, { origin: 'usdt_base', amountUsd: 10 });
    R.requetes[r2.corps.depositAddress] = [succes(r2.corps.depositAddress, TX(51))];
    N.recus[TX(51)] = recu([{ wei: W(390000) }]);
    const M4 = monde(R, N, { horloge: H, dossier, jeu: g2, credite: () => { throw new Error('process killed'); } });
    H.t += 60000; await M4.d.tour();
    ok(M4.solde(B) === 0n && M4.d.lit(B, r2.corps.id).status !== 'credited', 'le credit du jeu tombe : la commande reste ouverte');
    const M5 = monde(R, N, { horloge: H, dossier, jeu: g2 });
    H.t += 60000; await M5.d.tour();
    ok(M5.solde(B) === W(370500) && M5.d.lit(B, r2.corps.id).status === 'credited', 'relue ensuite : creditee une fois (370 500)');
  }

  console.log('\n-- 6. le frais, et l inertie --');
  {
    ok(D.lisFrais('') === 500 && D.lisFrais(undefined) === 500 && D.lisFrais('0') === 0 && D.lisFrais('1000') === 1000, 'frais : vide → 500, 0 et 1000 acceptes');
    ok(D.lisFrais('1001') === null && D.lisFrais('5%') === null && D.lisFrais('-1') === null && D.lisFrais('2.5') === null && D.lisFrais('abc') === null, 'frais : 1001, « 5% », -1, 2.5, abc → illisible');
    const p = D.partage(1000n, 500);
    ok(p.net === 950n && p.frais === 50n && D.partage(19n, 500).net === 18n && D.partage(19n, 500).frais === 1n, 'le partage arrondit au profit de la maison (19 wei → 18 + 1), jamais au-dela de ce qui est arrive');
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'betdepot-frais-'));
    const g = new Game();
    const M1 = monde(R, N, { horloge: H, dossier, jeu: g, fraisBps: 200 });
    const r = await M1.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 10 });
    ok(r.status === 200 && r.corps.feeBps === 200, 'BET_DEPOT_FRAIS_BPS=200 : la commande porte 2 %');
    const M2 = monde(R, N, { horloge: H, dossier, jeu: g, fraisBps: null });
    const n0 = R.cotations.length;
    const r2 = await M2.d.nouvelle(A, { origin: 'usdt_base', amountUsd: 10 });
    ok(r2.status === 503 && R.cotations.length === n0 && M2.d.actif() && !M2.d.ouvert(), 'frais illisible : plus de nouvelle commande (503, aucune cotation), le suivi reste actif');
    R.requetes[r.corps.depositAddress] = [succes(r.corps.depositAddress, TX(60))];
    N.recus[TX(60)] = recu([{ wei: W(100000) }]);
    H.t += 60000; await M2.d.tour();
    ok(M2.solde(A) === W(98000), 'la commande ouverte est creditee a SON frais (2 % : 98 000 sur 100 000)');
    const sans = monde(R, N, { vault: '' }), sansCle = monde(R, N, { cle: '' });
    const n1 = R.cotations.length;
    const x = await sans.d.nouvelle(A, { origin: 'sol', amountUsd: 10 }), y = await sansCle.d.nouvelle(A, { origin: 'sol', amountUsd: 10 });
    ok(!sans.d.actif() && !sansCle.d.actif() && x.status === 503 && y.status === 503 && R.cotations.length === n1 && (await sans.d.tour()) === 0 && sans.d.demarre() === false,
       'sans coffre ou sans cle : inerte (503, aucun appel, aucun suivi)');
  }

  console.log('\n-- 7. le vrai serveur --');
  {
    const port = 8890 + (process.pid % 50);
    const SECRET = 'secret-de-session-essai-depot-paris';
    const session = require('./session');
    const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'betdepot-srv-'));
    let traces = '';
    const lance = (extra) => new Promise((res) => {
      const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: bac, SESSION_SECRET: SECRET, RPC_URL: N.url, VAULT_ADDRESS: '', SWOGE_TOKEN: '',
        BET_VAULT_ADDRESS: VAULT, COMPTES_MAISON: MAISON, BET_DEPOT_FRAIS_BPS: '',
        AI_COLONIE: '0', TG_BOT_TOKEN: '', TG_CHAT_ID: '', ODDS_API_KEY: '', MONITEUR_URL: '', POLY_PAPIER: '0', DEPLOIEMENT_V4: '0',
        RELAY_API: R.url, RELAY_API_KEY: CLE, X402_BASE_PAYTO: '', X402_PAYTO: '', X402_CLE: '',
        BET_DEPOT_CADENCE_MS: '200', BET_DEPOT_TOUR_MS: '100' }, extra || {});
      const p = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', (d) => { traces += d; }); p.stderr.on('data', (d) => { traces += d; });
      const t = setInterval(async () => { try { if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) { clearInterval(t); res(p); } } catch (e) {} }, 120);
    });
    const tue = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGKILL'); });
    let p = await lance();
    process.on('exit', () => { try { p.kill('SIGKILL'); } catch (e) {} });
    const ja = session.emettre(SECRET, A, 3600), jb = session.emettre(SECRET, B, 3600), jm = session.emettre(SECRET, MAISON, 3600);
    const api = async (j, chemin, corps) => { const r = await fetch('http://127.0.0.1:' + port + chemin, { method: corps ? 'POST' : 'GET', headers: Object.assign({ 'content-type': 'application/json' }, j ? { authorization: 'Bearer ' + j } : {}), body: corps ? JSON.stringify(corps) : undefined }); const t = await r.text(); return { status: r.status, t, j: (() => { try { return JSON.parse(t); } catch (e) { return {}; } })() }; };
    const tout = [];
    ok(/\[betdepot\] on: .*fee 500 bps/.test(traces), 'au demarrage : « [betdepot] on … fee 500 bps »');
    let x = await api(null, '/bet/deposit', { origin: 'usdt_base', amountUsd: 5 }); tout.push(x.t);
    ok(x.status === 401, 'sans session : 401');
    x = await api('swg_' + 'x'.repeat(30), '/bet/deposit'); tout.push(x.t);
    ok(x.status === 401, 'une cle swg_ ne commande pas de depot : session seulement');
    x = await api(ja, '/bet/deposit'); tout.push(x.t);
    ok(x.status === 200 && x.j.available === true && x.j.feeBps === 500 && x.j.feePercent === 5 && x.j.origins.map((o) => o.id).join() === LISTE,
       'GET : disponible, frais 5 %, neuf provenances');
    x = await api(jm, '/bet/deposit'); tout.push(x.t);
    ok(x.status === 200 && x.j.available === false, 'GET d un compte maison : « available: false »');
    x = await api(jm, '/bet/deposit', { origin: 'usdt_base', amountUsd: 5 }); tout.push(x.t);
    ok(x.status === 403, 'POST d un compte maison : 403');
    /* Le WebSocket de A, connecte par sa session : il doit recevoir betDeposit. */
    const WS = require('ws');
    const ws = new WS('ws://127.0.0.1:' + port);
    const recus = [];
    ws.on('message', (m) => { let o; try { o = JSON.parse(String(m)); } catch (e) { return; } recus.push(o); if (o.type === 'hello') ws.send(JSON.stringify({ type: 'resume', token: ja })); });
    for (let i = 0; i < 40 && !recus.some((o) => o.type === 'auth'); i++) await new Promise((r) => setTimeout(r, 100));
    ok(recus.some((o) => o.type === 'auth' && o.address === A), 'le WebSocket de A est repris par sa session');
    x = await api(ja, '/bet/deposit', { origin: 'sol', amountUsd: 10, addr: B, player: B, depositAddress: 'EVIL', id: 'b' + '0'.repeat(24) }); tout.push(x.t);
    const id = x.j.id, dep = x.j.depositAddress;
    ok(x.status === 200 && /^b[0-9a-f]{24}$/.test(id) && dep && dep !== 'EVIL' && x.j.sendExactly === '0.1 SOL' && x.j.feePercent === 5, 'POST : une commande a soi (0,1 SOL), id et adresse du serveur, 5 %');
    x = await api(jb, '/bet/deposit/' + id); tout.push(x.t);
    ok(x.status === 404, 'la commande de A lue par B : 404');
    x = await api(jb, '/bet/deposit'); tout.push(x.t);
    ok(x.j.orders.length === 0, 'B ne voit pas la commande de A dans sa liste');
    R.requetes[dep] = [succes(dep, TX(70))];
    N.recus[TX(70)] = recu([{ wei: W(380000) }]);
    let v = null;
    for (let i = 0; i < 40 && !(v && v.status === 'credited'); i++) { await new Promise((r) => setTimeout(r, 150)); v = (await api(ja, '/bet/deposit/' + id)).j; }
    tout.push(JSON.stringify(v));
    ok(v && v.status === 'credited' && v.creditedSwogebet === '361000' && v.feeSwogebet === '19000' && v.betBalance === '361000.0',
       'le suivi du serveur credite A : 361 000 $SWOGEBET (95 % de 380 000), frais 19 000');
    for (let i = 0; i < 20 && !recus.some((o) => o.type === 'betDeposit'); i++) await new Promise((r) => setTimeout(r, 100));
    ok(recus.some((o) => o.type === 'betDeposit' && o.betBalance === '361000.0'), 'A recoit « betDeposit » en direct (betBalance 361000.0)');
    ws.close();
    x = await api(jb, '/bet/deposit/' + id); tout.push(x.t);
    ok(x.status === 404, 'B ne lit toujours rien');
    /* Redemarrage : l etat du jeu garde le credit, rien n est recredite. */
    await tue(p);
    p = await lance();
    await new Promise((r) => setTimeout(r, 700));
    x = await api(ja, '/bet/deposit/' + id); tout.push(x.t);
    ok(x.j.status === 'credited' && x.j.betBalance === '361000.0', 'apres un redemarrage : toujours 361 000, rien de plus');
    R.panne = true;
    for (let i = 0; i < 3; i++) { x = await api(jb, '/bet/deposit', { origin: 'usdt_sol', amountUsd: 5 }); tout.push(x.t); }
    const avant = R.cotations.length;
    x = await api(jb, '/bet/deposit', { origin: 'usdt_sol', amountUsd: 5 }); tout.push(x.t);
    ok(x.status === 503 && R.cotations.length === avant, 'Relay en panne : 503 sur les nouvelles commandes, sans meme appeler');
    R.panne = false;
    await tue(p);
    p = await lance({ BET_DEPOT: '0' });
    x = await api(ja, '/bet/deposit'); tout.push(x.t);
    const y = await api(ja, '/bet/deposit', { origin: 'usdt_base', amountUsd: 5 }); tout.push(y.t);
    ok(x.j.available === false && y.status === 503 && /\[betdepot\] off \(.*BET_DEPOT=0/.test(traces), 'BET_DEPOT=0 : eteint, 503, et le journal de demarrage le dit');
    ok(!tout.some((t) => String(t).includes(CLE)), 'la cle Relay n apparait dans aucune reponse (' + tout.length + ' relues)');
    ok(!traces.includes(CLE) && /\[betdepot\] order b/.test(traces), 'ni dans les journaux du serveur (alors que Relay l a renvoyee dans un message d erreur)');
    ok([...R.cles].every((k) => k === CLE), 'chaque appel a Relay porte la cle en en-tete x-api-key');
    await tue(p);
  }

  R.serveur.close(); N.serveur.close();
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
