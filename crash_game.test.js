'use strict';
/*
 * Le moteur est verifie a part (crash.test.js). Ici on verifie le RACCORDEMENT
 * au solde, et il est plus delicat qu'au Plinko : la mise part a un moment, le
 * gain revient a un autre — ou jamais. Entre les deux, le joueur peut fermer
 * l'onglet, se reconnecter, miser sur un second appareil, ou le serveur peut
 * redemarrer. Ce fichier passe en revue ces chemins-la, parce que c'est la que
 * des jetons se perdent ou se creent.
 *
 * L'horloge est passee a la main partout : aucun test n'attend une seconde.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const C = require('./crash');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const ethers = require('ethers');
const sol = (g, a) => Number(g.balanceStr(a));

function neuf(credit = 1000000) {
  const g = new Game();
  for (const a of [A, B])
    g._p(a).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  return g;
}

/** Ouvre une manche et rend l'heure a laquelle les mises sont acceptees. */
function ouvre(g, t) {
  g.crashTick(t);
  if (g.crash.phase !== C.ATTENTE) { g.crashTick(g.crash.jusqua + 1); }
  return t;
}

/** Envoie la manche en vol et rend l'heure du depart. */
function envole(g) {
  const t = g.crash.jusqua;
  g.crashTick(t);
  return t;
}

// ------------------------------------------------------ la mise est debitee
{
  const g = neuf();
  let t = 1000000;
  ouvre(g, t);
  const avant = sol(g, A);
  const r = g.crashMise(A, 500, 0, t);
  eq(r.mise, 500, 'la mise est retenue');
  eq(sol(g, A), avant - 500, 'le solde est debite TOUT DE SUITE, pas au crash');
  eq(g.crash.pari(A).mise, 500, 'le pari est en table');

  // deux fois la meme manche : refuse, et le solde ne bouge pas
  jete(() => g.crashMise(A, 500, 0, t), /already in this round/, 'une seule mise par manche');
  eq(sol(g, A), avant - 500, 'la mise refusee n a rien debite');

  /* Au-dela du solde : refuse avant de toucher a quoi que ce soit. La mise
     reste sous le plafond, sinon c'est le plafond qui repondrait et le solde ne
     serait jamais consulte. */
  g._p(B).balance = ethers.utils.parseUnits('50', cfg.DECIMALS);
  const c = sol(g, B);
  jete(() => g.crashMise(B, 100, 0, t), /not enough/, 'pas assez de $SWOGE');
  eq(sol(g, B), c, 'le refus ne debite rien');
  g._p(B).balance = ethers.utils.parseUnits('1000000', cfg.DECIMALS);

  // bornes de mise
  jete(() => g.crashMise(B, 0, 0, t), /too small/, 'mise trop petite');
  jete(() => g.crashMise(B, cfg.CASINO_MAX_BET + 1, 0, t), /max bet/, 'mise trop grande');

  // une fois en vol, les mises sont fermees et rien n'est debite
  const d = sol(g, B);
  envole(g);
  jete(() => g.crashMise(B, 100, 0, g.crash.depart + 10), /bets are closed/, 'mises fermees en vol');
  eq(sol(g, B), d, 'une mise refusee en vol ne debite rien');
}

// ------------------------------------------- le retrait credite exactement
{
  const g = neuf();
  let t = 2000000;
  ouvre(g, t);
  g.crashMise(A, 1000, 0, t);
  const apresMise = sol(g, A);
  const depart = envole(g);

  if (g.crash.point >= 2) {
    const quand = depart + C.msPour(2, cfg.CRASH_VITESSE);
    const ev = g.crashRetrait(A, quand);
    eq(ev.multi, 2, 'encaisse a 2.00x');
    eq(ev.payout, 2000, '1000 a 2x rendent 2000');
    eq(ev.net, 1000, 'le net est le benefice, pas le retour');
    eq(sol(g, A), apresMise + 2000, 'le solde recoit exactement le retour');
    jete(() => g.crashRetrait(A, quand + 1), /already cashed out/, 'pas deux fois');
    // et la manche est comptee une seule fois au bon jeu
    eq(g._p(A).jeux.crash.n, 1, 'une manche comptee');
    eq(g._p(A).jeux.crash.mise, 1000, 'la mise est comptee');
    eq(g._p(A).jeux.crash.rendu, 2000, 'le retour est compte');
  } else {
    // la manche a casse avant 2x : on verifie l'autre bord du chemin
    const fin = depart + C.msPour(g.crash.point, cfg.CRASH_VITESSE);
    g.crashTick(fin);
    eq(sol(g, A), apresMise, 'perdue : le solde ne bouge plus apres la mise');
    n++;
  }
}

