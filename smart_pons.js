'use strict';
/* ==================================================================
 * LANCEMENTS PONS, IGNITION, COPIE, REBOND — LES REGLES DU BRIEF V2 (15/10/2026)
 * ==================================================================
 *
 * Fonctions PURES : aucun reseau, aucune horloge (l'instant arrive en
 * argument). Le module qui lit la chaine est smart_lancements.js.
 *
 * Le brief v2 du proprietaire (smart_brief.BRIEF2, table smart_listes.BRIEF2)
 * dit comment ne plus rater un jeton comme $JUDGEBOT : lire les lancements
 * sur la chaine, connaitre les devs, suivre la courbe. Ses CHIFFRES sont les
 * siens (etude de son autre bot). Chaque constante ci-dessous dit d'ou elle
 * vient : « brief » (le texte du proprietaire), « sonde » (lu sur la chaine le
 * 15/10, EXPLOITATION.md « Lancements Pons »), ou « CHOISI » (aucune mesure).
 *
 * ---- CE QUE LA CHAINE A CONFIRME (sonde du 15/10, noeud public) ----
 *  - keccak256("TokenLaunched(address,address,address,address,uint256,uint256)")
 *    = 0x8d4aad49…9607, celui du brief ; il est emis par l'usine 0x7ed598bc… :
 *    topics = [sig, jeton, courbe, deployer], data = [cote, config, seuil].
 *    Le mot que le brief appelle « pair » est la MONNAIE DE COTATION, pas une
 *    paire : 0 (ETH) pour 46 lancements sur 66 en une heure, sinon USDG ou un
 *    autre jeton ; le seuil est dans cette monnaie (4,2 ETH quand c'est l'ETH).
 *  - keccak256("TokenLaunched(address,address,address,uint256,uint256)")
 *    = 0xfedb51b1…1755, celui du brief pour IGNITION : topics = [sig, jeton,
 *    crochet], data = [createur, u1, u2].
 *  - Les trois topics TRONQUES du brief, retrouves dans les vrais journaux de
 *    la courbe de JUDGEBOT (0x3d74fc75…) et de son lancement (tx 0xd78adcc1…),
 *    puis NOMMES (analyse du bytecode REA + evmole, noms openchain, rapport du
 *    coordinateur du 15/10) et RECALCULES par keccak256 ici : identiques.
 *      CurveBuy(address,address,uint256,uint256,uint256,uint256)  0xec36bf57…c455
 *                topics [sig, expediteur, destinataire], data [montant en cote,
 *                jetons, frais 1 % (feeBps 100), taxe du createur 2 % (creatorTaxBps 200)]
 *      CurveSell(meme forme)        0x8113d738…59df  data [jetons, montant en cote, frais, taxe]
 *      SnipeTaxExempted(address)    0xe4b7e48f…a8c7  topics [sig, adresse exemptee]
 *  - La graduation : CurveCompleted(address,uint256,uint256) 0xf8d37a90…fb67,
 *    emis par la COURBE, sans topic indexe (sonde : 2 en ~330 000 blocs ; la
 *    courbe 0x2f20f91e… rend ensuite graduated() = 1). CORRECTION du 15/10 :
 *    0x308c390e… (usine) et 0x2cc664e1… (courbe), d'abord pris pour la
 *    graduation, sont CreatorFeeRecipientUpdated (le 0 de solde de la courbe
 *    0x3cbb7020… venait de sa cote en jeton, pas d'une graduation).
 *  - La taxe : creatorTaxBps() de la courbe (JUDGEBOT : 200, soit 2 %) ; la
 *    regle « taxe > 5 % » du brief se lit donc sur la courbe meme.
 * ================================================================== */

const L = require('./smart_listes');

const TOPIC = {
  LANCE_PONS: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  LANCE_IGNITION: '0xfedb51b13e7432bcb4a213b2be92ee7637c20671f653bf0892174f0e4a261755',
  ACHAT: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  VENTE: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  EXEMPTION: '0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7',
  GRADUATION_COURBE: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',   // CurveCompleted(address,uint256,uint256)
};
/* Les fonctions view des jetons Pons (brief : description(), logo(),
   socials()). Sonde du 15/10 sur JUDGEBOT : les trois repondent ; socials()
   rend CINQ chaines (le 1er est le lien X : « https://x.com/sopersone », les
   quatre autres vides), pas une seule ; 23 jetons lus, tous avec un logo, 20
   avec un lien X. curve() rend l'adresse de la courbe. */
const SELECTEUR = { DESCRIPTION: '0x7284e416', LOGO: '0xfb7f21eb', SOCIALS: '0x53cd512a', SYMBOL: '0x95d89b41', CURVE: '0x7165485d', SLOT0: '0x3850c7bd',
  /* sur la COURBE (sonde du 15/10, JUDGEBOT) : creatorTaxBps() = 200, realQuoteReserve() = 1,166 ETH */
  CREATOR_TAX: '0xc1bb8901', REAL_QUOTE: '0x4f1f58fd' };   // keccak256('creatorTaxBps()'), keccak256('realQuoteReserve()')
