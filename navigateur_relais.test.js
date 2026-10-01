'use strict';
/* navigateur_relais.js + la route /navigateur/* de server.js (30/09/2026) : le joueur est celui de la
   SESSION, seuls les champs d un geste passent, le rythme est borne, et sans service branche l onglet
   le dit sans rien casser. */
const fs = require('fs'), path = require('path');
const R = require('./navigateur_relais');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const A = '0x' + 'a'.repeat(40);
(async () => {
  console.log('-- 1. sans service branche --');
  const vide = R.cree({ url: '', secret: '' });
  ok(!vide.actif() && (await vide.geste(A, { action: 'capture' })).code === 503, 'NAVIGATEUR_URL absent : 503 « not connected yet », rien d autre');

  console.log('\n-- 2. le relais --');
  const vus = []; let t = 1000;
  const faux = async (u, o) => { vus.push({ u, h: o.headers, b: JSON.parse(o.body) }); return { status: 200, json: async () => ({ ok: true, url: 'https://x.org/', image: 'AAA' }) }; };
  const Rl = R.cree({ url: 'http://navigateur.internal:8080/', secret: 's3cr3t', fetch: faux, maintenant: () => t });
  const r = await Rl.geste(A, { action: 'goto', url: 'https://x.org', joueur: '0x' + 'b'.repeat(40), x: 9, secret: 'x' });
  ok(r.code === 200 && vus[0].u === 'http://navigateur.internal:8080/geste' && vus[0].h['x-navigateur-secret'] === 's3cr3t', 'le geste part au service, avec le secret');
  ok(vus[0].b.joueur === A && !('x' in vus[0].b) && !('secret' in vus[0].b) && vus[0].b.url === 'https://x.org' && vus[0].b.ecran === 'bureau',
     'le joueur est celui de la session (pas celui du corps), et seuls les champs du geste passent');
  ok((await Rl.geste(A, { action: 'capture' })).code === 429, 'deux gestes a moins de ' + R.GESTE_MIN_MS + ' ms : le second attend (429)');
  t += 300;
  ok((await Rl.geste(A, { action: 'eval', code: 'x' })).code === 400, 'une action inconnue : 400');
  t += 300;
  const Rp = R.cree({ url: 'http://n', secret: 's', fetch: async () => { throw new Error('ECONNREFUSED'); }, maintenant: () => t });
  ok((await Rp.geste(A, { action: 'capture' })).code === 502, 'service injoignable : 502 lisible, pas d exception');

  console.log('\n-- 3. la route --');
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const i = srv.indexOf("if (path === '/navigateur/etat' ||"), bloc = srv.slice(i, i + 1800);
  ok(i > 0 && /sessionJoueur\.lire\(game\.sessionSecret, jeton\)/.test(bloc) && /navigateurRelais\.geste\(addr, q/.test(bloc) && !/q\.joueur|q\.addr/.test(bloc),
     'la route lit l adresse dans la session et la passe au relais ; jamais celle du corps');
  ok(/'\/navigateur\/etat'\) return json\(200, \{ ok: true, actif: navigateurRelais\.actif\(\) \}\)/.test(bloc), '/navigateur/etat dit seulement si le navigateur est branche');
  console.log('\nVERIFICATIONS : ' + n + (rates ? ' — ' + rates + ' RATE(S)' : ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
