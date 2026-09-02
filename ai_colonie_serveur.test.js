/* ============================================================================
 * LA COLONIE COTE SERVEUR : ELLE TOURNE SANS PERSONNE, ET TOUT LE MONDE VOIT
 * LA MEME CHOSE
 *
 * « Faut que ça soit live tout le temps, ça tourne 24/24 même quand on est pas
 * sur la page, tout le monde voit la même chose. »
 *
 * La version navigateur cochait zero des trois cases, et ca ne se voyait pas :
 * l'ecran etait plein, les positions vivaient, les agents apprenaient. Mais
 * chaque visiteur avait SA tresorerie dans SON stockage local, et fermer
 * l'onglet arretait SA colonie. Deux personnes cote a cote lisaient deux
 * mondes differents en croyant lire le meme.
 *
 * Ce fichier mesure le deplacement du moteur vers le serveur, et il mesure
 * d'abord ce qui pourrait couter de l'argent :
 *
 *   1. la colonie n'a AUCUN chemin vers la caisse des joueurs ;
 *   2. quand les services ne repondent pas, elle ne fabrique rien ;
 *   3. une position se ferme au prix RELU, jamais a un prix arrange ;
 *   4. la vue est la meme pour deux appelants, a la milliseconde pres.
 *
 * Le reseau est remplace par un monde qu'on ecrit ici : c'est la seule facon
 * de savoir ce qui a ete lu et ce qui a ete DEDUIT. Les formes des reponses
 * sont celles des vrais services, relevees sur la chaine 4663.
 * ==========================================================================*/
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Un dossier de donnees a nous : l'essai ne doit toucher ni le volume de
   production, ni le `state.json` du poste de developpement. */
const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), 'colonie-'));
process.env.DATA_DIR = DOSSIER;

let n = 0, rates = 0;
const ok = (v, m) => { n++; if (v) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* ---------------------------------------------------------------------------
 * LE MONDE FACTICE
 *
 * Il rend les memes formes que GeckoTerminal, GoPlus, DexScreener et le noeud
 * de la chaine. `appels` compte qui a ete interroge : c'est ce compteur qui
 * distingue « il a lu quatre sources » de « il a suppose quatre fois ».
 * ------------------------------------------------------------------------ */
const ZERO = '0x0000000000000000000000000000000000000000';
const SUJET = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const hex = (v) => '0x' + v.toString(16);

let MONDE = null, appels = null;

function jeton(i, o) {
  o = o || {};
  /* En HEXADECIMAL, et sur deux caracteres : `String(143)` donne « 143 », et
     « 143 » repete vingt fois fait soixante caracteres — pas une adresse. Le
     moteur la rejetait, et un banc qui sert plus de cent jetons mesurait alors
     son propre defaut de fabrication. */
  const suf = (i % 256).toString(16).padStart(2, '0');
  /* ---- DE VRAIES ADRESSES ----
   * Les precedentes portaient « t0ken » et « p001 », qui ne sont pas de
   * l'hexadecimal. Le moteur valide le format des adresses que lui rendent les
   * flux — c'est ce qui le protege d'une reponse abimee — et il les jetait donc
   * toutes. Le banc mesurait alors une absence qu'il avait lui-meme fabriquee. */
  return {
    addr: '0x' + suf.repeat(20),
    sym: 'TOK' + i,
    pool: '0x' + ('b0' + suf).repeat(10),
    prix: o.prix === undefined ? 1 : o.prix,
    liq: o.liq === undefined ? 50000 : o.liq,
    /* ---- LE BANC JOUE CONTRE LES REGLES QU'ON LIVRE ----
     * Le jeton par defaut valait 300 000 $ de capitalisation et douze minutes
     * d'age. Les deux tombent maintenant hors des bornes d'achat — plafond a
     * 100 000 $, age minimum de deux heures — et tout le banc se serait mis a
     * mesurer des refus. On le remonte DANS la fenetre plutot que de desactiver
     * les bornes pour l'essai : un banc qui tourne avec d'autres regles que la
     * production ne mesure plus la production. */
    mc: o.mc === undefined ? 60000 : o.mc,
    /* Quarante minutes : dans la fenetre d'achat (l'age minimum est passe de
       deux heures a quinze minutes), et SOUS les dix mille blocs du noeud de
       secours — ce qui remet le relais entre les deux noeuds a portee du banc,
       la ou trois heures le mettaient hors d'atteinte. */
    minutes: o.minutes === undefined ? 40 : o.minutes,
    porteurs: o.porteurs === undefined ? 130 : o.porteurs,
    indexe: !!o.indexe,          /* le montant est dans topics[3], pas dans data */
    goplus: o.goplus === undefined ? 'propre' : o.goplus,   /* propre | muet | honeypot */
    unSeulPorteur: !!o.unSeulPorteur,
    personneNeGarde: !!o.personneNeGarde,   /* chacun recoit puis renvoie : solde net nul */
    buys: o.buys === undefined ? 120 : o.buys,
    sells: o.sells === undefined ? 60 : o.sells,
    buyers: o.buyers === undefined ? 80 : o.buyers,
    /* ---- LE LAVAGE ----
     * Un seul portefeuille qui achete et revend a lui-meme. Les compteurs
     * agreges y voient un marche vivant ; les trades y voient une personne. */
    lavage: !!o.lavage,
    ch_m5: o.ch_m5 === undefined ? 8 : o.ch_m5,
    ch_h1: o.ch_h1 === undefined ? 20 : o.ch_h1,
    ch_h6: o.ch_h6 === undefined ? 35 : o.ch_h6,
    volH1: o.volH1 === undefined ? 20000 : o.volH1,
    /* Une SECONDE piscine : elle echange avec tout le monde, exactement comme
       la premiere. C'est a cette forme-la qu'on doit la reconnaitre, puisqu'on
       ne connait son adresse par aucun service. */
    secondePiscine: !!o.secondePiscine,
    tradeurs: o.tradeurs === undefined ? 12 : o.tradeurs,
    tradesN: o.tradesN === undefined ? 24 : o.tradesN,
    /* ---- LE PIEGE QUI NE SE VOIT QUE QUAND ON ESSAIE DE SORTIR ----
     * GoPlus le dit propre, la chaine le dit bien reparti, les compteurs
     * disent qu'on achete : rien ne le distingue d'un bon jeton AVANT
     * l'achat. Seul le contrat sait, et il ne le dit qu'a qui le lui
     * demande. */
    piege: !!o.piege,                 /* le transfert rend false */
    piegeQuiCasse: !!o.piegeQuiCasse, /* le transfert part en erreur */
    deployeur: o.deployeur || null,   /* lui, il peut toujours sortir */
    callMuet: !!o.callMuet,           /* le noeud ne repond pas a l'appel */
    /* La presence du projet : la vraie reponse DexScreener porte les URL. */
    sansTelegram: !!o.sansTelegram,
  };
}

/* Le flux des pools ne sert pas forcement TOUS les jetons du monde : c'est
   comme ca qu'on montre qu'un autre flux en ramene que lui seul connait. */
let poolsPageFiltre = null;

function mondeNeuf(jetons, extra) {
  return Object.assign({
    jetons,
    prixDe: (a) => { const t = jetons.find((x) => x.addr === a); return t ? t.prix : 0; },
    coupe: false,
    bloc: 5000000,
    profils: [], boosts: [], goplusCasse: false, rpcSature: false, claude: null, claudeCasse: false,
    cgCle: null, cgPorte: null, cgQuota: false,
    gpCle: null, gpSecret: null, drpcRefuse: false, drpcPlage: 0, drpcSansLogs: false,
  }, extra || {});
}

function poolsPage(page) {
  /* Le vrai flux rend vingt pools par page ; on met tout sur la premiere et
     on laisse les suivantes vides, ce qu'il fait aussi en fin de flux. */
  let liste = page === 1 ? MONDE.jetons : [];
  if (poolsPageFiltre) liste = liste.filter((t) => poolsPageFiltre.indexOf(t.addr) >= 0);
  return {
    data: liste.map((t) => ({
      id: 'pool_' + t.sym,
      attributes: {
        address: t.pool,
        base_token_price_usd: String(t.prix),
        market_cap_usd: String(t.mc), fdv_usd: String(t.mc),
        reserve_in_usd: String(t.liq),
        pool_created_at: new Date(Date.now() - t.minutes * 60000).toISOString(),
        transactions: { h1: { buys: t.buys, sells: t.sells, buyers: t.buyers, sellers: 30 } },
        volume_usd: { m5: 2000, h1: t.volH1, h6: 60000, h24: 90000 },
        price_change_percentage: { m5: String(t.ch_m5), h1: String(t.ch_h1), h6: String(t.ch_h6) },
      },
      relationships: { base_token: { data: { id: 'tok_' + t.sym } } },
    })),
    included: liste.map((t) => ({
      type: 'token', id: 'tok_' + t.sym,
      attributes: { address: t.addr, symbol: t.sym, name: t.sym + ' coin' },
    })),
  };
}

function goplusDe(t) {
  /* MUET : la vraie reponse d'un jeton de sept minutes. Sept champs, deux
     taxes vides, aucune liste. Elle ne dit PAS que tout va bien : elle ne dit
     rien, et c'est tout l'objet du tri-etat. */
  if (t.goplus === 'muet') {
    return { code: 1, result: { [t.addr]: {
      creator_address: '0xabc', creator_balance: '0', creator_percent: '0',
      lp_total_supply: '0', token_name: t.sym, token_symbol: t.sym, total_supply: '1000000' } } };
  }
  /* ---- LA VRAIE REPONSE SUR UN JETON DE DEUX MINUTES ----
   * Relevee sur la chaine : huit champs, dont `is_in_dex: "0"` — alors qu'on
   * vient de trouver le jeton dans un pool. Ce champ-la est demontrablement
   * faux, ce qui apprend quelque chose sur tous les autres. */
  if (t.goplus === 'pasIndexe') {
    return { code: 1, result: { [t.addr]: {
      buy_tax: '', sell_tax: '', cannot_buy: '0', is_in_dex: '0', is_open_source: '0',
      owner_address: '', token_name: t.sym, token_symbol: t.sym } } };
  }
  if (t.goplus === 'honeypot') {
    return { code: 1, result: { [t.addr]: {
      is_in_dex: '1', is_honeypot: '1', buy_tax: '0', sell_tax: '0.99', is_open_source: '0',
      holder_count: '4', is_proxy: '0', is_mintable: '1' } } };
  }
  return { code: 1, result: { [t.addr]: {
    is_in_dex: '1',
    is_honeypot: '0', cannot_buy: '0', transfer_pausable: '0', owner_change_balance: '0',
    selfdestruct: '0', personal_slippage_modifiable: '0', honeypot_with_same_creator: '0',
    slippage_modifiable: '0', trading_cooldown: '0', is_proxy: '0', is_mintable: '0',
    buy_tax: '0', sell_tax: '0', is_open_source: '1',
    holder_count: String(t.porteurs),
    holders: [{ address: '0xh1', percent: '0.02', is_contract: 0, is_locked: 0, tag: '' }],
    lp_holders: [{ address: ZERO, percent: '1', is_locked: 1, tag: 'burn' }] } } };
}

/* ---- LES TRADES, UN PAR UN ----
 * C'est la source qui distingue des PERSONNES de des transactions. Un jeton
 * `lavage` fait tout son volume avec un seul portefeuille : les compteurs
 * agreges y voient un marche vivant, les trades y voient une mise en scene. */
function tradesDe(t) {
  const out = [];
  const n = t.tradesN === undefined ? 24 : t.tradesN;
  for (let i = 0; i < n; i++) {
    const qui = t.lavage ? '0xwash' : '0xw' + (i % (t.tradeurs || 12));
    out.push({ attributes: { kind: i % 3 === 2 ? 'sell' : 'buy',
                             volume_in_usd: String(t.lavage && i % 2 ? 400 : 60),
                             tx_from_address: qui } });
  }
  return out;
}

function ohlcvFaux() {
  const l = [];
  for (let i = 0; i < 24; i++) l.push([Date.now() / 1000 - i * 900, 1, 1, 1, 1 + (i % 3) * 0.03]);
  return { data: { attributes: { ohlcv_list: l } } };
}

function logsDe(t) {
  /* Une emission depuis l'adresse nulle vers N porteurs. C'est exactement ce
     que la chaine contient quelques minutes apres la naissance d'un jeton, et
     c'est de la somme de ces lignes que sortent « combien de porteurs » et
     « quelle part tient le premier ». */
  const out = [];
  const cibles = t.unSeulPorteur ? 1 : t.porteurs;
  const part = t.unSeulPorteur ? 1000000 : 1000;
  const ligne = (de, vers, mult) => {
    const v = part * (mult || 1);
    const topics = [SUJET, pad(de), pad(vers)];
    let data = hex(v);
    if (t.indexe) { topics.push(hex(v)); data = '0x'; }  /* montant INDEXE */
    return { topics, data };
  };
  const piscine2 = '0x' + 'e'.repeat(40);
  for (let i = 0; i < cibles; i++) {
    const a = '0x' + String(i).padStart(40, 'a');
    /* Avec une seconde piscine, chacun recoit assez pour lui en donner et en
       GARDER (4 recus, 2 donnes, 1 rendu = 3 gardes). Sinon tout le monde finit
       a zero net, personne n'est porteur, et l'essai ne mesure plus l'exclusion
       de la piscine : il mesure un monde vide. La piscine, elle, accumule une
       part par porteur — donc quarante, ce qui ferait d'elle « le gros
       porteur » si on ne la reconnaissait pas a sa forme. */
    out.push(ligne(ZERO, a, t.secondePiscine ? 4 : 1));
    /* Elle recoit de chacun et renvoie a chacun : c'est ce qui la distingue
       d'un porteur, qui n'echange qu'avec une ou deux contreparties. */
    if (t.secondePiscine) {
      /* Deux entrees pour une sortie : elle finit avec un solde POSITIF, comme
         une vraie piscine. A solde nul, elle ne serait de toute facon pas
         comptee comme porteuse, et l'essai ne mesurerait rien. */
      out.push(ligne(a, piscine2)); out.push(ligne(a, piscine2)); out.push(ligne(piscine2, a));
    }
    /* Releve sur la vraie chaine : soixante et un transferts, trente adresses,
       toutes a zero net, et la piscine tenant l'emission entiere. Chacun entre
       et ressort aussitot. */
    if (t.personneNeGarde) out.push(ligne(a, t.pool));
  }
  return out;
}

/* ---- LE CONTRAT REPOND, LUI AUSSI ----
 * L'epreuve de vente n'invente rien : elle DEMANDE au contrat, par eth_call,
 * ce qu'il ferait si un porteur envoyait un jeton vers la piscine. Le monde
 * faux doit donc savoir repondre a cette question, sinon l'epreuve ne mesure
 * que le silence du faux.
 *
 * Trois contrats possibles, et ce sont les trois qui existent vraiment :
 *  - `piege` : le transfert rend `false` pour tout le monde sauf le deployeur.
 *    C'est la forme la plus courante — rien ne casse, la vente echoue.
 *  - `piegeQuiCasse` : le transfert part en erreur. Plus visible, aussi reel.
 *  - le reste : il rend `true`, comme un jeton normal.
 * `callMuet` coupe la reponse : le noeud ne repond pas, et l'epreuve doit
 * alors dire « non testable » plutot que « coupable ». */
const VRAI = '0x' + '0'.repeat(63) + '1';
const FAUX = '0x' + '0'.repeat(64);
function ethCall(p) {
  appels.call++;
  const to = String(p.to || '').toLowerCase();
  const t = MONDE.jetons.find((x) => x.addr === to);
  if (!t) return { result: VRAI };
  if (t.callMuet) return { error: { message: 'execution timeout' } };
  /* Le deployeur, lui, peut toujours sortir : c'est ce qui rend le piege
     invisible tant qu'on ne demande pas a QUELQU'UN D'AUTRE. */
  const de = String(p.from || '').toLowerCase();
  if (t.piege && de === String(t.deployeur || '').toLowerCase()) return { result: VRAI };
  if (t.piegeQuiCasse) return { error: { message: 'execution reverted: TRADING_DISABLED' } };
  if (t.piege) return { result: FAUX };
  return { result: VRAI };
}

/* Tout ce qui part sur le reseau, garde : c'est la seule facon de VERIFIER
   qu'un secret ne fuit pas, plutot que de l'esperer. */
let envoyes = [];
global.fetch = async function (url, opts) {
  url = String(url);
  envoyes.push({ url, body: (opts || {}).body, headers: (opts || {}).headers });
  const rep = (o, st) => ({ ok: st === undefined || st < 400, status: st || 200, json: async () => o });
  if (MONDE.coupe) throw new Error('Failed to fetch');

  if (/coingecko\.com/.test(url)) {
    const pro = /pro-api/.test(url);
    const cle = (opts.headers || {})[pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'];
    (pro ? appels.cgPro : appels.cgDemo);
    if (pro) appels.cgPro++; else appels.cgDemo++;
    /* Le monde accepte la cle sur UNE seule des deux portes : c'est le cas
       reel, et c'est ce qui oblige a sonder plutot qu'a demander. */
    if (cle !== MONDE.cgCle || MONDE.cgPorte !== (pro ? 'pro' : 'demo'))
      return rep({ status: { error_message: 'API Key Missing' } }, 401);
    if (MONDE.cgQuota) return rep({ status: { error_message: 'quota' } }, 429);
    if (/new_pools/.test(url)) {
      const page = parseInt((url.match(/page=(\d+)/) || [])[1] || '1', 10);
      return rep(poolsPage(page));
    }
    if (/ohlcv/.test(url)) { appels.ohlcv++; return rep(ohlcvFaux()); }
    if (/\/trades/.test(url)) {
      appels.trades++;
      const pool = (url.match(/pools\/([^/]+)\/trades/) || [])[1];
      const t = MONDE.jetons.find((x) => x.pool === pool);
      return rep({ data: t ? tradesDe(t) : [] });
    }
    return rep({ data: [] });
  }
  if (/new_pools/.test(url)) {
    appels.pools++;
    const page = parseInt((url.match(/page=(\d+)/) || [])[1] || '1', 10);
    return rep(poolsPage(page));
  }
  if (/api\.anthropic\.com/.test(url)) {
    appels.claude++;
    if (MONDE.claudeCasse) return rep({ error: { message: 'surcharge' } }, 529);
    const c = MONDE.claude;
    const texte = (typeof c === 'string') ? c : JSON.stringify(c || { avis: 'reserve', points: 0 });
    return rep({ content: [{ type: 'text', text: texte }] });
  }
  if (/token-profiles/.test(url)) {
    appels.profils++;
    return rep((MONDE.profils || []).map((a) => ({ chainId: 'robinhood', tokenAddress: a })));
  }
  if (/token-boosts/.test(url)) {
    appels.boosts++;
    return rep((MONDE.boosts || []).map((a) => ({ chainId: 'robinhood', tokenAddress: a })));
  }
  if (/\/trades/.test(url)) {
    appels.trades++;
    const pool = (url.match(/pools\/([^/]+)\/trades/) || [])[1];
    const t = MONDE.jetons.find((x) => x.pool === pool);
    if (!t) return rep({ data: [] });
    return rep({ data: tradesDe(t) });
  }
  if (/api\.gopluslabs\.io\/api\/v1\/token$/.test(url)) {
    appels.goplusJeton++;
    const b = JSON.parse(opts.body || '{}');
    /* La vraie signature : sha1(cle + heure + secret). Le banc la RECALCULE au
       lieu de croire celle qui arrive — sinon il validerait n'importe quoi, et
       une signature fausse passerait l'essai. */
    const attendu = require('crypto').createHash('sha1')
      .update(MONDE.gpCle + b.time + MONDE.gpSecret).digest('hex');
    if (!MONDE.gpCle || b.app_key !== MONDE.gpCle || b.sign !== attendu)
      return rep({ code: 4011, message: null, result: null });
    return rep({ code: 1, result: { access_token: 'jeton-goplus-valide', expires_in: 3600 } });
  }
  if (/gopluslabs/.test(url)) {
    appels.goplus++;
    if ((opts.headers || {}).Authorization === 'jeton-goplus-valide') appels.goplusAuth++;
    if (MONDE.goplusCasse) return rep({ error: 'indisponible' }, 503);
    const a = (url.split('contract_addresses=')[1] || '').toLowerCase();
    const t = MONDE.jetons.find((x) => x.addr === a);
    return rep(t ? goplusDe(t) : { result: {} });
  }
  if (/ohlcv/.test(url)) { appels.ohlcv++; return rep(ohlcvFaux()); }
  if (/dexscreener/.test(url)) {
    appels.dex++;
    const a = (url.split('/tokens/')[1] || '').toLowerCase();
    const t = MONDE.jetons.find((x) => x.addr === a);
    if (!t) return rep({ pairs: [] });
    /* La vraie reponse porte le pool, l'age, la capitalisation et les
       compteurs — c'est ce qui permet de reconstruire un jeton a partir de sa
       seule adresse, donc de suivre les deux flux qui n'en rendent qu'une. */
    return rep({ pairs: [{
      chainId: 'robinhood', pairAddress: t.pool, priceUsd: String(t.prix),
      baseToken: { address: t.addr, symbol: t.sym, name: t.sym + ' coin' },
      liquidity: { usd: t.liq }, fdv: t.mc,
      pairCreatedAt: Date.now() - t.minutes * 60000,
      txns: { h1: { buys: t.buys, sells: t.sells } },
      volume: { m5: 2000, h1: 20000, h6: 60000, h24: 90000 },
      priceChange: { m5: t.ch_m5, h1: t.ch_h1, h6: t.ch_h6 },
      /* ---- LA PRESENCE DU PROJET, AVEC SES ADRESSES ----
       * La vraie reponse porte des URL, pas des etiquettes nues. Tant que le
       * faux n'en mettait pas, la regle « site + twitter + telegram » ecartait
       * TOUS les jetons du banc et la suite se mesurait elle-meme au lieu de
       * mesurer le moteur. `sansTelegram` sert a l'inverse : eprouver la regle
       * sur un jeton a qui il manque vraiment quelque chose. */
      info: t.sansTelegram
        ? { socials: [{ type: 'twitter', url: 'https://x.com/' + t.sym }],
            websites: [{ url: 'https://' + t.sym + '.example' }] }
        : { socials: [{ type: 'twitter', url: 'https://x.com/' + t.sym },
                      { type: 'telegram', url: 'https://t.me/' + t.sym }],
            websites: [{ url: 'https://' + t.sym + '.example' }] } }] });
  }
  if (/lb\.drpc\.org/.test(url)) {
    appels.rpcCle++;
    if (!/dkey=/.test(url) || MONDE.drpcRefuse)
      return rep({ error: { message: 'Your token is invalid or expired', code: 4 } }, 403);
    const b = JSON.parse(opts.body);
    if (b.method === 'eth_blockNumber') return rep({ result: hex(MONDE.bloc) });
    if (b.method === 'eth_getLogs') {
      /* ---- CE QUE CE NOEUD-LA A VRAIMENT REPONDU ----
       * Douze mille quatre cent deux fois, mot pour mot. Ce n'est ni une
       * saturation ni un forfait : le reseau `robinhood` n'expose pas cette
       * methode chez dRPC. Le reste de ses methodes, si. */
      appels.rpcCleLogs++;
      if (MONDE.drpcSansLogs)
        return rep({ error: { message: 'the method eth_getLogs does not exist/is not available' } }, 200);
      const f = b.params[0];
      const plage = parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16);
      if (MONDE.drpcPlage && plage > MONDE.drpcPlage)
        return rep({ error: { message: 'ranges over ' + MONDE.drpcPlage + ' blocks are not supported' } }, 400);
      const a = String(f.address || '').toLowerCase();
      const t = MONDE.jetons.find((x) => x.addr === a);
      return rep({ result: t ? logsDe(t) : [] });
    }
    if (b.method === 'eth_call') return rep(ethCall(b.params[0]));
    return rep({ result: null });
  }
  if (/rpc\.mainnet\.chain\.robinhood|drpc\.org/.test(url)) {
    const secours = /drpc\.org/.test(url);
    if (secours) appels.rpc2++; else appels.rpc++;
    /* Le noeud officiel peut saturer : c'est le cas mesure — quatre refus sur
       six lectures a la file. Le second doit alors prendre le relais. */
    if (!secours && MONDE.rpcSature) return rep({ error: { code: 429, message: 'Too Many Requests' } }, 429);
    const b0 = JSON.parse(opts.body);
    if (secours && b0.method === 'eth_getLogs') {
      const f = b0.params[0];
      const plage = parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16);
      /* Sa vraie limite, relevee sur le service : dix mille blocs. */
      if (plage > 10000) return rep({ error: { message: 'ranges over 10000 blocks are not supported' } }, 400);
    }
    const b = JSON.parse(opts.body);
    if (b.method === 'eth_blockNumber') return rep({ result: hex(MONDE.bloc) });
    if (b.method === 'eth_getLogs') {
      const a = String(b.params[0].address || '').toLowerCase();
      const t = MONDE.jetons.find((x) => x.addr === a);
      return rep({ result: t ? logsDe(t) : [] });
    }
    if (b.method === 'eth_call') return rep(ethCall(b.params[0]));
    return rep({ result: null });
  }
  throw new Error('service non prevu : ' + url);
};

