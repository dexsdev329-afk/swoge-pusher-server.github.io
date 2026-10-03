'use strict';
/* ============================================================================
 * LE SCAN PUBLIC — IL MESURE, IL NE CONCLUT PAS
 *
 * Personne ne cherche un casino. Tout le monde, avant d acheter, cherche la
 * meme chose : « celui-la, c est un piege ? ». C est la seule porte du site
 * par ou peut entrer quelqu un qui n a jamais entendu parler de SWOGE, donc
 * elle est PUBLIQUE : pas de cle, pas de portefeuille, pas de compte.
 *
 * Une porte publique sur un serveur qui fait tourner de l argent reel demande
 * trois garanties, et ce sont elles qu on met a l essai :
 *
 *   1. ELLE NE REND QUE CE QU ON A MESURE. Jamais un avis, jamais un mot
 *      comme « sur » ou « rug ». Des cases, et ce qu elles ont rendu.
 *   2. ELLE SE TAIT SOUS LE MINIMUM. Un chiffre sur six lectures se lirait
 *      avec la meme autorite qu un chiffre sur six cents : il ne sort pas.
 *      Et chaque chiffre part AVEC son effectif — sans lui il ment.
 *   3. ELLE NE PEUT PAS FAIRE SAIGNER LE SERVEUR. Debit borne, et rien
 *      d autre qu une adresse en entree.
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'scanpub-'));
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
/* Assez haut pour que les blocs qui MESURENT autre chose ne butent pas
   dessus, assez bas pour que le bloc du debit l atteigne sans lenteur. Les
   appels au-dela de la limite sont refuses AVANT tout travail, donc les
   compter coute une microseconde. */
