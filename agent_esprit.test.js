'use strict';
/* L'ESPRIT D'UN AGENT (boucle d'outils autonome).
 *
 * Intention : a chaque pulsation l'esprit CHOISIT ses outils (lecture puis
 * action), sans humain ; les lectures le renseignent, puis il poste et/ou propose
 * un rachat ; bornes dures (au plus 1 post, 1 proposition d'argent, N pensees) ;
 * chaque pensee coute du carburant, a sec il dort ; le rachat n est propose que si
 * le createur l a active, et passe par la boucle trader (jamais en direct) ; aucun
 * outil ne prend d adresse, aucune cle. Modele et outils injectes.
 */
const E = require('./agent_esprit');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T = '0x' + '1'.repeat(40);
const agent = { token: T, persona: 'builder', symbole: 'FOO', rachat: { actif: false, budgetPctJour: 0 } };

/* Un faux modele : joue une liste de decisions scriptee, une par pensee. */
function modeleScript(liste) { let i = 0; return async () => liste[i++] || { fin: true }; }
/* Un faux carburant : solde infini, compte les debits. */
function fuelInfini() { let debits = 0; return { peutPenser: () => true, debite: () => { debits++; }, _debits: () => debits }; }

(async () => {
  console.log('-- 1. lit le marche puis poste (autonome) --');
  let posts = [];
  let r = await E.pense(agent, {
    modele: modeleScript([{ outil: 'market' }, { outil: 'post', args: { texte: 'gm, liquidity is healthy 🐾' } }, { fin: true }]),
    outils: { market: async () => ({ liqUsd: 5000 }) },
    poste: async (a, p) => { posts.push(p.texte); return { surX: false }; },
    fuel: fuelInfini(), coutParPenseeUsd: 0.002,
  });
  ok(r.lectures.length === 1 && r.lectures[0].outil === 'market', 'il a lu le marche');
  ok(r.actions.some((x) => x.action === 'post') && posts.length === 1, 'puis il a poste, tout seul');

  console.log('\n-- 2. au plus 1 post par pulsation --');
  posts = [];
  r = await E.pense(agent, {
    modele: modeleScript([{ outil: 'post', args: { texte: 'one' } }, { outil: 'post', args: { texte: 'two' } }]),
    poste: async (a, p) => { posts.push(p.texte); return { surX: true, url: 'u' }; }, fuel: fuelInfini(), coutParPenseeUsd: 0,
  });
  ok(posts.length === 1 && r.actions.filter((x) => x.action === 'post').length === 1, 'le deuxieme post du meme tour est saute');

  console.log('\n-- 3. le rachat : refuse si le createur ne l a pas active --');
  let intents = [];
  r = await E.pense(agent, {
    modele: modeleScript([{ outil: 'propose_buyback', args: { montantUsd: 5 } }]),
    traite: async (i) => { intents.push(i); return { decide: 'signed-paper', recu: { mode: 'paper' } }; }, fuel: fuelInfini(),
  });
  ok(intents.length === 0 && r.trace.some((t) => /not enabled/.test(t.refus || '')), 'rachat non active par le createur : rien ne part a la boucle trader');

  console.log('\n-- 4. rachat active : passe par la boucle trader (jamais en direct) --');
  const agentR = Object.assign({}, agent, { rachat: { actif: true, budgetPctJour: 10 } });
  intents = [];
  r = await E.pense(agentR, {
    modele: modeleScript([{ outil: 'can_i_sell' }, { outil: 'propose_buyback', args: { montantUsd: 3, justification: 'strong volume' } }]),
    outils: { can_i_sell: async () => ({ ok: true }) },
    traite: async (i) => { intents.push(i); return { decide: 'signed-paper', recu: { mode: 'paper' } }; }, fuel: fuelInfini(), coutParPenseeUsd: 0,
  });
  ok(intents.length === 1 && intents[0].action === 'buyback' && intents[0].token === T, 'la proposition passe par deps.traite (boucle trader), avec le token du registre');
  ok(r.actions.some((x) => x.action === 'propose_buyback' && x.decide === 'signed-paper'), 'et le resultat (papier) est rapporte');

  console.log('\n-- 5. le carburant : a sec, l esprit dort --');
  r = await E.pense(agent, { modele: modeleScript([{ outil: 'post', args: { texte: 'x' } }]),
    poste: async () => ({ surX: false }), fuel: { peutPenser: () => false, debite: () => {} }, coutParPenseeUsd: 0.002 });
  ok(r.dort === true && r.actions.length === 0, 'carburant a sec : dort, aucune action');

  console.log('\n-- 6. borne de pensees, et chaque pensee coute --');
  const f = fuelInfini();
  r = await E.pense(agent, { modele: modeleScript([{ outil: 'market' }, { outil: 'market' }, { outil: 'market' }, { outil: 'market' }, { outil: 'market' }, { outil: 'market' }]),
    outils: { market: async () => ({}) }, fuel: f, coutParPenseeUsd: 0.002, maxEtapes: 4 });
  ok(r.etapes <= 4 && f._debits() <= 4, 'au plus maxEtapes pensees, et chacune a coute du carburant');

  console.log('\n-- 7. aucun outil ne prend d adresse, aucune cle dans le module --');
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'agent_esprit.js'), 'utf8');
  ok(!/privateKey|signTransaction|sendTransaction|MIROIR_CLE|AGENT_CLE/.test(src), 'le code de l esprit ne touche aucune cle ni envoi');
  ok(!E.OUTILS.some((o) => /address|adresse|0x/i.test(o.desc)), 'aucun outil n expose une adresse a remplir');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