const C = require('./ai_colonie.js');

function remise(jetons, extra) {
  MONDE = mondeNeuf(jetons, extra);
  envoyes = [];
  appels = { pools: 0, goplus: 0, ohlcv: 0, dex: 0, rpc: 0, rpc2: 0, trades: 0, profils: 0, boosts: 0, claude: 0, cgDemo: 0, cgPro: 0, goplusJeton: 0, goplusAuth: 0, rpcCle: 0, rpcCleLogs: 0, call: 0 };
  for (const k of Object.keys(C._cache)) for (const j of Object.keys(C._cache[k])) delete C._cache[k][j];
  for (const k of Object.keys(C._prix)) delete C._prix[k];
  C._pose(C.etatNeuf());
  C._poseporte(null);            /* la porte CoinGecko est resondee a chaque scenario */
  C._posejeton({ valeur: null, jusqua: 0, essaye: false });
  delete process.env.COINGECKO_API_KEY;
  delete process.env.GOPLUS_APP_KEY; delete process.env.GOPLUS_APP_SECRET;
  delete process.env.DRPC_API_KEY;
  delete C.noeuds._cle;
  for (const n of C.noeuds()) n.plageLogs = n.cle === 'chaine2' ? 10000 : 200000;
  try { fs.unlinkSync(C.FICHIER); } catch (e) {}
}

const sains = () => [0, 1, 2, 3, 4, 5, 6].map((i) => jeton(i));

/* ==========================================================================
 * 1. LA CAISSE DES JOUEURS N'EST PAS ATTEIGNABLE
 * ======================================================================== */
