'use strict';
/*
 * Arriver depuis une autre chaine, sans quitter le site.
 *
 * ---- ce que ce fichier resout ----
 *
 * Le joueur tient du SOL, du BTC, de l'USDT sur TRON. Le casino tourne sur
 * Robinhood Chain. Entre les deux il manquait un pont, et la premiere reponse
 * — trois adresses de depot a nous, une par chaine, et une conversion au prix
 * du marche — etait la mauvaise : elle nous faisait detenir l'argent des
 * joueurs, et elle prenait le prix dans une reserve de deux ETH ou 188 $
 * d'achat deplacent le cours de 10 %. N'importe qui pouvait faire tomber ce
 * prix pour deux cents dollars, deposer, et racheter.
 *
 * Relay fait le trajet sans que rien ne passe par nous. Il rend une ADRESSE DE
 * DEPOT : le joueur y envoie ses SOL — depuis son portefeuille ou depuis son
 * compte d'echange, sans rien connecter — et l'ETH arrive a SON adresse sur
 * Robinhood Chain. Nous ne touchons jamais les fonds.
 *
 * ---- pourquoi ca passe par le serveur ----
 *
 * L'adresse de depot demande une cle d'integrateur. Une cle posee dans
 * swogebuy.js serait publique au premier « voir la source ». Le serveur
 * appelle Relay a la place du navigateur et ne rend que l'adresse. La cle ne
 * quitte pas la machine.
 *
 * ---- ce qui est verrouille ----
 *
 * La route est ouverte a tous — il le faut, un joueur qui n'a pas encore un
 * jeton doit pouvoir s'en servir. Elle est donc etroite :
 *
 *   • la chaine et le jeton de depart viennent d'une LISTE FERMEE. Sans elle,
 *     n'importe qui userait notre cle pour ses propres transferts ;
 *   • la destination est toujours de l'ETH natif sur Robinhood Chain, jamais
 *     ce que demande l'appelant ;
 *   • le montant est borne des deux cotes : trop petit, les frais mangent
 *     tout ; trop grand, c'est une faute de frappe ;
 *   • rien de ce que Relay repond n'est renvoye tel quel. On recopie les
 *     quelques champs utiles, ce qui evite de reexpedier un jour un detail
 *     qu'on n'a pas lu.
 */
const cfg = require('./config');

const RH = 4663;
const NATIF = '0x0000000000000000000000000000000000000000';

/* Les provenances qu'on accepte. Chacune a ete cotee pour de vrai avant
   d'entrer ici — une route qui n'existe pas ferait un bouton qui echoue.
   Le TRX natif n'en a pas ; l'USDT sur TRON, si, et c'est ce que detiennent
   la plupart des porteurs TRON. */
/* `repere` : l'adresse de la MONNAIE NATIVE de la chaine de depart.
 *
 * ---- ce qu'elle repare, et ce que ca a coute de le savoir ----
 *
 * En production, le pont marchait depuis Ethereum et Base et echouait depuis
 * Solana et TRON : « Invalid address 0x2ee6… for chain 792703809 » — le refus
 * parlait de l'adresse du JOUEUR, valide, jugee contre la chaine de DEPART.
 *
 * La regle, etablie par quatre appels a l'API et non par lecture de la
 * documentation, qui dit le contraire :
 *
 *   1. `user` est OBLIGATOIRE — sans lui : « body must have required property
 *      'user' ». L'omettre n'est donc pas une option ;
 *   2. `user` est valide contre la chaine d'ORIGINE, alors que la
 *      documentation le decrit comme « le portefeuille destinataire sur la
 *      chaine de destination » ;
 *   3. `refundTo` n'y change rien : le refus tombe pareil.
 *
 * Ce qui marche : `user` = une adresse valide sur la chaine de depart, et
 * `recipient` = le joueur. Comme personne n'a de portefeuille connecte du cote
 * depart — c'est tout l'interet d'une adresse de depot — on y met le repere de
 * la monnaie native, que la documentation autorise explicitement (« n'importe
 * quelle adresse valide, y compris l'adresse nulle »). Verifie : Relay rend
 * bien le joueur comme destinataire.
 *
 * Pour TRON c'est le repere du TRX, meme si l'on envoie de l'USDT : c'est la
 * chaine qui decide, pas le jeton. */
