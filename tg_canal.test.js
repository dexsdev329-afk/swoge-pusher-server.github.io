'use strict';
/* ============================================================================
 * DES CANAUX TELEGRAM COMME SOURCE D'ADRESSES (tg_canal.js)
 *
 * Le module LIT des apercus publics et en tire des adresses de JETON sur
 * Robinhood Chain. Il ne juge pas, n'achete pas — la colonie decide. L'essai
 * mesure donc l'extraction, la resolution et l'agregation :
 *   1. adresse nue, lien DexScreener Robinhood : proposes ; lien d'une AUTRE
 *      chaine, mint Solana, ticker seul : jamais ; un identifiant v4 (64 hexa)
 *      ou un hash ne donne pas de fausse adresse (defaut du 26 septembre) ;
 *   2. un lien de PAIRE est resolu en jeton — par DexScreener, sinon par
 *      token0/token1 sur la chaine (la paire v2 du $SWOGE : DexScreener muet) ;
 *   3. plusieurs canaux, dedup, attribution au premier, par message ;
 *   4. un canal en panne n'eteint pas les autres ;
 *   5. une adresse hors Robinhood n'est plus redemandee avant six heures (le
 *      releve du 26 septembre : 2 039 appels en cinq jours pour rien) ;
 *   6. la liste des canaux : normalisee, reglable a chaud.
 * Aucun appel sortant : reseau et chaine injectes.
 * ==========================================================================*/

process.env.TG_SURV_CANAUX = 'canalA,canalB';
process.env.TG_SURV_TTL_S = '120';
const T = require('./tg_canal');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const A_NUE = '0x95efAD01ffAb32ae00FE9f16Ca23a81b2802Cd54';     /* postee en clair le 21 septembre, un jeton Robinhood */
const PAIRE = '0x1111111111111111111111111111111111111111';     /* un lien DexScreener vers une PAIRE */
const JETON_PAIRE = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const PAIRE_V2_MUETTE = '0x2dc0fb72d9284228046cc95910eeaabebfe48456';   /* WETH/$SWOGE : DexScreener rend null */
const SWOGE = '0x8a166fb41cd659a0a43396272ff73973ce29f817';
const V4 = '0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea';
const JETON_V4 = '0x3333333333333333333333333333333333333333';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const MINT_SOL = 'GKaWJkSUgraALkF5GaCNpomH9ed3Vz6xnKR62WFkpump';
const HASH = '0x' + 'ab'.repeat(32);

const msg = (id, t, texte) => '<div class="tgme_widget_message_wrap"><div data-post="canalA/' + id + '"><time datetime="' + t + '"></time>'
  + '<div class="tgme_widget_message_text js-message_text">' + texte + '</div></div></div>';
const HTML_A = msg(1, '2026-09-26T10:00:00+00:00', 'Reversal here $METCAT insane')
  + msg(2, '2026-09-26T10:01:00+00:00', A_NUE)
  + msg(3, '2026-09-26T10:02:00+00:00', 'chart: <a href="https://dexscreener.com/robinhood/' + PAIRE + '">dex</a>')
  + msg(4, '2026-09-26T10:03:00+00:00', MINT_SOL)
  + msg(5, '2026-09-26T10:04:00+00:00', 'base play <a href="https://dexscreener.com/base/0x4444444444444444444444444444444444444444">dex</a>')
  + msg(6, '2026-09-26T10:05:00+00:00', 'v4 <a href="https://dexscreener.com/robinhood/' + V4 + '">dex</a> tx ' + HASH)
  + msg(7, '2026-09-26T10:06:00+00:00', 'swoge <a href="https://dexscreener.com/robinhood/' + PAIRE_V2_MUETTE + '">dex</a>')
  + msg(8, '2026-09-26T10:07:00+00:00', 'again ' + A_NUE.toLowerCase());
const HTML_B = msg(20, '2026-09-26T11:00:00+00:00', A_NUE) + msg(21, '2026-09-26T11:01:00+00:00', 'new 0x2222222222222222222222222222222222222222');