const ADR = {
  USINE_PONS: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  /* l'entree des lancements : tx.to de JUDGEBOT et de 95 des 200 derniers
     lancements (sonde) ; elle emet 0xdcacba5e… avec le deployer et l'achat */
  ENTREE_PONS: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  /* WETH/USDG v3 (smart_money.REF_USDG_ETH) : WETH = token0, USDG 6 decimales
     (sonde du 15/10 : slot0 -> 2 455 USDG par ETH) */
  REF_ETH_USDG: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca',
  ETH: '0x0000000000000000000000000000000000000000',
  DEV_IGNITION_V1: '0x7d17bfa7383e42e8df00ae042dcaf24748dd69b9',
};

// ------------------------------------------------------------ les seuils
/* « A T+2 min » : 1 189 blocs. Sonde du 15/10 : JUDGEBOT lance au bloc
   89 565 235 a 22:00:56 UTC ; le dernier bloc a <= 22:02:56 est 89 566 424
   (dichotomie sur les en-tetes) ; 6 000 blocs = 607 s (0,1012 s par bloc). */
const BLOCS_2MIN = 1189;
const T2_ACHETEURS = 20;                 // brief : « +20 acheteurs uniques »
const T2_ETH = 1.5;                      // brief : « ou >= 1,5 ETH achetes » (hors achats du dev : CHOISI, voir etatCourbe)
const DEV_GROS_ETH = 2;                  // brief : « le dev achete >= 2 ETH » (sonde : 0 sur les 200 derniers lancements)
const PLATEFORME_DEV_MIN_ETH = L.BRIEF2.PLATEFORME_DEV_MIN_ETH;   // brief : « avec >= 1 ETH du dev »
/* « achat minuscule » : le brief ne chiffre pas. CHOISI : 0,01 ETH, la
   poussiere de smart_calcul (MISE_MIN_WEI). JUDGEBOT : 0,028 ETH, donc pas
   minuscule (sonde). */
const ACHAT_MINUSCULE_ETH = 0.01;
/* « <= 1 exemption anti-snipe (×0,1) » : on compte les EVENEMENTS
   d'exemption de la courbe. Sonde : JUDGEBOT en porte 2, toutes deux pour le
   dev (1 adresse distincte) ; compte en adresses distinctes, JUDGEBOT aurait
   ce mauvais signe. Le brief ne dit pas lequel : ambigu, dit au rapport. */
const EXEMPTIONS_MIN = 2;
/* « logo pris sur un outil de sniper (axiom, gmgn, twimg) » : sonde sur 20
   lancements, 3 logos axiomtrading-v2.axiom-cdn.io et 2 pbs.twimg.com. */
const LOGO_SNIPER = /(axiom|gmgn|twimg)/i;
const TAXE_MAX = 5;                      // brief : « taxe > 5 % » ; lue sur la courbe : creatorTaxBps() / 100
/* Les frais de la courbe, a l'aller : 1 % + 2 % du montant (sonde : achat du
   dev de JUDGEBOT, 0,028 ETH -> 0,00028 + 0,00056) ; au retour, une vente du
   meme jour : 3,1 %. L'ombre d'un signal sur la courbe se juge NETTE de
   l'aller-retour : 6 points. */
const FRAIS_COURBE_AR_PCT = 6;
/* Le droit de lancement paye par tx.value en plus de l'achat : 0,0005 ETH
   (sonde : evenement 0x85177f28 de 0x31ea5b45… dans la tx de JUDGEBOT ;
   tx.value 0,0285 = achat 0,028 + 0,0005). D'ou l'achat du dev lu dans le
   Buy de la courbe, tx.value seulement a defaut. */
const DROIT_LANCEMENT_ETH = 0.0005;
// section 6 (brief)
const ACHAT_MIN_USD = 50;
const PART_CAP_MIN_PCT = 0.02;
const CAP_MAX_USD = 1e6;
// section 7 (brief)
const CHUTE_MIN_PCT = 50;
const REBOND_MIN_PCT = 20;
const LIQ_REBOND_MIN_USD = 8000;
/* « stop juste sous le creux » : CHOISI 5 % sous le creux (le brief ne chiffre pas) */
const STOP_SOUS_CREUX_PCT = 5;
/* « profil payé, pubs, boosts récents » : « recent » CHOISI = 24 h */
const PROMO_RECENTE_MS = 24 * 3600e3;
// section 8 (brief)
const PLAN_V2 = { stopSuiveurPct: 30, venteAx2Pct: 75, gardePct: 25, objectifFinal: 10 };
const PLAN_V2_TEXTE = 'petite mise fixe ; stop suiveur de 30 % ; vendre 75 % à ×2, garder 25 % pour le rare ×10 ; sortir si le dev vend ; accepter de perdre environ 7 trades sur 10';

