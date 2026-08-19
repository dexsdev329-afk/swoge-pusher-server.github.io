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
 * Aucun butin, aucune potion : rien ne tombe encore. Le reste y est : les
 * monstres tirent (liste `tirsM`, a part de la notre), la vie et le mana
 * remontent tout seuls a la vitalite et a la sagesse, et le fruit porte donne
 * un pouvoir qui se paie en mana.
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
    /* Les projectiles des MONSTRES, a part des notres. Une seule liste
       melangee obligerait a demander « a qui es-tu ? » a chaque collision,
       et un tir de joueur ne touche pas un joueur. */
    this.tirsM = [];
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
        cible: null, recharge: 0, stase: 0,
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
      /* Le mana n'est pas decoratif : c'est la seule ressource du pouvoir du
         fruit, et elle se remplit toute seule a la sagesse. Un personnage
         sans mana (0 de reserve) ne lance simplement rien. */
      mp: Math.max(0, stats.mp | 0), mpMax: Math.max(0, stats.mp | 0),
      att: stats.att | 0, def: stats.def | 0,
      vit: stats.vit | 0, wis: stats.wis | 0,
      famille: (fiche && fiche.famille) || 'poing',
      degats: (fiche && fiche.degats) || monde.DEGATS_POING,
      /* Le pouvoir vient du FRUIT, pas de l'arme : `statFruit` est la stat
         principale du fruit porte, envoyee par game.js. Sans fruit, pas de
         pouvoir — le poing nu ne lance pas d'eclair. */
      pouvoir: monde.pouvoirDeStat((fiche && fiche.statFruit) || null),
      pouvoirRecharge: 0,
      /* La rafale, quand elle est active : le temps qu'il lui reste. */
      rafale: 0,
      /* Depuis combien de temps ce joueur n'a ni bouge ni tire. C'est ce
         compteur qui decide du doublement de regeneration au repos. */
      repos: 0,
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
    /* Se DEPLACER casse le repos ; rester immobile a annoncer la meme
       position ne le casse pas. On mesure le mouvement reel, pas le fait
       qu'un message soit arrive : le client parle dix fois par seconde meme
       a l'arret. */
    if (d > 1) j.repos = 0;
    return honnete;
  }

  /** Tirer. Le serveur applique la cadence de l'arme : un client qui envoie
      cent demandes par seconde n'obtient pas cent projectiles. */
  tire(addr, angle) {
    const j = this.joueurs.get(addr);
    if (!j || j.pv <= 0) return 0;
    if (j.recharge > 0) return 0;
    const a = monde.ARMES[j.famille] || monde.ARMES.poing;
    /* La rafale ne cree pas de projectiles en plus : elle raccourcit
       l'attente entre deux tirs. Un pouvoir qui doublerait le NOMBRE de tirs
       changerait aussi la portee couverte et la forme de l'eventail — la
       cadence, elle, ne touche qu'a la vitesse de la main. */
    const facteur = j.rafale > 0 ? monde.POUVOIRS.rafale.facteur : 1;
    j.recharge = 1 / (a.cadence * facteur);
    j.repos = 0;
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

  /**
   * Declencher le pouvoir du fruit. Rend `null` quand il ne part pas — pas
   * de fruit, pas assez de mana, encore en recharge, ou mort — et un objet
   * decrivant ce qui s'est passe sinon. Le refus est RENDU plutot que
   * silencieux : le client doit pouvoir dire « pas assez de mana » au lieu
   * de laisser croire a une touche qui ne repond pas.
   *
   * Les degats de la foudre passent par ev.touches et ev.kills, exactement
   * comme un projectile : c'est le meme chemin d'XP, et un pouvoir qui tue
   * doit rapporter ce qu'une fleche aurait rapporte, ni plus ni moins.
   */
  pouvoir(addr, ev) {
    const j = this.joueurs.get(addr);
    if (!j || j.pv <= 0) return null;
    if (!j.pouvoir) return { refus: 'aucun' };
    const P = monde.POUVOIRS[j.pouvoir];
    if (!P) return { refus: 'aucun' };
    if (j.pouvoirRecharge > 0) return { refus: 'recharge', reste: j.pouvoirRecharge };
    if (j.mp < P.cout) return { refus: 'mana', manque: P.cout - j.mp };

    j.mp -= P.cout;
    j.pouvoirRecharge = P.recharge;
    j.repos = 0;
    const sortie = { cle: j.pouvoir, addr, x: j.x, y: j.y, mp: j.mp, recharge: P.recharge };

    if (j.pouvoir === 'rafale') {
      j.rafale = P.duree;
      sortie.duree = P.duree;
      return sortie;
    }

    if (j.pouvoir === 'stase') {
      /* Fige TOUT ce qui est dans le rayon, y compris ce qui ne poursuit
         personne : une stase qui ne toucherait que les monstres deja lances
         serait inutilisable en prevention, c'est-a-dire au seul moment ou
         l'on a le temps de la lancer. */
      const R2 = P.rayon * P.rayon;
      const figes = [];
      for (const m of this.monstres) {
        if (m.pv <= 0) continue;
        const dx = m.x - j.x, dy = m.y - j.y;
        if (dx * dx + dy * dy > R2) continue;
        m.stase = P.duree;
        figes.push(m.id);
      }
      sortie.rayon = P.rayon;
      sortie.duree = P.duree;
      sortie.figes = figes;
      return sortie;
    }

    // foudre : le monstre le plus proche dans la portee, touche sans delai
    let cible = null, d2mini = P.portee * P.portee;
    for (const m of this.monstres) {
      if (m.pv <= 0) continue;
      const dx = m.x - j.x, dy = m.y - j.y, d2 = dx * dx + dy * dy;
      if (d2 < d2mini) { d2mini = d2; cible = m; }
    }
    sortie.portee = P.portee;
    if (!cible) { sortie.vide = true; return sortie; }

    const t = monde.MONSTRES[cible.espece];
    /* Le coup MAXIMUM de l'arme, pas un tirage : un pouvoir qui coute
       soixante mana et douze secondes ne doit pas pouvoir tomber sur son
       minimum. Le hasard a sa place dans les tirs ordinaires, pas ici. */
    const base = (j.degats && j.degats[1]) || monde.DEGATS_POING[1];
    const perte = monde.degatsInfliges(j.att, base * P.facteur, t.def);
    cible.pv = Math.max(0, cible.pv - perte);
    sortie.monstre = cible.id;
    sortie.perte = perte;
    sortie.cx = Math.round(cible.x);
    sortie.cy = Math.round(cible.y);
    if (ev) {
      ev.touches.push({ addr, monstre: cible.id, espece: cible.espece,
                        perte, pv: cible.pv, x: cible.x, y: cible.y, pouvoir: 'foudre' });
      if (cible.pv <= 0) {
        j.xpGagnee += t.xp;
        ev.kills.push({ addr, espece: cible.espece, xp: t.xp, x: cible.x, y: cible.y });
      }
    }
    return sortie;
  }

  /* ---- LE PAS ---- */

  /**
   * Avance le monde de `dt` secondes. Rend les EVENEMENTS, plutot que de les
   * appliquer : c'est server.js qui sait crediter de l'XP et faire mourir un
   * personnage, et lui seul doit toucher aux soldes.
   */
  pas(dt) {
    dt = Math.max(0, Math.min(0.5, Number(dt) || 0));
    const ev = { degats: [], morts: [], kills: [], touches: [], regen: [] };
    if (!dt) return ev;

    for (const j of this.joueurs.values()) {
      if (j.recharge > 0) j.recharge -= dt;
      if (j.pouvoirRecharge > 0) j.pouvoirRecharge = Math.max(0, j.pouvoirRecharge - dt);
      if (j.rafale > 0) j.rafale = Math.max(0, j.rafale - dt);
      this._regenere(j, dt, ev);
    }
    this._pasMonstres(dt, ev);
    this._pasTirs(dt, ev);
    this._pasTirsMonstres(dt, ev);
    return ev;
  }

  /**
   * La vie et le mana qui remontent. Le debit vient de monde.regenParSeconde
   * (le coefficient de RotMG), double quand le joueur ne bouge ni ne tire
   * depuis REPOS_DELAI secondes.
   *
   * On accumule en flottant dans `pvReste`/`mpReste` et on ne verse que les
   * points ENTIERS. Sans ca, un pas de 100 ms a 4.9 PV/s donnerait 0.49 PV,
   * arrondi a 0 dix fois par seconde : la barre ne bougerait jamais, et le
   * bug serait invisible parce que la formule, elle, serait juste.
   *
   * Un mort ne regenere pas : ressusciter tout seul en restant au sol
   * annulerait la seule chose qui rend ce monde serieux.
   */
  _regenere(j, dt, ev) {
    if (j.pv <= 0) return;
    j.repos = (j.repos || 0) + dt;
    const auRepos = j.repos >= monde.REPOS_DELAI;

    let bouge = false;
    if (j.pv < j.pvMax) {
      j.pvReste = (j.pvReste || 0) + monde.regenParSeconde(j.vit, auRepos) * dt;
      const gain = Math.floor(j.pvReste);
      if (gain > 0) {
        j.pvReste -= gain;
        j.pv = Math.min(j.pvMax, j.pv + gain);
        bouge = true;
      }
    } else { j.pvReste = 0; }

    if (j.mp < j.mpMax) {
      j.mpReste = (j.mpReste || 0) + monde.regenParSeconde(j.wis, auRepos) * dt;
      const gain = Math.floor(j.mpReste);
      if (gain > 0) {
        j.mpReste -= gain;
        j.mp = Math.min(j.mpMax, j.mp + gain);
        bouge = true;
      }
    } else { j.mpReste = 0; }

    /* Rien n'est diffuse ici : les barres partent avec `etatPour`, dix fois
       par seconde de toute facon. `bouge` reste lisible pour les tests, qui
       ont besoin de savoir qu'un point a bien ete verse. */
    if (bouge && ev && ev.regen) ev.regen.push({ addr: j.addr, pv: j.pv, mp: j.mp });
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

      /* ---- LA STASE ----
       * Un monstre fige ne bouge pas, ne frappe pas, ne tire pas — et reste
       * une cible. On sort AVANT tout le reste, y compris avant la flanerie :
       * un squelette qui continuerait a deriver doucement pendant sa stase
       * donnerait l'impression que le pouvoir n'a pas pris.
       *
       * Sa recharge, elle, continue de descendre (ligne au-dessus) : sinon le
       * monstre sortirait de stase avec un coup arme et frapperait a l'instant
       * meme ou il se reveille, ce qui rendrait les cinq secondes gagnees
       * strictement nulles. */
      if (m.stase > 0) { m.stase = Math.max(0, m.stase - dt); continue; }

      const cible = this._joueurLePlusProche(m);
      m.cible = cible ? cible.addr : null;

      if (cible) {
        const dx = cible.x - m.x, dy = cible.y - m.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (t.tir) {
          /* ---- CELUI QUI TIRE ----
           * Il s'approche jusqu'a sa portee, puis s'arrete et decoche. Il ne
           * colle PAS au joueur : un archer au corps a corps ne serait qu'un
           * squelette mal dessine, et toute la difference qu'il apporte
           * tient dans la distance qu'il garde. */
          const bonne = t.tir.portee * 0.8;
          if (d > bonne) {
            m.x += (dx / d) * t.vitesse * dt;
            m.y += (dy / d) * t.vitesse * dt;
          } else if (d < t.tir.portee * 0.45) {
            // trop pres : il recule, sans jamais tourner le dos
            m.x -= (dx / d) * t.vitesse * 0.7 * dt;
            m.y -= (dy / d) * t.vitesse * 0.7 * dt;
          }
          if (m.recharge <= 0 && d <= t.tir.portee) {
            m.recharge = 1 / t.cadence;
            this.tirsM.push({
              id: this._nouvelId(), espece: m.espece,
              x: m.x, y: m.y, a: Math.atan2(dy, dx),
              v: t.tir.vitesse, reste: t.tir.portee / t.tir.vitesse,
              att: t.att, sprite: t.tir.sprite,
            });
          }
        } else {
          /* Au CONTACT on s'arrete : sans ca le monstre pousse le joueur
             devant lui, et une poursuite devient un remorquage. */
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
          /* L'adresse du TIREUR part avec le coup : c'est lui qui doit
             l'entendre, pas les trois joueurs d'a cote. */
          ev.touches.push({ addr: t.addr, monstre: m.id, espece: m.espece,
                            perte, pv: m.pv, x: t.x, y: t.y });
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

  /** Les fleches des monstres, contre NOUS. Meme forme que nos projectiles,
      collision inversee : elles cherchent les joueurs, pas les monstres. */
  _pasTirsMonstres(dt, ev) {
    for (let i = this.tirsM.length - 1; i >= 0; i--) {
      const t = this.tirsM[i];
      t.x += Math.cos(t.a) * t.v * dt;
      t.y += Math.sin(t.a) * t.v * dt;
      t.reste -= dt;
      let fini = t.reste <= 0;
      if (!fini) {
        for (const j of this.joueurs.values()) {
          if (j.pv <= 0) continue;
          const dx = j.x - t.x, dy = j.y - t.y;
          if (dx * dx + dy * dy > 34 * 34) continue;
          const perte = monde.degatsSubis(t.att, j.def);
          j.pv = Math.max(0, j.pv - perte);
          ev.degats.push({ addr: j.addr, perte, pv: j.pv, par: t.espece });
          if (j.pv <= 0) ev.morts.push({ addr: j.addr, par: t.espece });
          fini = true;
          break;
        }
      }
      if (fini) this.tirsM.splice(i, 1);
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
             mp: j.mp, mpMax: j.mpMax,
             /* Le pouvoir et son etat partent a chaque image : le bouton doit
                pouvoir s'eteindre a la seconde ou le mana manque, pas quand
                le joueur appuie pour rien. */
             po: j.pouvoir || null,
             poR: Number((j.pouvoirRecharge || 0).toFixed(2)),
             raf: Number((j.rafale || 0).toFixed(2)),
             xp: j.xpGagnee },
      monstres: this.monstres.filter(pres).map((m) => {
        const o = { i: m.id, e: m.espece, x: Math.round(m.x), y: Math.round(m.y),
                    d: m.dir, pv: m.pv, pvMax: m.pvMax };
        /* La stase se VOIT : sans marque a l'ecran, cinq secondes de monstres
           immobiles se lisent comme un serveur qui a lache. */
        if (m.stase > 0) o.st = Number(m.stase.toFixed(2));
        return o;
      }),
      tirs: this.tirs.filter(pres).map((t) => ({
        i: t.id, x: Math.round(t.x), y: Math.round(t.y),
        a: Number(t.a.toFixed(3)), f: t.famille, mien: t.addr === addr })),
      /* Les fleches ennemies dans une liste a part : le client doit pouvoir
         les dessiner autrement, et surtout ne jamais croire qu'elles sont a
         lui. */
      tirsM: this.tirsM.filter(pres).map((t) => ({
        i: t.id, x: Math.round(t.x), y: Math.round(t.y),
        a: Number(t.a.toFixed(3)), f: t.sprite })),
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
        pv: t.pv, pvMax: t.pv, dir: 'down', cible: null, recharge: 0, stase: 0,
        errX: 0, errY: 0, errChrono: 0,
      });
      nes++;
    }
    return nes;
  }
}

module.exports = { Realm, PAS_MS, MARGE_VITESSE };
