'use strict';
/*
 * Les adversaires d'entrainement.
 *
 * ---- ce qu'on demande a un bot, et ce qu'on ne lui demande pas ----
 *
 * On lui demande d'etre DUR A BATTRE. Pas de « faire semblant de reflechir »,
 * pas de laisser gagner : un adversaire qui se couche n'apprend rien a
 * personne, et un joueur qui s'entraine contre lui arrive a la table payante
 * avec une confiance qu'il n'a pas gagnee — c'est le pire service qu'on puisse
 * lui rendre.
 *
 * On ne lui demande PAS de tricher : il voit exactement ce qu'un joueur assis
 * en face verrait, et rien de plus. Aux deux jeux a coups caches — le Dernier
 * Chiffre et Pierre-Feuille-Bandit — il ne regarde JAMAIS le coup que
 * l'adversaire vient de poser mais qui n'est pas encore revele. C'est la seule
 * chose qui rende l'entrainement honnete, et c'est aussi la plus facile a
 * casser par accident : les deux fonctions concernees ne recoivent donc que
 * l'historique des manches DEJA revelees, jamais la partie en cours.
 *
 * ---- trois familles de jeux, trois facons de jouer ----
 *
 * 1. INFORMATION PARFAITE, PETIT (morpion). Tout est sur la table et l'arbre
 *    entier tient en memoire : on ne cherche pas, on RESOUT. Le bot est
 *    parfait — il ne peut pas perdre, jamais.
 *
 * 2. INFORMATION PARFAITE, GRAND (Puissance 4, morpion fantome, dames). On
 *    cherche en profondeur limitee : negamax, elagage alpha-beta, table de
 *    transposition et approfondissement iteratif. Ce qui fait la force ici
 *    n'est pas la finesse de l'evaluation mais la PROFONDEUR atteinte, et la
 *    profondeur vient de l'ordre des coups — d'ou tout le soin mis a essayer
 *    les bons coups en premier.
 *
 * 3. COUPS SIMULTANES ET CACHES (Dernier Chiffre, Pierre-Feuille-Bandit). Ici
 *    chercher ne veut rien dire : il n'y a rien a calculer sur une position,
 *    seulement une decision a prendre sans savoir. Deux reponses, et elles
 *    sont opposees :
 *      • au Dernier Chiffre on joue l'EQUILIBRE — la strategie mixte que
 *        personne ne peut exploiter, calculee ici meme ;
 *      • a Pierre-Feuille-Bandit on EXPLOITE — parce qu'un humain ne tire pas
 *        au hasard, et que ses habitudes se lisent sur sept manches.
 *
 * ---- ce fichier ne connait ni les soldes ni les sockets ----
 *
 * Il recoit une position, il rend un coup. C'est tout. game.js decide quand
 * l'appeler, server.js diffuse le resultat.
 */

const p4 = require('./puissance4');
const mp = require('./morpion');
const mf = require('./morpion_fantome');
const dm = require('./dames');

// =========================================================== Puissance 4

/* L'ordre d'exploration par defaut. Le centre d'abord, et ce n'est pas
   cosmetique : une case du centre appartient a sept alignements possibles, une
   case du bord a trois. Chercher le centre en premier fait tomber les coupures
   alpha-beta beaucoup plus tot, et double la profondeur atteignable a temps
   egal. */
const P4_ORDRE = [3, 2, 4, 1, 5, 0, 6];

/* Ce que vaut une case selon le nombre d'alignements qui la traversent. La
   table est CALCULEE une fois plutot qu'ecrite a la main : une table recopiee
   d'ailleurs serait juste par hasard, et fausse le jour ou la grille change de
   taille. */
const P4_POIDS = (function () {
  const t = new Array(p4.CASES).fill(0);
  const PAS = [1, p4.COLONNES, p4.COLONNES + 1, p4.COLONNES - 1];
  for (let c = 0; c < p4.COLONNES; c++) {
    for (let r = 0; r < p4.RANGEES; r++) {
      let n = 0;
      for (const pas of PAS) {
        for (let d = -3; d <= 0; d++) {
          /* Une fenetre de quatre cases consecutives qui contient celle-ci et
             tient entierement dans la grille. */
          let ok = true;
          for (let k = 0; k < 4; k++) {
            const cc = c + (pas === 1 ? d + k : pas === p4.COLONNES ? 0
                          : pas === p4.COLONNES + 1 ? d + k : -(d + k));
            const rr = r + (pas === 1 ? 0 : d + k);
            if (cc < 0 || cc >= p4.COLONNES || rr < 0 || rr >= p4.RANGEES) { ok = false; break; }
          }
          if (ok) n++;
        }
      }
      t[p4.idx(c, r)] = n;
    }
  }
  return t;
})();

/* Les fenetres de quatre cases : toutes les facons de gagner. On les calcule
   une fois, et l'evaluation ne fait plus que les parcourir. */
const P4_FENETRES = (function () {
  const out = [];
  for (let c = 0; c < p4.COLONNES; c++) {
    for (let r = 0; r < p4.RANGEES; r++) {
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (const [dc, dr] of dirs) {
        const f = [];
        for (let k = 0; k < 4; k++) {
          const cc = c + dc * k, rr = r + dr * k;
          if (cc < 0 || cc >= p4.COLONNES || rr < 0 || rr >= p4.RANGEES) { f.length = 0; break; }
          f.push(p4.idx(cc, rr));
        }
        if (f.length === 4) out.push(f);
      }
    }
  }
  return out;
})();

