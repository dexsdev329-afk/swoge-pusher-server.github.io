'use strict';
/* Qui demande un prix ? (29/09/2026) — lecture seule des compteurs publics.
 *   node outils/qui_demande.js [jours=1] [serveur]
 * Pour chaque jour : les demandes de paiement (402) par sorte (sonde = sans
 * arguments, demande = avec) et par famille de client (famille_client.js), les
 * refus sans cle, et ce qui a ete paye. Les jours d'avant le 29/09 n'ont pas de
 * famille : « (non mesure) ». */
const jours = Math.max(1, Math.min(30, Number(process.argv[2]) || 1));
const base = (process.argv[3] || 'https://web-production-220a3.up.railway.app').replace(/\/$/, '');
(async () => {
  const d = await (await fetch(base + '/agentic/x402', { signal: AbortSignal.timeout(30000) })).json();
  const J = d.jours;
  for (const r of J.parJour.slice(0, jours)) {
    const e = r.evenements, ext = (k) => (e[k] && e[k].exterieur ? e[k].exterieur.n : 0);
    console.log('\n== ' + r.jour + ' : ' + ext('demande402') + ' demandes de prix exterieures, ' + ext('paye_x402') + ' payees, ' + ext('echec') + ' echecs, '
      + ((e.demande402 && e.demande402.distincts) || 0) + ' demandeurs distincts');
    for (const k of ['demande402', 'refus_sans_cle']) {
      const so = (e[k] && e[k].sortes) || {};
      const l = Object.entries(so).sort((a, b) => b[1].n - a[1].n);
      if (!l.length) { if (e[k]) console.log('  ' + k + ' : (non mesure)'); continue; }
      const tot = l.reduce((a, [, v]) => a + v.n, 0);
      console.log('  ' + k + ' (' + tot + ') :');
      for (const [s, v] of l.slice(0, 15)) console.log('    ' + String(Math.round(v.n / tot * 1000) / 10).padStart(5) + ' %  ' + String(v.n).padStart(6) + '  ' + s);
    }
  }
})().catch((e) => { console.error('lecture impossible : ' + (e && e.message || e)); process.exit(1); });
