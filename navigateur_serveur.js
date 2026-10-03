'use strict';
/* ==================================================================
 * LE NAVIGATEUR DE SWOGE AGENTS — UN CHROMIUM SUR UN SERVICE A PART (30 septembre 2026)
 * ==================================================================
 *
 * Demande du proprietaire : « un endroit ou naviguer sur internet, et un bouton pour
 * screen et poser une question — pas un read page, un screen : une analyse plus
 * complete ». Choix : un vrai Chromium, sur un service Railway SEPARE du jeu — s'il
 * manque de memoire ou plante, le casino et la colonie (argent reel) ne tombent pas.
 *
 * Ce processus ne parle qu'au serveur du jeu : chaque requete porte
 * `x-navigateur-secret` (NAVIGATEUR_SECRET, le meme des deux cotes). Le joueur, lui,
 * n'arrive jamais ici : le serveur du jeu verifie sa session et passe son adresse.
 *
 * ---- LA GARDE RESEAU ----
 * Tout le trafic de Chromium passe par un mandataire interne (127.0.0.1) qui resout
 * chaque nom avec `navigue.lookupSur` : une adresse non publique (le service lui-meme,
 * le reseau prive de Railway, les metadonnees du nuage) est refusee AU MOMENT DE LA
 * CONNEXION, redirections et sous-ressources comprises. `--proxy-bypass-list=<-loopback>`
 * retire l'exception que Chromium fait sinon pour localhost ; QUIC est coupe (il
 * contournerait le mandataire) et WebRTC n'a pas le droit d'UDP hors mandataire.
 * Ports 80 et 443 seulement. Aucun telechargement, aucun service worker.
 *
 * ---- LES BORNES ----
 * NAVIGATEUR_SESSIONS_MAX contextes a la fois (3 par defaut), un par joueur ; ferme apres
 * NAVIGATEUR_INACTIF_S secondes sans geste (300) ; 20 s par geste ; capture JPEG de la
 * fenetre (1280 × 800, ou 390 × 844 en mode telephone).
 * ================================================================== */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const navigue = require('./navigue');
const Direct = require('./navigateur_direct');

const SECRET = String(process.env.NAVIGATEUR_SECRET || '');
const SESSIONS_MAX = Math.max(1, Number(process.env.NAVIGATEUR_SESSIONS_MAX) || 3);
const INACTIF_MS = Math.max(30, Number(process.env.NAVIGATEUR_INACTIF_S) || 300) * 1000;
const GESTE_MS = 20000;
const ECRANS = { bureau: { width: 1280, height: 800 }, telephone: { width: 390, height: 844 } };

/* ---- le mandataire : la seule porte de Chromium vers le reseau ---- */
function portOk(p) { return p === 80 || p === 443; }
/* ---- UNE RESOLUTION PAR NOM, PAS PAR CONNEXION (02/10/2026) ----
 * « Le navigateur est vraiment lent. » Une page ouvre des dizaines de connexions vers les
 * memes noms ; chacune passait par `dns.lookup`, qui tourne dans le pool de libuv (4 fils par
 * defaut) : les resolutions faisaient la queue avant meme le premier octet. On garde 30 s le
 * resultat DEJA VALIDE par `lookupSur` (adresses publiques seulement) — un echec ou un refus
 * n'est jamais garde, il est redemande. La garde reste entiere : on ne met en cache que ce
 * qu'elle a accepte, et seulement 30 s (un nom qui changerait d'adresse vers le prive est
 * relu a l'expiration, comme le ferait n'importe quel cache DNS). */
