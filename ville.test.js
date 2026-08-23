'use strict';
/*
 * LA VILLE DE SWOGE +18 : DES RUES, DES PATES, ET PERSONNE DEDANS.
 *
 * ---- CE QUI ETAIT CASSE ----
 *
 * La porte +18 du Nexus menait bien a une simulation a part. Mais cette
 * simulation n'avait pas de geographie a elle : elle tournait sur celle du
 * MONDE OUVERT. On y entrait et l'on se retrouvait « dans un monde avec du
 * combat », avec les memes rochers tires au sort et les memes cent soixante
 * creatures. La porte promettait un ailleurs et rendait le meme endroit.
 *
 * ---- CE QUE CET ESSAI EXIGE ----
 *
 * 1. LE PLAN A LA FORME D'UN PLAN. On compare ses champs a ceux d'un plan de
 *    donjon, RELUS sur un donjon — pas recopies ici. Un champ que la ville
 *    oublierait ferait un monde a qui il manque quelque chose que l'autre a,
 *    et le manque serait muet : la page dessinerait du vide.
 * 2. PERSONNE. Ni au premier pas, ni apres. Une ville avec deux monstres
 *    n'est pas « presque bonne », c'est exactement la plainte.
 * 3. ON PEUT MARCHER PARTOUT, ET ON NE TRAVERSE PAS LES MURS. Les deux se
 *    prouvent SUR LA GRILLE, par un parcours reel, jamais a l'oeil : un pate
 *    enclos serait un decor, pas une ville, et un pate qu'on traverse serait
 *    un dessin, pas un batiment.
 * 4. LA VILLE NE BOUGE PAS. Deux constructions donnent la meme ville. Un lieu
 *    dont les rues changent au redemarrage n'est pas un lieu.
 * 5. ET LE MONDE +18 LA RECOIT VRAIMENT. On entre par la porte, sur un
 *    serveur qui tourne, et l'on regarde ce qui arrive — en le CONTRASTANT
 *    avec le monde ouvert. Sans ce contraste, « pas de monstres » serait vrai
 *    aussi d'un essai qui regarde la mauvaise case.
 *
 * Aucun chiffre verifie n'est ecrit ici : ni le nombre de pates, ni celui des
 * facades, ni la taille de la ville. Tout se relit dans la table `VILLE` ou
 * se compte sur le plan rendu.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/ville-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };

const monde = require('./monde');
const { Realm } = require('./realm');
const V = monde.VILLE;
const T = monde.DONJON_TUILE;

/* La tuile d'un point du monde. Une seule facon de faire la conversion dans
   tout ce fichier : deux formules qui ne diffèrent que d'un demi-pas
   donneraient deux grilles, et l'une des deux « prouverait » n'importe quoi. */
const tuileDe = (x, y) => Math.floor(x / T) + ',' + Math.floor(y / T);

