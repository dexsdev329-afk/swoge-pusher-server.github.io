#!/usr/bin/env node
/* Le releve de la colonie en direct, en une commande : bornes, planchers,
 * positions, carnet par tranche, lignes reelles recentes, audit a la marge des
 * bornes, alertes, journal. Chaque appel garde un instantane dans _releves/
 * (hors depot), pour comparer deux moments sans refaire les calculs a la main.
 *   node releve.js                 les dernieres 24 h
 *   node releve.js --depuis 6h     les dernieres 6 h (ou 3j, 7d)
 *   node releve.js --url https://…/ai/colonie */
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const URL = opt('url', process.env.COLONIE_URL || 'https://web-production-220a3.up.railway.app/ai/colonie');
/* 03/10 : « --depuis 7d » retombait EN SILENCE sur 24 h (seuls h et j etaient lus) — le releve
   annoncait 6 trades « en 7 jours » quand il y en avait 26. j et d valent un jour ; une unite
   inconnue arrete tout, jamais une fenetre devinee. */
const dep = String(opt('depuis', '24h')); const m = dep.match(/^(\d+)([hjd])$/);
if (!m) { console.error('--depuis ' + dep + ' : unite inconnue (ecrire 6h, 3j ou 7d)'); process.exit(2); }
const DEPUIS_MS = Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3);
const h = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
const n1 = (x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x);
const bil = (b) => b ? `n=${b.n} moy=${n1(b.moyenne)}% gagnants=${b.partGagnantes}% gain=${n1(b.gain)}` : '—';
(async () => {
  const d = await (await fetch(URL)).json();
  const now = Date.now(), t0 = now - DEPUIS_MS;
  fs.mkdirSync(path.join(__dirname, '_releves'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '_releves', new Date().toISOString().replace(/[:.]/g, '-') + '.json'), JSON.stringify(d));
  console.log(`RELEVE ${h(now)} UTC · tours ${d.tours} · trades ${d.trades} · tresor papier $${n1(d.tresor)} · depuis ${dep}`);
  console.log('bornes    ', (d.bornes || []).map((b) => `${b.cle}=${b.valeur}`).join(' · '));
  const P = d.planchers || {};
  console.log('planchers ', `piscine ${Math.round(P.liq)} · cap ${P.mc}-${P.mcMax} · age ${P.ageMin} min · pompe ${P.pumpM5}%`);
  console.log('positions ', (d.positions || []).map((p) => `${p.sym} ${n1(p.r)}% cap ${p.mcAchat} AR ${p.allerRetour ?? '?'}%`).join(' · ') || 'aucune');
  const ref = (d.audit || []).find((a) => a.cle === 'achete ou retenu');
  console.log('reference ', ref ? `n=${ref.n} montes=${ref.partMontes}% moy=${ref.moyenne} strat=${ref.strat}` : '—');
  /* l audit a la marge de chaque borne */
  const A = Object.fromEntries((d.audit || []).map((a) => [a.cle, a]));
  const marge = (motif) => Object.values(A).filter((a) => motif.test(a.cle)).sort((x, y) => y.n - x.n).slice(0, 4)
    .map((a) => `${a.cle.replace(/^scout · /, '')} n=${a.n} ${a.partMontes}%`).join(' | ');
  console.log('audit age ', marge(/too young/));
  console.log('audit cap ', marge(/buy ceiling|cap below/));
  console.log('audit pisc', marge(/pool below|nothing to sell/));
  console.log('portes    ', marge(/too volatile|too few public|round trip too costly/) || '(rien encore)');
  /* Le rachat a 1,5 fois et plus de l entree la plus basse (18/10, n=14 au carnet) : sa ligne contre la reference. */
  const RT = d.rentree;
  if (RT) console.log('rachat    ', `max x${RT.max} · memoire ${RT.gardeJours} j, ${RT.jetons} jetons · refus ${RT.refus}/${RT.vus} (autre piscine ${RT.autrePiscine})`
    + ` · ligne n=${RT.ligne.n} montes=${RT.ligne.partMontes ?? '—'}% moy=${RT.ligne.moyenne ?? '—'} strat=${RT.ligne.strat ?? '—'}`
    + ` · reference ${RT.reference.partMontes ?? '—'}% · verdict ${RT.verdict} (sous ${RT.min} ombres, aucun)`);
  /* Les moins de 4 min selon DexScreener (mesure seule, 28/09) et les portefeuilles juges. */
  const SA = d.sondeAge;
  if (SA) console.log('jeunes<4  ', SA.lignes.map((l) => `${l.nom} n=${l.n} ${l.partMontes ?? '—'}%`).join(' | ') + ` · ligne entiere n=${SA.ligneEntiere.n} ${SA.ligneEntiere.partMontes ?? '—'}%`);
  /* Le signal du brief (15/10) : sa ligne a l echeance de reference, contre la reference ; la porte de « achat » ;
     le plan de sortie du brief rejoue en ombre, apparie a la sortie en vigueur. */
  const SG = d.smartSignal;
  if (SG) {
    for (const l of SG.lignes || []) {
      const pb = l.planBrief;
      /* les lignes du brief v2 (15/10 : lancements Pons, dev connu, IGNITION, copie, rebond) se lisent a leur cle */
      console.log(l.source ? String(l.cle).padEnd(22) : `smart ${l.verdict === 'ACHETER' ? 'buy  ' : 'watch'}`, `n=${l.n || 0}/${SG.min} montes=${l.partMontes ?? '—'}% moy=${l.moyenne ?? '—'} strat=${l.strat ?? '—'} (7j n=${l.n7 ?? 0} ${l.partMontes7 ?? '—'}%)`
        + ` · horizons ${(l.horizons || []).map((h) => `${h.h}m:${h.n ? h.partMontes + '%/' + h.n : '—'}`).join(' ')}`
        + ` · plan brief ${pb ? `n=${pb.n} moy=${pb.moyenne}% gagnants=${pb.partGagnantes}% ecart/vigueur=${pb.ecartMoyen ?? '—'} (${pb.apparies})` : '—'}`);
    }
    console.log('smart     ', `mode ${SG.mode} · porte ${SG.porte && SG.porte.ouverte ? 'OUVERTE' : 'fermee : ' + ((SG.porte && SG.porte.raisons) || []).join(' ; ')} · en attente ${SG.enAttente} · ombres ${SG.ombres}`);
  }
  /* La lecture de chaine des positions (17/10) : l ecart et le retard de DexScreener, et par regle ce
     qu une sortie sur la chaine aurait change. Observation seule, verdict refuse sous 100. */
  const PC = d.prixChaine;
  if (PC) console.log('chaine    ', `mode ${PC.mode} · ecart med ${PC.ecart.medianePct ?? '—'}% p90 ${PC.ecart.p90Pct ?? '—'}% (n=${PC.ecart.n})`
    + ` · retard ${PC.retard.minMedianS ?? '—'}-${PC.retard.maxMedianS ?? '—'} s (n=${PC.retard.n}, a jour ${PC.retard.aJour})`
    + ` · ${(PC.audit || []).map((a) => `${a.regle} n=${a.n}/${PC.assez} avance=${a.avanceMediane ?? '—'}s pts=${a.ptsMoyen ?? '—'}`).join(' | ') || 'aucune sortie appariee'}`);
  /* Le carnet des lancements (21/10, lancements_carnet.js) : fiches, suivis, vivants a 24 h et 7 j par theme. */
  try {
    const L = await (await fetch(URL.replace(/\/ai\/colonie.*$/, '/ai/smart/lancements'))).json();
    if (L && L.actif) {
      const v = L.vue, b = L.bilan, p = (x) => (x && x.assez ? x.vivantsPct + '%' : '—');
      console.log('lancem.   ', `${v.fiches} fiches · metas en file ${v.fileMeta} · suivis ${v.compteurs.suivis} · manques ${v.compteurs.manques} · vivants 24h ${p(b.tout['24h'])} (n=${b.tout['24h'].mesures}) 7j ${p(b.tout['7j'])} (n=${b.tout['7j'].mesures})`);
      console.log('  themes  ', Object.entries(b.parTheme).map(([k, x]) => `${k} n=${x.n} 24h ${p(x['24h'])}`).join(' | '));
    } else console.log('lancem.    carnet inactif');
  } catch (e) { console.log('lancem.    illisible : ' + String(e.message || e).slice(0, 60)); }
  const PFv = d.portefeuilles;
  if (PFv) console.log('portef.   ', `${PFv.wallets} portefeuilles, ${PFv.measured} mesures (10 jetons et plus), ${PFv.waiting} jetons en attente · reference ${PFv.reference.pairs} couples, ${PFv.reference.risePct ?? '—'}% de montees`);
  const c = d.carnet || {};
  console.log(`\nCARNET ${bil(c.tout)}`);
  for (const k of ['parTenue', 'parLiq', 'parMc', 'parAllerRetour', 'parSortie'])
    if (c[k] && c[k].length) console.log('  ' + k.padEnd(14), c[k].map((x) => `[${x.de ?? x.par}${x.a !== undefined ? '-' + (x.a ?? '∞') : ''}] ${bil(x)}`).join('\n' + ' '.repeat(17)));
  const L = (c.lignes || []).filter((x) => x.t > t0 && typeof x.r === 'number');
  if (L.length) {
    const g = L.filter((x) => x.r > 0).length, coupes = L.filter((x) => x.par === 'sentinelle' && /down/.test(x.raison || '')).length;
    console.log(`  depuis ${dep}: n=${L.length} moy=${n1(L.reduce((s, x) => s + x.r, 0) / L.length)}% gagnants=${Math.round(100 * g / L.length)}% coupes=${coupes} gain=${n1(L.reduce((s, x) => s + (x.gain || 0), 0))}`);
  }
  const R = d.reel || {}; const RL = (R.lignes || []).filter((x) => x.t > t0);
  console.log(`\nREEL vie n=${R.n} moy=${R.moyenne}% ecart papier→reel=${R.ecart} · ${bil((R.bilan || {}).tout)}`);
  if (RL.length) {
    console.log(`  depuis ${dep}: n=${RL.length} moy=${n1(RL.reduce((s, x) => s + x.r, 0) / RL.length)}% gagnants=${RL.filter((x) => x.r > 0).length}/${RL.length} ETH net=${n1(1e5 * RL.reduce((s, x) => s + ((+x.rendu || 0) - (+x.cout || 0)), 0)) / 1e5}`);
    for (const l of RL.slice().sort((a, b) => a.t - b.t)) console.log(`    ${h(l.t)} ${String(l.sym).padEnd(10)} ${String(l.r).padStart(7)}%  papier ${l.papier === null ? '?' : n1(l.papier)}  AR ${l.allerRetour ?? '?'}  tenue ${l.tenue} min`);
  }
  const EA = ((R.bilan || {}).ecartParAllerRetour || []);
  if (EA.length) console.log('  ecart/AR ', EA.map((x) => `[${x.de}-${x.a ?? '∞'}] n=${x.n} papier=${x.papier} reel=${x.reel} ecart=${x.ecart}${x.assez ? '' : ' (trop peu)'}`).join(' | ') + ` · sans AR ${(R.bilan || {}).sansAllerRetour ?? '?'}`);
  console.log('\nverdicts  ', (d.verdicts || []).map((v) => `${v.sortie}: n=${v.n} tropTot=${v.partTropTot}% pris=${v.prisMoyen} tenu=${v.tenuMoyen}`).join(' | '));
  console.log('paliers   ', (d.verdictsPaliers || []).map((v) => `+${v.palier}%: n=${v.n} (oubliees ${v.oubliees}) garder=${v.deltaTranche ?? '—'} pts tranche / ${v.deltaPosition ?? '—'} pts position, mieux tenu ${v.partMieuxTenir ?? '—'}%${v.assez ? '' : ' (trop peu)'}`).join(' | ') || 'rien encore');
  console.log('alertes   ', (d.alertes || []).map((a) => `[${a.gravite}] ${a.quoi}`).join(' | ') || 'aucune');
  console.log('journal');
  for (const j of (d.journalStructure || []).filter((j) => j.t > t0).slice(0, 12)) console.log(`  ${h(j.t)} ${j.quoi.padEnd(10)} ${(j.txt || '').slice(0, 110)}`);
})().catch((e) => { console.error('RATE : ' + e.message); process.exit(1); });
