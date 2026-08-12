'use strict';
/*
 * SWOGE Crash — une courbe monte, tout le monde joue la MEME manche, chacun
 * encaisse quand il veut. Celui qui tient trop longtemps perd sa mise.
 *
 * Cinq decisions de regles, parce qu'elles changent tout :
 *
 *  1. LE POINT DE CRASH EST TIRE D'UNE CHAINE DE HASH FAITE A L'AVANCE, pas au
 *     debut de la manche. On tire une graine, on la hashe N fois, et on JOUE LA
 *     CHAINE A L'ENVERS. Le dernier maillon est publie avant la premiere manche.
 *     Chaque manche revele son maillon, et sha256(maillon) redonne celui de la
 *     manche precedente : le joueur verifie toute l'histoire avec une seule
 *     valeur connue d'avance. Surtout, la maison ne peut PAS changer une manche
 *     a venir — il faudrait inverser sha256. Avec un tirage par manche, rien
 *     n'empecherait de retirer un gros multiplicateur le jour ou un gros joueur
 *     est en table.
 *
 *  2. LE MULTIPLICATEUR EST UNE FONCTION DU TEMPS, pas un compteur diffuse.
 *     multi(t) = e^(vitesse x t). Le serveur n'envoie que l'heure de depart :
 *     le navigateur dessine la courbe lui-meme, a 60 images par seconde, sans
 *     que rien ne transite. Et l'encaissement est date par L'HORLOGE DU SERVEUR
 *     a l'arrivee du message — jamais par le multiplicateur que le client
 *     pretend avoir atteint, qui serait trivial a falsifier.
 *
 *  3. L'AVANTAGE DE LA MAISON EST UNE PROBABILITE DE CRASH IMMEDIAT, pas une
 *     retenue sur les gains. Avec une probabilite p, la manche crashe a 1.00x
 *     et personne n'encaisse ; sinon P(atteindre x) = (1-p)/x. Un joueur qui
 *     vise x gagne x avec cette probabilite, donc il recupere exactement 1-p de
 *     sa mise — QUELLE QUE SOIT SA CIBLE. Aucune strategie ne bat les autres,
 *     et il n'y a pas un seul multiplicateur ou la maison gagne plus.
 *
 *  4. TOUT EST EN ENTIERS EXACTS (BigInt). Le tirage vit sur 2^52 issues :
 *     100 x 2^52 depasse la precision d'un flottant, et le taux de retour
 *     calcule en flottant serait faux dans les derniers chiffres — c'est-a-dire
 *     invérifiable. L'arrondi du multiplicateur se fait vers le BAS : il ne
 *     peut que retirer au joueur, jamais creer des jetons a partir de rien.
 *
 *  5. LE RETRAIT AUTOMATIQUE EST TRAITE PAR LE SERVEUR, A LA MILLISECONDE OU LA
 *     COURBE PASSE LA CIBLE. Un joueur dont la connexion rame ne doit pas
 *     perdre un encaissement que sa cible lui donnait : le reseau ne fait pas
 *     partie du jeu.
 *
 * Ce fichier ne connait ni les soldes ni les sockets : il tire, il compte le
 * temps, il dit ce qui se passe. game.js debite et credite, server.js diffuse.
 */

const crypto = require('crypto');

/* 2^52 issues : la precision entiere d'un flottant IEEE, et de quoi tirer un
   multiplicateur jusqu'a 45 000 milliards. Largement au-dela de tout plafond. */
const ESPACE = 1n << 52n;

// ------------------------------------------------------------------- chaine

/**
 * La chaine de hash, construite a l'envers.
 *
 * maillon[0] est joue par la manche 1, maillon[1] par la manche 2, etc. Et
 * sha256(maillon[i]) === maillon[i-1], avec maillon[-1] = l'engagement publie
 * avant la premiere manche. Un joueur qui note l'engagement peut verifier
 * toutes les manches, y compris celles qu'il n'a pas vues.
 */
function chaine(graine, n) {
  if (!(n > 0)) throw new Error('chaine vide');
  // On hashe n fois depuis la graine, puis on retourne : la derniere valeur
  // calculee devient l'engagement, la premiere manche joue l'avant-derniere.
  const avant = [Buffer.from(String(graine), 'utf8')];
  for (let i = 0; i < n; i++)
    avant.push(crypto.createHash('sha256').update(avant[i]).digest());
  const maillons = [];
  for (let i = n - 1; i >= 0; i--) maillons.push(avant[i].toString('hex'));
  return { engagement: avant[n].toString('hex'), maillons };
}

