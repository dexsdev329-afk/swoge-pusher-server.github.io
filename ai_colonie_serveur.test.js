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
  const suf = String(i).padStart(2, '0');
  return {
    addr: '0xt0ken' + suf + '0000000000000000000000000000000' + suf.slice(-1),
    sym: 'TOK' + i,
    pool: '0xp001' + suf + '0000000000000000000000000000000' + suf.slice(-1),
    prix: o.prix === undefined ? 1 : o.prix,
    liq: o.liq === undefined ? 50000 : o.liq,
    mc: o.mc === undefined ? 300000 : o.mc,
    minutes: o.minutes === undefined ? 12 : o.minutes,
    porteurs: o.porteurs === undefined ? 130 : o.porteurs,
    indexe: !!o.indexe,          /* le montant est dans topics[3], pas dans data */
    goplus: o.goplus === undefined ? 'propre' : o.goplus,   /* propre | muet | honeypot */
    unSeulPorteur: !!o.unSeulPorteur,
    personneNeGarde: !!o.personneNeGarde,   /* chacun recoit puis renvoie : solde net nul */
    buys: o.buys === undefined ? 120 : o.buys,
    sells: o.sells === undefined ? 60 : o.sells,
    buyers: o.buyers === undefined ? 80 : o.buyers,
  };
}

function mondeNeuf(jetons) {
  return {
    jetons,
    prixDe: (a) => { const t = jetons.find((x) => x.addr === a); return t ? t.prix : 0; },
    coupe: false,
    bloc: 5000000,
  };
}

function poolsPage(page) {
  /* Le vrai flux rend vingt pools par page ; on met tout sur la premiere et
     on laisse les suivantes vides, ce qu'il fait aussi en fin de flux. */
  const liste = page === 1 ? MONDE.jetons : [];
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
        volume_usd: { m5: 2000, h1: 20000, h6: 60000, h24: 90000 },
        price_change_percentage: { m5: '8', h1: '20', h6: '35' },
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
  if (t.goplus === 'honeypot') {
    return { code: 1, result: { [t.addr]: {
      is_honeypot: '1', buy_tax: '0', sell_tax: '0.99', is_open_source: '0',
      holder_count: '4', is_proxy: '0', is_mintable: '1' } } };
  }
  return { code: 1, result: { [t.addr]: {
    is_honeypot: '0', cannot_buy: '0', transfer_pausable: '0', owner_change_balance: '0',
    selfdestruct: '0', personal_slippage_modifiable: '0', honeypot_with_same_creator: '0',
    slippage_modifiable: '0', trading_cooldown: '0', is_proxy: '0', is_mintable: '0',
    buy_tax: '0', sell_tax: '0', is_open_source: '1',
    holder_count: String(t.porteurs),
    holders: [{ address: '0xh1', percent: '0.02', is_contract: 0, is_locked: 0, tag: '' }],
    lp_holders: [{ address: ZERO, percent: '1', is_locked: 1, tag: 'burn' }] } } };
}

function logsDe(t) {
  /* Une emission depuis l'adresse nulle vers N porteurs. C'est exactement ce
     que la chaine contient quelques minutes apres la naissance d'un jeton, et
     c'est de la somme de ces lignes que sortent « combien de porteurs » et
     « quelle part tient le premier ». */
  const out = [];
  const cibles = t.unSeulPorteur ? 1 : t.porteurs;
  const part = t.unSeulPorteur ? 1000000 : 1000;
  const ligne = (de, vers) => {
    const topics = [SUJET, pad(de), pad(vers)];
    let data = hex(part);
    if (t.indexe) { topics.push(hex(part)); data = '0x'; }  /* montant INDEXE */
    return { topics, data };
  };
  for (let i = 0; i < cibles; i++) {
    const a = '0x' + String(i).padStart(40, 'a');
    out.push(ligne(ZERO, a));
    /* Releve sur la vraie chaine : soixante et un transferts, trente adresses,
       toutes a zero net, et la piscine tenant l'emission entiere. Chacun entre
       et ressort aussitot. */
    if (t.personneNeGarde) out.push(ligne(a, t.pool));
  }
  return out;
}

