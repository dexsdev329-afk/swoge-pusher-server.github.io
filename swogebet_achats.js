'use strict';
/*
 * LES ACHATS DE $SWOGEBET, ANNONCES DANS LE CANAL.
 *
 * Le bot annonce deja les gains, les brulages et les mises en jeu — tout ce
 * qui se passe DANS le casino. Rien de ce qui se passe sur le marche. Un
 * achat de $SWOGEBET est pourtant l'evenement que le canal a le plus envie
 * de voir passer, et c'est le seul qui se lise directement sur la chaine.
 *
 * ---- CE QU'ON LIT, ET DANS QUEL SENS ----
 *
 * La piscine v3 emet un `Swap` par echange, avec deux montants SIGNES. Le
 * signe est tout : positif veut dire « entre dans la piscine », negatif
 * « en sort ». Un ACHAT de $SWOGEBET est donc un montant NEGATIF cote
 * $SWOGEBET — le jeton quitte la piscine pour aller chez l'acheteur.
 *
 * Lequel des deux montants est le $SWOGEBET ? On le DEMANDE a la piscine au
 * demarrage (`token0()`), on ne le suppose pas. Mesure du jour : token0 est
 * le $SWOGE et token1 le $SWOGEBET — mais une piscine deployee autrement
 * aurait l'ordre inverse, et une annonce qui confond achat et vente est pire
 * que pas d'annonce du tout. Tant que cette lecture n'a pas abouti, on
 * n'annonce rien.
 *
 * ---- ON DEMARRE A LA POINTE, PAS A ZERO ----
 *
 * Au premier lancement on part du bloc COURANT. Sinon le premier demarrage
 * — et chaque redemarrage sans etat — deverserait tout l'historique des
 * achats dans le canal d'un coup.
 *
 * ---- QUI A ACHETE ----
 *
 * `recipient` n'est pas toujours l'acheteur : quand l'achat vient de l'ETH,
 * le routeur fait les deux sauts et se designe lui-meme comme destinataire
 * du premier. On prend donc `from` de la transaction, qui est la personne
 * qui a signe. Une lecture de plus par evenement, et ils sont rares — une
 * vingtaine sur deux millions de blocs.
 *
 * ---- AUCUN CHIFFRE INVENTE ----
 *
 * L'annonce ne porte que ce que l'evenement contient : combien de $SWOGEBET
 * sont sortis, combien de $SWOGE sont entres. Pas de valeur en dollars : le
 * serveur n'a pas de source de prix, et en fabriquer une serait annoncer un
 * montant que personne n'a paye.
 */
const { ethers } = require('ethers');
const cfg = require('./config');
const tg = require('./telegram');

const POOL_V3 = '0xc12943975def537daCe9D62D4762a8250501924E';
const SWOGE    = '0x8a166fb41cd659a0a43396272ff73973ce29f817';
const SWOGEBET = '0xc0aed547862fba5d7d9fbf3cb14204cd756c8bea';

const POOL_ABI = [
  'function token0() view returns (address)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
];

const court = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '?');

/* Un montant lisible : entier tant qu'il tient, jamais abrege en « 1.2M ».
   Abreger cache la difference entre deux achats. */
function montant(bn) {
  const n = parseFloat(ethers.utils.formatEther(bn.isNegative() ? bn.mul(-1) : bn));
  if (!isFinite(n)) return '?';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1000 ? 2 : 0 });
}