const DNS_TTL_MS = 30000, DNS_MAX = 2000;
const DNS = new Map();
function lookupCache(hote, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const tous = !!(opts && opts.all), cle = String(hote).toLowerCase() + (tous ? '|*' : '');
  const c = DNS.get(cle);
  if (c && Date.now() - c.t < DNS_TTL_MS) { MESURE.dnsCache++; return tous ? cb(null, c.v) : cb(null, c.v, c.f); }
  navigue.lookupSur(hote, opts || {}, (err, v, f) => {
    if (!err) { if (DNS.size >= DNS_MAX) DNS.clear(); DNS.set(cle, { t: Date.now(), v, f }); }
    cb(err, v, f);
  });
}
function creeMandataire() {
  const srv = http.createServer((req, res) => {
    /* HTTP en clair : l'adresse absolue arrive dans la ligne de requete. */
    let u;
    /* `urlSure` AVANT tout : Node n'appelle pas `lookup` pour une IP ecrite en clair — mesure de
       l'essai du 30/09, trois requetes (image, fetch, redirection) vers 127.0.0.2 passaient ici. */
    try { u = navigue.urlSure(req.url); } catch (e) { res.writeHead(403); return res.end('blocked'); }
    const port = Number(u.port || 80);
    if (u.protocol !== 'http:' || !portOk(port)) { res.writeHead(403); return res.end('blocked'); }
    const amont = http.request({ hostname: u.hostname, port, path: u.pathname + u.search, method: req.method, headers: req.headers, lookup: lookupCache, timeout: GESTE_MS }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
    });
    amont.on('error', () => { if (!res.headersSent) res.writeHead(403); res.end('blocked'); });
    amont.on('timeout', () => amont.destroy());
    req.pipe(amont);
  });
  /* HTTPS : un tunnel CONNECT vers l'adresse RESOLUE et validee, jamais vers le nom brut. */
  srv.on('connect', (req, client, tete) => {
    const m = String(req.url || '').match(/^\[?([^\]]+?)\]?:(\d+)$/);
    const port = m ? Number(m[2]) : 0;
    if (!m || !portOk(port)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    lookupCache(m[1], {}, (err, ip) => {
      if (err) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const amont = net.connect(port, ip, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (tete && tete.length) amont.write(tete); amont.pipe(client); client.pipe(amont); });
      amont.setTimeout(120000, () => amont.destroy());
      amont.on('error', () => client.destroy());
      client.on('error', () => amont.destroy());
    });
  });
  return srv;
}

/* ---- les sessions : un contexte par joueur ---- */
let navigateur = null, mandatairePort = 0;
const SESSIONS = new Map();   /* joueur → { ctx, page, dernier, ecran, file } */
const MESURE = { gestes: 0, refus: 0, fermees: 0, erreurs: 0, derniereErreur: null, msTotal: 0, msMax: 0,
                 dnsCache: 0, images: 0, parAction: {} };
const AGENTS = { bureau: null, telephone: null };

async function lance(pw) {
  const mand = creeMandataire();
  await new Promise((ok) => mand.listen(0, '127.0.0.1', ok));
  mandatairePort = mand.address().port;
  /* ---- MOINS DE « ETES-VOUS UN ROBOT ? » (01/10/2026) ----
   * Signale par le proprietaire : « plein de verifications pour voir si on est pas un bot ».
   * Trois signaux que Chromium donnait lui-meme : l'executable « headless shell » (Playwright
   * le choisit par defaut sans canal, lib/server/chromium/chromium.js getExecutableName), la
   * marque « HeadlessChrome » dans l'agent utilisateur, et navigator.webdriver = true. Le canal
   * « chromium » lance le Chromium complet en mode sans tete ; l'agent utilisateur dit la meme
   * version, sans « Headless », et le meme systeme (Linux : il ne ment pas sur la plateforme) ;
   * AutomationControlled n'est plus annonce. Ce qui reste et ne se corrige pas d'ici : l'adresse
   * IP est celle d'un centre de donnees (Railway). Le joueur resout la case lui-meme, au doigt. */
  const args = ['--proxy-server=http://127.0.0.1:' + mandatairePort, '--proxy-bypass-list=<-loopback>',
    '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled'];
  const canal = process.env.NAVIGATEUR_CANAL === undefined ? 'chromium' : process.env.NAVIGATEUR_CANAL;
  try { navigateur = await pw.chromium.launch(canal ? { channel: canal, args } : { args }); }
  catch (e) { console.warn('[navigateur] canal « ' + canal + ' » indisponible, headless shell :', String(e.message || e).split('\n')[0]); navigateur = await pw.chromium.launch({ args }); }
  const majeure = String(navigateur.version() || '').split('.')[0] || '141';
  AGENTS.bureau = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + majeure + '.0.0.0 Safari/537.36';
  AGENTS.telephone = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + majeure + '.0.0.0 Mobile Safari/537.36';
  navigateur.on('disconnected', () => { navigateur = null; SESSIONS.clear(); });
  return mand;
}

