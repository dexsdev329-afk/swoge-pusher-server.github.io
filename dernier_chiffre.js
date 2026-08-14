'use strict';
/*
 * Le Dernier Chiffre — chacun cache un nombre, le plus proche SANS DEPASSER
 * remporte le pot.
 *
 * ---- pourquoi « sans depasser », et pas « le plus proche » ----
 *
 * La regle d'origine etait « le plus proche du tirage gagne ». Elle a ete
 * mesuree avant d'etre ecrite, et elle ne tient pas : sur une cible uniforme,
 * la meilleure reponse a n'importe quel choix adverse converge vers le milieu,
 * les deux joueurs y arrivent, et la partie devient un pile ou face — avec une
 * commission dessus. On ne vend pas un pile ou face en l'appelant un jeu.
 *
 * « Sans depasser » change la nature de la decision. Face a un adversaire qui
 * joue petit, on monte juste au-dessus de lui ; face a un adversaire qui joue
 * gros, on joue TRES petit et on le laisse se griller. Le basculement se situe
 * vers 55 sur une echelle de 100, et il n'existe aucun choix qui batte tous
 * les autres — c'est un equilibre mixte, donc un vrai jeu.
 *
 * ---- ce que « bluff » veut dire ici, et ce qu'il ne veut pas dire ----
 *
 * Il n'y en a pas, et il ne peut pas y en avoir : les deux choix sont caches
 * et la cible ne depend d'aucun des deux. Il n'y a rien a lire chez l'autre.
 * Ce jeu est un pari de position contre un adversaire invisible, pas un bluff,
 * et le dire franchement vaut mieux que de le promettre a l'ecran.
 *
 * ---- le tirage ----
 *
 * Le moteur ne tire RIEN. Il dit quand il faut tirer et recoit le resultat.
 * La graine du serveur reste chez le serveur : elle vaut de l'argent tant
 * qu'elle n'est pas revelee, et une partie de duel finit dans l'etat sauvegarde.
 */

/** L'echelle des choix. Cent : assez large pour que la position compte, assez
    courte pour tenir sur un ecran de telephone sans champ de saisie. */
const MIN = 1;
const MAX = 100;

const ATTENTE = 'attente';
const EN_COURS = 'en_cours';
const FINIE = 'finie';

class Partie {
  constructor(o) {
    this.jeu = 'dc';
    this.id = o.id;
    this.mise = o.mise;
    this.coupMs = o.coupMs || 30000;
    this.joueurs = [o.createur, null];
    this.reserve = o.reserve || null;
    this.revancheDe = o.revancheDe || null;
    this.phase = ATTENTE;
    this.creeA = o.now;
    this.echeance = 0;
    this.gagnant = null;
    this.raison = null;
    /* Les choix, caches jusqu'au tirage. `null` = pas encore choisi. */
    this.choix = { 1: null, 2: null };
    this.cible = null;
    this.preuve = null;
    this.tire = false;
    /* Il n'y a pas de tour : les deux jouent en meme temps. Le champ existe
       parce que le vestibule commun le lit, et il vaut zero — ce qui se lit
       « personne n'attend personne ». */
    this.tour = 0;
    this.coups = [];
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

  jouer(addr, coup, now) {
    if (this.phase !== EN_COURS) throw new Error('match is not running');
    const qui = this.jeton(addr);
    if (!qui) throw new Error('you are not in this match');
    if (now > this.echeance) throw new Error('time is up');
    /* On ne rejoue pas. Sans ce refus, le dernier a valider pourrait attendre
       l'autre — et comme les deux choix partent au meme moment vers le
       serveur, celui qui traine gagnerait le droit de se raviser. */
    if (this.choix[qui] != null) throw new Error('you already locked your number');
    const c = Number(coup);
    if (!Number.isInteger(c) || c < MIN || c > MAX)
      throw new Error('pick a whole number between ' + MIN + ' and ' + MAX);

    this.choix[qui] = c;
    this.coups.push(qui);
    return { jeton: qui, verrouille: true };
  }

  /** Les deux ont choisi : il est temps de tirer. */
  besoinTirage() {
    return this.phase === EN_COURS && !this.tire &&
           this.choix[1] != null && this.choix[2] != null;
  }

  /**
   * Le tirage, fourni par le serveur qui detient la graine.
   *
   * LE PLUS PROCHE SANS DEPASSER. Depasser, c'est etre elimine, pas etre
   * deuxieme — c'est toute la tension du jeu. Si les deux depassent, personne
   * ne gagne et les mises reviennent : faire payer deux joueurs pour un
   * tirage bas serait leur faire porter le hasard tout seuls.
   */
  revele(nombre, preuve, now) {
    if (this.tire) throw new Error('already drawn');
    const n = Number(nombre);
    if (!Number.isInteger(n) || n < MIN || n > MAX) throw new Error('invalid draw');
    this.tire = true;
    this.cible = n;
    this.preuve = preuve || null;

    const a = this.choix[1], b = this.choix[2];
    const okA = a != null && a <= n, okB = b != null && b <= n;
    if (okA && okB) {
      if (a > b) this._fin(1, 'plus proche', now);
      else if (b > a) this._fin(2, 'plus proche', now);
      else this._fin(null, 'meme nombre', now);
    } else if (okA) this._fin(1, 'l autre a depasse', now);
    else if (okB) this._fin(2, 'l autre a depasse', now);
    else this._fin(null, 'les deux ont depasse', now);
    return this;
  }

  /**
   * La pendule. Ne pas choisir, c'est perdre — sinon il suffirait de se taire
   * pour transformer une partie perdue d'avance en nulle. Si PERSONNE n'a
   * choisi, il ne s'est rien passe et les mises reviennent.
   */
  tick(now) {
    if (this.phase !== EN_COURS || now <= this.echeance) return null;
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
  }

  adresseGagnante() { return this.gagnant ? this.joueurs[this.gagnant - 1] : null; }

  /**
   * L'etat, vu par `pour`.
   *
   * LE CHOIX DE L'ADVERSAIRE NE DESCEND PAS TANT QUE LA PARTIE COURT. C'est
   * la seule regle de ce fichier qui protege de l'argent : un etat complet
   * envoye a tout le monde met le nombre adverse dans la console du
   * navigateur, et le second a choisir gagne a tous les coups. On envoie donc
   * `verrouille` — le fait qu'il ait choisi, ce qui est une information
   * legitime et attendue — et jamais quoi.
   */
  etat(now, pour) {
    const moi = pour ? this.jeton(pour) : 0;
    const fini = this.phase === FINIE;
    const visible = (q) => (fini || q === moi ? this.choix[q] : null);
    return {
      jeu: 'dc', id: this.id, mise: this.mise, phase: this.phase,
      joueurs: this.joueurs.slice(), gagnant: this.gagnant, raison: this.raison,
      tour: 0, coups: this.coups.slice(),
      min: MIN, max: MAX,
      choix: { 1: visible(1), 2: visible(2) },
      verrouille: { 1: this.choix[1] != null, 2: this.choix[2] != null },
      cible: fini ? this.cible : null,
      preuve: fini ? this.preuve : null,
      reserve: this.reserve, revancheDe: this.revancheDe,
      reste: this.phase === EN_COURS ? Math.max(0, this.echeance - (now || 0)) : 0,
      coupMs: this.coupMs,
    };
  }
}

module.exports = {
  MIN, MAX, ATTENTE, EN_COURS, FINIE, Partie,
  partage: require('./puissance4').partage,
};