/** Verifie qu'un maillon revele donne bien celui de la manche precedente. */
function verifie(maillon, precedent) {
  return crypto.createHash('sha256')
    .update(Buffer.from(maillon, 'hex')).digest('hex') === precedent;
}

// -------------------------------------------------------------- le tirage

/**
 * Le point de crash d'une manche, a partir de son maillon.
 *
 * Le sel est PUBLIC et fixe d'avance (mettez-y un hash de bloc futur, par
 * exemple) : il prouve que la chaine n'a pas ete choisie apres coup pour
 * tomber sur des multiplicateurs bas. Sans lui, la maison pourrait tirer mille
 * chaines et garder la pire pour les joueurs.
 *
 * Loi obtenue, pour un avantage p :
 *   P(crash a 1.00x)  = p
 *   P(atteindre x)    = (1-p)/x   pour tout x >= 1
 */
function pointDeCrash(maillon, sel, edgeBps, plafond) {
  const h = BigInt('0x' + crypto.createHmac('sha256', String(sel))
    .update(String(maillon)).digest('hex').slice(0, 13));  // 13 chiffres hex = 52 bits

  const rates = (BigInt(edgeBps) * ESPACE) / 10000n;   // les issues qui crashent a 1.00x
  if (h < rates) return 1;

  const n = ESPACE - rates;
  const j = h - rates;                                  // 0 <= j < n
  /* n/(n-j) est uniforme au sens ou P(n/(n-j) >= x) = 1/x. La division
     entiere par 100 arrondit vers le bas, donc toujours contre le joueur. */
  const brut = Number((100n * n) / (n - j)) / 100;
  return Math.min(brut, plafond);
}

// ---------------------------------------------------------- la courbe

/**
 * Le multiplicateur apres `ms` millisecondes de vol. Deux decimales vers le
 * bas, comme le point de crash : les deux doivent se comparer sans jamais se
 * croiser a cause d'un arrondi.
 */
function multiA(ms, vitesse) {
  if (!(ms > 0)) return 1;
  return Math.floor(100 * Math.exp(vitesse * ms)) / 100;
}

/** L'inverse : la premiere milliseconde ou la courbe affiche `multi`. */
function msPour(multi, vitesse) {
  if (!(multi > 1)) return 0;
  return Math.ceil(Math.log(multi) / vitesse);
}

// ------------------------------------------------- taux de retour, exact

/**
 * Le taux de retour REEL pour une cible donnee, calcule sur les 2^52 issues.
 * Pas une simulation : un comptage.
 *
 * Le joueur vise x (deux decimales, donc X = 100x entier). Il touche x si le
 * point de crash atteint x, c'est-a-dire si (100n)/(n-j) >= X, soit
 * n-j <= floor(100n/X), soit exactement floor(100n/X) issues sur 2^52.
 */
function retour(cible, edgeBps) {
  const X = BigInt(Math.round(cible * 100));
  if (X <= 100n) throw new Error('cible invalide');
  const rates = (BigInt(edgeBps) * ESPACE) / 10000n;
  const n = ESPACE - rates;
  const gagnantes = (100n * n) / X;
  // (X/100) x gagnantes / 2^52, en flottant seulement a la toute derniere etape
  return (Number(X) / 100) * (Number(gagnantes) / Number(ESPACE));
}

// --------------------------------------------------------------- la table

const ATTENTE = 'attente';   // les mises sont ouvertes
const VOL     = 'vol';       // la courbe monte
const APRES   = 'apres';     // la manche est crashee, on regarde les debris

/**
 * La manche partagee. Aucun minuteur a l'interieur : on lui passe l'heure et
 * elle repond. C'est ce qui rend le deroule TESTABLE — on peut rejouer une
 * manche entiere milliseconde par milliseconde sans attendre.
 */
