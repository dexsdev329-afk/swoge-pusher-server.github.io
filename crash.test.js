'use strict';
/*
 * Verification du Crash.
 *
 * Le point clef n'est pas "ca a l'air juste sur 100 000 manches" : c'est que
 * pour CHAQUE cible que le joueur peut viser — les 999 900 valeurs a deux
 * decimales entre 1.01x et 10 000x — le taux de retour se calcule exactement
 * sur les 2^52 issues du tirage, et vaut au plus 1 - avantage. On les parcourt
 * TOUTES. Aucun multiplicateur, aucune strategie, ne doit sortir du lot : c'est
 * la promesse du jeu, et une promesse ne se sonde pas par echantillon.
 *
 * La simulation qui suit ne sert pas a etablir la loi — elle sert a verifier
 * que le tirage reel suit bien la loi qu'on vient de prouver.
 */
const assert = require('assert');
const crypto = require('crypto');
const C = require('./crash');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m} : ${a} vs ${b}`); n++; };

const BPS = 300;              // 3 % d'avantage maison
const CIBLE = 1 - BPS / 10000;   // 0.97
const SEL = 'swoge-crash-v1';
const PLAFOND = 10000;
const VITESSE = 0.00006;

// ------------------------------------------------ la chaine de hash tient
{
  const c = C.chaine('graine-de-test', 500);
  eq(c.maillons.length, 500, 'la chaine a le nombre de maillons demande');
  ok(C.verifie(c.maillons[0], c.engagement), 'maillon 1 -> engagement publie');
  for (let i = 1; i < 500; i++)
    if (!C.verifie(c.maillons[i], c.maillons[i - 1])) {
      ok(false, `maillon ${i + 1} ne redonne pas le precedent`); break;
    }
  n++; // la boucle ci-dessus vaut une verification
  ok(new Set(c.maillons).size === 500, 'aucun maillon ne se repete');
  // Deux graines differentes ne partagent rien : sinon une manche serait rejouable
  const d = C.chaine('une-autre-graine', 500);
  ok(d.engagement !== c.engagement, 'une autre graine, un autre engagement');
  ok(!c.maillons.some((m) => d.maillons.indexOf(m) >= 0), 'aucun maillon en commun');
}

// -------------------------------------- taux de retour, TOUTES les cibles
/* Pour une cible X = 100x, les issues gagnantes sont exactement floor(100n/X)
   sur 2^52. On verifie que le retour ne depasse JAMAIS 1 - avantage, et qu'il
   ne s'en ecarte jamais de plus d'un cheveu par le bas (l'arrondi entier). */
{
  let pire = 1, meilleur = 0, cibleDuPire = 0;
  for (let X = 101; X <= PLAFOND * 100; X++) {
    const r = C.retour(X / 100, BPS);
    if (r > CIBLE + 1e-12) { ok(false, `cible ${X / 100}x : retour ${r} > ${CIBLE}`); break; }
    if (r > meilleur) meilleur = r;
    if (r < pire) { pire = r; cibleDuPire = X / 100; }
  }
  n++; // la boucle entiere vaut une verification
  /* 1e-12 : le comptage est exact en BigInt, mais le rapport final passe en
     flottant pour etre lisible — la derniere decimale est celle d'IEEE 754, pas
     celle du jeu. */
  ok(meilleur <= CIBLE + 1e-12, `le meilleur retour (${(meilleur * 100).toFixed(4)} %) reste sous la cible`);
  /* Le retour ne peut baisser que par la division entiere, qui coute au plus
     une issue sur floor(100n/X) — donc rien aux petites cibles, et au pire un
     pourcent tout en haut du plafond ou les issues gagnantes se comptent. */
  ok(pire > CIBLE - 0.01, `le pire retour (${(pire * 100).toFixed(4)} % a ${cibleDuPire}x) reste a moins d'un point`);
  console.log(`    retour sur ${(PLAFOND * 100 - 100).toLocaleString('fr')} cibles : ` +
              `de ${(pire * 100).toFixed(4)} % a ${(meilleur * 100).toFixed(4)} % (cible ${(CIBLE * 100).toFixed(2)} %)`);

  // quelques cibles rondes, verifiees a la main : P(atteindre x) = (1-p)/x
  for (const x of [1.01, 1.5, 2, 3, 5, 10, 100, 1000]) {
    pres(C.retour(x, BPS), CIBLE, 1e-9, `retour a ${x}x`);
    pres(C.retour(x, BPS) / x, CIBLE / x, 1e-9, `P(atteindre ${x}x) = (1-p)/${x}`);
  }
  // sans avantage, le jeu est exactement equitable
  for (const x of [1.5, 2, 7.25]) pres(C.retour(x, 0), 1, 1e-9, `sans avantage, retour a ${x}x`);
  // un avantage plus gros rend moins, toujours
  ok(C.retour(2, 500) < C.retour(2, 300), 'plus d avantage, moins de retour');
}

