'use strict';
/*
 * Le Boulier devient une salle : UN tirage, tout le monde dessus.
 *
 * ---- pourquoi ce n'etait pas deja le cas ----
 *
 * La premiere version tirait a la demande, un joueur a la fois. Ca marchait,
 * et ca ratait tout ce qui fait un boulier : on regarde les boules sortir avec
 * les autres, on voit qui touche quoi, et le plein qu'un inconnu vient de faire
 * est celui qu'on a rate de deux numeros. Un tirage prive, c'est une machine a
 * sous avec des boules.
 *
 * ---- les trois phases ----
 *
 *   ATTENTE  dix secondes pour acheter ses grilles. Tout le monde voit le
 *            decompte, le nombre de joueurs et la mise qui monte ;
 *   TIRAGE   les trente boules. Elles sont TOUTES connues des la premiere
 *            milliseconde de la phase — le serveur ne les lache pas une par
 *            une, il envoie la liste et le navigateur la rejoue. C'est ce qui
 *            permet a quelqu'un qui arrive en cours de tirage de le voir a
 *            partir de la bonne boule au lieu d'attendre la manche suivante ;
 *   APRES    les resultats, cinq secondes, puis on rouvre.
 *
 * ---- l'equite d'un tirage PARTAGE ----
 *
 * En solo, chaque manche se verifiait avec la graine du joueur et son numero.
 * Partagee, la manche n'appartient a personne : il faut donc un engagement
 * PUBLIC, publie avant que quiconque ait mise. On reprend exactement la chaine
 * du Crash — sha256 appliquee N fois, jouee a l'envers — parce qu'elle a
 * precisement cette propriete : l'empreinte du premier maillon est annoncee au
 * demarrage, chaque manche revele le sien, et n'importe qui peut verifier que
 * sha256(maillon) donne bien celui de la manche precedente. Une chaine de
 * cinquante mille maillons remontee jusqu'a l'engagement, c'est cinquante mille
 * manches qu'on ne peut pas avoir choisies apres coup.
 *
 * Le tirage lui-meme reste celui de boulier.js, au maillon pres : meme melange
 * de Fisher-Yates partiel, meme rejet, meme code — donc les memes garanties
 * d'uniformite, deja mesurees.
 *
 * Ce fichier ne connait ni les soldes ni les sockets : il compte le temps, il
 * tire, il dit ce qui se passe. game.js debite et credite, server.js diffuse.
 */

const crypto = require('crypto');
const boulier = require('./boulier');
const { chaine } = require('./crash');

const ATTENTE = 'attente';
const TIRAGE = 'tirage';
const APRES = 'apres';

class Salle {
  constructor(opts) {
    const o = opts || {};
    this.sel = o.sel || 'swoge-boulier';
    this.attenteMs = o.attenteMs || 10000;
    /* Le temps que le navigateur lache ses trente boules : 30 x 300 ms plus
       une seconde de mise en route. La phase dure ce que dure l'animation,
       sinon la salle rouvre les mises pendant que les boules tombent encore. */
    this.tirageMs = o.tirageMs || 10500;
    this.apresMs = o.apresMs || 5000;

    const c = chaine(o.graine || crypto.randomBytes(32).toString('hex'), o.longueur || 50000);
    this.engagement = c.engagement;
    this.maillons = c.maillons;

    this.index = 0;
    this.manche = 0;
    this.phase = APRES;
    this.jusqua = 0;
    this.sortie = [];
    this.maillon = null;
    this.precedent = this.engagement;
    this.joueurs = new Map();     // addr -> { nom, grilles, mise, lignes, gain, cagnotte }
    this.histoire = [];           // les dernieres manches, pour la page
  }