class Table {
  constructor(opts) {
    const o = opts || {};
    this.sel = o.sel || 'swoge';
    this.edgeBps = o.edgeBps != null ? o.edgeBps : 300;
    this.plafond = o.plafond || 10000;
    this.vitesse = o.vitesse || 0.00006;
    this.attenteMs = o.attenteMs || 7000;
    this.apresMs = o.apresMs || 4000;

    const c = chaine(o.graine || crypto.randomBytes(32).toString('hex'), o.longueur || 50000);
    this.engagement = c.engagement;
    this.maillons = c.maillons;

    this.index = 0;            // quelle manche de la chaine on joue
    this.manche = 0;           // numero affiche, repart de la reprise d'etat
    this.phase = APRES;        // on demarre "apres" : la premiere attente s'ouvre au premier tick
    this.jusqua = 0;           // fin de la phase courante (attente et apres seulement)
    this.depart = 0;           // heure de depart du vol
    this.point = 1;            // point de crash de la manche en cours
    this.maillon = null;       // revele SEULEMENT au crash
    this.precedent = this.engagement;
    this.paris = new Map();    // addr -> { mise, auto, multi, payout, retireA }
    this.histoire = [];        // les derniers points de crash, pour l'affichage
  }

  /** Reprise apres redemarrage : on ne rejoue jamais un maillon deja consomme. */
  charge(st) {
    if (!st) return;
    if (st.index != null) this.index = st.index;
    if (st.manche != null) this.manche = st.manche;
    if (st.precedent) this.precedent = st.precedent;
    if (Array.isArray(st.histoire)) this.histoire = st.histoire.slice(-50);
  }

  sauve() {
    return { index: this.index, manche: this.manche,
             precedent: this.precedent, histoire: this.histoire.slice(-50) };
  }

  /**
   * Fait avancer l'horloge. Renvoie la liste des evenements a diffuser, dans
   * l'ordre ou ils se sont produits. Appeler aussi souvent qu'on veut : deux
   * appels a la meme milliseconde ne produisent rien deux fois.
   */
  tick(now) {
    const evs = [];
    let boucle = 0;
    // Une boucle, pas un if : si le serveur a ete gele 30 secondes, on doit
    // rattraper les phases sautees au lieu de rester bloque dans le passe.
    while (boucle++ < 100) {
      if (this.phase === APRES && now >= this.jusqua) { evs.push(this._ouvre(now)); continue; }
      if (this.phase === ATTENTE && now >= this.jusqua) { evs.push(this._envole(now)); continue; }
      if (this.phase === VOL) {
        const fin = this.depart + msPour(this.point, this.vitesse);
        // Les retraits automatiques d'abord : a la milliseconde ou leur cible
        // est atteinte, donc AVANT le crash s'ils sont dessous.
        for (const e of this._autos(Math.min(now, fin))) evs.push(e);
        if (now >= fin) { evs.push(this._crashe(fin)); continue; }
      }
      break;
    }
    return evs;
  }

  /** Ouvre les mises : nouvelle manche, table vide. */
  _ouvre(now) {
    this.phase = ATTENTE;
    this.jusqua = now + this.attenteMs;
    this.manche++;
    this.paris = new Map();
    this.maillon = null;
    /* `duree` accompagne `jusqua` : l'horloge du navigateur n'est pas celle du
       serveur, et un decompte calcule sur une echeance absolue afficherait
       n'importe quoi chez un joueur dont la montre retarde de dix secondes. */
    return { type: 'crashAttente', manche: this.manche, jusqua: this.jusqua,
             duree: this.attenteMs,
             engagement: this.engagement, precedent: this.precedent };
  }

  /** Ferme les mises et lance la courbe. Le point est fixe ici, pas avant. */
  _envole(now) {
    const m = this.maillons[this.index % this.maillons.length];
    this.point = pointDeCrash(m, this.sel, this.edgeBps, this.plafond);
    this._enVol = m;
    this.phase = VOL;
    this.depart = now;
    this.jusqua = 0;
    return { type: 'crashDepart', manche: this.manche, depart: this.depart,
             vitesse: this.vitesse, joueurs: this.liste() };
  }

  /** La courbe casse. C'est ici, et seulement ici, que le maillon est revele. */
  _crashe(quand) {
    this.phase = APRES;
    this.jusqua = quand + this.apresMs;
    this.maillon = this._enVol;
    this.precedent = this._enVol;
    this.index++;
    this.histoire.push(this.point);
    if (this.histoire.length > 50) this.histoire.shift();
    const perdants = [];
    for (const [addr, p] of this.paris) if (p.multi == null) perdants.push(addr);
    return { type: 'crashFin', manche: this.manche, point: this.point,
             maillon: this.maillon, sel: this.sel, perdants, quand };
  }