/**
 * Ce que vaut une position pour `moi`, quand personne n'a encore gagne.
 *
 * Une fenetre ou les deux joueurs sont presents ne vaut rien : plus personne
 * ne peut y aligner quatre. Seules comptent les fenetres OUVERTES, et une
 * fenetre a trois jetons vaut bien plus que trois fenetres a un.
 *
 * On a essaye plus savant — ponderer une menace par le nombre de coups qui la
 * separent d'etre jouable, et par la parite de sa rangee, qui est la theorie
 * connue du Puissance 4. Mesure en duel appariee a profondeur egale, ce
 * raffinement PERD (9 gagnees, 19 nulles, 12 perdues). On l'a donc jete : ce
 * qui fait la force ici, c'est la profondeur, pas la finesse de la note.
 */
function p4Evalue(g, moi) {
  const lui = moi === 1 ? 2 : 1;
  let s = 0;
  for (let i = 0; i < P4_FENETRES.length; i++) {
    const f = P4_FENETRES[i];
    let a = 0, b = 0;
    for (let k = 0; k < 4; k++) {
      const v = g[f[k]];
      if (v === moi) a++; else if (v === lui) b++;
    }
    if (a && b) continue;                    // fenetre morte
    if (a === 3) s += 60; else if (a === 2) s += 8; else if (a === 1) s += 1;
    if (b === 3) s -= 70; else if (b === 2) s -= 10; else if (b === 1) s -= 1;
  }
  /* Le centre, encore : a materiel egal, la position centrale gagne la fin de
     partie parce qu'elle laisse plus de menaces possibles. */
  for (let i = 0; i < g.length; i++) {
    if (g[i] === moi) s += P4_POIDS[i];
    else if (g[i] === lui) s -= P4_POIDS[i];
  }
  return s;
}

const P4_GAGNE = 1000000;

/** La cle d'une position pour la table de transposition. */
function p4Cle(g, j) {
  let s = '';
  for (let i = 0; i < g.length; i++) s += g[i];
  return s + j;
}

/**
 * Negamax avec elagage alpha-beta, table de transposition et coups tueurs.
 *
 * `profondeur` compte les demi-coups restants. Le score est TOUJOURS du point
 * de vue du joueur au trait, d'ou le signe qui s'inverse a chaque niveau —
 * c'est ce qui evite d'ecrire deux fois la meme fonction, une pour chaque
 * camp, et de se tromper dans l'une des deux.
 *
 * Une victoire est d'autant meilleure qu'elle arrive TOT : on ajoute la
 * profondeur restante, sinon le bot voit un gain en un coup et un gain en cinq
 * comme equivalents, et fait durer les parties qu'il a deja gagnees.
 *
 * LA TABLE STOCKE UNE BORNE, PAS TOUJOURS UNE VALEUR. Un noeud coupe par
 * alpha-beta n'a pas ete explore en entier : sa valeur est seulement un
 * minorant (ou un majorant). Ranger cette valeur comme exacte et la relire
 * telle quelle est L'erreur classique de la table de transposition — elle rend
 * la recherche plus rapide et FAUSSE, ce qui ne se voit pas en test unitaire
 * mais se voit sur le resultat des parties. D'ou le champ `type`.
 */
function p4Negamax(g, joueur, profondeur, alpha, beta, tt, tueurs, ply) {
  const cols = p4.jouables(g);
  if (!cols.length) return 0;                          // grille pleine : nulle

  /* Un coup gagnant se prend tout de suite, sans descendre : c'est la coupure
     la moins chere de tout l'arbre, et elle arrive tres souvent. */
  for (const c of cols) {
    const i = p4.poser(g, c, joueur);
    const w = p4.gagne(g, i);
    g[i] = 0;
    if (w) return P4_GAGNE + profondeur;
  }
  if (profondeur <= 0) return p4Evalue(g, joueur);

  const alphaEntree = alpha;
  let cle = null, vu = null;
  if (tt) {
    cle = p4Cle(g, joueur);
    vu = tt.get(cle);
    if (vu && vu.prof >= profondeur) {
      if (vu.type === 0) return vu.v;                  // exacte
      if (vu.type === 1) { if (vu.v > alpha) alpha = vu.v; }   // minorant
      else if (vu.v < beta) beta = vu.v;                       // majorant
      if (alpha >= beta) return vu.v;
    }
  }

  /* L'ordre des coups. Le coup qui a coupe la derniere fois d'abord, puis les
     deux « tueurs » de ce niveau, puis le centre. C'est ce qui fait toute la
     difference : le meme arbre, explore dans le desordre, coute dix fois plus
     cher pour le meme resultat. */
  const essai = [];
  const pousse = (c) => {
    if (c != null && cols.indexOf(c) >= 0 && essai.indexOf(c) < 0) essai.push(c);
  };
  if (vu) pousse(vu.coup);
  const t = tueurs && tueurs[ply];
  if (t) { pousse(t[0]); pousse(t[1]); }
  for (const c of P4_ORDRE) pousse(c);

  let meilleur = -Infinity, meilleurCoup = essai[0];
  for (const c of essai) {
    const i = p4.poser(g, c, joueur);
    const v = -p4Negamax(g, joueur === 1 ? 2 : 1, profondeur - 1, -beta, -alpha,
                         tt, tueurs, ply + 1);
    g[i] = 0;
    if (v > meilleur) { meilleur = v; meilleurCoup = c; }
    if (meilleur > alpha) alpha = meilleur;
    if (alpha >= beta) {                               // l'adversaire evitera
      /* Un coup qui coupe a ce niveau coupera souvent au meme niveau d'une
         autre branche : on le garde sous la main. Il ne coute rien a essayer
         en premier et il fait tomber des sous-arbres entiers. */
      if (tueurs) {
        if (!tueurs[ply]) tueurs[ply] = [null, null];
        if (tueurs[ply][0] !== c) { tueurs[ply][1] = tueurs[ply][0]; tueurs[ply][0] = c; }
      }
      break;
    }
  }
  if (tt) {
    tt.set(cle, {
      prof: profondeur, v: meilleur, coup: meilleurCoup,
      type: meilleur <= alphaEntree ? 2 : (meilleur >= beta ? 1 : 0),
    });
  }
  return meilleur;
}