global.fetch = async function (url, opts) {
  url = String(url);
  const rep = (o, st) => ({ ok: st === undefined || st < 400, status: st || 200, json: async () => o });
  if (MONDE.coupe) throw new Error('Failed to fetch');

  if (/new_pools/.test(url)) {
    appels.pools++;
    const page = parseInt((url.match(/page=(\d+)/) || [])[1] || '1', 10);
    return rep(poolsPage(page));
  }
  if (/gopluslabs/.test(url)) {
    appels.goplus++;
    const a = (url.split('contract_addresses=')[1] || '').toLowerCase();
    const t = MONDE.jetons.find((x) => x.addr === a);
    return rep(t ? goplusDe(t) : { result: {} });
  }
  if (/ohlcv/.test(url)) {
    appels.ohlcv++;
    const l = [];
    for (let i = 0; i < 24; i++) l.push([Date.now() / 1000 - i * 900, 1, 1, 1, 1 + (i % 3) * 0.03]);
    return rep({ data: { attributes: { ohlcv_list: l } } });
  }
  if (/dexscreener/.test(url)) {
    appels.dex++;
    const a = (url.split('/tokens/')[1] || '').toLowerCase();
    const t = MONDE.jetons.find((x) => x.addr === a);
    if (!t) return rep({ pairs: [] });
    return rep({ pairs: [{ chainId: 'robinhood', priceUsd: String(t.prix),
      liquidity: { usd: t.liq }, info: { socials: [{ type: 'twitter' }], websites: [{}] } }] });
  }
  if (/rpc\.mainnet\.chain\.robinhood/.test(url)) {
    appels.rpc++;
    const b = JSON.parse(opts.body);
    if (b.method === 'eth_blockNumber') return rep({ result: hex(MONDE.bloc) });
    if (b.method === 'eth_getLogs') {
      const a = String(b.params[0].address || '').toLowerCase();
      const t = MONDE.jetons.find((x) => x.addr === a);
      return rep({ result: t ? logsDe(t) : [] });
    }
    return rep({ result: null });
  }
  throw new Error('service non prevu : ' + url);
};

const C = require('./ai_colonie.js');

function remise(jetons) {
  MONDE = mondeNeuf(jetons);
  appels = { pools: 0, goplus: 0, ohlcv: 0, dex: 0, rpc: 0 };
  for (const k of Object.keys(C._cache)) for (const j of Object.keys(C._cache[k])) delete C._cache[k][j];
  for (const k of Object.keys(C._prix)) delete C._prix[k];
  C._pose(C.etatNeuf());
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
  const base = { addr: '0xa', sym: 'A', liq: 50000, prix: 1, mc: 3e5, minutes: 9, ch_m5: 8,
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
  ok(avant > 0, avant + ' position(s) ouverte(s) a $1,00');

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
  ok(v.trades === avant, 'toutes les positions dues se ferment (' + v.trades + ')');

  /* +50 % sur une mise de $50, c est +$25 par position. Le chiffre doit
     tomber juste : c est la preuve que le rendement vient du prix relu et
     non d une estimation. */
  const attendu = C.DEPART + avant * C.MISE * 0.5;
  console.log('   tresorerie : ' + v.tresor.toFixed(2) + ' · attendu ' + attendu.toFixed(2));
  ok(Math.abs(v.tresor - attendu) < 0.01,
     'la tresorerie suit exactement le prix rendu : +50 % sur $' + C.MISE + ' × ' + avant
     + ' = $' + (avant * C.MISE * 0.5).toFixed(2));
  ok(v.gains === avant, 'et les gagnantes sont comptees comme telles');

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
  C.arrete();
  try { fs.rmSync(DOSSIER, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
  process.exitCode = rates ? 1 : 0;
})().catch((e) => { console.log('EXCEPTION : ' + (e && e.stack || e)); process.exitCode = 1; });
