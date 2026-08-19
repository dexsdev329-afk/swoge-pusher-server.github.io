'use strict';
/*
 * LE MONDE VIVANT — les monstres qui existent vraiment, et ce qu'ils font.
 *
 * ---- la ligne de partage ----
 *
 * monde.js dit ce qu'est un squelette. CE fichier tient les squelettes qui
 * marchent en ce moment : leurs points de vie du moment, qui ils poursuivent,
 * quels projectiles sont en vol. C'est de l'ETAT, et il est ici plutot que
 * dans server.js pour la meme raison que game.js n'est pas dans server.js :
 * on veut pouvoir le faire tourner dans un test, sans socket ni port.
 *
 * ---- pourquoi ici et pas dans le navigateur ----
 *
 * Les objets achetes avec du vrai $SWOGE sont detruits a la mort du
 * personnage, et l'XP nourrit la fame. Si le navigateur decidait des degats,
 * ouvrir la console suffirait a ne jamais mourir et a se donner des niveaux.
 * Le client envoie donc DEUX choses seulement : « je suis la » et « je tire
 * dans cette direction ». Tout le reste se tranche ici.
 *
 * La position, elle, reste annoncee par le client — la faire calculer au
 * serveur demanderait de lui envoyer les touches et de tout rejouer, ce qui
 * est un autre metier. On la BORNE donc : une position plus loin que ce que
 * la vitesse du personnage autorise est ramenee au bord de ce qui etait
 * possible. On ne peut pas traverser la carte, seulement mentir un peu.
 *
 * ---- ce qui n'y est pas ----
 *
 * Aucun butin, aucune potion : rien ne tombe encore. Les monstres ne tirent
 * pas non plus — ils blessent au contact. Un squelette qui decoche des
 * fleches demanderait ses propres projectiles cote monstre, et ca vaut mieux
 * une fois que le reste tient debout.
 */

const monde = require('./monde');

/* Le pas de simulation vise 10 fois par seconde. Plus rapide n'ajoute rien —
   les clients recoivent 6 a 7 images par seconde de toute facon — et plus
   lent rendrait les poursuites saccadees. */
const PAS_MS = 100;
/* Marge sur la distance qu'un joueur peut parcourir entre deux annonces. Le
   reseau hoquete ; refuser au millimetre ferait begayer un joueur honnete. */
const MARGE_VITESSE = 1.6;
/* On BORNE TOUJOURS, sans exception. Ma premiere version laissait passer les
   bonds ENORMES en se disant qu'un joueur revenant d'un onglet en veille ne
   devait pas rester colle a sa derniere position — ce qui bornait les petites
   triches et laissait passer les grandes, exactement l'inverse de ce qu'il
   faut. Le cas de l'onglet endormi se traite par le `dt` : c'est l'appelant
   qui mesure le temps ecoule, donc une longue absence donne mecaniquement une
   distance permise plus grande, sans qu'on ait a inventer une exception. */

class Realm {
  constructor(opts) {
    opts = opts || {};
    this.alea = opts.alea || Math.random;
    this.monstres = [];
    this.joueurs = new Map();     // addr -> etat
    this.tirs = [];
    this._id = 1;
    this.peuple();
  }

  _nouvelId() { return this._id++; }

  peuple() {
    this.monstres = monde.peuplement(this.alea).map((m) => {
      const t = monde.MONSTRES[m.espece];
      return {
        id: this._nouvelId(), espece: m.espece, biome: m.biome,
        x: m.x, y: m.y, ancreX: m.x, ancreY: m.y,
        pv: t.pv, pvMax: t.pv, dir: 'down',
        cible: null, recharge: 0,
        // la direction de flanerie, retiree de temps en temps
        errX: 0, errY: 0, errChrono: 0,
      };
    });
  }

  /* ---- LES JOUEURS ---- */

