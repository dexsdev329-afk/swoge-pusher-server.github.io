'use strict';
/*
 * Pierre-Feuille-Bandit — sept manches, et une relance de mise entre chacune.
 *
 * ---- pourquoi celui-ci est un vrai jeu, contrairement au Dernier Chiffre ----
 *
 * Pierre-feuille-ciseaux a un equilibre connu : un tiers chacun, au hasard. Un
 * humain n'y arrive pas. Il repete, il alterne, il repond a ce qu'il vient de
 * subir — et sur sept manches, ces habitudes se lisent. C'est le SEUL de ces
 * jeux ou le coup passe de l'adversaire est une information sur son coup
 * suivant, donc le seul ou le mot « bluff » veut dire quelque chose.
 *
 * La relance ajoute une seconde decision par-dessus la premiere : celui qui
 * vient de perdre peut remonter la mise, et l'autre doit decider s'il suit.
 * Suivre avec une avance, c'est encaisser plus ; se coucher, c'est abandonner
 * une avance acquise. C'est ce qui empeche le jeu d'etre sept pile-ou-face a
 * la suite.
 *
 * ---- ce qui coute de l'argent, et donc ce qui est ecrit ici avec soin ----
 *
 * LA MISE MONTE EN COURS DE PARTIE. C'est la premiere fois dans ce serveur :
 * les trois autres duels debitent une fois, a l'entree, et ne touchent plus a
 * rien. Deux regles en decoulent, toutes deux non negociables :
 *
 *   • LA RELANCE EST BORNEE. Sans plafond, deux joueurs qui se repondent
 *     doublent jusqu'a la ruine de l'un des deux sur un jeu ou personne ne
 *     controle rien. On ajoute la mise de DEPART a chaque fois, pas le double,
 *     et au plus RELANCES_MAX fois ;
 *   • LE MOTEUR NE DEBITE RIEN. Il n'a pas les soldes et ne doit pas les
 *     avoir. Il ANNONCE ce qu'une relance acceptee coutera (`coutSi`), le
 *     serveur verifie que les deux peuvent payer, et il depose le montant a
 *     prelever dans `aDebiter`. Un moteur qui toucherait aux soldes serait un
 *     moteur qu'on ne peut plus verifier tout seul.
 *
 * ---- les coups caches ----
 *
 * Les deux choix d'une manche partent en meme temps et restent caches jusqu'a
 * ce que les deux soient poses. Meme protection qu'au Dernier Chiffre, et pour
 * la meme raison : un coup adverse visible dans la page donne la manche a tous
 * les coups, et celui qui perd ne voit rien d'anormal.
 */

/** Les trois coups. Une lettre, jamais un mot : ce qui traverse le reseau ne
    doit pas pouvoir etre autre chose que l'un de ces trois. */
const COUPS = ['p', 'f', 'c'];          // pierre, feuille, ciseaux
const BAT = { p: 'c', f: 'p', c: 'f' }; // qui bat qui

/** Sept manches, quatre pour gagner. Le compte est arrete des qu'il est
    joue : une partie qui continue apres avoir ete decidee fait payer des
    relances pour rien. */
const MANCHES = 7;
const POUR_GAGNER = 4;

/** Combien de fois la mise peut monter. Chaque relance ajoute la mise de
    DEPART : au plus quatre fois la mise initiale a la fin, ce qu'un joueur
    peut se representer avant de s'asseoir. Doubler serait seize fois. */
const RELANCES_MAX = 3;

const ATTENTE = 'attente';
const EN_COURS = 'en_cours';
const FINIE = 'finie';

/* Ce que la partie attend a un instant donne. */
const COUPS_PHASE = 'coups';     // les deux posent leur coup
const RELANCE = 'relance';       // le perdant de la manche peut relancer
const SUIVRE = 'suivre';         // il a relance ; l'autre suit ou se couche

class Partie {
  constructor(o) {
    this.jeu = 'pf';
    this.id = o.id;
    this.miseBase = o.mise;
    this.mise = o.mise;              // ce qui est engage PAR JOUEUR, a l'instant
    this.coupMs = o.coupMs || 20000;
    this.joueurs = [o.createur, null];
    this.reserve = o.reserve || null;
    this.revancheDe = o.revancheDe || null;
    this.phase = ATTENTE;
    this.creeA = o.now;
    this.echeance = 0;
    this.gagnant = null;
    this.raison = null;
    this.tour = 0;                   // les deux jouent en meme temps
    this.coups = [];

    this.etape = COUPS_PHASE;
    this.manche = 1;
    this.points = { 1: 0, 2: 0 };
    this.choix = { 1: null, 2: null };
    this.relances = 0;
    this.relanceur = null;           // qui a offert la relance en cours
    this.historique = [];            // une ligne par manche jouee
    this.aDebiter = [];              // ce que le serveur doit prelever
  }