class VeilleurAchats {
  constructor(opts) {
    opts = opts || {};
    this.provider = opts.provider
      || new ethers.providers.StaticJsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID);
    this.tg = opts.tg || tg;
    /* La piscine s'injecte : c'est ce qui permet a l'essai de rejouer un
       achat, une vente et une piscine INVERSEE sans reseau ni minuterie. Le
       sens de lecture est la seule chose qui puisse transformer une vente en
       bonne nouvelle — il faut pouvoir l'exercer. */
    this.pool = opts.pool || new ethers.Contract(POOL_V3, POOL_ABI, this.provider);
    this.iBet = null;              // 0 ou 1 : lequel des deux montants est le $SWOGEBET
    this.dernier = null;           // dernier bloc traite
    this.vus = new Set();          // transactions deja annoncees
    this.arrete = false;
    this.msMin = opts.msMin || cfg.SWOGEBET_POLL_MS || 45000;
    this.seuil = ethers.utils.parseEther(String(opts.seuil !== undefined ? opts.seuil
                                               : (cfg.SWOGEBET_BUY_MIN || '0')));
  }

  /* L'ordre des jetons se LIT. Sans lui, on ne sait pas distinguer un achat
     d'une vente, et on prefere se taire. */
  async ordre() {
    const t0 = (await this.pool.token0()).toLowerCase();
    if (t0 === SWOGEBET) this.iBet = 0;
    else if (t0 === SWOGE) this.iBet = 1;
    else throw new Error('la piscine ne contient pas le $SWOGEBET : token0=' + t0);
    return this.iBet;
  }

  /* Un evenement -> ce qu'on en dit, ou null si ce n'est pas un achat. */
  async lisAchat(ev) {
    const a = ev.args;
    const bet   = this.iBet === 0 ? a.amount0 : a.amount1;
    const swoge = this.iBet === 0 ? a.amount1 : a.amount0;
    /* Negatif = le jeton SORT de la piscine = quelqu'un l'a achete. */
    if (!bet.isNegative()) return null;
    const sorti = bet.mul(-1);
    if (this.seuil.gt(0) && sorti.lt(this.seuil)) return null;

    let acheteur = a.recipient;
    try {
      const tx = await this.provider.getTransaction(ev.transactionHash);
      if (tx && tx.from) acheteur = tx.from;
    } catch (e) { /* on garde le destinataire : c'est vrai, juste moins precis */ }

    return { bet: sorti, swoge, acheteur, tx: ev.transactionHash, bloc: ev.blockNumber };
  }

  legende(a) {
    const lien = cfg.EXPLORER
      ? `\n<a href="${String(cfg.EXPLORER).replace(/\/+$/, '')}/tx/${a.tx}">View the transaction</a>`
      : '';
    return `🎰 <b>New $SWOGEBET buy</b>\n`
         + `<b>${montant(a.bet)} $SWOGEBET</b> bought for `
         + `<b>${montant(a.swoge)} $SWOGE</b>\n`
         + `by ${court(a.acheteur)}${lien}`;
  }

  async annonce(a) {
    if (this.vus.has(a.tx)) return false;
    this.vus.add(a.tx);
    /* La memoire des transactions vues ne grandit pas sans fin. */
    if (this.vus.size > 500) this.vus = new Set(Array.from(this.vus).slice(-250));
    await this.tg.notifyPhoto(cfg.SWOGEBET_BUY_IMAGE || null, this.legende(a));
    return true;
  }

  /* Un tour de veille. Rendu a part pour que l'essai puisse l'appeler sans
     minuterie. */
  async tour() {
    if (this.iBet === null) await this.ordre();
    const tip = await this.provider.getBlockNumber();
    if (this.dernier === null) { this.dernier = tip + 1; return 0; }
    if (tip < this.dernier) return 0;
    const evs = await this.pool.queryFilter(this.pool.filters.Swap(), this.dernier, tip);
    this.dernier = tip + 1;
    let n = 0;
    for (const ev of evs) {
      const a = await this.lisAchat(ev);
      if (a && await this.annonce(a)) n++;
    }
    return n;
  }

  demarre() {
    const tic = async () => {
      if (this.arrete) return;
      try { await this.tour(); }
      catch (e) { console.warn('[swogebet] veille :', e.message); }
      if (!this.arrete) this.minuteur = setTimeout(tic, this.msMin);
    };
    tic();
    return this;
  }
  stop() { this.arrete = true; clearTimeout(this.minuteur); }
}

module.exports = { VeilleurAchats, POOL_V3, SWOGE, SWOGEBET };