  /** Les retraits automatiques dus a cet instant. */
  _autos(now) {
    const evs = [];
    for (const [addr, p] of this.paris) {
      if (p.multi != null || !(p.auto > 1)) continue;
      const du = this.depart + msPour(p.auto, this.vitesse);
      if (now < du) continue;
      if (p.auto > this.point) continue;   // la courbe casse avant sa cible
      evs.push(this._encaisse(addr, p, p.auto, du));
    }
    return evs;
  }

  _encaisse(addr, p, multi, quand) {
    p.multi = multi;
    p.payout = Math.floor(p.mise * multi);
    p.retireA = quand;
    return { type: 'crashRetrait', addr, manche: this.manche, mise: p.mise,
             multi, payout: p.payout, net: p.payout - p.mise, auto: true };
  }

  // ------------------------------------------------------------ les mises

  /**
   * Poser une mise. Seulement pendant l'attente : une mise acceptee apres le
   * depart serait une mise prise en connaissance de la courbe.
   */
  parier(addr, mise, auto, now) {
    if (this.phase !== ATTENTE) throw new Error('bets are closed');
    if (this.paris.has(addr)) throw new Error('already in this round');
    const a = auto == null || auto === '' ? 0 : Number(auto);
    if (a && !(a >= 1.01)) throw new Error('auto cash out must be at least 1.01x');
    if (a && a > this.plafond) throw new Error('auto cash out above the ' + this.plafond + 'x cap');
    this.paris.set(addr, { mise, auto: a ? Math.floor(a * 100) / 100 : 0,
                           multi: null, payout: 0, retireA: 0 });
    return { manche: this.manche, mise, auto: a };
  }

  /**
   * Encaisser a la main. Le multiplicateur est celui de l'horloge du SERVEUR :
   * ce que le client affiche ne rentre jamais dans le calcul.
   */
  retirer(addr, now) {
    if (this.phase !== VOL) throw new Error('no round in flight');
    const p = this.paris.get(addr);
    if (!p) throw new Error('no bet in this round');
    if (p.multi != null) throw new Error('already cashed out');
    const multi = multiA(now - this.depart, this.vitesse);
    // Le crash a pu tomber entre deux ticks : on refuse tout ce qui est au-dela.
    if (multi > this.point) throw new Error('too late');
    const ev = this._encaisse(addr, p, multi, now);
    ev.auto = false;
    return ev;
  }

  /** Le pari d'un joueur, ou null. */
  pari(addr) {
    const p = this.paris.get(addr);
    return p ? { mise: p.mise, auto: p.auto, multi: p.multi, payout: p.payout } : null;
  }

  /** La table telle qu'on l'affiche : mises et encaissements de tout le monde. */
  liste() {
    const out = [];
    for (const [addr, p] of this.paris)
      out.push({ addr, mise: p.mise, auto: p.auto, multi: p.multi, payout: p.payout });
    return out;
  }

  /** L'etat complet, pour un joueur qui arrive en cours de manche. */
  etat(now) {
    return {
      phase: this.phase, manche: this.manche,
      // pendant le vol le point de crash reste secret : il fuiterait la manche
      multi: this.phase === VOL ? multiA(now - this.depart, this.vitesse) : 1,
      depart: this.phase === VOL ? this.depart : 0,
      jusqua: this.phase === VOL ? 0 : this.jusqua,
      // le temps qu'il RESTE, pour un client dont l'horloge n'est pas la notre
      reste: this.phase === VOL ? 0 : Math.max(0, this.jusqua - now),
      vitesse: this.vitesse, plafond: this.plafond,
      point: this.phase === APRES ? this.point : null,
      maillon: this.phase === APRES ? this.maillon : null,
      engagement: this.engagement, precedent: this.precedent, sel: this.sel,
      histoire: this.histoire.slice(-20), joueurs: this.liste(),
    };
  }
}

module.exports = {
  ESPACE, ATTENTE, VOL, APRES,
  chaine, verifie, pointDeCrash, multiA, msPour, retour, Table,
};