/** La force par defaut du Puissance 4. Mesuree, pas choisie au hasard. */
const P4_FORCE = 10;

/**
 * Le coup du bot au Puissance 4.
 *
 * APPROFONDISSEMENT ITERATIF : on cherche a 2, puis 4, puis 6… jusqu'a
 * `force`. Cela parait du gaspillage — on refait chaque fois le travail de la
 * fois d'avant — et c'est le contraire : le meilleur coup trouve a la
 * profondeur precedente passe en tete a la suivante, les coupures tombent tout
 * de suite, et la recherche complete coute MOINS cher que la seule derniere
 * passe lancee a froid.
 *
 * @param grille  la grille du moteur, telle quelle (on la remet en etat)
 * @param joueur  1 ou 2 — le jeton du bot
 * @param force   profondeur maximale. 10 tient en ~300 ms sur une grille vide,
 *                le pire cas, et bat la profondeur 8 de la version sans table.
 */
function p4Coup(grille, joueur, force) {
  const g = grille.slice();
  const cols = p4.jouables(g);
  if (!cols.length) return null;
  const max = Math.max(1, force || P4_FORCE);
  const tt = new Map(), tueurs = [];

  let meilleur = cols[0];
  let ordre = P4_ORDRE.filter((c) => cols.indexOf(c) >= 0);
  for (let prof = 2; prof <= max; prof++) {
    let meilleurScore = -Infinity, alpha = -Infinity;
    const notes = [];
    for (const c of ordre) {
      const i = p4.poser(g, c, joueur);
      const w = p4.gagne(g, i);
      const v = w ? P4_GAGNE + prof
                  : -p4Negamax(g, joueur === 1 ? 2 : 1, prof - 1, -Infinity, -alpha,
                               tt, tueurs, 1);
      g[i] = 0;
      notes.push([c, v]);
      if (v > meilleurScore) { meilleurScore = v; meilleur = c; }
      if (v > alpha) alpha = v;
    }
    notes.sort((a, b) => b[1] - a[1]);
    ordre = notes.map((x) => x[0]);
    if (meilleurScore >= P4_GAGNE) break;      // gain force : creuser n'apprend rien
  }
  return meilleur;
}

// ============================================================== morpion
/*
 * Ici on ne cherche pas : on RESOUT. L'arbre entier du morpion tient dans
 * quelques centaines de milliers de positions, et une table de transposition
 * le ramene a quelques milliers. Le bot joue donc parfaitement — il ne peut
 * pas perdre, jamais, et il gagne des que l'autre s'ecarte du chemin juste.
 */
const MP_MEMO = new Map();

function mpCle(g, joueur) { return g.join('') + joueur; }

function mpResout(g, joueur, prof) {
  const cle = mpCle(g, joueur);
  const vu = MP_MEMO.get(cle);
  if (vu !== undefined) return vu;

  const libres = mp.jouables(g);
  let r;
  if (!libres.length) r = 0;
  else {
    let meilleur = -Infinity;
    for (const c of libres) {
      g[c] = joueur;
      let v;
      /* `gagne` prend LE DERNIER COUP, pas la grille seule : c'est la seule
         case qui peut avoir cree un alignement, et la fonction ne verifie que
         les trois lignes qui la traversent. */
      const w = mp.gagne(g, c);
      /* Gagner tot vaut mieux que gagner tard : sans ce terme, le bot voit
         toutes ses victoires comme equivalentes et prend la plus lointaine,
         ce qui donne l'occasion de se rattraper. */
      if (w) v = 10 - prof;
      else v = -mpResout(g, joueur === 1 ? 2 : 1, prof + 1);
      g[c] = 0;
      if (v > meilleur) meilleur = v;
    }
    r = meilleur;
  }
  MP_MEMO.set(cle, r);
  return r;
}

/** Le coup du bot au morpion. Parfait, sans reglage de force possible. */
function mpCoup(grille, joueur) {
  const g = grille.slice();
  const libres = mp.jouables(g);
  if (!libres.length) return null;
  let meilleur = null, meilleurScore = -Infinity;
  for (const c of libres) {
    g[c] = joueur;
    const w = mp.gagne(g, c);
    const v = w ? 10 : -mpResout(g, joueur === 1 ? 2 : 1, 1);
    g[c] = 0;
    if (v > meilleurScore) { meilleurScore = v; meilleur = c; }
  }
  return meilleur;
}

