'use strict';
/* ============================================================================
 * UNE BORNE QUI GLISSE NE PEUT PAS FRANCHIR UN CREUX
 *
 * ---- LA MESURE, 20 septembre 2026, 11 354 tours en production ----
 *
 * La borne d age apprise etait montee a CINQUANTE minutes. Ce qu elle
 * refusait, par tranche, avec la colonne STRATEGIE — qui ne dit pas « est-ce
 * que ca monte » mais rejoue la sortie complete, donc ce qu on aurait
 * reellement encaisse :
 *
 *   moins de 10 min   n=297   47 % montent   strategie  +3,1 %   (294 obs)
 *   10-30 min         n= 59   31 %           strategie  +3,6 %   ( 57 obs)
 *   30-60 min         n= 30   27 %           strategie -21,4 %   ( 35 obs)
 *   60-90 min         n= 19   32 %           strategie -10,4 %   ( 20 obs)
 *   reference (ce qu on achete)  n=241   25 % montent
 *
 * Le desserrage juge la borne sur « la tranche juste sous la borne ». Juste
 * si la relation age/rendement est monotone — elle ne l est pas. La borne
 * etait a 50, sa marge etait donc 30-60 : la PIRE tranche. Elle refusait de
 * se desserrer, et elle avait raison sur celle-la. Mais la MEILLEURE tranche
 * est la plus jeune, et une borne qui glisse d un cran ne peut jamais
 * l atteindre : il faudrait traverser le creux.
 *
 * Le trait `age×mc` le confirme independamment : « ne de <10 min × mc
 * 50-100k », n=733, +50,6 % de moyenne — la meilleure case de la courbe.
 *
 * Ce que cet essai fige : le quota s ouvre sur la bonne tranche, et il se
 * REFERME tout seul des qu une des conditions tombe. Une soupape qui ne sait
 * pas se refermer n est pas une soupape.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/quotajeune-');
process.env.AI_COLONIE = '0';
const A = require('./ai_colonie');

console.log('-- sans audit, le quota reste ferme --');
{
  ok(A.trancheJeuneOuverte() === null, 'aucune tranche designee quand la colonie n a rien mesure');
  ok(A.QUOTA_JEUNE_PAR_TOUR >= 1, 'le quota existe : ' + A.QUOTA_JEUNE_PAR_TOUR + ' par tour');
  ok(A.QUOTA_JEUNE_MIN_OBS >= 20, 'et il exige au moins ' + A.QUOTA_JEUNE_MIN_OBS + ' rejeux avant de s ouvrir');
}

console.log('\n-- les bandes d age, telles que la colonie les nomme --');
{
  eq(A.bandeAge(3), 'too young: under 10 min', 'trois minutes tombent dans la tranche la plus jeune');
  eq(A.bandeAge(45), 'too young: 30-60 min', 'quarante-cinq minutes dans 30-60');
  eq(A.bandeSousLaBorne(50), 'too young: 30-60 min',
     'et la marge d une borne a 50 est bien 30-60 : la tranche que le desserrage regardait');
}

console.log('\n-- ce que le quota EXIGE, lu dans le code --');
{
  /* Quatre conditions. En verifier l ecriture vaut mieux que de les
     reconstituer : c est leur conjonction qui empeche le quota de s ouvrir
     sur une impression. */
  const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
  const bloc = src.slice(src.indexOf('function trancheJeuneOuverte()'),
                         src.indexOf('function trancheJeuneOuverte()') + 1800);
  ok(/haut > borneAge/.test(bloc), 'la tranche doit etre SOUS la borne');
  ok(/nStrat < QUOTA_JEUNE_MIN_OBS/.test(bloc), 'elle doit avoir assez de rejeux de strategie');
  ok(/l\.strat > 0/.test(bloc), 'sa strategie rejouee doit etre POSITIVE, pas seulement meilleure que');
  ok(/l\.partMontes >= S\.coute/.test(bloc), 'et ses jetons doivent monter au moins autant que ce qu on achete');
  ok(/seuilsAudit\(\)/.test(bloc),
     'le seuil vient du moteur lui-meme, pas d une marge reinventee a cote');
  /* Une condition qui tombe referme le quota SANS qu on y touche : c est ce
     qui distingue une soupape d un interrupteur. */
  ok(/return null/.test(bloc), 'et toute condition qui tombe rend `null` : le quota se referme seul');
}

console.log('\n-- le quota est PAR TOUR, et il a sa propre ligne d audit --');
{
  const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
  ok(/E\.quotaJeune\.tour === E\.tours/.test(src),
     'le compteur est remis a zero a chaque tour, pas par heure : une cadence qui change ne doit pas changer le quota');
  ok(/'achete par quota jeune'/.test(src),
     'les achats du quota portent leur PROPRE cle d audit');
  /* S ils tombaient dans « achete ou retenu », ils deplaceraient la reference
     contre laquelle ils sont justement juges. */
  const cle = src.slice(src.indexOf('function cleAudit'), src.indexOf('function cleAudit') + 500);
  ok(/o\.quotaJeune \? 'achete par quota jeune' : 'achete ou retenu'/.test(cle),
     'et ils ne se melangent pas a la reference, sinon elle se deplacerait avec eux');
}

console.log('\n-- l age reste le DERNIER veto --');
{
  /* Le quota n ouvre que l age. Un jeton qui arrive la a deja franchi la
     liquidite, la capitalisation, le contrat et la note : le quota ne
     contourne rien d autre. */
  const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
  const d0 = src.indexOf('function vetoScout');
  const v = src.slice(d0, src.indexOf('\nfunction ', d0 + 10));
  const iQuota = v.indexOf('quotaJeunePrend');
  const iLiq = v.indexOf('below the buy floor');
  const iMc = v.indexOf('above the buy ceiling');
  ok(iLiq >= 0 && iMc >= 0 && iQuota >= 0,
     'les trois refus sont bien dans `vetoScout` [liq ' + iLiq + ', mc ' + iMc + ', quota ' + iQuota + ']');
  ok(iQuota > iLiq && iQuota > iMc,
     'et le quota vient APRES eux : il n ouvre que la porte de l age');
}

try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
console.log(rates ? `\nquota_jeune.test.js : RATES : ${rates}/${n}` : `\nquota_jeune.test.js : ${n} verifications OK`);
process.exit(rates ? 1 : 0);