/* Les lignes d'audit de la colonie, une par source (smartSignal) : une ligne
   par source pour le vert, une seule pour tout le jaune. */
const SOURCES = { LANCEMENT: 'lancement', DEV: 'dev', IGNITION: 'ignition', COPIE: 'copie', REBOND: 'rebond' };

// ------------------------------------------------------------ petits outils
const lc = (x) => String(x == null ? '' : x).toLowerCase();
const adrDe = (topic) => ('0x' + String(topic || '').slice(-40)).toLowerCase();
const mots = (data) => { const d = String(data || '0x').slice(2); const o = []; for (let k = 0; k + 64 <= d.length; k += 64) o.push(d.slice(k, k + 64)); return o; };
const u256 = (w) => (w ? BigInt('0x' + w) : 0n);
const num = (h) => (typeof h === 'number' ? h : parseInt(h, 16));
const versEth = (wei) => Number(wei / 10n ** 12n) / 1e6;
const fini = (x) => typeof x === 'number' && isFinite(x);

// ------------------------------------------------------------ decodage
function decodeLancementPons(l) {
  if (!l || lc(l.topics && l.topics[0]) !== TOPIC.LANCE_PONS || (l.topics || []).length < 4) return null;
  const w = mots(l.data);
  return { plateforme: 'pons', usine: lc(l.address), jeton: adrDe(l.topics[1]), courbe: adrDe(l.topics[2]), deployer: adrDe(l.topics[3]),
    cote: w[0] ? adrDe(w[0]) : ADR.ETH, config: u256(w[1]), seuil: u256(w[2]), bloc: num(l.blockNumber), tx: lc(l.transactionHash), i: num(l.logIndex || 0) };
}
function decodeLancementIgnition(l) {
  if (!l || lc(l.topics && l.topics[0]) !== TOPIC.LANCE_IGNITION || (l.topics || []).length < 3) return null;
  const w = mots(l.data);
  return { plateforme: 'ignition', usine: lc(l.address), jeton: adrDe(l.topics[1]), crochet: adrDe(l.topics[2]), createur: w[0] ? adrDe(w[0]) : null,
    u1: u256(w[1]), u2: u256(w[2]), bloc: num(l.blockNumber), tx: lc(l.transactionHash), i: num(l.logIndex || 0) };
}
/** Un journal de courbe : achat, vente, exemption, graduation ; null sinon. */
function decodeCourbe(l) {
  if (!l || !l.topics || !l.topics.length) return null;
  const t0 = lc(l.topics[0]);
  const base = { courbe: lc(l.address), bloc: num(l.blockNumber), tx: lc(l.transactionHash), i: num(l.logIndex || 0) };
  if (t0 === TOPIC.ACHAT && l.topics.length >= 3) { const w = mots(l.data); return Object.assign(base, { genre: 'achat', expediteur: adrDe(l.topics[1]), destinataire: adrDe(l.topics[2]), cote: u256(w[0]), jetons: u256(w[1]) }); }
  if (t0 === TOPIC.VENTE && l.topics.length >= 3) { const w = mots(l.data); return Object.assign(base, { genre: 'vente', expediteur: adrDe(l.topics[1]), destinataire: adrDe(l.topics[2]), jetons: u256(w[0]), cote: u256(w[1]) }); }
  if (t0 === TOPIC.EXEMPTION && l.topics.length >= 2) return Object.assign(base, { genre: 'exemption', qui: adrDe(l.topics[1]) });
  if (t0 === TOPIC.GRADUATION_COURBE) return Object.assign(base, { genre: 'graduation' });
  return null;
}
/** Une chaine ABI (string) ; null si illisible. Bornee, sans caracteres de
 *  controle (elle finit dans un message HTML). */
function chaineAbi(hex) {
  try {
    const d = String(hex || '').slice(2);
    if (d.length < 128) return null;
    const off = Number(BigInt('0x' + d.slice(0, 64))) * 2;
    return chaineA(d, off);
  } catch (e) { return null; }
}
function chaineA(d, off) {
  const n = Number(BigInt('0x' + d.slice(off, off + 64)));
  if (!(n >= 0) || n > 4096) return null;
  const b = Buffer.from(d.slice(off + 64, off + 64 + n * 2), 'hex').toString('utf8');
  return b.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
}
/** socials() : cinq chaines (sonde). Rend un tableau de chaines non vides. */
function decodeSocials(hex) {
  try {
    const d = String(hex || '').slice(2);
    if (d.length < 64 * 5) return null;
    const out = [];
    for (let k = 0; k < 5; k++) { const off = Number(BigInt('0x' + d.slice(k * 64, k * 64 + 64))) * 2; const s = chaineA(d, off); if (s) out.push(s); }
    return out;
  } catch (e) { return null; }
}
const lienX = (socials) => (socials || []).find((s) => /^https?:\/\/(www\.)?(x|twitter)\.com\/[A-Za-z0-9_]+/i.test(s)) || null;
const hoteDe = (url) => { const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || '')); return m ? m[1].toLowerCase() : null; };

