'use strict';
/*
 * SWOGE Dames — un contre un, chacun mise, le gagnant ramasse.
 *
 * ---- quelles regles, et pourquoi celles-la ----
 *
 * Ce sont les regles du damier a 64 cases (dames anglo-americaines) :
 * douze pions chacun, deplacement en diagonale vers l'avant, prise par saut,
 * promotion en dame sur la derniere rangee, et LA PRISE EST OBLIGATOIRE.
 *
 * Le choix se defend en trois points :
 *
 *  1. la prise obligatoire supprime la partie qui n'avance pas. Sans elle,
 *     deux joueurs qui misent de l'argent evitent le contact, la pendule
 *     tourne, et la partie se decide au temps — ce qui n'est plus un jeu ;
 *  2. la dame ne « vole » pas (elle avance d'une case comme un pion, mais
 *     dans les quatre directions). Une dame volante transforme la moindre
 *     faute en fin de partie immediate et rend la variante illisible pour qui
 *     n'y joue pas deja ;
 *  3. le damier a 64 cases donne des parties de cinq minutes. Le damier
 *     international a 100 cases en donne de trente — personne ne mise sur
 *     trente minutes de reflexion.
 *
 * ---- la representation ----
 *
 * UN TABLEAU PLAT DE 64 CASES, comme la grille du Connect 4, et pour la meme
 * raison : une diagonale devient un pas constant (±7, ±9) au lieu de deux
 * boucles imbriquees qui se trompent de bord. Le garde-fou est toujours la
 * COLONNE — un pas de +9 depuis la colonne 7 arrive sur la colonne 0 de la
 * rangee suivante, et sans la comparaison des colonnes on fabrique des
 * diagonales fantomes qui traversent le damier.
 *
 *   0 = vide, 1 = pion du joueur 1, 2 = pion du joueur 2,
 *   3 = dame du joueur 1, 4 = dame du joueur 2.
 *
 * Le joueur 1 part du bas (rangee 7) et avance vers la rangee 0.
 */

const COTE = 8;
const CASES = COTE * COTE;

const VIDE = 0;
const PION1 = 1, PION2 = 2, DAME1 = 3, DAME2 = 4;

const proprio = (v) => (v === PION1 || v === DAME1) ? 1 : (v === PION2 || v === DAME2) ? 2 : 0;
const estDame = (v) => v === DAME1 || v === DAME2;
const ligne = (i) => Math.floor(i / COTE);
const colonne = (i) => i % COTE;
/** Les cases jouables sont les cases sombres. */
const sombre = (i) => (ligne(i) + colonne(i)) % 2 === 1;

/** Le damier de depart : douze pions chacun, sur les cases sombres. */
function nouvelle() {
  const g = new Array(CASES).fill(VIDE);
  for (let i = 0; i < CASES; i++) {
    if (!sombre(i)) continue;
    const r = ligne(i);
    if (r <= 2) g[i] = PION2;
    else if (r >= 5) g[i] = PION1;
  }
  return g;
}

/* Les quatre diagonales, en pas sur le tableau plat. */
const PAS = [-COTE - 1, -COTE + 1, COTE - 1, COTE + 1];

/** Le pas est-il legal pour cette piece ? Un pion n'avance que vers l'avant. */
function sensPermis(piece, pas) {
  if (estDame(piece)) return true;
  return proprio(piece) === 1 ? pas < 0 : pas > 0;
}

/** La case voisine dans la direction `pas`, ou -1 si l'on sort du damier. */
function voisine(i, pas) {
  const j = i + pas;
  if (j < 0 || j >= CASES) return -1;
  // le garde-fou : un pas diagonal change la colonne d'exactement un
  if (Math.abs(colonne(j) - colonne(i)) !== 1) return -1;
  return j;
}

/**
 * Les coups d'une piece.
 * @returns {Array<{de:number, vers:number, prise:number|null}>}
 */
function coupsDe(grille, i) {
  const piece = grille[i];
  const out = [];
  if (!piece) return out;
  for (const pas of PAS) {
    if (!sensPermis(piece, pas)) continue;
    const j = voisine(i, pas);
    if (j < 0) continue;
    if (grille[j] === VIDE) { out.push({ de: i, vers: j, prise: null }); continue; }
    if (proprio(grille[j]) === proprio(piece)) continue;
    // une prise : la case DERRIERE l'adversaire doit exister et etre vide
    const k = voisine(j, pas);
    if (k < 0 || grille[k] !== VIDE) continue;
    out.push({ de: i, vers: k, prise: j });
  }
  return out;
}