  /** Entrer dans le monde. `fiche` vient de game.personnageEtat. */
  rejoint(addr, fiche) {
    const stats = (fiche && fiche.stats) || {};
    const bord = this._pointDArrivee();
    const j = {
      addr, skin: (fiche && fiche.skin) || null, nom: (fiche && fiche.nom) || null,
      x: bord.x, y: bord.y, dir: 'up', anim: 'idle',
      pv: Math.max(1, stats.hp | 0), pvMax: Math.max(1, stats.hp | 0),
      att: stats.att | 0, def: stats.def | 0,
      famille: (fiche && fiche.famille) || 'poing',
      degats: (fiche && fiche.degats) || monde.DEGATS_POING,
      recharge: 0, xpGagnee: 0, vu: 0,
    };
    this.joueurs.set(addr, j);
    return j;
  }

  quitte(addr) { this.joueurs.delete(addr); return true; }

  /** On arrive TOUJOURS par le bord, sur la terre : entrer directement au
      milieu de la lave tuerait un debutant avant son premier pas. */
  _pointDArrivee() {
    const p = monde.pointDansBiome('terre', this.alea);
    return p || { x: 40, y: 40 };
  }

  /**
   * La position annoncee par le client, bornee par ce que la vitesse permet.
   * Rend `true` si elle a ete acceptee telle quelle, `false` si on l'a
   * ramenee — l'appelant peut alors renvoyer la position corrigee.
   */
  bouge(addr, x, y, dir, anim, dt) {
    const j = this.joueurs.get(addr);
    if (!j) return false;
    x = Math.max(0, Math.min(monde.MONDE.w, Number(x) || 0));
    y = Math.max(0, Math.min(monde.MONDE.h, Number(y) || 0));
    const max = monde.VITESSE_JOUEUR * Math.max(0.05, Number(dt) || 0.15) * MARGE_VITESSE;
    const dx = x - j.x, dy = y - j.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    let honnete = true;
    if (d > max && d > 0) {
      // trop loin : on avance jusqu'au bord de ce qui etait possible
      j.x += (dx / d) * max; j.y += (dy / d) * max;
      honnete = false;
    } else {
      j.x = x; j.y = y;
    }
    if (dir) j.dir = String(dir).slice(0, 6);
    if (anim) j.anim = String(anim).slice(0, 6);
    return honnete;
  }

  /** Tirer. Le serveur applique la cadence de l'arme : un client qui envoie
      cent demandes par seconde n'obtient pas cent projectiles. */
  tire(addr, angle) {
    const j = this.joueurs.get(addr);
    if (!j || j.pv <= 0) return 0;
    if (j.recharge > 0) return 0;
    const a = monde.ARMES[j.famille] || monde.ARMES.poing;
    j.recharge = 1 / a.cadence;
    const ang = Number(angle) || 0;
    const ecart = 0.13;
    const duree = a.portee / a.vitesse;
    let nes = 0;
    for (let i = 0; i < a.tirs; i++) {
      const d = a.tirs === 1 ? 0 : (i - (a.tirs - 1) / 2) * ecart;
      this.tirs.push({
        id: this._nouvelId(), addr, x: j.x, y: j.y, a: ang + d,
        v: a.vitesse, reste: duree, famille: j.famille,
      });
      nes++;
    }
    return nes;
  }

  /* ---- LE PAS ---- */

  /**
   * Avance le monde de `dt` secondes. Rend les EVENEMENTS, plutot que de les
   * appliquer : c'est server.js qui sait crediter de l'XP et faire mourir un
   * personnage, et lui seul doit toucher aux soldes.
   */
  pas(dt) {
    dt = Math.max(0, Math.min(0.5, Number(dt) || 0));
    const ev = { degats: [], morts: [], kills: [], touches: [] };
    if (!dt) return ev;

    for (const j of this.joueurs.values()) {
      if (j.recharge > 0) j.recharge -= dt;
    }
    this._pasMonstres(dt, ev);
    this._pasTirs(dt, ev);
    return ev;
  }