async function isolement() {
  console.log('\n-- ce que la colonie ne peut pas toucher --');
  remise(sains());
  await C.tour();
  C.sauve();

  const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
  ok(!/require\(['"]\.\/store/.test(src),
     'le module ne demande jamais `store` — c est lui qui tient l argent des joueurs');
  ok(!/state\.json/.test(src.replace(/^ \*.*$/gm, '')),
     'et le nom du fichier de la caisse n apparait dans aucun chemin');
  ok(/ai_colonie\.json/.test(String(C.FICHIER)) && !/state\.json/.test(String(C.FICHIER)),
     'son etat vit dans son PROPRE fichier (' + path.basename(C.FICHIER) + ')');

  const ecrits = fs.readdirSync(DOSSIER);
  console.log('   fichiers ecrits : ' + JSON.stringify(ecrits));
  ok(ecrits.indexOf('state.json') < 0,
     'apres un tour complet, aucun `state.json` n a ete cree — un defaut ici coute zero centime');
  ok(ecrits.indexOf('ai_colonie.json') >= 0, 'et son etat, lui, est bien sur le disque');

  /* Le rename atomique : une coupure au milieu de l'ecriture laisse l'ancien
     entier plutot qu'un fichier tronque. Des semaines d'apprentissage tiennent
     dans ce fichier. */
  ok(ecrits.indexOf('ai_colonie.json.tmp') < 0,
     'le temporaire ne traine pas apres l ecriture : le remplacement est atomique');
}

/* ==========================================================================
 * 2. AUCUN SERVICE NE REPOND
 *
 * Le seul comportement acceptable est de le DIRE. Une tresorerie qui bouge
 * sans prix relu, ou une position ouverte sur rien, sont des chiffres qu'on
 * ne peut pas reproduire — et un chiffre flatteur qu'on ne peut pas
 * reproduire donne envie d'y mettre de l'argent.
 * ======================================================================== */
async function horsLigne() {
  console.log('\n-- aucun service ne repond --');
  remise(sains());
  MONDE.coupe = true;
  await C.tour();
  const v = C.vue();
  console.log('   ' + JSON.stringify({ tresor: v.tresor, pos: v.positions.length, err: v.erreur }));
  ok(v.tresor === C.DEPART, 'la tresorerie reste a son point de depart ($' + C.DEPART + ')');
  ok(v.positions.length === 0, 'aucune position n est ouverte : sans prix relu, on ne sait pas a quoi on achete');
  ok(v.trades === 0 && v.ouvertures === 0, 'et rien n est compte comme fait');
  ok(!!v.erreur, 'la vue PORTE l echec au lieu de le taire (« ' + v.erreur + ' »)');
  ok(v.dernierTour > 0, 'et l heure de la tentative, pour qu on voie que ca a essaye');
  ok(!v.candidats || v.candidats.length === 0, 'aucun candidat n est presente : il n y a rien eu a lire');
}

/* ==========================================================================
 * 3. LES QUATRE SOURCES, ET LE PRIX REEL
 * ======================================================================== */
async function sources() {
  console.log('\n-- les quatre sources --');
  remise(sains());
  await C.tour();
  console.log('   appels : ' + JSON.stringify(appels));
  ok(appels.pools === 3, 'les pools neufs sont lus sur GeckoTerminal (' + appels.pools + ' pages)');
  ok(appels.goplus >= 6, 'la securite du contrat est lue sur GoPlus (' + appels.goplus + ')');
  ok(appels.ohlcv >= 6, 'les chandelles sont lues, pour la volatilite reelle (' + appels.ohlcv + ')');
  ok(appels.dex >= 6, 'DexScreener donne un SECOND avis sur le prix (' + appels.dex + ')');
  ok(appels.rpc >= 6, 'et la chaine elle-meme est interrogee — la seule source que personne ne peut maquiller ('
     + appels.rpc + ' appels)');

  const v = C.vue();
  ok(!v.erreur, 'le tour se termine sans erreur');
  ok(v.positions.length > 0, 'des positions s ouvrent (' + v.positions.length + ')');
  const p = C._etat().positions[0];
  console.log('   position : ' + JSON.stringify({ sym: p.sym, prix0: p.prix0, tenue: p.tenueMin }));
  ok(p.prix0 === MONDE.prixDe(p.adr),
     'au prix REEL du moment, pas une valeur posee (' + p.prix0 + ')');
  ok(p.t0 > 0 && p.tenueMin > 0, 'avec l instant d ouverture et la duree que le Closer compte tenir');
  const six = ['scout', 'warden', 'whale', 'whisper', 'oracle'];
  ok(six.every((a) => p.traits[a] && Object.keys(p.traits[a]).length),
     'elle emporte les traits des cinq analystes : sans eux, aucun ne pourrait apprendre de sa fin');

  /* La chaine a ete lue POUR DE BON : les porteurs viennent de la somme des
     transferts, pas d'un service qui pourrait se tromper. */
  const c = v.candidats.find((x) => x.chaineVue);
  console.log('   lu dans les blocs : ' + JSON.stringify({ sym: c && c.sym, porteurs: c && c.porteurs, top: c && c.top }));
  ok(!!c && c.porteurs === 130,
     'les porteurs sont COMPTES dans les blocs (' + (c && c.porteurs) + ' attendus 130)');
  ok(!!c && c.top !== null && c.top < 5,
     'et la part du premier porteur aussi (' + (c && c.top) + '%)');
}

/* ==========================================================================
 * 4. LE MONTANT INDEXE — UNE FAUSSE CONCLUSION, PAS UNE LECTURE RATEE
 *
 * Certains contrats INDEXENT le montant du transfert : il arrive alors dans
 * `topics[3]` et `data` est vide. Ne lire que `data` ne rendait pas « je ne
 * sais pas » — ca rendait « zero porteur », c'est-a-dire un jeton qu'on
 * ecarte pour une raison FAUSSE. Trois jetons sur six mesures tombaient
 * dedans.
 * ======================================================================== */
async function montantIndexe() {
  console.log('\n-- le montant du transfert est indexe --');
  remise([jeton(0, { indexe: true, porteurs: 77 }), jeton(1)]);
  await C.tour();
  const c = C.vue().candidats.find((x) => x.sym === 'TOK0');
  console.log('   ' + JSON.stringify({ porteurs: c && c.porteurs, top: c && c.top }));
  ok(!!c && c.porteurs === 77,
     'le montant est retrouve dans topics[3] : ' + (c && c.porteurs) + ' porteurs, pas zero');
  ok(!!c && c.top !== null, 'et la concentration reste calculable (' + (c && c.top) + '%)');
}

/* ==========================================================================
 * 5. L'INCONNU NE RAPPORTE JAMAIS DE POINTS
 * ======================================================================== */
function inconnu() {
  console.log('\n-- « il a repondu » n est pas « il sait » --');
  const base = { addr: '0xa', sym: 'A', liq: 50000, prix: 1, mc: 6e4, minutes: 180, ch_m5: 8,
    tx: { h1: { buys: 120, sells: 60, buyers: 80, sellers: 30 } },
    chaine: { vu: true, porteurs: 130, top: 2.1, brule: 0 } };
  const propre = Object.assign({}, base, { g: {
    have: true, taxeSue: true, buyTax: 0, sellTax: 0, codeSu: true, unverified: false,
    detSue: true, holders: 130, topSu: true, top: 2, lp: 100 } });
  const muet = Object.assign({}, base, { g: {
    have: false, taxeSue: false, codeSu: false, detSue: false, topSu: false, buyTax: 0, sellTax: 0, top: 0, lp: 0 } });
  const sp = C.scoreBase(propre), sm = C.scoreBase(muet);
  console.log('   note avec GoPlus complet : ' + sp.toFixed(1) + ' · avec GoPlus muet : ' + sm.toFixed(1));
  ok(sm < sp, 'un GoPlus muet note MOINS BIEN qu un GoPlus propre (' + sm.toFixed(1) + ' < ' + sp.toFixed(1) + ')');
  ok(sp - sm >= 10, 'et l ecart est reel, pas cosmetique (' + (sp - sm).toFixed(1) + ' points)');

  const tr = C.traitsDe(muet);
  ok(/inconnu/.test(tr.warden.taxe) && /inconnu/.test(tr.warden.code),
     'les traits du Warden le disent en toutes lettres : « ' + tr.warden.taxe + ' », « ' + tr.warden.code + ' »');
}

/* ==========================================================================
 * 6. LE PIEGE, ET LE PORTEUR UNIQUE
 * ======================================================================== */
async function pieges() {
  console.log('\n-- ce qui ne doit jamais devenir une position --');
  remise([jeton(0, { goplus: 'honeypot' }), jeton(1, { unSeulPorteur: true, goplus: 'muet' })]);
  await C.tour();
  const v = C.vue();
  const hp = v.candidats.find((x) => x.sym === 'TOK0');
  const un = v.candidats.find((x) => x.sym === 'TOK1');
  console.log('   ' + JSON.stringify({ honeypot: hp && hp.refus, porteurUnique: un && un.refus, pos: v.positions.length }));
  ok(!!hp && /honeypot/.test(String(hp.refus)), 'le contrat piege est refuse, et la raison est nommee');
  ok(!!un && /porteur tient/.test(String(un.refus)),
     'le jeton dont un seul porteur tient tout est refuse, meme si GoPlus n en dit rien (« ' + (un && un.refus) + ' »)');
  ok(v.positions.length === 0, 'et aucune position ne s ouvre sur l un ou l autre — c est tout l interet du controle');
}

/* ==========================================================================
 * 6 bis. « PERSONNE NE GARDE » N'EST PAS « JE NE SAIS PAS »
 *
 * Releve sur la vraie chaine 4663, sur deux jetons de deux minutes : soixante
 * et un transferts, trente adresses, TOUTES a zero net, la piscine tenant les
 * 10^27 de l'emission. La lecture etait parfaite — c'est le compte rendu qui
 * mentait, parce qu'un circulant nul sortait « inconnu ».
 *
 * Et l'inconnu est TIEDE : il coute quatre points, la ou « trente adresses ont
 * touche ce jeton et aucune ne l'a garde » doit fermer la porte. Le jeton
 * sortait donc en « note trop basse », c'est-a-dire avec l'apparence d'un
 * jeton ordinaire un peu faible. Quatre des quatorze jetons reels mesures
 * tombaient dans ce cas.
 * ======================================================================== */
async function personneNeGarde() {
  console.log('\n-- personne ne garde le jeton --');
  remise([jeton(0, { personneNeGarde: true, porteurs: 30, goplus: 'muet' }), jeton(1)]);
  await C.tour();
  const v = C.vue();
  const c = v.candidats.find((x) => x.sym === 'TOK0');
  console.log('   ' + JSON.stringify({ transferts: c && c.transferts, lus: c && c.montantsLus,
    porteurs: c && c.porteurs, personne: c && c.personne, refus: c && c.refus }));
  ok(!!c && c.montantsLus === true,
     'les montants ONT ete lus : ce n est pas une lecture ratee (' + (c && c.transferts) + ' transferts)');
  ok(!!c && c.porteurs === 0 && c.personne === true,
     'et ce qu ils disent est que personne ne detient rien — un fait, pas une ignorance');
  ok(!!c && /aucune ne le garde/.test(String(c.refus)),
     'le refus le NOMME : « ' + (c && c.refus) + ' »');
  ok(!!c && !/note trop basse/.test(String(c.refus)),
     'il ne sort pas en « note trop basse », qui l aurait fait passer pour un jeton ordinaire un peu faible');
  ok(!v.positions.some((p) => p.sym === 'TOK0'), 'et aucune position ne s ouvre dessus');
}

/* ==========================================================================
 * 7. RIEN DE VIEUX N'ENTRE
 * ======================================================================== */
async function neufSeulement() {
  console.log('\n-- le but est d analyser des NOUVEAUX jetons --');
  remise([jeton(0, { minutes: 2000 }), jeton(1, { minutes: 700 }), jeton(2, { minutes: 15 })]);
  await C.tour();
  const v = C.vue();
  console.log('   examines : ' + JSON.stringify(v.candidats.map((x) => x.sym + ':' + x.minutes + 'min')));
  ok(v.candidats.every((x) => x.minutes <= C.AGE_MAX_MIN),
     'aucun jeton de plus de ' + C.AGE_MAX_MIN + ' minutes n est examine');
  ok(v.candidats.length === 1 && v.candidats[0].sym === 'TOK2',
     'seul le jeton neuf passe — un seul jeton etabli suffirait a fausser ce que les agents apprennent');
}

/* ==========================================================================
 * 8. LE REGLEMENT SE FAIT AU PRIX RELU, ET LES SIX APPRENNENT
 * ======================================================================== */
async function reglement() {
  console.log('\n-- une position se ferme au prix RELU --');
  remise(sains());
  await C.tour();
  const E = C._etat();
  const avant = E.positions.length;
  const mises = E.positions.reduce((a, p) => a + p.mise, 0);
  /* ---- ON MARQUE LES POSITIONS D'AVANT ----
   * Les reconnaitre a leur adresse ne marche pas : le tour ferme une position
   * puis en ROUVRE une sur le meme jeton, qui a toujours une bonne note. Par
   * adresse, les six sont donc « toujours la », et l'essai mesurait zero
   * fermeture en presence de quatre. Une marque posee avant les distingue. */
  E.positions.forEach((p, i) => { p.__avant = i; });
  const ouvertesAvant = E.positions.map((p, i) => ({ marque: i, mise: p.mise }));
  const attendu = C.DEPART + mises * 0.5;   /* si tout fermait ; le Promoteur en garde */
  ok(avant > 0, avant + ' position(s) ouverte(s) a $1,00, pour $' + mises.toFixed(2) + ' engages');

  /* ---- LE TEMPS PASSE PAR PETITS PAS, COMME SUR LE SERVEUR ----
   * Un tour toutes les deux minutes et demie : une position est RELUE des
   * dizaines de fois avant d etre due, et chaque relecture pose un point sur
   * sa trajectoire. C est de ces points que le Closer tire ce que vaut telle
   * ou telle duree de tenue — sans eux il n aurait qu une seule mesure, celle
   * de la fin, et ne pourrait comparer avec rien.
   * Le prix ne bouge pas encore : ces points valent 0 %, et c est bien la
   * verite du moment. */
  const platt = {};
  for (const p of E.positions) platt[p.adr] = p.prix0;
  for (const dt of [8, 16]) {
    for (const p of E.positions) p.t0 = Date.now() - dt * 60000;
    C.regle(platt);
  }
  ok(E.positions.length === avant,
     'a ' + 16 + ' minutes, rien ne se ferme : la tenue de ' + E.positions[0].tenueMin
     + ' min n est pas atteinte');
  ok((E.positions[0].traj || []).length >= 2,
     'mais la trajectoire a ete relevee a chaque passage (' + E.positions[0].traj.length + ' points)');

  /* Puis le temps de la tenue est franchi, et le marche a bouge. La colonie
     n en sait rien : elle va le RELIRE. */
  for (const p of E.positions) p.t0 = Date.now() - 3 * 3600e3;
  for (const t of MONDE.jetons) t.prix = 1.5;
  for (const k of Object.keys(C._cache.chaine)) delete C._cache.chaine[k];

  await C.tour();
  const v = C.vue();
  console.log('   ' + JSON.stringify({ tresor: v.tresor, trades: v.trades, gains: v.gains }));

  /* ---- LE PROMOTEUR EST DANS LE CHEMIN, MAINTENANT ----
   * A +50 %, il en garde une partie pour une duree de plus — c'est son travail.
   * L'essai ne peut donc plus exiger que TOUT ferme : il exige que ce qui a
   * ferme l'ait fait au bon prix, et que ce qui reste ait ete PROLONGE pour une
   * raison ecrite, et non simplement oublie. */
  const prolongees = C._etat().positions.filter((p) => p.prolonge > 0);
  console.log('   fermees ' + v.trades + ' · prolongees ' + prolongees.length
    + ' · restantes ' + v.positions.length);
  ok(v.trades + prolongees.length === avant,
     'chaque position due est soit fermee, soit prolongee — aucune n est laissee en plan ('
     + v.trades + ' + ' + prolongees.length + ' = ' + avant + ')');
  ok(prolongees.length > 0 && prolongees.every((p) => p.casProlonge),
     'et une prolongation porte le cas sur lequel le Promoteur apprendra');

  /* +50 % sur chaque mise. La mise n'est plus une constante — c'est le
     Banquier qui la pose, et elle depend de la caisse du moment. On additionne
     donc les mises REELLEMENT engagees : le chiffre doit tomber juste, et
     c'est la preuve que le rendement vient du prix relu et non d'une
     estimation. */
  /* Les mises des positions D'AVANT qui ne sont plus la. Retrancher simplement
     ce qui reste ouvert donnerait un chiffre faux : le tour a aussi OUVERT de
     nouvelles positions sur les places liberees. */
  const encore = new Set(C._etat().positions.filter((p) => p.__avant !== undefined)
                                            .map((p) => p.__avant));
  const misesFermees = ouvertesAvant.filter((p) => !encore.has(p.marque))
                                    .reduce((a, p) => a + p.mise, 0);
  /* ---- ET L'ECHELLE DE SORTIE ENCAISSE AVANT LA FERMETURE ----
   * A +50 %, deux paliers sont franchis : 35 % de la mise vendus a +15 % et
   * 35 % a +40 % — au prix du moment, donc +50 % dans les deux cas puisqu'il
   * n'y a eu qu'une seule relecture. Une position PROLONGEE a donc deja
   * rapporte 70 % de son gain, et exiger que la tresorerie ne bouge que sur
   * les positions fermees reviendrait a exiger l'ancien comportement.
   * Ce qui doit rester exact, c'est que chaque dollar vienne d'un prix relu :
   * on additionne donc ce qui a ferme ET ce que chaque position ouverte a
   * deja encaisse, et le total doit tomber au centime. */
  const encaisse = C._etat().positions.reduce((a, p) => a + (p.encaisse || 0), 0);
  const attenduReel = C.DEPART + misesFermees * 0.5 + encaisse;
  console.log('   tresorerie : ' + v.tresor.toFixed(2) + ' · attendu ' + attenduReel.toFixed(2)
    + ' (sur $' + misesFermees.toFixed(2) + ' fermes + $' + encaisse.toFixed(2)
    + ' encaisses en route)');
  ok(Math.abs(v.tresor - attenduReel) < 0.01,
     'la tresorerie suit exactement les prix relus : +50 % sur les $' + misesFermees.toFixed(2)
     + ' fermes, plus les $' + encaisse.toFixed(2) + ' deja pris par les paliers');
  ok(encaisse > 0,
     'et les paliers ont bien encaisse en route, sans attendre la fermeture ($'
     + encaisse.toFixed(2) + ') : c est tout l interet de sortir par morceaux');
  ok(v.gains === v.trades, 'et toutes les fermees sont comptees gagnantes');
  ok(v.tresor > C.DEPART, 'la tresorerie a bien monte, pas juste « pas bouge » ($' + v.tresor.toFixed(2) + ')');

  const m = C._etat().memoire;
  const appris = ['scout', 'warden', 'whale', 'whisper', 'oracle', 'closer'].filter((a) => m[a] && Object.keys(m[a]).length);
  console.log('   agents ayant appris : ' + JSON.stringify(appris));
  ok(appris.length === 6, 'les SIX agents ont appris, chacun sur ce qu il regarde (' + appris.join(', ') + ')');

  let mauvaise = null;
  for (const a in m) for (const t in m[a]) for (const val in m[a][t]) {
    const c = m[a][t][val];
    if (!(c.n > 0) || !isFinite(c.s)) mauvaise = a + '/' + t + '/' + val + ' = ' + JSON.stringify(c);
  }
  ok(!mauvaise, mauvaise ? 'case de memoire impossible : ' + mauvaise
     : 'aucune case de memoire ne porte un compte vide ou un total impossible');

  const tenues = Object.keys((m.closer || {}).tenue || {});
  console.log('   durees retenues par le Closer : ' + JSON.stringify(tenues));
  ok(tenues.length >= 2, 'le Closer retient plusieurs durees de tenue, pour pouvoir les comparer');

  const l = C.vue().agents.scout.lecons;
  ok(l.every((x) => x.n >= 2),
     'et ce que la vue publie porte le nombre d observations — deux coups de chance ne font pas une regle');
}

/* ==========================================================================
 * 9. LE SERVEUR REDEMARRE, LA COLONIE CONTINUE
 * ======================================================================== */
async function survie() {
  console.log('\n-- le serveur redemarre --');
  remise(sains());
  await C.tour();
  const av = C.vue();
  const posAv = av.positions.length, ouvAv = av.ouvertures;
  ok(posAv > 0, posAv + ' position(s) en cours au moment de la coupure');

  /* Le processus meurt : on efface l etat en memoire et on relit le disque,
     exactement ce que fait `demarre()` au demarrage. */
  C._pose(C.etatNeuf());
  ok(C.vue().positions.length === 0, 'en memoire, tout est perdu — c est bien une coupure');
  C.charge();
  const ap = C.vue();
  console.log('   apres relecture : ' + JSON.stringify({ pos: ap.positions.length, ouv: ap.ouvertures, tresor: ap.tresor }));
  ok(ap.positions.length === posAv, 'les positions ouvertes sont retrouvees (' + ap.positions.length + ')');
  ok(ap.ouvertures === ouvAv, 'le compte des ouvertures aussi');
  const a = C._etat().positions[0];
  ok(a.prix0 > 0 && a.t0 > 0,
     'avec leur prix d entree et leur heure : c est eux qui rendront le calcul honnete plus tard');
  ok(a.traits && a.traits.scout, 'et leurs traits, sans quoi les agents n apprendraient rien de leur fin');

  /* Une forme plus ancienne se complete, elle ne se jette pas : une correction
     du moteur ne doit pas effacer des semaines d apprentissage. */
  const vieux = JSON.parse(fs.readFileSync(C.FICHIER, 'utf8'));
  delete vieux.candidats; delete vieux.tenue; delete vieux.meilleurSym;
  fs.writeFileSync(C.FICHIER, JSON.stringify(vieux));
  C._pose(C.etatNeuf());
  C.charge();
  ok(C._etat().positions.length === posAv && C._etat().tresor === vieux.tresor,
     'un etat ecrit par une version anterieure se COMPLETE au lieu d etre jete');
}

/* ==========================================================================
 * 10. TOUT LE MONDE VOIT LA MEME CHOSE
 * ======================================================================== */
async function partage() {
  console.log('\n-- tout le monde voit la meme chose --');
  remise(sains());
  await C.tour();
  const a = C.vue(), b = C.vue();
  const sansHorloge = (v) => { const x = JSON.parse(JSON.stringify(v)); delete x.t;
    x.positions.forEach((p) => { delete p.ouverteDepuis; }); return JSON.stringify(x); };
  ok(sansHorloge(a) === sansHorloge(b),
     'deux appels rendent la MEME vue — pas deux colonies qui divergent');
  ok(a.tresor === b.tresor && a.trades === b.trades,
     'meme tresorerie, meme historique : $' + a.tresor + ', ' + a.trades + ' trade(s)');

  /* La vue doit porter de quoi juger sa propre fraicheur : sans horodatage, un
     ecran fige ressemble a un ecran calme. */
  ok(a.maj > 0 && a.dernierTour > 0, 'elle porte l heure de la derniere lecture');
  ok(a.cadence > 0, 'et la cadence, pour que la page sache quand redemander (' + (a.cadence / 1000) + ' s)');
  ok(a.depuis > 0, 'et depuis quand la colonie tourne');

  /* Ce qui ne doit PAS en sortir : rien qui permette de rejouer une decision
     avec de l argent reel, et rien d interne au serveur. */
  const brut = JSON.stringify(a);
  ok(!/DATA_DIR|\/data\/|privateKey|mnemonic/.test(brut),
     'et rien du disque ni des cles du serveur ne fuit dans la vue publique');

  ok(a.seuil === C.SEUIL && a.ageMax === C.AGE_MAX_MIN,
     'elle publie ses propres regles (note >= ' + a.seuil + ', age <= ' + a.ageMax + ' min) : lisibles, donc verifiables');
}

/* ==========================================================================
 * 11. LA CADENCE NE S'EMPILE PAS
 * ======================================================================== */
async function pasDEmpilement() {
  console.log('\n-- deux tours ne se marchent pas dessus --');
  remise(sains());
  const [x, y] = await Promise.all([C.tour(), C.tour()]);
  const v = C.vue();
  console.log('   appels pools apres deux appels simultanes : ' + appels.pools);
  ok(appels.pools === 3,
     'le second tour lance en meme temps ne relance pas les lectures (' + appels.pools + ' pages, pas 6)');
  ok(v.positions.length <= 6, 'et aucune position n est ouverte en double (' + v.positions.length + ')');
  const adr = v.positions.map((p) => p.sym);
  ok(new Set(adr).size === adr.length, 'un jeton ne peut porter qu une position a la fois');
}


/* ==========================================================================
 * 12. LA SURVEILLANCE : ON NE REPAIE PAS DEUX FOIS LE MEME JETON
 *
 * « Je vois qu'il scanne souvent le même. S'il a déjà scanné, ça sert à rien
 *   de l'analyser en boucle. Peut-être le mettre dans une case surveillance
 *   s'il a un potentiel. »
 *
 * C'etait exact, et ca coutait le budget entier : les memes jetons repassaient
 * l'analyse complete a chaque tour — trois appels reseau chacun — pendant que
 * des jetons jamais vus attendaient. Ce qui se mesure ici n'est pas que la
 * colonie « se souvient » : c'est qu'elle DEPENSE MOINS au second tour.
 * ======================================================================== */
async function surveillance() {
  console.log('\n-- on ne repaie pas deux fois le meme jeton --');
  remise(sains());
  await C.tour();
  const t1 = { goplus: appels.goplus, chaine: appels.rpc, trades: appels.trades };
  const vus1 = C.vue().candidats.length;
  console.log('   1er tour : ' + vus1 + ' jetons examines · ' + JSON.stringify(t1));

  /* Deuxieme tour, meme monde : rien n'a bouge, rien ne merite d'etre repaye. */
  const av = Object.assign({}, appels);
  await C.tour();
  const t2 = { goplus: appels.goplus - av.goplus, chaine: appels.rpc - av.rpc,
               trades: appels.trades - av.trades };
  const v = C.vue();
  console.log('   2e tour  : ' + v.candidats.length + ' jetons examines · ' + JSON.stringify(t2));
  /* Sept jetons, un budget d'appels qui en couvre six : le second tour ne
     paie QUE le septieme — jamais les six deja juges. C'est exactement le
     defaut signale, et il se mesure en appels. */
  const dejaJuges = vus1;
  ok(t2.goplus <= 1 && t2.trades <= 1,
     'au second tour, le budget ne repaie pas les ' + dejaJuges + ' jetons deja juges : '
     + t2.goplus + ' appel(s) de securite au lieu de ' + t1.goplus);
  ok(v.candidats.length < vus1,
     'et il examine ' + v.candidats.length + ' jeton(s) au lieu de ' + vus1
     + ' — ceux que le budget du premier tour n avait pas atteints');
  ok(!v.candidats.some((c) => c.sym === 'TOK0'),
     'le premier jeton du tour precedent n est pas repasse a l analyse');
  ok(v.evites.length > 0,
     v.evites.length + ' jeton(s) ecartes sans un appel, et la raison est ecrite (« '
     + (v.evites[0] || {}).pourquoi + ' »)');
  ok((v.compteurs.reexamensEvites || 0) > 0,
     'le compteur des reexamens evites monte (' + v.compteurs.reexamensEvites + ')');

  /* ---- MAIS UN SIGNAL GRATUIT QUI BOUGE LE RAMENE ----
   * La liquidite vient du flux des pools, qu'on lit de toute facon : le
   * re-examen ne coute rien a DECIDER. */
  MONDE.jetons[0].liq = MONDE.jetons[0].liq * 2;
  const d = C.doitExaminer({ addr: MONDE.jetons[0].addr, liq: MONDE.jetons[0].liq,
                             prix: MONDE.jetons[0].prix });
  console.log('   liquidite doublee → ' + JSON.stringify(d));
  ok(d.oui && /liquidite/.test(d.pourquoi),
     'un jeton dont la liquidite a double revient a l examen (« ' + d.pourquoi + ' »)');

  /* ---- ET UN CONTRAT PIEGE NE REVIENT JAMAIS ----
   * Le refus portait sur le CONTRAT, pas sur un etat : rien ne changera. */
  remise([jeton(0, { goplus: 'honeypot' }), jeton(1)]);
  await C.tour();
  const banni = C._etat().connus[MONDE.jetons[0].addr];
  console.log('   honeypot : ' + JSON.stringify({ permanent: banni && banni.permanent, verdict: banni && banni.verdict }));
  ok(!!banni && banni.permanent === true, 'un honeypot est BANNI, pas mis en surveillance');
  const dd = C.doitExaminer({ addr: MONDE.jetons[0].addr, liq: 1e9, prix: 1e9 });
  ok(!dd.oui, 'et meme avec une liquidite mille fois plus grande, il ne revient pas (« ' + dd.pourquoi + ' »)');

  /* Alors qu un refus sur un ETAT laisse la porte ouverte. */
  const faible = C._etat().connus[MONDE.jetons[1].addr];
  ok(!faible || !faible.permanent,
     'un refus qui porte sur un etat — et non sur le contrat — ne bannit pas');
}

/* ==========================================================================
 * 13. TROIS FLUX, ET PAS LA MEME POPULATION
 * ======================================================================== */
async function troisFlux() {
  console.log('\n-- plusieurs sources de jetons --');
  const p = jeton(7, { minutes: 5 }), b = jeton(8, { minutes: 6 });
  remise([jeton(0), jeton(1), p, b], { profils: [p.addr], boosts: [b.addr] });
  /* Le monde connait les quatre jetons, mais le flux des pools n'en sert que
     deux : les deux autres n'ont QUE leur propre flux pour arriver. Sans ce
     filtre, l'essai ne mesurerait rien — les pools les auraient amenes seuls. */
  poolsPageFiltre = MONDE.jetons.slice(0, 2).map((x) => x.addr);
  await C.tour();
  poolsPageFiltre = null;
  const v = C.vue();
  const syms = v.candidats.map((x) => x.sym);
  const orig = {};
  for (const c of v.candidats) orig[c.origine] = (orig[c.origine] || 0) + 1;
  console.log('   examines : ' + JSON.stringify(syms) + ' · origines : ' + JSON.stringify(orig));
  ok(appels.profils >= 1 && appels.boosts >= 1, 'les deux flux DexScreener sont lus');
  ok(syms.indexOf('TOK7') >= 0, 'un jeton que SEUL le flux des profils connait arrive quand meme');
  ok(syms.indexOf('TOK8') >= 0, 'et un jeton que seul le flux des pousses connait aussi');
  ok(Object.keys(orig).length >= 2,
     'les jetons portent l origine qui les a trouves : ' + JSON.stringify(orig));

  /* L origine est un TRAIT : la colonie apprendra lequel des trois flux paie. */
  const tr = C.traitsDe({ origine: 'profils', minutes: 5, liq: 9000, prix: 1, tx: {}, vol: {} });
  ok(/profils/.test(tr.scout.origine),
     'et c est un trait du Scout, donc une chose qu il APPREND : « ' + tr.scout.origine + ' »');
}

/* ==========================================================================
 * 14. LES LECTURES PARESSEUSES, ET L ORDRE QUI EN DECOULE
 *
 * « Ils peuvent changer l'ordre s'ils pensent que les services seraient mieux
 *   dans un autre ordre. »
 *
 * Ce n'est un pouvoir que si l'ordre change quelque chose. Il change ceci :
 * on ne paie les donnees d'un garde que si le jeton arrive jusqu'a lui, donc
 * un refus precoce fait economiser tous les appels d'apres. L'essai le mesure
 * en appels, pas en intentions.
 * ======================================================================== */
async function paresse() {
  console.log('\n-- un refus precoce fait economiser les appels d apres --');
  remise([jeton(0, { goplus: 'honeypot' })]);
  await C.tour();
  const c = C.vue().candidats[0];
  console.log('   ' + JSON.stringify({ refus: c.refus, par: c.quiRefuse, appels: c.appels,
    goplus: appels.goplus, rpc: appels.rpc, trades: appels.trades, ohlcv: appels.ohlcv }));
  ok(appels.goplus === 1, 'le premier garde a bien paye son appel');
  ok(appels.trades === 0 && appels.ohlcv === 0,
     'mais les services des gardes SUIVANTS ne sont jamais appeles : le jeton est deja refuse');
  ok(c.appels === 1, 'un seul appel pour ce jeton, au lieu de quatre (' + c.appels + ')');

  console.log('\n-- et la colonie reordonne sur ce qu elle a mesure --');
  C._pose(C.etatNeuf());
  const E = C._etat();
  /* Des relevés : le Whale refuse la moitie de ce qu il voit, le Warden un
     jeton sur vingt. A cout egal, le Whale doit passer devant. */
  E.compteurs = { wardenVu: 100, wardenBloque: 5, whaleVu: 100, whaleBloque: 50,
                  whisperVu: 100, whisperBloque: 20 };
  const avant = C.gardesEnOrdre().map((a) => a.key).join(' → ');
  const bouge = C.revoitOrdre(true);
  const apres = C.gardesEnOrdre().map((a) => a.key).join(' → ');
  console.log('   avant : ' + avant + '\n   apres : ' + apres);
  ok(bouge === true, 'l ordre a change');
  ok(apres.indexOf('whale') < apres.indexOf('warden'),
     'le garde qui refuse le plus pour le meme prix passe devant (' + apres + ')');
  /* ---- DEUX PLACES QUI NE SE NEGOCIENT PAS ----
   * L'Oracle apres tous les gardes : sa note se sert de ce que les autres ont
   * fait lire. Le Cobaye apres l'Oracle : son epreuve coute des appels et ne
   * sert que sur un jeton qu'on s'apprete a acheter. Le reste de l'ordre, lui,
   * appartient aux agents. */
  const cles = C.gardesEnOrdre().map((a) => a.key);
  ok(cles.indexOf('oracle') > Math.max(cles.indexOf('warden'), cles.indexOf('whale'),
                                       cles.indexOf('whisper')),
     'et l Oracle reste apres tous les gardes : sa note se sert de ce que les autres ont fait lire');
  ok(cles[cles.length - 1] === 'cobaye',
     'et le Cobaye tout a la fin : « avant le gros achat » veut dire apres tous les autres '
     + 'controles, sinon on paie son epreuve pour des jetons que le Whale allait refuser');
  const j = E.journalStructure[0];
  console.log('   journal : ' + (j && j.txt));
  ok(!!j && j.quoi === 'ordre' && /whale/.test(j.txt),
     'le changement est ecrit, avec les chiffres qui l ont decide');
  ok(!!j.chiffres && j.chiffres.some((x) => /%/.test(String(x.refus))),
     'et ces chiffres sont les taux de refus mesures, pas une justification apres coup');

  /* ---- ON NE REORDONNE PAS SUR DU BRUIT ---- */
  C._pose(C.etatNeuf());
  C._etat().compteurs = { wardenVu: 3, wardenBloque: 3, whaleVu: 2, whaleBloque: 0, whisperVu: 2, whisperBloque: 0 };
  ok(C.revoitOrdre(true) === false,
     'sur trois jetons vus, rien ne bouge : reordonner sur du bruit, c est du bruit');

  /* ---- ET UN GARDE PLACE EN DERNIER NE VOIT PRESQUE RIEN ----
   * Releve sur deux tours reels : Warden et Whale avaient vu vingt jetons,
   * le Whisper — dernier — en avait vu DEUX. Exiger le meme echantillon de
   * tout le monde revenait a lui demander ses preuves sur une place qu'on ne
   * lui donnera jamais : l'ordre etait gele pour toujours, et rien ne le
   * disait. On promeut ce qui est mesure, on ne retrograde pas sur une
   * absence de mesure. */
  console.log('\n-- un garde qui n a rien vu ne gele pas l ordre --');
  C._pose(C.etatNeuf());
  const D = C._etat();
  D.compteurs = { wardenVu: 60, wardenBloque: 1, whaleVu: 60, whaleBloque: 40, whisperVu: 2, whisperBloque: 0 };
  const bouge2 = C.revoitOrdre(true);
  const ordre2 = C.gardesEnOrdre().map((a) => a.key).join(' → ');
  console.log('   whisper n a vu que 2 jetons → ' + ordre2);
  ok(bouge2 === true, 'l ordre bouge quand meme');
  ok(ordre2.indexOf('whale') < ordre2.indexOf('warden'),
     'les deux gardes mesures sont classes sur leur releve (' + ordre2 + ')');
  ok(ordre2.indexOf('whisper') > ordre2.indexOf('warden'),
     'et celui qui n a rien vu reste derriere, sans bloquer les autres');
}

/* ==========================================================================
 * 15. LE BANQUIER
 * ======================================================================== */
async function banquier() {
  console.log('\n-- la mise s adapte a la caisse --');
  C._pose(C.etatNeuf());
  const E = C._etat();
  const m1 = C.miseDe(70);
  E.tresor = 300;
  const m2 = C.miseDe(70);
  E.tresor = 4000;
  const m3 = C.miseDe(70);
  console.log('   caisse 1000 → $' + m1.mise + ' · caisse 300 → $' + m2.mise + ' · caisse 4000 → $' + m3.mise);
  ok(m2.mise < m1.mise && m3.mise > m1.mise,
     'elle monte et descend AVEC la caisse — une mise fixe sur une caisse qui fond est une part qui grossit');
  ok(m1.mise / 1000 <= C.MISE_PART_MAX + 1e-9,
     'et jamais plus de ' + (C.MISE_PART_MAX * 100) + ' % de la caisse sur un seul jeton');

  console.log('\n-- les bornes ne s apprennent pas --');
  /* ---- LE CAS QUI COMPTE ----
   * Kelly est la seule methode qui puisse reclamer une grosse part, et il la
   * reclame quand le releve est bon : neuf gagnantes sur dix, et des gains
   * trois fois plus gros que les pertes. La formule sort 87 %, on en prend le
   * quart — 22 % — et la borne doit ramener a 8 %. C'est precisement le
   * moment ou un systeme qui apprend se ruine, et le seul moyen de ne pas s'y
   * ruiner est que la borne ne soit pas negociable. */
  C._pose(C.etatNeuf());
  const K = C._etat();
  K.tresor = 1000;
  K.banque.memoire.__global = { n: 40, gagnantes: 36, sommeGains: 36 * 30, sommePertes: 4 * 10 };
  K.banque.memoire['kelly|autour du depart'] = { n: 40, s: 40 * 25, s2: 0 };
  const st = C.statsRendement();
  const brut = (st.p * st.b - (1 - st.p)) / st.b / 4;
  const fou = C.miseDe(100);
  console.log('   Kelly au quart reclame ' + (brut * 100).toFixed(0) + ' % → mise $' + fou.mise
    + ' (' + fou.raison + ')');
  ok(brut > C.MISE_PART_MAX,
     'Kelly reclame ' + (brut * 100).toFixed(0) + ' %, bien au-dessus de la borne de '
     + (C.MISE_PART_MAX * 100) + ' %');
  ok(fou.methode === 'kelly', 'et c est bien Kelly qui a ete retenu, sur son releve');
  ok(Math.abs(fou.mise - 1000 * C.MISE_PART_MAX) < 0.01,
     'la mise est ramenee a la borne : $' + fou.mise + ' et pas $' + Math.round(brut * 1000));
  ok(/borne/.test(fou.raison), 'et la raison le DIT : « ' + fou.raison + ' »');

  console.log('\n-- l exposition totale est bornee, elle aussi --');
  C._pose(C.etatNeuf());
  const F = C._etat();
  F.positions = [{ adr: '0x1', mise: 290 }];
  const serre = C.miseDe(70);
  console.log('   $290 deja engages sur 1000 → ' + JSON.stringify({ mise: serre.mise, raison: serre.raison }));
  ok(serre.mise === 0 || (290 + serre.mise) <= 1000 * C.EXPO_PART_MAX + 1e-9,
     'la somme engagee ne depasse pas ' + (C.EXPO_PART_MAX * 100) + ' % de la caisse');
  ok(/exposition|plus de place/.test(serre.raison), 'et la raison le nomme : « ' + serre.raison + ' »');

  console.log('\n-- sous le plancher, il arrete d ouvrir --');
  F.positions = [];
  F.tresor = 60;
  const stop = C.miseDe(90);
  console.log('   caisse $60 → ' + JSON.stringify(stop));
  ok(stop.mise === 0 && stop.arret === true,
     'a $60 il n ouvre plus rien : « ' + stop.raison + ' »');
  ok(/plancher/.test(stop.raison), 'et il dit que c est le plancher, pas une panne');

  console.log('\n-- il apprend quelle methode a paye, en POURCENTAGE --');
  C._pose(C.etatNeuf());
  const G = C._etat();
  /* Deux methodes, memes conditions. « part » gagne largement. */
  for (let i = 0; i < 10; i++) {
    G.tresor = 1000;
    C.banquierApprend({ methode: 'part', regime: 'autour du depart' }, 12);
    C.banquierApprend({ methode: 'fixe', regime: 'autour du depart' }, -6);
  }
  const ch = C.methodeApprise();
  console.log('   ' + JSON.stringify(ch));
  ok(ch.methode === 'part' && ch.appris === true,
     'il retient la methode dont le releve est le meilleur dans ce regime (' + ch.methode + ')');
  ok(ch.n >= 5, 'et seulement au-dela de quelques observations (' + ch.n + ')');

  /* Le regime compte : une methode bonne au-dessus du depart n est pas
     forcement celle qui ramene d un creux. */
  G.tresor = 700; G.banque.pic = 1000;
  console.log('   caisse 700 apres un pic a 1000 → regime « ' + C.regime() + ' »');
  ok(C.regime() === 'en creux', 'un creux de 30 % est un regime a part');
  ok(C.methodeApprise().appris === false,
     'et dans ce regime-la il n a encore rien appris : il ne recopie pas le releve d un autre regime');

  console.log('\n-- Kelly ne calcule pas sans releve --');
  C._pose(C.etatNeuf());
  ok(C.statsRendement() === null, 'sans historique, il n y a pas de taux de reussite a donner a Kelly');
  const k = C.miseDe(70);
  C._etat().banque.methode = 'kelly';
  const k2 = C.miseDe(70);
  ok(k2.mise > 0, 'il ne fabrique pas de probabilites : il retombe sur la part de base ($' + k2.mise + ')');
}

/* ==========================================================================
 * 16. LE VETO QUE SEULS LES TRADES PERMETTENT
 * ======================================================================== */
async function lavage() {
  console.log('\n-- un seul portefeuille qui fait tout le volume --');
  remise([jeton(0, { lavage: true, tradeurs: 1 }), jeton(1)]);
  await C.tour();
  const v = C.vue();
  const c = v.candidats.find((x) => x.sym === 'TOK0');
  console.log('   ' + JSON.stringify({ acheteurs: c && c.acheteurs, part: c && c.partDuPlusGros,
                                       refus: c && c.refus, par: c && c.quiRefuse }));
  ok(!!c && c.tradesVus, 'les trades ont ete lus un par un');
  ok(!!c && c.partDuPlusGros >= 85,
     'un seul portefeuille porte ' + (c && c.partDuPlusGros) + ' % du volume');
  ok(!!c && /portefeuille fait/.test(String(c.refus)),
     'le Whisper refuse, et il nomme ce qu il a vu : « ' + (c && c.refus) + ' »');
  ok(!v.positions.some((p) => p.sym === 'TOK0'), 'aucune position ne s ouvre dessus');
  /* Et l autre, dont le volume est reparti, passe le meme controle. */
  const sain = v.candidats.find((x) => x.sym === 'TOK1');
  ok(!!sain && !/portefeuille/.test(String(sain.refus)),
     'alors qu un jeton dont le volume est reparti passe ce controle-la');
}

/* ==========================================================================
 * 17. ILS SE MULTIPLIENT — QUAND ILS ONT UNE RAISON, ET PAS AUTREMENT
 *
 * « S'ils ont besoin de plus d'agents ils peuvent s'auto-développer, se
 *   multiplier, ou plus de maisons. »
 *
 * La raison ne peut pas etre « ca fait joli ». Elle est mesuree : une case
 * tres observee mais tres dispersee ne predit rien — il n'y a pas une
 * population dedans, il y en a deux, et la coupe passe au milieu.
 * ======================================================================== */
async function multiplication() {
  console.log('\n-- un agent engendre un specialiste --');
  C._pose(C.etatNeuf());
  const E = C._etat();
  ok(C.engendre() === null, 'sans releve, personne ne nait : il n y a aucune raison');

  /* Une case du Whale : vingt observations, resultats partout. */
  for (let i = 0; i < 20; i++) C.apprendAgent('whale', { top: 'top 15-30%' }, i % 2 ? 45 : -40);
  const c = E.memoire.whale.top['top 15-30%'];
  console.log('   case « top 15-30% » : ' + c.n + ' obs, moyenne '
    + (c.s / c.n).toFixed(1) + ' %, ecart type ' + C.ecartType(c).toFixed(1));
  ok(C.ecartType(c) > C.ECART_TYPE_BRUIT,
     'sa moyenne est proche de zero mais son ecart type est enorme : elle ne predit rien');

  const petit = C.engendre();
  console.log('   ne : ' + (petit && petit.nom) + ' · traits ' + JSON.stringify(petit && petit.traits));
  ok(!!petit, 'un specialiste nait');
  ok(petit.role === 'specialiste' && petit.parent === 'whale',
     'il est rattache a l agent dont la case etait floue (' + petit.parent + ')');
  ok(Array.isArray(petit.traits[0]) && petit.traits[0][0] === 'top',
     'et son trait est un CROISEMENT de la case floue avec un second trait : ' + JSON.stringify(petit.traits[0]));
  /* Le point qui compte : il ne doit pas couter un appel de plus. */
  const parent = E.roster.find((a) => a.key === 'whale');
  console.log('   cout du parent ' + C.coutDe(parent, null) + ' · cout du petit ' + C.coutDe(petit, null));
  ok(C.coutDe(petit, null) <= C.coutDe(parent, null),
     'il ne coute AUCUN appel de plus : il recoupe des donnees deja payees');
  ok(!!E.journalStructure.find((x) => x.quoi === 'naissance'),
     'sa naissance est ecrite, avec le chiffre qui l a decidee');

  /* ---- ET IL EST DANS LE ROSTER, DONC IL APPREND ---- */
  const t = { addr: '0xz', minutes: 5, liq: 9000, prix: 1, mc: 1e5, tx: {}, vol: {},
              chaine: { vu: true, montantsLus: true, porteurs: 40, top: 20, brule: 0 } };
  const tr = C.traitsDe(t);
  console.log('   ses cases sur un jeton : ' + JSON.stringify(tr[petit.key]));
  ok(!!tr[petit.key] && Object.keys(tr[petit.key]).length === 1,
     'il lit sa propre case sur chaque jeton');
  ok(/×/.test(Object.values(tr[petit.key])[0]),
     'et cette case est bien un croisement : « ' + Object.values(tr[petit.key])[0] + ' »');
  ok(C.vue().roster.some((a) => a.key === petit.key),
     'la vue le publie : la page dessinera une maison de plus, sans qu aucun nombre soit ecrit en dur');

  console.log('\n-- mais un petit qui ne coupe pas mieux est retire --');
  /* On lui donne des cases aussi dispersees que celles de son parent. */
  for (let i = 0; i < 16; i++)
    C.apprendAgent(petit.key, { [Object.keys(tr[petit.key])[0]]: 'flou' }, i % 2 ? 60 : -55);
  const parti = C.elague();
  console.log('   retire : ' + (parti && parti.nom));
  ok(!!parti && parti.key === petit.key, 'il est retire');
  ok(!C._etat().roster.some((a) => a.key === petit.key), 'et il ne figure plus au roster');
  ok(!C._etat().memoire[petit.key], 'sa memoire part avec lui : elle ne pese plus sur les notes');
  const jr = C._etat().journalStructure.find((x) => x.quoi === 'retrait');
  ok(!!jr && /ecart type/.test(jr.txt), 'le retrait est ecrit, avec la comparaison : « ' + (jr && jr.txt) + ' »');

  console.log('\n-- et la colonie ne peut pas exploser --');
  C._pose(C.etatNeuf());
  const F = C._etat();
  for (let i = 0; i < 40; i++) C.apprendAgent('whale', { top: 'top 15-30%' }, i % 2 ? 45 : -40);
  let nes = 0;
  for (let i = 0; i < 20; i++) if (C.engendre()) nes++;
  console.log('   naissances tentees 20 · obtenues ' + nes
    + ' · specialistes au roster ' + F.roster.filter((a) => a.role === 'specialiste').length);
  ok(F.roster.filter((a) => a.role === 'specialiste').length <= C.ENFANTS_MAX,
     'jamais plus de ' + C.ENFANTS_MAX + ' specialistes : « ils se multiplient » ne veut pas dire trois cents agents');
}

/* ==========================================================================
 * 18. LES SERVICES, ET CEUX QUI NE MARCHENT PAS
 * ======================================================================== */
async function services() {
  console.log('\n-- chaque service porte son releve --');
  remise(sains());
  await C.tour();
  const v = C.vue();
  const parCle = {};
  for (const s of v.services) parCle[s.cle] = s;
  console.log('   ' + v.services.filter((s) => s.essais)
    .map((s) => s.cle + ' ' + s.reussites + '/' + s.essais).join(' · '));
  ok(v.services.length === Object.keys(C.SERVICES).length,
     'les ' + v.services.length + ' services sont publies, avec ce que chacun apporte');
  ok(parCle.pools.reussites > 0 && parCle.chaine.reussites > 0,
     'et leur releve est celui des vrais appels, pas une declaration');
  ok(v.services.every((s) => s.quoi && s.quoi.length > 5),
     'chacun dit ce qu il apporte, en francais : un nom d API ne renseigne personne');

  console.log('\n-- une source qui tombe est nommee, pas passee sous silence --');
  const av = C._etat().services.goplus.reussites;
  MONDE.goplusCasse = true;
  remise(sains());
  MONDE.goplusCasse = true;
  await C.tour();
  const s = C.vue().services.find((x) => x.cle === 'goplus');
  console.log('   goplus : ' + JSON.stringify({ essais: s.essais, reussites: s.reussites, echec: s.dernierEchec }));
  ok(s.essais > s.reussites, 'ses echecs sont comptes');
  ok(!!s.dernierEchec, 'et le dernier est garde en clair : « ' + s.dernierEchec + ' »');

  console.log('\n-- et celles qui ne marcheront jamais ici sont nommees aussi --');
  const hs = C.vue().horsService;
  console.log('   ' + Object.keys(hs).join(', '));
  ok(!!hs.gmgn && /Cloudflare/.test(hs.gmgn),
     'GMGN est nomme avec la raison MESUREE : « ' + hs.gmgn.slice(0, 70) + '… »');
  ok(/y compris sur ethereum/.test(hs.gmgn),
     'et la raison distingue « protection anti-robot » de « ne connait pas la chaine 4663 »');
  ok(Object.keys(hs).length >= 3,
     'les trois services essayes sans succes restent ecrits, pour qu on ne les re-essaie pas dans six mois');
}


/* ==========================================================================
 * 19. UNE POSITION DONT LE JETON A QUITTE LE FLUX
 *
 * Les flux ne servent que du NEUF. Une position tenue quarante minutes voit
 * son jeton en sortir avant d'etre reglee — et il n'y avait alors plus aucun
 * prix pour elle. Elle restait ouverte pour toujours, affichant « prix non
 * relu », et gardait une des six places. Six positions coincees, et la colonie
 * cesse d'acheter : aucune erreur nulle part, un ecran parfaitement normal, et
 * plus rien qui se passe. C'est le genre de panne qu'on ne voit qu'en comptant
 * les jours.
 * ======================================================================== */
async function jetonSorti() {
  console.log('\n-- le jeton d une position ouverte sort du flux --');
  remise(sains());
  await C.tour();
  const E = C._etat();
  const n = E.positions.length;
  ok(n > 0, n + ' position(s) ouverte(s)');

  /* Le temps passe, et les jetons de ces positions ne sont plus des jetons
     neufs : plus aucun flux ne les sert. Ils existent toujours — DexScreener
     repond encore a leur adresse — mais plus personne ne les propose. */
  for (const p of E.positions) p.t0 = Date.now() - 3 * 3600e3;
  const anciens = E.positions.map((p) => p.adr);
  const restants = MONDE.jetons.filter((t) => anciens.indexOf(t.addr) < 0);
  MONDE.jetons = MONDE.jetons.map((t) => anciens.indexOf(t.addr) >= 0
    ? Object.assign({}, t, { minutes: 5000, prix: t.prix * 1.5 })   /* trop vieux pour les flux */
    : t);
  for (const k of Object.keys(C._cache.dex)) delete C._cache.dex[k];
  for (const k of Object.keys(C._cache.chaine)) delete C._cache.chaine[k];

  await C.tour();
  const v = C.vue();
  console.log('   positions restantes : ' + v.positions.length + ' · trades ' + v.trades
    + ' · prix de secours ' + (v.compteurs.prixDeSecours || 0));
  ok((v.compteurs.prixDeSecours || 0) > 0,
     'leur prix est alle etre cherche a l adresse, une par une (' + v.compteurs.prixDeSecours + ')');
  ok(v.trades > 0, 'et elles se reglent (' + v.trades + ') au lieu de rester coincees pour toujours');
  ok(v.tresor > C.DEPART,
     'au prix REEL relu a l adresse, pas extrapole depuis l ancien : $' + v.tresor.toFixed(2));

  /* Et le secours est PLAFONNE : il ne doit pas manger le budget d'appels du
     tour au point qu'on n'examine plus aucun jeton neuf. */
  console.log('\n-- mais ce secours est plafonne --');
  /* `remise` remet l'etat a neuf : poser les positions AVANT reviendrait a les
     effacer, et l'essai mesurerait zero en se felicitant d'etre sous la borne.
     On remet le monde d'abord, on peuple ensuite. */
  remise(sains());
  const F = C._etat();
  for (let i = 0; i < 6; i++) F.positions.push({
    sym: 'ORPHELIN' + i, adr: '0x' + String(i).repeat(40), pool: '0xpp' + i,
    /* `prixLu` frais : ces positions-la sont vieilles mais SUIVIES — c'est le
       secours qui les cote. Sans ce champ, la passe d'abandon les emporterait
       en tete de tour et l'essai ne mesurerait plus le plafond du secours. */
    prix0: 1, t0: Date.now() - 3 * 3600e3, prixLu: Date.now(),
    mise: 30, traits: {}, tenueMin: 20, traj: [] });
  ok(F.positions.length === 6, 'six positions dont AUCUN jeton n est dans les flux');
  await C.tour();
  const utilises = C._etat().compteurs.prixDeSecours || 0;
  console.log('   six positions orphelines → ' + utilises + ' prix de secours demandes');
  ok(utilises > 0, 'le secours est bien declenche (' + utilises + ')');
  ok(utilises <= 4,
     'mais au plus quatre par tour : le reste attendra le tour suivant, plutot que de manger '
     + 'le budget d appels des jetons neufs');
  ok(C.vue().candidats.length > 0,
     'et des jetons neufs sont examines quand meme dans le meme tour ('
     + C.vue().candidats.length + ')');
}


/* ==========================================================================
 * 20. DEUX NOEUDS, PARCE QU'UN SEUL COUPE
 *
 * Mesure sur le noeud officiel : quatre refus « Too Many Requests » sur six
 * lectures a la file. C'est la contrainte qui limitait le nombre de jetons
 * lisibles par tour — et un refus rendait « inconnu », c'est-a-dire un jeton
 * ecarte pour une raison qui n'a rien a voir avec lui.
 *
 * Un second noeud public a ete cherche et trouve, sans cle. Il a sa propre
 * limite — dix mille blocs par lecture de journaux, soit dix-sept minutes de
 * cette chaine — donc il n'est pas candidat pour tout, et on ne lui envoie
 * pas une demande qu'on sait refusee.
 * ======================================================================== */
async function deuxNoeuds() {
  /* ==================================================================
   * CE QUE L'AGE MINIMUM D'ACHAT A CHANGE ICI
   *
   * Le noeud de secours plafonne a dix mille blocs, soit dix-sept minutes de
   * cette chaine. Il couvrait donc la vie ENTIERE d'un jeton de douze minutes,
   * et c'est ce relais que cet essai mesurait.
   *
   * Depuis qu'on n'achete plus rien avant deux heures, ce cas n'existe plus :
   * un jeton qu'on daigne examiner demande cent mille blocs, et le secours
   * n'est meme pas candidat. Il ne sert donc plus AUCUNE lecture de blocs —
   * seulement les methodes sans plage : le numero de bloc, et l'appel du
   * Cobaye. C'est une consequence reelle de la regle d'age, pas un defaut, et
   * elle vaut d'etre ecrite : le noeud officiel est devenu le seul a pouvoir
   * compter les porteurs.
   *
   * Ce qui doit rester vrai quand il sature : on rend « inconnu », jamais un
   * compte ampute. Un faux compte se propage — le Whale y lit une
   * concentration, l'agent l'apprend, et la lecon est fausse pour tous les
   * jetons qui partagent le trait.
   * ================================================================== */
  console.log('\n-- le noeud officiel sature --');
  remise([0, 1, 2, 3, 4, 5].map((i) => jeton(i, { minutes: 180 })), { rpcSature: true });
  await C.tour();
  const v = C.vue();
  console.log('   appels : officiel ' + appels.rpc + ' · secours ' + appels.rpc2);
  const lus = v.candidats.filter((c) => c.chaineVue).length;
  console.log('   jetons dont la chaine a quand meme ete lue : ' + lus + '/' + v.candidats.length);
  ok(appels.rpc2 > 0,
     'le second noeud prend le relais sur ce qu il PEUT servir — le numero de bloc n a pas de '
     + 'plage (' + appels.rpc2 + ' appels)');
  ok(lus === 0,
     'mais aucune chaine n est lue : sa limite de dix mille blocs ne couvre pas la vie d un '
     + 'jeton de trois heures, et on ne lit pas les derniers blocs en faisant comme si c etait '
     + 'tout');
  ok(v.candidats.length > 0 && v.candidats.every((c) => c.porteurs === null),
     'les porteurs restent « inconnu » plutot que faux : un compte ampute se propage a tous les '
     + 'jetons qui partagent le trait, et il ne se rattrape jamais');

  const s1 = v.services.find((x) => x.cle === 'chaine');
  const s2 = v.services.find((x) => x.cle === 'chaine2');
  console.log('   releve : officiel ' + s1.reussites + '/' + s1.essais
    + ' (' + s1.dernierEchec + ') · secours ' + s2.reussites + '/' + s2.essais);
  ok(s1.essais > s1.reussites && /sature/.test(String(s1.dernierEchec)),
     'la saturation de l officiel est comptee et NOMMEE, pas confondue avec une panne');
  ok(s2.reussites > 0, 'et le secours porte son propre releve : les deux sont des services distincts');

  /* Et quand il repond, tout se lit normalement : la saturation etait bien la
     cause, pas la regle d'age. */
  remise([0, 1].map((i) => jeton(i, { minutes: 180 })));
  await C.tour();
  const vv = C.vue();
  console.log('   officiel disponible : '
    + vv.candidats.filter((c) => c.chaineVue).length + '/' + vv.candidats.length + ' lus');
  ok(vv.candidats.length > 0 && vv.candidats.every((c) => c.chaineVue && c.porteurs !== null),
     'des que le noeud officiel repond, les porteurs sont comptes pour tous : c est bien la '
     + 'saturation qui bloquait, pas l age');

  console.log('\n-- mais on ne lui envoie pas ce qu il refusera --');
  /* Sa limite est connue : au-dela, il n'est pas candidat. Envoyer quand meme
     ferait un aller-retour pour rien, et surtout ferait passer un refus de
     format pour une saturation — donc une reprise qui echouera toujours. */
  remise(sains(), { rpcSature: true });
  let erreur = null;
  try {
    await C.tour();   /* les jetons sont jeunes : la plage tient dans la limite */
  } catch (e) { erreur = e; }
  ok(!erreur, 'un jeton de quelques minutes tient dans les dix mille blocs');
  const avant = appels.rpc2;
  /* Une plage volontairement enorme : aucun noeud ne peut, et ca doit se dire
     plutot que de partir en boucle de reprises. */
  let dit = null;
  try {
    await C._rpc('eth_getLogs', [{ address: '0xa', topics: [],
      fromBlock: '0x0', toBlock: '0x' + (500000).toString(16) }]);
  } catch (e) { dit = e.message; }
  console.log('   plage de 500 000 blocs → « ' + dit + ' »');
  ok(!!dit && /aucun noeud/.test(dit),
     'une plage que personne ne sert est refusee AVANT l appel, et la raison le dit');
  ok(appels.rpc2 === avant, 'et aucun appel inutile n a ete envoye au second noeud');
}


/* ==========================================================================
 * 21. UN PRIX SANS DATE MENT
 *
 * « Nos positions ouvertes ne bougent pas : +0.0 % · +$0.00 »
 *
 * Elles bougeaient. C'est le chiffre affiche qui ne bougeait pas. Une position
 * ecrivait son prix d'entree dans le cache des prix, et quand son jeton sortait
 * des flux — ce qui arrive toujours, ils ne servent que du neuf — plus rien ne
 * le remplacait. L'ecran affichait donc l'ecart entre le prix d'entree et le
 * prix d'entree : exactement zero, presente comme une cotation du moment.
 * C'est la pire forme du defaut que ce fichier traque : pas une absence, une
 * VALEUR, et une valeur rassurante.
 * ======================================================================== */
async function prixDate() {
  console.log('\n-- un prix garde sa date, sinon il ment --');
  remise(sains());
  await C.tour();
  const p = C.vue().positions[0];
  ok(p.latent !== null, 'juste apres la lecture, la position porte un ecart (' + p.latent + ' %)');
  ok(p.prixVu > 0, 'et la date du prix qui a servi a le calculer');

  /* On fait vieillir le prix sans en lire d'autre : c'est exactement ce qui se
     passe quand le jeton sort des flux. */
  const adr = C._etat().positions[0].adr;
  C._prix[adr].t = Date.now() - 40 * 60e3;
  const p2 = C.vue().positions[0];
  console.log('   prix vieux de 40 min → latent ' + JSON.stringify(p2.latent));
  ok(p2.latent === null,
     'un prix de quarante minutes ne fait plus une cotation : la vue rend « inconnu », pas « +0,0 % »');
  ok(C.prixFrais(adr) === null, 'et le moteur le dit aussi, au meme endroit');

  /* Un prix relu redonne un ecart. */
  C.posePrix(adr, C._etat().positions[0].prix0 * 1.2);
  ok(C.vue().positions[0].latent === 20,
     'et des qu un prix est relu, l ecart revient, juste (' + C.vue().positions[0].latent + ' %)');
}

/* ==========================================================================
 * 22. LE SOLDE A 500 MILLIONS
 *
 * « Il y a un bug, il a surement achete un honeypot, le solde est a 256
 *   millions. » — puis 500.
 *
 * Ce n'etait pas un achat, c'etait une DIVISION. Le rendement se calcule en
 * (prix - prix0) / prix0 : un jeton a tres faible decimale relu depuis une
 * autre source donne un rapport a plusieurs millions pour cent, et trente
 * dollars de mise deviennent des centaines de millions de papier. Aucun pool de
 * quatre mille dollars ne paie ca — le chiffre ne decrit rien.
 * ======================================================================== */
async function prixAberrant() {
  console.log('\n-- un prix inexploitable n est pas un gain --');
  remise(sains());
  const E = C._etat();
  E.positions.push({ sym: 'MINUSCULE', adr: '0xzz', pool: '0xpz', prix0: 1e-12,
    t0: Date.now() - 3600e3, mise: 30, traits: { whale: { top: 'top <5%' } },
    tenueMin: 20, tenueBase: 20, traj: [], liq0: 4000, score: 70 });
  const avantTresor = E.tresor;
  C.regle({ '0xzz': { prix: 0.001, liq: 4000 } });    /* un rapport a cent milliards pour cent */
  const v = C.vue();
  console.log('   tresorerie : ' + v.tresor + ' · flux : ' + (v.flux[0] || {}).txt);
  ok(v.tresor === avantTresor,
     'la tresorerie ne bouge pas d un centime : $' + v.tresor + ' — pas 500 millions');
  ok(v.trades === 1, 'la position est bien fermee (elle ne reste pas coincee)');
  ok(/inexploitable/.test((v.flux[0] || {}).txt),
     'et le fil DIT pourquoi rien n a ete compte : « ' + (v.flux[0] || {}).txt + ' »');
  ok((v.compteurs.prixAberrant || 0) === 1, 'le cas est compte, pour qu on sache que ca arrive');
  ok(!C._etat().memoire.whale,
     'et PERSONNE n en apprend rien : une lecon tiree d un chiffre faux se propage a tous les '
     + 'jetons qui partagent le trait');

  /* Un vrai dix-fois, lui, doit passer : la borne separe l invraisemblable du
     rare, pas le rare du courant. */
  remise(sains());
  const F = C._etat();
  F.positions.push({ sym: 'VRAI10X', adr: '0xy', pool: '0xpy', prix0: 1, t0: Date.now() - 3600e3,
    mise: 30, traits: {}, tenueMin: 20, tenueBase: 20, traj: [], liq0: 4000, score: 70 });
  C.regle({ '0xy': { prix: 6, liq: 4000 } });
  console.log('   un vrai +500 % → tresorerie ' + C.vue().tresor);
  ok(C.vue().tresor === C.DEPART + 30 * 5, 'un +500 % reel est comptabilise ($' + C.vue().tresor + ')');

  /* Et l alerte le signale. */
  remise(sains());
  C._etat().compteurs.prixAberrant = 3;
  const a = C.alertes().find((x) => /inexploitable/.test(x.quoi));
  ok(!!a && a.gravite === 'haute', 'et une alerte le remonte : « ' + (a && a.quoi) + ' »');
}

/* ==========================================================================
 * 23. « INVESTIS PAS DANS DES RUG PULL DEJA RUG »
 * ======================================================================== */
async function dejaRug() {
  console.log('\n-- un jeton deja vide n est meme pas examine --');
  remise([
    jeton(0, { mc: 2000, liq: 3000 }),          /* le cas signale : 2K de capitalisation... */
    jeton(1, { ch_h1: -70 }),
    jeton(2),
  ]);
  MONDE.jetons[0].volH1 = 9000;                  /* ...et un gros volume dessus */
  await C.tour();
  const v = C.vue();
  const par = {};
  for (const c of v.candidats) par[c.sym] = { refus: c.refus, qui: c.quiRefuse, appels: c.appels };
  console.log('   ' + JSON.stringify(par));
  ok(/sortie/.test(String((par.TOK0 || {}).refus)),
     'deux mille de capitalisation avec un gros volume dessus : « ' + (par.TOK0 || {}).refus + ' »');
  ok(/tombe de 70%/.test(String((par.TOK1 || {}).refus)),
     'un jeton deja tombe de 70 % en une heure est ecarte : « ' + (par.TOK1 || {}).refus + ' »');
  ok((par.TOK0 || {}).qui === 'scout' && (par.TOK1 || {}).qui === 'scout',
     'c est le Scout qui les ecarte — son controle ne coute aucun appel');
  ok((par.TOK0 || {}).appels === 0 && (par.TOK1 || {}).appels === 0,
     'et ils sont donc ecartes pour ZERO appel : le budget va aux jetons qui meritent un regard');
  ok(!v.positions.some((p) => p.sym === 'TOK0' || p.sym === 'TOK1'),
     'aucune position ne s ouvre dessus');
  ok(v.candidats.some((c) => c.sym === 'TOK2' && !c.refus), 'et le jeton sain passe');
}

/* ==========================================================================
 * 24. CE QUI N'EST PAS UN PORTEUR
 *
 * « Regarde holderscan aussi, pour comprendre ce qu'est un contrat, une adresse
 *   burn, que tu analyses mieux. »
 * ======================================================================== */
async function pasDesPorteurs() {
  console.log('\n-- une piscine, un contrat et une adresse de destruction ne detiennent pas --');
  remise([jeton(0, { porteurs: 40, secondePiscine: true }), jeton(1)]);
  await C.tour();
  const c = C.vue().candidats.find((x) => x.sym === 'TOK0');
  console.log('   ' + JSON.stringify({ porteurs: c && c.porteurs, top: c && c.top,
                                       ecartes: c && c.infra, participants: c && c.participants }));
  ok(!!c && c.infra >= 1,
     (c && c.infra) + ' adresse(s) ecartee(s) : elles echangent avec presque tout le monde, '
     + 'c est la forme d une piscine, pas celle d un porteur');
  ok(!!c && c.porteurs === 40,
     'les quarante vrais porteurs sont comptes, et eux seuls (' + (c && c.porteurs) + ')');
  ok(!!c && c.top !== null && c.top < 10,
     'la concentration reste juste : sans cette exclusion, la seconde piscine aurait paru tenir '
     + 'l essentiel du jeton (' + (c && c.top) + ' %)');
}

/* ==========================================================================
 * 25. LA SENTINELLE ET LE PROMOTEUR
 *
 * « Un agent en plus qui décide si on prolonge ou pas le trade, et un qui
 *   surveille chaque trade. Chaque agent doit apprendre et améliorer son propre
 *   travail, pas attendre le résultat final des trades. »
 * ======================================================================== */
async function veilleEtProlongation() {
  console.log('\n-- la Sentinelle coupe sans attendre le compte a rebours --');
  remise(sains());
  const E = C._etat();
  E.positions.push({ sym: 'CHUTE', adr: '0xc1', pool: '0xpc', prix0: 1, t0: Date.now() - 60e3,
    mise: 30, traits: {}, tenueMin: 20, tenueBase: 20, traj: [], liq0: 50000, score: 70 });
  E.positions.push({ sym: 'VIDANGE', adr: '0xc2', pool: '0xpd', prix0: 1, t0: Date.now() - 60e3,
    mise: 30, traits: {}, tenueMin: 20, tenueBase: 20, traj: [], liq0: 50000, score: 70 });
  C.regle({ '0xc1': { prix: 0.55, liq: 50000 },       /* -45 % : le sol se derobe */
            '0xc2': { prix: 1.02, liq: 9000 } });     /* le prix tient, la piscine se vide */
  const v = C.vue();
  const coupes = v.flux.filter((f) => /coupe/.test(f.txt));
  console.log('   ' + JSON.stringify(coupes.map((f) => f.txt)));
  ok(coupes.length === 2, 'les deux positions sont coupees AVANT la fin de leur tenue de 20 min');
  ok(coupes.some((f) => /chute de 45%/.test(f.txt)),
     'l une pour la chute : « ' + (coupes.find((f) => /chute/.test(f.txt)) || {}).txt + ' »');
  ok(coupes.some((f) => /piscine est passee/.test(f.txt)),
     'l autre pour la piscine qui se vide, alors que son PRIX allait bien : « '
     + (coupes.find((f) => /piscine/.test(f.txt)) || {}).txt + ' »');
  ok((v.compteurs.sentinelleCoupe || 0) === 2, 'ses coupes sont comptees a son nom');

  /* ---- ET ELLE APPREND DE SES ALERTES, PAS DU RESULTAT GLOBAL ---- */
  const m = C._etat().memoire.sentinelle || {};
  console.log('   ce qu elle retient : ' + JSON.stringify(m));
  ok(!!m.derive && !!m.liq,
     'elle retient ce qu elle a VU — l etat du prix et celui de la piscine — et non le rendement '
     + 'd une position dont elle ne repond pas');
  ok(m.liq['piscine divisee par 2'] && m.liq['piscine divisee par 2'].n === 1,
     'chaque signal porte son compte : « quand j ai vu la piscine divisee par deux, voila ce que '
     + 'ca a donne »');

  console.log('\n-- le Promoteur prolonge, et apprend de SA decision --');
  remise(sains());
  const F = C._etat();
  ok(C.veutProlonger({ prolonge: 0, score: 70 }, -5) === null, 'il ne prolonge jamais une perdante');
  ok(C.veutProlonger({ prolonge: 3, score: 70 }, 60) === null,
     'ni indefiniment : trois prolongations au plus');
  /* Sans releve il essaie une fois sur trois : assez pour apprendre, pas assez
     pour immobiliser la caisse — prolonger tout revenait a ne plus rien fermer,
     donc a ce que plus personne n apprenne rien. */
  let pris = 0;
  for (let i = 0; i < 9; i++) if (C.veutProlonger({ prolonge: 0, score: 70 }, 40)) pris++;
  console.log('   sur neuf fortes hausses, il en garde ' + pris);
  ok(pris === 3, 'une sur trois, sans releve (' + pris + '/9)');

  /* Avec un releve defavorable, il arrete. */
  const cas = C.casPromoteur({ prolonge: 0, score: 70 }, 40);
  for (let i = 0; i < 12; i++) C.apprendAgent('promoteur', cas, -25);
  ok(C.veutProlonger({ prolonge: 0, score: 70 }, 40) === null,
     'et quand son propre releve dit que prolonger coute -25 %, il cesse');
  const l = C.vue().agents.promoteur.lecons;
  console.log('   sa lecon : ' + JSON.stringify(l[0]));
  ok(l.length > 0 && l[0].n === 12,
     'sa lecon porte sur la DIFFERENCE qu il a faite, avec son nombre d observations');
}

/* ==========================================================================
 * 26. CHANGER DE STRATEGIE QUAND LA SIENNE NE PAIE PAS
 * ======================================================================== */
async function strategie() {
  console.log('\n-- trop de trades acceptes, et ca ne paie pas --');
  remise(sains());
  ok(C.seuilCourant() === C.SEUIL, 'le seuil part de ' + C.SEUIL);
  ok(C.revoitStrategie() === false, 'et rien ne bouge sans positions fermees');
  for (let i = 0; i < 14; i++) C.noteResultat(-7);
  ok(C.revoitStrategie() === true, 'apres quatorze positions perdantes, il bouge');
  console.log('   seuil : ' + C.SEUIL + ' → ' + C.seuilCourant());
  ok(C.seuilCourant() > C.SEUIL, 'la colonie se fait plus difficile (' + C.seuilCourant() + ')');
  const j = C._etat().journalStructure.find((x) => x.quoi === 'strategie');
  ok(!!j && /-7\.0 % en moyenne/.test(j.txt),
     'et le changement porte la mesure qui l a decide : « ' + (j && j.txt) + ' »');
  ok(C.vue().seuil === C.seuilCourant(),
     'la vue publie le seuil COURANT, pas celui du depart : sinon la page annoncerait une regle '
     + 'que la colonie n applique plus');

  console.log('\n-- et elle se rouvre quand ca paie --');
  for (let i = 0; i < 14; i++) C.noteResultat(9);
  const av = C.seuilCourant();
  C.revoitStrategie();
  console.log('   seuil : ' + av + ' → ' + C.seuilCourant());
  ok(C.seuilCourant() < av,
     'sans quoi le seuil ne pourrait que monter, et la colonie finirait par ne plus rien acheter');

  console.log('\n-- mais il ne part pas a la derive --');
  for (let k = 0; k < 40; k++) { for (let i = 0; i < 14; i++) C.noteResultat(-30); C.revoitStrategie(); }
  console.log('   apres quarante ajustements perdants : ' + C.seuilCourant());
  ok(C.seuilCourant() <= C.SEUIL_MAX, 'il est borne en haut (' + C.seuilCourant() + ')');
  for (let k = 0; k < 40; k++) { for (let i = 0; i < 14; i++) C.noteResultat(20); C.revoitStrategie(); }
  ok(C.seuilCourant() >= C.SEUIL_MIN, 'et en bas (' + C.seuilCourant() + ')');
}

/* ==========================================================================
 * 27. LE CONSEILLER
 * ======================================================================== */
async function conseiller() {
  console.log('\n-- sans cle, il est eteint, et c est dit --');
  delete process.env.ANTHROPIC_API_KEY;
  remise(sains());
  await C.tour();
  let v = C.vue();
  ok(v.conseiller.actif === false, 'il est eteint');
  ok(appels.claude === 0, 'aucun appel n est tente');
  ok(v.alertes.some((a) => /Conseiller est eteint/.test(a.quoi)),
     'et une alerte dit ce qu il faudrait pour l allumer : « '
     + (v.alertes.find((a) => /Conseiller/.test(a.quoi)) || {}).quoiFaire + ' »');
  ok(v.candidats.every((c) => !c.conseil), 'aucun jeton ne porte d avis');

  console.log('\n-- avec une cle, il n est consulte que sur les cas limites --');
  process.env.ANTHROPIC_API_KEY = 'cle-d-essai';
  /* ---- ENCORE FAUT-IL AVOIR DES CAS LIMITES ----
   * Les jetons du banc sain notent au-dessus de quatre-vingt-dix : ils ne sont
   * pas limites, ils sont evidents, et le Conseiller n'a rien a y arbitrer.
   * Il faut donc des jetons mediocres — peu de liquidite, peu de porteurs, un
   * GoPlus muet — c'est-a-dire exactement la population sur laquelle une note
   * ne tranche pas. */
  /* Mediocre, mais AU-DESSUS du plancher d'achat : une piscine de 3 000 $ est
     desormais ecartee par le Scout, donc le jeton n'atteindrait jamais
     l'Oracle et le Conseiller n'aurait rien a arbitrer. La mediocrite vient
     donc d'ou elle doit venir — peu de porteurs, un GoPlus muet, des
     compteurs faibles — et pas d'une piscine que la colonie refuse. */
  remise([0, 1, 2, 3].map((i) => jeton(i, { liq: 14000, mc: 60000, porteurs: 10,
    goplus: 'muet', buys: 6, sells: 5, buyers: 4, tradeurs: 4 })));
  MONDE.claude = { avis: 'favorable', points: 6, pourquoi: 'liquidite correcte et volume reparti' };
  await C.tour();
  v = C.vue();
  console.log('   appels a Claude : ' + appels.claude + ' · avis rendus : ' + v.conseiller.rendus);
  ok(appels.claude > 0, 'il est appele (' + appels.claude + ')');
  ok(appels.claude <= 3, 'au plus trois fois par tour : son cout est borne, comme le reste');
  const avec = v.candidats.filter((c) => c.conseil);
  ok(avec.length > 0, avec.length + ' jeton(s) portent son avis');
  ok(avec.every((c) => Math.abs(c.avis) <= 8),
     'et son avis pese au plus huit points, quoi qu il reponde');

  console.log('\n-- il ne peut pas lever un veto --');
  remise([jeton(0, { goplus: 'honeypot' })]);
  MONDE.claude = { avis: 'favorable', points: 8, pourquoi: 'tout va bien' };
  await C.tour();
  v = C.vue();
  console.log('   ' + JSON.stringify({ refus: v.candidats[0].refus, conseil: v.candidats[0].conseil }));
  ok(/honeypot/.test(String(v.candidats[0].refus)),
     'le contrat piege reste refuse, quoi qu il en dise');
  ok(v.positions.length === 0, 'et aucune position ne s ouvre');

  console.log('\n-- et une reponse abimee ne devient pas une donnee --');
  /* Mediocre, mais AU-DESSUS du plancher d'achat : une piscine de 3 000 $ est
     desormais ecartee par le Scout, donc le jeton n'atteindrait jamais
     l'Oracle et le Conseiller n'aurait rien a arbitrer. La mediocrite vient
     donc d'ou elle doit venir — peu de porteurs, un GoPlus muet, des
     compteurs faibles — et pas d'une piscine que la colonie refuse. */
  remise([0, 1, 2, 3].map((i) => jeton(i, { liq: 14000, mc: 60000, porteurs: 10,
    goplus: 'muet', buys: 6, sells: 5, buyers: 4, tradeurs: 4 })));
  MONDE.claude = 'PAS DU JSON DU TOUT';
  await C.tour();
  v = C.vue();
  const s = v.services.find((x) => x.cle === 'conseil');
  console.log('   service conseil : ' + JSON.stringify({ essais: s.essais, reussites: s.reussites,
    echec: s.dernierEchec }));
  ok(s.essais > s.reussites, 'l echec est compte');
  ok(/illisible/.test(String(s.dernierEchec)), 'et nomme : « ' + s.dernierEchec + ' »');
  ok(v.candidats.every((c) => !c.conseil), 'aucun avis n est retenu de ce qu on n a pas su lire');
  delete process.env.ANTHROPIC_API_KEY;
}

/* ==========================================================================
 * 28. UN ETAT FAUX SE JETTE
 * ======================================================================== */
async function remiseAZero() {
  console.log('\n-- l etat empoisonne par le bug est mis de cote --');
  remise(sains());
  /* Un etat tel qu'il etait : une tresorerie a cinq cents millions. */
  const vieux = Object.assign(C.etatNeuf(), { v: 2, tresor: 512000000, trades: 40, gains: 38,
    courbe: [1000, 512000000], meilleur: 17000000 });
  fs.writeFileSync(C.FICHIER, JSON.stringify(vieux));
  C._pose(C.etatNeuf());
  C.charge();
  const v = C.vue();
  console.log('   tresorerie apres relecture : $' + v.tresor + ' · trades ' + v.trades);
  ok(v.tresor === C.DEPART, 'la colonie repart de $' + C.DEPART + ', pas de $512 000 000');
  ok(v.trades === 0 && v.ouvertures === 0, 'et tout ce qui en descendait repart aussi');
  const j = (v.journalStructure || [])[0];
  ok(!!j && j.quoi === 'remise' && /512000000/.test(j.txt),
     'la remise a zero est ECRITE, avec le chiffre qu on a jete : « ' + (j && j.txt.slice(0, 90)) + '… »');
  const copies = fs.readdirSync(DOSSIER).filter((f) => /abandonne/.test(f));
  ok(copies.length > 0, 'et une copie de l ancien etat est gardee : ' + copies[0]);

  /* Un etat a la bonne version, lui, se complete comme avant. */
  const bon = Object.assign(C.etatNeuf(), { tresor: 1234, trades: 7 });
  delete bon.surveillance;
  fs.writeFileSync(C.FICHIER, JSON.stringify(bon));
  C._pose(C.etatNeuf());
  C.charge();
  ok(C.vue().tresor === 1234 && C.vue().trades === 7,
     'alors qu un etat a jour est relu tel quel — on ne jette pas a chaque correction');
}


/* ==========================================================================
 * 29. LA CLE COINGECKO
 *
 * Les memes donnees, par une porte a nous plutot que par la file commune. Ce
 * qui compte ici n'est pas qu'elle marche — c'est qu'elle ne casse rien quand
 * elle ne marche pas. Une amelioration qui, en tombant, casse ce qui marchait
 * avant n'est pas une amelioration.
 * ======================================================================== */
async function coingecko() {
  console.log('\n-- sans cle, on lit par l acces libre --');
  remise(sains());
  await C.tour();
  let v = C.vue();
  console.log('   porte : ' + v.coingecko.porte + ' · appels libres ' + appels.pools
    + ' · demo ' + appels.cgDemo + ' · pro ' + appels.cgPro);
  ok(v.coingecko.cle === false && v.coingecko.porte === 'libre', 'aucune cle, aucune porte a sonder');
  ok(appels.cgDemo === 0 && appels.cgPro === 0, 'et rien n est envoye a CoinGecko');
  ok(appels.pools === 3, 'les lectures passent par l acces libre, comme avant (' + appels.pools + ')');
  ok(!v.alertes.some((a) => /CoinGecko/.test(a.quoi)), 'et aucune alerte : il n y a rien a signaler');

  console.log('\n-- une cle Demo est reconnue comme telle --');
  remise(sains(), { cgCle: 'cg-demo-123', cgPorte: 'demo' });
  process.env.COINGECKO_API_KEY = 'cg-demo-123';
  await C.tour();
  v = C.vue();
  console.log('   porte : ' + v.coingecko.porte + ' · demo ' + appels.cgDemo
    + ' · pro ' + appels.cgPro + ' · libre ' + appels.pools);
  ok(v.coingecko.porte === 'demo', 'la porte Demo est retenue');
  ok(appels.cgDemo > 1, 'et les lectures y passent (' + appels.cgDemo + ')');
  ok(appels.pools === 0, 'plus aucune ne passe par la file commune');
  ok(v.candidats.length > 0, 'et les jetons sont lus normalement : la forme des reponses est la meme');

  console.log('\n-- une cle Pro aussi, sans qu on ait a le dire --');
  remise(sains(), { cgCle: 'cg-pro-456', cgPorte: 'pro' });
  process.env.COINGECKO_API_KEY = 'cg-pro-456';
  await C.tour();
  v = C.vue();
  console.log('   porte : ' + v.coingecko.porte + ' · demo ' + appels.cgDemo + ' · pro ' + appels.cgPro);
  ok(v.coingecko.porte === 'pro', 'la porte Pro est retenue');
  ok(appels.cgDemo >= 1, 'apres avoir essaye la Demo d abord — les deux cles ne se distinguent pas a l oeil');
  ok(appels.cgPro > 1, 'et les lectures passent par la Pro (' + appels.cgPro + ')');

  console.log('\n-- une cle refusee ne casse rien, et elle est signalee --');
  remise(sains(), { cgCle: 'la-bonne', cgPorte: 'demo' });
  process.env.COINGECKO_API_KEY = 'la-mauvaise';
  await C.tour();
  v = C.vue();
  console.log('   porte : ' + v.coingecko.porte + ' · libre ' + appels.pools
    + ' · jetons examines ' + v.candidats.length);
  ok(v.coingecko.porte === 'libre', 'on retombe sur l acces libre');
  ok(v.candidats.length > 0,
     'et la colonie continue exactement comme avant la cle : ' + v.candidats.length + ' jetons lus');
  const a = v.alertes.find((x) => /CoinGecko/.test(x.quoi));
  ok(!!a && a.gravite === 'haute',
     'une alerte le dit, au lieu de laisser une cle inutile en place : « ' + (a && a.quoi) + ' »');
  ok(!!a && /coingecko\.com\/en\/developers/.test(a.quoiFaire),
     'avec ou aller la verifier');

  console.log('\n-- et un quota atteint en pleine journee ne perd pas la lecture --');
  /* La cle est BONNE : elle a ete reconnue au demarrage. Le quota tombe
     ensuite, en pleine journee — c'est le cas courant, et c'est celui qui doit
     etre absorbe sans rien perdre. */
  remise(sains(), { cgCle: 'cg-demo-123', cgPorte: 'demo' });
  process.env.COINGECKO_API_KEY = 'cg-demo-123';
  ok((await C.sondeCoingecko()) === 'demo', 'la cle est reconnue au demarrage');
  MONDE.cgQuota = true;
  await C.tour();
  v = C.vue();
  const s = v.services.find((x) => x.cle === 'coingecko');
  console.log('   libre ' + appels.pools + ' · jetons ' + v.candidats.length
    + ' · service coingecko ' + JSON.stringify({ essais: s.essais, echec: s.dernierEchec }));
  ok(appels.pools > 0, 'les lectures repassent par l acces libre au premier refus');
  ok(v.candidats.length > 0, 'et le tour se fait quand meme (' + v.candidats.length + ' jetons)');
  ok(s.essais > s.reussites && !!s.dernierEchec,
     'le refus est compte et nomme : « ' + s.dernierEchec + ' »');
  delete process.env.COINGECKO_API_KEY;
}


/* ==========================================================================
 * 30. LA CLE GOPLUS : DEUX PIECES D'UNE MEME SERRURE
 *
 * « Il y a marqué App Key et App Secret, je sais pas laquelle copier-coller. »
 *
 * Les deux. La cle s'envoie en clair, le secret ne sort jamais de la machine :
 * on les combine en une signature — sha1(cle + heure + secret) — qu'on echange
 * contre un jeton valable une heure. Ce qui compte dans cet essai, c'est que le
 * secret n'apparaisse NULLE PART dans ce qui part sur le reseau, et que la
 * colonie continue de lire quand la paire est mauvaise.
 * ======================================================================== */
async function goplusCle() {
  console.log('\n-- sans cle, les lectures de securite marchent deja --');
  remise(sains());
  await C.tour();
  let v = C.vue();
  ok(v.goplus.identifie === false, 'aucune identification');
  ok(appels.goplusJeton === 0, 'aucun jeton n est demande');
  ok(appels.goplus > 0 && v.candidats.some((c) => c.goplusSait !== undefined),
     'et la securite des contrats est lue quand meme — c est ce qui a servi jusqu ici');

  console.log('\n-- la paire complete obtient un jeton --');
  remise(sains(), { gpCle: 'app-key-123', gpSecret: 'app-secret-456' });
  process.env.GOPLUS_APP_KEY = 'app-key-123';
  process.env.GOPLUS_APP_SECRET = 'app-secret-456';
  await C.tour();
  v = C.vue();
  console.log('   jetons demandes ' + appels.goplusJeton + ' · lectures authentifiees '
    + appels.goplusAuth + '/' + appels.goplus);
  ok(appels.goplusJeton === 1,
     'le jeton est demande UNE fois et garde : il vaut une heure, le redemander a chaque lecture '
     + 'serait doubler le nombre d appels pour rien');
  ok(appels.goplusAuth === appels.goplus,
     'et toutes les lectures le portent (' + appels.goplusAuth + '/' + appels.goplus + ')');
  ok(v.goplus.jeton === true, 'la vue le confirme');

  console.log('\n-- et le secret ne part jamais sur le reseau --');
  const fuite = envoyes.filter((e) => /app-secret-456/.test(e.url + ' ' + (e.body || '')
    + ' ' + JSON.stringify(e.headers || {})));
  console.log('   ' + envoyes.length + ' requetes examinees, ' + fuite.length + ' portant le secret');
  ok(fuite.length === 0,
     'aucune des ' + envoyes.length + ' requetes ne contient le secret : il ne sert qu a signer, '
     + 'sur cette machine');
  const avecCle = envoyes.filter((e) => /app-key-123/.test((e.body || '')));
  ok(avecCle.length === 1, 'seule la demande de jeton porte la cle, et une seule fois');

  console.log('\n-- une mauvaise paire ne casse rien, et elle est signalee --');
  remise(sains(), { gpCle: 'la-bonne', gpSecret: 'le-bon-secret' });
  process.env.GOPLUS_APP_KEY = 'la-bonne';
  process.env.GOPLUS_APP_SECRET = 'PAS-le-bon-secret';
  await C.tour();
  v = C.vue();
  console.log('   jeton : ' + v.goplus.jeton + ' · lectures ' + appels.goplus
    + ' dont authentifiees ' + appels.goplusAuth);
  ok(v.goplus.jeton === false, 'aucun jeton n est obtenu');
  ok(appels.goplus > 0 && appels.goplusAuth === 0,
     'les lectures continuent SANS authentification : comme avant la cle, donc rien n est casse');
  ok(v.candidats.length > 0, 'et le tour se fait normalement (' + v.candidats.length + ' jetons)');
  const a = v.alertes.find((x) => /GoPlus/.test(x.quoi));
  ok(!!a && /horloge/.test(a.quoiFaire),
     'une alerte le dit, et nomme la cause la plus frequente : « ' + (a && a.quoiFaire.slice(0, 80)) + '… »');

  console.log('\n-- et une moitie de paire est dite pour ce qu elle est --');
  remise(sains());
  process.env.GOPLUS_APP_KEY = 'toute-seule';
  const b = C.alertes().find((x) => /sans GOPLUS_APP_SECRET/.test(x.quoi));
  ok(!!b, 'la cle sans son secret est signalee : « ' + (b && b.quoi) + ' »');
  ok(/serrure a deux pieces/.test(b.pourquoi),
     'en expliquant que ce ne sont pas deux facons d entrer');
  delete process.env.GOPLUS_APP_KEY; delete process.env.GOPLUS_APP_SECRET;
}

/* ==========================================================================
 * 31. LA CLE dRPC
 * ======================================================================== */
async function drpcCle() {
  console.log('\n-- avec une cle, le noeud a nous passe devant --');
  remise(sains());
  process.env.DRPC_API_KEY = 'dkey-abc';
  const ordre = C.noeuds().map((n) => n.cle);
  console.log('   ' + ordre.join(' → '));
  ok(ordre[0] === 'chaineCle',
     'il est essaye en premier : c est un debit qui nous appartient, les autres sont partages '
     + 'avec la terre entiere');
  await C.tour();
  let v = C.vue();
  console.log('   appels : cle ' + appels.rpcCle + ' · officiel ' + appels.rpc
    + ' · public ' + appels.rpc2);
  ok(appels.rpcCle > 0, 'les lectures y passent (' + appels.rpcCle + ')');
  ok(appels.rpc === 0, 'et plus par le noeud officiel, qui refusait quatre lectures sur six');
  ok(v.candidats.filter((c) => c.chaineVue).length > 0, 'les blocs sont lus normalement');
  ok(v.rpcCle.pose === true, 'la vue confirme que la cle est en place');

  console.log('\n-- sa limite de plage est MESUREE, pas supposee --');
  remise(sains(), { drpcPlage: 5000 });
  process.env.DRPC_API_KEY = 'dkey-abc';
  ok(C.noeuds()[0].plageLogs === 200000, 'on part optimiste (200 000 blocs)');
  await C.tour();
  const apres = C.noeuds()[0].plageLogs;
  console.log('   plage retenue apres le premier refus : ' + apres);
  ok(apres === 5000,
     'au premier refus, le noeud retient la limite que le service ANNONCE (' + apres + ') — '
     + 'ecrire un chiffre a la main ici, ce serait le croire sur parole et se tromper en silence '
     + 'le jour ou il change');
  ok(C.vue().rpcCle.plage === 5000, 'et la vue la publie');

  console.log('\n-- une cle refusee ne prive pas la colonie de la chaine --');
  remise(sains(), { drpcRefuse: true });
  process.env.DRPC_API_KEY = 'dkey-perimee';
  await C.tour();
  v = C.vue();
  console.log('   cle ' + appels.rpcCle + ' · officiel ' + appels.rpc
    + ' · jetons lus ' + v.candidats.filter((c) => c.chaineVue).length);
  ok(appels.rpcCle > 0 && appels.rpc > 0,
     'apres le refus, la lecture repart sur le noeud officiel');
  ok(v.candidats.filter((c) => c.chaineVue).length > 0,
     'et les blocs sont lus quand meme : une cle perimee ne doit pas valoir moins que pas de cle');
  delete process.env.DRPC_API_KEY;
  delete C.noeuds._cle;
}


/* ==========================================================================
 * 32. GOPLUS SE CONTREDIT, ET C'EST LUI QUI NOUS LE DIT
 *
 * Releve sur la vraie chaine, sur des jetons de deux minutes : huit champs, et
 * parmi eux `is_in_dex: "0"` — alors qu'on vient de TROUVER le jeton dans un
 * pool. Cette reponse est demontrablement fausse, ce qui apprend quelque chose
 * sur toutes les autres : ses zeros ne sont pas des observations, ce sont les
 * valeurs par defaut d'une fiche pas encore remplie.
 *
 * Le probleme n'etait pas theorique. `is_open_source: "0"` etait lu comme
 * « code non verifie » et coutait huit points — appliques a un contrat que
 * GoPlus n'avait simplement pas encore regarde. On penalisait un jeton pour
 * NOTRE ignorance, sur toute la population qu'on vient chercher.
 * ======================================================================== */
async function goplusSeContredit() {
  console.log('\n-- il dit « pas dans un dex » d un jeton trouve dans un pool --');
  remise([jeton(0, { goplus: 'pasIndexe' }), jeton(1)]);
  await C.tour();
  const v = C.vue();
  const c = v.candidats.find((x) => x.sym === 'TOK0');
  console.log('   ' + JSON.stringify({ seContredit: c && c.goplusSeContredit, sait: c && c.goplusSait }));
  ok(!!c && c.goplusSeContredit === true, 'la contradiction est reperee');
  ok(!!c && c.goplusSait === false,
     'et on considere qu il ne sait rien — c est ce qu il vient de prouver');

  /* Le chiffre qui compte : la note ne doit plus porter la penalite. */
  const base = { addr: '0xa', sym: 'A', liq: 9000, prix: 1, mc: 6e4, minutes: 180, ch_m5: 8,
    tx: { h1: { buys: 20, sells: 8, buyers: 12 } }, vol: { h1: 9000, h6: 9000 },
    chaine: { vu: true, montantsLus: true, porteurs: 40, top: 3, brule: 0 } };
  const cru = Object.assign({}, base, { g: { have: true, seContredit: false, taxeSue: false,
    codeSu: true, unverified: true, detSue: false, topSu: false, buyTax: 0, sellTax: 0, top: 0, lp: 0 } });
  const lucide = Object.assign({}, base, { g: { have: false, seContredit: true, taxeSue: false,
    codeSu: false, unverified: false, detSue: false, topSu: false, buyTax: 0, sellTax: 0, top: 0, lp: 0 } });
  const a = C.scoreBase(cru), b = C.scoreBase(lucide);
  console.log('   note en le croyant sur parole : ' + a.toFixed(0) + ' · en notant sa contradiction : ' + b.toFixed(0));
  ok(b > a, 'le jeton ne perd plus les points d un controle qui n a jamais eu lieu (+'
     + (b - a).toFixed(0) + ')');
  ok((v.compteurs.goplusSeContredit || 0) > 0, 'et le cas est compte, pour qu on sache s il est rare ou general');

  /* Mais un GoPlus qui SAIT garde toute son autorite : on ne jette pas le
     service, on jette ce qu'il n'a pas mesure. */
  const d = v.candidats.find((x) => x.sym === 'TOK1');
  ok(!!d && d.goplusSait === true && !d.goplusSeContredit,
     'un jeton dont la fiche est remplie reste lu normalement');
}

/* ==========================================================================
 * 33. UN APPEL QUI NE PEUT PAS REPONDRE NE SE PAIE PAS
 *
 * Mesure sur douze jetons de une a deux minutes : les chandelles rendent 0
 * volatilite exploitable sur 12, DexScreener connait le jeton 1 fois sur 12,
 * et les trades sont assez nombreux pour conclure 2 fois sur 12. Ces appels
 * etaient payes, echouaient a rendre quoi que ce soit, et le trait sortait
 * « inconnu ». Le budget d'un tour partait donc pour l'essentiel dans des
 * questions dont on pouvait savoir a l'avance qu'elles n'avaient pas de
 * reponse.
 * ======================================================================== */
async function appelsInutiles() {
  console.log('\n-- ce qu on ne demande pas, et pourquoi --');
  const cas = [
    ['2 min, 3 transactions', { minutes: 2, tx: { h1: { buys: 2, sells: 1 } } }, ['ohlcv', 'dex', 'trades']],
    ['8 min, 40 transactions', { minutes: 8, tx: { h1: { buys: 30, sells: 10 } } }, ['dex']],
    ['40 min, actif', { minutes: 40, tx: { h1: { buys: 60, sells: 20 } } }, []],
  ];
  for (const [nom, t, sautes] of cas) {
    const vus = ['ohlcv', 'dex', 'trades'].filter((b) => C.peutRepondre(b, t));
    console.log('   ' + nom.padEnd(24) + ' → saute : ' + (vus.join(', ') || 'rien'));
    ok(JSON.stringify(vus) === JSON.stringify(sautes),
       nom + ' : on saute ' + (sautes.join(', ') || 'rien') + ' et rien d autre');
  }
  ok(/bougies/.test(String(C.peutRepondre('ohlcv', { minutes: 2, tx: {} }))),
     'et la raison est ecrite : « ' + C.peutRepondre('ohlcv', { minutes: 2, tx: {} }) + ' »');

  /* ---- ET A DEUX MINUTES, ON NE PAIE PLUS RIEN DU TOUT ----
   * L'economie mesuree ici etait « on ne demande pas les chandelles a un jeton
   * qui n'en a pas ». Depuis l'age minimum d'achat elle va plus loin : le
   * Scout ecarte le jeton AVANT le premier appel, parce qu'on ne l'achetera
   * pas a cet age-la de toute facon. Zero appel vaut mieux que trois appels
   * bien choisis, et c'est ce qu'il faut mesurer maintenant. */
  console.log('\n-- et ca se voit sur un tour entier --');
  remise([0, 1, 2, 3, 4, 5].map((i) => jeton(i, { minutes: 2, buys: 2, sells: 1, buyers: 2 })));
  await C.tour();
  let v = C.vue();
  const jeunes = { ohlcv: appels.ohlcv, dex: appels.dex, trades: appels.trades, rpc: appels.rpc };
  console.log('   six jetons de 2 min, calmes : ' + JSON.stringify(jeunes)
    + ' · refus : ' + JSON.stringify((v.candidats[0] || {}).refus));
  ok(jeunes.ohlcv === 0 && jeunes.trades === 0,
     'aucun appel de chandelles ni de trades : a deux minutes, ils ne peuvent rien rendre');
  ok(jeunes.rpc === 0,
     'ni meme un appel a la chaine : le Scout tranche sur l age, et son controle ne coute rien');
  ok(v.candidats.length > 0 && v.candidats.every((c) => /trop jeune/.test(c.refus || '')),
     'ils sont tous ecartes pour leur age, et le refus le DIT : « '
     + ((v.candidats[0] || {}).refus || '') + ' »');
  ok(v.candidats.every((c) => c.appels === 0),
     'zero appel paye pour les six : on ne paie pas pour juger ce qu on n achetera pas');

  /* La regle qui dit ce qu'un service peut rendre, elle, n'a pas bouge : elle
     sert toujours sur les jetons qu'on garde. */
  console.log('\n-- un jeton en age d etre achete, lui, est lu en entier --');
  remise([0, 1].map((i) => jeton(i, { minutes: 180, buys: 60, sells: 20, buyers: 40 })));
  await C.tour();
  v = C.vue();
  console.log('   ' + JSON.stringify({ ohlcv: appels.ohlcv, dex: appels.dex, trades: appels.trades }));
  ok(appels.ohlcv > 0 && appels.trades > 0 && appels.dex > 0,
     'a trois heures, les trois services ont quelque chose a dire, et on le leur demande');
}


/* ==========================================================================
 * 34. OU LA COLONIE REGARDE
 *
 * Elle triait par « le plus jeune d'abord » et prenait les dix premiers : sur
 * cette chaine, dix jetons de une a deux minutes — l'age ou elle est le plus
 * aveugle. Elle depensait tout son budget la ou il y a le moins a lire, et
 * l'age etant l'un de ses propres traits, elle ne pouvait meme pas apprendre
 * que c'etait une mauvaise idee : elle n'observait jamais les autres bandes.
 * ======================================================================== */
async function bandesDage() {
  console.log('\n-- le regard se repartit sur les ages --');
  const l = [];
  for (const m of [1, 1, 2, 2, 3, 3, 4, 8, 12, 25, 40, 90, 200]) l.push({ sym: 'T' + m, minutes: m });
  const avant = l.slice().sort((a, b) => a.minutes - b.minutes).slice(0, 8).map((t) => t.minutes);
  const apres = C.parBandes(l).slice(0, 8).map((t) => t.minutes);
  console.log('   avant : ' + avant.join(', ') + ' min');
  console.log('   apres : ' + apres.join(', ') + ' min');
  ok(Math.max(...avant) <= 8, 'l ancien tri ne voyait que les plus jeunes (jusqu a ' + Math.max(...avant) + ' min)');
  ok(Math.max(...apres) > 60,
     'le nouveau atteint toutes les bandes des les premiers examines (jusqu a ' + Math.max(...apres) + ' min)');
  const bandes = new Set(C.parBandes(l).slice(0, 8).map((t) => {
    let i = C.BANDES.findIndex((b) => t.minutes < b.max);
    return i < 0 ? C.BANDES.length - 1 : i;
  }));
  ok(bandes.size === C.BANDES.length,
     'les ' + C.BANDES.length + ' bandes sont representees, donc l age peut enfin s apprendre');
  ok(C.parBandes(l).length === l.length, 'et aucun jeton n est perdu au passage');

  /* Sur un vrai tour, la vue doit MONTRER la repartition : sinon « elle
     regarde partout » est une phrase invérifiable. */
  remise([jeton(0, { minutes: 2 }), jeton(1, { minutes: 3 }), jeton(2, { minutes: 12 }),
          jeton(3, { minutes: 40 }), jeton(4, { minutes: 120 })]);
  await C.tour();
  const v = C.vue();
  console.log('   ' + JSON.stringify(v.bandes));
  ok(v.bandes.filter((b) => b.vus > 0).length >= 3,
     'un tour reel touche au moins trois bandes (' + v.bandes.map((b) => b.nom + ':' + b.vus).join(' ') + ')');
}

/* ==========================================================================
 * 35. PRENDRE UN GAIN, ET SAVOIR SI ON A EU RAISON
 *
 * Personne ne prenait de gain : le Closer tenait sa duree, le Promoteur la
 * prolongeait, la Sentinelle ne coupait que sur un desastre. Une position a
 * +80 % au bout de six minutes attendait la vingtieme.
 *
 * Le vrai probleme n'est pas de vendre — c'est d'APPRENDRE. Vendre a +40 % et
 * noter « j'ai eu +40 % » est circulaire : la question est ce qu'on aurait eu
 * en gardant, et une fois la position fermee on ne le sait plus. On revient
 * donc voir a l'echeance, sur des prix reels.
 * ======================================================================== */
async function prendreUnGain() {
  console.log('\n-- la Sentinelle prend un gain avant l echeance --');
  remise(sains());
  const E = C._etat();
  const p = { sym: 'MONTE', adr: '0xg1', pool: '0xpg', prix0: 1, t0: Date.now() - 6 * 60000,
    mise: 30, traits: {}, tenueMin: 20, tenueBase: 20, traj: [], liq0: 9000, score: 70 };
  E.positions = [p];
  ok(C.veutPrendre(p, 8) === null, 'en dessous de +' + C.GAIN_EXPLORE + ' %, il n y a rien a arbitrer');
  E.sortieEssais = 2;      /* la prochaine est celle qu il explore */
  const n = C.regle({ '0xg1': { prix: 1.4, liq: 9000 } });
  const v1 = C.vue();
  console.log('   ' + (v1.flux[0] || {}).txt);
  ok(n === 1 && E.positions.length === 0, 'la position est fermee a six minutes, pas a vingt');
  ok(/gain pris/.test((v1.flux[0] || {}).txt), 'et le fil dit que c est un gain pris, pas une coupe');
  ok((v1.compteurs.gainPris || 0) === 1, 'le geste est compte a son nom');
  ok(v1.suites.length === 1 && v1.suites[0].echeance > Date.now(),
     'et une SUITE est notee : on reviendra voir a l echeance ce que garder aurait donne');

  console.log('\n-- et on revient voir, sur des prix reels --');
  E.suites[0].echeance = Date.now() - 1000;
  C.regleLesSuites({ '0xg1': { prix: 1.1, liq: 9000 } });   /* a l echeance, ca ne valait que +10 % */
  let v = C.vue();
  console.log('   ' + (v.flux[0] || {}).txt);
  ok(/ca valait \+10\.0%/.test((v.flux[0] || {}).txt),
     'la lecon compare ce qu on a pris a ce qu on aurait eu');
  const m = C._etat().memoire.sentinelle.sortie['gain pris a +35-60%'];
  console.log('   lecon : ' + JSON.stringify(m));
  ok(!!m && Math.abs(m.s / m.n - 30) < 0.01,
     'et ce qu elle retient est la DIFFERENCE (+30 pts), pas le gain lui-meme — noter « j ai eu '
     + '+40 % » serait circulaire et n apprendrait rien');
  ok(C._etat().suites.length === 0, 'la suite est soldee, elle ne sera pas jugee deux fois');

  console.log('\n-- vendre trop tot se paie, dans le releve --');
  remise(sains());
  const F = C._etat();
  C.noteSuite({ adr: '0xg2', sym: 'ENVOLE', prix0: 1, t0: Date.now() - 6 * 60000, tenueMin: 20 },
              1.3, 30, C.casSortie(30), Date.now());
  F.suites[0].echeance = Date.now() - 1000;
  C.regleLesSuites({ '0xg2': { prix: 2.5, liq: 9000 } });   /* ca a continue de monter */
  const m2 = F.memoire.sentinelle.sortie['gain pris a +20-35%'];
  console.log('   ' + (C.vue().flux[0] || {}).txt);
  ok(m2.s < 0, 'la lecon est NEGATIVE (' + m2.s.toFixed(0) + ') : elle a vendu trop tot, et elle le saura');
  ok(/trop tot/.test((C.vue().flux[0] || {}).txt), 'et le fil le dit en toutes lettres');

  console.log('\n-- son releve finit par decider a sa place --');
  remise(sains());
  const G = C._etat();
  const cas = C.casSortie(45);
  for (let i = 0; i < 12; i++) C.apprendAgent('sentinelle', cas, -25);
  const q = { adr: '0xg3', prix0: 1, t0: Date.now() - 6 * 60000, tenueMin: 20 };
  ok(C.veutPrendre(q, 45) === null,
     'quand son propre releve dit que vendre a cette hauteur coute 25 points, elle ne vend plus');
  for (let i = 0; i < 24; i++) C.apprendAgent('sentinelle', cas, 25);
  ok(!!C.veutPrendre(q, 45),
     'et quand il dit le contraire, elle vend — sans qu aucune regle n ait ete ecrite a la main');

  console.log('\n-- une suite qu on ne peut pas juger n invente rien --');
  remise(sains());
  const H = C._etat();
  C.noteSuite({ adr: '0xg4', sym: 'DISPARU', prix0: 1, t0: Date.now(), tenueMin: 20 },
              1.3, 30, C.casSortie(30), Date.now());
  H.suites[0].echeance = Date.now() - 1000;
  C.regleLesSuites({});                       /* aucun prix relu */
  ok(H.suites.length === 1, 'sans prix a l echeance, la suite ATTEND au lieu d etre jugee au hasard');
  ok(!H.memoire.sentinelle || !H.memoire.sentinelle.sortie,
     'et rien n est appris : une lecon tiree d un prix qu on n a pas lu serait pire qu aucune lecon');
  H.suites[0].t = Date.now() - 5 * 3600e3;
  C.regleLesSuites({});
  ok(H.suites.length === 0, 'mais on ne la poursuit pas indefiniment : au bout de quelques heures, on lache');
}


/* ==========================================================================
 * 36. QUEL NOEUD REFUSE, ET POURQUOI
 *
 * Releve en production : « Les noeuds de la chaine refusent 36 % des lectures —
 * 247 refus sur 683 appels », avec une cle dRPC deja posee, et pour tout
 * remede : « si les refus persistent malgre elle, c'est le forfait qui est
 * atteint ».
 *
 * C'etait une DEDUCTION, pas une mesure. L'alerte additionnait trois noeuds
 * dont les refus n'ont ni la meme cause ni le meme remede, puis devinait. Et
 * elle devinait mal dans le cas le plus important : quand le noeud a cle echoue
 * a chaque fois, chaque lecture le paie puis retombe sur les publics, le total
 * affiche un tiers de refus — exactement ce qu'on verrait avec un forfait
 * atteint — alors que la cle ne fonctionne pas du tout et qu'on envoie
 * chercher au mauvais endroit.
 * ======================================================================== */
async function quelNoeud() {
  /* `remise` remet le monde a neuf — et efface les variables d'environnement.
     La cle se pose donc APRES, sinon chaque scenario mesure le cas « aucune
     cle » en croyant en mesurer un autre. */
  const pose = (serv, cle) => {
    remise(sains());
    C._etat().services = serv;
    if (cle) process.env.DRPC_API_KEY = cle; else delete process.env.DRPC_API_KEY;
  };

  console.log('\n-- la cle est refusee a chaque fois --');
  pose({ chaineCle: { essais: 247, reussites: 0, dernierEchec: 'Your token is invalid or expired' },
         chaine: { essais: 436, reussites: 436 } }, 'dkey-essai');
  let a = C.alertes().find((x) => /noeuds de la chaine/.test(x.quoi));
  console.log('   ' + a.quoi);
  console.log('   ' + a.pourquoi.slice(0, 130));
  ok(/36 %/.test(a.quoi), 'le total est le meme qu avant (36 %)');
  ok(/le noeud a cle \(dRPC\) : 247\/247 refus/.test(a.pourquoi),
     'mais le detail dit OU : ' + (a.pourquoi.match(/le noeud a cle[^·]*/) || [''])[0].trim());
  ok(/le noeud officiel : 0\/436/.test(a.pourquoi),
     'et que l officiel, lui, ne refuse rien — ce que le total cachait entierement');
  ok(/ECHOUE A CHAQUE FOIS/.test(a.quoiFaire) && /pas un forfait/.test(a.quoiFaire),
     'le remede dit que ce n est PAS un forfait : « ' + a.quoiFaire.slice(0, 90) + '… »');
  ok(/Your token is invalid or expired/.test(a.quoiFaire),
     'en citant la raison que le service a donnee, plutot qu une hypothese');
  ok(/reseau « robinhood »/.test(a.quoiFaire),
     'et en nommant ce qu il faut verifier : la cle peut exister sans couvrir cette chaine');

  console.log('\n-- la cle marche, mais le forfait est atteint --');
  pose({ chaineCle: { essais: 400, reussites: 120, dernierEchec: 'sature' },
         chaine: { essais: 283, reussites: 280, dernierEchec: 'sature' } }, 'dkey-essai');
  a = C.alertes().find((x) => /noeuds de la chaine/.test(x.quoi));
  console.log('   ' + a.quoiFaire.slice(0, 110));
  ok(/La cle fonctionne \(120 lectures reussies\)/.test(a.quoiFaire),
     'on dit qu elle fonctionne, avec le compte');
  ok(/c\'est bien le forfait/.test(a.quoiFaire),
     'et LA, le forfait est bien le diagnostic — mais parce qu on l a mesure');

  console.log('\n-- la cle marche : plus d alerte du tout --');
  pose({ chaineCle: { essais: 600, reussites: 590 },
         chaine: { essais: 83, reussites: 40, dernierEchec: 'sature' } }, 'dkey-essai');
  a = C.alertes().find((x) => /noeuds de la chaine/.test(x.quoi));
  console.log('   ' + (a ? a.quoi : 'aucune alerte'));
  ok(!a,
     'des refus sur les noeuds de SECOURS ne declenchent rien : c est leur role, et ils ne coutent '
     + 'aucune lecture perdue tant que la cle repond');

  console.log('\n-- une cle posee mais jamais appelee --');
  pose({ chaine: { essais: 500, reussites: 300, dernierEchec: 'sature' } }, 'dkey-essai');
  a = C.alertes().find((x) => /noeuds de la chaine/.test(x.quoi));
  console.log('   ' + a.quoiFaire.slice(0, 110));
  ok(/n\'a pas encore ete appele/.test(a.quoiFaire) && /redeploye/.test(a.quoiFaire),
     'on nomme la cause la plus frequente : une variable posee apres le dernier deploiement');

  console.log('\n-- et sans cle du tout, on dit laquelle poser --');
  pose({ chaine: { essais: 500, reussites: 300, dernierEchec: 'sature' } }, null);
  a = C.alertes().find((x) => /noeuds de la chaine/.test(x.quoi));
  ok(/DRPC_API_KEY/.test(a.quoiFaire), 'la variable est nommee : « ' + a.quoiFaire.slice(0, 80) + '… »');
}


/* ==========================================================================
 * 37. APPRENDRE DE CE QU'ON N'A PAS ACHETE
 *
 * « Fais-lui trader plus de jetons, qu'il en analyse plus, pour s'améliorer
 *   plus vite. »
 *
 * L'intuition est juste, mais le frein n'etait pas le nombre de positions : il
 * etait dans ce que les agents avaient le droit de voir. Ils n'apprenaient QUE
 * des jetons achetes — c'est-a-dire de ceux qui avaient passe tous les vetos et
 * depasse le seuil. La memoire ne contenait donc que des cas selectionnes par
 * les regles qu'on voulait justement evaluer : un biais de selection dans sa
 * forme la plus pure. Le Warden ne pouvait pas savoir si les contrats qu'il
 * bloquait s'effondraient vraiment, puisqu'il ne voyait jamais la suite.
 * ======================================================================== */
async function livreDOmbre() {
  console.log('\n-- chaque jeton analyse laisse une ombre --');
  remise(sains());
  await C.tour();
  let v = C.vue();
  console.log('   examines ' + v.candidats.length + ' · positions ' + v.positions.length
    + ' · ombres en attente ' + v.ombres.enAttente);
  ok(v.ombres.enAttente >= v.candidats.length - v.positions.length,
     'tous les jetons examines laissent une ombre, pas seulement les achetes ('
     + v.ombres.enAttente + ' pour ' + v.candidats.length + ' examines)');

  console.log('\n-- et a l echeance, TOUS les analystes en apprennent --');
  remise(sains());
  const E = C._etat();
  const tr = { whale: { top: 'top >50%' }, scout: { age: 'ne de <10 min' } };
  for (let i = 0; i < 10; i++)
    C.noteOmbre({ addr: '0x' + i, sym: 'R' + i, prix: 1 },
                { traits: tr, score: 20 }, 'un porteur tient 90% du circulant', 'whale');
  ok(E.ombres.length === 10, 'dix jetons refuses pour concentration sont suivis');
  /* C'est l'AGE qui decide desormais, pas une echeance posee : on les vieillit
     jusqu'a l'echeance de reference, celle qui nourrit la memoire des agents. */
  for (const o of E.ombres) o.t = Date.now() - C.HORIZON_REF * 60000;
  const m = {};
  E.ombres.forEach((o, i) => { m[o.adr] = { prix: i === 0 ? 1.5 : (i < 6 ? 0.4 : 1.02) }; });
  const n = C.regleLesOmbres(m);
  console.log('   ' + n + ' ombres jugees · memoire whale : ' + JSON.stringify(E.memoire.whale));
  ok(n === 10, 'les dix sont jugees sur des prix relus');
  ok(!!E.memoire.whale && E.memoire.whale.top['top >50%'].n === 10,
     'et le Whale apprend enfin ce que fait un jeton qu il a REFUSE — ce qu il ne pouvait pas '
     + 'savoir tant qu il n apprenait que des achetes');
  ok(E.memoire.whale.top['top >50%'].s < 0,
     'ici, ces jetons perdent en moyenne : son veto est confirme par la mesure');

  console.log('\n-- ce qui donne un AUDIT des vetos --');
  const a = C.auditDesRefus()[0];
  console.log('   ' + JSON.stringify(a));
  ok(!!a && a.n === 10, 'chaque raison de refus porte son compte');
  ok(a.effondres === 5 && a.montes === 1,
     'et ce que les jetons ecartes ont VRAIMENT fait : ' + a.effondres + ' effondres, '
     + a.montes + ' monte');
  ok(a.moyenne < 0,
     'un veto qui ecarte surtout des perdants est une protection (' + a.moyenne + ' % en moyenne)');
  ok(C.vue().audit.length > 0, 'et la vue le publie : un veto qui ecarterait des gagnants doit se voir');

  console.log('\n-- mais les agents de DECISION restent en dehors --');
  remise(sains());
  const F = C._etat();
  C.noteOmbre({ addr: '0xz', sym: 'Z', prix: 1 },
              { traits: { whale: { top: 'top <5%' } }, score: 80 }, null, null);
  F.ombres[0].t = Date.now() - C.HORIZON_REF * 60000;
  C.regleLesOmbres({ '0xz': { prix: 1.4 } });
  console.log('   agents ayant appris : ' + JSON.stringify(Object.keys(F.memoire)));
  ok(!!F.memoire.whale, 'les analystes apprennent');
  ok(!F.memoire.banquier && !F.memoire.closer && !F.memoire.sentinelle && !F.memoire.promoteur,
     'le Banquier, le Closer, la Sentinelle et le Promoteur non : une position qu on n a pas prise '
     + 'n a ni mise, ni duree tenue, ni gain pris — leur en donner melangerait ce qu on a fait avec '
     + 'ce qu on aurait pu faire');

  console.log('\n-- et une ombre qu on ne peut pas juger n invente rien --');
  remise(sains());
  const G = C._etat();
  C.noteOmbre({ addr: '0xy', sym: 'Y', prix: 1 }, { traits: { whale: { top: 'top <5%' } }, score: 80 }, null, null);
  G.ombres[0].t = Date.now() - C.HORIZON_REF * 60000;
  C.regleLesOmbres({});
  ok(G.ombres.length === 1, 'sans prix relu, elle ATTEND au lieu d etre jugee au hasard');
  ok(!G.memoire.whale, 'et rien n est appris');
  C.regleLesOmbres({ '0xy': { prix: 1e9 } });     /* un rapport aberrant */
  ok(!G.memoire.whale && G.ombres.length === 0,
     'un prix aberrant la solde sans rien apprendre : les memes bornes que pour une position');
  ok((C.vue().compteurs.ombreAberrante || 0) === 1, 'et le cas est compte');
}


/* ==========================================================================
 * 38. QUAND CE GENRE DE JETON PAIE
 *
 * « L'essentiel, c'est qu'il récolte une masse de données pour comprendre
 *   comment trader correctement et faire de l'argent. »
 *
 * Tout etait juge a UN horizon — vingt minutes — et l'observation etait jetee.
 * On ne pouvait donc jamais repondre a la seule question qui decide du
 * resultat : QUAND vendre. Un jeton a +40 % a la vingtieme minute peut avoir
 * fait +120 % a la huitieme, ou etre en route vers +300 % a la deuxieme heure.
 * Ces trois cas donnaient exactement la meme ligne dans la memoire.
 * ======================================================================== */
async function profilsDansLeTemps() {
  console.log('\n-- une courbe par trait, pas un seul chiffre --');
  remise(sains());
  const rapide = { scout: { liq: 'liq 5-25k', age: 'ne de <10 min' }, whale: { top: 'top 5-15%' },
                   whisper: { press: 'achats massifs' } };
  const lente = { scout: { liq: 'liq>100k', age: '2-6 h' }, whale: { top: 'top <5%' },
                  whisper: { press: 'equilibre' } };
  for (let i = 0; i < 10; i++) {
    C.noteProfil(rapide, 5, 60); C.noteProfil(rapide, 15, 25);
    C.noteProfil(rapide, 30, -5); C.noteProfil(rapide, 60, -20);
    C.noteProfil(lente, 5, 4); C.noteProfil(lente, 15, 12);
    C.noteProfil(lente, 30, 26); C.noteProfil(lente, 60, 55);
  }
  const cr = C.courbeDe('liq', 'liq 5-25k'), cl = C.courbeDe('liq', 'liq>100k');
  console.log('   liq 5-25k : ' + cr.map((p) => p.h + 'min ' + p.moyenne + '%').join(' · '));
  console.log('   liq>100k  : ' + cl.map((p) => p.h + 'min ' + p.moyenne + '%').join(' · '));
  ok(cr.length === 4 && cl.length === 4, 'chaque valeur de trait porte sa courbe, echeance par echeance');
  ok(cr[0].moyenne > cr[3].moyenne && cl[0].moyenne < cl[3].moyenne,
     'et les deux populations se distinguent : l une culmine tot, l autre monte longtemps — '
     + 'ce qu un chiffre unique a vingt minutes ne pouvait pas montrer');

  console.log('\n-- d ou sort une duree de tenue PAR JETON --');
  const a = C.horizonPour(rapide), b = C.horizonPour(lente);
  console.log('   celui qui culmine tot → ' + (a && a.min) + ' min · celui qui monte → ' + (b && b.min) + ' min');
  ok(!!a && a.min === 5, 'le jeton dont les traits culminent tot est tenu 5 min');
  ok(!!b && b.min === 60, 'celui dont les traits montent longtemps est tenu 60 min');
  ok(a.min !== b.min,
     'deux jetons, deux durees — au lieu d une constante unique pour tout le monde');

  console.log('\n-- mais pas sur trois observations --');
  remise(sains());
  C.noteProfil(rapide, 5, 60);
  ok(C.courbeDe('liq', 'liq 5-25k') === null,
     'en dessous de ' + C.PROFIL_MIN_OBS + ' observations, il n y a pas de courbe : une moyenne sur '
     + 'deux jetons n est pas une courbe, c est deux jetons');
  ok(C.horizonPour(rapide) === null, 'et aucune duree n en est tiree');

  console.log('\n-- et la position dit d ou vient sa duree --');
  remise(sains());
  for (let i = 0; i < 12; i++) {
    C.noteProfil(lente, 5, 4); C.noteProfil(lente, 15, 12);
    C.noteProfil(lente, 30, 26); C.noteProfil(lente, 60, 55);
  }
  const E = C._etat();
  C.ouvre({ addr: '0xp1', sym: 'P1', pool: '0xpp', prix: 1, mc: 3e5, minutes: 5, liq: 9000,
            an: { score: 80, traits: lente } });
  const p = E.positions[0];
  console.log('   ' + p.tenueMin + ' min · « ' + p.tenueRaison + ' »');
  ok(p.tenueMin === 60, 'elle est tenue 60 min, comme ses traits le suggerent');
  ok(/courbes de ses traits culminent/.test(p.tenueRaison),
     'et la raison est ecrite, pas deduite : « ' + p.tenueRaison + ' »');
}

/* ==========================================================================
 * 39. UNE MESURE PRISE AU MAUVAIS MOMENT N'EST PAS UNE MESURE
 *
 * Les prix arrivent quand le jeton repasse dans un flux, pas a la seconde
 * voulue. Sans borne, un jeton relu pour la premiere fois a quarante minutes
 * remplirait d'un coup les echeances de 5, 15 et 30 avec son rendement a
 * quarante — et les trois courbes seraient fausses sans que rien ne le
 * signale. C'est exactement le genre de chiffre qui a l'air d'une donnee.
 * ======================================================================== */
async function jalonsHonnetes() {
  console.log('\n-- une echeance ratee reste vide --');
  ok(C.jalonValable(5, 6) === true, 'a 6 min, l echeance de 5 est valable');
  ok(C.jalonValable(5, 12) === false, 'a 12 min, elle ne l est plus');
  ok(C.jalonValable(60, 80) === true, 'a 80 min, celle de 60 l est encore (la tolerance suit l echelle)');
  ok(C.jalonValable(60, 140) === false, 'a 140, non');
  ok(C.jalonValable(30, 10) === false, 'et une echeance pas encore atteinte n est jamais remplie');

  console.log('\n-- sur une ombre relue trop tard --');
  remise(sains());
  const E = C._etat();
  const tr = { scout: { liq: 'liq 5-25k' } };
  C.noteOmbre({ addr: '0xt', sym: 'TARD', prix: 1 }, { traits: tr, score: 70 }, null, null);
  E.ombres[0].t = Date.now() - 45 * 60000;          /* premiere relecture a 45 min */
  C.regleLesOmbres({ '0xt': { prix: 1.4 } });
  ok(E.ombres.length === 1, 'l ombre est gardee : une echeance plus lointaine reste atteignable');
  const jal = E.ombres[0].jalons;
  console.log('   echeances remplies : ' + JSON.stringify(Object.keys(jal)));
  ok(!jal[5] && !jal[15],
     'les echeances de 5 et 15 min restent VIDES : on ne les remplit pas avec un prix de 45 min');
  ok(jal[30] !== undefined,
     'seule celle de 30 est remplie, parce que 45 min tombe dans sa tolerance');
  ok(!C.courbeDe('liq', 'liq 5-25k') || !((C._etat().profils.liq['liq 5-25k'] || {})[5]),
     'et rien n est ecrit dans la courbe des 5 min');

  console.log('\n-- une ombre nourrit les agents UNE fois, pas cinq --');
  remise(sains());
  const F = C._etat();
  C.noteOmbre({ addr: '0xu', sym: 'U', prix: 1 }, { traits: { whale: { top: 'top <5%' } }, score: 70 }, null, null);
  for (const h of C.HORIZONS) {
    F.ombres[0].t = Date.now() - h * 60000;
    C.regleLesOmbres({ '0xu': { prix: 1.2 } });
  }
  const m = F.memoire.whale.top['top <5%'];
  console.log('   jalons poses : ' + (F.compteurs.jalons || 0) + ' · memoire du Whale : n=' + m.n);
  ok((F.compteurs.jalons || 0) === C.HORIZONS.length, 'les cinq echeances sont relevees');
  ok(m.n === 1,
     'mais la memoire de l agent ne compte qu UNE observation : sinon le meme jeton compterait cinq '
     + 'fois et les cases gonfleraient sans qu on ait vu cinq jetons');
}

/* ==========================================================================
 * 40. QUEL TRAIT PORTE DE L'INFORMATION
 *
 * Vingt-cinq traits sont releves sur chaque jeton, et rien ne disait lesquels
 * servaient. Un trait dont toutes les valeurs rendent la meme chose n'apprend
 * rien — et il DILUE les autres, puisque son ajustement s'ajoute au leur.
 * ======================================================================== */
async function traitsQuiSeparent() {
  console.log('\n-- ce qui separe, et ce qui est du bruit --');
  remise(sains());
  /* `liq` separe nettement ; `vola` rend la meme chose partout. */
  for (let i = 0; i < 10; i++) {
    C.noteProfil({ a: { liq: 'liq<1k' } }, C.HORIZON_REF, -30 + (i % 3));
    C.noteProfil({ a: { liq: 'liq>100k' } }, C.HORIZON_REF, 20 + (i % 3));
    C.noteProfil({ a: { vola: 'calme' } }, C.HORIZON_REF, 2 + (i % 7) * 8);
    C.noteProfil({ a: { vola: 'vola >12%' } }, C.HORIZON_REF, 3 + (i % 7) * 8);
  }
  const l = C.classementDesTraits();
  console.log('   ' + l.map((t) => t.trait + ' ' + t.separation).join(' · '));
  const liq = l.find((t) => t.trait === 'liq'), vo = l.find((t) => t.trait === 'vola');
  ok(!!liq && !!vo, 'les deux traits sont classes');
  ok(liq.separation > vo.separation * 3,
     'la liquidite separe bien plus que la volatilite (' + liq.separation + ' contre ' + vo.separation + ')');
  ok(l[0].trait === 'liq', 'et le classement met en tete celui qui porte l information');
  console.log('   liq : ' + liq.meilleure.quoi + ' ' + liq.meilleure.moyenne + '% vs '
    + liq.pire.quoi + ' ' + liq.pire.moyenne + '%');
  ok(liq.ecartValeurs > 45,
     'avec l ecart entre ses valeurs extremes (' + liq.ecartValeurs + ' points)');
  ok(vo.ecartValeurs < 5,
     'alors que celles de la volatilite rendent la meme chose (' + vo.ecartValeurs + ' points) : '
     + 'ce trait ne separe rien, et il dilue les autres');
  ok(C.vue().traits.length >= 2, 'et la vue publie le classement');
}

/* ==========================================================================
 * 41. L'EPREUVE DE VENTE, AVANT LE GROS ACHAT
 *
 * « Faudrait un bot dans le village avant le gros achat : il teste avec un
 *   centime un achat et une vente pour pas se faire honeypot. »
 *
 * La colonie ne signe rien — un agent qui pretendrait depenser un centime
 * serait exactement la fabrication que tout le reste refuse. Mais on peut
 * POSER LA QUESTION au contrat sans depenser ni signer : `eth_call` execute le
 * transfert dans le vide et rend ce qu'il aurait rendu.
 *
 * Ce qui est mesure ici :
 *  - un piege qui laisse tout passer sauf la sortie est ATTRAPE, alors que
 *    GoPlus le dit propre et que la chaine le dit bien reparti ;
 *  - un noeud muet ne rend pas le jeton coupable — « pas testable » et
 *    « bloque » sont deux verdicts differents ;
 *  - l'epreuve n'est jouee que sur ce qui allait etre achete, sinon elle
 *    coute des appels pour des jetons deja refuses.
 * ======================================================================== */
async function epreuveDeVente() {
  console.log('\n-- l epreuve de vente --');

  /* ---- LE CONTRAT REPOND NON ---- */
  remise([jeton(0, { piege: true }), jeton(1)]);
  const bon = { addr: MONDE.jetons[1].addr, pool: MONDE.jetons[1].pool,
                chaine: { vu: true, cobayes: ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)] } };
  const mauvais = { addr: MONDE.jetons[0].addr, pool: MONDE.jetons[0].pool,
                    chaine: { vu: true, cobayes: ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)] } };
  const eb = await C.simuleVente(bon);
  const em = await C.simuleVente(mauvais);
  console.log('   sain : ' + JSON.stringify(eb));
  console.log('   piege : ' + JSON.stringify(em));
  ok(eb.teste && eb.passe, 'sur un jeton sain, les deux cobayes peuvent envoyer vers la piscine');
  ok(em.teste && !em.passe && em.refus === em.essais,
     'sur le piege, AUCUN ne le peut (' + em.refus + '/' + em.essais + ')');
  ok(!C.vetoCobaye({ epreuve: eb }) && !!C.vetoCobaye({ epreuve: em }),
     'et c est le veto du Cobaye qui le dit : « ' + C.vetoCobaye({ epreuve: em }) + ' »');

  /* ---- UN CONTRAT QUI CASSE PLUTOT QUE DE RENDRE FALSE ----
   * Les deux formes existent ; les deux doivent etre lues comme un refus. */
  remise([jeton(0, { piegeQuiCasse: true })]);
  const casse = await C.simuleVente({ addr: MONDE.jetons[0].addr, pool: MONDE.jetons[0].pool,
    chaine: { vu: true, cobayes: ['0x' + '1'.repeat(40)] } });
  console.log('   qui casse : ' + JSON.stringify(casse));
  ok(casse.teste && !casse.passe,
     'une revocation est une REPONSE du contrat, donc un refus, pas une panne');

  /* ---- LE NOEUD MUET N'ACCUSE PERSONNE ----
   * C'est la distinction qui compte, et elle se joue sur le VOCABULAIRE de
   * l'erreur : « execution reverted » vient de la machine virtuelle, donc du
   * contrat ; « execution timeout » vient du noeud, et ne dit rien du jeton.
   * On listait d'abord les pannes connues en comptant tout le reste comme un
   * refus — et chaque panne non prevue condamnait alors un jeton innocent en
   * le presentant comme une trouvaille de securite. Si « pas de reponse »
   * valait « piege », une panne de noeud ecarterait tous les jetons du monde
   * et on croirait la colonie prudente alors qu'elle serait aveugle. */
  remise([jeton(0, { callMuet: true })]);
  const muet = await C.simuleVente({ addr: MONDE.jetons[0].addr, pool: MONDE.jetons[0].pool,
    chaine: { vu: true, cobayes: ['0x' + '1'.repeat(40)] } });
  console.log('   noeud muet : ' + JSON.stringify(muet));
  ok(muet.teste === false, 'un noeud qui ne repond pas ne donne PAS de verdict');
  ok(!C.vetoCobaye({ epreuve: muet }),
     'et « pas testable » ne bloque rien : on ne condamne pas sur une absence de reponse');
  ok(/repondu|detenteur/.test(muet.raison || ''), 'la raison est ecrite : « ' + muet.raison + ' »');

  /* ---- SANS DETENTEUR CONNU, IL N'Y A PERSONNE A QUI DEMANDER ---- */
  const vide = await C.simuleVente({ addr: '0xa', pool: '0xb', chaine: { vu: false } });
  ok(vide.teste === false, 'sans lecture de chaine, l epreuve ne peut pas etre jouee');

  /* ---- ET DANS UN TOUR COMPLET ----
   * Le piege passe GoPlus (« propre »), passe la chaine (130 porteurs),
   * passe les compteurs. Il n'est arrete QUE par l'epreuve. */
  remise([jeton(0, { piege: true }), jeton(1), jeton(2)]);
  await C.tour();
  const v = C.vue();
  const cand = v.candidats.find((x) => x.addr === MONDE.jetons[0].addr);
  console.log('   ' + JSON.stringify({ sym: cand && cand.sym, refus: cand && cand.refus,
    qui: cand && cand.quiRefuse, epreuve: cand && cand.epreuve }));
  ok(!!cand, 'le piege a bien ete examine');
  ok(cand.quiRefuse === 'cobaye',
     'et c est le Cobaye qui l arrete, apres que tous les autres l aient laisse passer');
  ok(!C._etat().positions.some((p) => p.addr === MONDE.jetons[0].addr),
     'aucune position n est ouverte dessus');
  ok(C._etat().positions.length > 0, 'alors que les jetons sains, eux, sont achetes');
  const cpt = C._etat().compteurs;
  console.log('   compteurs : ' + JSON.stringify({ vu: cpt.cobayeVu, ok: cpt.cobayeOk,
    bloque: cpt.cobayeBloque, incertain: cpt.cobayeIncertain }));
  ok(cpt.cobayeBloque >= 1, 'le blocage est compte');
  ok((cpt.cobayeVu || 0) <= v.candidats.length,
     'et l epreuve n est jouee que sur ce qui allait etre achete (' + cpt.cobayeVu
     + ' epreuves pour ' + v.candidats.length + ' jetons examines) : la payer sur tout le flux '
     + 'reviendrait a acheter des appels pour des jetons deja refuses');

  /* ---- CE QU'ELLE NE PROUVE PAS, ECRIT DANS LE CODE ----
   * Une epreuve qu'on croit plus forte qu'elle n'est vaut moins que pas
   * d'epreuve : elle simule le transfert, pas l'echange complet. */
  const src = require('fs').readFileSync(__dirname + '/ai_colonie.js', 'utf8');
  ok(/ne prouve pas/i.test(src) && /pas « on pourra vendre »/.test(src),
     'et la limite de l epreuve est ecrite la ou elle est lue');
}

