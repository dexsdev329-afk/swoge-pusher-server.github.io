'use strict';
/*
 * SWOGE Poker — machine a etats d'une table (Texas Hold'em No-Limit, 6 max).
 *
 * Comme poker.js, ce module ignore totalement le reseau. Le temps lui est
 * INJECTE (`now()`), jamais lu depuis l'horloge : c'est ce qui permet de tester
 * les minuteurs et l'exclusion pour inactivite de facon deterministe, sans
 * attendre une minute par test.
 *
 * Regles implementees :
 *  - bouton tournant, petite et grosse blinde ; en tete-a-tete le bouton EST la
 *    petite blinde et parle en premier avant le flop, en second ensuite
 *  - relance minimale = taille de la derniere relance, jamais moins que la BB
 *  - un tapis inferieur a une relance complete NE rouvre PAS les encheres
 *  - pots annexes calcules par poker.js
 *  - rake preleve seulement si le flop est vu ("no flop, no drop"), plafonne
 */

const P = require('./poker');

const STREETS = ['preflop', 'flop', 'turn', 'river'];

class PokerTable {
  constructor(opts = {}) {
    this.id = opts.id || 'T1';
    this.maxSeats = opts.maxSeats || 6;
    this.sb = opts.smallBlind || 1;
    this.bb = opts.bigBlind || 2;
    this.minBuyIn = opts.minBuyIn || this.bb * 20;
    this.maxBuyIn = opts.maxBuyIn || this.bb * 200;
    this.actionMs = opts.actionMs != null ? opts.actionMs : 60000;
    this.idleHandsLimit = opts.idleHandsLimit != null ? opts.idleHandsLimit : 5;
    this.rakeBps = opts.rakeBps != null ? opts.rakeBps : 500;   // 5 %
    this.rakeCap = opts.rakeCap != null ? opts.rakeCap : this.bb * 5;
    this.serverSeed = opts.serverSeed || 'seed';

    this.seats = new Array(this.maxSeats).fill(null);
    this.state = 'waiting';
    this.handNo = 0;
    this.button = -1;
    this.board = [];
    this.deck = [];
    this.deckAt = 0;
    this.currentSeat = -1;
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.actionDeadline = 0;
    this.lastResult = null;
    this.events = [];
  }

  // ------------------------------------------------------------- utilitaires

