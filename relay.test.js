'use strict';
/*
 * L'adresse de depot : ce que la porte accepte, et ce qu'elle ne dit jamais.
 *
 * ---- ce qui est verifiable ici, et ce qui ne l'est pas ----
 *
 * Le chemin heureux — une vraie adresse rendue par Relay — demande leur cle et
 * un vrai appel sortant. Ce fichier ne le simule pas : une simulation de bout
 * en bout d'un service tiers prouve surtout que la simulation est d'accord avec
 * elle-meme. Il verifie ce qui est A NOUS, et qui casse sans prevenir :
 *
 *   • la LISTE FERMEE. La route est publique — un joueur sans un jeton doit
 *     pouvoir s'en servir — donc elle use notre cle pour n'importe qui. Ce qui
 *     l'empeche de servir aux transferts d'un inconnu, c'est qu'elle refuse
 *     toute provenance, toute destination et tout montant hors liste ;
 *   • la CLE NE DESCEND JAMAIS. Ni dans une reponse, ni dans un message
 *     d'erreur. C'est le genre de fuite qu'on ne voit pas en regardant l'ecran ;
 *   • sans cle, un 503 franc — la page s'en sert pour retomber sur le lien
 *     vers relay.link plutot que d'afficher une panne.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

const CLE_ADMIN = 'cle-admin-de-test';
/* Une cle Relay reconnaissable : si elle apparait quelque part dans une
   reponse, on la verra. */
const CLE_RELAY = 'relay-SECRET-a-ne-jamais-sortir-42';
const PORT = 8800 + (process.pid % 60);
const MOI = '0x' + '11'.repeat(20);

const nes = [];
function lance(env2) {
  const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-relay-'));
  const env = Object.assign({}, process.env, {
    PORT: String(PORT), DATA_DIR: bac, ADMIN_KEY: CLE_ADMIN, RPC_URL: '',
    /* On detourne Relay vers une adresse morte : aucun appel sortant ne part
       d'un test, et le chemin heureux n'est de toute facon pas ce qu'on
       verifie ici. */
    RELAY_API: 'http://127.0.0.1:1',
  }, env2 || {});
  const p = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  nes.push(p);
  let traces = '';
  p.stdout.on('data', (d) => { traces += d; });
  p.stderr.on('data', (d) => { traces += d; });
  return new Promise((res, rej) => {
    const fin = Date.now() + 20000;
    const t = setInterval(async () => {
      if (Date.now() > fin) { clearInterval(t); return rej(new Error('pas demarre :\n' + traces)); }
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (r.status === 200 || r.status === 503) { clearInterval(t); res({ p, bac, traces: () => traces }); }
      } catch (e) {}
    }, 120);
  });
}
const arrete = (s) => { try { s.p.kill('SIGKILL'); } catch (e) {} fs.rmSync(s.bac, { recursive: true, force: true }); };
const G = (c) => fetch(`http://127.0.0.1:${PORT}${c}`);

