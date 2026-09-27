'use strict';
/* ==========================================================================
 * LE SCAN DE LOBSTER — UNE FIXTURE D'ESSAI PARTAGEE
 *
 * Le scan de LOBSTER (0x254a…8dc5), releve sur le serveur en direct le
 * 26 septembre 2026 (route /scan, `aiColonie.scanJeton`) : 35 cases, dans
 * l'ordre ou la colonie les rend (par |moyenne|). C'est le cas qui a montre
 * les defauts de la carte (cles brutes, libelles francais, quatre lignes du
 * bytecode a +16,9 % sur 2 395 a 2 398 observations, cinq « not from pons »).
 * Lue par carte_scan.test.js, studio_jeton.test.js et scan_public.test.js :
 * un seul releve, pas trois copies qui divergent.
 * ======================================================================== */
const LOBSTER = {
  jeton: { adr: '0x254afb9fd36789bea39fb5656ba6fdb827be8dc5', sym: 'LOBSTER', nom: 'Lobster' },
  lanceur: null, faits: [],
  cases: [['octEmit', 'code : sans emission', 2395, 16.9], ['octListe', 'code : sans liste noire', 2398, 16.9], ['octPause', 'code : sans pause', 2396, 16.9],
    ['octFrais', 'code : frais fixes', 2398, 16.9], ['social', '3+ reseaux', 1087, 16.5], ['pad', 'not from a launchpad', 52584, 5.5], ['padDep', 'no launchpad record', 57003, 4.5],
    ['mc', 'mc <10k', 32821, -4.3], ['origine', 'trouve par pools', 51335, 3.7], ['pons', 'not from pons', 57293, 3.3], ['ponsGradAge', 'not from pons', 57293, 3.3],
    ['ponsVitesse', 'not from pons', 57293, 3.3], ['ponsDep', 'not from pons', 57293, 3.3], ['ponsInit', 'not from pons', 57293, 3.3], ['taxe', 'taxe inconnue', 63182, 2.8],
    ['code', 'code inconnu', 63155, 2.8], ['pouv', 'pouvoirs ?', 63155, 2.8], ['accord', 'une seule source', 63145, 2.8], ['avis', 'conseiller non consulte', 62993, 2.8],
    ['vola', 'vola ?', 60870, 2.7], ['cobaye', 'sortie non testee', 62847, 2.7], ['brule', 'brule inconnu', 59070, 2.3], ['accel', 'stable', 552, -2.2],
    ['flux', 'flux inconnu', 61554, 2.2], ['achUniq', 'acheteurs ?', 61554, 2.2], ['taille', 'tailles ?', 61559, 2.2], ['top', 'concentration inconnue', 58177, 2.1],
    ['det', 'porteurs inconnus', 58177, 2.1], ['press', 'equilibre', 13484, -1.7], ['age×mc', '2-6 h × mc <10k', 301, -1.7], ['liq', 'liq 5-25k', 23388, -1.5],
    ['uniq', '<20 traders/h', 49294, 0.8], ['elan', '5m 0-5%', 29374, -0.5], ['pools', '1 pool', 7432, -0.4], ['age', '2-6 h', 5657, -0.2]]
    .map(([trait, c, nn, moyenne]) => ({ trait, case: c, n: nn, moyenne })),
  mesureSur: { observations: 147292, tours: 14949, minObs: 6, echeance: 30 },
};

module.exports = LOBSTER;