/* ==========================================================================
 * 42. LA PRESENCE DU PROJET
 *
 * « Faudrait acheter que des cryptos avec site web, telegram et twitter, et
 *   DexScreener a jour. »
 *
 * Une regle de gout ne se code pas comme une verite : elle est nommee, elle
 * est reglable, et « pas encore vu » ne doit jamais etre confondu avec
 * « absent » — sinon on reproche a un jeton de deux minutes notre propre
 * calendrier d'indexation.
 * ======================================================================== */
async function presenceDuProjet() {
  console.log('\n-- site, twitter, telegram --');
  console.log('   exiges : ' + JSON.stringify(C.sociauxExiges()));
  ok(C.sociauxExiges().join(',') === 'site,twitter,telegram',
     'les trois sont exiges par defaut');

  const complet = { dex: { vu: true, liens: [
    { type: 'site', url: 'https://a.example' }, { type: 'twitter', url: 'https://x.com/a' },
    { type: 'telegram', url: 'https://t.me/a' }] } };
  ok(C.vetoOracle(complet) === null, 'un projet avec les trois passe');

  const sansTg = { dex: { vu: true, liens: [
    { type: 'site', url: 'https://a.example' }, { type: 'twitter', url: 'https://x.com/a' }] } };
  console.log('   sans telegram : ' + C.vetoOracle(sansTg));
  ok(/telegram/.test(C.vetoOracle(sansTg) || ''),
     'et il manque est NOMME, pas juste « refuse » : « ' + C.vetoOracle(sansTg) + ' »');

  /* ---- « PAS ENCORE VU » N'EST PAS « ABSENT » ----
   * DexScreener ne connait qu'un jeton sur douze a deux minutes. Les deux cas
   * doivent porter des mots differents, parce qu'ils appellent des suites
   * differentes : l'un revient en surveillance, l'autre est ecarte. */
  const pasVu = { dex: { vu: false }, saute: { dex: true }, minutes: 2 };
  const absent = { dex: { vu: false }, minutes: 40 };
  console.log('   pas lu : ' + C.vetoOracle(pasVu) + ' | lu et absent : ' + C.vetoOracle(absent));
  ok(/pas encore verifiable/.test(C.vetoOracle(pasVu) || ''),
     'quand on ne l a pas encore regarde, on le dit comme ca');
  ok(/absent de DexScreener/.test(C.vetoOracle(absent) || ''),
     'quand on a regarde et qu il n y est pas, c est autre chose — et ce n est pas le meme mot');

  /* ---- LA REGLE EST REGLABLE ----
   * C'est une exigence de gout, pas une verite mesuree : elle doit pouvoir
   * etre relachee sans toucher au code. */
  const avant = process.env.SOCIAUX_EXIGES;
  process.env.SOCIAUX_EXIGES = '';
  ok(C.vetoOracle(sansTg) === null && C.vetoOracle(absent) === null,
     'a vide, la regle ne refuse plus rien');
  process.env.SOCIAUX_EXIGES = 'site';
  ok(C.vetoOracle(sansTg) === null && /site/.test(C.vetoOracle({ dex: { vu: true, liens: [] } }) || ''),
     'et on peut n en exiger qu un');
  if (avant === undefined) delete process.env.SOCIAUX_EXIGES; else process.env.SOCIAUX_EXIGES = avant;

  /* ---- ET DANS UN TOUR COMPLET ---- */
  remise([jeton(0, { sansTelegram: true }), jeton(1, { sansTelegram: true })]);
  await C.tour();
  const v = C.vue();
  console.log('   ' + JSON.stringify(v.candidats.map((x) => x.sym + ' : ' + x.refus)));
  ok(C._etat().positions.length === 0,
     'un flux entier de jetons sans Telegram n ouvre aucune position');
  ok(v.candidats.every((x) => x.quiRefuse === 'oracle' && /telegram/.test(x.refus || '')),
     'et chacun porte la raison exacte, donc l audit dira demain ce que cette regle a coute');
  ok(v.sociauxExiges && v.sociauxExiges.length === 3,
     'la vue publie la regle en vigueur : une exigence qu on ne voit pas ne peut pas etre discutee');

  remise([jeton(0), jeton(1)]);
  await C.tour();
  ok(C._etat().positions.length > 0,
     'et les memes jetons, avec leurs trois reseaux, sont achetes : la regle refuse ce qui manque, '
     + 'pas tout');
}

