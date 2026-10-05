'use strict';
/* L'AGENT D'UN JETON COMPOSE UN POST.
 *
 * Intention (à tenir si un changement contredit l'essai) : l'agent écrit dans
 * SA persona, à partir des faits reçus seulement (jamais un chiffre inventé) ;
 * un fetch injectable fait que RIEN ne sort de la machine ; sans clé ou si le
 * modèle se tait, une phrase de réserve déterministe part quand même ; les liens
 * écrits par le modèle sont retirés, et le lien voulu est ajouté proprement.
 */
const A = require('./agent_poste');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* Un faux Anthropic : rend le texte qu'on lui dit, et compte les appels. */
function fauxModele(texte, { jette, status } = {}) {
  return async () => {
    if (jette) throw new Error('reseau coupe');
    if (status && status !== 200) return { ok: false, status };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: texte }] }) };
  };
}

(async () => {
  console.log('-- 1. le prompt systeme porte la persona ET les regles dures --');
  const sys = A.systeme('contrarian');
  ok(/Contrarian/.test(sys) && /NEVER invent a number/.test(sys) && /No promises of returns/.test(sys),
     'le systeme contient le caractere de la persona et les garde-fous');
  ok(/analyst/i.test(A.systeme('inconnue')), 'une persona inconnue retombe sur un defaut, pas une erreur');

  console.log('\n-- 2. compose via le modele : texte nettoye, un seul appel --');
  let r = await A.compose({ persona: 'analyst', symbole: 'FOO', faits: ['liquidity $12.3K', '3 holders'] },
                          { cleAnthropic: 'k', fetch: fauxModele('  "Reading the book, not the hype. $FOO liquidity is thin but real. 📊"  ') });
  ok(r.via === 'modele', 'avec une cle et une reponse : via modele');
  ok(!/^["\s]/.test(r.texte) && !/["\s]$/.test(r.texte), 'les guillemets et espaces de bord sont retires');

  console.log('\n-- 3. aucun lien du modele ne survit ; le lien voulu est ajoute proprement --');
  r = await A.compose({ persona: 'hype', symbole: 'FOO', lien: 'https://swoleeswoge.dog/t/FOO' },
                      { cleAnthropic: 'k', fetch: fauxModele('Check us at https://spam.example/evil now 🐾') });
  ok(!/spam\.example/.test(r.texte), 'le lien ecrit par le modele est supprime');
  ok(r.texte.endsWith('https://swoleeswoge.dog/t/FOO'), 'le lien voulu est ajoute a la fin');
  ok(r.texte.length <= 280, 'le post tient dans la limite de X');

  console.log('\n-- 4. sans cle : phrase de reserve, bâtie sur l objectif reçu --');
  r = await A.compose({ persona: 'builder', symbole: 'FOO', objectif: 'ship a new game every week' }, { fetch: fauxModele('ne devrait pas servir') });
  ok(r.via === 'reserve' && /ship a new game every week/.test(r.texte), 'sans cle : reserve, et elle reprend l objectif tel quel');

  console.log('\n-- 5. le modele tombe (reseau / non-200) : on bascule en reserve --');
  r = await A.compose({ persona: 'stoic', symbole: 'FOO' }, { cleAnthropic: 'k', fetch: fauxModele('', { jette: true }) });
  ok(r.via === 'reserve' && r.texte.length > 0, 'modele injoignable : reserve non vide');
  r = await A.compose({ persona: 'stoic', symbole: 'FOO' }, { cleAnthropic: 'k', fetch: fauxModele('', { status: 500 }) });
  ok(r.via === 'reserve', 'HTTP 500 : reserve');

  console.log('\n-- 6. la reserve n invente aucun chiffre --');
  const res = A.reserve({ persona: 'contrarian', symbole: 'FOO' });
  ok(!/\d/.test(res), 'sans fait ni objectif, la reserve ne contient aucun chiffre');
  ok(/\$FOO/.test(res), 'mais elle nomme le jeton');

  console.log('\n-- 7. la demande transmet faits, objectif et posts passes au modele --');
  const d = A.demande({ persona: 'analyst', symbole: 'FOO', objectif: 'be useful', faits: ['vol $1K'], precedents: ['old post'] });
  ok(/be useful/.test(d) && /vol \$1K/.test(d) && /old post/.test(d) && /do not repeat/i.test(d),
     'objectif, faits et consigne de non-repetition sont dans la demande');
  const dv = A.demande({ persona: 'analyst', symbole: 'FOO' });
  ok(/No fresh facts/.test(dv), 'sans fait : on le dit au modele (il ne doit citer aucun chiffre)');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
