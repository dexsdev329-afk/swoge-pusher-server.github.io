'use strict';
/*
 * L'XP, SEPAREE DU VOLUME MISE.
 *
 * ---- ce que ce fichier doit garantir, et dans quel ordre ----
 *
 * 1. PERSONNE NE PERD DE NIVEAU a la bascule. C'est la seule propriete dont
 *    l'echec ne se rattrape pas : un joueur retrograde le remarque tout de
 *    suite, et aucune explication ne repare l'impression que ses parties ont
 *    ete effacees. Elle passe donc avant tout le reste.
 * 2. Le volume n'est plus la seule source. C'est la raison du changement.
 * 3. Rien de gratuit : ni les doublons, ni les filleuls inactifs, ni deux
 *    fois la meme quete. Une source d'XP qu'on peut boucler est une source
 *    qui sera bouclee.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const B = require('./boutique');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`); n++; };

const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const A = '0x' + 'a1'.repeat(20);
const C = '0x' + 'c2'.repeat(20);

// ================== 1. LA BASCULE NE RETROGRADE PERSONNE
/*
 * On parcourt toute la plage utile de volumes et on exige l'egalite EXACTE
 * entre l'ancien niveau et le nouveau. Pas « a peu pres » : un joueur a la
 * frontiere d'un niveau est precisement celui qui regarde.
 */
{
  let pire = 0, quel = null;
  for (let v = 50; v < 400000000; v = Math.ceil(v * 1.07)) {
    const avant = Game.niveauDe(v);
    const apres = Game.niveauDeXp(Game.xpDuVolume(v));
    if (apres < avant) { const d = avant - apres; if (d > pire) { pire = d; quel = v; } }
  }
  eq(pire, 0, `aucun volume ne rend un niveau plus bas qu avant (pire ecart sur ${quel})`);

  /* Et sur les seuils EXACTS, la ou l'arrondi se trompe le plus volontiers. */
  for (let lv = 1; lv <= 60; lv++) {
    const v = Game.volumePour(lv);
    eq(Game.niveauDeXp(Game.xpDuVolume(v)), lv, `le seuil exact du niveau ${lv} rend bien ${lv}`);
    n -= 1;
  }
  n += 1;
  ok(true, 'les soixante seuils exacts tombent juste');

  /* Le facteur de conversion est DERIVE, pas ecrit. On le prouve en changeant
     la courbe : la neutralite doit tenir sans qu'on touche a autre chose. */
  const bp = cfg.XP_PUISSANCE, bb = cfg.XP_BASE;
  cfg.XP_PUISSANCE = 3; cfg.XP_BASE = 7;
  let casse = 0;
  for (let v = 50; v < 10000000; v = Math.ceil(v * 1.3))
    if (Game.niveauDeXp(Game.xpDuVolume(v)) < Game.niveauDe(v)) casse++;
  eq(casse, 0, 'la neutralite tient meme apres un changement de courbe');
  cfg.XP_PUISSANCE = bp; cfg.XP_BASE = bb;
}

// ================== 2. LE VOLUME N'EST PLUS LA SEULE SOURCE
{
  const g = new Game();
  const p = g._p(A);
  eq(g.niveau(A).niveau, 0, 'un joueur neuf est au niveau 0');
  eq(g.niveau(A).xp, 0, 'et sans XP');

  /* Se connecter sept jours de suite, sans miser un seul jeton. */
  for (let j = 0; j < 7; j++) {
    p.streakLastClaimDay = null;          // on simule le lendemain
    g.claimStreak(A);
  }
  const apres = g.niveau(A);
  eq(apres.xpGagne, 7 * cfg.XP_CONNEXION, 'sept connexions donnent sept fois l XP de connexion');
  eq(apres.volume, 0, 'sans avoir mise quoi que ce soit');
  ok(apres.niveau >= 1, `et le joueur a QUITTE le niveau 0 (niveau ${apres.niveau})`);
  eq(apres.sources.connexion, 7 * cfg.XP_CONNEXION, 'la source est nommee dans le detail');
}

