'use strict';
/* ==================================================================
 * LE COURS DU $SWOGE, LU SUR LA CHAÎNE QUAND DEXSCREENER SE TAIT
 * ==================================================================
 *
 * Relevé du 26 septembre 2026 : DexScreener rend `pairs: null` pour le vrai
 * $SWOGE (0x8a16…F817) — sur `/latest/dex/tokens`, `/tokens/v1` et la paire
 * elle-même — alors que sa piscine est vivante sur la chaîne (2,47 WETH
 * contre 266 M de $SWOGE). Sans cours, SwoleMind et SwogeAgentic se
 * fermaient (« The $SWOGE price is unavailable »), par prudence : c'est la
 * bonne réaction, mais le produit était à l'arrêt. Au même moment, la
 * recherche « SWOGE » rendait un CLONE (0xDB87…9b03, mêmes nom et symbole) :
 * chercher par nom aurait pris le mauvais jeton. On lit donc la piscine
 * CONNUE, par son adresse, sur la chaîne.
 *
 * La piscine est de type Uniswap V2 (`getReserves`, `token0`, `token1`,
 * vérifié ce jour-là : token0 = WETH, token1 = $SWOGE). Le prix en WETH est
 * le rapport des réserves ; le cours de l'ETH vient des piscines WETH/USDG de
 * la même chaîne sur DexScreener (19 M $ de liquidité), qui, elles, répondent.
 *
 * Garde-fous : les deux jetons de la piscine doivent être exactement WETH et
 * $SWOGE ; en dessous de MIN_WETH de réserve, pas de cours (une piscine vidée
 * se manipule pour rien) ; un ETH hors de [100 ; 100 000] $ est refusé. Le
 * prix se prend ensuite par `coursPrudent` (studio_chat.js) : le PLUS BAS du
 * moment et de la médiane — un cours pompé ne fait pas payer moins.
 * ================================================================== */

const MIN_WETH = 0.5;
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const POOL = '0x2dc0fb72d9284228046cc95910eeaabebfe48456';

/** Le prix d'un $SWOGE en WETH, lu dans la piscine V2 ; null si elle ne ressemble pas à ce qu'on attend. */
async function prixEnWeth({ lit, pool, swoge, weth }) {
  /* `lit(adresse, signature)` rend le résultat décodé d'un appel en lecture (injecté : l'essai n'a pas de chaîne). */
  const [t0, t1, r] = await Promise.all([lit(pool, 'token0'), lit(pool, 'token1'), lit(pool, 'getReserves')]);
  const a = String(t0).toLowerCase(), b = String(t1).toLowerCase(), w = weth.toLowerCase(), s = swoge.toLowerCase();
  if (!((a === w && b === s) || (a === s && b === w))) return null;
  const r0 = Number(r[0]) / 1e18, r1 = Number(r[1]) / 1e18;      /* WETH et $SWOGE ont 18 décimales */
  const rw = a === w ? r0 : r1, rs = a === w ? r1 : r0;
  if (!(rw >= MIN_WETH) || !(rs > 0)) return null;
  return rw / rs;
}

/** Le cours de l'ETH en $, depuis la piscine WETH la plus profonde de Robinhood Chain (DexScreener). */
async function ethUsd(prendre, weth) {
  const r = await (prendre || fetch)('https://api.dexscreener.com/latest/dex/tokens/' + (weth || WETH), { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const p = (j.pairs || []).filter((x) => String(x.chainId || '').toLowerCase() === 'robinhood'
    && String((x.baseToken || {}).address || '').toLowerCase() === String(weth || WETH).toLowerCase())
    .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const v = p[0] ? Number(p[0].priceUsd) : NaN;
  return v > 100 && v < 100000 ? v : null;
}

/** Le cours du $SWOGE en $, lu sur la chaîne ; null si une des deux lectures manque. */
async function cours({ lit, prendre, pool, swoge, weth }) {
  const [w, e] = await Promise.all([prixEnWeth({ lit, pool: pool || POOL, swoge, weth: weth || WETH }), ethUsd(prendre, weth)]);
  return w && e ? w * e : null;
}

/** Un lecteur réel (ethers v5) pour `lit`. */
function lecteurEthers(rpc, chainId) {
  const { ethers } = require('ethers');
  const p = new ethers.providers.JsonRpcProvider(rpc, chainId);
  const ABI = ['function token0() view returns (address)', 'function token1() view returns (address)',
               'function getReserves() view returns (uint112, uint112, uint32)'];
  return async (adresse, fn) => {
    const c = new ethers.Contract(adresse, ABI, p);
    const v = await c[fn]();
    return fn === 'getReserves' ? [v[0].toString(), v[1].toString()] : v;
  };
}

module.exports = { cours, prixEnWeth, ethUsd, lecteurEthers, MIN_WETH, WETH, POOL };
