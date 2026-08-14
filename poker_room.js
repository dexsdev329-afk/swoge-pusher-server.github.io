'use strict';
/*
 * SWOGE Poker — la salle : plusieurs tables, l'argent, et le temps.
 *
 * poker_table.js ne connait que des jetons entiers et un temps injecte. La
 * salle fait le pont avec le reste du serveur :
 *   - cave prise sur le solde $SWOGE a l'arrivee, rendue au depart
 *   - un joueur ne peut etre assis qu'a une seule table
 *   - PAS DE BOT : une table a un seul joueur attend simplement le deuxieme
 *   - minuteur d'une minute par decision, exclusion apres 5 mains sans action
 *
 * Tout jeton qui quitte une table repasse par `pokerCashOut`. C'est le seul
 * chemin, pour qu'aucun jeton ne puisse se perdre entre les deux comptabilites.
 */

const crypto = require('crypto');
const { PokerTable } = require('./poker_table');

const DEFAULT_TABLES = [
  { id: 'micro', name: 'Doge Micro', smallBlind: 1,   bigBlind: 2 },
  { id: 'low',   name: 'Wolf Low',   smallBlind: 5,   bigBlind: 10 },
  { id: 'high',  name: 'Bull High',  smallBlind: 50,  bigBlind: 100 },
];

class PokerRoom {
  /**
   * @param game     instance de Game (soldes, quetes, statistiques)
   * @param opts.onEvent(tableId, event)   notifie le serveur (diffusion)
   * @param opts.tables                    definition des tables
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.onEvent = opts.onEvent || (() => {});
    this.actionMs = opts.actionMs != null ? opts.actionMs : 60000;
    this.idleHandsLimit = opts.idleHandsLimit != null ? opts.idleHandsLimit : 5;
    this.betweenHandsMs = opts.betweenHandsMs != null ? opts.betweenHandsMs : 5000;
    this.rakeBps = opts.rakeBps != null ? opts.rakeBps : 500;   // 5 %
    this.rakeCollected = 0;

    this.tables = new Map();
    this.meta = new Map();          // tableId -> { name, nextHandAt, seedHash }
    this.seatOf = new Map();        // addr -> { tableId, seat }

    for (const d of (opts.tables || DEFAULT_TABLES)) {
      const seed = crypto.randomBytes(32).toString('hex');
      const t = new PokerTable({
        id: d.id, maxSeats: 6,
        smallBlind: d.smallBlind, bigBlind: d.bigBlind,
        minBuyIn: d.minBuyIn != null ? d.minBuyIn : d.bigBlind * 20,
        maxBuyIn: d.maxBuyIn != null ? d.maxBuyIn : d.bigBlind * 200,
        actionMs: this.actionMs, idleHandsLimit: this.idleHandsLimit,
        rakeBps: this.rakeBps, rakeCap: d.bigBlind * 5,
        serverSeed: seed,
      });
      this.tables.set(d.id, t);
      this.meta.set(d.id, {
        name: d.name, nextHandAt: 0,
        seedHash: crypto.createHash('sha256').update(seed).digest('hex'),
      });
    }
  }

  // ------------------------------------------------------------------ lecture

  lobby() {
    return [...this.tables.entries()].map(([id, t]) => {
      const m = this.meta.get(id);
      return {
        id, name: m.name, sb: t.sb, bb: t.bb,
        minBuyIn: t.minBuyIn, maxBuyIn: t.maxBuyIn,
        seats: t.maxSeats, players: t.occupied().length,
        state: t.state, seedHash: m.seedHash,
        rakeBps: t.rakeBps, rakeCap: t.rakeCap,
        waitingForPlayers: t.state === 'waiting' && t.ready().length < 2,
      };
    });
  }

  where(addr) { return this.seatOf.get(addr) || null; }

  occupied(tableId) {
    const t = this.tables.get(tableId);
    return t ? t.occupied() : [];
  }

  snapshot(tableId, addr) {
    const t = this.tables.get(tableId);
    if (!t) return null;
    const at = this.seatOf.get(addr);
    const mine = at && at.tableId === tableId ? at.seat : -1;
    const m = this.meta.get(tableId);
    const snap = t.snapshot(mine);
    snap.name = m.name;
    snap.mySeat = mine;
    snap.nextHandAt = m.nextHandAt;
    snap.minBuyIn = t.minBuyIn;
    snap.maxBuyIn = t.maxBuyIn;
    snap.waitingForPlayers = t.state === 'waiting' && t.ready().length < 2;
    return snap;
  }

  // -------------------------------------------------------------- mouvements

  /** S'asseoir. `seat` a -1 = premiere place libre. */
  join(addr, tableId, buyIn, { seat = -1, name, avatar } = {}) {
    if (this.seatOf.has(addr)) throw new Error('deja assis a une table');
    const t = this.tables.get(tableId);
    if (!t) throw new Error('table inconnue');

    let place = seat;
    if (place < 0 || t.seats[place]) {
      place = t.seats.findIndex((s) => !s);
      if (place < 0) throw new Error('table complete');
    }
    const amt = Math.floor(Number(buyIn));
    if (!(amt >= t.minBuyIn)) throw new Error(`cave minimum : ${t.minBuyIn} $SWOGE`);
    if (amt > t.maxBuyIn) throw new Error(`cave maximum : ${t.maxBuyIn} $SWOGE`);

    // on debite d'abord : si le solde est insuffisant, rien n'a bouge
    this.game.pokerBuyIn(addr, amt);
    try {
      // L'avatar suit la place : six sieges, six animaux, donc jamais deux
      // joueurs avec la meme tete a la meme table. Un choix explicite ne peut
      // pas casser cette garantie, il est seulement pris comme preference.
      const tete = (avatar != null && !this.occupied(tableId).some((i) => t.seats[i].avatar === (avatar % 6)))
        ? (avatar % 6) : place % 6;
      t.sit(place, { addr, name, stack: amt, avatar: tete });
    } catch (e) {
      this.game.pokerCashOut(addr, amt);          // annulation propre
      throw e;
    }
    this.seatOf.set(addr, { tableId, seat: place });
    this._after(tableId, Date.now());
    return { tableId, seat: place, stack: amt };
  }

