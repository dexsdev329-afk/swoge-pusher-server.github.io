'use strict';
/* APERÇU D'UN POST D'AGENT (orchestrateur).
 *
 * Intention : relier registre → faits → compositeur (+ image optionnelle) sans
 * RIEN publier ; un jeton sans agent, ou un agent en pause, ne produit pas
 * d'aperçu ; une récolte qui tombe n'empêche pas de composer ; l'image n'est
 * demandée que si on la demande, et son contrôle pattes est rapporté.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const AJ = require('./agent_jeton');
const D = require('./agent_demo');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T = '0x' + '1'.repeat(40);
const C = '0x' + 'a'.repeat(40);

(async () => {
  console.log('-- 0. promptImage impose les pattes de chien --');
  ok(/furry dog paws, never human hands/.test(D.promptImage('hype', 'FOO')) && /\$FOO/.test(D.promptImage('hype', 'FOO')),
     'le prompt d image demande des pattes et montre le symbole');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-demo-'));
  const reg = AJ.cree({ fichier: path.join(dir, 'a.json') });
  reg.attache({ token: T, createur: C, persona: 'builder', objectif: 'ship weekly', pool: '0x' + 'c'.repeat(40) });

  const composeFaux = async (o) => ({ texte: '[' + o.persona + '] ' + (o.faits[0] || 'no fact') + (o.symbole ? ' $' + o.symbole : ''), via: o.faits.length ? 'modele' : 'reserve' });

  console.log('\n-- 1. aperçu complet : registre → faits → post --');
  let r = await D.apercu({ token: T, symbole: 'FOO' }, {
    registre: reg,
    recolte: async () => ({ faits: ['liquidity $5K', '0% buy/sell tax'], sources: {} }),
    compose: composeFaux,
  });
  ok(r.ok && r.agent.persona === 'builder', 'l agent est lu dans le registre');
  ok(r.faits.length === 2 && /liquidity \$5K/.test(r.post.texte) && /\$FOO/.test(r.post.texte), 'les faits nourrissent le post, le symbole passe');
  ok(!('image' in r), 'sans avecImage : aucune image générée');

  console.log('\n-- 2. un jeton sans agent, ou en pause --');
  r = await D.apercu({ token: '0x' + '9'.repeat(40) }, { registre: reg, compose: composeFaux });
  ok(!r.ok && r.code === 404, 'pas d agent pour ce jeton : 404');
  reg.bascule(T, C, false);
  r = await D.apercu({ token: T }, { registre: reg, compose: composeFaux });
  ok(!r.ok && r.code === 409, 'agent en pause : 409, aucun aperçu');
  reg.bascule(T, C, true);

  console.log('\n-- 3. une récolte qui tombe n empêche pas de composer --');
  r = await D.apercu({ token: T }, { registre: reg, recolte: async () => { throw new Error('reseau'); }, compose: composeFaux });
  ok(r.ok && r.faits.length === 0 && r.post.via === 'reserve', 'faits vides, mais le post part quand même (réserve)');

  console.log('\n-- 4. image optionnelle : contrôle pattes rapporté, rien n est publié --');
  let prompts = [];
  r = await D.apercu({ token: T, symbole: 'FOO', avecImage: true }, {
    registre: reg, recolte: async () => ({ faits: ['launched today'] }), compose: composeFaux,
    image: async (p) => { prompts.push(p); return { png: Buffer.alloc(1234), controle: { ok: true, raison: 'furry paws' } }; },
  });
  ok(r.image && r.image.octets === 1234 && r.image.controle.ok === true, 'l image est produite et son contrôle pattes est rapporté');
  ok(/dog paws/.test(prompts[0]), 'le prompt d image demandé contient bien les pattes');
  ok(r.post && !/http/.test(JSON.stringify(r)), 'aucune publication : on ne rend qu un aperçu');

  console.log('\n-- 5. l image qui échoue ne casse pas l aperçu --');
  r = await D.apercu({ token: T, avecImage: true }, {
    registre: reg, recolte: async () => ({ faits: [] }), compose: composeFaux,
    image: async () => { throw new Error('image HS'); },
  });
  ok(r.ok && !r.image && /image HS/.test(r.imageErreur || ''), 'image en panne : aperçu quand même, erreur notée');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