/* ==========================================================================
 * 43. CE QU'ON ACHETE, ET COMMENT ON EN SORT
 *
 * « J'ai l'impression qu'il y a un souci sur les trades. Regarde comment
 *   fonctionnait ce bot pour les call, il fonctionnait bien. »
 *
 * Le releve de la colonie apres treize heures disait la meme chose que lui,
 * chiffres a l'appui : « achete ou retenu » rendait -38,9 % en moyenne, zero
 * monte, trois effondres — pendant que « note trop basse » rendait +93 %. Dix
 * positions ouvertes, toutes a prix jamais relu, capitalisations d'achat entre
 * 5 759 $ et 15 738 $.
 *
 * Le robot cite regle ca par deux choses, et ce sont elles qui sont reprises :
 * des PLANCHERS a l'entree (piscine, capitalisation, et des bornes de hausse
 * pour ne pas payer le sommet d'une bougie) et une SORTIE PAR MORCEAUX avec un
 * arret suiveur, au lieu du tout ou rien.
 * ======================================================================== */
async function planchersEtSortie() {
  console.log('\n-- les planchers d entree --');
  const P = C.planchers();
  console.log('   ' + JSON.stringify(P));
  ok(P.liq > 0 && P.mc > 0, 'une piscine et une capitalisation minimales sont posees');

  /* Une piscine sous le plancher : on n'achete pas ce qu'on ne pourra ni
     suivre ni vendre. */
  /* Petit ET calme : un gros volume sur une capitalisation minuscule declenche
     l'autre regle — « ce n'est plus un marche, c'est une sortie » — et l'essai
     mesurerait celle-la au lieu du plancher. */
  remise([jeton(0, { liq: 4000, mc: 4200, volH1: 900 }), jeton(1)]);
  await C.tour();
  let v = C.vue();
  let c0 = v.candidats.find((x) => x.sym === 'TOK0');
  console.log('   petite piscine : ' + JSON.stringify({ refus: c0 && c0.refus, qui: c0 && c0.quiRefuse }));
  ok(!!c0 && /plancher d'achat/.test(c0.refus || ''),
     'une piscine de 4 000 $ est ecartee, et le refus DIT le plancher : « ' + (c0 || {}).refus + ' »');
  ok(!C._etat().positions.some((p) => p.sym === 'TOK0'), 'aucune position ne s ouvre dessus');

  /* ---- ON N'ACHETE PAS LE SOMMET ----
   * C'est le refus le moins intuitif et le plus utile : le chiffre ne dit rien
   * du jeton, il dit OU L'ON ENTRE. */
  remise([jeton(0, { ch_m5: 240 }), jeton(1, { ch_h1: 400 }), jeton(2)]);
  await C.tour();
  v = C.vue();
  const pump5 = v.candidats.find((x) => x.sym === 'TOK0');
  const pump1 = v.candidats.find((x) => x.sym === 'TOK1');
  console.log('   deja monte : ' + JSON.stringify([pump5 && pump5.refus, pump1 && pump1.refus]));
  ok(!!pump5 && /cinq minutes/.test(pump5.refus || '') && /sommet/.test(pump5.refus || ''),
     'un +240 % en cinq minutes est refuse : « ' + (pump5 || {}).refus + ' »');
  ok(!!pump1 && /une heure/.test(pump1.refus || '') && /sommet/.test(pump1.refus || ''),
     'un +400 % en une heure aussi : « ' + (pump1 || {}).refus + ' »');
  ok(v.candidats.some((x) => x.sym === 'TOK2' && !x.refus),
     'et le jeton qui monte normalement passe : la borne ecarte l exces, pas la hausse');

  /* ---- LA REGLE QUI EXPLIQUE PASSE DEVANT CELLE QUI COMPTE ----
   * Les deux ecartent le meme jeton. Une seule apprend quelque chose a qui la
   * lit, et c est celle-la qu on veut dans l audit. */
  remise([jeton(0, { mc: 2000, liq: 2000, volH1: 40000 })]);
  await C.tour();
  c0 = C.vue().candidats[0];
  console.log('   volume sur rien : « ' + (c0 || {}).refus + ' »');
  ok(!!c0 && /ce n'est plus un marche/.test(c0.refus || ''),
     'le jeton a 2 000 $ avec un gros volume garde SA raison — « une sortie » — plutot que le '
     + 'plancher, qui dirait seulement « trop petit »');

  console.log('\n-- sortir par morceaux --');
  const E2 = C.echelle();
  console.log('   ' + JSON.stringify(E2));
  ok(E2.p1 < E2.p2 && E2.p2 < E2.p3, 'les trois paliers montent');
  ok(E2.v1 + E2.v2 + E2.v3 < 100,
     'et ils ne vendent pas tout : ' + (100 - E2.v1 - E2.v2 - E2.v3) + ' % restent pour la suite');

  /* Une position qui monte, palier par palier. Rien n'est simule ici : on
     joue l'echelle a la main sur des rendements donnes, et on regarde la
     tresorerie et le reste. */
  remise(sains());
  const F = C._etat();
  F.tresor = 1000;
  const p = { sym: 'X', pool: '0xp', mise: 100, prix0: 1, t0: Date.now() };
  ok(C.joueEchelle(p, 5, Date.now()) === false && p.reste === 1,
     'a +5 %, aucun palier : on ne vend pas pour rien');
  C.joueEchelle(p, E2.p1 + 1, Date.now());
  console.log('   apres le 1er palier : reste ' + p.reste + ' · tresorerie ' + F.tresor.toFixed(2));
  ok(Math.abs(p.reste - (1 - E2.v1 / 100)) < 1e-9,
     'au premier palier, ' + E2.v1 + ' % sont vendus et le reste continue (' + p.reste + ')');
  ok(F.tresor > 1000, 'et la tresorerie a encaisse SANS que la position soit fermee ($'
     + F.tresor.toFixed(2) + ')');
  const apres1 = F.tresor;
  C.joueEchelle(p, E2.p1 + 2, Date.now());
  ok(F.tresor === apres1 && Math.abs(p.reste - (1 - E2.v1 / 100)) < 1e-9,
     'un palier deja franchi ne se rejoue pas : sinon on vendrait la meme part a chaque tour');
  const fini = C.joueEchelle(p, E2.p3 + 1, Date.now());
  console.log('   apres tous les paliers : reste ' + p.reste.toFixed(3));
  ok(fini === false && p.reste > 0.001,
     'meme apres le dernier palier il reste une part : c est elle qui paie les rares gros coups');

  /* ---- L'ARRET SUIVEUR ----
   * Il ne dit pas quand vendre, il dit quand ARRETER DE TENIR. */
  console.log('\n-- l arret suiveur --');
  const q = { sym: 'Y', mise: 100, prix0: 1, t0: Date.now() };
  ok(C.arretSuiveur(q, 4) === null, 'sous le seuil d armement, il ne fait rien');
  ok(C.arretSuiveur(q, E2.suivDepart + 5) === null, 'une position qui MONTE n est jamais coupee');
  const bas = C.arretSuiveur(q, E2.suivDepart + 5 - E2.suivEcart - 1);
  console.log('   ' + bas);
  ok(!!bas && /plus haut/.test(bas),
     'mais une fois armee, la redescente sous le plus haut ferme — et la raison porte le chiffre : « '
     + bas + ' »');
  const q2 = { sym: 'Z', mise: 100, prix0: 1, t0: Date.now() };
  C.arretSuiveur(q2, E2.suivSerreA + 10);
  ok(!!C.arretSuiveur(q2, E2.suivSerreA + 10 - E2.suivSerre - 1),
     'et plus haut on est monte, plus l arret se resserre : ' + E2.suivSerre
     + ' points au lieu de ' + E2.suivEcart + ', parce qu une grosse redescente coute plus cher');

  /* ---- ET RIEN DE TOUT CA SUR UN PRIX QU'ON REFUSE ----
   * C'est le defaut qui a fait passer la tresorerie a vingt-sept milliards :
   * l'echelle encaissait avant que `ferme` rejette la lecture. */
  console.log('\n-- un prix impossible ne fait vendre aucun palier --');
  remise([jeton(0, { prix: 1e-12 })]);
  await C.tour();
  const avant = C._etat().tresor;
  for (const t of MONDE.jetons) t.prix = 0.001;      /* +99 999 999 900 % */
  for (const k of Object.keys(C._cache.dex)) delete C._cache.dex[k];
  await C.tour();
  const apres = C._etat().tresor;
  console.log('   tresorerie : ' + avant.toFixed(2) + ' → ' + apres.toFixed(2));
  ok(Math.abs(apres - avant) < 1000,
     'la tresorerie ne part pas en milliards : le meme garde-fou couvre les paliers et la '
     + 'fermeture ($' + apres.toFixed(2) + ')');

  /* ---- LA POSITION QU'ON NE SAIT PAS SUIVRE ----
   * Dix positions ouvertes treize heures sans un seul prix relu : elles ne
   * pouvaient plus se fermer, et elles tenaient toutes les places. */
  console.log('\n-- une position qu on ne sait pas suivre est abandonnee --');
  remise(sains());
  await C.tour();
  const G = C._etat();
  ok(G.positions.length > 0, 'des positions sont ouvertes (' + G.positions.length + ')');
  const n0 = G.positions.length;
  const p0 = G.positions[0];
  const delai = C.abandonDelai(p0);
  console.log('   delai d abandon : ' + Math.round(delai / 60000) + ' min');
  ok(delai >= 60 * 60000, 'le delai vaut au moins une heure : en dessous on abandonnerait des '
    + 'jetons que DexScreener n a simplement pas encore indexes');
  /* On recule leur derniere lecture au-dela du delai, et le monde se tait
     COMPLETEMENT : c'est le cas ou la passe doit encore agir, puisqu'elle ne
     depend d'aucun prix — le tour s'arrete alors sur « aucun jeton neuf assez
     liquide », et les positions perdues de vue le resteraient un tour de plus
     a chaque fois. */
  for (const x of G.positions) { x.prixLu = Date.now() - delai - 60000; x.t0 = x.prixLu; }
  MONDE.jetons = [];
  poolsPageFiltre = null;
  try { await C.tour(); } catch (e) { /* plus rien a lire : c'est le cas mesure */ }
  console.log('   positions : ' + n0 + ' → ' + C._etat().positions.length
    + ' · tresorerie ' + C._etat().tresor.toFixed(2));
  ok(C._etat().positions.length < n0,
     'celles dont le prix n a jamais pu etre relu sont abandonnees, au lieu de tenir la place '
     + 'pour toujours (' + n0 + ' → ' + C._etat().positions.length + ')');
  ok((C._etat().compteurs.abandonneeSansPrix || 0) > 0, 'et c est compte');
  ok(C.vue().alertes.some((a) => /abandonnees faute de prix/.test(a.quoi)),
     'une alerte le remonte, avec ce qu il faudrait faire');
  const fluxAband = C._etat().flux.find((f) => /jamais relu/.test(f.txt || ''));
  ok(!!fluxAband && /rien compte/.test(fluxAband.txt),
     'le fil dit que RIEN n a ete comptabilise : on n invente pas un zero pour cloturer '
     + 'proprement — ce zero entrerait dans la memoire des agents comme une observation');
}