  /* Reprise apres redemarrage : on ne rejoue jamais un maillon deja consomme.
     Les joueurs, eux, ne se reprennent pas — une manche a moitie jouee dont
     tout le monde a ete deconnecte n'a plus d'arbitre, et les mises sont
     remboursees par game.js a la relecture. */
  charge(st) {
    if (!st) return;
    if (st.index != null) this.index = st.index;
    if (st.manche != null) this.manche = st.manche;
    if (st.precedent) this.precedent = st.precedent;
    if (Array.isArray(st.histoire)) this.histoire = st.histoire.slice(-30);
  }
  sauve() {
    return { index: this.index, manche: this.manche,
             precedent: this.precedent, histoire: this.histoire.slice(-30) };
  }

  /**
   * Fait avancer l'horloge. Renvoie les evenements a diffuser, dans l'ordre.
   * Une boucle et non un `if` : si le serveur a ete gele trente secondes, on
   * rattrape les phases sautees au lieu de rester bloque dans le passe.
   */
  tick(now) {
    const evs = [];
    let tours = 0;
    while (tours++ < 100) {
      if (this.phase === APRES && now >= this.jusqua) { evs.push(this._ouvre(now)); continue; }
      if (this.phase === ATTENTE && now >= this.jusqua) { evs.push(this._tire(now)); continue; }
      if (this.phase === TIRAGE && now >= this.jusqua) { evs.push(this._ferme(now)); continue; }
      break;
    }
    return evs;
  }

  /** Ouvre les inscriptions : nouvelle manche, salle vide. */
  _ouvre(now) {
    this.phase = ATTENTE;
    this.jusqua = now + this.attenteMs;
    this.manche++;
    this.joueurs = new Map();
    this.sortie = [];
    this.maillon = null;
    /* `duree` accompagne `jusqua` : l'horloge du navigateur n'est pas celle du
       serveur, et un decompte cale sur une echeance absolue afficherait
       n'importe quoi chez un joueur dont la montre retarde de dix secondes. */
    return { type: 'boulierAttente', manche: this.manche, jusqua: this.jusqua,
             duree: this.attenteMs, engagement: this.engagement,
             precedent: this.precedent };
  }

  /**
   * Ferme les inscriptions et tire. Le maillon est revele ICI, avec la sortie :
   * il n'y a plus rien a cacher une fois les boules connues, et le garder pour
   * la fin empecherait de verifier pendant que ca se joue.
   */
  _tire(now) {
    const m = this.maillons[this.index % this.maillons.length];
    this.maillon = m;
    this.precedent = m;
    this.index++;
    /* Le tirage de boulier.js, au maillon pres. Le « sel » tient la place de la
       graine du joueur : il est public et fixe d'avance, ce qui prouve que la
       chaine n'a pas ete choisie apres coup pour tomber sur des tirages
       pauvres. */
    this.sortie = boulier.tirage(m, this.sel, this.manche);
    this.phase = TIRAGE;
    this.jusqua = now + this.tirageMs;
    return { type: 'boulierTirage', manche: this.manche, sortie: this.sortie.slice(),
             maillon: m, sel: this.sel, jusqua: this.jusqua, duree: this.tirageMs,
             joueurs: this.liste() };
  }

  /** La manche est finie : on montre les resultats, puis on rouvrira. */
  _ferme(now) {
    this.phase = APRES;
    this.jusqua = now + this.apresMs;
    const l = this.liste();
    this.histoire.unshift({ manche: this.manche, t: now,
                            joueurs: l.length,
                            mise: l.reduce((s, j) => s + j.mise, 0),
                            gain: l.reduce((s, j) => s + j.gain, 0),
                            best: l.reduce((s, j) => Math.max(s, j.best), 0) });
    if (this.histoire.length > 30) this.histoire.pop();
    return { type: 'boulierFin', manche: this.manche, jusqua: this.jusqua,
             duree: this.apresMs, joueurs: l };
  }