(async () => {

/* ================== 0. LA TABLE TIENT DEBOUT ================== */
console.log('-- ce que la table declare --');
ok(Array.isArray(V.FACADES) && V.FACADES.length >= 2,
   `la ville declare ${V.FACADES.length} planches de facade`);
/* La regle que le generateur ne verifie PAS a l'execution, parce qu'elle est
   structurelle : aucune facade ne peut etre plus large que le plus petit pate
   qu'on accepte. Sans ce garde, une cinquieme planche un peu large
   deborderait sur la rue d'a cote — et l'on marcherait dans un dessin sans
   qu'aucune collision ne s'en apercoive. */
const plusLarge = Math.max(...V.FACADES.map((f) => f.tuiles));
ok(plusLarge <= V.ilotMin,
   `la plus large des facades (${plusLarge} tuiles) tient dans le plus petit pate (${V.ilotMin})`);
ok(V.rue >= 2, `une rue fait ${V.rue} tuiles — de quoi passer a deux`);
ok(V.origine.x >= 1 && V.origine.y >= 1
   && V.origine.x + V.cote < monde.MONDE.w / T
   && V.origine.y + V.cote < monde.MONDE.h / T,
   `la ville (${V.cote} tuiles de cote a ${V.origine.x},${V.origine.y}) tient dans la carte `
   + `(${monde.MONDE.w / T} tuiles)`);

/* ================== 1. LA FORME DU PLAN ================== */
console.log('\n-- un plan de ville est un plan --');
const plan = monde.planDeVille();
const modele = monde.planDeDonjon('forge', Math.random);
/* Les champs du MODELE, relus sur un donjon vivant. Les recopier ici aurait
   fait de cet essai un souvenir : il aurait valide la forme d'hier. */
const champsDonjon = Object.keys(modele).filter((k) => modele[k] !== undefined).sort();
ok(champsDonjon.length >= 8,
   `un plan de donjon porte ${champsDonjon.length} champs : ${champsDonjon.join(', ')}`);
const manquants = champsDonjon.filter((k) => !(k in plan));
eq(manquants.length, 0,
   `le plan de la ville porte tous les champs d'un plan de donjon`
   + (manquants.length ? ` — il manque : ${manquants.join(', ')}` : ''));

console.log('\n-- et ce qu on y a mis, ou pas --');
eq(plan.peuplement.length, 0, 'AUCUNE creature n\'est ecrite dans le plan');
eq(plan.braises.length, 0, 'aucune plaque de braise non plus');
eq(plan.sortie, null,
   'et aucune porte de retour : on quitte une ville comme on quitte la plaine');
eq(plan.anneaux.length, 1, 'un seul anneau de sol, comme un donjon');
eq(plan.anneaux[0].biome, V.sol, `et il porte le sol declare par la table (« ${V.sol} »)`);
ok(plan.anneaux[0].jusqua !== Infinity && plan.anneaux[0].jusqua > 1,
   `sa borne est finie (${plan.anneaux[0].jusqua}) — « Infinity » ne traverse pas JSON`);
eq(plan.mur, V.mur, `la planche de pierre est celle que la table nomme (« ${V.mur} »)`);
ok(plan.tuiles.length > 0 && plan.obstacles.length > 0,
   `${plan.tuiles.length} tuiles de rue et ${plan.obstacles.length} blocs`);

/* ================== 2. LES FACADES ================== */
console.log('\n-- les facades sont des blocs, pas des dessins --');
const facades = plan.obstacles.filter((o) => o.bat);
/* Un plancher, sinon toutes les boucles qui suivent ne feraient AUCUN tour et
   « tout passe » voudrait dire « je n'ai rien regarde ». */
ok(facades.length >= V.FACADES.length,
   `${facades.length} facades posees, au moins une par planche declaree (${V.FACADES.length})`);
const planches = new Set(facades.map((o) => o.bat));
for (const f of V.FACADES) {
  ok(planches.has(f.planche),
     `la planche « ${f.planche} » est bien posee quelque part dans la ville`);
}
ok([...planches].every((p) => V.FACADES.some((f) => f.planche === p)),
   'et aucune facade ne nomme une planche absente de la table');
for (const f of V.FACADES) {
  const pose = facades.find((o) => o.bat === f.planche);
  eq(pose.larg, f.tuiles * T,
     `« ${f.planche} » est posee sur ${f.tuiles} tuiles (${pose.larg} unites)`);
  eq(pose.cadres || 0, f.cadres || 0,
     `« ${f.planche} » annonce ${f.cadres || 0} image(s) animee(s), comme la table`);
}
/* Chaque facade a bien remplace un BLOC. C'est le `continue` du generateur
   qu'on surveille ici : une facade qui n'aurait pas trouve son bloc serait
   simplement absente, et le nombre ci-dessus ne le dirait pas. */
ok(facades.every((o) => o.r > 0 && o.t !== undefined),
   'chaque facade a garde le rayon et la planche de pierre du bloc qu\'elle remplace');

/* ================== 2 bis. LES PORTES ==================
 *
 * Une porte n'est pas ecrite : elle se DERIVE du batiment. Ce qu'on exige ici
 * n'est donc pas « il y a des portes », c'est « chaque porte est devant la
 * face sud du batiment que la TABLE declare ouvrant, et nulle part ailleurs ».
 * Aucune coordonnee n'est ecrite dans cet essai : tout se recalcule depuis le
 * bloc rendu. Un essai qui coderait en dur la position de la tour serait la
 * deuxieme verite que ce travail existe justement pour eviter.
 */
console.log('\n-- les portes se derivent des batiments --');
/* Les rues, en tuiles. Declarees ICI parce que les portes s'y tiennent, et
   relues plus bas par le parcours : une seule conversion pour tout le
   fichier, sinon deux grilles decalees d'un demi-pas « prouveraient »
   n'importe quoi. */
const rues = new Set(plan.tuiles.map(([c, l]) => c + ',' + l));
const ouvrantes = V.FACADES.filter((f) => f.salle);
ok(ouvrantes.length > 0,
   `${ouvrantes.length} planche(s) de la table ouvrent sur une salle : `
   + ouvrantes.map((f) => f.planche + ' -> ' + f.salle).join(', '));
ok(Array.isArray(plan.portes), 'le plan porte une liste de portes');
/* LE PLANCHER : sans lui, toutes les boucles qui suivent ne feraient aucun
   tour et « toutes les portes sont bonnes » voudrait dire « je n'en ai vu
   aucune ». */
const batsOuvrants = facades.filter((o) => ouvrantes.some((f) => f.planche === o.bat));
ok(batsOuvrants.length > 0,
   `${batsOuvrants.length} batiment(s) ouvrant(s) poses dans la ville`);
eq(plan.portes.length, batsOuvrants.length,
   'il y a exactement une porte par batiment ouvrant — ni une de plus, ni une de moins');

let malPlacees = [], horsRue = [], mauvaiseCle = [];
for (const o of batsOuvrants) {
  const [c, l] = tuileDe(o.x, o.y).split(',').map(Number);
  /* Ce qu'on ATTEND, recalcule depuis le bloc : le centre de la tuile de rue
     juste au SUD. La formule est celle du generateur, mais appliquee a des
     coordonnees rendues — si le generateur cesse de deriver et se met a
     recopier un nombre, cette egalite tombe. */
  const ax = (c + 0.5) * T, ay = (l + 1 + 0.5) * T;
  const p = plan.portes.find((q) => Math.abs(q.x - ax) < 1 && Math.abs(q.y - ay) < 1);
  if (!p) { malPlacees.push(`${o.bat} en ${c},${l}`); continue; }
  const attendue = V.FACADES.find((f) => f.planche === o.bat).salle;
  if (p.salle !== attendue) mauvaiseCle.push(`${o.bat} annonce « ${p.salle} » au lieu de « ${attendue} »`);
  if (!rues.has(tuileDe(p.x, p.y))) horsRue.push(`${o.bat} en ${c},${l}`);
}
eq(malPlacees.length, 0,
   `chaque porte est devant la face SUD de son batiment`
   + (malPlacees.length ? ` — egarees : ${malPlacees.join(' / ')}` : ''));
eq(mauvaiseCle.length, 0,
   `et chacune nomme la salle que la TABLE lui donne`
   + (mauvaiseCle.length ? ` — ${mauvaiseCle.join(' / ')}` : ''));
eq(horsRue.length, 0,
   `et se tient sur une tuile de RUE, jamais dans la pierre`
   + (horsRue.length ? ` — ${horsRue.join(' / ')}` : ''));
/* LE CONTRASTE. Sans lui, « une porte par batiment ouvrant » serait vrai
   aussi d'un generateur qui en poserait une devant CHAQUE facade — et l'on
   entrerait dans la tour par le manege. */
const fermees = facades.filter((o) => !ouvrantes.some((f) => f.planche === o.bat));
ok(fermees.length > 0, `${fermees.length} facades ne declarent aucune salle`);
const fautives = fermees.filter((o) => {
  const [c, l] = tuileDe(o.x, o.y).split(',').map(Number);
  return plan.portes.some((q) => Math.abs(q.x - (c + 0.5) * T) < 1
                              && Math.abs(q.y - (l + 1 + 0.5) * T) < 1);
});
eq(fautives.length, 0, 'et aucune d\'elles n\'a de porte devant elle');
/* On peut ATTEINDRE la porte : elle est sur une rue, et cette rue est reliee
   au point d'arrivee. Une porte qu'on voit sans pouvoir y aller serait pire
   qu'un batiment ferme. Le parcours est fait plus bas, sur la meme grille —
   on garde donc les portes de cote et l'on verifie apres. */
ok(plan.portes.every((q) => q.r > 0),
   `chaque porte dit son rayon (${plan.portes[0] && plan.portes[0].r}) — la page ne l'invente pas`);

/* ================== 3. LA GRILLE ================== */
console.log('\n-- on marche dans les rues, jamais dans les pates --');
const entree = tuileDe(plan.entree.x, plan.entree.y);
ok(rues.has(entree), `le point d'arrivee (${entree}) est une tuile de RUE`);
ok(!plan.obstacles.some((o) => tuileDe(o.x, o.y) === entree),
   'et aucun bloc n\'est pose dessus');

/* ---- LE PARCOURS ----
 * Un vrai parcours en largeur sur la grille, depuis le point d'arrivee, sans
 * jamais quitter les tuiles de rue. C'est le seul moyen honnete de dire « on
 * peut aller partout » : le lire sur le dessin, c'est croire une image. */
const vu = new Set([entree]);
const file = [entree];
while (file.length) {
  const [c, l] = file.shift().split(',').map(Number);
  for (const [dc, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const k = (c + dc) + ',' + (l + dl);
    if (rues.has(k) && !vu.has(k)) { vu.add(k); file.push(k); }
  }
}
eq(vu.size, rues.size,
   `le parcours atteint TOUTES les rues (${vu.size} sur ${rues.size})`);

/* ---- ET CHAQUE PORTE EST ATTEIGNABLE ----
 * Le parcours ci-dessus est parti du point d'arrivee sans jamais quitter les
 * rues. Une porte qu'il n'atteint pas est une porte derriere un pate enclos :
 * on la verrait sur la carte et l'on ne pourrait jamais la pousser. */
const portesLoin = plan.portes.filter((q) => !vu.has(tuileDe(q.x, q.y)));
eq(portesLoin.length, 0,
   `on peut marcher jusqu'aux ${plan.portes.length} portes depuis le point d'arrivee`
   + (portesLoin.length ? ` — coupees : ${portesLoin.length}` : ''));

/* ---- ET DEVANT CHAQUE BATIMENT ----
 * Une facade est posee sur le bord SUD de son pate : la tuile juste en
 * dessous est la rue d'ou on la regarde. Elle doit etre atteinte. */
let devant = 0, orphelines = [];
for (const o of facades) {
  const [c, l] = tuileDe(o.x, o.y).split(',').map(Number);
  const pied = c + ',' + (l + 1);
  if (rues.has(pied) && vu.has(pied)) devant++;
  else orphelines.push(o.bat + ' en ' + c + ',' + l);
}
eq(orphelines.length, 0,
   `on peut se tenir devant les ${devant} facades depuis le point d'arrivee`
   + (orphelines.length ? ` — inatteignables : ${orphelines.join(' / ')}` : ''));

/* ---- ET LES PATES ARRETENT VRAIMENT ----
 * Pas sur la grille cette fois, mais avec la collision du jeu : on part de la
 * rue, devant une facade, et l'on avance vers le nord d'un pas de joueur.
 * On doit buter. Le pas vers le SUD, lui, doit passer — sans quoi « ca
 * bloque » serait vrai d'une collision qui bloque partout. */
const RJ = 22;
let butes = 0, traversees = [];
for (const o of facades) {
  const xs = o.x, ys = o.y + T;                  // la rue, un pas au sud du bloc
  ok(!monde.bloque(plan.obstacles, xs, ys, RJ) || traversees.push(0),
     `devant « ${o.bat} », la rue est libre`);
  let bute = false;
  for (let d = 8; d <= T * 2; d += 8) {
    if (monde.bloque(plan.obstacles, xs, ys - d, RJ)) { bute = true; break; }
  }
  if (bute) butes++; else traversees.push(o.bat + ' en ' + tuileDe(o.x, o.y));
}
eq(traversees.length, 0,
   `les ${butes} facades arretent le pas de celui qui marche dedans`
   + (traversees.length ? ` — traversees : ${traversees.join(' / ')}` : ''));

/* ================== 4. LA VILLE NE BOUGE PAS ================== */
console.log('\n-- un lieu ne change pas de rues --');
const bis = monde.planDeVille();
eq(JSON.stringify(bis.tuiles), JSON.stringify(plan.tuiles),
   'deux constructions sans tirage donnent exactement les memes rues');
eq(JSON.stringify(bis.obstacles), JSON.stringify(plan.obstacles),
   'et exactement les memes blocs, facades comprises');
/* Le TEMOIN : le generateur n'est pas fige, il est SEME. Un tirage different
   doit donner une autre ville — sinon « toujours la meme » serait vrai d'un
   generateur casse qui rend une constante. */
const autre = monde.planDeVille(monde.hasardSeme(V.germe + 1));
ok(JSON.stringify(autre.tuiles) !== JSON.stringify(plan.tuiles),
   'et un autre germe donne une autre ville — le generateur tire vraiment');

/* ================== 5. TOUS LES TIRAGES TIENNENT ================== */
console.log('\n-- et pas seulement celle-la --');
const GERMES = 150;
let pires = [];
for (let g = 0; g < GERMES; g++) {
  const p = monde.planVille(monde.hasardSeme(g * 7919 + 13));
  const s = new Set([...p.sol]);
  const e = p.entree.c + ',' + p.entree.l;
  if (!s.has(e)) { pires.push(`germe ${g} : arrivee dans la pierre`); continue; }
  const w = new Set([e]), q = [e];
  while (q.length) {
    const [c, l] = q.shift().split(',').map(Number);
    for (const [dc, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = (c + dc) + ',' + (l + dl);
      if (s.has(k) && !w.has(k)) { w.add(k); q.push(k); }
    }
  }
  if (w.size !== s.size) { pires.push(`germe ${g} : ${s.size - w.size} rues coupees`); continue; }
  const hors = p.facades.filter((f) => !s.has(f.c + ',' + (f.l + 1)));
  if (hors.length) { pires.push(`germe ${g} : ${hors.length} facades sans rue devant`); continue; }
  const large = p.facades.filter((f) => {
    const a = p.ilots.find((i) => f.c >= i.x0 && f.c <= i.x1 && f.l === i.y1);
    return !a || f.tuiles > (a.x1 - a.x0 + 1);
  });
  if (large.length) pires.push(`germe ${g} : ${large.length} facades plus larges que leur pate`);
}
eq(pires.length, 0,
   `${GERMES} villes tirees : toutes parcourables, toutes batissables`
   + (pires.length ? ` — ${pires.slice(0, 3).join(' / ')}` : ''));

/* ================== 6. LA SIMULATION RESTE VIDE ================== */
console.log('\n-- personne, et personne ne vient --');
const R = new Realm({ plan: monde.planDeVille() });
eq(R.monstres.length, 0, 'la simulation de la ville nait sans une creature');
eq(R.salles.length, 0, 'et sans salle gardee');
eq(R.portails.length, 0, 'et sans portail de retour au milieu de la rue');
for (let i = 0; i < 300; i++) R.pas(0.1);
eq(R.monstres.length, 0, 'trente secondes plus tard, toujours personne');
/* LE TEMOIN. Sans lui, « aucun monstre » serait vrai aussi d'un `Realm` casse
   qui n'en fait naitre nulle part — et l'essai feliciterait la panne. */
const dehors = new Realm({});
for (let i = 0; i < 10; i++) dehors.pas(0.1);
ok(dehors.monstres.length > 0,
   `pendant que le monde ouvert, lui, en porte ${dehors.monstres.length}`);

/* ================== 7. ET LA PORTE +18 Y MENE ================== */
console.log('\n-- ce qu on recoit en franchissant la porte --');
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
process.env.PORT = String(port);
const { Game } = require('./game');
let moteur = null; const _p0 = Game.prototype._p;
Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
require('./server');
await new Promise((r) => setTimeout(r, 900));

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
const entre = async (cle) => {
  const w = ethers.Wallet.createRandom();
  const s = await ouvre();
  const h = await attend(s, 'hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  await attend(s, 'auth');
  const p = moteur._p(w.address);
  p.skins = { andy: true }; p.skinActif = 'andy';
  s.recus.length = 0;
  s.send(JSON.stringify({ type: 'realmJoin', monde: cle }));
  return { s, entre: await attend(s, 'realmEntre') };
};

const ville = await entre('plus18');
const plaine = await entre('ouvert');

eq(ville.entre.carte, 'plus18', 'la porte +18 annonce sa carte');
ok(Array.isArray(ville.entre.tuiles) && ville.entre.tuiles.length > 0,
   `et elle envoie la forme de son sol (${(ville.entre.tuiles || []).length} tuiles)`);
/* LE CONTRASTE. Sans lui, « la +18 envoie des tuiles » ne dirait pas qu'elle
   a une forme A ELLE : le monde ouvert n'en envoie aucune, et c'est
   exactement ce qui separe une carte d'un terrain sans bord. */
eq(plaine.entre.tuiles, null, 'la plaine, elle, n\'en envoie aucune : elle n\'a pas de bord');
eq(ville.entre.anneaux.length, 1, 'la +18 n\'a qu\'un sol');
eq(ville.entre.anneaux[0].biome, V.sol, `et c'est « ${V.sol} »`);
ok(plaine.entre.anneaux.length > 1,
   `la plaine, elle, en a ${plaine.entre.anneaux.length} — ses anneaux de danger`);
eq(ville.entre.donjon, null,
   'la +18 ne se declare PAS comme un donjon : elle n\'a pas de porte de retour');
ok(!ville.entre.sortie, 'et aucune porte de sortie n\'accompagne son entree');
const batsRecus = (ville.entre.obstacles || []).filter((o) => o.bat);
ok(batsRecus.length >= V.FACADES.length,
   `${batsRecus.length} facades arrivent avec les blocs, nommees par le serveur`);
ok(batsRecus.every((o) => o.larg > 0),
   'chacune dit sa largeur en unites de monde — la page en deduit la hauteur');
/* ---- ET LES PORTES ARRIVENT AVEC ----
 * Une porte derivee que le serveur garderait pour lui ne servirait a rien :
 * la page ne peut pas la recalculer, elle n'a ni le semis ni la table des
 * facades. On regarde donc le MESSAGE, pas la structure. */
ok(Array.isArray(ville.entre.portes) && ville.entre.portes.length === plan.portes.length,
   `les ${(ville.entre.portes || []).length} portes de la ville partent avec l'entree`);
ok((ville.entre.portes || []).every((q) => q.salle && q.r > 0
     && Number.isFinite(q.x) && Number.isFinite(q.y)),
   'chacune nomme sa salle, son point et son rayon');
/* LE CONTRASTE : la plaine n'a pas de batiment, donc pas de porte. Sans lui,
   « la ville envoie des portes » ne dirait pas que c'est SON plan qui les
   porte — un champ pose sur tous les mondes aurait passe aussi. */
eq(plaine.entre.portes, null, 'la plaine, elle, n\'en annonce aucune');

/* ---- ET AUCUNE CREATURE N'Y VIT ----
 * On regarde l'instantane que le serveur envoie, pas la structure : c'est ce
 * que le joueur voit. Et l'on contraste avec la plaine, sans quoi « aucun
 * monstre » serait vrai d'un instantane aveugle. */
await new Promise((r) => setTimeout(r, 1200));
const etatV = await attend(ville.s, 'realmEtat');
const etatP = await attend(plaine.s, 'realmEtat');
eq((etatV.monstres || []).length, 0, 'l\'instantane de la ville ne montre aucune creature');
ok((etatP.monstres || []).length > 0,
   `celui de la plaine en montre ${(etatP.monstres || []).length} — l'instantane n'est pas aveugle`);

/* ---- ON NAIT DANS LA RUE ---- */
const moi = ville.entre.moi;
ok(rues.has(tuileDe(moi.x, moi.y)),
   `on nait sur une tuile de rue (${tuileDe(moi.x, moi.y)}), jamais dans un mur`);

ville.s.close(); plaine.s.close();
console.log(`\nville.test.js : ${n} verifications OK`);
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
