'use strict';
/*
 * LE VEILLEUR DES ACHATS DE $SWOGEBET.
 *
 * Ce qu'il annonce part dans un canal public, donc les deux facons de se
 * tromper coutent cher et sont opposees :
 *
 *   - annoncer une VENTE comme un achat. Le signe du montant est tout, et
 *     l'ordre des jetons dans la piscine decide quel montant regarder. Si
 *     quelqu'un deploie un jour la piscine dans l'autre sens et qu'on a
 *     suppose l'ordre au lieu de le lire, chaque vente devient une bonne
 *     nouvelle. L'essai monte donc une piscine INVERSEE et verifie que le
 *     sens suit.
 *
 *   - deverser l'historique. Au demarrage, on part de la pointe : sinon le
 *     premier lancement — et chaque redemarrage — remet vingt achats d'un
 *     coup dans le canal.
 *
 * Tout se joue sur une fausse chaine : pas de reseau, pas de minuterie.
 */
const { ethers } = require('ethers');
const { VeilleurAchats, SWOGE, SWOGEBET } = require('./swogebet_achats');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const E = (x) => ethers.utils.parseEther(String(x));

/* Une fausse chaine : elle rend les evenements qu'on lui donne, et note ce
   qu'on lui demande. */
function fausseChaine(opts) {
  const evs = opts.evs || [];
  return {
    tip: opts.tip || 1000,
    getBlockNumber() { return Promise.resolve(this.tip); },
    getTransaction(h) {
      const t = (opts.txs || {})[h];
      return Promise.resolve(t ? { from: t } : null);
    },
    /* `queryFilter` passe par le contrat ; on remplace le contrat entier. */
    _evs: evs,
  };
}
function contrat(chaine, token0) {
  return {
    token0: () => Promise.resolve(token0),
    filters: { Swap: () => ({}) },
    queryFilter: (f, de, a) => Promise.resolve(
      chaine._evs.filter((e) => e.blockNumber >= de && e.blockNumber <= a)),
  };
}
function evSwap(bloc, a0, a1, tx, recipient) {
  return { blockNumber: bloc, transactionHash: tx,
           args: { amount0: a0, amount1: a1, recipient: recipient || '0x1111111111111111111111111111111111111111' } };
}
function fauxTg() {
  return { envois: [], notifyPhoto(p, c) { this.envois.push({ photo: p, texte: c }); return Promise.resolve(); } };
}

