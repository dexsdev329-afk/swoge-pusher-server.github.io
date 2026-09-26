'use strict';
/* ==================================================================
 * L'ÉCONOMIE $SWOGE, LUE SUR LA CHAÎNE — /economie.json
 * ==================================================================
 *
 * La carte « THE $SWOGE ECONOMY » de l'accueil et le chapitre du brûlage du
 * whitepaper portaient des chiffres ÉCRITS À LA MAIN. Relevé du 26 septembre
 * 2026, sur le contrat du jeton (chaîne 4663) :
 *   - brûlé (solde de 0x…dEaD) : 13 389 118 réels contre 6 827 534 affichés —
 *     la page annonçait MOINS DE LA MOITIÉ de ce qui a été brûlé ;
 *   - coffre du casino : 15 155 373 réels contre 99 826 711 affichés (≈10 %
 *     de l'offre annoncés, 1,52 % réels).
 * Signalé par un joueur. Un chiffre recopié ne suit pas la chaîne : chaque
 * retrait brûle 1 %, chaque dépôt et retrait fait bouger le coffre. On lit
 * donc les soldes eux-mêmes, et la page ne recopie plus rien.
 *
 * Trois lectures (offre, adresse morte, coffre), gardées CACHE_MS : la carte
 * est vue par tout le monde, la chaîne n'a pas à payer chaque visite. Une
 * lecture ratée ne remplace pas la dernière bonne — on rend celle-ci, avec sa
 * date, et `frais: false` : un chiffre daté vaut mieux qu'une case vide, et
 * bien mieux qu'un zéro qui se lirait « plus rien de brûlé ».
 * ================================================================== */

const cfg = require('./config');

const CACHE_MS = 5 * 60 * 1000;
const ABI = ['function totalSupply() view returns (uint256)',
             'function balanceOf(address) view returns (uint256)',
             'function decimals() view returns (uint8)'];

/* Les noeuds, dans l'ordre : l'officiel, puis celui que la colonie a mesuré
   fiable (`RPC_SECOURS`, Alchemy) s'il est posé. Le premier qui répond gagne. */
function noeuds() {
  const l = [cfg.RPC_URL];
  const s = (process.env.RPC_SECOURS || '').trim();
  if (s && l.indexOf(s) < 0) l.push(s);
  return l;
}

async function lisChaine() {
  const { ethers } = require('ethers');
  let derniere = null;
  for (const url of noeuds()) {
    try {
      const p = new ethers.providers.StaticJsonRpcProvider(url, cfg.CHAIN_ID);
      const t = new ethers.Contract(cfg.SWOGE_TOKEN, ABI, p);
      const [dec, offre, brule, coffre] = await Promise.all([
        t.decimals(), t.totalSupply(), t.balanceOf(cfg.BURN_ADDRESS),
        cfg.VAULT_ADDRESS ? t.balanceOf(cfg.VAULT_ADDRESS) : Promise.resolve(null),
      ]);
      const n = (x) => (x == null ? null : Number(ethers.utils.formatUnits(x, dec)));
      return { offre: n(offre), brule: n(brule), coffre: n(coffre) };
    } catch (e) { derniere = e; }
  }
  throw derniere || new Error('no node');
}

let lecteur = lisChaine;
let cache = null;          /* { offre, brule, coffre, lu } : la dernière BONNE lecture */
let enCours = null;
let dernierEssai = -Infinity;   /* jamais essaye : la premiere visite lit */

/* La vue publique : les soldes, leur part de l'offre, et ce que dit la
   configuration du serveur sur le staking (le rendement et son plafond ne
   sont pas sur la chaîne, ils sont dans `config.js`). */
function vue(c, frais) {
  const offre = c && c.offre;
  const part = (x) => (offre > 0 && x != null ? Math.round(x / offre * 10000) / 100 : null);
  return {
    ok: !!c,
    frais,
    lu: c ? c.lu : null,
    jeton: cfg.SWOGE_TOKEN, chaine: cfg.CHAIN_ID,
    adresseBrulage: cfg.BURN_ADDRESS, coffreAdresse: cfg.VAULT_ADDRESS || null,
    offre: c ? c.offre : null,
    brule: c ? c.brule : null, brulePct: c ? part(c.brule) : null,
    coffre: c ? c.coffre : null, coffrePct: c ? part(c.coffre) : null,
    stakingAprPct: cfg.STAKE_APR_BPS / 100,
    stakingPlafond: offre > 0 ? Math.round(offre * cfg.STAKE_CAP_BPS / 10000) : null,
  };
}

async function etat(maintenant) {
  const t = maintenant || Date.now();
  if (cache && t - cache.lu < CACHE_MS) return vue(cache, true);
  /* Une seule lecture à la fois, et pas de relance en rafale après un échec :
     cent visiteurs pendant une panne de noeud font UNE tentative par minute. */
  if (!enCours && t - dernierEssai >= 60 * 1000) {
    dernierEssai = t;
    enCours = lecteur().then((r) => {
      if (r && r.offre > 0 && r.brule != null) cache = Object.assign({}, r, { lu: t });
    }).catch((e) => { console.warn('[economie] lecture ratee : ' + String(e && e.message || e).slice(0, 90)); })
      .then(() => { enCours = null; });
  }
  if (enCours) await enCours;
  return vue(cache, !!(cache && t - cache.lu < CACHE_MS));
}

function _lecteur(fn) { lecteur = fn; }
function _reset() { cache = null; enCours = null; dernierEssai = -Infinity; lecteur = lisChaine; }

module.exports = { etat, CACHE_MS, _lecteur, _reset };