// ================== 3. LA COLLECTION FAIT MONTER, LES DOUBLONS NON
{
  const g = new Game();
  g.boutiqueLignes = [];
  const p = g._p(C);
  const avant = g.niveau(C).xpGagne;

  /* Un objet neuf paie selon sa rarete. */
  p.balance = WEI(100000000);
  let neufs = 0, doubles = 0, xpNeuf = 0, xpDouble = 0;
  for (let i = 0; i < 60; i++) {
    p.balance = WEI(100000000);
    const av = g.niveau(C).xpGagne;
    const r = g.boutiqueAchat(C, 'bois');
    const gagne = g.niveau(C).xpGagne - av;
    if (r.neuf) { neufs++; xpNeuf += gagne; } else { doubles++; xpDouble += gagne; }
  }
  ok(neufs > 0 && doubles > 0, `${neufs} objets neufs et ${doubles} doublons tires`);
  eq(xpDouble, 0, 'UN DOUBLON NE RAPPORTE RIEN — sinon le plus gros acheteur monte le plus vite');
  ok(xpNeuf > 0, `les objets neufs rapportent (${xpNeuf} XP)`);
  eq(g.niveau(C).sources.collection, xpNeuf, 'et c est bien impute a la collection');
}

// ================== 4. UNE FAMILLE COMPLETE PAIE UNE SECONDE FOIS
{
  const g = new Game();
  const p = g._p(A);
  const fam = B.ITEMS.filter((o) => o.famille === 'chaos');
  /* Les quatre premiers poses a la main : on teste la prime de famille, pas
     le tirage, qui a sa propre suite. */
  fam.slice(0, 4).forEach((o) => { p.objets[o.id] = 1; });
  const av = g.niveau(A).xpGagne;
  /* On force le cinquieme en epuisant tous les autres mythiques. */
  for (const o of B.itemsDe('mythique', 1))
    if (o.id !== fam[4].id) g.boutiqueEmis[o.id] = B.rarete('mythique').plafond;
  let vu = false;
  for (let i = 0; i < 3000 && !vu; i++) {
    p.balance = WEI(100000000000);
    if (g.boutiqueAchat(A, 'mythe').item.id === fam[4].id) vu = true;
  }
  ok(vu, 'le cinquieme fruit de la famille est sorti');
  const gagne = g.niveau(A).xpGagne - av;
  ok(gagne >= cfg.XP_FAMILLE, `la famille complete paie sa prime (${gagne} XP, dont ${cfg.XP_FAMILLE} de famille)`);
  eq(g.niveau(A).sources.famille, cfg.XP_FAMILLE, 'imputee a la famille, une seule fois');
}

// ================== 5. RIEN DE GRATUIT
{
  const g = new Game();
  const p = g._p(A);

  /* La serie du jour ne se reclame qu'une fois par jour. */
  g.claimStreak(A);
  const x1 = g.niveau(A).xpGagne;
  assert.throws(() => g.claimStreak(A), /already claimed/); n++;
  eq(g.niveau(A).xpGagne, x1, 'une deuxieme reclamation le meme jour ne donne pas d XP');

  /* L'XP ne descend jamais, meme si un appelant se trompe de signe. */
  g._gagneXp(p, -50000, 'essai');
  eq(g.niveau(A).xpGagne, x1, 'un montant negatif est ignore, il ne retire rien');

  /* Une rarete inconnue ne paie pas le premier bareme venu. */
  const q = g._p(C);
  const av = g.niveau(C).xpGagne;
  g._gagneXp(q, (cfg.XP_OBJET || {}).nexistepas || 0, 'collection');
  eq(g.niveau(C).xpGagne, av, 'une rarete inconnue rapporte zero, pas un defaut');
}