// ======================================================= morpion fantome
/*
 * Trois pions chacun ; poser le quatrieme efface le plus ancien des siens.
 *
 * L'information est parfaite — tout est visible, y compris le pion qui va
 * partir — mais l'arbre est INFINI : la grille ne se remplit jamais, donc rien
 * n'arrete la descente. On cherche donc en profondeur limitee, et l'etat a
 * suivre n'est pas seulement la grille : c'est la grille PLUS l'ordre dans
 * lequel chacun a pose ses pions, puisque c'est lui qui decide du prochain
 * efface. Oublier les files, c'est chercher dans un jeu qui n'est pas celui
 * qu'on joue.
 */
const MF_GAGNE = 100000;

/** Les trois cases qui vont s'effacer : celles en tete de chaque file. */
function mfFantome(files, joueur) {
  const f = files[joueur];
  return f.length >= mf.PIONS_MAX ? f[0] : null;
}

/**
 * La note d'une position pour `moi`. Deux idees, et pas une de plus :
 *
 *  • une ligne ou je suis seul vaut d'autant plus que j'y ai de pions ;
 *  • MAIS un alignement bati sur un pion qui part au prochain coup ne vaut
 *    rien. C'est LA particularite du jeu, et une evaluation qui l'ignore
 *    pousse le bot a monter des menaces qu'il detruit lui-meme.
 */
function mfEvalue(grille, files, moi) {
  const lui = moi === 1 ? 2 : 1;
  const partMoi = mfFantome(files, moi), partLui = mfFantome(files, lui);
  let s = 0;
  for (const L of mf.LIGNES) {
    let a = 0, b = 0, aSolide = 0, bSolide = 0;
    for (const c of L) {
      const v = grille[c];
      if (v === moi) { a++; if (c !== partMoi) aSolide++; }
      else if (v === lui) { b++; if (c !== partLui) bSolide++; }
    }
    if (a && b) continue;                     // ligne morte pour les deux
    if (a === 2) s += aSolide === 2 ? 22 : 6;
    else if (a === 1) s += 2;
    if (b === 2) s -= bSolide === 2 ? 26 : 7;
    else if (b === 1) s -= 2;
  }
  /* Le centre est sur quatre lignes, un coin sur trois, un bord sur deux. */
  const VAL = [3, 2, 3, 2, 4, 2, 3, 2, 3];
  for (let i = 0; i < 9; i++) {
    if (grille[i] === moi) s += VAL[i];
    else if (grille[i] === lui) s -= VAL[i];
  }
  return s;
}

/** Joue un coup sur une copie de travail. Rend de quoi le defaire. */
function mfJoue(grille, files, joueur, c) {
  let parti = null;
  const f = files[joueur];
  if (f.length >= mf.PIONS_MAX) { parti = f.shift(); grille[parti] = 0; }
  grille[c] = joueur;
  f.push(c);
  return parti;
}

function mfDefait(grille, files, joueur, c, parti) {
  const f = files[joueur];
  f.pop();
  grille[c] = 0;
  if (parti !== null) { f.unshift(parti); grille[parti] = joueur; }
}

function mfNegamax(grille, files, joueur, prof, alpha, beta) {
  const libres = mf.jouables(grille);
  if (!libres.length) return 0;               // ne peut pas arriver, mais bon

  /* Le coup gagnant d'abord : il coupe l'arbre pour rien du tout. */
  for (const c of libres) {
    const parti = mfJoue(grille, files, joueur, c);
    const w = mf.gagne(grille, c);
    mfDefait(grille, files, joueur, c, parti);
    if (w) return MF_GAGNE + prof;
  }
  if (prof <= 0) return mfEvalue(grille, files, joueur);

  let meilleur = -Infinity;
  for (const c of libres) {
    const parti = mfJoue(grille, files, joueur, c);
    const v = -mfNegamax(grille, files, joueur === 1 ? 2 : 1, prof - 1, -beta, -alpha);
    mfDefait(grille, files, joueur, c, parti);
    if (v > meilleur) meilleur = v;
    if (meilleur > alpha) alpha = meilleur;
    if (alpha >= beta) break;
  }
  return meilleur;
}

/**
 * Le coup du bot au morpion fantome.
 *
 * @param grille  la grille du moteur
 * @param pions   {1:[…], 2:[…]} — les files du moteur, du plus ancien au plus
 *                recent. On travaille sur des COPIES : le moteur garde les
 *                siennes intactes.
 * @param joueur  1 ou 2
 * @param force   profondeur. 8 suffit largement sur neuf cases.
 */
function mfCoup(grille, pions, joueur, force) {
  const g = grille.slice();
  const files = { 1: (pions[1] || []).slice(), 2: (pions[2] || []).slice() };
  const libres = mf.jouables(g);
  if (!libres.length) return null;
  const prof = Math.max(1, force || 8);

  let meilleur = null, meilleurScore = -Infinity, alpha = -Infinity;
  for (const c of libres) {
    const parti = mfJoue(g, files, joueur, c);
    const w = mf.gagne(g, c);
    const v = w ? MF_GAGNE + prof
                : -mfNegamax(g, files, joueur === 1 ? 2 : 1, prof - 1, -Infinity, -alpha);
    mfDefait(g, files, joueur, c, parti);
    if (v > meilleurScore) { meilleurScore = v; meilleur = c; }
    if (v > alpha) alpha = v;
  }
  return meilleur;
}

