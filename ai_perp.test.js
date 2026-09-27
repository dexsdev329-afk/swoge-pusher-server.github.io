'use strict';
/*
 * LES COLONIES DE PERPETUELS — ce qu on verifie sans toucher a Bitget.
 *
 *  1. La lecture : ce que l API publique rend devient des mesures, et un
 *     champ absent reste null — jamais comble.
 *  2. Les traits : ceux d un perpetuel, pas ceux d un jeton. Un financement,
 *     un regime de volatilite, un couloir de journee.
 *  3. Le FINANCEMENT est un cout, et il est retire du rendement. C est la
 *     lecon payee en argent reel par la colonie de jetons.
 *  4. Les deux sens sont juges separement, chacun avec sa ligne d audit, et
 *     une regle se juge contre ce qu on PREND.
 *  5. Un tour complet contre un faux marche : refus, prise, position, stop.
 *  6. Rien dans ce fichier ne peut signer quoi que ce soit.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'perp-'));
process.env.PERP_SYMBOLES = 'BTCUSDT,ETHUSDT';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };

const P = require('./ai_perp');
const SYM = 'BTCUSDT';

/* Un marche fabrique : `pente` en pourcent par bougie, `bruit` l amplitude. */
function marche(o) {
  const c = Object.assign({ prix: 80000, pente: 0, bruit: 0.05, financement: 0.0001,
                            bid: 10, ask: 10, var24: 0.01, interet: 30000 }, o || {});
  /* ---- DEUX PENTES, ET C EST NECESSAIRE ----
   * Une seule pente pour les deux echelles rend impossible l etat de marche
   * qui a bloque la colonie en production : un FOND marque (bougies de quatre
   * heures) avec une volatilite COURTE calme (bougies de quinze minutes). En
   * forcant la pente courte pour obtenir le fond, on declenche le veto de
   * tempete — qui est un refus de securite, pas de direction, et l essai
   * mesurait alors autre chose que ce qu il croyait. */
  if (c.pente4 === undefined) c.pente4 = c.pente;
  const bougies = (n2, pas, pente) => {
    const l = [];
    for (let i = 0; i < n2; i++) {
      const p = c.prix * (1 + (pente / 100) * (i - n2 + 1));
      const b = p * (1 + ((i % 3) - 1) * c.bruit / 100);
      l.push({ t: Date.now() - (n2 - i) * pas, o: b, h: b * 1.001, b: b * 0.999, c: b, v: 100 });
    }
    l[l.length - 1].c = c.prix;
    return l;
  };
  return { sym: SYM, t: Date.now(), prix: c.prix, marque: c.prix, index: c.prix,
           financement: c.financement, interet: c.interet, bid: c.bid, ask: c.ask,
           haut24: c.prix * 1.02, bas24: c.prix * 0.98, var24: c.var24, volume: 1e9,
           m15: bougies(100, 900000, c.pente), h4: bougies(60, 14400000, c.pente4) };
}
const neuf = () => { P._pose(P.etatNeuf()); return P.etat(); };