// --------------------------------------------- la loi du point de crash
/* On tire beaucoup de manches et on compare la frequence observee a la loi
   demontree plus haut. C'est la seule partie statistique du fichier, et elle ne
   demontre rien : elle attrape une erreur de branchement entre la formule et le
   tirage reel. */
{
  const N = 200000;
  const points = new Array(N);
  for (let i = 0; i < N; i++)
    points[i] = C.pointDeCrash('maillon-' + i, SEL, BPS, PLAFOND);

  ok(points.every((p) => p >= 1), 'aucun point de crash sous 1.00x');
  ok(points.every((p) => p <= PLAFOND), 'aucun point de crash au-dessus du plafond');
  ok(points.every((p) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-9),
     'tous les points ont exactement deux decimales');

  /* Attention au piege : les manches a 1.00x sont PLUS nombreuses que
     l'avantage maison. Deux sources s'additionnent — les 3 % de crash immediat,
     et la bande entre 1.00x et 1.01x, qui n'est pas vide et que l'arrondi vers
     le bas ramene a 1.00x. La proportion exacte se lit dans la loi deja
     prouvee : P(M = 1.00) = 1 - P(M >= 1.01) = 1 - retour(1.01)/1.01. */
  const attendu100 = N * (1 - C.retour(1.01, BPS) / 1.01);
  const rates = points.filter((p) => p === 1).length;
  const ecart = Math.abs(rates - attendu100) / Math.sqrt(attendu100 * (1 - attendu100 / N));
  ok(ecart < 4, `manches a 1.00x : ${rates} contre ${Math.round(attendu100)} attendus (${ecart.toFixed(2)} ecarts-types)`);
  ok(rates > N * BPS / 10000,
     'il y a bien plus de manches a 1.00x que le seul avantage maison');

  for (const x of [1.5, 2, 5, 20]) {
    const atteints = points.filter((p) => p >= x).length;
    const attendu = N * CIBLE / x;
    const e = Math.abs(atteints - attendu) / Math.sqrt(attendu);
    ok(e < 4, `P(atteindre ${x}x) : ${atteints} contre ${Math.round(attendu)} attendus (${e.toFixed(2)} ecarts-types)`);
  }

  // le retour mesure, toutes cibles confondues
  for (const x of [1.5, 2, 10]) {
    const gagne = points.filter((p) => p >= x).length * x;
    const mesure = gagne / N;
    pres(mesure, CIBLE, 0.02, `retour mesure a ${x}x sur ${N} manches`);
    console.log(`    ${N.toLocaleString('fr')} manches, cible ${x}x : mesure ${(mesure * 100).toFixed(2)} % contre ${(CIBLE * 100).toFixed(2)} % calcule`);
  }

  // le meme maillon redonne le meme point : une manche se reverifie
  eq(C.pointDeCrash('maillon-42', SEL, BPS, PLAFOND),
     C.pointDeCrash('maillon-42', SEL, BPS, PLAFOND), 'le tirage est reproductible');
  // un autre sel donne un autre resultat : le sel entre bien dans le calcul
  ok(C.pointDeCrash('maillon-42', 'autre-sel', BPS, PLAFOND) !==
     C.pointDeCrash('maillon-42', SEL, BPS, PLAFOND), 'le sel change le tirage');
}