process.env.SCAN_PAR_MIN = '40';

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const A = require('./ai_colonie');
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const lit = async (u) => { const r = await fetch('http://127.0.0.1:' + port + u); return { code: r.status, j: await r.json().catch(() => null), cache: r.headers.get('cache-control') }; };

  console.log('-- ce qui n est pas une adresse n entre pas, et ne coute pas une place --');
  {
    for (const mauvais of ['', 'pasuneadresse', '0x123', '0x' + 'z'.repeat(40),
                           '../../etc/passwd', '0x' + 'a'.repeat(41)]) {
      const r = await lit('/scan?adr=' + encodeURIComponent(mauvais));
      ok(r.code === 400 && r.j && r.j.erreur,
         '« ' + (mauvais || '(vide)').slice(0, 20) + ' » est refuse : ' + (r.j && r.j.erreur));
    }
    /* Le message dit QUOI FAIRE. « invalid input » n a jamais aide personne. */
    const r = await lit('/scan?adr=x');
    ok(/0x/.test(r.j.erreur), 'et le refus dit ce qu on attend : « ' + r.j.erreur + ' »');
    /* ---- ET IL NE CONSOMME PAS LE QUOTA ----
     * Une adresse mal formee ne touche aucun service. La compter reviendrait
     * a bloquer quelqu un pour deux fautes de frappe, avant qu il ait rien
     * demande. Sept refus de forme, puis une vraie demande : elle doit
     * passer, alors que la limite est a trois. */
    for (let i = 0; i < 7; i++) await lit('/scan?adr=nawak' + i);
    const apres = await lit('/scan/0x' + 'b'.repeat(40));
    ok(apres.code !== 429, 'sept adresses mal formees ne bloquent pas la suivante [' + apres.code + ']');
  }

  console.log('\n-- une adresse bien formee mais inconnue ne s invente pas --');
  {
    const r = await lit('/scan/0x' + 'b'.repeat(40));
    eq(r.code, 400, 'une adresse qui n est sur aucune piscine est refusee');
    ok(/not found/i.test(r.j.erreur || ''), 'et elle le DIT : « ' + r.j.erreur + ' »');
  }

  console.log('\n-- la porte est publique, et elle est etroite --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const bloc = src.slice(src.indexOf("path === '/scan'"), src.indexOf("path === '/scan'") + 1400);
    ok(!/authed|ADMIN_KEY|cle/.test(bloc), 'aucune cle demandee : sinon elle ne sert a rien');
    ok(/access-control-allow-origin/.test(bloc), 'et elle est lisible depuis le site');
    ok(/scanDebit\(req\)/.test(bloc), 'le debit est borne avant tout travail');
    ok(/429/.test(bloc), 'et le refus de debit se dit avec le bon code');
    /* Rien d autre qu une adresse : une route publique qui accepte des
       options accepte un jour celle qu on n avait pas prevue. */
    const params = bloc.match(/searchParams\.get\('([^']+)'\)|get\('([^']+)'\)/g) || [];
    ok(params.length <= 1, 'un seul parametre en entree : ' + params.join(', '));
  }

  console.log('\n-- ce que le scan REND, et ce qu il ne rend jamais --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
    const d0 = src.indexOf('async function scanJeton');
    const bloc = src.slice(d0, src.indexOf('\nfunction ', d0 + 10));
    /* ---- LE MINIMUM D OBSERVATIONS ----
     * C est la seule chose qui separe une mesure d une impression. */
    ok(/caseApprise\(/.test(bloc), 'chaque case passe par la memoire');
    const ca = src.slice(src.indexOf('function caseApprise'), src.indexOf('function caseApprise') + 400);
    ok(/c\.n < PROFIL_MIN_OBS/.test(ca) && /return null/.test(ca),
       'et une case sous le minimum rend `null` : elle ne sort pas du tout');
    ok(/if \(!m\) continue;/.test(bloc), 'donc elle n apparait pas dans la reponse');
    /* ---- L EFFECTIF PART AVEC LE CHIFFRE ----
     * Un « -43,7 % » sans son n se lit pareil qu il porte sur six lectures ou
     * sur six cents. */
    ok(/n: m\.n, moyenne: m\.moyenne/.test(bloc), 'chaque case part avec son effectif');
    ok(/mesureSur/.test(bloc) && /observations:/.test(bloc),
       'et la reponse dit sur combien d observations TOUT repose');
    /* ---- AUCUN VERDICT ----
     * Le scan ne dit pas quoi faire. Le lecteur conclut. */
    ok(!/(rug|scam|safe|danger|buy|sell)['"]/i.test(bloc.replace(/\*[^\n]*/g, '')),
       'aucun mot de verdict dans ce que la route rend');
    /* ---- ET AUCUNE CLE ---- */
    ok(!/API_KEY|SECRET|privateKey|\bsign\(/i.test(bloc), 'ni cle ni signature : c est une lecture');
  }

  console.log('\n-- les caches sont ceux du tour, pas des appels en plus --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
    const d0 = src.indexOf('async function scanJeton');
    const bloc = src.slice(d0, src.indexOf('\nfunction ', d0 + 10));
    ok(/lisDex\(addr\)/.test(bloc), 'le prix et l age viennent de `lisDex`, qui a son cache');
    ok(/assure\(t, \['goplus', 'octets'\]\)/.test(bloc),
       'le contrat passe par `assure`, exactement comme dans le tour');
    ok(!/fetch\(|json\(/.test(bloc), 'et le scan n appelle aucun service en direct : que des lecteurs caches');
  }

  console.log('\n-- un service muet n arrete pas le scan --');
  {
    /* GoPlus ou le catalogue peuvent ne pas repondre. Le scan doit rendre ce
       qu il a, pas une erreur : une page vide vaut moins qu une page
       partielle qui dit ce qui manque. */
    const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
    const d0 = src.indexOf('async function scanJeton');
    const bloc = src.slice(d0, src.indexOf('\nfunction ', d0 + 10));
    const gardes = (bloc.match(/catch \(e\)/g) || []).length;
    ok(gardes >= 2, gardes + ' lectures sous garde : un service muet ne fait pas tomber la page');
  }

  /* 03/10 : ces trois blocs scannaient LOBSTER EN DIRECT. Ce jour-la DexScreener ne lui connait plus
     aucune paire (« pairs: null ») : la route rendait 404 — a raison, un jeton sans piscine n a pas
     de carte — et l essai tombait pour une raison qui n avait rien a voir avec ce qu il mesure (le
     PNG, son cache, ses liens). LOBSTER vient donc de son releve du 26/09 (scan_lobster.essai) ; tout
     autre jeton passe par le vrai scan, et le jeton inconnu rend toujours 404. */
  const LOBF = require('./scan_lobster.essai');
  const scanDirect = A.scanJeton;
  A.scanJeton = async (adr) => (String(adr).toLowerCase() === LOBF.jeton.adr ? LOBF : scanDirect(adr));

  console.log('\n-- la carte en PNG, ecrite sans une seule dependance --');
  {
    /* Le site est statique sur GitHub Pages et les robots de X ne lisent pas
       le JavaScript : la carte dessinee dans la page ne sera jamais vue par
       eux. Celle-ci est ecrite par le serveur, pixel par pixel. */
    const A = LOBF.jeton.adr;
    const r = await fetch('http://127.0.0.1:' + port + '/scan/carte/' + A + '.png');
    const b = Buffer.from(await r.arrayBuffer());
    eq(r.status, 200, 'la carte est servie');
    eq(r.headers.get('content-type'), 'image/png', 'en PNG');
    ok(b.slice(1, 4).toString() === 'PNG' && b[0] === 0x89, 'et c est un vrai PNG : la signature y est');
    /* Les dimensions sont dans l entete : c est le format que X attend, et un
       autre rapport serait recadre par lui. */
    const L = b.readUInt32BE(16), H = b.readUInt32BE(20);
    ok(L === 1200 && H === 630, 'au format des apercus : ' + L + '×' + H);
    ok(b.length > 4000 && b.length < 400000, 'et d un poids raisonnable : ' + Math.round(b.length / 1024) + ' Ko');

    /* ---- LE CACHE ----
     * Un lien partage est demande une fois par robot et par reseau, parfois
     * quatre fois en dix secondes. Redessiner quatre fois la meme image
     * serait du travail pur. */
    const t0 = Date.now();
    const r2 = await fetch('http://127.0.0.1:' + port + '/scan/carte/' + A + '.png');
    const ms = Date.now() - t0;
    eq(r2.status, 200, 'le deuxieme appel repond aussi');
    ok(ms < 150, 'et il vient du cache : ' + ms + ' ms');
    ok(/max-age/.test(r2.headers.get('cache-control') || ''), 'la reponse se laisse garder par les robots');

    /* Un jeton inconnu n a pas de carte : on ne dessine pas une image qui
       dirait quelque chose de faux. */
    const r3 = await fetch('http://127.0.0.1:' + port + '/scan/carte/0x' + 'b'.repeat(40) + '.png');
    eq(r3.status, 404, 'un jeton inconnu n a pas de carte plutot qu une carte vide');
    const r4 = await fetch('http://127.0.0.1:' + port + '/scan/carte/nawak.png');
    eq(r4.status, 400, 'et ce qui n est pas une adresse est refuse');
  }

  console.log('\n-- le lien qu on partage porte la mesure --');
  {
    const A = LOBF.jeton.adr;
    const r = await fetch('http://127.0.0.1:' + port + '/s/' + A);
    const h = await r.text();
    eq(r.status, 200, 'la page d apercu repond');
    const dans = (re) => (h.match(re) || [])[1] || '';
    ok(/scam/i.test(dans(/<title>([^<]*)/)), 'le titre porte la question : « ' + dans(/<title>([^<]*)/) + ' »');
    ok(/LOBSTER/i.test(dans(/<title>([^<]*)/)), 'et le jeton');
    /* La description porte la MESURE : c est ce qu on lit dans un apercu,
       bien avant de cliquer. */
    const d = dans(/og:description" content="([^"]*)/);
    ok(/never a buy signal/i.test(d), 'la description refuse le verdict : « ' + d.slice(0, 70) + '… »');
    ok(/observations|measured enough/i.test(d), 'et elle parle d observations, pas d avis');
    ok(/\/scan\/carte\/0x[0-9a-f]{40}\.png$/.test(dans(/og:image" content="([^"]*)/)),
       'l image de l apercu est la carte de CE jeton');
    ok(/twitter:card" content="summary_large_image/.test(h), 'et elle est declaree en grand format');
    /* Un humain qui l ouvre atterrit sur la vraie page, avec son jeton. */
    const c = dans(/canonical" href="([^"]*)/);
    ok(/swoge_scan\.html\?t=0x/.test(c), 'un humain est envoye sur la page du site, jeton compris : ' + c);
    ok(new RegExp('http-equiv="refresh"').test(h), 'et il y va tout seul');
    /* Ce qui n est pas une adresse ne fabrique pas une page : il renvoie au
       scanner, sans jeton. */
    const r2 = await fetch('http://127.0.0.1:' + port + '/s/nawak', { redirect: 'manual' });
    ok(r2.status === 302, 'ce qui n est pas une adresse est renvoye au scanner [' + r2.status + ']');
  }

  console.log('\n-- l image est ecrite sans dependance, et la police est celle du site --');
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    /* L intention n a jamais ete « trois », c est « aucune ne s ajoute sans
       qu on le decide ». La liste est donc NOMMEE : le SDK Anthropic (SWOGE AI
       Chat, 24 septembre 2026) y est entre en connaissance de cause — du JS
       pur, sans script d installation ni fichier `.node`. */
    const CONNUES = ['@anthropic-ai/sdk', 'cannon-es', 'ethers', 'ws'];
    eq(deps.slice().sort().join(', '), CONNUES.join(', '), 'le depot n a que ses dependances connues');
    ok(!deps.some((d) => /sharp|canvas|resvg|jimp|puppeteer/.test(d)),
       'aucune n est un moteur de rendu : ils embarquent des binaires natifs qui cassent un deploiement');
    const src = fs.readFileSync(path.join(__dirname, 'carte_png.js'), 'utf8');
    const req = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    ok(req.every((x) => ['zlib', 'fs', 'path'].indexOf(x) >= 0),
       'et le dessin n utilise que ce qui est DANS Node : ' + req.join(', '));
    /* La police vient d un atlas rendu hors ligne : sans lui, le texte
       retomberait sur une police bitmap tapee a la main. */
    const atlas = JSON.parse(fs.readFileSync(path.join(__dirname, 'police_scan.json'), 'utf8'));
    ok(atlas.glyphes && Object.keys(atlas.glyphes).length > 150,
       Object.keys(atlas.glyphes).length + ' glyphes dans l atlas, deux graisses');
    ok(atlas.glyphes['b0'] && atlas.glyphes['r0'], 'les chiffres existent en gras et en maigre');
    const outil = fs.readFileSync(path.join(__dirname, 'outils', 'police.js'), 'utf8');
    ok(/Outfit/.test(outil) && /n a pas ete chargee/.test(outil),
       'et l outil REFUSE de generer l atlas si la police du site n est pas arrivee');
  }

  console.log('\n-- le scan porte ses liens : la carte, et la page qu on partage --');
  {
    /* Audit du 26 septembre 2026 : un agent (ou la page) qui lisait le scan
       n avait aucun moyen de trouver l image partageable ni la page de
       partage. Elles existaient ; le JSON ne les disait pas. */
    const A = LOBF.jeton.adr;
    const r = await lit('/scan/' + A);
    eq(r.code, 200, 'le scan de LOBSTER repond');
    const l = (r.j && r.j.links) || {};
    ok(new RegExp('/scan/carte/' + A + '\\.png$').test(l.card || '') && new RegExp('/s/' + A + '$').test(l.share || '') && /swoge_scan\.html\?t=0x/.test(l.page || ''),
       'links : l image de la carte, la page de partage (og:image), la page du site');
    const img = await fetch('http://127.0.0.1:' + port + new URL(l.card).pathname);
    const part = await fetch('http://127.0.0.1:' + port + new URL(l.share).pathname);
    const h = await part.text();
    ok(img.status === 200 && img.headers.get('content-type') === 'image/png' && part.status === 200 && h.includes('og:image" content="' + l.card + '"'),
       'et ils menent quelque part : le PNG, et la page dont l apercu EST cette carte');
  }

  A.scanJeton = scanDirect;

  console.log('\n-- le scan de LOBSTER, en anglais : le JSON, et l apercu partage --');
  {
    /* La colonie de l'essai est vide (DATA_DIR neuf) : son scan rend 0 case, et
       « chaque case porte sa phrase » etait vrai sur un tableau vide — une route
       qui aurait perdu les phrases, ou un apercu revenu a la cle brute, passaient.
       Le temps de ce bloc, la colonie rend le releve de LOBSTER (35 cases, fixture
       partagee) : ce que server.js en fait est juge sur la vraie route. */
    const LOB = require('./scan_lobster.essai');
    const adr = LOB.jeton.adr;
    const scan0 = A.scanJeton;
    A.scanJeton = async () => LOB;
    try {
      const r = await lit('/scan/' + adr);
      const cs = (r.j && r.j.cases) || [];
      ok(r.code === 200 && cs.length === LOB.cases.length && cs.every((c) => c.label && c.traitLabel),
         'les ' + cs.length + ' cases du JSON portent leur phrase anglaise (label) et le nom de leur trait (traitLabel)');
      ok(cs.every((c, i) => c.trait === LOB.cases[i].trait && c.case === LOB.cases[i].case), 'la cle brute reste a cote, dans l ordre de la colonie');
      const li = (r.j && r.j.lines) || [];
      ok(li.length === 21 && /^bytecode: no mint/.test(li[0].label) && li[0].traitLabel === 'Contract bytecode' && li[0].n === 2395
         && li.filter((l) => /^bytecode:/.test(l.label)).length === 1,
         'lines : ce que la page montre — 21 lignes, le bytecode en UNE ligne (' + (li[0] && li[0].label) + ', n=' + (li[0] && li[0].n) + ')');
      ok(!li.some((l) => /code : |OCTEMIT|octEmit|reseaux|emission/i.test(l.label + ' ' + l.traitLabel)), 'aucune cle brute ni phrase francaise dans lines');
      const h = await (await fetch('http://127.0.0.1:' + port + '/s/' + adr)).text();
      const d = (h.match(/og:description" content="([^"]*)/) || [])[1] || '';
      ok(/bytecode: no mint/.test(d) && /\+16\.9% over 2395 observations/.test(d) && !/code : |octEmit|emission/i.test(h),
         'l apercu partage dit la premiere ligne EN ANGLAIS, avec son effectif (« ' + d.slice(0, 90) + '… »), plus « code : sans emission »');
    } finally { A.scanJeton = scan0; }
  }

  /* ---- EN DERNIER, ET C EST VOULU ----
   * Ce bloc EPUISE le quota : le placer avant les autres les faisait
   * echouer en 429, pour une raison qui n avait rien a voir avec ce
   * qu ils mesuraient. Un essai qui tombe pour la mauvaise raison est
   * pire qu un essai absent : on cherche le defaut au mauvais endroit. */
  console.log('\n-- le debit tient --');
  {
    /* Passe la limite, la route refuse — et elle refuse AVANT d avoir
       interroge le moindre service. */
    let codes = [];
    for (let i = 0; i < 45; i++) codes.push((await lit('/scan/0x' + 'c'.repeat(40))).code);
    codes = codes.slice(-5);
    ok(codes.filter((c) => c === 429).length >= 1,
       'passe la limite, la route repond 429 : ' + codes.join(','));
    const r = await lit('/scan/0x' + 'c'.repeat(40));
    ok(r.j && /wait/i.test(r.j.erreur || ''), 'et elle dit quoi faire : « ' + (r.j && r.j.erreur) + ' »');
  }


  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) {}
  console.log(rates ? `\nscan_public.test.js : RATES : ${rates}/${n}` : `\nscan_public.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('  RATE ' + (e.stack || e)); process.exit(1); });