/* ==========================================================================
 * 44. UN NOEUD QUI DIT « JE NE SERS PAS CETTE METHODE » EST CRU
 *
 * Releve sur la colonie : les deux noeuds dRPC ont rendu « the method
 * eth_getLogs does not exist/is not available » a chacun de leurs 12 402
 * appels. Zero reussite. Et on les rappelait a chaque lecture — deux echecs
 * certains payes avant d'atteindre le seul noeud qui repond, lequel saturait
 * alors sous toute la charge.
 * ======================================================================== */
async function methodeInconnue() {
  console.log('\n-- un noeud qui ne sert pas une methode n est plus rappele dessus --');
  remise(sains(), { drpcSansLogs: true });
  process.env.DRPC_API_KEY = 'cle-drpc';
  C.noeuds().forEach((n) => { delete n.sansMethode; });
  await C.tour();
  const a1 = appels.rpcCleLogs;
  console.log('   1er tour : ' + a1 + ' eth_getLogs au noeud a cle');
  ok(a1 > 0, 'il est essaye une premiere fois : on ne devine pas, on demande');
  const n = C.noeuds().find((x) => x.cle === 'chaineCle');
  ok(!!n && n.sansMethode && n.sansMethode.eth_getLogs,
     'sa reponse est RETENUE, telle qu il l a ecrite');
  /* On compte les `eth_getLogs` A LUI, pas tous ses appels : il garde
     `eth_blockNumber` et `eth_call`, et les compter ferait echouer l'essai sur
     un comportement qu'on veut justement conserver. */
  appels.rpcCleLogs = 0;
  for (const k of Object.keys(C._cache.chaine)) delete C._cache.chaine[k];
  await C.tour();
  console.log('   2e tour : ' + appels.rpcCleLogs + ' eth_getLogs au noeud a cle');
  ok(appels.rpcCleLogs === 0,
     'et il n est plus rappele pour cette methode-la (' + appels.rpcCleLogs + ') : c est autant '
     + 'd echecs certains qu on ne paie plus avant d atteindre le noeud qui repond');
  /* Mais il garde le reste : ce n est pas un bannissement. */
  const bloc = await C._rpc('eth_blockNumber');
  ok(!!bloc, 'il sert toujours les autres methodes : on retient une methode, pas un noeud');
  delete process.env.DRPC_API_KEY;
}

