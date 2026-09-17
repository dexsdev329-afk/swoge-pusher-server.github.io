#!/usr/bin/env node
/* Le releve de la colonie en direct, en une commande : bornes, planchers,
 * positions, carnet par tranche, lignes reelles recentes, audit a la marge des
 * bornes, alertes, journal. Chaque appel garde un instantane dans _releves/
 * (hors depot), pour comparer deux moments sans refaire les calculs a la main.
 *   node releve.js                 les dernieres 24 h
 *   node releve.js --depuis 6h     les dernieres 6 h (ou 3j)
 *   node releve.js --url https://…/ai/colonie */
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const URL = opt('url', process.env.COLONIE_URL || 'https://web-production-220a3.up.railway.app/ai/colonie');
const dep = String(opt('depuis', '24h')); const m = dep.match(/^(\d+)([hj])$/);
const DEPUIS_MS = m ? Number(m[1]) * (m[2] === 'j' ? 86400e3 : 3600e3) : 24 * 3600e3;
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
  console.log('\nverdicts  ', (d.verdicts || []).map((v) => `${v.sortie}: n=${v.n} tropTot=${v.partTropTot}% pris=${v.prisMoyen} tenu=${v.tenuMoyen}`).join(' | '));
  console.log('alertes   ', (d.alertes || []).map((a) => `[${a.gravite}] ${a.quoi}`).join(' | ') || 'aucune');
  console.log('journal');
  for (const j of (d.journalStructure || []).filter((j) => j.t > t0).slice(0, 12)) console.log(`  ${h(j.t)} ${j.quoi.padEnd(10)} ${(j.txt || '').slice(0, 110)}`);
})().catch((e) => { console.error('RATE : ' + e.message); process.exit(1); });