// ------------------------------------------------------------- la courbe
{
  eq(C.multiA(0, VITESSE), 1, 'la courbe part de 1.00x');
  eq(C.multiA(-5, VITESSE), 1, 'avant le depart, 1.00x');
  ok(C.multiA(1000, VITESSE) > 1, 'la courbe monte');
  for (let ms = 0; ms < 60000; ms += 137)
    if (C.multiA(ms + 137, VITESSE) < C.multiA(ms, VITESSE)) {
      ok(false, `la courbe redescend a ${ms} ms`); break;
    }
  n++;
  ok(Math.abs(C.multiA(10000, VITESSE) - 1.82) < 0.01, '10 s -> environ 1.82x');
  ok(Math.abs(C.multiA(30000, VITESSE) - 6.04) < 0.02, '30 s -> environ 6.05x');

  /* L'aller-retour temps <-> multiplicateur doit tenir : c'est lui qui decide
     si un retrait automatique tombe avant ou apres le crash. S'il derapait d'une
     milliseconde, un joueur perdrait une mise qu'il avait gagnee. */
  for (const x of [1.01, 1.5, 2, 3.33, 10, 100, 1000, 10000]) {
    const ms = C.msPour(x, VITESSE);
    ok(C.multiA(ms, VITESSE) >= x, `a ${ms} ms la courbe atteint bien ${x}x`);
    ok(C.multiA(ms - 1, VITESSE) < x, `une ms plus tot elle n'y est pas encore (${x}x)`);
  }
}

// -------------------------------------------------- le deroule d'une manche
/* On rejoue des manches entieres en avancant l'horloge a la main. Aucun
   minuteur, donc aucune attente : le deroule est une fonction du temps. */
{
  const t = new C.Table({ graine: 'manche-de-test', longueur: 200, sel: SEL,
                          edgeBps: BPS, plafond: PLAFOND, vitesse: VITESSE,
                          attenteMs: 7000, apresMs: 4000 });
  let now = 1000000;

  let evs = t.tick(now);
  eq(evs.length, 1, 'le premier tick ouvre les mises');
  eq(evs[0].type, 'crashAttente', 'la manche s ouvre par une attente');
  eq(t.phase, C.ATTENTE, 'phase attente');
  eq(t.manche, 1, 'premiere manche');

  // pendant l'attente, on mise
  t.parier('0xa', 100, 0, now);
  t.parier('0xb', 200, 2, now);       // retrait automatique a 2x
  assert.throws(() => t.parier('0xa', 50, 0, now), /already in this round/);
  n++;
  assert.throws(() => t.retirer('0xa', now), /no round in flight/);
  n++;
  eq(t.liste().length, 2, 'deux joueurs en table');

  // rien ne bouge tant que l'attente n'est pas ecoulee
  eq(t.tick(now + 6999).length, 0, 'l attente tient jusqu au bout');
  eq(t.phase, C.ATTENTE, 'toujours en attente');

  now += 7000;
  evs = t.tick(now);
  eq(evs[0].type, 'crashDepart', 'les mises fermees, la courbe part');
  eq(t.phase, C.VOL, 'phase vol');
  assert.throws(() => t.parier('0xc', 100, 0, now), /bets are closed/);
  n++;
  ok(t.etat(now).point === null, 'le point de crash reste secret pendant le vol');
  ok(t.etat(now).maillon === null, 'le maillon reste secret pendant le vol');

  const point = t.point;
  ok(point >= 1 && point <= PLAFOND, 'le point de crash est dans les bornes');

  // on avance jusqu'au crash en collectant tout
  const vus = [];
  const fin = t.depart + C.msPour(point, VITESSE);
  for (let k = 0; now <= fin + 100 && k < 100000; k++, now += 50)
    for (const e of t.tick(now)) vus.push(e);

  const crash = vus.find((e) => e.type === 'crashFin');
  ok(crash, 'la manche finit par crasher');
  eq(crash.point, point, 'le point annonce est celui qui a ete tire');
  ok(C.verifie(crash.maillon, t.engagement), 'le maillon revele verifie l engagement');

  // 0xb avait une cible a 2x : il encaisse si et seulement si la courbe y est allee
  const retrait = vus.find((e) => e.type === 'crashRetrait' && e.addr === '0xb');
  if (point >= 2) {
    ok(retrait, 'le retrait automatique a bien eu lieu');
    eq(retrait.multi, 2, 'encaisse exactement a la cible');
    eq(retrait.payout, 400, '200 mises a 2x rendent 400');
    ok(retrait.auto === true, 'marque comme automatique');
    ok(crash.perdants.indexOf('0xb') < 0, 'un joueur encaisse n est pas perdant');
  } else {
    ok(!retrait, 'pas de retrait : la courbe a casse avant la cible');
    ok(crash.perdants.indexOf('0xb') >= 0, 'il est dans les perdants');
  }
  ok(crash.perdants.indexOf('0xa') >= 0, '0xa n a jamais encaisse, il perd');

  // la manche suivante s'ouvre apres le temps d'arret
  now = crash.quand + 4000;
  evs = t.tick(now);
  ok(evs.some((e) => e.type === 'crashAttente'), 'la manche suivante s ouvre');
  eq(t.manche, 2, 'deuxieme manche');
  eq(t.liste().length, 0, 'la table est vidée');
  eq(t.etat(now).precedent, crash.maillon,
     'le maillon revele devient la reference de la manche suivante');
}

