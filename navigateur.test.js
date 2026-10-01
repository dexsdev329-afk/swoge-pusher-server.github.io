'use strict';
/* navigateur_serveur.js : le Chromium de SWOGE Agents (30/09/2026). Ce que l'essai tient, avec un
   vrai Chromium : on navigue, on clique, on tape, on defile, on revient, et chaque geste rend une
   capture JPEG ; RIEN d'interne n'est atteint — ni en page, ni en image cachee dans une page, ni par
   redirection, ni par un schema autre que http(s) ; seul le serveur du jeu (secret) parle au service ;
   le nombre de sessions est borne. Le « site public » de l'essai ecoute sur 127.0.0.1:80 (seule
   adresse que l'essai autorise) ; l'« interne » sur 127.0.0.2:80 compte ce qu'on lui demande. */
process.env.NAVIGATEUR_SECRET = 'essai-' + Math.random().toString(36).slice(2);
process.env.NAVIGATEUR_SESSIONS_MAX = '2';
const http = require('http');
const navigue = require('./navigue');
const NS = require('./navigateur_serveur');
let pw = null; try { pw = require('playwright'); } catch (e) {}
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const J1 = '0x' + '1'.repeat(40), J2 = '0x' + '2'.repeat(40), J3 = '0x' + '3'.repeat(40);

