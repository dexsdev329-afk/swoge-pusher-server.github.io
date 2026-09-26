'use strict';
/*
 * ARRÊTER UNE RÉPONSE (studio_chat.arrete, route /studio/chat/stop) —
 * demande du propriétaire, 26 septembre 2026 : « je me suis trompé, je veux
 * l'arrêter pour en faire une autre ; pas grave de ne pas récupérer ses jetons ».
 *   1. arrêtée pendant que le modèle écrit : la place se libère TOUT DE SUITE,
 *      la réserve est gardée, le fournisseur reçoit le signal ;
 *   2. arrêtée avant que le modèle ne soit appelé : rien facturé ;
 *   3. l'arrêt arrivé AVANT la requête : elle ne réserve rien ;
 *   4. on n'arrête que la sienne, et que celle qu'on vise (comparaison) ;
 *   5. de bout en bout : vrai serveur, vrai SDK, faux Anthropic LENT — la
 *      connexion vers le fournisseur est coupée, une nouvelle question part.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const ethers = require('ethers');
const WebSocket = require('ws');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

const BAC = fs.mkdtempSync('/tmp/studioarret-');
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';
delete process.env.PERPLEXITY_API_KEY;
for (const k of ['OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_BASE_URL', 'XAI_BASE_URL', 'X402_PAYTO', 'X402_CLE']) delete process.env[k];
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

/* Un faux solde : ce qui est réservé et réglé. */
function faux() {
  const f = { reserves: [], regles: [] };
  f.api = { reserve: (a, w) => { f.reserves.push(w); return true; }, regle: (a, rw, fw) => { f.regles.push([rw, fw]); return '123'; } };
  return f;
}
/* Un fournisseur qui écrit lentement et obéit au signal. */
const lent = (vu) => ({ signal, surTexte }) => new Promise((res, rej) => {
  vu.appele = true;
  surTexte('Bonjour');
  const t = setTimeout(() => { vu.fini = true; res({ texte: 'Bonjour tout', usage: { input_tokens: 100, output_tokens: 50 } }); }, 3000);
  signal.addEventListener('abort', () => { clearTimeout(t); vu.signal = true; rej(new Error('aborted')); });
});