async function ferme(joueur) {
  const s = SESSIONS.get(joueur);
  if (!s) return;
  SESSIONS.delete(joueur); MESURE.fermees++;
  if (s.flux) { const w = s.flux.attentes; s.flux = null; w.forEach((f) => f()); }
  try { await s.ctx.close(); } catch (e) { /* deja ferme */ }
}
function balaie() {
  const t = Date.now();
  for (const [j, s] of SESSIONS) if (t - s.dernier > INACTIF_MS) ferme(j);
}

async function session(joueur, ecran) {
  let s = SESSIONS.get(joueur);
  const e = ECRANS[ecran] ? ecran : 'bureau';
  if (s && s.ecran !== e) { await ferme(joueur); s = null; }
  if (s) return s;
  balaie();
  if (SESSIONS.size >= SESSIONS_MAX) { const err = new Error('the browser is busy: ' + SESSIONS_MAX + ' people are using it — try again in a few minutes'); err.code = 503; throw err; }
  if (!navigateur) { const err = new Error('the browser is restarting — try again in a moment'); err.code = 503; throw err; }
  const ctx = await navigateur.newContext({ viewport: ECRANS[e], isMobile: e === 'telephone', hasTouch: e === 'telephone', deviceScaleFactor: 1,
    acceptDownloads: false, serviceWorkers: 'block', locale: 'en-US', userAgent: AGENTS[e] || undefined });
  /* Seuls http(s), data: et blob: se chargent ; le mandataire juge ensuite l'adresse.
     01/10 : les flux audio/video (« media ») ne se chargent plus — une capture n'en montre
     qu'une image, et ils occupaient le tuyau pendant que la page attendait. */
  await ctx.route('**/*', (r) => (/^(https?|data|blob):/i.test(r.request().url()) && r.request().resourceType() !== 'media' ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  /* Une fenetre surgissante devient la page courante, apres la meme garde. */
  ctx.on('page', async (p) => { if (p === page) return; const u = p.url(); try { await p.close(); } catch (x) {} try { if (/^https?:/i.test(u)) await page.goto(navigue.urlSure(u).href, { timeout: GESTE_MS }); } catch (x) {} });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  s = { ctx, page, dernier: Date.now(), ecran: e, file: Promise.resolve() };
  SESSIONS.set(joueur, s);
  return s;
}

/* Un geste, puis la capture de ce que la fenetre montre. Les gestes d'un joueur passent un par un. */
async function geste(joueur, a) {
  const s = await session(joueur, a.ecran);
  const tour = s.file.then(async () => {
    const t0 = Date.now();
    s.dernier = Date.now(); MESURE.gestes++;
    const p = s.page, fin = { timeout: GESTE_MS };
    /* `flux` : le client recoit les images par /image ; le geste n'attend plus le chargement et
       ne fait plus de capture — sauf « capture », qui en veut une, nette, pour « Screen ». */
    const flux = a.flux === true && a.action !== 'capture';
    if (flux) demarreFlux(s).catch(() => {});
    let note = null;
    try {
      switch (a.action) {
        case 'goto': {
          let brut = String(a.url || '').trim();
          if (brut && !/^[a-z]+:\/\//i.test(brut)) brut = /\s/.test(brut) || !/\./.test(brut) ? 'https://duckduckgo.com/html/?q=' + encodeURIComponent(brut) : 'https://' + brut;
          /* En flux (02/10), on rend la main des que la navigation est ENGAGEE : la suite
             du chargement arrive en images, au fil de l'eau, au lieu d'attendre la fin. */
          await p.goto(navigue.urlSure(brut).href, Object.assign({ waitUntil: flux ? 'commit' : 'domcontentloaded' }, fin));
          /* 01/10 : 2,5 s au plus apres le DOM, et non 5 : la page continue de charger, et le
             client redemande une capture 1,5 s apres chaque geste (outils/browse_onglet.html). */
          if (!flux) await p.waitForLoadState('load', { timeout: 2500 }).catch(() => {});
          break;
        }
        case 'clic': {
          const x = Number(a.x), y = Number(a.y), V = p.viewportSize();
          if (!(x >= 0 && y >= 0 && x <= V.width && y <= V.height)) throw new Error('click outside the page');
          await p.mouse.click(x, y);
          if (!flux) { await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}); await p.waitForTimeout(250); }
          break;
        }
        case 'defile': await p.mouse.wheel(0, Math.max(-4000, Math.min(4000, Number(a.dy) || 600))); if (!flux) await p.waitForTimeout(300); break;
        /* 10 ms par caractere : 500 caracteres coutaient 5 s. En flux, le texte part d'un coup. */
        case 'tape': await p.keyboard.type(String(a.texte || '').slice(0, 500), { delay: flux ? 0 : 10 }); break;
        case 'touche': {
          const k = String(a.touche || '');
          if (!/^(Enter|Tab|Escape|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)$/.test(k)) throw new Error('this key is not allowed');
          await p.keyboard.press(k); if (!flux) await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}); break;
        }
        case 'retour': await p.goBack(flux ? { waitUntil: 'commit', timeout: GESTE_MS } : fin).catch(() => {}); break;
        case 'avance': await p.goForward(flux ? { waitUntil: 'commit', timeout: GESTE_MS } : fin).catch(() => {}); break;
        case 'recharge': await p.reload(flux ? { waitUntil: 'commit', timeout: GESTE_MS } : fin); break;
        case 'capture': break;
        default: throw new Error('unknown action');
      }
    } catch (e) {
      MESURE.erreurs++; MESURE.derniereErreur = String(e && e.message || e).slice(0, 160);
      note = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|403|not on the public internet|blocked/i.test(String(e && e.message)) ? 'This address cannot be opened (only public websites are allowed).'
        : /Timeout/i.test(String(e && e.message)) ? 'The page took too long to load; this is what it shows so far.' : String(e && e.message || e).split('\n')[0].slice(0, 160);
    }
    /* Qualite 60 et non 70. Mesure du 01/10 (1280 × 800, trois pages du site) : 118 Ko contre
       139, 76 contre 89, 74 contre 85 — 13 a 15 % de moins, le texte reste net. La taille n'etait
       donc PAS la cause de la lenteur ; les attentes l'etaient (jusqu'a 5 s de « load » par
       ouverture), d'ou les 2,5 s plus haut et la capture de suivi cote client. */
    const image = flux ? null : await p.screenshot({ type: 'jpeg', quality: 60, timeout: GESTE_MS }).catch(() => null);
    const ms = Date.now() - t0; MESURE.msTotal += ms; if (ms > MESURE.msMax) MESURE.msMax = ms;
    const pa = MESURE.parAction[(flux ? 'flux:' : '') + a.action] || (MESURE.parAction[(flux ? 'flux:' : '') + a.action] = { n: 0, ms: 0, max: 0 });
    pa.n++; pa.ms += ms; if (ms > pa.max) pa.max = ms;
    return { url: p.url(), titre: await p.title().catch(() => ''), image: image ? image.toString('base64') : null, ecran: ECRANS[s.ecran], note,
             seq: s.flux ? s.flux.seq : 0 };
  });
  s.file = tour.catch(() => {});
  return tour;
}

