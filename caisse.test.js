'use strict';
/*
 * LA CAISSE AUTOMATIQUE (caisse.js) — décisions du propriétaire, 26 septembre
 * 2026 : 5 % de chaque paiement rachètent du $SWOGE, gardé (envoyé à la
 * trésorerie avec le reste), la caisse étant le portefeuille de gaz.
 *   1. le partage : exactement 5 % / 95 %, et un paiement n'est JAMAIS partagé
 *      deux fois (versement sous le seuil, redémarrage) ;
 *   2. le rachat : dès le seuil, en une transaction, minimum de sortie = devis
 *      − 3 %, jamais zéro ; raté → la part reste pour le tour suivant ;
 *   3. les versements : TOUT le $SWOGE et l'USDG dû, seulement à la trésorerie ;
 *   4. un solde plus bas que les parts tenues : recalé et COMPTÉ ;
 *   5. l'ETH n'est jamais touché (c'est le gaz).
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const fs = require('fs'), os = require('os'), path = require('path');
const { ethers } = require('ethers');
const B = ethers.BigNumber;
const K = require('./caisse');
delete process.env.X402_RACHAT_PART; delete process.env.X402_RACHAT_MIN_USD; delete process.env.X402_VERSEMENT_MIN_USD;

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', SWOGE = '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const CAISSE = '0x' + '11'.repeat(20), TRESOR = '0x' + '22'.repeat(20), ROUTEUR = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';
const u = (d) => B.from(Math.round(d * 1e6));

/* Une fausse chaîne : les soldes de la caisse, et tout ce qu'on lui demande. */
function chaine() {
  const c = { soldes: { [USDG]: B.from(0), [SWOGE]: B.from(0), eth: ethers.utils.parseEther('0.003') }, allow: B.from(0), envois: [], echanges: [], approbations: 0,
    echangeEchoue: false, taux: B.from('39741171417200970242219') /* $SWOGE pour 1 USDG, relevé du 26 septembre */ };
  c.api = { caisse: CAISSE, routeur: ROUTEUR,
    solde: async (j) => c.soldes[j],
    allowance: async () => c.allow,
    approuve: async (j, s) => { c.approbations++; c.allow = ethers.constants.MaxUint256; return { ok: s === ROUTEUR, hash: '0xa' }; },
    devis: async (m, chemin) => { c.chemin = chemin; return B.from(m).mul(c.taux).div(1e6); },
    echange: async (m, mini, chemin, vers, ech) => {
      c.echanges.push({ m, mini, chemin, vers, ech });
      if (c.echangeEchoue) return { ok: false, hash: '0xbad' };
      c.soldes[USDG] = c.soldes[USDG].sub(m); c.soldes[SWOGE] = c.soldes[SWOGE].add(B.from(m).mul(c.taux).div(1e6));
      return { ok: true, hash: '0xswap' + c.echanges.length };
    },
    envoie: async (j, vers, m) => { c.envois.push({ j, vers, m: B.from(m) }); c.soldes[j] = c.soldes[j].sub(m); return { ok: true, hash: '0xtx' + c.envois.length }; },
  };
  return c;
}
const monde = (fichier, c) => K.cree({ chaine: c.api, tresor: TRESOR, usdg: USDG, swoge: SWOGE, weth: WETH, fichier, journal: () => {} });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caisse-'));

  console.log('-- 1. le partage : 5 % / 95 %, jamais deux fois --');
  {
    const f = path.join(dir, 'a.json'), c = chaine(), k = monde(f, c);
    eq(K.PART(), 0.05, 'la part par defaut : 5 % (choix du proprietaire)');
    c.soldes[USDG] = u(0.6);                                  /* des paiements sous les seuils */
    let r = await k.tour();
    ok(r.partage && Math.abs(r.partage.rachatUsd - 0.03) < 1e-9 && Math.abs(r.partage.versementUsd - 0.57) < 1e-9, '0,60 $ arrives : 0,03 $ pour le rachat, 0,57 $ pour la tresorerie');
    ok(!c.echanges.length && !c.envois.length, 'sous les seuils (1 $) : rien ne part — pas de gaz pour quelques centimes');
    r = await k.tour();
    ok(!r.partage && k.vue().enAttente.versementUsd === 0.57, 'un second tour sans nouveau paiement ne partage RIEN de plus');
    const k2 = monde(f, c);
    await k2.tour();
    ok(k2.vue().enAttente.rachatUsd === 0.03 && k2.vue().enAttente.versementUsd === 0.57, 'apres un REDEMARRAGE, les parts sont relues sur disque : rien n est partage deux fois');
    c.soldes[USDG] = c.soldes[USDG].add(u(20));               /* 20 $ de plus */
    r = await k2.tour();
    ok(Math.abs(r.partage.nouveauUsd - 20) < 1e-9 && Math.abs(r.partage.rachatUsd - 1) < 1e-9, 'seul le NOUVEL argent (20 $) est partage : 1 $ de rachat');
  }

  console.log('\n-- 2. le rachat, puis les versements --');
  {
    const f = path.join(dir, 'b.json'), c = chaine(), k = monde(f, c);
    c.soldes[USDG] = u(40);                                   /* 40 $ de paiements USDG */
    c.soldes[SWOGE] = ethers.utils.parseEther('50000');       /* et des paiements en $SWOGE */
    const r = await k.tour();
    const e = c.echanges[0];
    ok(e && e.m.eq(u(2)), 'rachat : 5 % de 40 $ = 2 USDG echanges');
    eq(e.chemin.join(','), [USDG, WETH, SWOGE].join(','), 'en UNE transaction : USDG -> WETH -> $SWOGE (routeur v2)');
    ok(e.vers === CAISSE, 'le $SWOGE rachete arrive d abord a la caisse');
    const devis = u(2).mul(c.taux).div(1e6);
    ok(e.mini.eq(devis.mul(9700).div(10000)) && e.mini.gt(0), 'minimum de sortie = devis − 3 %, jamais zero (pas de sandwich gratuit)');
    ok(c.approbations === 1, 'l autorisation USDG -> routeur, une fois');
    const vs = c.envois.find((x) => x.j === SWOGE), vu = c.envois.find((x) => x.j === USDG);
    ok(vs && vs.vers === TRESOR && vs.m.eq(ethers.utils.parseEther('50000').add(devis)), 'TOUT le $SWOGE (paye + rachete) part a la tresorerie : ' + ethers.utils.formatEther(vs.m));
    ok(vu && vu.vers === TRESOR && vu.m.eq(u(38)), 'et 95 % de l USDG (38 $) aussi');
    ok(c.envois.every((x) => x.vers === TRESOR), 'AUCUN envoi ailleurs qu a la tresorerie');
    ok(c.soldes[USDG].eq(0) && c.soldes[SWOGE].eq(0) && c.soldes.eth.eq(ethers.utils.parseEther('0.003')), 'la caisse est vide apres le tour ; l ETH (le gaz) n est jamais touche');
    const v = k.vue();
    ok(v.rachats === 1 && v.usdgRacheteUsd === 2 && v.usdgVerseUsd === 38 && Number(v.swogeRachete) > 0 && v.enAttente.rachatUsd === 0, 'l etat public : 1 rachat (2 $ -> ' + Math.round(Number(v.swogeRachete)) + ' $SWOGE), 38 $ verses');
    ok(r.ok && r.rachat.hash && r.versementUsdg.hash && r.versementSwoge.hash, 'chaque geste a sa transaction');
  }

  console.log('\n-- 3. un echange rate garde la part --');
  {
    const f = path.join(dir, 'c.json'), c = chaine(), k = monde(f, c);
    c.soldes[USDG] = u(40); c.echangeEchoue = true;
    const r = await k.tour();
    ok(!r.ok && /buyback/.test(r.erreurs[0]) && k.vue().enAttente.rachatUsd === 2, 'l echange echoue : la part de rachat (2 $) reste pour le tour suivant');
    ok(c.envois.some((x) => x.j === USDG && x.m.eq(u(38))) && !c.envois.some((x) => x.j === USDG && x.m.gt(u(38))), 'la tresorerie recoit quand meme ses 38 $, pas la part du rachat');
    c.echangeEchoue = false;
    const r2 = await k.tour();
    ok(r2.rachat && k.vue().enAttente.rachatUsd === 0 && !r2.partage, 'au tour suivant, la part est rachetee — sans etre repartagee');
  }

  console.log('\n-- 4. un solde plus bas que les parts tenues --');
  {
    const f = path.join(dir, 'd.json'), c = chaine(), k = monde(f, c);
    c.soldes[USDG] = u(0.8); await k.tour();                  /* 0,04 + 0,76 tenus */
    c.soldes[USDG] = u(0.5);                                  /* quelqu un (ou quelque chose) a pris 0,30 $ */
    await k.tour();
    const v = k.vue();
    ok(v.anomalies === 1 && Math.abs(v.enAttente.rachatUsd + v.enAttente.versementUsd - 0.5) < 1e-9, 'recale sur la chaine (0,50 $), et COMPTE comme anomalie (' + v.anomalies + ')');
  }

  console.log('\n-- 5. reglages --');
  {
    process.env.X402_RACHAT_PART = '0.9';
    eq(K.PART(), 0.5, 'une part au-dela de 50 % est bornee a 50 %');
    process.env.X402_RACHAT_PART = '0.02';
    eq(K.PART(), 0.02, 'X402_RACHAT_PART change la part sans toucher au code');
    delete process.env.X402_RACHAT_PART;
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
