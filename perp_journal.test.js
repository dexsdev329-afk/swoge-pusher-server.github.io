'use strict';
/* ============================================================================
 * LE JOURNAL BRUT : CE QU ON POURRA DEMANDER PLUS TARD
 *
 * La colonie garde des compteurs, et un compteur ne repond qu a la question
 * qu on avait prevue. Ce journal garde la LIGNE BRUTE — ce qui a ete mesure
 * au moment de la decision — et, plus tard, ce que la situation a donne. Le
 * rapprochement des deux est la seule chose qui reponde a « comment gagne-t-on
 * sur la duree ».
 *
 * Ce qui est mesure ici :
 *   - une ligne par marche et par tour, avec ses mesures et sa decision ;
 *   - une ligne de resultat par echeance atteinte, reliee a la premiere ;
 *   - la TAILLE reelle d une ligne, parce qu un journal qui remplit le volume
 *     est un journal qu on eteindra ;
 *   - la retention : les vieux fichiers partent, les recents restent ;
 *   - et qu un journal qui tombe n arrete JAMAIS la colonie.
 * ==========================================================================*/
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b || JSON.stringify(a) === JSON.stringify(b), m + ' (' + JSON.stringify(a) + ')');

/* Un volume a nous : on n ecrit pas dans celui de la colonie. */
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'perpj-'));
process.env.DATA_DIR = BAC;
process.env.PERP_JOURNAL = '1';
process.env.PERP_JOURNAL_JOURS = '7';
const J = require('./perp_journal');

const mesuresFausses = (o) => Object.assign({
  sym: 'BTCUSDT', prix: 81214.4, ecartEma: 0.42, fond: -1.2, vol15: 0.18, vol4: 0.31,
  couloir: 0.72, var1h: 0.3, var4h: -0.8, var24: 2.1, financement: 0.0001,
  interet: 41230.5, varInteret: 1.4, base: 0.012, carnet: -0.21, volume: 2875000000,
}, o || {});

console.log('-- une ligne par marche et par tour --');
{
  const t = Date.parse('2026-09-19T12:00:00Z');
  const id = J.idObs(t, 'BTCUSDT', 412);
  eq(id, '20260919-412-BTC', 'l identifiant porte le jour, le tour et le marche : lisible a l oeil');
  const l = J.noteObservation({ id, t, x: mesuresFausses(),
    sides: [{ sens: 1, score: 73, refus: null, qui: null },
            { sens: -1, score: 41, refus: 'score below the bar', qui: 'tendance' }],
    prise: 1 });
  ok(!!l, 'la ligne est ecrite');
  eq(l.s, 'BTCUSDT', 'elle porte son marche');
  eq(l.sc, [73, 41], 'les deux sens ont leur note');
  eq(l.rf, [null, 'score below the bar'], 'et leur refus, ou son absence');
  eq(l.pr, 1, 'et ce qui a ete pris');
  /* ---- CE QUI N EXISTE QUE SUR UN PERPETUEL ----
   * Financement, interet ouvert, prime sur l index : c est ce qu on vient
   * chercher, et c est justement ce qu un journal de prix ne garde pas. */
  ok(l.f === 0.0001 && l.oi === 41230.5 && l.ba === 0.012,
     'financement, interet ouvert et prime sur l index sont gardes');
  ok(l.doi === 1.4, 'ainsi que la VARIATION de l interet ouvert, qui n a pas de sens sur une photo seule');
  ok(l.cb === -0.21 && l.vo === 2875000000, 'le carnet et le volume aussi');
}

console.log('\n-- et une ligne par echeance atteinte, reliee a la premiere --');
{
  const t = Date.parse('2026-09-19T16:00:00Z');
  const r = J.noteResultat({ id: '20260919-412-BTC', t, sym: 'BTCUSDT', sens: 1, horizon: 240,
                             rendement: 1.83, brut: 2.06, financement: -0.23, cle: 'pris' });
  ok(!!r, 'le resultat est ecrit');
  eq(r.i, '20260919-412-BTC', 'sous l identifiant de l observation : c est le fil qui relie les deux');
  eq(r.h, 240, 'avec son echeance');
  ok(r.b === 2.06 && r.fc === -0.23,
     'et le mouvement du prix SEPARE du financement — sans ca, on ne saura jamais lequel des deux a coute');
}

console.log('\n-- on relit ce qu on a ecrit --');
{
  const v = J.relit('2026-09-19', '2026-09-19');
  eq(v.obs.length, 1, 'une observation relue');
  eq(v.res.length, 1, 'un resultat relu');
  eq(v.cassees, 0, 'aucune ligne illisible');
  /* Le rapprochement : c est POUR CA que le journal existe. */
  const par = {};
  for (const o of v.obs) par[o.i] = o;
  const joint = v.res.filter((r) => par[r.i]).map((r) => ({ f: par[r.i].f, r: r.r }));
  eq(joint.length, 1, 'et la jointure rend ce qu on veut : la mesure du moment, et ce qu elle a donne');
  ok(joint[0].f === 0.0001 && joint[0].r === 1.83,
     'un financement de 0,01 % a donne +1,83 % a quatre heures — c est la ligne qu on veut par milliers');
}

console.log('\n-- une ligne tronquee ne se lit pas comme une observation --');
{
  /* Un redemarrage au milieu d un `appendFile` laisse une ligne coupee. Elle
     doit etre COMPTEE, jamais devinee. */
  fs.appendFileSync(path.join(J.dossier(), '2026-09-19.ndjson'), '{"k":"o","i":"casse"\n');
  const v = J.relit('2026-09-19', '2026-09-19');
  eq(v.cassees, 1, 'la ligne coupee est comptee');
  eq(v.obs.length, 1, 'et elle n entre pas dans les observations');
}