  _joueurLePlusProche(m) {
    const t = monde.MONSTRES[m.espece];
    let mieux = null, d2mini = t.vue * t.vue;
    for (const j of this.joueurs.values()) {
      if (j.pv <= 0) continue;
      const dx = j.x - m.x, dy = j.y - m.y, d2 = dx * dx + dy * dy;
      if (d2 < d2mini) { d2mini = d2; mieux = j; }
    }
    return mieux;
  }

  _pasMonstres(dt, ev) {
    for (const m of this.monstres) {
      if (m.pv <= 0) continue;
      const t = monde.MONSTRES[m.espece];
      if (m.recharge > 0) m.recharge -= dt;

      const cible = this._joueurLePlusProche(m);
      m.cible = cible ? cible.addr : null;

      if (cible) {
        const dx = cible.x - m.x, dy = cible.y - m.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        /* Au CONTACT on s'arrete : sans ca le monstre pousse le joueur devant
           lui, et une poursuite devient un remorquage. */
        const contact = t.rayon + 26;
        if (d > contact) {
          m.x += (dx / d) * t.vitesse * dt;
          m.y += (dy / d) * t.vitesse * dt;
        } else if (m.recharge <= 0) {
          const perte = monde.degatsSubis(t.att, cible.def);
          cible.pv = Math.max(0, cible.pv - perte);
          m.recharge = 1 / t.cadence;
          ev.degats.push({ addr: cible.addr, perte, pv: cible.pv, par: m.espece });
          if (cible.pv <= 0) ev.morts.push({ addr: cible.addr, par: m.espece });
        }
        m.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left')
                                            : (dy > 0 ? 'down' : 'up');
      } else {
        /* Personne en vue : on flane autour de son point de naissance. Sans
           l'ancre, une longue poursuite abandonnee laisserait les monstres
           s'accumuler la ou un joueur a disparu, et le reste de la carte se
           viderait tout seul. */
        m.errChrono -= dt;
        if (m.errChrono <= 0) {
          const ang = this.alea() * Math.PI * 2;
          m.errX = Math.cos(ang); m.errY = Math.sin(ang);
          m.errChrono = 1.2 + this.alea() * 2.2;
        }
        const versAncre = Math.sqrt((m.ancreX - m.x) ** 2 + (m.ancreY - m.y) ** 2);
        if (versAncre > 260) {
          const dx = m.ancreX - m.x, dy = m.ancreY - m.y, d = versAncre || 1;
          m.errX = dx / d; m.errY = dy / d;
        }
        m.x += m.errX * t.vitesse * 0.4 * dt;
        m.y += m.errY * t.vitesse * 0.4 * dt;
        m.dir = Math.abs(m.errX) > Math.abs(m.errY) ? (m.errX > 0 ? 'right' : 'left')
                                                    : (m.errY > 0 ? 'down' : 'up');
      }
      m.x = Math.max(0, Math.min(monde.MONDE.w, m.x));
      m.y = Math.max(0, Math.min(monde.MONDE.h, m.y));
    }
  }

  _pasTirs(dt, ev) {
    for (let i = this.tirs.length - 1; i >= 0; i--) {
      const t = this.tirs[i];
      t.x += Math.cos(t.a) * t.v * dt;
      t.y += Math.sin(t.a) * t.v * dt;
      t.reste -= dt;

      let fini = t.reste <= 0;
      if (!fini) {
        const j = this.joueurs.get(t.addr);
        for (const m of this.monstres) {
          if (m.pv <= 0) continue;
          const r = monde.MONSTRES[m.espece].rayon;
          const dx = m.x - t.x, dy = m.y - t.y;
          if (dx * dx + dy * dy > r * r) continue;
          const arme = monde.tirageArme(j ? j.degats : monde.DEGATS_POING, this.alea);
          const perte = monde.degatsInfliges(j ? j.att : 0, arme, monde.MONSTRES[m.espece].def);
          m.pv = Math.max(0, m.pv - perte);
          ev.touches.push({ monstre: m.id, perte, pv: m.pv, x: t.x, y: t.y });
          if (m.pv <= 0 && j) {
            const xp = monde.MONSTRES[m.espece].xp;
            j.xpGagnee += xp;
            ev.kills.push({ addr: j.addr, espece: m.espece, xp, x: m.x, y: m.y });
          }
          fini = true;
          break;
        }
      }
      if (fini) this.tirs.splice(i, 1);
    }
    /* Les morts disparaissent APRES le tour : les retirer pendant la boucle
       decalerait le tableau sous les pieds de l'iteration. */
    if (ev.kills.length || ev.touches.length) {
      this.monstres = this.monstres.filter((m) => m.pv > 0);
    }
  }