/* DEUX PROVENANCES, ET C'EST VOULU. Vingt-quatre chaines ont une route vers
   Robinhood Chain — Base, Arbitrum, Optimism et vingt autres — mais chaque
   tuile de plus dilue celles qui servent vraiment. Ethereum couvre ceux qui
   tiennent leur ETH sur le reseau principal, Solana ceux qui n'en ont pas du
   tout. Le reste s'ajoute en une ligne le jour ou quelqu'un le demande.
 *
   CE QUI NE PEUT PAS Y ETRE, ET POURQUOI. Chaque ligne a rendu une vraie
   adresse de depot sur la production ; les deux qui manquent ont ete retirees
   parce qu'elles ne le pouvaient pas :
 *
     • le BITCOIN : aucune route vers Robinhood Chain, a aucun montant —
       0,002, 0,01, 0,05 et 0,2 BTC essayes, tous « no routes found » ;
     • le TRON : « Zero-address refundTo is only supported for EVM/BVM/SVM
       deposit-address refunds ». Le repere de repli qui marche pour Solana et
       les chaines EVM n'est pas accepte pour une machine virtuelle TRON, et
       nous n'avons pas d'adresse TRON du joueur a mettre a la place — il n'a
       rien connecte de ce cote, c'est tout l'interet d'une adresse de depot.
 *
   Un bouton qui echoue toujours est pire que pas de bouton : le joueur croit
   que c'est lui qui s'y prend mal. */
const DEPUIS = {
  sol:  { chaine: 792703809, jeton: '11111111111111111111111111111111',
          repere: '11111111111111111111111111111111',
          symbole: 'SOL', decimales: 9, min: 0.01, max: 1000 },
  eth:  { chaine: 1,         jeton: NATIF, repere: NATIF,
          symbole: 'ETH', decimales: 18, min: 0.001, max: 100 },
};

const actif = () => !!cfg.RELAY_API_KEY;
const provenances = () => Object.keys(DEPUIS).map((k) => ({
  cle: k, symbole: DEPUIS[k].symbole, min: DEPUIS[k].min, max: DEPUIS[k].max,
}));

/** Le montant en plus petite unite, sans passer par les flottants au-dela du
 *  raisonnable : un montant saisi a la main n'a jamais dix-huit decimales. */
function enUnites(montant, decimales) {
  const s = String(montant).replace(',', '.').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [ent, dec = ''] = s.split('.');
  if (dec.length > decimales) return null;
  const brut = (ent + dec.padEnd(decimales, '0')).replace(/^0+(?=\d)/, '');
  return brut || '0';
}

async function appelle(chemin, corps) {
  const r = await fetch(cfg.RELAY_API + chemin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.RELAY_API_KEY },
    body: JSON.stringify(corps),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) {
    const m = (j && (j.message || j.error)) || t.slice(0, 200);
    const e = new Error(m);
    e.statut = r.status;
    throw e;
  }
  return j;
}

/**
 * L'adresse ou le joueur envoie ses fonds.
 *
 * @param {string} cle       une provenance de la liste fermee
 * @param {string} vers      l'adresse du joueur sur Robinhood Chain
 * @param {string} montant   ce qu'il compte envoyer, dans sa monnaie
 */
async function adresseDepot(cle, vers, montant) {
  if (!actif()) { const e = new Error('no relay key'); e.statut = 503; throw e; }
  const d = DEPUIS[cle];
  if (!d) { const e = new Error('unknown origin'); e.statut = 400; throw e; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(vers || ''))) {
    const e = new Error('bad destination address'); e.statut = 400; throw e;
  }
  const n = parseFloat(String(montant).replace(',', '.'));
  if (!(n >= d.min) || !(n <= d.max)) {
    const e = new Error(`amount must be between ${d.min} and ${d.max} ${d.symbole}`);
    e.statut = 400; throw e;
  }
  const brut = enUnites(montant, d.decimales);
  if (brut === null) { const e = new Error('bad amount'); e.statut = 400; throw e; }

  const j = await appelle('/quote/v2', {
    useDepositAddress: true,
    /* `user` porte le repere de la chaine de DEPART, `recipient` le joueur.
       Voir le commentaire de DEPUIS : c'est l'inverse de ce que la
       documentation laisse croire, et c'est ce que l'API accepte. */
    user: d.repere,
    recipient: vers,
    refundTo: d.repere,
    originChainId: d.chaine, originCurrency: d.jeton,
    /* La destination n'est PAS negociable : de l'ETH natif sur Robinhood
       Chain, chez le joueur. C'est ce que le panneau sait acheter ensuite. */
    destinationChainId: RH, destinationCurrency: NATIF,
    amount: brut, tradeType: 'EXACT_INPUT',
  });

  const etape = (j.steps || []).find((s) => s.depositAddress) || {};
  const adresse = etape.depositAddress;
  if (!adresse) { const e = new Error('relay returned no deposit address'); e.statut = 502; throw e; }
  const det = j.details || {};

  /* On recopie, on ne reexpedie pas. Renvoyer la reponse entiere serait
     renvoyer un jour un champ qu'on n'a pas lu. */
  return {
    adresse: adresse,
    id: etape.requestId || (j.request && j.request.id) || null,
    symbole: d.symbole,
    envoie: det.currencyIn ? det.currencyIn.amountFormatted : String(montant),
    recoit: det.currencyOut ? det.currencyOut.amountFormatted : null,
    /* Les deux cotes en dollars, pas seulement l'arrivee. Le joueur tape un
       nombre de SOL ou d'ETH : sans le montant de DEPART chiffre, il n'a
       aucun moyen de savoir s'il vient d'engager dix dollars ou mille, et
       0,05 ETH ne dit rien a personne. */
    dollarsEnvoi: det.currencyIn ? det.currencyIn.amountUsd : null,
    dollars: det.currencyOut ? det.currencyOut.amountUsd : null,
    secondes: det.timeEstimate || null,
  };
}

