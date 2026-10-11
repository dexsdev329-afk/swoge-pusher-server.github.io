'use strict';
/*
 * Precharge (`node -r essais/coupes/faux_fetch.js ...`) d'un processus enfant
 * de coupes_gardes.test.js : AUCUN reseau. `fetch` est remplace par un faux
 * fournisseur qui :
 *   - note chaque URL, SANS la cle (apiKey retiree), dans FAUX_LOG ;
 *   - rend [] a The Odds API (une reponse vide ne coute rien, guide v4) et
 *     { events: [] } a ESPN ;
 *   - fait tomber /sports quand FAUX_SPORTS=panne (le chemin des jokers sans
 *     liste des sports).
 * Les alertes de solde (Telegram) sont coupees : rien ne part.
 */
const fs = require('fs');
const path = require('path');
const LOG = process.env.FAUX_LOG;
const entetes = (h) => ({ get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) });
global.fetch = async (url) => {
  const u = new URL(String(url));
  u.searchParams.delete('apiKey');
  if (LOG) fs.appendFileSync(LOG, u.toString() + '\n');
  if (/espn\.com$/.test(u.hostname)) return { ok: true, status: 200, json: async () => ({ events: [] }) };
  if (/\/v4\/sports\/?$/.test(u.pathname) && process.env.FAUX_SPORTS === 'panne') throw new Error('reseau coupe (faux)');
  return { ok: true, status: 200, headers: entetes({ 'x-requests-remaining': '20000', 'x-requests-used': '0', 'x-requests-last': '0' }),
           json: async () => [], text: async () => '[]' };
};
require(path.join(__dirname, '..', '..', 'alerte_solde')).oddsEvenement = () => true;