  /* ---- CE QU'ON ENVOIE ---- */

  /** L'etat visible autour d'un joueur. On ne diffuse pas la carte entiere :
      quarante monstres a dix images par seconde pour chaque client, dont
      trente-cinq hors de l'ecran, est du trafic pur. */
  etatPour(addr, portee) {
    const j = this.joueurs.get(addr);
    if (!j) return null;
    const R = Number(portee) || 1400;
    const R2 = R * R;
    const pres = (o) => {
      const dx = o.x - j.x, dy = o.y - j.y;
      return dx * dx + dy * dy <= R2;
    };
    const autres = [];
    for (const k of this.joueurs.values()) {
      if (k.addr === addr || !pres(k)) continue;
      autres.push({ a: k.addr, x: Math.round(k.x), y: Math.round(k.y),
                    dir: k.dir, anim: k.anim, skin: k.skin, nom: k.nom,
                    pv: k.pv, pvMax: k.pvMax });
    }
    return {
      moi: { x: Math.round(j.x), y: Math.round(j.y), pv: j.pv, pvMax: j.pvMax,
             xp: j.xpGagnee },
      monstres: this.monstres.filter(pres).map((m) => ({
        i: m.id, e: m.espece, x: Math.round(m.x), y: Math.round(m.y),
        d: m.dir, pv: m.pv, pvMax: m.pvMax })),
      tirs: this.tirs.filter(pres).map((t) => ({
        i: t.id, x: Math.round(t.x), y: Math.round(t.y),
        a: Number(t.a.toFixed(3)), f: t.famille, mien: t.addr === addr })),
      joueurs: autres,
    };
  }

  /** Un monstre remplace ceux qu'on a tues, pour que la carte ne se vide pas.
      On ne fait naitre que ce qui manque, et LOIN des joueurs : voir un
      squelette apparaitre a trois pas serait une punition sans cause. */
  repeuple(distanceMini) {
    const dmin = Number(distanceMini) || 900;
    const voulu = Object.keys(monde.PEUPLEMENT)
      .reduce((s, b) => s + monde.PEUPLEMENT[b].nombre, 0);
    let nes = 0;
    let essais = 0;
    while (this.monstres.length < voulu && essais < 200) {
      essais++;
      const liste = monde.peuplement(this.alea);
      const m = liste[Math.floor(this.alea() * liste.length)];
      if (!m) break;
      let tropPres = false;
      for (const j of this.joueurs.values()) {
        const dx = j.x - m.x, dy = j.y - m.y;
        if (dx * dx + dy * dy < dmin * dmin) { tropPres = true; break; }
      }
      if (tropPres) continue;
      const t = monde.MONSTRES[m.espece];
      this.monstres.push({
        id: this._nouvelId(), espece: m.espece, biome: m.biome,
        x: m.x, y: m.y, ancreX: m.x, ancreY: m.y,
        pv: t.pv, pvMax: t.pv, dir: 'down', cible: null, recharge: 0,
        errX: 0, errY: 0, errChrono: 0,
      });
      nes++;
    }
    return nes;
  }
}

module.exports = { Realm, PAS_MS, MARGE_VITESSE };
