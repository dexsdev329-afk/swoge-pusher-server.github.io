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

  console.log('\n-- 2 bis. le diagnostic : un code, jamais l adresse --');
  const enPanne = R.cree({ url: 'http://navigateur.railway.internal:8080', secret: 's', fetch: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }, maintenant: () => t });
  const d = await enPanne.sante();
  ok(d.joignable === false && d.code === 'ENOTFOUND' && !JSON.stringify(d).includes('railway.internal'), 'nom introuvable : ENOTFOUND, sans l adresse');
  t += 300;
  ok(/\(ENOTFOUND\)/.test((await enPanne.geste(A, { action: 'capture' })).corps.raison), 'le message du geste porte le code');
  const enForme = R.cree({ url: 'http://n', secret: 's', fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sessions: 1, max: 3 }) }), maintenant: () => t });
  const d2 = await enForme.sante();
  ok(d2.joignable && d2.pret && d2.max === 3 && (await vide.sante()).code === 'NOT_CONFIGURED', 'joignable et pret : dit ; pas configure : dit');

  console.log('\n-- 2 ter. le flux d images (02/10) --');
  const vusF = []; let lacher = null;
  const fauxF = async (u, o) => { vusF.push({ u, b: JSON.parse(o.body) }); if (lacher === 'attend') await new Promise((s) => setTimeout(s, 50));
    return { status: 200, json: async () => ({ ok: true, seq: 3, image: 'BBB', url: 'https://x.org/' }) }; };
  const Rf = R.cree({ url: 'http://n', secret: 's', fetch: fauxF, maintenant: () => t });
  const ri = await Rf.image(A, { apres: 2, attente: 99999, joueur: '0x' + 'b'.repeat(40) });
  ok(ri.code === 200 && vusF[0].u === 'http://n/image' && vusF[0].b.joueur === A && vusF[0].b.attente === 10000 && !('x' in vusF[0].b),
     'l image est demandee pour le joueur de la SESSION, attente bornee a 10 s');
  lacher = 'attend';
  const trois = await Promise.all([Rf.image(A, {}), Rf.image(A, {}), Rf.image(A, {})]);
  ok(trois.filter((x) => x.code === 429).length === 1, 'deux demandes en vol au plus par joueur : la troisieme attend (429)');
  t += 300;
  await Rf.geste(A, { action: 'clic', x: 1, y: 2, flux: true });
  ok(vusF[vusF.length - 1].b.flux === true, 'le geste dit au service que le client recoit le flux');
  const enFormeF = R.cree({ url: 'http://n', secret: 's', fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sessions: 1, max: 3,
    mesure: { gestes: 4, msTotal: 2000, images: 9, dnsCache: 5, parAction: { 'flux:clic': { n: 2, ms: 300, max: 200 } }, derniereErreur: 'https://secret.example/page' } }) }), maintenant: () => t });
  const dF = await enFormeF.sante();
  ok(dF.mesure && dF.mesure.msMoyen === 500 && dF.mesure.parAction['flux:clic'].msMoyen === 150 && !JSON.stringify(dF).includes('secret.example'),
     'le diagnostic porte les durees par action, jamais la derniere erreur ni une adresse');

  console.log('\n-- 2 quater. le ticket de la liaison directe (02/10) --');
  const Dt = require('./navigateur_direct');
  ok(R.cree({ url: 'http://n', secret: 's', publique: '' }).ticket(A).code === 404, 'sans adresse publique du navigateur : pas de ticket, la page reste sur le relais');
  const Rt = R.cree({ url: 'http://n', secret: 's3cr3t', publique: 'https://nav.example/', maintenant: () => Date.now() });
  const tt = Rt.ticket(A);
  ok(tt.code === 200 && tt.corps.url === 'https://nav.example' && Dt.verifie('s3cr3t', tt.corps.ticket) === A && tt.corps.dureeMs === Dt.DUREE_MS,
     'le ticket porte l adresse de la session, signe avec le secret partage, et l adresse publique du navigateur');
  ok(!JSON.stringify(tt.corps).includes('s3cr3t'), 'le secret ne part jamais dans la reponse');
  ok(Rt.ticket('pas-une-adresse').code === 400, 'pas d adresse de joueur : pas de ticket');

  console.log('\n-- 3. la route --');
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  /* Le bloc entier de la route, jusqu'a la suivante (le pilote) — et non 1 800 caracteres fixes. */
  const i = srv.indexOf("if (path === '/navigateur/etat' ||"), bloc = srv.slice(i, srv.indexOf("if (path === '/navigateur/pilote' ||", i));
  ok(i > 0 && /sessionJoueur\.lire\(game\.sessionSecret, jeton\)/.test(bloc) && /navigateurRelais\.geste\(addr, q/.test(bloc) && !/q\.joueur|q\.addr/.test(bloc),
     'la route lit l adresse dans la session et la passe au relais ; jamais celle du corps');
  ok(/'\/navigateur\/ticket' \? navigateurRelais\.ticket\(addr\)/.test(bloc), '/navigateur/ticket : le ticket est fait pour l adresse de la session, apres la verification de session');
  ok(/'\/navigateur\/image'/.test(bloc) && /navigateurRelais\.image\(addr, q/.test(bloc), '/navigateur/image passe par la meme session, la meme adresse');
  /* 02/10 : la mesure du pilote s'y ajoute (navigateur_pilote.js) — des compteurs, sans adresse. */
  ok(/'\/navigateur\/etat'\) return json\(200, Object\.assign\(\{ ok: true, actif: navigateurRelais\.actif\(\) \}, await navigateurRelais\.sante\(\)(, \{ pilote: pilote\.mesure\(\) \})?\)\)/.test(bloc), '/navigateur/etat dit si le navigateur est branche, et s il repond');
  console.log('\nVERIFICATIONS : ' + n + (rates ? ' — ' + rates + ' RATE(S)' : ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