/* ==================================================================
 * LE FLUX D'IMAGES (02/10/2026)
 * ==================================================================
 * « Le navigateur est vraiment lent » — et ce n'etait pas la machine : sur 24 h, le service a
 * plafonne a 1,3 % d'un processeur et 0,43 Go. C'etait la FORME de l'echange : chaque geste
 * attendait le chargement (jusqu'a 2,5 s apres le DOM), faisait une capture, la renvoyait en
 * Californie → Europe, puis le client en redemandait une 1,5 s plus tard. On voyait la page
 * par a-coups, et toujours en retard.
 *
 * Chromium sait diffuser son ecran (CDP `Page.startScreencast`) : il envoie une image chaque
 * fois que la page se repeint, et SEULEMENT alors. On garde la derniere ; le client la demande
 * par /image en « longue attente » (il passe le numero de la derniere qu'il a vue, on repond
 * des qu'une plus recente existe, ou au bout de `attente`). Chaque image recue est donc la
 * plus recente : pas de file qui s'allonge, et le rythme se regle tout seul sur le reseau.
 * Une page qui ne bouge pas ne coute rien.
 *
 * L'inactivite se compte sur les GESTES, pas sur les images : un onglet ouvert qui regarde ne
 * garde pas une session au-dela de NAVIGATEUR_INACTIF_S. */