/** Le prix ETH d'un ETH en USDG lu dans slot0 de la reference (WETH token0,
 *  18 decimales ; USDG token1, 6 decimales). */
function ethUsdDepuisSlot0(hex) {
  try {
    const sq = BigInt('0x' + String(hex).slice(2, 66));
    if (sq <= 0n) return null;
    const p = Number((sq * sq * 10n ** 12n * 1000000n) >> 192n) / 1e6;
    return p > 100 && p < 1e6 ? p : null;
  } catch (e) { return null; }
}

// ------------------------------------------------------------ l'etat d'une courbe
/**
 * Les evenements d'une courbe -> son etat, jusqu'au bloc `jusqua` (inclus).
 * `devs` : les adresses du dev (deployer, tx.from, son groupe connu).
 * Rend { acheteurs (distincts, hors dev), achete (en cote, BigInt), ventesDev,
 * exemptions, exemptes (distincts), gradue, dernierPrix ({ cote, jetons }),
 * achatsDev (en cote) }.
 */
function etatCourbe(evts, o) {
  const devs = new Set(((o && o.devs) || []).map(lc));
  const jusqua = o && fini(o.jusqua) ? o.jusqua : Infinity;
  const ach = new Set(); const exemptes = new Set();
  let achete = 0n, ventesDev = 0, exemptions = 0, gradue = false, dernier = null, achatsDev = 0n;
  for (const e of (evts || []).slice().sort((a, b) => a.bloc - b.bloc || a.i - b.i)) {
    if (e.bloc > jusqua) continue;
    if (e.genre === 'achat') {
      /* « >= 1,5 ETH achetes » a T+2 : par d'autres que le dev (CHOISI : le
         dev pourrait acheter 1,5 ETH lui-meme ; son achat a son propre
         signal, >= 2 ETH) */
      if (devs.has(e.destinataire)) achatsDev += e.cote; else { ach.add(e.destinataire); achete += e.cote; }
      if (e.jetons > 0n) dernier = { cote: e.cote, jetons: e.jetons, bloc: e.bloc };
    } else if (e.genre === 'vente') {
      if (devs.has(e.expediteur) || devs.has(e.destinataire)) ventesDev++;
      if (e.jetons > 0n) dernier = { cote: e.cote, jetons: e.jetons, bloc: e.bloc };
    } else if (e.genre === 'exemption') { exemptions++; exemptes.add(e.qui); }
    else if (e.genre === 'graduation') gradue = true;
  }
  return { acheteurs: ach.size, achete, ventesDev, exemptions, exemptes: exemptes.size, gradue, dernierPrix: dernier, achatsDev };
}
/** La capitalisation (USD) d'un jeton sur une courbe cotee en ETH, au prix du
 *  dernier echange : (cote / jetons) × offre × ETH/USD. */
function capCourbeUsd(dernier, offre, ethUsd) {
  if (!dernier || !(dernier.jetons > 0n) || !(offre > 0n) || !fini(ethUsd)) return null;
  const eth = Number((dernier.cote * offre * 1000000n) / dernier.jetons) / 1e6 / 1e18;
  return Math.round(eth * ethUsd);
}

// ------------------------------------------------------------ section 2 : le lancement
/**
 * Le jugement d'un lancement. `f` :
 *   lancement   decode (pons ou ignition)
 *   tx          { from, to, value (hex|BigInt), gas, maxFeePerGas } | null
 *   achatDevEth l'achat du dev lu dans le Buy de la courbe (null : non lu)
 *   exemptions  nombre d'evenements d'exemption de la courbe (null : non lu)
 *   meta        { logo, socials: [], description } | null (non lu)
 *   taxe        % (null : non lue — toujours sur la courbe)
 *   finances    Set des wallets finances par Relay depuis les wallets Solana
 *   devVend     true | false | null
 * Rend { alerte, verdict ('vert'|'jaune'|'rouge'), source, signaux, mauvais,
 * attention, inconnues, risque, devConnu }.
 */
