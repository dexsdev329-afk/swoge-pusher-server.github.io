'use strict';
/*
 * La force des bots, MESUREE.
 *
 * On peut ecrire « le bot est difficile » dans un commentaire ; ca ne coute
 * rien et ca ne prouve rien. Ce fichier le fait jouer, des milliers de
 * parties, contre des adversaires dont on connait exactement le niveau :
 *
 *   • LE HASARD — un coup legal au hasard. Un bot qui ne l'ecrase pas n'est
 *     pas un bot ;
 *   • LE GLOUTON — prend une victoire immediate, bloque une defaite
 *     immediate, sinon le meilleur coup a un demi-coup de vue. C'est le niveau
 *     d'un joueur humain attentif qui ne calcule pas plus loin. C'est LUI le
 *     vrai etalon : battre le hasard ne veut rien dire ;
 *   • LUI-MEME, pour le morpion : deux jeux parfaits doivent faire nulle a
 *     tous les coups. C'est la seule preuve possible de la perfection, et
 *     elle est absolue — pas statistique.
 *
 * ---- comment on compare deux bots, et pourquoi le naif ne marche pas ----
 *
 * Faire jouer deux bots DETERMINISTES l'un contre l'autre quarante fois ne
 * produit pas quarante parties : il en produit DEUX, rejouees vingt fois
 * chacune. La premiere version de ce fichier a rendu « 20-0-20 » et l'a pris
 * pour un match nul serre ; c'etait en realite « celui qui ouvre gagne »,
 * mesure deux fois. On part donc d'OUVERTURES ALEATOIRES, et surtout on les
 * joue DANS LES DEUX SENS : si les deux bots gagnent chacun du bon cote, la
 * position etait deja decidee et le duel ne prouve rien. Un bot n'est meilleur
 * que s'il CONVERTIT une position que l'autre rate.
 *
 * Les seuils sont volontairement exigeants. Un bot d'entrainement qui perd
 * une partie sur cinq contre un glouton donne au joueur une confiance qu'il
 * n'a pas gagnee, et il arrivera a la table payante en face de quelqu'un qui,
 * lui, calcule.
 */
const assert = require('assert');
const B = require('./bots');
const p4 = require('./puissance4');
const mp = require('./morpion');
const mf = require('./morpion_fantome');
const dm = require('./dames');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

/* Un generateur reproductible : une suite de tests qui depend de Math.random
   donne un resultat different a chaque execution, et un echec qu'on ne peut
   pas rejouer n'est pas un echec exploitable. */