  /**
   * Inscrit des grilles. game.js a deja debite : ici on enregistre, et on
   * refuse ce qui ne peut pas etre joue.
   *
   * On AJOUTE aux grilles deja posees plutot que de les remplacer : un joueur
   * qui appuie deux fois sur « 10 grilles » pendant les dix secondes en veut
   * vingt, et le plafond est celui de la MANCHE, pas du clic.
   */
  inscrire(addr, nom, grilles, prix, max) {
    if (this.phase !== ATTENTE) throw new Error('bets are closed for this draw');
    if (!Array.isArray(grilles) || !grilles.length) throw new Error('play at least one grid');
    const j = this.joueurs.get(addr);
    const deja = j ? j.grilles.length : 0;
    if (deja + grilles.length > max)
      throw new Error('at most ' + max + ' grids per draw');
    const g = grilles.map((x) => boulier.valideGrille(x));
    if (j) {
      j.grilles = j.grilles.concat(g);
      j.mise += prix * g.length;
      j.nom = nom || j.nom;
    } else {
      this.joueurs.set(addr, { nom: nom || null, grilles: g, mise: prix * g.length,
                               lignes: [], gain: 0, cagnotte: 0, best: 0 });
    }
    return this.joueurs.get(addr);
  }

  /** Ce qu'un joueur a pose sur cette manche. */
  mien(addr) {
    const j = this.joueurs.get(addr);
    if (!j) return null;
    return { grilles: j.grilles.map((g) => g.slice()), mise: j.mise,
             lignes: j.lignes.slice(), gain: j.gain, cagnotte: j.cagnotte, best: j.best };
  }

  /** Le resultat d'un joueur, une fois que game.js a paye. */
  note(addr, lignes, gain, cagnotte) {
    const j = this.joueurs.get(addr);
    if (!j) return;
    j.lignes = lignes;
    j.gain = gain;
    j.cagnotte = cagnotte;
    j.best = lignes.reduce((s, l) => Math.max(s, l.n), 0);
  }

  /**
   * La table, telle qu'elle s'affiche. On ne rend PAS les grilles des autres :
   * savoir que quelqu'un a coche le 47 avant que le 47 sorte ne regarde
   * personne, et la liste ferait dix mille numeros par diffusion.
   */
  liste() {
    const out = [];
    for (const [addr, j] of this.joueurs)
      out.push({ addr, nom: j.nom, grilles: j.grilles.length, mise: j.mise,
                 gain: j.gain, cagnotte: j.cagnotte, best: j.best });
    /* Le plus gros gain devant, puis la plus grosse mise : pendant l'attente
       personne n'a encore gagne, c'est donc la mise qui classe, et au resultat
       c'est le gain. Une seule regle pour les deux moments. */
    out.sort((a, b) => (b.gain - a.gain) || (b.mise - a.mise));
    return out;
  }

  etat(now, addr) {
    const e = {
      phase: this.phase, manche: this.manche,
      jusqua: this.jusqua, reste: Math.max(0, this.jusqua - now),
      engagement: this.engagement, precedent: this.precedent,
      joueurs: this.liste(),
      histoire: this.histoire.slice(0, 12),
    };
    /* Le tirage part avec l'etat pendant la phase TIRAGE et pendant APRES :
       quelqu'un qui arrive au milieu voit les boules deja sorties au lieu
       d'attendre dix secondes devant une cage vide. */
    if (this.phase !== ATTENTE) {
      e.sortie = this.sortie.slice();
      e.maillon = this.maillon;
      e.sel = this.sel;
      /* Combien de boules ont deja du tomber a l'ecran, pour reprendre le
         tirage au bon endroit plutot qu'au debut. */
      if (this.phase === TIRAGE) {
        const ecoule = this.tirageMs - Math.max(0, this.jusqua - now);
        e.avance = Math.max(0, Math.min(this.sortie.length,
          Math.floor((ecoule / this.tirageMs) * this.sortie.length)));
      } else e.avance = this.sortie.length;
    }
    if (addr) e.moi = this.mien(addr);
    return e;
  }
}

module.exports = { Salle, ATTENTE, TIRAGE, APRES };
