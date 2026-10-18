'use strict';
/*
 * AGENTLIFE → SWOGE AI (18/10/2026), contre une fausse API des signaux :
 *   1. sans AGENTLIFE_SIGNALS_KEY : rien (aucune requete) ;
 *   2. la cle part en Authorization, jamais dans l'URL ni dans l'etat servi ;
 *   3. au premier tour, rien de plus vieux que 30 min ; puis le curseur avance ;
 *      une alerte n'est transmise qu'une fois ;
 *   4. « swoge » (l'echo de la colonie elle-meme), « confirmation » (une vente),
 *      une autre chaine, un type inconnu : ecartes ;
 *   5. la VRAIE colonie accepte chaque type comme une source v2 (une ligne
 *      d'audit « agentlife: … » chacun) et n'en fait jamais un achat :
 *      `signalSmart` les met en file d'ombres, la vue les liste.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlife-'));
process.env.STUDIO_DEX = '0';
delete process.env.AGENTLIFE_SIGNALS_KEY;
const AL = require('./agentlife');

const T = Date.parse('2026-10-18T22:00:00Z');
const adr = (c) => '0x' + c.repeat(40);
function alerte(kind, c, minutes, o) {
  return Object.assign({ at: new Date(T - minutes * 60000).toISOString(), kind, token: adr(c), chain: 'robinhood', symbol: 'TK' + c, note: 'note ' + kind,
    mcapAtAlert: 40000, liquidityAtAlert: 9000, peakMcap: null, mcap1h: null, mcap6h: null, peakX: null, x1h: null, x6h: null }, o || {});
}

(async () => {
  console.log('-- 1. sans cle : rien');
  let appels = [];
  const prendre = (rep) => async (url, init) => { appels.push({ url, auth: init && init.headers && init.headers.authorization }); return { ok: true, status: 200, json: async () => rep() }; };
  let recus = [];
  let X = AL.cree({ dossier: process.env.DATA_DIR, prendre: prendre(() => ({ alerts: [] })), surAlerte: (v) => { recus.push(v); return true; }, maintenant: () => T });
  eq((await X.tour()).etat, 'inactif', 'tour : inactif');
  eq(appels.length, 0, 'aucune requete');
  eq(X.planifie(), null, 'planifie : rien d arme');

  console.log('-- 2. la cle, le recul, les ecartes');
  process.env.AGENTLIFE_SIGNALS_KEY = 'cle-secrete-de-test-1234567890';
  const lot = [
    alerte('rebond', 'a', 10), alerte('lancement', 'b', 5), alerte('swoge', 'c', 4), alerte('confirmation', 'd', 3),
    alerte('smart', 'e', 2, { chain: 'base' }), alerte('nouveau_type', 'f', 2), alerte('copie', 'g', 1, { token: 'pas-une-adresse' }),
  ];
  X = AL.cree({ dossier: process.env.DATA_DIR, prendre: prendre(() => ({ alerts: lot })), surAlerte: (v) => { recus.push(v); return true; }, maintenant: () => T });
  let r = await X.tour();
  eq(r.etat, 'lu', 'tour lu');
  const u = new URL(appels[0].url);
  eq(appels[0].auth, 'Bearer cle-secrete-de-test-1234567890', 'la cle part en Authorization');
  ok(!/cle-secrete/.test(appels[0].url), 'et jamais dans l URL');
  eq(u.pathname, '/signals/v1/alerts', 'la route des alertes');
  eq(Date.parse(u.searchParams.get('since')), T - 30 * 60000, 'premier tour : depuis 30 min, pas plus');
  eq(recus.map((v) => v.source).join(','), 'agentlife_rebond,agentlife_lancement', 'transmises : rebond et lancement seulement');
  ok(recus.every((v) => v.verdict === 'ACHETER' && /^0x[0-9a-f]{40}$/.test(v.jeton) && v.t < T), 'chacune : ACHETER, adresse, heure de l alerte');
  const M = X.etat().mesure;
  ok(M.ecartees.swoge === 1 && M.ecartees.confirmation === 1 && M.horsChaine === 1 && M.ecartees['inconnu:nouveau_type'] === 1 && M.ecartees.adresse === 1,
     'ecartees : swoge (echo), confirmation (vente), autre chaine, type inconnu, adresse illisible');
  ok(!JSON.stringify(X.etat()).includes('cle-secrete'), 'l etat servi ne contient pas la cle');

  console.log('-- 3. le curseur et le double');
  appels = [];
  r = await X.tour();
  eq(Date.parse(new URL(appels[0].url).searchParams.get('since')), T - 1 * 60000, 'le curseur avance a la plus recente lue');
  eq(recus.length, 2, 'la meme alerte relue : pas transmise deux fois');

  console.log('-- 4. une panne');
  const X2 = AL.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'agentlife-')), prendre: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Clé invalide' }) }), surAlerte: () => true, maintenant: () => T });
  eq((await X2.tour()).etat, 'erreur', 'une cle refusee : erreur comptee');
  ok(/401/.test(X2.etat().mesure.derniereErreur), 'avec son statut');

  console.log('-- 5. la vraie colonie : des ombres, jamais un achat');
  delete process.env.COLONIE_SMART_SIGNAL;
  const C = require('./ai_colonie');
  for (const k of Object.keys(AL.LIGNES)) ok(C.SMART_LIGNES_V2['agentlife_' + k] === AL.LIGNES[k], 'source v2 : agentlife_' + k + ' -> « ' + AL.LIGNES[k] + ' »');
  ok(!C.SMART_LIGNES_V2.agentlife_swoge && !C.SMART_LIGNES_V2.agentlife_confirmation, 'ni « swoge » ni « confirmation » n ont de ligne');
  ok(C.signalSmart({ jeton: adr('a'), verdict: 'ACHETER', source: 'agentlife_rebond', t: T }), 'la colonie prend une alerte rebond');
  ok(!C.signalSmart({ jeton: adr('a'), verdict: 'ACHETER', source: 'agentlife_swoge', t: T }), 'et refuse une source inconnue (agentlife_swoge)');
  const vue = C.smartVue();
  const l = vue.lignes.find((x) => x.cle === 'agentlife: rebound');
  ok(l && l.source === 'agentlife_rebond' && l.verdict === 'ACHETER', 'la vue liste sa ligne « agentlife: rebound »');
  eq(vue.enAttente, 1, 'elle attend un prix dans la file des ombres');
  ok(C.smartLigneDe({ verdict: 'ACHETER', source: 'agentlife_rebond' }) === 'agentlife: rebound', 'son ombre sera jugee sous sa ligne');
  /* « observe » ou « achat », une source v2 n'entre jamais dans le tour : la condition est dans
     prendLesSignauxSmart (`!v.source`) — lue ici dans le code, pour que personne ne l'enleve sans le voir. */
  const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
  ok(/mode === 'achat' && !v\.source && v\.verdict === 'ACHETER' && porte && porte\.ouverte\) t = await jetonDepuisDex/.test(src)
     && /if \(mode === 'achat' && !v\.source && v\.verdict === 'ACHETER' && !deja\)/.test(src), 'seul un verdict SANS source peut entrer dans le tour : AgentLife jamais');

  console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