/** Les prises possibles d'une piece — c'est ce qui decide de la suite d'un enchainement. */
function prisesDe(grille, i) { return coupsDe(grille, i).filter((c) => c.prise !== null); }

/**
 * Tous les coups legaux d'un joueur. LA PRISE EST OBLIGATOIRE : s'il en
 * existe une, elle est le seul coup permis. C'est cette regle qui empeche la
 * partie ou personne n'avance.
 */
function tousCoups(grille, joueur) {
  const simples = [], prises = [];
  for (let i = 0; i < CASES; i++) {
    if (proprio(grille[i]) !== joueur) continue;
    for (const c of coupsDe(grille, i)) (c.prise === null ? simples : prises).push(c);
  }
  return prises.length ? prises : simples;
}

/** Le joueur a-t-il encore une piece ? */
function pieces(grille, joueur) {
  let n = 0;
  for (let i = 0; i < CASES; i++) if (proprio(grille[i]) === joueur) n++;
  return n;
}

/** La rangee de promotion d'un joueur. */
const rangeeDame = (joueur) => (joueur === 1 ? 0 : COTE - 1);

// --------------------------------------------------------------- une partie

const ATTENTE = 'attente';
const EN_COURS = 'en_cours';
const FINIE = 'finie';

/* Sans prise ni avance de pion pendant ce nombre de demi-coups, la partie est
   nulle et chacun reprend sa mise. Deux dames qui se poursuivent ne le font
   pas indefiniment avec de l'argent immobilise. */
const NULLE_APRES = 60;

class Partie {
  constructor(o) {
    this.jeu = 'dm';
    this.id = o.id;
    this.mise = o.mise;
    this.coupMs = o.coupMs || 60000;
    this.joueurs = [o.createur, null];
    this.reserve = o.reserve || null;
    this.revancheDe = o.revancheDe || null;
    this.grille = nouvelle();
    this.tour = 1;
    this.phase = ATTENTE;
    this.creeA = o.now;
    this.echeance = 0;
    this.coups = [];
    this.gagnant = null;
    this.raison = null;
    this.ligne = null;              // les cases a mettre en valeur a la fin
    /* La piece qui doit continuer une prise multiple. Tant qu'elle est posee,
       le tour ne change pas et AUCUNE autre piece ne peut jouer. */
    this.enchaine = null;
    this.calme = 0;                 // demi-coups sans prise ni avance de pion
  }

  rejoindre(addr, now) {
    if (this.phase !== ATTENTE) throw new Error('this match is no longer open');
    if (addr === this.joueurs[0]) throw new Error('you cannot join your own match');
    if (this.reserve && addr !== this.reserve)
      throw new Error('this rematch is reserved for another player');
    this.joueurs[1] = addr;
    this.phase = EN_COURS;
    this.echeance = now + this.coupMs;
    return this;
  }

  jeton(addr) {
    if (addr === this.joueurs[0]) return 1;
    if (addr === this.joueurs[1]) return 2;
    return 0;
  }

  /** Les coups legaux du joueur au trait, tels que le navigateur les attend. */
  coupsLegaux() {
    if (this.phase !== EN_COURS) return [];
    if (this.enchaine !== null) return prisesDe(this.grille, this.enchaine);
    return tousCoups(this.grille, this.tour);
  }