(async () => {
  // ================================ SANS CLE : un refus franc, pas une panne
  {
    const s = await lance({ RELAY_API_KEY: '' });
    const r = await G(`/relay/depot?de=sol&vers=${MOI}&montant=1`);
    eq(r.status, 503, 'sans cle, la route repond 503 — « pas configure », pas « casse »');
    const j = await r.json();
    ok(/relay key/i.test(j.error), 'et le dit : ' + j.error);

    const l = await (await G('/relay/depuis')).json();
    eq(l.actif, false, 'la page peut demander AVANT d afficher un bouton qui echouerait');
    ok(Array.isArray(l.provenances) && l.provenances.length === 2,
       'et la liste des provenances reste lisible : ' + l.provenances.map((x) => x.cle).join(', '));

    ok(/pas de RELAY_API_KEY/.test(s.traces()),
       'le serveur le dit au demarrage plutot que de le laisser decouvrir par un bouton');
    arrete(s);
  }

  // ============================== AVEC CLE : la liste fermee tient
  {
    const s = await lance({ RELAY_API_KEY: CLE_RELAY });
    ok(/cle presente/.test(s.traces()), 'avec la cle, le demarrage le dit aussi');

    /* Les provenances hors liste. Sans ce refus, la route serait un service de
       transfert gratuit pour n'importe qui, paye avec notre cle. */
    for (const de of ['', 'doge', 'btc', 'tron', 'base', 'arb', 'op', 'sol2', '../sol', 'SOL']) {
      const r = await G(`/relay/depot?de=${encodeURIComponent(de)}&vers=${MOI}&montant=1`);
      eq(r.status, 400, `provenance « ${de} » refusee`);
    }

    /* Les destinations. Une adresse mal formee, c'est de l'argent envoye a
       personne — et c'est irrattrapable. */
    for (const vers of ['', 'moi', '0x123', MOI + 'ff', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4']) {
      const r = await G(`/relay/depot?de=sol&vers=${encodeURIComponent(vers)}&montant=1`);
      eq(r.status, 400, `destination « ${vers.slice(0, 14)} » refusee`);
    }

    /* Les montants. Trop petit, les frais mangent tout et le joueur croit
       avoir perdu ; trop grand, c'est une faute de frappe. */
    for (const m of ['', '0', '-1', 'beaucoup', '0.000001', '99999999', '1e9', '1.2345678901']) {
      const r = await G(`/relay/depot?de=sol&vers=${MOI}&montant=${encodeURIComponent(m)}`);
      eq(r.status, 400, `montant « ${m} » refuse`);
    }

    /* Un montant VALIDE va jusqu'au bout et echoue sur le reseau — l'adresse
       de Relay est detournee dans ce test. Ce qui compte : ce n'est plus 400,
       donc le filtre a bien laisse passer ce qu'il devait laisser passer. */
    {
      const r = await G(`/relay/depot?de=sol&vers=${MOI}&montant=1.5`);
      ok(r.status !== 400, `un montant valide franchit le filtre (recu ${r.status})`);
      const j = await r.json();
      ok(!/relay-SECRET/.test(JSON.stringify(j)),
         'et la cle n apparait pas dans l erreur reseau');
    }

    /* L'etat d'un envoi : meme discipline sur l'identifiant. */
    for (const id of ['', 'x', '0x', 'select 1', '0x' + 'a'.repeat(200)]) {
      const r = await G(`/relay/etat?id=${encodeURIComponent(id)}`);
      eq(r.status, 400, `identifiant « ${id.slice(0, 12)} » refuse`);
    }

    // ---------------------------------- LA CLE NE SORT NULLE PART
    const portes = [`/relay/depot?de=sol&vers=${MOI}&montant=1.5`,
                    '/relay/depuis',
                    '/relay/etat?id=0x' + 'ab'.repeat(16),
                    '/health'];
    for (const p of portes) {
      const r = await G(p);
      const corps = await r.text();
      ok(!corps.includes(CLE_RELAY), `la cle n est pas dans la reponse de ${p.split('?')[0]}`);
      let entetes = '';
      r.headers.forEach((v, k) => { entetes += k + ':' + v + '\n'; });
      ok(!entetes.includes(CLE_RELAY), `ni dans ses en-tetes`);
    }
    ok(!s.traces().includes(CLE_RELAY), 'ni dans les traces du serveur');

    arrete(s);
  }

  // ================== CE QU'ON ENVOIE VRAIMENT A RELAY
  /* Un faux Relay qui note la requete. On ne simule pas leur reponse pour
     prouver que tout marche — on regarde ce qui SORT de chez nous, qui est la
     seule moitie qu'on maitrise. */
  {
    const http = require('http');
    let vu = null;
    const faux = http.createServer((rq, rp) => {
      let corps = '';
      rq.on('data', (c) => { corps += c; });
      rq.on('end', () => {
        vu = { url: rq.url, entetes: rq.headers, corps: JSON.parse(corps || '{}') };
        rp.writeHead(200, { 'content-type': 'application/json' });
        rp.end(JSON.stringify({
          steps: [{ depositAddress: 'FaUxAdReSsE1111111111111111111111111111111',
                    requestId: '0x' + 'cd'.repeat(32) }],
          details: { currencyIn: { amountFormatted: '1.5' },
                     currencyOut: { amountFormatted: '0.0609', amountUsd: '114.3' },
                     timeEstimate: 3 },
        }));
      });
    });
    await new Promise((r) => faux.listen(8899, r));

    const s = await lance({ RELAY_API_KEY: CLE_RELAY, RELAY_API: 'http://127.0.0.1:8899' });
    const r = await G(`/relay/depot?de=sol&vers=${MOI}&montant=1.5`);
    eq(r.status, 200, 'la route rend l adresse');
    const j = await r.json();

    eq(j.adresse, 'FaUxAdReSsE1111111111111111111111111111111', 'celle que Relay a donnee');
    eq(j.symbole, 'SOL', 'avec la monnaie a envoyer');
    eq(j.recoit, '0.0609', 'et ce que le joueur recevra');
    ok(!('steps' in j) && !('details' in j),
       'on recopie les champs utiles, on ne reexpedie pas la reponse entiere');

    eq(vu.url, '/quote/v2', 'l appel part sur la bonne porte');
    eq(vu.entetes['x-api-key'], CLE_RELAY, 'la cle voyage en en-tete');
    ok(!vu.url.includes(CLE_RELAY), 'jamais dans l adresse — les adresses se retrouvent dans les journaux');
    eq(vu.corps.useDepositAddress, true, 'on demande bien une adresse de depot');
    eq(vu.corps.originChainId, 792703809, 'depuis Solana');
    eq(vu.corps.originCurrency, '11111111111111111111111111111111', 'en SOL natif');
    eq(vu.corps.amount, '1500000000', 'le montant converti en lamports, sans flottant');
    /* L'adresse de repli, sur la chaine de DEPART. Sans elle, Relay se rabat
       sur `user`, le valide contre la chaine d'origine et refuse tout ce qui
       n'est pas EVM — le defaut ne s'est vu qu'en production, parce que depuis
       Ethereum et Base l'adresse du joueur passe des deux cotes. */

    eq(vu.corps.destinationChainId, 4663, 'vers Robinhood Chain');
    eq(vu.corps.destinationCurrency, '0x0000000000000000000000000000000000000000',
       'en ETH natif — ce que le panneau sait acheter ensuite');
    eq(vu.corps.recipient, MOI, 'chez le joueur — c est `recipient` qui livre');
    eq(vu.corps.user, '11111111111111111111111111111111',
       '`user` porte le repere de la chaine de DEPART : l API le valide contre elle, ' +
       'et c est ce refus qui cassait Solana et TRON en production');
    eq(vu.corps.refundTo, '11111111111111111111111111111111',
       'le repli aussi, sur la chaine de depart');

    /* La destination est IMPOSEE : meme si l'appelant en demande une autre. */
    await G(`/relay/depot?de=eth&vers=${MOI}&montant=0.05&destinationChainId=1&destinationCurrency=0xdead`);
    eq(vu.corps.destinationChainId, 4663, 'un parametre glisse dans l adresse ne detourne pas la destination');
    eq(vu.corps.originChainId, 1, 'et Ethereum part bien d Ethereum');

    arrete(s);
    await new Promise((r) => faux.close(r));
  }

  console.log(`relay.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => {
  for (const p of nes) { try { p.kill('SIGKILL'); } catch (x) {} }
  console.error(e); process.exit(1);
});