  occupied() { return this.seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0); }
  /** Sieges encore dans le coup (pas couches). */
  inHand() { return this.occupied().filter((i) => this.seats[i].inHand && !this.seats[i].folded); }
  /** Sieges pouvant encore miser (ni couches ni a tapis). */
  actionable() { return this.inHand().filter((i) => !this.seats[i].allIn); }
  /** Ce siege peut-il prendre la parole ? */
  canAct(i) {
    const s = i >= 0 ? this.seats[i] : null;
    return !!s && s.inHand && !s.folded && !s.allIn;
  }
  /** Joueurs prets a jouer la prochaine main. */
  ready() {
    return this.occupied().filter((i) => !this.seats[i].sittingOut && this.seats[i].stack > 0);
  }
  emit(type, data) { this.events.push(Object.assign({ type, handNo: this.handNo }, data || {})); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  nextOccupied(from, pred) {
    for (let k = 1; k <= this.maxSeats; k++) {
      const i = (from + k) % this.maxSeats;
      if (this.seats[i] && (!pred || pred(i))) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ sieges

  sit(seat, { addr, name, stack, avatar }) {
    if (seat < 0 || seat >= this.maxSeats) throw new Error('invalid seat');
    if (this.seats[seat]) throw new Error('seat taken');
    if (this.occupied().some((i) => this.seats[i].addr === addr)) throw new Error('already seated');
    if (stack < this.minBuyIn) throw new Error('buy-in below minimum');
    if (stack > this.maxBuyIn) throw new Error('buy-in above maximum');
    this.seats[seat] = {
      addr, name: name || addr.slice(0, 6), avatar: avatar || 0,
      stack, committed: 0, totalCommitted: 0, cards: [],
      folded: false, allIn: false, hasActed: false, inHand: false,
      sittingOut: false, idleHands: 0, actedThisHand: false,
    };
    this.emit('sit', { seat, addr, name: this.seats[seat].name, stack });
    return this.seats[seat];
  }

  /**
   * Quitte la table. Renvoie le tapis a recrediter TOUT DE SUITE.
   *
   * En plein coup, le siege n'est pas libere sur-le-champ : ses jetons deja
   * engages appartiennent au pot, et les retirer de la table les ferait
   * disparaitre. Le joueur est couche, son tapis lui est rendu, et le siege
   * est libere a la fin de la main. S'il est deja a tapis, sa main reste
   * vivante jusqu'a l'abattage (regle du poker) : le tapis part alors avec
   * l'evenement `leave` emis en fin de main.
   */
  leave(seat, now = 0) {
    const s = this.seats[seat];
    if (!s) return null;
    const enMain = this.state !== 'waiting' && this.state !== 'showdown';
    const vivant = enMain && s.inHand && !s.folded;

    if (vivant && s.allIn) {
      s.leaving = true;
      s.sittingOut = true;
      return 0;                       // credite plus tard, a l'abattage
    }

    const stack = s.stack;
    // On garde le siege tant que la main dure des que le joueur a mis des
    // jetons au pot — meme s'il s'est deja couche. Liberer le siege tout de
    // suite ferait disparaitre sa mise du pot.
    if (enMain && (vivant || s.totalCommitted > 0)) {
      if (vivant) {
        s.folded = true;
        s.hasActed = true;
        this.emit('action', { seat, action: 'fold' });
      }
      s.stack = 0;
      s.leaving = true;
      s.sittingOut = true;
      this.emit('leave', { seat, addr: s.addr, stack });
      if (this.inHand().length <= 1) this.finishHand(now);
      else if (vivant && this.currentSeat === seat) this.advance(now);
      return stack;
    }

    this.seats[seat] = null;
    this.emit('leave', { seat, addr: s.addr, stack });
    return stack;
  }

  // ------------------------------------------------------------- deroulement

  /** Demarre une main si au moins deux joueurs sont prets. */
  maybeStart(now = 0) {
    if (this.state !== 'waiting') return false;
    if (this.ready().length < 2) return false;
    this.startHand(now);
    return true;
  }

  startHand(now = 0) {
    const players = this.ready();
    this.handNo++;
    this.board = [];
    this.deckAt = 0;
    this.deck = P.shuffledDeck(this.serverSeed, this.id, this.handNo);
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.lastResult = null;

    for (const i of this.occupied()) {
      const s = this.seats[i];
      s.committed = 0; s.totalCommitted = 0; s.cards = [];
      s.folded = false; s.allIn = false; s.hasActed = false; s.actedThisHand = false;
      s.inHand = players.includes(i);
    }

    this.button = this.button < 0 ? players[0] : this.nextOccupied(this.button, (i) => players.includes(i));

    const heads = players.length === 2;
    // tete-a-tete : le bouton est la petite blinde
    const sbSeat = heads ? this.button : this.nextOccupied(this.button, (i) => players.includes(i));
    const bbSeat = this.nextOccupied(sbSeat, (i) => players.includes(i));

    this.postBlind(sbSeat, this.sb);
    this.postBlind(bbSeat, this.bb);
    this.currentBet = this.bb;
    this.minRaise = this.bb;

    for (const i of players) {
      this.seats[i].cards = [this.deck[this.deckAt++], this.deck[this.deckAt++]];
    }

    this.state = 'preflop';
    // preflop : le premier a parler est a gauche de la BB (le bouton en tete-a-tete).
    // Un joueur dont toute la cave est partie dans la blinde est deja a tapis :
    // il faut passer au suivant, sinon la table reste bloquee sur lui.
    const premier = heads ? this.button : this.nextOccupied(bbSeat, (i) => players.includes(i));
    this.currentSeat = this.canAct(premier) ? premier
      : this.nextOccupied(premier, (i) => this.canAct(i));
    this.sbSeat = sbSeat; this.bbSeat = bbSeat;
    this.setDeadline(now);
    this.emit('handStart', { button: this.button, sbSeat, bbSeat, players: players.slice() });

    // plus personne ne peut miser : on deroule le tableau jusqu'a l'abattage
    if (this.currentSeat < 0 ||
        (this.actionable().length === 1 && this.toCall(this.currentSeat) === 0)) {
      this.nextStreet(now);
    }
  }

  postBlind(seat, amount) {
    const s = this.seats[seat];
    const put = Math.min(amount, s.stack);
    s.stack -= put; s.committed += put; s.totalCommitted += put;
    if (s.stack === 0) s.allIn = true;
    this.emit('blind', { seat, amount: put });
  }

  setDeadline(now) { this.actionDeadline = this.actionMs > 0 ? now + this.actionMs : 0; }

  /** Montant a payer pour suivre, depuis ce siege. */
  toCall(seat) {
    const s = this.seats[seat];
    return Math.max(0, Math.min(this.currentBet - s.committed, s.stack));
  }

  /** Actions permises, telles que le client doit les afficher. */
  legalActions(seat) {
    if (this.currentSeat !== seat || this.state === 'waiting' || this.state === 'showdown') return [];
    const s = this.seats[seat];
    if (!s || s.folded || s.allIn) return [];
    const call = this.toCall(seat);
    const acts = ['fold'];
    if (call === 0) acts.push('check');
    else acts.push('call');
    // relancer suppose de pouvoir depasser la mise courante. C'est une RELANCE
    // des qu'une mise existe deja — la grosse blinde qui exerce son option ne
    // "mise" pas, elle relance, meme si elle n'a rien a payer.
    if (s.stack > call) acts.push(this.currentBet > 0 ? 'raise' : 'bet');
    acts.push('allin');
    return acts;
  }

  /** Relance minimale totale (mise cumulee sur la street) depuis ce siege. */
  minRaiseTo(seat) {
    return this.currentBet + this.minRaise;
  }

  /**
   * Joue une action. `amount` est la mise TOTALE visee sur la street pour
   * bet/raise (pas l'increment), ignoree pour les autres.
   */
  act(seat, action, amount = 0, now = 0) {
    if (this.state === 'waiting' || this.state === 'showdown') throw new Error('no hand in progress');
    if (seat !== this.currentSeat) throw new Error('not your turn');
    const s = this.seats[seat];
    if (!s || s.folded || s.allIn) throw new Error('cannot act');

    const call = this.toCall(seat);

    if (action === 'fold') {
      s.folded = true;
      this.emit('action', { seat, action: 'fold' });
    } else if (action === 'check') {
      if (call > 0) throw new Error('cannot check, there is a bet');
      this.emit('action', { seat, action: 'check' });
    } else if (action === 'call') {
      if (call === 0) throw new Error('nothing to call');
      this.put(seat, call);
      this.emit('action', { seat, action: 'call', amount: call });
    } else if (action === 'bet' || action === 'raise') {
      const target = Math.floor(amount);
      const allInTotal = s.committed + s.stack;
      if (target >= allInTotal) return this.act(seat, 'allin', 0, now);
      const min = this.minRaiseTo(seat);
      if (target < min) throw new Error(`raise to at least ${min}`);
      const inc = target - s.committed;
      this.put(seat, inc);
      this.minRaise = target - this.currentBet;
      this.currentBet = target;
      this.reopen(seat);
      this.emit('action', { seat, action, to: target });
    } else if (action === 'allin') {
      const inc = s.stack;
      const total = s.committed + inc;
      this.put(seat, inc);
      if (total > this.currentBet) {
        const raiseBy = total - this.currentBet;
        // un tapis inferieur a une relance complete ne rouvre pas les encheres
        if (raiseBy >= this.minRaise) { this.minRaise = raiseBy; this.reopen(seat); }
        this.currentBet = total;
      }
      this.emit('action', { seat, action: 'allin', to: total });
    } else {
      throw new Error('unknown action');
    }

    s.hasActed = true;
    // une action forcee par le minuteur ne compte pas comme une action du joueur
    if (!s.forced) s.actedThisHand = true;
    this.advance(now);
    return this.snapshot();
  }

  put(seat, amount) {
    const s = this.seats[seat];
    const put = Math.min(amount, s.stack);
    s.stack -= put; s.committed += put; s.totalCommitted += put;
    if (s.stack === 0) s.allIn = true;
  }

  /** Une relance complete redonne la parole a tous les autres. */
  reopen(exceptSeat) {
    for (const i of this.actionable()) if (i !== exceptSeat) this.seats[i].hasActed = false;
  }

  /** Le tour d'encheres est-il termine ? */
  roundComplete() {
    const live = this.actionable();
    if (this.inHand().length <= 1) return true;
    if (live.length === 0) return true;
    return live.every((i) => this.seats[i].hasActed && this.seats[i].committed === this.currentBet);
  }

  advance(now) {
    if (this.inHand().length <= 1) return this.finishHand(now);
    if (!this.roundComplete()) {
      const next = this.nextOccupied(this.currentSeat, (i) =>
        this.seats[i].inHand && !this.seats[i].folded && !this.seats[i].allIn &&
        !(this.seats[i].hasActed && this.seats[i].committed === this.currentBet));
      if (next >= 0) { this.currentSeat = next; this.setDeadline(now); return; }
    }
    this.nextStreet(now);
  }

  nextStreet(now) {
    for (const i of this.occupied()) { this.seats[i].committed = 0; this.seats[i].hasActed = false; }
    this.currentBet = 0;
    this.minRaise = this.bb;

    const idx = STREETS.indexOf(this.state);
    if (idx < 0 || idx === STREETS.length - 1) return this.finishHand(now);

    this.state = STREETS[idx + 1];
    this.deckAt++;                                     // brulee
    const draw = this.state === 'flop' ? 3 : 1;
    for (let k = 0; k < draw; k++) this.board.push(this.deck[this.deckAt++]);
    this.emit('street', { street: this.state, board: this.board.slice() });

    // plus personne ne peut miser : on deroule le tableau jusqu'a l'abattage
    if (this.actionable().length <= 1) {
      const stillOwing = this.actionable().filter((i) => this.toCall(i) > 0);
      if (stillOwing.length === 0) return this.nextStreet(now);
    }
    this.currentSeat = this.nextOccupied(this.button, (i) =>
      this.seats[i].inHand && !this.seats[i].folded && !this.seats[i].allIn);
    if (this.currentSeat < 0) return this.nextStreet(now);
    this.setDeadline(now);
  }

  // ------------------------------------------------------------- fin de main

  finishHand(now) {
    const contrib = {};
    for (const i of this.occupied()) if (this.seats[i].totalCommitted > 0) contrib[i] = this.seats[i].totalCommitted;

    // Remboursement de la mise non suivie. Si un seul joueur a engage plus que
    // tous les autres, le surplus n'a jamais ete paye par personne : il lui
    // revient tel quel, avant tout calcul de pot et SANS rake.
    let refund = null;
    const montants = Object.values(contrib);
    if (montants.length > 1) {
      const tri = montants.slice().sort((a, b) => b - a);
      if (tri[0] > tri[1]) {
        const top = Number(Object.keys(contrib).find((k) => contrib[k] === tri[0]));
        const rendu = tri[0] - tri[1];
        this.seats[top].stack += rendu;
        this.seats[top].totalCommitted -= rendu;
        contrib[top] -= rendu;
        refund = { seat: top, amount: rendu };
        this.emit('refund', refund);
      }
    }

    const alive = this.inHand();
    const potTotal = Object.values(contrib).reduce((a, b) => a + b, 0);
    let sawFlop = this.board.length > 0;
    const pots = P.buildPots(contrib, alive);
    const results = [];
    let rakeTotal = 0;

    for (const pot of pots) {
      let amount = pot.amount;
      if (sawFlop && this.rakeBps > 0) {
        const rake = Math.min(Math.floor(amount * this.rakeBps / 10000), this.rakeCap - rakeTotal);
        if (rake > 0) { amount -= rake; rakeTotal += rake; }
      }
      const cands = pot.eligible.length ? pot.eligible : alive;
      let best = -1, winners = [];
      if (cands.length === 1) {
        winners = cands.slice();
      } else {
        for (const i of cands) {
          const sc = P.evaluate(this.seats[i].cards.concat(this.board));
          if (sc > best) { best = sc; winners = [i]; }
          else if (sc === best) winners.push(i);
        }
      }
      const share = Math.floor(amount / winners.length);
      let rest = amount - share * winners.length;
      for (const w of winners) {
        // l'eventuel reste va au premier joueur a gauche du bouton
        let extra = 0;
        if (rest > 0) { extra = 1; rest--; }
        this.seats[w].stack += share + extra;
        results.push({ seat: w, amount: share + extra, hand: best >= 0 ? P.handName(best) : null });
      }
    }

    // compteur d'inactivite : une main sans action volontaire compte
    for (const i of this.occupied()) {
      const s = this.seats[i];
      if (!s.inHand) continue;
      if (s.actedThisHand) s.idleHands = 0;
      else s.idleHands++;
    }

    this.lastResult = {
      handNo: this.handNo, board: this.board.slice(), pot: potTotal,
      pots, results, rake: rakeTotal, refund,
      // ce que chaque siege a reellement engage (apres remboursement) : c'est
      // ca, et pas la cave, qui compte comme une mise cote comptabilite
      contrib: Object.assign({}, contrib),
      addrs: Object.fromEntries(this.occupied().map((i) => [i, this.seats[i].addr])),
      shown: alive.length > 1
        ? alive.map((i) => ({ seat: i, cards: this.seats[i].cards.slice() }))
        : [],
    };
    this.emit('handEnd', this.lastResult);

    this.state = 'showdown';
    this.currentSeat = -1;
    this.actionDeadline = 0;

    // les jetons sont retournes dans les tapis : la table ne doit plus rien
    for (const i of this.occupied()) { this.seats[i].committed = 0; this.seats[i].totalCommitted = 0; }

    // liberation des sieges : partants, inactifs, puis tapis vides
    for (const i of this.occupied()) {
      const s = this.seats[i];
      if (s.leaving) {
        this.emit('leave', { seat: i, addr: s.addr, stack: s.stack });
        this.seats[i] = null;
      } else if (this.idleHandsLimit > 0 && s.idleHands >= this.idleHandsLimit) {
        this.emit('idleKick', { seat: i, addr: s.addr, stack: s.stack });
        this.seats[i] = null;
      } else if (s.stack <= 0) {
        this.emit('busted', { seat: i, addr: s.addr, stack: 0 });
        this.seats[i] = null;
      }
    }
    return this.lastResult;
  }

  /** A appeler entre deux mains pour repartir. */
  nextHand(now = 0) {
    if (this.state !== 'showdown') return false;
    this.state = 'waiting';
    for (const i of this.occupied()) this.seats[i].inHand = false;
    return this.maybeStart(now);
  }

  // --------------------------------------------------------------- minuteurs

  /**
   * Fait avancer le temps. Si le joueur au trait a depasse son delai, on
   * checke quand c'est gratuit et on couche sinon — coucher une main qu'on
   * pouvait voir gratuitement penaliserait le joueur sans raison.
   */
  tick(now) {
    if (this.state === 'waiting' || this.state === 'showdown') return null;
    if (!this.actionDeadline || now < this.actionDeadline) return null;
    const seat = this.currentSeat;
    if (seat < 0) return null;
    const auto = this.toCall(seat) === 0 ? 'check' : 'fold';
    this.emit('timeout', { seat, auto });
    const s = this.seats[seat];
    // le drapeau doit etre pose AVANT act() : si cette action termine la main,
    // le comptage d'inactivite a lieu a l'interieur de act().
    if (s) s.forced = true;
    try { this.act(seat, auto, 0, now); }
    finally { if (s) s.forced = false; }
    return auto;
  }

  // ----------------------------------------------------------------- lecture

  /** Etat public. `forSeat` reçoit ses propres cartes, jamais celles des autres. */
  snapshot(forSeat = -1) {
    const shown = this.lastResult && this.lastResult.shown ? this.lastResult.shown : [];
    return {
      id: this.id, state: this.state, handNo: this.handNo, board: this.board.slice(),
      button: this.button, currentSeat: this.currentSeat, currentBet: this.currentBet,
      minRaiseTo: this.currentSeat >= 0 ? this.minRaiseTo(this.currentSeat) : 0,
      sb: this.sb, bb: this.bb, actionDeadline: this.actionDeadline,
      sbSeat: this.sbSeat != null ? this.sbSeat : -1,
      bbSeat: this.bbSeat != null ? this.bbSeat : -1,
      actionMs: this.actionMs,
      pot: this.state === 'showdown' && this.lastResult ? this.lastResult.pot
        : this.occupied().reduce((t, i) => t + this.seats[i].totalCommitted, 0),
      legal: forSeat >= 0 ? this.legalActions(forSeat) : [],
      toCall: forSeat >= 0 && this.seats[forSeat] ? this.toCall(forSeat) : 0,
      seats: this.seats.map((s, i) => {
        if (!s) return null;
        const reveal = i === forSeat || shown.some((x) => x.seat === i);
        return {
          seat: i, name: s.name, avatar: s.avatar, stack: s.stack,
          committed: s.committed, folded: s.folded, allIn: s.allIn,
          inHand: s.inHand, sittingOut: s.sittingOut,
          cards: reveal ? s.cards.slice() : (s.inHand && !s.folded ? [-1, -1] : []),
        };
      }),
      lastResult: this.lastResult,
    };
  }
}

module.exports = { PokerTable, STREETS };