function jugeLancement(f) {
  const l = f.lancement || {};
  const tx = f.tx || null;
  const from = tx ? lc(tx.from) : null, to = tx ? lc(tx.to) : null;
  const dep = l.deployer || l.createur || null;
  const qui = [dep, from].filter(Boolean);
  const signaux = [], mauvais = [], attention = [], inconnues = [];
  const coteEth = l.plateforme !== 'pons' || !l.cote || l.cote === ADR.ETH;
  /* l'achat du dev : le Buy de la courbe, sinon tx.value moins le droit de lancement */
  let achat = fini(f.achatDevEth) ? f.achatDevEth : null;
  let achatSource = achat === null ? null : 'curve Buy';
  if (achat === null && tx && tx.value != null && coteEth) { achat = Math.max(0, versEth(BigInt(tx.value)) - DROIT_LANCEMENT_ETH); achatSource = 'tx.value'; }
  const dc = qui.map((a) => L.devConnu(a)).find(Boolean) || null;
  if (dc) signaux.push({ cle: 'dev_connu', texte: 'dev connu : ' + dc.groupe });
  if (l.plateforme === 'ignition') signaux.push({ cle: 'usine_ignition', texte: 'usine IGNITION ' + l.usine.slice(0, 10) + '…' });
  if (qui.includes(L.BRIEF2.IGNITION.wallet) || qui.includes(ADR.DEV_IGNITION_V1)) signaux.push({ cle: 'wallet_ignition', texte: 'wallet de l’équipe IGNITION' });
  const fin = f.finances || new Set();
  const finance = qui.find((a) => fin.has(a));
  if (finance) signaux.push({ cle: 'finance_relay', texte: 'wallet financé par Relay depuis un wallet Solana d’IGNITION' });
  if (f.meta && f.meta.logo && hoteDe(f.meta.logo) === L.BRIEF2.IGNITION.imagesHote) signaux.push({ cle: 'image_ignition', texte: 'image hébergée sur ' + L.BRIEF2.IGNITION.imagesHote });
  if (coteEth && achat !== null && achat >= DEV_GROS_ETH) signaux.push({ cle: 'dev_2eth', texte: 'le dev achète ' + achat.toFixed(2).replace('.', ',') + ' ETH' });
  const plat = L.BRIEF2.PLATEFORMES.find((p) => p.adresse === dep || p.adresse === to);
  if (plat) {
    if (achat !== null && achat >= PLATEFORME_DEV_MIN_ETH) signaux.push({ cle: 'plateforme', texte: 'plateforme ' + plat.nom + ' avec ' + achat.toFixed(2).replace('.', ',') + ' ETH du dev' });
    else attention.push({ cle: 'plateforme_petit', texte: 'plateforme ' + plat.nom + ' sans 1 ETH du dev' });
  }
  if (qui.some((a) => L.BRIEF2.RELAIS.includes(a))) attention.push({ cle: 'relais', texte: 'relais de l’« usine à graduation » : bundle, vendre vite' });
  /* les mauvais signes */
  if (achat === null) inconnues.push('achat_dev');
  else if (achat < ACHAT_MINUSCULE_ETH) mauvais.push({ cle: 'achat_dev_minuscule', texte: achat === 0 ? 'aucun achat du dev' : 'achat du dev minuscule (' + achat.toFixed(4).replace('.', ',') + ' ETH)' });
  if (f.exemptions == null) inconnues.push('exemptions');
  else if (f.exemptions < EXEMPTIONS_MIN) mauvais.push({ cle: 'exemptions', texte: f.exemptions + ' exemption anti-snipe (×0,1 selon le brief)' });
  if (!f.meta) inconnues.push('meta');
  else {
    if (f.meta.logo && LOGO_SNIPER.test(hoteDe(f.meta.logo) || f.meta.logo)) mauvais.push({ cle: 'logo_sniper', texte: 'logo pris sur un outil de sniper (' + hoteDe(f.meta.logo) + ')' });
    if (!lienX(f.meta.socials)) mauvais.push({ cle: 'pas_de_x', texte: 'pas de lien X' });
  }
  if (fini(f.taxe)) { if (f.taxe > TAXE_MAX) mauvais.push({ cle: 'taxe', texte: 'taxe de ' + f.taxe + ' %' }); }
  else inconnues.push('taxe');
  /* un copieur d'IGNITION : maxFee 0,2 gwei et gaz < 5,8 M (brief) */
  const cop = L.BRIEF2.IGNITION.copieurs;
  const ignition = signaux.some((s) => /ignition|finance_relay/.test(s.cle));
  if (ignition && tx && tx.maxFeePerGas != null && tx.gas != null && Number(BigInt(tx.maxFeePerGas)) === cop.maxFeeWei && Number(BigInt(tx.gas)) < cop.gazMax) mauvais.push({ cle: 'copieur_ignition', texte: 'signature d’un copieur d’IGNITION (maxFee 0,2 gwei, gaz < 5,8 M)' });

  const source = ignition ? SOURCES.IGNITION : dc ? SOURCES.DEV : SOURCES.LANCEMENT;
  const alerte = signaux.length > 0 || attention.some((a) => a.cle === 'relais');
  let verdict;
  if (f.devVend === true) verdict = 'rouge';
  else if (!signaux.length) verdict = alerte ? 'jaune' : 'rouge';
  else if (!mauvais.length && !attention.length && !inconnues.filter((x) => x !== 'taxe').length) verdict = 'vert';
  else verdict = 'jaune';
  /* le risque principal : le dev qui vend, sinon le premier mauvais signe, le
     relais, une inconnue, et a defaut la verite du brief */
  let risque;
  if (f.devVend === true) risque = 'le dev ou ses wallets vendent : sortir';
  else if (attention.length) risque = attention[0].texte;
  else if (mauvais.length) risque = mauvais[0].texte;
  else if (inconnues.length) risque = 'non lu : ' + inconnues.join(', ');
  else risque = 'la plupart rechutent de 60 à 90 % après leur premier pic (brief)';
  return { alerte, verdict, source, signaux, mauvais, attention, inconnues, risque, devConnu: dc, achatDevEth: achat, achatSource, coteEth };
}

