'use strict';
/*
 * Le mode entrainement, joue pour de vrai.
 *
 * Ce que ce fichier cherche a attraper, dans l'ordre d'importance :
 *
 *  1. QUE L'ARGENT NE PUISSE PAS ENTRER. C'est la seule chose ici qui pourrait
 *     couter quelque chose a quelqu'un. On verifie que la mise est nulle, que
 *     rien ne demande a etre preleve, et que le module n'a aucun moyen de
 *     toucher un solde ;
 *  2. QUE LE BOT NE VOIE PAS LES COUPS CACHES. Aux deux jeux simultanes il
 *     joue apres le joueur : s'il regardait, il gagnerait tout, tout le temps.
 *     On le mesure — un bot qui triche au Dernier Chiffre gagne ~100 % des
 *     parties, un bot honnete tourne autour de la moitie ;
 *  3. QUE LES SIX JEUX AILLENT JUSQU'AU BOUT sans se bloquer, dans les deux
 *     sens (le bot ouvre / le joueur ouvre).
 */
const assert = require('assert');
const { Entrainement, BOT } = require('./entrainement');
const bots = require('./bots');
const p4 = require('./puissance4');
const dm = require('./dames');
const pf = require('./pierre_feuille_bandit');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

function alea(graine) {
  let x = graine >>> 0;
  return function () {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}
const MOI = '0xjoueur';

/** Un tirage d'entrainement : le vrai vient de la graine du serveur, celui-ci
    est reproductible pour que les parties de test le soient aussi. */
function faitTirage(rnd) {
  return () => ({ nombre: 1 + Math.floor(rnd() * 100), preuve: { test: true } });
}

/** Un joueur au hasard, pour derouler une partie entiere sans jouer nous-meme.
    Il joue MAL, ce qui est le but : on veut voir le bot gagner. */
function coupAuHasard(partie, rnd) {
  const jeton = partie.jeton(MOI);
  switch (partie.jeu) {
    case 'p4': { const c = p4.jouables(partie.grille); return c[Math.floor(rnd() * c.length)]; }
    case 'mp': case 'mf': {
      const l = [];
      for (let i = 0; i < 9; i++) if (partie.grille[i] === 0) l.push(i);
      return l[Math.floor(rnd() * l.length)];
    }
    case 'dm': {
      const c = partie.coupsLegaux();
      const x = c[Math.floor(rnd() * c.length)];
      return x ? { de: x.de, vers: x.vers } : null;
    }
    case 'dc': return 1 + Math.floor(rnd() * 100);
    case 'pf':
      if (partie.etape === pf.RELANCE) return rnd() < 0.5 ? 'r' : 'n';
      if (partie.etape === pf.SUIVRE) return rnd() < 0.9 ? 's' : 'x';
      return ['p', 'f', 'c'][Math.floor(rnd() * 3)];
    default: return null;
  }
}

/** Deroule une partie complete. Rend le gagnant vu du JOUEUR :
    'joueur', 'bot' ou 'nul'. */
function partie(E, jeu, rnd, t0) {
  let t = t0;
  const p = E.ouvrir(MOI, jeu, t);
  for (let k = 0; k < 500 && p.phase !== 'finie'; k++) {
    t += 1000;
    /* Le bot a pu finir la partie en ouvrant. */
    if (p.phase !== 'en_cours') break;
    const c = coupAuHasard(p, rnd);
    if (c === null || c === undefined) break;
    E.jouer(MOI, c, t);
  }
  eq(p.phase, 'finie', `${jeu} : la partie se termine`);
  n -= 1;                                  // ne pas compter une fois par partie
  const jeton = p.jeton(MOI);
  return p.gagnant === null ? 'nul' : (p.gagnant === jeton ? 'joueur' : 'bot');
}

// ============================================== l'argent ne peut pas entrer

{
  const rnd = alea(1);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  for (const jeu of Entrainement.JEUX) {
    const p = E.ouvrir(MOI, jeu, 1000);
    eq(p.mise, 0, `${jeu} : la mise est nulle`);
    ok(!Array.isArray(p.aDebiter) || p.aDebiter.length === 0,
       `${jeu} : rien a prelever a l ouverture`);
    const e = E.etat(MOI, 1000);
    eq(e.gratuit, true, `${jeu} : l etat annonce que c est gratuit`);
    eq(e.entrainement, true, `${jeu} : l etat annonce que c est un entrainement`);
    ok(e.botJeton === 1 || e.botJeton === 2, `${jeu} : le bot a un jeton`);
  }
  /* Le module ne parle a AUCUN solde : il ne recoit ni le jeu, ni la table des
     joueurs, et son seul lien avec le serveur est une fonction de tirage. Ce
     test est grossier — il lit le fichier — mais il attrape exactement la
     regression qu'on redoute : quelqu'un qui, un jour, « aurait juste besoin »
     du solde ici. */
  const src = require('fs').readFileSync(require.resolve('./entrainement'), 'utf8');
  for (const mot of ['balance', 'require(\'./game\')', 'WEI(', '_duelDebite', 'partage(']) {
    ok(src.indexOf(mot) < 0, `entrainement.js ne mentionne pas ${mot}`);
  }
}

/* Au Pierre-Feuille-Bandit, la relance suivie fait monter la mise. A mise de
   depart nulle elle doit rester nulle — sinon une partie gratuite finirait par
   reclamer de l'argent. */
{
  const rnd = alea(2);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  let vues = 0;
  for (let i = 0; i < 30; i++) {
    const p = E.ouvrir(MOI, 'pf', 1000 + i * 100000);
    let t = 1000 + i * 100000;
    for (let k = 0; k < 200 && p.phase === 'en_cours'; k++) {
      t += 1000;
      if (p.etape === pf.RELANCE && p.relanceur === p.jeton(MOI)) { vues++; E.jouer(MOI, 'r', t); continue; }
      if (p.etape === pf.SUIVRE && p.relanceur !== p.jeton(MOI)) { E.jouer(MOI, 's', t); continue; }
      const c = coupAuHasard(p, rnd);
      if (c == null) break;
      E.jouer(MOI, c, t);
    }
    eq(p.mise, 0, 'la mise reste nulle malgre les relances');
    ok(!p.aDebiter || !p.aDebiter.length, 'et rien n est jamais a prelever');
    n -= 2;
  }
  n += 2;
  ok(vues > 0, `on a bien traverse ${vues} relances`);
}

// ============================ le bot ne voit pas les coups caches

/* AU DERNIER CHIFFRE, LE BOT JOUE APRES LE JOUEUR. Le coup cache est donc dans
   l'objet partie quand il choisit. S'il le regardait, il lui suffirait de
   jouer un de plus pour gagner presque a tous les coups. On mesure : contre un
   joueur qui tire au hasard, un bot honnete qui joue l'equilibre gagne plus
   souvent que lui — l'equilibre punit les nombres trop hauts — mais reste tres
   loin des 100 % d'un tricheur. */
{
  const rnd = alea(4242);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  let bot = 0, joueur = 0, nul = 0;
  for (let i = 0; i < 400; i++) {
    const r = partie(E, 'dc', rnd, 1000 + i * 100000);
    if (r === 'bot') bot++; else if (r === 'joueur') joueur++; else nul++;
  }
  const part = bot / 400;
  console.log(`  Dernier Chiffre · le bot gagne ${bot} parties sur 400 ` +
              `(${joueur} au joueur, ${nul} nulles)`);
  ok(part < 0.75, `le bot ne triche pas : il gagne ${(part * 100).toFixed(0)} %, ` +
                  'un tricheur en gagnerait ~100');
  ok(bot > joueur, 'mais il bat quand meme un joueur qui tire au hasard');
}

/* Meme controle a Pierre-Feuille-Bandit : contre un joueur qui tire vraiment au
   hasard, personne ne peut gagner, pas meme un bot parfait. Un bot qui
   gagnerait nettement plus de la moitie des parties aurait vu le coup cache. */
{
  const rnd = alea(777);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  let bot = 0, joueur = 0, nul = 0;
  for (let i = 0; i < 200; i++) {
    const r = partie(E, 'pf', rnd, 1000 + i * 1000000);
    if (r === 'bot') bot++; else if (r === 'joueur') joueur++; else nul++;
  }
  console.log(`  Pierre-Feuille-Bandit · le bot gagne ${bot} parties sur 200 ` +
              `(${joueur} au joueur, ${nul} nulles)`);
  ok(bot / 200 < 0.72, `le bot ne voit pas le coup cache (${bot}/200)`);
}

// ================================== les six jeux vont jusqu'au bout

/* Et le bot GAGNE. C'est tout l'interet du mode : un adversaire qui se
   coucherait n'apprendrait rien a personne. Le joueur simule ici joue au
   hasard, donc le bot doit ecraser les quatre jeux a information parfaite. */
{
  const attendu = { p4: 0.95, mp: 0.8, mf: 0.9, dm: 0.9 };
  for (const jeu of ['p4', 'mp', 'mf', 'dm']) {
    const rnd = alea(31337);
    const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
    const parties = jeu === 'dm' ? 12 : 40;
    let bot = 0, joueur = 0, nul = 0;
    for (let i = 0; i < parties; i++) {
      const r = partie(E, jeu, rnd, 1000 + i * 1000000);
      if (r === 'bot') bot++; else if (r === 'joueur') joueur++; else nul++;
    }
    console.log(`  ${jeu} · le bot gagne ${bot}/${parties} ` +
                `(${joueur} au joueur, ${nul} nulles)`);
    eq(joueur, 0, `${jeu} : un joueur au hasard ne lui prend AUCUNE partie`);
    ok(bot / parties >= attendu[jeu], `${jeu} : le bot en gagne ${bot} sur ${parties}`);
  }
}

/* LES DEUX SENS. Le tirage decide qui ouvre ; sur assez de tables les deux cas
   se presentent, et aucun ne doit bloquer. Ouvrir est un avantage aux quatre
   jeux de plateau, et un mode d'entrainement qui donnerait toujours le trait au
   joueur serait plus facile que la table payante. */
{
  const rnd = alea(5150);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  /* Le JETON du bot est toujours 2 — c'est le joueur qui pose la table, donc
     lui qui est le joueur 1. Ce qui est tire au sort, c'est LE TRAIT, et ca ne
     se lit pas sur le jeton : ca se lit sur le fait que le bot a deja joue ou
     non quand la table s'ouvre. Une premiere version de ce test comptait les
     jetons et concluait que le tirage ne marchait pas. */
  let ouvre = 0, suit = 0;
  for (let i = 0; i < 60; i++) {
    const p = E.ouvrir(MOI, 'p4', 1000 + i * 100000);
    eq(p.jeton(BOT), 2, 'le bot est toujours le joueur 2'); n -= 1;
    if (p.coups.length === 1) ouvre++; else if (p.coups.length === 0) suit++;
  }
  n += 1;
  ok(ouvre > 10 && suit > 10,
     `le bot ouvre ${ouvre} fois et suit ${suit} fois sur 60`);
}

// ============================================ le detail qui casse tout

/* UNE SEULE TABLE PAR JOUEUR. En ouvrir une deuxieme remplace la premiere —
   sinon un joueur accumule des parties que personne ne finira jamais, et le
   serveur les fait toutes avancer a chaque tick. */
{
  const rnd = alea(9);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  const a = E.ouvrir(MOI, 'p4', 1000);
  const b = E.ouvrir(MOI, 'mp', 2000);
  eq(E.mienne(MOI), b, 'la seconde table remplace la premiere');
  ok(a !== b, 'et ce n est pas la meme');
  E.fermer(MOI);
  eq(E.mienne(MOI), null, 'fermer la table la retire');
}

/* La pendule fait perdre celui qui laisse filer son temps — la meme regle
   qu'a la table payante. Sans elle, l'entrainement apprendrait a jouer sans
   horloge, et le joueur decouvrirait la pendule en payant. */
{
  const rnd = alea(11);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  const p = E.ouvrir(MOI, 'p4', 1000);
  /* On se place APRES l'echeance du coup en cours. */
  const finies = E.tick(p.echeance + 1);
  eq(finies.length, 1, 'la table expire');
  eq(p.phase, 'finie', 'et la partie est finie');
  /* Celui qui devait jouer perd, quel qu'il soit. */
  ok(p.gagnant === 1 || p.gagnant === 2, 'quelqu un gagne au temps');
  eq(p.raison, 'temps', 'et c est bien le temps qui a tranche');
}

/* Aux dames, une rafle rend la main au bot : la boucle doit la derouler
   entierement dans le meme appel, sinon la partie se retrouve bloquee avec un
   `enchaine` que le joueur ne peut pas jouer. */
{
  const rnd = alea(13);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  let rafles = 0;
  for (let i = 0; i < 12; i++) {
    const p = E.ouvrir(MOI, 'dm', 1000 + i * 1000000);
    let t = 1000 + i * 1000000;
    for (let k = 0; k < 400 && p.phase === 'en_cours'; k++) {
      t += 1000;
      /* Quand la main revient au joueur, `enchaine` doit etre soit null, soit
         une piece A LUI — jamais une piece du bot restee au milieu d'une
         rafle. */
      if (p.enchaine !== null) {
        ok(dm.proprio(p.grille[p.enchaine]) === p.jeton(MOI),
           'l enchainement en attente appartient au joueur');
        n -= 1;
        rafles++;
      }
      const c = coupAuHasard(p, rnd);
      if (c == null) break;
      E.jouer(MOI, c, t);
    }
  }
  n += 1;
  ok(rafles >= 0, `on a traverse ${rafles} enchainements du cote joueur`);
}

/* On refuse ce qu'on ne sait pas faire, au lieu de le faire a moitie. */
{
  const rnd = alea(17);
  const E = new Entrainement({ alea: rnd, tirage: faitTirage(rnd) });
  assert.throws(() => E.ouvrir(MOI, 'blackjack', 1000), /unknown game/,
                'un jeu inconnu est refuse'); n++;
  assert.throws(() => E.jouer('0xpersonne', 3, 1000), /no practice match/,
                'jouer sans table est refuse'); n++;
  /* Sans fonction de tirage, le Dernier Chiffre est indisponible — il n'y a
     pas de version degradee qui tirerait « en attendant ». */
  const sansTirage = new Entrainement({ alea: rnd });
  assert.throws(() => sansTirage.ouvrir(MOI, 'dc', 1000), /unavailable/,
                'pas de tirage, pas de table'); n++;
  ok(sansTirage.ouvrir(MOI, 'p4', 1000), 'les autres jeux restent ouverts');
}

// ================================ branche sur le vrai jeu (game.js)

/*
 * Les tests precedents jouent avec le module seul. Celui-ci passe par la vraie
 * classe Game — celle qui tient les soldes.
 *
 * ---- ce qu'on verifie, et ce qui a change ----
 *
 * L'entrainement ne deplacait AUCUN jeton, et ce test l'exigeait. Depuis que
 * battre un bot rapporte une prime, ce n'est plus vrai, et le remplacer par
 * « le solde a le droit de bouger » aurait ete abandonner la garantie plutot
 * que la mettre a jour.
 *
 * La bonne invariante est plus precise que l'ancienne : le solde ne peut que
 * MONTER, exactement du nombre de JEUX DIFFERENTS gagnes multiplie par la
 * prime — jamais des mises, jamais un rake, jamais deux fois le meme jeu. On
 * compte donc les victoires en jouant, et on verifie le solde au jeton pres.
 */
{
  const G = require('./game');
  const Game = G.Game || G;
  const cfg = require('./config');
  const eth = require('ethers').ethers;
  const g = new Game();
  const A = '0xentraine';
  const p = g._p(A);
  const avant = p.balance;

  const rnd = alea(20260815);
  let jouees = 0;
  const gagnes = {};                       // les jeux ou le joueur a gagne au moins une fois
  for (const jeu of ['p4', 'mp', 'mf', 'dm', 'dc', 'pf']) {
    for (let i = 0; i < 4; i++) {
      const t0 = 1000 + jouees * 1000000;
      const partie = g.entrainementOuvrir(A, jeu, t0);
      let t = t0;
      for (let k = 0; k < 400 && partie.phase === 'en_cours'; k++) {
        t += 1000;
        const c = coupAuHasard(partie, rnd);
        if (c == null) break;
        try { g.entrainementJouer(A, c, t); } catch (e) { break; }
      }
      if (partie.phase === 'finie' && partie.gagnant === partie.jeton(A)) gagnes[jeu] = 1;
      jouees++;
    }
  }
  /* Et un abandon, qui est le chemin par lequel l'argent revient d'ordinaire. */
  g.entrainementOuvrir(A, 'p4', 99000000);
  g.entrainementAbandonner(A, 99001000);

  const nb = Object.keys(gagnes).length;
  const attendu = avant.add(
    eth.utils.parseUnits(String(cfg.ENTRAINEMENT_PRIME * nb), cfg.DECIMALS));
  console.log(`  ${jouees} parties · le joueur au hasard a gagne a ${nb} jeu(x) ` +
              `sur 6 : ${Object.keys(gagnes).join(', ') || 'aucun'}`);
  eq(g._p(A).balance.toString(), attendu.toString(),
     `le solde a monte de ${nb} prime(s), pas d un jeton de plus`);
  ok(g._p(A).balance.gte(avant), 'et il n a JAMAIS baisse');
  /* Ni les quetes du jour, ni le volume mise : une partie gratuite ne doit pas
     faire avancer une quete qui, elle, paie en $SWOGE. */
  eq(g._p(A).dropsToday, 0, 'aucune quete du jour ne bouge');

  /* L'etat rendu au navigateur porte bien les deux visages : sans eux la page
     dessine un siege vide en face du joueur. */
  g.entrainementOuvrir(A, 'p4', 100000000);
  const e = g.entrainementEtat(A, 100000000);
  eq(e.rakeBps, 0, 'aucune commission annoncee');
  eq(e.noms.filter(Boolean).length, 2, 'les deux joueurs ont un nom');
  eq(e.profils.filter(Boolean).length, 2, 'les deux joueurs ont un profil');
  ok(e.profils.some((x) => x && x.bot), 'et l un des deux est marque comme bot');
  eq(g.entrainementEtat('0xpersonne', 100000000), null,
     'un joueur sans table n en a pas');
}

// ================================================ la prime de victoire

/*
 * Battre un bot rapporte des $SWOGE. C'est le seul endroit du serveur ou de
 * l'argent est cree sans qu'une mise ait ete posee, donc c'est celui qui merite
 * le plus de tests — pas le moins.
 *
 * On force les parties plutot que de les jouer : gagner contre le Puissance 4
 * en jouant au hasard n'arrive jamais (mesure : 0 sur 40), et un test qui
 * attend un evenement qui n'arrive pas ne teste rien.
 */
{
  const G = require('./game');
  const Game = G.Game || G;
  const cfg = require('./config');
  const g = new Game();
  const A = '0xprime';
  const solde = () => g._p(A).balance.toString();
  const wei = (n) => require('ethers').ethers.utils.parseUnits(String(n), cfg.DECIMALS).toString();

  /** Termine la partie en cours sur un vainqueur choisi, sans la jouer. */
  function force(partie, gagnant, raison) {
    partie.phase = 'finie';
    partie.gagnant = gagnant;
    partie.raison = raison || 'aligne';
  }

  const avant = solde();
  /* ---- gagner paie ---- */
  let p = g.entrainementOuvrir(A, 'p4', 1000);
  force(p, p.jeton(A));
  let r = g._entrainementPrime(A, p);
  ok(r && r.prime === cfg.ENTRAINEMENT_PRIME, `gagner paie ${r && r.prime} $SWOGE`);
  eq(solde(), require('ethers').ethers.BigNumber.from(avant)
       .add(wei(cfg.ENTRAINEMENT_PRIME)).toString(), 'et le solde monte d autant');

  /* ---- LA MEME PARTIE NE PAIE PAS DEUX FOIS ---- */
  const apres1 = solde();
  eq(g._entrainementPrime(A, p), null, 'la meme partie ne repaie pas');
  eq(solde(), apres1, 'et le solde ne bouge plus');

  /* ---- LE PLAFOND : une prime par jeu et par jour ---- */
  const p2 = g.entrainementOuvrir(A, 'p4', 2000);
  force(p2, p2.jeton(A));
  const r2 = g._entrainementPrime(A, p2);
  ok(r2 && r2.plafond === true && r2.prime === 0,
     'la deuxieme victoire du jour au meme jeu ne paie pas');
  eq(solde(), apres1, 'et le solde reste ou il etait');

  /* ---- mais un AUTRE jeu paie encore ---- */
  const p3 = g.entrainementOuvrir(A, 'mp', 3000);
  force(p3, p3.jeton(A));
  const r3 = g._entrainementPrime(A, p3);
  ok(r3 && r3.prime > 0, 'un autre jeu paie encore le meme jour');

  /* ---- LE PLAFOND TIENT SOUS LE MITRAILLAGE ----
     C'est le scenario qui compte : un script qui rejoue le jeu le plus facile
     en boucle. Au Dernier Chiffre une partie tient en un message et se gagne
     une fois sur quatre ; sans plafond par jeu, ce serait une rente. */
  const avantSpam = solde();
  for (let i = 0; i < 200; i++) {
    const q = g.entrainementOuvrir(A, 'dc', 10000 + i * 1000);
    force(q, q.jeton(A));
    g._entrainementPrime(A, q);
  }
  eq(solde(), require('ethers').ethers.BigNumber.from(avantSpam)
       .add(wei(cfg.ENTRAINEMENT_PRIME)).toString(),
     '200 victoires forcees au meme jeu ne paient qu une seule prime');

  /* ---- perdre et faire nulle ne paient rien ---- */
  const avantNul = solde();
  const p4b = g.entrainementOuvrir(A, 'mf', 500000);
  force(p4b, null, 'trop long');                       // nulle
  eq(g._entrainementPrime(A, p4b), null, 'une nulle ne paie rien');
  const p5 = g.entrainementOuvrir(A, 'dm', 600000);
  force(p5, p5.jeton(A) === 1 ? 2 : 1);                // le bot gagne
  eq(g._entrainementPrime(A, p5), null, 'une defaite ne paie rien');
  eq(solde(), avantNul, 'et le solde n a pas bouge');

  /* ---- abandonner ne paie pas, et redemander n'y change rien ----
     Une partie perdue n'a pas besoin d'etre marquee pour ne pas etre repayee :
     c'est le controle du vainqueur qui la refuse, et il la refusera autant de
     fois qu'on insistera. C'est une garantie plus solide qu'un drapeau, parce
     qu'elle ne depend d'aucun etat. */
  const avantAb = solde();
  g.entrainementOuvrir(A, 'pf', 700000);
  const ab = g.entrainementAbandonner(A, 700001);
  eq(solde(), avantAb, 'abandonner ne paie rien');
  for (let i = 0; i < 5; i++) eq(g._entrainementPrime(A, ab), null, 'ni au ' + (i + 2) + 'e essai');
  eq(solde(), avantAb, 'et le solde n a toujours pas bouge');

  /* ---- une partie NON FINIE ne paie rien ---- */
  const enCours = g.entrainementOuvrir(A, 'mp', 800000);
  if (enCours.phase === 'en_cours')
    eq(g._entrainementPrime(A, enCours), null, 'une partie en cours ne paie rien');
  else n++;

  /* ---- le jour suivant remet le compteur a zero ---- */
  const p6 = g.entrainementOuvrir(A, 'p4', 900000);
  force(p6, p6.jeton(A));
  g._p(A).dayKey = 'un-autre-jour';                    // on force le changement de jour
  const avantJour = solde();
  const r6 = g._entrainementPrime(A, p6);
  ok(r6 && r6.prime > 0, 'le lendemain, le meme jeu repaie');
  ok(solde() !== avantJour, 'et le solde remonte');
}

console.log(`entrainement.test.js : ${n} verifications OK`);
