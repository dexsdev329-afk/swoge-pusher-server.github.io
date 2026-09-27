'use strict';
/* ============================================================================
 * L'IMAGE KLING POSTEE SUR TELEGRAM A HEURE FIXE (kling_telegram.js)
 *
 * Ce qu'elle DOIT tenir : rien avant l'heure ; a l'heure, une image faite sur
 * la reference officielle, postee UNE fois avec sa legende ; un redemarrage ne
 * la rejoue pas ; plus d'une heure de retard : rien ; un echec de Kling ne
 * poste RIEN sur le canal public, il est journalise ; sans cle, on attend.
 * ==========================================================================*/
const fs = require('fs');
const KT = require('./kling_telegram');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

(async () => {
  const A = Date.parse('2026-09-27T18:00:00Z');
  const prog = [{ cle: 'p1', a: A, prompt: 'SWOGE at poker', legende: 'SWOGE at the poker table', format: '3:4', reference: 'subject' }];
  const fabrique = (o) => {
    const dossier = o.dossier || fs.mkdtempSync('/tmp/kling-tg-');
    const postes = [], journal = [], demandes = [];
    let t = o.t;
    const kt = KT.cree({ dossier, site: 'https://swoleeswoge.dog', programme: prog, maintenant: () => t,
      telegram: { notifyPhoto: (url, leg) => postes.push({ url, leg }) }, journal: (x) => journal.push(x),
      kling: { actif: () => o.actif !== false, image: async (q) => { demandes.push(q); return o.image || { ok: true, id: 'I1', url: 'https://cdn.kling.example/i.png', estimationUsd: 0.028, reference: 'subject', essais: [] }; } } });
    return { kt, dossier, postes, journal, demandes, avance: (ms) => { t += ms; } };
  };

  console.log('-- 1. a l heure, une fois --');
  {
    const f = fabrique({ t: A - 60e3 });
    ok((await f.kt.tour()) === null && f.demandes.length === 0, 'une minute avant : rien');
    f.avance(90e3);
    const r = await f.kt.tour();
    ok(r && r.ok && f.postes.length === 1 && f.postes[0].url === 'https://cdn.kling.example/i.png' && f.postes[0].leg === 'SWOGE at the poker table', 'a l heure : l image part sur Telegram avec sa legende');
    ok(f.demandes[0].image === 'https://swoleeswoge.dog/img/site/swoge_reference.jpg' && f.demandes[0].reference === 'subject', 'faite sur la reference officielle de SWOGE');
    ok(f.journal[0].statut === 'succeed' && f.journal[0].estimationUsd === 0.028, 'et journalisee avec son cout');
    f.avance(60e3); await f.kt.tour();
    ok(f.postes.length === 1, 'le passage suivant ne la reposte pas');
    const g = fabrique({ t: A + 5 * 60e3, dossier: f.dossier });
    await g.kt.tour();
    ok(g.demandes.length === 0 && g.postes.length === 0 && g.kt.etat()[0].fait.etat === 'poste', 'un redemarrage ne la rejoue pas (etat ecrit sur disque)');
  }

  console.log('\n-- 2. ce qui ne part pas --');
  {
    const tard = fabrique({ t: A + KT.RETARD_MAX_MS + 60e3 });
    await tard.kt.tour();
    ok(tard.demandes.length === 0 && tard.postes.length === 0 && tard.kt.etat()[0].fait.etat === 'manque', 'plus d une heure de retard : rien, et c est note « manque »');
    const rate = fabrique({ t: A + 1000, image: { ok: false, raison: 'Kling failed: content risk', essais: [] } });
    const r = await rate.kt.tour();
    ok(r && !r.ok && rate.postes.length === 0 && rate.journal[0].statut === 'failed' && /content risk/.test(rate.journal[0].message), 'Kling echoue : rien sur le canal public, l echec est journalise');
    await rate.kt.tour();
    ok(rate.demandes.length === 1, 'et on ne relance pas en boucle (0,028 $ par essai)');
    const sansCle = fabrique({ t: A + 1000, actif: false });
    await sansCle.kt.tour();
    ok(sansCle.demandes.length === 0 && sansCle.kt.etat()[0].fait === null, 'sans KLING_API_KEY : on attend, l envoi reste du tant qu il est dans l heure');
  }
  ok(KT.PROGRAMME[0].a === Date.parse('2026-09-27T18:00:00Z') && /reference image/.test(KT.PROGRAMME[0].prompt) && /poker/.test(KT.PROGRAMME[0].prompt),
     'le programme reel : 20 h a Paris le 27/09 (18 h UTC), SWOGE au poker, sur la reference');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