/* Le faux DexScreener (pairs/robinhood/…) et la fausse chaine (token0/token1). */
const appels = { dex: 0, chaine: 0, tg: 0 };
function reseau(html) {
  return async (url) => {
    url = String(url);
    if (/t\.me\/s\//.test(url)) { appels.tg++; if (/canalB/.test(url) && html.bPanne) throw new Error('HTTP 404'); return /canalA/.test(url) ? HTML_A : HTML_B; }
    appels.dex++;
    const id = url.split('/').pop().toLowerCase();
    if (id === PAIRE) return JSON.stringify({ pairs: [{ chainId: 'robinhood', baseToken: { address: JETON_PAIRE }, quoteToken: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' } }] });
    if (id === V4) return JSON.stringify({ pairs: [{ chainId: 'robinhood', baseToken: { address: WETH }, quoteToken: { address: JETON_V4 } }] });
    return JSON.stringify({ schemaVersion: '1.0.0', pairs: null, pair: null });
  };
}
T._chaine(async (adr) => { appels.chaine++; return adr.toLowerCase() === PAIRE_V2_MUETTE ? { token0: WETH, token1: SWOGE } : null; });

(async () => {
  console.log('-- 1. ce qui est propose, et ce qui ne l est jamais --');
  {
    const a = T.analyse(HTML_A);
    eq(a.liens.map((l) => l.id).sort().join(','), [PAIRE, V4, PAIRE_V2_MUETTE].sort().join(','), 'les liens DexScreener ROBINHOOD seulement (paire v2, piscine v4 entiere)');
    eq(a.nues.join(','), A_NUE.toLowerCase(), 'une adresse nue, dedupliquee malgre la casse');
    ok(!a.nues.some((x) => HASH.startsWith(x) || V4.startsWith(x)), 'un hash ou un id v4 (64 hexa) ne donne PAS une fausse adresse de 40');
    ok(!a.nues.includes('0x4444444444444444444444444444444444444444') && a.horsChaine >= 2, 'le lien /base/ et le mint Solana sont ecartes (comptes : ' + a.horsChaine + ')');
    ok(!JSON.stringify(a).includes('METCAT'), 'un ticker seul n est jamais pris (il designerait n importe quel clone)');
    eq(T.extraisAdresses('').length, 0, 'un texte vide ne rend rien');
  }

  console.log('\n-- 2. un lien de paire est resolu en jeton --');
  {
    T._videCache(); T._reseau(reseau({}));
    eq(await T.resousLien(PAIRE), JETON_PAIRE, 'paire connue de DexScreener : le cote jeton (pas l USDG)');
    eq(await T.resousLien(V4), JETON_V4, 'piscine v4 (id de 64 hexa) : le cote jeton (pas le WETH)');
    eq(await T.resousLien(PAIRE_V2_MUETTE), SWOGE, 'paire que DexScreener ne connait pas : token0/token1 lus sur la chaine (le $SWOGE)');
    eq(await T.resousLien(A_NUE.toLowerCase()), A_NUE.toLowerCase(), 'pas une paire : l adresse du jeton elle-meme');
  }

  console.log('\n-- 3. plusieurs canaux, par message --');
  {
    T._videCache(); appels.tg = 0; T._reseau(reseau({}));
    const r = await T.adressesRecentes();
    const par = Object.fromEntries(r.adresses.map((x) => [x.addr, x]));
    ok(par[JETON_PAIRE] && par[JETON_V4] && par[SWOGE] && par[A_NUE.toLowerCase()] && par['0x2222222222222222222222222222222222222222'], 'les jetons resolus et les adresses nues des deux canaux');
    ok(!par[PAIRE] && !par[V4.slice(0, 42)] && !par['0x4444444444444444444444444444444444444444'], 'jamais une paire brute, jamais un id tronque, jamais l autre chaine');
    eq(par[A_NUE.toLowerCase()].canal, 'canalA', 'une adresse vue dans les deux canaux : attribuee au premier');
    ok(par[A_NUE.toLowerCase()].post === 'canalA/8' && /2026-09-26T10:07/.test(par[A_NUE.toLowerCase()].t), 'avec son message le plus recent (lien et heure)');
    eq(r.canaux.join(','), 'canalA,canalB', 'les deux canaux de la liste');
    eq(appels.tg, 2, 'un appel par canal');
    const avant = appels.tg;
    await T.adressesRecentes();
    eq(appels.tg, avant, 'dans la fenetre du cache : aucun nouvel appel');
  }

  console.log('\n-- 4. un canal en panne n eteint pas les autres --');
  {
    T._videCache(); T._reseau(reseau({ bPanne: true }));
    const r = await T.adressesRecentes();
    ok(r.erreurs.length === 1 && r.erreurs[0].canal === 'canalB' && r.adresses.length >= 4, 'canalB en panne est note, canalA sert quand meme');
    ok(T.vue().canaux.find((c) => c.canal === 'canalB').erreurs === 1, 'et la vue le dit');
  }

  console.log('\n-- 5. hors Robinhood : plus redemande avant six heures --');
  {
    T._videCache(); T._reseau(reseau({}));
    const r = await T.adressesRecentes();
    const x = r.adresses.find((y) => y.addr === '0x2222222222222222222222222222222222222222');
    T.note(x.addr, x, 'hors robinhood');
    const y = r.adresses.find((z) => z.addr === JETON_PAIRE);
    T.note(y.addr, y, 'proposé');
    const r2 = await T.adressesRecentes();
    ok(!r2.adresses.some((z) => z.addr === x.addr) && r2.adresses.some((z) => z.addr === JETON_PAIRE), 'l adresse rejetee n est plus proposee ; la proposee, si (la colonie a sa propre memoire)');
    eq(T.REJET_MS, 6 * 3600e3, 'six heures');
    const v = T.vue();
    ok(v.trouvailles[0].addr === JETON_PAIRE && v.trouvailles[0].statut === 'proposé' && v.trouvailles[1].statut === 'hors robinhood' && v.rejetsEnCours === 1,
       'la vue : les dernieres trouvailles, avec leur statut');
    ok(v.canaux.find((c) => c.canal === 'canalA').proposes === 1, 'et le compte des jetons proposes par canal');
  }

  console.log('\n-- 6. la liste des canaux --');
  {
    eq(T.normaliseCanal('@Exceptionalmemes'), 'Exceptionalmemes', '« @canal »');
    eq(T.normaliseCanal('https://t.me/s/Exceptionalmemes'), 'Exceptionalmemes', '« https://t.me/s/canal »');
    eq(T.normaliseCanal('t.me/hood_calls/123'), 'hood_calls', '« t.me/canal/123 » (un lien de message)');
    eq(T.normaliseCanal('x; rm -rf /'), null, 'un nom invalide : rien');
    const cfg = require('./config');
    cfg.TG_SURV_CANAUX = '@un_canal, t.me/deux_canal, @un_canal';
    eq(T.canaux().join(','), 'un_canal,deux_canal', 'lue A CHAUD depuis la configuration (reglages.js), dedupliquee');
    cfg.TG_SURV_CANAUX = '';
    eq(T.canaux().length, 0, 'vide : la source s eteint proprement');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