/** T+2 min (section 2) : bon signe, sortir, ou rien. `etat` = etatCourbe(...)
 *  jusqu'a lancement + BLOCS_2MIN. Le montant n'est en ETH que si la courbe
 *  est cotee en ETH : sinon seul le nombre d'acheteurs compte. */
function jugeT2(etat, o) {
  const coteEth = !(o && o.coteEth === false);
  const eth = coteEth ? versEth(etat.achete) : null;
  const bon = !etat.gradue && (etat.acheteurs >= T2_ACHETEURS || (eth !== null && eth >= T2_ETH));
  return { bon, sortir: etat.ventesDev > 0, gradue: etat.gradue, acheteurs: etat.acheteurs, eth };
}

// ------------------------------------------------------------ sections 4 et 6 : la copie
/**
 * Un achat d'un wallet suivi (section 4), passe aux filtres de la section 6.
 * `a` : { wallet, txFrom, listeMemeTx (wallets de la liste servis par la meme
 * tx), usd, capUsd, ageMin, exclusJeton (raison : action, stablecoin…),
 * marche (true : piscine ou courbe active) }.
 * Rend { garde, raison, voix, nom, inconnues }.
 */
function filtreCopie(a) {
  const r = L.roleV2(a.wallet);
  if (!r) return { garde: false, raison: 'not followed' };
  if (r.role === 'exclu') return { garde: false, raison: 'excluded (section 5)' };
  if (!a.txFrom) return { garde: false, raison: 'tx not read' };
  if (lc(a.txFrom) !== lc(a.wallet)) return { garde: false, raison: 'tx not sent by the wallet (tx.from ' + lc(a.txFrom).slice(0, 10) + '…)' };
  if ((a.listeMemeTx || 0) >= 2) return { garde: false, raison: 'one tx to ' + a.listeMemeTx + ' listed wallets: airdrop' };
  if (a.exclusJeton) return { garde: false, raison: a.exclusJeton };
  if (a.marche === false) return { garde: false, raison: 'no market and no active curve' };
  const inconnues = [];
  if (fini(a.usd)) { if (a.usd < ACHAT_MIN_USD) return { garde: false, raison: 'buy under $' + ACHAT_MIN_USD }; } else inconnues.push('usd');
  if (fini(a.capUsd)) {
    if (a.capUsd > CAP_MAX_USD) return { garde: false, raison: 'token over $1M' };
    if (fini(a.usd) && a.capUsd > 0 && a.usd / a.capUsd * 100 < PART_CAP_MIN_PCT) return { garde: false, raison: 'buy under 0.02% of the market cap' };
  } else inconnues.push('cap');
  if (r.condition) {
    const c = r.condition;
    if (!fini(a.ageMin)) inconnues.push('age');
    else if (a.ageMin < c.ageMin || a.ageMin > c.ageMax) return { garde: false, raison: r.nom + ': token age outside ' + c.ageMin + '-' + c.ageMax + ' min' };
    if (fini(a.capUsd) && a.capUsd >= c.capMaxUsd) return { garde: false, raison: r.nom + ': market cap not under $' + c.capMaxUsd };
  }
  return { garde: true, raison: null, voix: r.voix, nom: r.nom, inconnues };
}
/** Les voix distinctes d'une liste d'achats gardes (un groupe = une voix). */
function voix(achats) { return new Set((achats || []).map((a) => a.voix || lc(a.wallet))).size; }
/** Une tx qui sert le meme jeton a plusieurs wallets de la liste : combien. */
function listeMemeTx(destinataires) {
  const s = new Set(); for (const d of destinataires || []) { const r = L.roleV2(d) || (L.roleDe(d) ? { role: 'v1' } : null); if (r) s.add(lc(d)); }
  return s.size;
}

// ------------------------------------------------------------ section 7 : le rebond
/**
 * Une observation de plus pour un jeton en surveillance. `e` = { haut, creux,
 * signale } (null au depart) ; `obs` = { mc, liq }. mc tient lieu de prix (meme
 * offre). Rend { etat, signal: null | { haut, creux, prix, stop } }.
 */
