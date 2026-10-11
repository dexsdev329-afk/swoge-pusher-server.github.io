#!/usr/bin/env node
'use strict';
/*
 * LE BILAN DU DIRECT EN JEU, HORS SERVEUR (lot 7 de la cle 20K, 11/10/2026).
 *
 *   node outils/releve_en_jeu.js JOURNAL [JOURNAL…]   des fichiers .jsonl ou des dossiers qui en contiennent
 *     --projection N               la base du mois SANS l'observation (credits), pour la condition G5
 *     --projection-socle C:J:MOIS  ou la projection du socle (x-requests-used x 30 / jour J du mois MOIS),
 *                                  dont le bilan retire lui-meme ce que l'observation a coute
 *     --json                       le bilan entier en JSON
 *
 * Les fichiers viennent du volume (`$DATA_DIR/paris_en_jeu/AAAA-MM-JJ.jsonl`)
 * ou de la route admin `/paris/en-jeu/journal?jour=AAAA-MM-JJ`. AUCUN appel
 * reseau, AUCUN credit : le bilan est `paris_en_jeu.bilan`, la MEME fonction
 * que le serveur (un seul endroit), rejouee sur le brut. Une definition fausse
 * se corrige dans paris_en_jeu.js et se recalcule ici sur tout ce qui est
 * garde (30 jours sur le volume, plus ce qui a ete fige ailleurs).
 *
 * Code de sortie : 0 si la porte est verte, 2 si elle ne l'est pas (rouge ou
 * « not enough »), 1 sur une erreur de lecture.
 */
const fs = require('fs');
const path = require('path');
const enJeu = require('../paris_en_jeu');

function fichiersDe(cible) {
  const st = fs.statSync(cible);
  if (st.isDirectory()) return fs.readdirSync(cible).filter((f) => /\.jsonl$/.test(f)).sort().map((f) => path.join(cible, f));
  return [cible];
}
const pc = (x) => (x === null || x === undefined ? 'n/a' : (Math.round(x * 10000) / 100) + ' %');

function texte(b) {
  const L = [];
  const e = b.echantillon;
  L.push(`Live betting gate (observation) — ${b.porte.verte ? 'GREEN' : 'NOT GREEN'}`);
  L.push(`  sample: ${e.evenements} dated events (${e.evenementsJuges} judged for the informed bettor), ${e.rencontres} complete matches (${e.admises} admitted, ${e.incompletes} incomplete), ${e.clubs} clubs, ${e.jours} days`);
  /* la borne du retard d'ESPN (relecture du 11/10/2026) : au-dela du seuil, G1 et G2 ne jugent pas la rencontre */
  const re = b.latences.retardEspn;
  L.push(`  ESPN lag bound (kick-off + clock, 1st half): median ${re.mediane === null ? 'n/a' : re.mediane + ' s'}, p90 ${re.p90 === null ? 'n/a' : re.p90 + ' s'}, ` +
         `max ${re.max === null ? 'n/a' : re.max + ' s'} on ${re.connues} of ${re.n} complete matches; ${re.nonJugees} not judged (over ${re.seuil} s or unknown)`);
  for (const r of b.porte.raisons) L.push('  - ' + r);
  L.push('');
  for (const k of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) L.push(`  ${k} ${b.conditions[k].ok ? 'green' : 'RED  '}  ${b.conditions[k].texte}`);
  L.push('');
  L.push('  by club:');
  for (const [c, k] of Object.entries(b.conditions.G3.clubs)) {
    L.push(`    ${c.padEnd(22)} ${String(k.completes).padStart(3)}/${String(k.rencontres).padEnd(3)} complete, ESPN ${k.appariees}/${k.rencontres}, ` +
           `live exchange ${pc(k.vivante)} (${k.vivantes}/${k.jugees})${k.vendable ? '  sellable' : '  — ' + k.pourquoi}`);
  }
  const s = b.conditions.G3.suspensionsS;
  L.push(`  exchange suspensions: ${s.n} (median ${s.mediane === null ? 'n/a' : s.mediane + ' s'}, p90 ${s.p90 === null ? 'n/a' : s.p90 + ' s'})`);
  L.push('  informed bettor by delay: ' + Object.entries(b.conditions.G1.parDelta).map(([d, x]) => `+${d} s ${x.acceptees}/${x.offres} accepted`).join(', '));
  L.push('  latencies (reported only): ESPN - price jump ' + JSON.stringify(b.latences.espnMoinsSautS) + ', ESPN - freeze ' + JSON.stringify(b.latences.espnMoinsGelS) +
         ', dating ' + JSON.stringify(b.latences.datation));
  for (const [m, t] of Object.entries(b.taux)) {
    L.push(`  margin ${m}: 1X2 quotable ${pc(t.cotable)}, accepted strict ${pc(t.accepteesStricte)}, min(seen, fresh) ${pc(t.accepteesMin)}, outside 3 min after events ${pc(t.accepteesMinHorsEvenement)}`);
  }
  if (b.sonde) L.push(`  last_update probe: ${b.sonde.ok ? 'present' : 'ABSENT'}`);
  return L.join('\n');
}

function principal(argv) {
  const args = argv.slice(2);
  const cibles = [];
  const params = {};
  let json = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--json') json = true;
    else if (a === '--projection') params.projection = Number(args[++k]);
    else if (a === '--projection-socle') {
      const [c, j, mois] = String(args[++k] || '').split(':');
      params.projection = { credits: Number(c), jourDuMois: Number(j), mois };
    } else cibles.push(a);
  }
  if (!cibles.length) { console.error('usage: node outils/releve_en_jeu.js JOURNAL.jsonl|DOSSIER [...] [--projection N] [--json]'); return 1; }
  const lignes = [];
  for (const c of cibles) for (const f of fichiersDe(c)) for (const l of enJeu.lisLignes(fs.readFileSync(f, 'utf8'))) lignes.push(l);
  const b = enJeu.bilan(lignes, params);
  console.log(json ? JSON.stringify(b, null, 2) : texte(b));
  return b.porte.verte ? 0 : 2;
}

module.exports = { principal, texte };
if (require.main === module) {
  let code = 1;
  try { code = principal(process.argv); } catch (e) { console.error(String((e && e.message) || e)); code = 1; }
  process.exit(code);
}
