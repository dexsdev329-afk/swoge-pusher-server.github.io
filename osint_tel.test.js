'use strict';
/* ============================================================================
 * LE NUMERO : LE TYPE ET LA REGION SE LISENT DANS LE PLAN, PAS DANS numverify
 *
 * numverify rend souvent un operateur vide sur un numero francais : la
 * portabilite fait qu un numero garde son numero en changeant d operateur,
 * donc l attribution d origine ne dit plus rien. Mais le TYPE (mobile / fixe /
 * VoIP / special) et la REGION, eux, sont dans le PREFIXE du plan ARCEP — ils
 * ne bougent jamais. On les decode donc nous-memes, sans cle, et on garde
 * l operateur a « not determined » avec la raison.
 * ==========================================================================*/
const C = require('./osint_connecteurs');
const N = require('./osint_noyau');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

console.log('-- 1. le plan francais : type et region, deterministes --');
eq(C.typeFR('612345678'), 'mobile', '06 est un mobile');
eq(C.typeFR('712345678'), 'mobile', '07 est un mobile aussi');
ok(/Île-de-France/.test(C.typeFR('145678900')), '01 est un fixe en Île-de-France');
ok(/North-West/.test(C.typeFR('240000000')), '02 est un fixe au Nord-Ouest');
ok(/South-East/.test(C.typeFR('491234567')), '04 est un fixe au Sud-Est');
ok(/VoIP/.test(C.typeFR('970123456')), '09 est de la VoIP / non geographique');
ok(/freephone/.test(C.typeFR('800123456')), '0800 est un numero vert');
ok(/special-rate/.test(C.typeFR('899123456')), '089x est a tarif majore');
eq(C.typeFR(''), null, 'rien a decoder rend null');

(async () => {
  console.log('\n-- 2. le connecteur, de bout en bout, sur un +33 6 --');
  const cible = N.entite('telephone', '+33 6 12 34 56 78');
  eq(cible.valeur, '+33612345678', 'le numero est normalise en E.164');
  const r = await N.enquete(cible, {});
  const plan = (r.faits || []).find((x) => x.predicat === 'NUMBERING PLAN');
  const type = (r.faits || []).find((x) => x.predicat === 'LINE TYPE');
  const car = (r.faits || []).find((x) => x.predicat === 'CARRIER');
  ok(plan && /France/.test(plan.valeur), 'le plan dit France');
  ok(type && /mobile/.test(type.valeur), 'le TYPE est mobile — ce que numverify ne donnait pas [' + (type && type.valeur) + ']');
  ok(type && /ARCEP/.test((type.sources || [])[0] || ''), 'et il est sourcé au plan ARCEP');
  /* `numerotation` ne parle PAS de l opérateur : sans clé numverify, aucun
     CARRIER n est affirmé — on ne fabrique pas une fausse contradiction. */
  ok(!car, 'numerotation ne prétend rien sur l opérateur : c est le rôle de numverify quand sa clé est là');

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
