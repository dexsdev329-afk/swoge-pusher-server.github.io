'use strict';
/* ==========================================================================
 * UN CANAL TELEGRAM COMME SOURCE D'ADRESSES — LECTURE PASSIVE, RIEN DE PLUS
 *
 * « SWOGE AI surveille ce canal Telegram, il y met des contrats et des liens
 *   DexScreener. » — @Exceptionalmemes, 21 septembre 2026.
 *
 * Ce que fait ce module : lire l'apercu PUBLIC d'un canal (t.me/s/<canal>) et
 * en extraire des ADRESSES de contrat candidates. C'est tout. Il ne juge pas,
 * il n'achete pas, il ne previent personne : il rend une liste d'adresses au
 * meme titre que les flux DexScreener, et la colonie decide seule ce qu'elle
 * en fait. Le trait `origine = 'telegram'` la laisse APPRENDRE ce que vaut le
 * canal — au lieu qu'on en decide ici, ce qui serait juger sur un pressenti.
 *
 * ---- POURQUOI L'APERCU WEB, ET PAS L'API BOT ----
 * L'API Bot de Telegram ne rend les posts d'un canal QUE si le bot en est
 * administrateur. @Exceptionalmemes est un canal tiers : on ne peut pas y
 * poser le bot. L'apercu public `https://t.me/s/<canal>`, lui, sert les
 * derniers posts en HTML lisible, sans cle et sans permission. Aucune
 * dependance MTProto, aucun secret — le depot reste « nu ».
 * Mesure du 21 septembre 2026 sur @Exceptionalmemes : HTTP 200, ~98 ko,
 * 16 messages, un contrat EVM (0x95ef…Cd54) et des mints Solana en `…pump`.
 *
 * ---- CE QU'ON EXTRAIT, ET CE QU'ON LAISSE ----
 * Deux formes portent une adresse EVM dans ce canal : l'adresse nue 0x…40hex,
 * et un lien DexScreener .../<reseau>/0x…. On rend les deux, en minuscules.
 * On NE rend PAS les mints Solana (base58) : la colonie et le miroir ne
 * couvrent que la chaine EVM `robinhood`, et de toute facon `jetonDepuisDex`
 * jette toute adresse sans paire sur cette chaine. On ne propose donc que ce
 * que la suite peut reellement juger — une adresse hors chaine ne ferait que
 * gacher un appel.
 * ======================================================================== */

/* Les canaux surveilles, modifiables sans toucher au code. Defaut : celui qui
   a motive le module. `TG_SURV_CANAUX=''` (ou ' ') eteint la source
   proprement, sans rien casser ailleurs. */
const CANAUX = (process.env.TG_SURV_CANAUX === undefined ? 'Exceptionalmemes' : process.env.TG_SURV_CANAUX)
  .split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);

/* L'apercu pese ~100 ko et le canal ne poste pas a la seconde : on ne le
   redemande pas a chaque tour de colonie. */
const TTL_MS = Math.max(30, Number(process.env.TG_SURV_TTL_S || 120)) * 1000;

/* Le reseau, injectable pour les essais : aucun appel sortant en test. */
let _lit = (url) => fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))));
function _reseau(fn) { _lit = fn; }

/* Un lien DexScreener porte l'adresse APRES le reseau : .../robinhood/0x… ;
   l'adresse nue est un 0x suivi de 40 hexa. Les deux, sur tout le HTML. */
const RE_DEX = /dexscreener\.com\/[a-z0-9]+\/(0x[0-9a-fA-F]{40})/gi;
const RE_NUE = /0x[0-9a-fA-F]{40}/g;

/* Toutes les adresses EVM d'un texte (ou d'un HTML), dedupliquees, minuscules.
   L'ordre du DexScreener d'abord n'a pas d'importance : le Set dedoublonne, et
   une adresse nue egale a celle d'un lien tombe sur la meme cle. */
function extraisAdresses(texte) {
  const s = String(texte || '');
  const out = new Set();
  let m;
  RE_DEX.lastIndex = 0; while ((m = RE_DEX.exec(s))) out.add(m[1].toLowerCase());
  RE_NUE.lastIndex = 0; while ((m = RE_NUE.exec(s))) out.add(m[0].toLowerCase());
  return [...out];
}

const cache = new Map();   /* canal -> { t, adrs } */

/* Les adresses candidates d'un canal, servies du cache si recentes. */
async function adressesCanal(canal) {
  const c = cache.get(canal);
  if (c && Date.now() - c.t < TTL_MS) return c.adrs;
  const html = await _lit('https://t.me/s/' + encodeURIComponent(canal));
  const adrs = extraisAdresses(html);
  cache.set(canal, { t: Date.now(), adrs });
  return adrs;
}

/* Toutes les adresses de tous les canaux surveilles, dedupliquees. Chaque
   entree porte le canal d'ou elle vient, pour le journal. Une erreur sur un
   canal n'eteint pas les autres : elle est notee et on continue. */
async function adressesRecentes() {
  const vu = new Map();   /* addr -> canal (le premier qui l'a servie) */
  const erreurs = [];
  for (const canal of CANAUX) {
    try {
      for (const a of await adressesCanal(canal)) if (!vu.has(a)) vu.set(a, canal);
    } catch (e) { erreurs.push({ canal, message: String(e.message || e).slice(0, 80) }); }
  }
  return {
    adresses: [...vu.entries()].map(([addr, canal]) => ({ addr, canal })),
    erreurs, canaux: CANAUX.slice(),
  };
}

/* Pour les essais : vider le cache entre deux scenarios. */
function _videCache() { cache.clear(); }

module.exports = { CANAUX, extraisAdresses, adressesCanal, adressesRecentes, _reseau, _videCache };