/**
 * Ce que vaut un montant, sans rien reserver.
 *
 * MEME APPEL que l'adresse de depot, sans `useDepositAddress`. C'est un
 * chiffrage : Relay cote la route et rend les deux cotes en dollars, mais
 * n'ouvre aucune adresse. Il fallait cette distinction — le champ se chiffre
 * a chaque frappe, et ouvrir une adresse de depot par frappe en creerait
 * trente pour un seul envoi.
 *
 * Tout ce qui echoue ici est SANS CONSEQUENCE : la page n'affiche simplement
 * pas la ligne en dollars. C'est un confort, pas une etape du parcours, et il
 * ne doit jamais empecher un depot de partir.
 */
async function prix(cle, vers, montant) {
  if (!actif()) { const e = new Error('no relay key'); e.statut = 503; throw e; }
  const d = DEPUIS[cle];
  if (!d) { const e = new Error('unknown origin'); e.statut = 400; throw e; }
  /* LE DESTINATAIRE EST LE JOUEUR, pas le repere de la chaine de depart.
   *
   * Premiere version : `recipient: d.repere`. Le chiffrage marchait depuis
   * Ethereum et pas depuis Solana — et pour une raison qui saute aux yeux une
   * fois vue : le repere d'Ethereum est 0x000…0, une adresse 0x parfaitement
   * valide sur Robinhood Chain, tandis que celui de Solana est
   * « 1111…1111 », que Relay refuse comme destinataire d'une chaine EVM. Le
   * bogue etait invisible sur la moitie des provenances.
   *
   * L'appel a donc EXACTEMENT la meme forme que celui de l'adresse de depot,
   * a `useDepositAddress` pres — c'est justement la divergence entre les deux
   * qui l'avait cree. */
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(vers || ''))) {
    const e = new Error('bad destination address'); e.statut = 400; throw e;
  }
  const n = parseFloat(String(montant).replace(',', '.'));
  if (!(n >= d.min) || !(n <= d.max)) {
    const e = new Error(`amount must be between ${d.min} and ${d.max} ${d.symbole}`);
    e.statut = 400; throw e;
  }
  const brut = enUnites(montant, d.decimales);
  if (brut === null) { const e = new Error('bad amount'); e.statut = 400; throw e; }

  const j = await appelle('/quote/v2', {
    user: d.repere, recipient: vers, refundTo: d.repere,
    originChainId: d.chaine, originCurrency: d.jeton,
    destinationChainId: RH, destinationCurrency: NATIF,
    amount: brut, tradeType: 'EXACT_INPUT',
  });
  const det = j.details || {};
  return {
    symbole: d.symbole,
    envoie: det.currencyIn ? det.currencyIn.amountFormatted : String(montant),
    dollarsEnvoi: det.currencyIn ? det.currencyIn.amountUsd : null,
    recoit: det.currencyOut ? det.currencyOut.amountFormatted : null,
    dollars: det.currencyOut ? det.currencyOut.amountUsd : null,
    secondes: det.timeEstimate || null,
  };
}

/** Ou en est l'envoi. Le joueur regarde cet ecran pendant que ca se fait. */
async function etat(id) {
  if (!actif()) { const e = new Error('no relay key'); e.statut = 503; throw e; }
  if (!/^0x[0-9a-fA-F]{10,80}$/.test(String(id || ''))) {
    const e = new Error('bad request id'); e.statut = 400; throw e;
  }
  const r = await fetch(`${cfg.RELAY_API}/intents/status/v3?requestId=${encodeURIComponent(id)}`,
                        { headers: { 'x-api-key': cfg.RELAY_API_KEY } });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) { const e = new Error((j && j.message) || t.slice(0, 150)); e.statut = r.status; throw e; }
  return { statut: (j && j.status) || 'unknown', fini: (j && j.status) === 'success',
           tx: (j && j.txHashes && j.txHashes[0]) || null };
}

module.exports = { actif, provenances, adresseDepot, prix, etat, DEPUIS, enUnites };