console.log('\n-- la taille, calculee et non esperee --');
{
  /* Cinq marches, 288 tours par jour : 1 440 lignes. Si une ligne pesait un
     kilo-octet, le journal ferait un demi-giga par an, et on l eteindrait. */
  const t = Date.parse('2026-09-20T00:00:00Z');
  let octets = 0;
  for (let i = 0; i < 100; i++) {
    const l = J.noteObservation({ id: J.idObs(t, 'ETHUSDT', i), t, x: mesuresFausses({ sym: 'ETHUSDT', prix: 3021.55 + i }),
      sides: [{ sens: 1, score: 50 + i % 30, refus: i % 3 ? 'funding too expensive' : null, qui: 'financement' },
              { sens: -1, score: 40, refus: 'score below the bar', qui: 'tendance' }], prise: null });
    octets += JSON.stringify(l).length + 1;
  }
  const parLigne = Math.round(octets / 100);
  ok(parLigne < 400, 'une ligne pese ' + parLigne + ' octets');
  const parJour = parLigne * 5 * 288;
  ok(parJour < 700000, 'soit ' + Math.round(parJour / 1024) + ' Ko par jour pour cinq marches');
  console.log('       ' + Math.round(parJour * 180 / 1048576) + ' Mo pour les 180 jours gardes par defaut');
}

console.log('\n-- les vieux jours partent, les recents restent --');
{
  const vieux = path.join(J.dossier(), '2020-01-01.ndjson');
  fs.writeFileSync(vieux, '{"k":"o"}\n');
  J.purge(Date.parse('2026-09-21T00:00:00Z'));
  ok(!fs.existsSync(vieux), 'un fichier plus vieux que la retention est efface');
  ok(fs.existsSync(path.join(J.dossier(), '2026-09-20.ndjson')), 'et les recents restent');
  const e = J.etat();
  ok(e.jours >= 2 && e.octets > 0, 'l etat dit ce que le journal porte : ' + e.jours + ' jours, ' + e.octets + ' octets');
  eq(e.garde, 7, 'et combien de jours il garde');
}

console.log('\n-- un journal qui tombe n arrete PAS la colonie --');
{
  /* Il observe, il ne commande pas. Un disque plein ne doit pas empecher une
     position de se fermer. */
  const j2 = path.join(__dirname, 'perp_journal.js');
  const src = fs.readFileSync(j2, 'utf8');
  ok(/catch[\s\S]{0,120}console\.error/.test(src), 'chaque ecriture est sous garde');
  const avant = process.env.DATA_DIR;
  /* Un FICHIER pris pour un dossier : `mkdir` echoue franchement (ENOTDIR).
     `/proc/...` semblait plus parlant et faisait carrement BLOQUER `mkdir`
     sur ce noyau — un essai qui ne rend jamais la main n est pas un essai. */
  process.env.DATA_DIR = '/dev/null/pas-un-dossier';
  let boum = null;
  try { J.noteObservation({ id: 'x', t: Date.now(), x: mesuresFausses(), sides: [] }); }
  catch (e) { boum = e; }
  process.env.DATA_DIR = avant;
  ok(!boum, 'un chemin impossible ne leve pas : la colonie continue');
}

console.log('\n-- et il ne DECIDE rien --');
{
  const moteur = fs.readFileSync(path.join(__dirname, 'ai_perp.js'), 'utf8');
  /* Meme frontiere que `OBS_VIEUX_PAR_TOUR` : on rend mesurable avant de
     faire acheter. Le journal est appele pour ECRIRE, jamais pour lire une
     decision. */
  const appels = moteur.match(/journal\.\w+/g) || [];
  ok(appels.length > 0, 'le moteur ecrit dans le journal : ' + [...new Set(appels)].join(', '));
  /* ---- CE QUE CET ESSAI VEUT VRAIMENT DIRE ----
   * Il interdisait toute lecture. Son intention n a jamais ete « aucune
   * lecture » mais « le moteur ne demande pas au journal quoi faire » — et
   * `etat()` ne rend que la taille et les dates des fichiers, de quoi ecrire
   * une ligne sur la page. Ce qui compte est plus precis, et desormais
   * verifie : le CONTENU du journal (`relit`) n est jamais lu, et `etat()`
   * n est appele QUE depuis la vue, jamais depuis un tour ou une note. */
  ok(!/journal\.relit/.test(moteur), 'le contenu du journal n est jamais relu par le moteur');
  const hors = appels.filter((a) => !/note|idObs|etat/.test(a));
  ok(hors.length === 0, 'aucun autre appel que les ecritures, l identifiant et l etat : ' + hors.join(', '));
  /* `etat()` est-il confine a la vue ? On decoupe la fonction et on regarde. */
  const d0 = moteur.indexOf('function vue()');
  const d1 = moteur.indexOf('// ------', d0);
  const dansLaVue = moteur.slice(d0, d1);
  const total = (moteur.match(/journal\.etat\(/g) || []).length;
  const dedans = (dansLaVue.match(/journal\.etat\(/g) || []).length;
  ok(total > 0 && total === dedans,
     'l etat du journal n est lu que par la vue (' + dedans + '/' + total + '), jamais par une decision');
}

try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* un bac temporaire */ }
console.log(rates ? `\nperp_journal.test.js : RATES : ${rates}/${n}` : `\nperp_journal.test.js : ${n} verifications OK`);
process.exit(rates ? 1 : 0);