  rejoindre(addr, now) {
    if (this.phase !== ATTENTE) throw new Error('this match is no longer open');
    if (addr === this.joueurs[0]) throw new Error('you cannot join your own match');
    if (this.reserve && addr !== this.reserve)
      throw new Error('this rematch is reserved for another player');
    this.joueurs[1] = addr;
    this.phase = EN_COURS;
    this.etape = COUPS_PHASE;
    this.echeance = now + this.coupMs;
    return this;
  }

  jeton(addr) {
    if (addr === this.joueurs[0]) return 1;
    if (addr === this.joueurs[1]) return 2;
    return 0;
  }

  /**
   * Ce que ce coup coutera A CHAQUE joueur s'il aboutit, en plus de ce qui est
   * deja engage. Le serveur s'en sert pour verifier les deux soldes AVANT que
   * la relance existe : accepter une relance qu'un joueur ne peut pas payer
   * laisserait une partie a moitie financee, ce qui n'a pas de reparation
   * propre.
   */
  coutSi(addr, coup) {
    if (this.phase !== EN_COURS) return 0;
    if (this.etape !== SUIVRE || String(coup) !== 's') return 0;
    const qui = this.jeton(addr);
    if (!qui || qui === this.relanceur) return 0;
    return this.miseBase;
  }

  jouer(addr, coup, now) {
    if (this.phase !== EN_COURS) throw new Error('match is not running');
    const qui = this.jeton(addr);
    if (!qui) throw new Error('you are not in this match');
    if (now > this.echeance) throw new Error('time is up');
    const c = String(coup);

    if (this.etape === COUPS_PHASE) return this._pose(qui, c, now);
    if (this.etape === RELANCE) return this._relance(qui, c, now);
    return this._suivre(qui, c, now);
  }

  // ------------------------------------------------------------ une manche
  _pose(qui, c, now) {
    if (COUPS.indexOf(c) < 0) throw new Error('play rock, paper or scissors');
    /* On ne se ravise pas : les deux coups partent en meme temps, donc celui
       qui traine gagnerait le droit de changer d'avis en voyant l'autre
       verrouiller. */
    if (this.choix[qui] != null) throw new Error('you already locked your move');
    this.choix[qui] = c;
    this.coups.push(qui);
    if (this.choix[1] == null || this.choix[2] == null) return { jeton: qui, verrouille: true };

    const a = this.choix[1], b = this.choix[2];
    let vainqueur = null;
    if (a !== b) vainqueur = (BAT[a] === b) ? 1 : 2;
    if (vainqueur) this.points[vainqueur]++;
    this.historique.push({ manche: this.manche, 1: a, 2: b, vainqueur, mise: this.mise });

    return this._apresManche(vainqueur, now);
  }

  _apresManche(vainqueur, now) {
    this.choix = { 1: null, 2: null };
    /* Le compte est arrete DES qu'il est joue : continuer ferait payer des
       relances sur une partie deja decidee. */
    if (this.points[1] >= POUR_GAGNER) return this._fin(1, 'quatre manches', now);
    if (this.points[2] >= POUR_GAGNER) return this._fin(2, 'quatre manches', now);
    if (this.manche >= MANCHES) {
      if (this.points[1] > this.points[2]) return this._fin(1, 'aux points', now);
      if (this.points[2] > this.points[1]) return this._fin(2, 'aux points', now);
      return this._fin(null, 'a egalite', now);
    }
    this.manche++;
    /* LA RELANCE APPARTIENT A CELUI QUI VIENT DE PERDRE. C'est ce qui la rend
       interessante : celui qui mene doit decider s'il suit une remontee de
       mise sur une avance qu'il pourrait perdre. Sur une manche nulle,
       personne ne relance — il ne s'est rien passe. */
    if (vainqueur && this.relances < RELANCES_MAX) {
      this.etape = RELANCE;
      this.relanceur = vainqueur === 1 ? 2 : 1;
    } else {
      this.etape = COUPS_PHASE;
      this.relanceur = null;
    }
    this.echeance = now + this.coupMs;
    return { manche: this.manche - 1, vainqueur, etape: this.etape };
  }