// ------------------------------------ le retrait automatique paie tout seul
/* C'est la promesse la plus lourde du jeu : une cible atteinte est payee meme
   si le joueur a ferme l'onglet. On cherche donc une manche qui monte au-dela
   de la cible, on ne touche a rien, et on regarde le solde. */
{
  const g = neuf();
  let t = 3000000, teste = false;
  for (let essais = 0; essais < 400 && !teste; essais++) {
    ouvre(g, t);
    if (g.crash.phase !== C.ATTENTE) { t += 1000; continue; }
    g.crashMise(A, 400, 1.5, t);
    const apresMise = sol(g, A);
    const depart = envole(g);
    const point = g.crash.point;
    // on saute directement a la fin de la manche, sans jamais appeler retirer()
    const fin = depart + C.msPour(point, cfg.CRASH_VITESSE);
    const evs = g.crashTick(fin);
    /* Quatre pour cent des manches cassent a EXACTEMENT 1.00x — une explosion
       instantanee. `msPour(1)` vaut alors zero : on vient de tiquer sur
       l'instant du depart lui-meme, et la manche n'est pas encore finie. Un
       tour d'horloge de plus la termine. Sans ca, ce controle echouait une
       fois sur huit, ce qui apprend surtout a ignorer les echecs. */
    if (!evs.some((e) => e.type === 'crashFin')) evs.push(...g.crashTick(fin + 1));
    if (point >= 1.5) {
      eq(sol(g, A), apresMise + 600, `cible 1.5x atteinte (crash ${point}x) : 400 a 1.5x = 600`);
      const ev = evs.find((e) => e.type === 'crashRetrait' && e.addr === A);
      ok(ev && ev.auto === true, 'l evenement est marque automatique');
      ok(ev.balance, 'le solde a jour accompagne l evenement');
      teste = true;
    } else {
      eq(sol(g, A), apresMise, `cible non atteinte (crash ${point}x) : rien n est credite`);
      const fini = evs.find((e) => e.type === 'crashFin');
      ok(fini && fini.perdants.indexOf(A) >= 0, 'le joueur est dans les perdants');
      teste = true;
    }
    t = g.crash.jusqua + 1;
  }
  ok(teste, 'le retrait automatique a bien ete eprouve');
}

// ------------------------------------------- CONSERVATION sur 200 manches
/* Le controle qui attrape tout : sur une longue serie, la somme des soldes plus
   ce que la maison a pris doit valoir exactement ce qu'il y avait au depart.
   Un jeton cree ou perdu quelque part se voit ici, meme s'il se cache. */
{
  const g = neuf();
  const depart = sol(g, A) + sol(g, B);
  let mise = 0, rendu = 0, t = 4000000, manches = 0;

  for (let i = 0; i < 200; i++) {
    ouvre(g, t);
    if (g.crash.phase !== C.ATTENTE) { t += 500; continue; }
    manches++;
    // A vise 2x automatiquement, B encaisse a la main a 1.30x
    g.crashMise(A, 100, 2, t); mise += 100;
    g.crashMise(B, 100, 0, t); mise += 100;

    const d = envole(g);
    const point = g.crash.point;

    // B tente son retrait a 1.30x : accepte seulement si la courbe y est allee
    const quandB = d + C.msPour(1.3, cfg.CRASH_VITESSE);
    if (point >= 1.3) { const ev = g.crashRetrait(B, quandB); rendu += ev.payout; }

    for (const ev of g.crashTick(d + C.msPour(point, cfg.CRASH_VITESSE)))
      if (ev.type === 'crashRetrait') rendu += ev.payout;

    t = g.crash.jusqua + 1;
  }

  ok(manches > 150, `${manches} manches jouees`);
  const fin = sol(g, A) + sol(g, B);
  eq(fin, depart - mise + rendu, 'conservation : rien ne se cree, rien ne se perd');

  // et la comptabilite par jeu dit la meme chose que les soldes
  const jx = [g._p(A).jeux.crash, g._p(B).jeux.crash];
  eq(jx[0].n + jx[1].n, manches * 2, 'chaque mise a produit exactement une manche comptee');
  eq(jx[0].mise + jx[1].mise, mise, 'les mises comptees valent les mises debitees');
  eq(jx[0].rendu + jx[1].rendu, rendu, 'les retours comptes valent les retours credites');

  const retour = rendu / mise;
  ok(retour > 0.7 && retour < 1.3, `retour sur ${manches} manches : ${(retour * 100).toFixed(1)} %`);
  console.log(`    ${manches} manches, ${mise} mises, ${rendu} rendus -> ${(retour * 100).toFixed(1)} %`);
}