(async () => {
  /* ---- 1. L'ORDRE DES JETONS SE LIT ---- */
  console.log('-- quel montant est le $SWOGEBET --');
  {
    const c = fausseChaine({});
    const v = new VeilleurAchats({ provider: c, tg: fauxTg(), pool: contrat(c, SWOGE) });
    ok(await v.ordre() === 1, 'piscine normale (token0 = $SWOGE) : le $SWOGEBET est le montant 1');

    const c2 = fausseChaine({});
    const v2 = new VeilleurAchats({ provider: c2, tg: fauxTg(), pool: contrat(c2, SWOGEBET) });
    ok(await v2.ordre() === 0, 'piscine inversee (token0 = $SWOGEBET) : c est le montant 0');

    const c3 = fausseChaine({});
    const v3 = new VeilleurAchats({ provider: c3, tg: fauxTg(), pool: contrat(c3, '0x000000000000000000000000000000000000dead') });
    let leve = false;
    try { await v3.ordre(); } catch (e) { leve = true; }
    ok(leve, 'et une piscine qui ne contient pas le jeton fait ECHOUER la lecture :'
       + ' on prefere se taire que deviner le sens');
  }

  /* ---- 2. UN ACHAT EST ANNONCE, UNE VENTE NE L EST PAS ---- */
  console.log('\n-- achat ou vente --');
  {
    const tg = fauxTg();
    const c = fausseChaine({ tip: 2000, txs: { '0xaa': '0xAcHeTeUr000000000000000000000000000000aa' },
      /* montant1 NEGATIF = le $SWOGEBET sort de la piscine = achat */
      evs: [ evSwap(1500, E(100), E(-250), '0xaa'),
             /* montant1 POSITIF = il entre = vente */
             evSwap(1501, E(-90), E(250), '0xbb') ] });
    const v = new VeilleurAchats({ provider: c, tg, pool: contrat(c, SWOGE) });
    await v.ordre();
    v.dernier = 1000;
    const combien = await v.tour();
    ok(combien === 1, 'un achat et une vente : UN seul est annonce (' + combien + ')');
    ok(/New \$SWOGEBET buy/.test(tg.envois[0].texte), 'et c est bien annonce comme un achat');
    ok(/250 \$SWOGEBET/.test(tg.envois[0].texte),
       'avec ce qui est SORTI de la piscine : '
       + ((/([\d,.]+) \$SWOGEBET/.exec(tg.envois[0].texte) || [])[1] || '(rien lu)'));
    ok(/100 \$SWOGE\b/.test(tg.envois[0].texte), 'et ce qui y est entre en $SWOGE');
    ok(tg.envois.length === 1, 'la vente ne dit rien du tout');
  }

  /* ---- 3. LA PISCINE INVERSEE INVERSE AUSSI LE SENS ---- */
  console.log('\n-- si la piscine etait montee dans l autre sens --');
  {
    const tg = fauxTg();
    /* Memes evenements, piscine inversee : c est maintenant le montant 0 qui
       porte le $SWOGEBET, donc l ACHAT est l autre ligne. */
    const c = fausseChaine({ tip: 2000,
      evs: [ evSwap(1500, E(100), E(-250), '0xaa'),
             evSwap(1501, E(-90), E(250), '0xbb') ] });
    const v = new VeilleurAchats({ provider: c, tg, pool: contrat(c, SWOGEBET) });
    await v.ordre();
    v.dernier = 1000;
    await v.tour();
    ok(tg.envois.length === 1 && /90 \$SWOGEBET/.test(tg.envois[0].texte),
       'l autre echange devient l achat — le sens SUIT l ordre lu, il n est pas fige');
  }

  /* ---- 4. ON DEMARRE A LA POINTE ---- */
  console.log('\n-- le premier tour ne deverse pas l historique --');
  {
    const tg = fauxTg();
    const c = fausseChaine({ tip: 2000,
      evs: [ evSwap(10, E(1), E(-2), '0x01'), evSwap(900, E(1), E(-2), '0x02'),
             evSwap(1999, E(1), E(-2), '0x03') ] });
    const v = new VeilleurAchats({ provider: c, tg, pool: contrat(c, SWOGE) });
    const premier = await v.tour();
    ok(premier === 0 && tg.envois.length === 0,
       'le premier tour n annonce RIEN : il se cale sur la pointe (' + premier + ')');
    ok(v.dernier === 2001, 'et il repart du bloc suivant (' + v.dernier + ')');
    c.tip = 2002;
    c._evs.push(evSwap(2001, E(5), E(-9), '0x04'));
    await v.tour();
    ok(tg.envois.length === 1, 'seul ce qui arrive ENSUITE est annonce');
  }

  /* ---- 5. LE MEME ACHAT N EST PAS ANNONCE DEUX FOIS ---- */
  console.log('\n-- deux fois le meme --');
  {
    const tg = fauxTg();
    const c = fausseChaine({ tip: 2000, evs: [ evSwap(1500, E(1), E(-2), '0xaa') ] });
    const v = new VeilleurAchats({ provider: c, tg, pool: contrat(c, SWOGE) });
    await v.ordre();
    v.dernier = 1000; await v.tour();
    v.dernier = 1000; await v.tour();       // on rejoue la meme fenetre
    ok(tg.envois.length === 1,
       'un chevauchement de fenetres ne double pas l annonce (' + tg.envois.length + ')');
  }

  /* ---- 6. L ACHETEUR EST CELUI QUI A SIGNE ---- */
  console.log('\n-- qui a achete --');
  {
    const ROUTEUR = '0xcaf681a66d020601342297493863e78c959e5cb2';
    const VRAI = '0xD1ca000000000000000000000000000000009999';
    const tg = fauxTg();
    const c = fausseChaine({ tip: 2000, txs: { '0xaa': VRAI },
      evs: [ evSwap(1500, E(1), E(-2), '0xaa', ROUTEUR) ] });
    const v = new VeilleurAchats({ provider: c, tg, pool: contrat(c, SWOGE) });
    await v.ordre(); v.dernier = 1000; await v.tour();
    ok(tg.envois[0].texte.indexOf('0xD1ca') >= 0,
       'quand l achat vient de l ETH, le destinataire est le ROUTEUR : on nomme'
       + ' celui qui a signe la transaction');
    ok(tg.envois[0].texte.indexOf('0xcaf6') < 0, 'et jamais le routeur');
  }

  /* ---- 7. QUAND LA TRANSACTION NE SE LIT PAS, ON GARDE CE QU ON SAIT ---- */
  console.log('\n-- si la transaction ne se lit pas --');
  {
    const tg = fauxTg();
    const DEST = '0xbEEf000000000000000000000000000000001234';
    const c = fausseChaine({ tip: 2000, evs: [ evSwap(1500, E(1), E(-2), '0xzz', DEST) ] });
    c.getTransaction = () => Promise.reject(new Error('rpc muet'));
    const v = new VeilleurAchats({ provider: c, tg, pool: contrat(c, SWOGE) });
    await v.ordre(); v.dernier = 1000; await v.tour();
    ok(tg.envois.length === 1 && tg.envois[0].texte.indexOf('0xbEEf') >= 0,
       'on retombe sur le destinataire — moins precis, mais VRAI — plutot que de'
       + ' perdre l annonce');
  }

  /* ---- 8. LE SEUIL ---- */
  console.log('\n-- le seuil, quand il est pose --');
  {
    const tg = fauxTg();
    const c = fausseChaine({ tip: 2000,
      evs: [ evSwap(1500, E(1), E(-2), '0xaa'), evSwap(1501, E(1), E(-5000), '0xbb') ] });
    const v = new VeilleurAchats({ provider: c, tg, seuil: 1000, pool: contrat(c, SWOGE) });
    await v.ordre(); v.dernier = 1000; await v.tour();
    ok(tg.envois.length === 1 && /5,000 \$SWOGEBET/.test(tg.envois[0].texte),
       'sous le seuil, rien ; au-dessus, l annonce part');
  }

  /* ---- 9. AUCUN CHIFFRE INVENTE ---- */
  console.log('\n-- ce que l annonce n affirme pas --');
  {
    const tg = fauxTg();
    const c = fausseChaine({ tip: 2000, evs: [ evSwap(1500, E(100), E(-250), '0xaa') ] });
    const v = new VeilleurAchats({ provider: c, tg, pool: contrat(c, SWOGE) });
    await v.ordre(); v.dernier = 1000; await v.tour();
    ok(!/\$\d|USD|usd/.test(tg.envois[0].texte.replace(/\$SWOGE(BET)?/g, '')),
       'aucune valeur en dollars : le serveur n a pas de source de prix, et un'
       + ' montant fabrique serait un montant que personne n a paye');
    ok(!/\d\.\dk|\d\.\d\dM/.test(tg.envois[0].texte),
       'et aucun montant abrege — « 1.2M » cache la difference entre deux achats');
  }

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
  process.exit(rates ? 1 : 0);
})();