  /** Quitter la table (encaisse le tapis). Renvoie ce qui est recredite. */
  leaveTable(addr, now = Date.now()) {
    const at = this.seatOf.get(addr);
    if (!at) return 0;
    const t = this.tables.get(at.tableId);
    t.leave(at.seat, now);
    return this._after(at.tableId, now);
  }

  /** Jouer une action. `amount` = mise TOTALE visee pour bet/raise. */
  act(addr, action, amount = 0, now = Date.now()) {
    const at = this.seatOf.get(addr);
    if (!at) throw new Error('vous n etes pas a une table');
    const t = this.tables.get(at.tableId);
    if (t.currentSeat !== at.seat) throw new Error('ce n est pas votre tour');
    t.act(at.seat, action, amount, now);
    this._after(at.tableId, now);
    return at.tableId;
  }

  /** Se mettre en pause : on ne recoit plus de cartes, mais on garde sa place. */
  sitOut(addr, flag = true) {
    const at = this.seatOf.get(addr);
    if (!at) throw new Error('vous n etes pas a une table');
    const s = this.tables.get(at.tableId).seats[at.seat];
    if (s) s.sittingOut = !!flag;
    return !!flag;
  }

  /** Recaver : ajoute des jetons entre deux mains. */
  rebuy(addr, amountRaw) {
    const at = this.seatOf.get(addr);
    if (!at) throw new Error('vous n etes pas a une table');
    const t = this.tables.get(at.tableId);
    const s = t.seats[at.seat];
    if (s.inHand && t.state !== 'waiting' && t.state !== 'showdown') {
      throw new Error('impossible pendant une main');
    }
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) throw new Error('montant invalide');
    if (s.stack + amt > t.maxBuyIn) throw new Error(`cave maximum : ${t.maxBuyIn} $SWOGE`);
    this.game.pokerBuyIn(addr, amt);
    s.stack += amt;
    return s.stack;
  }

  // ---------------------------------------------------------------- horloge

  /**
   * A appeler regulierement (une fois par seconde suffit). Fait respirer les
   * tables : minuteurs de decision, puis demarrage de la main suivante.
   */
  tick(now = Date.now()) {
    for (const [id, t] of this.tables) {
      const m = this.meta.get(id);
      if (t.state === 'showdown') {
        if (!m.nextHandAt) m.nextHandAt = now + this.betweenHandsMs;
        else if (now >= m.nextHandAt) { m.nextHandAt = 0; t.nextHand(now); this._after(id, now); }
        continue;
      }
      if (t.state === 'waiting') {
        m.nextHandAt = 0;
        if (t.ready().length >= 2) { t.maybeStart(now); this._after(id, now); }
        continue;
      }
      t.tick(now);
      this._after(id, now);
    }
  }

  // ------------------------------------------------------------------ interne

  /**
   * Vide la file d'evenements d'une table et en tire les consequences
   * financieres. Renvoie le total recredite pendant cet appel.
   */
  _after(tableId, now) {
    const t = this.tables.get(tableId);
    let rendu = this._drain(tableId, now);

    // deuxieme joueur arrive (ou revenu) : la main part immediatement
    if (t.state === 'waiting' && t.ready().length >= 2) {
      t.maybeStart(now);
      rendu += this._drain(tableId, now);
    }

    // filet de securite : un siege vide cote table ne doit plus figurer ici
    for (const [addr, v] of [...this.seatOf]) {
      if (v.tableId !== tableId) continue;
      const s = t.seats[v.seat];
      if (!s || s.addr !== addr) this.seatOf.delete(addr);
    }
    return rendu;
  }

  _drain(tableId, now) {
    const t = this.tables.get(tableId);
    const m = this.meta.get(tableId);
    let rendu = 0;

    for (const ev of t.drainEvents()) {
      if (ev.type === 'handEnd') {
        this.rakeCollected += ev.rake || 0;
        /* Ce que chaque siege a RECU sur cette main. On le rassemble avant de
           regler : un joueur peut toucher plusieurs pots (principal et
           lateraux), et ne compter que le premier ferait apparaitre du revenu
           que la maison n'a pas encaisse. */
        const recu = {};
        for (const r of ev.results || []) recu[r.seat] = (recu[r.seat] || 0) + (r.amount || 0);
        // ce qui a ete reellement engage compte comme mise
        for (const [seat, montant] of Object.entries(ev.contrib || {})) {
          const a = ev.addrs && ev.addrs[seat];
          if (!a) continue;
          this.game.pokerWager(a, montant);
          /* Et la main est REGLEE : classement du mois, revenu, usage. Sans
             cet appel, le poker restait invisible aux trois. */
          this.game.pokerManche(a, montant, recu[seat] || 0);
        }
        for (const r of ev.results || []) {
          const a = ev.addrs && ev.addrs[r.seat];
          if (a && r.amount > 0) this.game.pokerWin(a);
        }
        m.nextHandAt = now + this.betweenHandsMs;
      } else if (ev.type === 'leave' || ev.type === 'idleKick' || ev.type === 'busted') {
        // le siege est libere cote table : on rend les jetons au solde
        const at = [...this.seatOf.entries()].find(([, v]) => v.tableId === tableId && v.seat === ev.seat);
        if (ev.stack > 0 && ev.addr) rendu += this.game.pokerCashOut(ev.addr, ev.stack);
        // un depart en plein coup emet `leave` avant la liberation du siege :
        // on ne libere la place que si la table l'a vraiment rendue
        if (at && !t.seats[ev.seat]) this.seatOf.delete(at[0]);
      }
      this.onEvent(tableId, ev);
    }
    return rendu;
  }
}

module.exports = { PokerRoom, DEFAULT_TABLES };