// ================================================================== dames
/*
 * LE TOUR N'EST PAS LE COUP. Une prise qui peut s'enchainer rend la main au
 * MEME joueur : le moteur le dit avec `encore`. La recherche doit faire
 * pareil, sinon elle compte une rafle de trois pieces comme trois coups
 * adverses et evalue une position qui n'existe pas. On ne change donc de camp
 * — et de signe — que quand le tour passe vraiment.
 */
const DM_GAGNE = 1000000;

/** Ce que vaut le materiel. Une dame vaut plus de trois pions : elle va dans
    les deux sens, et sur un damier vide elle finit la partie toute seule. */
const DM_PION = 100, DM_DAME = 340;

/**
 * La note d'une position pour `moi`.
 *
 * Le materiel decide de presque tout aux dames ; le reste sert a departager
 * deux positions de meme materiel :
 *  • AVANCER ses pions, parce qu'un pion qui approche de la rangee de
 *    promotion vaut de plus en plus cher ;
 *  • TENIR LE CENTRE, parce qu'une piece au bord n'a que deux diagonales ;
 *  • GARDER SA DERNIERE RANGEE, parce qu'un trou dedans laisse entrer une
 *    dame adverse.
 */
function dmEvalue(grille, moi) {
  const lui = moi === 1 ? 2 : 1;
  let s = 0;
  for (let i = 0; i < dm.CASES; i++) {
    const v = grille[i];
    if (!v) continue;
    const qui = dm.proprio(v);
    const r = dm.ligne(i), c = dm.colonne(i);
    let n = dm.estDame(v) ? DM_DAME : DM_PION;
    if (!dm.estDame(v)) {
      /* La distance parcourue vers la promotion. Le joueur 1 part du bas. */
      const avance = qui === 1 ? (7 - r) : r;
      n += avance * 9;
    }
    n += (c === 0 || c === 7) ? -8 : 4;       // le bord ne prend jamais
    /* La derniere rangee gardee : deux pions qui n'ont pas bouge de chez eux
       valent mieux qu'une avance de plus. */
    if (!dm.estDame(v) && r === dm.rangeeDame(qui === 1 ? 2 : 1)) n += 12;
    s += (qui === moi) ? n : -n;
  }
  return s;
}

/** Applique un coup sur une copie. Rend de quoi le defaire ET si le tour
    continue — la regle d'enchainement du moteur, copiee ici a l'identique. */
function dmJoue(g, c, joueur) {
  const piece = g[c.de];
  const pris = c.prise !== null ? g[c.prise] : 0;
  g[c.de] = dm.VIDE;
  g[c.vers] = piece;
  if (c.prise !== null) g[c.prise] = dm.VIDE;
  let promu = false;
  if (!dm.estDame(piece) && dm.ligne(c.vers) === dm.rangeeDame(joueur)) {
    g[c.vers] = joueur === 1 ? dm.DAME1 : dm.DAME2;
    promu = true;
  }
  /* Une piece promue s'arrete la : c'est la regle du damier a 64 cases, et
     l'oublier ferait chercher des rafles que le moteur refusera. */
  const encore = c.prise !== null && !promu && dm.prisesDe(g, c.vers).length > 0;
  return { piece, pris, promu, encore };
}

function dmDefait(g, c, u) {
  g[c.de] = u.piece;
  g[c.vers] = dm.VIDE;
  if (c.prise !== null) g[c.prise] = u.pris;
}

/** Les coups legaux, avec la prise obligatoire et l'enchainement en cours. */
function dmLegaux(g, joueur, enchaine) {
  if (enchaine !== null && enchaine !== undefined) return dm.prisesDe(g, enchaine);
  return dm.tousCoups(g, joueur);
}

function dmNegamax(g, joueur, enchaine, prof, alpha, beta) {
  const coups = dmLegaux(g, joueur, enchaine);
  /* Plus de coup : on est bloque, donc on a PERDU. Le signe compte — rendre 0
     ferait croire au bot qu'etre etouffe vaut une partie nulle, et il s'y
     jetterait pour sauver du materiel. */
  if (!coups.length) return -(DM_GAGNE + prof);
  if (prof <= 0 && (enchaine === null || enchaine === undefined)) {
    /* On ne s'arrete JAMAIS au milieu d'une rafle : la position y est fausse,
       une piece est prise et la riposte n'a pas eu lieu. C'est l'« effet
       d'horizon », et aux dames il coute des parties entieres. */
    return dmEvalue(g, joueur);
  }

  let meilleur = -Infinity;
  for (const c of coups) {
    const u = dmJoue(g, c, joueur);
    let v;
    if (u.encore) {
      /* Le tour continue : meme joueur, meme signe, et la profondeur ne baisse
         pas — une rafle est UN tour, pas trois. */
      v = dmNegamax(g, joueur, c.vers, prof, alpha, beta);
    } else {
      v = -dmNegamax(g, joueur === 1 ? 2 : 1, null, prof - 1, -beta, -alpha);
    }
    dmDefait(g, c, u);
    if (v > meilleur) meilleur = v;
    if (meilleur > alpha) alpha = meilleur;
    if (alpha >= beta) break;
  }
  return meilleur;
}

/**
 * Le coup du bot aux dames — UN coup, pas un tour. S'il enchaine, le serveur
 * le rappellera avec `enchaine` renseigne, exactement comme il le ferait pour
 * un humain.
 *
 * @param grille    le damier du moteur
 * @param joueur    1 ou 2
 * @param enchaine  la case de la piece qui doit continuer sa prise, ou null
 * @param force     profondeur en TOURS. 6 tient largement sous la seconde.
 */
