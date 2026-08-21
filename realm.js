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
/* Les regles d'un sac au sol vivent a part depuis que le Nexus en a un lui
   aussi : deux exemplaires de « un sac vit soixante secondes » finissent par
   ne plus dire la meme chose, et ces phrases-la gardent des pieces payees en
   argent reel. Voir sacs.js. */
const sacsAuSol = require('./sacs');

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
/* ---- ET LA TAILLE QU'ON PRESENTE A UN TIR ----
 *
 * `RAYON_JOUEUR` est le rayon du CORPS : celui qui l'empeche de passer entre
 * deux rochers. Il vaut vingt-deux, ce qui est juste pour se faufiler et faux
 * pour se faire toucher — le personnage est dessine sur cent cinquante unites
 * de haut et une bonne trentaine de large, et un projectile qui lui passe au
 * travers a deux doigts du torse se lit comme un tir qui ne compte pas.
 *
 * Les creatures presentent trente-quatre a quarante-quatre. Trente-deux met
 * donc le joueur un peu en dessous de la plus petite d'entre elles : plus dur
 * a toucher qu'un monstre, ce qui est le bon sens, mais pas invisible. */
const RAYON_CIBLE = 32;
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
    /* ---- ON PEUT SE TIRER DESSUS, OU NON ----
     *
     * Le monde vert est une zone sure : un tir de joueur n'y touche que des
     * creatures, et c'est ecrit plus bas, la ou les deux listes de projectiles
     * sont separees. Le monde rouge, lui, existe POUR ca.
     *
     * C'est une option de la simulation et pas un test dans la boucle de
     * collision : une carte ou l'on se tire dessus est un autre monde, pas le
     * meme monde avec un drapeau. La difference compte le jour ou l'on
     * ajoutera une troisieme carte — il n'y aura rien a se rappeler de
     * verifier. */
    this.pvp = !!opts.pvp;
    /* ---- LES BLOCS, POSES UNE FOIS ----
     * Ils ne bougent jamais : les tirer a chaque pas serait du travail rendu
     * a l'identique cent fois par seconde. Ils partent au client a l'entree,
     * tels quels — la page ne peut pas les redeviner, et un desaccord se
     * verrait tout de suite : on marcherait dans un rocher, ou l'on serait
     * arrete par du vide. */
    /* ---- LE PLAN, OU LE MONDE OUVERT ----
     * Ce constructeur codait le monde ouvert en dur : ses salles, ses rochers,
     * sa population, son point d'arrivee au bord. Un donjon a les memes
     * creatures, les memes tirs, la meme mort et le meme butin — mais pas la
     * meme geometrie.
     *
     * Deux facons de le faire. Marquer chaque chose d'un numero d'etage et
     * verifier ce numero partout : dans le monstre qui cherche un joueur, dans
     * le tir qui cherche un monstre, dans la zone qui cherche des pieds, dans
     * le pouvoir, dans la portee de `etatPour`. Six boucles, six occasions
     * d'oublier la verification — et l'oubli serait MUET, parce que deux
     * donjons vivent aux memes coordonnees : une fleche tiree dans l'un
     * toucherait une creature de l'autre, posee au meme endroit, et personne
     * ne saurait pourquoi il perd de la vie sans etre touche.
     *
     * L'autre facon est celle-ci : une DEUXIEME simulation. L'isolation n'est
     * alors plus une verification qu'on peut oublier, c'est une structure — le
     * joueur du donjon n'est pas dans `joueurs`, donc rien ne peut le viser ;
     * la creature du donjon n'est pas dans `monstres`, donc aucun tir ne peut
     * l'atteindre. Pas une ligne des six boucles ne change.
     *
     * Ce qui reste a faire tient ici : ce que le plan dit, le plan le donne ;
     * sans plan, le monde ouvert, exactement comme avant. */
    this.plan = opts.plan || null;
    if (this.plan) {
      /* Un donjon n'a pas de salles gardees : c'en est une, en plus grand. */
      this.salles = [];
      this.obstacles = this.plan.obstacles || [];
    } else {
    /* Les SALLES d'abord : les rochers doivent pouvoir les eviter, l'inverse
       n'aurait pas de sens — une salle a moitie mangee par un rocher n'a plus
       de porte unique, et personne ne pourrait dire pourquoi elle est
       infranchissable. */
    this.salles = monde.salles(this.alea).map((s) => ({
      ...s, vide: false, rearme: 0,
    }));
    this.obstacles = monde.obstacles(this.alea, this.salles);
    }
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
    /* Les zones marquees au sol, en attente de frapper. */
    this.zones = [];
    /* ---- LES PORTAILS ----
     * Une liste a part, et pas un sac d'une sorte particuliere. Un sac se
     * RAMASSE ; un portail se FRANCHIT. Les avoir melanges aurait demande, a
     * chaque ligne qui touche aux sacs — le ramassage, le ramassage
     * automatique, l'echange, l'expiration, le plafond — de se souvenir
     * d'ecarter celui-la. Cinq occasions d'en oublier une, et la premiere
     * oubliee aurait fait ramasser une porte. */
    /* ---- LE COMPTE A REBOURS DU SOCLE ----
     * Une seconde par seconde, comme les tombes et les sacs. Pas d'horodatage :
     * ce monde n'a pas d'horloge, il a un `dt`, et un timestamp aurait ete la
     * seule chose ici qui avance quand la simulation, elle, est arretee. */
    this.socleAttente = {};
    this.portails = [];
    this._id = 1;
    /* ---- LA PORTE DU SAS ----
     * Elle existe des le premier pas, et elle ne se referme jamais (`reste`
     * infini : le decompte de `pas` le laisse infini). Un donjon dont la
     * sortie se meriterait enfermerait un joueur qui a mal juge sa vie — et sa
     * mort lui couterait un equipement paye en argent reel. La difficulte d'un
     * donjon est ce qu'on y rencontre ; jamais le fait d'y etre coince.
     * C'est un portail comme les autres, et pas un objet a part : le dessin, la
     * detection sous les pieds et l'envoi dans l'etat sont deja ecrits une
     * fois. `retour` est tout ce qui la distingue. */
    if (this.plan && this.plan.sortie) {
      this.portails.push({ id: this._nouvelId(),
                           x: this.plan.sortie.x, y: this.plan.sortie.y,
                           donjon: null, retour: true, espece: null,
                           reste: Infinity });
    }
    this.peuple();
    for (const s of this.salles) this._armeSalle(s);
  }

  _nouvelId() { return this._id++; }

  /**
   * Poser les gardiens d'une salle.
   *
   * Ils portent `salle` : c'est ce qui les distingue des creatures sauvages.
   * Sans cette marque, `repeuple` les compterait dans la population du monde
   * et retirerait huit creatures a la carte pour compenser — le monde se
   * deviderait a mesure qu'on lui ajoute des destinations.
   *
   * Leur ancre est le CENTRE de la salle. La regle de flanerie les y ramene
   * des qu'ils s'en ecartent de 260, et l'interieur en fait 896 : ils ne
   * sortent donc pas par la porte pour aller mourir dehors, ce qui aurait
   * vide la salle sans que personne n'y soit entre.
   */
  _armeSalle(s) {
    const t = monde.MONSTRES[monde.SALLE.espece];
    const rayon = s.cote / 2 - monde.SALLE.mur - t.rayon;
    for (let k = 0; k < monde.SALLE.gardiens; k++) {
      const ang = (k / monde.SALLE.gardiens) * Math.PI * 2;
      const x = s.x + Math.cos(ang) * rayon * 0.45;
      const y = s.y + Math.sin(ang) * rayon * 0.45;
      this.monstres.push({
        id: this._nouvelId(), espece: monde.SALLE.espece, biome: s.biome, salle: s.i,
        x, y, ancreX: s.x, ancreY: s.y,
        pv: t.pv, pvMax: t.pv, dir: 'down', cible: null,
        recharge: 0, rechargeT: 0, stase: 0, feu: 0, feuReste: 0, errX: 0, errY: 0, errChrono: 0,
      });
    }
    s.vide = false;
    s.rearme = 0;
  }

  /**
   * Les salles, a chaque pas. Vider une salle laisse son butin au centre ;
   * six minutes plus tard les gardiens reviennent.
   *
   * Le butin tombe UNE fois par armement. Sans le drapeau, un sac naitrait a
   * chaque pas tant que la salle est vide — dix par seconde.
   */
  _pasSalles(dt, ev) {
    for (const s of this.salles) {
      const restants = this.monstres.some((m) => m.salle === s.i && m.pv > 0);
      if (!s.vide && !restants) {
        s.vide = true;
        s.rearme = monde.SALLE.rearme;
        /* ---- LA BALISE S'ALLUME, ET NE S'ETEINT PLUS ----
         *
         * Le coffre se rearme au bout de six minutes ; la balise, non. C'est
         * ce qui les separe : le coffre est une recompense qu'on vient
         * reprendre, la balise est une ROUTE qu'on vient d'ouvrir. Une route
         * qui se referme derriere soi n'est pas une route.
         *
         * Elle appartient au MONDE et pas au joueur : celui qui abat les
         * gardiens ouvre le raccourci pour tout le monde, y compris pour ceux
         * qui arriveront apres. C'est la premiere chose de ce jeu qu'on soit
         * content de voir faite par quelqu'un d'autre. */
        if (!s.balise) {
          s.balise = true;
          if (ev) {
            ev.balises = ev.balises || [];
            /* Le meme point que la liste et que la teleportation : l'annonce
               « une balise s'est allumee » pose une fleche a l'ecran, et une
               fleche qui vise autre chose que la pierre envoie chercher au
               mauvais endroit. */
            ev.balises.push({ i: s.i, ...this.pointDeBalise(s),
                              biome: monde.biomeEn(s.x, s.y) });
          }
        }
        /* GARANTI : une salle gardee promet un tresor, et la promesse tient
           meme quand la saison n'a plus de reliques. C'est celui qui tient le
           catalogue qui sait descendre d'un cran — ici on dit seulement que
           celui-la etait promis. */
        const piece = this.tireObjet ? this.tireObjet(s.butin, this.alea, true) : null;
        if (piece) {
          const sac = { id: this._nouvelId(), x: s.x, y: s.y,
                        sac: monde.SAC_DE_RARETE[s.butin] || 'or',
                        reste: monde.SAC.duree, contenu: [piece] };
          this.sacs.push(sac);
          while (this.sacs.length > monde.SAC.plafond) this.sacs.shift();
          if (ev) {
            ev.butins = ev.butins || [];
            ev.butins.push({ addr: null, sac: sac.sac, salle: s.i,
                             contenu: sac.contenu.slice(), x: sac.x, y: sac.y });
          }
        }
      }
      if (s.vide && s.rearme > 0) {
        s.rearme -= dt;
        if (s.rearme <= 0) {
          /* On ne les fait revenir que si personne n'est dedans : voir deux
             gardiens apparaitre autour de soi n'est pas un defi, c'est une
             embuscade sans cause. Ils attendront le pas suivant. */
          const quelquUn = [...this.joueurs.values()]
            .some((j) => j.pv > 0 && monde.dansLaSalle(s, j.x, j.y));
          if (!quelquUn) this._armeSalle(s);
          else s.rearme = 5;
        }
      }
    }
  }

  peuple() {
    /* Dans un donjon, la population est ECRITE : trois salles, une creature par
       place prevue, le boss au fond. On ne la tire pas au sort — un donjon dont
       le nombre de creatures changerait a chaque ouverture ne pourrait pas etre
       equilibre, et deux joueurs qui le racontent ne parleraient pas du meme
       endroit. */
    if (this.plan) {
      this.monstres = (this.plan.peuplement || []).map((m) => this._naissance(m));
      return;
    }
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
    this.monstres = places.map((m) => this._naissance(m));
  }

  /* La forme d'un monstre vivant, a partir d'une place. Ecrite UNE fois : le
     monde ouvert, le donjon et le repeuplement la construisaient chacun de leur
     cote, et le jour ou un champ s'ajoute, deux des trois l'oublient — le
     monstre qui en manque un se comporte alors comme s'il avait un defaut, pas
     comme s'il lui manquait une ligne. */
  _naissance(m) {
    const t = monde.MONSTRES[m.espece];
    return {
      id: this._nouvelId(), espece: m.espece, biome: m.biome,
      x: m.x, y: m.y, ancreX: m.x, ancreY: m.y,
      pv: t.pv, pvMax: t.pv, dir: 'down',
      /* DEUX recharges : le contact et le tir. Une seule ferait qu'un monstre
         qui vient de decocher ne peut plus frapper de pres, ce qui reviendrait
         a lui retirer une des deux attaques au hasard. */
      cible: null, recharge: 0, rechargeT: 0, stase: 0,
      /* Ce que le familier de feu laisse : une duree, un taux et un
         responsable. Declares ICI plutot que crees au premier coup — un champ
         qui apparait en cours de route est un champ que la moitie du code
         teste avec `undefined`. */
      feu: 0, feuReste: 0, feuTaux: 0, feuPar: null,
      // la direction de flanerie, retiree de temps en temps
      errX: 0, errY: 0, errChrono: 0,
    };
  }

  /* ---- LES JOUEURS ---- */

  /**
   * Entrer dans le monde. `fiche` vient de game.personnageEtat.
   *
   * `arrivee` est facultatif, et il sert au PASSAGE d'une simulation a
   * l'autre : franchir un portail n'est pas entrer dans le jeu.
   *
   * ---- pourquoi la vie voyage avec le joueur ----
   *
   * Sans elle, `rejoint` remet les points de vie au maximum — c'est ce qu'il
   * faut quand on entre en jeu. Mais un portail est une porte : entrer a dix
   * points de vie et ressortir plein en aurait fait un bouton de soin, et le
   * meilleur usage d'un donjon aurait ete de ne jamais le faire — entrer,
   * ressortir, repartir chasser gueri. La chose qu'on avait construite pour
   * etre la plus dure du jeu serait devenue sa fontaine.
   *
   * Les etats (brulure, paralysie, ralentissement) ne voyagent PAS, et ce
   * n'est pas un oubli : ils sont poses par une creature qui reste de l'autre
   * cote, ils durent quelques secondes, et les faire traverser demanderait de
   * les recopier un a un — donc d'en oublier un le jour ou un quatrieme
   * s'ajoute. Franchir une porte lave ce qui bruit ; ce qui compte, la vie,
   * traverse.
   */
  rejoint(addr, fiche, arrivee) {
    const stats = (fiche && fiche.stats) || {};
    const bord = (arrivee && Number.isFinite(arrivee.x) && Number.isFinite(arrivee.y))
      ? { x: arrivee.x, y: arrivee.y }
      : this._pointDArrivee();
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
      /* Le familier vient avec la fiche : il appartient au COMPTE, et la
         simulation ne fait que le transporter jusqu'aux autres pages. */
      fam: (fiche && fiche.fam) || null,
      /* Son NIVEAU, parce que c'est lui qui decide de ce que son pouvoir
         vaut. La simulation ne le calcule pas — elle le recoit avec la fiche,
         comme les stats du personnage. */
      famNiv: Math.max(1, (fiche && fiche.famNiv) | 0),
      famR: 0,                 // sa recharge, en secondes
      bouclier: 0,             // ce que la terre laisse derriere elle
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
    /* La vie et le mana d'avant la porte, jamais AU-DESSUS du maximum : une
       fiche qui a change entre les deux mondes (une piece perdue, un niveau
       gagne) ne doit pas laisser un joueur a onze cents points sur une reserve
       de neuf cents — la barre deborderait, et le chiffre mentirait. */
    if (arrivee && Number.isFinite(arrivee.pv)) {
      j.pv = Math.max(1, Math.min(j.pvMax, Math.round(arrivee.pv)));
    }
    if (arrivee && Number.isFinite(arrivee.mp)) {
      j.mp = Math.max(0, Math.min(j.mpMax, Math.round(arrivee.mp)));
    }
    this.joueurs.set(addr, j);
    return j;
  }

  /**
   * ================== CHANGER D'ARME SANS SORTIR DU MONDE ==================
   *
   * La fiche n'etait lue qu'a l'ENTREE. On pouvait donc s'equiper d'une epee
   * trouvee en plein combat : la page se mettait a dessiner ses projectiles,
   * et le serveur continuait de tirer avec l'ancienne. On voyait les deux —
   * le tir de l'arme portee ET celui de l'arme rangee — et aucun des deux
   * n'etait tout a fait vrai.
   *
   * On remplace donc ce qui vient de la fiche, et RIEN d'autre : ni la
   * position, ni les etats en cours, ni les recharges. Changer d'arme ne doit
   * pas annuler une paralysie ni remettre le pouvoir a zero.
   *
   * ---- les points de vie ----
   *
   * Une armure change le maximum. On garde les points COURANTS et on les
   * borne au nouveau maximum : monter le maximum ne soigne pas. Sans cette
   * regle, enfiler et retirer une armure a repetition serait une fontaine de
   * soin gratuite au milieu de la lave.
   */
  rehabille(addr, fiche) {
    const j = this.joueurs.get(addr);
    if (!j || !fiche) return null;
    const stats = fiche.stats || {};
    j.pvMax = Math.max(1, stats.hp | 0);
    j.pv = Math.max(0, Math.min(j.pv, j.pvMax));
    j.mpMax = Math.max(0, stats.mp | 0);
    j.mp = Math.max(0, Math.min(j.mp, j.mpMax));
    j.att = stats.att | 0; j.def = stats.def | 0;
    j.vit = stats.vit | 0; j.wis = stats.wis | 0;
    j.dex = stats.dex | 0; j.spd = stats.spd | 0;
    j.cadence = monde.cadenceDe(stats.dex | 0);
    j.vitesse = monde.vitesseDe(stats.spd | 0);
    j.famille = fiche.famille || 'poing';
    j.degats = fiche.degats || monde.DEGATS_POING;
    /* Changer de familier se voit SANS ressortir du monde : c'est le meme
       chemin que changer d'arme, et un compagnon qui n'apparaitrait qu'a la
       prochaine entree se lirait comme un choix qui n'a pas pris. */
    j.fam = fiche.fam || null;
    j.famNiv = Math.max(1, fiche.famNiv | 0);
    /* ---- ET SA RECHARGE SUIT LE NOUVEAU NIVEAU ----
     * Elle continuait de courir sur l'ancienne. Un joueur qui nourrit son
     * familier au milieu d'un combat le fait passer de soixante secondes a
     * trente — et devait quand meme attendre les soixante d'avant, une fois.
     * Le geste le plus satisfaisant du systeme (« je le nourris, il agit plus
     * souvent ») ne se voyait donc pas au moment ou on le fait.
     * On BORNE au lieu de remettre a zero : remettre a zero offrirait une
     * action gratuite a chaque repas, et nourrir en boucle deviendrait une
     * facon de tirer. */
    j.famR = Math.min(j.famR || 0, monde.rechargeFamilier(j.famNiv));
    j.pouvoir = monde.pouvoirDeStat(fiche.statFruit || null);
    return j;
  }

  quitte(addr) { this.joueurs.delete(addr); return true; }

  /** On arrive TOUJOURS par le bord, sur la terre : entrer directement au
      milieu de la lave tuerait un debutant avant son premier pas. */
  _pointDArrivee() {
    /* Un donjon a UNE entree, et c'est le plan qui la nomme. Arriver au hasard
       dans un couloir de trois tuiles reviendrait a arriver dans un mur une
       fois sur deux, et arriver au hasard dans la salle du fond reviendrait a
       arriver sur le boss. */
    if (this.plan && this.plan.entree) {
      return { x: this.plan.entree.x, y: this.plan.entree.y };
    }
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
    /* ---- LA PORTE S'OUVRE AVANT QU'ON SACHE CE QUE LE SAC CONTIENT ----
     * Posee ici, et pas apres le butin, parce qu'elle n'en depend pas : un
     * tirage malheureux qui rendrait le sac vide fait sortir `_abat` par le
     * `return` d'en dessous, et le donjon d'Optimus se serait referme sur un
     * coup de des. Ce qu'ouvre sa mort ne se tire pas au sort. */
    this._ouvrePortail(m, j, ev);
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

  /**
   * La porte qu'une creature laisse en tombant.
   *
   * ---- pourquoi DERRIERE elle, et pas dessous ----
   *
   * Le sac tombe sur place. Si le portail y tombait aussi, ramasser le butin et
   * entrer dans le donjon seraient le meme geste au meme endroit : on serait
   * entre sans avoir choisi. Le decalage est ce qui rend le choix possible — on
   * voit la porte, on finit de ramasser, puis on marche dedans ou l'on s'en va.
   *
   * Le sens est celui de sa CHUTE : du tueur vers elle, prolonge. C'est le seul
   * qui se lise a l'ecran comme « derriere » — un decalage vers le nord mettrait
   * la porte devant celui qui arrivait par le sud. Sans tueur (une creature
   * achevee par une brulure, ou dont le joueur a quitte le monde), on prend le
   * sens ou elle regardait.
   *
   * Elle glisse hors des rochers et reste dans la carte. Une porte a moitie dans
   * un rocher se verrait mais ne se franchirait pas, et personne ne pourrait
   * deviner pourquoi.
   */
  _ouvrePortail(m, j, ev) {
    const donjon = monde.PORTAIL_DE[m.espece] || null;
    const retour = !donjon && !!monde.RETOUR_DE[m.espece];
    if (!donjon && !retour) return null;
    let ux = 0, uy = 0;
    if (j) {
      const dx = m.x - j.x, dy = m.y - j.y;
      const d = Math.hypot(dx, dy);
      if (d > 1) { ux = dx / d; uy = dy / d; }
    }
    /* Pas de tueur, ou un tueur exactement dessus : on prend le sens ou elle
       regardait. C'est le seul autre « derriere » qui veuille dire quelque
       chose a l'ecran. */
    if (!ux && !uy) {
      if (m.dir === 'up') uy = -1;
      else if (m.dir === 'left') ux = -1;
      else if (m.dir === 'right') ux = 1;
      else uy = 1;
    }
    const R = monde.PORTAIL.rayon;
    /* On recule tant qu'on peut, puis on se rapproche : mieux vaut une porte un
       peu trop pres qu'une porte dans la pierre. Le pas final (0) la remet sur
       la creature elle-meme, ce qui est toujours libre — elle y tenait. */
    let x = m.x, y = m.y;
    for (const f of [1, 0.75, 0.5, 0.25, 0]) {
      const px = Math.max(R, Math.min(monde.MONDE.w - R, m.x + ux * monde.PORTAIL.recul * f));
      const py = Math.max(R, Math.min(monde.MONDE.h - R, m.y + uy * monde.PORTAIL.recul * f));
      if (!monde.bloque(this.obstacles, px, py, R * 0.5)) { x = px; y = py; break; }
    }
    const p = { id: this._nouvelId(), x, y, donjon, retour, espece: m.espece,
                /* Une porte de SORTIE ne se ferme pas : voir monde.PORTAIL. */
                reste: retour ? monde.PORTAIL.dureeRetour : monde.PORTAIL.duree };
    this.portails.push(p);
    /* ---- LE PLAFOND NE MANGE JAMAIS UNE SORTIE ----
     * `shift()` retire la PLUS ANCIENNE, et la plus ancienne d'un donjon est
     * la porte du sas. Vingt-quatre portes dans un donjon n'arrivera sans
     * doute jamais — mais « sans doute jamais » est exactement la marge dans
     * laquelle on enferme un joueur, et un joueur enferme perd un equipement
     * paye en argent reel. On ne compte donc que ce qui peut se fermer. */
    while (this.portails.length > monde.PORTAIL.plafond) {
      const i = this.portails.findIndex((q) => Number.isFinite(q.reste));
      if (i < 0) break;
      this.portails.splice(i, 1);
    }
    if (ev) {
      ev.portails = ev.portails || [];
      ev.portails.push({ addr: j ? j.addr : null, id: p.id, donjon, retour,
                         espece: m.espece, x: p.x, y: p.y });
    }
    return p;
  }

  /** La porte SOUS LES PIEDS d'un joueur, ou null. La plus proche s'il y en a
      plusieurs, comme pour les sacs. */
  portailSousLesPieds(addr) {
    const j = this.joueurs.get(addr);
    if (!j) return null;
    let choisi = null, d2mini = monde.PORTAIL.rayon * monde.PORTAIL.rayon;
    for (const p of this.portails) {
      const dx = p.x - j.x, dy = p.y - j.y, d2 = dx * dx + dy * dy;
      if (d2 <= d2mini) { d2mini = d2; choisi = p; }
    }
    return choisi;
  }

  /** Le sac SOUS LES PIEDS d'un joueur, ou null. Le plus proche s'il y en a
      plusieurs : deux sacs cote a cote et c'est celui de derriere qu'on
      ouvrirait. */
  sacSousLesPieds(addr) {
    const j = this.joueurs.get(addr);
    if (!j) return null;
    return sacsAuSol.sousLesPieds(this.sacs, j.x, j.y);
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
    const r = sacsAuSol.prend(this.sacs, s, place, accepte);
    if (!r || r.refuse) return r;
    const objet = r;
    if (ev) { ev.ramasses = ev.ramasses || []; ev.ramasses.push({ addr, sac: s.sac, id: s.id, ...objet }); }
    return r;
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
    /* ---- UNE FIOLE SE POSE COMME UNE PIECE ----
     * Elle n'a pas d'identifiant de catalogue — c'est une STAT, pas un objet —
     * et `Number('att')` vaut NaN. Le depot la refusait donc, en silence pour
     * qui glisse et avec « Unknown item » pour qui regarde la socket : on
     * pouvait ramasser une fiole et plus jamais s'en defaire autrement qu'en
     * la buvant. Un sac de huit places dont une case ne se vide pas est un sac
     * de sept places.
     * Le sol, lui, sait deja les porter : c'est sous cette forme exacte
     * qu'elles tombent d'un monstre. */
    const r = sacsAuSol.depose(this.sacs, j.x, j.y, addr, objet,
                              () => this._nouvelId());
    if (!r || r.refuse) return r;
    const s = this.sacs.find((x) => x.id === r.id);
    const item = r.item, stat = r.stat;
    if (ev) { ev.deposes = ev.deposes || []; ev.deposes.push({ addr, id: s.id, item, stat }); }
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
    const ev = { degats: [], morts: [], kills: [], touches: [], regen: [], butins: [], ramasses: [], expires: [], marques: [], zones: [], portails: [] };
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
    /* ---- CE QUI N'A PAS ETE RAMASSE REVIENT AU POOL ----
     * Une piece a plafond d'emission est COMPTEE des qu'elle tombe : sans ca,
     * deux joueurs pourraient ramasser la derniere relique. Mais un sac qui
     * finit sa minute sans que personne n'y touche aurait alors retire cette
     * piece du monde pour toujours. On annonce donc ce qui part ; c'est
     * l'appelant qui tient le registre, realm.js ne le connait pas. */
    const perdus = sacsAuSol.vieillit(this.sacs, dt);
    if (perdus.length && ev) {
      ev.expires = ev.expires || [];
      for (const o of perdus) ev.expires.push(o);
    }
    /* Les portes vieillissent comme les sacs, et pour la meme raison : une
       porte qui resterait ouverte pour toujours ferait du donjon un LIEU, pas
       un evenement — on irait y attendre au lieu d'aller le chercher. Celle du
       sas a un `reste` infini : le retrancher le laisse infini, donc elle ne se
       referme jamais, sans un `if` de plus. */
    for (let i = this.portails.length - 1; i >= 0; i--) {
      this.portails[i].reste -= dt;
      if (this.portails[i].reste <= 0) this.portails.splice(i, 1);
    }
    /* Le poseur s'est ecarte : le sac redevient ramassable, pour lui comme
       pour les autres. On l'oublie ICI plutot qu'a l'entree du ramassage :
       « qui a pose » est un fait du monde, pas une question de qui regarde. */
    sacsAuSol.oubliePoseurs(this.sacs, (a) => this.joueurs.get(a) || null);
    /* Le delai avant que le boss du donjon puisse renaitre. Il ne court que
       pendant qu'il est mort — `repeuple` le remet a plein tant qu'il vit. */
    for (const k of Object.keys(this.socleAttente)) {
      if (this.socleAttente[k] > 0) this.socleAttente[k] = Math.max(0, this.socleAttente[k] - dt);
    }
    this._pasSalles(dt, ev);
    this._pasZones(dt, ev);
    this._pasMonstres(dt, ev);
    this._pasTirs(dt, ev);
    this._pasTirsMonstres(dt, ev);
    /* APRES les monstres : le familier reagit a ce qui vient de se passer,
       pas a l'etat d'avant le pas. Un chien qui mordrait avant que le monstre
       n'ait avance frapperait ou il etait. */
    this._pasFamiliers(dt, ev);
    return ev;
  }

  /**
   * ==================== LE FAMILIER AIDE ====================
   *
   * Il agit SEUL, sur une recharge. Un compagnon qu'il faut declencher est une
   * deuxieme touche de pouvoir : on l'oublie, ou on l'appuie en boucle. Le
   * joueur choisit LEQUEL sortir, et c'est la que se joue la decision.
   *
   * ---- il n'est pas une entite ----
   *
   * Pas de position, pas de points de vie, rien ne le vise. C'est la promesse
   * faite au joueur : l'oeuf tombe une fois sur cinq mille et ce qu'il en sort
   * ne se perd pas. Ses effets partent donc du MAITRE — soixante unites
   * d'imprecision sur deux cent soixante, moins que le rayon d'un monstre.
   *
   * ---- et il ne se bat pas dans le monde rouge ----
   *
   * Sur la carte PvP, on perd son sac en mourant. Laisser un tirage a un sur
   * cinq mille decider des duels aurait fait de la chance au butin la
   * competence principale d'une carte ou l'on risque ses affaires — et il n'y
   * a aucune facon de FARMER un un-sur-cinq-mille pour rattraper. Le familier
   * y trotte, et c'est tout.
   */
  _pasFamiliers(dt, ev) {
    if (this.pvp) return;
    for (const j of this.joueurs.values()) {
      if (j.pv <= 0 || !j.fam) { continue; }
      /* Le bouclier s'use meme quand la recharge court : c'est une duree, pas
         une charge, et la suspendre l'aurait rendu permanent au repos. */
      if (j.bouclier > 0) j.bouclier = Math.max(0, j.bouclier - dt);
      j.famR = (j.famR || 0) - dt;
      if (j.famR > 0) continue;

      const cle = monde.POUVOIR_PAR_ESPECE[j.fam];
      const E = cle ? monde.familierEffet(cle, j.famNiv || 1) : null;
      /* Une espece sans pouvoir connu — un familier ajoute avant sa regle :
         on lui donne quand meme une recharge, sinon la boucle le reprendrait a
         chaque pas. Celle de SON niveau, comme tout le monde. */
      if (!E) { j.famR = monde.rechargeFamilier(j.famNiv || 1); continue; }

      /* ---- CE QUI SE PASSE, ET SI LA RECHARGE REPART ----
       * Un geste dans le vide ne consomme PAS la recharge : sinon le chien
       * mordrait l'air a l'instant ou l'on arrive sur un groupe, et
       * attendrait cinq secondes pour le premier vrai coup. */
      const fait = this._familierAgit(j, cle, E, ev);
      if (fait) j.famR = E.recharge;
      else j.famR = 0.35;                 // il regarde autour, il ne dort pas
    }
  }

  /** Le geste lui-meme. Rend `true` s'il a servi a quelque chose. */
  _familierAgit(j, cle, E, ev) {
    /* ---- LE SOIN ET LE BOUCLIER NE VISENT PERSONNE ----
     * Ils partent sur le maitre. Les mettre dans la boucle de recherche de
     * cible les aurait rendus muets quand il n'y a pas de monstre — c'est-a-
     * dire au moment ou l'on se soigne. */
    if (cle === 'soigne') {
      if (j.pv >= j.pvMax) return false;
      const gain = Math.max(1, Math.round(j.pvMax * E.part));
      j.pv = Math.min(j.pvMax, j.pv + gain);
      ev.fam = ev.fam || [];
      ev.fam.push({ addr: j.addr, quoi: 'soigne', gain, pv: j.pv,
                    x: Math.round(j.x), y: Math.round(j.y) });
      return true;
    }
    if (cle === 'bouclier') {
      /* On ne le repose pas s'il tient encore : sinon la recharge le
         prolongerait sans fin et il ne serait plus une fenetre mais un etat. */
      if (j.bouclier > 0) return false;
      j.bouclier = E.duree;
      j.bouclierPart = E.reduction;
      ev.fam = ev.fam || [];
      ev.fam.push({ addr: j.addr, quoi: 'bouclier', duree: E.duree,
                    part: E.reduction, x: Math.round(j.x), y: Math.round(j.y) });
      return true;
    }

    if (cle === 'repousse') {
      const R2 = E.rayon * E.rayon;
      const pousses = [];
      for (const m of this.monstres) {
        if (m.pv <= 0) continue;
        const dx = m.x - j.x, dy = m.y - j.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        /* Pile dessus : on pousse vers le bas plutot que de diviser par zero.
           Une direction arbitraire vaut mieux qu'un NaN qui sortirait la
           creature de la carte pour toujours. */
        const d = Math.sqrt(d2) || 1;
        const nx = d2 ? dx / d : 0, ny = d2 ? dy / d : 1;
        /* ---- ON POUSSE, ON NE TELEPORTE PAS ----
         * Le mur arrete : sans ce test, les tenebres enverraient les monstres
         * DANS la roche, ou ils resteraient coinces hors d'atteinte et
         * empecheraient la salle de se vider. */
        const vx = m.x + nx * E.force, vy = m.y + ny * E.force;
        if (!monde.bloque(this.obstacles, vx, vy, 0)) { m.x = vx; m.y = vy; }
        pousses.push(m.id);
      }
      if (!pousses.length) return false;
      ev.fam = ev.fam || [];
      ev.fam.push({ addr: j.addr, quoi: 'repousse', rayon: E.rayon,
                    monstres: pousses, x: Math.round(j.x), y: Math.round(j.y) });
      return true;
    }

    /* ---- LES TROIS QUI VISENT ----
     * Le plus proche dans la portee. Un tirage au hasard parmi ceux a portee
     * aurait rendu le compagnon illisible : on ne saurait jamais pourquoi il
     * a choisi celui-la. */
    let cible = null, d2mini = E.portee * E.portee;
    for (const m of this.monstres) {
      if (m.pv <= 0) continue;
      const dx = m.x - j.x, dy = m.y - j.y, d2 = dx * dx + dy * dy;
      if (d2 < d2mini) { d2mini = d2; cible = m; }
    }
    if (!cible) return false;

    if (cle === 'gele') {
      /* Deja fige : on ne recommence pas. Prolonger a chaque recharge aurait
         fait d'un seul monstre une statue permanente, ce qui n'est pas une
         aide mais une suppression. */
      if (cible.stase > 0) return false;
      cible.stase = E.duree;
      ev.fam = ev.fam || [];
      ev.fam.push({ addr: j.addr, quoi: 'gele', monstre: cible.id, duree: E.duree,
                    x: Math.round(cible.x), y: Math.round(cible.y) });
      return true;
    }

    if (cle === 'brule') {
      /* La brulure REMPLACE, elle ne s'ajoute pas : deux compteurs sur la meme
         creature auraient double les degats sans que rien ne le dise. */
      cible.feu = E.duree;
      cible.feuPar = j.addr;
      cible.feuTaux = E.parSeconde;
      ev.fam = ev.fam || [];
      ev.fam.push({ addr: j.addr, quoi: 'brule', monstre: cible.id, duree: E.duree,
                    x: Math.round(cible.x), y: Math.round(cible.y) });
      return true;
    }

    // mord
    const perte = Math.max(1, Math.round(E.degats));
    cible.pv = Math.max(0, cible.pv - perte);
    ev.fam = ev.fam || [];
    ev.fam.push({ addr: j.addr, quoi: 'mord', monstre: cible.id, perte, pv: cible.pv,
                  x: Math.round(cible.x), y: Math.round(cible.y) });
    /* Le meme evenement que nos tirs : la page peint le chiffre au meme
       endroit, avec le meme code. Un second chemin d'affichage aurait fini par
       montrer les degats du chien autrement que les notres. */
    ev.touches.push({ addr: j.addr, monstre: cible.id, espece: cible.espece,
                      perte, pv: cible.pv, x: cible.x, y: cible.y, familier: j.fam });
    if (cible.pv <= 0) this._abat(cible, j, ev);
    return true;
  }

  /* ---- CE QUE LE BOUCLIER LAISSE PASSER ----
   * UN seul endroit reduit les degats. Il y a trois facons de se faire
   * toucher — le contact, la zone, la fleche — et recopier la soustraction
   * dans les trois aurait garanti que la quatrieme, le jour ou elle arrive,
   * l'oublie. La brulure n'y passe pas : elle ignore la defense par regle du
   * jeu, et un bouclier est une defense. */
  _amorti(j, perte) {
    if (!(j.bouclier > 0) || !(j.bouclierPart > 0)) return perte;
    /* Au moins un point : un bouclier qui annulerait entierement les petits
       coups ferait des secondes ou l'on ne risque rien, et l'esquive — la
       seule competence du jeu — cesserait de compter pendant ce temps-la. */
    return Math.max(1, Math.round(perte * (1 - j.bouclierPart)));
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
      if (t.zone && m.zoneRecharge === undefined) m.zoneRecharge = 1 / t.zone.cadence;

      /* ---- LE FEU DU FAMILIER RONGE ----
       * Avant la stase : une creature figee brule quand meme. Le contraire
       * aurait fait de la glace un CONTRE au feu chez le meme joueur, ce que
       * personne ne comprendrait — ce sont deux aides, pas deux camps.
       *
       * Meme comptabilite que la brulure du joueur : on accumule en flottant
       * et l'on ne verse que les points ENTIERS. A cinq points par seconde, un
       * pas de cent millisecondes vaut 0,5 — arrondir chaque pas donnerait
       * zero pour toujours. */
      if (m.feu > 0) {
        m.feu = Math.max(0, m.feu - dt);
        m.feuReste = (m.feuReste || 0) + (m.feuTaux || 0) * dt;
        const brule = Math.floor(m.feuReste);
        if (brule > 0) {
          m.feuReste -= brule;
          m.pv = Math.max(0, m.pv - brule);
          ev.touches.push({ addr: m.feuPar || null, monstre: m.id, espece: m.espece,
                            perte: brule, pv: m.pv, x: m.x, y: m.y, familier: 'feu' });
          if (m.pv <= 0) {
            /* Le maitre a pu partir entre-temps : `_abat` sait recevoir un
               tueur absent, et le butin appartient au sol de toute facon. */
            this._abat(m, this.joueurs.get(m.feuPar) || null, ev);
            continue;
          }
        }
      } else if (m.feuReste) { m.feuReste = 0; }

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
            const perte = this._amorti(cible, monde.degatsSubis(t.att, cible.def));
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
        /* ---- ET IL MARQUE LE SOL ----
         * Seulement s'il VOIT quelqu'un, et pas de trop loin : une zone posee
         * a l'autre bout de sa vue frapperait un joueur qui ne sait meme pas
         * qu'il est vu. */
        if (t.zone) {
          m.zoneRecharge -= dt;
          if (m.zoneRecharge <= 0 && d < t.zone.rayon * 3) {
            m.zoneRecharge = 1 / t.zone.cadence;
            this.zones.push({ id: this._nouvelId(), x: cible.x, y: cible.y,
                              r: t.zone.rayon, att: t.zone.att,
                              effet: t.zone.effet || null, espece: m.espece,
                              reste: t.zone.annonce, duree: t.zone.annonce });
            if (ev) {
              ev.marques = ev.marques || [];
              ev.marques.push({ x: cible.x, y: cible.y, r: t.zone.rayon,
                                duree: t.zone.annonce, espece: m.espece });
            }
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
      /* ---- ET LES AUTRES JOUEURS, DANS LE MONDE ROUGE ----
       *
       * AVANT les creatures : sinon un lime pose entre deux joueurs servirait
       * de bouclier vivant, et se planquer derriere un monstre serait la
       * meilleure defense du jeu. Le tir touche ce qu'il rencontre.
       *
       * Le tireur ne se touche pas lui-meme — un projectile nait sur soi, et
       * sans cette ligne on se tuerait au premier coup. Les degats se
       * calculent avec la MEME formule que contre une creature : une regle de
       * degats a part aurait donne deux equilibres a tenir, et celui qui ne
       * sert que la moitie du temps derive toujours. */
      if (!fini && this.pvp) {
        const tireur = this.joueurs.get(t.addr);
        for (const c of this.joueurs.values()) {
          if (c.addr === t.addr || c.pv <= 0) continue;
          const dx = c.x - t.x, dy = c.y - t.y;
          if (dx * dx + dy * dy > RAYON_CIBLE * RAYON_CIBLE) continue;
          const arme = monde.tirageArme(tireur ? tireur.degats : monde.DEGATS_POING, this.alea);
          const perte = monde.degatsInfliges(tireur ? tireur.att : 0, arme, c.def);
          c.pv = Math.max(0, c.pv - perte);
          /* DEUX evenements, pour deux publics : celui qui encaisse doit voir
             sa barre baisser, celui qui tire doit voir son coup porter. Un
             seul des deux laisserait l'autre dans le noir. */
          ev.degats.push({ addr: c.addr, perte, pv: c.pv,
                           par: (tireur && tireur.nom) || 'someone', quoi: 'joueur' });
          ev.touches.push({ addr: t.addr, joueur: c.addr, perte, pv: c.pv, x: t.x, y: t.y });
          if (c.pv <= 0) {
            ev.morts.push({ addr: c.addr, par: (tireur && tireur.nom) || 'someone',
                            pvp: 1, parAddr: t.addr, x: c.x, y: c.y });
          }
          fini = true;
          break;
        }
      }
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

  /**
   * ---- LES ZONES MARQUEES AU SOL ----
   *
   * Une zone est posee la ou le joueur SE TROUVE, puis elle attend. Quand le
   * compte a rebours finit, elle frappe tout ce qui est encore dedans.
   *
   * Elle est posee sur la position du joueur et pas devant lui : viser la ou
   * il va serait un piege sans reponse, puisqu'il faudrait deviner ce que le
   * monstre a devine. Posee sur lui, la reponse est toujours la meme et
   * toujours disponible — bouger.
   *
   * Le monstre ne verifie RIEN au moment de frapper : la zone existe seule.
   * Le tuer pendant l'annonce ne l'annule donc pas, et c'est voulu — sinon la
   * meilleure reponse a une zone serait de tirer plus fort, ce qui est
   * exactement ce qu'elle doit empecher.
   */
  _pasZones(dt, ev) {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.reste -= dt;
      if (z.reste > 0) continue;
      this.zones.splice(i, 1);
      ev.zones = ev.zones || [];
      ev.zones.push({ x: z.x, y: z.y, r: z.r, espece: z.espece });
      for (const j of this.joueurs.values()) {
        if (j.pv <= 0) continue;
        const dx = j.x - z.x, dy = j.y - z.y;
        if (dx * dx + dy * dy > z.r * z.r) continue;
        const perte = this._amorti(j, monde.degatsSubis(z.att, j.def));
        j.pv = Math.max(0, j.pv - perte);
        ev.degats.push({ addr: j.addr, perte, pv: j.pv, par: z.espece, quoi: 'zone' });
        if (z.effet) this._poseEtat(j, z.effet, ev);
        if (j.pv <= 0) this._meurt(j, z.espece, ev);
      }
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
          const perte = this._amorti(j, monde.degatsSubis(t.att, j.def));
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
                    /* ---- SON FAMILIER ----
                     * Une CHAINE, pas une creature. Le familier n'est pas une
                     * entite de la simulation : il n'a ni position, ni points
                     * de vie, ni collision — il trotte derriere son maitre, et
                     * c'est la page qui le fait trotter. Le simuler cote
                     * serveur aurait double le nombre de choses a deplacer et
                     * a diffuser pour un compagnon qui ne fait encore rien.
                     * Le jour ou il MORD, il deviendra une entite ; ce jour-la
                     * ce champ ne suffira plus, et c'est tres bien : on saura
                     * exactement ou regarder. */
                    fam: k.fam || null,
                    pv: k.pv, pvMax: k.pvMax });
    }
    return {
      moi: { x: Math.round(j.x), y: Math.round(j.y), pv: j.pv, pvMax: j.pvMax,
             mp: j.mp, mpMax: j.mpMax, fam: j.fam || null,
             /* Ce qu'il reste de bouclier. Sans ce champ, la terre serait le
                seul des six pouvoirs dont on ne verrait jamais rien — elle
                agit en RETIRANT des degats, et l'absence ne se dessine pas. */
             bo: j.bouclier > 0 ? Number(j.bouclier.toFixed(2)) : 0,
             /* Sa vitesse de deplacement, telle que le SERVEUR la calcule.
                La page ne la deduit pas de son cote : deux formules a tenir
                d'accord finiraient par se contredire, et le joueur se ferait
                ramener en arriere sans comprendre pourquoi. */
             v: Math.round(j.vitesse),
             /* ---- ET SA CADENCE DE TIR, POUR LA MEME RAISON ----
              * La page se limitait a la cadence de l'ARME, et rien d'autre.
              * Le serveur, lui, la multiplie par la dexterite et par la
              * rafale : il acceptait donc deux fois plus de tirs que la page
              * n'en demandait. La dexterite ne servait a rien, et « Rapid
              * fire » ne faisait pas tirer plus vite — il faisait juste
              * clignoter une aura.
              * Elle part d'ici pour qu'il n'y ait qu'un seul endroit ou la
              * regle s'ecrit. Deux formules a tenir d'accord finissent
              * toujours par se contredire, et celle-la se contredisait en
              * silence : la page demandait moins que son du. */
             c: Number((((monde.ARMES[j.famille] || monde.ARMES.poing).cadence
                        * (j.cadence || 1)
                        * (j.rafale > 0 ? monde.POUVOIRS.rafale.facteur : 1))).toFixed(2)),
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
        /* Et le feu aussi : une creature qui perd des points de vie sans que
           rien ne le montre se lit comme un bug, pas comme une brulure. */
        if (m.feu > 0) o.fe = Number(m.feu.toFixed(2));
        return o;
      }),
      /* ---- LA VITESSE PART AVEC LE PROJECTILE ----
       * Sans elle, la page ne peut que POSER les projectiles la ou ils
       * etaient au dernier etat — dix fois par seconde. Un tir a 340 unites
       * par seconde reste alors fige six images puis saute de trente-quatre
       * unites, et ca se lit comme du lag alors que rien ne rame.
       * Avec l'angle et la vitesse, la page les fait AVANCER entre deux
       * etats : un projectile va tout droit a vitesse constante, donc la
       * prediction est exacte, pas approchee. Un nombre de plus par
       * projectile, contre une vingtaine en vol. */
      tirs: this.tirs.filter(pres).map((t) => ({
        i: t.id, x: Math.round(t.x), y: Math.round(t.y),
        a: Number(t.a.toFixed(3)), v: Math.round(t.v), f: t.famille,
        mien: t.addr === addr })),
      /* Les fleches ennemies dans une liste a part : le client doit pouvoir
         les dessiner autrement, et surtout ne jamais croire qu'elles sont a
         lui. */
      tirsM: this.tirsM.filter(pres).map((t) => ({
        i: t.id, x: Math.round(t.x), y: Math.round(t.y),
        a: Number(t.a.toFixed(3)), v: Math.round(t.v), f: t.sprite })),
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
      /* Les zones en attente : la page dessine le cercle qui se remplit, et
         elle a besoin du temps RESTANT pour savoir ou il en est. Sans ce
         chiffre elle le devinerait — donc se tromperait, donc mentirait sur
         le moment ou ca frappe. */
      zones: this.zones.filter(pres).map((z) => ({
        i: z.id, x: Math.round(z.x), y: Math.round(z.y), r: z.r,
        t: Number(z.reste.toFixed(2)), d: z.duree })),
      /* L'ETAT DES SALLES : gardee, ou videe. Rien d'autre — la page a deja
         leur position et leur taille depuis l'entree, elles ne bougent pas.
         Ce seul bit sert au coffre : ferme tant qu'un gardien vit, ouvert
         quand la salle tombe. C'est ce qui fait d'une salle une DESTINATION —
         on voit de la porte qu'il y a quelque chose a prendre, et on voit de
         loin qu'elle a deja ete faite. */
      salles: this.salles.filter(pres).map((s) => ({ i: s.i, v: s.vide ? 1 : 0 })),
      /* ---- LES BALISES PARTENT EN ENTIER, PAS SEULEMENT CELLES QU'ON VOIT ----
       * Les salles sont filtrees par `pres` : on n'envoie que celles a
       * l'ecran, parce qu'on les DESSINE. Une balise sert a aller AILLEURS —
       * n'envoyer que celles qui sont deja sous les yeux reviendrait a
       * n'offrir de voyager que vers l'endroit ou l'on se tient. */
      /* La ou l'on ARRIVE, pas le centre de la salle : c'est ce que la pierre
         promet, et c'etait faux. Voir `pointDeBalise`. */
      balises: this.salles.map((s) => {
        const p = this.pointDeBalise(s);
        return { i: s.i, x: Math.round(p.x), y: Math.round(p.y),
                 on: s.balise ? 1 : 0 };
      }),
      /* Les portes ouvertes. Le temps restant part avec elles pour la meme
         raison que celui des sacs : la page dessine la porte qui se referme, et
         sans ce chiffre elle le devinerait — donc mentirait sur le moment ou il
         est trop tard pour entrer. */
      portails: this.portails.filter(pres).map((p) => ({
        i: p.id, x: Math.round(p.x), y: Math.round(p.y), dj: p.donjon || null,
        /* Ce qui separe les deux portes : l'une emmene, l'autre ramene. La page
           ecrit « ENTER » sur la premiere et « EXIT » sur la seconde, et sans ce
           bit elle devrait deviner — donc se tromper une fois sur deux sur le
           seul bouton qui compte. */
        rt: p.retour ? 1 : 0,
        /* Une porte qui ne se referme jamais n'a pas de compte a rebours a
           dessiner : `null` le dit, la ou `Infinity` serait devenu `null` en
           traversant JSON de toute facon — mais sans qu'on l'ait voulu. */
        r: Number.isFinite(p.reste) ? Number(p.reste.toFixed(1)) : null })),
      /* La FICHE part avec la piece — bonus, degats, couleur, drapeau des
         numerotees — parce que c'est la, au sol, que se pose la question
         « est-ce qu'elle vaut mieux que celle que je porte ? ». Elle est
         posee UNE fois, quand la piece nait ou qu'on la depose. La forme est
         ecrite dans sacs.js : le hall et le monde de combat envoient
         exactement le meme objet, et la page n'a qu'une facon de le lire. */
      sacs: this.sacs.filter(pres).map(sacsAuSol.vue),
    };
  }

  /**
   * ==================== SE RENDRE A UNE BALISE ====================
   *
   * Un seul refus, et il est structurel : la balise doit etre ALLUMEE. On ne
   * verifie pas la distance — c'est tout l'interet, on vient de loin — ni la
   * vie, ni le combat en cours : fuir vers une balise est un usage legitime,
   * et le seul moyen d'en faire un abus serait qu'elle soit gratuite a
   * allumer. Elle ne l'est pas : il faut avoir abattu ses gardiens.
   *
   * On arrive au BORD de la salle et non au centre. Au centre on se poserait
   * sur le coffre, et sur une salle rearmee, au milieu de ses gardiens.
   */
  vaALaBalise(addr, i) {
    const j = this.joueurs.get(String(addr || '').toLowerCase());
    if (!j) return null;
    const s = this.salles.find((x) => x.i === Number(i));
    if (!s || !s.balise) return null;
    const p = this.pointDeBalise(s);
    j.x = Math.max(40, Math.min(monde.MONDE.w - 40, p.x));
    j.y = Math.max(40, Math.min(monde.MONDE.h - 40, p.y));
    return { i: s.i, x: Math.round(j.x), y: Math.round(j.y) };
  }

  /* ---- OU EST LA BALISE, POUR DE BON ----
   *
   * DEVANT LA PORTE. Chaque salle gardee a UNE ouverture, sur un cote tire au
   * sort — nord, sud, est ou ouest. La balise etait posee au sud pour tout le
   * monde : sur les trois quarts des salles, elle se retrouvait donc derriere
   * un mur, et l'on se teleportait a un endroit d'ou il faut faire le tour.
   * Devant la porte, elle dit exactement ce qu'elle promet : « d'ici, tu
   * entres ».
   *
   * Ni au centre : on s'y poserait sur le coffre, et sur une salle rearmee, au
   * milieu de ses gardiens.
   *
   * Ce point est ECRIT ICI et nulle part ailleurs. Il servait a la
   * teleportation ; la liste envoyee aux pages, elle, donnait le centre de la
   * salle. La pierre se dessinait donc SOUS le coffre — invisible derriere
   * lui, et son anneau vert au sol se lisait comme un cercle sans objet autour
   * d'un tresor. Deux endroits qui pretendaient dire « la balise est ici » et
   * n'en disaient pas la meme.
   */
  /* ---- ET ELLE NE TOMBE PAS DANS UN ROCHER ----
   *
   * Le point ideal est devant la porte. Le monde, lui, ne le sait pas : il
   * pose ses rochers ou il veut, et sur trois salles sur deux cent trente-sept
   * la pierre est justement la. On s'y teleportait DANS le decor.
   *
   * On s'ecarte donc, par cercles de plus en plus larges autour du point
   * ideal. Et c'est la METHODE D'INSTANCE qui sert partout — au dessin comme a
   * la teleportation. La lecon a deja ete payee une fois : deux endroits qui
   * pretendent dire « la balise est ici » finissent par n'en pas dire la meme,
   * et le joueur voit la pierre a un endroit et arrive a un autre.
   */
  pointDeBalise(s) {
    const p = Realm.pointDeBalise(s);
    if (!monde.bloque(this.obstacles, p.x, p.y, RAYON_JOUEUR)) return p;
    for (let r = 48; r <= 320; r += 48) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
        if (x < 60 || y < 60 || x > monde.MONDE.w - 60 || y > monde.MONDE.h - 60) continue;
        /* PAS dans la salle : on la contournerait par l'interieur, au milieu
           des gardiens, ce qui est exactement ce qu'on evite en ne posant pas
           la balise au centre. */
        const demi = monde.SALLE.cote * monde.TUILE / 2;
        if (Math.abs(x - s.x) < demi && Math.abs(y - s.y) < demi) continue;
        if (!monde.bloque(this.obstacles, x, y, RAYON_JOUEUR)) return { x, y };
      }
    }
    /* Rien de libre a trois cents unites a la ronde : on rend le point ideal
       plutot que rien. Coince dans un rocher, on en sort en marchant ; sans
       balise, la salle n'a plus de route. */
    return p;
  }

  /** Le point IDEAL, sans regarder le decor. Voir la methode d'instance. */
  static pointDeBalise(s) {
    const R = monde.SALLE.cote * monde.TUILE / 2;
    /* Soixante unites DEHORS : dedans on serait dans l'embrasure, et le
       gardien le plus proche de la porte nous accueillerait au premier pas. */
    const loin = R + 60;
    switch (s.porte) {
      case 'nord':  return { x: s.x, y: s.y - loin };
      case 'ouest': return { x: s.x - loin, y: s.y };
      case 'est':   return { x: s.x + loin, y: s.y };
      /* `sud` et tout le reste : une salle sans porte nommee — une vieille
         sauvegarde, un plan bricole — se comporte comme avant plutot que de
         poser sa balise a `undefined`. */
      default:      return { x: s.x, y: s.y + loin };
    }
  }

  /** Un monstre remplace ceux qu'on a tues, pour que la carte ne se vide pas.
      On ne fait naitre que ce qui manque, et LOIN des joueurs : voir un
      squelette apparaitre a trois pas serait une punition sans cause. */
  repeuple(distanceMini) {
    /* ---- UN DONJON NE SE REPEUPLE PAS ----
     * C'est ce qui le separe du monde ouvert. Le monde se referme derriere soi
     * pour qu'il y ait toujours quelque chose a chasser ; un donjon se VIDE, et
     * c'est le fait qu'il finisse qui en fait une expedition plutot qu'un
     * terrain. Sans ce refus, `monde.PEUPLEMENT` y ferait naitre cent soixante
     * creatures des anneaux, dans trois salles de pierre — le donjon serait
     * devenu le monde ouvert, en plus petit. */
    if (this.plan) return 0;
    const dmin = Number(distanceMini) || 900;
    const voulu = Object.keys(monde.PEUPLEMENT)
      .reduce((s, b) => s + monde.PEUPLEMENT[b].nombre, 0);
    /* Les gardiens de salle ne sont pas de la population sauvage : les
       compter ici retirerait huit creatures a la carte, et le monde se
       deviderait a mesure qu'on lui ajoute des destinations. */
    const sauvages = () => this.monstres.filter((m) => !m.salle).length;
    let nes = 0;
    let essais = 0;
    /* ---- LE SOCLE, AVANT LE TIRAGE ORDINAIRE ----
     *
     * Optimus pese deux pour cent de son anneau : le tirage general en fait
     * naitre un tous les quatre cents monstres environ, ce qui veut dire que
     * l'abattre une fois revenait a ne plus jamais le revoir. Or c'est la
     * seule porte de la Fonderie. On le fait donc naitre A PART, hors du
     * tirage, des que le monde n'en a plus — apres un delai, sinon un joueur
     * poste sur sa depouille enchainerait les donjons.
     *
     * Le compte a rebours se tient ICI plutot qu'a la mort de la creature :
     * la mort a six chemins dans ce fichier — le tir, la zone, le contact, le
     * pouvoir, la salle, le donjon — et il aurait fallu ne pas l'oublier dans
     * les six. Ce qu'on regarde, c'est le monde : « il n'y en a plus depuis
     * combien de temps ». Cette question-la n'a qu'un endroit ou se poser. */
    for (const esp of Object.keys(monde.SOCLE || {})) {
      const socle = monde.SOCLE[esp];
      const vivants = () => this.monstres.filter((m) => m.espece === esp && !m.salle).length;
      /* Pas les 900 unites du repeuplement ordinaire : l'anneau de lave est un
         disque de 768 de rayon, et la regle generale y interdit donc TOUTE
         naissance des qu'un joueur y met les pieds — c'est-a-dire des qu'on
         chasse Optimus. `ecartDeNaissance` la ramene a ce que l'anneau offre. */
      const ecart = monde.ecartDeNaissance(esp, dmin);
      if (vivants() < socle && !(this.socleAttente[esp] > 0)) {
        for (let k = 0; k < 40 && vivants() < socle; k++) {
          const m = monde.placeUne(esp, this.alea);
          if (!m) break;
          const t = monde.MONSTRES[m.espece];
          if (!t) break;
          if (monde.bloque(this.obstacles, m.x, m.y, t.rayon)) continue;
          let tropPres = false;
          for (const j of this.joueurs.values()) {
            const dx = j.x - m.x, dy = j.y - m.y;
            if (dx * dx + dy * dy < ecart * ecart) { tropPres = true; break; }
          }
          if (tropPres) continue;
          this.monstres.push(this._naissance(m));
          nes++;
        }
      }
      /* ---- LE DELAI SE REMET A PLEIN TANT QU'IL VIT ----
       * Et « il vit » inclut « il vient de naitre a l'instant ». Remettre le
       * compteur seulement quand il etait DEJA la laissait un trou : dans un
       * monde ou le tirage initial ne l'avait pas donne, il naissait au
       * premier tour sans jamais armer son delai — et le joueur qui l'abattait
       * en voyait un autre a la seconde suivante. */
      if (vivants() >= socle) {
        this.socleAttente[esp] = Number(monde.SOCLE_DELAI && monde.SOCLE_DELAI[esp]) || 0;
      }
    }
    /* ---- ON REBOUCHE LE TROU LA OU IL EST ----
     *
     * Le tirage precedent piochait une place au hasard dans la table du monde
     * ENTIER : nettoyer la lave y faisait naitre une creature sur neuf, et les
     * huit autres partaient garnir des anneaux deja pleins. Le compte total
     * revenait bien a 166, mais l'anneau qu'on venait de vider restait vide —
     * autrement dit, l'endroit ou l'on chasse est le seul qui ne se repeuple
     * pas. C'est exactement l'inverse de ce que le repeuplement existe pour
     * faire.
     *
     * On regarde donc quel anneau est le plus loin de son compte et on fait
     * naitre LA. Les nombres viennent de `PEUPLEMENT`, qui les declare deja :
     * rien de nouveau n'est invente ici, on cesse simplement de les ignorer. */
    const manquant = () => {
      const vus = {};
      for (const m of this.monstres) if (!m.salle && m.biome) vus[m.biome] = (vus[m.biome] || 0) + 1;
      let pire = null, ecartMax = 0;
      for (const b of Object.keys(monde.PEUPLEMENT)) {
        const d = monde.PEUPLEMENT[b].nombre - (vus[b] || 0);
        if (d > ecartMax) { ecartMax = d; pire = b; }
      }
      return pire;
    };
    while (sauvages() < voulu && essais < 200) {
      essais++;
      const b = manquant();
      if (!b) break;
      const m = monde.naitDans(b, this.alea);
      if (!m) break;
      /* ---- LA MEME BORNE QUE POUR LE SOCLE, ET POUR LA MEME RAISON ----
       * La lave est un disque de 768 unites de rayon : la regle des 900 y
       * interdit TOUTE naissance des qu'un joueur s'y trouve. L'anneau le plus
       * dur du jeu se vidait donc a mesure qu'on le nettoyait, et ne se
       * remplissait qu'une fois qu'on l'avait quitte — c'est-a-dire quand ca
       * ne servait plus a rien. */
      const ecart = monde.ecartDeNaissance(m.espece, dmin);
      let tropPres = false;
      for (const j of this.joueurs.values()) {
        const dx = j.x - m.x, dy = j.y - m.y;
        if (dx * dx + dy * dy < ecart * ecart) { tropPres = true; break; }
      }
      if (tropPres) continue;
      const t = monde.MONSTRES[m.espece];
      /* Ni dans un rocher : un colosse de rayon 78 ne du dans un bloc y
         resterait pour toujours, immobile, et se lirait comme un monstre
         casse plutot que comme un monstre coince. */
      if (monde.bloque(this.obstacles, m.x, m.y, t.rayon)) continue;
      this.monstres.push(this._naissance(m));
      nes++;
    }
    return nes;
  }
}

module.exports = { Realm, PAS_MS, MARGE_VITESSE };
