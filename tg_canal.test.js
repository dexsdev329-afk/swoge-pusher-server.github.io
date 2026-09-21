'use strict';
/* ============================================================================
 * LE CANAL TELEGRAM COMME SOURCE D'ADRESSES
 *
 * Ce qui se joue ici, et rien d'autre : on LIT un apercu public et on en tire
 * des adresses EVM candidates. Le module ne juge pas, n'achete pas — c'est la
 * colonie qui decide, et `jetonDepuisDex` qui verifie la chaine. Donc l'essai
 * ne mesure que l'extraction et l'agregation :
 *
 *   1. Une adresse nue et une adresse dans un lien DexScreener sortent toutes
 *      deux, en minuscules, dedupliquees ; un mint Solana ne sort PAS.
 *   2. Plusieurs canaux : les adresses sont dedupliquees entre eux, chacune
 *      attribuee au premier canal qui l'a servie.
 *   3. Un canal en panne n'eteint pas les autres : il est note, on continue.
 *   4. Le cache epargne un second appel dans la fenetre TTL.
 *
 * Aucun appel sortant : le reseau est injecte (`_reseau`). La forme HTML est
 * celle mesuree le 21 septembre 2026 sur @Exceptionalmemes (classe
 * `tgme_widget_message_text js-message_text`, adresse nue en clair).
 * ==========================================================================*/

/* Les canaux AVANT le require : le module lit l'env au chargement. */
process.env.TG_SURV_CANAUX = 'canalA,canalB';
process.env.TG_SURV_TTL_S = '120';
const T = require('./tg_canal');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

/* Une adresse reelle vue dans le canal, et deux fabriquees pour l'essai. */
const A_NUE = '0x95efAD01ffAb32ae00FE9f16Ca23a81b2802Cd54';   /* postee en clair, casse melangee */
const A_DEX = '0x1111111111111111111111111111111111111111';   /* postee dans un lien DexScreener */
const MINT_SOL = 'Hsga2MdTiF6sWwjv6atngwXz8cpsYdp11LpPSZNvpump';  /* Solana : ne doit PAS sortir */

/* La forme reelle de l'apercu : des blocs `tgme_widget_message_text`. */
const HTML_A =
  '<div class="tgme_widget_message_text js-message_text" dir="auto">Reversal here</div>' +
  '<div class="tgme_widget_message_text js-message_text" dir="auto">' + A_NUE + '</div>' +
  '<div class="tgme_widget_message_text js-message_text" dir="auto">chart: ' +
    '<a href="https://dexscreener.com/robinhood/' + A_DEX + '" target="_blank">dexscreener</a></div>' +
  '<div class="tgme_widget_message_text js-message_text" dir="auto">solana play ' + MINT_SOL + '</div>' +
  '<div class="tgme_widget_message_text js-message_text" dir="auto">still ' + A_NUE.toLowerCase() + ' aping</div>';

const HTML_B =
  '<div class="tgme_widget_message_text js-message_text" dir="auto">' + A_DEX + '</div>' +   /* deja vu en A */
  '<div class="tgme_widget_message_text js-message_text" dir="auto">new one 0x2222222222222222222222222222222222222222</div>';

(async () => {
  console.log('-- 1. extraction : nue + lien DexScreener, minuscules, dedup, pas de Solana --');
  {
    const a = T.extraisAdresses(HTML_A);
    eq(a.length, 2, 'deux adresses EVM distinctes, malgre le doublon de casse');
    ok(a.includes(A_NUE.toLowerCase()), 'l adresse nue sort, en minuscules');
    ok(a.includes(A_DEX.toLowerCase()), 'l adresse du lien DexScreener sort aussi');
    ok(!a.some((x) => x.includes('pump')) && a.every((x) => /^0x[0-9a-f]{40}$/.test(x)),
       'le mint Solana ne sort pas : on ne propose que ce que la chaine EVM peut juger');
    eq(T.extraisAdresses('').length, 0, 'un texte vide ne rend rien, sans casser');
  }

  console.log('\n-- 2. plusieurs canaux : dedup entre eux, attribue au premier --');
  {
    let appels = 0;
    T._videCache();
    T._reseau(async (url) => { appels++; return String(url).includes('canalA') ? HTML_A : HTML_B; });
    const r = await T.adressesRecentes();
    eq(r.adresses.length, 3, 'trois adresses uniques sur les deux canaux (A_DEX partage)');
    const parCanal = Object.fromEntries(r.adresses.map((x) => [x.addr, x.canal]));
    eq(parCanal[A_DEX.toLowerCase()], 'canalA', 'une adresse vue dans les deux est attribuee au premier');
    ok(r.adresses.some((x) => x.addr.endsWith('2222')), 'l adresse propre a B est bien la');
    eq(r.canaux.join(','), 'canalA,canalB', 'les deux canaux sont ceux de l env');
    eq(r.erreurs.length, 0, 'aucune erreur quand les deux repondent');
    eq(appels, 2, 'un appel par canal, pas plus');
  }

  console.log('\n-- 3. un canal en panne n eteint pas les autres --');
  {
    T._videCache();
    T._reseau(async (url) => {
      if (String(url).includes('canalB')) throw new Error('HTTP 404');
      return HTML_A;
    });
    const r = await T.adressesRecentes();
    ok(r.adresses.length >= 2, 'les adresses de A sont servies malgre la panne de B [' + r.adresses.length + ']');
    eq(r.erreurs.length, 1, 'la panne de B est notee, pas tue');
    ok(/canalB/.test(r.erreurs[0].canal) && /404/.test(r.erreurs[0].message), 'et elle dit lequel et pourquoi');
  }

  console.log('\n-- 4. le cache epargne un second appel dans la fenetre --');
  {
    let appels = 0;
    T._videCache();
    T._reseau(async () => { appels++; return HTML_A; });
    await T.adressesCanal('canalA');
    await T.adressesCanal('canalA');
    eq(appels, 1, 'deux lectures rapprochees du meme canal, un seul appel reseau');
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
