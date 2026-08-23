'use strict';
/*
 * LES MONDES OUVERTS, ENUMERES — JAMAIS NOMMES.
 *
 * ---- pourquoi ce fichier existe a cote de deux_mondes.test.js ----
 *
 * `deux_mondes.test.js` nomme `ouvert` et `crimson` en dur. Il a donc verifie,
 * une fois, ce qu'on avait sous les yeux ce jour-la — et il continuera de
 * passer, vert et muet, le jour ou une troisieme ligne s'ajoutera a la table
 * des mondes. C'est exactement la faute que ce depot combat partout ailleurs :
 * une table qu'on etend d'une ligne, et un essai qui la regarde de moins en
 * moins.
 *
 * Ici, la liste des mondes ne s'ecrit PAS. Elle se relit dans `server.js` a
 * chaque execution, et tout ce qui suit boucle dessus. Une quatrieme carte
 * n'est donc pas « un monde de plus qui n'est pas teste » : c'est trois
 * verifications de plus qui apparaissent toutes seules, et qui echouent si
 * cette carte n'est pas une simulation a part entiere.
 *
 * ---- ce qu'on exige de CHAQUE monde declare ----
 *
 * 1. ON Y ENTRE EN LE NOMMANT, et la carte annoncee est bien la sienne. Sans
 *    ce nom, la page ne peut pas dire ou l'on est : deux mondes ouverts ont
 *    la meme geometrie et le meme sol.
 * 2. ON Y EST SEUL. C'est le point vraiment grave, et c'est pour lui que le
 *    fichier existe : deux mondes qui partageraient une instance mettraient
 *    deux joueurs qui se croient seuls au meme endroit, et le premier tir le
 *    leur apprendrait. On le verifie par la STRUCTURE (autant de simulations
 *    que de cles) et par l'OBSERVABLE (`etatPour` ne montre rien).
 * 3. LE NEXUS SAIT COMPTER LES TETES DERRIERE SA PORTE. Un compteur qui
 *    oublie une porte, ou qui annonce le chiffre d'une AUTRE simulation,
 *    envoie les joueurs dans une carte vide en leur promettant du monde.
 *
 * Et deux choses qui ne dependent d'aucune cle : le monde par defaut reste
 * atteignable sans rien nommer, et une cle inventee y retombe au lieu de
 * mettre dehors quelqu'un pour un mot qu'il n'a pas tape.
 *
 * ---- ce qu'on ne verifie pas ici ----
 *
 * Les regles PROPRES a un monde (le plancher de rarete du rouge, le donjon
 * rattache au monde d'ou l'on entre) restent dans `deux_mondes.test.js` : ce
 * sont des promesses nommees, elles ont le droit d'etre verifiees par leur
 * nom. Ce fichier-ci ne verifie que ce qui doit etre vrai de TOUS les mondes,
 * y compris de ceux qui n'existent pas encore.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/mondesouv-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };

/* ==================== D'OU VIENT LA LISTE ====================
 *
 * De la source, et de nulle part ailleurs. On lit le texte de `server.js` et
 * on en extrait les cles de `const MONDES = new Map([...])`.
 *
 * Recopier la liste ici aurait rendu ce fichier exactement aussi aveugle que
 * celui qu'il complete : la copie serait juste le jour ou on l'ecrit, et
 * fausse le jour ou quelqu'un ajoute une porte. Exporter la table depuis
 * `server.js` pour la commodite de l'essai aurait ete l'autre solution — mais
 * une table exportee pour un essai finit par etre modifiee par du code de
 * production « puisqu'elle est la ».
 *
 * Lire du TEXTE peut evidemment se tromper : une table ecrite autrement demain
 * rendrait une liste incomplete, et un essai qui boucle sur une liste
 * incomplete passe en n'ayant rien regarde. C'est pour ca que la liste relue
 * est CONFRONTEE au serveur vivant deux fois plus bas : au nombre de
 * simulations ouvertes qui tournent vraiment, et aux cles que le Nexus annonce
 * lui-meme. Une cle manquee ici fait tomber ces deux confrontations-la.
 */