  /**
   * Joue un coup. `coup` vaut { de, vers } — deux cases, rien d'autre : le
   * chemin de la prise se deduit, et un client qui l'enverrait ne serait de
   * toute facon pas cru.
   */
  jouer(addr, coup, now) {
    if (this.phase !== EN_COURS) throw new Error('match is not running');
    const qui = this.jeton(addr);
    if (!qui) throw new Error('you are not in this match');
    if (qui !== this.tour) throw new Error('not your turn');
    if (now > this.echeance) throw new Error('time is up');

    const de = Number(coup && coup.de), vers = Number(coup && coup.vers);
    if (!Number.isInteger(de) || !Number.isInteger(vers) ||
        de < 0 || de >= CASES || vers < 0 || vers >= CASES) throw new Error('invalid move');
    if (proprio(this.grille[de]) !== qui) throw new Error('that is not your piece');

    const legaux = this.coupsLegaux();
    const c = legaux.find((x) => x.de === de && x.vers === vers);
    if (!c) {
      /* Le message doit dire POURQUOI : « coup interdit » devant un damier ou
         une prise etait obligatoire n'apprend rien, et le joueur reessaie le
         meme coup. */
      if (this.enchaine !== null) throw new Error('you must continue the capture');
      if (legaux.length && legaux[0].prise !== null) throw new Error('a capture is available — you must take it');
      throw new Error('illegal move');
    }

    const piece = this.grille[de];
    this.grille[de] = VIDE;
    this.grille[vers] = piece;
    if (c.prise !== null) this.grille[c.prise] = VIDE;
    this.coups.push({ de, vers, prise: c.prise });

    // la promotion : elle FERME le tour, meme si une prise restait possible
    let promu = false;
    if (!estDame(piece) && ligne(vers) === rangeeDame(qui)) {
      this.grille[vers] = qui === 1 ? DAME1 : DAME2;
      promu = true;
    }

    // la partie qui s'endort
    if (c.prise !== null || !estDame(piece)) this.calme = 0; else this.calme++;

    /* L'enchainement : la meme piece doit continuer tant qu'elle peut
       prendre. Une piece promue s'arrete la — c'est la regle du damier a 64
       cases, et elle evite qu'un pion devienne dame puis rafle la moitie du
       camp adverse dans le meme tour. */
    const encore = c.prise !== null && !promu && prisesDe(this.grille, vers).length > 0;
    if (encore) {
      this.enchaine = vers;
      this.echeance = now + this.coupMs;
    } else {
      this.enchaine = null;
      const suivant = qui === 1 ? 2 : 1;
      this.tour = suivant;
      this.echeance = now + this.coupMs;
      // le joueur suivant a-t-il encore de quoi jouer ?
      if (pieces(this.grille, suivant) === 0 || tousCoups(this.grille, suivant).length === 0) {
        this._fin(qui, pieces(this.grille, suivant) === 0 ? 'plus de pions' : 'bloque', now);
        this.ligne = [vers];
      } else if (this.calme >= NULLE_APRES) {
        this._fin(null, 'partie nulle', now);
      }
    }
    return { de, vers, prise: c.prise, promu, encore };
  }

  tick(now) {
    if (this.phase !== EN_COURS || now <= this.echeance) return null;
    this._fin(this.tour === 1 ? 2 : 1, 'temps', now);
    return this;
  }

  abandonner(addr, now) {
    if (this.phase !== EN_COURS) throw new Error('match is not running');
    const qui = this.jeton(addr);
    if (!qui) throw new Error('you are not in this match');
    this._fin(qui === 1 ? 2 : 1, 'abandon', now);
    return this;
  }

  _fin(gagnant, raison, now) {
    this.phase = FINIE;
    this.gagnant = gagnant;
    this.raison = raison;
    this.finA = now;
    this.echeance = 0;
    this.enchaine = null;
  }

  adresseGagnante() { return this.gagnant ? this.joueurs[this.gagnant - 1] : null; }

  etat(now) {
    return {
      jeu: 'dm', id: this.id, mise: this.mise, phase: this.phase,
      joueurs: this.joueurs.slice(), grille: this.grille.slice(),
      tour: this.tour, gagnant: this.gagnant, raison: this.raison,
      ligne: this.ligne, coups: this.coups.slice(),
      reserve: this.reserve, revancheDe: this.revancheDe,
      /* Les coups legaux partent AVEC l'etat. Le navigateur n'a donc aucune
         regle a connaitre : il allume les cases qu'on lui donne, et le serveur
         reste seul juge — y compris de la prise obligatoire. */
      legaux: this.coupsLegaux(),
      enchaine: this.enchaine,
      pieces: [pieces(this.grille, 1), pieces(this.grille, 2)],
      reste: this.phase === EN_COURS ? Math.max(0, this.echeance - (now || 0)) : 0,
      coupMs: this.coupMs,
    };
  }
}

module.exports = {
  COTE, CASES, VIDE, PION1, PION2, DAME1, DAME2, NULLE_APRES,
  ATTENTE, EN_COURS, FINIE,
  proprio, estDame, ligne, colonne, sombre, nouvelle, voisine,
  coupsDe, prisesDe, tousCoups, pieces, rangeeDame, Partie,
  partage: require('./puissance4').partage,
};
