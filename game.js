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
const crash = require('./crash');
const p4 = require('./puissance4');
/* Les trois duels partagent la meme interface de moteur : une Partie qui sait
   rejoindre, jouer, ticker et dire qui a gagne. C'est ce qui permet a un seul
   chemin d'argent de les servir tous les trois. */
const DUELS = { p4, mp: require('./morpion'), dm: require('./dames') };
const ATTENTE = p4.ATTENTE, EN_COURS = p4.EN_COURS, FINIE = p4.FINIE;
const volcano = require('./volcano');

const WEI = (n) => ethers.utils.parseUnits(String(n), cfg.DECIMALS);
const COST = WEI(cfg.DROP_COST);
const SPIN_COST = WEI(cfg.SPIN_COST || '1');
const MINW = WEI(cfg.MIN_WITHDRAW);
const BN = (n) => ethers.BigNumber.from(n);
const MS_YEAR = BN('31536000000'); // 365*24*3600*1000

class Game {
  constructor() {
    this.players = new Map(); // addr -> { balance, cumulativeAuthorized, clientSeed, nonce, name, dayNet, dayKey, dropsToday, winsToday, questClaimed, hasDeposited }
    this.telegramMap = new Map(); // telegramId (string) -> addr, so the Adsgram reward postback can find the account
    this.seenTx = new Set();  // dedupe deposits
    this.lastBlock = 0;       // deposit-scan watermark (persisted so a restart resumes)
    this._stakeRateBps = BN(cfg.STAKE_APR_BPS);
    // progressive jackpot (all wei)
    this.jackpotPot = WEI(cfg.JACKPOT_SEED);
    this._jackpotSeed = WEI(cfg.JACKPOT_SEED);
    this._rakeWei = COST.mul(Math.round(cfg.JACKPOT_RAKE_PCT * 100)).div(10000); // pct, 2-dec
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
    this.p4Seq = 0;
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
      && z(p.refDu) && z(p.refTotal) && !(p.attente || []).length;
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
  serialize() {
    const players = [];
    let vides = 0;
    for (const [addr, p] of this.players) {
      /* Les fiches vides ne sont pas ecrites. C'est la seule barriere entre
         un script qui ouvre mille comptes par minute et un fichier de soldes
         qui devient trop lourd pour etre sauve. */
      if (Game.estVide(p)) { vides++; continue; }
      players.push([addr, {
        b: p.balance.toString(), c: p.cumulativeAuthorized.toString(),
        s: p.clientSeed, n: p.nonce, name: p.name, nc: !!p.nomChoisi,
        /* Le nom a ete PAYE. Sans ca au fichier, le joueur repaierait mille
           jetons a chaque redeploiement, et personne ne comprendrait pourquoi. */
        np: !!p.nomPaye,
        dn: p.dayNet.toString(), dk: p.dayKey,
        dt: p.dropsToday, wt: p.winsToday, qc: p.questClaimed, hd: p.hasDeposited,
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
        tg: p.tgId || null,
        wg: !!p.welcomeGranted, ww: !!p.welcomeWagered, wc: !!p.welcomeClaimed,
        sd: p.streakDay || 0, sl: p.streakLastClaimDay || null,
        ac: p.adCount || 0, ak: p.adDayKey || null, al: p.adLastMs || 0,
      }]);
    }
    if (vides > 100) console.log(`[store] ${vides} fiche(s) vide(s) non ecrite(s)`);
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
             compta: this._comptaEcrite(), tunnel: this.tunnel || {},
             prixVerses: this.prixVerses || {},
             graines: this.graines || [], graineDepuis: this.graineDepuis || null,
             manchesGraine: this.manchesGraine || 0,
             jackpotPot: this.jackpotPot.toString(),
             crashGraine: this.crashGraine, crash: this.crash.sauve(),
             fraisCumules: (this.fraisCumules || BN(0)).toString(),
             brule: (this.brule || BN(0)).toString(), brulages: this.brulages || [],
             lastBlock: this.lastBlock, seenTx: Array.from(this.seenTx), players,
             duels, telegramMap: Array.from(this.telegramMap) };
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
    if (st.serverSeed) { this.serverSeed = st.serverSeed; this.serverSeedHash = crypto.createHash('sha256').update(st.serverSeed).digest('hex'); }
    /* Les graines revelees survivent a tout : elles sont la SEULE facon pour
       un joueur de verifier une manche d'il y a six mois. Les perdre au
       redemarrage reviendrait a retirer la preuve apres l'avoir donnee. */
    if (st.compta) this.compta = st.compta;
    if (st.tunnel) this.tunnel = st.tunnel;
    if (st.prixVerses) this.prixVerses = st.prixVerses;
    if (Array.isArray(st.graines)) this.graines = st.graines;
    if (st.graineDepuis) this.graineDepuis = st.graineDepuis;
    if (st.manchesGraine) this.manchesGraine = st.manchesGraine;
    if (st.jackpotPot) this.jackpotPot = ethers.BigNumber.from(st.jackpotPot);
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
        visage: d.vi || null, amis: Array.isArray(d.am) ? d.am : [], photo: !!d.ph,
        demandes: Array.isArray(d.dm) ? d.dm : [], envoyees: Array.isArray(d.en) ? d.en : [],
        parrain: d.pa || null, filleuls: Array.isArray(d.fi) ? d.fi : [],
        refDu: ethers.BigNumber.from(d.rd || '0'), refTotal: ethers.BigNumber.from(d.rt || '0'),
        revCumul: Number(d.rc || 0), revPaye: Number(d.rp || 0),
        attente: Array.isArray(d.att) ? d.att : [],
        record: d.rec || null, meilleurJour: d.mj || null, refBienvenue: !!d.rb,
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
  _markWager(p, wei) {
    if (!p) return;
    /* Le compteur AVANT le tirage. C'est le seul endroit traverse par tous les
       jeux au moment ou la mise part, donc avant qu'aucune carte ne soit
       tiree : en le notant ici et en relisant le compteur a la fin de la
       manche, on obtient la PLAGE exacte de numeros utilises. Noter seulement
       le compteur final serait faux des qu'un jeu tire plusieurs fois — au
       blackjack, une main en consomme une dizaine. */
    p.nonceDebut = p.nonce;
    if (!p.welcomeWagered) p.welcomeWagered = true;
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
  _manche(p, jeu, mise, rendu) {
    if (!p || !jeu) return;
    /* Le seul point de passage de TOUTES les manches, tous jeux confondus :
       c'est donc ici que le journal se remplit, et nulle part ailleurs. Un
       nouveau jeu qui appelle _manche est journalise sans rien avoir a
       ajouter — et un jeu qui oublierait de l'appeler ne compterait deja pas
       dans les statistiques, ce qui se voit. */
    if (p.addr) journal.ajoute(p.addr, { k: 'r', g: jeu, m: Number(mise) || 0, p: Number(rendu) || 0,
      /* De quoi refaire le calcul soi-meme, une fois la graine du serveur
         revelee : son empreinte, la graine du joueur, et les numeros utilises
         par cette manche. */
      sh: this.serverSeedHash, cs: p.clientSeed,
      n0: p.nonceDebut == null ? p.nonce : p.nonceDebut, n1: p.nonce });
    this.manchesGraine = (this.manchesGraine || 0) + 1;
    /* LE point de passage du revenu. Il vaut pour les jeux contre la banque
       comme pour le 1v1 : la somme des mises moins la somme des rendus EST ce
       que la maison garde, commission comprise. */
    this.note('mises', Number(mise) || 0, p.addr);
    this.note('rendus', Number(rendu) || 0, p.addr);
    this.note('manches', 1);
    /* Le volume du MOIS. Il se remet a zero tout seul au changement de mois :
       un classement mensuel qu'il faut penser a reinitialiser finit toujours
       par afficher le mois d'avant. */
    const mc = Game.moisCle();
    if (p.moisCle !== mc) { p.moisCle = mc; p.moisMise = 0; }
    p.moisMise = (p.moisMise || 0) + (Number(mise) || 0);

    if (!p.jeux) p.jeux = {};
    const j = p.jeux[jeu] || (p.jeux[jeu] = { n: 0, mise: 0, rendu: 0, gagne: 0, nul: 0 });
    j.n++;
    j.mise += Number(mise) || 0;
    j.rendu += Number(rendu) || 0;
    if (rendu > mise) j.gagne++;
    else if (rendu === mise) j.nul++;

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
    else p.attente.push([jour, du]);
  }

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
    const couts = Number((m.staking + m.bonus + m.parrainage + m.jackpots).toFixed(6));
    return {
      mois: k,
      /* le revenu */
      mises: m.mises, rendus: m.rendus, revenu, manches: m.manches,
      /* ce qui est donne */
      staking: m.staking, bonus: m.bonus, parrainage: m.parrainage, jackpots: m.jackpots,
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
  /** Le niveau que donne un volume. */
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
    const n = this._niveauAcquis(p, Game.niveauDe(v));
    const suivant = Math.min(cfg.NIVEAU_MAX, n + 1);
    const bas = n === 0 ? 0 : Game.volumePour(n);
    const haut = Game.volumePour(suivant);
    const max = n >= cfg.NIVEAU_MAX;
    return {
      niveau: n,
      palier: Game.PALIERS[Math.min(Math.floor(Math.max(0, n - 1) / 10), 9)],
      palierNo: Math.min(Math.floor(Math.max(0, n - 1) / 10) + 1, 10),
      volume: Number(v.toFixed(2)),
      seuil: Math.round(bas),
      prochain: max ? null : Math.round(haut),
      restant: max ? 0 : Math.max(0, Math.round(haut - v)),
      progression: max ? 100 : Number(Math.max(0, Math.min(100, (v - bas) / (haut - bas) * 100)).toFixed(1)),
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
  }
  jackpotStr() { return ethers.utils.formatUnits(this.jackpotPot, cfg.DECIMALS); }

  // ---- Staking: 100% APR, per-position soft lock; early exit forfeits 50% ----
  _lockMs() { return cfg.STAKE_LOCK_DAYS * 86400000; }
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

  /** Ou en est la salle : ce qui est pris, ce qui reste, et le taux de
   *  remplissage. C'est ce que la page de staking affiche AVANT que le joueur
   *  tape un montant — un refus qui arrive apres la saisie est une brimade. */
  capaciteStaking() {
    const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));
    const plafond = this.plafondStaking();
    const occupe = this.totalStaked();
    if (!plafond) return { plafond: null, occupe: f(occupe), libre: null, taux: 0, plein: false };
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

  /** Unstake EVERYTHING + pay accrued yield. Unlocked positions return in full;
   * still-locked ones return (1 − penalty), the rest is forfeited to the vault. */
  unstakeAll(addr) {
    const p = this._p(addr);
    if (!p.stakes.length) throw new Error('nothing staked');
    this._settleStakes(p);
    const now = Date.now();
    let returned = BN(0), penalty = BN(0);
    for (const pos of p.stakes) {
      if (now >= pos.u) { returned = returned.add(pos.a); }
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
    /* Ce que le staking coute chaque jour, que quelqu'un joue ou non. */
    const rendementJour = staked * (cfg.STAKE_APR_BPS / 10000) / 365;
    /* Ce que la maison encaisse chaque jour, mesure sur le mois en cours et
       non estime : c'est le seul des deux chiffres qui puisse surprendre. */
    const c = this.comptes();
    const jours = Math.max(1, new Date().getUTCDate());
    const revenuJour = (c.revenu || 0) / jours;
    const drainJour = rendementJour - revenuJour;

    const b = this.owedBreakdown();
    const du = f(b.balances.add(b.staked).add(b.pending).add(b.jackpot));
    const surplus = pot ? f(pot) - du : null;

    return {
      staked, rendementJour: Number(rendementJour.toFixed(6)),
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
   * yield, and the jackpot reserve. */
  owedBreakdown() {
    let balances = BN(0), staked = BN(0), pending = BN(0);
    for (const p of this.players.values()) {
      balances = balances.add(p.balance);
      staked = staked.add(this._stakedTotal(p));
      pending = pending.add(p.stakeAccrued).add(this._pendingAll(p));
    }
    return { balances, staked, pending, jackpot: this.jackpotPot };
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
        bets: p.betCount || 0,                     // nombre de mises
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
      });
    }
    rows.sort((a, b) => parseFloat(b.wagered) - parseFloat(a.wagered));
    return rows;
  }

  stakeInfo(addr) {
    const p = this._p(addr);
    const pending = p.stakeAccrued.add(this._pendingAll(p));
    const now = Date.now();
    let locked = BN(0), unlocked = BN(0), nextUnlock = null;
    for (const pos of p.stakes) {
      if (now >= pos.u) unlocked = unlocked.add(pos.a);
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
      capacite: this.capaciteStaking(),
    };
  }

  /** Per-player daily quest state (progress + claimable flags). */
  questState(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const locked = cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited;
    return cfg.QUESTS.map((q) => {
      const prog = q.metric === 'drops' ? p.dropsToday : q.metric === 'wins' ? p.winsToday : q.target; // 'free' → always met
      const done = prog >= q.target;
      const claimed = !!p.questClaimed[q.id];
      return { id: q.id, label: q.label, metric: q.metric, target: q.target, reward: q.reward,
               progress: Math.min(prog, q.target), done, claimed, locked, claimable: done && !claimed && !locked };
    });
  }

  /** Claim a completed quest → credit its reward. Throws on any invalid claim. */
  claimQuest(addr, id) {
    const p = this._p(addr); this._bumpDay(p);
    const q = cfg.QUESTS.find((x) => x.id === id);
    if (!q) throw new Error('unknown quest');
    if (cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited) throw new Error('deposit first to unlock quests');
    const prog = q.metric === 'drops' ? p.dropsToday : q.metric === 'wins' ? p.winsToday : q.target;
    if (prog < q.target) throw new Error('quest not complete yet');
    if (p.questClaimed[q.id]) throw new Error('already claimed today');
    p.questClaimed[q.id] = true;
    const r = WEI(q.reward);
    p.balance = p.balance.add(r);
    p.dayNet = p.dayNet.add(r);
    return q.reward;
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
    return { day: s.day, reward };
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
        graineJoueur: "chaque jeu ajoute son propre suffixe a la graine du joueur : ':plinko', ':mines', ':hilo', ':casino' (Hold'em et Three Card). Le Coin Pusher n'en ajoute aucun ; le blackjack place ':bj:' avant le numero.",
        pusher: "HMAC_SHA256(graine_serveur, graine_joueur + ':' + n1)",
        blackjack: "HMAC_SHA256(graine_serveur, graine_joueur + ':bj:' + numero), un tirage par carte",
        plinko: "flux d'octets, compteur a partir de 0 : HMAC_SHA256(graine_serveur, graine_joueur + ':plinko' + ':' + n1 + ':' + compteur). Un bit par rangee, du bit de poids fort au plus faible ; 1 = a droite. La case d'arrivee est la somme des bits.",
        mines: "meme flux, avec le suffixe ':mines'",
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
            dropsToday: 0, winsToday: 0, questClaimed: {}, hasDeposited: false,
            stakes: [], stakeAccrued: ethers.BigNumber.from(0), volcanoMeter: 0,
            wagered: ethers.BigNumber.from(0), betCount: 0,
            tgId: null, welcomeGranted: false, welcomeWagered: false, welcomeClaimed: false,
            streakDay: 0, streakLastClaimDay: null, adCount: 0, adDayKey: null, adLastMs: 0 };
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
    return { address: String(addr).toLowerCase(), name: p.name,
             visage: p.visage || null, photo: !!p.photo,
             niveau: n.niveau, palier: n.palier, palierNo: n.palierNo };
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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(COST); p.dropsToday++; this._markWager(p, COST);
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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei);
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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei);
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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(costWei); p.dropsToday++; this._markWager(p, costWei);
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
  _bjDraw(p) {
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':bj:' + p.nonce).digest('hex');
    p.nonce++;
    return Number(BigInt('0x' + h.slice(0, 15)) % BigInt(13));
  }
  _bjVal(ranks) {
    let sum = 0, aces = 0;
    for (const r of ranks) { if (r === 0) { sum += 11; aces++; } else if (r >= 9) sum += 10; else sum += r + 1; }
    while (sum > 21 && aces) { sum -= 10; aces--; }
    return sum;
  }
  _bjDealerPlay(p) { while (this._bjVal(p.bj.dc) < 17) p.bj.dc.push(this._bjDraw(p)); }
  _bjPublic(p, reveal) {
    const b = p.bj, show = reveal || b.stage === 'done';
    return {
      bet: b.bet, doubled: !!b.doubled, stage: b.stage,
      player: { cards: b.pc.slice(), value: this._bjVal(b.pc) },
      dealer: { cards: show ? b.dc.slice() : [b.dc[0]], value: show ? this._bjVal(b.dc) : this._bjVal([b.dc[0]]), hidden: !show },
      canDouble: b.stage === 'player' && b.pc.length === 2 && p.balance.gte(WEI(b.bet)),
      result: b.result || null, payout: b.payout || 0,
      balance: ethers.utils.formatUnits(p.balance, cfg.DECIMALS),
      fairness: { serverSeedHash: this.serverSeedHash, nonce: p.nonce },
    };
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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(debit); p.dropsToday++; this._markWager(p, debit);

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
      this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(extra)); this._markWager(p, WEI(extra));
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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise));

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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise));

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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise));

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
    p.dropsToday++; this._markWager(p, WEI(mise));
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
    const p = jeu === 'mp' ? 'MP' : jeu === 'dm' ? 'DM' : 'P4';
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

  _duelDebite(addr, mise) {
    const p = this._p(addr);
    p.balance = p.balance.sub(WEI(mise));
    // dropsToday compte pour les quetes du jour. Tous les autres jeux
    // l'incrementent a la mise ; le Connect 4 l'avait oublie, et une partie
    // ne faisait donc avancer aucune quete.
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++;
    this._markWager(p, WEI(mise));
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
    this._duelDebite(addr, mise);
    this.p4.set(id, partie);
    return partie;
  }

  /** S'asseoir en face. La partie demarre a cet instant. */
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
    this._duelDebite(addr, mise);
    partie.rejoindre(addr, t);
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
    this._duelDebite(addr, mise);
    this.p4.set(id, partie);
    return partie;
  }

  duelJouer(addr, id, coup, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    const r = partie.jouer(addr, coup, now || Date.now());
    const reglement = partie.phase === FINIE ? this._duelRegle(partie) : null;
    return { partie, coup: r, reglement };
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
    } else {
      const gagnant = partie.adresseGagnante();
      const perdant = partie.joueurs[partie.gagnant === 1 ? 1 : 0];
      this._duelCredite(gagnant, r.gain);
      const pg = this._p(gagnant);
      this._bumpDay(pg); pg.winsToday++;
      this._manche(pg, jeu, partie.mise, r.gain);
      if (perdant) this._manche(this._p(perdant), jeu, partie.mise, 0);
    }
    return r;
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
  duelEtat(id, now) {
    const m = this.p4.get(String(id));
    if (!m) return null;
    const e = m.etat(now || Date.now());
    e.jeu = m.jeu || 'p4';
    e.noms = m.joueurs.map((a) => (a ? this._p(a).name : null));
    e.visages = m.joueurs.map((a) => (a ? { visage: this._p(a).visage || null, photo: !!this._p(a).photo, address: a } : null));
    e.rakeBps = this._duelCfg(e.jeu).rakeBps;
    return e;
  }

  /** La partie en cours d'un joueur, s'il en a une. */
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
  _p4Debite(addr, m) { return this._duelDebite(addr, m); }
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
    this._markWager(p, WEI(amt));
  }

  /** Une main gagnee : compte pour les quetes et le classement du jour. */
  pokerWin(addr) { const p = this._p(addr); this._bumpDay(p); p.winsToday++; }

  bjBet(addr, amountRaw) {
    const p = this._p(addr);
    if (p.bj && p.bj.stage !== 'done') throw new Error('hand in progress');
    const amt = Math.floor(Number(amountRaw));
    if (!(amt >= cfg.BJ_MIN_BET)) throw new Error('bet too small');
    if (amt > cfg.BJ_MAX_BET) throw new Error('max bet is ' + cfg.BJ_MAX_BET + ' $SWOGE');
    const w = WEI(amt);
    if (p.balance.lt(w)) throw new Error('not enough $SWOGE');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); p.dropsToday++; this._markWager(p, w);
    p.bj = { bet: amt, pc: [this._bjDraw(p), this._bjDraw(p)], dc: [this._bjDraw(p), this._bjDraw(p)], stage: 'player', doubled: false, result: null, payout: 0 };
    const pv = this._bjVal(p.bj.pc), dv = this._bjVal(p.bj.dc);
    if (pv === 21 || dv === 21) {
      if (pv === 21 && dv === 21) { p.bj.stage = 'done'; p.bj.result = 'push'; p.balance = p.balance.add(w); this._bumpDay(p); p.dayNet = p.dayNet.add(w); p.bj.payout = amt; this._manche(p, 'bj', amt, amt); }
      else if (pv === 21) { const credit = amt * 2.5; p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); p.winsToday++; p.bj.stage = 'done'; p.bj.result = 'blackjack'; p.bj.payout = credit; this._manche(p, 'bj', amt, credit); }
      else { p.bj.stage = 'done'; p.bj.result = 'dealer_blackjack'; p.bj.payout = 0; this._manche(p, 'bj', amt, 0); }
    }
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjHit(addr) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    p.bj.pc.push(this._bjDraw(p));
    if (this._bjVal(p.bj.pc) > 21) this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjStand(addr) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    this._bjDealerPlay(p);
    this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, true);
  }

  bjDouble(addr) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'player' || p.bj.pc.length !== 2) throw new Error('cannot double now');
    const w = WEI(p.bj.bet);
    if (p.balance.lt(w)) throw new Error('not enough to double');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); this._markWager(p, w); p.bj.doubled = true;
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

  /** Request a withdrawal of `amountStr` $SWOGE. Returns cumulativeAuthorized (wei) or throws. */
  requestWithdraw(addr, amountStr) {
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

  fairness(addr) {
    const p = this._p(addr);
    return { serverSeedHash: this.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce };
  }
}

module.exports = { Game, COST, MINW };
