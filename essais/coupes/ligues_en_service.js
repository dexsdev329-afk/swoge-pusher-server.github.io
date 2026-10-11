'use strict';
/*
 * Processus enfant de coupes_gardes.test.js (avec faux_fetch.js en
 * precharge) : imprime, en une ligne JSON, les cles de
 * paris_import.liguesEnService() pour l'ODDS_API_LIGUES et les
 * PARIS_COUPES_OBSERVE de son environnement. ODDS_API_LIGUES est lue au
 * chargement du module : d'ou un processus par reglage.
 */
const path = require('path');
(async () => {
  const imp = require(path.join(__dirname, '..', '..', 'paris_import.js'));
  const l = await imp.liguesEnService();
  console.log(JSON.stringify(l.map((x) => x.clef)));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(3); });