/* ==========================================================================
 * 45. LA SURVEILLANCE RAMENE
 *
 * La case existait ; rien ne l'ouvrait. Un jeton refuse a deux minutes pour
 * « pas encore verifiable sur DexScreener » ne revenait jamais, parce que le
 * seul chemin vers le pipeline etait le flux des nouveaux pools, ou il ne
 * figure plus cinq minutes plus tard.
 * ======================================================================== */
async function surveillanceRamene() {
  console.log('\n-- ce qu on a mis de cote revient quand il a l age d etre juge --');
  remise(sains());
  const F = C._etat();
  /* Un jeton connu, refuse sur un ETAT, qui avait frole le seuil, et qui a
     maintenant l'age d'etre indexe. */
  const a = MONDE.jetons[0].addr;
  F.connus[a] = { sym: 'TOK0', vu: 1, ne: Date.now() - 30 * 60000,
                  dernier: Date.now() - 25 * 60000,
                  verdict: 'pas encore verifiable sur DexScreener (2 min)', meilleure: 60 };
  const repris = await C.reprises(new Map());
  console.log('   repris : ' + JSON.stringify(repris.map((t) => t.sym + '/' + t.origine)));
  ok(repris.length === 1 && repris[0].origine === 'surveillance',
     'il est redemande a son adresse, et il porte l origine qui le dit');
  ok(F.connus[a].repris > 0, 'et la date est notee : on ne le redemande pas a chaque tour');
  const encore = await C.reprises(new Map());
  ok(encore.length === 0, 'juste apres, il n est pas redemande — l appel serait paye pour rien');

  /* Ce qui a ete banni ne revient jamais, et ce qui n a jamais frole le seuil
     non plus : le budget est petit, il va a ceux qui etaient pres de passer. */
  F.connus[a].repris = 0;
  F.connus[a].permanent = true;
  ok((await C.reprises(new Map())).length === 0, 'un jeton banni ne revient pas : son refus '
    + 'portait sur le CONTRAT, et un contrat ne change pas');
  F.connus[a].permanent = false;
  F.connus[a].meilleure = 5;
  ok((await C.reprises(new Map())).length === 0,
     'et un jeton qui n a jamais approche le seuil non plus');

  /* ---- ET IL PASSE LE CONTROLE DES RE-EXAMENS ----
   * L ecarter la pour « rien n a bouge » reviendrait a payer l appel qui le
   * ramene puis a jeter ce qu il rapporte. */
  ok(C.doitExaminer({ addr: a, origine: 'surveillance', minutes: 30, liq: 1, prix: 1 }).oui,
     'un jeton qu on est alle rechercher expres est examine, pas ecarte pour « deja juge »');
}

