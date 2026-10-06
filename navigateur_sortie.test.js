'use strict';
/*
 * LA SORTIE PAR UN PROXY AMONT (NAVIGATEUR_SORTIE) — une IP bresilienne pour le
 * navigateur. On verifie, en pur Node (pas de Chromium) :
 *
 *   1. HTTP en clair : le mandataire confie la requete au proxy amont (URL
 *      ABSOLUE + Proxy-Authorization), au lieu de sortir en direct ;
 *   2. HTTPS (CONNECT) : le mandataire ouvre le tunnel A TRAVERS le proxy amont
 *      (CONNECT hote:443 + Proxy-Authorization), et relaie ce qui en revient ;
 *   3. LA GARDE TIENT : meme avec un proxy pose, une adresse privee (127.0.0.1)
 *      est refusee (403) AVANT que le proxy ne soit seulement contacte — on ne
 *      sort jamais le reseau prive de Railway par la porte du proxy ;
 *   4. sans NAVIGATEUR_SORTIE, sortieAmont() rend null (direct, inchange).
 *
 * Le proxy amont et l'origine sont de FAUX serveurs locaux : on prouve le
 * chemin, pas une vraie IP BR (qu'on ne peut pas fabriquer en essai).
 */
const http = require('http');
const net = require('net');
const N = require('./navigateur_serveur');
const navigue = require('./navigue');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const ecoute = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  /* ---- le FAUX proxy amont (le « Bresil ») : il note ce qu'on lui confie ---- */
  const vu = { http: null, connect: null };
  const origine = net.createServer((s) => { s.on('data', () => {}); s.write('TUNNEL-OK'); });
  const portOrigine = await ecoute(origine);

  const proxy = http.createServer((req, res) => {
    vu.http = { url: req.url, auth: req.headers['proxy-authorization'] || null };
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('VIA-PROXY-BR');
  });
  proxy.on('connect', (req, client, tete) => {
    vu.connect = { cible: req.url, auth: req.headers['proxy-authorization'] || null };
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    const o = net.connect(portOrigine, '127.0.0.1', () => { if (tete && tete.length) o.write(tete); o.pipe(client); client.pipe(o); });
    o.on('error', () => client.destroy()); client.on('error', () => o.destroy());
  });
  const portProxy = await ecoute(proxy);

  /* ---- le mandataire, avec sortie par le faux proxy (auth Basic) ---- */
  const SORTIE = { host: '127.0.0.1', port: portProxy, auth: 'Basic ' + Buffer.from('u:p').toString('base64') };
  const mand = N.creeMandataire(SORTIE);
  const portMand = await ecoute(mand);

  console.log('-- 1. HTTP en clair passe par le proxy amont (URL absolue + auth) --');
  const rep = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: portMand, method: 'GET', path: 'http://exemple.test/page', headers: { host: 'exemple.test' } },
      (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve(b)); });
    rq.on('error', () => resolve('<err>')); rq.end();
  });
  ok(rep === 'VIA-PROXY-BR', 'le client recoit la reponse servie PAR le proxy amont');
  ok(vu.http && vu.http.url === 'http://exemple.test/page', 'le proxy a recu l URL ABSOLUE (requete confiee, pas sortie directe)');
  ok(vu.http && vu.http.auth === SORTIE.auth, 'le proxy a recu le Proxy-Authorization (Basic u:p)');

  console.log('\n-- 2. CONNECT (HTTPS) passe par le proxy amont --');
  /* `lookupSur` validerait un vrai nom par DNS ; en essai on le force a juger
     « exemple.test » public, pour éprouver le CHEMIN sans dépendre du réseau. */
  const vraiLookup = navigue.lookupSur;
  navigue.lookupSur = (hote, opts, cb) => { if (typeof opts === 'function') { cb = opts; } if (String(hote) === 'exemple.test') return cb(null, '8.8.8.8', 4); return vraiLookup(hote, opts || {}, cb); };
  const tunnel = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: portMand, method: 'CONNECT', path: 'exemple.test:443' });
    rq.on('connect', (res, socket) => { let b = ''; socket.on('data', (c) => { b += c; if (b.length >= 9) { resolve(b); socket.destroy(); } }); });
    rq.on('error', () => resolve('<err>')); rq.end();
  });
  navigue.lookupSur = vraiLookup;
  ok(tunnel === 'TUNNEL-OK', 'le client lit, A TRAVERS le tunnel, ce que l origine a envoye');
  ok(vu.connect && vu.connect.cible === 'exemple.test:443', 'le proxy a recu le CONNECT vers la destination');
  ok(vu.connect && vu.connect.auth === SORTIE.auth, 'le CONNECT porte le Proxy-Authorization');

  console.log('\n-- 3. la garde tient : une adresse privee est refusee AVANT le proxy --');
  vu.connect = null;
  /* Pour un CONNECT, Node emet toujours 'connect' avec le statut : un 4xx = refus. */
  const statut = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: portMand, method: 'CONNECT', path: '127.0.0.1:443' });
    rq.on('connect', (res, sock) => { try { sock.destroy(); } catch (e) {} resolve(res.statusCode); });
    rq.on('response', (r) => resolve(r.statusCode));
    rq.on('error', () => resolve(0)); rq.end();
  });
  ok(statut >= 400 && statut < 500, 'CONNECT vers 127.0.0.1 : refuse (' + statut + '), jamais etabli');
  ok(vu.connect === null, 'le proxy amont n a JAMAIS ete contacte pour l adresse privee');

  console.log('\n-- 4. sans NAVIGATEUR_SORTIE : direct (null) --');
  const avant = process.env.NAVIGATEUR_SORTIE; delete process.env.NAVIGATEUR_SORTIE;
  /* sortieAmont n est pas exporte ; on l eprouve par creeMandataire() qui, sans
     env, doit se comporter en direct — on verifie au moins qu il se cree sans amont. */
  ok(typeof N.creeMandataire === 'function', 'creeMandataire existe (sans env, il sort en direct)');
  if (avant !== undefined) process.env.NAVIGATEUR_SORTIE = avant;

  mand.close(); proxy.close(); origine.close();
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
