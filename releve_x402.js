#!/usr/bin/env node
/* Le releve x402 en une commande (28 septembre 2026) : l'experience de prix (les
 * outils baisses contre les temoins, avant et apres), puis l'etat des chantiers
 * mesures (embauche, achats, lancements Base, Bazaar). Ne refait aucun calcul a
 * la main : lit /agentic/x402 et le juge. Garde un instantane dans _releves/.
 *   node releve_x402.js
 *   node releve_x402.js --url https://…/agentic/x402
 * Regle du depot : sous `demandesAssez` demandes exterieures dans un groupe, on
 * n'en tire rien (un taux sur une poignee de demandes est de la chance). */
const fs = require('fs'), path = require('path');
const { EXPERIENCE_PRIX: X } = require('./agentic');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const URL = opt('url', process.env.X402_URL || 'https://web-production-220a3.up.railway.app/agentic/x402');

function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.round((c - m) / d * 10000) / 100, Math.round((c + m) / d * 10000) / 100];
}
/** Les demandes de prix et les paiements EXTERIEURS d'un groupe, sur des jours donnes. */
function groupe(parJour, outils, garde) {
  let dem = 0, pay = 0, usd = 0;
  const detail = {};
  for (const j of parJour) {
    if (!garde(j.jour)) continue;
    for (const o of outils) {
      const e = (j.outils || {})[o] || {};
      const d = ((e.demande402 || {}).exterieur || {}).n || 0, p = ((e.paye_x402 || {}).exterieur || {}).n || 0;
      dem += d; pay += p; usd += ((e.paye_x402 || {}).exterieur || {}).usd || 0;
      const t = detail[o] || (detail[o] = { dem: 0, pay: 0 }); t.dem += d; t.pay += p;
    }
  }
  return { dem, pay, usd: Math.round(usd * 1e6) / 1e6, taux: dem ? Math.round(pay / dem * 10000) / 100 : null, ic: wilson(pay, dem), detail };
}
/** Le verdict, jamais au-dela de ce que les nombres portent. */
function juge(r) {
  const [bA, tA] = [r.baisses.apres, r.temoins.apres];
  if (bA.dem < X.demandesAssez || tA.dem < X.demandesAssez) return 'pas assez de demandes apres la baisse (baisses ' + bA.dem + ', temoins ' + tA.dem + ' sur ' + X.demandesAssez + ' chacun) : rien a conclure';
  if (!bA.ic || !tA.ic) return 'intervalles indisponibles';
  if (bA.ic[0] > tA.ic[1]) return 'les outils baisses convertissent MIEUX que les temoins (intervalles disjoints)';
  if (bA.ic[1] < tA.ic[0]) return 'les outils baisses convertissent MOINS bien que les temoins (intervalles disjoints)';
  return 'aucune difference mesurable entre baisses et temoins (intervalles qui se recouvrent) : le prix n etait pas le frein';
}
function analyse(d) {
  const J = ((d.jours || {}).parJour) || [];
  const avant = (j) => j < X.jour, apres = (j) => j > X.jour;
  const r = { baisses: { avant: groupe(J, X.baisses, avant), apres: groupe(J, X.baisses, apres) },
    temoins: { avant: groupe(J, X.temoins, avant), apres: groupe(J, X.temoins, apres) } };
  r.verdict = juge(r);
  return r;
}

module.exports = { analyse, groupe, wilson, juge };

if (require.main === module) (async () => {
  const d = await (await fetch(URL)).json();
  fs.mkdirSync(path.join(__dirname, '_releves'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '_releves', 'x402-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'), JSON.stringify(d));
  const r = analyse(d);
  const f = (g) => `demandes ${g.dem} · payes ${g.pay} · taux ${g.taux ?? '—'}% ${g.ic ? '[' + g.ic.join(' ; ') + ']' : ''} · ${g.usd} $`;
  console.log(`EXPERIENCE ${X.nom} (le ${X.jour}, mixte, n'entre nulle part)`);
  for (const k of ['baisses', 'temoins']) {
    console.log(`  ${k.padEnd(8)} avant  ${f(r[k].avant)}`);
    console.log(`  ${''.padEnd(8)} apres  ${f(r[k].apres)}`);
  }
  console.log('  verdict  ' + r.verdict);
  const det = Object.entries(Object.assign({}, r.baisses.apres.detail, r.temoins.apres.detail)).sort((a, b) => b[1].dem - a[1].dem)
    .map(([o, t]) => `${o} ${t.pay}/${t.dem}`).join(' · ');
  console.log('  par outil (apres, payes/demandes) ' + (det || '—'));
  const e = d.embauche || {}, a = d.achats || {}, b = d.baseLancements || {}, z = (d.base || {}).bazaar || {};
  console.log(`\nEMBAUCHE  ${JSON.stringify(e.mesure || {})} · aujourd'hui ${e.aujourdhuiUsd ?? '—'} $`);
  console.log(`ACHATS    ${JSON.stringify(a.mesure || {})} · aujourd'hui ${a.aujourdhuiUsd ?? '—'} $`);
  const ref = b.reference || {};
  console.log(`BASE      ${b.lancements ?? '—'} lancements · juges ${ref.judged ?? '—'} · echanges en 24 h ${ref.tradedWithin24hPct ?? '—'}% ${ref.ci95 ? '[' + ref.ci95.join(' ; ') + ']' : ''} · erreurs noeud ${(b.mesure || {}).erreurs ?? '—'}`);
  console.log(`BAZAAR    success ${z.success ?? '—'} · processing ${z.processing ?? '—'} · rejected ${z.rejected ?? '—'} · depuis ${z.depuis || 'le dernier demarrage'}${z.dernierRejet ? ' · dernier refus : ' + z.dernierRejet : ''}`);
})().catch((e) => { console.error('RATE : ' + e.message); process.exit(1); });