(async () => {
  console.log('-- 1. la lecture rend des mesures, et un trou reste un trou --');
  {
    const x = P.mesures(marche({ pente: 0.05 }));
    ok(x.ecartEma !== null && x.fond !== null && x.vol15 !== null && x.couloir !== null,
       'tendance, fond, volatilite et couloir sont calcules');
    ok(x.ecartEma > 0, 'sur un marche qui monte, l ecart de moyennes est positif (' + x.ecartEma.toFixed(3) + '%)');
    const creux = P.mesures(Object.assign(marche({}), { m15: [], h4: [], bid: null, ask: null, financement: null }));
    ok(creux.ecartEma === null && creux.vol15 === null && creux.carnet === null && creux.financement === null,
       'sans bougies ni carnet, tout reste null : rien n est comble');
    ok(P.volatilite([]) === null && P.position([], 10) === null && P.ema([1, 2], 9) === null,
       'et les mesures refusent de repondre sous leur minimum d observations');
  }

  console.log('\n-- 2. des traits de perpetuel, pas de jeton --');
  {
    const noms = Object.keys(P.TRAITS);
    ok(noms.indexOf('fin') >= 0 && noms.indexOf('regime') >= 0 && noms.indexOf('couloir') >= 0,
       'la table porte le financement, le regime et le couloir : ' + noms.join(', '));
    ok(!noms.some((k) => /top|brule|liq|pons|taxe|porteur/.test(k)),
       'et aucun trait de jeton : ni concentration, ni piscine, ni contrat');
    const cle = Object.keys(P.AGENTS.reduce((a, x) => (a[x.key] = 1, a), {}));
    eq(cle.length, 8, 'huit agents (' + cle.join(', ') + ')');
    ok(!cle.some((k) => ['scout', 'warden', 'whale', 'whisper', 'oracle', 'cobaye'].indexOf(k) >= 0),
       'aucun n est repris de la colonie de jetons : ce ne sont pas les memes questions');
    ok(P.AGENTS.filter((a) => a.role === 'garde').length >= 2, 'au moins deux gardes, qui peuvent refuser');
    const x = P.mesures(marche({ financement: 0.002 }));
    const t = P.traitsDe(x);
    ok(JSON.stringify(t).indexOf('longs paient fort') >= 0,
       'un financement tres positif tombe dans « longs paient fort » : la foule est longue');
  }

  console.log('\n-- 3. le financement est un COUT, retire du rendement --');
  {
    /* 0,01 % par periode de 8 h. Un long tenu 8 h paie 0,01 point. */
    eq(P.coutFinancement(1, 0.0001, 480), -0.01, 'un long paie quand le taux est positif');
    eq(P.coutFinancement(-1, 0.0001, 480), 0.01, 'et un short encaisse la meme chose');
    eq(P.coutFinancement(1, 0.0001, 240), -0.005, 'au prorata du temps tenu');
    eq(P.coutFinancement(1, null, 480), 0, 'un taux inconnu ne coute rien : on n invente pas');
    eq(P.PERIODE_FIN_MIN, 480, 'la periode est de huit heures, comme sur la plateforme');

    const S = neuf();
    const x0 = P.mesures(marche({ prix: 80000, financement: 0.001 }));
    x0.sym = SYM;
    P.noteOmbre(x0, 1, null, null, {});
    /* L echeance de reference est a quatre heures, et sa fenetre se ferme a
       324 minutes : une ombre relue plus tard n a pas de jalon, et c est
       voulu — un jalon pris au mauvais moment n est pas un jalon. */
    S.ombres[0].t = Date.now() - 240 * 60000;
    const x1 = P.mesures(marche({ prix: 80800, financement: 0.001 }));   /* +1 % brut */
    x1.sym = SYM;
    P.regleLesOmbres({ [SYM]: x1 });
    const a = S.audit['pris'];
    /* 0,1 % par 8 h, tenu 4 h : la moitie, soit 0,05 point retire du +1 %. */
    ok(a && a.n === 1 && Math.abs(a.s - 0.95) < 0.02,
       'un long a +1 % brut qui a paye un demi-financement est juge a ' + a.s.toFixed(3) + ' %, pas a 1 %');
    const b0 = Math.floor(S.ombres.length ? S.ombres[0].t / P.CRENEAU_AUDIT_MS : (Date.now() - 240 * 60000) / P.CRENEAU_AUDIT_MS);
    ok(a.grp && a.grp.n === a.nz && Object.keys(a.grp.ouverts).map(Number).every((b) => Math.abs(b - b0) <= 1),
       'et elle est rangee dans le creneau de 4 h de son OUVERTURE (groupe de l erreur-type du verdict)');
    const S2 = neuf();
    P.noteOmbre(x0, 1, null, null, {});
    S2.ombres[0].t = Date.now() - 400 * 60000;            /* la fenetre des 4 h est passee */
    P.regleLesOmbres({ [SYM]: x1 });
    ok(!S2.audit['pris'], 'et une ombre relue hors de la fenetre ne remplit rien : un jalon rate reste vide');
  }

  console.log('\n-- 4. les deux sens, chacun sa ligne, jugee contre ce qu on prend --');
  {
    /* ---- REECRIT LE 27 SEPTEMBRE 2026, SUR SON INTENTION ----
     * L intention reste : une regle qui ecarte des perdants protege, une qui
     * ecarte des gagnants coute, et sous le minimum on ne conclut pas. Ce qui
     * change : le minimum vient d un calcul de puissance (12 donnait des
     * verdicts sans valeur — il en faut ~310 par cote au seuil de +8 points,
     * rapport du 26/09), et les rendements se lisent en unites de σ, pour
     * que le melange de marches ne fabrique pas de verdict. L essai nourrit
     * donc chaque ligne au-dela du minimum, en σ. */
    /* Reecrit encore le 27/09 : chaque ombre porte son heure d OUVERTURE (le
       verdict groupe par creneau de 4 h), et les lignes sont nourries dans
       l ordre du temps, comme la boucle — une ombre par creneau et par
       ligne ici, donc independantes : les verdicts d origine tiennent. */
    const S = neuf();
    const N = P.AUDIT_MIN_MOYENNE + 10, L = P.CRENEAU_AUDIT_MS, T0 = 1e6 * L;
    for (let i = 0; i < N; i++) {
      const t = T0 + i * L;
      /* « pris » : 20 % d ombres a +1,5 σ, le reste a -0,3 σ (en %, σ = 1). */
      P.noteAudit('pris', i % 5 === 0 ? 1.5 : -0.3, i % 5 === 0 ? 1.5 : -0.3, t);
      P.noteAudit('Regime · storm', i % 25 === 0 ? 1.5 : -1.2, i % 25 === 0 ? 1.5 : -1.2, t);     /* 4 % */
      P.noteAudit('Trend · long against a deep downtrend', i % 2 ? 1.6 : -0.2, i % 2 ? 1.6 : -0.2, t); /* 50 % */
      /* Une regle qui fait EXACTEMENT comme ce qu on prend : « same ». */
      P.noteAudit('Session · same', i % 5 === 0 ? 1.5 : -0.3, i % 5 === 0 ? 1.5 : -0.3, t);
    }
    const ref = P.reference();
    ok(ref && ref.sigma.n === N && Math.abs(ref.sigma.part - 20) < 0.1,
       'la reference est ce qu on PREND, en σ : ' + ref.sigma.part + ' % a ≥ +1 σ sur ' + ref.sigma.n);
    eq(P.verdictRegle('Regime · storm').verdict, 'protects', 'une regle qui n ecarte que des perdants protege');
    eq(P.verdictRegle('Trend · long against a deep downtrend').verdict, 'costs',
       'une regle qui n ecarte que des gagnants coute — et il faut la relire');
    eq(P.verdictRegle('Session · same').verdict, 'same', 'une regle qui ecarte la meme chose que ce qu on prend : « same »');
    P.noteAudit('jamais vue', 1, 1, T0);
    eq(P.verdictRegle('jamais vue').verdict, 'unknown', 'et sous le minimum, on ne conclut pas');
    eq(P.verdictRegle('jamais vue').manque, P.AUDIT_MIN_OBS - 1, 'en disant combien il manque');
    ok(P.auditDesRefus().every((l) => l.n >= 3), 'le tableau ecarte ce qui a moins de trois observations');
    /* ---- LE MINIMUM EST UN CALCUL, PAS UN ROND ----
     * La formule redonne les chiffres du rapport sur l ancienne base (11 % de
     * ≥ +1,5 %) : ~310 pour « costs », ~650 pour « protects ». */
    ok(Math.abs(P.nDeuxParts(0.11, 0.19) - 310) <= 3 && Math.abs(P.nDeuxParts(0.11, 0.066) - 650) <= 5,
       'le calcul de puissance redonne ~310 et ~650 par cote : ' + P.nDeuxParts(0.11, 0.19) + ', ' + P.nDeuxParts(0.11, 0.066));
    ok(P.AUDIT_MIN_OBS >= 300 && P.AUDIT_MIN_MOYENNE >= 1200,
       'et les minimums en σ sont du meme ordre : ' + P.AUDIT_MIN_COUTE + ' / ' + P.AUDIT_MIN_PROTEGE + ' / ' + P.AUDIT_MIN_MOYENNE);
    ok(P.vue().minObs === P.AUDIT_MIN_OBS, 'la page recoit ce minimum : ' + P.vue().minObs);
    /* Sous le minimum de la PREMIERE regle mais avec une reference pleine :
       ce qui etait « costs » a douze observations ne l est plus. */
    neuf();
    for (let i = 0; i < N; i++) P.noteAudit('pris', i % 5 === 0 ? 1.5 : -0.3, i % 5 === 0 ? 1.5 : -0.3, T0 + i * L);
    for (let i = 0; i < 40; i++) P.noteAudit('Trend · jeune', 2, 2, T0 + (N + i) * L);
    eq(P.verdictRegle('Trend · jeune').verdict, 'unknown', 'quarante ombres toutes gagnantes : toujours « unknown » — 40 n est pas un echantillon');
  }

  console.log('\n-- 4ter. cinq ombres du meme tour ne valent pas cinq observations --');
  {
    /* Un veto refuse BTC, ETH, SOL, XRP et DOGE au meme tour : cinq ombres
       ouvertes dans le meme creneau, a ρ 0,76 a 4 h (rapport du 26/09). Ici
       le cas extreme : les cinq ont le MEME destin. 500 ombres, 28 % de
       montees, contre « pris » a 20 % (+8 points, 500 ombres independantes).
       L erreur-type i.i.d. donnait z ≈ 2,96 : « costs ». Groupee par
       creneau, l effectif est de 100 creneaux, et z ≈ 1,65 : on ne conclut
       pas. Les memes 28 % en 500 creneaux distincts restent « costs » : c est
       bien le groupement qui change le verdict, rien d autre. */
    const L = P.CRENEAU_AUDIT_MS, T0 = 2e6 * L;
    const nourrit = (grappe) => {
      neuf();
      for (let i = 0; i < 500; i++) {
        const t = T0 + i * L;
        P.noteAudit('pris', i % 5 === 0 ? 1.5 : -0.3, i % 5 === 0 ? 1.5 : -0.3, t);
        if (grappe) {
          /* un creneau sur cinq (5j+2, ou « pris » perd toujours : covariance nulle), 5 ombres identiques */
          if (i % 5 === 2) { const j = (i - 2) / 5, v = j < 28 ? 1.5 : -0.3; for (let m = 0; m < 5; m++) P.noteAudit('Veto · grappe', v, v, t); }
        } else {
          const v = i < 140 ? 1.5 : -0.3;
          P.noteAudit('Veto · grappe', v, v, t);
        }
      }
      return P.verdictRegle('Veto · grappe');
    };
    const vg = nourrit(true);
    const zIid = (0.28 - 0.20) / Math.sqrt(0.24 * 0.76 * (2 / 500));
    ok(vg.n === 500 && vg.groupes === 100 && vg.verdict === 'unknown' && vg.zParts < 1.96 && zIid > 1.96,
       'grappes de 5 : ' + vg.verdict + ' a z ' + vg.zParts + ' sur ' + vg.groupes + ' creneaux (i.i.d. aurait dit z ' + zIid.toFixed(2) + ', « costs »)');
    /* L erreur-type a la main : k/(k−1) Σ (G_g − p·n_g)² / n², regle + « pris ». */
    const vRegle = (100 / 99) * (28 * Math.pow(5 - 1.4, 2) + 72 * Math.pow(1.4, 2)) / (500 * 500);
    const vPris = (500 / 499) * (100 * 0.64 + 400 * 0.04) / (500 * 500);
    ok(Math.abs(vg.seParts - Math.round(Math.sqrt(vRegle + vPris) * 1000) / 1000) < 1e-9,
       'l erreur-type groupee est exactement la formule de seGroupe : ' + vg.seParts);
    const vi = nourrit(false);
    ok(vi.verdict === 'costs' && vi.groupes === 500, 'les memes 28 % sur 500 creneaux distincts : « costs » (z ' + vi.zParts + ')');

    /* La covariance avec « pris » est retiree : une regle qui refuse, dans les
       memes creneaux, exactement ce qu on prend a une difference toujours
       nulle, donc une erreur-type nulle — pas √2 fois celle de « pris ». */
    neuf();
    for (let i = 0; i < 600; i++) {
      const t = T0 + i * L, v = i % 5 === 0 ? 1.5 : -0.3;
      P.noteAudit('pris', v, v, t); P.noteAudit('Session · jumelle', v, v, t);
    }
    const eJ = P.ecartGroupe(P.etat().audit['Session · jumelle'], P.etat().audit['pris']);
    ok(eJ && eJ.seParts < 1e-9 && eJ.seMoyennes < 1e-9, 'une regle jumelle de « pris », meme creneaux : erreur-type de l ecart 0 [' + (eJ && eJ.seParts) + ']');

    /* Le repli des creneaux clos ne perd rien : recalcul brut, sans repli. */
    neuf();
    const brut = { a: {}, r: {} };
    let graine = 7; const alea = () => { graine = (graine * 16807) % 2147483647; return graine / 2147483647; };
    for (let i = 0; i < 300; i++) {
      const t = T0 + i * L + Math.floor(alea() * L);
      const b = Math.floor(t / L);
      for (const [cle, k] of [['pris', 'r'], ['Veto · melange', 'a']]) {
        const m = 1 + Math.floor(alea() * 4);
        for (let q = 0; q < m; q++) {
          const z = alea() * 3 - 1.2;
          P.noteAudit(cle, z, z, t);
          const o = brut[k][b] || (brut[k][b] = { n: 0, g: 0, s: 0 });
          o.n++; o.g += z >= 1 ? 1 : 0; o.s += z;
        }
      }
    }
    const tot = (B) => { let n = 0, g = 0, s = 0; for (const b in B) { n += B[b].n; g += B[b].g; s += B[b].s; } return { n, g, s, k: Object.keys(B).length }; };
    const A = tot(brut.a), R = tot(brut.r);
    const pa = A.g / A.n, pr = R.g / R.n;
    let va = 0, vr = 0, cv = 0;
    for (const b in brut.a) va += Math.pow(brut.a[b].g - pa * brut.a[b].n, 2);
    for (const b in brut.r) vr += Math.pow(brut.r[b].g - pr * brut.r[b].n, 2);
    for (const b in brut.a) if (brut.r[b]) cv += (brut.a[b].g - pa * brut.a[b].n) * (brut.r[b].g - pr * brut.r[b].n);
    const cA = A.k / (A.k - 1), cR = R.k / (R.k - 1);
    const seBrut = Math.sqrt(cA * va / (A.n * A.n) + cR * vr / (R.n * R.n) - 2 * Math.sqrt(cA * cR) * cv / (A.n * R.n));
    const eM = P.ecartGroupe(P.etat().audit['Veto · melange'], P.etat().audit['pris']);
    ok(eM && Math.abs(eM.seParts - seBrut) < 1e-12 && eM.groupes === A.k && Object.keys(P.etat().audit['pris'].grp.ouverts).length <= 4,
       'creneaux replies au fil de l eau (' + Object.keys(P.etat().audit['pris'].grp.ouverts).length + ' encore ouverts) : meme erreur-type que le calcul brut [' + (eM && eM.seParts.toFixed(6)) + ' / ' + seBrut.toFixed(6) + ']');
  }

  console.log('\n-- 4bis. la porte par marché : corrigée, éteinte, et elle ne refuse qu au-delà du bruit --');
  {
    /* ---- REECRIT LE 27 SEPTEMBRE 2026, SUR SON INTENTION ----
     * Intention d origine : « un marché à espérance apprise négative est
     * refusé ». Le rapport du 26/09 a montré que la porte était MORTE (clé
     * 'BTCUSDT' contre 'BTC') et que, réveillée telle quelle, elle aurait
     * refusé BTC sur du bruit (−0,062 ± 0,12, n = 47). Elle refuse désormais
     * une espérance négative AU-DELÀ du bruit (moyenne + 2 e.-t. < 0). */
    neuf();
    const pose = (nom, l) => { for (const r of l) P.noteProfil({ banquier: { marche: nom } }, P.HORIZON_REF, r); };
    const bruit = (m, sd, n) => Array.from({ length: n }, (_, i) => m + (i % 2 ? sd : -sd));
    pose('ETH', bruit(-0.3, 0.5, 200));          /* −0,3 ± 0,035 : négatif au-delà du bruit */
    pose('BTC', bruit(-0.062, 0.84, 47));        /* le cas réel du 26/09 : −0,062, e.-t. ~0,12 */
    pose('DOGE', bruit(0.2, 0.5, 200));
    pose('XRP', bruit(-3, 0.1, 3));              /* négatif mais trop peu vu */
    ok(P.marcheRefuse('ETH'), 'un marché qui perd au-delà du bruit est refusé');
    ok(!P.marcheRefuse('BTC'), 'BTC du 26/09 (−0,062 sur 47, e.-t. ~0,12) : PAS refusé — c était du bruit');
    ok(!P.marcheRefuse('DOGE'), 'un marché à espérance positive passe');
    ok(!P.marcheRefuse('XRP'), 'sous le minimum d observations, on ne conclut pas (aucun refus)');
    ok(!P.marcheRefuse('INCONNU'), 'un marché jamais vu n est pas refusé : un inconnu n est pas un mauvais signe');
    /* Une case d avant les carrés (n, s seulement) ne peut pas avoir d erreur-type. */
    const vieille = P.caseProfil('marche', 'SOL', P.HORIZON_REF, false); vieille.n = 500; vieille.s = -500;
    ok(!P.marcheRefuse('SOL'), 'une case sans somme des carrés ne refuse rien : sans erreur-type, pas de jugement');
    const eth = P.caseProfil('marche', 'ETH', P.HORIZON_REF, true);
    ok(eth.nq === 200 && typeof eth.q === 'number', 'la case garde la somme des carrés (' + eth.q.toFixed(1) + ') et son effectif');
    eq(P.PORTE_MEMOIRE, false, 'et la porte est ÉTEINTE par défaut : l allumer est une décision du propriétaire');
  }

  console.log('\n-- 5. un tour complet, contre un faux marche --');
  {
    const S = neuf();
    /* Marche mort : les deux sens sont refuses par le meme garde. */
    let r = await P.tour({ marches: { [SYM]: marche({ bruit: 0.001, pente: 0 }) } });
    ok(r.verdicts.every((v) => /dead/.test(v.refus || '')), 'un marche mort refuse les deux sens : « ' + r.verdicts[0].refus + ' »');
    eq(r.ouvert, 0, 'et rien ne s ouvre');
    /* La cle d audit porte le NOM anglais de l agent, pas sa cle interne :
       c est cette chaine que la page affiche, au milieu d un panneau anglais.
       Ce qui est verifie reste le meme — l ombre est classee sous l agent qui
       a refuse — mais sous le nom qu'on lira. */
    const nomRegime = P.AGENTS.find((a) => a.key === 'regime').nom;
    ok(S.ombres.length === 2 && S.ombres.every((o) => o.cle.indexOf(nomRegime + ' · ') === 0),
       'deux ombres, une par sens, sous la regle qui a refuse (« ' + S.ombres[0].cle + ' »)');
    ok(!/regime ·/.test(S.ombres[0].cle), 'et pas sous sa cle interne, qui est francaise');

    /* Tempete : refusee aussi, et par une autre phrase. */
    const S2 = neuf();
    r = await P.tour({ marches: { [SYM]: marche({ bruit: 3, pente: 0.2 }) } });
    ok(r.verdicts.some((v) => /storm/.test(v.refus || '')), 'une tempete est refusee : « ' + (r.verdicts.find((v) => v.refus) || {}).refus + ' »');

    /* Tendance de fond marquee : le sens contraire est refuse par son nom. */
    const S3 = neuf();
    r = await P.tour({ marches: { [SYM]: marche({ pente: 0.35, bruit: 0.1 }) } });
    const court = r.verdicts.find((v) => v.sens < 0);
    ok(/short against a deep uptrend/.test(court.refus || ''),
       'contre une tendance de fond haussiere, le short est refuse : « ' + court.refus + ' »');

    /* Et une position s ouvre quand un sens passe. */
    const S4 = neuf();
    let pris = null;
    for (const p of [0.35, -0.35, 0.12, -0.12]) {
      neuf();
      const rr = await P.tour({ marches: { [SYM]: marche({ pente: p, bruit: 0.12, financement: p > 0 ? -0.0008 : 0.0008 }) } });
      if (rr.ouvert === 1) { pris = { p, rr }; break; }
    }
    ok(!!pris, 'un marche lisible finit par ouvrir une position (pente ' + (pris && pris.p) + ')');
    const S5 = P.etat();
    const pos = S5.positions[0];
    ok(pos && pos.stop && pos.cible && (pos.sens > 0 ? pos.stop < pos.prix0 && pos.cible > pos.prix0
                                                     : pos.stop > pos.prix0 && pos.cible < pos.prix0),
       'avec un stop et une cible du bon cote (' + (pos.sens > 0 ? 'long' : 'short') + ')');
    ok(Math.abs(pos.stop - pos.prix0) / pos.prix0 * 100 > pos.vol,
       'le stop est un MULTIPLE de la volatilite du moment, pas un pourcentage fixe');

    /* Le stop se declenche, et le carnet garde le detail. */
    const tresorAvant = S5.tresor;
    const contre = pos.prix0 * (1 - pos.sens * 0.05);
    /* Chaque position est surveillee au prix de SON marche : la surveillance
       recoit desormais la table des marches lus, pas un prix unique. */
    P.surveille({ [pos.sym]: { prix: contre } });
    eq(S5.positions.length, 0, 'le stop ferme la position');
    ok(S5.carnet.length === 1 && S5.carnet[0].pourquoi === 'stop' && S5.carnet[0].r < 0,
       'le carnet dit pourquoi et combien : ' + JSON.stringify(S5.carnet[0].r));
    ok(typeof S5.carnet[0].financement === 'number' && typeof S5.carnet[0].brut === 'number',
       'et il separe le mouvement du prix du financement paye — sans cette colonne, on ne sait pas ce qui a coute');
    /* Le rendement papier est NET des DEUX couts : financement ET frais aller-retour.
       Sans le frais, le papier gagnerait et le reel perdrait — le mensonge a eviter. */
    const cc = S5.carnet[0];
    ok(cc.frais > 0, 'le carnet porte le frais aller-retour preleve : ' + cc.frais + '%');
    ok(Math.abs(cc.r - (cc.brut + cc.financement - cc.frais)) < 0.0015,
       'et le rendement est NET : brut + financement - frais, pas le brut seul');
    ok(S5.tresor < tresorAvant, 'le papier a baisse');
    ok(S5.trades === 1 && P.vue().financement.n === 1, 'le trade est compte, le financement aussi');
  }

  console.log('\n-- 6. rien ici ne peut signer quoi que ce soit --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'ai_perp.js'), 'utf8');
    /* `\b` avant `sign(` : sans lui, `Object.assign(` faisait echouer la
       verification — un faux positif qui aurait fini par la faire retirer,
       c est-a-dire par retirer le garde-fou le plus important du fichier. */
    ok(!/API_KEY|SECRET|signature|privateKey|Wallet|\bsign\(/i.test(src.replace(/\* [^\n]*/g, '')),
       'le fichier ne porte ni cle, ni secret, ni signature');
    ok(!/\/order|placeOrder|\/trade|paptrading/i.test(src.replace(/\* [^\n]*/g, '')),
       'et aucun chemin vers un ordre : une colonie qui perd en papier ne doit jamais avoir pu perdre autre chose');
    ok(/api\.bitget\.com\/api\/v2\/mix\/market/.test(src), 'la source est le marche PUBLIC de Bitget');
    const v = P.vue();
    ok(v.papier === true && !JSON.stringify(v).toLowerCase().includes('secret'), 'et la vue le dit : papier');
    ok(Array.isArray(v.agents) && v.agents.length === 8 && v.horizonRef === 240,
       'la vue porte les agents et l echeance de reference (' + v.horizonRef + ' min)');
    /* ---- UNE COLONIE, PAS UNE PAR MARCHE ----
     * L essai verifiait qu il y en avait une par instrument, chacune avec son
     * etat. Son intention etait que les marches ne se melangent pas. Ils ne
     * se melangent toujours pas — chaque position, chaque ombre et chaque
     * ligne de carnet porte SON marche — mais la tresorerie, la memoire et
     * l audit sont communs : cinq memoires nourries chacune d un cinquieme
     * des observations n apprennent rien. */
    ok(P.SYMBOLES.length >= 2 && P.SYMBOLES.every((x) => /USDT$/.test(x)),
       P.SYMBOLES.length + ' marches suivis : ' + P.SYMBOLES.join(', '));
    ok(P.etat() === P.etat(), 'et UNE seule colonie pour tous');
    ok(v.marches.join(',') === P.SYMBOLES.join(','), 'la vue nomme les marches suivis');
  }

  /* ======================================================================
   * 9. UNE COLONIE, PLUSIEURS MARCHES
   * ==================================================================== */
  console.log('\n-- 8 bis. au plus deux positions dans le meme sens, et la regle se juge --');
  {
    /* Choix du proprietaire, le 26 septembre 2026 : cinq cryptos prises dans
       le meme sens sont un seul pari pose cinq fois. La regle refuse le
       troisieme candidat d'un sens, et son ombre est jugee comme toute regle. */
    eq(P.MEME_SENS_MAX, 2, 'deux positions au plus dans un sens (defaut)');
    neuf();
    const S = P.etat();
    const pose = (sym, prix, sens) => { const x = P.mesures(marche({ prix })); x.sym = sym; return P.ouvre(x, sens, { score: 80, traits: {} }); };
    pose('BTCUSDT', 60000, 1); pose('ETHUSDT', 3000, 1);
    const DOGE = marche({ prix: 0.2, pente: 0.45, bruit: 0.1, financement: -0.0009 });
    const r = await P.tour({ marches: { BTCUSDT: marche({ prix: 60000 }), ETHUSDT: marche({ prix: 3000 }), DOGEUSDT: DOGE } });
    const long = r.verdicts.find((v) => v.sym === 'DOGEUSDT' && v.sens === 1);
    const garde = r.verdicts.filter((v) => v.sens === 1 && v.refus === 'too many positions the same way');
    ok(garde.length >= 1 && garde.every((v) => v.sens === 1), 'deux longs ouverts : un troisieme long est refuse, et le refus nomme la regle (« ' + (long && long.refus) + ' »)');
    ok(!r.verdicts.some((v) => v.sens === -1 && v.refus === 'too many positions the same way'), 'un short, lui, reste possible : la regle ne compte que le meme sens');
    ok(S.positions.filter((q) => q.sens === 1).length <= 2, 'et aucun troisieme long ne s ouvre');
    ok(S.ombres.some((o) => o.cle === 'Exposure · too many positions the same way' && o.sens === 1),
       'le candidat refuse laisse son ombre sous « Exposure · too many positions the same way » : l audit la jugera contre « pris »');
    ok(P.vue().memeSensMax === 2, 'la page peut dire la regle');

    neuf();
    pose('BTCUSDT', 60000, 1);
    const r2 = await P.tour({ marches: { BTCUSDT: marche({ prix: 60000 }), ETHUSDT: marche({ prix: 3000 }), DOGEUSDT: DOGE } });
    ok(!r2.verdicts.some((v) => v.refus === 'too many positions the same way'), 'un seul long ouvert : la regle ne refuse rien');
  }

  console.log('\n-- 9. un tour lit TOUS les marches et prend le meilleur --');
  {
    neuf();
    /* Trois marches, une seule tendance franche : c est celle-la qui doit
       etre prise, quel que soit l ordre de lecture. */
    const r = await P.tour({ marches: {
      BTCUSDT:  marche({ prix: 60000, pente: 0.02, bruit: 0.1 }),
      ETHUSDT:  marche({ prix: 3000,  pente: 0.02, bruit: 0.1 }),
      DOGEUSDT: marche({ prix: 0.2,   pente: 0.45, bruit: 0.1, financement: -0.0009 }),
    } });
    eq(r.marches.length, 3, 'les trois marches sont lus AVANT qu une decision soit prise');
    ok(r.verdicts.length === 6, 'deux sens par marche : ' + r.verdicts.length + ' verdicts');
    const S = P.etat();
    ok(S.positions.length <= 1, 'une position a la fois pour toute la colonie, pas une par marche');
    if (S.positions.length) {
      const meilleur = r.verdicts.filter((v) => !v.refus).sort((a, b) => b.score - a.score)[0];
      eq(S.positions[0].sym, meilleur.sym, 'et c est le meilleur score qui est pris, quel que soit son marche');
      ok(/DOGE|BTC|ETH/.test(S.flux[0].quoi), 'le journal nomme le marche : « ' + S.flux[0].quoi + ' »');
    }

    /* ---- UNE OMBRE PAR MARCHE, PAS UNE POUR TOUS ----
     * Sans le marche dans le doublon, une ombre posee sur BTC empecherait la
     * meme regle d en poser une sur DOGE, et l audit ne verrait plus qu un
     * marche sur cinq. */
    neuf();
    const S2 = P.etat();
    const xa = P.mesures(marche({ prix: 60000 })); xa.sym = 'BTCUSDT';
    const xb = P.mesures(marche({ prix: 0.2 }));   xb.sym = 'DOGEUSDT';
    P.noteOmbre(xa, 1, 'storm', 'regime', {});
    P.noteOmbre(xb, 1, 'storm', 'regime', {});
    eq(S2.ombres.length, 2, 'la meme regle laisse une ombre par marche');
    P.noteOmbre(xa, 1, 'storm', 'regime', {});
    eq(S2.ombres.length, 2, 'mais pas deux fois sur le meme marche dans la meme fenetre');

    /* ---- CHAQUE OMBRE SE JUGE AU PRIX DE SON MARCHE ---- */
    neuf();
    const S3 = P.etat();
    const b0 = P.mesures(marche({ prix: 60000, financement: 0 })); b0.sym = 'BTCUSDT';
    const d0b = P.mesures(marche({ prix: 0.2, financement: 0 }));  d0b.sym = 'DOGEUSDT';
    P.noteOmbre(b0, 1, null, null, {});
    P.noteOmbre(d0b, 1, 'storm', 'regime', {});
    for (const o of S3.ombres) o.t = Date.now() - 240 * 60000;
    const b1 = P.mesures(marche({ prix: 66000, financement: 0 })); b1.sym = 'BTCUSDT';   /* +10 % */
    const d1b = P.mesures(marche({ prix: 0.18, financement: 0 })); d1b.sym = 'DOGEUSDT'; /* -10 % */
    P.regleLesOmbres({ BTCUSDT: b1, DOGEUSDT: d1b });
    ok(Math.abs(S3.audit['pris'].s - 10) < 0.5,
       'l ombre BTC est jugee au prix de BTC : ' + S3.audit['pris'].s.toFixed(1) + ' %');
    const r2 = S3.audit['Regime · storm'];
    ok(r2 && Math.abs(r2.s + 10) < 0.5,
       'et celle de DOGE au prix de DOGE : ' + r2.s.toFixed(1) + ' %');

    /* Un marche muet ne fait pas juger ses ombres au prix d un autre. */
    neuf();
    const S4 = P.etat();
    P.noteOmbre(d0b, 1, null, null, {});
    S4.ombres[0].t = Date.now() - 240 * 60000;
    P.regleLesOmbres({ BTCUSDT: b1 });
    ok(!S4.audit['pris'], 'un marche non lu laisse ses ombres en attente, il ne les juge pas au prix d un autre');
    eq(S4.ombres.length, 1, 'et l ombre reste');
  }

  /* ======================================================================
   * 10. LE MARCHE EST UN TRAIT, PAS UNE ARCHITECTURE
   * ==================================================================== */
  console.log('\n-- 10. le marche est un trait observe --');
  {
    neuf();
    ok(typeof P.TRAITS.marche === 'function', 'le marche est un trait');
    const x = P.mesures(marche({ prix: 0.2 })); x.sym = 'DOGEUSDT';
    eq(P.TRAITS.marche(x), 'DOGE', 'sa case est le nom du marche, sans le suffixe');
    const banquier = P.AGENTS.find((a) => a.key === 'banquier');
    ok(banquier.traits.indexOf('marche') >= 0,
       'et c est le Banquier qui l observe : « combien on met » est la question ou le marche compte');
    const tr = P.traitsDe(x);
    eq(tr.banquier.marche, 'DOGE', 'les traits du moment le portent');

    /* ---- CE QUE CHAQUE MARCHE A RENDU ----
     * Le decoupage en cinq colonies donnait cette repartition gratuitement.
     * Une colonie unique doit la RENDRE, sinon on perd la seule chose que le
     * decoupage faisait bien. */
    const S = P.etat();
    S.carnet = [
      { sym: 'BTCUSDT', r: 2, gain: 20, financement: -0.1 },
      { sym: 'BTCUSDT', r: -1, gain: -10, financement: -0.2 },
      { sym: 'DOGEUSDT', r: 5, gain: 50, financement: -0.3 },
    ];
    const pm = P.parMarche();
    const btc = pm.find((m) => m.nom === 'BTC');
    const doge = pm.find((m) => m.nom === 'DOGE');
    eq(btc.n, 2, 'la repartition compte les trades fermes de chaque marche');
    eq(btc.partGagnantes, 50, 'avec sa part de gagnantes');
    eq(btc.gain, 10, 'et ce qu il a rapporte');
    eq(doge.n, 1, 'DOGE a le sien');
    ok(pm.every((m) => m.appris === null),
       'et « ce qu on a appris » reste vide tant que la case n a pas ses observations');
    /* Une esperance sur trois ombres est du bruit ; sur assez, elle s affiche. */
    for (let i = 0; i < P.PROFIL_MIN_OBS; i++) P.noteProfil({ banquier: { marche: 'DOGE' } }, P.HORIZON_REF, 2);
    const doge2 = P.parMarche().find((m) => m.nom === 'DOGE');
    ok(doge2.appris && doge2.appris.n === P.PROFIL_MIN_OBS,
       'passe le minimum, ce que la colonie a appris du marche s affiche : ' + JSON.stringify(doge2.appris));
    /* Les marches jamais vus sont quand meme listes : « aucun trade » est une
       information, et une ligne absente se lit comme un marche qu on ne suit
       pas. */
    ok(pm.length >= P.SYMBOLES.length, 'tous les marches suivis sont listes, meme ceux sans trade');
  }

  /* ======================================================================
   * 11. LA SOUPAPE DE FAMINE
   *
   * ---- CE QUI EST ARRIVE, 19 septembre 2026, sept tours en production ----
   *
   * Zero position, dix ombres, aucun trade. Un tour rejoue contre le vrai
   * marche a donne, sur les CINQ marches a la fois :
   *   LONG  36 a 51 « score below the bar »  ·  SHORT 49 a 64 « short against
   *   a deep uptrend ».
   *
   * Ce n etait pas une panne mais une contradiction, RESOLUE le 22 septembre :
   * la NOTE etait contrariante (couloir, journee poussaient contre le
   * mouvement) alors que le VETO suit la tendance — en fond haussier, le short
   * etait le cote que la note aimait et que le veto interdisait, le long celui
   * que le veto autorisait et que la note detestait, l intersection etait vide.
   * `perp_edge.js` a tranche sur de vraies bougies (trend au-dessus du point
   * mort, contre-mouvement dessous) et la note suit desormais la tendance : en
   * fond haussier le long PASSE. Le blocage HONNETE qui reste, et que la soupape
   * garde, est un marche PLAT : aucun sens n atteint la barre.
   *
   * Et pire, quel que soit le blocage : `reference()` exige douze « pris » pour
   * exister. Sans rien de pris, aucune regle ne peut JAMAIS etre jugee. Meme
   * roue a cliquet que la colonie de jetons le 12 septembre, meme reponse :
   * une soupape.
   * ==================================================================== */
  console.log('\n-- 11. la soupape de famine --');
  {
    /* Le blocage reproduit apres l alignement de la note : un marche PLAT et
       sans financement penchant. Aucun sens n atteint la barre (« score below
       the bar », note 50 < 55) : c est un refus d AVIS, pas de securite — la
       volatilite est vivante (ni marche mort, ni tempete) et le fond lisible. */
    neuf();
    const S = P.etat();
    const plat = marche({ prix: 80000, pente: 0, pente4: 0, bruit: 0.12, financement: 0, var24: 0 });
    const xPlat = P.mesures(plat);
    ok(xPlat.vol15 >= 0.04 && xPlat.vol15 <= 0.6, 'le marche est vivant : ni mort ni tempete (vol ' + xPlat.vol15.toFixed(3) + ')');
    ok(Math.abs(xPlat.fond) <= P.FOND_MUR, 'et son fond ne declenche pas le mur de tendance (fond ' + xPlat.fond.toFixed(2) + ' %)');
    let r = await P.tour({ marches: { BTCUSDT: plat } });
    const refuses = r.verdicts.filter((v) => /below the bar/.test(v.refus || ''));
    ok(refuses.length === 2, 'les deux sens sont refuses par la barre, pas par la securite (' + refuses.length + '/2)');
    eq(r.ouvert, 0, 'donc rien ne s ouvre — c est le blocage');
    eq(S.disette, 1, 'la disette se compte');

    /* Les tours passent. Le premier a deja compte : il en reste
       FAMINE_TOURS - 2 avant celui qui ouvre la soupape. */
    for (let i = 2; i <= P.FAMINE_TOURS - 1; i++) r = await P.tour({ marches: { BTCUSDT: plat } });
    eq(S.disette, P.FAMINE_TOURS - 1, 'la disette monte, et rien ne s est ouvert avant l heure');
    eq(S.positions.length, 0, 'la soupape ne s ouvre pas une seconde trop tot');
    r = await P.tour({ marches: { BTCUSDT: plat } });
    eq(r.ouvert, 1, 'au bout de ' + P.FAMINE_TOURS + ' tours, la soupape prend le meilleur candidat');
    ok(S.positions[0].soupape === true, 'et la position porte sa marque');
    eq(S.compteurs.soupape, 1, 'la prise de soupape est comptee a part');
    ok(/valve/.test(S.flux[0].quoi), 'le journal le dit : « ' + S.flux[0].quoi + ' »');
    eq(S.disette, 0, 'et la disette repart de zero');
    /* ---- LA REFERENCE PEUT ENFIN EXISTER ----
     * C est tout l enjeu : sans « pris », `verdictRegle` ne rend jamais que
     * « unknown », et l audit ne peut RIEN juger. */
    ok(S.ombres.some((o) => o.cle === 'pris'),
       'la prise laisse une ombre « pris » : c est elle qui fera la reference');

    /* ---- LA SECURITE, ELLE, NE CEDE PAS ----
     * Une soupape qui ouvrirait aussi les refus de securite prendrait des
     * positions qu on ne saurait pas juger — un marche mort, une tempete. */
    neuf();
    const S2 = P.etat();
    const mort = marche({ bruit: 0.001, pente: 0 });
    for (let i = 0; i <= P.FAMINE_TOURS + 2; i++) await P.tour({ marches: { BTCUSDT: mort } });
    eq(S2.positions.length, 0, 'sur un marche mort, la soupape ne prend RIEN, meme apres la famine');
    ok(!S2.compteurs.soupape, 'et elle ne se compte pas');
    ok(Object.keys(P.VETOS_SECURITE).length >= 2, 'la securite est une table a part, pas une chaine de caracteres');

    /* ---- ET ELLE SE JUGE ----
     * Une soupape posee sans mesure doit etre mesurable tout de suite. */
    const b = P.soupapeBilan();
    ok(b.soupape && b.colonie, 'le bilan separe ce que prend la soupape de ce que prend la colonie');
    eq(b.comparable, false, 'et il refuse de conclure tant que les deux groupes n ont pas leur echantillon');
    eq(b.tours, P.FAMINE_TOURS, 'il rappelle au bout de combien de tours elle s ouvre');
  }

  /* ======================================================================
   * 12. PLUSIEURS POSITIONS, UNE PAR MARCHE
   *
   * ---- LA MESURE QUI L A DECIDE ----
   * 20 septembre 2026, 283 tours en production : 4 ouvertures et
   * 211 `dejaEngage`. Deux cent onze fois, un candidat avait passe la
   * securite, l avis ET la barre, et la colonie n a rien fait parce qu elle
   * tenait deja une position AILLEURS. Une position se tient jusqu a douze
   * heures : sur cinq marches, une seule a la fois laisse passer l essentiel
   * de ce qu on a su reperer.
   *
   * La regle d origine — deux sens sur le MEME instrument s annulent et
   * paient deux financements — reste vraie, et reste appliquee.
   * ==================================================================== */
  console.log('\n-- 12. plusieurs positions, une par marche --');
  {
    neuf();
    const S = P.etat();
    /* Trois marches lisibles et franchement orientes : de quoi ouvrir. */
    const bon = (p) => marche({ prix: 100, pente: p, bruit: 0.12, financement: -0.0009 });
    const trois = { BTCUSDT: bon(0.3), ETHUSDT: bon(0.3), SOLUSDT: bon(0.3) };
    await P.tour({ marches: trois });
    eq(S.positions.length, 1, 'un tour n ouvre qu une position : la meilleure note, pas toutes');
    await P.tour({ marches: trois });
    ok(S.positions.length === 2, 'le tour suivant en ouvre une autre, sur un AUTRE marche : ' + S.positions.length);
    const marches = S.positions.map((p) => p.sym);
    eq(new Set(marches).size, marches.length, 'jamais deux positions sur le meme instrument : ' + marches.join(', '));
    ok(!S.compteurs.dejaEngage, 'et le compteur fourre-tout `dejaEngage` a disparu');

    /* Le plafond mord, et il se compte. */
    for (let i = 0; i < 6; i++) await P.tour({ marches: trois });
    ok(S.positions.length <= P.POSITIONS_MAX,
       'le plafond de ' + P.POSITIONS_MAX + ' tient : ' + S.positions.length + ' positions');
    /* Depuis le 26 septembre 2026, une troisieme raison existe : trois marches
       tous longs, et au-dela de deux longs la regle du meme sens refuse. Elle
       se compte a part elle aussi (`memeSens`) — c'est l'intention de l'essai. */
    ok((S.compteurs.plafondPositions || 0) + (S.compteurs.dejaSurCeMarche || 0) + (S.compteurs.memeSens || 0) > 0,
       'et les raisons de ne rien faire sont comptees SEPAREMENT : plafond '
       + (S.compteurs.plafondPositions || 0) + ', marche deja tenu ' + (S.compteurs.dejaSurCeMarche || 0)
       + ', meme sens ' + (S.compteurs.memeSens || 0));
    ok(S.positions.filter((q) => q.sens === 1).length <= P.MEME_SENS_MAX, 'trois marches tous longs : jamais plus de ' + P.MEME_SENS_MAX + ' longs a la fois');

    /* Chaque position garde son marche, et se surveille au prix du sien. */
    const avant = S.positions.length;
    const p0 = S.positions[0];
    const contre = p0.prix0 * (1 - p0.sens * 0.05);
    P.surveille({ [p0.sym]: { prix: contre } });
    eq(S.positions.length, avant - 1, 'un stop ne ferme que la position de SON marche');
    eq(S.carnet[0].sym, p0.sym, 'et le carnet dit lequel : ' + S.carnet[0].sym);
  }

  /* ======================================================================
   * 13. LES FRAIS PAR TYPE D ORDRE (27 septembre 2026)
   * Le papier comptait 0,04 % aller-retour (maker des deux cotes). L entree,
   * le stop et la sortie au temps sont des ordres au marche (taker 0,06 %),
   * seule la cible peut etre un ordre limite (maker 0,02 %). Rapport du
   * 26/09 : −0,377 → −0,449 % par trade sur les 40 trades visibles.
   * ==================================================================== */
  console.log('\n-- 13. les frais suivent le type d ordre --');
  {
    eq(P.fraisAR('stop'), 0.12, 'un stop paie taker a l entree et a la sortie : 0,12 %');
    eq(P.fraisAR('time'), 0.12, 'une sortie au temps aussi : 0,12 %');
    eq(P.fraisAR('target'), 0.08, 'une cible est un ordre limite pose : taker + maker = 0,08 %');
    const S = neuf();
    const x = P.mesures(marche({ prix: 100, financement: 0 })); x.sym = SYM;
    const p1 = P.ouvre(x, 1, { score: 60, traits: {} });
    P.ferme(p1, p1.cible, 'target');
    const p2 = P.ouvre(x, 1, { score: 60, traits: {} });
    P.ferme(p2, p2.stop, 'stop');
    const [stop, cible] = S.carnet;
    eq(cible.frais, 0.08, 'la ligne de la cible porte 0,08 %');
    eq(stop.frais, 0.12, 'celle du stop 0,12 %');
    ok(Math.abs(stop.r - (stop.brut + stop.financement - 0.12)) < 0.0015, 'et le net les retire : ' + stop.r);
    /* Une ligne d AVANT (frais maker 0,04) garde son net comptabilise ; la vue
       rend a cote son net aux frais reels, pour que les deux se comparent. */
    S.carnet.push({ sym: SYM, sens: 1, prix0: 100, prix: 99, r: -1.04, brut: -1, financement: 0, frais: 0.04,
                    gain: -1, minutes: 100, pourquoi: 'stop', t: Date.now() - 86400000 });
    const vieille = P.vue().carnet.find((c) => c.frais === 0.04);
    eq(vieille.r, -1.04, 'une ancienne ligne garde son net d origine (frais maker)');
    eq(vieille.rReel, -1.12, 'et la vue lui ajoute son net aux frais reels : ' + vieille.rReel);
    /* `PERP_FRAIS` garde son sens : un forfait aller-retour pour tous les trades. */
    const { execFileSync } = require('child_process');
    const forfait = execFileSync(process.execPath, ['-e',
      "const P=require('./ai_perp');console.log(JSON.stringify([P.fraisAR('target'),P.fraisAR('stop'),P.fraisReels('target')]))"],
      { cwd: __dirname, env: Object.assign({}, process.env, { PERP_FRAIS: '0.04' }) }).toString().trim();
    eq(forfait, '[0.04,0.04,0.08]', 'PERP_FRAIS pose : le forfait s applique partout, les frais reels restent calculables');
  }

  console.log('\n-- 14. la periode de financement vient du contrat --');
  {
    const S = neuf();
    const appels = [];
    const prendre = async (u) => {
      appels.push(u);
      const sym = new URL(u).searchParams.get('symbol');
      if (sym === 'BADUSDT') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ code: '00000', data: [{ symbol: sym, fundInterval: sym === 'ZECUSDT' ? '4' : '8' }] }) };
    };
    await P.litPeriodes(['BTCUSDT', 'ZECUSDT', 'BADUSDT'], prendre);
    eq(P.periodeFin('BTCUSDT'), 480, 'BTC regle toutes les 8 h');
    eq(P.periodeFin('ZECUSDT'), 240, 'un contrat a 4 h est lu comme tel (378 contrats Bitget sur 805)');
    eq(P.periodeFin('BADUSDT'), 480, 'une lecture ratee retombe sur 480, le defaut');
    ok(appels.every((u) => /\/contracts\?/.test(u)), 'lu sur /contracts');
    await P.litPeriodes(['BTCUSDT', 'ZECUSDT'], prendre);
    eq(appels.length, 3, 'et une seule fois par jour et par contrat : pas un appel de plus au tour suivant');
    eq(P.coutFinancement(1, 0.0001, 240, 240), -0.01, 'a 4 h, quatre heures tenues coutent une periode entiere');
    const x = P.mesures(marche({ prix: 100, financement: 0.0001 })); x.sym = 'ZECUSDT';
    const pz = P.ouvre(x, 1, { score: 60, traits: {} });
    eq(pz.pf, 240, 'la position garde la periode de SON contrat');
    pz.t = Date.now() - 240 * 60000;
    P.ferme(pz, 100, 'time');
    eq(S.carnet[0].financement, -0.01, 'et le financement du trade la suit : ' + S.carnet[0].financement);
  }

  console.log('\n-- 15. le carnet est servi en entier --');
  {
    const S = neuf();
    for (let i = 0; i < 150; i++) S.carnet.push({ sym: SYM, sens: 1, r: 0.1, brut: 0.22, financement: 0, frais: 0.12, pourquoi: 'time', t: Date.now() - i * 60000 });
    eq(P.vue().carnet.length, 150, 'les 150 lignes du carnet partent a la page (40 avant le 27/09)');
  }

  /* ======================================================================
   * 16. STOPS ET CIBLES JUGES SUR LES BOUGIES D UNE MINUTE
   * Rejeu du 26/09 : un « temps −0,46 % » etait un stop touche a 188 min, et
   * 9 stops sur 22 avaient ete vus avec 50 a 282 min de retard.
   * ==================================================================== */
  console.log('\n-- 16. les bougies fines jugent stops et cibles --');
  {
    const MIN = 60000;
    const pose = () => {
      const S = neuf();
      const x = P.mesures(marche({ prix: 100, financement: 0 })); x.sym = SYM;
      const p = P.ouvre(x, 1, { score: 60, traits: {} });
      p.t = Date.now() - 300 * MIN; p.jusqua = p.t + 720 * MIN; p.stop = 98; p.cible = 103;
      return { S, p };
    };
    const b = (t, o, h, lo, c) => ({ t, o, h, b: lo, c });
    /* Le dernier prix est sage (100), mais une bougie a touche le stop il y a
       deux heures : la position est fermee AU STOP, a l heure du stop. */
    let { S, p } = pose();
    const tStop = p.t + 120 * MIN;
    P.surveille({ [SYM]: { prix: 100 } }, { [SYM]: [b(p.t + MIN, 100, 100.5, 99.5, 100), b(tStop, 99, 99.2, 97.9, 98.5), b(tStop + MIN, 98.5, 101, 98.4, 100)] });
    eq(S.carnet[0] && S.carnet[0].pourquoi, 'stop', 'un stop touche entre deux tours est vu, meme si le prix est revenu');
    eq(S.carnet[0].minutes, 120, 'et date a la minute du stop : ' + S.carnet[0].minutes + ' min, pas au tour');
    ({ S, p } = pose());
    P.surveille({ [SYM]: { prix: 100 } }, { [SYM]: [b(p.t - 30 * 1000, 100, 100, 90, 100), b(p.t + MIN, 100, 100.4, 99.6, 100)] });
    eq(S.positions.length, 1, 'une bougie commencee AVANT l entree ne compte pas : ses extremes peuvent dater d avant');
    ({ S, p } = pose());
    P.surveille({ [SYM]: { prix: 100 } }, { [SYM]: [b(p.t + MIN, 100, 103.5, 97.5, 100)] });
    eq(S.carnet[0].pourquoi, 'stop', 'stop et cible dans la meme bougie : le stop d abord (on ne sait pas l ordre)');
    ({ S, p } = pose());
    P.surveille({ [SYM]: { prix: 97 } }, { [SYM]: [b(p.t + MIN, 97, 97.2, 96.5, 97)] });
    eq(S.carnet[0].prix, 97, 'une bougie qui OUVRE sous le stop le prend a l ouverture : un stop-market glisse');
    ({ S, p } = pose());
    P.surveille({ [SYM]: { prix: 102 } }, { [SYM]: [b(p.t + MIN, 100, 103.2, 99.9, 102)] });
    ok(S.carnet[0].pourquoi === 'target' && S.carnet[0].prix === 103 && S.carnet[0].frais === 0.08,
       'une cible touchee se prend a la cible, aux frais maker de sortie');
    ({ S, p } = pose());
    const fin = [];
    for (let k = 719; k <= 721; k++) fin.push(b(p.t + k * MIN, 101, 101.2, 100.8, k === 719 ? 101.1 : 101));
    P.surveille({ [SYM]: { prix: 100.5 } }, { [SYM]: fin });
    ok(S.carnet[0].pourquoi === 'time' && S.carnet[0].prix === 101.1 && S.carnet[0].minutes === 720,
       'la tenue echue sort au dernier cours AVANT l echeance, a 720 min : ' + S.carnet[0].prix + ' / ' + S.carnet[0].minutes);
    /* La lecture : un appel par position, borne. */
    const S2 = neuf();
    for (const [sym, prix] of [['BTCUSDT', 100], ['ETHUSDT', 10]]) { const x = P.mesures(marche({ prix })); x.sym = sym; P.ouvre(x, 1, { score: 60, traits: {} }); }
    const appels = [];
    const f = await P.litFines(S2.positions, async (u) => { appels.push(u); return { ok: true, json: async () => ({ code: '00000', data: [[String(Date.now()), '1', '1', '1', '1', '1']] }) }; });
    eq(appels.length, 2, 'un appel par position ouverte, pas plus');
    ok(appels.every((u) => /granularity=1m/.test(u) && /startTime=/.test(u)), 'des bougies d une minute, depuis le dernier controle');
    ok(Object.keys(f).length === 2 && f.BTCUSDT[0].c === 1, 'rendues sous la forme des autres bougies');
    ok(P.POSITIONS_MAX <= 5, 'donc au plus ' + P.POSITIONS_MAX + ' appels de plus par tour');
  }

  console.log('\n-- 17. la porte mémoire : la bonne clé, éteinte, mesurée --');
  {
    const S = neuf();
    const bruit = (m, sd, n2) => Array.from({ length: n2 }, (_, i) => m + (i % 2 ? sd : -sd));
    for (const r of bruit(-0.5, 0.3, 100)) P.noteProfil({ banquier: { marche: 'DOGE' } }, P.HORIZON_REF, r);
    ok(P.marcheRefuse('DOGE') && !P.marcheRefuse('DOGEUSDT'), 'la case est rangée sous « DOGE », pas « DOGEUSDT »');
    const DOGE = marche({ prix: 0.2, pente: 0.45, bruit: 0.1, financement: -0.0009 });
    DOGE.sym = 'DOGEUSDT';
    const r = await P.tour({ marches: { DOGEUSDT: DOGE } });
    ok(!r.verdicts.some((v) => /market memory/.test(v.refus || '')), 'éteinte, elle ne refuse rien en service');
    ok((S.compteurs.memoireAuraitRefuse || 0) >= 1, 'mais elle compte ce qu elle aurait refusé : ' + S.compteurs.memoireAuraitRefuse);
    const { execFileSync } = require('child_process');
    /* Le meme marche, rejoue dans un processus ou la porte est ALLUMEE : le
       marche passe par un fichier du bac temporaire, jamais par le depot. */
    const fm = path.join(process.env.DATA_DIR, 'marche_doge.json');
    fs.writeFileSync(fm, JSON.stringify(DOGE));
    const code = "const P=require('./ai_perp');P._pose(P.etatNeuf());"
      + "for(let i=0;i<100;i++)P.noteProfil({banquier:{marche:'DOGE'}},240,i%2?-0.2:-0.8);"
      + "const m=JSON.parse(require('fs').readFileSync(process.env.MARCHE,'utf8'));"
      + "P.tour({marches:{DOGEUSDT:m},sansSauver:true}).then(r=>console.log(JSON.stringify(r.verdicts.map(v=>v.refus))))";
    const allumee = execFileSync(process.execPath, ['-e', code], { cwd: __dirname,
      env: Object.assign({}, process.env, { PERP_PORTE_MEMOIRE: '1', PERP_JOURNAL: '0', MARCHE: fm }) }).toString().trim();
    ok(/market memory: this market loses beyond noise/.test(allumee), 'allumée (PERP_PORTE_MEMOIRE=1), elle refuse DOGE : ' + allumee.slice(0, 80));
  }

  console.log('\n-- 18. l audit en σ, et « below the bar » rangé sous la note --');
  {
    const S = neuf();
    const x = P.mesures(marche({ prix: 100, bruit: 0.12, financement: 0 })); x.sym = SYM;
    P.noteOmbre(x, 1, null, null, {});
    const o = S.ombres[0];
    ok(Math.abs(o.sig - x.vol15 * 4) < 1e-9, 'l ombre porte le σ a 4 h de son marche (vol 15 min × 4) : ' + o.sig.toFixed(3) + ' %');
    o.t = Date.now() - 240 * 60000;
    const x1 = P.mesures(marche({ prix: 101, bruit: 0.12, financement: 0 })); x1.sym = SYM;
    P.regleLesOmbres({ [SYM]: x1 });
    const a = S.audit.pris;
    ok(a.nz === 1 && Math.abs(a.sz - a.s / o.sig) < 1e-6, 'l audit la juge en unites de σ : ' + a.sz.toFixed(2) + ' σ pour ' + a.s.toFixed(2) + ' %');
    /* Un marche plat, sans financement : la note reste sous la barre. */
    neuf();
    const plat = marche({ prix: 80000, pente: 0, pente4: 0, bruit: 0.12, financement: 0, var24: 0 });
    const r = await P.tour({ marches: { BTCUSDT: plat } });
    ok(r.verdicts.every((v) => v.refus === 'score below the bar'), 'la note est sous la barre des deux cotes');
    const cles = P.etat().ombres.map((z) => z.cle);
    ok(cles.every((c) => c === 'Score · score below the bar'),
       'l ombre est rangee sous « Score », la note entiere, plus sous Trend : ' + cles[0]);
    const trend = P.AGENTS.find((z) => z.key === 'tendance').nom;
    ok(!cles.some((c) => c.indexOf(trend + ' · score') === 0), 'Trend n est plus accuse d un refus collectif');
  }

  console.log('\n-- 19. le bilan des trades : n, Wilson, net ± erreur-type, jugeable a 143 --');
  {
    eq(P.TRADES_JUGEABLES, 143, 'le seuil vient du calcul : +0,30 % a sd 1,44 %, 80 %, α 5 % unilateral → 143');
    const S = neuf();
    const x = P.mesures(marche({ prix: 100, financement: 0 })); x.sym = SYM;
    for (let i = 0; i < 20; i++) {
      const p = P.ouvre(x, 1, { score: 60, traits: {} });
      P.ferme(p, i % 4 === 0 ? p.cible : p.stop, i % 4 === 0 ? 'target' : 'stop');
    }
    const b = P.vue().bilan;
    eq(b.n, 20, 'vingt trades au bilan');
    eq(b.gagnants, 5, 'cinq gagnants (les cibles)');
    ok(b.wilson && b.wilson[0] < 25 && b.wilson[1] > 25, 'avec leur intervalle de Wilson : ' + b.wilson.join('–') + ' %');
    ok(b.jugeable === false && b.seuil === 143, 'et « pas jugeable » sous 143 trades');
    ok(typeof b.netReel === 'number' && b.parSortie.stop.n === 15 && b.parSortie.target.n === 5, 'le net aux frais reels, par sortie');
    /* Tout le meme jour : une erreur-type groupee par jour n existe pas avec un seul jour. */
    eq(b.se, null, 'un seul jour : pas d erreur-type groupee — on ne l invente pas');
    for (const c of S.carnet.slice(0, 10)) c.t -= 86400000;
    P.rebatitBilan(S);
    const b2 = P.vue().bilan;
    ok(b2.n === 20 && b2.jours === 2 && typeof b2.se === 'number', 'deux jours : l erreur-type groupee existe (' + b2.se + ')');
    /* Un etat d avant le bilan se reconstruit depuis son carnet, et dit ce qui manque. */
    S.trades = 260;
    P.rebatitBilan(S);
    eq(P.vue().bilan.manquants, 240, 'un etat qui a perdu des lignes de carnet le DIT : 240 trades manquants');
    /* ---- LE TAUX DE GAIN PORTE SUR LE BILAN, PAS SUR LE CARNET ----
     * 27/09 : 300 trades, les 100 premiers gagnants, les 200 derniers
     * perdants. Le taux se lisait sur le carnet (200 lignes) : 0 %, servi a
     * cote de trades = 300 et d un Wilson calcule sur 300 (28–39 %). */
    const S3 = neuf();
    for (let i = 0; i < 300; i++) {
      const p = P.ouvre(x, 1, { score: 60, traits: {} });
      P.ferme(p, i < 100 ? p.cible : p.stop, i < 100 ? 'target' : 'stop');
    }
    const v3 = P.vue();
    ok(S3.carnet.length === 200 && v3.trades === 300 && v3.bilan.n === 300, 'carnet 200 lignes, 300 trades, bilan 300');
    eq(v3.partGagnantes, Math.round(v3.bilan.gagnants / v3.bilan.n * 100), 'le taux vient du bilan, comme son n et son intervalle');
    ok(v3.partGagnantes === 33 && v3.bilan.wilson[0] <= 33 && v3.bilan.wilson[1] >= 33,
       'et son intervalle le contient : ' + v3.partGagnantes + ' % dans ' + v3.bilan.wilson.join('–') + ' % (le carnet disait 0 %)');
  }

  console.log('\n-- 20. le journal porte le detail de la note, agent par agent --');
  {
    neuf();
    const J = require('./perp_journal');
    const avant = J.relit('0000-00-00').obs.length;
    const DOGE = marche({ prix: 0.2, pente: 0.45, bruit: 0.1, financement: -0.0009 });
    const r = await P.tour({ marches: { DOGEUSDT: DOGE } });
    const l = J.relit('0000-00-00').obs.slice(avant).find((z) => z.s === 'DOGEUSDT');
    ok(l && Array.isArray(l.dt) && l.dt.length === 2 && l.dt.every((d) => d.length === J.DT_ORDRE.length),
       'chaque ligne porte `dt` : ' + J.DT_ORDRE.length + ' contributions par sens');
    const sc = r.verdicts.map((v) => v.score);
    ok(l.dt.every((d, i) => Math.abs(50 + d.reduce((u, w) => u + w, 0) - sc[i]) <= 1),
       'et 50 + la somme des contributions redonne la note : ' + sc.join(', '));
    ok(l.dt[0][J.DT_ORDRE.indexOf('financement')] !== 0, 'Funding a sa colonne : on pourra lui faire un P/L');
  }

  console.log(`\nai_perp.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('  RATE ' + (e.message || e)); console.log(`ai_perp.test.js : RATES : 1/${n + 1}`); process.exit(1); });