(async () => {
  if (!pw) { console.log('playwright absent : essai ignore'); return fin(); }
  let interne = 0;
  const secret = http.createServer((q, r) => { interne++; console.log('   [interne] ' + q.method + ' ' + q.url + ' via ' + (q.headers['proxy-connection'] ? 'proxy' : 'direct')); r.end('SECRET'); });
  let videos = 0;
  const site = http.createServer((q, r) => {
    const html = (b) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html><head><title>' + q.url + '</title></head><body style="margin:0;height:3000px">' + b + '</body></html>'); };
    if (q.url === '/') return html('<a id="l" href="/deux" style="position:absolute;left:100px;top:100px;width:200px;height:50px;display:block;background:#09f">next</a>'
      + '<input id="i" style="position:absolute;left:100px;top:300px;width:300px;height:40px" oninput="document.title=this.value">');
    if (q.url === '/deux') return html('<h1>deux</h1>');
    /* 01/10 : ce que la page voit de qui la visite (agent, webdriver), et un flux video. */
    if (q.url === '/qui') return html('<script>document.title = navigator.userAgent + "|" + navigator.webdriver;</script>');
    if (q.url === '/film') return html('<video src="/v.mp4" autoplay muted></video><audio src="/a.mp3" autoplay></audio>');
    if (q.url === '/v.mp4' || q.url === '/a.mp3') { videos++; r.writeHead(200, { 'content-type': 'video/mp4' }); return r.end(Buffer.alloc(2000)); }
    if (q.url === '/cache') return html('<img src="http://127.0.0.2/secret.png"><script>fetch("http://127.0.0.2/fuite").catch(()=>{});var w=new WebSocket("ws://127.0.0.2/ws");</script>');
    if (q.url === '/redir') { r.writeHead(302, { location: 'http://127.0.0.2/secret' }); return r.end(); }
    if (q.url === '/popup') return html('<a id="p" href="/deux" target="_blank" style="position:absolute;left:0;top:0;width:300px;height:100px;display:block">open</a>');
    r.writeHead(404); r.end();
  });
  let pret = true;
  await new Promise((s) => site.listen(80, '127.0.0.1', s).on('error', () => { pret = false; s(); }));
  await new Promise((s) => secret.listen(80, '127.0.0.2', s).on('error', () => { pret = false; s(); }));
  if (!pret) { console.log('ports 80 indisponibles : essai ignore'); return fin(); }
  navigue._permetLocal(true);   /* 127.0.0.1 et lui seul */
  const mand = await NS.lance(pw);
  const srv = NS.creeServeur(); await new Promise((s) => srv.listen(0, '127.0.0.1', s));
  const B = 'http://127.0.0.1:' + srv.address().port;
  const appel = async (chemin, corps, secretOk) => {
    const r = await fetch(B + chemin, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, secretOk === false ? {} : { 'x-navigateur-secret': process.env.NAVIGATEUR_SECRET }), body: JSON.stringify(corps) });
    return Object.assign({ code: r.status }, await r.json());
  };

  console.log('-- 1. seul le serveur du jeu parle au navigateur --');
  ok((await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/' }, false)).code === 401, 'sans le secret : 401, rien n est ouvert');
  ok((await appel('/geste', { joueur: 'moi', action: 'capture' })).code === 400, 'un joueur qui n est pas une adresse : refuse');

  console.log('\n-- 2. naviguer, voir, cliquer, taper, defiler, revenir --');
  let r = await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/' });
  const jpeg = r.image ? Buffer.from(r.image, 'base64') : Buffer.alloc(0);
  ok(r.ok && r.url === 'http://127.0.0.1/' && jpeg[0] === 0xff && jpeg[1] === 0xd8 && r.ecran.width === 1280, 'la page s ouvre et revient en capture JPEG 1280 × 800 (' + jpeg.length + ' octets)');
  r = await appel('/geste', { joueur: J1, action: 'clic', x: 150, y: 120 });
  ok(r.url === 'http://127.0.0.1/deux', 'un clic sur le lien, aux coordonnees de la capture, suit le lien');
  r = await appel('/geste', { joueur: J1, action: 'retour' });
  ok(r.url === 'http://127.0.0.1/', 'retour : la page precedente');
  await appel('/geste', { joueur: J1, action: 'clic', x: 150, y: 320 });
  r = await appel('/geste', { joueur: J1, action: 'tape', texte: 'hello swoge' });
  ok(r.titre === 'hello swoge', 'cliquer dans un champ puis taper : le texte arrive dans la page');
  ok((await appel('/geste', { joueur: J1, action: 'touche', touche: 'F12' })).note === 'this key is not allowed', 'seules les touches de navigation passent');
  r = await appel('/geste', { joueur: J1, action: 'defile', dy: 800 });
  ok(r.ok && !!r.image, 'defiler rend la nouvelle vue');
  ok((await appel('/geste', { joueur: J1, action: 'clic', x: 5000, y: 10 })).note === 'click outside the page', 'un clic hors de la fenetre est refuse');

  /* 01/10 : « plein de verifications pour voir si on est pas un bot ». */
  r = await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/qui' });
  const [ua, wd] = String(r.titre || '').split('|');
  ok(/Chrome\/\d+\.0\.0\.0/.test(ua) && !/Headless/i.test(ua) && wd === 'false', 'le site visite voit un Chrome ordinaire : pas de « HeadlessChrome », webdriver faux [' + r.titre + ']');
  await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/film' });
  ok(videos === 0, 'les flux audio et video ne se chargent pas : une capture n en montre qu une image (' + videos + ' requete)');
  ok(NS.MESURE.msMax > 0 && NS.MESURE.msTotal >= NS.MESURE.msMax, 'la duree de chaque geste est mesuree (max ' + NS.MESURE.msMax + ' ms)');

  console.log('\n-- 3. rien d interne, jamais --');
  const avant = interne;
  r = await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.2/secret' });
  ok(/only public websites/.test(r.note || '') || /public internet/.test(r.note || ''), 'ouvrir une adresse interne : refuse, et dit [' + r.note + ']');
  r = await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/cache' });
  await new Promise((s) => setTimeout(s, 800));
  r = await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/redir' });
  ok(interne === avant, 'une image, un fetch, une WebSocket ou une redirection vers l interieur n atteignent rien (' + (interne - avant) + ' requete)');
  for (const u of ['file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'chrome://version', 'http://127.0.0.1:8080/'])
    ok(!!(await appel('/geste', { joueur: J1, action: 'goto', url: u })).note, u + ' : refuse');
  r = await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/popup' });
  r = await appel('/geste', { joueur: J1, action: 'clic', x: 50, y: 50 });
  await new Promise((s) => setTimeout(s, 800));
  r = await appel('/geste', { joueur: J1, action: 'capture' });
  ok(r.url === 'http://127.0.0.1/deux' && NS.SESSIONS.get(J1).ctx.pages().length === 1, 'une fenetre surgissante devient la page courante : un seul onglet');

  console.log('\n-- 4. bornes : sessions, telephone, fermeture --');
  r = await appel('/geste', { joueur: J2, action: 'goto', url: 'http://127.0.0.1/', ecran: 'telephone' });
  ok(r.ok && r.ecran.width === 390, 'un deuxieme joueur, en ecran telephone (390 px)');
  r = await appel('/geste', { joueur: J3, action: 'capture' });
  ok(r.code === 503 && /busy/.test(r.raison), 'un troisieme au-dela de NAVIGATEUR_SESSIONS_MAX=2 : 503, « busy »');
  await appel('/ferme', { joueur: J2 });
  ok(!NS.SESSIONS.has(J2) && (await appel('/geste', { joueur: J3, action: 'capture' })).ok, 'une session fermee libere sa place');
  const sante = await (await fetch(B + '/sante')).json();
  ok(sante.ok && sante.max === 2 && !('image' in sante), '/sante dit l etat sans secret, et rien d un joueur');

  for (const j of [J1, J2, J3]) await NS.ferme(j);
  const { navigateur } = NS._etat(); await navigateur.close();
  srv.close(); mand.close(); site.close(); secret.close();
  fin();
})().catch((e) => { console.error(e); process.exit(1); });

function fin() { console.log('\nVERIFICATIONS : ' + n + (rates ? ' — ' + rates + ' RATE(S)' : ' — tout passe')); process.exit(rates ? 1 : 0); }