// ------------------------------------------------- le retrait a la main
{
  // une manche dont on connait le point d'avance : on cherche un maillon haut
  const t = new C.Table({ graine: 'retrait-main', longueur: 5000, sel: SEL,
                          edgeBps: BPS, plafond: PLAFOND, vitesse: VITESSE });
  // on avance de manche en manche jusqu'a en trouver une qui monte au-dela de 3x
  let now = 500000, trouve = false;
  for (let essais = 0; essais < 300 && !trouve; essais++) {
    t.tick(now);                       // ouvre
    if (t.phase !== C.ATTENTE) { now += 1000; continue; }
    t.parier('0xz', 100, 0, now);
    now += 7000; t.tick(now);          // envol
    if (t.point >= 3) {
      trouve = true;
      const quand = t.depart + C.msPour(2, VITESSE);
      const ev = t.retirer('0xz', quand);
      eq(ev.multi, 2, 'encaisse au multiplicateur de l horloge serveur');
      eq(ev.payout, 200, '100 mises a 2x rendent 200');
      eq(ev.auto, false, 'marque comme manuel');
      assert.throws(() => t.retirer('0xz', quand + 1), /already cashed out/);
      n++;
      // trop tard : au-dela du point de crash, l'encaissement est refuse
      const t2 = new C.Table({ graine: 'trop-tard', longueur: 50, sel: SEL,
                               edgeBps: BPS, plafond: PLAFOND, vitesse: VITESSE });
      let m = 900000;
      t2.tick(m); t2.parier('0xy', 100, 0, m); m += 7000; t2.tick(m);
      const apres = t2.depart + C.msPour(t2.point, VITESSE) + 5000;
      assert.throws(() => t2.retirer('0xy', apres), /too late/);
      n++;
    }
    // on va au bout de la manche pour passer a la suivante
    now = t.depart + C.msPour(t.point, VITESSE) + 4000;
    t.tick(now);
  }
  ok(trouve, 'une manche au-dessus de 3x a bien ete trouvee');
}

