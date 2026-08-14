'use strict';
/*
 * La surveillance.
 *
 * Un controle de sante qui repond toujours oui est pire que pas de controle :
 * il donne la tranquillite sans la garantie, et on branche dessus un service
 * d'alerte qui ne sonnera jamais. Ce fichier ne verifie donc pas que /health
 * repond — il verifie qu'il repond NON quand ca va mal, et pour chacune des
 * pannes qui coutent de l'argent, une par une.
 *
 * On teste aussi ce qu'il ne doit PAS dire : cette page est publique, parce
 * qu'un moniteur externe ne sait pas s'authentifier. Aucun solde, aucune
 * adresse ne doit s'y trouver.
 */
const assert = require('assert');
const fs = require('fs');

process.env.PORT = String(8600 + (process.pid % 90));
process.env.DATA_DIR = fs.mkdtempSync('/tmp/sante-test-');
process.env.RPC_URL = '';
process.env.DEV_FAUCET = '1';

const sante = require('./sante');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================== ce qui rend l etat mauvais
{
  eq(sante.etat().ok, true, 'au repos, tout va bien');

  /* Les ecritures qui echouent : la panne la plus chere, et la seule qui
     laisse le serveur repondre normalement pendant qu elle se produit. */
  sante.noteEcriture(false);
  eq(sante.etat().ok, true, 'une sauvegarde ratee isolee ne declenche rien');
  sante.noteEcriture(false);
  sante.noteEcriture(false);
  const casse = sante.etat();
  eq(casse.ok, false, 'trois d affilee, si : ca ne s ecrit plus');
  ok(/sauvegardes ratees/.test(casse.graves.join(' ')),
     'et le message dit laquelle des pannes c est', casse.graves);
  eq(casse.ecrituresRatees, 3, 'le compte est rapporte');

  sante.noteEcriture(true);
  eq(sante.etat().ok, true, 'une reussite remet le compteur a zero');
}

// ------------------------------------------- ce qui n est qu une remarque
{
  sante.noteIncident('exception', 'quelque chose a casse quelque part');
  const e = sante.etat();
  eq(e.ok, true, 'une exception isolee n arrete pas le serveur, donc pas d alerte');
  eq(e.incidents10min, 1, 'mais elle est comptee');
  ok(/exception/.test(e.remarques.join(' ')), 'et rapportee', e.remarques);
}

// ==================================== la page ne dit rien de confidentiel
/* Elle est publique par necessite : un service de surveillance ne sait pas
   presenter une cle. Elle ne doit donc porter que des durees et des
   compteurs. */
{
  const texte = JSON.stringify(sante.etat());
  ok(!/0x[0-9a-fA-F]{40}/.test(texte), 'aucune adresse de joueur');
  ok(!/balance|solde|serverSeed|sessionSecret|graine/i.test(texte),
     'aucun solde, aucune graine', texte.slice(0, 200));
  const cles = Object.keys(sante.etat());
  ok(cles.includes('ok') && cles.includes('graves'),
     'mais de quoi decider : un verdict et ses raisons', cles);
}

// ============================ le serveur, en vrai : 200 quand ca va, 503 sinon
{
  require('./server');
  const http = require('http');
  const lis = (chemin) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: process.env.PORT, path: chemin }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; });
      r.on('end', () => res({ code: r.statusCode, corps: d }));
    }).on('error', rej);
  });

  (async () => {
    await dors(400);
    const bon = await lis('/health');
    eq(bon.code, 200, '/health rend 200 quand tout va bien');
    const vu = JSON.parse(bon.corps);
    eq(vu.ok, true, 'et le dit dans le corps');
    ok(typeof vu.joueurs === 'number', 'avec le nombre de joueurs', vu);

    /* LE controle qui compte : on casse pour de vrai, et on regarde si le
       service de surveillance serait prevenu. Un 200 ici voudrait dire qu on
       a branche une alarme sur un fil coupe. */
    sante.noteEcriture(false); sante.noteEcriture(false); sante.noteEcriture(false);
    const mauvais = await lis('/health');
    eq(mauvais.code, 503, '/health rend 503 des que les ecritures echouent — ' +
       'c est ce code qui fait sonner un telephone');
    const vu2 = JSON.parse(mauvais.corps);
    eq(vu2.ok, false, 'et le corps dit non');
    ok(vu2.graves.length > 0, 'en donnant la raison, pas juste « erreur »', vu2.graves);

    sante.noteEcriture(true);
    eq((await lis('/health')).code, 200, 'et il repasse a 200 quand c est repare');

    /* L equite reste publique et indifferente a tout ca : une preuve derriere
       une panne n est pas une preuve. */
    eq((await lis('/fairness')).code, 200, '/fairness reste accessible');

    console.log(`sante.test.js : ${n} verifications OK`);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