/* ==========================================================================
 * 46. ELLE DIT ELLE-MEME POURQUOI ELLE N'ACHETE PAS
 *
 * « Regarde pourquoi le bot ne trade pas. »
 *
 * Il a fallu relever l'etat sur le serveur et compter les refus un par un pour
 * repondre — alors que la colonie avait les chiffres. Ce qui est mesure ici :
 * quand rien ne s'ouvre pendant longtemps, elle NOMME la regle qui bloque le
 * plus, avec sa part et le reglage qui la gouverne. Pas « rien ne passe » :
 * trois filtres qui refusent chacun un tiers ne se corrigent pas comme un seul
 * qui refuse tout.
 * ======================================================================== */
async function pourquoiPasDAchat() {
  console.log('\n-- elle dit ce qui l empeche d acheter --');
  /* Un flux entier de jetons trop petits : ils passent tout le reste et
     tombent tous sur le meme plancher. */
  /* Des jetons DIFFERENTS a chaque tour : la colonie ne rejuge pas ce qu'elle
     a deja juge quand rien n'a bouge — c'est voulu, ca economise les appels —
     et un banc qui reservirait les six memes ne compterait donc que six refus
     pour vingt-quatre tours. En production le flux est neuf a chaque fois.

     On change le MONDE, pas l'etat : `remise` remet la colonie a neuf, et
     l'appeler dans la boucle effacerait a chaque tour les compteurs qu'on
     cherche justement a mesurer. */
  remise([0, 1, 2, 3, 4, 5].map((i) => jeton(i, { mc: 4000, liq: 4000, volH1: 2000 })));
  const F = C._etat();
  for (let k = 0; k < 24; k++) {
    MONDE.jetons = [0, 1, 2, 3, 4, 5].map((i) => jeton(k * 6 + i, { mc: 4000, liq: 4000, volH1: 2000 }));
    MONDE.prixDe = (a) => { const t = MONDE.jetons.find((x) => x.addr === a); return t ? t.prix : 0; };
    for (const c of Object.keys(C._cache)) for (const j of Object.keys(C._cache[c])) delete C._cache[c][j];
    F.tours = k;
    await C.tour();
  }
  const v = C.vue();
  console.log('   sans achat depuis ' + F.toursSansAchat + ' tours · '
    + (F.refusVus || 0) + ' refus vus');
  ok((F.toursSansAchat || 0) >= 20,
     'les tours sans achat sont comptes (' + F.toursSansAchat + ')');
  ok(Object.keys(F.refusFamilles || {}).length > 0,
     'et les refus sont ranges par FAMILLE : « piscine de $4548 » et « piscine de $6202 » sont '
     + 'la meme regle, et les compter separement les rendrait invisibles');
  const cles = Object.keys(F.refusFamilles);
  ok(cles.some((k) => /#/.test(k)),
     'les nombres sont remplaces par un caractere, c est ce qui les regroupe (« ' + cles[0] + ' »)');

  const a = v.alertes.find((x) => /Aucun achat depuis/.test(x.quoi));
  console.log('   ' + (a ? a.quoi : 'AUCUNE ALERTE'));
  ok(!!a, 'une alerte le dit');
  console.log('   ' + (a ? a.pourquoi.slice(0, 190) : ''));
  ok(!!a && /plancher d'achat/.test(a.pourquoi),
     'elle NOMME la regle qui bloque le plus, pas « rien ne passe »');
  /* Un volume faible : sinon c'est la regle du lavage qui tranche la premiere
     — « volume de $20000 sur une capitalisation de $4000 » — et l'essai
     mesurerait un autre refus que celui qu'il annonce. */
  ok(!!a && /%/.test(a.pourquoi), 'avec sa part des refus : une regle qui en fait 5 % ne se '
    + 'corrige pas comme une qui en fait 80 %');
  ok(!!a && /MC_ACHAT_MIN|LIQ_ACHAT_MIN/.test(a.pourquoi),
     'et le REGLAGE a toucher : une alerte qui dit ce qui bloque sans dire quoi bouger fait '
     + 'chercher dans le code');
  ok(!!a && /panneau/.test(a.quoiFaire) && /protege/.test(a.quoiFaire),
     'elle renvoie a l audit, qui seul dit si la regle protege ou si elle coute');

  /* ---- ET ELLE SE TAIT DES QUE CA REPART ----
   * Une alerte qui reste allumee apres la correction apprend a ne plus la
   * lire, et c'est alors la suivante qu'on ne lit plus. */
  remise(sains());
  await C.tour();
  const v2 = C.vue();
  console.log('   apres un achat : ' + C._etat().toursSansAchat + ' tour(s) sans achat');
  ok(C._etat().positions.length > 0, 'des positions se rouvrent sur un flux normal');
  ok((C._etat().toursSansAchat || 0) === 0, 'le compteur repart de zero');
  ok(!v2.alertes.some((x) => /Aucun achat depuis/.test(x.quoi)),
     'et l alerte s eteint : une alerte qui reste allumee apres la correction apprend a ne plus '
     + 'la lire');
}

(async () => {
  await isolement();
  await horsLigne();
  await sources();
  await montantIndexe();
  inconnu();
  await pieges();
  await personneNeGarde();
  await neufSeulement();
  await reglement();
  await survie();
  await partage();
  await pasDEmpilement();
  await surveillance();
  await troisFlux();
  await paresse();
  await banquier();
  await lavage();
  await multiplication();
  await services();
  await jetonSorti();
  await deuxNoeuds();
  await prixDate();
  await prixAberrant();
  await dejaRug();
  await pasDesPorteurs();
  await veilleEtProlongation();
  await strategie();
  await conseiller();
  await remiseAZero();
  await coingecko();
  await goplusCle();
  await drpcCle();
  await goplusSeContredit();
  await appelsInutiles();
  await bandesDage();
  await prendreUnGain();
  await quelNoeud();
  await livreDOmbre();
  await profilsDansLeTemps();
  await jalonsHonnetes();
  await traitsQuiSeparent();
  await epreuveDeVente();
  await presenceDuProjet();
  await planchersEtSortie();
  await methodeInconnue();
  await surveillanceRamene();
  await pourquoiPasDAchat();
  C.arrete();
  try { fs.rmSync(DOSSIER, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
  process.exitCode = rates ? 1 : 0;
})().catch((e) => { console.log('EXCEPTION : ' + (e && e.stack || e)); process.exitCode = 1; });