  // ----------------------------------------------------------- la relance
  _relance(qui, c, now) {
    if (qui !== this.relanceur) throw new Error('the raise is not yours to make');
    if (c === 'r') {
      this.etape = SUIVRE;
      this.echeance = now + this.coupMs;
      return { relance: true, montant: this.miseBase };
    }
    if (c === 'n') {                       // il passe
      this.etape = COUPS_PHASE;
      this.relanceur = null;
      this.echeance = now + this.coupMs;
      return { relance: false };
    }
    throw new Error('raise or pass');
  }

  _suivre(qui, c, now) {
    if (qui === this.relanceur) throw new Error('waiting for the other player');
    if (c === 'x') {                       // se coucher
      return this._fin(this.relanceur, 'couche', now);
    }
    if (c !== 's') throw new Error('call or fold');
    /* La mise monte POUR LES DEUX, et le serveur prelevera la difference. Le
       moteur ne touche a aucun solde : il dit seulement quoi prelever. */
    this.relances++;
    this.mise += this.miseBase;
    for (const a of this.joueurs) if (a) this.aDebiter.push({ addr: a, montant: this.miseBase });
    this.etape = COUPS_PHASE;
    this.relanceur = null;
    this.echeance = now + this.coupMs;
    return { suivi: true, mise: this.mise };
  }

  /**
   * La pendule.
   *
   * Se taire ne doit jamais valoir mieux que jouer. Pendant les coups, celui
   * qui a pose gagne la partie ; si aucun n'a pose, il ne s'est rien passe et
   * les mises reviennent. Sur une relance en attente, ne rien dire vaut
   * passer — pas se coucher : le silence ne doit pas couter la partie a
   * quelqu'un qui a peut-etre juste perdu sa connexion.
   */
  tick(now) {
    if (this.phase !== EN_COURS || now <= this.echeance) return null;
    if (this.etape === RELANCE) {
      this.etape = COUPS_PHASE; this.relanceur = null;
      this.echeance = now + this.coupMs;
      return this;
    }
    if (this.etape === SUIVRE) {
      this.relanceur = null;
      this.etape = COUPS_PHASE;
      this.echeance = now + this.coupMs;
      return this;
    }
    const a = this.choix[1] != null, b = this.choix[2] != null;
    if (a && !b) this._fin(1, 'temps', now);
    else if (b && !a) this._fin(2, 'temps', now);
    else this._fin(null, 'temps', now);
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
    this.etape = COUPS_PHASE;
    return this;
  }

  adresseGagnante() { return this.gagnant ? this.joueurs[this.gagnant - 1] : null; }

  /** Le coup adverse ne descend pas tant que la manche court. */
  etat(now, pour) {
    const moi = pour ? this.jeton(pour) : 0;
    const fini = this.phase === FINIE;
    const visible = (q) => (fini || q === moi ? this.choix[q] : null);
    return {
      jeu: 'pf', id: this.id, mise: this.mise, miseBase: this.miseBase,
      phase: this.phase, joueurs: this.joueurs.slice(),
      gagnant: this.gagnant, raison: this.raison, tour: 0, coups: this.coups.slice(),
      etape: this.etape, manche: this.manche, manches: MANCHES, pourGagner: POUR_GAGNER,
      points: { 1: this.points[1], 2: this.points[2] },
      choix: { 1: visible(1), 2: visible(2) },
      verrouille: { 1: this.choix[1] != null, 2: this.choix[2] != null },
      relances: this.relances, relancesMax: RELANCES_MAX, relanceur: this.relanceur,
      /* L'historique est PUBLIC, et c'est voulu : lire les habitudes de
         l'adversaire sur les manches passees EST le jeu. */
      historique: this.historique.slice(),
      reserve: this.reserve, revancheDe: this.revancheDe,
      reste: this.phase === EN_COURS ? Math.max(0, this.echeance - (now || 0)) : 0,
      coupMs: this.coupMs,
    };
  }
}

module.exports = {
  COUPS, BAT, MANCHES, POUR_GAGNER, RELANCES_MAX,
  ATTENTE, EN_COURS, FINIE, COUPS_PHASE, RELANCE, SUIVRE, Partie,
  partage: require('./puissance4').partage,
};