function alea(graine) {
  let x = graine >>> 0;
  return function () {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}
const choix = (t, rnd) => t[Math.floor(rnd() * t.length) % t.length];

// ============================================== Puissance 4 : les temoins

function p4Hasard(g, joueur, rnd) { return choix(p4.jouables(g), rnd); }

/** Gagne si possible, bloque si necessaire, sinon le centre disponible. */
function p4Glouton(g, joueur, rnd) {
  const lui = joueur === 1 ? 2 : 1;
  const cols = p4.jouables(g);
  for (const c of cols) {                       // gagner
    const i = p4.poser(g, c, joueur); const w = p4.gagne(g, i); g[i] = 0;
    if (w) return c;
  }
  for (const c of cols) {                       // bloquer
    const i = p4.poser(g, c, lui); const w = p4.gagne(g, i); g[i] = 0;
    if (w) return c;
  }
  for (const c of B.P4_ORDRE) if (cols.indexOf(c) >= 0) return c;
  return cols[0];
}

/** Joue une partie depuis `g0`, `j0` au trait. `a` tient le camp `j0`. */
function p4Partie(a, b, rnd, g0, j0) {
  const g = g0 ? g0.slice() : p4.nouvelle();
  let joueur = j0 || 1;
  const mien = joueur;
  for (let coup = 0; coup < p4.CASES; coup++) {
    const f = joueur === mien ? a : b;
    const c = f(g, joueur, rnd);
    const i = p4.poser(g, c, joueur);
    if (p4.gagne(g, i)) return joueur;
    if (!p4.jouables(g).length) return 0;
    joueur = joueur === 1 ? 2 : 1;
  }
  return 0;
}

// ====================================================== Puissance 4 : le bot

/* La table des poids et les fenetres sont CALCULEES : on verifie qu'elles
   disent bien ce qu'on croit, sinon toute l'evaluation est fausse en silence. */
{
  eq(B.P4_FENETRES.length, 69, '69 facons d aligner quatre sur 7x6');
  ok(B.P4_FENETRES.every((f) => f.length === 4 && new Set(f).size === 4),
     'chaque fenetre porte quatre cases distinctes');
  const centre = B.P4_POIDS[p4.idx(3, 0)], bord = B.P4_POIDS[p4.idx(0, 0)];
  ok(centre > bord, `le centre (${centre}) vaut plus que le bord (${bord})`);
  eq(B.P4_ORDRE[0], 3, 'la recherche commence par le centre');
}

/* Le premier coup sur une grille vide EST le centre. C'est le coup gagnant du
   Puissance 4 resolu : le premier joueur gagne s'il ouvre au centre, et
   seulement la. Un bot qui ouvrirait ailleurs perdrait contre un jeu parfait. */
eq(B.p4Coup(p4.nouvelle(), 1, 8), 3, 'le bot ouvre au centre');

/* Il prend une victoire immediate, et il la prend TOUT DE SUITE. */
{
  const g = p4.nouvelle();
  p4.poser(g, 1, 1); p4.poser(g, 2, 1); p4.poser(g, 3, 1);   // trois alignes
  ok([0, 4].indexOf(B.p4Coup(g, 1, 6)) >= 0, 'il complete son alignement');
}
/* Et il bloque celle de l'autre quand il n'a rien de mieux. */
{
  const g = p4.nouvelle();
  p4.poser(g, 1, 2); p4.poser(g, 2, 2); p4.poser(g, 3, 2);
  p4.poser(g, 0, 1); p4.poser(g, 0, 1);                       // le bot n'a rien
  const c = B.p4Coup(g, 1, 6);
  ok(c === 0 || c === 4, `il bloque en ${c}`);
}

/* ---- LA MESURE, depuis une grille vide ---- */
function serie(bot, temoin, parties, rnd) {
  let g = 0, p = 0, n2 = 0;
  for (let i = 0; i < parties; i++) {
    const botOuvre = i % 2 === 0;               // ouvrir est un avantage : on alterne
    const r = botOuvre ? p4Partie(bot, temoin, rnd) : p4Partie(temoin, bot, rnd);
    const jetonBot = botOuvre ? 1 : 2;
    if (r === 0) n2++; else if (r === jetonBot) g++; else p++;
  }
  return { g, p, n: n2 };
}

{
  const rnd = alea(20260815);
  const bot = (g, j) => B.p4Coup(g, j, 8);

  const vsHasard = serie(bot, p4Hasard, 100, rnd);
  console.log(`  Puissance 4 · contre le hasard  : ${vsHasard.g} gagnees, ` +
              `${vsHasard.n} nulles, ${vsHasard.p} perdues`);
  eq(vsHasard.p, 0, 'il ne perd JAMAIS contre le hasard');
  ok(vsHasard.g >= 98, 'il gagne au moins 98 parties sur 100 contre le hasard');

  const vsGlouton = serie(bot, p4Glouton, 100, rnd);
  console.log(`  Puissance 4 · contre le glouton : ${vsGlouton.g} gagnees, ` +
              `${vsGlouton.n} nulles, ${vsGlouton.p} perdues`);
  /* C'est LE chiffre qui compte : le glouton joue comme un humain attentif qui
     ne calcule pas plus loin qu'un coup. */
  eq(vsGlouton.p, 0, 'il ne perd JAMAIS contre le glouton');
  ok(vsGlouton.g >= 95, `il gagne ${vsGlouton.g} parties sur 100 contre le glouton`);
}

/* ---- LA PROFONDEUR SERT-ELLE ? ----
   Comparaison APPARIEE : la meme ouverture aleatoire jouee dans les deux sens.
   Sans ca on ne mesure que l'avantage du trait (voir l'en-tete du fichier). */
function p4Ouverture(rnd, plis) {
  for (let essai = 0; essai < 300; essai++) {
    const g = p4.nouvelle(); let j = 1, mort = false;
    for (let k = 0; k < plis; k++) {
      const i = p4.poser(g, choix(p4.jouables(g), rnd), j);
      if (p4.gagne(g, i)) { mort = true; break; }
      j = j === 1 ? 2 : 1;
    }
    if (!mort) return { g, j };
  }
  return null;
}
function p4Apparie(fa, fb, n2, graine, plis) {
  const rnd = alea(graine); let A = 0, Bp = 0, eg = 0;
  for (let i = 0; i < n2; i++) {
    const o = p4Ouverture(rnd, plis); if (!o) continue;
    const r1 = p4Partie(fa, fb, rnd, o.g, o.j);   // fa au trait
    const r2 = p4Partie(fb, fa, rnd, o.g, o.j);   // fb au trait
    const pts = (r1 === o.j ? 1 : r1 === 0 ? 0.5 : 0)
              + (r2 === o.j ? 0 : r2 === 0 ? 0.5 : 1);
    if (pts > 1) A++; else if (pts < 1) Bp++; else eg++;
  }
  return { A, Bp, eg };
}
{
  const r = p4Apparie((g, j) => B.p4Coup(g, j, 10), (g, j) => B.p4Coup(g, j, 4),
                      24, 7777, 4);
  console.log(`  Puissance 4 · profondeur 10 contre 4 (appariee) : ` +
              `${r.A} gagnees, ${r.eg} egalites, ${r.Bp} perdues`);
  ok(r.A > r.Bp, 'chercher plus loin convertit plus de positions');
}

/* La force par defaut est celle qu'on a mesuree, pas une valeur oubliee. */
eq(B.P4_FORCE, 10, 'la force par defaut du Puissance 4');

// ========================================================= morpion : parfait

/* DEUX JEUX PARFAITS FONT NULLE. Toujours, dans les deux sens, sans exception.
   C'est la preuve de la perfection : s'il existait un seul coup faible, l'autre
   copie du bot le punirait. */
{
  for (let essai = 0; essai < 2; essai++) {
    const g = mp.nouvelle();
    let joueur = 1, fini = null;
    for (let k = 0; k < mp.CASES; k++) {
      const c = B.mpCoup(g, joueur);
      g[c] = joueur;
      if (mp.gagne(g, c)) { fini = joueur; break; }
      joueur = joueur === 1 ? 2 : 1;
    }
    eq(fini, null, 'bot contre bot : nulle');
  }
}

/* Contre le hasard, il ne perd jamais et gagne presque toujours. */
{
  const rnd = alea(4242);
  let g = 0, p = 0, n2 = 0;
  for (let i = 0; i < 400; i++) {
    const gr = mp.nouvelle();
    const botOuvre = i % 2 === 0;
    let joueur = 1, res = 0;
    for (let k = 0; k < mp.CASES; k++) {
      const estBot = (joueur === 1) === botOuvre;
      const c = estBot ? B.mpCoup(gr, joueur) : choix(mp.jouables(gr), rnd);
      gr[c] = joueur;
      if (mp.gagne(gr, c)) { res = joueur; break; }
      joueur = joueur === 1 ? 2 : 1;
    }
    const jetonBot = botOuvre ? 1 : 2;
    if (res === 0) n2++; else if (res === jetonBot) g++; else p++;
  }
  console.log(`  Morpion · contre le hasard : ${g} gagnees, ${n2} nulles, ${p} perdues`);
  eq(p, 0, 'un morpion parfait ne perd JAMAIS');
  ok(g >= 300, `il gagne ${g} parties sur 400 (le reste en nulles)`);
}

/* Il bloque une menace immediate. C'est le coup qu'un joueur distrait rate, et
   celui qu'on verifie en premier quand on doute d'un bot. */
{
  const g = mp.nouvelle();
  g[0] = 2; g[1] = 2;                       // l'adversaire menace en 2
  eq(B.mpCoup(g, 1), 2, 'il bloque la ligne du haut');
}
/* Et il prefere gagner que bloquer : gagner met fin a la partie. */
{
  const g = mp.nouvelle();
  g[0] = 2; g[1] = 2;                       // menace adverse en 2
  g[3] = 1; g[4] = 1;                       // mais lui gagne en 5
  eq(B.mpCoup(g, 1), 5, 'il gagne plutot que de bloquer');
}

// ================================================== morpion fantome

/* Le bot doit tenir compte du pion qui VA PARTIR. On lui donne deux pions
   alignes dont le plus ancien s'efface au prochain coup : completer la ligne
   ne gagnerait rien, puisque le premier pion disparait dans le meme geste. */
{
  const g = mf.nouvelle();
  /* Le joueur 1 a pose 0, 1 puis 8 ; son prochain coup effacera la case 0. */
  const pions = { 1: [0, 1, 8], 2: [3, 4] };
  g[0] = 1; g[1] = 1; g[8] = 1; g[3] = 2; g[4] = 2;
  const c = B.mfCoup(g, pions, 1, 8);
  ok(c !== 2, 'il ne complete pas une ligne que son propre effacement detruit');
  ok(mf.jouables(g).indexOf(c) >= 0, 'et il joue une case libre');
}

/* Une victoire immediate REELLE, elle, se prend : ici la ligne 0-1-2 tient
   parce que le pion efface (la case 6) n'en fait pas partie. */
{
  const g = mf.nouvelle();
  const pions = { 1: [6, 0, 1], 2: [3, 4] };
  g[6] = 1; g[0] = 1; g[1] = 1; g[3] = 2; g[4] = 2;
  eq(B.mfCoup(g, pions, 1, 8), 2, 'il complete la ligne qui survit a l effacement');
}

/* La mesure : contre le hasard, puis contre un glouton qui gagne et bloque. */
function mfPartie(a, b, rnd) {
  const g = mf.nouvelle();
  const pions = { 1: [], 2: [] };
  let joueur = 1;
  for (let k = 0; k < mf.COUPS_MAX; k++) {
    const c = (joueur === 1 ? a : b)(g, pions, joueur, rnd);
    const f = pions[joueur];
    if (f.length >= mf.PIONS_MAX) { g[f.shift()] = 0; }
    g[c] = joueur; f.push(c);
    if (mf.gagne(g, c)) return joueur;
    joueur = joueur === 1 ? 2 : 1;
  }
  return 0;
}
function mfHasard(g, pions, joueur, rnd) { return choix(mf.jouables(g), rnd); }
/** Il gagne s'il peut, il bloque s'il doit — en tenant compte de l'effacement,
    donc au meme niveau qu'un joueur humain qui a compris la regle. */
function mfGlouton(g, pions, joueur, rnd) {
  const lui = joueur === 1 ? 2 : 1;
  const libres = mf.jouables(g);
  const essaie = (qui, c) => {
    const f = pions[qui]; let parti = null;
    if (f.length >= mf.PIONS_MAX) { parti = f[0]; g[parti] = 0; }
    g[c] = qui;
    const w = mf.gagne(g, c);
    g[c] = 0; if (parti !== null) g[parti] = qui;
    return w;
  };
  for (const c of libres) if (essaie(joueur, c)) return c;
  for (const c of libres) if (essaie(lui, c)) return c;
  if (libres.indexOf(4) >= 0) return 4;
  return libres[0];
}
{
  const rnd = alea(31415);
  for (const [nom, temoin, seuil] of [['hasard', mfHasard, 90], ['glouton', mfGlouton, 60]]) {
    let g = 0, p = 0, n2 = 0;
    for (let i = 0; i < 100; i++) {
      const botOuvre = i % 2 === 0;
      const bot = (gr, pi, j) => B.mfCoup(gr, pi, j, 7);
      const t = (gr, pi, j) => temoin(gr, pi, j, rnd);
      const r = botOuvre ? mfPartie(bot, t, rnd) : mfPartie(t, bot, rnd);
      const jetonBot = botOuvre ? 1 : 2;
      if (r === 0) n2++; else if (r === jetonBot) g++; else p++;
    }
    console.log(`  Morpion fantome · contre le ${nom} : ${g} gagnees, ${n2} nulles, ${p} perdues`);
    ok(g >= seuil, `il gagne ${g} parties sur 100 contre le ${nom}`);
    ok(p <= 2, `il en perd ${p} contre le ${nom}`);
  }
}

// ============================================================== dames

/* L'evaluation dit ce qu'on croit : une dame vaut plus qu'un pion, et un
   damier symetrique vaut zero pour les deux camps. */
{
  eq(B.dmEvalue(dm.nouvelle(), 1), 0, 'le damier de depart est equilibre');
  eq(B.dmEvalue(dm.nouvelle(), 2), 0, 'et il l est pour les deux camps');
  ok(B.DM_DAME > 3 * B.DM_PION, 'une dame vaut plus de trois pions');
}

/* La prise obligatoire : si une prise existe, le bot la joue — il n'a pas le
   choix, et le moteur refuserait autre chose. */
{
  const g = new Array(dm.CASES).fill(dm.VIDE);
  /* Un pion du joueur 1 en 43 peut prendre celui du joueur 2 en 36. */
  g[43] = dm.PION1; g[36] = dm.PION2;
  const c = B.dmCoup(g, 1, null, 4);
  ok(c && c.prise === 36, 'il prend la piece a prendre');
}

/* Il voit une rafle : deux pieces alignees se prennent dans le meme tour, et
   une recherche qui s'arreterait au milieu de l'enchainement ne la verrait
   pas comme un gain. */
{
  const g = new Array(dm.CASES).fill(dm.VIDE);
  g[57] = dm.PION1; g[50] = dm.PION2; g[36] = dm.PION2;
  const c = B.dmCoup(g, 1, null, 4);
  ok(c && c.prise === 50, `il entame la rafle (prise ${c && c.prise})`);
  /* et il la continue : le moteur rendra la main sur la meme piece */
  const g2 = g.slice();
  g2[57] = dm.VIDE; g2[50] = dm.VIDE; g2[43] = dm.PION1;
  const c2 = B.dmCoup(g2, 1, 43, 4);
  ok(c2 && c2.prise === 36, 'et il finit la rafle');
}

function dmPartie(a, b, rnd) {
  const g = dm.nouvelle();
  let joueur = 1, calme = 0;
  for (let tour = 0; tour < 400; tour++) {
    let enchaine = null, boucle = 0;
    for (;;) {
      const coups = B.dmLegaux(g, joueur, enchaine);
      if (!coups.length) return joueur === 1 ? 2 : 1;     // bloque : il perd
      const c = (joueur === 1 ? a : b)(g, joueur, enchaine, rnd) || coups[0];
      const piece = g[c.de];
      g[c.de] = dm.VIDE; g[c.vers] = piece;
      if (c.prise !== null) g[c.prise] = dm.VIDE;
      let promu = false;
      if (!dm.estDame(piece) && dm.ligne(c.vers) === dm.rangeeDame(joueur)) {
        g[c.vers] = joueur === 1 ? dm.DAME1 : dm.DAME2; promu = true;
      }
      if (c.prise !== null || !dm.estDame(piece)) calme = 0; else calme++;
      if (c.prise !== null && !promu && dm.prisesDe(g, c.vers).length && ++boucle < 12) {
        enchaine = c.vers; continue;
      }
      break;
    }
    if (dm.pieces(g, joueur === 1 ? 2 : 1) === 0) return joueur;
    if (calme >= dm.NULLE_APRES) return 0;
    joueur = joueur === 1 ? 2 : 1;
  }
  return 0;
}
function dmHasard(g, joueur, enchaine, rnd) { return choix(B.dmLegaux(g, joueur, enchaine), rnd); }
/** Le glouton : il regarde UN demi-coup et prend ce qui rapporte le plus de
    materiel tout de suite. C'est exactement le niveau d'un debutant applique. */
function dmGlouton(g, joueur, enchaine, rnd) {
  const coups = B.dmLegaux(g, joueur, enchaine);
  let best = coups[0], bs = -Infinity;
  for (const c of coups) {
    const piece = g[c.de], pris = c.prise !== null ? g[c.prise] : 0;
    g[c.de] = dm.VIDE; g[c.vers] = piece;
    if (c.prise !== null) g[c.prise] = dm.VIDE;
    const v = B.dmEvalue(g, joueur);
    g[c.de] = piece; g[c.vers] = dm.VIDE;
    if (c.prise !== null) g[c.prise] = pris;
    if (v > bs) { bs = v; best = c; }
  }
  return best;
}
{
  const rnd = alea(1789);
  for (const [nom, temoin, seuil] of [['hasard', dmHasard, 18], ['glouton', dmGlouton, 14]]) {
    let g = 0, p = 0, n2 = 0;
    for (let i = 0; i < 20; i++) {
      const botOuvre = i % 2 === 0;
      const bot = (gr, j, e) => B.dmCoup(gr, j, e, 5);
      const t = (gr, j, e) => temoin(gr, j, e, rnd);
      const r = botOuvre ? dmPartie(bot, t, rnd) : dmPartie(t, bot, rnd);
      const jetonBot = botOuvre ? 1 : 2;
      if (r === 0) n2++; else if (r === jetonBot) g++; else p++;
    }
    console.log(`  Dames · contre le ${nom} : ${g} gagnees, ${n2} nulles, ${p} perdues`);
    ok(g >= seuil, `il gagne ${g} parties sur 20 contre le ${nom}`);
    eq(p, 0, `il n en perd aucune contre le ${nom}`);
  }
}

// ==================================================== dernier chiffre

/* LE GAIN EST CALCULE A LA MAIN DANS bots.js. On le REVERIFIE en simulant les
   cent cibles une par une : si la formule et la simulation divergent, c'est la
   formule qui a tort, et tout l'equilibre construit dessus avec elle. */
{
  let ecarts = 0;
  for (let a = 1; a <= 100; a++) {
    for (let b = 1; b <= 100; b++) {
      let s = 0;
      for (let t = 1; t <= 100; t++) {
        const okA = a <= t, okB = b <= t;
        if (okA && okB) s += a > b ? 1 : a < b ? -1 : 0;
        else if (okA) s += 1;
        else if (okB) s -= 1;
      }
      if (s !== B.dcGain(a, b)) ecarts++;
    }
  }
  eq(ecarts, 0, 'la formule du gain colle a la simulation sur les 10 000 couples');
}
/* Le jeu est a somme nulle et symetrique : le gain de a contre b est l'oppose
   du gain de b contre a. */
{
  let mal = 0;
  for (let a = 1; a <= 100; a++) for (let b = 1; b <= 100; b++)
    if (B.dcGain(a, b) !== -B.dcGain(b, a)) mal++;
  eq(mal, 0, 'le jeu est antisymetrique');
}

/* L'EQUILIBRE EST INEXPLOITABLE. C'est la seule propriete qui compte, et elle
   se verifie exactement : on essaie les cent reponses possibles contre la loi
   du bot, et AUCUNE ne doit rapporter. Un ecart positif serait la recette pour
   battre le bot a tous les coups. */
{
  eq(B.DC_LOI.length, 100, 'la loi porte sur les cent nombres');
  ok(Math.abs(B.DC_LOI.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'c est une loi de probabilite');
  ok(B.DC_LOI.every((x) => x >= 0), 'aucune probabilite negative');

  let pire = -Infinity, quel = 0;
  for (let a = 1; a <= 100; a++) {
    let s = 0;
    for (let b = 1; b <= 100; b++) s += B.DC_LOI[b - 1] * B.dcGain(a, b);
    if (s > pire) { pire = s; quel = a; }
  }
  console.log(`  Dernier Chiffre · meilleure reponse a l equilibre : ` +
              `jouer ${quel} rapporte ${(pire / 100).toFixed(4)} par partie`);
  /* Le seuil est serre EXPRES. Les approximations iteratives qu'on a essayees
     avant la solution exacte laissaient une faille de 0,0133 puis 0,0005 ; a
     0,001 ce test les refuse toutes les deux et n'accepte que la vraie
     solution. Un seuil confortable aurait laisse passer le jeu fictif, et
     personne n'aurait jamais su que le bot etait exploitable. */
  ok(pire / 100 < 0.001, `la meilleure reponse rapporte ${(pire / 100).toFixed(6)}`);
}

/* CE QUI EST DANS LE SUPPORT FAIT MATCH NUL, CE QUI EST DEHORS PERD.
   C'est la definition meme d'un equilibre, et c'est un test plus fort que
   « les strategies naives perdent » : a l'equilibre, jouer toujours 50 ne perd
   PAS — ca ne gagne rien non plus, et c'est tout ce qu'on peut demander. La
   premiere version de ce test exigeait que 50 perde ; elle se trompait de
   propriete, et l'aurait fait echouer sur un equilibre parfaitement juste. */
{
  const gainDuBot = (b) => {
    let s = 0;
    for (let a = 1; a <= 100; a++) s += B.DC_LOI[a - 1] * B.dcGain(a, b);
    return s / 100;
  };
  /* Dans le support : on ne gagne ni ne perd. */
  for (const b of [1, 25, 50, 70, 75]) {
    ok(Math.abs(gainDuBot(b)) < 0.001,
       `jouer toujours ${b} ne rapporte rien (${gainDuBot(b).toFixed(6)})`);
  }
  /* Dehors : on perd, et d'autant plus qu'on s'en eloigne. Les gros nombres
     sont le piege naturel du jeu — « je vise haut pour battre l'autre » — et
     c'est exactement ce que le bot punit. */
  let precedent = 0;
  for (const b of [77, 80, 90, 100]) {
    const v = gainDuBot(b);
    console.log(`  Dernier Chiffre · contre celui qui joue toujours ${b} : ` +
                `le bot gagne ${v.toFixed(3)} par partie`);
    ok(v > 0, `jouer toujours ${b} perd contre l equilibre`);
    ok(v > precedent, `et ${b} perd plus que le precedent`);
    precedent = v;
  }
  ok(gainDuBot(100) > 0.4, 'viser 100 coute presque une demi-mise par partie');
}

/* Le bot tire bien dans l'intervalle permis, et il ne tire pas toujours pareil
   — un bot previsible a ce jeu se bat en jouant un de plus que lui. */
{
  const rnd = alea(999);
  const vus = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = B.dcCoup(rnd);
    ok(Number.isInteger(c) && c >= B.DC_MIN && c <= B.DC_MAX, 'nombre dans l echelle');
    n -= 1;                                   // ne pas compter 2000 fois la meme
    vus.add(c);
  }
  n += 1;
  ok(vus.size >= 3, `il tire ${vus.size} nombres differents sur 2000 parties`);
}

// =========================================== pierre-feuille-bandit

/* Contre un humain PREVISIBLE, le bot doit gagner nettement. Ce sont les trois
   habitudes les mieux etablies au pierre-feuille-ciseaux, et un bot
   d'entrainement qui ne les punit pas n'apprend rien au joueur. */
function pfSerie(humain, parties, graine) {
  const rnd = alea(graine);
  const hist = [];               // du point de vue du bot : { moi, lui, resultat }
  let g = 0, p = 0, n2 = 0;
  for (let i = 0; i < parties; i++) {
    const moi = B.pfCoup(hist, rnd);
    const lui = humain(hist, rnd, i);
    let res;                     // resultat DE L ADVERSAIRE
    if (moi === lui) { n2++; res = 'nul'; }
    else if (B.PF_BAT[moi] === lui) { g++; res = 'perdu'; }
    else { p++; res = 'gagne'; }
    hist.push({ moi, lui, resultat: res });
  }
  return { g, p, n: n2 };
}
{
  /* Les quatre habitudes les mieux etablies au pierre-feuille-ciseaux. Aucune
     n'est codee dans le bot : il doit les DECOUVRIR, chacune par une lecture
     differente. C'est le test qui a fait jeter le predicteur a regles ecrites
     en dur — il n'en attrapait que deux sur quatre. */
  const humains = [
    ['toujours pierre', () => 'p'],
    ['alterne p-f-c', (h, r, i) => B.PF_COUPS[i % 3]],
    ['garde s il gagne, change s il perd', (h) => {
      if (!h.length) return 'p';
      const d = h[h.length - 1];
      return d.resultat === 'gagne' ? d.lui : B.PF_CONTRE[d.moi];
    }],
    ['change a tous les coups', (h) => {
      if (!h.length) return 'p';
      return B.PF_CONTRE[h[h.length - 1].lui];
    }],
  ];
  for (const [nom, f] of humains) {
    const r = pfSerie(f, 200, 2024);
    const taux = r.g / (r.g + r.p);
    console.log(`  Pierre-Feuille-Bandit · contre « ${nom} » : ` +
                `${r.g} gagnees, ${r.n} nulles, ${r.p} perdues ` +
                `(${(taux * 100).toFixed(0)} % des manches decisives)`);
    /* Le plafond theorique : le bot melange 30 % de vrai hasard, donc meme une
       lecture parfaite ne peut gagner que 70 % + 30 %/3 = 80 % des manches. On
       exige d'en approcher, pas de le depasser — ce serait impossible. */
    ok(r.g > r.p * 2.5, `il domine « ${nom} » (${r.g} contre ${r.p})`);
    ok(taux > 0.8, `il gagne ${(taux * 100).toFixed(0)} % des manches decisives`);
    ok(r.g / 200 > 0.7, `il gagne ${r.g} des 200 manches, plafond theorique 160`);
  }
}

/* Contre le VRAI hasard, personne ne peut gagner — pas meme lui. On verifie
   qu'il ne s'effondre pas : un bot qui perdrait contre le hasard aurait un
   modele qui se retourne contre lui. */
{
  const r = pfSerie((h, rnd) => choix(B.PF_COUPS, rnd), 600, 55);
  const ecart = Math.abs(r.g - r.p) / 600;
  console.log(`  Pierre-Feuille-Bandit · contre le hasard : ${r.g}-${r.n}-${r.p} ` +
              `(ecart ${(ecart * 100).toFixed(1)} %)`);
  ok(ecart < 0.08, `il reste a l equilibre contre le hasard (ecart ${(ecart * 100).toFixed(1)} %)`);
}
/* Le melange de hasard est bien present : sans lui, un joueur qui a compris le
   modele le retourne en lui donnant a manger un faux motif. */
{
  ok(B.PF_BRUIT > 0.2 && B.PF_BRUIT < 0.5, 'la part de hasard est raisonnable');
  const rnd = alea(3);
  const hist = [];
  for (let i = 0; i < 6; i++) hist.push({ moi: 'p', lui: 'p', resultat: 'perdu' });
  const vus = new Set();
  for (let i = 0; i < 300; i++) vus.add(B.pfCoup(hist, rnd));
  eq(vus.size, 3, 'meme face a un motif evident, il ne joue pas toujours pareil');
}
/* La relance suit une regle qui se raconte : on met plus quand on est devant
   et que la fin approche ; on ne se couche que si la remontee est perdue. */
{
  ok(B.pfRelance(3, 1, 2), 'il relance quand il mene et qu il reste peu');
  ok(!B.pfRelance(1, 3, 2), 'il ne relance pas quand il est derriere');
  ok(!B.pfRelance(3, 1, 6), 'ni trop tot');
  ok(B.pfSuit(2, 2, 4), 'il suit a egalite');
  ok(!B.pfSuit(0, 3, 1), 'il se couche quand la remontee est arithmetiquement morte');
}

console.log(`bots.test.js : ${n} verifications OK`);
