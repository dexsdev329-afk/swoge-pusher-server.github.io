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

  /* ---- 5. LE FLUX (02/10/2026) ----
     « Le navigateur est vraiment lent » : la machine n y etait pour rien (1,3 % d un processeur
     au pire sur 24 h). C etait la forme de l echange — attendre le chargement, capturer, renvoyer,
     redemander. Le flux d images de Chromium arrive des que la page se repeint. */
  console.log('\n-- 5. le flux d images, et des gestes qui n attendent plus --');
  for (const j of [J1, J2, J3]) await NS.ferme(j);
  ok((await appel('/image', { joueur: J1, apres: 0 })).code === 404, 'sans session ouverte : rien a montrer (404), aucune session creee');
  /* L ancien geste, pour comparer : il attend le chargement et capture. */
  let t0 = Date.now();
  await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/' });
  await appel('/geste', { joueur: J1, action: 'clic', x: 150, y: 120 });
  const msAncien = Date.now() - t0;
  await appel('/geste', { joueur: J1, action: 'retour' });
  let im = await appel('/image', { joueur: J1, apres: 0, attente: 2000 });
  const j0 = im.image ? Buffer.from(im.image, 'base64') : Buffer.alloc(0);
  ok(im.ok && im.seq >= 1 && j0[0] === 0xff && j0[1] === 0xd8 && im.url === 'http://127.0.0.1/', 'la premiere image arrive tout de suite, en JPEG, avec l adresse de la page (seq ' + im.seq + ')');
  const vide = await appel('/image', { joueur: J1, apres: im.seq, attente: 600 });
  ok(vide.ok && vide.image === null && vide.seq === im.seq, 'une page immobile ne renvoie rien de neuf : la longue attente se termine sans image');
  t0 = Date.now();
  r = await appel('/geste', { joueur: J1, action: 'clic', x: 150, y: 120, flux: true });
  const msClic = Date.now() - t0;
  ok(r.ok && r.image === null, 'en flux, le geste ne capture plus : il rend la main (' + msClic + ' ms)');
  let vu = null;
  for (let k = 0; k < 10 && !(vu && vu.url === 'http://127.0.0.1/deux' && vu.image); k++) vu = await appel('/image', { joueur: J1, apres: im.seq, attente: 3000 });
  ok(vu && vu.url === 'http://127.0.0.1/deux' && vu.seq > im.seq && !!vu.image, 'et l image suivante montre la page ou le clic a mene (seq ' + (vu && vu.seq) + ')');
  t0 = Date.now();
  await appel('/geste', { joueur: J1, action: 'goto', url: 'http://127.0.0.1/', flux: true });
  await appel('/geste', { joueur: J1, action: 'clic', x: 150, y: 120, flux: true });
  const msFlux = Date.now() - t0;
  console.log('   ouvrir + cliquer : ' + msAncien + ' ms en attendant les captures, ' + msFlux + ' ms en flux');
  ok(msFlux < msAncien, 'ouvrir une page et cliquer rend la main plus tot en flux (' + msFlux + ' contre ' + msAncien + ' ms)');
  r = await appel('/geste', { joueur: J1, action: 'capture', flux: true });
  ok(!!r.image, '« capture » rend toujours une image nette : c est elle que « Screen » envoie');
  ok(NS.MESURE.images > 0 && NS.MESURE.parAction['flux:clic'] && NS.MESURE.parAction['flux:clic'].n >= 1, 'les images et la duree de chaque geste, par action, sont comptees');
  ok(NS.MESURE.dnsCache > 0, 'le mandataire resout un nom une fois, puis le relit en cache (' + NS.MESURE.dnsCache + ' fois)');
  const att = appel('/image', { joueur: J1, apres: 1e9, attente: 8000 });
  await new Promise((s) => setTimeout(s, 200));
  await NS.ferme(J1);
  const fini = await att;
  ok(fini.ok === true && fini.image === null, 'fermer la session libere une longue attente en cours, sans erreur');
  const sante2 = await (await fetch(B + '/sante')).json();
  ok(sante2.mesure && sante2.mesure.parAction && !JSON.stringify(sante2).includes('127.0.0.1/'), '/sante porte les durees, jamais une adresse visitee');

  console.log('\n-- 6. la liaison directe (02/10) : un ticket signe, jamais une adresse du corps --');
  for (const j of [J1, J2, J3]) await NS.ferme(j);
  const D = require('./navigateur_direct');
  const S = process.env.NAVIGATEUR_SECRET;
  const pub = async (chemin, corps, tk) => {
    const rr = await fetch(B + chemin, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, tk ? { authorization: 'Ticket ' + tk } : {}), body: JSON.stringify(corps) });
    return Object.assign({ code: rr.status, cors: rr.headers.get('access-control-allow-origin') }, await rr.json().catch(() => ({})));
  };
  const tk = D.signe(S, J1).ticket;
  ok((await pub('/p/geste', { action: 'capture' })).code === 401, 'sans ticket : 401');
  ok((await pub('/p/geste', { action: 'capture' }, D.signe('un-autre-secret', J1).ticket)).code === 401, 'un ticket signe avec un autre secret : 401');
  ok((await pub('/p/geste', { action: 'capture' }, D.signe(S, J1, Date.now() - D.DUREE_MS - 1000).ticket)).code === 401, 'un ticket echu : 401');
  ok((await pub('/p/geste', { action: 'capture' }, tk.replace(J1, J2))).code === 401, 'un ticket dont on a change l adresse : 401');
  ok((await pub('/p/geste', { action: 'capture' }, 'x-navigateur-secret')).code === 401 && NS.SESSIONS.size === 0, 'aucun refus n ouvre de session');
  const pre = await fetch(B + '/p/geste', { method: 'OPTIONS' });
  ok(pre.status === 204 && /authorization/.test(pre.headers.get('access-control-allow-headers') || ''), 'la page peut appeler depuis le site (CORS, en-tete authorization)');
  r = await pub('/p/geste', { joueur: J2, action: 'goto', url: 'http://127.0.0.1/', flux: true }, tk);
  ok(r.code === 200 && r.ok && NS.SESSIONS.has(J1) && !NS.SESSIONS.has(J2) && r.cors === '*', 'avec le ticket : le geste agit pour le joueur DU TICKET, pas pour celui du corps');
  ok((await pub('/p/geste', { action: 'capture' }, tk)).code === 429, 'deux gestes a moins de 250 ms : le second attend (429), comme par le relais');
  ok((await pub('/p/geste', { action: 'eval', code: 'x' }, tk)).code === 400, 'une action inconnue : 400');
  await new Promise((s2) => setTimeout(s2, 300));
  const avantD = interne;
  r = await pub('/p/geste', { action: 'goto', url: 'http://127.0.0.2/secret' }, tk);
  ok(r.ok && !!r.note && interne === avantD, 'la garde reseau tient en direct aussi : rien d interne (' + r.note + ')');
  const imD = await pub('/p/image', { apres: 0, attente: 2000 }, tk);
  ok(imD.code === 200 && !!imD.image && imD.seq > 0, 'l image arrive en direct, au nom du ticket');
  ok((await pub('/p/image', { apres: 0 }, D.signe(S, J3).ticket)).code === 404 && !NS.SESSIONS.has(J3), 'le ticket d un joueur sans session : rien a montrer, aucune session ouverte');
  console.log('\n-- 7. le clavier (03/10) : raccourcis, copier, et des frappes qui n attendent plus --');
  ok(D.toucheOk('Control+a') && D.toucheOk('Control+c') && D.toucheOk('Shift+ArrowLeft') && D.toucheOk('Control+Shift+ArrowRight') && D.toucheOk('Delete')
     && !D.toucheOk('Control+t') && !D.toucheOk('Control+w') && !D.toucheOk('Control+l') && !D.toucheOk('F12') && !D.toucheOk('Alt+F4'),
     'Ctrl+A/C/V/X/Z/Y, la selection au clavier passent ; jamais une combinaison du navigateur lui-meme (Ctrl+T, Ctrl+W, Ctrl+L, F12)');
  await new Promise((s2) => setTimeout(s2, 300));
  await pub('/p/geste', { action: 'goto', url: 'http://127.0.0.1/' }, tk);
  await new Promise((s2) => setTimeout(s2, 300));
  await pub('/p/geste', { action: 'clic', x: 150, y: 320 }, tk);
  const t0k = Date.now();
  /* Au rythme de la page (35 ms entre deux envois de frappes) : rien n est refuse, et c est bien
     moins que les 250 ms imposees a un geste qui charge. */
  const f1 = await pub('/p/geste', { action: 'tape', texte: 'swoge', flux: true }, tk);
  await new Promise((s2) => setTimeout(s2, 35));
  const f2 = await pub('/p/geste', { action: 'tape', texte: ' dog', flux: true }, tk);
  const dk = Date.now() - t0k;
  ok(f1.ok && f2.ok && dk < 250, 'deux frappes a 35 ms d intervalle passent toutes les deux (' + dk + ' ms au total, sous les 250 d un geste)');
  await new Promise((s2) => setTimeout(s2, 40));
  const tout = await pub('/p/geste', { action: 'touche', touche: 'Control+a', flux: true }, tk);
  await new Promise((s2) => setTimeout(s2, 40));
  const cp = await pub('/p/geste', { action: 'copie' }, tk);
  ok(tout.ok && !tout.note && cp.ok && cp.copie === 'swoge dog', 'Ctrl+A puis copier : la selection du champ revient a la page (« ' + cp.copie + ' »)');
  await new Promise((s2) => setTimeout(s2, 300));
  const interdit = await pub('/p/geste', { action: 'touche', touche: 'Control+w' }, tk);
  ok(interdit.ok && interdit.note === 'this key is not allowed' && NS.SESSIONS.has(J1), 'Ctrl+W est refuse : l onglet ne se ferme pas');

  const sante3 = await (await fetch(B + '/sante')).json();
  ok(!('derniereErreur' in sante3.mesure) && sante3.mesure.gestesDirects >= 1 && sante3.mesure.refusTicket >= 4, '/sante, desormais publique, ne dit plus la derniere erreur ; elle compte gestes directs et tickets refuses');

  for (const j of [J1, J2, J3]) await NS.ferme(j);
  const { navigateur } = NS._etat(); await navigateur.close();
  srv.close(); mand.close(); site.close(); secret.close();
  fin();
})().catch((e) => { console.error(e); process.exit(1); });

function fin() { console.log('\nVERIFICATIONS : ' + n + (rates ? ' — ' + rates + ' RATE(S)' : ' — tout passe')); process.exit(rates ? 1 : 0); }