function dmCoup(grille, joueur, enchaine, force) {
  const g = grille.slice();
  const coups = dmLegaux(g, joueur, enchaine == null ? null : enchaine);
  if (!coups.length) return null;
  if (coups.length === 1) return coups[0];    // rien a chercher
  const prof = Math.max(1, force || 6);

  let meilleur = null, meilleurScore = -Infinity, alpha = -Infinity;
  for (const c of coups) {
    const u = dmJoue(g, c, joueur);
    const v = u.encore
      ? dmNegamax(g, joueur, c.vers, prof, alpha, Infinity)
      : -dmNegamax(g, joueur === 1 ? 2 : 1, null, prof - 1, -Infinity, -alpha);
    dmDefait(g, c, u);
    if (v > meilleurScore) { meilleurScore = v; meilleur = c; }
    if (v > alpha) alpha = v;
  }
  return meilleur;
}

// ======================================================== dernier chiffre
/*
 * Chacun cache un nombre de 1 a 100, une cible uniforme est tiree, et le plus
 * proche SANS DEPASSER gagne.
 *
 * ---- pourquoi on ne « cherche » pas ici ----
 *
 * Il n'y a pas de position a explorer : un seul coup, cache, contre un
 * adversaire qui joue en meme temps. La seule question est QUELLE LOI DE
 * TIRAGE adopter — et elle a une reponse exacte.
 *
 * ---- le gain, calcule et pas devine ----
 *
 * Pour a > b, en sommant sur les cent cibles possibles :
 *   • cible >= a   : les deux passent, a est plus haut, a gagne   (101-a cas)
 *   • b <= cible < a : a depasse, b passe, b gagne                  (a-b cas)
 *   • cible < b    : les deux depassent, personne ne gagne          (b-1 cas)
 * d'ou un gain espere de (101 - 2a + b)/100 pour celui qui joue a. Le jeu est
 * a somme nulle et symetrique, donc antisymetrique en (a,b), et sa valeur est
 * nulle : personne n'a d'avantage a la place de l'autre.
 *
 * ---- l'equilibre, et pourquoi c'est LUI qu'on joue ----
 *
 * Il n'existe aucun nombre qui batte tous les autres : monter juste au-dessus
 * de l'adversaire bat les petits, jouer tres bas bat les gros. L'equilibre est
 * donc MIXTE — une loi de tirage, pas un nombre.
 *
 * Un bot qui joue l'equilibre n'est pas « imbattable » : personne ne l'est a un
 * jeu de hasard cache. Il est INEXPLOITABLE, ce qui est la seule forme de force
 * qui existe ici — quoi que fasse le joueur en face, il ne peut pas gagner sur
 * la duree. Chercher a l'exploiter serait pire : ca supposerait de deviner ses
 * habitudes, et ca ouvrirait la porte a l'inverse.
 *
 * ---- et on le CALCULE, au lieu de l'approcher ----
 *
 * On a d'abord approche cet equilibre par jeu fictif, puis par regret matching.
 * Les deux marchent et les deux convergent lentement : 20 000 tours laissent
 * une faille de 0,0133 mise par partie, et 400 000 tours (cinq secondes et
 * demie au demarrage) la ramenent seulement a 0,0005. « Presque inexploitable »
 * apres cinq secondes de calcul a chaque redemarrage du serveur, c'est le pire
 * des deux mondes.
 *
 * Alors on l'a resolu. A l'equilibre, tous les nombres joues rapportent la
 * meme chose, et le jeu etant symetrique cette valeur commune est zero. En
 * ecrivant E(a) = 0 pour deux nombres consecutifs et en soustrayant, tout se
 * simplifie et il reste :
 *
 *     E(a+1) - E(a) = (100 - a)(x_a + x_{a+1}) - F(a) - 1
 *
 * ou F(a) est la masse deja placee STRICTEMENT en dessous de a. Poser cette
 * difference a zero donne une recurrence sur les seules masses cumulees :
 *
 *     F(a+2) = F(a) + (1 + F(a)) / (100 - a)
 *
 * Elle avance de deux en deux, donc en deux chaines entrelacees — l'une part de
 * F(1) = 0, l'autre de F(2) = x_1. Et x_1 n'est pas libre : la recurrence prise
 * en a = 1 dit 99 (x_1 + x_2) = 1, et la chaine impaire impose x_2 = 0. Donc
 *
 *     x_1 = 1/99, exactement.
 *
 * Il ne reste aucun parametre a regler. Cent divisions au chargement, et une
 * faille residuelle de 0,00003 mise par partie — trois millioniemes, qui ne
 * viennent que de l'arrondi du dernier nombre du support. La loi s'arrete
 * d'elle-meme a 76 : au-dela, le nombre est si haut qu'il depasse la cible trop
 * souvent pour valoir la peine d'etre joue, et l'equilibre ne lui donne rien.
 *
 * Le test, lui, ne fait aucune confiance a ce raisonnement : il essaie les cent
 * reponses possibles et verifie qu'AUCUNE ne rapporte.
 */
const DC_MIN = 1, DC_MAX = 100;

/** Le gain espere de `a` contre `b`, en centiemes. Entier, donc exact. */
function dcGain(a, b) {
  if (a === b) return 0;
  if (a > b) return 101 - 2 * a + b;
  return -(101 - 2 * b + a);
}