function litLesClesDesMondes(src) {
  const debut = src.indexOf('const MONDES = new Map(');
  if (debut < 0) return null;
  let prof = 0, fin = -1;
  for (let i = src.indexOf('(', debut); i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[') prof++;
    else if (c === ')' || c === ']') { prof--; if (prof === 0) { fin = i; break; } }
  }
  if (fin < 0) return null;
  const corps = src.slice(debut, fin + 1);
  const cles = [];
  const re = /\[\s*['"]([^'"]+)['"]\s*,/g;
  let m;
  while ((m = re.exec(corps))) cles.push(m[1]);
  return cles;
}

const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const CLES = litLesClesDesMondes(SOURCE);
/* Un essai qui n'a pas trouve sa liste doit le DIRE et tomber tout de suite.
   S'il continuait avec une liste vide, chaque boucle plus bas ne ferait aucun
   tour, aucune verification n'echouerait, et « tout passe » voudrait dire
   « je n'ai rien teste » — le mensonge le plus cher de tous. */
if (!CLES) {
  throw new Error('la table des mondes est introuvable dans server.js : cherche `const MONDES = new Map(`. '
                  + 'Tant qu\'elle n\'est pas relue, cet essai ne verifie RIEN et ne doit pas passer.');
}
const mDefaut = /const MONDE_DEFAUT\s*=\s*['"]([^'"]+)['"]/.exec(SOURCE);

(async () => {
  console.log('\n-- la liste relue dans la source --');
  /* Deux, c'est le minimum en dessous duquel cet essai n'a plus de sujet :
     l'isolation entre mondes ne veut rien dire quand il n'y en a qu'un, et une
     liste vide ferait passer le fichier entier a vide. */
  ok(CLES.length >= 2,
     `server.js declare au moins deux mondes ouverts (${CLES.length} relus : ${JSON.stringify(CLES)})`);
  ok(new Set(CLES).size === CLES.length,
     'et aucune cle n\'y est ecrite deux fois');
  ok(!!mDefaut, 'la cle du monde par defaut se lit elle aussi dans la source');
  const DEFAUT = mDefaut[1];
  ok(CLES.includes(DEFAUT),
     `et le monde par defaut « ${DEFAUT} » est bien un des mondes declares`);

  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const { Game } = require('./game');
  let moteur = null; const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
  /* ---- QU'EST-CE QU'UN MONDE OUVERT, VU D'ICI ----
   *
   * C'etait « une simulation SANS plan ». Ca ne l'est plus : la ville de
   * SWOGE +18 est un monde ouvert qui a une forme a lui, et ce critere-la
   * l'aurait fait disparaitre de cette liste sans qu'aucune assertion ne le
   * dise — l'essai aurait simplement teste un monde de moins.
   *
   * Le vrai depart est le MOMENT. Les mondes ouverts sont construits au
   * chargement de `server.js` : ils battent avant que le premier client soit
   * connecte. Un donjon, lui, n'existe qu'a partir de la porte franchie. On
   * releve donc ce qui tourne DEJA a la fin du demarrage, et rien d'autre.
   * On les attrape a leur premier tour de boucle plutot que d'exporter la
   * table : une table exportee pour un essai finit par etre modifiee par du
   * code de production « puisqu'elle est la ». */
  const { Realm } = require('./realm');
  const ouverts = new Set();
  let demarrageFini = false;
  const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) {
    if (!demarrageFini) ouverts.add(this);
    return pas0.call(this, dt);
  };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  demarrageFini = true;

  const ouvre = () => new Promise((res, rej) => {
    const s = new WebSocket('ws://127.0.0.1:' + port);
    s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    s.on('open', () => res(s)); s.on('error', rej);
  });
  const attend = (s, type, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function tour() {
      const m = s.recus.filter((x) => x.type === type).pop();
      if (m) return res(m);
      if (Date.now() - t0 > (ms || 6000)) return rej(new Error('pas de ' + type));
      setTimeout(tour, 25);
    })();
  });
  const connecte = async (w) => {
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    return s;
  };
  const dort = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Les simulations rangent les joueurs sous l'adresse EN MINUSCULES ; chercher
     la forme a majuscules du portefeuille ne trouve jamais rien, et l'essai
     conclurait « il n'est dans aucun monde » alors qu'il y est. */
  const cle = (addr) => String(addr).toLowerCase();
  /* Le monde ouvert qui CONTIENT une adresse. C'est la seule facon honnete de
     designer la simulation d'une cle quand on refuse de nommer les mondes :
     par l'occupant qu'on vient d'y envoyer. */
  const mondeDe = (addr) => [...ouverts].find((r) => r.joueurs.has(cle(addr))) || null;

  const sockets = [];
  /* Entre par la porte demandee. `demandee === null` : on n'envoie AUCUN champ
     `monde`, ce qui est le cas du client d'avant le deploiement. */
  const entre = async (demandee) => {
    const w = ethers.Wallet.createRandom();
    const s = await connecte(w);
    sockets.push(s);
    const p = moteur._p(w.address);
    p.skins = { andy: true }; p.skinActif = 'andy';
    s.recus.length = 0;
    s.send(JSON.stringify(demandee === null
      ? { type: 'realmJoin' }
      : { type: 'realmJoin', monde: demandee }));
    const e = await attend(s, 'realmEntre');
    return { s, addr: cle(w.address), entre: e };
  };

  /* ============ 1. CHAQUE PORTE DECLAREE S'OUVRE, ET DIT SON NOM ============ */
  console.log('\n-- une porte par cle relue --');
  const dossiers = new Map();
  for (const k of CLES) {
    const principal = await entre(k);
    eq(principal.entre.carte, k, `la porte « ${k} » annonce sa propre carte`);
    const sim = mondeDe(principal.addr);
    ok(!!sim, `et un joueur entre par « ${k} » vit dans une simulation ouverte`);
    /* LE TEMOIN. Un deuxieme joueur envoye dans le MEME monde, dont l'unique
       role est de prouver plus bas que l'instantane de ce monde-ci n'est pas
       simplement aveugle. Sans lui, « je ne vois personne des autres mondes »
       serait vrai aussi d'un `etatPour` casse qui ne montre jamais rien. */
    const temoin = await entre(k);
    ok(mondeDe(temoin.addr) === sim,
       `deux joueurs qui nomment « ${k} » atterrissent dans LA MEME simulation`);
    dossiers.set(k, { principal, temoin, sim });
  }
  ok(dossiers.size === CLES.length,
     `les ${CLES.length} mondes relus ont tous ete visites (${dossiers.size} dossiers)`);

  /* ================== 2. CHACUN CHEZ SOI ================== */
  console.log('\n-- une cle, une simulation --');
  const sims = [...dossiers.values()].map((d) => d.sim);
  ok(new Set(sims).size === CLES.length,
     `${CLES.length} cles donnent ${new Set(sims).size} simulations DISTINCTES`);
  /* La confrontation qui rattrape une liste mal relue : le serveur fait
     tourner exactement autant de mondes ouverts que la source en declare. Une
     cle que le lecteur de source aurait manquee ferait apparaitre ici une
     simulation de trop, et l'essai tomberait au lieu de l'ignorer. */
  ok(ouverts.size === CLES.length,
     `et le serveur ne fait tourner ni plus ni moins de mondes ouverts (${ouverts.size})`);

  /* ---- ON SE POSE TOUS AU MEME ENDROIT ----
   * Memes x, memes y pour tout le monde, dans toutes les simulations. Si deux
   * cles partageaient une instance, c'est ici que ca se verrait : les corps
   * seraient superposes DANS la meme simulation, et chacun apparaitrait dans
   * l'instantane de l'autre. */
  let X = null, Y = null;
  for (const [k, d] of dossiers) {
    const corps = [d.principal, d.temoin].map((q) => d.sim.joueurs.get(q.addr));
    ok(corps.every((j) => !!j), `les deux joueurs de « ${k} » ont bien un corps a deplacer`);
    for (const j of corps) {
      if (X === null) { X = j.x; Y = j.y; }
      j.x = X; j.y = Y;
    }
  }

  console.log('\n-- ce que chacun voit de la ou il est --');
  for (const [k, d] of dossiers) {
    const vue = d.sim.etatPour(d.principal.addr, 1400);
    ok(vue && Array.isArray(vue.joueurs),
       `« ${k} » rend un instantane exploitable a celui qui y vit`);
    const vus = new Set((vue.joueurs || []).map((o) => cle(o.a)));
    /* LE TEMOIN D'ABORD. Tant qu'on n'a pas vu cet instantane MONTRER
       quelqu'un, les absences qu'on verifie juste apres ne prouvent rien. */
    ok(vus.has(d.temoin.addr),
       `dans « ${k} », l'instantane montre bien le voisin du meme monde`);
    /* ET MAINTENANT L'ABSENCE DES AUTRES. */
    const etrangers = [...dossiers].filter(([k2]) => k2 !== k)
      .flatMap(([k2, d2]) => [d2.principal, d2.temoin].map((q) => [k2, q.addr]));
    const infiltres = etrangers.filter(([, a]) => vus.has(a)).map(([k2]) => k2);
    eq(infiltres.length, 0,
       `dans « ${k} », personne des autres mondes n'apparait${infiltres.length ? ' (vus : ' + infiltres.join(', ') + ')' : ''}`);
    /* L'instantane ne montre que ce qui est a portee : un etranger present
       mais loin y serait invisible, et l'absence ci-dessus serait un hasard de
       distance et non une isolation. On regarde donc aussi la simulation
       elle-meme, ou la portee n'existe pas. */
    const dedans = etrangers.filter(([, a]) => d.sim.joueurs.has(a)).map(([k2]) => k2);
    eq(dedans.length, 0,
       `et la simulation de « ${k} » ne contient aucun corps des autres mondes${dedans.length ? ' (' + dedans.join(', ') + ')' : ''}`);
  }

  /* ================== 3. QUI NE NOMME RIEN, ET QUI NOMME N'IMPORTE QUOI ================== */
  console.log('\n-- le client qui ne dit rien --');
  const muet = await entre(null);
  eq(muet.entre.carte, DEFAUT,
     'sans champ `monde`, on arrive dans le monde par defaut de la source');
  ok(mondeDe(muet.addr) === dossiers.get(DEFAUT).sim,
     'et c\'est bien la simulation qu\'on atteint en nommant cette cle-la');

  /* Une cle inventee ne fabrique pas un monde : elle retombe sur le defaut.
     Refuser aurait ete l'autre choix defendable — mais un joueur mis dehors
     par un mot qu'il n'a pas tape ne revient pas demander pourquoi.
     Le mot est FABRIQUE a partir de la liste relue, pas choisi a la main :
     un jour ou l'autre, un mot ecrit en dur ici finirait par devenir une vraie
     cle, et l'essai verifierait alors le contraire de ce qu'il croit. */
  let inventee = 'carte-que-personne-na-declaree';
  while (CLES.includes(inventee)) inventee += '-bis';
  const perdu = await entre(inventee);
  eq(perdu.entre.carte, DEFAUT, `la cle inventee « ${inventee} » retombe sur le defaut`);
  ok(mondeDe(perdu.addr) === dossiers.get(DEFAUT).sim,
     'et son corps est dans la simulation du defaut, pas dans une simulation neuve');

  /* ================== 4. LE NEXUS COMPTE DERRIERE CHAQUE PORTE ================== */
  console.log('\n-- combien derriere chaque porte --');
  const sn = await connecte(ethers.Wallet.createRandom());
  sockets.push(sn);
  sn.send(JSON.stringify({ type: 'nexusJoin', skin: 'andy' }));
  sn.send(JSON.stringify({ type: 'nexusMove', x: 100, y: 100, dir: 'down' }));
  const etatN = await attend(sn, 'nexusEtat', 4000);
  ok(etatN && etatN.portes && typeof etatN.portes === 'object',
     'le Nexus annonce un compteur de portes');
  for (const k of CLES) {
    ok(typeof etatN.portes[k] === 'number',
       `le compteur porte la cle « ${k} »`);
    /* Le chiffre de SA simulation, pas d'une autre : un compteur qui lirait
       toujours le meme monde afficherait « 4 inside » sur une carte vide, ce
       qui est pire que pas de chiffre du tout. */
    eq(etatN.portes[k], dossiers.get(k).sim.joueurs.size,
       `et le chiffre de « ${k} » est celui de SA simulation`);
  }
  /* La deuxieme confrontation entre la source relue et le serveur vivant :
     `portes` est construit en parcourant la vraie table. Une cle que le
     lecteur de source aurait manquee apparaitrait ici en trop. */
  eq(Object.keys(etatN.portes).length, CLES.length,
     'et le Nexus n\'annonce aucune porte que la source ne declare pas');

  for (const s of sockets) s.close();
  console.log(`\nmondes_ouverts.test.js : ${n} verifications OK (${CLES.length} mondes relus : ${CLES.join(', ')})`);
  process.exit(0);
})().catch((e) => { console.error('RATE ' + (e && e.message ? e.message : e)); process.exit(1); });