function suitRebond(e, obs) {
  const x = Object.assign({ haut: null, creux: null, signale: false }, e || {});
  if (!obs || !fini(obs.mc) || obs.mc <= 0) return { etat: x, signal: null };
  const p = obs.mc;
  if (x.haut === null || p > x.haut) { x.haut = p; x.creux = null; return { etat: x, signal: null }; }
  /* (haut - p) / haut et (p - creux) / creux : exacts aux bornes (1 - p/haut
     rend 19,999… pour un rebond de 20 %) */
  const chute = (x.haut - p) / x.haut * 100;
  if (x.creux === null) { if (chute >= CHUTE_MIN_PCT) x.creux = p; return { etat: x, signal: null }; }
  if (p < x.creux) { x.creux = p; return { etat: x, signal: null }; }
  const rebond = (p - x.creux) / x.creux * 100;
  if (!x.signale && rebond >= REBOND_MIN_PCT && fini(obs.liq) && obs.liq >= LIQ_REBOND_MIN_USD) {
    x.signale = true;
    return { etat: x, signal: { haut: x.haut, creux: x.creux, prix: p, chutePct: Math.round((x.haut - x.creux) / x.haut * 100), rebondPct: Math.round(rebond), stop: Math.round(x.creux * (1 - STOP_SOUS_CREUX_PCT / 100)) } };
  }
  return { etat: x, signal: null };
}

// ------------------------------------------------------------ section 6 : la promo DexScreener
/** La reponse de orders/v1 (sonde du 15/10 : { orders: [{ type, status,
 *  paymentTimestamp (ms) }], boosts: [{ amount, paymentTimestamp }] }). */
function promo(j, maintenant) {
  if (!j || !Array.isArray(j.orders) || !Array.isArray(j.boosts)) return null;
  const rec = (t) => fini(t) && maintenant - t <= PROMO_RECENTE_MS;
  const ok = j.orders.filter((o) => o && o.status !== 'rejected' && o.status !== 'cancelled');
  const profil = ok.filter((o) => o.type === 'tokenProfile').sort((a, b) => (b.paymentTimestamp || 0) - (a.paymentTimestamp || 0))[0] || null;
  const pubs = ok.filter((o) => o.type === 'tokenAd' || o.type === 'trendingBarAd');
  const boosts = j.boosts.filter((b) => b && fini(b.paymentTimestamp));
  const boostsRecents = boosts.filter((b) => rec(b.paymentTimestamp));
  const p = { profil: profil ? { t: profil.paymentTimestamp || null, recent: rec(profil.paymentTimestamp) } : null,
    pubs: pubs.map((o) => ({ type: o.type, t: o.paymentTimestamp || null, recent: rec(o.paymentTimestamp) })),
    boosts: boosts.length, boostsRecents: boostsRecents.length, montantRecent: boostsRecents.reduce((s, b) => s + (Number(b.amount) || 0), 0) };
  p.pousse = !!(boostsRecents.length && p.pubs.some((x) => x.recent) && p.profil && p.profil.recent);
  return p;
}
function promoTexte(p, maintenant) {
  if (p === undefined) return 'non demandée';
  if (p === null) return 'non lue';
  const il = (t) => (fini(t) ? 'il y a ' + dureeTexte((maintenant - t) / 60000) : '');
  const parts = [];
  parts.push(p.profil ? 'profil payé ' + il(p.profil.t) : 'aucun profil payé');
  parts.push(p.pubs.length ? p.pubs.length + ' pub' + (p.pubs.length > 1 ? 's' : '') + ' (' + p.pubs.map((x) => x.type).join(', ') + ')' : 'aucune pub');
  parts.push(p.boosts ? p.boosts + ' boost' + (p.boosts > 1 ? 's' : '') + (p.boostsRecents ? ', ' + p.boostsRecents + ' en 24 h' : '') : 'aucun boost');
  return parts.join(' · ') + (p.pousse ? ' — l’équipe pousse (les arnaques paient aussi)' : '');
}
function dureeTexte(min) { if (!fini(min)) return '?'; if (min < 1) return Math.max(0, Math.round(min * 60)) + ' s'; if (min < 120) return Math.round(min) + ' min'; if (min < 48 * 60) return Math.round(min / 60) + ' h'; return Math.round(min / 1440) + ' j'; }

// ------------------------------------------------------------ le texte (proprietaire, en francais)
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const EMOJI = { vert: '🟢', jaune: '🟡', rouge: '🔴' };
const usdTexte = (u) => (!fini(u) ? '?' : u >= 1e6 ? (u / 1e6).toFixed(2).replace('.', ',') + ' M$' : u >= 1e3 ? Math.round(u / 1e3) + ' k$' : Math.round(u) + ' $');
const ethTexte = (e) => (!fini(e) ? '?' : (e >= 1 ? e.toFixed(2) : e.toFixed(3)).replace('.', ','));

/**
 * L'alerte au format du brief v2. `a` :
 *   verdict ('vert'|'jaune'|'rouge'), titre, symbole, jeton, ageMin,
 *   courbe { eth, seuilEth, gradue } | null, capUsd | null,
 *   qui [texte], promo (objet promo | null | undefined), risque,
 *   plan { entree, stop, objectif }, lienX, explorer
 * Finit par « Pas un conseil financier. »
 */
