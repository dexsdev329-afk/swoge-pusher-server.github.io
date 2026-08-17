'use strict';
/*
 * LE MODE ENTRAINEMENT — les memes six jeux, contre un bot, sans un centime.
 *
 * ---- pourquoi ca ne passe PAS par le chemin des duels payants ----
 *
 * La tentation etait d'ouvrir une table de duel ordinaire avec une mise de
 * zero et d'asseoir un bot en face. C'aurait ete une erreur : le chemin des
 * duels debite a l'entree, credite a la fin, alimente les quetes du jour,
 * compte le volume mise et prend une commission. Y faire passer des parties a
 * zero, c'est faire traverser toute la comptabilite par des montants nuls et
 * esperer que chaque multiplication tombe juste — pour un jeu ou il n'y a, par
 * construction, rien a compter.
 *
 * Ici il n'y a donc AUCUN acces aux soldes. Ce fichier ne connait pas la classe
 * des joueurs, ne sait pas additionner deux mises et ne pourrait pas en creer
 * une s'il le voulait. C'est verifiable en le lisant, ce qui vaut mieux que
 * de le promettre.
 *
 * Ce qu'on reutilise, en revanche, ce sont LES MOTEURS DE REGLES — les memes
 * classes Partie que les tables payantes. L'entrainement doit se jouer sur les
 * regles exactes de la table payante, pendule comprise, sinon il entraine a
 * autre chose. Une deuxieme implementation des regles « pour l'entrainement »
 * divergerait au premier correctif, et le joueur decouvrirait la vraie regle
 * en payant.
 *
 * ---- une table a la fois, et elle s'efface ----
 *
 * Un joueur n'a qu'une table d'entrainement ouverte : en ouvrir une seconde
 * remplace la premiere. Rien n'est sauvegarde — la partie meurt avec le
 * processus, et c'est tres bien, il n'y a rien dedans qui vaille d'etre garde.
 *
 * ---- le bot ne triche pas, et c'est ici que ca se joue ----
 *
 * Aux quatre jeux a information parfaite, il n'y a rien a cacher : le bot voit
 * le plateau, comme le joueur.
 *
 * Au SEUL jeu a coups simultanes — le Dernier Chiffre — le bot joue apres le
 * joueur dans le temps du serveur, donc le coup adverse est physiquement a sa
 * portee. Il ne le regarde pas, et ce n'est pas une question de discipline :
 * la fonction de bots.js ne le recoit pas. `dcCoup` ne prend qu'une source
 * d'alea. Un bot a qui on ne donne pas l'information ne peut pas s'en servir
 * par accident au prochain correctif.
 */

const bots = require('./bots');
const p4 = require('./puissance4');

const MOTEURS = {
  p4, mp: require('./morpion'), dm: require('./dames'),
  mf: require('./morpion_fantome'), dc: require('./dernier_chiffre'),
};
const JEUX = Object.keys(MOTEURS);

/** L'adresse du bot. Elle ne peut appartenir a personne : ce n'est pas une
    adresse Ethereum, donc aucun portefeuille ne s'y connectera jamais. */
const BOT = 'bot';

const ATTENTE = p4.ATTENTE, EN_COURS = p4.EN_COURS, FINIE = p4.FINIE;

/** Un nom d'adversaire par jeu — pour que le joueur ait quelqu'un en face
    plutot qu'une etiquette « bot ». */
const NOMS = {
  p4: 'Quatre', mp: 'Croix', dm: 'Damier',
  mf: 'Fantome', dc: 'Chiffre',
};

class Entrainement {
  /**
   * @param o.tirage  (partie) => { nombre, preuve } — le tirage du Dernier
   *   Chiffre. On ne le fabrique pas ici : le serveur detient la graine, et un
   *   deuxieme generateur « pour l'entrainement » serait un deuxieme endroit
   *   ou se tromper. Sans lui, on refuse simplement d'ouvrir une table dc.
   * @param o.alea    () => [0,1) — la source de hasard. Les tests en passent
   *   une reproductible ; sans elle, Math.random.
   */
  constructor(o) {
    o = o || {};
    this.tirage = o.tirage || null;
    this.alea = o.alea || Math.random;
    this.tables = new Map();          // adresse du joueur -> partie
    this.seq = 0;
  }

  /** Les jeux qu'on sait entrainer. */
  static get JEUX() { return JEUX.slice(); }
  static get BOT() { return BOT; }

  /**
   * Ouvre une table d'entrainement. Le bot s'assied tout de suite — il n'y a
   * personne a attendre.
   *
   * QUI OUVRE LE JEU EST TIRE AU SORT. Au Puissance 4 le premier joueur gagne
   * la partie parfaite, et au morpion il ne peut pas perdre : donner
   * systematiquement le trait au joueur ferait un entrainement plus facile que
   * la table payante, ce qui est exactement le contraire du but.
   */
  ouvrir(addr, jeu, now) {
    if (JEUX.indexOf(jeu) < 0) throw new Error('unknown game');
    if (jeu === 'dc' && !this.tirage)
      throw new Error('practice is unavailable for this game right now');
    const t = now || Date.now();
    const moteur = MOTEURS[jeu];
    const id = 'e' + jeu + (++this.seq);
    /* Mise ZERO. Les moteurs n'y touchent pas — ils ne font que la transporter
       jusqu'au partage, et le partage n'est jamais appele ici. */
    const partie = new moteur.Partie({ id, mise: 0, createur: addr, now: t });
    const premier = this.alea() < 0.5 ? 1 : 2;
    partie.rejoindre(BOT, t, premier);
    /* Ce que le moteur a pu vouloir prelever : au Pierre-Feuille-Bandit une
       relance suivie remplit `aDebiter`. On le vide a chaque fois — a mise
       nulle il ne contient que des zeros, mais une file qui grossit sans
       jamais etre lue est un piege pour le prochain qui passe. */
    if (Array.isArray(partie.aDebiter)) partie.aDebiter.length = 0;

    this.tables.set(addr, partie);
    this._botJoue(partie, t);          // s'il ouvre, il joue tout de suite
    return partie;
  }