const FLUX_QUALITE = 55;
const FLUX_ATTENTE_MAX = 10000;
async function demarreFlux(s) {
  if (s.flux) return s.flux;
  if (s.fluxEnCours) return s.fluxEnCours;
  s.fluxEnCours = (async () => {
    const V = ECRANS[s.ecran];
    const cdp = await s.ctx.newCDPSession(s.page);
    const F = { cdp, seq: 0, image: null, t: 0, attentes: [] };
    cdp.on('Page.screencastFrame', (f) => {
      /* Sans accuse de reception, Chromium n'envoie plus rien. */
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (s.flux !== F) return;
      F.seq++; F.image = f.data; F.t = Date.now(); MESURE.images++;
      const w = F.attentes; F.attentes = []; w.forEach((r) => r());
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: FLUX_QUALITE, maxWidth: V.width, maxHeight: V.height, everyNthFrame: 1 });
    s.flux = F;
    return F;
  })();
  try { return await s.fluxEnCours; } finally { s.fluxEnCours = null; }
}
/** La derniere image de la session du joueur, plus recente que `apres` — ou rien au bout de `attente`. */
async function image(joueur, q) {
  const s = SESSIONS.get(joueur);
  if (!s) { const e = new Error('no browser session: open a page first'); e.code = 404; throw e; }
  const F = await demarreFlux(s);
  /* Au demarrage, Chromium envoie lui-meme une premiere image — mais une page immobile ne se
     repeint plus ensuite. On lui laisse 400 ms ; sans rien, on en prend une pour commencer.
     (Prendre la capture tout de suite faisait arriver DEUX images d une page immobile : la
     notre, puis la sienne.) */
  if (!F.seq) await new Promise((ok) => { const t = setTimeout(ok, 400); F.attentes.push(() => { clearTimeout(t); ok(); }); });
  if (!F.seq) {
    const b = await s.page.screenshot({ type: 'jpeg', quality: FLUX_QUALITE, timeout: GESTE_MS }).catch(() => null);
    if (b && !F.seq && s.flux === F) { F.seq = 1; F.image = b.toString('base64'); F.t = Date.now(); }
  }
  const apres = Number(q.apres) || 0;
  const attente = Math.max(0, Math.min(FLUX_ATTENTE_MAX, Number(q.attente) || 0));
  if (F.seq <= apres && attente > 0 && F.attentes.length < 4) {
    await new Promise((ok) => { const t = setTimeout(ok, attente); F.attentes.push(() => { clearTimeout(t); ok(); }); });
  }
  const neuve = s.flux === F && F.seq > apres;
  return { seq: F.seq, image: neuve ? F.image : null, url: s.page.url(), titre: await s.page.title().catch(() => ''), ecran: ECRANS[s.ecran] };
}

/* ---- le petit serveur, pour le serveur du jeu seulement ---- */
function egal(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function corps(req, max) {
  return new Promise((ok, ko) => { const m = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > max) { ko(new Error('too large')); req.destroy(); } else m.push(c); }); req.on('end', () => ok(Buffer.concat(m).toString('utf8'))); req.on('error', ko); });
}
/* ==================================================================
 * LA LIAISON DIRECTE (02/10/2026) : /p/geste et /p/image, pour la page du joueur
 * ==================================================================
 * Le navigateur est a Amsterdam, le serveur du jeu en Californie : la page parle ici
 * directement (navigateur_direct.js). Pas de secret dans la page — un TICKET signe par le
 * serveur du jeu pour la session du joueur. Le joueur est celui du ticket, jamais celui du
 * corps. Les memes bornes que le relais : un geste par 250 ms, deux images en vol. */
