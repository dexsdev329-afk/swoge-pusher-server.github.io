'use strict';
/* ============================================================================
 * L'ÉCONOMIE $SWOGE — LA CARTE DIT CE QUE DIT LA CHAÎNE
 *
 * La carte de l'accueil annonçait 6 827 534 brûlés et un coffre à ≈10 % quand
 * la chaîne disait 13 389 118 et 1,52 % (relevé du 26 septembre 2026). Ce que
 * `/economie.json` DOIT tenir :
 *   1. Les chiffres sont ceux lus sur le contrat, et leur part de l'offre.
 *   2. La chaîne n'est pas relue à chaque visite (cache), mais l'est après.
 *   3. Une lecture ratée ne remplace JAMAIS la dernière bonne par un zéro :
 *      on rend l'ancienne, datée, `frais: false`.
 *   4. Sans aucune lecture réussie, la route le dit (503) au lieu d'inventer.
 * Aucun appel réseau : le lecteur de chaîne est remplacé.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'economie-'));
process.env.VAULT_ADDRESS = '0x5593c8141303D14999Df7aa03dd3d3a6d4335fAb';
const port = 20000 + Math.floor(Math.random() * 20000);
process.env.PORT = String(port);

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

(async () => {
  const E = require('./economie');
  let appels = 0, panne = false, brule = 13389118.44;
  const faux = async () => { appels++; if (panne) throw new Error('node down'); return { offre: 1e9, brule, coffre: 15155373.09 }; };

  console.log('-- 1. les chiffres de la chaine, et leur part de l offre --');
  {
    E._reset(); E._lecteur(faux);
    const e = await E.etat(1000);
    ok(e.ok && e.frais, 'une lecture reussie est servie, fraiche');
    eq(e.brule, 13389118.44, 'le brule est le solde de l adresse morte');
    eq(e.brulePct, 1.34, 'et sa part de l offre');
    eq(e.coffrePct, 1.52, 'le coffre, et sa part (pas « ≈10 % »)');
    eq(e.stakingPlafond, 200000000, 'le plafond du staking vient de la configuration (20 % de l offre)');
    eq(e.stakingAprPct, 100, 'et le rendement aussi');
  }

  console.log('\n-- 2. le cache : une lecture par periode, pas une par visite --');
  {
    const avant = appels;
    for (let i = 0; i < 20; i++) await E.etat(1000 + i * 1000);
    eq(appels - avant, 0, 'vingt visites dans la periode : aucune relecture');
    brule = 13400000;
    const e = await E.etat(1000 + E.CACHE_MS + 1);
    eq(appels - avant, 1, 'la periode passee : une relecture');
    eq(e.brule, 13400000, 'et le nouveau brule est servi (il ne fait que monter)');
  }

  console.log('\n-- 3. une panne ne fait pas croire que rien n est brule --');
  {
    panne = true;
    const t = 1000 + 3 * E.CACHE_MS;
    const e = await E.etat(t);
    ok(e.ok && e.brule === 13400000, 'la derniere bonne lecture est rendue, pas un zero [' + e.brule + ']');
    eq(e.frais, false, 'et elle se dit perimee');
    const avant = appels;
    for (let i = 1; i <= 10; i++) await E.etat(t + i * 1000);
    eq(appels - avant, 0, 'pendant la panne, pas de relance a chaque visite (une par minute au plus)');
  }

  console.log('\n-- 4. jamais lu : on le dit, on n invente pas --');
  {
    E._reset(); panne = true; E._lecteur(faux);
    const e = await E.etat(1000);
    ok(!e.ok && e.brule === null && e.offre === null, 'aucune lecture reussie : aucun chiffre');
  }

  console.log('\n-- 5. la route publique, sur un vrai serveur --');
  {
    E._reset(); panne = false; brule = 13389118.44; E._lecteur(faux);
    require('./server');
    await new Promise((r) => setTimeout(r, 400));
    const rep = await fetch('http://127.0.0.1:' + port + '/economie.json');
    const j = await rep.json();
    eq(rep.status, 200, 'la route repond');
    eq(rep.headers.get('access-control-allow-origin'), '*', 'lisible depuis le site (CORS)');
    ok(j.brule === 13389118.44 && j.coffreAdresse === process.env.VAULT_ADDRESS, 'elle sert les chiffres de la chaine, et l adresse du coffre lue');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