/**
 * La loi d'equilibre, calculee par la recurrence ci-dessus.
 *
 * `cum[a]` est la masse strictement en dessous de a ; la probabilite de a est
 * ce qui separe cum[a] de cum[a+1]. On borne a 1 : la derniere marche est
 * coupee net par le total, et c'est elle qui donne au support sa fin nette.
 */
const DC_LOI = (function () {
  const cum = new Array(DC_MAX + 3).fill(1);
  cum[1] = 0;
  cum[2] = 1 / 99;                            // = x_1, impose par la recurrence
  for (let a = 1; a <= DC_MAX; a++) {
    const v = cum[a] + (1 + cum[a]) / (100 - a);
    cum[a + 2] = v < 1 ? v : 1;
  }
  const x = new Array(DC_MAX).fill(0);
  for (let a = DC_MIN; a <= DC_MAX; a++) {
    const bas = Math.min(1, Math.max(0, cum[a]));
    const haut = Math.min(1, Math.max(0, cum[a + 1]));
    x[a - 1] = Math.max(0, haut - bas);
  }
  /* On renormalise : les cent divisions laissent une poussiere, et une loi qui
     ne somme pas a un ferait tirer le dernier nombre un peu trop souvent. */
  const total = x.reduce((p, q) => p + q, 0);
  return x.map((v) => v / total);
})();

/**
 * Le nombre du bot au Dernier Chiffre.
 *
 * @param rnd  une source d'alea — le serveur passe la sienne, les tests en
 *             passent une reproductible. Sans elle le bot serait previsible,
 *             et un bot previsible a ce jeu se bat en un coup : il suffit de
 *             jouer un de plus que lui.
 */
function dcCoup(rnd) {
  const r = (typeof rnd === 'function' ? rnd() : Math.random());
  let s = 0;
  for (let i = 0; i < DC_LOI.length; i++) {
    s += DC_LOI[i];
    if (r < s) return DC_MIN + i;
  }
  return DC_MAX;
}

// ================================================== pierre-feuille-bandit
/*
 * Sept manches, et une relance de mise entre chacune.
 *
 * ---- ici, et ici SEULEMENT, on exploite ----
 *
 * Pierre-feuille-ciseaux a un equilibre connu : un tiers chacun, au hasard. Un
 * bot qui le joue ne perd jamais sur la duree — et ne gagne jamais non plus.
 * Il ferait un adversaire d'entrainement inutile : le joueur apprendrait que
 * le jeu est un tirage au sort, ce qui est faux face a un humain.
 *
 * Car un humain ne tire pas au hasard. Il repete son coup gagnant, il change
 * apres avoir perdu, il evite de jouer trois fois la meme chose. Ces habitudes
 * sont mesurables sur sept manches, et c'est LA le jeu : le bot les lit, et le
 * joueur qui veut le battre doit apprendre a ne pas en avoir.
 *
 * ---- le garde-fou ----
 *
 * Exploiter, c'est s'exposer : un adversaire qui comprend le modele peut le
 * retourner en lui donnant a manger un faux motif. On melange donc toujours
 * une part de vrai hasard (`PF_BRUIT`) — assez pour que le retournement ne
 * paie pas, assez peu pour que la lecture serve encore. Et tant qu'on n'a rien
 * vu, on joue au hasard : inventer un motif sur deux manches, c'est se donner
 * une raison de perdre.
 */
const PF_COUPS = ['p', 'f', 'c'];
/** Ce qui bat quoi : BAT[x] est le coup que x bat. Pour battre `x`, il faut
    donc jouer celui dont BAT vaut `x`. */
const PF_BAT = { p: 'c', f: 'p', c: 'f' };
const PF_CONTRE = { p: 'f', f: 'c', c: 'p' };   // ce qui bat x

/** La part de hasard pur. Un tiers : au-dessous, un joueur qui a compris le
    modele le retourne ; au-dessus, le bot ne lit plus rien. */
const PF_BRUIT = 0.3;

/*
 * ---- comment on lit l'adversaire, et pourquoi on ne PARIE pas sur une regle ----
 *
 * La premiere version de ce predicteur codait en dur les habitudes attendues :
 * « s'il vient de gagner il repete, s'il vient de perdre il joue ce qui vient
 * de le battre ». La deuxieme habitude etait FAUSSE — apres une defaite, le
 * joueur type ne joue pas ce qui bat son propre coup, il joue ce qui bat le
 * coup du BOT, ce qui n'est pas la meme chose. Resultat mesure contre un
 * adversaire pourtant parfaitement previsible : 70 manches gagnees contre 43,
 * la ou on en attendait 160 contre 20.
 *
 * On ne remplace pas une devinette par une autre. On donne au bot PLUSIEURS
 * lectures — chacune predit le prochain coup a partir d'un contexte different —
 * et il garde celle qui a eu raison le plus souvent depuis le debut de la
 * partie. Si l'adversaire repete, la lecture « frequence brute » gagne ; s'il
 * repond au resultat, c'est celle qui regarde le resultat ; s'il repond au coup
 * du bot, celle-la. Le bot n'a plus besoin qu'on devine juste a sa place : il
 * essaie tout et garde ce qui marche.
 */

/** Les contextes de lecture. Chacun resume « la situation » avant une manche ;
    le modele apprend quel coup suit habituellement chaque situation. */
