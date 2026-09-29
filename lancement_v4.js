'use strict';
/* ==========================================================================
 * LANCER UN JETON V4 DEPUIS L'AGENT (29/09/2026)
 * ==========================================================================
 *
 * Demande du proprietaire : « des agents IA qui peuvent creer des tokens
 * facilement avec le nouveau launchpad, via SwoleMind ou SwogeAgentic ».
 *
 * Meme regle que l'eSIM (achats.js) : l'agent PROPOSE, le joueur decide. Ici
 * c'est plus strict encore : le serveur ne signe RIEN. Il prepare une offre
 * (nom, symbole, pool, liens, sel CREATE2, launchpad, frais) ; la page la montre
 * et c'est le PORTEFEUILLE DU JOUEUR qui envoie createToken. Le joueur paie le
 * frais, il devient le createur, il touche 50 % des frais de trading. Aucune
 * cle, aucun fonds de la maison n'est engage.
 *
 * Les deux launchpads deployes le 29/09 (deploiement_v4.js) :
 *   - pool $SWOGE : 0x6532C42a..., frais 10 000 $SWOGE BRULES (approve puis createToken) ;
 *   - pool ETH    : 0xEfD0fd35..., frais 0,0001 ETH au tresor (createToken payable).
 * Une offre n'est faite que sur un launchpad dont le serveur a RELU les parametres
 * sur la chaine (etape au-dela de « deploye ») : jamais sur une adresse devinee.
 *
 * Ce que l'offre refuse (le point « refus des copies » de la tache #58) :
 *   - un symbole ou un nom d'ACTION TOKENISEE de la liste officielle Robinhood
 *     (actions_rh.identite) : le 28/09, une copie de NVDA tenait 30 386 $ de
 *     liquidite a cote de l'officielle. Liste injoignable : on refuse, on ne
 *     lance pas a l'aveugle ;
 *   - les symboles des grands actifs (BTC, ETH, USDC...) et tout ce qui porte
 *     « SWOGE » : un jeton lance par n'importe qui ne doit pas pouvoir passer
 *     pour un jeton de la maison ;
 *   - des liens qui ne sont pas https, ou trop longs pour l'evenement Meta.
 * ======================================================================== */

const crypto = require('crypto');

const OFFRE_MS = 15 * 60e3;
const RESERVES = new Set(['BTC', 'WBTC', 'ETH', 'WETH', 'STETH', 'USDC', 'USDT', 'USDG', 'DAI', 'USDE', 'PYUSD', 'SOL', 'WSOL', 'BNB', 'XRP',
  'DOGE', 'ADA', 'TRX', 'LINK', 'UNI', 'ARB', 'OP', 'HOOD', 'ROBINHOOD']);
const RE_MAISON = /swoge/i;

const net = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

/* Un lien : https seulement ; un @pseudo X ou Telegram devient son adresse. */
function lienDe(v, genre) {
  const s = net(v, 200);
  if (!s) return '';
  if (genre === 'twitter' && /^@?[A-Za-z0-9_]{1,15}$/.test(s)) return 'https://x.com/' + s.replace(/^@/, '');
  if (genre === 'telegram' && /^@?[A-Za-z0-9_]{5,32}$/.test(s)) return 'https://t.me/' + s.replace(/^@/, '');
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !/\./.test(u.hostname) || u.username || u.password) return null;
  return u.toString().slice(0, 200);
}

/**
 * deps : { launchpads() → { swoge: {adresse, fraisWei}|null, eth: {adresse, fraisWei}|null },
 *          identite?(null, symbole, nom) → { imposteur, symbole }|{ officielle }|null (actions_rh),
 *          maintenant? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const MESURE = { offres: 0, refusees: 0, copies: 0 };

  function refus(raison) { MESURE.refusees++; return { ok: false, raison }; }

  async function propose(e) {
    e = e || {};
    const pool = String(e.pool || '').toLowerCase() === 'eth' || String(e.pool || '').toLowerCase() === 'weth' ? 'eth'
      : String(e.pool || '').toLowerCase() === 'swoge' ? 'swoge' : null;
    if (!pool) return refus('choose the pool: "swoge" (paired with $SWOGE, fee 10,000 $SWOGE burned) or "eth" (paired with ETH, fee 0.0001 ETH)');
    const name = net(e.name, 32);
    const symbol = net(e.symbol, 12).toUpperCase().replace(/^\$/, '');
    if (!name) return refus('the token needs a name (1 to 32 characters)');
    if (/https?:|www\.|<|>/i.test(name)) return refus('the name cannot contain a link or markup');
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return refus('the symbol must be 2 to 10 letters or digits, e.g. "PEPE"');
    if (RESERVES.has(symbol) || RESERVES.has(name.toUpperCase())) return refus('"' + symbol + '" is the ticker of a major asset: pick another symbol so buyers are not misled');
    if (RE_MAISON.test(symbol) || RE_MAISON.test(name)) return refus('names and symbols containing "SWOGE" are reserved for official SWOGE tokens');
    /* La copie d'une action tokenisee : refusee, et une liste illisible ne laisse rien passer. */
    if (deps.identite) {
      let id = null;
      try { id = await deps.identite(null, symbol, name); } catch (x) { id = undefined; }
      if (id === undefined) return refus('the official stock token list could not be read to check the name - try again in a minute');
      if (id && (id.imposteur || id.officielle)) { MESURE.copies++; return refus('"' + symbol + '" / "' + name + '" copies the official Robinhood stock token ' + id.symbole + ': this launchpad refuses copies'); }
    }
    const liens = {};
    for (const k of ['website', 'twitter', 'telegram']) {
      const l = lienDe(e[k], k);
      if (l === null) return refus('the ' + k + ' link must be an https:// address' + (k === 'website' ? '' : ' or a @handle'));
      liens[k] = l;
    }
    const L = deps.launchpads() || {};
    const lp = L[pool];
    if (!lp || !/^0x[0-9a-fA-F]{40}$/.test(String(lp.adresse || '')) || !/^[0-9]+$/.test(String(lp.fraisWei || ''))) {
      return refus('the ' + (pool === 'eth' ? 'ETH' : '$SWOGE') + ' pool launchpad is not available right now');
    }
    const fraisWei = String(lp.fraisWei);
    const offre = {
      id: crypto.randomBytes(8).toString('hex'),
      chainId: 4663, pool, launchpad: lp.adresse,
      name, symbol, salt: '0x' + crypto.randomBytes(32).toString('hex'),
      website: liens.website, twitter: liens.twitter, telegram: liens.telegram, logo: '',
      feeWei: fraisWei, feeToken: pool === 'eth' ? 'ETH' : 'SWOGE',
      fee: pool === 'eth' ? Number(fraisWei) / 1e18 : Number(BigInt(fraisWei) / 10n ** 18n),
      feeGoesTo: pool === 'eth' ? 'treasury' : 'burned',
      swoge: pool === 'swoge' ? lp.swoge : null,
      supply: 1000000000, creatorShareOfTradingFees: 0.5,
      expire: maintenant() + OFFRE_MS,
    };
    MESURE.offres++;
    return { ok: true, offre };
  }

  return { propose, MESURE };
}

module.exports = { cree, lienDe, RESERVES, OFFRE_MS };