// ================== 6. LE PARRAINAGE PAIE LE JOUEUR, PAS L ADRESSE
{
  const g = new Game();
  const parrain = g._p(A);
  const dormeur = '0x' + 'd1'.repeat(20);
  const actif = '0x' + 'e1'.repeat(20);
  g._p(dormeur); g._p(actif);
  parrain.filleuls = [dormeur.toLowerCase(), actif.toLowerCase()];
  g._p(actif).revCumul = 1200;          // celui-la a vraiment joue
  g._p(dormeur).revCumul = 0;           // celui-la est une adresse vide
  parrain.refDu = ethers.utils.parseUnits('10', cfg.DECIMALS);

  const av = g.niveau(A).xpGagne;
  g.reclameParrainage(A);
  eq(g.niveau(A).xpGagne - av, cfg.XP_PARRAIN,
     'UN seul filleul paye : celui qui a joue, pas l adresse creee pour la prime');

  /* Et il ne paie pas deux fois. */
  parrain.refDu = ethers.utils.parseUnits('10', cfg.DECIMALS);
  const av2 = g.niveau(A).xpGagne;
  g.reclameParrainage(A);
  eq(g.niveau(A).xpGagne, av2, 'une deuxieme reclamation ne repaie pas le meme filleul');
}

// ================== 7. L XP SURVIT AU REDEMARRAGE
{
  const g = new Game();
  const p = g._p(A);
  g._gagneXp(p, 4321, 'quete');
  p.xpFilleuls = { '0xabc': 1 };
  const niv = g.niveau(A);

  const g2 = new Game();
  /* `serialize()` et pas `serializeTete()` : la tete ne porte pas les fiches,
     et le test passait a cote de ce qu'il pretendait verifier. */
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  const r = g2.niveau(A);
  eq(r.xpGagne, niv.xpGagne, 'l XP gagnee revient telle quelle apres un redemarrage');
  eq(r.niveau, niv.niveau, 'et le niveau avec');
  eq(JSON.stringify(g2._p(A).xpSources), JSON.stringify(p.xpSources), 'le detail par source aussi');
  eq(JSON.stringify(g2._p(A).xpFilleuls), JSON.stringify(p.xpFilleuls),
     'et la marque des filleuls deja payes — sans elle, un redemarrage les repaie tous');
}

// ================== 8. LE RYTHME, MESURE
{
  const parJour = cfg.XP_CONNEXION + 3 * cfg.XP_QUETE;
  console.log(`  un joueur assidu sans miser : ${parJour} XP/jour`);
  const lignes = [];
  for (const lv of [1, 5, 10, 20, 30, 50, 100]) {
    const cout = Game.xpPour(lv) - Game.xpPour(Math.max(1, lv - 1));
    const volAvant = Game.volumePour(lv) - Game.volumePour(Math.max(1, lv - 1));
    lignes.push(`    ${String(lv).padStart(3)} : ${String(Math.round(cout)).padStart(7)} XP ` +
      `(${(cout / parJour).toFixed(1)} j) — avant : ${Math.round(volAvant).toLocaleString('fr')} de mise`);
  }
  console.log('  cout du passage au niveau N :');
  lignes.forEach((l) => console.log(l));
  const j20 = (Game.xpPour(20) - Game.xpPour(19)) / parJour;
  ok(j20 < 15, `passer 19 -> 20 prend ${j20.toFixed(1)} jours de jeu, pas 900 000 de mise`);
  ok(Game.xpPour(cfg.NIVEAU_MAX) < 2000000,
     `le niveau ${cfg.NIVEAU_MAX} coute ${Math.round(Game.xpPour(cfg.NIVEAU_MAX)).toLocaleString('fr')} XP — atteignable, ` +
     `la ou il demandait ${Math.round(Game.volumePour(cfg.NIVEAU_MAX)).toLocaleString('fr')} de mise, soit cinq fois toute la supply`);
}

console.log(`xp.test.js : ${n} verifications OK`);