// --------------------------------------------- l horloge peut sauter
/* Un serveur gele (redemarrage, pic de charge) ne doit pas rester coince dans
   le passe : le tick doit rattraper les phases sautees. */
{
  const t = new C.Table({ graine: 'saut', longueur: 100, sel: SEL, edgeBps: BPS,
                          plafond: PLAFOND, vitesse: VITESSE });
  let now = 2000000;
  t.tick(now);
  eq(t.phase, C.ATTENTE, 'attente ouverte');

  /* Dix minutes de gel pendant l'attente. La courbe doit partir MAINTENANT et
     pas etre datee d'il y a dix minutes : anti-datee, elle serait deja crashee
     et tous ceux qui avaient mise perdraient sans avoir rien pu faire. */
  now += 600000;
  const evs = t.tick(now);
  eq(evs[0].type, 'crashDepart', 'la courbe part au reveil');
  eq(t.depart, now, 'le vol est date du reveil, jamais anti-date');
  ok(t.index <= 1, 'un seul maillon consomme, aucune manche jouee a vide');

  /* Gel pendant le vol, cette fois. Une cible sous le point de crash doit etre
     payee au reveil : le joueur avait gagné avant que le serveur ne se fige. */
  const u = new C.Table({ graine: 'gel-en-vol', longueur: 3000, sel: SEL,
                          edgeBps: BPS, plafond: PLAFOND, vitesse: VITESSE });
  let m = 5000000, teste = false;
  for (let essais = 0; essais < 400 && !teste; essais++) {
    u.tick(m);
    if (u.phase !== C.ATTENTE) { m += 1000; continue; }
    u.parier('0xgel', 100, 2, m);        // cible a 2x
    m += 7000; u.tick(m);                // envol
    const point = u.point;
    // on saute par-dessus TOUTE la manche d'un coup
    const vus = u.tick(m + 600000);
    const paye = vus.find((e) => e.type === 'crashRetrait' && e.addr === '0xgel');
    if (point >= 2) {
      ok(paye, `cible 2x atteinte (crash a ${point}x) : payee malgre le gel`);
      eq(paye.multi, 2, 'payee exactement a la cible, pas au multiplicateur du reveil');
      teste = true;
    } else {
      ok(!paye, `cible 2x non atteinte (crash a ${point}x) : rien n'est paye`);
      teste = true;
    }
    m = u.jusqua + 1;
  }
  ok(teste, 'le gel en plein vol a bien ete eprouve');
}

// ------------------------------------------ reprise apres redemarrage
{
  const a = new C.Table({ graine: 'reprise', longueur: 100, sel: SEL, edgeBps: BPS,
                          plafond: PLAFOND, vitesse: VITESSE });
  let now = 3000000;
  for (let i = 0; i < 5; i++) { for (const e of a.tick(now)) void e; now += 4000; }
  const st = a.sauve();
  const b = new C.Table({ graine: 'reprise', longueur: 100, sel: SEL, edgeBps: BPS,
                          plafond: PLAFOND, vitesse: VITESSE });
  b.charge(st);
  eq(b.index, a.index, 'la reprise ne rejoue pas un maillon consomme');
  eq(b.manche, a.manche, 'le numero de manche survit');
  eq(b.precedent, a.precedent, 'la reference de verification survit');
}

// ------------------------------------------------------- les mises refusees
{
  const t = new C.Table({ graine: 'refus', longueur: 50, sel: SEL, edgeBps: BPS,
                          plafond: PLAFOND, vitesse: VITESSE });
  const now = 4000000;
  t.tick(now);
  assert.throws(() => t.parier('0x1', 100, 1.0, now), /at least 1.01x/);
  n++;
  assert.throws(() => t.parier('0x2', 100, PLAFOND + 1, now), /above the/);
  n++;
  assert.throws(() => t.retirer('0x9', now), /no round in flight/);
  n++;
  t.parier('0x3', 100, 0, now);
  eq(t.pari('0x3').auto, 0, 'sans cible, pas de retrait automatique');
  eq(t.pari('0x4'), null, 'un joueur sans mise n a pas de pari');
  t.parier('0x5', 100, 2.567, now);
  eq(t.pari('0x5').auto, 2.56, 'la cible est rabotee a deux decimales, vers le bas');
}

console.log(`crash.test.js : ${n} verifications OK`);