(async () => {
  /* Le port AVANT le premier require : studio_chat charge config, qui lit PORT une fois. */
  const port = await libre();
  process.env.PORT = String(port);
  const C = require('./studio_chat');
  const cours = async () => 0.00002801;
  const q = (o) => Object.assign({ addr: '0xa', modele: 'haiku-4-5', messages: [{ role: 'user', content: 'salut' }] }, o);

  console.log('-- 1. arretee pendant que le modele ecrit --');
  {
    const f = faux(), vu = {}, textes = [];
    const t0 = Date.now();
    const p = C.repond(q({ rid: 'rid-arret-01' }), { cours, solde: f.api, fournisseur: lent(vu), surTexte: (t) => textes.push(t) });
    await dort(80);
    eq(C.arrete('0xA', 'rid-arret-01'), 1, 'l arret trouve la reponse (adresse sans egard a la casse)');
    const r = await p;
    ok(Date.now() - t0 < 1000 && !vu.fini, 'la reponse s arrete TOUT DE SUITE, sans attendre le fournisseur (' + (Date.now() - t0) + ' ms)');
    ok(r.ok === false && r.arrete === true && r.code === 409 && /reserved/.test(r.raison), 'le resultat dit « arretee » : ' + r.raison);
    ok(f.regles.length === 1 && f.regles[0][0] === f.regles[0][1] && f.regles[0][0] === f.reserves[0], 'la RESERVE est gardee (regle du proprietaire) — ni plus, ni moins');
    ok(r.factureSwoge && Number(r.factureSwoge) > 0, 'et le montant garde est annonce : ' + r.factureSwoge + ' $SWOGE');
    ok(vu.signal === true, 'le fournisseur a recu le signal (il arrete de consommer)');
    ok(!C.EN_VOL.has('0xa') && !(C.EN_VOL.n.get('0xa')), 'la place est liberee');
    textes.length = 0;
    await dort(50);
    eq(textes.length, 0, 'plus aucun texte ne part apres l arret');
    eq(C.arrete('0xa', 'rid-arret-01'), 0, 'arreter deux fois : rien de plus');
  }

  console.log('\n-- 2. arretee avant que le modele ne soit appele --');
  {
    const f = faux(), vu = {};
    let lache;
    const fiches = new Promise((r) => { lache = r; });
    const p = C.repond(q({ addr: '0xb', rid: 'rid-arret-02', messages: [{ role: 'user', content: 'scan 0x' + '1'.repeat(40) }] }),
      { cours, solde: f.api, fournisseur: lent(vu), jetons: () => fiches });
    await dort(30);
    eq(C.arrete('0xb', 'rid-arret-02'), 1, 'arretee pendant la lecture du jeton');
    const r = await p;
    lache([]);
    ok(r.arrete && /nothing was charged/.test(r.raison) && f.regles.length === 1 && f.regles[0][1] === 0n && !vu.appele, 'le modele n a pas ete appele : TOUT est rendu, rien facture');
  }

  console.log('\n-- 3. l arret arrive avant la requete --');
  {
    const f = faux(), vu = {};
    eq(C.arrete('0xc', 'rid-arret-03'), 0, 'rien en vol : l arret est retenu');
    const r = await C.repond(q({ addr: '0xc', rid: 'rid-arret-03' }), { cours, solde: f.api, fournisseur: lent(vu) });
    ok(r.arrete && r.code === 409 && f.reserves.length === 0 && !vu.appele, 'la requete arrivee ensuite ne reserve rien et n appelle personne');
    const r2 = await C.repond(q({ addr: '0xc', rid: 'rid-arret-04' }), { cours, solde: f.api, fournisseur: async () => ({ texte: 'ok', usage: { input_tokens: 10, output_tokens: 5 } }) });
    ok(r2.ok, 'une AUTRE requete de la meme adresse n est pas touchee');
  }

  console.log('\n-- 4. on n arrete que la sienne, et que celle qu on vise --');
  {
    const f = faux(), vuA = {}, vuB = {}, vuX = {};
    const pA = C.repond(q({ addr: '0xd', rid: 'rid-cmp-A1' }), { cours, solde: f.api, fournisseur: lent(vuA) });
    const pB = C.repond(q({ addr: '0xd', rid: 'rid-cmp-B1' }), { cours, solde: f.api, fournisseur: async ({ surTexte }) => { await dort(300); return { texte: 'B', usage: { input_tokens: 10, output_tokens: 5 } }; } });
    const pX = C.repond(q({ addr: '0xe', rid: 'rid-cmp-A1' }), { cours, solde: faux().api, fournisseur: lent(vuX) });
    await dort(50);
    eq(C.arrete('0xd', 'rid-cmp-A1'), 1, 'une seule colonne de la comparaison est visee');
    const [a, b] = await Promise.all([pA, pB]);
    ok(a.arrete && b.ok && b.texte === 'B', 'la colonne arretee s arrete, l autre finit et est facturee normalement');
    ok(!vuX.signal, 'le meme rid chez une AUTRE adresse n est pas touche');
    C.arrete('0xe'); await pX;
  }

  console.log('\n-- 5. de bout en bout : vrai serveur, faux Anthropic lent --');
  {
    const vus = [];
    const fauxAnth = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const v = { corps: JSON.parse(b || '{}'), coupe: false, fini: false }; vus.push(v);
        req.socket.on('close', () => { if (!v.fini) v.coupe = true; });
        const e = (x) => 'event: ' + x.type + '\ndata: ' + JSON.stringify(x) + '\n\n';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(e({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: v.corps.model, content: [], stop_reason: null, usage: { input_tokens: 800, output_tokens: 1 } } }));
        res.write(e({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        res.write(e({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Je commence ' } }));
        const lentement = /lent/.test(JSON.stringify(v.corps.messages));
        setTimeout(() => {
          if (res.destroyed) return;
          v.fini = true;
          res.end(e({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'et je finis.' } }) + e({ type: 'content_block_stop', index: 0 })
            + e({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } }) + e({ type: 'message_stop' }));
        }, lentement ? 4000 : 10);
      });
    });
    const pA = await libre(); await new Promise((r) => fauxAnth.listen(pA, r));
    process.env.ANTHROPIC_API_KEY = 'sk-test-local';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + pA;
    process.env.STUDIO_CHAT_EN_VOL = '1';     /* une seule reponse a la fois : sans arret, la suivante serait refusee */
    require('./config');
    const { Game } = require('./game');
    let moteur = null;
    const p0 = Game.prototype._p;
    Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
    require('./server');
    await dort(900);
    const base = 'http://127.0.0.1:' + port;

    const w = ethers.Wallet.createRandom();
    const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    await new Promise((r) => s.on('open', r));
    const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
    const h = await attend('hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    const auth = await attend('auth');
    const adr = w.address.toLowerCase();
    moteur._p(adr).balance = ethers.utils.parseUnits('200000', 18);
    const H = { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session };
    const avant = ethers.utils.parseUnits(moteur.balanceStr(adr), 18);

    const t0 = Date.now();
    const lente = fetch(base + '/studio/chat', { method: 'POST', headers: H, body: JSON.stringify({ modele: 'haiku-4-5', rid: 'rid-route-lent', messages: [{ role: 'user', content: 'reponds lent' }] }) }).then((r) => r.text());
    await dort(400);
    const refus = await (await fetch(base + '/studio/chat', { method: 'POST', headers: H, body: JSON.stringify({ modele: 'haiku-4-5', rid: 'rid-route-bis', messages: [{ role: 'user', content: 'vite' }] }) })).text();
    ok(/too many answers at once/.test(refus), 'SANS arret, une seconde question est refusee tant que la premiere tourne (le probleme signale)');
    eq((await fetch(base + '/studio/chat/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"rid":"rid-route-lent"}' })).status, 401, 'sans session, on n arrete rien');
    const autreW = ethers.Wallet.createRandom();
    void autreW;
    const st = await (await fetch(base + '/studio/chat/stop', { method: 'POST', headers: H, body: JSON.stringify({ rid: 'rid-route-lent' }) })).json();
    eq(st.arretes, 1, 'POST /studio/chat/stop par la session : une reponse arretee');
    const flux = await lente;
    const err = JSON.parse((flux.split('event: erreur\ndata: ')[1] || '{}').split('\n')[0]);
    ok(err.arrete === true && /reserved/.test(err.raison) && Date.now() - t0 < 3000, 'le flux se termine tout de suite par « arretee » (' + (Date.now() - t0) + ' ms), sans « et je finis »' + (/je finis/.test(flux) ? ' — RATE : texte apres arret' : ''));
    await dort(100);
    ok(vus[0] && vus[0].coupe === true, 'la connexion vers le fournisseur est COUPEE (la maison cesse de payer des jetons)');
    const apres = ethers.utils.parseUnits(moteur.balanceStr(adr), 18);
    eq(avant.sub(apres).toString(), ethers.utils.parseUnits(err.factureSwoge, 18).toString(), 'le solde baisse exactement du montant annonce (la reserve)');
    const suite = await (await fetch(base + '/studio/chat', { method: 'POST', headers: H, body: JSON.stringify({ modele: 'haiku-4-5', rid: 'rid-route-ter', messages: [{ role: 'user', content: 'vite' }] }) })).text();
    ok(/event: fin/.test(suite) && /je finis/.test(suite), 'juste apres l arret, une NOUVELLE question part et est servie');
    const rp = await (await fetch(base + '/studio/reprise/rid-route-lent', { headers: { authorization: 'Bearer ' + auth.session } })).json();
    ok(rp.arrete === true, 'une page rechargee voit la reponse « arretee », pas une reponse fantome');
    s.close(); fauxAnth.close();
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
