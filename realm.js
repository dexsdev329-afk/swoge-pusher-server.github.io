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
/* Le rayon du personnage pour les BLOCS, et pour eux seuls. Il n'a rien a
   voir avec les projectiles — un tir touche un joueur selon la portee du
   monstre, pas selon son encombrement. Vingt-deux, soit la moitie du plus
   petit obstacle : assez pour ne pas entrer dans la pierre, assez peu pour
   passer entre deux rochers qui ne se touchent pas. */
const RAYON_JOUEUR = 22;
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
    /* ---- QUI CHOISIT LA PIECE QUI TOMBE ----
     * `monde.js` dit la RARETE — c'est une regle du monde. Quelle piece porte
     * cette rarete appartient au catalogue, et ni le monde ni la simulation
     * n'ont a le connaitre. Celui qui tient les deux (server.js) fournit donc
     * le tirage.
     * Absent, aucun equipement ne tombe : mieux vaut un monde sans butin
     * d'equipement qu'un sac contenant un objet que personne ne peut nommer. */
    this.tireObjet = typeof opts.tireObjet === 'function' ? opts.tireObjet : null;
    /* ---- LES BLOCS, POSES UNE FOIS ----
     * Ils ne bougent jamais : les tirer a chaque pas serait du travail rendu
     * a l'identique cent fois par seconde. Ils partent au client a l'entree,
     * tels quels — la page ne peut pas les redeviner, et un desaccord se
     * verrait tout de suite : on marcherait dans un rocher, ou l'on serait
     * arrete par du vide. */
    this.obstacles = monde.obstacles(this.alea);
    this.monstres = [];
    this.joueurs = new Map();     // addr -> etat
    this.tirs = [];
    /* Les projectiles des MONSTRES, a part des notres. Une seule liste
       melangee obligerait a demander « a qui es-tu ? » a chaque collision,
       et un tir de joueur ne touche pas un joueur. */
    this.tirsM = [];
    /* ---- LES TOMBES ----
     * Elles survivent a celui qui les laisse : le joueur sort du monde a sa
     * mort, la pierre reste. C'est donc une liste a part, et pas un champ du
     * joueur — un champ disparaitrait avec lui, ce qui est exactement le
     * contraire de ce qu'on veut. */
    this.tombes = [];
    /* Les sacs de butin, poses au sol. Comme les tombes : le serveur les
       tient, ils vieillissent, et ils disparaissent. */
    this.sacs = [];
    this._id = 1;
    this.peuple();
  }

  _nouvelId() { return this._id++; }

  peuple() {
    /* ---- NI ICI NON PLUS ----
     * `repeuple` avait le garde, pas la population de depart : quatorze
     * creatures sur cent soixante naissaient dans la pierre a chaque
     * demarrage. Elles n'en seraient jamais sorties, et se seraient lues
     * comme des monstres casses plutot que comme des monstres coinces.
     * Deux endroits font naitre un monstre — les deux doivent regarder.
     * Celles qu'on refuse ici, `repeuple` les remplace ailleurs. */
    const voulu = Object.keys(monde.PEUPLEMENT)
      .reduce((s, b) => s + monde.PEUPLEMENT[b].nombre, 0);
    const places = [];
    /* On RETIRE tant qu'il manque du monde, au lieu de se contenter de jeter
       ce qui tombe mal. « La carte porte N creatures » doit etre vrai des la
       premiere seconde, pas seulement apres le premier repeuplement — un
       joueur qui entre juste apres le demarrage ne doit pas trouver un monde
       aux trois quarts vide. */
    for (let tour = 0; tour < 6 && places.length < voulu; tour++) {
      for (const m of monde.peuplement(this.alea)) {
        if (places.length >= voulu) break;
        if (monde.bloque(this.obstacles, m.x, m.y, monde.MONSTRES[m.espece].rayon)) continue;
        places.push(m);
      }
    }
    this.monstres = places.map((m) => {
      const t = monde.MONSTRES[m.espece];
      return {
        id: this._nouvelId(), espece: m.espece, biome: m.biome,
        x: m.x, y: m.y, ancreX: m.x, ancreY: m.y,
        pv: t.pv, pvMax: t.pv, dir: 'down',
        /* DEUX recharges : le contact et le tir. Une seule ferait qu'un
           monstre qui vient de decocher ne peut plus frapper de pres, ce qui
           reviendrait a lui retirer une des deux attaques au hasard. */
        cible: null, recharge: 0, rechargeT: 0, stase: 0,
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
      /* ---- LA DEXTERITE ET LA VITESSE SERVENT ENFIN ----
       * Elles montaient avec les niveaux, se payaient en equipement, et ne
       * changeaient rien. On les garde ici sous leur forme UTILE : combien de
       * fois par seconde on tire, et a quelle vitesse on court. */
      dex: stats.dex | 0, spd: stats.spd | 0,
      cadence: monde.cadenceDe(stats.dex | 0),
      vitesse: monde.vitesseDe(stats.spd | 0),
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
      /* ---- LA PARALYSIE ----
         Ils vivent ICI et nulle part ailleurs : c'est le serveur qui refuse
         le deplacement, pas la page qui accepte de ne pas bouger. */
      /* Les trois etats et leurs trois immunites, SEPAREES : sortir d'une
         paralysie ne doit pas proteger d'une brulure, sinon un seul monstre
         suffirait a rendre tous les autres inoffensifs et le joueur
         apprendrait a se faire toucher expres. */
      paralyse: 0, ralenti: 0, brulure: 0,
      immun: { paralyse: 0, ralenti: 0, brulure: 0 },
      /* Le reste de degat de brulure a verser : elle brule par SECONDE, et un
         pas de cent millisecondes vaut 0,8 point. Sans accumulation, chaque
         pas arrondirait a zero et la brulure ne ferait jamais rien. */
      brulReste: 0,
      recharge: 0, xpGagnee: 0, vu: 0,
    };
    this.joueurs.set(addr, j);
    return j;
  }

  quitte(addr) { this.joueurs.delete(addr); return true; }

  /** On arrive TOUJOURS par le bord, sur la terre : entrer directement au
      milieu de la lave tuerait un debutant avant son premier pas. */
  _pointDArrivee() {
    /* ---- ET JAMAIS DANS UN ROCHER ----
     * Apparaitre coince dans un bloc donne un personnage qui ne peut plus
     * bouger que dans une direction, sans que rien ne dise pourquoi. On
     * retire jusqu'a trouver un point libre ; au bout de vingt essais on rend
     * ce qu'on a plutot que de boucler — la terre est vaste et un echec vingt
     * fois de suite n'arrive pas, mais une boucle sans sortie, si. */
    let p = null;
    for (let i = 0; i < 20; i++) {
      p = monde.pointDansBiome('terre', this.alea);
      if (!p) continue;
      if (!monde.bloque(this.obstacles, p.x, p.y, RAYON_JOUEUR * 2)) return p;
    }
    return p || { x: 40, y: 40 };
  }

  /**
   * La position annoncee par le client, bornee par ce que la vitesse permet.
   * Rend `true` si elle a ete acceptee telle quelle, `false` si on l'a
   * ramenee — l'appelant peut alors renvoyer la position corrigee.
   */
  /**
   * Le point le plus proche qu'on puisse VRAIMENT occuper, en partant d'ou
   * l'on etait.
   *
   * Refuser le pas en bloc collerait au moindre frolement d'un rocher : on
   * longe un obstacle en marchant en diagonale, et la composante qui passe
   * doit passer. On essaie donc les deux axes separement — c'est ce qui fait
   * qu'on GLISSE le long d'un mur au lieu de s'y coller.
   */
  _glisse(depX, depY, x, y, rayon) {
    /* ---- ETRE DEDANS N'EST PAS UNE PRISON ----
     * Si le point de DEPART est deja bloque, on laisse passer. Rien ne devrait
     * s'y trouver — ni joueur ni monstre n'y naissent, et aucun des deux ne
     * peut y entrer — mais le jour ou ca arrive, refuser le pas donnerait une
     * creature figee pour toujours, ou pire un joueur qui ne peut plus rien
     * faire. Une regle qui se repare toute seule vaut mieux qu'une regle qui
     * tient un piege ferme. */
    if (monde.bloque(this.obstacles, depX, depY, rayon)) return { x, y };
    if (!monde.bloque(this.obstacles, x, y, rayon)) return { x, y };
    if (!monde.bloque(this.obstacles, x, depY, rayon)) return { x, y: depY };
    if (!monde.bloque(this.obstacles, depX, y, rayon)) return { x: depX, y };
    return { x: depX, y: depY };
  }

  bouge(addr, x, y, dir, anim, dt) {
    const j = this.joueurs.get(addr);
    if (!j) return false;
    /* ---- PARALYSE : ON NE BOUGE PAS ----
     * Le refus est ICI, dans le serveur, et pas seulement dans la page qui
     * ignore les touches. La position est ANNONCEE par le client : une
     * paralysie qui ne serait que dessinee se contournerait en ouvrant la
     * console. On accepte encore la direction du regard — se retourner n'est
     * pas se deplacer, et un personnage fige qui tire dans le dos de ce qu'il
     * vise serait absurde. */
    if (j.paralyse > 0) {
      if (dir) j.dir = String(dir).slice(0, 6);
      j.anim = 'idle';
      return false;
    }
    x = Math.max(0, Math.min(monde.MONDE.w, Number(x) || 0));
    y = Math.max(0, Math.min(monde.MONDE.h, Number(y) || 0));
    /* ---- LE RALENTISSEMENT EST APPLIQUE ICI ----
     * C'est la borne de vitesse du serveur qui le rend REEL : une page qui
     * accepterait de bouger moins vite se corrigerait en ouvrant la console.
     * Le facteur multiplie ce que la vitesse autorise, donc un joueur ralenti
     * qui annonce sa vitesse normale se fait ramener en arriere, exactement
     * comme un tricheur. */
    const frein = j.ralenti > 0 ? monde.EFFETS.ralenti.facteur : 1;
    /* SA vitesse, pas une constante : depuis que la statistique compte, deux
       personnages n'ont plus le meme plafond. Le repli sur la constante sert
       au cas — impossible en pratique — d'un joueur entre sans fiche. */
    const vmax = j.vitesse || monde.VITESSE_JOUEUR;
    const max = vmax * frein
              * Math.max(0.05, Number(dt) || 0.15) * MARGE_VITESSE;
    const dx = x - j.x, dy = y - j.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    let honnete = true;
    const deX = j.x, deY = j.y;
    if (d > max && d > 0) {
      // trop loin : on avance jusqu'au bord de ce qui etait possible
      j.x += (dx / d) * max; j.y += (dy / d) * max;
      honnete = false;
    } else {
      j.x = x; j.y = y;
    }
    /* ---- ET LES BLOCS ----
     * Le refus est ICI, comme la paralysie et la vitesse : une page qui
     * accepterait de s'arreter devant un rocher se corrigerait en ouvrant la
     * console. Le joueur a le rayon d'une creature moyenne — lui donner zero
     * l'aurait laisse entrer dans la pierre jusqu'aux epaules. */
    const p = this._glisse(deX, deY, j.x, j.y, RAYON_JOUEUR);
    j.x = p.x; j.y = p.y;
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
    /* ---- LA DEXTERITE MULTIPLIE LA CADENCE ----
     * L'arme donne le rythme de base, la dexterite l'accelere, la rafale
     * l'accelere encore. Les trois se multiplient parce qu'ils repondent a
     * trois questions differentes : quelle arme, quel personnage, quel
     * moment. */
    const dext = j.cadence || 1;
    j.recharge = 1 / (a.cadence * dext * facteur);
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
      if (cible.pv <= 0) this._abat(cible, j, ev);
    }
    return sortie;
  }

  /**
   * Abattre une creature. UN SEUL endroit donne l'experience, annonce la mort
   * ET tire le butin.
   *
   * Il y avait deux chemins vers la mort d'un monstre — le projectile et le
   * pouvoir — et chacun recopiait le gain d'experience. Y ajouter le butin
   * aurait fait deux tirages a maintenir : le jour ou l'un change, l'autre
   * paie encore l'ancien taux, et personne ne s'en apercoit puisque les deux
   * marchent. C'est la meme lecon que `_meurt` pour les joueurs.
   */
  _abat(m, j, ev) {
    const t = monde.MONSTRES[m.espece];
    if (j) {
      j.xpGagnee += t.xp;
      ev.kills.push({ addr: j.addr, espece: m.espece, xp: t.xp, x: m.x, y: m.y });
    }
    /* Le butin tombe meme si le tueur a disparu entre-temps : le sac
       appartient au sol, pas a celui qui a porte le coup. */
    const b = monde.butinDe(m.espece, this.alea, m.biome);
    if (!b || !b.contenu || !b.contenu.length) return;
    /* Une rarete devient une PIECE ici, ou l'entree disparait. Un sac qui
       resterait avec une place vide se ramasserait sans rien donner — et le
       joueur croirait avoir rate son geste. */
    const contenu = [];
    for (const o of b.contenu.slice(0, monde.SAC.cases)) {
      if (!o.objet) { contenu.push(o); continue; }
      const piece = this.tireObjet ? this.tireObjet(o.objet, this.alea) : null;
      if (piece) contenu.push(piece);
    }
    if (!contenu.length) return;
    const sac = { id: this._nouvelId(), x: m.x, y: m.y, sac: b.sac,
                  reste: monde.SAC.duree, contenu };
    this.sacs.push(sac);
    while (this.sacs.length > monde.SAC.plafond) this.sacs.shift();
    ev.butins = ev.butins || [];
    ev.butins.push({ addr: j ? j.addr : null, sac: sac.sac,
                     contenu: sac.contenu.slice(), x: sac.x, y: sac.y });
  }

  /** Le sac SOUS LES PIEDS d'un joueur, ou null. Le plus proche s'il y en a
      plusieurs : deux sacs cote a cote et c'est celui de derriere qu'on
      ouvrirait. */
  sacSousLesPieds(addr) {
    const j = this.joueurs.get(addr);
    if (!j) return null;
    let choisi = null, d2mini = monde.SAC.rayon * monde.SAC.rayon;
    for (const s of this.sacs) {
      const dx = s.x - j.x, dy = s.y - j.y, d2 = dx * dx + dy * dy;
      if (d2 <= d2mini) { d2mini = d2; choisi = s; }
    }
    return choisi;
  }

  /**
   * Prendre UNE place d'un sac ouvert.
   *
   * Le sac est un contenant, pas un objet qu'on absorbe : on prend ce qu'on
   * veut et on laisse le reste. Le client nomme la place (`place`) et le sac
   * (`id`) — mais c'est le serveur qui verifie qu'on est bien dessus. Sans
   * cette verification, nommer un identifiant suffirait a vider un sac a
   * l'autre bout de la carte, et les sacs sont exactement ce qu'on aurait
   * interet a voler.
   *
   * On rend l'objet pris ; c'est l'appelant (server.js) qui sait le convertir
   * en potion ou en point de stat — realm.js ne connait pas les comptes.
   */
  ramasse(addr, ev, accepte, id, place) {
    const s = this.sacSousLesPieds(addr);
    if (!s) return null;
    /* Si le client a nomme un sac, ce doit etre CELUI-LA. Un sac qui a expire
       pendant que le doigt descendait ne doit pas faire prendre son voisin. */
    if (id !== undefined && id !== null && Number(id) !== s.id) return null;
    const k = Math.max(0, Math.floor(Number(place) || 0));
    const objet = s.contenu[k];
    if (!objet) return null;
    /* ---- ON DEMANDE AVANT DE PRENDRE ----
     * Une potion d'attaque prise a son plafond serait bue pour rien, et la
     * place serait vidée. On laisse donc l'appelant refuser : l'objet reste
     * dans le sac, qui finira sa minute. `realm.js` ne sait pas ce qu'est un
     * plafond de potion — il se contente de poser la question. */
    if (typeof accepte === 'function') {
      const verdict = accepte(objet, s);
      if (verdict !== true) {
        return { refuse: true, raison: verdict || 'refuse', sac: s.sac,
                 id: s.id, place: k, ...objet };
      }
    }
    s.contenu.splice(k, 1);
    /* Un sac vide disparait tout de suite : le laisser jusqu'a la fin de sa
       minute donnerait un sac qu'on rouvre pour rien, encore et encore. */
    if (!s.contenu.length) {
      const i = this.sacs.indexOf(s);
      if (i >= 0) this.sacs.splice(i, 1);
    }
    if (ev) { ev.ramasses = ev.ramasses || []; ev.ramasses.push({ addr, sac: s.sac, id: s.id, ...objet }); }
    return { sac: s.sac, id: s.id, place: k, vide: !s.contenu.length, ...objet };
  }

  /**
   * Deposer un objet au sol.
   *
   * Il rejoint le sac sur lequel on se tient s'il y reste une place ; sinon un
   * sac BRUN nait sous nos pieds avec sa minute entiere. C'est ce qui rend
   * l'echange possible — poser son epee commune, prendre celle qu'on vient de
   * trouver — et c'est aussi comment on donne quelque chose a quelqu'un : le
   * sac est visible de tous, et le premier arrive le prend.
   *
   * Le brun n'est pas un choix esthetique : un objet depose ne doit pas
   * ressembler a un butin rare, sinon on traverserait la carte pour une epee
   * commune que quelqu'un a jetee.
   */
  depose(addr, objet, ev) {
    const j = this.joueurs.get(addr);
    if (!j) return null;
    const item = Number(objet && objet.item !== undefined ? objet.item : objet);
    if (!Number.isFinite(item)) return null;
    let s = this.sacSousLesPieds(addr);
    if (s && s.contenu.length >= monde.SAC.cases) return { refuse: true, raison: 'sac-plein' };
    if (!s) {
      s = { id: this._nouvelId(), x: j.x, y: j.y, sac: 'brun',
            reste: monde.SAC.duree, contenu: [] };
      this.sacs.push(s);
      while (this.sacs.length > monde.SAC.plafond) this.sacs.shift();
    }
    /* Le NOM et la CLE d'image entrent avec la piece, une fois. Les retrouver
       au moment d'envoyer l'etat les recalculerait pour chaque client, dix
       fois par seconde — et obligerait realm.js a connaitre la boutique, ce
       qu'il n'a aucune raison de faire. */
    s.contenu.push({ item, cle: (objet && objet.cle) || null,
                     nom: (objet && objet.nom) || null,
                     rarete: (objet && objet.rarete) || null });
    if (ev) { ev.deposes = ev.deposes || []; ev.deposes.push({ addr, id: s.id, item }); }
    return { id: s.id, sac: s.sac, place: s.contenu.length - 1 };
  }

  /**
   * Mourir. Un SEUL endroit pose l'evenement ET la pierre : les faire a deux
   * endroits differents finirait par donner une mort sans tombe, et le trou
   * serait invisible — personne ne remarque une pierre qui n'apparait pas.
   *
   * La tombe garde le nom et le visage : c'est ce qui la rend lisible pour
   * les autres. « Quelqu'un est mort ici » ne vaut rien ; « Dodexel est mort
   * ici, il y a vingt secondes » fait reculer.
   */
  _meurt(j, par, ev) {
    ev.morts.push({ addr: j.addr, par });
    this.tombes.push({
      id: this._nouvelId(), x: j.x, y: j.y,
      nom: j.nom || null, skin: j.skin || null, par,
      reste: monde.TOMBE.duree,
    });
    /* La plus vieille s'efface quand le plafond est atteint : une liste sans
       borne finirait par voyager en entier vers chaque client. */
    while (this.tombes.length > monde.TOMBE.plafond) this.tombes.shift();
  }

  /* ---- LE PAS ---- */

  /**
   * Avance le monde de `dt` secondes. Rend les EVENEMENTS, plutot que de les
   * appliquer : c'est server.js qui sait crediter de l'XP et faire mourir un
   * personnage, et lui seul doit toucher aux soldes.
   */
  pas(dt) {
    dt = Math.max(0, Math.min(0.5, Number(dt) || 0));
    const ev = { degats: [], morts: [], kills: [], touches: [], regen: [], butins: [], ramasses: [] };
    if (!dt) return ev;

    for (const j of this.joueurs.values()) {
      if (j.recharge > 0) j.recharge -= dt;
      if (j.pouvoirRecharge > 0) j.pouvoirRecharge = Math.max(0, j.pouvoirRecharge - dt);
      if (j.rafale > 0) j.rafale = Math.max(0, j.rafale - dt);
      this._pasEtats(j, dt, ev);
      this._regenere(j, dt, ev);
    }
    /* ---- LES PIERRES VIEILLISSENT AVANT LES MORTS DE CE PAS ----
     * Dans l'autre ordre, une tombe posee a l'instant se voyait retirer le
     * temps du pas ou elle venait de naitre : elle partait avec 59,95 s au
     * lieu de 60. Trois centiemes n'ont aucune importance en jeu — mais
     * « elle part avec sa minute entiere » est une phrase qu'on peut
     * verifier, et un test la verifie. Une regle vraie vaut mieux qu'une
     * regle presque vraie qu'on aura oubliee dans six mois. */
    for (let i = this.tombes.length - 1; i >= 0; i--) {
      this.tombes[i].reste -= dt;
      if (this.tombes[i].reste <= 0) this.tombes.splice(i, 1);
    }
    /* Les sacs aussi, et pour la meme raison : un sac ne du pas courant doit
       partir avec sa minute entiere, pas avec 59,95 s. */
    for (let i = this.sacs.length - 1; i >= 0; i--) {
      this.sacs[i].reste -= dt;
      if (this.sacs[i].reste <= 0) this.sacs.splice(i, 1);
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

  /**
   * Les trois etats du joueur, a chaque pas. Une seule fonction pour les
   * trois : ils obeissent a la meme regle et la dupliquer trois fois est le
   * plus sur moyen d'en corriger un et d'oublier les deux autres.
   *
   * L'IMMUNITE se pose au moment ou l'etat TOMBE, jamais quand il commence :
   * sinon elle courrait pendant l'etat lui-meme et ne protegerait presque de
   * rien.
   */
  _pasEtats(j, dt, ev) {
    for (const cle of Object.keys(monde.EFFETS)) {
      if (j[cle] > 0) {
        j[cle] = Math.max(0, j[cle] - dt);
        if (j[cle] === 0) j.immun[cle] = monde.EFFETS[cle].immunite;
      } else if (j.immun[cle] > 0) {
        j.immun[cle] = Math.max(0, j.immun[cle] - dt);
      }
    }

    /* ---- LA BRULURE RONGE ----
     * Elle IGNORE la defense : c'est la seule chose du jeu qu'une armure ne
     * bloque pas, donc la seule raison de reculer quand on est bien protege.
     * On accumule en flottant et on ne verse que les points ENTIERS — a huit
     * points par seconde, un pas de cent millisecondes vaut 0,8, et arrondir
     * chaque pas donnerait zero pour toujours. */
    if (j.brulure > 0 && j.pv > 0) {
      j.brulReste += monde.EFFETS.brulure.parSeconde * dt;
      const perte = Math.floor(j.brulReste);
      if (perte > 0) {
        j.brulReste -= perte;
        j.pv = Math.max(0, j.pv - perte);
        j.repos = 0;                       // bruler n'est pas se reposer
        ev.degats.push({ addr: j.addr, perte, pv: j.pv, par: 'brulure', quoi: 'brulure' });
        if (j.pv <= 0) this._meurt(j, 'brulure', ev);
      }
    } else {
      j.brulReste = 0;
    }
  }

  /**
   * Appliquer un etat. Rend `true` s'il a PRIS. Le refus n'est pas un echec :
   * c'est l'immunite qui fait son travail, et c'est elle qui empeche trois
   * monstres du meme genre de transformer une rencontre en execution.
   */
  _poseEtat(j, cle, ev) {
    const E = monde.EFFETS[cle];
    if (!E || j.pv <= 0) return false;
    if (j.immun[cle] > 0 || j[cle] > 0) return false;
    j[cle] = E.duree;
    return true;
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
      if (m.stase === undefined) m.stase = 0;
      /* D'ou il part. Les quatre facons dont un monstre se deplace — vers le
         joueur, en reculant, en flanant, vers son ancre — se corrigent au
         MEME endroit, tout en bas. Poser le test dans chacune aurait donne
         quatre occasions d'en oublier une, et l'oubli serait invisible :
         trois monstres sur quatre s'arreteraient devant les rochers. */
      const deX = m.x, deY = m.y;

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

        /* ---- IL DECOCHE, QU'IL SOIT DE CONTACT OU NON ----
         * Le tir a sa PROPRE recharge : un monstre qui vient de decocher doit
         * pouvoir frapper de pres dans la seconde, sinon lui donner une
         * attaque a distance revenait a lui retirer l'autre au hasard.
         * Il tire meme colle au joueur : reculer d'un pas ne doit pas suffire
         * a annuler une attaque qu'on voit venir. */
        /* `|| 0` et non `m.rechargeT` nu : un monstre construit sans ce champ
           donnait `undefined <= 0` — c'est-a-dire FAUX — et ne tirait jamais,
           en silence. Un champ manquant doit valoir « pret », pas « muet a
           vie ». Le test l'a attrape sur un monstre pose a la main. */
        if (m.rechargeT > 0) m.rechargeT -= dt;
        if (t.tir && (m.rechargeT || 0) <= 0 && d <= t.tir.portee) {
          const cad = t.tir.cadence || t.cadence;
          m.rechargeT = 1 / cad;
          const n = t.tir.tirs || 1;
          const ecart = t.tir.ecart || 0;
          const ang = Math.atan2(dy, dx);
          for (let k = 0; k < n; k++) {
            /* L'eventail est CENTRE sur la cible : avec un nombre impair, le
               projectile du milieu vise juste, et c'est celui-la qu'on doit
               esquiver en se decalant. */
            const a = ang + (n === 1 ? 0 : (k - (n - 1) / 2) * ecart);
            this.tirsM.push({
              id: this._nouvelId(), espece: m.espece,
              x: m.x, y: m.y, a,
              v: t.tir.vitesse, reste: t.tir.portee / t.tir.vitesse,
              /* Le tir frappe MOINS FORT que le contact : sans ca, ajouter une
                 attaque a distance a six creatures aurait double la difficulte
                 du monde d'un coup. */
              att: t.tir.att === undefined ? t.att : t.tir.att,
              sprite: t.tir.sprite,
              /* L'effet voyage AVEC le projectile : une fleche deja en vol
                 quand le monstre meurt garde son pouvoir. Tuer le lanceur
                 n'annule pas un coup deja porte. */
              effet: t.tir.effet || null,
              drainMp: t.tir.drainMp || 0,
            });
          }
        }

        if (t.contact === false) {
          /* ---- CELUI QUI GARDE SES DISTANCES ----
           * Il s'approche jusqu'a sa portee puis s'arrete. Il ne colle PAS au
           * joueur : un archer au corps a corps ne serait qu'un squelette mal
           * dessine, et toute la difference qu'il apporte tient dans l'ecart
           * qu'il garde. */
          const bonne = t.tir.portee * 0.8;
          if (d > bonne) {
            m.x += (dx / d) * t.vitesse * dt;
            m.y += (dy / d) * t.vitesse * dt;
          } else if (d < t.tir.portee * 0.45) {
            // trop pres : il recule, sans jamais tourner le dos
            m.x -= (dx / d) * t.vitesse * 0.7 * dt;
            m.y -= (dy / d) * t.vitesse * 0.7 * dt;
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
            /* `quoi` dit d'ou vient le coup. Depuis que la meme creature
               frappe ET tire, « par: skeleton » ne suffit plus a distinguer
               une morsure d'un os lance — ni pour la page, qui ne joue pas le
               meme son, ni pour un test qui compte les coups au contact. */
            ev.degats.push({ addr: cible.addr, perte, pv: cible.pv,
                             par: m.espece, quoi: 'contact' });
            if (cible.pv <= 0) this._meurt(cible, m.espece, ev);
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
      /* ---- ILS NE TRAVERSENT PAS NON PLUS ----
       * Un monstre qui passe a travers un rocher ferait du couvert un
       * mensonge : on se croirait a l'abri et l'on serait mordu au travers.
       * Il glisse comme le joueur, avec SON rayon — un colosse de 78 ne
       * passe pas ou passe une nuee de 16, et les couloirs ne sont donc pas
       * les memes pour tout le monde. */
      const pos = this._glisse(deX, deY, m.x, m.y, t.rayon);
      m.x = pos.x; m.y = pos.y;
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

      /* ---- UN ROCHER ARRETE AUSSI LES FLECHES ----
       * Un mur qu'on traverse a l'arc n'est pas un mur, c'est une decoration.
       * Le couvert n'aurait alors aucun sens : on se croirait a l'abri et
       * l'on serait canarde au travers. Le projectile est un point — lui
       * donner une epaisseur le ferait s'arreter a cote de la pierre. */
      let fini = t.reste <= 0 || !!monde.bloque(this.obstacles, t.x, t.y, 0);
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
          if (m.pv <= 0) this._abat(m, j, ev);
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
      /* Les leurs s'arretent aussi, et c'est TOUT l'interet : sans cette
         ligne le couvert protegerait le monstre et pas nous. */
      let fini = t.reste <= 0 || !!monde.bloque(this.obstacles, t.x, t.y, 0);
      if (!fini) {
        for (const j of this.joueurs.values()) {
          if (j.pv <= 0) continue;
          const dx = j.x - t.x, dy = j.y - t.y;
          if (dx * dx + dy * dy > 34 * 34) continue;
          const perte = monde.degatsSubis(t.att, j.def);
          j.pv = Math.max(0, j.pv - perte);
          /* ---- LE TIR QUI POSE UN ETAT ----
           * Il fait ses degats comme les autres, et EN PLUS il cloue, ralentit
           * ou brule — sauf si le joueur sort a peine du meme etat. Dans ce
           * cas il ne reste que les degats : c'est ce qui empeche trois
           * creatures du meme genre de transformer une rencontre en
           * execution. Un mort ne recoit aucun etat : le compteur survivrait
           * a la reapparition. */
          const pose = t.effet ? this._poseEtat(j, t.effet, ev) : false;
          /* ---- LE DRAIN DE MANA ----
           * Instantane, pas un etat : il n'y a rien a decompter et rien dont
           * on puisse etre immunise. C'est la seule attaque qui ne prend ni la
           * vie ni le controle mais la RESERVE — et depuis que le mana paie le
           * pouvoir du fruit, se faire vider veut dire perdre son eclair au
           * moment ou l'on en aurait eu besoin. */
          let vole = 0;
          if (t.drainMp > 0 && j.mp > 0) {
            vole = Math.min(j.mp, t.drainMp);
            j.mp -= vole;
          }
          ev.degats.push({ addr: j.addr, perte, pv: j.pv, par: t.espece,
                           quoi: 'tir', mp: vole || 0,
                           effet: pose ? t.effet : null,
                           duree: pose ? monde.EFFETS[t.effet].duree : 0,
                           /* garde pour la page, qui lisait ce nom */
                           paralyse: (pose && t.effet === 'paralyse')
                             ? monde.EFFETS.paralyse.duree : 0 });
          if (j.pv <= 0) this._meurt(j, t.espece, ev);
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
             /* Sa vitesse de deplacement, telle que le SERVEUR la calcule.
                La page ne la deduit pas de son cote : deux formules a tenir
                d'accord finiraient par se contredire, et le joueur se ferait
                ramener en arriere sans comprendre pourquoi. */
             v: Math.round(j.vitesse),
             /* Le pouvoir et son etat partent a chaque image : le bouton doit
                pouvoir s'eteindre a la seconde ou le mana manque, pas quand
                le joueur appuie pour rien. */
             po: j.pouvoir || null,
             poR: Number((j.pouvoirRecharge || 0).toFixed(2)),
             raf: Number((j.rafale || 0).toFixed(2)),
             /* La paralysie part a chaque image : la page doit pouvoir cesser
                d'obeir aux touches a la seconde ou elle commence, sans
                attendre un message a part. */
             par: Number((j.paralyse || 0).toFixed(2)),
             ral: Number((j.ralenti || 0).toFixed(2)),
             feu: Number((j.brulure || 0).toFixed(2)),
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
      /* Les tombes des AUTRES autant que les siennes : c'est tout leur
         interet. Une pierre qu'on serait seul a voir ne previendrait
         personne. */
      tombes: this.tombes.filter(pres).map((t) => ({
        i: t.id, x: Math.round(t.x), y: Math.round(t.y),
        nom: t.nom, par: t.par, r: Number(t.reste.toFixed(1)) })),
      /* Les sacs de TOUT LE MONDE, comme les tombes. Un butin que seul son
         tueur verrait n'aurait aucune raison d'etre au sol : autant le lui
         donner directement. Ce qui les rend interessants, c'est qu'ils sont
         visibles et qu'ils ne durent pas.
         `r` part avec eux : la page dessine la minute qui s'ecoule, et sans
         ce chiffre elle devrait la deviner — donc se tromper. */
      sacs: this.sacs.filter(pres).map((s) => ({
        i: s.id, x: Math.round(s.x), y: Math.round(s.y), s: s.sac,
        /* Le CONTENU part avec le sac : la page ouvre une grille de huit
           places des qu'on marche dessus, et elle doit pouvoir la remplir
           sans une deuxieme demande — sinon la grille s'ouvre vide et se
           remplit un aller-retour plus tard, sous le doigt. */
        c: s.contenu.map((o) => (o.stat ? { st: o.stat }
                              : o.potion ? { po: o.potion }
                              : { it: o.item, cl: o.cle, nm: o.nom, ra: o.rarete })),
        r: Number(s.reste.toFixed(1)) })),
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
      /* Ni dans un rocher : un colosse de rayon 78 ne du dans un bloc y
         resterait pour toujours, immobile, et se lirait comme un monstre
         casse plutot que comme un monstre coince. */
      if (monde.bloque(this.obstacles, m.x, m.y, t.rayon)) continue;
      this.monstres.push({
        id: this._nouvelId(), espece: m.espece, biome: m.biome,
        x: m.x, y: m.y, ancreX: m.x, ancreY: m.y,
        pv: t.pv, pvMax: t.pv, dir: 'down', cible: null, recharge: 0, rechargeT: 0, stase: 0,
        errX: 0, errY: 0, errChrono: 0,
      });
      nes++;
    }
    return nes;
  }
}

module.exports = { Realm, PAS_MS, MARGE_VITESSE };
