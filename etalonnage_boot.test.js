'use strict';
/*
 * UN REDEPLOIEMENT NE COUTE PAS UN ETALONNAGE.
 *
 * Mesure du 18 septembre 2026 : 118 deploiements Railway en dix-sept jours,
 * un etalonnage (un credit par ligue active, neuf) une heure apres chacun
 * qui a vecu plus d'une heure — l'essentiel des 211 credits du mois. Le
 * premier etalonnage doit repartir de la date du dernier, ecrite sur le
 * volume, et jamais tomber sous une heure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-etal-'));
process.env.DATA_DIR = dossier;
process.env.ODDS_API_KEY = 'x';
const { delaiAvantEtalonnage } = require('./paris_import.js');

const H = 3600000, J = 24 * H;
let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('  ok   ' + m); };
function pose(quand) {
  fs.writeFileSync(path.join(dossier, 'odds_dernier.json'),
    JSON.stringify(quand ? { calibre: { quand: new Date(quand).toISOString() } } : {}) + '\n');
}
const t0 = Date.parse('2026-09-18T12:00:00Z');

/* Le module garde l'etat en memoire apres la premiere lecture : on ecrit
   AVANT le premier appel, et l'on verifie l'ordre le plus parlant en dernier. */
pose(t0 - 2 * J);
const d2 = delaiAvantEtalonnage(t0);
ok(Math.abs(d2 - 5 * J) < 1000, `etalonne il y a deux jours : le prochain attend cinq jours (${Math.round(d2 / H)} h), pas une heure`);
ok(d2 > H, 'donc bien plus qu une heure : un redeploiement dans la semaine ne paie rien');

const d6 = delaiAvantEtalonnage(t0 + 4 * J);
ok(Math.abs(d6 - 1 * J) < 1000, `quatre jours plus tard, il en reste un (${Math.round(d6 / H)} h)`);

const d10 = delaiAvantEtalonnage(t0 + 8 * J);
ok(d10 === H, 'dix jours apres le dernier, le plancher : une heure, comme avant');

console.log(`\netalonnage_boot.test.js : ${n} verifications OK`);