const DIRECT_GESTE_MIN_MS = 250;
const directDernier = new Map(), directEnVol = new Map();
async function routeDirecte(req, res, chemin) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
                 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '600' };
  const json = (code, o) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, cors)); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST') return json(405, { ok: false });
  const joueur = Direct.verifie(SECRET, String(req.headers.authorization || '').replace(/^Ticket\s+/i, ''));
  if (!joueur) { MESURE.refusTicket = (MESURE.refusTicket || 0) + 1; return json(401, { ok: false, raison: 'ticket missing or expired' }); }
  let q;
  try { q = JSON.parse(await corps(req, 16384) || '{}'); } catch (e) { return json(400, { ok: false, raison: 'unreadable request' }); }
  try {
    if (chemin === '/p/geste') {
      const o = Direct.champs(q);
      if (!o) return json(400, { ok: false, raison: 'unknown action' });
      const t = Date.now();
      if (t - (directDernier.get(joueur) || 0) < DIRECT_GESTE_MIN_MS) return json(429, { ok: false, raison: 'slow down' });
      directDernier.set(joueur, t);
      if (directDernier.size > 5000) directDernier.clear();
      MESURE.gestesDirects = (MESURE.gestesDirects || 0) + 1;
      return json(200, Object.assign({ ok: true }, await geste(joueur, o)));
    }
    const n = directEnVol.get(joueur) || 0;
    if (n >= 2) return json(429, { ok: false, raison: 'slow down' });
    directEnVol.set(joueur, n + 1);
    try {
      MESURE.imagesDirectes = (MESURE.imagesDirectes || 0) + 1;
      return json(200, Object.assign({ ok: true }, await image(joueur, { apres: Math.max(0, Number(q.apres) || 0), attente: Number(q.attente) || 0 })));
    } finally { const m = (directEnVol.get(joueur) || 1) - 1; if (m > 0) directEnVol.set(joueur, m); else directEnVol.delete(joueur); }
  } catch (e) { return json(e && (e.code === 503 || e.code === 404) ? e.code : 500, { ok: false, raison: String(e && e.message || e).slice(0, 200) }); }
}

function creeServeur() {
  return http.createServer(async (req, res) => {
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    const chemin = req.url.split('?')[0];
    /* 02/10 : le service a une adresse publique (liaison directe) — /sante ne dit plus la derniere
       erreur, qui peut citer une page visitee. Le relais ne la lisait deja pas. */
    if (chemin === '/sante') return json(200, { ok: !!navigateur, sessions: SESSIONS.size, max: SESSIONS_MAX, mesure: Object.assign({}, MESURE, { derniereErreur: undefined }) });
    if (chemin === '/p/geste' || chemin === '/p/image') return routeDirecte(req, res, chemin);
    if (!SECRET || !egal(req.headers['x-navigateur-secret'] || '', SECRET)) { MESURE.refus++; return json(401, { ok: false }); }
    if (req.method !== 'POST') return json(405, { ok: false });
    let q;
    try { q = JSON.parse(await corps(req, 16384) || '{}'); } catch (e) { return json(400, { ok: false, raison: 'unreadable request' }); }
    const joueur = String(q.joueur || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(joueur)) return json(400, { ok: false, raison: 'no player' });
    try {
      if (chemin === '/ferme') { await ferme(joueur); return json(200, { ok: true }); }
      if (chemin === '/geste') return json(200, Object.assign({ ok: true }, await geste(joueur, q)));
      if (chemin === '/image') return json(200, Object.assign({ ok: true }, await image(joueur, q)));
      return json(404, { ok: false });
    } catch (e) { return json(e && (e.code === 503 || e.code === 404) ? e.code : 500, { ok: false, raison: String(e && e.message || e).slice(0, 200) }); }
  });
}

module.exports = { creeMandataire, creeServeur, lance, geste, image, ferme, SESSIONS, MESURE, ECRANS, DNS, lookupCache, _etat: () => ({ navigateur, mandatairePort }) };

if (require.main === module) {
  if (!SECRET) { console.error('[navigateur] NAVIGATEUR_SECRET manquant : refus de demarrer'); process.exit(1); }
  const pw = require('playwright-core');
  lance(pw).then(() => {
    creeServeur().listen(Number(process.env.PORT) || 8080, () => console.log('[navigateur] pret, ' + SESSIONS_MAX + ' sessions au plus'));
    const b = setInterval(balaie, 30000); if (b.unref) b.unref();
  }).catch((e) => { console.error('[navigateur] Chromium ne demarre pas : ' + e.message); process.exit(1); });
  /* Chromium tombe : le service redemarre (Railway le relance), plutot que servir des erreurs. */
  setInterval(() => { if (!navigateur) { console.error('[navigateur] Chromium perdu : sortie'); process.exit(1); } }, 10000).unref();
}