const PF_LECTURES = [
  { nom: 'frequence', ctx: () => '.' },
  { nom: 'son dernier coup', ctx: (h) => h[h.length - 1].lui },
  { nom: 'mon dernier coup', ctx: (h) => h[h.length - 1].moi },
  { nom: 'le resultat', ctx: (h) => h[h.length - 1].resultat },
  { nom: 'son coup + le resultat', ctx: (h) => h[h.length - 1].lui + h[h.length - 1].resultat },
  { nom: 'mon coup + le resultat', ctx: (h) => h[h.length - 1].moi + h[h.length - 1].resultat },
  { nom: 'les deux derniers', ctx: (h) => h[h.length - 2].lui + h[h.length - 1].lui },
];

/** Ce que ce contexte a vu suivre, dans l'historique, la situation actuelle. */
function pfCompte(h, lecture, jusqu) {
  const f = { p: 0, f: 0, c: 0 };
  let total = 0;
  const cle = lecture.ctx(h.slice(0, jusqu));
  for (let i = 1; i < jusqu; i++) {
    let k;
    try { k = lecture.ctx(h.slice(0, i)); } catch (e) { continue; }
    if (k === cle) { f[h[i].lui]++; total++; }
  }
  return { f, total };
}

function pfMeilleur(f) {
  return PF_COUPS.reduce((a, b) => (f[b] > f[a] ? b : a), 'p');
}

/**
 * Predit le prochain coup adverse a partir des manches DEJA REVELEES.
 *
 * On note chaque lecture sur le passe — combien de fois elle aurait vu juste —
 * et on suit la meilleure. Rendre `null` veut dire « je ne lis rien », et
 * l'appelant joue alors au hasard : inventer un motif sur deux manches, c'est
 * se donner une raison de perdre.
 */
function pfPredit(historique) {
  const h = historique || [];
  if (h.length < 2) return null;

  let meilleure = null, meilleurScore = -1;
  for (const lecture of PF_LECTURES) {
    /* La note de la lecture : on rejoue la partie et on compte ses succes. On
       ne lui donne a chaque fois que le passe dont elle disposait — la noter
       sur des manches qu'elle n'avait pas vues la ferait paraitre meilleure
       qu'elle n'est, et le bot suivrait la mauvaise. */
    let bon = 0, essais = 0;
    for (let i = 2; i < h.length; i++) {
      const { f, total } = pfCompte(h, lecture, i);
      if (!total) continue;
      essais++;
      if (pfMeilleur(f) === h[i].lui) bon++;
    }
    if (!essais) continue;
    /* A egalite de taux, on prefere la lecture qui s'appuie sur plus
       d'observations : un 2 sur 2 ne vaut pas un 8 sur 10. */
    const note = (bon + 0.5) / (essais + 1.5);
    if (note > meilleurScore) { meilleurScore = note; meilleure = lecture; }
  }
  /* Sous le hasard pur (un tiers), la lecture n'apprend rien : autant l'avouer
     et jouer au hasard plutot que de suivre un motif qui n'existe pas. */
  if (!meilleure || meilleurScore <= 0.34) return null;

  const { f, total } = pfCompte(h, meilleure, h.length);
  if (!total) return null;
  const best = pfMeilleur(f);
  return f[best] > total / 2 ? best : null;
}

/**
 * Le coup du bot a Pierre-Feuille-Bandit.
 *
 * @param historique  les manches revelees : [{ moi, lui, resultat }, …] ou
 *                    `resultat` est celui de L'ADVERSAIRE. Jamais la manche en
 *                    cours — le bot ne doit pas voir un coup cache.
 * @param rnd         la source d'alea.
 */
function pfCoup(historique, rnd) {
  const tire = () => (typeof rnd === 'function' ? rnd() : Math.random());
  const predit = pfPredit(historique);
  if (!predit || tire() < PF_BRUIT) {
    return PF_COUPS[Math.floor(tire() * 3) % 3];
  }
  return PF_CONTRE[predit];                    // ce qui bat ce qu'on attend
}

/**
 * Faut-il relancer, et faut-il suivre ?
 *
 * La regle est celle d'un joueur qui compte : on met plus d'argent quand on
 * est DEVANT, parce qu'il reste moins de manches pour se faire reprendre, et
 * on suit une relance sauf quand on est nettement derriere et qu'il ne reste
 * presque rien pour revenir. On ne relance jamais sur du vide — le bruit du
 * modele suffit a rendre le bot illisible sans qu'il paie pour ca.
 *
 * @param moi   manches gagnees par le bot
 * @param lui   manches gagnees par l'adversaire
 * @param reste manches restantes
 */
function pfRelance(moi, lui, reste) {
  return moi > lui && reste <= 3;
}
function pfSuit(moi, lui, reste) {
  /* Se coucher rend la partie ; ne le faire que quand la remontee est
     arithmetiquement improbable, pas des qu'on est derriere. */
  return !(lui - moi >= 2 && reste <= 2);
}

module.exports = {
  // Puissance 4
  P4_ORDRE, P4_POIDS, P4_FENETRES, P4_FORCE,
  p4Evalue, p4Negamax, p4Coup,
  // morpion
  mpResout, mpCoup,
  // morpion fantome
  mfEvalue, mfCoup,
  // dames
  DM_PION, DM_DAME, dmEvalue, dmLegaux, dmCoup,
  // dernier chiffre
  DC_MIN, DC_MAX, DC_LOI, dcGain, dcCoup,
  // pierre-feuille-bandit
  PF_COUPS, PF_BAT, PF_CONTRE, PF_BRUIT, PF_LECTURES, pfPredit, pfCoup, pfRelance, pfSuit,
};
