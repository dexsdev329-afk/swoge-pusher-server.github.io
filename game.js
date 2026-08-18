'use strict';
/*
 * Game logic: player balances, provably-fair coin values, winnings.
 *
 * Balance model (all in $SWOGE wei, BigNumber):
 *   deposit  → balance += amount
 *   drop     → balance -= DROP_COST     (and a provably-fair value is locked on the coin)
 *   win      → balance += coinValue     (when the coin is pushed off the front)
 *   withdraw → balance -= amount, cumulativeAuthorized += amount
 *              (the signed voucher authorizes cumulativeAuthorized; the contract
 *               pays cumulative − alreadyWithdrawnOnChain, so it's replay-safe)
 *
 * Provably-fair:
 *   serverSeed (secret) + serverSeedHash (public, sent to clients)
 *   value = POOL[ HMAC(serverSeed, clientSeed:nonce) mod POOL.length ]
 *   Rotating the seed reveals the old serverSeed so players can verify history.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const cfg = require('./config');
const journal = require('./journal');
const casino = require('./casino');
const hilo = require('./hilo');
const mines = require('./mines');
const plinko = require('./plinko');
const boulier = require('./boulier');
const { Salle: BoulierSalle } = require('./boulier_salle');
const crash = require('./crash');
const p4 = require('./puissance4');
/* Les trois duels partagent la meme interface de moteur : une Partie qui sait
   rejoindre, jouer, ticker et dire qui a gagne. C'est ce qui permet a un seul
   chemin d'argent de les servir tous les trois. */
const paris = require('./paris');
const boutique = require('./boutique');
const skins = require('./skins');
const personnages = require('./personnages');
/* Le bareme d'XP d'un objet, par rarete. Une rarete inconnue ne rapporte rien
   plutot que de rapporter le premier bareme venu : une faute de frappe dans
   une clef doit se voir, pas se payer. */
function xpDeRarete(cle) { return (cfg.XP_OBJET || {})[String(cle)] || 0; }
const DUELS = { p4, mp: require('./morpion'), dm: require('./dames'),
                mf: require('./morpion_fantome'),
                dc: require('./dernier_chiffre') };
const ATTENTE = p4.ATTENTE, EN_COURS = p4.EN_COURS, FINIE = p4.FINIE;
const volcano = require('./volcano');
const { Entrainement } = require('./entrainement');

const WEI = (n) => ethers.utils.parseUnits(String(n), cfg.DECIMALS);
const COST = WEI(cfg.DROP_COST);
const SPIN_COST = WEI(cfg.SPIN_COST || '1');
const MINW = WEI(cfg.MIN_WITHDRAW);
const BN = (n) => ethers.BigNumber.from(n);
const MS_YEAR = BN('31536000000'); // 365*24*3600*1000

class Game {
  constructor() {
    /* Les paris sportifs. Ils vivent plus longtemps qu'une manche : poses
       aujourd'hui, regles apres le match. */
    this.paris = []; this.parisRegles = {}; this.parisSeq = 0;
    /* Les credits envoyes depuis le panneau, sur la fenetre glissante. Ils
       sont l'enveloppe : les perdre au redemarrage rendrait le plafond
       contournable d'un simple redeploiement. */
    this.dons = [];
    /* LE REGISTRE DES EMIS. { id d'objet : nombre deja sorti }, pour toute la
       plateforme. C'est lui qui fait exister les plafonds : sans un compteur
       GLOBAL, chaque inventaire ne connait que sa propre quantite et personne
       ne sait combien de Void Fruits existent. Il vit dans la tete de l'etat,
       pas dans les fiches — il n'appartient a aucun joueur. */
    /* Les compteurs de touches. En tete d'etat et non par joueur : la question
       est « quelle rangee sert », pas « que fait tel joueur ». */
    this.taps = {};
    /* Les annonces du marche. En tete d'etat : elles n'appartiennent a
       personne une fois posees — l'objet est sorti de l'inventaire du vendeur
       et attend son acheteur. */
    this.marche = [];
    this.marcheNo = 1;
    this.boutiqueEmis = {};
    /* LES TROIS PREMIERES LIGNES. Une entree par gagnant, dans l'ordre :
       { addr, nom, famille, prix, t }. C'est cette liste qui dit combien de
       places restent — pas un compteur a cote, qui pourrait diverger. */
    this.boutiqueLignes = [];
    this.players = new Map(); // addr -> { balance, cumulativeAuthorized, clientSeed, nonce, name, dayNet, dayKey, dropsToday, winsToday, questClaimed, hasDeposited }
    this.telegramMap = new Map(); // telegramId (string) -> addr, so the Adsgram reward postback can find the account
    this.seenTx = new Set();  // dedupe deposits
    this.lastBlock = 0;       // deposit-scan watermark (persisted so a restart resumes)
    this._stakeRateBps = BN(cfg.STAKE_APR_BPS);
    // progressive jackpot (all wei)
    this.jackpotPot = WEI(cfg.JACKPOT_SEED);
    this._jackpotSeed = WEI(cfg.JACKPOT_SEED);
    this._rakeWei = COST.mul(Math.round(cfg.JACKPOT_RAKE_PCT * 100)).div(10000); // pct, 2-dec
    /* La cagnotte du Boulier. Elle vit a part du jackpot du Coin Pusher : les
       deux montent avec les mises de leur propre jeu, et les melanger ferait
       payer un plein a 90 boules avec l'argent des pieces poussees. */
    this.boulierPot = WEI(cfg.BOULIER_CAGNOTTE_AMORCE);
    this.boulierPleins = [];   // les derniers pleins, pour la page et l'admin
    /* La salle : un tirage, tout le monde dessus. Elle ne connait ni les
       soldes ni les sockets — elle compte le temps et tire. */
    this.boulierSalle = new BoulierSalle({
      graine: cfg.BOULIER_GRAINE || undefined,
      attenteMs: cfg.BOULIER_ATTENTE_MS, tirageMs: cfg.BOULIER_TIRAGE_MS,
      apresMs: cfg.BOULIER_APRES_MS,
    });
    /* Secret des jetons de session. Il vit avec l'etat : sans ca, chaque
       redeploiement deconnecterait tous les joueurs d'un coup. */
    this.sessionSecret = cfg.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    /* La graine de la chaine du Crash vit avec l'etat, comme le secret de
       session : la regenerer a chaque redeploiement casserait l'engagement
       publie, et donc la seule chose qui prouve aux joueurs que les manches a
       venir sont deja ecrites. */
    this.crashGraine = cfg.CRASH_GRAINE || crypto.randomBytes(32).toString('hex');
    this._rotateSeed();
    this._crashTable();
    /* Les parties de Connect 4. Elles ne sont PAS sauvegardees avec l'etat :
       une partie interrompue par un redemarrage rendrait les deux mises (voir
       _p4Rendre), parce qu'une grille a moitie jouee dont les deux joueurs ont
       ete deconnectes n'a plus d'arbitre. */
    this.p4 = new Map();
    /* Les fiches touchees depuis la derniere sauvegarde. Le magasin la vide
       quand il a fini d'ecrire — et seulement s'il a reussi. */
    this.sales = new Set();
    this.p4Seq = 0;
    /* LES TABLES D'ENTRAINEMENT. Elles vivent a cote des duels payants, pas
       dedans : aucun solde ne les traverse, rien n'y est sauvegarde, et elles
       meurent avec le processus. Le seul lien avec la maison est le tirage du
       Dernier Chiffre, qui a besoin de la graine du serveur. */
    this.entrainement = new Entrainement({
      tirage: (partie) => this._tirageDuel(partie),
    });
    /* Le total preleve sur les retraits depuis toujours. Il ne bouge aucun
       solde — il reste dans le coffre — mais c'est le chiffre a bruler. */
    this.fraisCumules = BN(0);
    this.brule = BN(0);          // ce qui est DEJA parti a l'adresse morte
    this.brulages = [];          // les dernieres transactions, pour pouvoir les montrer
  }

  /** (Re)construit la table du Crash a partir de la graine courante. */
  _crashTable() {
    this.crash = new crash.Table({
      graine: this.crashGraine, longueur: cfg.CRASH_CHAINE, sel: cfg.CRASH_SEL,
      edgeBps: cfg.CRASH_EDGE_BPS, plafond: cfg.CRASH_PLAFOND,
      vitesse: cfg.CRASH_VITESSE, attenteMs: cfg.CRASH_ATTENTE_MS,
      apresMs: cfg.CRASH_APRES_MS,
    });
  }

  /**
   * Une fiche qui n'a JAMAIS RIEN FAIT.
   *
   * ---- pourquoi cette question se pose ----
   *
   * Ouvrir un compte ne coute rien : on fabrique une paire de cles chez soi
   * et on signe une phrase. Pas de gaz, pas de transaction, pas de courriel.
   * Le serveur ne peut donc pas distinguer un faux compte d'un vrai AU
   * MOMENT DE LA CONNEXION — a cet instant ils sont identiques.
   *
   * Et chaque fiche pese 559 octets dans un fichier qui est REECRIT EN ENTIER
   * toutes les dix secondes, par un JSON.stringify qui bloque le seul fil
   * d'execution. Vingt mille fiches vides, c'est une seconde de gel a chaque
   * sauvegarde ; deux cent mille, c'est dix secondes toutes les dix secondes,
   * et plus aucune partie ne tourne.
   *
   * On ne filtre donc pas a l'entree — c'est impossible — mais A L'ECRITURE.
   * La difference entre un vrai joueur et une ferme n'apparait que lorsqu'il
   * FAIT quelque chose ; on garde tout ce qui a fait quelque chose, et rien
   * d'autre. Le credit d'essai ne compte pas : il est donne, pas gagne.
   */
  /**
   * Les familles deja completes d'un inventaire, pour les fiches d'avant le
   * registre `xpFamilles`.
   *
   * Posseder une famille entiere ne peut vouloir dire qu'une chose : le bonus
   * a deja ete verse, puisqu'il part a l'instant exact ou la derniere piece
   * arrive. Reconstituer la marque a la lecture evite une migration du fichier
   * ET evite le trou inverse — sans elle, il suffirait de revendre une piece
   * et de la retirer pour encaisser une deuxieme fois les deux mille points.
   */
  static _famillesPossedees(objets) {
    const m = {};
    for (const f of boutique.FAMILLES) {
      const l = boutique.ITEMS.filter((o) => o.famille === f.cle);
      if (l.length && l.every((o) => (objets || {})[o.id])) m[f.cle] = 1;
    }
    return m;
  }

  static estVide(p) {
    if (!p) return true;
    const z = (w) => !w || ethers.BigNumber.from(w).isZero();
    return p.balance.lte(WEI(String(cfg.WELCOME_BONUS || 0)))
      && !p.hasDeposited && z(p.deposited)
      && z(p.wagered) && !(p.betCount > 0)
      && !p.nomChoisi && !p.visage && !p.photo
      && !(p.amis || []).length && !(p.demandes || []).length && !(p.envoyees || []).length
      && !p.parrain && !(p.filleuls || []).length
      && !(p.stakes || []).length && z(p.stakeAccrued) && z(p.stakeClaimTotal)
      && z(p.cumulativeAuthorized) && !p.tgId
      && z(p.refDu) && z(p.refTotal) && !(p.attente || []).length
      /* ---- L'XP COMPTE COMME UNE TRACE ----
       *
       * Sans cette ligne, une fiche qui n'a QUE de l'XP — le joueur qui se
       * connecte tous les jours et fait ses quetes sans jamais miser — passe
       * pour vide : elle n'est pas ecrite au fichier, et elle est purgee de la
       * memoire. Sa serie et sa progression disparaissent au redemarrage.
       *
       * C'est exactement le joueur que la separation de l'XP et du volume
       * existe pour rendre possible, et il etait le seul que le systeme
       * effacait. Trouve par le test de redemarrage, pas a la lecture. */
      && !(p.xp > 0) && !(p.streakDay > 0) && !Object.keys(p.objets || {}).length
      && !Object.keys(p.skins || {}).length;
  }

  /**
   * Retire de la memoire les fiches qui n'ont jamais rien fait.
   *
   * `protegees` porte les adresses actuellement connectees : retirer la fiche
   * de quelqu'un qui est devant son ecran lui reprendrait son credit d'essai
   * au milieu de sa visite. Elles reviendront a la purge suivante s'il n'a
   * toujours rien fait.
   */
  purge(protegees) {
    let n = 0;
    for (const [addr, p] of this.players) {
      if (protegees && protegees.has(addr)) continue;
      if (Game.estVide(p)) { this.players.delete(addr); n++; }
    }
    return n;
  }

  /** Snapshot the whole state for persistence (BigNumbers → strings). */
  /**
   * UNE fiche, telle qu'elle est ecrite.
   *
   * Elle est sortie de `serialize()` pour qu'on puisse en ecrire une seule.
   * Reecrire vingt mille fiches parce que trente ont bouge coute, a vingt
   * mille joueurs, sept cents millisecondes pendant lesquelles le serveur ne
   * repond a personne — mesure, pas suppose.
   *
   * Rend null pour une fiche vide : c'est la seule barriere entre un script
   * qui ouvre mille comptes par minute et un fichier de soldes trop lourd
   * pour etre sauve.
   */
  fiche(addr) {
    const p = this.players.get(String(addr).toLowerCase());
    if (!p || Game.estVide(p)) return null;
    return {
        b: p.balance.toString(), c: p.cumulativeAuthorized.toString(),
        s: p.clientSeed, n: p.nonce, name: p.name, nc: !!p.nomChoisi,
        /* Le nom a ete PAYE. Sans ca au fichier, le joueur repaierait mille
           jetons a chaque redeploiement, et personne ne comprendrait pourquoi. */
        np: !!p.nomPaye,
        dn: p.dayNet.toString(), dk: p.dayKey,
        dt: p.dropsToday, wt: p.winsToday, qc: p.questClaimed, hd: p.hasDeposited,
        pe: p.primesEntrainement,
        mij: p.miseJour || {}, fac: p.face || {},
        vi: p.visage || null, am: p.amis || [], ph: !!p.photo,
        dm: p.demandes || [], en: p.envoyees || [],
        pa: p.parrain || null, fi: p.filleuls || [],
        rd: (p.refDu || BN(0)).toString(), rt: (p.refTotal || BN(0)).toString(),
        rc: p.revCumul || 0, rp: p.revPaye || 0, att: p.attente || [],
        rec: p.record || null, mj: p.meilleurJour || null, rb: !!p.refBienvenue,
        bb: (p.bonusBloque || BN(0)).toString(), bc2: p.bonusCible ? p.bonusCible.toString() : null,
        mk: p.moisCle || null, mm: p.moisMise || 0,
        sct: (p.stakeClaimTotal || BN(0)).toString(), tnl: p.trNonLus || 0,
        stk: p.stakes.map((x) => [x.a.toString(), x.s, x.u]), sa: p.stakeAccrued.toString(),
        tw: (p.wagered || ethers.BigNumber.from(0)).toString(), bc: p.betCount || 0,
        /* Le niveau ACQUIS. Sans lui au fichier, la marque se reperdrait a
           chaque redemarrage et serait recalculee sur la courbe du moment —
           donc le durcissement retrograderait tout le monde au premier
           deploiement suivant. */
        nx: p.nivMax || 0,
        dp: (p.deposited || ethers.BigNumber.from(0)).toString(), jx: p.jeux || {},
        bj: p.bj || null, vm: p.volcanoMeter || 0,
        ob: p.objets || {},
        sk: p.skins || undefined, ska: p.skinActif || undefined,
        /* Le volume par skin part en chaine wei, comme p.wagered lui-meme —
           meme raison : un BigNumber ne traverse pas JSON.stringify tout
           seul. */
        pr: (p.persos && Object.keys(p.persos).length)
          ? Object.keys(p.persos).reduce((o, id) => { const c = p.persos[id];
              o[id] = { w: (c.w || ethers.BigNumber.from(0)).toString(),
                        ef: c.ef || undefined, ea: c.ea || undefined }; return o; }, {})
          : undefined,
        tg: p.tgId || null,
        wg: !!p.welcomeGranted, ww: !!p.welcomeWagered, wc: !!p.welcomeClaimed,
        /* L'XP GAGNEE part au fichier ; l'XP du volume ne part PAS, elle se
           recalcule. Persister une somme deja derivable, c'est se donner deux
           verites a tenir d'accord. */
        xp: p.xp || 0, xps: p.xpSources || undefined, xpf: p.xpFilleuls || undefined,
        xo: p.xpObjets || undefined,
        xfa: p.xpFamilles || undefined,
        cof: p.coffreOffertJour || null, jc: p.jourColl || undefined,
        cre: p.creeLe || undefined, pj: p.parfaitJour || undefined,
        sd: p.streakDay || 0, sl: p.streakLastClaimDay || null,
        ac: p.adCount || 0, ak: p.adDayKey || null, al: p.adLastMs || 0,
    };
  }

  /** Tout l'etat SAUF les fiches : c'est petit, et ca s'ecrit a chaque fois. */
  serializeTete() {
    /* Les duels en cours ne sont PAS rejoues au redemarrage — une grille a
       moitie jouee dont les deux joueurs ont ete deconnectes n'a plus
       d'arbitre. Mais les MISES, elles, ont bel et bien quitte les soldes et
       sont ecrites sur le disque : sans cette liste, un redemarrage au milieu
       d'une partie faisait disparaitre la table AVEC l'argent. On garde donc
       le strict necessaire pour rembourser a la relecture. */
    const duels = [];
    for (const m of this.p4.values()) {
      if (m.phase === FINIE) continue;
      duels.push({ id: m.id, jeu: m.jeu || 'p4', mise: m.mise,
                   joueurs: m.joueurs.filter(Boolean) });
    }
    return { v: 1, serverSeed: this.serverSeed, sessionSecret: this.sessionSecret,
             taps: this.taps || {},
             marche: this.marche || [], marcheNo: this.marcheNo || 1,
             boutiqueEmis: this.boutiqueEmis || {},
             boutiqueLignes: this.boutiqueLignes || [],
             compta: this._comptaEcrite(), tunnel: this.tunnel || {},
             prixVerses: this.prixVerses || {},
             graines: this.graines || [], graineDepuis: this.graineDepuis || null,
             manchesGraine: this.manchesGraine || 0,
             /* Les paris traversent les jours : sans eux dans la sauvegarde,
                un redeploiement le vendredi soir efface tout ce qui a ete
                pose pour le samedi. */
             paris: this.paris || [], parisRegles: this.parisRegles || {},
             parisSeq: this.parisSeq || 0,
             dons: this.dons || [],
             jackpotPot: this.jackpotPot.toString(),
             boulierPot: this.boulierPot.toString(),
             boulierPleins: this.boulierPleins || [],
             boulierSalle: this.boulierSalle.sauve(),
             crashGraine: this.crashGraine, crash: this.crash.sauve(),
             fraisCumules: (this.fraisCumules || BN(0)).toString(),
             brule: (this.brule || BN(0)).toString(), brulages: this.brulages || [],
             lastBlock: this.lastBlock, seenTx: Array.from(this.seenTx),
             usage: this.usage || {},
             duels, telegramMap: Array.from(this.telegramMap) };
  }

  /** L'etat COMPLET, tete et fiches. L'export, l'import et l'instantane de
   *  secours passent par la ; la sauvegarde courante, non. */
  serialize() {
    const players = [];
    let vides = 0;
    for (const addr of this.players.keys()) {
      const f = this.fiche(addr);
      if (!f) { vides++; continue; }
      players.push([addr, f]);
    }
    if (vides > 100) console.log(`[store] ${vides} fiche(s) vide(s) non ecrite(s)`);
    const tete = this.serializeTete();
    tete.players = players;
    return tete;
  }

  /** Restore a snapshot produced by serialize() (called once at startup). */
  /**
   * REMPLACE tout l'etat par celui d'une archive. C'est la restauration.
   *
   * ---- pourquoi ce n'est pas hydrate() ----
   *
   * hydrate() AJOUTE : il pose les fiches de l'archive par-dessus celles qui
   * sont deja en memoire. C'est ce qu'il faut au demarrage — la memoire est
   * vide. Ce n'est surtout pas ce qu'il faut pour une restauration : les
   * joueurs qui existent aujourd'hui mais pas dans l'archive resteraient la,
   * avec leur solde d'aujourd'hui, melanges a des soldes d'hier. On croirait
   * avoir restaure ; on aurait fabrique un etat qui n'a jamais existe.
   *
   * On construit donc une instance NEUVE, on l'hydrate, et on transplante ses
   * champs un par un. Tout ce qui existe sur un Game frais est remplace, donc
   * rien de l'ancien ne survit par oubli — pas meme un champ ajoute plus tard
   * dont on aurait oublie de s'occuper ici.
   */
  remplace(st) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.players))
      throw new Error('this file is not a SWOGE state (no players list)');
    const neuf = new Game();
    neuf.hydrate(st);
    const avant = this.players.size;
    for (const k of Object.keys(this)) delete this[k];
    for (const k of Object.keys(neuf)) this[k] = neuf[k];
    return { avant, apres: this.players.size };
  }

  hydrate(st) {
    if (!st) return;
    /* Le secret fixe par l'environnement l'emporte : c'est ainsi qu'on revoque
       toutes les sessions d'un coup, en le changeant sur le serveur. */
    if (st.sessionSecret && !cfg.SESSION_SECRET) this.sessionSecret = st.sessionSecret;
    /* Sans cette ligne, un redemarrage remettrait tous les compteurs a zero
       et les plafonds ne borneraient plus rien — le pire des defauts
       silencieux : la boutique continuerait de fonctionner. */
    if (st.taps && typeof st.taps === 'object') this.taps = st.taps;
    /* Les annonces DOIVENT traverser une sauvegarde : l'objet a quitte
       l'inventaire du vendeur. Les perdre, c'est les detruire. */
    if (Array.isArray(st.marche)) this.marche = st.marche;
    if (st.marcheNo) this.marcheNo = st.marcheNo;
    if (st.boutiqueEmis && typeof st.boutiqueEmis === 'object') this.boutiqueEmis = st.boutiqueEmis;
    /* Sans cette ligne, un redemarrage ROUVRIRAIT la course et repaierait
       quatre-vingt-dix millions, sans rien afficher d'anormal. */
    if (Array.isArray(st.boutiqueLignes)) this.boutiqueLignes = st.boutiqueLignes;
    if (st.serverSeed) { this.serverSeed = st.serverSeed; this.serverSeedHash = crypto.createHash('sha256').update(st.serverSeed).digest('hex'); }
    /* Les graines revelees survivent a tout : elles sont la SEULE facon pour
       un joueur de verifier une manche d'il y a six mois. Les perdre au
       redemarrage reviendrait a retirer la preuve apres l'avoir donnee. */
    if (st.compta) this.compta = st.compta;
    if (st.usage) this.usage = st.usage;
    if (Array.isArray(st.paris)) this.paris = st.paris;
    if (st.parisRegles) this.parisRegles = st.parisRegles;
    if (st.parisSeq) this.parisSeq = st.parisSeq;
    if (Array.isArray(st.dons)) this.dons = st.dons;
    if (st.tunnel) this.tunnel = st.tunnel;
    if (st.prixVerses) this.prixVerses = st.prixVerses;
    if (Array.isArray(st.graines)) this.graines = st.graines;
    if (st.graineDepuis) this.graineDepuis = st.graineDepuis;
    if (st.manchesGraine) this.manchesGraine = st.manchesGraine;
    if (st.jackpotPot) this.jackpotPot = ethers.BigNumber.from(st.jackpotPot);
    /* La cagnotte se relit telle quelle, meme a zero — un `if (st.boulierPot)`
       la remettrait a un million au premier redemarrage suivant un plein, et
       la maison offrirait le cadeau d'ouverture a chaque deploiement. */
    if (st.boulierPot !== undefined && st.boulierPot !== null)
      this.boulierPot = ethers.BigNumber.from(st.boulierPot);
    if (Array.isArray(st.boulierPleins)) this.boulierPleins = st.boulierPleins;
    /* La salle reprend son NUMERO DE MAILLON, pas ses joueurs. Un maillon
       rejoue serait deux manches identiques ; une manche a moitie inscrite dont
       tout le monde a ete deconnecte n'a plus d'arbitre. La fenetre
       d'inscription dure dix secondes, l'exposition est donc de dix secondes —
       la meme que celle du Crash, qui fait pareil depuis toujours. */
    if (st.boulierSalle) this.boulierSalle.charge(st.boulierSalle);
    /* La graine d'environnement l'emporte, comme pour le secret de session :
       c'est ainsi qu'on repart sur une chaine neuve volontairement. Sinon on
       reprend celle de l'etat, et l'index sauve evite de rejouer un maillon
       deja consomme — le meme maillon deux fois, ce serait la meme manche. */
    if (st.crashGraine && !cfg.CRASH_GRAINE) { this.crashGraine = st.crashGraine; this._crashTable(); }
    if (st.crash) this.crash.charge(st.crash);
    if (st.lastBlock) this.lastBlock = st.lastBlock;
    if (Array.isArray(st.seenTx)) this.seenTx = new Set(st.seenTx);
    if (st.fraisCumules) this.fraisCumules = ethers.BigNumber.from(st.fraisCumules);
    if (st.brule) this.brule = ethers.BigNumber.from(st.brule);
    if (Array.isArray(st.brulages)) this.brulages = st.brulages;
    if (Array.isArray(st.players)) for (const [addr, d] of st.players) {
      this.players.set(addr, {
        balance: ethers.BigNumber.from(d.b || '0'),
        cumulativeAuthorized: ethers.BigNumber.from(d.c || '0'),
        clientSeed: d.s || crypto.randomBytes(8).toString('hex'),
        nonce: d.n || 0, name: d.name || addr.slice(0, 6),
        /* Les etats ecrits avant cette marque n'ont pas de `nc`. Un nom qui
           n'est pas le debut de l'adresse a forcement ete choisi : on le
           reconnait, sinon les joueurs deja nommes perdraient leur nom a la
           premiere connexion suivant la mise a jour. */
        nomChoisi: d.nc !== undefined ? !!d.nc : !!(d.name && d.name !== addr.slice(0, 6)),
        dayNet: ethers.BigNumber.from(d.dn || '0'), dayKey: d.dk || null,
        dropsToday: d.dt || 0, winsToday: d.wt || 0, questClaimed: d.qc || {}, hasDeposited: !!d.hd,
        primesEntrainement: d.pe || {},
        miseJour: (d.mij && typeof d.mij === 'object') ? d.mij : {},
        face: (d.fac && typeof d.fac === 'object') ? d.fac : {},
        visage: d.vi || null, amis: Array.isArray(d.am) ? d.am : [], photo: !!d.ph,
        demandes: Array.isArray(d.dm) ? d.dm : [], envoyees: Array.isArray(d.en) ? d.en : [],
        parrain: d.pa || null, filleuls: Array.isArray(d.fi) ? d.fi : [],
        refDu: ethers.BigNumber.from(d.rd || '0'), refTotal: ethers.BigNumber.from(d.rt || '0'),
        revCumul: Number(d.rc || 0), revPaye: Number(d.rp || 0),
        attente: Array.isArray(d.att) ? d.att : [],
        record: d.rec || null, meilleurJour: d.mj || null, refBienvenue: !!d.rb,
        objets: (d.ob && typeof d.ob === 'object') ? d.ob : {},
        skins: (d.sk && typeof d.sk === 'object') ? d.sk : {},
        persos: (d.pr && typeof d.pr === 'object')
          ? Object.keys(d.pr).reduce((o, id) => { const c = d.pr[id] || {};
              o[id] = { w: ethers.BigNumber.from(c.w || '0'),
                        ef: c.ef || null, ea: c.ea || null }; return o; }, {})
          : {},
        skinActif: d.ska || null,
        bonusBloque: ethers.BigNumber.from(d.bb || '0'),
        bonusCible: d.bc2 ? ethers.BigNumber.from(d.bc2) : null,
        moisCle: d.mk || null, moisMise: Number(d.mm || 0),
        stakeClaimTotal: ethers.BigNumber.from(d.sct || '0'), trNonLus: d.tnl || 0,
        stakes: Array.isArray(d.stk)
          ? d.stk.map((x) => ({ a: ethers.BigNumber.from(x[0]), s: x[1], u: x[2] }))
          : (d.st && d.st !== '0' // migrate old single-stake format → one locked position
              ? [{ a: ethers.BigNumber.from(d.st), s: d.ss || Date.now(), u: (d.ss || Date.now()) + cfg.STAKE_LOCK_DAYS * 86400000 }]
              : []),
        stakeAccrued: ethers.BigNumber.from(d.sa || '0'),
        wagered: ethers.BigNumber.from(d.tw || '0'), betCount: d.bc || 0,
        /* Fiche relue du disque, donc anterieure au durcissement : si elle ne
           porte pas encore de niveau acquis, on le retrouve avec la courbe qui
           etait en vigueur. C'est la SEULE occasion ou l'ancienne courbe sert,
           et elle ne sert qu'une fois par joueur. */
        nomPaye: !!d.np,
        nivMax: d.nx !== undefined ? d.nx
          : Game._niveauHerite(ethers.BigNumber.from(d.tw || '0')),
        deposited: ethers.BigNumber.from(d.dp || '0'), jeux: d.jx || {},
        bj: d.bj || null, volcanoMeter: d.vm || 0,
        tgId: d.tg || null,
        welcomeGranted: !!d.wg, welcomeWagered: !!d.ww, welcomeClaimed: !!d.wc,
        xp: Number(d.xp) || 0, xpSources: d.xps || {}, xpFilleuls: d.xpf || {},
        xpObjets: d.xo || {},
        xpFamilles: d.xfa || Game._famillesPossedees(d.ob || {}),
        coffreOffertJour: d.cof || null,
        jourColl: d.jc || { coffres: 0, neufs: 0, rarete: 0 },
        creeLe: d.cre || 0, parfaitJour: d.pj || null,
        streakDay: d.sd || 0, streakLastClaimDay: d.sl || null,
        adCount: d.ac || 0, adDayKey: d.ak || null, adLastMs: d.al || 0,
      });
    }
    if (Array.isArray(st.telegramMap)) this.telegramMap = new Map(st.telegramMap.map((e) => [String(e[0]), String(e[1]).toLowerCase()]));

    /* Les duels interrompus par l'arret : on ne reprend pas la partie — sans
       arbitre ni joueurs connectes, une grille a moitie jouee ne veut plus
       rien dire — mais ON REND LES MISES. Elles avaient quitte les soldes
       avant l'arret ; sans ce remboursement elles disparaissaient avec la
       table, et personne ne pouvait meme dire ou. */
    if (Array.isArray(st.duels)) {
      let rendues = 0, sommes = 0;
      for (const d of st.duels) {
        for (const a of (d.joueurs || [])) {
          if (!a) continue;
          const p = this._p(a);
          p.balance = p.balance.add(WEI(d.mise));
          sommes += Number(d.mise) || 0;
        }
        rendues++;
      }
      if (rendues) console.log(`[duels] ${rendues} partie(s) interrompue(s) : ${sommes} $SWOGE rendus`);
    }
  }

  _today() { return new Date().toISOString().slice(0, 10); } // UTC day key
  // UTC day key shifted by `n` days (n<0 = past). Used for streak "was yesterday?".
  _dayShift(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
  // Called every time a player actually stakes a bet — unlocks the welcome claim.
  // Appele a chaque mise reelle : debloque le bonus de bienvenue ET cumule le
  // total joue a vie (affiche dans le tableau de bord admin).
  _markWager(p, wei, jeu) {
    if (!p) return;
    /* Le compteur AVANT le tirage. C'est le seul endroit traverse par tous les
       jeux au moment ou la mise part, donc avant qu'aucune carte ne soit
       tiree : en le notant ici et en relisant le compteur a la fin de la
       manche, on obtient la PLAGE exacte de numeros utilises. Noter seulement
       le compteur final serait faux des qu'un jeu tire plusieurs fois — au
       blackjack, une main en consomme une dizaine. */
    p.nonceDebut = p.nonce;
    if (!p.welcomeWagered) p.welcomeWagered = true;
    /* La mise du jour, JEU PAR JEU : c'est le compteur des missions. Il se
       tient ici et nulle part ailleurs, pour la meme raison que le reste —
       un jeu qui oublierait de passer par la ne compterait deja ni pour le
       niveau ni pour le tunnel, ce qui se voit tout de suite. */
    /* Le skin PORTE accumule ce volume comme le sien — c'est ce qui fait
       « progression par classe » : jouer avec Landwolf actif ne fait pas
       monter Pepe. Rien ne se passe si aucun skin n'est porte — la mise
       compte toujours pour le compte, elle ne compte simplement pour
       aucune classe. */
    if (wei && p.skinActif) {
      p.persos = p.persos || {};
      const c = p.persos[p.skinActif] || (p.persos[p.skinActif] = { w: BN(0), ef: null, ea: null });
      c.w = (c.w || BN(0)).add(wei);
    }
    if (jeu && wei) {
      this._bumpDay(p);
      if (!p.miseJour) p.miseJour = {};
      p.miseJour[jeu] = (p.miseJour[jeu] || 0) + Number(ethers.utils.formatUnits(wei, cfg.DECIMALS));
    }
    if (wei) {
      /* La PREMIERE mise de sa vie : le dernier passage du tunnel, et celui
         qui separe un curieux d'un joueur. */
      if (!(p.betCount > 0) && p.addr) this.noteTunnel('premieresMises', p.addr);
      /* On compare des niveaux ACQUIS, pas des niveaux calcules. Un joueur
         fige au-dessus de la courbe — parce qu'il avait deja atteint son
         niveau avant qu'elle soit durcie — verrait sinon defiler des montees
         de niveau pour des paliers qu'il a depuis longtemps depasses. */
      const avant = this._niveauAcquis(p, Game.niveauDe(Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS))));
      p.wagered = (p.wagered || BN(0)).add(wei); p.betCount = (p.betCount || 0) + 1;
      /* La montee se constate ICI, au seul endroit ou l'experience bouge. On
         la met de cote plutot que de la notifier : _markWager est appele en
         plein milieu d'une manche, et une fenetre qui s'ouvre a cet instant
         couvrirait le jeu. Le serveur la ramasse une fois la manche finie. */
      const apres = this._niveauAcquis(p, Game.niveauDe(Number(ethers.utils.formatUnits(p.wagered, cfg.DECIMALS))));
      if (apres > avant && p.addr) {
        if (!this.montees) this.montees = [];
        this.montees.push({ addr: p.addr, de: avant, a: apres,
                            palier: Game.PALIERS[Math.min(Math.floor((apres - 1) / 10), 9)],
                            nouveauPalier: Math.floor((apres - 1) / 10) !== Math.floor(Math.max(0, avant - 1) / 10) });
      }
    }
    this._libereCadeau(p);
  }
  /**
   * Comptabilite PAR JEU. Le serveur ne retenait qu'un total de mises, tous
   * jeux confondus : impossible de dire si un joueur gagne anormalement
   * quelque part, ni meme a quoi il joue. On enregistre une manche a la fois,
   * au moment ou elle se conclut.
   *
   * `mise` et `rendu` sont des NOMBRES, pas des wei : ce sont des chiffres
   * d'affichage, jamais des soldes, et personne ne paie avec.
   */
  /* `opts` sert aux jeux dont l'argent ne part pas et ne revient pas dans le
     meme instant. Le Coin Pusher en est un : on lache une piece maintenant,
     et une piece — pas forcement la sienne — tombe plus tard. Les deux moments
     doivent compter, mais une seule fois chacun.
       • suite       : ce versement prolonge une manche deja comptee. On
                       enregistre l'argent, pas une deuxieme manche.
       • sansJournal : pas de ligne d'historique. Trois cents chutes a un jeton
                       noieraient l'onglet « Rounds » et cacheraient tout le
                       reste ; les compteurs, eux, ont besoin de chacune. */
  _manche(p, jeu, mise, rendu, opts) {
    if (!p || !jeu) return;
    const suite = !!(opts && opts.suite);
    /* Le seul point de passage de TOUTES les manches, tous jeux confondus :
       c'est donc ici que le journal se remplit, et nulle part ailleurs. Un
       nouveau jeu qui appelle _manche est journalise sans rien avoir a
       ajouter — et un jeu qui oublierait de l'appeler ne compterait deja pas
       dans les statistiques, ce qui se voit. */
    if (p.addr && !(opts && opts.sansJournal)) journal.ajoute(p.addr, { k: 'r', g: jeu, m: Number(mise) || 0, p: Number(rendu) || 0,
      /* De quoi refaire le calcul soi-meme, une fois la graine du serveur
         revelee : son empreinte, la graine du joueur, et les numeros utilises
         par cette manche. */
      sh: this.serverSeedHash, cs: p.clientSeed,
      n0: p.nonceDebut == null ? p.nonce : p.nonceDebut, n1: p.nonce });
    this.manchesGraine = (this.manchesGraine || 0) + 1;
    this.noteJeu(p, jeu, mise, rendu, suite);
    /* LE point de passage du revenu. Il vaut pour les jeux contre la banque
       comme pour le 1v1 : la somme des mises moins la somme des rendus EST ce
       que la maison garde, commission comprise. */
    this.note('mises', Number(mise) || 0, p.addr);
    this.note('rendus', Number(rendu) || 0, p.addr);
    if (!suite) this.note('manches', 1);
    /* Le volume du MOIS. Il se remet a zero tout seul au changement de mois :
       un classement mensuel qu'il faut penser a reinitialiser finit toujours
       par afficher le mois d'avant. */
    const mc = Game.moisCle();
    if (p.moisCle !== mc) { p.moisCle = mc; p.moisMise = 0; }
    p.moisMise = (p.moisMise || 0) + (Number(mise) || 0);

    if (!p.jeux) p.jeux = {};
    const j = p.jeux[jeu] || (p.jeux[jeu] = { n: 0, mise: 0, rendu: 0, gagne: 0, nul: 0 });
    if (!suite) j.n++;
    j.mise += Number(mise) || 0;
    j.rendu += Number(rendu) || 0;
    if (!suite) {
      if (rendu > mise) j.gagne++;
      else if (rendu === mise) j.nul++;
    }

    /* Le plus gros gain d'une vie de joueur. On le retient au moment ou il
       arrive : le recalculer plus tard voudrait dire relire tout le journal,
       et une statistique qui coute une lecture de fichier ne s'affiche
       jamais. */
    const gain = (Number(rendu) || 0) - (Number(mise) || 0);
    if (gain > 0 && (!p.record || gain > p.record.g))
      p.record = { g: gain, x: mise > 0 ? Number((rendu / mise).toFixed(2)) : 0, j: jeu, t: Date.now() };

    this._revenuParrain(p, jeu, mise, rendu);
  }

  /* ------------------------------------------------------------ parrainage
   *
   * Ce que le parrain touche vient du REVENU reel du filleul, pas de ses
   * depots ni de son volume. Deux consequences qui font tout le systeme :
   *
   *  • se parrainer soi-meme ne rapporte rien. Pour se verser dix pour cent
   *    de ses propres pertes, il faut d'abord en perdre cent. Aucune regle
   *    anti-triche a ecrire : la triche est perdante par construction ;
   *
   *  • un filleul qui GAGNE fait baisser le compteur. Mais on ne reprend
   *    jamais ce qui a ete verse : on garde une ligne d'eau — le plus haut
   *    niveau deja paye — et on ne paie que ce qui la depasse. Un gros coup
   *    du filleul suspend les gains du parrain le temps que le compteur
   *    repasse au-dessus, sans jamais mettre personne en dette.
   */
  _revenuParrain(p, jeu, mise, rendu) {
    if (!p || !p.parrain || !p.hasDeposited) return;
    const parrain = this.players.get(p.parrain);
    if (!parrain) return;

    const rev = Game.PVP[jeu]
      ? (Number(mise) || 0) * (cfg.REFERRAL_PVP_BPS / 10000)
      : (Number(mise) || 0) - (Number(rendu) || 0);
    if (!isFinite(rev)) return;

    p.revCumul = (p.revCumul || 0) + rev;

    /* ---- le filleul se refait : on reprend ce qui n'est pas encore mur ----
     *
     * Sans ca, une part est versee des la manche perdue, et si le filleul
     * reprend tout le lendemain la maison a paye sur un revenu qu'elle n'a
     * plus. Ce qui est deja MUR, en revanche, ne se reprend jamais : le
     * parrain ne peut pas se retrouver en dette. */
    if (p.revCumul < (p.revPaye || 0)) {
      let manque = ((p.revPaye || 0) - p.revCumul) * (cfg.REFERRAL_BPS / 10000);
      const seaux = p.attente || [];
      while (manque > 1e-9 && seaux.length) {
        const dernier = seaux[seaux.length - 1];
        if (dernier[1] <= manque + 1e-9) { manque -= dernier[1]; seaux.pop(); }
        else { dernier[1] -= manque; manque = 0; }
      }
      /* La ligne d'eau redescend d'autant : ce revenu-la est a regagner. Ce
         qui a deja muri reste acquis, donc la ligne ne descend pas plus bas
         que ce qu'on a pu reprendre. */
      const repris = ((p.revPaye || 0) - p.revCumul) * (cfg.REFERRAL_BPS / 10000) - manque;
      p.revPaye = (p.revPaye || 0) - repris / (cfg.REFERRAL_BPS / 10000);
      return;
    }
    if (p.revCumul <= (p.revPaye || 0)) return;         // rien de neuf a verser

    /* La part depend du niveau du PARRAIN : c'est lui qu'on recompense. */
    const du = (p.revCumul - (p.revPaye || 0)) * (this.partParrainage(p.parrain) / 10000);
    p.revPaye = p.revCumul;
    /* Le revenu vient de monter : c'est peut-etre le moment ou la maison a
       fini de gagner le cadeau du filleul. */
    this._libereCadeau(p);
    if (!(du > 0)) return;

    /* Le gain part EN ATTENTE, range par jour. Un seau par jour et non par
       manche : sept jours de parties feraient sinon des milliers de lignes
       pour un seul filleul. */
    const jour = Math.floor(Date.now() / 86400000);
    if (!Array.isArray(p.attente)) p.attente = [];
    const dernier = p.attente[p.attente.length - 1];
    if (dernier && dernier[0] === jour) dernier[1] += du;
    else {
      p.attente.push([jour, du]);
      /* ---- LE PARRAIN APPREND QUE SON FILLEUL LUI RAPPORTE ----
       *
       * Une seule fois par filleul et par jour : c'est le seau du jour qui
       * vient de s'ouvrir. Annoncer chaque manche ferait des centaines de
       * messages pour un joueur actif, et un signal qu'on coupe ne signale
       * plus rien.
       *
       * On ne fait qu'une NOTE ici — game.js ne connait aucune socket. Le
       * serveur la ramasse, comme il ramasse deja les montees de niveau. */
      (this.gainsParrain = this.gainsParrain || [])
        .push({ parrain: p.parrain, filleul: p.name || null });
    }
  }

  /** Les filleuls qui ont commence a rapporter depuis la derniere fois qu'on
   *  a regarde. Se vide en le lisant, comme `montéesRecentes`. */
  gainsParrainRecents() { const g = this.gainsParrain || []; this.gainsParrain = []; return g; }

  /**
   * Fait murir ce qui a passe le delai : les seaux assez vieux quittent le
   * filleul et deviennent encaissables chez le parrain.
   *
   * Aucun minuteur : on regarde au moment ou quelqu'un demande. Un gain qui
   * murit pendant que personne ne regarde n'a pas besoin d'evenement.
   */
  _murit(addr) {
    const p = this._p(addr);
    const limite = Math.floor(Date.now() / 86400000) - Math.max(0, cfg.REFERRAL_HOLD_DAYS);
    for (const f of (p.filleuls || [])) {
      const q = this._p(f);
      if (!Array.isArray(q.attente) || !q.attente.length) continue;
      const reste = [];
      let mur = 0;
      for (const seau of q.attente) {
        if (seau[0] <= limite) mur += seau[1];
        else reste.push(seau);
      }
      if (mur > 0) {
        const w = WEI(mur.toFixed(6));
        p.refDu = (p.refDu || BN(0)).add(w);
        p.refTotal = (p.refTotal || BN(0)).add(w);
        q.attente = reste;
      }
    }
  }

  /**
   * Le cadeau de parrainage se debloque-t-il ?
   *
   * ---- pourquoi ce n'est PAS un simple volume a miser ----
   *
   * Une mise a atteindre se contourne par le jeu le moins cher : miser vingt
   * mille au blackjack, dont l'avantage maison est d'un demi pour cent, ne
   * coute que cent — pour un cadeau de cinq cents. Le verrou serait joli sur
   * le papier et la recolte resterait rentable.
   *
   * On demande donc la seule chose qui ne se contourne pas : QUE LA MAISON
   * AIT REELLEMENT GAGNE LE MONTANT DU CADEAU sur ce joueur. C'est deja
   * compte, exactement, pour le parrainage (`revCumul`). Impossible de
   * debloquer cinq cents sans en avoir fait perdre cinq cents — quel que
   * soit le jeu choisi.
   *
   * Reste le joueur honnete et chanceux, qui gagne et ne debloquerait jamais.
   * Pour lui, une sortie de secours au VOLUME : au bout de deux cents fois le
   * cadeau mise, le compte est de toute facon largement rentable, meme au jeu
   * le moins cher.
   */
  _libereCadeau(p) {
    if (!p || !p.bonusBloque || p.bonusBloque.lte(0)) return;
    const cadeau = Number(cfg.REFERRAL_WELCOME) || 0;
    const gagne = (p.revCumul || 0) >= cadeau;
    const volume = p.bonusCible && (p.wagered || BN(0)).gte(p.bonusCible);
    if (gagne || volume) { p.bonusBloque = BN(0); p.bonusCible = null; }
  }

  /* ======================================================================
   * LA COMPTABILITE DU MOIS
   *
   * ---- pourquoi le solde d'un joueur ne dit RIEN ----
   *
   * « Il depose 100 000, il lui en reste 80 000, donc il a perdu 20 000 » est
   * faux, et c'est le piege central. La variation d'un solde melange CINQ
   * choses : les depots, les retraits, le resultat des jeux, le rendement du
   * staking, et les envois entre joueurs. Le meme joueur repasse « positif »
   * le mois suivant sans avoir joue une seule fois, simplement parce qu'il a
   * redepose ou touche son rendement.
   *
   * ---- ce qu'on compte, alors ----
   *
   * Le REVENU, c'est ce que la maison garde : mises moins rendus. Un seul
   * point de passage suffit — _manche — et il vaut aussi pour le 1v1 : la
   * somme des mises des deux joueurs moins la somme de ce qui leur est rendu
   * EST la commission, sans avoir a la compter a part.
   *
   * Les COUTS, c'est ce que la maison donne sans contrepartie : rendement de
   * staking, bonus, parrainage, jackpots.
   *
   * Et les DEPOTS ET RETRAITS NE SONT NI L'UN NI L'AUTRE. Un depot de 100 000
   * n'enrichit personne : la maison le DOIT. Les compter comme un gain est
   * l'erreur qui fait couler les casinos — on se croit riche de l'argent des
   * joueurs.
   * ====================================================================== */
  _mois(cle) {
    if (!this.compta) this.compta = {};
    const k = cle || Game.moisCle();
    if (!this.compta[k]) this.compta[k] = {
      mises: 0, rendus: 0,                      // revenu = mises - rendus
      staking: 0, bonus: 0, parrainage: 0, jackpots: 0,   // ce qu'on donne
      /* Les credits envoyes depuis le panneau. Ils COUTENT, au meme titre
         qu'un bonus : les ranger dans le bilan les rendrait invisibles au
         resultat du mois, et un resultat qui ignore ce qu'on donne se lit
         comme un benefice. */
      cadeaux: 0,
      depots: 0, retraits: 0, brule: 0,         // bilan, PAS resultat
      manches: 0, joueurs: {},
    };
    return this.compta[k];
  }
  /**
   * Le detail par joueur, reduit a ce qui se lit.
   *
   * Sans borne, il refait exactement le probleme qu'on vient de retirer : une
   * ligne par compte, dans un fichier reecrit en entier toutes les dix
   * secondes. Vingt mille comptes vides le faisaient repasser de 0,3 Ko a
   * 1,8 Mo — mon propre test l'a attrape.
   *
   * On garde les deux cents plus gros de chaque cote. Personne n'a jamais lu
   * la trois-centieme ligne d'un tableau, et ce detail n'est qu'un confort :
   * la verite, elle, est au journal, qui n'oublie rien.
   */
  static _tailleDetail() { return 200; }
  _comptaEcrite() {
    const out = {};
    for (const k of Object.keys(this.compta || {})) {
      const m = this.compta[k];
      const noms = Object.keys(m.joueurs || {});
      let gardes = noms;
      if (noms.length > Game._tailleDetail() * 2) {
        const poids = (a) => Math.abs((m.joueurs[a].mises || 0) - (m.joueurs[a].rendus || 0))
                           + (m.joueurs[a].staking || 0) + (m.joueurs[a].bonus || 0);
        gardes = noms.sort((a, b) => poids(b) - poids(a)).slice(0, Game._tailleDetail() * 2);
      }
      const j = {};
      for (const a of gardes) j[a] = m.joueurs[a];
      out[k] = Object.assign({}, m, { joueurs: j });
    }
    return out;
  }

  /* ==================== CE QUI EST JOUE, ET PAR COMBIEN ====================
   *
   * La comptabilite existante compte l'ARGENT, par mois : mises, rendus,
   * staking. Elle ne dit pas QUEL JEU. Treize jeux tournent, et la seule facon
   * de savoir lequel sert etait de lire les journaux joueur par joueur.
   *
   * Consequence concrete, et c'est ce qui a decide d'ecrire ceci : le bareme du
   * Coin Pusher a ete rerregle sur un raisonnement, sans qu'aucun chiffre ne
   * puisse dire ensuite si ca a change quoi que ce soit. On ne saura jamais
   * pour hier ; on saura pour demain.
   *
   * Trois decisions :
   *
   *  1. PAR JOUR ET PAR JEU. Le mois est trop grossier pour voir l'effet d'un
   *     changement, l'heure trop fine pour quinze joueurs.
   *  2. LES JOUEURS DISTINCTS, pas seulement les manches. Mille manches d'une
   *     seule personne et mille manches de cent personnes sont deux mondes, et
   *     le total ne les distingue pas. On garde donc les adresses vues — mais
   *     bornees : au-dela de PLAFOND_VUS on cesse de les retenir et on compte
   *     ce qui deborde, ce qui est dit dans le resultat plutot que cache.
   *  3. QUATRE-VINGT-DIX JOURS. De quoi comparer un avant et un apres sans
   *     faire grossir l'etat sans fin.
   */
  noteJeu(p, jeu, mise, rendu, suite) {
    if (!jeu) return;
    const jour = new Date().toISOString().slice(0, 10);
    const u = this.usage || (this.usage = {});
    const d = u[jour] || (u[jour] = {});
    const g = d[jeu] || (d[jeu] = { m: 0, mise: 0, rendu: 0, vus: {}, plus: 0 });
    /* `suite` : un versement qui prolonge une manche deja comptee. L'argent
       compte, la manche non — sinon le Coin Pusher afficherait deux fois plus
       de parties qu'il n'y a eu de chutes. */
    if (!suite) g.m++;
    g.mise = Number((g.mise + (Number(mise) || 0)).toFixed(6));
    g.rendu = Number((g.rendu + (Number(rendu) || 0)).toFixed(6));
    const a = p && p.addr;
    if (a) {
      if (g.vus[a]) g.vus[a]++;
      else if (Object.keys(g.vus).length < Game.PLAFOND_VUS) g.vus[a] = 1;
      else g.plus++;
    }
    /* On elague ici plutot que par une minuterie : le nettoyage suit l'usage,
       un serveur qui ne joue pas n'a rien a nettoyer. */
    const cles = Object.keys(u);
    if (cles.length > Game.JOURS_USAGE) {
      cles.sort();
      for (const k of cles.slice(0, cles.length - Game.JOURS_USAGE)) delete u[k];
    }
  }

  static get PLAFOND_VUS() { return 400; }
  static get JOURS_USAGE() { return 90; }

  /**
   * Le tableau, pret a lire : un jour, une ligne par jeu, du plus joue au
   * moins joue. `net` est ce que la maison garde — mises moins rendus.
   */
  usageJour(jour) {
    const d = (this.usage || {})[jour] || {};
    return Object.keys(d).map((jeu) => {
      const g = d[jeu];
      const distincts = Object.keys(g.vus || {}).length;
      return { jeu, manches: g.m, joueurs: distincts, auDela: g.plus || 0,
               mise: Number(g.mise.toFixed(6)), rendu: Number(g.rendu.toFixed(6)),
               net: Number((g.mise - g.rendu).toFixed(6)),
               retour: g.mise > 0 ? Number((g.rendu / g.mise * 100).toFixed(2)) : null };
    }).sort((a, b) => b.manches - a.manches);
  }

  /** Les jours connus, du plus recent au plus ancien. */
  usageJours() { return Object.keys(this.usage || {}).sort().reverse(); }

  /** Note un mouvement au mois en cours. `qui` sert au detail par joueur. */
  note(quoi, montant, qui) {
    const v = Number(montant) || 0;
    if (!v) return;
    const m = this._mois();
    m[quoi] = Number(((m[quoi] || 0) + v).toFixed(6));
    if (qui) {
      const j = m.joueurs[qui] || (m.joueurs[qui] = { mises: 0, rendus: 0, staking: 0, bonus: 0 });
      if (j[quoi] !== undefined) j[quoi] = Number((j[quoi] + v).toFixed(6));
    }
  }

  /**
   * Le compte du mois, pret a lire.
   *
   * `resultat` est le seul chiffre qui reponde a « le casino a-t-il gagne de
   * l'argent ce mois-ci ». Tout le reste est du detail ou du bilan.
   */
  comptes(cle) {
    const k = cle || Game.moisCle();
    const m = (this.compta && this.compta[k]) || this._mois(k);
    const revenu = Number((m.mises - m.rendus).toFixed(6));
    const couts = Number((m.staking + m.bonus + m.parrainage + m.jackpots +
                          (m.cadeaux || 0)).toFixed(6));
    return {
      mois: k,
      /* le revenu */
      mises: m.mises, rendus: m.rendus, revenu, manches: m.manches,
      /* ce qui est donne */
      staking: m.staking, bonus: m.bonus, parrainage: m.parrainage, jackpots: m.jackpots,
      cadeaux: m.cadeaux || 0,
      couts,
      resultat: Number((revenu - couts).toFixed(6)),
      /* le bilan — ni gain ni perte */
      depots: m.depots, retraits: m.retraits, brule: m.brule,
      /* les dix joueurs qui ont le plus rapporte ce mois-ci, et les dix qui
         ont le plus coute : c'est la meme question posee dans les deux sens */
      joueurs: Object.keys(m.joueurs).map((a) => ({
        address: a,
        resultat: Number((m.joueurs[a].mises - m.joueurs[a].rendus).toFixed(6)),
        recu: Number((m.joueurs[a].staking + m.joueurs[a].bonus).toFixed(6)),
      })).sort((x, y) => y.resultat - x.resultat),
    };
  }

  /* ======================================================================
   * LE TUNNEL — ou les gens s'arretent
   *
   * Savoir ce qu'on gagne ne dit pas OU CA COINCE. Quatre chiffres par jour y
   * repondent : combien ouvrent une page, combien branchent un portefeuille,
   * combien deposent, combien misent une premiere fois. Les trois passages
   * entre ces quatre-la designent le probleme — le trafic, la friction du
   * portefeuille, ou le premier depot — et evitent de depenser son energie au
   * mauvais endroit.
   *
   * Les adresses vues du jour vivent EN MEMOIRE seulement : c'est un
   * ensemble qui se vide chaque jour, et l'ecrire recreerait exactement le
   * poids qu'on vient de retirer du fichier.
   * ====================================================================== */
  _jour(cle) {
    if (!this.tunnel) this.tunnel = {};
    const k = cle || new Date().toISOString().slice(0, 10);
    if (!this.tunnel[k]) this.tunnel[k] = {
      pages: 0, connexions: 0, nouveaux: 0, deposants: 0, premieresMises: 0, depose: 0,
    };
    return this.tunnel[k];
  }
  /** Une adresse ne compte qu'une fois par jour pour un passage donne. */
  _uneFois(quoi, addr) {
    const jour = new Date().toISOString().slice(0, 10);
    if (!this._vus || this._vusJour !== jour) { this._vus = new Set(); this._vusJour = jour; }
    const cle = quoi + ':' + addr;
    if (this._vus.has(cle)) return false;
    this._vus.add(cle);
    return true;
  }
  noteTunnel(quoi, addr, montant) {
    const j = this._jour();
    if (addr && !this._uneFois(quoi, String(addr).toLowerCase())) return;
    j[quoi] = (j[quoi] || 0) + 1;
    if (montant) j.depose = Number(((j.depose || 0) + Number(montant)).toFixed(6));
    /* On ne garde pas l'histoire complete : soixante jours suffisent a voir
       une tendance, et le fichier ne doit pas grossir sans fin. */
    const cles = Object.keys(this.tunnel).sort();
    while (cles.length > 60) delete this.tunnel[cles.shift()];
  }

  /** Le tunnel des derniers jours, avec les taux de passage. */
  tunnelJours(combien) {
    const cles = Object.keys(this.tunnel || {}).sort().reverse().slice(0, combien || 14);
    return cles.map((k) => {
      const j = this.tunnel[k];
      const t = (a, b) => (b > 0 ? Number((a / b * 100).toFixed(1)) : null);
      return Object.assign({ jour: k }, j, {
        tauxConnexion: t(j.connexions, j.pages),
        tauxDepot: t(j.deposants, j.connexions),
        tauxPremiereMise: t(j.premieresMises, j.deposants),
      });
    });
  }

  /* ======================================================================
   * LE PRIX DU CLASSEMENT
   *
   * Une part du revenu du mois, partagee entre les premiers au volume. Une
   * PART et non un montant fixe : le prix ne peut alors jamais couter plus
   * que ce que le mois a rapporte. Un mois creux paie peu, un mois plein
   * paie bien, et la maison ne peut pas se retrouver a distribuer de
   * l'argent qu'elle n'a pas gagne.
   * ====================================================================== */
  cagnotte(cle) {
    const c = this.comptes(cle);
    const brut = Math.max(0, c.revenu) * (cfg.PRIX_CLASSEMENT_BPS / 10000);
    return Number(brut.toFixed(6));
  }

  /** Qui gagnerait quoi si le mois se terminait maintenant. */
  prixClassement(cle) {
    const k = cle || Game.moisCle();
    const total = this.cagnotte(k);
    const parts = cfg.PRIX_PARTS;
    const somme = parts.reduce((a, b) => a + b, 0) || 100;
    /* Le classement d'un mois PASSE ne se relit pas depuis les compteurs
       courants (ils ont ete remis a zero) : on le reconstruit depuis le
       detail garde avec les comptes. */
    let liste;
    if (k === Game.moisCle()) {
      liste = this.classementMois(null, parts.length).top;
    } else {
      const m = (this.compta || {})[k] || { joueurs: {} };
      liste = Object.keys(m.joueurs || {})
        .map((a) => ({ address: a, mise: m.joueurs[a].mises || 0, name: this._p(a).name }))
        .sort((x, y) => y.mise - x.mise).slice(0, parts.length)
        .map((r, i) => Object.assign(r, { rang: i + 1 }));
    }
    return {
      mois: k, cagnotte: total, part: cfg.PRIX_CLASSEMENT_BPS / 100,
      verse: !!(this.prixVerses && this.prixVerses[k]),
      gagnants: liste.map((r, i) => ({
        rang: i + 1, address: r.address, name: r.name, mise: r.mise,
        prix: Number((total * (parts[i] || 0) / somme).toFixed(6)),
      })),
    };
  }

  /**
   * Verse le prix d'un mois. UNE SEULE FOIS — un prix paye deux fois est de
   * l'argent cree, et personne ne s'en plaindrait assez vite pour qu'on le
   * remarque.
   */
  verseClassement(cle) {
    const k = cle || Game.moisCle();
    if (!this.prixVerses) this.prixVerses = {};
    if (this.prixVerses[k]) throw new Error('prize already paid for ' + k);
    const p = this.prixClassement(k);
    if (!(p.cagnotte > 0)) throw new Error('nothing to share for ' + k);
    const payes = [];
    for (const g of p.gagnants) {
      if (!(g.prix > 0)) continue;
      const w = WEI(g.prix.toFixed(6));
      const q = this._p(g.address);
      q.balance = q.balance.add(w);
      journal.ajoute(g.address, { k: 'rf', s: 'classement', m: g.prix.toFixed(6), rang: g.rang, mois: k });
      payes.push({ rang: g.rang, address: g.address, name: q.name, prix: g.prix });
    }
    this.note('bonus', p.cagnotte);
    this.prixVerses[k] = { t: Date.now(), total: p.cagnotte, n: payes.length };
    return { mois: k, total: p.cagnotte, gagnants: payes };
  }

  /** Les mois dont on a une trace, du plus recent au plus ancien. */
  moisConnus() { return Object.keys(this.compta || {}).sort().reverse(); }

  /* ======================================================================
   * LES CENT NIVEAUX
   *
   * L'experience est le volume mise, qui est deja compte depuis toujours :
   * chacun a donc son vrai niveau des le premier jour, sans migration et sans
   * avoir rien perdu. Et il ne se triche pas — chaque point coute l'avantage
   * de la maison.
   * ====================================================================== */
  static get PALIERS() {
    return ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond',
            'Master', 'Champion', 'Legend', 'Mythic', 'SWOLE'];
  }
  /** Le volume cumule qu'il faut pour atteindre le niveau n. */
  static volumePour(n) {
    const x = Math.max(1, Math.min(cfg.NIVEAU_MAX, Number(n) || 1));
    return cfg.NIVEAU_BASE * Math.pow(x, cfg.NIVEAU_PUISSANCE);
  }
  /** Le niveau que donne un volume. Conserve pour la migration et les tests :
   *  c'est la courbe D'AVANT l'XP, celle qui ne connaissait que la depense. */
  static niveauDe(volume) {
    const v = Number(volume) || 0;
    if (v < cfg.NIVEAU_BASE) return 0;
    /* Le petit epsilon n'est pas cosmetique : `pow(1788854/50, 1/3.5)` rend
       19,999999998 et non 20. Sans lui, le joueur qui atteint EXACTEMENT le
       seuil reste au niveau precedent — et c'est precisement le moment ou il
       regarde. */
    const n = Math.floor(Math.pow(v / cfg.NIVEAU_BASE, 1 / cfg.NIVEAU_PUISSANCE) + 1e-9);
    return Math.max(0, Math.min(cfg.NIVEAU_MAX, n));
  }

  /* ======================================================================
   * L'XP
   * ======================================================================
   *
   * Le niveau se lit desormais sur une somme :
   *
   *     xp total  =  xp derive du volume mise  +  xp gagne par les gestes
   *
   * Le premier terme n'est pas stocke : il se RECALCULE du volume cumule, qui
   * existait deja. Rien a migrer, rien qui puisse diverger d'un compteur
   * parallele, et un joueur ne peut pas perdre de niveau parce qu'aucun des
   * deux termes ne descend jamais.
   */

  /** L'XP qu'il faut pour atteindre le niveau n. */
  static xpPour(n) {
    const x = Math.max(1, Math.min(cfg.NIVEAU_MAX, Number(n) || 1));
    return cfg.XP_BASE * Math.pow(x, cfg.XP_PUISSANCE);
  }

  /**
   * Le volume mise, traduit en XP.
   *
   * L'exposant est le RAPPORT des deux puissances, ce qui fait que la
   * traduction rend exactement l'ancien niveau. Ce n'est pas un reglage a
   * gout : c'est la seule valeur qui ne retrograde ni ne promeut personne le
   * jour de la bascule. La verifier est d'ailleurs un test a soi seul.
   */
  static xpDuVolume(volume) {
    const v = Number(volume) || 0;
    if (v <= 0) return 0;
    const e = cfg.XP_PUISSANCE / cfg.NIVEAU_PUISSANCE;
    return cfg.XP_BASE * Math.pow(v / cfg.NIVEAU_BASE, e) * (cfg.XP_VOLUME_BONUS || 1);
  }

  /** Le niveau que donne une XP totale. */
  static niveauDeXp(xp) {
    const x = Number(xp) || 0;
    if (x < cfg.XP_BASE) return 0;
    const n = Math.floor(Math.pow(x / cfg.XP_BASE, 1 / cfg.XP_PUISSANCE) + 1e-9);
    return Math.max(0, Math.min(cfg.NIVEAU_MAX, n));
  }

  /** L'XP totale d'une fiche : le volume traduit, plus ce qui a ete gagne. */
  _xpTotale(p) {
    const v = Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS));
    return Game.xpDuVolume(v) + Math.max(0, Number(p.xp) || 0);
  }

  /**
   * LE SEUL ENDROIT QUI DONNE DE L'XP.
   *
   * Un point d'entree unique, et non un `p.xp +=` dispersé dans cinq
   * methodes : c'est ce qui permet de garder le detail par source, donc de
   * repondre plus tard a « d'ou vient la progression des joueurs » sans
   * rejouer l'historique. Et un plafond negatif impossible : l'XP ne se
   * reprend pas, y compris si un appelant se trompe de signe.
   *
   * Rend le niveau AVANT et APRES, pour que l'appelant puisse annoncer une
   * montee sans la recalculer — et sans risquer de la calculer autrement.
   */
  _gagneXp(p, montant, source) {
    const m = Math.max(0, Math.round(Number(montant) || 0));
    if (!m) return null;
    const avant = this.niveauDeFiche(p);
    p.xp = (Number(p.xp) || 0) + m;
    p.xpSources = p.xpSources || {};
    p.xpSources[source] = (p.xpSources[source] || 0) + m;
    const apres = this.niveauDeFiche(p);
    return { gagne: m, source, avant, apres, monte: apres > avant };
  }

  /** Le niveau d'une fiche, acquis compris. Sert a `_gagneXp` et a `niveau`. */
  niveauDeFiche(p) {
    return this._niveauAcquis(p, Game.niveauDeXp(this._xpTotale(p)));
  }

  /**
   * Le niveau d'un joueur, avec de quoi l'afficher : son palier, et surtout
   * CE QU'IL RESTE A FAIRE. Un niveau sans la marche suivante ne donne envie
   * de rien ; « encore 293 970 mises » se vise.
   */
  /**
   * LE NIVEAU ACQUIS.
   *
   * Un niveau atteint ne se reprend pas — y compris quand la courbe est
   * durcie. Sans cette marque, monter la difficulte retrograderait tous les
   * joueurs existants d'un coup : celui qui etait niveau 34 se reveillerait
   * niveau 21, sans rien avoir fait, et c'est exactement la punition que tout
   * le systeme de niveaux est concu pour eviter.
   *
   * La marque se pose a la premiere lecture, avec la courbe QUI ETAIT EN
   * VIGUEUR. La retrouver depuis l'ancienne puissance est la seule facon
   * d'etre juste : figer le joueur a son niveau calcule aujourd'hui reviendrait
   * a le retrograder puis a graver la retrogradation.
   */
  _niveauAcquis(p, calcule) {
    if (!cfg.NIVEAU_ACQUIS) return calcule;
    if (!(p.nivMax > calcule)) p.nivMax = calcule;      // il monte, il ne descend pas
    return p.nivMax;
  }

  /**
   * La migration, et le piege qu'elle cachait.
   *
   * Elle ne s'applique QU'AUX FICHES RELUES DU DISQUE — celles qui existaient
   * donc avant le durcissement. Ma premiere version la posait paresseusement,
   * a la premiere lecture de n'importe quelle fiche : un joueur NEUF avec le
   * meme volume heritait alors de l'ancienne courbe et arrivait niveau 34 au
   * lieu de 21. Le durcissement n'aurait servi a rien, et personne ne l'aurait
   * vu avant des semaines.
   */
  static _niveauHerite(wagered) {
    const v = Number(ethers.utils.formatUnits(wagered || BN(0), cfg.DECIMALS));
    const av = cfg.NIVEAU_PUISSANCE_AVANT;
    if (!v || v < cfg.NIVEAU_BASE || !(av > 0)) return 0;
    return Math.max(0, Math.min(cfg.NIVEAU_MAX,
      Math.floor(Math.pow(v / cfg.NIVEAU_BASE, 1 / av) + 1e-9)));
  }

  niveau(addr) {
    const p = this._p(addr);
    const v = Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS));
    const xp = this._xpTotale(p);
    const n = this._niveauAcquis(p, Game.niveauDeXp(xp));
    const suivant = Math.min(cfg.NIVEAU_MAX, n + 1);
    const bas = n === 0 ? 0 : Game.xpPour(n);
    const haut = Game.xpPour(suivant);
    const max = n >= cfg.NIVEAU_MAX;
    return {
      niveau: n,
      palier: Game.PALIERS[Math.min(Math.floor(Math.max(0, n - 1) / 10), 9)],
      palierNo: Math.min(Math.floor(Math.max(0, n - 1) / 10) + 1, 10),
      /* L'XP est ce que la page affiche desormais. Le volume reste rendu :
         il est devenu une STATISTIQUE parmi d'autres, ce qu'il aurait toujours
         du etre, et la page en a encore besoin ailleurs. */
      xp: Math.round(xp),
      xpVolume: Math.round(Game.xpDuVolume(v)),
      xpGagne: Math.max(0, Math.round(Number(p.xp) || 0)),
      sources: p.xpSources || {},
      volume: Number(v.toFixed(2)),
      seuil: Math.round(bas),
      prochain: max ? null : Math.round(haut),
      restant: max ? 0 : Math.max(0, Math.round(haut - xp)),
      progression: max ? 100 : Number(Math.max(0, Math.min(100, (xp - bas) / (haut - bas) * 100)).toFixed(1)),
      max,
    };
  }

  /* ---- ce que le niveau ouvre ----
   * On ne code ici que ce qui NE COUTE RIEN a la maison. Tout avantage
   * monetaire doit rester indexe sur ce que le joueur rapporte, sinon on
   * refait la dette du staking en plus petit. */

  /** Les montees de niveau depuis la derniere fois qu'on a regarde. */
  montéesRecentes() { const m = this.montees || []; this.montees = []; return m; }

  /** La photo personnelle : un depot OU le niveau 5. Le niveau est le
   *  meilleur filtre des deux — il demande d'avoir joue, pas seulement
   *  d'etre passe. */
  peutTeleverser(addr) {
    return !cfg.AVATAR_REQUIRE_DEPOSIT || this._p(addr).hasDeposited || this.niveau(addr).niveau >= 5;
  }

  /** Le retrait minimum baisse avec le palier — pure commodite, cout nul. */
  minRetraitDe(addr) {
    const n = this.niveau(addr).niveau;
    const base = Number(cfg.MIN_WITHDRAW);
    if (n >= 40) return Math.max(2000, base / 5);
    if (n >= 20) return Math.max(5000, base / 2);
    return base;
  }

  /** La part de parrainage monte d'un point PAR PALIER : 10 % a Bronze,
   *  20 % a SWOLE. Elle reste un pourcentage du REVENU, donc elle ne peut
   *  jamais couter plus que ce que le filleul a rapporte. */
  partParrainage(addr) {
    const t = cfg.REFERRAL_PALIER_BPS;
    if (!t || !t.length) return cfg.REFERRAL_BPS;
    const i = Math.max(1, this.niveau(addr).palierNo || 1) - 1;
    return t[Math.min(i, t.length - 1)];
  }

  /** Les jeux ou l'argent va d'un joueur a l'autre, pas a la banque. */
  static get PVP() { return { p4: true, poker: true, mp: true, dm: true }; }

  static moisCle(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
  }

  /**
   * Le classement du mois, au VOLUME MISE.
   *
   * Pas au gain : classer sur les gains, c'est classer sur la chance, et le
   * meme joueur y monte et descend sans rien changer a sa facon de jouer. Le
   * volume, lui, ne depend que de ce qu'on a fait — et c'est la seule mesure
   * qu'un joueur peut reconnaitre comme la sienne.
   *
   * Le demandeur recoit TOUJOURS son propre rang, meme s'il est trois-centieme :
   * un classement ou l'on ne se trouve pas ne sert a personne.
   */
  classementMois(addr, limite) {
    const mc = Game.moisCle();
    const moi = String(addr || '').toLowerCase();
    /* ---- UNE SEULE FABRICATION PAR SECONDE ----
     * Ce calcul parcourt TOUS les joueurs, les trie, et coute 6,6 ms a vingt
     * mille fiches. Node n'a qu'un fil : cent cinquante demandes par seconde
     * — qu'une seule socket envoie sans effort — suffisent a saturer un coeur
     * et a ne plus servir personne. Or le classement ne change pas de facon
     * perceptible en une seconde. On le fabrique donc au plus une fois par
     * seconde et tout le monde recoit le meme, ce qui ramene le cout par
     * demande a rien. */
    const t = Date.now();
    if (!this._clCache || this._clCache.mois !== mc || t - this._clCache.t > 1000) {
      const liste = [];
      for (const [a, p] of this.players) {
        const v = p.moisCle === mc ? (p.moisMise || 0) : 0;
        if (v > 0) liste.push({ address: a, name: p.name, visage: p.visage || null,
                                photo: !!p.photo, mise: v });
      }
      liste.sort((x, y) => y.mise - x.mise);
      liste.forEach((r, i) => { r.rang = i + 1; });
      this._clCache = { t, mois: mc, liste };
    }
    const arr = this._clCache.liste;
    const mien = arr.find((r) => r.address === moi) || null;
    return { mois: mc, joueurs: arr.length, top: arr.slice(0, limite || 50), moi: mien };
  }

  /**
   * Le code d'invitation d'un joueur. Son NOM s'il en a choisi un — c'est
   * lui qu'on partage de vive voix et qu'on retape sans se tromper — sinon
   * huit caracteres de son adresse.
   */
  codeParrain(addr) {
    const p = this._p(addr);
    return p.nomChoisi && p.name ? p.name : String(addr).toLowerCase().slice(2, 10);
  }

  /** L'adresse derriere un code d'invitation, ou null. */
  resoutCode(code) {
    const c = String(code || '').trim();
    if (!c) return null;
    if (/^0x[0-9a-fA-F]{40}$/.test(c)) return c.toLowerCase();
    const cle = Game.cleNom(c);
    for (const [a, p] of this.players) {
      if (p.nomChoisi && p.name && Game.cleNom(p.name) === cle) return a;
      if (a.slice(2, 10) === c.toLowerCase()) return a;
    }
    return null;
  }

  /**
   * Attache un filleul a son parrain. UNE SEULE FOIS, pour la vie : laisser
   * changer de parrain, c'est laisser deux joueurs se renvoyer le meme
   * filleul et ouvrir une negociation la ou il n'y a qu'un fait.
   */
  lieParrain(filleul, code) {
    const f = String(filleul).toLowerCase();
    const p = this._p(f);
    if (p.parrain) throw new Error('you already have a sponsor');
    const cible = this.resoutCode(code);
    if (!cible) throw new Error('no such invite code');
    if (cible === f) throw new Error('you cannot invite yourself');
    const q = this._p(cible);
    if (q.parrain === f) throw new Error('you two cannot sponsor each other');
    p.parrain = cible;
    if (!Array.isArray(q.filleuls)) q.filleuls = [];
    if (q.filleuls.indexOf(f) < 0) q.filleuls.push(f);
    /* Le compteur repart de zero a l'attache : le parrain ne touche rien sur
       ce qui a ete joue avant lui. */
    p.revCumul = 0; p.revPaye = 0;
    return { parrain: cible, nom: q.name };
  }

  /** Ce que le parrain voit : son lien, ses filleuls, ce qu'ils rapportent. */
  parrainage(addr) {
    const a = String(addr).toLowerCase();
    this._murit(a);
    const p = this._p(a);
    /* SA part a lui, pas celle de tout le monde : afficher 10 % a un joueur
       qui en touche 18 le ferait douter du compte affiche juste a cote. */
    const part = this.partParrainage(a);
    const liste = (p.filleuls || []).map((f) => {
      const q = this._p(f);
      return {
        address: f, name: q.name, visage: q.visage || null, photo: !!q.photo,
        depose: !!q.hasDeposited,
        /* Ce que CE filleul a deja rapporte, et non ce qu'il a perdu : c'est
           la seule facon de rendre le calcul verifiable par le parrain. */
        rapporte: ethers.utils.formatUnits(WEI(Math.max(0, (q.revPaye || 0) * (part / 10000)).toFixed(6)), cfg.DECIMALS),
        // ce qui, chez lui, n'a pas encore passe le delai
        attente: Number(((q.attente || []).reduce((n, x) => n + x[1], 0)).toFixed(6)),
      };
    });
    const parrain = p.parrain ? { address: p.parrain, name: this._p(p.parrain).name } : null;
    /* Ce qui mûrit encore, tous filleuls confondus. */
    const enAttente = { total: 0, plusTot: null };
    for (const f of (p.filleuls || [])) {
      for (const seau of (this._p(f).attente || [])) {
        enAttente.total += seau[1];
        const mur = (seau[0] + Math.max(0, cfg.REFERRAL_HOLD_DAYS)) * 86400000;
        if (enAttente.plusTot === null || mur < enAttente.plusTot) enAttente.plusTot = mur;
      }
    }
    enAttente.total = Number(enAttente.total.toFixed(6));
    return {
      code: this.codeParrain(a),
      part: part / 100,                      // SA part, en pourcentage, pour l'affichage
      partMax: Math.max.apply(null, cfg.REFERRAL_PALIER_BPS) / 100,
      partPalier: (cfg.REFERRAL_PALIER_BPS || []).map((b, i) => ({
        palier: Game.PALIERS[i] || ('palier ' + (i + 1)), part: b / 100 })),
      partPvp: cfg.REFERRAL_PVP_BPS / 100,
      bienvenue: cfg.REFERRAL_WELCOME,
      parrain,
      filleuls: liste,
      du: ethers.utils.formatUnits(p.refDu || BN(0), cfg.DECIMALS),
      total: ethers.utils.formatUnits(p.refTotal || BN(0), cfg.DECIMALS),
      /* Ce qui n'est pas encore mur, et la date ou le plus vieux seau le
         devient. Une somme « en attente » sans date fait croire a un blocage ;
         avec la date, elle se comprend en une seconde. */
      attente: enAttente.total,
      attenteLe: enAttente.plusTot,
      delaiJours: cfg.REFERRAL_HOLD_DAYS,
      /* Ce qui est encore bloque, et combien il reste a miser pour le
         debloquer. Un montant bloque sans compteur pousse le joueur a ecrire
         au support ; avec le compteur, il joue. */
      bloque: ethers.utils.formatUnits(p.bonusBloque || BN(0), cfg.DECIMALS),
      /* Ce qu'il reste a « rendre a la maison » pour debloquer le cadeau.
         C'est le vrai verrou, donc c'est ce chiffre-la qu'il faut montrer —
         un compteur de volume ferait esperer une chose qui n'ouvre rien. */
      resteADonner: (p.bonusBloque && p.bonusBloque.gt(0))
        ? Math.max(0, Number(cfg.REFERRAL_WELCOME) - (p.revCumul || 0)) : 0,
      depotMini: cfg.REFERRAL_WELCOME_MIN,
    };
  }

  /** Le parrain encaisse. Un gain qui se cueille se remarque ; un gain qui
      tombe tout seul dans le solde passe inapercu. */
  reclameParrainage(addr) {
    this._murit(addr);
    const p = this._p(addr);
    const du = p.refDu || BN(0);
    if (du.lte(0)) throw new Error('nothing to claim yet');
    p.refDu = BN(0);
    p.balance = p.balance.add(du);
    const m = ethers.utils.formatUnits(du, cfg.DECIMALS);
    this.note('parrainage', m, String(addr).toLowerCase());
    journal.ajoute(String(addr).toLowerCase(), { k: 'rf', m, n: (p.filleuls || []).length });

    /* ---- L'XP DE PARRAINAGE, ET POURQUOI PAS A L'ATTACHE ----
     *
     * Payer au moment ou un filleul s'attache se ferme en dix minutes : on
     * cree dix adresses, on les lie, on encaisse dix fois. L'XP est donc due
     * UNE FOIS PAR FILLEUL, et seulement quand ce filleul a produit du revenu
     * — c'est-a-dire quand il a vraiment joue. Amener quelqu'un qui joue est
     * l'acte qu'on recompense ; creer une adresse n'en est pas un.
     *
     * `xpFilleuls` retient lesquels ont deja paye. Sans cette marque, chaque
     * reclamation suivante repaierait les memes.
     */
    p.xpFilleuls = p.xpFilleuls || {};
    const neufs = (p.filleuls || []).filter((f) => {
      if (p.xpFilleuls[f]) return false;
      const q = this.players.get(String(f).toLowerCase());
      return !!(q && Number(q.revCumul) > 0);
    });
    if (neufs.length) {
      neufs.forEach((f) => { p.xpFilleuls[f] = 1; });
      this._gagneXp(p, cfg.XP_PARRAIN * neufs.length, 'parrainage');
    }
    return { montant: m, balance: this.balanceStr(addr) };
  }

  /**
   * Les statistiques du profil. TOUT vient de ce qui est deja compte par
   * ailleurs — les compteurs par jeu, le record, le journal. Une statistique
   * qui aurait sa propre source finirait par contredire l'historique affiche
   * juste en dessous, et c'est l'historique qu'on croit.
   */
  stats(addr) {
    const p = this._p(addr);
    const jeux = p.jeux || {};
    let manches = 0, mise = 0, rendu = 0;
    const parJeu = [];
    for (const k of Object.keys(jeux)) {
      const j = jeux[k];
      manches += j.n || 0; mise += j.mise || 0; rendu += j.rendu || 0;
      parJeu.push({ jeu: k, n: j.n || 0, mise: j.mise || 0 });
    }
    parJeu.sort((x, y) => y.n - x.n);
    const r = journal.resume(String(addr).toLowerCase());
    return {
      depuis: r.depuis || null,
      manches, mise, net: rendu - mise,
      /* Les paris ne sont PAS dans `p.jeux` tant qu'ils ne sont pas regles :
         ils ont leur bilan a eux, tenu depuis les paris eux-memes. Sans lui,
         un joueur qui n'a fait que parier voit des zeros partout. */
      paris: this.statsParis(addr),
      favoris: parJeu.slice(0, 3),
      record: p.record || null,
      meilleurJour: p.meilleurJour || null,
      depose: ethers.utils.formatUnits(p.deposited || BN(0), cfg.DECIMALS),
      stakeReclame: ethers.utils.formatUnits(p.stakeClaimTotal || BN(0), cfg.DECIMALS),
      amis: (p.amis || []).length,
      filleuls: (p.filleuls || []).length,
      frais: this.infoFrais(),
      parrainGagne: ethers.utils.formatUnits(p.refTotal || BN(0), cfg.DECIMALS),
    };
  }

  _bumpDay(p) {
    const t = this._today();
    if (p.dayKey === t) return;
    /* Le jour qui se termine vaut peut-etre un record : c'est le seul moment
       ou son total est encore la. Apres la remise a zero, il n'existe plus
       nulle part. */
    if (p.dayKey && p.dayNet && p.dayNet.gt(0)) {
      const net = Number(ethers.utils.formatUnits(p.dayNet, cfg.DECIMALS));
      if (!p.meilleurJour || net > p.meilleurJour.net) p.meilleurJour = { jour: p.dayKey, net };
    }
    p.dayKey = t; p.dayNet = ethers.BigNumber.from(0); p.dropsToday = 0; p.winsToday = 0; p.questClaimed = {};
    p.primesEntrainement = {};
    p.miseJour = {};
    /* Les compteurs de collection du jour. Ils vivent ici, avec les autres,
       parce qu'ils se remettent a zero au meme instant — un compteur du jour
       qui a son propre reveil finit par se decaler d'un jour. */
    p.jourColl = { coffres: 0, neufs: 0, rarete: 0 };
  }
  jackpotStr() { return ethers.utils.formatUnits(this.jackpotPot, cfg.DECIMALS); }

  /* ==================================================================
   * LES PARIS SPORTIFS
   *
   * Ce n'est pas un jeu de casino, et la difference est toute la
   * difficulte : la mise part aujourd'hui, le resultat tombe dans trois
   * jours. Entre les deux, la maison porte un ENGAGEMENT — ce qu'elle devra
   * payer si les paris passent — qui n'existe nulle part ailleurs dans ce
   * serveur, ou chaque manche se regle dans la seconde.
   *
   * Trois regles en decoulent, et aucune n'est negociable :
   *
   *  1. LA COTE EST FIGEE A LA PRISE DU PARI. Elle est recopiee dans le
   *     pari lui-meme. Corriger une faute de frappe dans le catalogue ne
   *     doit jamais changer ce qu'un joueur croyait avoir accepte ;
   *  2. L'ENGAGEMENT EST PLAFONNE PAR MATCH. Sans plafond, quinze joueurs
   *     au maximum sur la meme issue a 7,50 engagent onze millions et
   *     demi sur un seul resultat. L'avantage de la maison est reel a la
   *     longue, mais « a la longue » ne paie pas un coffre vide samedi soir ;
   *  3. LE REGLEMENT NE PAIE QU'UNE FOIS. Un match regle deux fois, c'est
   *     de l'argent cree, et personne ne s'en plaindra assez vite pour
   *     qu'on le remarque.
   * ================================================================== */

  /**
   * Ce qu'on sait d'un match : le catalogue d'abord, LES PARIS ensuite.
   *
   * Un match peut quitter le calendrier — import qui ne le rend plus, volume
   * remis a zero, retention depassee. Tant qu'aucun pari n'y touche, ca n'a
   * aucune importance. Des qu'un pari y touche, c'est de l'argent bloque :
   * la rencontre ne s'affiche plus (« ? – ? »), elle ne remonte plus dans la
   * liste a regler, et `regleMatch` jetait « unknown match ». Le gagnant ne
   * pouvait plus etre paye du tout.
   *
   * On retombe donc sur ce que le pari a GARDE au moment de sa pose. C'est la
   * bonne source de verite : ce qui a ete vendu au joueur, pas ce que le
   * calendrier raconte aujourd'hui. Les paris poses avant que les jambes ne
   * portent cette copie rendent `null` — ils restent reglables, mais a
   * l'aveugle : voir `parisAregler` et `regleMatch`.
   */
  _infosMatch(matchId) {
    const id = String(matchId || '');
    const m = paris.match(id);
    if (m) return m;
    for (const p of (this.paris || [])) {
      for (const j of (p.jambes || [])) {
        if (j.match !== id || !j.domicile) continue;
        return {
          id, sport: j.sport || null, competition: j.competition || '',
          domicile: j.domicile, exterieur: j.exterieur,
          debut: Number(j.debut) || p.t,
          issues: (j.issues && j.issues.length) ? j.issues.slice() : paris.issues(j.sport),
          cotes: {}, horsCalendrier: true,
        };
      }
    }
    return null;
  }

  /** Tous les paris d'un match, regles ou non. */
  _parisDe(matchId) {
    return (this.paris || []).filter((p) =>
      (p.jambes || [{ match: p.match, choix: p.choix }]).some((j) => j.match === matchId));
  }

  /** Ce qu'un pari a choisi sur ce match, ou null s'il n'y touche pas. */
  _jambeSur(pari, matchId) {
    const l = pari.jambes || [{ match: pari.match, choix: pari.choix }];
    for (const j of l) if (j.match === matchId) return j;
    return null;
  }

  /**
   * Ce que la maison devrait payer sur ce match si TOUTE issue tombait — on
   * prend la pire, celle qui coute le plus. C'est le seul chiffre qui compte
   * pour savoir si l'on peut accepter un pari de plus.
   */
  engagementMatch(matchId) {
    const par = {};
    for (const p of this._parisDe(matchId)) {
      if (p.regle) continue;
      const j = this._jambeSur(p, matchId);
      if (!j) continue;
      par[j.choix] = (par[j.choix] || 0) + p.rapport;
    }
    let pire = 0;
    for (const k of Object.keys(par)) pire = Math.max(pire, par[k]);
    return pire;
  }

  /** Les matchs ouverts, avec la place qu'il reste sur chacun. */
  parisOuverts(now) {
    const t = now || Date.now();
    return paris.ouverts(t).map((m) => {
      const v = paris.vue(m, t);
      v.engagement = Number(this.engagementMatch(m.id).toFixed(6));
      v.place = Math.max(0, cfg.PARI_ENGAGEMENT_MAX - v.engagement);
      return v;
    });
  }

  /**
   * Poser un pari : une seule selection, ou un COMBINE.
   *
   * Le combine multiplie les cotes et exige que TOUTES les selections
   * passent. Une seule fausse et le pari entier est perdu — c'est ce qui le
   * rend interessant pour le joueur (des rapports impossibles en simple) et
   * pour la maison (les marges se multiplient aussi : a 7,7 % la selection,
   * un combine de cinq porte 45 % de marge).
   *
   * MAIS L'ENGAGEMENT EXPLOSE AVEC LUI. Cinq selections a 2,00 font 32 fois
   * la mise : au plafond de mise, c'est 3,2 millions dus sur UN pari. Trois
   * bornes tiennent ca :
   *   • le GAIN d'un pari est plafonne, quel que soit le nombre de jambes ;
   *   • l'engagement d'un match compte le gain ENTIER de chaque combine qui
   *     le touche. C'est majorant — le combine peut encore tomber sur une
   *     autre jambe — et c'est exactement ce qu'on veut d'un garde-fou ;
   *   • deux jambes sur le MEME match sont refusees : elles seraient soit
   *     contradictoires, soit une facon de deguiser un simple en combine.
   */
  parie(addr, matchId, choixRaw, miseRaw, now) {
    return this.parieCombine(addr, [{ match: matchId, choix: choixRaw }], miseRaw, now);
  }

  parieCombine(addr, selectionsRaw, miseRaw, now) {
    const t = now || Date.now();
    const sel = Array.isArray(selectionsRaw) ? selectionsRaw : [];
    if (!sel.length) throw new Error('pick at least one selection');
    if (sel.length > cfg.PARI_JAMBES_MAX)
      throw new Error('at most ' + cfg.PARI_JAMBES_MAX + ' selections in one bet');

    const vus = new Set();
    const jambes = sel.map((x) => {
      const m = paris.match(x && x.match);
      if (!m) throw new Error('unknown match');
      if (m.debut <= t) throw new Error('betting is closed on ' + m.domicile + ' v ' + m.exterieur);
      /* Deux jambes sur le meme match : soit contradictoires, soit un simple
         deguise en combine pour contourner le plafond de gain. */
      if (vus.has(m.id)) throw new Error('only one selection per match');
      vus.add(m.id);
      const choix = String(x.choix);
      if (m.issues.indexOf(choix) < 0)
        throw new Error('pick ' + m.issues.join(', ') + ' on ' + m.domicile + ' v ' + m.exterieur);
      /* LA JAMBE GARDE SA RENCONTRE. Les noms, le coup d'envoi et les issues
         sont recopies ici, une fois, au moment de la vente. Ils ne changeront
         plus : c'est le ticket, pas le calendrier. Sans cette copie, un match
         qui quitte le catalogue emporte avec lui de quoi afficher ET de quoi
         regler le pari — le gagnant devient impayable. Quelques octets par
         pari contre de l'argent bloque : le choix n'en est pas un. */
      return { match: m.id, choix, cote: m.cotes[choix],
               domicile: m.domicile, exterieur: m.exterieur, debut: m.debut,
               sport: m.sport, competition: m.competition, issues: m.issues.slice() };
    });

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.PARI_MIN)) throw new Error('minimum bet is ' + cfg.PARI_MIN + ' $SWOGE');
    if (mise > cfg.PARI_MAX) throw new Error('maximum bet is ' + cfg.PARI_MAX + ' $SWOGE');

    const p = this._p(addr);
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    let cote = 1;
    for (const j of jambes) cote *= j.cote;
    cote = Math.floor(cote * 1e4) / 1e4;
    const rapport = paris.rapport(cote, mise);
    if (rapport > cfg.PARI_GAIN_MAX)
      throw new Error('this bet could return ' + Math.floor(rapport) +
        ' $SWOGE — the cap is ' + cfg.PARI_GAIN_MAX + '. Lower the stake or drop a leg.');

    /* Le plafond, match par match. Le gain ENTIER pese sur CHAQUE match
       touche : c'est majorant, et un garde-fou doit majorer. */
    for (const j of jambes) {
      const cumul = {};
      for (const q of (this.paris || [])) {
        if (q.regle) continue;
        for (const b of (q.jambes || [])) {
          if (b.match !== j.match) continue;
          cumul[b.choix] = (cumul[b.choix] || 0) + q.rapport;
        }
      }
      cumul[j.choix] = (cumul[j.choix] || 0) + rapport;
      let pire = 0;
      for (const k of Object.keys(cumul)) pire = Math.max(pire, cumul[k]);
      if (pire > cfg.PARI_ENGAGEMENT_MAX) {
        const m = paris.match(j.match);
        throw new Error(m.domicile + ' v ' + m.exterieur + ' is full — ' +
          Math.max(0, Math.floor(cfg.PARI_ENGAGEMENT_MAX - this.engagementMatch(j.match))) +
          ' $SWOGE of exposure left');
      }
    }

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++;
    this._markWager(p, WEI(mise), 'paris');

    if (!this.paris) this.paris = [];
    const pari = {
      id: 'b' + (++this.parisSeq) + '-' + Math.floor(t / 1000).toString(36),
      addr: String(addr).toLowerCase(),
      jambes, cote, mise, rapport, t,
      regle: false, gagne: null,
      /* Les champs d'un simple restent remplis : les paris deja poses et les
         pages en service les lisent. */
      match: jambes[0].match, choix: jambes[0].choix,
    };
    this.paris.push(pari);
    journal.ajoute(pari.addr, { k: 'pa', s: 'pose', m: String(mise),
                                match: jambes.map((j) => j.match).join('+'),
                                choix: jambes.map((j) => j.choix).join('+'), cote, rapport });
    return pari;
  }

  /**
   * TOUS les paris, pour le panneau d'administration.
   *
   * Pourquoi une methode a part plutot que `mesParis` sans adresse : ce qui
   * est demande ici n'est pas la meme chose. Le joueur veut SES paris, en
   * clair ; l'exploitant veut retrouver UN pari a partir de son identifiant,
   * savoir qui l'a pose, et voir ce qui est encore en jeu. La recherche porte
   * donc sur l'identifiant du pari, celui du match, l'adresse et le nom —
   * les quatre choses qu'on a sous la main quand quelqu'un signale un
   * probleme.
   *
   * L'identifiant du pari est la piece maitresse : il est affiche au joueur,
   * ecrit dans le journal, et repris ici. Un joueur qui ecrit « mon pari
   * b41-mfx2 n'a pas ete paye » se verifie en une recherche au lieu de
   * fouiller un fichier.
   */
  tousParis(opt) {
    const o = opt || {};
    const q = String(o.q || '').trim().toLowerCase();
    const etat = String(o.etat || 'tous');
    const t = Number(o.now) || Date.now();

    let liste = (this.paris || []);
    if (etat === 'ouvert') liste = liste.filter((p) => !p.regle);
    else if (etat === 'regle') liste = liste.filter((p) => p.regle);

    if (q) {
      liste = liste.filter((p) => {
        if (String(p.id).toLowerCase().includes(q)) return true;
        if (String(p.addr).toLowerCase().includes(q)) return true;
        const f = this.players.get(p.addr);
        const nom = (f && f.name) || '';
        if (nom && String(nom).toLowerCase().includes(q)) return true;
        return (p.jambes || []).some((j) => String(j.match).toLowerCase().includes(q));
      });
    }

    const total = liste.length;
    /* Le total AVANT la tranche : « 3 sur 412 » se lit, « 3 » ne dit rien. */
    const debut = Math.max(0, Number(o.debut) || 0);
    const page = liste.sort((x, y) => y.t - x.t)
      .slice(debut, debut + (Number(o.limite) || 50));

    /* Les sommes portent sur TOUT ce qui est filtre, pas sur la page : c'est
       l'engagement reel qu'on veut voir, pas celui des cinquante premiers. */
    let mise = 0, engage = 0, paye = 0;
    for (const p of liste) {
      mise += p.mise;
      if (!p.regle) engage += p.rapport;
      else if (p.gagne) paye += p.rapport;
      else if (p.gagne === null) paye += p.mise;
    }

    return {
      total, debut, encore: debut + page.length < total,
      resume: { mise: Math.round(mise), engage: Math.round(engage), paye: Math.round(paye),
                ouverts: (this.paris || []).filter((x) => !x.regle).length },
      paris: page.map((p) => {
        const j0 = this._infosMatch(p.match);
        return {
          id: p.id, addr: p.addr,
          nom: (this.players.get(p.addr) || {}).name || null,
          t: p.t, mise: p.mise, cote: p.cote, rapport: p.rapport,
          regle: !!p.regle, gagne: p.regle ? p.gagne : null,
          /* L'etat en un mot, calcule ici : trois pages differentes le
             deduisaient chacune a sa facon, et une seule s'y prenait bien. */
          /* Rencontre introuvable — ni au calendrier, ni sur le ticket : elle
             ne se jouera plus jamais « plus tard ». « running » laissait
             croire qu'il n'y avait rien a faire ; c'est justement l'inverse. */
          etat: !p.regle ? (!j0 || j0.debut <= t ? 'a regler' : 'en cours')
                         : p.gagne === null ? 'rembourse' : p.gagne ? 'gagne' : 'perdu',
          jambes: (p.jambes || []).map((j) => {
            const m = this._infosMatch(j.match);
            return { match: j.match, choix: j.choix, cote: j.cote,
                     domicile: m ? m.domicile : '?', exterieur: m ? m.exterieur : '?',
                     debut: m ? m.debut : null, sport: m ? m.sport : null,
                     issues: m ? m.issues.slice() : [],
                     /* La rencontre n'est plus au calendrier : le panneau le
                        dit plutot que d'afficher « ? – ? » sans explication. */
                     horsCalendrier: !!(m && m.horsCalendrier) || !m,
                     regle: !!(this.parisRegles && this.parisRegles[j.match]),
                     resultat: (this.parisRegles && this.parisRegles[j.match]
                                && this.parisRegles[j.match].resultat) || null };
          }),
        };
      }),
    };
  }

  /**
   * Les rencontres qui ATTENDENT un resultat, pour le panneau.
   *
   * C'est la seule liste qui demande une action humaine : le coup d'envoi est
   * passe, des paris sont en jeu, et rien n'a encore ete decide. Tant qu'elle
   * n'est pas vide, des joueurs attendent d'etre payes.
   *
   * On rend l'exposition ISSUE PAR ISSUE, et c'est le point important : avant
   * de cliquer, on doit voir ce que CHAQUE resultat coute a la maison. Un
   * seul total ne dit rien — c'est la difference entre les issues qui permet
   * de reperer une erreur de saisie avant qu'elle ne paie.
   */
  parisAregler(now) {
    const t = Number(now) || Date.now();
    if (!this.parisRegles) this.parisRegles = {};
    const parMatch = new Map();
    for (const p of (this.paris || [])) {
      if (p.regle) continue;
      for (const j of (p.jambes || [])) {
        if (!parMatch.has(j.match)) parMatch.set(j.match, []);
        parMatch.get(j.match).push({ p, j });
      }
    }
    /* ---- ON PART DU CATALOGUE, PAS DES PARIS ----
     *
     * La liste ne montrait que les rencontres SUR LESQUELLES QUELQU'UN AVAIT
     * MISE. Une rencontre jouee que personne n'avait prise n'apparaissait donc
     * nulle part : elle restait indefiniment « en attente » sans qu'aucun
     * ecran ne le dise, et le jour ou un pari tombait dessus — un combine, un
     * retardataire — elle sortait de nulle part avec plusieurs jours de retard.
     *
     * On enumere donc toutes les rencontres du calendrier, et les paris ne font
     * plus que RENSEIGNER celles qui en ont. Une rencontre sans pari s'affiche
     * a zero : elle ne coute rien a trancher, et la trancher la sort de la
     * liste au lieu de la laisser trainer.
     */
    /* ---- ET LES RENCONTRES QUI ONT QUITTE LE CATALOGUE ----
     *
     * Partir du calendrier ne suffit pas : une rencontre peut en SORTIR alors
     * que des paris y dorment encore. Elle n'apparaissait alors nulle part,
     * aucun bouton ne permettait de la trancher, et `regleMatch` la refusait.
     * Le pari restait ouvert pour toujours — c'est precisement ce qui est
     * arrive au 17 aout, apres un redemarrage qui a rendu au conteneur le
     * calendrier du depot.
     *
     * On ajoute donc toute rencontre PORTANT UN PARI NON REGLE et absente du
     * calendrier. Ce qu'on sait d'elle vient du ticket ; les paris poses avant
     * que les jambes ne gardent leur rencontre n'ont pas de fiche du tout, et
     * on l'affiche alors telle quelle — l'identifiant seul (« spainlaliga-
     * 20260817-dep-elc ») dit deja quelle rencontre c'etait, et le bouton
     * « Refund all » reste toujours disponible en cas de doute.
     */
    const rencontres = paris.catalogue().matchs.slice();
    const auCatalogue = new Set(rencontres.map((m) => m.id));
    for (const id of parMatch.keys()) {
      if (auCatalogue.has(id)) continue;
      const su = this._infosMatch(id);
      rencontres.push(su || {
        id, sport: null, competition: '', domicile: '?', exterieur: '?',
        /* Faute de mieux, la pose du pari : un pari se pose AVANT le coup
           d'envoi, donc l'attente affichee est un minorant honnete. */
        debut: Math.min(...parMatch.get(id).map((x) => x.p.t)),
        issues: paris.ISSUES.slice(), cotes: {},
        horsCalendrier: true, sansFiche: true,
      });
    }

    const sortie = [];
    for (const m of rencontres) {
      const id = m.id;
      if (this.parisRegles[id]) continue;             // deja tranchee
      /* Une rencontre du calendrier qui n'a pas commence n'attend rien. Une
         rencontre SORTIE du calendrier, si : elle ne reviendra pas toute
         seule, et ses paris sont bloques des maintenant. */
      if (m.debut > t && !m.horsCalendrier) continue;
      const lignes = parMatch.get(id) || [];
      const expo = {};
      for (const i of m.issues) expo[i] = 0;
      let mise = 0;
      const joueurs = new Set();
      for (const { p, j } of lignes) {
        /* Le gain ENTIER pese sur l'issue choisie : un combine ne paie que si
           toutes ses jambes passent, mais du point de vue de CE match, c'est
           ce choix-la qui ouvre la porte. Majorant, et un garde-fou majore. */
        expo[j.choix] = (expo[j.choix] || 0) + p.rapport;
        mise += p.mise;
        joueurs.add(p.addr);
      }
      sortie.push({
        id, sport: m.sport, competition: m.competition,
        domicile: m.domicile, exterieur: m.exterieur, debut: m.debut,
        issues: m.issues.slice(), cotes: Object.assign({}, m.cotes),
        paris: lignes.length, joueurs: joueurs.size, mise: Math.round(mise),
        expo: Object.fromEntries(m.issues.map((i) => [i, Math.round(expo[i] || 0)])),
        /* Depuis combien de temps elle attend. Une rencontre qui attend depuis
           deux jours est une rencontre qu'on a oubliee. */
        attendDepuisMin: Math.max(0, Math.round((t - m.debut) / 60000)),
        /* Le panneau doit pouvoir le DIRE : une rencontre hors calendrier se
           regle a la main, sans cotes affichees, et merite qu'on regarde son
           identifiant avant de cliquer. */
        horsCalendrier: !!m.horsCalendrier, sansFiche: !!m.sansFiche,
      });
    }
    return sortie.sort((a, b) => a.debut - b.debut);
  }

  /* ================= LE BILAN DES PARIS, PAR JOUEUR =================
   *
   * ---- pourquoi ca ne pouvait pas venir de `p.jeux` ----
   *
   * Les compteurs du profil et du panneau lisent `p.jeux`, qui est ecrit par
   * `_manche` — c'est-a-dire A LA FIN d'une manche. Un pari sportif n'a pas
   * de fin le jour ou il est pose : il se regle le lendemain, ou jamais si le
   * match a disparu du calendrier. Un joueur qui avait mise trois mille
   * jetons le samedi affichait donc « aucune manche enregistree » et zero
   * partout, ce qui se lit comme un compteur casse — et qui l'etait, en un
   * sens : il comptait autre chose que ce qu'on lui demandait.
   *
   * On repart donc de `this.paris`, qui est la source de verite : chaque
   * pari y est range des sa pose, et son etat y est celui d'aujourd'hui.
   *
   * ---- ce que chaque chiffre veut dire, exactement ----
   *
   *   • le TAUX DE REUSSITE porte sur les paris TRANCHES, remboursements
   *     exclus : un match annule n'est ni gagne ni perdu, et le compter en
   *     defaite ferait baisser un taux sans qu'aucun pari n'ait ete perdu ;
   *   • le RESULTAT ne compte que les paris regles. Un pari en cours n'est
   *     ni gagne ni perdu, et l'inscrire en perte affiche un joueur perdant
   *     le samedi soir qui redevient gagnant le dimanche sans avoir rien
   *     fait ;
   *   • ce qui est EN JEU et ce qui EST A GAGNER se disent a part. C'est la
   *     seule paire de chiffres qui reponde a « ou j'en suis, la, tout de
   *     suite ».
   * ================================================================ */

  /** Le bilan de TOUS les parieurs en une passe. `Map` adresse -> bilan. */
  _bilansParis() {
    const par = new Map();
    const vide = () => ({
      total: 0, ouverts: 0, gagnes: 0, perdus: 0, rembourses: 0,
      mise: 0, miseJugee: 0, rendu: 0, enJeu: 0, aGagner: 0, plusGros: null,
    });
    for (const p of (this.paris || [])) {
      const a = String(p.addr || '').toLowerCase();
      if (!a) continue;
      let b = par.get(a);
      if (!b) { b = vide(); par.set(a, b); }
      b.total++;
      b.mise += p.mise;
      if (!p.regle) { b.ouverts++; b.enJeu += p.mise; b.aGagner += p.rapport; continue; }
      /* `gagne === null` : rembourse. La mise revient, donc le resultat ne
         bouge pas — et le pari ne compte dans aucun des deux camps. */
      if (p.gagne === null) { b.rembourses++; continue; }
      b.miseJugee += p.mise;
      if (p.gagne) {
        b.gagnes++; b.rendu += p.rapport;
        if (!b.plusGros || p.rapport > b.plusGros.rendu)
          b.plusGros = { id: p.id, mise: p.mise, cote: p.cote, rendu: p.rapport, t: p.t };
      } else b.perdus++;
    }
    for (const b of par.values()) this._finBilan(b);
    return par;
  }

  /** Les chiffres derives, poses une seule fois, au meme endroit. */
  _finBilan(b) {
    const juges = b.gagnes + b.perdus;
    b.juges = juges;
    /* Sans un seul pari tranche, le taux n'est pas « 0 % » — il n'existe pas.
       Afficher 0 % a quelqu'un dont le premier pari court encore serait une
       information fausse, et decourageante pour rien. */
    b.taux = juges ? Number(((b.gagnes / juges) * 100).toFixed(1)) : null;
    b.net = Number((b.rendu - b.miseJugee).toFixed(6));
    b.mise = Number(b.mise.toFixed(6));
    b.miseJugee = Number(b.miseJugee.toFixed(6));
    b.rendu = Number(b.rendu.toFixed(6));
    b.enJeu = Number(b.enJeu.toFixed(6));
    b.aGagner = Number(b.aGagner.toFixed(6));
    return b;
  }

  /** Le bilan d'UN joueur. Zero partout s'il n'a jamais parie. */
  statsParis(addr) {
    const a = String(addr || '').toLowerCase();
    const b = {
      total: 0, ouverts: 0, gagnes: 0, perdus: 0, rembourses: 0,
      mise: 0, miseJugee: 0, rendu: 0, enJeu: 0, aGagner: 0, plusGros: null,
    };
    for (const p of (this.paris || [])) {
      if (String(p.addr || '').toLowerCase() !== a) continue;
      b.total++; b.mise += p.mise;
      if (!p.regle) { b.ouverts++; b.enJeu += p.mise; b.aGagner += p.rapport; continue; }
      if (p.gagne === null) { b.rembourses++; continue; }
      b.miseJugee += p.mise;
      if (p.gagne) {
        b.gagnes++; b.rendu += p.rapport;
        if (!b.plusGros || p.rapport > b.plusGros.rendu)
          b.plusGros = { id: p.id, mise: p.mise, cote: p.cote, rendu: p.rapport, t: p.t };
      } else b.perdus++;
    }
    return this._finBilan(b);
  }

  /** Les paris d'un joueur, du plus recent au plus ancien. */
  mesParis(addr, limite) {
    const a = String(addr).toLowerCase();
    return (this.paris || []).filter((p) => p.addr === a)
      .sort((x, y) => y.t - x.t).slice(0, limite || 50)
      .map((p) => {
        const m = this._infosMatch(p.match);
        return Object.assign({}, p, {
          domicile: m ? m.domicile : '?', exterieur: m ? m.exterieur : '?',
          debut: m ? m.debut : null, competition: m ? m.competition : '',
          /* Chaque jambe porte SA rencontre. Sans ca, un combine regle
             n'affiche que la premiere : les pages lisent les noms dans le
             calendrier des matchs OUVERTS, et un match joue n'y est plus.
             On recopie la jambe — l'objet range dans `this.paris` ne doit
             pas bouger, il sert au reglement. */
          jambes: (p.jambes || []).map((j) => {
            const mj = this._infosMatch(j.match);
            return Object.assign({}, j, {
              domicile: mj ? mj.domicile : '?', exterieur: mj ? mj.exterieur : '?',
              debut: mj ? mj.debut : null, competition: mj ? mj.competition : '',
              /* Le SPORT, sans quoi la page ne sait pas si « 1 » se dit
                 « Home » ou « Player 1 » : la NFL et le cricket n'ont que
                 deux issues eux aussi, mais opposent des EQUIPES. */
              sport: mj ? mj.sport : null,
              issues: mj ? mj.issues.slice() : [],
            });
          }),
        });
      });
  }

  /**
   * Regler un match. Paie les gagnants, marque les perdants, UNE SEULE FOIS.
   *
   * Le resultat est celui du terrain : '1', 'N' ou '2'. Le reglement se fait
   * a la main, et c'est assume — un service de resultats automatique qui se
   * trompe paie les mauvaises personnes sans que personne ne le sache.
   */
  regleMatch(matchId, resultat) {
    /* ---- UNE RENCONTRE ABSENTE DU CALENDRIER RESTE REGLABLE ----
     *
     * Refuser net (« unknown match ») protegeait d'une faute de frappe, mais
     * au prix bien plus lourd de rendre IMPAYABLE tout pari dont la rencontre
     * avait quitte le catalogue. Entre les deux, il n'y a pas photo : une
     * faute de frappe sur un identifiant sans pari ne coute rien, un gagnant
     * qu'on ne peut plus payer coute la confiance.
     *
     * On accepte donc a deux conditions : ou bien on sait de quoi il s'agit
     * (catalogue, ou fiche gardee par le ticket), ou bien la rencontre porte
     * au moins un pari NON REGLE — un identifiant invente n'en porte aucun.
     */
    const m = this._infosMatch(matchId);
    const issues = m ? m.issues
      : (this._parisDe(matchId).some((p) => !p.regle) ? paris.ISSUES : null);
    if (!issues) throw new Error('unknown match');
    if (issues.indexOf(String(resultat)) < 0)
      throw new Error('result must be one of ' + issues.join(', '));
    if (!this.parisRegles) this.parisRegles = {};
    if (this.parisRegles[matchId]) throw new Error('already settled');

    /* On enregistre le resultat AVANT de regarder les paris : un combine ne
       peut etre juge que quand toutes ses jambes ont un resultat, et c'est
       cette table qui le dit. */
    this.parisRegles[matchId] = { t: Date.now(), resultat: String(resultat) };

    let paye = 0, gagnants = 0, mise = 0, perdus = 0, attente = 0;
    let top = null;
    for (const p of this._parisDe(matchId)) {
      if (p.regle) continue;
      const v = this._jugePari(p);
      if (v === null) { attente++; continue; }      // il reste des jambes a jouer
      p.regle = true; p.gagne = v;
      mise += p.mise;
      const rendu = v ? p.rapport : 0;
      if (rendu > 0) {
        const q = this._p(p.addr);
        q.balance = q.balance.add(WEI(rendu));
        this._bumpDay(q); q.dayNet = q.dayNet.add(WEI(rendu)); q.winsToday++;
        paye += rendu; gagnants++;
      } else perdus++;
      /* LE PLUS GROS GAGNANT DE CE REGLEMENT. On le retient au passage plutot
         que de rendre la liste entiere : un match populaire peut regler des
         centaines de paris, et l'appelant n'a besoin que de celui-la pour
         l'annoncer. Retenir tout le tableau ferait porter a chaque reglement
         le poids de son affluence. */
      if (rendu > 0 && (!top || rendu > top.rendu))
        top = { addr: p.addr, mise: p.mise, rendu, cote: p.cote,
                jambes: (p.jambes || []).length || 1 };
      journal.ajoute(p.addr, { k: 'pa', s: 'regle', m: String(p.mise), match: matchId,
                               cote: p.cote, resultat: String(resultat), rendu: String(rendu) });
      this._manche(this._p(p.addr), 'paris', p.mise, rendu);
    }
    const r = this.parisRegles[matchId];
    r.gagnants = gagnants; r.paye = paye; r.perdus = perdus; r.attente = attente;
    return { match: matchId, resultat: String(resultat), gagnants, perdus,
             enAttente: attente, paye, mise, net: mise - paye, top };
  }

  /**
   * Un pari est-il gagne, perdu, ou pas encore jugeable ?
   *
   *   true  : toutes les jambes sont tombees du bon cote ;
   *   false : au moins une jambe est perdue — inutile d'attendre les autres,
   *           un combine tombe entierement des la premiere erreur ;
   *   null  : il reste des matchs a jouer.
   */
  _jugePari(pari) {
    const l = pari.jambes || [{ match: pari.match, choix: pari.choix }];
    let complet = true;
    for (const j of l) {
      const r = (this.parisRegles || {})[j.match];
      if (!r || r.rembourse) { complet = false; continue; }
      if (r.resultat !== j.choix) return false;      // une seule fausse suffit
    }
    return complet ? true : null;
  }

  /**
   * Rembourser un match — report, annulation, cote saisie de travers.
   *
   * Rendre la mise n'est pas une faveur : un match qui ne se joue pas n'a
   * produit aucun resultat, et garder l'argent reviendrait a encaisser un
   * pari qui n'a jamais eu lieu.
   */
  rembourseMatch(matchId) {
    if (!this.parisRegles) this.parisRegles = {};
    if (this.parisRegles[matchId]) throw new Error('already settled');
    const liste = this._parisDe(matchId).filter((p) => !p.regle);
    let rendu = 0;
    for (const p of liste) {
      p.regle = true; p.gagne = null;
      const q = this._p(p.addr);
      q.balance = q.balance.add(WEI(p.mise));
      this._bumpDay(q); q.dayNet = q.dayNet.add(WEI(p.mise));
      rendu += p.mise;
      journal.ajoute(p.addr, { k: 'pa', s: 'rembourse', m: String(p.mise), match: matchId });
    }
    this.parisRegles[matchId] = { t: Date.now(), resultat: null, rembourse: true,
                                  paris: liste.length, rendu };
    return { match: matchId, paris: liste.length, rendu };
  }

  /** Ce que la maison doit encore sur l'ensemble des paris non regles. */
  engagementTotal() {
    const vus = new Set();
    let total = 0;
    for (const p of (this.paris || [])) if (!p.regle) vus.add(p.match);
    for (const id of vus) total += this.engagementMatch(id);
    return Number(total.toFixed(6));
  }

  // ---- Staking: 100% APR, sortie libre a tout moment ----
  _lockMs() { return cfg.STAKE_LOCK_DAYS * 86400000; }

  /* ---- CE QUI FAIT QU UNE POSITION EST BLOQUEE ----
   *
   * C'est la PENALITE, pas la date. Un verrou qui ne coute rien a franchir
   * n'est pas un verrou : l'annoncer quand meme afficherait « bloque jusqu'au
   * 14 aout 2027 » a quelqu'un qui peut sortir dans la seconde, et c'est la
   * pire des deux erreurs — celle qui retient un joueur qui n'avait aucune
   * raison de rester dehors.
   *
   * Poser la question dans ce sens regle aussi les positions DEJA PRISES :
   * elles portent une date d'echeance ecrite au moment du depot, et rien ne
   * la reecrira jamais. En faisant dependre le verrou de la penalite en
   * vigueur, elles se deverrouillent toutes seules le jour ou la penalite
   * tombe a zero, sans migration ni retouche de l'etat.
   */
  _verrouille(pos, now) {
    return cfg.STAKE_EARLY_PENALTY_BPS > 0 && now < pos.u;
  }
  _pendingPos(pos) {
    const elapsed = Date.now() - pos.s;
    if (elapsed <= 0) return BN(0);
    return pos.a.mul(this._stakeRateBps).mul(elapsed).div(10000).div(MS_YEAR); // a × apr × elapsed/yr
  }
  _pendingAll(p) { let y = BN(0); for (const pos of p.stakes) y = y.add(this._pendingPos(pos)); return y; }
  _settleStakes(p) { const now = Date.now(); for (const pos of p.stakes) { p.stakeAccrued = p.stakeAccrued.add(this._pendingPos(pos)); pos.s = now; } }
  _stakedTotal(p) { let s = BN(0); for (const pos of p.stakes) s = s.add(pos.a); return s; }

  /* ---- LE PLAFOND, TOUS JOUEURS CONFONDUS ----
   *
   * A 100 % l'an, chaque jeton en staking engage la maison a en rendre deux
   * dans un an. Le plafond met une borne CONNUE D'AVANCE a cette dette : au
   * maximum 20 % de l'offre en staking, donc au maximum 20 % de l'offre de
   * rendement sur l'annee. Sans lui, un seul gros porteur peut engager le
   * coffre pour une somme qu'on ne decouvrira que douze mois plus tard.
   *
   * La place se LIBERE quand quelqu'un sort : ce n'est pas une porte fermee,
   * c'est une salle pleine.
   */
  plafondStaking() {
    const pct = Math.max(0, Math.min(10000, cfg.STAKE_CAP_BPS || 0));
    if (!pct) return null;                                   // 0 = pas de plafond
    /* L'offre lue sur la chaine si le serveur l'a eue, sinon celle du fichier
       de config. */
    const offre = (this.offreTotale && !this.offreTotale.isZero())
      ? this.offreTotale : WEI(String(cfg.TOKEN_SUPPLY));
    return offre.mul(pct).div(10000);
  }

  /**
   * Le plafond d'UN portefeuille : une part de la salle, pas de l'offre.
   *
   * Si le plafond global bouge, celui-ci suit, et le rapport « combien de
   * portefeuilles au minimum pour remplir la salle » reste celui qui a ete
   * choisi. Rend null quand il n'y a pas de plafond global : plafonner une
   * part d'un infini n'aurait pas de sens.
   */
  plafondJoueur() {
    const salle = this.plafondStaking();
    if (!salle) return null;
    const pct = Math.max(0, Math.min(10000, cfg.STAKE_CAP_JOUEUR_BPS || 0));
    if (!pct) return null;                                   // 0 = pas de plafond par joueur
    return salle.mul(pct).div(10000);
  }

  /**
   * Ce qu'il reste a CE portefeuille.
   *
   * Une position deja ouverte au-dessus du plafond n'est pas rognee : elle
   * reste, et il reste zero. On ne casse pas un engagement pris sous une
   * autre regle — on empeche seulement d'en ajouter.
   */
  placeJoueur(addr) {
    const max = this.plafondJoueur();
    if (!max) return null;
    const deja = this._stakedTotal(this._p(addr));
    return max.gt(deja) ? max.sub(deja) : BN(0);
  }

  /** Ou en est la salle : ce qui est pris, ce qui reste, et le taux de
   *  remplissage. C'est ce que la page de staking affiche AVANT que le joueur
   *  tape un montant — un refus qui arrive apres la saisie est une brimade. */
  capaciteStaking(addr) {
    const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));
    const plafond = this.plafondStaking();
    const occupe = this.totalStaked();
    /* Le plafond personnel part AVEC la capacite de la salle, pour la meme
       raison qu'elle : un refus qui arrive apres la saisie est une brimade. */
    const maxJoueur = this.plafondJoueur();
    const perso = addr && maxJoueur ? {
      plafondJoueur: f(maxJoueur),
      dejaJoueur: f(this._stakedTotal(this._p(addr))),
      libreJoueur: f(this.placeJoueur(addr)),
      partSalle: cfg.STAKE_CAP_JOUEUR_BPS / 100,
    } : (maxJoueur ? { plafondJoueur: f(maxJoueur), partSalle: cfg.STAKE_CAP_JOUEUR_BPS / 100 } : {});
    if (!plafond) return { plafond: null, occupe: f(occupe), libre: null, taux: 0, plein: false, ...perso };
    const libre = plafond.gt(occupe) ? plafond.sub(occupe) : BN(0);
    /* On ARRONDIT VERS LE BAS. A 99,9995 %, un arrondi au plus proche affiche
       « 100 % » alors qu'il reste de la place : le joueur renonce a une salle
       qui l'aurait accepte. Cent pour cent ne s'affiche que quand c'est
       vraiment plein. */
    const taux = libre.lte(0) ? 100 : Math.min(99.99, Math.floor(f(occupe) / f(plafond) * 10000) / 100);
    return {
      plafond: f(plafond), occupe: f(occupe), libre: f(libre), taux,
      plein: libre.lte(0),
      partOffre: cfg.STAKE_CAP_BPS / 100,
      ...perso,
    };
  }

  stake(addr, amountStr) {
    const p = this._p(addr);
    const amount = WEI(amountStr);
    if (amount.lte(0)) throw new Error('enter an amount');
    if (amount.gt(p.balance)) throw new Error('amount exceeds balance');
    /* Le plafond se verifie AVANT de toucher au solde. Un refus qui arrive
       apres le debit laisserait un joueur sans ses jetons ni son staking. */
    /* On RECOMPTE, on ne tient pas de compteur a cote. Un compteur qui derive
       d'un seul jeton laisserait entrer un peu plus que le plafond a chaque
       fois, sans que rien ne le signale ; la somme, elle, ne peut pas mentir.
       Et une mise en staking est mille fois plus rare qu'une manche : le
       parcours des fiches ne se voit pas. */
    const plafond = this.plafondStaking();
    if (plafond) {
      const occupe = this.totalStaked();
      const libre = plafond.gt(occupe) ? plafond.sub(occupe) : BN(0);
      const joli = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS))
        .toLocaleString('en-US', { maximumFractionDigits: 0 });
      /* Le refus porte TOUJOURS le chiffre exact qui reste. « Pool full » tout
         seul fait ecrire au support ; « il reste 12 400 » fait retaper 12 400. */
      if (libre.lte(0))
        throw new Error('staking pool is full (' + (cfg.STAKE_CAP_BPS / 100) +
          '% of supply) — wait for someone to unstake');
      if (amount.gt(libre))
        throw new Error('only ' + joli(libre) + ' $SWOGE of room left in the staking pool (cap ' +
          joli(plafond) + ', ' + (cfg.STAKE_CAP_BPS / 100) + '% of supply)');
    }
    /* Le plafond PAR PORTEFEUILLE. Le rendement est une subvention payee par
       les manches de tout le monde : qu'un seul portefeuille l'absorbe revient
       a faire payer la salle pour une personne.
     *
     * Ce qui est deja stake n'est pas touche. Une position ouverte sous une
     * autre regle le reste — on empeche d'AJOUTER, on ne retire pas. */
    const maxJoueur = this.plafondJoueur();
    if (maxJoueur) {
      const joli = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS))
        .toLocaleString('en-US', { maximumFractionDigits: 0 });
      const place = this.placeJoueur(addr);
      if (place.lte(0))
        throw new Error('you have reached the per-wallet staking cap of ' + joli(maxJoueur) +
          ' $SWOGE — your current stake stays untouched, you just cannot add to it');
      if (amount.gt(place))
        throw new Error('you can stake ' + joli(place) + ' $SWOGE more (per-wallet cap ' +
          joli(maxJoueur) + ', ' + (cfg.STAKE_CAP_JOUEUR_BPS / 100) + '% of the pool)');
    }
    this._settleStakes(p);
    p.balance = p.balance.sub(amount);
    const now = Date.now();
    p.stakes.push({ a: amount, s: now, u: now + this._lockMs() }); // a=amount, s=lastSettle, u=unlockAt
    journal.ajoute(addr, { k: 'st', s: 'stake', m: ethers.utils.formatUnits(amount, cfg.DECIMALS),
                           total: ethers.utils.formatUnits(this._stakedTotal(p), cfg.DECIMALS) });
  }

  claimStake(addr) {
    const p = this._p(addr);
    this._settleStakes(p);
    const reward = p.stakeAccrued;
    if (reward.lte(0)) throw new Error('no yield to claim yet');
    p.stakeAccrued = BN(0);
    p.balance = p.balance.add(reward);
    p.stakeClaimTotal = (p.stakeClaimTotal || BN(0)).add(reward);
    const r = ethers.utils.formatUnits(reward, cfg.DECIMALS);
    this.note('staking', r, String(addr).toLowerCase());
    journal.ajoute(addr, { k: 'st', s: 'claim', m: r,
                           total: ethers.utils.formatUnits(this._stakedTotal(p), cfg.DECIMALS) });
    return r;
  }

  /** Unstake EVERYTHING + pay accrued yield. Sortie libre par defaut : tout
   * revient en entier. Si une penalite est remise en vigueur, seules les
   * positions encore bloquees rendent (1 − penalite). */
  unstakeAll(addr) {
    const p = this._p(addr);
    if (!p.stakes.length) throw new Error('nothing staked');
    this._settleStakes(p);
    const now = Date.now();
    let returned = BN(0), penalty = BN(0);
    for (const pos of p.stakes) {
      if (!this._verrouille(pos, now)) { returned = returned.add(pos.a); }
      else {
        const keep = pos.a.mul(10000 - cfg.STAKE_EARLY_PENALTY_BPS).div(10000);
        returned = returned.add(keep);
        penalty = penalty.add(pos.a.sub(keep)); // forfeited → stays in the vault (house)
      }
    }
    const yld = p.stakeAccrued;
    p.stakeAccrued = BN(0);
    p.stakes = [];
    p.balance = p.balance.add(returned).add(yld);
    const f = (w) => ethers.utils.formatUnits(w, cfg.DECIMALS);
    /* La PENALITE est journalisee separement de ce qui revient : c'est
       exactement le chiffre qu'un joueur conteste six mois plus tard, et
       « rendu 500 » sans « penalite 500 » ne permet pas de lui repondre. */
    journal.ajoute(addr, { k: 'st', s: 'unstake', m: f(returned),
                           pen: f(penalty), yld: f(yld), total: '0' });
    return { returned: f(returned), penalty: f(penalty), yield: f(yld) };
  }

  /** Sum of all staked principal (wei). */
  totalStaked() { let s = BN(0); for (const p of this.players.values()) s = s.add(this._stakedTotal(p)); return s; }

  /**
   * COMBIEN DE TEMPS LE COFFRE TIENT.
   *
   * ---- pourquoi un niveau ne suffit pas ----
   *
   * L'alarme de solvabilite compare ce qu'il y a dans le coffre a ce qu'on
   * doit. Elle sonne quand c'est deja passe dessous — c'est-a-dire le jour ou
   * on l'apprend par un joueur qui n'arrive pas a retirer.
   *
   * A 100 % l'an, la dette ne saute pas : elle MONTE, a la seconde, d'un
   * montant qui se calcule. Une salle a cent millions en staking fabrique cent
   * millions de dette par an, soit environ 274 000 par jour, qu'il se passe
   * quelque chose ou non.
   *
   * En face, l'avantage de la maison ENCAISSE tous les jours. Les deux
   * courbes se croisent a une date, et cette date se calcule aujourd'hui.
   * C'est le seul chiffre qui previent au lieu de constater.
   *
   * @param {BigNumber|null} pot ce qu'il y a reellement dans le coffre
   */
  autonomie(pot) {
    const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));
    const staked = f(this.totalStaked());
    const bMaison = this.owedBreakdown();
    const stakedMaison = f(bMaison.maisonStaked || BN(0));
    /* Ce que le staking coute chaque jour, que quelqu'un joue ou non.
       LE RENDEMENT QUE LA MAISON SE VERSE A ELLE-MEME N'EST PAS UN DRAIN : il
       sort d'une poche pour entrer dans l'autre. Le compter ferait afficher un
       cout quotidien enorme et une autonomie de quelques jours alors que rien
       ne quitte le coffre. On donne donc les deux — le cout brut, et celui qui
       concerne vraiment des joueurs. */
    const rendementJour = staked * (cfg.STAKE_APR_BPS / 10000) / 365;
    const rendementJoueurs = Math.max(0, staked - stakedMaison) * (cfg.STAKE_APR_BPS / 10000) / 365;
    /* Ce que la maison encaisse chaque jour, mesure sur le mois en cours et
       non estime : c'est le seul des deux chiffres qui puisse surprendre. */
    const c = this.comptes();
    const jours = Math.max(1, new Date().getUTCDate());
    const revenuJour = (c.revenu || 0) / jours;
    /* Le drain se mesure sur le rendement QUI PART VRAIMENT — celui des
       joueurs. C'est lui qui vide le coffre ; l'autre tourne en rond. */
    const drainJour = rendementJoueurs - revenuJour;

    const b = this.owedBreakdown();
    const du = f(b.balances.add(b.staked).add(b.pending).add(b.jackpot));
    const surplus = pot ? f(pot) - du : null;

    return {
      /* Ce que la maison tient elle-meme, en clair a cote du surplus. Sans
         cette ligne le surplus monterait de neuf millions sans explication —
         et un chiffre de solvabilite qui bouge sans raison lisible ne sert
         plus a rien. */
      /* Ce que la maison tient elle-meme. Il est COMPRIS dans le « du » —
         ces comptes peuvent retirer — et affiche a part pour que le
         proprietaire lise sa vraie position sans que le chiffre de
         solvabilite devienne faux. */
      maison: f(b.maison), maisonN: b.maisonN, maisonStaked: stakedMaison,
      /* Le surplus SANS les comptes maison — ce qu'il vaudrait si leurs jetons
         etaient une dette. Il n'est plus le chiffre d'alarme, mais il reste
         celui qu'on veut lire le jour ou l'on se demande « et si je devais
         rendre meme ca ». */
      surplusHorsMaison: surplus === null ? null : Number((surplus - f(b.maison)).toFixed(6)),
      staked, rendementJour: Number(rendementJour.toFixed(6)),
      rendementJoueurs: Number(rendementJoueurs.toFixed(6)),
      revenuJour: Number(revenuJour.toFixed(6)),
      drainJour: Number(drainJour.toFixed(6)),
      surplus: surplus === null ? null : Number(surplus.toFixed(6)),
      /* null = le revenu couvre le rendement, la salle se paie toute seule.
         0 = deja sous l'eau. Sinon, le nombre de jours qui restent. */
      joursRestants: (surplus === null) ? null
        : (drainJour <= 0 ? null : Math.max(0, Math.floor(surplus / drainJour))),
      /* Le staking que le REVENU seul pourrait porter, sans rien remettre au
         coffre. C'est le chiffre a comparer au plafond. */
      stakingAutofinance: Number((revenuJour * 365 / (cfg.STAKE_APR_BPS / 10000)).toFixed(0)),
    };
  }

  /** Breakdown (wei) of what the vault owes: player balances, staked, pending
   * yield, and the two progressive pots.
   *
   * LES DEUX CAGNOTTES SONT UNE DETTE, pas une reserve de la maison. Elles ont
   * ete promises : le pot du Coin Pusher se paie au prochain declencheur, celui
   * du Boulier au prochain 10/10. Les laisser hors de ce calcul ferait afficher
   * un surplus retirable superieur d'un million au reel — et le proprietaire
   * retirerait de bonne foi l'argent d'un gagnant qui n'a pas encore joue. */
  /** Cette adresse appartient-elle a la maison ? */
  estMaison(addr) {
    return (cfg.COMPTES_MAISON || []).indexOf(String(addr || '').toLowerCase()) >= 0;
  }

  owedBreakdown() {
    let balances = BN(0), staked = BN(0), pending = BN(0);
    /* CE QUE TIENNENT LES COMPTES DE LA MAISON est compte a part, jamais
       retire en silence. Le surplus est un chiffre de solvabilite : s'il monte
       de neuf millions, il faut pouvoir dire d'ou ils viennent. */
    let maison = BN(0), maisonN = 0, maisonStaked = BN(0);
    for (const [addr, p] of this.players) {
      const st = this._stakedTotal(p);
      const pe = p.stakeAccrued.add(this._pendingAll(p));
      /* ---- LES COMPTES DE LA MAISON RESTENT DANS LE « DU » ----
       *
       * Ma premiere version les en sortait, ce qui faisait monter le surplus
       * d'autant. C'etait juste A UNE CONDITION : que ces comptes ne puissent
       * plus retirer. Ils le peuvent — decision du proprietaire — donc leurs
       * jetons sont une creance comme une autre, et les sortir du « du »
       * aurait annonce 81 millions de surplus qui peuvent partir a tout
       * moment. Un chiffre de solvabilite se calcule au pire, jamais au mieux.
       *
       * Ils sont comptes A PART pour l'affichage : le proprietaire doit
       * pouvoir lire « le coffre couvre tout, et 81 M de ce qu'il couvre sont
       * a moi » — deux nombres, pas un seul qui melange les deux. */
      /* ---- EXCLU DU « DU », ET C'EST INDISSOCIABLE DU VERROU DE RETRAIT ----
       *
       * A tout instant, l'exclusion est une comptabilite juste : ces jetons
       * sont a la maison, ils n'attendent aucun joueur. Le danger n'est pas
       * dans la formule, il est dans L'ORDRE DES GESTES.
       *
       * Le proprietaire lit « surplus : 92 M » et le retire. Le coffre tombe
       * a ce qu'on doit aux joueurs. Or la fiche du compte maison porte
       * toujours une creance de 81 M — `p.balance` ne sait pas qu'elle a ete
       * exclue — et `requestWithdraw` ne regarde que cette fiche. Il signerait
       * un bon pour de l'argent qui n'est plus la, et ce sont les joueurs qui
       * paieraient.
       *
       * Le verrou de `requestWithdraw` fait que cette creance ne peut JAMAIS
       * etre exercee. Les deux moities tiennent ensemble ; retirer l'une sans
       * l'autre est le trou. `maison.test.js` echoue si l'une disparait. */
      if (this.estMaison(addr)) {
        maison = maison.add(p.balance).add(st).add(pe);
        maisonStaked = maisonStaked.add(st);
        maisonN++;
        continue;
      }
      balances = balances.add(p.balance);
      staked = staked.add(st);
      pending = pending.add(pe);
    }
    return { balances, staked, pending, maison, maisonN, maisonStaked,
             jackpot: this.jackpotPot.add(this.boulierPot),
             jackpotPusher: this.jackpotPot, jackpotBoulier: this.boulierPot };
  }

  /** Everything the vault OWES players right now (wei): balances + staked +
   * pending yield + the jackpot pot. Owner surplus = vaultPot − this. */
  totalOwed() {
    const b = this.owedBreakdown();
    return b.balances.add(b.staked).add(b.pending).add(b.jackpot);
  }

  /** Une ligne par joueur pour le tableau de bord proprietaire (/players). */
  playersReport() {
    const f = (w) => ethers.utils.formatUnits(w || BN(0), cfg.DECIMALS);
    const rows = [];
    /* EN UNE PASSE, pas une par joueur : deux cents joueurs fois dix mille
       paris feraient deux millions de comparaisons a chaque rafraichissement
       du panneau, toutes les quinze secondes. */
    const bilans = this._bilansParis();
    for (const [addr, p] of this.players) {
      const staked = this._stakedTotal(p);
      const pending = p.stakeAccrued.add(this._pendingAll(p));
      rows.push({
        address: addr,
        name: p.name || addr.slice(0, 6),
        visage: p.visage || null,          // le visage fait partie de l'identite affichee
        photo: !!p.photo,                  // et sa photo, s'il en a televerse une
        amis: (p.amis || []).length,
        balance: f(p.balance),
        staked: f(staked),
        pending: f(pending),
        wagered: f(p.wagered),                     // total joue a vie
        bets: p.betCount || 0,                     // nombre de mises, tous jeux
        /* LES PARIS SPORTIFS A PART. `bets` compte les mises de casino, qui
           se reglent dans la seconde ; un pari vit plusieurs jours et n'entre
           dans aucun compteur de manche tant qu'il n'est pas tranche. Le
           panneau affichait donc zero pour quelqu'un qui avait trois mille
           jetons engages. */
        paris: bilans.get(addr) || null,
        withdrawn: f(p.cumulativeAuthorized),
        deposited: !!p.hasDeposited,
        depositedAmount: f(p.deposited),
        /* Le seul chiffre qui repond a « d'ou vient cet argent ? » :
           ce qu'il detient, plus ce qu'il a sorti, moins ce qu'il a mis.
           Un joueur normal est LEGEREMENT NEGATIF — c'est l'avantage de la
           maison. Fortement positif sans mise correspondante, c'est une entree
           d'argent qui ne vient pas du jeu. */
        net: f(p.balance.add(staked).add(pending).add(p.cumulativeAuthorized)
                .sub(p.deposited || BN(0))),
        jeux: p.jeux || {},
        tgId: p.tgId || null,
        total: f(p.balance.add(staked).add(pending)),
        /* ---- CE QUE LA TABLE NE DISAIT PAS ----
         *
         * Inscription, derniere visite, niveau, serie, collection. Tous ces
         * champs existaient dans la fiche et aucun n'arrivait au panneau : on
         * ne pouvait donc pas trier les joueurs par anciennete, ni voir d'un
         * coup d'oeil qui n'est plus venu depuis un mois.
         *
         * Ils sont pris DIRECTEMENT sur la fiche, sans recalcul : le niveau
         * et la collection se lisent, ils ne se comptent pas. La table passe
         * toutes les quinze secondes sur deux cents joueurs — ce qui coute
         * cher ici le coute deux cents fois. */
        creeLe: p.creeLe || 0,
        dernierJour: p.dayKey || null,
        niveau: this.niveauDeFiche(p),
        xp: Math.round(this._xpTotale(p)),
        streak: p.streakDay || 0,
        objets: Object.keys(p.objets || {}).length,
      });
    }
    rows.sort((a, b) => parseFloat(b.wagered) - parseFloat(a.wagered));
    return rows;
  }

  /**
   * LA FICHE COMPLETE D'UN JOUEUR, pour le panneau.
   *
   * ---- pourquoi elle ne passe pas par playersReport ----
   *
   * `playersReport()` sert la TABLE : deux cents lignes toutes les quinze
   * secondes. Y ajouter la collection, les quetes du jour et le detail du
   * staking ferait payer a chaque rafraichissement le prix d'une information
   * qu'on ne regarde que sur un joueur a la fois. Les deux vues ont des couts
   * differents parce qu'elles ont des cadences differentes.
   *
   * ---- ce qu'elle doit permettre ----
   *
   * Repondre a « je n'ai pas recu mon gain » sans ouvrir un fichier. Donc :
   * qui il est, ce qu'il a, d'ou ca vient, ou il en est, et ce qu'il a fait.
   * Le `net` est le chiffre qui repond a la derniere question — ce qu'il
   * detient plus ce qu'il a sorti, moins ce qu'il a mis. Un joueur normal est
   * legerement negatif : c'est l'avantage de la maison.
   */
  ficheAdmin(addr) {
    const a = String(addr || '').toLowerCase();
    const p = this.players.get(a);
    if (!p) return null;
    const f = (w) => ethers.utils.formatUnits(w || BN(0), cfg.DECIMALS);
    const staked = this._stakedTotal(p);
    const pending = p.stakeAccrued.add(this._pendingAll(p));

    /* La collection, comptee sur le catalogue et pas sur l'inventaire : c'est
       « 12 sur 30 » qui renseigne, pas « 12 ». */
    const objets = p.objets || {};
    const possedes = boutique.ITEMS.filter((o) => objets[o.id]);
    const familles = boutique.FAMILLES.map((fa) => {
      const l = boutique.ITEMS.filter((o) => o.famille === fa.cle);
      const ai = l.filter((o) => objets[o.id]).length;
      return { cle: fa.cle, nom: fa.nom, saison: fa.saison, a: ai, sur: l.length,
               complete: l.length > 0 && ai === l.length };
    });

    let quetes = [];
    try { quetes = this.quetesDuJour(a).map((q) => this._queteVue(p, q, false)); }
    catch (e) { quetes = []; }

    return {
      /* ---- qui ---- */
      address: a,
      name: p.name || null, nomChoisi: !!p.nomChoisi, nomPaye: !!p.nomPaye,
      visage: p.visage || null, photo: !!p.photo,
      tgId: p.tgId || null,
      /* `creeLe` vaut 0 sur les fiches anterieures a son arrivee. On rend le
         zero tel quel plutot qu'une date inventee : « inconnu » est une
         reponse, « 1er janvier 1970 » est un mensonge. */
      creeLe: p.creeLe || 0,
      dernierJour: p.dayKey || null,

      /* ---- l'argent ---- */
      argent: {
        balance: f(p.balance), staked: f(staked), pending: f(pending),
        total: f(p.balance.add(staked).add(pending)),
        deposited: f(p.deposited), hasDeposited: !!p.hasDeposited,
        withdrawn: f(p.cumulativeAuthorized),
        wagered: f(p.wagered), bets: p.betCount || 0,
        net: f(p.balance.add(staked).add(pending).add(p.cumulativeAuthorized)
               .sub(p.deposited || BN(0))),
        dayNet: f(p.dayNet), meilleurJour: p.meilleurJour || null,
      },

      /* ---- ou il en est ---- */
      progression: {
        niveau: this.niveauDeFiche(p),
        xp: Math.round(this._xpTotale(p)),
        xpGagnee: Math.round(p.xp || 0),
        xpSources: p.xpSources || {},
        collection: { a: possedes.length, sur: boutique.ITEMS.length },
        familles,
        rachatOuvert: this.rachatVerrou(a),
      },

      /* ---- ce qui le fait revenir ---- */
      engagement: {
        streakDay: p.streakDay || 0,
        streakDernier: p.streakLastClaimDay || null,
        coffreOffert: this.coffreOffert(a),
        quetes,
        parfait: this.parfaitEtat ? (() => { try { return this.parfaitEtat(a); } catch (e) { return null; } })() : null,
        amis: (p.amis || []).length,
        parrain: p.parrain || null,
        filleuls: (p.filleuls || []).length,
        refTotal: f(p.refTotal), refDu: f(p.refDu),
      },

      /* ---- ce qu'il a joue ---- */
      jeux: p.jeux || {},
      stakes: this.stakeInfo(a),
      maison: this.estMaison(a),
    };
  }

  stakeInfo(addr) {
    const p = this._p(addr);
    const pending = p.stakeAccrued.add(this._pendingAll(p));
    const now = Date.now();
    let locked = BN(0), unlocked = BN(0), nextUnlock = null;
    for (const pos of p.stakes) {
      if (!this._verrouille(pos, now)) unlocked = unlocked.add(pos.a);
      else { locked = locked.add(pos.a); if (nextUnlock === null || pos.u < nextUnlock) nextUnlock = pos.u; }
    }
    const f = (w) => ethers.utils.formatUnits(w, cfg.DECIMALS);
    return {
      staked: f(this._stakedTotal(p)), locked: f(locked), unlocked: f(unlocked),
      pending: f(pending), aprBps: cfg.STAKE_APR_BPS,
      penaltyBps: cfg.STAKE_EARLY_PENALTY_BPS, lockDays: cfg.STAKE_LOCK_DAYS, nextUnlock,
      /* La salle, vue de l'exterieur. Elle part AVEC l'etat du joueur : sinon
         il decouvre que c'est plein apres avoir tape son montant, ce qui se
         lit comme une panne et non comme une regle. */
      capacite: this.capaciteStaking(addr),
    };
  }

  /**
   * Les missions du jour : trois jeux nommes, qui changent chaque jour.
   *
   * Le tirage n'en est pas un — c'est une rotation calculee a partir du numero
   * du jour. Tout le monde voit donc les memes jeux le meme jour (ce qui se
   * raconte dans le canal), personne ne peut la faire tourner en rechargeant,
   * et le pas etant premier avec la longueur du catalogue, chaque jeu revient
   * a intervalle regulier au lieu d'etre oublie des semaines.
   */
  missionsDuJour(jourKey) {
    const cat = cfg.MISSION_CATALOGUE || [];
    const k = Math.max(0, Math.min(cfg.MISSIONS_PAR_JOUR || 0, cat.length));
    if (!k) return [];
    /* Le numero du jour depuis l'epoque, lu sur la CLE du jour et non sur
       l'horloge : la cle est ce qui remet les compteurs a zero, les deux
       doivent basculer au meme instant. */
    const jour = Math.floor(Date.parse((jourKey || this._today()) + 'T00:00:00Z') / 86400000);
    const out = [];
    for (let i = 0; i < k; i++) {
      const [jeu, nom, page] = cat[(((jour * k + i) % cat.length) + cat.length) % cat.length];
      out.push({ id: 'm:' + jeu, jeu, nom, page, metric: 'mise',
                 label: 'Wager ' + cfg.MISSION_MISE.toLocaleString('en-US') + ' $SWOGE on ' + nom,
                 target: cfg.MISSION_MISE, reward: cfg.MISSION_GAIN });
    }
    return out;
  }

  /* ====================================================================
   * LES CINQ QUETES DU JOUR
   * ====================================================================
   *
   * ---- la selection est CALCULEE, jamais tiree ----
   *
   * Elle se rejoue a partir de la date seule. C'est ce qui permet de repondre
   * a « pourquoi j'ai eu ca » sans stocker un tirage par joueur, et ce qui
   * fait que deux joueurs comparent la meme journee.
   *
   * ---- l'anti-repetition est STRUCTURELLE, pas historique ----
   *
   * Ma premiere idee etait « une quete ne revient pas avant trois jours »,
   * verifiee contre les journees precedentes. Elle ne tient pas : pour
   * calculer aujourd'hui il faudrait calculer hier, qui a besoin d'avant-hier,
   * et ainsi de suite sans fin.
   *
   * Le pas modulaire regle ca sans memoire : la quete d'indice i d'un palier
   * de N sort le jour ou (jour * k + slot) % N == i. Chaque quete revient donc
   * exactement tous les N/k jours, et il suffit que N/k depasse trois. C'est
   * la meme mecanique que la rotation des jeux, qui marchait deja.
   *
   * ---- ce qui est FILTRE avant de tourner ----
   *
   * Les quetes de collection ne sont proposees qu'a qui possede deja un objet,
   * celle du parrainage qu'a qui a un filleul, et les paliers Hard et Elite
   * n'apparaissent qu'apres quelques jours. Une quete impossible sur le papier
   * est pire qu'une quete absente : elle apprend a ne pas lire la liste.
   *
   * Le filtre casse la promesse « tout le monde voit la meme chose », et c'est
   * assume : un debutant voit MOINS de quetes, jamais d'autres.
   */
  _queteEligible(p, q, jours) {
    if (q.cond === 'aDesObjets' && !Object.keys(p.objets || {}).length) return false;
    if (q.cond === 'aDesFilleuls' && !(p.filleuls || []).length) return false;
    /* L'introduction progressive. Montrer les cinq paliers a quelqu'un qui
       n'a rien lui montre surtout ce qu'il n'a pas. */
    if (q.palier === 'hard' && jours < 3) return false;
    if (q.palier === 'elite' && !Object.keys(p.objets || {}).length) return false;
    return true;
  }

  /** Depuis combien de jours cette fiche existe. Sert a l'introduction. */
  _anciennete(p) {
    if (!p.creeLe) return 99;            // fiche d'avant ce champ : pas un debutant
    return Math.max(0, Math.floor((Date.now() - p.creeLe) / 86400000));
  }

  /** La cible d'une quete de volume, calee sur le solde du joueur. */
  _queteCible(p) {
    const solde = Number(ethers.utils.formatUnits(p.balance || BN(0), cfg.DECIMALS));
    const c = Math.min(cfg.QUETE_CIBLE_MAX, solde * cfg.QUETE_CIBLE_MULT);
    return Math.max(cfg.QUETE_CIBLE_MIN, Math.round(c / 10) * 10);
  }

  quetesDuJour(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const jour = Math.floor(Date.parse((p.dayKey || this._today()) + 'T00:00:00Z') / 86400000);
    const anc = this._anciennete(p);
    const pool = cfg.QUETES_POOL || [];
    const jeux = this.missionsDuJour(p.dayKey);       // la rotation des jeux, deja en place
    const cible = this._queteCible(p);

    /* Un compteur de creneau par palier : deux Normal le meme jour doivent
       piocher a deux endroits differents de leur liste. */
    const pris = {}, sortie = [], vus = new Set(), jeuxVus = new Set();
    (cfg.QUETE_COMPO || []).forEach((palier, slot) => {
      const lot = pool.filter((q) => q.palier === palier && this._queteEligible(p, q, anc));
      if (!lot.length) return;
      const k = pris[palier] = (pris[palier] || 0);
      pris[palier]++;
      /* On part de la position calculee, et on avance jusqu'a une quete pas
         encore prise ce jour-la. Sans cette avance, deux creneaux du meme
         palier tomberaient sur la meme quete des que la liste est courte. */
      /* ---- LE PAS DOIT ETRE PREMIER AVEC LA LONGUEUR ----
       *
       * Ma premiere version avancait de `QUETE_COMPO.length` par jour. Sur un
       * palier qui compte exactement ce nombre de quetes, le terme du jour
       * s'annule modulo la longueur : la selection ne bougeait plus JAMAIS.
       * Mesure : huit jours d'affilee, les deux memes quetes Normal.
       *
       * Un pas de 1 est premier avec n'importe quelle longueur — c'est la
       * seule valeur qui ne peut pas retomber dans ce piege quel que soit le
       * nombre de quetes qu'on ajoutera ensuite. Le decalage par creneau
       * suffit a separer deux creneaux d'un meme palier. */
      let q = null;
      for (let d = 0; d < lot.length; d++) {
        const cand = lot[(((jour + slot + d) % lot.length) + lot.length) % lot.length];
        if (vus.has(cand.id)) continue;
        q = cand; break;
      }
      if (!q) return;
      vus.add(q.id);

      const vue = { id: q.id, palier: q.palier, metric: q.metric, cible: q.cible || 1,
                    label: q.label, jeu: null, nom: null, page: null };
      if (q.volume) vue.cible = cible;
      if (q.jeuDuJour) {
        /* PAS DEUX FOIS LE MEME JEU : sinon la journee entiere se joue sur une
           seule table, et on perd la distribution qui est le meilleur effet du
           systeme. */
        const libre = jeux.filter((m) => !jeuxVus.has(m.jeu));
        const m = libre[0] || jeux[k % Math.max(1, jeux.length)];
        if (!m) return;
        jeuxVus.add(m.jeu);
        vue.jeu = m.jeu; vue.nom = m.nom; vue.page = m.page;
        vue.cible = cible;
      }
      vue.label = String(q.label)
        .replace('{cible}', Number(vue.cible).toLocaleString('en-US'))
        .replace('{jeu}', vue.nom || '');
      vue.reward = (cfg.QUETE_GAIN || {})[q.palier] || 0;
      vue.xp = (cfg.QUETE_XP || {})[q.palier] || 0;
      sortie.push(vue);
    });
    return sortie;
  }

  /* Une quete, vue par le joueur. Le meme calcul sert a l'affichage et a la
     reclamation : deux calculs finiraient par diverger, et celui qui diverge
     paie ou refuse de payer a tort. */
  _queteVue(p, q, locked) {
    const cible = q.cible !== undefined ? q.cible : q.target;
    const prog = this._queteProgres(p, q);
    const done = prog >= cible;
    const claimed = !!p.questClaimed[q.id];
    /* LES JETONS ATTENDENT LE PREMIER DEPOT, L'XP NON. La marge anti-farming
       vient du volume mise ; un debutant a 100 jetons voit sa cible tomber a
       300, donc huit d'esperance contre trente distribues. Couper en deux ce
       qui etait ferme d'un bloc garde la retention ouverte a tous et laisse
       une adresse jetable ne rapporter que de l'XP — qui ne se retire pas. */
    const jetons = (cfg.QUETE_JETONS_APRES_DEPOT && !p.hasDeposited) ? 0 : (q.reward || 0);
    return { id: q.id, label: q.label, metric: q.metric, target: cible, reward: jetons,
             recompenseBloquee: jetons !== (q.reward || 0),
             xp: q.xp || 0, palier: q.palier || null,
             jeu: q.jeu || null, nom: q.nom || null, page: q.page || null,
             progress: Math.min(prog, cible), done, claimed, locked,
             claimable: done && !claimed && !locked };
  }

  /**
   * OU EN EST LE JOUEUR SUR CE COMPTEUR.
   *
   * Un seul endroit qui traduit un `metric` en nombre. Deux endroits — un pour
   * l'affichage, un pour la reclamation — finiraient par diverger, et celui
   * qui diverge paie ou refuse de payer a tort.
   *
   * Aucun de ces compteurs n'a demande de toucher au moteur d'un jeu : ils se
   * lisent tous sur ce qui etait deja compte. `jeux` est le nombre de clefs de
   * `miseJour`, et un duel y depose deja son identifiant.
   */
  _queteProgres(p, q) {
    const inv = p.objets || {};
    const mj = p.miseJour || {};
    const jc = p.jourColl || {};
    switch (q.metric) {
      case 'drops': return p.dropsToday || 0;
      case 'wins':  return p.winsToday || 0;
      case 'mise':  return mj[q.jeu] || 0;
      case 'jeux':  return Object.keys(mj).length;
      case 'total': return Object.values(mj).reduce((a, b) => a + b, 0);
      case 'paris': return (mj.paris || 0) > 0 ? 1 : 0;
      case 'duel':  return Game.JEUX_DUEL.some((j) => (mj[j] || 0) > 0) ? 1 : 0;
      case 'parisGagnes': return p.parisGagnesJour || 0;
      case 'coffres': return jc.coffres || 0;
      case 'neufs':   return jc.neufs || 0;
      /* Le RANG de rarete, pas la quantite : « rare ou mieux » est un seuil
         sur l'echelle, et l'echelle est celle de la boutique. */
      case 'rarete':  return jc.rarete || 0;
      case 'sortes':  return Object.keys(inv).filter((k) => inv[k] > 0).length;
      case 'pleines': {
        const fams = {};
        for (const o of boutique.ITEMS) if (inv[o.id]) fams[o.famille] = (fams[o.famille] || 0) + 1;
        return Object.values(fams).filter((n) => n === boutique.RARETES.length).length;
      }
      case 'serie': return p.streakLastClaimDay === this._today() ? 1 : 0;
      case 'filleul': {
        const t = this._today();
        return (p.filleuls || []).some((f) => {
          const q2 = this.players.get(String(f).toLowerCase());
          return !!(q2 && q2.dayKey === t && Object.keys(q2.miseJour || {}).length);
        }) ? 1 : 0;
      }
      default: return q.cible !== undefined ? q.cible : (q.target || 0);
    }
  }

  static get JEUX_DUEL() { return ['p4', 'mp', 'dm', 'mf', 'dc']; }

  /** Per-player daily quest state (progress + claimable flags). */
  questState(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const locked = cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited;
    return this.quetesDuJour(addr).map((q) => this._queteVue(p, q, locked));
  }

  /**
   * LA JOURNEE PARFAITE.
   *
   * Les cinq quetes du jour reclamees. Elle paie un coffre de bois — le
   * meilleur objet de recompense du site : une emotion, un objet plafonne,
   * aucune valeur monetaire a defendre.
   *
   * ---- LE PLAFOND N'EST PAS DECORATIF ----
   *
   * La saison 1 compte 9 600 pieces. Un coffre par joueur et par jour, c'est
   * l'edition entiere en six cents jours a seize joueurs — et en DIX-NEUF a
   * cinq cents. Une edition brulee ne se rattrape pas, et personne ne s'en
   * apercevrait avant qu'il soit trop tard. Le compteur est donc global, remis
   * a zero chaque jour, et il rend l'XP seule quand il est atteint plutot que
   * de refuser : le joueur a fait le travail.
   */
  parfaitEtat(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const l = this.questState(addr);
    const total = l.length;
    const faites = l.filter((q) => q.claimed).length;
    return {
      total, faites,
      pret: total > 0 && faites >= total && p.parfaitJour !== p.dayKey,
      pris: p.parfaitJour === p.dayKey,
      coffre: Game.COFFRE_OFFERT,
      xp: cfg.PARFAIT_XP,
      restantGlobal: Math.max(0, cfg.COFFRES_GRATUITS_JOUR - this._coffresGratuitsDuJour()),
    };
  }

  /* Le compteur global des coffres gratuits — coffre du jour ET journee
     parfaite. Il vit en memoire et repart a zero chaque jour : sa raison
     d'etre est de borner une ferme d'adresses dans la journee, pas de tenir
     une comptabilite. Un redemarrage le remet a zero, ce qui est le bon
     compromis : l'edition, elle, est protegee par ses plafonds par objet. */
  _coffresGratuitsDuJour() {
    const t = this._today();
    if (this.coffresGratuitsJour !== t) { this.coffresGratuits = 0; this.coffresGratuitsJour = t; }
    return this.coffresGratuits || 0;
  }
  _prendCoffreGratuit() {
    if (this._coffresGratuitsDuJour() >= cfg.COFFRES_GRATUITS_JOUR) return false;
    this.coffresGratuits = this._coffresGratuitsDuJour() + 1;
    return true;
  }

  reclameParfait(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const e = this.parfaitEtat(addr);
    if (e.pris) throw new Error('already claimed today');
    if (!e.pret) throw new Error(`finish all ${e.total} quests first (${e.faites}/${e.total})`);
    p.parfaitJour = p.dayKey;
    this._gagneXp(p, cfg.PARFAIT_XP, 'parfait');
    /* Le coffre passe par le MEME chemin que tous les autres. Sous le plafond
       global il part ; au-dessus, l'XP seule — refuser apres coup une
       recompense annoncee serait pire que la reduire. */
    let gagne = null;
    if (this._prendCoffreGratuit()) gagne = this.boutiqueAchat(addr, Game.COFFRE_OFFERT, { gratuit: true });
    return { xp: cfg.PARFAIT_XP, gagne, plafonne: !gagne };
  }

  /** Claim a completed quest → credit its reward. Throws on any invalid claim. */
  claimQuest(addr, id) {
    const p = this._p(addr); this._bumpDay(p);
    /* Les missions du jour se cherchent dans la liste DU JOUR : celle d'hier
       n'existe plus, et un identifiant garde de la veille ne doit pas payer
       aujourd'hui. */
    /* Les quetes du jour se cherchent dans la liste DU JOUR : celle d'hier
       n'existe plus, et un identifiant garde de la veille ne doit pas payer
       aujourd'hui. */
    const q = this.quetesDuJour(addr).find((x) => x.id === id);
    if (!q) throw new Error('unknown quest');
    if (cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited) throw new Error('deposit first to unlock quests');
    const vue = this._queteVue(p, q, false);
    if (!vue.done) throw new Error('quest not complete yet');
    if (p.questClaimed[q.id]) throw new Error('already claimed today');
    p.questClaimed[q.id] = true;
    /* On paie CE QUE LA VUE ANNONCE, jamais la valeur brute du pool : deux
       calculs de la recompense finiraient par diverger, et celui qui diverge
       paie ce que le joueur n'a pas vu. */
    const r = WEI(vue.reward);
    p.balance = p.balance.add(r);
    p.dayNet = p.dayNet.add(r);
    /* L'XP suit le PALIER de la quete. C'est elle qui porte la progression :
       les jetons restent symboliques parce qu'ils se comparent a une mise et
       perdent la comparaison, l'XP ne se compare a rien. */
    this._gagneXp(p, q.xp || cfg.XP_QUETE, 'quete');
    return vue.reward;
  }

  // ---- Telegram link (for the Adsgram reward postback) ----
  linkTelegram(addr, tgId) {
    if (!tgId) return;
    tgId = String(tgId);
    const p = this._p(addr);
    p.tgId = tgId;
    this.telegramMap.set(tgId, addr.toLowerCase());
  }

  // ---- New-player welcome bonus (granted once, on first authenticated login) ----
  /** Grant the demo credit exactly once. Returns the granted amount (0 if already given). */
  grantWelcome(addr) {
    const p = this._p(addr);
    if (p.welcomeGranted) return 0;
    p.welcomeGranted = true;
    if (cfg.WELCOME_BONUS > 0) { p.balance = p.balance.add(WEI(cfg.WELCOME_BONUS)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(cfg.WELCOME_BONUS)); this.note('bonus', cfg.WELCOME_BONUS); }
    return cfg.WELCOME_BONUS;
  }

  /** Claim the extra welcome reward — allowed only after the player has wagered. */
  claimWelcome(addr) {
    const p = this._p(addr);
    if (!p.welcomeGranted) throw new Error('welcome bonus not granted yet');
    if (!p.welcomeWagered) throw new Error('play your welcome bonus first');
    if (p.welcomeClaimed) throw new Error('welcome reward already claimed');
    p.welcomeClaimed = true;
    const r = WEI(cfg.WELCOME_CLAIM);
    p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r);
    return cfg.WELCOME_CLAIM;
  }

  // ---- 7-day login ladder ----
  /**
   * Le palier que la reclamation d'AUJOURD'HUI crediterait (1..N), sans rien
   * modifier.
   *
   * UN TROU NE REMET PLUS A ZERO. Avant, rater une journee renvoyait le joueur
   * au palier 1 : il revenait le surlendemain, voyait « Claim day 1 » a la
   * place de « day 2 » et concluait, a raison, que la reclamation ne marchait
   * pas. Une echelle qui punit l'absence punit surtout ceux qui reviennent.
   * On avance donc d'un palier a chaque journee reclamee, quel que soit
   * l'ecart ; la seule regle qui reste est UNE reclamation par journee.
   */
  _streakToday(p) {
    const rewards = cfg.STREAK_REWARDS, N = rewards.length || 1;
    if (p.streakLastClaimDay === this._today()) return { day: p.streakDay, claimedToday: true };
    // jamais rien reclame -> palier 1 ; sinon le suivant, qui reboucle N -> 1
    const day = p.streakLastClaimDay ? (p.streakDay % N) + 1 : 1;
    return { day, claimedToday: false };
  }

  /** Public streak state for the UI. */
  streakState(addr) {
    const p = this._p(addr);
    const rewards = cfg.STREAK_REWARDS;
    const s = this._streakToday(p);
    return { day: s.day, claimedToday: s.claimedToday, rewards,
             todayReward: rewards[(s.day - 1) % rewards.length] || 0,
             claimable: !s.claimedToday };
  }

  /** Claim today's streak reward (once per UTC day). Returns { day, reward }. */
  claimStreak(addr) {
    const p = this._p(addr);
    const s = this._streakToday(p);
    if (s.claimedToday) throw new Error('streak already claimed today');
    const reward = cfg.STREAK_REWARDS[(s.day - 1) % cfg.STREAK_REWARDS.length] || 0;
    p.streakDay = s.day;
    p.streakLastClaimDay = this._today();
    if (reward > 0) { const r = WEI(reward); p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r); }
    /* REVENIR VAUT DE L'XP. C'est la source la plus importante des cinq : elle
       est la seule qu'un joueur puisse toucher sans engager un seul jeton. */
    const x = this._gagneXp(p, cfg.XP_CONNEXION, 'connexion');
    return { day: s.day, reward, xp: x ? x.gagne : 0, niveauMonte: !!(x && x.monte) };
  }

  /** Combined welcome + streak state for the client. */
  bonusState(addr) {
    const p = this._p(addr);
    return {
      welcome: { granted: !!p.welcomeGranted, wagered: !!p.welcomeWagered, claimed: !!p.welcomeClaimed,
                 amount: cfg.WELCOME_BONUS, reward: cfg.WELCOME_CLAIM,
                 claimable: !!p.welcomeGranted && !!p.welcomeWagered && !p.welcomeClaimed },
      streak: this.streakState(addr),
      ad: this.adState(addr),
    };
  }

  // ---- Rewarded video ads (Adsgram) ----
  _adBump(p) { const t = this._today(); if (p.adDayKey !== t) { p.adDayKey = t; p.adCount = 0; } }
  /** How many ad rewards are left today + cooldown remaining (seconds). */
  adState(addr) {
    const p = this._p(addr); this._adBump(p);
    const left = Math.max(0, cfg.AD_DAILY_CAP - (p.adCount || 0));
    const cool = Math.max(0, Math.ceil((p.adLastMs + cfg.AD_COOLDOWN_SEC * 1000 - Date.now()) / 1000));
    return { reward: cfg.AD_REWARD, dailyCap: cfg.AD_DAILY_CAP, watchedToday: p.adCount || 0, left, cooldown: cool, blockId: cfg.ADSGRAM_BLOCK_ID };
  }

  /**
   * Credit an Adsgram rewarded video, looked up by Telegram id. Enforces the
   * daily cap + cooldown so the reward postback can't be replayed for free coins.
   * Returns { ok, reward, balance, addr } or { ok:false, reason }.
   */
  grantAdReward(tgId) {
    tgId = String(tgId || '');
    const addr = this.telegramMap.get(tgId);
    if (!addr) return { ok: false, reason: 'unknown_user' };
    const p = this._p(addr); this._adBump(p);
    const now = Date.now();
    if (now < p.adLastMs + cfg.AD_COOLDOWN_SEC * 1000) return { ok: false, reason: 'cooldown', addr };
    if ((p.adCount || 0) >= cfg.AD_DAILY_CAP) return { ok: false, reason: 'daily_cap', addr };
    p.adCount = (p.adCount || 0) + 1;
    p.adLastMs = now;
    const r = WEI(cfg.AD_REWARD);
    p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r);
    return { ok: true, reward: cfg.AD_REWARD, balance: this.balanceStr(addr), addr };
  }

  /** Top `n` players by today's net gain (winners only). */
  leaderboard(n) {
    const t = this._today(), arr = [];
    for (const p of this.players.values()) {
      if (p.dayKey === t && p.dayNet.gt(0)) arr.push({ name: p.name, net: ethers.utils.formatUnits(p.dayNet, cfg.DECIMALS) });
    }
    arr.sort((a, b) => parseFloat(b.net) - parseFloat(a.net));
    return arr.slice(0, n);
  }

  _rotateSeed() {
    this.serverSeed = crypto.randomBytes(32).toString('hex');
    this.serverSeedHash = crypto.createHash('sha256').update(this.serverSeed).digest('hex');
    this.graineDepuis = Date.now();
    this.manchesGraine = 0;
  }

  /**
   * Y a-t-il une main EN COURS quelque part ?
   *
   * Une main de blackjack, une grille de Mines, une serie de Hi-Lo tirent
   * plusieurs fois, a plusieurs secondes d'intervalle. Tourner la graine au
   * milieu ferait tirer les premieres cartes avec l'ancienne et les suivantes
   * avec la nouvelle : la manche porterait UNE empreinte alors que deux
   * graines l'ont produite, et elle serait invérifiable — exactement le
   * contraire du but recherche. On attend donc que les tables soient vides.
   */
  partiesEnCours() {
    let n = 0;
    for (const p of this.players.values()) {
      /* Le blackjack tire AU FIL DE L'EAU, avec la graine du moment : une
         rotation en pleine main ferait tirer les premieres cartes avec
         l'ancienne et les suivantes avec la nouvelle. C'est le cas grave. */
      if (p.bj && p.bj.stage !== 'done') { n++; continue; }
      /* Les Mines, le Hi-Lo et les tables de casino, eux, FIGENT leur graine
         au debut de la manche (p.X.graine) : une rotation ne les couperait
         pas. On les attend quand meme, pour une autre raison — la ligne
         d'historique porte l'empreinte EN VIGUEUR a la fin de la manche, et
         apres une rotation ce serait la nouvelle alors que l'ancienne a tire.
         Le joueur verifierait avec la mauvaise graine et croirait a une
         tricherie. */
      if (p.mines && p.mines.etat && !p.mines.etat.fini) { n++; continue; }
      if (p.hilo && p.hilo.etat && !p.hilo.etat.fini) { n++; continue; }
      if (p.casino && p.casino.stage && p.casino.stage !== 'done') { n++; continue; }
    }
    return n;
  }

  /**
   * Tourne la graine et REVELE la precedente.
   *
   * C'est le geste qui donne son sens a tout le reste. L'empreinte annoncee
   * d'avance engage la maison ; la graine publiee apres coup permet de
   * VERIFIER. Sans elle, le joueur n'a qu'une promesse : il ne peut recalculer
   * aucune manche, et « provably fair » ne veut rien dire.
   *
   * @param {boolean} force  tourner meme si une main est en cours (a eviter)
   */
  tourneGraine(force) {
    const enCours = this.partiesEnCours();
    if (enCours && !force)
      throw new Error(`${enCours} hand(s) still running — rotation would split a round in two`);
    const revelee = {
      h: this.serverSeedHash,
      s: this.serverSeed,
      t0: this.graineDepuis || null,
      t1: Date.now(),
      n: this.manchesGraine || 0,
    };
    if (!Array.isArray(this.graines)) this.graines = [];
    this.graines.unshift(revelee);
    if (this.graines.length > cfg.FAIRNESS_GARDE) this.graines.length = cfg.FAIRNESS_GARDE;
    this._rotateSeed();
    return { revelee, nouvelle: this.serverSeedHash };
  }

  /**
   * Ce que tout le monde peut lire — y compris qui n'a pas de compte.
   *
   * La graine EN COURS n'y figure jamais : la publier laisserait predire les
   * manches a venir. Seules les graines retirees du service sont ouvertes.
   */
  equite() {
    return {
      empreinteActuelle: this.serverSeedHash,
      depuis: this.graineDepuis || null,
      manches: this.manchesGraine || 0,
      /* Les formules, jeu par jeu. Une preuve qu'on ne sait pas refaire n'est
         pas une preuve : le mode d'emploi fait partie de la promesse. */
      /* Les formules, jeu par jeu — et A LA VIRGULE PRES.
       *
       * Ce bloc a ete ecrit deux fois : la premiere version oubliait que
       * chaque jeu SUFFIXE la graine du joueur (« …:plinko », « …:mines »)
       * et que le numero est incremente AVANT le tirage. Un joueur qui aurait
       * suivi cette documentation aurait trouve un resultat different du sien
       * et en aurait conclu qu'on triche. Une preuve fausse est pire que pas
       * de preuve : elle accuse.
       */
      formules: {
        empreinte: 'sha256(graine_serveur) == empreinte annoncee',
        numero: "le numero utilise par une manche est n1 (celui d'ARRIVEE) : il est incremente avant le tirage. n0 et n1 encadrent les numeros consommes, utile au blackjack qui en prend une dizaine par main.",
        graineJoueur: "chaque jeu ajoute son propre suffixe a la graine du joueur : ':plinko', ':mines', ':hilo', ':boulier', ':casino' (Hold'em et Three Card). Le Coin Pusher n'en ajoute aucun ; le blackjack place ':bj:' avant le numero.",
        pusher: "HMAC_SHA256(graine_serveur, graine_joueur + ':' + n1)",
        blackjack: "HMAC_SHA256(graine_serveur, graine_joueur + ':bj:' + numero), un tirage par carte",
        plinko: "flux d'octets, compteur a partir de 0 : HMAC_SHA256(graine_serveur, graine_joueur + ':plinko' + ':' + n1 + ':' + compteur). Un bit par rangee, du bit de poids fort au plus faible ; 1 = a droite. La case d'arrivee est la somme des bits.",
        mines: "meme flux, avec le suffixe ':mines'",
        boulier: "meme flux, avec le suffixe ':boulier'. Melange de Fisher-Yates partiel sur une urne 1..90 : a chaque pas i de 0 a 29 on tire j uniforme dans [i, 89] (rejet au-dela de 256 - 256 % (90 - i)), on echange, et urne[i] est la boule qui sort. L'ordre rendu est celui du boulier.",
        holdem_three: "meme flux, avec le suffixe ':casino'",
        hilo: "flux : HMAC_SHA256(graine_serveur, graine_joueur + ':hilo' + ':' + n1 + ':' + pas + ':' + essai + ':' + compteur)",
        note: "chaque ligne d'historique porte l'empreinte en vigueur (sh), la graine du joueur (cs) et la plage de numeros de la manche (n0, n1)",
      },
      graines: (this.graines || []).map((g) => ({
        empreinte: g.h, graine: g.s, du: g.t0, au: g.t1, manches: g.n,
      })),
    };
  }

  _p(addr) {
    addr = addr.toLowerCase();
    /* On note l'adresse comme SALE ici, au seul endroit par lequel passe
       toute lecture et toute ecriture d'une fiche.
     *
     * Marquer trop est sans consequence : on reecrit une fiche qui n'avait
     * pas bouge. Marquer trop peu perd de l'argent. Entre les deux il n'y a
     * pas d'hesitation possible, et c'est pourquoi la marque est posee a
     * l'ACCES et non a la mutation : il faudrait sinon retrouver les cent
     * quarante endroits qui modifient une fiche, et n'en oublier aucun —
     * aujourd'hui, et a chaque fonctionnalite ajoutee ensuite.
     */
    if (this.sales) this.sales.add(addr);
    let p = this.players.get(addr);
    /* La fiche porte son adresse. Sans elle, tout code qui ne recoit que la
       fiche — _manche, appele par les dix-neuf fins de manche — ne sait pas de
       QUI il parle, et ne peut donc rien journaliser. Elle est reposee aussi
       pour les fiches relues du disque, qui datent d'avant. */
    if (p && !p.addr) p.addr = addr;
    if (!p) {
      p = { addr, balance: ethers.BigNumber.from(0), cumulativeAuthorized: ethers.BigNumber.from(0),
            clientSeed: crypto.randomBytes(8).toString('hex'), nonce: 0, name: addr.slice(0, 6),
            nomChoisi: false,
            deposited: BN(0), jeux: {}, visage: null, amis: [], demandes: [], envoyees: [],
            parrain: null, filleuls: [], refDu: BN(0), refTotal: BN(0), revCumul: 0, revPaye: 0,
            attente: [],
            record: null, meilleurJour: null, stakeClaimTotal: BN(0), trNonLus: 0,
            bonusBloque: BN(0), bonusCible: null,
            moisCle: null, moisMise: 0,
            refBienvenue: false,
            dayNet: ethers.BigNumber.from(0), dayKey: null,
            dropsToday: 0, winsToday: 0, questClaimed: {}, hasDeposited: false, miseJour: {}, face: {},
            primesEntrainement: {},
            stakes: [], stakeAccrued: ethers.BigNumber.from(0), volcanoMeter: 0,
            wagered: ethers.BigNumber.from(0), betCount: 0,
            tgId: null, welcomeGranted: false, welcomeWagered: false, welcomeClaimed: false,
            streakDay: 0, streakLastClaimDay: null, adCount: 0, adDayKey: null, adLastMs: 0,
            /* L'XP GAGNEE — celle des gestes. Celle du volume se recalcule et
               n'est donc pas ici : un compteur derivable qu'on stocke est un
               deuxieme endroit ou la verite peut diverger. */
            xp: 0, xpSources: {}, xpFilleuls: {}, xpObjets: {}, xpFamilles: {},
            coffreOffertJour: null,
            jourColl: { coffres: 0, neufs: 0, rarete: 0 }, creeLe: Date.now(),
            /* L'inventaire de la boutique : identifiant d'objet -> quantite.
               Un objet plat, pas une Map : il part au fichier tel quel. */
            objets: {},
            /* Les skins possedes, et celui qu'on porte. Registre a part de
               `objets` : un skin ne vient d'aucun coffre et n'appartient a
               aucune saison. */
            skins: {}, skinActif: null,
            /* La progression PAR SKIN : id -> { w: volume mise sous ce skin,
               ef: fruit equipe, ea: arme equipee }. Vide tant qu'aucun skin
               n'a ete porte pendant une mise. */
            persos: {} };
      this.players.set(addr, p);
    }
    return p;
  }

  /**
   * Le nom de DEPANNAGE, celui que la page envoie au moment de la connexion —
   * en pratique les six premiers caracteres de l'adresse.
   *
   * Il ne doit JAMAIS ecraser un nom choisi. Toutes les pages envoient
   * `name` a chaque connexion : sans cette garde, un joueur se donne un nom
   * dans son profil, change de jeu, et se retrouve affiche « 0x24d7 » a la
   * table suivante — son nom disparait au premier rechargement. C'est
   * exactement ce qui arrivait.
   */
  setName(addr, name) {
    const p = this._p(addr);
    if (p.nomChoisi) return p.name;              // un nom choisi ne se remplace pas
    p.name = String(name || '').slice(0, 24) || addr.slice(0, 6);
    return p.name;
  }

  /* Les vingt-quatre visages proposes. Une LISTE FERMEE, et pas une chaine
     libre : ce nom et cette image s'affichent chez les AUTRES joueurs, au
     poker, au Crash, au Connect 4. Laisser passer n'importe quel texte, c'est
     laisser un joueur en coller un autre dans le HTML de la table. */
  /** La forme comparable d'un nom : sans casse et sans accents. */
  static cleNom(n) {
    return String(n || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  /* Les medailles peintes. Le serveur n'en connait que le CODE : l'image
     vit sur le site, elle change sans qu'on redemarre quoi que ce soit, et
     un joueur ne peut pas en inventer une — la liste fermee reste la seule
     verite. Elles passent devant les frimousses : c'est ce qui se voit a
     une table de poker. */
  static get BADGES() { return ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']; }
  /* Les medailles, et rien d'autre. Les frimousses etaient la AVANT que les
     medailles existent : les garder revenait a proposer deux qualites de
     visage cote a cote, et a laisser un joueur choisir la moins bonne sans
     savoir pourquoi. Celles deja portees par un joueur continuent de
     s'afficher — on ne lui reprend pas son visage — mais on n'en propose
     plus. */
  static get VISAGES() { return Game.BADGES.slice(); }

  /**
   * Le nom public d'un joueur, tel qu'il choisit de le porter.
   *
   * Les espaces de bout sont retires — c'est une faute de frappe, pas une
   * intention. Tout le reste est REFUSE plutot que corrige en silence : un
   * joueur qui tape un nom pris, trop court ou plein de balises doit
   * l'apprendre, pas se retrouver affiche sous autre chose.
   */
  setPublicName(addr, nom) {
    const n = String(nom == null ? '' : nom).trim();
    if (n.length < 3) throw new Error('name must be at least 3 characters');
    if (n.length > 18) throw new Error('name must be 18 characters at most');
    /* Lettres, chiffres, espace, tiret, souligne et point. Rien d'autre : ce
       nom part dans le HTML des tables des autres joueurs. */
    if (!/^[\p{L}\p{N} ._-]+$/u.test(n)) throw new Error('letters, digits, space, . _ - only');
    if (/^\s|\s$|\s{2,}/.test(n)) throw new Error('no double or trailing spaces');
    /* La cle d'unicite ignore la casse ET les accents : « Eliott » et
       « Éliott » se ressemblent assez a l'ecran d'une table pour qu'on prenne
       l'un pour l'autre, et se faire passer pour un autre joueur est
       precisement ce qu'un nom public ne doit pas permettre. */
    const cle = Game.cleNom(n);
    for (const [a, p] of this.players)
      if (a !== String(addr).toLowerCase() && Game.cleNom(p.name || '') === cle)
        throw new Error('that name is taken');
    const p = this._p(addr);

    /* ---- LE PRIX DU NOM ----
     *
     * Un nom unique retire quelque chose a tous les autres joueurs, pour
     * toujours. Gratuit, cette rarete se fait ramasser en une soiree.
     *
     * Trois cas ne paient PAS, et c'est deliberé :
     *   • reposer exactement le nom qu'on possede deja — sinon changer sa
     *     photo, qui passe par le meme formulaire, couterait mille jetons ;
     *   • celui qui avait deja choisi son nom avant l'entree en vigueur du
     *     prix : on ne facture pas retroactivement ;
     *   • le prix mis a zero par configuration.
     *
     * Le montant est BRULE, pas encaisse : il rejoint le tas a bruler, celui
     * des frais de retrait. Un prix sur l'identite qui finit dans une poche
     * ressemble a un peage ; le meme prix retire de la circulation profite a
     * tous les porteurs, y compris a celui qui vient de payer.
     */
    if (this.doitPayerNom(p)) {
      const prix = Number(cfg.NAME_PRICE) || 0;
      const w = WEI(String(prix));
      if (p.balance.lt(w))
        throw new Error('a unique name costs ' + prix + ' $SWOGE — you have ' +
                        Number(ethers.utils.formatUnits(p.balance, cfg.DECIMALS)).toFixed(2));
      p.balance = p.balance.sub(w);
      /* Le meme tas que les frais de retrait : ce qui est ici attend d'etre
         brule, et sera compte comme brule quand la transaction aura eu lieu. */
      this.fraisCumules = (this.fraisCumules || BN(0)).add(w);
      p.nomPaye = true;
      this.note('brule', prix);
      journal.ajoute(addr, { k: 'nm', s: 'name', m: String(prix), nom: n });
    }

    p.name = n;
    /* La marque qui protege ce nom : a partir d'ici, la connexion d'une page
       ne le remplacera plus (voir setName). */
    p.nomChoisi = true;
    return n;
  }

  /**
   * Qui doit payer. UNE SEULE FOIS dans sa vie : le prix achete le droit
   * d'avoir un nom a soi, pas chaque changement. Facturer chaque changement
   * ferait payer mille jetons une faute de frappe, et le joueur garderait le
   * nom fautif plutot que de repayer — ce qui donne exactement le contraire de
   * ce qu'on cherche.
   *
   * Et personne n'est facture retroactivement : celui qui avait deja choisi
   * son nom avant l'entree en vigueur du prix le garde, et peut encore en
   * changer. Ils sont une quinzaine ; les faire payer pour un nom qu'ils ont
   * depuis des semaines serait incomprehensible.
   */
  doitPayerNom(p) {
    return (Number(cfg.NAME_PRICE) || 0) > 0 && !p.nomPaye && p.nomChoisi !== true;
  }

  /** Ce que coute le prochain nom, pour l'afficher AVANT que le joueur tape
   *  quoi que ce soit. Un prix decouvert au moment du refus se lit comme une
   *  panne ; annonce d'avance, il se lit comme une regle. */
  prixNom(addr) {
    const p = this._p(addr);
    return { prix: Number(cfg.NAME_PRICE) || 0, du: this.doitPayerNom(p) ? (Number(cfg.NAME_PRICE) || 0) : 0,
             brule: true, solde: Number(ethers.utils.formatUnits(p.balance, cfg.DECIMALS)) };
  }

  /** Le visage, choisi dans la liste fermee. */
  setVisage(addr, v) {
    const liste = Game.VISAGES;
    const s = String(v == null ? '' : v);
    if (liste.indexOf(s) < 0) throw new Error('unknown avatar');
    this._p(addr).visage = s;
    return s;
  }

  /** Ce que les autres joueurs voient d'un joueur. */
  profilPublic(addr) {
    const p = this._p(addr);
    /* `photo` dit seulement QU'IL Y EN A UNE. L'image elle-meme se demande a
       /avatar/<adresse>, ce qui la met dans le cache du navigateur au lieu de
       la recopier dans chaque message de table. */
    /* Le niveau part avec le profil public : il apparait donc d'un coup aux
       duels, dans la liste d'amis, au classement et aux tables, sans qu'aucun
       de ces endroits ait a le demander. */
    const n = this.niveau(addr);
    /* `nomChoisi` dit si le nom est une IDENTITE ou juste le debut d'une
       adresse. C'est la meme distinction qui decide si une page publique
       existe : sans nom choisi, il n'y a rien a partager. */
    return { address: String(addr).toLowerCase(), name: p.name, nomChoisi: !!p.nomChoisi,
             visage: p.visage || null, photo: !!p.photo,
             niveau: n.niveau, palier: n.palier, palierNo: n.palierNo };
  }
  /**
   * Ce qu'on montre sur une page de profil PUBLIQUE.
   *
   * Construit par ADDITION, jamais en filtrant `stats()`. La difference n'est
   * pas de style : filtrer, c'est publier par defaut et retirer ensuite — le
   * jour ou quelqu'un ajoute un champ a `stats()`, il se retrouve en ligne
   * sans que personne l'ait decide. Ici, ce qui n'est pas ecrit ci-dessous
   * n'existe pas.
   *
   * Ce qui n'y sera jamais : le solde, le total depose, le gain net, les
   * revenus de parrainage. Le solde de quelqu'un ne regarde personne, et
   * afficher combien il a depose designe une cible.
   *
   * Ce qui y est : ce que le canal Telegram annonce deja publiquement — le
   * nom, le niveau, les grosses victoires — plus ce qui se lit deja aux
   * tables : contre qui on joue, et comment ca tourne.
   */
  profilPage(addr) {
    const a = String(addr).toLowerCase();
    const p = this.players.get(a);
    if (!p) return null;
    const pub = this.profilPublic(a);
    const n = this.niveau(a);
    const jeux = p.jeux || {};

    let manches = 0;
    const parJeu = [];
    for (const k of Object.keys(jeux)) {
      const j = jeux[k];
      manches += j.n || 0;
      parJeu.push({ jeu: k, n: j.n || 0, gagne: j.gagne || 0 });
    }
    parJeu.sort((x, y) => y.n - x.n);

    /* Les rivalites : ceux qu'on a le plus croises. Un adversaire rencontre
       une fois n'est pas une rivalite, c'est une rencontre. */
    const face = [];
    for (const [adv, c] of Object.entries(p.face || {})) {
      const total = (c.v || 0) + (c.d || 0) + (c.n || 0);
      if (total < 2) continue;
      const q = this.players.get(adv);
      face.push({ adresse: adv, nom: q ? q.name : adv.slice(0, 6),
                  niveau: q ? this.niveau(adv).niveau : 0,
                  v: c.v || 0, d: c.d || 0, n: c.n || 0, total });
    }
    face.sort((x, y) => y.total - x.total);

    return {
      adresse: a, nom: pub.name, visage: pub.visage, photo: pub.photo,
      niveau: pub.niveau, palier: pub.palier, palierNo: pub.palierNo,
      volume: n.volume, seuil: n.seuil, prochain: n.prochain,
      manches,
      favoris: parJeu.filter((x) => x.n > 0).slice(0, 3),
      /* La plus grosse victoire est deja annoncee dans le canal au moment ou
         elle tombe : la republier ici n'apprend rien de nouveau a personne. */
      record: p.record ? { gain: p.record.g, multi: p.record.x, jeu: p.record.j, quand: p.record.t } : null,
      duels: {
        joues: face.reduce((t, x) => t + x.total, 0),
        gagnes: face.reduce((t, x) => t + x.v, 0),
        rivaux: face.slice(0, 5),
      },
      amis: (p.amis || []).length,
      depuis: journal.resume(a).depuis || null,
    };
  }

  /** Trouve un joueur par son NOM public, pour les adresses partageables. */
  parNom(nom) {
    const q = String(nom || '').trim().toLowerCase();
    if (!q) return null;
    if (/^0x[0-9a-f]{40}$/.test(q)) return this.players.has(q) ? q : null;
    for (const [a, p] of this.players)
      if (p.nomChoisi && String(p.name || '').toLowerCase() === q) return a;
    return null;
  }

  /**
   * Graine du joueur. Le DEUX-POINTS est interdit, et ce n'est pas cosmetique.
   *
   * Chaque jeu fabrique son message en collant des morceaux avec ce separateur :
   * la machine a sous utilise `graine:numero`, le blackjack `graine:bj:numero`,
   * les autres `graine:casino`, `graine:hilo`, `graine:mines`, `graine:plinko`.
   * Un joueur qui choisissait la graine « X:bj » obtenait pour la machine a
   * sous le message « X:bj:12 » — exactement celui du blackjack pour la graine
   * « X ». Deux jeux differents partageaient alors le meme tirage, et le
   * cloisonnement sur lequel repose toute l'equite tombait.
   *
   * En retirant le separateur de ce que le joueur controle, aucune graine ne
   * peut plus se faire passer pour un autre jeu.
   */
  setClientSeed(addr, seed) {
    const p = this._p(addr);
    const propre = String(seed || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (propre) p.clientSeed = propre;
    return p.clientSeed;
  }

  balanceWei(addr) { return this._p(addr).balance; }
  balanceStr(addr) { return ethers.utils.formatUnits(this._p(addr).balance, cfg.DECIMALS); }

  /** Credit an on-chain deposit once (deduped by tx hash). */
  creditDeposit({ player, amount, tx }) {
    if (this.seenTx.has(tx)) return false;
    this.seenTx.add(tx);
    const p = this._p(player);
    p.balance = p.balance.add(amount);
    p.hasDeposited = true; // unlocks daily quests (real skin in the game)
    /* Le TOTAL depose, et pas seulement un oui/non. Sans lui il est impossible
       de dire si un gros solde vient d'un gros depot ou de nulle part — c'est
       exactement la question qu'on n'a pas su trancher le jour ou un joueur a
       ete soupconne de tricher. */
    p.deposited = (p.deposited || BN(0)).add(amount);
    /* L'adresse ET la transaction. Le joueur qui conteste un depot six mois
       plus tard ne se souvient pas d'un montant : il se souvient d'un
       virement, et c'est le hash qui permet d'aller le regarder sur la
       chaine. L'adresse de depart est la sienne — le coffre credite celui qui
       a envoye — mais l'ecrire noir sur blanc evite d'avoir a le supposer. */
    this.note('depots', ethers.utils.formatUnits(amount, cfg.DECIMALS));
    this.noteTunnel('deposants', player, ethers.utils.formatUnits(amount, cfg.DECIMALS));
    journal.ajouteSync(player, { k: 'dep', m: ethers.utils.formatUnits(amount, cfg.DECIMALS),
                                 tx, from: String(player).toLowerCase() });

    /* Le cadeau du filleul, verse a son PREMIER depot reel et une seule fois.
       Personne ne partage un lien qui ne donne rien a l'ami ; et l'attacher
       au depot plutot qu'au clic empeche d'ouvrir cent comptes vides pour
       ramasser cent cadeaux. */
    if (p.parrain && !p.refBienvenue && Number(cfg.REFERRAL_WELCOME) > 0 &&
        (p.deposited || BN(0)).gte(WEI(cfg.REFERRAL_WELCOME_MIN))) {
      p.refBienvenue = true;
      const cadeau = WEI(cfg.REFERRAL_WELCOME);
      p.balance = p.balance.add(cadeau);
      /* Le cadeau entre dans le solde mais NE PEUT PAS EN SORTIR tant que la
         mise a atteindre n'est pas faite. C'est le seul verrou qui coute
         quelque chose a qui vient seulement le ramasser : pour retirer, il
         faut jouer, et jouer coute l'avantage de la maison. */
      p.bonusBloque = (p.bonusBloque || BN(0)).add(cadeau);
      p.bonusCible = (p.wagered || BN(0)).add(cadeau.mul(Math.round(cfg.REFERRAL_WELCOME_ROLLOVER)));
      journal.ajoute(player, { k: 'rf', s: 'welcome', m: String(cfg.REFERRAL_WELCOME),
                               mise: ethers.utils.formatUnits(p.bonusCible.sub(p.wagered || BN(0)), cfg.DECIMALS) });
    }
    return true;
  }

  canDrop(addr) { return this._p(addr).balance.gte(COST); }

  /**
   * Consume 1 drop cost. Returns { value, jackpotWon } (both provably-fair):
   *   value      = coin value paid when it reaches the front (0 = empty)
   *   jackpotWon = wei won from the progressive pot on this drop (0 if not)
   * Returns null if the balance can't cover the drop.
   */
  drop(addr) {
    const p = this._p(addr);
    if (p.balance.lt(COST)) return null;
    p.balance = p.balance.sub(COST);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(COST); p.dropsToday++; this._markWager(p, COST, 'pusher');
    /* LA CHUTE EST LA MANCHE. Le Coin Pusher ne passait par aucun point de
       reglage : il ne comptait ni pour le classement du mois, ni pour le
       revenu de la maison, ni pour la mesure d'usage — le jeu qui donne son
       nom au serveur etait invisible aux trois. Ce qui revient plus tard
       arrive par win(), et se raccroche a cette manche-ci. */
    this._manche(p, 'pusher', Number(cfg.DROP_COST) || 0, 0, { sansJournal: true });
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    // weighted provably-fair pick over cfg.PRIZES ([value, weight]) — bits 0..14
    let r = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(cfg.PRIZE_TOTAL));
    let value = 0;
    for (let i = 0; i < cfg.PRIZES.length; i++) { r -= cfg.PRIZES[i][1]; if (r < 0) { value = cfg.PRIZES[i][0]; break; } }
    // progressive jackpot: feed the pot, then roll the trigger on bits 15..29
    this.jackpotPot = this.jackpotPot.add(this._rakeWei);
    let jackpotWon = ethers.BigNumber.from(0);
    const jr = Number(BigInt('0x' + h.slice(15, 30)) % BigInt(cfg.JACKPOT_ODDS));
    if (jr === 0) {
      jackpotWon = this.jackpotPot;
      this.note('jackpots', ethers.utils.formatUnits(jackpotWon, cfg.DECIMALS), p.addr);
      p.balance = p.balance.add(jackpotWon);
      p.dayNet = p.dayNet.add(jackpotWon);
      this.jackpotPot = this._jackpotSeed;
    }
    return { value, jackpotWon };
  }

  /** Give back a drop cost (the table was full, so no coin was placed). */
  refund(addr) { const p = this._p(addr); p.balance = p.balance.add(COST); }

  canSpin(addr) { return this._p(addr).balance.gte(SPIN_COST); }

  /**
   * SWOGE Smash: one spin. Deducts SPIN_COST, rolls a provably-fair multiplier
   * from cfg.SPIN_PRIZES (RTP = 50%) and credits (multiplier × SPIN_COST).
   * Fully synchronous — like drop() — so two concurrent spins can never both
   * pass the balance check (Node is single-threaded; the second sees the
   * already-deducted balance). Returns { mult, payout } or null if too poor.
   */
  spin(addr, betRaw) {
    const p = this._p(addr);
    // Mise variable (defaut : l'ancien cout fixe, pour les clients pas encore a jour)
    let bet = Math.floor(Number(betRaw));
    if (!(bet >= 1)) bet = Number(cfg.SPIN_COST || '1');
    if (bet < cfg.SMASH_MIN_BET) bet = cfg.SMASH_MIN_BET;
    if (bet > cfg.SMASH_MAX_BET) return { error: 'max bet is ' + cfg.SMASH_MAX_BET + ' $SWOGE' };
    const betWei = WEI(bet);
    if (p.balance.lt(betWei)) return null;
    p.balance = p.balance.sub(betWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei, 'smash');
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    let r = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(cfg.SPIN_TOTAL));
    let mult = 0;
    for (let i = 0; i < cfg.SPIN_PRIZES.length; i++) { r -= cfg.SPIN_PRIZES[i][1]; if (r < 0) { mult = cfg.SPIN_PRIZES[i][0]; break; } }
    let payout = 0;
    if (mult > 0) {
      const pay = betWei.mul(mult);
      p.balance = p.balance.add(pay);
      this._bumpDay(p); p.dayNet = p.dayNet.add(pay); p.winsToday++;
      payout = mult * bet;
    }
    this._manche(p, 'smash', bet, payout);
    return { mult, payout, bet };
  }

  volcanoMeterOf(addr) { return this._p(addr).volcanoMeter || 0; }

  /**
   * SWOGE Spin (Volcano). One spin at `bet` $SWOGE. Deducts the bet, computes a
   * provably-fair outcome server-side (client only animates it, so wins can't be
   * faked), tracks the per-player collect meter, and credits base×bet. RTP ~70%.
   * Returns { outcome, bet, payout, balance, fairness } or { error }.
   */
  volcanoSpin(addr, bet) {
    const p = this._p(addr);
    bet = Math.floor(Number(bet));
    if (!cfg.VOLCANO_BETS.includes(bet)) throw new Error('invalid bet');
    const betWei = WEI(bet);
    if (p.balance.lt(betWei)) return { error: 'need_deposit' };
    p.balance = p.balance.sub(betWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei, 'spin');
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    const out = volcano.spinAll(volcano.rngFrom(h), p.volcanoMeter || 0);
    p.volcanoMeter = out.meter;
    let payout = 0;
    if (out.totalInternal > 0) {
      const payWei = WEI(out.totalInternal * bet);
      p.balance = p.balance.add(payWei);
      this._bumpDay(p); p.dayNet = p.dayNet.add(payWei); p.winsToday++;
      payout = out.totalInternal * bet;
    }
    this._manche(p, 'spin', bet, payout);
    return { outcome: out, bet, payout, balance: this.balanceStr(addr), fairness: this.fairness(addr) };
  }

  /** Buy the bonus directly: costs bet × VOLCANO_BONUS_COST_MULT, runs a guaranteed bonus. */
  volcanoBuyBonus(addr, bet) {
    const p = this._p(addr);
    bet = Math.floor(Number(bet));
    if (!cfg.VOLCANO_BETS.includes(bet)) throw new Error('invalid bet');
    const cost = bet * cfg.VOLCANO_BONUS_COST_MULT;
    const costWei = WEI(cost);
    if (p.balance.lt(costWei)) return { error: 'need_deposit' };
    p.balance = p.balance.sub(costWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(costWei); p.dropsToday++; this._markWager(p, costWei, 'spin');
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    const bonus = volcano.runBonus(3, volcano.rngFrom(h));
    let payout = 0;
    if (bonus.total > 0) {
      const payWei = WEI(bonus.total * bet);
      p.balance = p.balance.add(payWei);
      this._bumpDay(p); p.dayNet = p.dayNet.add(payWei); p.winsToday++;
      payout = bonus.total * bet;
    }
    this._manche(p, 'spinBonus', cost, payout);
    return { outcome: { bonus }, bet, cost, payout, balance: this.balanceStr(addr), fairness: this.fairness(addr) };
  }

  // ===== SWOGE Blackjack (provably-fair, infinite deck, dealer stands on 17) =====
  // rank index: 0=A, 1..8 = 2..9, 9=10, 10=J, 11=Q, 12=K
  /* ---- LA CARTE PORTE SON ENSEIGNE ----
   *
   * Le tirage rendait un RANG (0..12) et la page inventait l'enseigne dans le
   * navigateur, a partir d'un sel local. Deux consequences :
   *
   *   • un joueur qui verifie l'equite ne pouvait pas reconstituer sa main
   *     TELLE QU'IL L'AVAIT VUE — les piques affiches n'existaient nulle part
   *     sur le serveur ;
   *   • aucun pari annexe n'etait constructible. Perfect Pairs et 21+3
   *     demandent l'enseigne, et les batir sur celle du navigateur aurait
   *     laisse le joueur recharger la page jusqu'a tomber sur une paire
   *     parfaite a 25:1.
   *
   * La carte est un nombre de 0 a 51 : rang = n % 13, enseigne = n / 13. Le
   * tirage consomme le meme jeton de la suite provably-fair qu'avant, seule
   * l'interpretation change — les graines deja publiees restent verifiables.
   *
   * LES MAINS EN COURS AU DEPLOIEMENT portent des valeurs 0..12 : elles se
   * relisent comme des cartes d'enseigne 0. Faux, mais jouable — on ne casse
   * pas une main en cours pour une enseigne.
   *
   * ATTENTION A QUI LIT UNE CARTE : tout code qui comparait la valeur brute a
   * un rang (« r >= 9 donc c'est une figure ») doit passer par rangDe. C'est
   * exactement ce qui a fait tomber bj_audit.test.js au premier essai, et le
   * defaut etait dans le test, pas ici.
   */
  static rangDe(carte) { return ((Number(carte) || 0) % 13 + 13) % 13; }
  static enseigneDe(carte) { return Math.floor(((Number(carte) || 0) % 52 + 52) % 52 / 13); }
  /* L'ordre des enseignes est celui des planches de la page : 0 coeur,
     1 carreau, 2 trefle, 3 pique. Les deux premieres sont rouges. Perfect
     Pairs distingue trois paliers et c'est la SEULE chose qui les separe. */
  static couleurDe(carte) { return Game.enseigneDe(carte) < 2 ? 0 : 1; }

  /* ---------------------------------------------------- LES PARIS ANNEXES
   *
   * Les deux premiers se jouent AVANT la donne et se resolvent DES la donne :
   * ils ne lisent que les deux cartes du joueur et la carte VISIBLE du
   * croupier. Aucun des deux ne touche a la carte cachee, donc les payer tout
   * de suite ne revele rien — c'est ce qui permet de les regler avant meme
   * que le joueur ait tire.
   *
   * L'assurance, elle, est d'une autre nature : elle se propose APRES la donne,
   * uniquement sur un As decouvert, et elle PARIE sur la carte cachee. Elle a
   * donc son propre temps de jeu (l'etape 'insurance'), et pas une case a
   * remplir avant de distribuer.
   *
   * Les deux fonctions ci-dessous sont pures : elles ne lisent que des cartes.
   * C'est ce qui les rend mesurables a un million de coups sans lancer une
   * seule partie — voir bj_annexes.test.js.
   */
  /** Perfect Pairs : les deux cartes du joueur. null si ce n'est pas une paire. */
  static ppRang(a, b) {
    if (Game.rangDe(a) !== Game.rangDe(b)) return null;
    if (Game.enseigneDe(a) === Game.enseigneDe(b)) return 'parfaite';
    if (Game.couleurDe(a) === Game.couleurDe(b)) return 'couleur';
    return 'mixte';
  }
  /** 21+3 : les deux cartes du joueur et la carte visible du croupier. */
  static tp3Rang(a, b, c) {
    const r = [a, b, c].map(Game.rangDe).sort((x, y) => x - y);
    const memeEnseigne = Game.enseigneDe(a) === Game.enseigneDe(b) && Game.enseigneDe(b) === Game.enseigneDe(c);
    if (r[0] === r[1] && r[1] === r[2]) return memeEnseigne ? 'brelanServi' : 'brelan';
    /* L'As vaut UN ou QUATORZE : A-2-3 se lit tel quel (rangs 0,1,2), mais
       D-R-A se trie en 0,11,12 et demande son propre cas. L'oublier retirerait
       une suite sur douze au joueur, silencieusement. */
    const suite = (r[0] + 1 === r[1] && r[1] + 1 === r[2]) || (r[0] === 0 && r[1] === 11 && r[2] === 12);
    if (suite && memeEnseigne) return 'quinteFlush';
    if (memeEnseigne) return 'couleur';
    if (suite) return 'quinte';
    return null;
  }

  _bjDraw(p) {
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':bj:' + p.nonce).digest('hex');
    p.nonce++;
    return Number(BigInt('0x' + h.slice(0, 15)) % BigInt(52));
  }
  _bjVal(cartes) { return this._bjValRangs((cartes || []).map(Game.rangDe)); }
  _bjValRangs(ranks) {
    let sum = 0, aces = 0;
    for (const r of ranks) { if (r === 0) { sum += 11; aces++; } else if (r >= 9) sum += 10; else sum += r + 1; }
    while (sum > 21 && aces) { sum -= 10; aces--; }
    return sum;
  }
  _bjDealerPlay(p) { while (this._bjVal(p.bj.dc) < 17) p.bj.dc.push(this._bjDraw(p)); }
  /* Une main COMMENCEE AVANT ce deploiement — ou relue d'une sauvegarde — n'a
     pas de case annexe. On la lui donne, vide, plutot que de laisser chaque
     lecteur tester l'existence du champ : c'est le meme choix qu'a l'arrivee
     des enseignes, on ne casse pas une main en cours. */
  static _bjAnn(b) {
    if (!b.ann) b.ann = {};
    for (const k of ['pp', 'tp', 'ins']) if (!b.ann[k]) b.ann[k] = { mise: 0, rang: null, gain: 0 };
    return b.ann;
  }
  _bjPublic(p, reveal) {
    const b = p.bj, show = reveal || b.stage === 'done';
    Game._bjAnn(b);
    return {
      bet: b.bet, doubled: !!b.doubled, stage: b.stage,
      player: { cards: b.pc.slice(), value: this._bjVal(b.pc) },
      dealer: { cards: show ? b.dc.slice() : [b.dc[0]], value: show ? this._bjVal(b.dc) : this._bjVal([b.dc[0]]), hidden: !show },
      canDouble: b.stage === 'player' && b.pc.length === 2 && p.balance.gte(WEI(b.bet)),
      result: b.result || null, payout: b.payout || 0,
      /* Les annexes voyagent toujours, meme vides : la page peut alors les
         peindre sans se demander si le champ existe. */
      annexes: {
        pp:  { mise: b.ann.pp.mise,  rang: b.ann.pp.rang,  gain: b.ann.pp.gain },
        tp:  { mise: b.ann.tp.mise,  rang: b.ann.tp.rang,  gain: b.ann.tp.gain },
        ins: { mise: b.ann.ins.mise, rang: b.ann.ins.rang, gain: b.ann.ins.gain },
      },
      /* Ce que le joueur a le droit de poser sur l'assurance, MAINTENANT. La
         page ne recalcule pas la moitie de la mise dans son coin : elle
         afficherait un maximum que le serveur refuse des que le solde manque. */
      insuranceMax: b.stage === 'insurance' ? this._bjAssuranceMax(p) : 0,
      balance: ethers.utils.formatUnits(p.balance, cfg.DECIMALS),
      fairness: { serverSeedHash: this.serverSeedHash, nonce: p.nonce },
    };
  }
  /** Mise annexe acceptable, ou l'erreur exacte qui dit pourquoi elle ne l'est pas. */
  _bjMiseAnnexe(v, nom) {
    if (v == null || v === '') return 0;
    const m = Math.floor(Number(v));
    if (!isFinite(m) || m < 0) throw new Error('bad ' + nom + ' side bet');
    if (m === 0) return 0;
    if (m > cfg.BJ_SIDE_MAX_BET) throw new Error('side bets are capped at ' + cfg.BJ_SIDE_MAX_BET + ' $SWOGE');
    return m;
  }
  _bjAssuranceMax(p) {
    const moitie = Math.floor(p.bj.bet / 2);
    const solde = Math.floor(Number(ethers.utils.formatUnits(p.balance, cfg.DECIMALS)));
    return Math.max(0, Math.min(moitie, solde));
  }
  /** Credite un pari annexe et l'inscrit sous son propre nom de jeu. */
  _bjPaieAnnexe(p, cle, jeu, rang, mult) {
    const a = Game._bjAnn(p.bj)[cle];
    if (!(a.mise > 0)) return;
    a.rang = rang;
    a.gain = rang ? a.mise * (mult + 1) : 0;
    if (a.gain > 0) {
      p.balance = p.balance.add(WEI(a.gain));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(a.gain)); p.winsToday++;
    }
    /* Chaque annexe tient SON compte, sous son propre nom. Les noyer dans
       « bj » cacherait exactement ce qu'on a besoin de surveiller : une table
       de gain trop genereuse se voit sur la ligne du pari concerne, pas sur
       celle de la main principale qui, elle, est saine. */
    this._manche(p, jeu, a.mise, a.gain);
  }
  /* Les deux annexes d'avant-donne, reglees d'un coup. Elles ne lisent que
     pc[0], pc[1] et dc[0] : la carte cachee n'entre pas dans le calcul. */
  _bjResoutAnnexes(p) {
    const b = p.bj; Game._bjAnn(b);
    if (b.ann.pp.mise > 0) {
      const rang = Game.ppRang(b.pc[0], b.pc[1]);
      this._bjPaieAnnexe(p, 'pp', 'bj_pp', rang, rang ? cfg.BJ_PP_PAY[rang] : 0);
    }
    if (b.ann.tp.mise > 0) {
      const rang = Game.tp3Rang(b.pc[0], b.pc[1], b.dc[0]);
      this._bjPaieAnnexe(p, 'tp', 'bj_213', rang, rang ? cfg.BJ_213_PAY[rang] : 0);
    }
  }
  /* Les naturels. Extrait de bjBet parce que l'assurance s'intercale avant :
     sur un As decouvert, on demande d'abord au joueur, ON REGARDE ENSUITE. */
  _bjNaturels(p) {
    const b = p.bj, amt = b.bet, w = WEI(amt);
    const pv = this._bjVal(b.pc), dv = this._bjVal(b.dc);
    if (pv !== 21 && dv !== 21) { b.stage = 'player'; return; }
    if (pv === 21 && dv === 21) {
      b.stage = 'done'; b.result = 'push'; b.payout = amt;
      p.balance = p.balance.add(w); this._bumpDay(p); p.dayNet = p.dayNet.add(w);
      this._manche(p, 'bj', amt, amt);
    } else if (pv === 21) {
      const credit = amt * 2.5;
      p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); p.winsToday++;
      b.stage = 'done'; b.result = 'blackjack'; b.payout = credit;
      this._manche(p, 'bj', amt, credit);
    } else {
      b.stage = 'done'; b.result = 'dealer_blackjack'; b.payout = 0;
      this._manche(p, 'bj', amt, 0);
    }
  }
  /* L'assurance non repondue vaut REFUS. Un client qui ignore l'etape (une
     page pas encore rechargee, un script tiers) doit pouvoir tirer ou rester
     comme avant : sans ca, sa main resterait ouverte pour toujours et il ne
     pourrait plus miser.
     Rend vrai quand ce refus a TERMINE la main — le croupier avait son
     blackjack. Le geste demande n'a alors plus lieu d'etre, et ce n'est pas
     une faute du joueur : on lui rend l'etat final au lieu d'une erreur. Le
     signal est volontairement etroit : rester sur une main deja finie AUTREMENT
     reste une erreur, et l'audit y tient. */
  _bjPasseAssurance(addr, p) {
    if (!p.bj || p.bj.stage !== 'insurance') return false;
    this.bjInsure(addr, 0);
    return p.bj.stage === 'done';
  }
  _bjSettle(p, stake) {   // stake already deducted; credit the return
    const pv = this._bjVal(p.bj.pc), dv = this._bjVal(p.bj.dc);
    let res, credit = 0;
    if (pv > 21) res = 'bust';
    else if (dv > 21 || pv > dv) { res = 'win'; credit = stake * 2; }
    else if (pv < dv) res = 'lose';
    else { res = 'push'; credit = stake; }
    if (credit > 0) { p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); if (res === 'win') p.winsToday++; }
    p.bj.stage = 'done'; p.bj.result = res; p.bj.payout = credit;
    this._manche(p, 'bj', stake, credit);
  }

  bjState(addr) { const p = this._p(addr); return p.bj ? this._bjPublic(p, false) : null; }

  // ----------------------------------------------------------------- casino
  // Deux jeux contre la banque : Casino Hold'em et Three Card. Toute la logique
  // de gain vit dans casino.js, teste hors ligne ; ici on ne fait que debiter,
  // garder l'etat entre la donne et la decision, puis crediter.

  /** Vue publique : jamais les cartes du croupier avant la decision. */
  _casinoPublic(p, fini) {
    const s = p.casino;
    if (!s) return null;
    const v = {
      game: s.game, stage: fini ? 'done' : s.stage,
      ante: s.ante, side: s.side,
      player: s.player.slice(),
      board: s.board ? s.board.slice() : [],
      result: null,
    };
    if (fini && s.result) {
      v.dealer = s.result.dealer ? s.result.dealer.slice() : (s.dealer || []).slice();
      v.board = (s.result.board || s.board || []).slice();
      const engage = s.game === 'holdem'
        ? s.ante * (s.called ? 3 : 1) + s.side
        : s.ante * (s.called ? 2 : 1) + s.side;
      v.result = {
        outcome: s.result.outcome, payout: s.result.payout, detail: s.result.detail,
        fee: s.result.fee || 0, staked: engage, net: s.result.payout - engage,
        playerHand: s.result.playerHand || null, dealerHand: s.result.dealerHand || null,
      };
    }
    return v;
  }

  casinoState(addr) { const p = this._p(addr); return p.casino ? this._casinoPublic(p, p.casino.stage === 'done') : null; }

  /**
   * Distribue une main. `side` est le Pair Plus (Three Card) ou le bonus AA
   * (Hold'em). Les mises partent tout de suite : rien ne doit pouvoir etre
   * distribue sans que le solde ait deja ete debite.
   */
  casinoDeal(addr, gameId, anteRaw, sideRaw) {
    const p = this._p(addr);
    if (p.casino && p.casino.stage !== 'done') throw new Error('hand in progress');
    if (gameId !== 'holdem' && gameId !== 'three') throw new Error('unknown game');

    const ante = Math.floor(Number(anteRaw));
    const side = Math.max(0, Math.floor(Number(sideRaw) || 0));
    if (!(ante >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (ante > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (side > cfg.CASINO_MAX_BET) throw new Error('side bet too large');

    // Hold'em : suivre coute 2x l'Ante, on exige donc 3x l'Ante des le depart,
    // sinon le joueur decouvre son flop sans pouvoir payer la suite.
    const requis = ante * (gameId === 'holdem' ? 3 : 2) + side;
    if (p.balance.lt(WEI(requis))) throw new Error('not enough $SWOGE to see the hand through');

    const debit = WEI(ante + side);
    p.balance = p.balance.sub(debit);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(debit); p.dropsToday++; this._markWager(p, debit, gameId);

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':casino', nonce: p.nonce };

    if (gameId === 'three') {
      const d = casino.shoe(graine.serverSeed, graine.clientSeed, graine.nonce);
      p.casino = { game: 'three', stage: 'decide', ante, side, graine,
                   player: [d[0], d[1], d[2]], dealer: [d[3], d[4], d[5]], board: [] };
    } else {
      const deal = casino.holdemDeal(graine);
      p.casino = { game: 'holdem', stage: 'decide', ante, side, graine, deal,
                   player: deal.player, dealer: deal.dealer, board: deal.board };
    }
    return this._casinoPublic(p, false);
  }

  /** Suivre ou se coucher. Credite le gain et referme la main. */
  casinoDecide(addr, suit) {
    const p = this._p(addr);
    const s = p.casino;
    if (!s || s.stage !== 'decide') throw new Error('no hand to decide');

    // Suivre engage une mise supplementaire : elle doit etre debitee AVANT que
    // le resultat soit connu, sinon un joueur a sec pourrait suivre gratuitement.
    let extra = 0;
    if (suit) extra = s.game === 'holdem' ? s.ante * 2 : s.ante;
    if (extra > 0) {
      if (p.balance.lt(WEI(extra))) throw new Error('not enough $SWOGE to call');
      p.balance = p.balance.sub(WEI(extra));
      this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(extra)); this._markWager(p, WEI(extra), s.game);
    }

    const feeBps = cfg.CASINO_WIN_FEE_BPS;
    const r = s.game === 'three'
      ? casino.threeCard(Object.assign({}, s.graine, { ante: s.ante, pairPlus: s.side, play: !!suit, feeBps }))
      : casino.holdemResolve({ deal: s.deal, ante: s.ante, aa: s.side, call: !!suit, feeBps });

    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.outcome === 'win' || r.outcome === 'dealer_not_qualified') p.winsToday++;
    }
    s.result = r; s.stage = 'done'; s.called = !!suit;
    const vue = this._casinoPublic(p, true);
    this._manche(p, s.game, vue.result.staked, r.payout);
    return vue;
  }

  // ------------------------------------------------------------------ hi-lo
  // Plus haut ou plus bas. La mise part au premier tirage ; a partir de la, le
  // joueur ne risque plus que ce qu'il a deja engage. Tout le calcul vit dans
  // hilo.js, teste hors ligne.

  _hiloPublic(p) {
    const s = p.hilo;
    if (!s) return null;
    const e = s.etat;
    return {
      mise: e.mise, carte: e.carte, rang: e.rang, pas: e.pas,
      multi: e.multi, fini: !!e.fini, perdu: !!e.perdu, encaisse: !!e.encaisse,
      peutMonter: !!e.peutMonter, peutDescendre: !!e.peutDescendre,
      // ce que rapporterait chaque pari, pour l'afficher AVANT de cliquer
      multHigher: e.peutMonter ? hilo.multiplicateur(e.rang, 'higher', cfg.HILO_EDGE_BPS) : 0,
      multLower: e.peutDescendre ? hilo.multiplicateur(e.rang, 'lower', cfg.HILO_EDGE_BPS) : 0,
      gain: Math.floor(e.mise * e.multi),
      dernier: s.dernier || null,
    };
  }

  hiloState(addr) { const p = this._p(addr); return this._hiloPublic(p); }

  /** Ouvre une partie : la mise est debitee tout de suite. */
  hiloStart(addr, miseRaw) {
    const p = this._p(addr);
    if (p.hilo && !p.hilo.etat.fini) throw new Error('game in progress');

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise), 'hilo');

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':hilo', nonce: p.nonce };
    p.hilo = { graine, etat: hilo.ouvrir(Object.assign({ mise }, graine)), dernier: null };
    return this._hiloPublic(p);
  }

  /** Un pas : plus haut ou plus bas. Rien n'est debite, la mise est deja partie. */
  hiloStep(addr, sens) {
    const p = this._p(addr);
    const s = p.hilo;
    if (!s || s.etat.fini) throw new Error('no game in progress');
    const avant = s.etat.carte;
    const r = hilo.jouer(Object.assign({ etat: s.etat, sens, edgeBps: cfg.HILO_EDGE_BPS }, s.graine));
    s.etat = r.etat;
    s.dernier = { sens, avant, carte: r.carte, gagne: r.gagne,
                  egalites: r.egalites, mult: r.multiplicateurDuPas };
    // une partie perdue se conclut ICI, pas a l'encaissement : sans ca on ne
    // compterait que les parties gagnantes et le taux serait de 100 %
    if (s.etat.fini && s.etat.perdu) this._manche(p, 'hilo', s.etat.mise, 0);
    return this._hiloPublic(p);
  }

  /** Encaisse le multiplicateur courant. */
  hiloCashOut(addr) {
    const p = this._p(addr);
    const s = p.hilo;
    if (!s || s.etat.fini) throw new Error('no game to cash out');
    const r = hilo.encaisser(s.etat);
    s.etat = r.etat;
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    const v = this._hiloPublic(p);
    v.payout = r.payout; v.net = r.net;
    this._manche(p, 'hilo', v.mise, r.payout);
    return v;
  }

  // ------------------------------------------------------------------ mines
  // Une grille de 25 cases, des bombes placees a l'ouverture. Tout le calcul
  // vit dans mines.js, verifie hors ligne.

  /**
   * Vue publique. Les bombes ne sortent QUE lorsque la partie est finie : les
   * envoyer plus tot reviendrait a donner la solution, et aucun affichage cote
   * navigateur ne peut cacher une donnee qu'on lui a transmise.
   */
  _minesPublic(p) {
    const s = p.mines;
    if (!s) return null;
    const e = s.etat;
    const v = {
      mise: e.mise, nbMines: e.nbMines,
      ouvertes: e.ouvertes.slice(),
      multi: e.multi,
      fini: !!e.fini, perdu: !!e.perdu, encaisse: !!e.encaisse, complet: !!e.complet,
      // ce que rapporterait la case suivante, pour l'afficher AVANT de cliquer
      multiSuivant: e.fini ? 0
        : mines.multiplicateur(e.nbMines, e.ouvertes.length + 1, e.edgeBps),
      gain: Math.floor(e.mise * e.multi),
      maximum: mines.maximum(e.nbMines, e.edgeBps),
    };
    if (e.fini) {
      v.bombes = e.bombes.slice();          // la grille se decouvre a la fin
      if (e.touchee != null) v.touchee = e.touchee;
    }
    return v;
  }

  minesState(addr) { const p = this._p(addr); return this._minesPublic(p); }

  /**
   * Multiplicateur de la PREMIERE case pour chaque nombre de bombes propose.
   * Calcule ici, et envoye au navigateur, pour qu'il n'ait aucune formule a
   * lui : deux sources de verite finissent toujours par diverger, et c'est
   * l'affichage qui aurait tort au pire moment — juste avant de miser.
   */
  minesBareme() {
    const out = {};
    for (const m of cfg.MINES_CHOIX) out[m] = mines.multiplicateur(m, 1, cfg.MINES_EDGE_BPS);
    return out;
  }

  /** Ouvre une partie : la mise est debitee tout de suite. */
  minesStart(addr, miseRaw, nbMinesRaw) {
    const p = this._p(addr);
    if (p.mines && !p.mines.etat.fini) throw new Error('game in progress');

    /* Pas de Math.floor ici, contrairement a la mise : le nombre de bombes est
       un choix pris dans une liste, pas un montant. Recevoir 2,5 veut dire que
       le client s'est trompe — l'arrondir en silence masquerait sa faute et
       ferait jouer une grille que personne n'a demandee. */
    const nbMines = Number(nbMinesRaw);
    if (!Number.isInteger(nbMines) || nbMines < mines.MINES_MIN || nbMines > mines.MINES_MAX)
      throw new Error('mines must be a whole number between ' + mines.MINES_MIN + ' and ' + mines.MINES_MAX);

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise), 'mines');

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':mines', nonce: p.nonce };
    p.mines = { graine, etat: mines.ouvrir(Object.assign({ mise, nbMines, edgeBps: cfg.MINES_EDGE_BPS }, graine)) };
    return this._minesPublic(p);
  }

  /** Retourne une case. Rien n'est debite : la mise est deja partie. */
  minesPick(addr, position) {
    const p = this._p(addr);
    const s = p.mines;
    if (!s || s.etat.fini) throw new Error('no game in progress');
    const r = mines.jouer({ etat: s.etat, position });
    s.etat = r.etat;
    if (s.etat.fini && s.etat.perdu) this._manche(p, 'mines', s.etat.mise, 0);
    const v = this._minesPublic(p);
    v.dernier = { position: r.position, sure: r.sure };
    return v;
  }

  /** Encaisse le multiplicateur courant. */
  minesCashOut(addr) {
    const p = this._p(addr);
    const s = p.mines;
    if (!s || s.etat.encaisse || s.etat.perdu) throw new Error('no game to cash out');
    const r = mines.encaisser(s.etat);
    s.etat = r.etat;
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    const v = this._minesPublic(p);
    v.payout = r.payout; v.net = r.net;
    this._manche(p, 'mines', v.mise, r.payout);
    return v;
  }

  // ----------------------------------------------------------------- plinko
  // Une bille, un coup. Rien a conserver entre deux messages : il n'y a donc
  // aucun etat qu'un joueur puisse abandonner en cours de route pour garder sa
  // mise, contrairement au Hi-Lo et au Mines.

  /** Le bareme complet, pour que le navigateur affiche les godets sans calculer. */
  plinkoTable(rangees, risque) {
    return plinko.table(rangees, risque, cfg.PLINKO_EDGE_BPS);
  }

  /** Toutes les tables d'un coup : envoyees a la connexion, jamais recalculees. */
  plinkoBaremes() {
    const out = {};
    for (const r of plinko.RANGEES)
      for (const q of plinko.RISQUES) out[r + ':' + q] = this.plinkoTable(r, q);
    return out;
  }

  /** Lache une bille. La mise part et le gain revient dans le meme geste. */
  plinkoDrop(addr, miseRaw, rangeesRaw, risqueRaw) {
    const p = this._p(addr);

    const rangees = Number(rangeesRaw);
    if (!Number.isInteger(rangees) || plinko.RANGEES.indexOf(rangees) < 0)
      throw new Error('rows must be one of ' + plinko.RANGEES.join(', '));
    const risque = String(risqueRaw || '');
    if (plinko.RISQUES.indexOf(risque) < 0)
      throw new Error('risk must be one of ' + plinko.RISQUES.join(', '));

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise), 'plinko');

    p.nonce++;
    const r = plinko.lancer({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':plinko', nonce: p.nonce,
      mise, rangees, risque, edgeBps: cfg.PLINKO_EDGE_BPS,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    this._manche(p, 'plinko', r.mise, r.payout);
    return { mise: r.mise, rangees: r.rangees, risque: r.risque,
             chemin: r.chemin, case: r.case, multi: r.multi,
             payout: r.payout, net: r.net, table: r.table };
  }

  // ---------------------------------------------------------------- boulier
  // 90 boules, 30 sortent, une grille de 10. Un coup unique comme le Plinko :
  // rien a conserver entre deux messages, donc rien qu'un joueur puisse
  // abandonner en cours de route pour garder sa mise.
  //
  // La difference avec tous les autres jeux de la maison : le prix est FIXE.
  // C'est la cagnotte qui l'impose (voir BOULIER_PRIX dans config.js). On joue
  // plusieurs grilles au lieu de miser plus gros — et les grilles d'une meme
  // manche partagent les memes 30 boules, parce qu'un boulier ne tourne qu'une
  // fois.

  /** Ce qu'il faut au navigateur pour tout afficher sans calculer une formule. */
  boulierBareme() {
    return {
      boules: boulier.BOULES, tirees: boulier.TIREES, grille: boulier.GRILLE,
      prix: cfg.BOULIER_PRIX, grillesMax: cfg.BOULIER_GRILLES_MAX,
      table: boulier.table(),
      partCagnotteBps: boulier.CAGNOTTE_BPS,
      partPleinBps: boulier.CAGNOTTE_PART_BPS,
      retourBareme: boulier.retourBareme(),
      retourTotal: boulier.retourTotal(),
    };
  }

  /** La cagnotte en SWOGE lisibles, comme jackpotStr() pour le Coin Pusher. */
  boulierPotStr() { return ethers.utils.formatUnits(this.boulierPot, cfg.DECIMALS); }

  /** L'etat affiche a la connexion et a chaque changement de phase. */
  boulierEtat(now, addr) {
    const e = this.boulierSalle.etat(now || Date.now(), addr);
    e.cagnotte = this.boulierPotStr();
    e.pleins = (this.boulierPleins || []).slice(0, 10);
    return e;
  }

  /**
   * Inscrit des grilles sur la manche EN COURS D'ATTENTE.
   *
   * L'ordre des operations n'est pas negociable. La cagnotte est alimentee a
   * l'inscription, pas au tirage : sinon un joueur qui fait un plein emporterait
   * un pot auquel sa propre mise n'a pas encore contribue, et le pot repartirait
   * en dessous de ce que le cycle a collecte.
   */
  boulierInscrit(addr, grillesRaw, now) {
    const p = this._p(addr);
    if (!Array.isArray(grillesRaw) || grillesRaw.length < 1)
      throw new Error('play at least one grid');
    if (grillesRaw.length > cfg.BOULIER_GRILLES_MAX)
      throw new Error('at most ' + cfg.BOULIER_GRILLES_MAX + ' grids per draw');

    const prix = cfg.BOULIER_PRIX;
    const mise = prix * grillesRaw.length;
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    /* La salle valide et refuse AVANT tout debit : phase fermee, plafond de la
       manche atteint, grille mal formee. Une manche refusee ne doit rien avoir
       touche. */
    this.boulierSalle.inscrire(addr, p.name, grillesRaw, prix, cfg.BOULIER_GRILLES_MAX);

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++;
    this._markWager(p, WEI(mise), 'boulier');

    const versement = boulier.partCagnotte(prix) * grillesRaw.length;
    this.boulierPot = this.boulierPot.add(WEI(versement));

    return { etat: this.boulierEtat(now || Date.now(), addr), mise };
  }

  /**
   * Le tirage est sorti : on paie tout le monde.
   *
   * Les joueurs sont servis DANS L'ORDRE D'INSCRIPTION. Ca ne compte que pour
   * la cagnotte — deux pleins la meme manche prennent chacun 80 % de ce qui
   * RESTE — mais alors ca compte vraiment, et un ordre qui depend du parcours
   * d'une Map serait un ordre que personne ne peut prevoir ni verifier.
   */
  boulierRegle(sortie) {
    const prix = cfg.BOULIER_PRIX;
    const out = [];
    for (const [addr, j] of this.boulierSalle.joueurs) {
      const p = this._p(addr);
      let payout = 0, cagnotteGagnee = 0;
      const lignes = j.grilles.map((g) => {
        const t = boulier.touches(g, sortie);
        const l = { grille: g.slice(), touches: t, n: t.length,
                    lot: boulier.lot(t.length, prix), plein: false };
        if (t.length === boulier.GRILLE) {
          /* Le pot est debite de ce qui est REELLEMENT verse, pas de la part
             brute : un pot de 200 002 donne 160 001,6 et le solde ne connait
             que des SWOGE entiers. Le reste fractionnaire demeure dans le pot,
             ou il servira au gagnant suivant. */
          const part = this.boulierPot.mul(boulier.CAGNOTTE_PART_BPS).div(10000);
          const swoge = Math.floor(Number(ethers.utils.formatUnits(part, cfg.DECIMALS)));
          this.boulierPot = this.boulierPot.sub(WEI(swoge));
          l.plein = true; l.cagnotte = swoge;
          cagnotteGagnee += swoge; payout += swoge;
        }
        payout += l.lot;
        return l;
      });

      if (cagnotteGagnee > 0) {
        this.boulierPleins.unshift({ t: Date.now(), addr, nom: p.name, gain: cagnotteGagnee });
        this.boulierPleins = this.boulierPleins.slice(0, 50);
      }
      if (payout > 0) {
        p.balance = p.balance.add(WEI(payout));
        this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(payout));
        if (payout > j.mise) p.winsToday++;
      }
      this._manche(p, 'boulier', j.mise, payout);
      this.boulierSalle.note(addr, lignes, payout, cagnotteGagnee);
      out.push({ addr, mise: j.mise, lignes, payout, net: payout - j.mise,
                 cagnotteGagnee, balance: this.balanceStr(addr) });
    }
    return out;
  }

  /** L'horloge de la salle. server.js diffuse ce qui en sort. */
  boulierTick(now) {
    const evs = this.boulierSalle.tick(now);
    for (const ev of evs) {
      /* Le reglement se fait A LA SORTIE DES BOULES, pas a la fin de
         l'animation : le joueur qui ferme l'onglet pendant que les boules
         tombent a deja ete paye, exactement comme au solo. L'animation ne fait
         que raconter. */
      if (ev.type === 'boulierTirage') {
        ev.resultats = this.boulierRegle(ev.sortie);
        ev.joueurs = this.boulierSalle.liste();
        ev.cagnotte = this.boulierPotStr();
      }
    }
    return evs;
  }

  // ------------------------------------------------------------------ crash
  // Une seule manche pour tout le monde. Contrairement au Plinko, la mise part
  // AVANT de savoir quoi que ce soit, et le gain revient plus tard — au retrait,
  // ou jamais. Le solde suit donc deux chemins separes : le debit a la mise, le
  // credit a l'encaissement.

  /** L'etat de la table pour un joueur donne, avec son propre pari. */
  crashEtat(now, addr) {
    const e = this.crash.etat(now || Date.now());
    e.edgeBps = cfg.CRASH_EDGE_BPS;
    e.min = cfg.CASINO_MIN_BET;
    e.max = cfg.CASINO_MAX_BET;
    e.joueurs = this._crashNoms(e.joueurs);
    if (addr) e.moi = this.crash.pari(addr);
    return e;
  }

  /**
   * La table du Crash ne connait que des adresses — c'est voulu, elle ignore
   * tout des joueurs. Mais une liste de 0x25…47f ne dit rien a personne : on y
   * remet les noms au moment de sortir, la ou ils sont connus.
   */
  _crashNoms(liste) {
    return (liste || []).map((j) => Object.assign({ name: this._p(j.addr).name }, j));
  }

  /**
   * Poser une mise sur la manche en cours. La mise est debitee tout de suite :
   * un solde qui ne bougerait qu'au crash laisserait le joueur miser deux fois
   * le meme jeton sur deux onglets.
   */
  crashMise(addr, miseRaw, autoRaw, now) {
    const p = this._p(addr);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    // parier() est ce qui peut encore refuser (mises fermees, deja en table) :
    // on l'appelle AVANT de toucher au solde, pour n'avoir rien a annuler.
    const r = this.crash.parier(addr, mise, autoRaw, now || Date.now());

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise));
    p.dropsToday++; this._markWager(p, WEI(mise), 'crash');
    return { manche: r.manche, mise, auto: r.auto, balance: this.balanceStr(addr) };
  }

  /** Encaisser a la main. Le multiplicateur vient de l'horloge du serveur. */
  crashRetrait(addr, now) {
    const ev = this.crash.retirer(addr, now || Date.now());
    this._crediteRetrait(ev);
    return ev;
  }

  /** Le credit d'un encaissement, manuel ou automatique — un seul chemin. */
  _crediteRetrait(ev) {
    const p = this._p(ev.addr);
    if (ev.payout > 0) {
      p.balance = p.balance.add(WEI(ev.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(ev.payout));
      if (ev.net > 0) p.winsToday++;
    }
    this._manche(p, 'crash', ev.mise, ev.payout);
    ev.balance = this.balanceStr(ev.addr);
    return ev;
  }

  /**
   * Fait avancer la manche. Renvoie les evenements a diffuser tels quels ;
   * les soldes, eux, sont deja a jour quand la fonction rend la main.
   */
  crashTick(now) {
    const evs = this.crash.tick(now || Date.now());
    for (const ev of evs) {
      if (ev.type === 'crashDepart') ev.joueurs = this._crashNoms(ev.joueurs);
      else if (ev.type === 'crashRetrait') this._crediteRetrait(ev);
      else if (ev.type === 'crashFin') {
        // Les perdants ont ete debites a la mise : il ne reste qu'a inscrire la
        // manche a leur compteur, pour que la comptabilite par jeu soit juste.
        // La table garde les paris jusqu'a l'ouverture de la manche suivante :
        // la mise perdue est donc encore lisible ici, et nulle part apres.
        for (const addr of ev.perdants) {
          const pari = this.crash.pari(addr);
          this._manche(this._p(addr), 'crash', pari ? pari.mise : 0, 0);
        }
      }
    }
    return evs;
  }


  // ------------------------------------------------------------ LA BOUTIQUE
  /*
   * Un coffre s'achete avec le solde de jeu, comme une mise, et rend un objet
   * au lieu de jetons.
   *
   * ---- ce que ce n'est PAS, et pourquoi ca compte ----
   *
   * Un achat de coffre n'est PAS une manche. Il ne passe donc ni par
   * `_manche`, ni par `_markWager`, et il n'avance aucune quete du jour.
   *
   * Deux raisons, et la seconde suffirait :
   *
   *   • le journal et l'audit calculent un retour par jeu — mise contre
   *     rendu. Un coffre ne rend jamais de jetons : le compter comme une mise
   *     ferait apparaitre un jeu a 0 % de retour au milieu des autres, et
   *     fausserait le retour global du site, qui est publie ;
   *   • les quetes du jour paient en jetons. Si acheter un coffre les faisait
   *     avancer, on pourrait les remplir sans jamais jouer — et une quete qui
   *     s'achete ne recompense plus rien.
   *
   * L'argent, lui, est bien compte : `note('boutique', ...)` le porte au mois,
   * du cote de la maison.
   */

  /**
   * LA COURSE AUX TROIS PREMIERES LIGNES.
   *
   * Appelee apres chaque objet range. Rend l'entree du gagnant si ce fruit
   * vient de completer une famille et qu'il reste une place, sinon null.
   *
   * Le controle « ce joueur a-t-il deja gagne » porte sur l'ADRESSE et pas
   * sur la famille : celui qui complete trois familles ne doit pas rafler
   * les trois places, sinon la course n'oppose personne.
   */
  _boutiqueLigne(p, item, now) {
    if (!this.boutiqueLignes) this.boutiqueLignes = [];
    /* ---- CETTE COURSE EST CELLE DE LA SAISON 1 ----
     *
     * Le controle est explicite plutot que deduit. Aujourd'hui il ne change
     * rien : la saison 2 n'ouvre a personne avant que les trois lignes de la
     * saison 1 soient tombees, et les trois gagnants sont deja bloques par la
     * regle d'adresse — aucune ligne d'armes ne peut donc atteindre un prix.
     * Mais « ca ne peut pas arriver » est une propriete de l'enchainement
     * actuel, pas une regle ecrite, et la premiere personne qui touchera a la
     * porte la cassera sans le voir.
     *
     * Quand la saison 2 aura sa propre course, elle aura sa propre liste et
     * ses propres montants. Elle ne se greffe pas sur celle-ci : les trois
     * places de la saison 1 appartiennent a la saison 1, definitivement. */
    if (boutique.famille(item.famille).saison !== 1) return null;
    if (this.boutiqueLignes.length >= boutique.PRIX_LIGNE.length) return null;
    if (this.boutiqueLignes.some((g) => g.addr === p.addr)) return null;

    const inv = p.objets || {};
    const manque = boutique.ITEMS.some(
      (o) => o.famille === item.famille && !inv[o.id]);
    if (manque) return null;

    const rang = this.boutiqueLignes.length;          // 0, 1 ou 2
    const prix = boutique.PRIX_LIGNE[rang];
    p.balance = p.balance.add(WEI(prix));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(prix));
    const fam = boutique.famille(item.famille);
    const g = { addr: p.addr, nom: p.name || p.addr.slice(0, 6),
                famille: item.famille, familleNom: fam ? fam.nom : item.famille,
                rang: rang + 1, prix, t: now || Date.now() };
    this.boutiqueLignes.push(g);
    /* Journalise comme un gain, parce que c'en est un : un coffre pouvait
       jusqu'ici ne jamais rendre de jetons, ce n'est plus vrai. */
    journal.ajoute(p.addr, { k: 'r', g: 'boutique', m: 0, p: prix });
    this.note('primes', prix, p.addr);
    return g;
  }

  /**
   * LE CLASSEMENT DES COLLECTIONNEURS.
   *
   * ---- ce qu'on classe, et pourquoi pas autre chose ----
   *
   * Le rang se joue sur le nombre de fruits DIFFERENTS, pas sur la quantite
   * totale. Compter les doublons ferait gagner celui qui ouvre le plus de
   * coffres de bois, alors que la collection se termine en trouvant ce qu'on
   * n'a pas — et c'est ce que la planche montre depuis le debut.
   *
   * A egalite, on departage par la RARETE : un joueur a douze fruits dont un
   * mythique passe devant un joueur a douze communs. Le poids d'une rarete
   * est l'inverse de son plafond — dix mythiques contre mille communs, donc
   * un mythique vaut cent communs. Le bareme n'est pas invente : il sort des
   * plafonds, et il se recalculera tout seul si on les change.
   *
   * ---- le cout ----
   *
   * Une passe sur les fiches, comme le panneau d'administration. La
   * difference est qu'ici tout le monde peut demander — on renvoie donc
   * seulement le haut du classement et la ligne du demandeur, jamais la
   * liste entiere.
   */
  boutiqueClassement(addr, limite, saison) {
    const objets = boutique.itemsDeSaison(saison || 1);
    const poids = {};
    for (const r of boutique.RARETES) poids[r.cle] = 1000 / r.plafond;
    const rangRarete = {};
    boutique.RARETES.forEach((r, i) => { rangRarete[r.cle] = i; });

    const l = [];
    for (const [a, p] of this.players) {
      const inv = p.objets;
      if (!inv) continue;
      let sortes = 0, score = 0, meilleure = -1, familles = {};
      for (const o of objets) {
        if (!inv[o.id]) continue;
        sortes++;
        score += poids[o.rarete] || 0;
        if (rangRarete[o.rarete] > meilleure) meilleure = rangRarete[o.rarete];
        familles[o.famille] = (familles[o.famille] || 0) + 1;
      }
      if (!sortes) continue;
      /* Les familles COMPLETES, parce que c'est ce que la course recompense
         et que le classement doit parler de la meme chose que la course. */
      let pleines = 0;
      for (const k of Object.keys(familles)) if (familles[k] === boutique.RARETES.length) pleines++;
      /* CE QU'IL POSSEDE, en trente caracteres.
         La page dessine la rangee de fruits en allumant ceux qu'il a : il lui
         faut donc la liste, pas seulement le compte. Une chaine de 0 et de 1
         dans l'ordre du catalogue tient en trente octets par joueur — envoyer
         un tableau d'identifiants en couterait cinq fois plus pour dire la
         meme chose, et il faudrait le croiser cote page. */
      const avoir = objets.map((o) => (inv[o.id] ? '1' : '0')).join('');
      l.push({ addr: a, nom: p.name || a.slice(0, 6), sortes, score: Math.round(score),
               pleines, avoir,
               meilleure: meilleure >= 0 ? boutique.RARETES[meilleure].cle : null });
    }
    l.sort((x, y) => (y.sortes - x.sortes) || (y.score - x.score) || (y.pleines - x.pleines));
    l.forEach((x, i) => { x.rang = i + 1; });

    const moi = addr ? l.find((x) => x.addr === String(addr).toLowerCase()) : null;
    const n = Math.max(1, Math.min(50, Number(limite) || 10));
    return {
      total: l.length,
      top: l.slice(0, n).map((x) => ({ rang: x.rang, nom: x.nom, sortes: x.sortes,
                                       pleines: x.pleines, meilleure: x.meilleure,
                                       avoir: x.avoir })),
      /* Sa ligne part TOUJOURS, meme s'il est deja dans le haut : la page
         choisit de la repeter ou non, le serveur ne devine pas. */
      moi: moi ? { rang: moi.rang, sortes: moi.sortes, pleines: moi.pleines,
                   meilleure: moi.meilleure, avoir: moi.avoir } : null,
      sur: objets.length,
    };
  }

  /**
   * ================== LA PORTE DE LA SAISON SUIVANTE ==================
   *
   * Une saison s'ouvre a tout le monde quand la precedente a rendu ses TROIS
   * lignes completes. Les trois gagnants, eux, y entrent des leur propre ligne
   * finie — sans attendre les deux autres.
   *
   * ---- pourquoi la question se pose a l'ACHAT et nulle part ailleurs ----
   *
   * On pourrait cacher les coffres verrouilles dans la page et s'arreter la.
   * Ce serait une porte peinte : la page envoie un message, et n'importe qui
   * peut envoyer le meme message a la main. La seule porte qui ferme est celle
   * que le serveur tient au moment ou il debite. La page, elle, sert a ne pas
   * proposer un bouton qui refusera — c'est du confort, pas de la securite.
   *
   * ---- ce qui n'est PAS verifie ici ----
   *
   * On ne demande pas au joueur d'avoir fini quoi que ce soit. La saison 2 est
   * ouverte a un joueur qui n'a jamais achete un seul fruit, du moment que la
   * course de la saison 1 est terminee. C'est voulu : la porte recompense les
   * trois premiers par de l'AVANCE, pas par de l'exclusivite. Une saison
   * reservee a ceux qui ont fini la precedente fermerait le jeu a tout nouvel
   * arrivant, ce qui est l'inverse du but.
   */
  boutiqueSaisonOuverte(addr, n) {
    const s = Number(n) || 1;
    if (s <= 1) return true;
    const l = this.boutiqueLignes || [];
    /* La course finie ouvre pour tous. */
    if (l.length >= boutique.PRIX_LIGNE.length) return true;
    /* Sinon, seuls ceux qui ont deja une ligne a leur nom. */
    const a = String(addr || '').toLowerCase();
    return l.some((g) => String(g.addr || '').toLowerCase() === a);
  }

  /**
   * L'etat de chaque saison POUR CE JOUEUR : ouverte ou non, et pourquoi.
   *
   * Le « pourquoi » compte autant que le verrou. Une saison grisee sans
   * explication se lit comme une panne ; la meme saison avec « 2 lignes sur 3
   * — la saison 2 ouvre a la troisieme » se lit comme une raison de jouer, et
   * c'est exactement ce qu'on veut qu'elle soit.
   */
  boutiqueSaisons(addr) {
    const l = this.boutiqueLignes || [];
    const total = boutique.PRIX_LIGNE.length;
    const a = String(addr || '').toLowerCase();
    const gagnant = l.find((g) => String(g.addr || '').toLowerCase() === a);
    return boutique.SAISONS.map((s) => {
      const ouverte = this.boutiqueSaisonOuverte(addr, s.n);
      return {
        n: s.n, nom: s.nom, sujet: s.sujet, ouverte,
        /* `avance` distingue les deux facons d'etre entre : par la course
           finie, ou par sa propre ligne avant les autres. La page en fait une
           mention — « you are in early, rank #1 » — qui n'a de sens que la. */
        avance: !!(ouverte && s.n > 1 && l.length < total && gagnant),
        rang: gagnant ? gagnant.rang : null,
        faites: l.length, sur: total,
      };
    });
  }

  /** Les places restantes et les gagnants, pour la page et l'annonce. */
  boutiqueCourse() {
    const gagnants = this.boutiqueLignes || [];
    return {
      prix: boutique.PRIX_LIGNE,
      gagnants: gagnants.map((g) => ({ nom: g.nom, familleNom: g.familleNom,
                                       rang: g.rang, prix: g.prix, t: g.t })),
      restant: Math.max(0, boutique.PRIX_LIGNE.length - gagnants.length),
    };
  }

  /**
   * L'ETAT DE LA BOUTIQUE POUR L'EXPLOITANT.
   *
   * Deux questions, et elles n'ont pas la meme reponse :
   *
   *   • COMBIEN IL RESTE — ca se lit dans le registre global, et c'est ce qui
   *     dit si l'edition approche de sa fin ;
   *   • QUI A QUOI — ca demande de parcourir les fiches. Le registre sait
   *     combien de Void Fruits sont sortis, il ne sait pas chez qui.
   *
   * ---- pourquoi on parcourt tout, et pourquoi ce n'est pas grave ----
   *
   * Il n'existe pas d'index inverse objet -> joueurs, et on n'en construit pas
   * un : il faudrait le tenir a jour a chaque achat, donc un deuxieme endroit
   * qui peut se desynchroniser du premier. Le parcours coute une passe sur les
   * fiches, sur une page d'administration qu'une personne ouvre de temps en
   * temps. Le mauvais echange serait l'inverse.
   *
   * Les detenteurs sont TRIES par quantite : sur un mythique a dix
   * exemplaires, savoir que quelqu'un en detient quatre est l'information qui
   * compte.
   */
  boutiqueAdmin() {
    const emis = this.boutiqueEmis || {};
    /* Une seule passe sur les fiches, pour tous les objets a la fois. */
    const parObjet = new Map();
    for (const [addr, p] of this.players) {
      const inv = p.objets;
      if (!inv) continue;
      for (const id of Object.keys(inv)) {
        const q = inv[id];
        if (!(q > 0)) continue;
        if (!parObjet.has(id)) parObjet.set(id, []);
        parObjet.get(id).push({ addr, nom: p.name || addr.slice(0, 6), q });
      }
    }
    const items = boutique.ITEMS.map((o) => {
      const det = (parObjet.get(String(o.id)) || []).sort((a, b) => b.q - a.q);
      const plafond = boutique.rarete(o.rarete).plafond;
      const sorti = emis[o.id] || 0;
      return {
        id: o.id, nom: o.nom, cle: o.cle, rarete: o.rarete, famille: o.famille,
        saison: o.saison,
        plafond, emis: sorti, reste: Math.max(0, plafond - sorti),
        /* La somme des inventaires DOIT egaler le registre. Si elle ne
           l'egale pas, l'un des deux ment et la page doit le montrer plutot
           que de choisir lequel croire. */
        detenu: det.reduce((a, d) => a + d.q, 0),
        porteurs: det.length,
        detenteurs: det.slice(0, 12),
      };
    });
    const parRarete = boutique.RARETES.map((r) => {
      const l = items.filter((o) => o.rarete === r.cle);
      return { cle: r.cle, nom: r.nom, couleur: r.couleur, plafond: r.plafond,
               emis: l.reduce((a, o) => a + o.emis, 0),
               total: r.plafond * l.length };
    });
    /* Le detail PAR SAISON. Sans lui, « 412 sur 19 200 » melangeait une
       edition ouverte depuis des mois et une qui n'a pas commence, et le
       chiffre qui compte — « ou en est la saison en cours » — n'etait affiche
       nulle part. */
    const parSaison = boutique.SAISONS.map((s) => {
      const l = items.filter((o) => o.saison === s.n);
      return { n: s.n, nom: s.nom,
               emis: l.reduce((a, o) => a + o.emis, 0),
               edition: l.reduce((a, o) => a + o.plafond, 0),
               porteurs: new Set(l.flatMap((o) => o.detenteurs.map((d) => d.addr))).size };
    });
    return {
      items, parRarete, parSaison,
      lignes: (this.boutiqueLignes || []).map((g) => ({ nom: g.nom, rang: g.rang,
                                                        familleNom: g.familleNom, prix: g.prix, t: g.t })),
      familles: boutique.FAMILLES.map((f) => ({ cle: f.cle, nom: f.nom, couleur: f.couleur, saison: f.saison })),
      edition: boutique.ITEMS.reduce((a, o) => a + boutique.rarete(o.rarete).plafond, 0),
      sortis: Object.values(emis).reduce((a, b) => a + b, 0),
    };
  }

  /* ======================================================================
   * LES SKINS DE PERSONNAGE
   * ======================================================================
   *
   * ---- rien a voir avec les saisons ----
   *
   * La boutique tire au hasard dans une edition fermee. Un skin, lui, s'achete
   * DIRECTEMENT, a prix fixe, et reste disponible en permanence — il n'ouvre
   * ni ne ferme jamais. `p.skins` est donc un registre a part, distinct de
   * `p.objets` : mélanger les deux aurait fait apparaitre un skin dans la
   * collection de fruits, ou compter pour l'edition d'une saison a laquelle il
   * n'appartient pas.
   *
   * ---- ce qui est code, et ce qui ne l'est pas ----
   *
   * Acheter, et porter celui qu'on a achete. C'est tout. Pas d'emplacement
   * pour un fruit de pouvoir, une arme, une armure ou une bague — ces
   * emplacements n'existent nulle part ailleurs sur le site non plus, et les
   * poser ici sans rien pour les remplir promettrait un jeu qui n'est pas
   * construit. Le jour ou il l'est, `p.skins[id]` est deja la pour porter ces
   * emplacements sans rien migrer.
   */
  skinsEtat(addr) {
    const p = this._p(addr);
    const possedes = p.skins || {};
    return {
      catalogue: skins.catalogue().map((s) => ({ ...s, possede: !!possedes[s.id] })),
      actif: p.skinActif || null,
    };
  }

  acheteSkin(addr, id) {
    const p = this._p(addr);
    const s = skins.skin(id);
    if (!s) throw new Error('unknown skin');
    p.skins = p.skins || {};
    if (p.skins[id]) throw new Error('you already own this skin');
    const prix = skins.prixDe(id);
    const w = WEI(prix);
    if (p.balance.lt(w)) throw new Error(`not enough $SWOGE — this skin costs ${prix.toLocaleString('en-US')}`);
    p.balance = p.balance.sub(w);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(w);
    p.skins[id] = true;
    /* Le skin qu'on vient d'acheter devient celui qu'on porte : sans ce
       geste, payer ne changerait rien a l'ecran, et l'achat semblerait n'avoir
       servi a rien tant qu'on n'a pas trouve un second endroit pour l'activer.
       Un second geste pourra toujours re-choisir parmi ceux deja possedes. */
    p.skinActif = id;
    this.note('boutique', prix, String(addr).toLowerCase());
    journal.ajoute(String(addr).toLowerCase(), { k: 'sk', id, m: String(prix) });
    return { id, prix, actif: p.skinActif, balance: this.balanceStr(addr) };
  }

  choisitSkin(addr, id) {
    const p = this._p(addr);
    if (!(p.skins || {})[id]) throw new Error('you do not own this skin');
    p.skinActif = id;
    return { actif: id };
  }

  /* ======================================================================
   * LE PERSONNAGE — niveau, xp, equipement, UN SKIN A LA FOIS
   * ======================================================================
   *
   * Rien ici ne touche a un vrai combat. Ces stats existent pour etre lues,
   * pas pour changer l'issue d'une manche : voir personnages.js.
   */
  _persoDe(p, id) {
    return (p.persos && p.persos[id]) || { w: BN(0), ef: null, ea: null };
  }

  /**
   * L'etat complet d'UN skin, pret a peindre : son niveau, son XP, ses huit
   * stats (base + equipement), et ce qui est actuellement equipe.
   *
   * `null` si le skin n'est pas possede — un personnage qu'on ne possede pas
   * n'a pas de fiche a montrer, pas une fiche vide.
   */
  personnageEtat(addr, skinId) {
    const p = this._p(addr);
    if (!(p.skins || {})[skinId]) return null;
    const base = personnages.BASE[skinId];
    if (!base) return null;
    const c = this._persoDe(p, skinId);
    const volume = Number(ethers.utils.formatUnits(c.w || BN(0), cfg.DECIMALS));
    const xp = personnages.xpDuVolume(volume);
    const niveau = personnages.niveauDeXp(xp);
    const xpNiveau = personnages.xpPour(niveau);
    const xpProchain = niveau >= personnages.NIVEAU_MAX ? null : personnages.xpPour(niveau + 1);

    /* Le bonus d'un objet equipe : sa rarete pese sur SA stat, celle de sa
       famille. Un objet qui n'existe plus (retire du catalogue, ce qui
       n'arrive jamais aujourd'hui mais ne doit pas casser demain) ne casse
       pas la fiche, il ne donne juste plus rien. */
    const bonusDe = (itemId) => {
      const o = itemId ? boutique.item(itemId) : null;
      if (!o) return null;
      const stat = personnages.FAMILLE_STAT[o.famille];
      if (!stat) return null;
      const val = personnages.bonusDe(o.rarete, (r) => { const x = boutique.rarete(r); return x ? x.plafond : 0; });
      return { item: o.id, nom: o.nom, cle: o.cle, stat, bonus: val };
    };
    const bFruit = bonusDe(c.ef);
    const bArme = bonusDe(c.ea);

    const stats = {};
    personnages.STATS.forEach((s) => {
      let v = personnages.statAuNiveau(base[s], niveau);
      if (bFruit && bFruit.stat === s) v += bFruit.bonus;
      if (bArme && bArme.stat === s) v += bArme.bonus;
      stats[s] = v;
    });

    return {
      skin: skinId, niveau, xp: Math.round(xp),
      xpNiveau: Math.round(xpNiveau),
      xpProchain: xpProchain === null ? null : Math.round(xpProchain),
      volume: Math.round(volume),
      stats, base,
      equipFruit: bFruit, equipArme: bArme,
    };
  }

  /**
   * Equipe (ou retire, si `itemId` est vide) un fruit ou une arme sur un
   * skin. `genre` vaut 'fruit' ou 'arme' — deux methodes separees auraient
   * duplique cette meme suite de verifications quatre fois.
   */
  _equipe(addr, skinId, itemId, genre) {
    const p = this._p(addr);
    if (!(p.skins || {})[skinId]) throw new Error('you do not own this skin');
    p.persos = p.persos || {};
    const c = p.persos[skinId] || (p.persos[skinId] = { w: BN(0), ef: null, ea: null });
    const champ = genre === 'fruit' ? 'ef' : 'ea';

    if (itemId === null || itemId === undefined || itemId === '') {
      c[champ] = null;
      return this.personnageEtat(addr, skinId);
    }
    const o = boutique.item(itemId);
    if (!o) throw new Error('unknown item');
    const sai = boutique.saison(o.saison);
    const attendu = genre === 'fruit' ? 'fruit' : 'weapon';
    if (!sai || sai.sujet !== attendu) throw new Error(`this item is not a ${attendu}`);
    if (!((p.objets || {})[o.id] > 0)) throw new Error('you do not own this item');
    c[champ] = o.id;
    return this.personnageEtat(addr, skinId);
  }
  equipeFruit(addr, skinId, itemId) { return this._equipe(addr, skinId, itemId, 'fruit'); }
  equipeArme(addr, skinId, itemId) { return this._equipe(addr, skinId, itemId, 'arme'); }

  /** Le catalogue et l'inventaire du joueur, prets a peindre. */
  boutiqueEtat(addr, saison) {
    const p = this._p(addr);
    const saisons = this.boutiqueSaisons(addr);
    /* Une saison demandee mais fermee retombe sur la saison 1 : la page recoit
       alors une collection qu'elle a le droit de montrer, et la liste des
       saisons lui dit pourquoi l'autre n'est pas la. Rendre une erreur aurait
       laisse un panneau vide pour un cas qui n'est pas une faute. */
    let n = Number(saison) || 1;
    if (!this.boutiqueSaisonOuverte(addr, n)) n = 1;
    return { catalogue: boutique.catalogue(this.boutiqueEmis || {}, n, cfg.RACHAT_BASE),
             /* La page a besoin de la porte AVANT le clic, pas de l'erreur
                apres : un bouton qui repond « non » a un geste qu'il proposait
                est une faute d'interface, pas un garde-fou. */
             rachat: this.rachatVerrou(addr),
             inventaire: p.objets || {},
             saisons, saison: n,
             course: this.boutiqueCourse(),
             classement: this.boutiqueClassement(addr, 10, n) };
  }

  /* ======================================================================
   * LE COFFRE DU JOUR
   * ======================================================================
   *
   * Un coffre de bois offert chaque jour, sans condition et sans depot. Trois
   * regles, et la troisieme est celle qui compte :
   *
   *   1. UN PAR JOUR (jour UTC), le meme pour tout le monde ;
   *   2. IL NE S'ACCUMULE PAS. Manquer trois jours ne donne pas trois coffres.
   *      Un stock qui s'empile transforme une raison de revenir DEMAIN en une
   *      raison de revenir un jour — c'est-a-dire en rien ;
   *   3. MANQUER UN JOUR NE PUNIT PAS. Celui d'hier est perdu, celui
   *      d'aujourd'hui est la. Une serie se casse ; un cadeau quotidien, non.
   *      Sans cette regle, le joueur qui s'absente une semaine revient devant
   *      une porte fermee, et c'est le moment exact ou l'on perd quelqu'un.
   *
   * C'est le coffre de BOIS de la saison 1, jamais le dore ni le mythique :
   * l'objet offert doit valoir quelque chose sans valoir ce que les autres
   * paient.
   */
  static get COFFRE_OFFERT() { return 'bois'; }

  /** L'etat du coffre du jour, pour la page et pour la pastille. */
  coffreOffert(addr) {
    const p = this._p(addr);
    const jour = this._today();
    const c = boutique.coffre(Game.COFFRE_OFFERT);
    return {
      dispo: p.coffreOffertJour !== jour,
      coffre: Game.COFFRE_OFFERT,
      nom: c ? c.nom : Game.COFFRE_OFFERT,
      image: c ? (c.image || c.cle) : Game.COFFRE_OFFERT,
      valeur: c ? c.prix : 0,
      /* La derniere fois qu'il l'a pris. La page s'en sert pour dire « revenez
         demain » plutot que d'afficher un bouton mort. */
      prisLe: p.coffreOffertJour || null,
    };
  }

  /**
   * Ouvre le coffre du jour. Le MEME chemin que l'achat — meme tirage, memes
   * plafonds, meme registre, meme annonce — sans le debit.
   *
   * La marque est posee AVANT le tirage. Posee apres, une erreur au milieu du
   * tirage laisserait le coffre encore disponible alors qu'un objet est deja
   * sorti du stock : le joueur le reprendrait, et l'edition y perdrait une
   * piece a chaque incident.
   */
  ouvreCoffreOffert(addr) {
    const p = this._p(addr);
    const jour = this._today();
    if (p.coffreOffertJour === jour) throw new Error('today\'s free chest is already open — come back tomorrow');
    /* Le MEME plafond que la journee parfaite. Les deux sortent de la meme
       edition ; un plafond sur l'une et pas sur l'autre ne protege rien,
       il suffit de prendre l'autre. */
    if (!this._prendCoffreGratuit())
      throw new Error('today\'s free chests are all gone — come back tomorrow');
    p.coffreOffertJour = jour;
    return this.boutiqueAchat(addr, Game.COFFRE_OFFERT, { gratuit: true });
  }

  /**
   * TOUT CE QUI ATTEND LE JOUEUR, en un seul nombre.
   *
   * C'est ce que porte la pastille du bouton profil. Elle existe parce qu'une
   * recompense qu'il faut penser a aller chercher est une recompense que
   * personne ne va chercher — et parce que c'est la pastille qui ramene un
   * joueur, jamais le bouton.
   *
   * On ne compte QUE ce qui se reclame en un geste et se perd si on ne le fait
   * pas. Une quete a moitie faite n'y est pas : une pastille qui s'allume pour
   * quelque chose qu'on ne peut pas resoudre apprend a l'ignorer, et une
   * pastille ignoree ne sert plus a rien pour de bon.
   */
  enAttente(addr) {
    const p = this._p(addr);
    const coffre = this.coffreOffert(addr).dispo;
    const serie = !this._streakToday(p).claimedToday;
    let quetes = 0;
    try { quetes = this.questState(addr).filter((q) => q.done && !q.claimed).length; } catch (e) {}
    const transferts = p.trNonLus || 0;
    let parfait = false;
    try { parfait = this.parfaitEtat(addr).pret; } catch (e) {}
    return { coffre, serie, quetes, transferts, parfait,
             total: (coffre ? 1 : 0) + (serie ? 1 : 0) + quetes + (transferts ? 1 : 0) +
                    (parfait ? 1 : 0) };
  }

  /**
   * ================== LES TOUCHES, COMPTEES ==================
   *
   * Ce que les joueurs touchent vraiment, bouton par bouton. Un total pour
   * tout le monde : jamais qui a clique. La question est « quelle rangee
   * sert », pas « que fait tel joueur ».
   *
   * ---- ces nombres viennent du CLIENT, donc ils se bornent ----
   *
   * N'importe qui peut envoyer ce message a la main et annoncer un million de
   * touches sur la rangee de son choix. Le degat serait faible — ils ne
   * servent qu'a reordonner un menu — mais un chiffre qu'on sait faux ne sert
   * plus a rien du tout, et on le decouvrirait le jour ou on s'en sert.
   *
   * Trois bornes : la FORME de la clef, le NOMBRE de clefs par message, et le
   * compte par clef. Aucune ne rend le chiffre exact face a quelqu'un de
   * determine ; ensemble elles rendent le mensonge lent.
   */
  noteTaps(taps) {
    if (!taps || typeof taps !== 'object') return 0;
    this.taps = this.taps || {};
    let pris = 0;
    for (const cle of Object.keys(taps).slice(0, 60)) {
      if (!/^(menu|bar|jeu):[a-z0-9_:-]{1,40}$/.test(cle)) continue;
      const n = Math.max(0, Math.min(100, Math.floor(Number(taps[cle]) || 0)));
      if (!n) continue;
      this.taps[cle] = (this.taps[cle] || 0) + n;
      pris += n;
    }
    return pris;
  }

  /**
   * Les touches, triees, pour le panneau d'administration.
   *
   * Regroupees par FAMILLE — le tiroir, la barre du bas, les jeux — parce que
   * comparer une rangee de menu a une tuile de jeu ne veut rien dire : elles
   * n'ont ni la meme surface ni le meme nombre d'occasions d'etre touchees.
   * Le seul classement qui informe est celui d'une famille contre elle-meme.
   */
  tapsAdmin() {
    const t = this.taps || {};
    const fam = { menu: [], bar: [], jeu: [] };
    for (const cle of Object.keys(t)) {
      const i = cle.indexOf(':');
      const f = cle.slice(0, i), reste = cle.slice(i + 1);
      if (!fam[f]) continue;
      fam[f].push({ cle: reste, n: t[cle] });
    }
    const out = {};
    for (const f of Object.keys(fam)) {
      const l = fam[f].sort((a, b) => b.n - a.n);
      const total = l.reduce((a, x) => a + x.n, 0);
      out[f] = { total, lignes: l.map((x) => ({ cle: x.cle, n: x.n,
                 pct: total ? +(100 * x.n / total).toFixed(1) : 0 })) };
    }
    return out;
  }

  /**
   * Ouvre un coffre. Debite, tire, range l'objet, et rend de quoi refaire le
   * calcul soi-meme une fois la graine du serveur revelee.
   */
  boutiqueAchat(addr, cle, options) {
    const gratuit = !!(options && options.gratuit);
    const c = boutique.coffre(cle);
    if (!c) throw new Error('unknown chest');
    /* LA PORTE, AVANT LE DEBIT. Elle est ici et pas dans la page : la page ne
       peut que cacher un bouton, et un message se refabrique a la main. */
    if (!this.boutiqueSaisonOuverte(addr, c.saison)) {
      const l = this.boutiqueLignes || [];
      throw new Error('season ' + c.saison + ' opens when the season ' + (c.saison - 1) +
                      ' race ends — ' + l.length + ' of ' + boutique.PRIX_LIGNE.length +
                      ' lines completed');
    }
    const p = this._p(addr);
    const prix = WEI(c.prix);
    /* Le coffre offert emprunte TOUT le reste du chemin — meme tirage, memes
       plafonds, meme registre, meme annonce. Seul le debit saute. Un second
       chemin de tirage serait un second endroit ou les plafonds peuvent se
       tromper, et personne ne le verrait avant qu'un objet sorte en trop. */
    if (!gratuit) {
      if (p.balance.lt(prix)) throw new Error('not enough $SWOGE');
      p.balance = p.balance.sub(prix);
      this._bumpDay(p); p.dayNet = p.dayNet.sub(prix);
    }

    /* `:shop:` separe ce tirage de tous les autres. Sans cette marque, un
       coffre et un lancer du Coin Pusher tires au MEME numero par le meme
       joueur donneraient la meme empreinte — et deux jeux qui partagent leur
       hasard ne sont plus verifiables independamment. */
    const nonce = p.nonce;
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':shop:' + nonce).digest('hex');
    p.nonce++;

    this.boutiqueEmis = this.boutiqueEmis || {};
    const t = boutique.tire(h, cle, this.boutiqueEmis);
    p.objets = p.objets || {};
    /* NEUF OU DOUBLON : la question se pose AVANT de ranger l'objet, c'est le
       seul instant ou la reponse existe encore.
     *
     * ---- POURQUOI DEUX QUESTIONS ET PAS UNE ----
     *
     * `neuf` dit « je ne l'ai pas en main » ; `premiere` dit « je ne l'ai
     * JAMAIS eu ». Tant que rien ne sortait de l'inventaire, les deux etaient
     * la meme phrase. Le rachat instantane les separe : on vend l'objet, il
     * quitte l'inventaire, et le prochain tirage le rendrait « neuf » une
     * deuxieme fois. Payer l'XP sur `neuf` ouvrirait alors une boucle —
     * tirer, revendre, retirer — dont le cout est un coffre et le gain une
     * XP deja touchee.
     *
     * `xpObjets` est le meme registre que `xpFilleuls` : la marque de ce qui
     * a deja paye. La condition garde `!p.objets[...]` DEVANT, et c'est ce qui
     * evite une migration : un joueur qui possede deja l'objet echoue sur le
     * premier terme, meme si son registre est vide parce qu'il date d'avant. */
    const neuf = !p.objets[t.item.id];
    p.xpObjets = p.xpObjets || {};
    const premiere = neuf && !p.xpObjets[t.item.id];
    p.objets[t.item.id] = (p.objets[t.item.id] || 0) + 1;
    /* Le compteur global monte ICI, au meme instant que l'inventaire. Les
       deux ne peuvent pas diverger : il n'y a pas de chemin entre les deux
       lignes ou une erreur puisse s'inserer. */
    this.boutiqueEmis[t.item.id] = (this.boutiqueEmis[t.item.id] || 0) + 1;

    /* Un coffre offert n'est pas du revenu : le compter fausserait le chiffre
       d'affaires et, par ricochet, le prix du classement qui en est une part. */
    if (!gratuit) this.note('boutique', c.prix, addr);

    /* La ligne vient-elle de se completer ? On regarde APRES avoir range
       l'objet : c'est le seul instant ou la reponse peut changer. */
    /* `boutiqueAchat` ne recoit pas d horloge — les autres jeux en passent une
       pour etre rejouables, celui-ci n en a pas besoin : le tirage vient du
       HMAC, pas du temps. L horodatage du gagnant est donc pris ici. */
    const ligne = this._boutiqueLigne(p, t.item, Date.now());

    /* ---- L'XP DE COLLECTION ----
     *
     * Seul un objet JAMAIS POSSEDE en donne. Payer les doublons ferait monter
     * le plus vite celui qui ouvre le plus de coffres — c'est-a-dire celui qui
     * depense le plus, et on serait revenu exactement au probleme que la
     * separation de l'XP et du volume repare.
     *
     * La famille complete paie une deuxieme fois, et sans condition de course :
     * les trois prix de la saison 1 recompensent les trois PREMIERS, l'XP
     * recompense l'exploit lui-meme, pour tout le monde et a tout moment. */
    /* Les quetes de collection lisent ces trois-la. Le rang de rarete est
       garde au MAXIMUM du jour et non au dernier tire : « sors un rare »
       serait sinon annule par le commun suivant. */
    this._bumpDay(p);
    p.jourColl = p.jourColl || { coffres: 0, neufs: 0, rarete: 0 };
    p.jourColl.coffres++;
    if (neuf) p.jourColl.neufs++;
    const rangR = boutique.RARETES.findIndex((r) => r.cle === t.item.rarete);
    if (rangR > (p.jourColl.rarete || 0)) p.jourColl.rarete = rangR;

    let xpGagne = 0;
    if (premiere) {
      p.xpObjets[t.item.id] = 1;
      const r = xpDeRarete(t.item.rarete);
      const g = this._gagneXp(p, r, 'collection');
      if (g) xpGagne += g.gagne;
    }
    /* ---- LA FAMILLE A SON PROPRE REGISTRE ----
     *
     * Elle ne peut pas se raccrocher a `premiere`. Un joueur qui a revendu une
     * piece puis la retire completerait sa famille pour la PREMIERE fois sur
     * un tirage qui n'est pas une premiere : le bonus ne serait jamais verse a
     * quelqu'un qui l'a pourtant merite. On demande donc a la famille ce qu'on
     * demande a l'objet — a-t-elle deja paye — et on le lui demande a elle.
     *
     * `xpFamilles` est reconstitue a la lecture du fichier pour les fiches
     * d'avant (voir `hydrate`) : celui qui possede la famille entiere a
     * forcement deja touche le bonus, puisqu'il se verse a l'instant ou elle
     * se complete. */
    if (neuf) {
      const fam = boutique.ITEMS.filter((o) => o.famille === t.item.famille);
      p.xpFamilles = p.xpFamilles || {};
      if (fam.length && !p.xpFamilles[t.item.famille] && fam.every((o) => p.objets[o.id])) {
        p.xpFamilles[t.item.famille] = 1;
        const gf = this._gagneXp(p, cfg.XP_FAMILLE, 'famille');
        if (gf) xpGagne += gf.gagne;
      }
    }

    return { coffre: c.cle, coffreNom: c.nom, prix: c.prix,
             coffreImage: c.image || c.cle, saison: c.saison, gratuit,
             neuf, xp: xpGagne, niveau: this.niveauDeFiche(p),
             ligne,
             item: t.item, rarete: t.rarete,
             quantite: p.objets[t.item.id],
             emis: this.boutiqueEmis[t.item.id],
             plafond: boutique.rarete(t.item.rarete).plafond,
             epuise: t.epuise,
             balance: this.balanceStr(addr),
             preuve: { sh: this.serverSeedHash, cs: p.clientSeed, n: nonce, r1: t.r1, r2: t.r2 } };
  }

  // ---------------------------------------------------------- les duels 1v1
  /*
   * Connect 4, morpion et dames partagent EXACTEMENT le meme argent : on mise
   * a la creation ou a l'entree, la somme ne revient qu'a la fin, et le pot
   * est partage de la meme facon. Il n'y a donc qu'un seul chemin d'argent
   * pour les trois — et pas trois copies qui divergeraient au premier
   * correctif.
   *
   * Ce qui change d'un jeu a l'autre tient dans le moteur de regles et dans
   * quelques reglages (mises, pendule). Le moteur est designe par la partie
   * elle-meme (`partie.jeu`), donc rejoindre, jouer, abandonner et regler
   * n'ont meme pas besoin de savoir a quel jeu ils ont affaire : l'identifiant
   * suffit.
   */

  _duelCfg(jeu) {
    /* Le prefixe des reglages, par jeu. Une table plutot qu'une cascade de
       ternaires : le quatrieme jeu a montre que la cascade se relit mal et
       qu'on y oublie une branche. */
    const p = { mp: 'MP', dm: 'DM', mf: 'MF', dc: 'DC', p4: 'P4' }[jeu] || 'P4';
    const v = (k, d) => (cfg[p + '_' + k] !== undefined ? cfg[p + '_' + k] : d);
    return {
      min: v('MIN', cfg.P4_MIN), max: v('MAX', cfg.P4_MAX),
      coupMs: v('COUP_MS', cfg.P4_COUP_MS),
      attenteMs: v('ATTENTE_MS', cfg.P4_ATTENTE_MS),
      revancheMs: v('REVANCHE_MS', cfg.P4_REVANCHE_MS),
      rakeBps: v('RAKE_BPS', cfg.P4_RAKE_BPS),
      rakeSurNul: v('RAKE_SUR_NUL', cfg.P4_RAKE_SUR_NUL),
    };
  }
  _moteur(jeu) { return DUELS[jeu] || DUELS.p4; }

  _duelVerifie(jeu, miseRaw, addr) {
    const c = this._duelCfg(jeu);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= c.min)) throw new Error('minimum bet is ' + c.min + ' $SWOGE');
    if (mise > c.max) throw new Error('maximum bet is ' + c.max + ' $SWOGE');
    const p = this._p(addr);
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');
    return mise;
  }

  _duelDebite(addr, mise, jeu) {
    const p = this._p(addr);
    p.balance = p.balance.sub(WEI(mise));
    // dropsToday compte pour les quetes du jour. Tous les autres jeux
    // l'incrementent a la mise ; le Connect 4 l'avait oublie, et une partie
    // ne faisait donc avancer aucune quete.
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++;
    this._markWager(p, WEI(mise), jeu);
  }

  _duelCredite(addr, montant) {
    if (!(montant > 0)) return;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(montant));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(montant));
  }

  /** Ouvre une table et attend un adversaire. */
  duelCreer(jeu, addr, miseRaw, now) {
    const mise = this._duelVerifie(jeu, miseRaw, addr);
    for (const m of this.p4.values())
      if (m.phase !== FINIE && m.jeton(addr)) throw new Error('you already have a match running');
    const t = now || Date.now();
    const id = jeu + (++this.p4Seq) + '-' + Math.floor(t / 1000).toString(36);
    const partie = new (this._moteur(jeu).Partie)({
      id, mise, createur: addr, now: t, coupMs: this._duelCfg(jeu).coupMs });
    this._duelDebite(addr, mise, jeu);
    this.p4.set(id, partie);
    return partie;
  }

  /* ---- QUI OUVRE LE JEU ----
   *
   * Celui qui posait la table jouait toujours le premier coup. Au Puissance 4
   * et au morpion ce n'est pas un detail : le premier joueur a un avantage
   * connu et mesurable — au Puissance 4 il gagne meme la partie parfaite.
   * Ouvrir une table revenait donc a choisir le bon cote, et l'autre payait la
   * meme mise pour le mauvais.
   *
   * LE TIRAGE SORT DE LA GRAINE DU SERVEUR, pas de Math.random. Trois raisons :
   *
   *   • aucun des deux joueurs ne peut le predire — l'identifiant de la table
   *     est fabrique ici, et la graine n'est connue de personne avant sa
   *     revelation ;
   *   • personne ne peut CHOISIR sa table : un robot qui ne rejoindrait que
   *     les parties ou il ouvre devrait deviner la graine ;
   *   • il se VERIFIE apres coup, comme le reste de la maison. La graine
   *     revelee, n'importe qui recalcule HMAC(graine, 'duel:<id>') et retrouve
   *     qui devait commencer.
   *
   * On ne consomme aucun jeton de la suite provably-fair : le tirage se derive
   * de l'identifiant seul, et ne decale donc ni les cartes ni les billes des
   * autres jeux.
   */
  _duelPremier(id) {
    const h = crypto.createHmac('sha256', this.serverSeed).update('duel:' + String(id)).digest('hex');
    return Number(BigInt('0x' + h.slice(0, 15)) % BigInt(2)) === 0 ? 1 : 2;
  }

  /** S'asseoir en face. La partie demarre a cet instant, et le tirage dit qui ouvre. */
  duelRejoindre(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    /* Sa propre table AVANT le controle general : un joueur qui clique sur sa
       propre partie a besoin d'entendre « c'est la tienne », pas « tu as deja
       une partie en cours » — qui est vrai mais n'explique rien. */
    if (partie.joueurs[0] === addr) throw new Error('you cannot join your own match');
    if (partie.reserve && partie.reserve !== addr)
      throw new Error('this rematch is reserved for another player');
    const mise = this._duelVerifie(partie.jeu || 'p4', partie.mise, addr);
    /* On ne tient qu'une partie a la fois — mais une table a soi qui attend
       encore n'est pas une partie : on la retire et on rend la mise. Sans ca,
       ouvrir une table puis en rejoindre une autre serait impossible sans
       passer par un bouton « annuler » que personne ne trouve. */
    const t = now || Date.now();
    const retirees = [];
    for (const m of this.p4.values()) {
      if (m.phase !== FINIE && m.jeton(addr)) {
        if (m.phase === ATTENTE && m.joueurs[0] === addr) { retirees.push(m); continue; }
        throw new Error('you already have a match running');
      }
    }
    for (const m of retirees) this._duelFerme(m, 'retiree', t);
    this._duelDebite(addr, mise, partie.jeu || 'p4');
    partie.rejoindre(addr, t, this._duelPremier(partie.id));
    return { partie, retirees };
  }

  /** Le createur retire sa table tant que personne ne s'est assis. */
  duelAnnuler(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    if (partie.joueurs[0] !== addr) throw new Error('this table is not yours');
    if (partie.phase !== ATTENTE) throw new Error('this match has already started');
    this._duelFerme(partie, 'retiree', now || Date.now());
    return partie;
  }

  _duelFerme(partie, raison, now) {
    this._duelRendre(partie);
    partie.phase = FINIE;
    partie.raison = raison;
    partie.finA = now;
    partie.echeance = 0;
    return partie;
  }

  /**
   * La revanche : « On remet ca ? » — avec une somme, qui n'est pas forcement
   * celle d'avant.
   *
   * L'offre EST une table, simplement nominative : le demandeur paie tout de
   * suite, comme pour n'importe quelle table, et l'autre s'assied avec
   * duelRejoindre. Si personne ne repond, l'expiration rend la mise. Rien de
   * neuf ne touche a l'argent, donc rien de neuf ne peut le perdre.
   */
  duelRevanche(addr, idPrecedent, miseRaw, now) {
    const avant = this.p4.get(String(idPrecedent));
    if (!avant) throw new Error('previous match not found');
    if (avant.phase !== FINIE) throw new Error('this match is not over yet');
    if (!avant.jeton(addr)) throw new Error('you were not in this match');
    const adversaire = avant.joueurs[avant.jeton(addr) === 1 ? 1 : 0];
    if (!adversaire) throw new Error('there is no opponent to challenge');

    const jeu = avant.jeu || 'p4';
    const mise = this._duelVerifie(jeu, miseRaw, addr);
    for (const m of this.p4.values())
      if (m.phase !== FINIE && m.jeton(addr)) throw new Error('you already have a match running');
    /* Une seule offre en attente vers le meme adversaire : sinon dix clics
       bloquent dix mises et l'autre ne peut en accepter qu'une. */
    for (const m of this.p4.values())
      if (m.phase === ATTENTE && m.reserve === adversaire && m.joueurs[0] === addr)
        throw new Error('you already sent a rematch request');

    const t = now || Date.now();
    const id = jeu + (++this.p4Seq) + '-' + Math.floor(t / 1000).toString(36);
    const partie = new (this._moteur(jeu).Partie)({
      id, mise, createur: addr, now: t, coupMs: this._duelCfg(jeu).coupMs,
      reserve: adversaire, revancheDe: avant.id });
    this._duelDebite(addr, mise, jeu);
    this.p4.set(id, partie);
    return partie;
  }

  duelJouer(addr, id, coup, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    const t = now || Date.now();
    /* ---- LA MISE PEUT MONTER EN COURS DE PARTIE ----
       Au Pierre-Feuille-Bandit, suivre une relance engage les DEUX joueurs
       pour un tour de mise de plus. On verifie donc les deux soldes AVANT que
       le coup existe : une relance acceptee qu'un joueur ne peut pas payer
       laisserait une partie a moitie financee, et il n'y a pas de reparation
       propre a ca. Le moteur annonce le cout, il ne connait aucun solde. */
    if (typeof partie.coutSi === 'function') {
      const du = partie.coutSi(addr, coup);
      if (du > 0) for (const a of partie.joueurs) {
        if (a && this._p(a).balance.lt(WEI(du)))
          throw new Error('one of you cannot cover the raise (' + du + ' $SWOGE more each)');
      }
    }
    const r = partie.jouer(addr, coup, t);
    /* Ce que le moteur a decide de prelever. On le draine tout de suite : une
       file qui traine, c'est une mise engagee que personne n'a payee. */
    if (Array.isArray(partie.aDebiter) && partie.aDebiter.length) {
      for (const d of partie.aDebiter.splice(0)) this._duelDebite(d.addr, d.montant, partie.jeu);
    }
    /* LE TIRAGE, pour les jeux qui en demandent un.
       Le moteur ne tire rien lui-meme : la graine du serveur vaut de l'argent
       tant qu'elle n'est pas revelee, et un moteur de duel finit dans l'etat
       sauvegarde. Il dit QUAND, on lui rend le resultat et de quoi le
       refaire. */
    if (typeof partie.besoinTirage === 'function' && partie.besoinTirage()) {
      const d = this._tirageDuel(partie);
      partie.revele(d.nombre, d.preuve, t);
    }
    const reglement = partie.phase === FINIE ? this._duelRegle(partie) : null;
    return { partie, coup: r, reglement };
  }

  /**
   * Un tirage de duel, refaisable par n'importe qui une fois la graine
   * revelee.
   *
   * Les DEUX choix entrent dans l'empreinte. Sans eux, le nombre ne
   * dependrait que de la graine et de l'identifiant de partie — le serveur le
   * connaitrait donc avant que les joueurs aient choisi. Avec eux, il ne peut
   * etre calcule qu'une fois les deux nombres verrouilles, par personne
   * d'autre que celui qui detient la graine, et personne ne detient la graine
   * a ce moment-la sauf le serveur, qui s'est deja engage sur son empreinte.
   */
  _tirageDuel(partie) {
    const moteur = this._moteur(partie.jeu);
    const min = moteur.MIN || 1, max = moteur.MAX || 100;
    const entree = [partie.id, partie.choix[1], partie.choix[2]].join(':');
    const h = crypto.createHmac('sha256', this.serverSeed).update(entree).digest('hex');
    const brut = parseInt(h.slice(0, 13), 16);
    return {
      nombre: min + (brut % (max - min + 1)),
      preuve: { empreinte: this.serverSeedHash, entree, hmac: h },
    };
  }

  duelAbandonner(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    partie.abandonner(addr, now || Date.now());
    return { partie, reglement: this._duelRegle(partie) };
  }

  /**
   * Le reglement. Appele UNE SEULE FOIS par partie : `regle` garde la trace,
   * sinon un abandon suivi d'un tick paierait le gagnant deux fois.
   */
  _duelRegle(partie) {
    if (partie.regle) return null;
    partie.regle = true;
    const jeu = partie.jeu || 'p4';
    const c = this._duelCfg(jeu);
    const nul = !partie.gagnant;
    const r = this._moteur(jeu).partage(partie.mise, c.rakeBps, nul, c.rakeSurNul);
    if (nul) {
      for (const a of partie.joueurs) if (a) {
        this._duelCredite(a, r.rendu);
        this._manche(this._p(a), jeu, partie.mise, r.rendu);
      }
      this._faceAFace(partie.joueurs[0], partie.joueurs[1], 'n');
    } else {
      const gagnant = partie.adresseGagnante();
      const perdant = partie.joueurs[partie.gagnant === 1 ? 1 : 0];
      this._duelCredite(gagnant, r.gain);
      const pg = this._p(gagnant);
      this._bumpDay(pg); pg.winsToday++;
      this._manche(pg, jeu, partie.mise, r.gain);
      if (perdant) this._manche(this._p(perdant), jeu, partie.mise, 0);
      this._faceAFace(gagnant, perdant, 'v');
    }
    return r;
  }

  /**
   * Le face-a-face : qui a battu qui, et combien de fois.
   *
   * Sans ce compteur, « rivalites » ne veut rien dire — on saurait qu'un
   * joueur a gagne quarante duels, jamais CONTRE QUI. Or c'est la seule
   * statistique qui donne envie de reprendre une partie, et la seule qui
   * fasse d'un adversaire quelqu'un plutot qu'une couleur.
   *
   * On le tient au reglement, le seul endroit traverse par toutes les fins de
   * partie — victoire, nulle et abandon compris.
   */
  _faceAFace(gagnant, perdant, issue) {
    if (!gagnant || !perdant || gagnant === perdant) return;
    const pose = (a, b, k) => {
      const p = this._p(a);
      if (!p.face) p.face = {};
      const c = p.face[String(b).toLowerCase()] || (p.face[String(b).toLowerCase()] = { v: 0, d: 0, n: 0 });
      c[k]++;
    };
    if (issue === 'n') { pose(gagnant, perdant, 'n'); pose(perdant, gagnant, 'n'); }
    else { pose(gagnant, perdant, 'v'); pose(perdant, gagnant, 'd'); }
  }

  /** Rend les mises : une table qu'on ferme sans avoir joue ne coute rien. */
  _duelRendre(partie) {
    if (partie.regle) return;
    partie.regle = true;
    for (const a of partie.joueurs) if (a) this._duelCredite(a, partie.mise);
  }

  /**
   * Fait avancer les parties. Renvoie ce qui a change, pour diffusion.
   * Deux echeances : le coup, et l'attente d'un adversaire — une table sans
   * preneur ne doit pas retenir une mise indefiniment.
   */
  duelTick(now) {
    const t = now || Date.now();
    const evs = [];
    for (const [id, partie] of this.p4) {
      const c = this._duelCfg(partie.jeu || 'p4');
      if (partie.phase === EN_COURS) {
        if (partie.tick(t)) evs.push({ type: 'p4Fin', partie, reglement: this._duelRegle(partie) });
      } else if (partie.phase === ATTENTE &&
                 t - partie.creeA > (partie.reserve ? c.revancheMs : c.attenteMs)) {
        /* Une revanche tient moins longtemps qu'une table ouverte : elle
           s'adresse a quelqu'un qui est encore devant son ecran, et elle
           immobilise une mise en attendant sa reponse. */
        this._duelRendre(partie);
        partie.phase = FINIE; partie.raison = 'expiree';
        evs.push({ type: 'p4Expire', partie });
      } else if (partie.phase === FINIE && t - (partie.finA || partie.creeA) > 120000) {
        this.p4.delete(id);   // on ne garde pas les parties finies plus de deux minutes
      }
    }
    return evs;
  }

  /**
   * Les tables ouvertes, pour la fenetre « rejoindre une partie ».
   * Les revanches n'y figurent pas : elles sont nominatives, et les voir
   * afficher une place qu'on ne peut pas prendre serait pire que de ne pas
   * les voir du tout.
   */
  duelLobby(jeu) {
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== ATTENTE || m.reserve) continue;
      if (jeu && (m.jeu || 'p4') !== jeu) continue;
      /* Le profil public porte le niveau, le visage et la photo : le
         vestibule les recoit donc sans avoir a les demander. */
      const q = this.profilPublic(m.joueurs[0]);
      out.push({ id: m.id, jeu: m.jeu || 'p4', mise: m.mise, createur: m.joueurs[0],
                 nom: q.name, niveau: q.niveau, palier: q.palier,
                 visage: q.visage, photo: q.photo, creeA: m.creeA });
    }
    return out.sort((a, b) => b.creeA - a.creeA);
  }

  /**
   * LES PARTIES EN COURS, pour les regarder.
   *
   * Le vestibule ne montrait que les tables qui ATTENDENT. A quatre heures du
   * matin il est vide, et une plateforme qui parait vide convertit tres mal —
   * alors qu'une partie peut tres bien etre en train de se jouer.
   *
   * Ce que ca rend possible, et qui ne coute rien : un spectateur. Il ne mise
   * pas, ne joue pas, n'existe pas pour la partie — il regarde. C'est ce qui
   * transforme un moment a deux en evenement avec public, et ce qui fait qu'une
   * page ouverte a n'importe quelle heure a quelque chose a montrer.
   */
  duelsEnCours(jeu) {
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== EN_COURS) continue;
      if (jeu && (m.jeu || 'p4') !== jeu) continue;
      const j = m.joueurs.map((a) => (a ? this.profilPublic(a) : null));
      out.push({
        id: m.id, jeu: m.jeu || 'p4', mise: m.mise, depuis: m.creeA,
        tour: m.tour,
        joueurs: j.map((q) => q && { address: q.address, nom: q.name, niveau: q.niveau,
                                     palier: q.palier, visage: q.visage, photo: q.photo }),
      });
    }
    /* Les plus grosses mises en tete : c'est ce qu'on a envie de regarder. */
    return out.sort((a, b) => (b.mise - a.mise) || (b.depuis - a.depuis));
  }

  /** Les demandes de revanche qui attendent la reponse de `addr`. */
  duelInvitations(addr, now, jeu) {
    const t = now || Date.now();
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== ATTENTE || m.reserve !== addr) continue;
      if (jeu && (m.jeu || 'p4') !== jeu) continue;
      out.push({ id: m.id, jeu: m.jeu || 'p4', mise: m.mise, de: m.joueurs[0],
                 nom: this._p(m.joueurs[0]).name, revancheDe: m.revancheDe,
                 reste: Math.max(0, this._duelCfg(m.jeu || 'p4').revancheMs - (t - m.creeA)) });
    }
    return out.sort((a, b) => a.reste - b.reste);
  }

  /** L'etat d'une partie, avec les noms — la table n'en connait pas. */
  /**
   * L'etat d'une partie, VU PAR `pour`.
   *
   * Le second parametre n'existe que pour les jeux a information cachee : Le
   * Dernier Chiffre ne doit pas descendre le nombre de l'adversaire dans la
   * page, sinon le second a choisir gagne a tous les coups en ouvrant sa
   * console. Les autres moteurs l'ignorent — leur plateau est public par
   * nature. Sans `pour`, on obtient la vue d'un SPECTATEUR, qui est la plus
   * pauvre : c'est le bon defaut, un oubli cache au lieu de reveler.
   */
  duelEtat(id, now, pour) {
    const m = this.p4.get(String(id));
    if (!m) return null;
    const e = m.etat(now || Date.now(), pour || null);
    e.jeu = m.jeu || 'p4';
    e.noms = m.joueurs.map((a) => (a ? this._p(a).name : null));
    /* Le profil PUBLIC, pas des champs recopies a la main : nom, visage, photo
       et niveau viennent tous de la meme source, donc la table montre
       exactement ce que montrent le vestibule, la liste d'amis et le
       classement. Deux sources finiraient par se contredire, et c'est celle
       qu'on a sous les yeux pendant la partie qu'on croit. */
    e.profils = m.joueurs.map((a) => (a ? this.profilPublic(a) : null));
    /* L'ancien champ reste : les pages en service le lisent encore. */
    e.visages = m.joueurs.map((a) => (a ? { visage: this._p(a).visage || null, photo: !!this._p(a).photo, address: a } : null));
    e.rakeBps = this._duelCfg(e.jeu).rakeBps;
    return e;
  }

  /**
   * Une phrase toute faite, dite a la table.
   *
   * Ce qui arrive ici est un IDENTIFIANT, jamais un texte : il n'y a donc rien
   * a filtrer, et rien qu'un joueur puisse ecrire. Un identifiant inconnu est
   * refuse — c'est ce qui garantit que la liste est vraiment fermee, et non
   * simplement celle que le client veut bien afficher.
   *
   * Seuls les DEUX joueurs parlent. Un spectateur entend la table sans jamais
   * pouvoir y parler : il n'a rien mise, et lui ouvrir la parole rouvrirait
   * a tout le monde la surface qu'on vient de fermer.
   */
  duelDire(addr, id, phraseId, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    if (partie.phase !== EN_COURS) throw new Error('this match is not running');
    const place = partie.joueurs.indexOf(addr);
    if (place < 0) throw new Error('you are not at this table');
    const phrase = (cfg.PHRASES || []).find((x) => x[0] === phraseId);
    if (!phrase) throw new Error('unknown phrase');

    const t = now || Date.now();
    if (!partie.dits) partie.dits = {};
    const d = partie.dits[addr] || (partie.dits[addr] = { t: 0, n: 0 });
    /* On plafonne AVANT d'espacer : celui qui a tout dit doit lire « vous avez
       assez parle », pas « attendez trois secondes » quinze fois de suite. */
    if (d.n >= cfg.PHRASE_MAX) throw new Error('you have said enough for this match');
    if (t - d.t < cfg.PHRASE_PAUSE_MS) throw new Error('slow down');
    d.t = t; d.n++;

    return { partie, joueur: place + 1, id: phrase[0], emote: phrase[1], texte: phrase[2],
             nom: this._p(addr).name, reste: cfg.PHRASE_MAX - d.n };
  }

  /** La partie en cours d'un joueur, s'il en a une. */
  // ------------------------------------------------- le mode entrainement
  /*
   * Les memes six jeux, contre un bot, gratuitement.
   *
   * Ces methodes ne sont qu'un guichet : tout est dans entrainement.js, qui
   * n'a acces a aucun solde. On les met ici pour que server.js n'ait qu'un
   * seul interlocuteur — et pour que la frontiere reste visible, c'est-a-dire
   * qu'on voie d'un coup d'oeil que RIEN dans ce bloc ne touche a l'argent.
   */

  entrainementOuvrir(addr, jeu, now) {
    return this.entrainement.ouvrir(addr, String(jeu || ''), now || Date.now());
  }
  entrainementJouer(addr, coup, now) {
    const r = this.entrainement.jouer(addr, coup, now || Date.now());
    r.prime = this._entrainementPrime(addr, r.partie);
    return r;
  }

  /**
   * LA PRIME : battre un bot rapporte des $SWOGE.
   *
   * ---- pourquoi elle est payee ICI et pas dans entrainement.js ----
   *
   * entrainement.js n'a acces a aucun solde, et c'est une propriete qu'on
   * tient a garder : elle se verifie en lisant le fichier. Il annonce donc
   * qu'une partie est finie et qui l'a gagnee ; c'est ce guichet-ci, qui a
   * deja les soldes en main, qui decide de payer. Toute la creation de
   * $SWOGE du mode entrainement tient donc dans cette seule fonction.
   *
   * ---- ce qui est verifie, et pourquoi chaque verification existe ----
   *
   * • GAGNER, pas finir. Une nulle ne paie pas : au morpion le bot est
   *   parfait, donc la nulle est le meilleur resultat atteignable et serait
   *   sinon une rente a un coup ;
   * • UNE SEULE FOIS PAR PARTIE. Le drapeau est pose sur la partie elle-meme.
   *   Sans lui, redemander l'etat d'une partie gagnee la repaierait ;
   * • UNE SEULE FOIS PAR JEU ET PAR JOUR. C'est le plafond, et il porte sur
   *   LE JEU, pas sur le compte : voir config.js pour le raisonnement — en
   *   deux mots, le Dernier Chiffre se gagne une fois sur quatre en un seul
   *   message, donc un plafond global se viderait au meme jeu en une minute.
   *
   * Rend null quand il n'y a rien a payer, et un objet quand il y a quelque
   * chose a annoncer — y compris « plafond atteint », que le joueur doit voir
   * plutot que de croire a un oubli.
   */
  _entrainementPrime(addr, partie) {
    if (!partie || partie.phase !== FINIE) return null;
    const jeton = partie.jeton(addr);
    if (!jeton || partie.gagnant !== jeton) return null;     // nulle ou defaite
    if (partie.primeVue) return null;                        // deja traitee
    partie.primeVue = true;

    const prime = Number(cfg.ENTRAINEMENT_PRIME) || 0;
    if (prime <= 0) return null;
    const jeu = partie.jeu;
    const p = this._p(addr);
    this._bumpDay(p);
    if (!p.primesEntrainement) p.primesEntrainement = {};
    const max = Number(cfg.ENTRAINEMENT_PRIMES_JOUR) || 0;
    const deja = p.primesEntrainement[jeu] || 0;
    if (max > 0 && deja >= max) return { jeu, prime: 0, plafond: true };

    p.primesEntrainement[jeu] = deja + 1;
    p.balance = p.balance.add(WEI(prime));
    p.dayNet = p.dayNet.add(WEI(prime));
    this.sales.add(addr);
    return { jeu, prime, plafond: false };
  }
  entrainementAbandonner(addr, now) {
    /* Abandonner, c'est perdre, et une partie perdue ne peut jamais payer :
       le controle du vainqueur echoue a chaque appel, autant de fois qu'on
       demande. On passe quand meme par le guichet plutot que de decider ici
       qu'il n'y a rien a faire — le jour ou l'abandon donnerait autre chose
       qu'une defaite, c'est la-bas que ce serait ecrit. */
    const partie = this.entrainement.abandonner(addr, now || Date.now());
    this._entrainementPrime(addr, partie);
    return partie;
  }
  entrainementFermer(addr) { return this.entrainement.fermer(addr); }
  /**
   * L'etat d'une table d'entrainement, HABILLE COMME UNE VRAIE.
   *
   * C'est tout le truc : les six pages savent deja dessiner une table de duel,
   * avec les deux visages, les deux noms et la pendule. On leur rend donc
   * exactement la meme forme — `noms`, `profils`, `visages` — et elles peignent
   * la partie d'entrainement sans une ligne de code en plus. Une deuxieme
   * facon de dessiner un damier, c'est un deuxieme endroit ou le corriger.
   *
   * Le bot recoit un nom et un visage comme n'importe qui. Sans ca la page
   * affiche un siege vide en face du joueur, et la partie a l'air cassee.
   */
  entrainementEtat(addr, now) {
    const e = this.entrainement.etat(addr, now || Date.now());
    if (!e) return null;
    const moi = this._p(addr);
    e.noms = e.joueurs.map((a) => (a === Entrainement.BOT ? e.botNom : (a ? moi.name : null)));
    e.profils = e.joueurs.map((a) => (a === Entrainement.BOT
      ? { name: e.botNom, visage: 'robot', photo: false, address: Entrainement.BOT, niveau: 0, bot: true }
      : (a ? this.profilPublic(a) : null)));
    e.visages = e.joueurs.map((a) => (a === Entrainement.BOT
      ? { visage: 'robot', photo: false, address: Entrainement.BOT }
      : (a ? { visage: moi.visage || null, photo: !!moi.photo, address: a } : null)));
    /* Aucune commission : il n'y a pas de pot. La page lit ce champ pour
       annoncer « le gagnant prend X moins Y » — a zero, elle n'annonce rien,
       ce qui est exactement juste. */
    e.rakeBps = 0;
    return e;
  }
  /** La pendule des tables d'entrainement. Rend celles qui viennent d'expirer,
      pour que le serveur previenne leurs joueurs. */
  entrainementTick(now) {
    const finies = this.entrainement.tick(now || Date.now());
    /* La pendule peut, en principe, faire perdre le bot : aux jeux a coups
       simultanes il n'a pas de tour a lui, et l'echeance tombe sur les deux.
       On passe donc par le meme guichet plutot que de supposer que le joueur
       est forcement le perdant. */
    for (const f of finies) f.prime = this._entrainementPrime(f.addr, f.partie);
    return finies;
  }

  duelMienne(addr) {
    for (const m of this.p4.values())
      if (m.phase !== FINIE && m.jeton(addr)) return m;
    return null;
  }

  /* Les anciens noms restent : le Connect 4 est deja en service, et une
     partie en cours ne doit pas tomber parce qu'on a range le code. */
  p4Creer(addr, mise, now) { return this.duelCreer('p4', addr, mise, now); }
  p4Rejoindre(addr, id, now) { return this.duelRejoindre(addr, id, now); }
  p4Annuler(addr, id, now) { return this.duelAnnuler(addr, id, now); }
  p4Revanche(addr, idAvant, mise, now) { return this.duelRevanche(addr, idAvant, mise, now); }
  p4Jouer(addr, id, colonne, now) { return this.duelJouer(addr, id, colonne, now); }
  p4Abandonner(addr, id, now) { return this.duelAbandonner(addr, id, now); }
  p4Tick(now) { return this.duelTick(now); }
  p4Lobby() { return this.duelLobby('p4'); }
  p4Invitations(addr, now) { return this.duelInvitations(addr, now, 'p4'); }
  p4Etat(id, now) { return this.duelEtat(id, now); }
  p4Mienne(addr) { return this.duelMienne(addr); }
  _p4Regle(partie) { return this._duelRegle(partie); }
  _p4Rendre(partie) { return this._duelRendre(partie); }
  _p4Credite(addr, m) { return this._duelCredite(addr, m); }
  _p4Debite(addr, m) { return this._duelDebite(addr, m, 'p4'); }
  _p4Verifie(mise, addr) { return this._duelVerifie('p4', mise, addr); }

  // ------------------------------------------------------------------ poker
  // Le poker se joue en jetons entiers sur la table (1 jeton = 1 $SWOGE). La
  // cave sort du solde a l'arrivee et y retourne au depart. Ce n'est pas une
  // mise : ce qui est reellement joue est compte main par main via pokerWager.

  /** Sort `amount` du solde pour l'emmener sur une table. */
  pokerBuyIn(addr, amountRaw) {
    const p = this._p(addr);
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) throw new Error('invalid buy-in');
    const w = WEI(amt);
    if (p.balance.lt(w)) throw new Error('not enough $SWOGE');
    p.balance = p.balance.sub(w);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(w);
    return amt;
  }

  /** Ramene des jetons de table dans le solde (depart, exclusion, tapis vide). */
  pokerCashOut(addr, amountRaw) {
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) return 0;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(amt));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(amt));
    return amt;
  }

  /** Ce qu'un joueur a reellement engage sur une main : compte comme une mise. */
  pokerWager(addr, amountRaw) {
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) return;
    const p = this._p(addr);
    this._bumpDay(p); p.dropsToday++;
    this._markWager(p, WEI(amt), 'poker');
  }

  /** Une main gagnee : compte pour les quetes et le classement du jour. */
  pokerWin(addr) { const p = this._p(addr); this._bumpDay(p); p.winsToday++; }

  /**
   * Une main de poker, reglee.
   *
   * Le poker ne passait par aucun point de reglage : ni classement, ni
   * revenu, ni mesure d'usage. Il en a pourtant tout ce qu'il faut — ce que
   * chaque siege a REELLEMENT engage (le remboursement de la mise non suivie
   * est deja retire) et ce que chaque siege a recu. Leur difference, sur une
   * main entiere, EST le rake : la comptabilite tombe juste sans qu'on ait a
   * lui declarer la commission separement.
   */
  pokerManche(addr, mise, rendu) {
    const m = Number(mise) || 0;
    if (!(m > 0)) return;
    this._manche(this._p(addr), 'poker', m, Number(rendu) || 0);
  }

  /**
   * @param annexes {pp, tp} — les mises annexes d'avant-donne, en $SWOGE.
   *
   * TOUT EST DEBITE AVANT LE PREMIER TIRAGE. Debiter la main, distribuer, puis
   * decouvrir que l'annexe ne passe pas laisserait une main jouee sur une mise
   * que le joueur n'a pas les moyens de tenir. On refuse d'abord, on donne
   * ensuite — et le refus ne consomme aucun jeton de la suite provably-fair.
   */
  bjBet(addr, amountRaw, annexes) {
    const p = this._p(addr);
    if (p.bj && p.bj.stage !== 'done') throw new Error('hand in progress');
    const amt = Math.floor(Number(amountRaw));
    if (!(amt >= cfg.BJ_MIN_BET)) throw new Error('bet too small');
    if (amt > cfg.BJ_MAX_BET) throw new Error('max bet is ' + cfg.BJ_MAX_BET + ' $SWOGE');
    const pp = this._bjMiseAnnexe(annexes && annexes.pp, 'perfect pairs');
    const tp = this._bjMiseAnnexe(annexes && annexes.tp, '21+3');
    const w = WEI(amt + pp + tp);
    if (p.balance.lt(w)) throw new Error('not enough $SWOGE');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); p.dropsToday++; this._markWager(p, w, 'bj');
    p.bj = { bet: amt, pc: [this._bjDraw(p), this._bjDraw(p)], dc: [this._bjDraw(p), this._bjDraw(p)], stage: 'player', doubled: false, result: null, payout: 0,
             ann: { pp: { mise: pp, rang: null, gain: 0 }, tp: { mise: tp, rang: null, gain: 0 }, ins: { mise: 0, rang: null, gain: 0 } } };
    this._bjResoutAnnexes(p);
    /* L'ASSURANCE PASSE AVANT LE NATUREL DU CROUPIER. C'est tout son interet :
       on la propose sans savoir, et le tour d'apres on regarde. Verifier le
       blackjack du croupier d'abord la viderait de son sens. */
    if (Game.rangDe(p.bj.dc[0]) === 0 && this._bjAssuranceMax(p) > 0) p.bj.stage = 'insurance';
    else this._bjNaturels(p);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  /**
   * L'assurance. Se propose sur un As decouvert, se borne a la moitie de la
   * main, paie 2:1 si la carte cachee vaut dix. Zero = refus, et refuser est
   * une reponse valide qui fait avancer la main.
   */
  bjInsure(addr, amountRaw) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'insurance') throw new Error('no insurance to take');
    const max = this._bjAssuranceMax(p);
    const m = Math.floor(Number(amountRaw) || 0);
    if (m < 0) throw new Error('bad insurance');
    if (m > max) throw new Error('insurance is at most half your bet');
    if (m > 0) {
      const w = WEI(m);
      p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); this._markWager(p, w, 'bj');
      Game._bjAnn(p.bj).ins.mise = m;
      /* On lit la carte cachee ICI, pour l'assurance seulement. Elle reste
         cachee dans l'etat public : _bjPublic ne la revele qu'a 'done'. */
      const naturel = this._bjVal(p.bj.dc) === 21;
      this._bjPaieAnnexe(p, 'ins', 'bj_ins', naturel ? 'payee' : null, cfg.BJ_INS_PAY);
    }
    this._bjNaturels(p);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjHit(addr) {
    const p = this._p(addr);
    if (this._bjPasseAssurance(addr, p)) return this._bjPublic(p, true);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    p.bj.pc.push(this._bjDraw(p));
    if (this._bjVal(p.bj.pc) > 21) this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjStand(addr) {
    const p = this._p(addr);
    if (this._bjPasseAssurance(addr, p)) return this._bjPublic(p, true);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    this._bjDealerPlay(p);
    this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, true);
  }

  bjDouble(addr) {
    const p = this._p(addr);
    if (this._bjPasseAssurance(addr, p)) return this._bjPublic(p, true);
    if (!p.bj || p.bj.stage !== 'player' || p.bj.pc.length !== 2) throw new Error('cannot double now');
    const w = WEI(p.bj.bet);
    if (p.balance.lt(w)) throw new Error('not enough to double');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); this._markWager(p, w, 'bj'); p.bj.doubled = true;
    p.bj.pc.push(this._bjDraw(p));
    if (this._bjVal(p.bj.pc) <= 21) this._bjDealerPlay(p);
    this._bjSettle(p, p.bj.bet * 2);
    return this._bjPublic(p, true);
  }

  /** A coin was pushed off the front → credit its owner. */
  win(addr, value) {
    if (!value) return;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(value));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(value)); p.winsToday++;
    /* Ce qui tombe se rattache a la chute deja comptee : `suite`. Une piece
       qui atteint le bord n'est pas une nouvelle partie — souvent ce n'est
       meme pas la piece qu'on vient de lacher. */
    this._manche(p, 'pusher', 0, Number(value) || 0, { suite: true, sansJournal: true });
  }

  /**
   * Le frais de retrait, en wei, sur un montant brut. Le meme pour tous.
   *
   * Il n'est verse a personne : il reste dans le coffre pour etre BRULE. Un
   * pour cent qui part dans la poche de la maison est une taxe ; le meme un
   * pour cent retire de la circulation profite a tous les porteurs, celui qui
   * retire compris.
   */
  fraisRetrait(addr, brut) {
    if (!(cfg.WITHDRAW_FEE_BPS > 0)) return BN(0);
    return brut.mul(cfg.WITHDRAW_FEE_BPS).div(10000);
  }

  /** Ce que le joueur doit savoir AVANT de valider. */
  infoFrais() {
    return {
      taux: cfg.WITHDRAW_FEE_BPS / 100,
      du: cfg.WITHDRAW_FEE_BPS > 0,
      brule: true,
      mini: cfg.MIN_WITHDRAW,
    };
  }

  /**
   * Ce qui attend d'etre brule : preleve moins deja brule.
   *
   * On garde les DEUX totaux et non un seul compteur qu'on remettrait a
   * zero : « combien a-t-on brule depuis le debut » est la question qu'on
   * pose quand on doute d'une promesse, et un compteur remis a zero ne sait
   * plus y repondre.
   */
  aBruler() {
    const p = (this.fraisCumules || BN(0)).sub(this.brule || BN(0));
    return p.gt(0) ? p : BN(0);
  }

  /**
   * Note un brulage qui a EU LIEU sur la chaine. Le serveur ne brule pas
   * lui-meme : les jetons sont dans le coffre, et seule la cle du
   * proprietaire peut les en sortir. Ce qu'on enregistre ici, c'est la
   * preuve — un hash de transaction que n'importe qui peut aller verifier.
   */
  enregistreBrulage(montantStr, tx) {
    const w = WEI(String(montantStr));
    if (w.lte(0)) throw new Error('nothing to burn');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ''))) throw new Error('a real transaction hash is required');
    if (this.brulages.some((b) => b.tx.toLowerCase() === String(tx).toLowerCase()))
      throw new Error('this transaction is already recorded');
    this.brule = (this.brule || BN(0)).add(w);
    this.brulages.unshift({ t: Date.now(), m: ethers.utils.formatUnits(w, cfg.DECIMALS), tx: String(tx) });
    if (this.brulages.length > 50) this.brulages.length = 50;
    return { total: ethers.utils.formatUnits(this.brule, cfg.DECIMALS),
             reste: ethers.utils.formatUnits(this.aBruler(), cfg.DECIMALS) };
  }

  /**
   * Les depots du JOURNAL compares a ceux de l'ETAT.
   *
   * ---- pourquoi cette comparaison, et pas une autre ----
   *
   * Les deux nombres sont ecrits dans la meme respiration : le solde monte,
   * puis la ligne part au journal. Mais ils vivent dans DEUX FICHIERS. Le
   * journal est ajoute ligne a ligne, tout de suite ; l'etat est reecrit en
   * entier, une seconde plus tard. Un arret entre les deux — un redeploiement,
   * deux instances qui se marchent dessus — laisse donc le journal en avance
   * sur l'etat : la ligne « Deposit +12 602 » existe, et le solde ne l'a
   * jamais vue.
   *
   * C'est precisement ce cas que cette methode trouve, et l'ecart qu'elle
   * rend est exactement ce qu'il faut recrediter.
   */
  verifieDepots(addr) {
    const a = String(addr).toLowerCase();
    const p = this._p(a);
    /* Le journal ecrit en differe : ce qui attend encore en memoire doit
       partir avant qu'on le relise, sinon le controle sous-estime le journal
       et conclut qu'il n'y a rien a reparer. */
    journal.videSync();
    let curseur = null, lignes = [], somme = 0, tours = 0;
    for (;;) {
      const r = journal.lit(a, { genre: 'dep', curseur, limite: 200 });
      for (const e of r.evenements) {
        /* LA LIGNE DE REPARATION NE COMPTE PAS. Elle est ecrite au journal
           pour que le joueur voie la correction dans son historique — mais
           l'inclure dans le total remettrait le journal en avance sur l'etat
           qu'on vient d'aligner, et la reparation suivante recrediterait la
           meme somme. Une boucle qui cree de l'argent a chaque tour. */
        if (e.tx === 'repair') { lignes.push({ t: e.t, m: e.m, tx: 'repair' }); continue; }
        somme += Number(e.m) || 0;
        lignes.push({ t: e.t, m: e.m, tx: e.tx });
      }
      if (!r.encore || r.curseur === null || ++tours > 40) break;
      curseur = r.curseur;
    }
    const compte = Number(ethers.utils.formatUnits(p.deposited || BN(0), cfg.DECIMALS));
    const ecart = Number((somme - compte).toFixed(6));
    return {
      address: a,
      journal: Number(somme.toFixed(6)),
      etat: compte,
      ecart,
      /* Un ecart NEGATIF n'est pas une panne : le journal est plus jeune que
         les comptes. Un depot fait avant sa mise en service est dans l'etat
         et pas dans le journal, et c'est exactement ce que ca donne. Seul un
         ecart POSITIF signale un credit perdu — le journal ne peut pas
         inventer une ligne. */
      diagnostic: ecart > 0.000001
        ? 'CREDIT PERDU : le journal prouve ' + ecart + ' $SWOGE que l etat n a pas'
        : ecart < -0.000001
          ? 'normal : ' + (-ecart) + ' $SWOGE deposes avant la mise en service du journal'
          : 'les deux fichiers disent la meme chose',
      solde: this.balanceStr(a),
      mouvements: this.mouvements(a),
      depots: lignes.slice(0, 20),
    };
  }

  /**
   * Ou est passe l'argent, par grande categorie.
   *
   * « J'ai depose et je ne le vois plus » a deux reponses possibles : le
   * credit s'est perdu, ou il a ete joue. La premiere se lit dans l'ecart
   * ci-dessus ; la seconde se lit ici, et il faut les deux — sinon on repare
   * un solde qui n'avait rien perdu, et on cree de l'argent.
   */
  mouvements(addr) {
    const a = String(addr).toLowerCase();
    journal.videSync();
    const t = { depots: 0, reparations: 0, retraits: 0, mise: 0, rendu: 0, recu: 0, envoye: 0,
                stake: 0, stakeClaim: 0, parrainage: 0, manches: 0, lignes: 0 };
    let curseur = null, tours = 0;
    for (;;) {
      const r = journal.lit(a, { curseur, limite: 200 });
      for (const e of r.evenements) {
        t.lignes++;
        const m = Number(e.m) || 0;
        if (e.k === 'dep') { if (e.tx === 'repair') t.reparations += m; else t.depots += m; }
        else if (e.k === 'wd') t.retraits += m;
        else if (e.k === 'r') { t.manches++; t.mise += Number(e.m) || 0; t.rendu += Number(e.p) || 0; }
        else if (e.k === 'tr') { if (e.sens === 'in') t.recu += m; else t.envoye += m; }
        else if (e.k === 'st') { if (e.s === 'claim') t.stakeClaim += m; else if (e.s === 'stake') t.stake += m; }
        else if (e.k === 'rf') t.parrainage += m;
      }
      if (!r.encore || r.curseur === null || ++tours > 60) break;
      curseur = r.curseur;
    }
    for (const k of Object.keys(t)) t[k] = Number(t[k].toFixed(6));
    t.resultatDesJeux = Number((t.rendu - t.mise).toFixed(6));
    return t;
  }

  /**
   * Recredite un ecart constate. Ce n'est PAS un cadeau : c'est la reparation
   * d'un depot reel dont la trace existe au journal et que l'etat a perdu.
   * Le montant est donc plafonne par l'ecart — on ne peut rien creer avec.
   */
  repareDepots(addr) {
    const v = this.verifieDepots(addr);
    if (!(v.ecart > 0)) throw new Error('nothing to repair: state matches the journal');
    const a = String(addr).toLowerCase();
    const p = this._p(a);
    const w = WEI(v.ecart.toFixed(6));
    p.balance = p.balance.add(w);
    p.deposited = (p.deposited || BN(0)).add(w);
    p.hasDeposited = true;
    journal.ajouteSync(a, { k: 'dep', m: v.ecart.toFixed(6), tx: 'repair',
                            from: a, note: 'lost credit restored' });
    return { ...this.verifieDepots(a), rendu: v.ecart };
  }

  /* ================================================================
   * CREDITER UN JOUEUR DEPUIS LE PANNEAU
   *
   * Un dedommagement, un lot de concours, une erreur a rattraper. Ces jetons
   * ne viennent d'AUCUN depot : ils augmentent ce que la maison doit sans
   * rien ajouter au coffre. C'est pour ca que ca se compte.
   *
   * UNE ENVELOPPE GLISSANTE, pas un compteur par envoi. Ce qui est borne est
   * le TOTAL sorti sur les douze dernieres heures, tous joueurs confondus :
   * un plafond par envoi se contourne en dix clics, et dix clics passent
   * inapercus la ou un seul gros montant se remarque.
   *
   * Elle se libere au fur et a mesure : un envoi de cent mille fait de la
   * place douze heures apres avoir ete fait, pas au prochain minuit. Le
   * panneau montre les deux, la jauge et le compte a rebours, parce que
   * « vous ne pouvez plus envoyer » sans dire QUAND se lit comme une panne.
   * ================================================================ */

  /** Les envois encore DANS la fenetre, du plus recent au plus ancien. */
  _donsRecents(now) {
    const t = Number(now) || Date.now();
    const depuis = t - cfg.CREDIT_ADMIN_FENETRE_H * 3600000;
    /* On PURGE : la liste ne sert qu'a la fenetre, et un tableau qui grandit
       pour toujours finit dans chaque sauvegarde, toutes les dix secondes. */
    this.dons = (this.dons || []).filter((d) => d && Number(d.t) > depuis);
    return this.dons.slice().sort((a, b) => b.t - a.t);
  }

  /**
   * Ce qui reste a envoyer, et quand le reste revient. C'est ce que le
   * panneau dessine — jauge et barre de temps.
   */
  enveloppeCredit(now) {
    const t = Number(now) || Date.now();
    const fenetre = cfg.CREDIT_ADMIN_FENETRE_H * 3600000;
    const dons = this._donsRecents(t);
    const utilise = dons.reduce((s, d) => s + (Number(d.montant) || 0), 0);
    const reste = Math.max(0, cfg.CREDIT_ADMIN_MAX - utilise);
    /* Le PROCHAIN envoi a sortir de la fenetre : c'est lui qui rend de la
       place, et c'est donc l'heure qu'il faut afficher — pas celle du dernier
       envoi, qui est la plus lointaine des deux. */
    const plusVieux = dons.length ? dons[dons.length - 1] : null;
    return {
      max: cfg.CREDIT_ADMIN_MAX, fenetreH: cfg.CREDIT_ADMIN_FENETRE_H,
      utilise: Number(utilise.toFixed(6)), reste: Number(reste.toFixed(6)),
      envois: dons.length,
      /* Dans combien de temps de la place se libere, et combien. */
      libereDansMs: plusVieux ? Math.max(0, plusVieux.t + fenetre - t) : 0,
      libereMontant: plusVieux ? Number(plusVieux.montant) || 0 : 0,
      /* Et dans combien de temps l'enveloppe est ENTIEREMENT rendue. */
      videDansMs: dons.length ? Math.max(0, dons[0].t + fenetre - t) : 0,
      derniers: dons.slice(0, 12).map((d) => ({
        t: d.t, addr: d.addr, montant: Number(d.montant) || 0,
        nom: (this.players.get(d.addr) || {}).name || null,
      })),
    };
  }

  /** Le joueur vise : son nom public, ou son adresse. */
  trouveJoueur(cible) {
    const s = String(cible || '').trim();
    if (!s) return null;
    const bas = s.toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(bas)) return this.players.has(bas) ? bas : null;
    /* La MEME cle que l'unicite des noms : sans elle, « Éliott » ne
       retrouverait pas « Eliott », et l'exploitant conclurait que le joueur
       n'existe pas. */
    const cle = Game.cleNom(s);
    for (const [a, p] of this.players)
      if (p.name && Game.cleNom(p.name) === cle) return a;
    return null;
  }

  /**
   * Crediter. Le montant est en $SWOGE entiers, la cible un nom ou une
   * adresse. Rend de quoi rafraichir le panneau ET prevenir le joueur.
   */
  crediteJoueur(cible, montantRaw, now, note) {
    const t = Number(now) || Date.now();
    const addr = this.trouveJoueur(cible);
    if (!addr) throw new Error('unknown player — check the name, or paste the address');

    const montant = Math.floor(Number(montantRaw));
    if (!(montant > 0)) throw new Error('amount must be a positive whole number');

    const env = this.enveloppeCredit(t);
    if (env.reste <= 0) {
      const h = Math.floor(env.libereDansMs / 3600000);
      const mn = Math.round((env.libereDansMs % 3600000) / 60000);
      throw new Error(`${env.max} $SWOGE already sent in the last ${env.fenetreH} h — ` +
        `${env.libereMontant} frees up in ${h} h ${mn} min`);
    }
    if (montant > env.reste)
      throw new Error(`only ${Math.floor(env.reste)} $SWOGE left in this ${env.fenetreH} h window ` +
        `(cap ${env.max})`);

    const p = this._p(addr);
    const w = WEI(montant);
    p.balance = p.balance.add(w);
    this._bumpDay(p); p.dayNet = p.dayNet.add(w);

    if (!this.dons) this.dons = [];
    this.dons.push({ t, addr, montant, note: note ? String(note).slice(0, 120) : '' });

    /* Le joueur doit pouvoir le LIRE dans son historique : un solde qui monte
       tout seul, sans ligne pour l'expliquer, se signale comme un bug — ou
       pire, se prend pour un gain qu'on ira chercher a nouveau. */
    journal.ajoute(addr, { k: 'ca', m: String(montant),
                           note: note ? String(note).slice(0, 120) : '' });
    /* La comptabilite le compte a part : ce n'est ni un depot, ni un gain de
       jeu, et le confondre avec l'un des deux fausserait les deux. */
    this.note('cadeaux', String(montant));

    return {
      addr, nom: (this.players.get(addr) || {}).name || null,
      montant, solde: this.balanceStr(addr),
      enveloppe: this.enveloppeCredit(t),
    };
  }

  /** Request a withdrawal of `amountStr` $SWOGE. Returns cumulativeAuthorized (wei) or throws. */
  requestWithdraw(addr, amountStr) {
    /* ---- L'AUTRE MOITIE DE `COMPTES_MAISON` ----
     *
     * Les jetons de ce compte ont ete sortis du « du », donc annonces comme
     * surplus retirable par le proprietaire. Sa fiche porte pourtant toujours
     * la creance : si le surplus est retire ET que ce bon est signe, le coffre
     * doit deux fois la meme somme, et ce sont les joueurs qui n'obtiennent
     * plus leur retrait.
     *
     * Ce refus n'est pas une precaution : c'est ce qui rend l'exclusion sure.
     * L'argent d'un compte maison sort par le retrait du proprietaire — qui,
     * lui, se lit dans le surplus et le fait donc baisser. */
    if (this.estMaison(addr))
      throw new Error('house accounts do not withdraw — their tokens are already counted as house surplus. Use the owner withdrawal.');
    const p = this._p(addr);
    const amount = WEI(amountStr);
    /* Le minimum baisse avec le palier : c'est un confort qui ne coute rien
       a la maison, et qui se remarque tout de suite. */
    const mini = this.minRetraitDe(addr);
    if (amount.lt(WEI(String(mini)))) throw new Error('below minimum withdraw (' + mini + ' $SWOGE)');
    if (amount.gt(p.balance)) throw new Error('amount exceeds balance');
    /* Le cadeau de parrainage ne sort pas tant qu'il n'a pas ete joue. Le
       message dit COMBIEN il reste a miser : « bloque » sans chiffre ferait
       revenir le joueur toutes les cinq minutes. */
    const bloque = p.bonusBloque || BN(0);
    if (bloque.gt(0) && amount.gt(p.balance.sub(bloque))) {
      const reste = (p.bonusCible || BN(0)).sub(p.wagered || BN(0));
      throw new Error('play ' + ethers.utils.formatUnits(reste.gt(0) ? reste : BN(0), cfg.DECIMALS) +
                      ' $SWOGE more to unlock your referral gift');
    }
    /* Le frais se prend sur le brut, et le joueur n'est autorise a tirer que
       le NET : la difference reste dans le coffre, donc dans le surplus du
       proprietaire. Rien n'est cree, rien n'est detruit ici — c'est un
       deplacement, et il doit se retrouver au jeton pres. */
    const frais = this.fraisRetrait(addr, amount);
    const net = amount.sub(frais);
    p.balance = p.balance.sub(amount);
    p.cumulativeAuthorized = p.cumulativeAuthorized.add(net);
    this.fraisCumules = (this.fraisCumules || BN(0)).add(frais);
    this.note('retraits', ethers.utils.formatUnits(net, cfg.DECIMALS));
    this.note('brule', ethers.utils.formatUnits(frais, cfg.DECIMALS));
    /* On journalise l'AUTORISATION, pas l'encaissement : c'est le moment ou le
       solde quitte le compte, et c'est celui que le joueur reconnait. Le bon
       peut encore etre presente plus tard a la chaine — ou jamais. */
    journal.ajoute(addr, { k: 'wd', m: ethers.utils.formatUnits(net, cfg.DECIMALS),
                           brut: amountStr,
                           frais: ethers.utils.formatUnits(frais, cfg.DECIMALS),
                           to: String(addr).toLowerCase(),
                           cum: ethers.utils.formatUnits(p.cumulativeAuthorized, cfg.DECIMALS) });
    return p.cumulativeAuthorized;
  }

  // ------------------------------------------------------------- les amis
  /*
   * Une liste d'adresses, et un virement de solde a solde.
   *
   * Le virement ne touche PAS la chaine : il deplace deux nombres dans l'etat
   * du serveur, ce qui est instantane et gratuit — c'est tout l'interet. Mais
   * c'est de l'argent, donc trois regles :
   *
   *  1. l'expediteur doit avoir DEPOSE au moins une fois. Sans ca, ouvrir dix
   *     portefeuilles jetables, ramasser dix bonus de bienvenue et tout
   *     rassembler sur un onzieme ne couterait rien ;
   *  2. on ne s'envoie rien a soi-meme — ca ne veut rien dire et ca fabrique
   *     de faux mouvements dans l'historique ;
   *  3. debit et credit dans la MEME instruction, sans await entre les deux.
   *     Node est mono-thread : rien ne peut s'intercaler, donc la somme des
   *     deux soldes ne peut pas bouger.
   */
  /** La fiche publique d'une adresse, connue ou non. */
  _vu(a) {
    const q = this.players.get(a);
    if (!q) return { address: a, name: a.slice(0, 6), visage: null, photo: false, connu: false };
    /* On passe par le profil public : ainsi une ligne d'ami porte exactement
       ce qu'une ligne de duel ou de classement porte — meme nom, meme visage,
       meme niveau. Les recopier a la main ici les ferait diverger un jour. */
    return Object.assign(this.profilPublic(a), { connu: true });
  }

  /**
   * Tout ce que l'ecran des amis a besoin de savoir : les amis, les demandes
   * RECUES et celles qu'on a envoyees. Les trois ensemble, parce qu'ils se
   * lisent ensemble — savoir qu'on a une demande en attente sans savoir de
   * qui ne sert a rien.
   */
  amis(addr) {
    const p = this._p(addr);
    return {
      amis: (p.amis || []).map((a) => this._vu(a)),
      recues: (p.demandes || []).map((a) => this._vu(a)),
      envoyees: (p.envoyees || []).map((a) => this._vu(a)),
    };
  }

  /** Combien de demandes attendent une reponse — pour la pastille. */
  amisEnAttente(addr) { return (this._p(addr).demandes || []).length; }

  /** Les envois d'argent recus qu'il n'a pas encore regardes. */
  transfertsNonLus(addr) { return this._p(addr).trNonLus || 0; }
  vuTransferts(addr) { const p = this._p(addr); const n = p.trNonLus || 0; p.trNonLus = 0; return n; }

  /**
   * Cherche des joueurs par NOM. On cherche sur le nom choisi, pas sur
   * l'adresse : personne ne retient une adresse, et c'est justement pour ca
   * que les joueurs se donnent des noms.
   */
  chercheJoueurs(q, moi, max) {
    const cle = Game.cleNom(String(q || '').trim());
    if (cle.length < 2) return [];
    const a_moi = String(moi || '').toLowerCase();
    const debut = [], dedans = [];
    for (const [a, p] of this.players) {
      if (a === a_moi) continue;
      const n = Game.cleNom(p.name || '');
      if (!n) continue;
      const i = n.indexOf(cle);
      if (i === 0) debut.push(this._vu(a));
      else if (i > 0) dedans.push(this._vu(a));
      if (debut.length >= (max || 8)) break;
    }
    // ceux dont le nom COMMENCE par la recherche d'abord : c'est ce qu'on tape
    return debut.concat(dedans).slice(0, max || 8);
  }

  /** L'adresse visee, donnee soit telle quelle, soit par un nom exact. */
  _cible(x) {
    const s = String(x || '').trim();
    if (/^0x[0-9a-f]{40}$/i.test(s)) return s.toLowerCase();
    const cle = Game.cleNom(s);
    if (cle.length < 2) return null;
    for (const [a, p] of this.players) if (Game.cleNom(p.name || '') === cle) return a;
    return null;
  }

  /**
   * Envoie une demande d'ami. On ne devient pas l'ami de quelqu'un sans qu'il
   * l'ait accepte — sinon n'importe qui remplit la liste de n'importe qui.
   * Si l'autre nous avait deja demande, on accepte au lieu de croiser deux
   * demandes qui s'attendent.
   */
  amiDemande(addr, cible) {
    const moi = String(addr).toLowerCase();
    const a = this._cible(cible);
    if (!a) throw new Error('no player found with that name or address');
    if (a === moi) throw new Error('that is you');
    const p = this._p(moi), q = this._p(a);
    if (!p.amis) p.amis = [];
    if (p.amis.indexOf(a) >= 0) throw new Error('already in your friends');
    if (p.amis.length >= 100) throw new Error('friend list is full (100)');

    // il nous avait deja demande : on scelle tout de suite
    if ((p.demandes || []).indexOf(a) >= 0) return this.amiAccepte(moi, a);

    if (!p.envoyees) p.envoyees = [];
    if (p.envoyees.indexOf(a) >= 0) throw new Error('request already sent');
    if (!q.demandes) q.demandes = [];
    if (q.demandes.length >= 200) throw new Error('that player has too many pending requests');
    p.envoyees.push(a);
    q.demandes.push(moi);
    return { etat: this.amis(moi), vers: a };
  }

  amiAccepte(addr, autre) {
    const moi = String(addr).toLowerCase();
    const a = String(autre || '').toLowerCase();
    const p = this._p(moi), q = this._p(a);
    if ((p.demandes || []).indexOf(a) < 0) throw new Error('no request from that player');
    p.demandes = p.demandes.filter((x) => x !== a);
    q.envoyees = (q.envoyees || []).filter((x) => x !== moi);
    if (!p.amis) p.amis = [];
    if (!q.amis) q.amis = [];
    // l'amitie va DANS LES DEUX SENS : un seul cote et l'autre ne voit rien
    if (p.amis.indexOf(a) < 0) p.amis.push(a);
    if (q.amis.indexOf(moi) < 0) q.amis.push(moi);
    return { etat: this.amis(moi), avec: a };
  }

  amiRefuse(addr, autre) {
    const moi = String(addr).toLowerCase();
    const a = String(autre || '').toLowerCase();
    const p = this._p(moi), q = this._p(a);
    p.demandes = (p.demandes || []).filter((x) => x !== a);
    q.envoyees = (q.envoyees || []).filter((x) => x !== moi);
    return this.amis(moi);
  }

  /** Retire des DEUX cotes : garder l'autre moitie n'aurait aucun sens. */
  amiRetire(addr, autre) {
    const moi = String(addr).toLowerCase();
    const a = String(autre || '').toLowerCase();
    const p = this._p(moi), q = this._p(a);
    p.amis = (p.amis || []).filter((x) => x !== a);
    q.amis = (q.amis || []).filter((x) => x !== moi);
    p.envoyees = (p.envoyees || []).filter((x) => x !== a);
    q.demandes = (q.demandes || []).filter((x) => x !== moi);
    return this.amis(moi);
  }

  /**
   * Envoie du $SWOGE d'un solde a un autre.
   * @returns {{ montant:string, vers:string, solde:string }}
   */
  transfere(addr, vers, montantStr) {
    const moi = String(addr).toLowerCase();
    const dest = String(vers || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(dest)) throw new Error('enter a valid 0x… address');
    if (dest === moi) throw new Error('you cannot send to yourself');

    const p = this._p(moi);
    if (cfg.TRANSFER_REQUIRE_DEPOSIT && !p.hasDeposited)
      throw new Error('deposit once before sending $SWOGE to others');

    let montant;
    try { montant = WEI(String(montantStr)); }
    catch (e) { throw new Error('enter a valid amount'); }
    if (montant.lte(0)) throw new Error('enter an amount');
    if (montant.lt(WEI(String(cfg.TRANSFER_MIN)))) throw new Error('minimum transfer is ' + cfg.TRANSFER_MIN + ' $SWOGE');
    if (montant.gt(p.balance)) throw new Error('amount exceeds your balance');

    const q = this._p(dest);
    // debit et credit d'un seul tenant : rien ne peut s'intercaler
    p.balance = p.balance.sub(montant);
    q.balance = q.balance.add(montant);

    const m = ethers.utils.formatUnits(montant, cfg.DECIMALS);
    /* Le destinataire n'est peut-etre pas la. Un message qui passe pendant
       qu'on est deconnecte n'a jamais existe : on compte donc les envois
       recus non vus, et la pastille les porte jusqu'a ce qu'il regarde. */
    q.trNonLus = (q.trNonLus || 0) + 1;
    journal.ajoute(moi, { k: 'tr', sens: 'out', m, autre: dest });
    journal.ajoute(dest, { k: 'tr', sens: 'in', m, autre: moi });
    return { montant: m, vers: dest,
             solde: ethers.utils.formatUnits(p.balance, cfg.DECIMALS),
             nomDest: q.name };
  }

  /* ======================================================================
   * LE RACHAT IMMEDIAT
   * ======================================================================
   *
   * La vitrine demande un acheteur. Celui qui veut se debarrasser d'un commun
   * maintenant n'a pas envie d'attendre trois jours. La maison le reprend a un
   * prix fixe, connu d'avance, et volontairement bien plus bas que ce qu'un
   * joueur en donnerait : c'est une sortie de secours, pas le prix du marche.
   *
   * ---- L'OBJET RETOURNE AU STOCK, IL N'EST PAS DETRUIT ----
   *
   * Et ce n'est pas un choix de confort. Si le rachat detruisait, c'est le
   * COMMUN qui partirait en premier — il est le moins bien paye, donc le plus
   * revendu. A dix pour cent de revente, les mille exemplaires d'un commun
   * disparaissent en dix mille tirages. Le jour ou ils sont partis, PLUS
   * PERSONNE ne peut completer cette famille : c'est justement la piece dont
   * tout le monde a besoin pour finir une ligne, et la course s'arreterait
   * faute de matiere.
   *
   * Le plafond cesse donc de dire « dix seront tirees en tout » pour dire
   * « dix existent a la fois ». La planche l'ecrit ainsi — voir le libelle
   * envoye avec le catalogue. Annoncer l'un et faire l'autre serait pire que
   * les deux.
   *
   * ---- ce que la maison y gagne ----
   *
   * Elle a vendu un coffre 4 000, elle reprend l'objet pour ~500, et elle peut
   * le revendre. Le joueur ressort avec ce qu'il voulait — de la liquidite
   * immediate — et l'edition ne se vide pas.
   */
  prixRachatDe(itemId) {
    const o = boutique.item(itemId);
    return o ? boutique.prixRachat(o.rarete, cfg.RACHAT_BASE) : 0;
  }

  /**
   * LA PORTE DU RACHAT, ET DE QUOI L'AFFICHER.
   *
   * ---- pourquoi il en faut une du tout ----
   *
   * Le rachat est le seul geste du site qui transforme un objet en jetons
   * SANS acheteur en face. Le marche ne cree rien — un joueur paie, un autre
   * encaisse. Le rachat, lui, EMET. Il faut donc que la matiere premiere ait
   * coute quelque chose, et il y a exactement un endroit ou elle ne coute
   * rien : le coffre offert chaque jour.
   *
   * ---- pourquoi le volume et pas le depot ----
   *
   * Un depot se retire. La porte s'ouvrirait avec de l'argent qu'on reprend
   * ensuite, donc elle ne couterait rien a franchir — et une porte gratuite
   * n'est pas une porte. Le volume est DEPENSE : l'avoir joue, c'est avoir
   * laisse l'avantage de la maison sur la table.
   *
   * ---- pourquoi on renvoie le detail et pas un oui/non ----
   *
   * Un bouton grise sans explication se lit « casse ». Avec le chiffre et ce
   * qui reste, il se lit « pas encore » — et il devient une raison de jouer au
   * lieu d'une raison de partir. C'est la meme information, ce n'est pas le
   * meme produit.
   */
  rachatVerrou(addr) {
    const p = this._p(addr);
    const volume = Number(ethers.utils.formatUnits(p.wagered || BN(0), cfg.DECIMALS));
    const requis = Number(cfg.RACHAT_VOLUME_MIN) || 0;
    return { requis, volume: Math.floor(volume),
             reste: Math.max(0, Math.ceil(requis - volume)),
             ouvert: volume >= requis };
  }

  boutiqueRachat(addr, itemId, qteStr) {
    const p = this._p(addr);
    const o = boutique.item(itemId);
    if (!o) throw new Error('unknown item');
    const qte = Math.max(1, Math.floor(Number(qteStr) || 1));
    const ai = (p.objets || {})[o.id] || 0;
    if (ai < qte) throw new Error(qte > 1 ? `you only own ${ai} of these` : 'you do not own this item');

    /* La porte. Le message porte LE CHIFFRE QUI MANQUE : « il faut jouer plus »
       ne dit pas quoi faire, « il te reste 34 000 » si. */
    const v = this.rachatVerrou(addr);
    if (!v.ouvert) {
      throw new Error(`play ${v.reste.toLocaleString('en-US')} more volume to unlock instant sell` +
                      ` (${v.volume.toLocaleString('en-US')} / ${v.requis.toLocaleString('en-US')})`);
    }

    const unite = this.prixRachatDe(o.id);
    if (!(unite > 0)) throw new Error('this item cannot be sold back');
    const total = unite * qte;

    /* Tout d'un seul tenant. */
    p.objets[o.id] -= qte;
    if (!p.objets[o.id]) delete p.objets[o.id];
    p.balance = p.balance.add(WEI(total));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(total));

    /* ---- LE REGISTRE REDESCEND ----
     *
     * C'est ce qui remet l'objet en circulation. Jamais sous zero : un
     * registre negatif ferait afficher plus d'exemplaires restants qu'il n'en
     * existe, et le plafond ne voudrait plus rien dire. */
    if (cfg.RACHAT_RECYCLE) {
      this.boutiqueEmis = this.boutiqueEmis || {};
      this.boutiqueEmis[o.id] = Math.max(0, (this.boutiqueEmis[o.id] || 0) - qte);
    }

    /* Un rachat est une DEPENSE de la maison, pas une recette. La compter
       comme du revenu gonflerait le chiffre d'affaires et, par ricochet, le
       prix du classement qui en est une part. */
    this.note('rachat', -total, String(addr).toLowerCase());
    journal.ajoute(String(addr).toLowerCase(), { k: 'rc', item: o.id, m: String(total), q: qte });
    return { item: o.id, qte, unite, total, recycle: !!cfg.RACHAT_RECYCLE,
             balance: this.balanceStr(addr) };
  }

  /* ======================================================================
   * LE MARCHE
   * ======================================================================
   *
   * ---- l'objet est MIS SOUS SEQUESTRE, pas marque « en vente » ----
   *
   * A la mise en vente, l'objet QUITTE l'inventaire du vendeur et vit dans
   * l'annonce. Un drapeau « en vente » laisse sur place aurait demande de se
   * souvenir de le verifier partout — a la vente, au compte de la collection,
   * au classement, a la ligne complete — et il aurait suffi d'un endroit
   * oublie pour vendre deux fois le meme objet.
   *
   * Le sequestre rend la question impossible a poser : il n'est nulle part
   * ailleurs. En contrepartie il faut le RENDRE a l'annulation, et il doit
   * traverser les sauvegardes — les deux sont testes.
   *
   * ---- il ne fabrique rien ----
   *
   * `boutiqueEmis` n'est jamais touche par une vente. Une piece vendue est la
   * meme piece, chez quelqu'un d'autre. C'est la propriete qui protege
   * l'edition, et c'est la premiere chose que le test verifie.
   */

  /** Ce que le joueur possede VRAIMENT, hors ce qu'il a mis en vente. */
  _possede(p, itemId) { return (p.objets || {})[itemId] || 0; }

  marcheVend(addr, itemId, prixStr, qteStr) {
    const moi = String(addr).toLowerCase();
    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before selling items');

    const o = boutique.item(itemId);
    if (!o) throw new Error('unknown item');
    /* ---- LA QUANTITE ----
     *
     * Une annonce porte N exemplaires du meme objet. L'alternative — N
     * annonces d'un exemplaire — remplissait la vitrine de lignes identiques
     * et mangeait le quota d'annonces pour rien. Ici, cinq communs font une
     * ligne qui dit « x5 ». */
    const qte = Math.max(1, Math.floor(Number(qteStr) || 1));
    if (this._possede(p, o.id) < qte)
      throw new Error(qte > 1 ? `you only own ${this._possede(p, o.id)} of these` : 'you do not own this item');

    const prix = Math.floor(Number(prixStr) || 0);
    if (!(prix >= cfg.MARCHE_PRIX_MIN))
      throw new Error('minimum price is ' + cfg.MARCHE_PRIX_MIN + ' $SWOGE');
    if (prix > cfg.MARCHE_PRIX_MAX)
      throw new Error('maximum price is ' + cfg.MARCHE_PRIX_MAX + ' $SWOGE');

    this.marche = this.marche || [];
    const miennes = this.marche.filter((a) => a.vendeur === moi).length;
    if (miennes >= cfg.MARCHE_ANNONCES_MAX)
      throw new Error('you already have ' + miennes + ' items for sale');

    /* SEQUESTRE ET ANNONCE D'UN SEUL TENANT : rien ne peut s'intercaler entre
       le retrait de l'inventaire et la creation de l'annonce. */
    p.objets[o.id] -= qte;
    if (!p.objets[o.id]) delete p.objets[o.id];
    const a = { id: this.marcheNo++, vendeur: moi, nomVendeur: p.name || moi.slice(0, 6),
                item: o.id, prix, qte, t: Date.now() };
    this.marche.push(a);
    journal.ajoute(moi, { k: 'mv', item: o.id, m: String(prix), q: qte });
    return this._annonceVue(a);
  }

  marcheAnnule(addr, id) {
    const moi = String(addr).toLowerCase();
    const i = (this.marche || []).findIndex((a) => a.id === Number(id));
    if (i < 0) throw new Error('this listing no longer exists');
    const a = this.marche[i];
    if (a.vendeur !== moi) throw new Error('this listing is not yours');
    /* On RETIRE d'abord, on rend ensuite : l'inverse laisserait une fenetre ou
       l'objet est a la fois dans l'inventaire et en vente. */
    this.marche.splice(i, 1);
    const p = this._p(moi);
    p.objets = p.objets || {};
    p.objets[a.item] = (p.objets[a.item] || 0) + (a.qte || 1);
    return { annule: a.id, item: a.item, qte: a.qte || 1 };
  }

  marcheAchete(addr, id) {
    const moi = String(addr).toLowerCase();
    const i = (this.marche || []).findIndex((x) => x.id === Number(id));
    if (i < 0) throw new Error('this listing no longer exists');
    const a = this.marche[i];
    /* ACHETER SA PROPRE ANNONCE EST REFUSE. Ce n'est pas une precaution
       theorique : c'est ainsi qu'on fabrique un faux prix de reference, en se
       vendant a soi-meme pour cinquante millions devant tout le monde. */
    if (a.vendeur === moi) throw new Error('you cannot buy your own listing');

    const p = this._p(moi);
    if (cfg.MARCHE_REQUIERT_DEPOT && !p.hasDeposited)
      throw new Error('deposit once before buying items');
    const prix = WEI(a.prix);
    if (p.balance.lt(prix)) throw new Error('not enough $SWOGE');

    const v = this._p(a.vendeur);
    const frais = prix.mul(cfg.MARCHE_FRAIS_BPS).div(10000);
    const net = prix.sub(frais);

    /* Tout d'un seul tenant : l'annonce part, l'argent passe, l'objet arrive.
       Aucune de ces trois lignes ne peut echouer une fois ici. */
    /* L'annonce ne part que si elle se vide. Sinon elle reste, avec un
       exemplaire de moins : c'est ce qui permet a cinq personnes d'acheter la
       meme ligne l'une apres l'autre. */
    if ((a.qte || 1) > 1) a.qte = (a.qte || 1) - 1;
    else this.marche.splice(i, 1);
    p.balance = p.balance.sub(prix);
    v.balance = v.balance.add(net);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(prix);
    this._bumpDay(v); v.dayNet = v.dayNet.add(net);
    p.objets = p.objets || {};
    p.objets[a.item] = (p.objets[a.item] || 0) + 1;

    const mF = Number(ethers.utils.formatUnits(frais, cfg.DECIMALS));
    if (mF > 0) this.note('marche', mF, moi);
    v.trNonLus = (v.trNonLus || 0) + 1;
    journal.ajoute(moi, { k: 'ma', item: a.item, m: String(a.prix), autre: a.vendeur });
    journal.ajoute(a.vendeur, { k: 'mvend', item: a.item,
                                m: ethers.utils.formatUnits(net, cfg.DECIMALS), autre: moi });

    /* ---- LA LIGNE PEUT SE FERMER PAR UN ACHAT ----
     *
     * `_boutiqueLigne` est appele ici comme il l'est apres un coffre. C'est
     * une DECISION et non un effet de bord : la course recompense d'avoir
     * reuni une famille, pas d'avoir eu de la chance. Celui a qui il manque
     * un legendaire peut donc l'acheter — c'est exactement ce que le marche
     * existe pour permettre, et le prix qu'il paiera est fixe par celui qui
     * le detient.
     *
     * Ce qui ne suit PAS : l'XP. Deux comptes complices se revendraient le
     * meme objet en boucle, et chaque aller-retour paierait sa prime de
     * « jamais possede ». */
    const item = boutique.item(a.item);
    const ligne = item ? this._boutiqueLigne(p, item, Date.now()) : null;

    return { item: a.item, prix: a.prix, vendeur: a.vendeur, ligne,
             frais: mF, balance: this.balanceStr(moi) };
  }

  _annonceVue(a) {
    const o = boutique.item(a.item) || {};
    const r = boutique.rarete(o.rarete) || {};
    return { id: a.id, prix: a.prix, qte: a.qte || 1,
             vendeur: a.vendeur, nomVendeur: a.nomVendeur, t: a.t,
             item: { id: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete, famille: o.famille,
                     /* Le nom AFFICHABLE de la rarete part d'ici. La page
                        montrait la clef interne — « Mythique », « Legendaire » —
                        parce qu'elle n'avait que ca sous la main. Le serveur,
                        lui, connait les deux. */
                     rareteNom: r.nom || o.rarete, couleur: r.couleur || null,
                     saison: o.saison, plafond: r.plafond || 0,
                     emis: (this.boutiqueEmis || {})[o.id] || 0 } };
  }

  /**
   * La vitrine. Triee par rarete puis par prix : c'est l'ordre dans lequel on
   * cherche — on veut d'abord savoir s'il existe un mythique, ensuite combien.
   */
  marcheListe(addr, saison) {
    const moi = String(addr || '').toLowerCase();
    const inv = (this.players.get(moi) || {}).objets || {};
    const rang = {};
    boutique.RARETES.forEach((r, i) => { rang[r.cle] = i; });
    const l = (this.marche || [])
      .map((a) => this._annonceVue(a))
      .filter((a) => !saison || a.item.saison === Number(saison))
      /* `jaiDeja` est calcule ICI et non dans la page : c'est le seul filtre
         qui compte vraiment pour un collectionneur — on ouvre un marche pour
         combler un trou, pas pour racheter ce qu'on a. */
      .map((a) => Object.assign(a, { jaiDeja: !!inv[a.item.id], mien: a.vendeur === moi }));
    l.sort((x, y) => (rang[y.item.rarete] - rang[x.item.rarete]) || (x.prix - y.prix));
    return { annonces: l, miennes: l.filter((a) => a.vendeur === moi).map((a) => a.id),
             frais: cfg.MARCHE_FRAIS_BPS / 100,
             min: cfg.MARCHE_PRIX_MIN, max: cfg.MARCHE_PRIX_MAX };
  }

  fairness(addr) {
    const p = this._p(addr);
    return { serverSeedHash: this.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce };
  }
}

module.exports = { Game, COST, MINW };