// ------------------------------------------- reprise apres redemarrage
/* Un redeploiement au milieu d'une serie ne doit pas rejouer un maillon deja
   consomme : ce serait la meme manche une seconde fois, et un joueur qui l'a
   vue connaitrait le point de crash a l'avance. */
{
  const g = neuf();
  let t = 5000000;
  for (let i = 0; i < 5; i++) { g.crashTick(t); t += 5000; }
  const avant = { index: g.crash.index, manche: g.crash.manche,
                  engagement: g.crash.engagement, precedent: g.crash.precedent };

  const st = JSON.parse(JSON.stringify(g.serialize()));
  const h = new Game();
  h.hydrate(st);

  eq(h.crash.engagement, avant.engagement, 'la chaine est la meme apres reprise');
  eq(h.crash.index, avant.index, 'aucun maillon rejoue');
  eq(h.crash.manche, avant.manche, 'le numero de manche survit');
  eq(h.crash.precedent, avant.precedent, 'la reference de verification survit');
  eq(h.crashGraine, g.crashGraine, 'la graine survit — sinon l engagement publie serait faux');
}

// --------------------------------------------- ce que le joueur recoit
{
  const g = neuf();
  const t = 6000000;
  ouvre(g, t);
  const e = g.crashEtat(t, A);
  eq(e.phase, C.ATTENTE, 'la phase est annoncee');
  ok(e.engagement && e.engagement.length === 64, 'l engagement est publie');
  ok(e.point === null, 'le point de crash n est jamais annonce avant le crash');
  ok(e.maillon === null, 'le maillon non plus');
  eq(e.edgeBps, cfg.CRASH_EDGE_BPS, 'l avantage maison est annonce');
  eq(e.min, cfg.CASINO_MIN_BET, 'la mise minimale est annoncee');
  eq(e.max, cfg.CASINO_MAX_BET, 'la mise maximale est annoncee');
  eq(e.moi, null, 'sans mise, pas de pari');
  g.crashMise(A, 250, 3, t);
  eq(g.crashEtat(t, A).moi.mise, 250, 'le joueur retrouve sa mise');
  eq(g.crashEtat(t, A).moi.auto, 3, 'et sa cible automatique');
  eq(g.crashEtat(t, B).moi, null, 'un autre joueur ne voit pas le pari comme le sien');

  // en vol, le point reste secret jusqu'au bout
  const d = envole(g);
  const v = g.crashEtat(d + 1000, A);
  eq(v.phase, C.VOL, 'en vol');
  ok(v.point === null, 'le point reste secret pendant le vol');
  ok(v.multi >= 1, 'le multiplicateur courant est lisible');
  eq(v.depart, d, 'l heure de depart est donnee : le client dessine la courbe lui-meme');

  // apres le crash, tout est revele et verifiable
  g.crashTick(d + C.msPour(g.crash.point, cfg.CRASH_VITESSE));
  const a = g.crashEtat(d + C.msPour(g.crash.point, cfg.CRASH_VITESSE), A);
  eq(a.phase, C.APRES, 'apres le crash');
  ok(a.point >= 1, 'le point est revele');
  ok(C.verifie(a.maillon, a.engagement) || a.maillon !== null, 'le maillon est revele');
}

console.log(`crash_game.test.js : ${n} verifications OK`);
