'use strict';
/* ==========================================================================
 * LA COPIE DE LLMS.TXT PUBLIEE SUR LE SITE — FAITE PAR LA MEME FONCTION
 *
 *   node outils/llms_site.js > ../SWOGE.github.io/llms.txt
 *
 * Le serveur sert /llms.txt en direct depuis le catalogue (agentic.llmsTxt,
 * prix en $ et en $SWOGE). Le site en publie une copie statique, prix en $
 * seulement, pour les agents qui lisent swoleeswoge.dog/llms.txt. Une copie
 * recopiee a la main vieillit en silence : le 26 septembre 2026, elle listait
 * encore `telegram_calls` le jour ou l'outil a cesse d'etre vendu. Elle se
 * REGENERE donc, avec les reglages du service en production :
 *   - la recherche web allumee (cle Perplexity posee sur Railway) ;
 *   - TG_APPELS_VENTE tel qu'il est dans l'environnement (absent : l'outil
 *     n'est pas vendu, donc pas liste) ;
 *   - STUDIO_MARGE tel qu'il est (absent : 1,5, le defaut de studio_chat) ;
 *   - x402 ALLUME, comme en production (releve du 26 septembre 2026 sur
 *     /agentic/x402 : v2, exact, eip155:4663, USDG en EIP-3009 puis $SWOGE en
 *     Permit2, minimum 0,02 $). La copie du site ne disait RIEN de x402 — un
 *     agent qui lisait swoleeswoge.dog/llms.txt croyait qu'il fallait un compte.
 *     Le paragraphe est celui du serveur (meme fonction) ; les adresses et le
 *     minimum viennent de x402.js et de la config, jamais recopies ici. Seul le
 *     prix du moment (gaz) n'y est pas : le 402 le cote, appel par appel.
 * agentic.test.js compare la copie du site a cette sortie, mot pour mot.
 * ======================================================================== */
const A = require('../agentic');
const X = require('../x402');
const config = require('../config');

const API = 'https://web-production-220a3.up.railway.app';
const SITE = 'https://swoleeswoge.dog';
/* esim : la boutique sans compte (boutique_esim.js), ouverte en production depuis le 28/09 au soir. */
const U = { api: API, site: SITE, swoge: false, page: SITE + '/swogeagentic.html', docs: SITE + '/swogeagentic_api.html', esim: true };

/* L'etat x402 public de la production, dans la forme de server.js (x402Etat) : ce que llmsTxt en lit. */
const X402 = { actif: true, x402Version: X.X402_VERSION, scheme: 'exact', network: X.RESEAU, asset: config.SWOGE_TOKEN, minimumUsd: X.MIN_USD,
  assets: [{ symbol: 'USDG', asset: X.USDG, decimals: X.DECIMALES_USDG, assetTransferMethod: 'eip3009' },
    { symbol: 'SWOGE', asset: config.SWOGE_TOKEN, decimals: 18, assetTransferMethod: 'permit2' }] };

/* Le catalogue sans cle ni solde : seuls les noms, schemas et prix en $ servent ici. */
const api = A.cree({ cles: {}, solde: {}, outils: {}, cours: async () => 0, actifs: () => ({ recherche: true }) });

api.catalogue().then((cat) => process.stdout.write(A.llmsTxt(Object.assign({}, cat, { x402: X402 }), U)))
  .catch((e) => { console.error(e); process.exit(1); });