function texteAlerte(a, maintenant) {
  const sym = esc(a.symbole || (a.jeton ? a.jeton.slice(0, 8) + '…' : '?'));
  const etat = [];
  etat.push(fini(a.ageMin) ? dureeTexte(a.ageMin) : 'âge inconnu');
  if (a.courbe) {
    if (a.courbe.gradue) etat.push('courbe graduée');
    else if (fini(a.courbe.eth) && fini(a.courbe.seuilEth) && a.courbe.seuilEth > 0) etat.push('courbe ' + ethTexte(a.courbe.eth) + ' / ' + ethTexte(a.courbe.seuilEth) + ' ETH (' + Math.round(a.courbe.eth / a.courbe.seuilEth * 100) + ' %)');
    else etat.push('sur la courbe Pons');
  }
  if (fini(a.capUsd)) etat.push('capitalisation ' + usdTexte(a.capUsd) + (a.capSource ? ' (' + a.capSource + ')' : ''));
  const p = a.plan || {};
  const lignes = [
    `<b>${EMOJI[a.verdict] || '🟡'} ${esc(a.titre)} — ${sym}</b>`,
    `<code>${esc(a.jeton || '')}</code>`,
    `• Âge et état : ${esc(etat.join(' · '))}`,
    `• Qui : ${esc((a.qui || []).join(' ; ') || 'aucun wallet ni dev connu')}`,
    `• Promo DexScreener : ${esc(promoTexte(a.promo, maintenant))}`,
    `• Risque principal : ${esc(a.risque || '?')}`,
    `• Plan : entrée ${esc(p.entree || 'aucune')} ; stop ${esc(p.stop || 'suiveur de 30 %')} ; objectif ${esc(p.objectif || 'vendre 75 % à ×2, garder 25 % pour ×10')}`,
    `• Règle : ${esc(PLAN_V2_TEXTE)}`,
    `• Vérifie l’adresse : la vraie est celle de la bio X du projet${a.lienX ? ' (' + esc(a.lienX) + ')' : ' (aucun lien X lu)'}`,
  ];
  if (a.explorer && a.jeton) lignes.push(`<a href="${esc(a.explorer)}/token/${esc(a.jeton)}">explorer</a>`);
  lignes.push('Pas un conseil financier.');
  return lignes.join('\n');
}
/** Le plan (section 8) selon le verdict. */
function plan(verdict, o) {
  o = o || {};
  if (verdict === 'rouge') return { entree: 'aucune', stop: '—', objectif: o.sortie ? 'sortir maintenant' : '—' };
  if (verdict === 'jaune') return { entree: 'aucune pour l’instant, surveiller', stop: 'suiveur de 30 % si entrée', objectif: 'vendre 75 % à ×2, garder 25 % pour ×10' };
  return { entree: 'petite mise fixe' + (o.prix ? ' (' + o.prix + ')' : ''), stop: o.stop || 'suiveur de 30 %', objectif: 'vendre 75 % à ×2, garder 25 % pour ×10' };
}

/** Ce que la colonie recoit : des codes, la source, et si le prix vient de la
 *  courbe (frais d'aller-retour a deduire). */
function pourLaColonie(o) {
  return { jeton: lc(o.jeton), sym: o.symbole || null, verdict: o.verdict === 'vert' ? 'ACHETER' : 'SURVEILLER', source: o.source, t: o.t,
    courbe: !!o.courbe, fraisPct: o.courbe ? FRAIS_COURBE_AR_PCT : 0,
    conditions: (o.conditions || []).slice(0, 20), wallets: (o.wallets || []).slice(0, 10), inconnues: (o.inconnues || []).slice(0, 20) };
}

module.exports = {
  TOPIC, SELECTEUR, ADR, SOURCES, BLOCS_2MIN, T2_ACHETEURS, T2_ETH, DEV_GROS_ETH, PLATEFORME_DEV_MIN_ETH, ACHAT_MINUSCULE_ETH, EXEMPTIONS_MIN, LOGO_SNIPER,
  TAXE_MAX, FRAIS_COURBE_AR_PCT, DROIT_LANCEMENT_ETH, ACHAT_MIN_USD, PART_CAP_MIN_PCT, CAP_MAX_USD, CHUTE_MIN_PCT, REBOND_MIN_PCT, LIQ_REBOND_MIN_USD,
  STOP_SOUS_CREUX_PCT, PROMO_RECENTE_MS, PLAN_V2, PLAN_V2_TEXTE, EMOJI,
  decodeLancementPons, decodeLancementIgnition, decodeCourbe, chaineAbi, decodeSocials, lienX, hoteDe, ethUsdDepuisSlot0,
  etatCourbe, capCourbeUsd, jugeLancement, jugeT2, filtreCopie, voix, listeMemeTx, suitRebond, promo, promoTexte, texteAlerte, plan, pourLaColonie,
  versEth, dureeTexte, usdTexte,
};