  /** La table d'un joueur, ou null. */
  mienne(addr) { return this.tables.get(addr) || null; }

  fermer(addr) { this.tables.delete(addr); }

  /**
   * Le coup du joueur, puis la reponse du bot.
   *
   * Le bot repond DANS LE MEME APPEL. C'est ce qui permet a la page de
   * n'attendre qu'un seul aller-retour : elle envoie un coup, elle recoit la
   * position d'apres, coup du bot compris.
   */
  jouer(addr, coup, now) {
    const partie = this.tables.get(addr);
    if (!partie) throw new Error('no practice match running');
    const t = now || Date.now();
    const r = partie.jouer(addr, coup, t);
    if (Array.isArray(partie.aDebiter)) partie.aDebiter.length = 0;
    this._apresCoup(partie, t);
    this._botJoue(partie, t);
    return { partie, coup: r };
  }

  abandonner(addr, now) {
    const partie = this.tables.get(addr);
    if (!partie) throw new Error('no practice match running');
    partie.abandonner(addr, now || Date.now());
    return partie;
  }

  /**
   * La pendule. Les moteurs font perdre celui qui laisse filer son temps, et
   * on garde cette regle : un entrainement sans pendule n'entraine pas a la
   * table payante, ou la pendule existe.
   *
   * Le bot, lui, ne peut pas manquer son tour — il repond dans le meme appel
   * que le joueur. Si l'echeance tombe malgre tout de son cote, c'est qu'il
   * attendait le coup simultane du joueur.
   */
  tick(now) {
    const t = now || Date.now();
    const finies = [];
    for (const [addr, partie] of this.tables) {
      if (partie.phase === EN_COURS && typeof partie.tick === 'function') {
        if (partie.tick(t)) finies.push({ addr, partie });
      }
    }
    return finies;
  }

  // ------------------------------------------------------------ le bot joue

  /** Ce que le moteur reclame apres un coup : pour l'instant, le tirage du
      Dernier Chiffre. */
  _apresCoup(partie, t) {
    if (typeof partie.besoinTirage === 'function' && partie.besoinTirage()) {
      const d = this.tirage(partie);
      partie.revele(d.nombre, d.preuve, t);
    }
  }

  /**
   * Fait jouer le bot tant que c'est a lui. La boucle est bornee : une erreur
   * de regle qui rendrait la main au bot indefiniment bloquerait le serveur au
   * lieu de se voir, et un serveur bloque est plus difficile a diagnostiquer
   * qu'une partie qui s'arrete.
   */
  _botJoue(partie, t) {
    for (let garde = 0; garde < 64; garde++) {
      if (partie.phase !== EN_COURS) return;
      if (!this._sonTour(partie)) return;
      const coup = this._choisit(partie);
      if (coup === null || coup === undefined) return;
      partie.jouer(BOT, coup, t);
      if (Array.isArray(partie.aDebiter)) partie.aDebiter.length = 0;
      this._apresCoup(partie, t);
    }
  }

  /** Est-ce au bot de jouer ? Les jeux a coups simultanes n'ont pas de tour :
      le bot doit poser son coup des qu'il ne l'a pas encore fait. */
  _sonTour(partie) {
    const jeton = partie.jeton(BOT);
    if (!jeton) return false;
    if (partie.jeu === 'dc') return partie.choix[jeton] == null;
    return partie.tour === jeton;
  }

  _choisit(partie) {
    const jeton = partie.jeton(BOT);
    switch (partie.jeu) {
      case 'p4':
        return bots.p4Coup(partie.grille, jeton, bots.P4_FORCE);
      case 'mp':
        return bots.mpCoup(partie.grille, jeton);
      case 'mf':
        return bots.mfCoup(partie.grille, partie.pions, jeton);
      case 'dm': {
        /* Le coup, pas le tour : si la prise s'enchaine, le moteur rendra la
           main au bot et la boucle de `_botJoue` le rappellera. */
        const c = bots.dmCoup(partie.grille, jeton, partie.enchaine);
        return c ? { de: c.de, vers: c.vers } : null;
      }
      case 'dc':
        /* Le bot ne recoit RIEN de la partie : il tire dans la loi
           d'equilibre. Le coup cache du joueur est a portee de main ici, et
           c'est precisement pour ca qu'on ne le passe pas. */
        return bots.dcCoup(this.alea);
      default:
        return null;
    }
  }

  // ------------------------------------------------------------- l'affichage

  /**
   * Ce qu'on envoie au navigateur. C'est l'etat du moteur — le meme que celui
   * d'une table payante, pour que la page n'ait pas deux facons de se
   * dessiner — augmente de ce qui n'appartient qu'a l'entrainement.
   */
  etat(addr, now) {
    const partie = this.tables.get(addr);
    if (!partie) return null;
    const e = partie.etat(now || Date.now(), addr);
    e.entrainement = true;
    e.bot = BOT;
    e.botJeton = partie.jeton(BOT);
    e.botNom = NOMS[partie.jeu] || 'Bot';
    /* La mise est nulle et doit le RESTER visible : une page qui afficherait
       « 0 $SWOGE » a cote d'un bouton « jouer » a besoin de savoir que c'est
       voulu, pas un solde qui n'a pas charge. */
    e.gratuit = true;
    return e;
  }
}

module.exports = { Entrainement, BOT, JEUX, NOMS, MOTEURS };
