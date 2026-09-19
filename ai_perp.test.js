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
  const bougies = (n2, pas) => {
    const l = [];
    for (let i = 0; i < n2; i++) {
      const p = c.prix * (1 + (c.pente / 100) * (i - n2 + 1));
      const b = p * (1 + ((i % 3) - 1) * c.bruit / 100);
      l.push({ t: Date.now() - (n2 - i) * pas, o: b, h: b * 1.001, b: b * 0.999, c: b, v: 100 });
    }
    l[l.length - 1].c = c.prix;
    return l;
  };
  return { sym: SYM, t: Date.now(), prix: c.prix, marque: c.prix, index: c.prix,
           financement: c.financement, interet: c.interet, bid: c.bid, ask: c.ask,
           haut24: c.prix * 1.02, bas24: c.prix * 0.98, var24: c.var24, volume: 1e9,
           m15: bougies(100, 900000), h4: bougies(60, 14400000) };
}
const neuf = (sym) => { P._pose(sym, P.etatNeuf(sym)); return P.etat(sym); };

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

    const S = neuf(SYM);
    const x0 = P.mesures(marche({ prix: 80000, financement: 0.001 }));
    x0.__sym = SYM;
    P.noteOmbre(SYM, x0, 1, null, null, {});
    /* L echeance de reference est a quatre heures, et sa fenetre se ferme a
       324 minutes : une ombre relue plus tard n a pas de jalon, et c est
       voulu — un jalon pris au mauvais moment n est pas un jalon. */
    S.ombres[0].t = Date.now() - 240 * 60000;
    const x1 = P.mesures(marche({ prix: 80800, financement: 0.001 }));   /* +1 % brut */
    P.regleLesOmbres(SYM, x1);
    const a = S.audit['pris'];
    /* 0,1 % par 8 h, tenu 4 h : la moitie, soit 0,05 point retire du +1 %. */
    ok(a && a.n === 1 && Math.abs(a.s - 0.95) < 0.02,
       'un long a +1 % brut qui a paye un demi-financement est juge a ' + a.s.toFixed(3) + ' %, pas a 1 %');
    const S2 = neuf(SYM);
    P.noteOmbre(SYM, x0, 1, null, null, {});
    S2.ombres[0].t = Date.now() - 400 * 60000;            /* la fenetre des 4 h est passee */
    P.regleLesOmbres(SYM, x1);
    ok(!S2.audit['pris'], 'et une ombre relue hors de la fenetre ne remplit rien : un jalon rate reste vide');
  }

  console.log('\n-- 4. les deux sens, chacun sa ligne, jugee contre ce qu on prend --');
  {
    const S = neuf(SYM);
    /* Une regle qui ecarte des perdants protege ; une qui ecarte des gagnants coute. */
    for (let i = 0; i < 20; i++) P.noteAudit(SYM, 'pris', i < 8 ? 3 : -2);          /* 40 % de gagnantes */
    for (let i = 0; i < 20; i++) P.noteAudit(SYM, 'regime · storm', -3);            /* 0 % */
    for (let i = 0; i < 20; i++) P.noteAudit(SYM, 'tendance · long against a deep downtrend', 4); /* 100 % */
    const ref = P.reference(SYM);
    eq(ref.partGagnantes, 40, 'la reference est ce qu on PREND : ' + ref.partGagnantes + ' % de gagnantes sur ' + ref.n);
    eq(P.verdictRegle(SYM, 'regime · storm').verdict, 'protects',
       'une regle qui n ecarte que des perdants protege');
    eq(P.verdictRegle(SYM, 'tendance · long against a deep downtrend').verdict, 'costs',
       'une regle qui n ecarte que des gagnants coute — et il faut la relire');
    P.noteAudit(SYM, 'jamais vue', 1);
    eq(P.verdictRegle(SYM, 'jamais vue').verdict, 'unknown', 'et sous le minimum, on ne conclut pas');
    eq(P.verdictRegle(SYM, 'jamais vue').manque, P.AUDIT_MIN_OBS - 1, 'en disant combien il manque');
    ok(P.auditDesRefus(SYM).every((l) => l.n >= 3), 'le tableau ecarte ce qui a moins de trois observations');
  }

  console.log('\n-- 5. un tour complet, contre un faux marche --');
  {
    const S = neuf(SYM);
    /* Marche mort : les deux sens sont refuses par le meme garde. */
    let r = await P.tour(SYM, { marche: marche({ bruit: 0.001, pente: 0 }) });
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
    const S2 = neuf(SYM);
    r = await P.tour(SYM, { marche: marche({ bruit: 3, pente: 0.2 }) });
    ok(r.verdicts.some((v) => /storm/.test(v.refus || '')), 'une tempete est refusee : « ' + (r.verdicts.find((v) => v.refus) || {}).refus + ' »');

    /* Tendance de fond marquee : le sens contraire est refuse par son nom. */
    const S3 = neuf(SYM);
    r = await P.tour(SYM, { marche: marche({ pente: 0.35, bruit: 0.1 }) });
    const court = r.verdicts.find((v) => v.sens < 0);
    ok(/short against a deep uptrend/.test(court.refus || ''),
       'contre une tendance de fond haussiere, le short est refuse : « ' + court.refus + ' »');

    /* Et une position s ouvre quand un sens passe. */
    const S4 = neuf(SYM);
    let pris = null;
    for (const p of [0.35, -0.35, 0.12, -0.12]) {
      neuf(SYM);
      const rr = await P.tour(SYM, { marche: marche({ pente: p, bruit: 0.12, financement: p > 0 ? -0.0008 : 0.0008 }) });
      if (rr.ouvert === 1) { pris = { p, rr }; break; }
    }
    ok(!!pris, 'un marche lisible finit par ouvrir une position (pente ' + (pris && pris.p) + ')');
    const S5 = P.etat(SYM);
    const pos = S5.positions[0];
    ok(pos && pos.stop && pos.cible && (pos.sens > 0 ? pos.stop < pos.prix0 && pos.cible > pos.prix0
                                                     : pos.stop > pos.prix0 && pos.cible < pos.prix0),
       'avec un stop et une cible du bon cote (' + (pos.sens > 0 ? 'long' : 'short') + ')');
    ok(Math.abs(pos.stop - pos.prix0) / pos.prix0 * 100 > pos.vol,
       'le stop est un MULTIPLE de la volatilite du moment, pas un pourcentage fixe');

    /* Le stop se declenche, et le carnet garde le detail. */
    const tresorAvant = S5.tresor;
    const contre = pos.prix0 * (1 - pos.sens * 0.05);
    P.surveille(SYM, { prix: contre });
    eq(S5.positions.length, 0, 'le stop ferme la position');
    ok(S5.carnet.length === 1 && S5.carnet[0].pourquoi === 'stop' && S5.carnet[0].r < 0,
       'le carnet dit pourquoi et combien : ' + JSON.stringify(S5.carnet[0].r));
    ok(typeof S5.carnet[0].financement === 'number' && typeof S5.carnet[0].brut === 'number',
       'et il separe le mouvement du prix du financement paye — sans cette colonne, on ne sait pas ce qui a coute');
    ok(S5.tresor < tresorAvant, 'le papier a baisse');
    ok(S5.trades === 1 && P.vue(SYM).financement.n === 1, 'le trade est compte, le financement aussi');
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
    const v = P.vue(SYM);
    ok(v.papier === true && !JSON.stringify(v).toLowerCase().includes('secret'), 'et la vue le dit : papier');
    ok(Array.isArray(v.agents) && v.agents.length === 8 && v.horizonRef === 240,
       'la vue porte les agents et l echeance de reference (' + v.horizonRef + ' min)');
    /* L essai disait « deux colonies » et recopiait la liste. Son intention
       est qu il y ait UNE colonie par instrument, chacune avec son etat — pas
       qu il y en ait exactement deux : la liste est une variable
       d environnement, elle a vocation a bouger. */
    ok(P.SYMBOLES.length >= 2 && P.SYMBOLES.every((x) => /USDT$/.test(x)),
       P.SYMBOLES.length + ' colonies, une par instrument : ' + P.SYMBOLES.join(', '));
    const e = P.etat('ETHUSDT');
    ok(e.sym === 'ETHUSDT' && e !== P.etat('BTCUSDT'), 'et chacune a son etat, separe de l autre');
    ok(new Set(P.SYMBOLES.map((x) => P.etat(x))).size === P.SYMBOLES.length,
       'aucune colonie n en partage un avec une autre');
  }

  /* ======================================================================
   * 9. L AUDIT COMMUN AUX MARCHES
   *
   * Une regle produit au plus douze ombres par jour et par marche. Douze
   * observations, c est le minimum pour un verdict, et c est un verdict
   * fragile ; une regle qui ne se declenche pas a chaque fenetre met des
   * semaines a les atteindre. Mis en commun, les marches donnent cinq fois
   * l echantillon pour le meme temps ecoule.
   *
   * Mais additionner suppose que la regle se comporte PAREIL partout. Ce
   * qui est mesure ici est surtout ce que l audit commun REFUSE de conclure
   * quand ce n est pas le cas.
   * ==================================================================== */
  console.log('\n-- 9. l audit commun aux marches --');
  {
    /* Deux marches neufs, remplis a la main : on met a l essai l addition et
       le refus d additionner, pas le moteur qui produit les ombres. */
    const A = 'BTCUSDT', B = 'ETHUSDT';
    const poseAudit = (sym, table) => {
      const S = P.etatNeuf(sym);
      for (const cle in table) {
        const [nn, gg] = table[cle];
        S.audit[cle] = { n: nn, s: 0, gagnantes: gg, perdantes: nn - gg };
      }
      P._pose(sym, S);
    };
    for (const sym of P.SYMBOLES) P._pose(sym, P.etatNeuf(sym));

    /* Les deux marches sont d accord : 20 % de gagnantes chez l un, 22 % chez
       l autre, contre 45 % pour ce qu on prend. La regle protege. */
    poseAudit(A, { 'pris': [40, 18], 'Funding · too expensive': [30, 6] });
    poseAudit(B, { 'pris': [40, 18], 'Funding · too expensive': [32, 7] });
    const ref = P.referenceCommune();
    eq(ref.n, 80, 'la reference commune additionne ce que TOUS les marches prennent');
    eq(ref.partGagnantes, 45, 'et sa part de gagnantes porte sur les 80');
    const w = P.verdictCommun('Funding · too expensive');
    eq(w.n, 62, 'la regle est jugee sur 62 observations, pas sur 30');
    eq(w.verdict, 'protects', 'deux marches d accord : elle protege (' + w.partGagnantes + '% contre ' + w.reference + '%)');
    eq(w.marches, 2, 'et le verdict dit sur combien de marches il porte');

    /* ---- CE QU ON N A PAS LE DROIT D ADDITIONNER ----
     * 10 % chez l un, 60 % chez l autre : le total ferait 35 %, un chiffre
     * juste sur rien. La regle ne se comporte pas pareil selon le marche, et
     * la ligne doit le DIRE au lieu de conclure. */
    poseAudit(A, { 'pris': [40, 18], 'Range · too far': [30, 3] });
    poseAudit(B, { 'pris': [40, 18], 'Range · too far': [30, 18] });
    const d = P.verdictCommun('Range · too far');
    eq(d.verdict, 'diverge', 'marches en desaccord : aucun verdict commun');
    ok(d.ecart >= P.DIVERGE_POINTS, 'et l ecart constate est rendu : ' + d.ecart + ' points');
    /* Chaque marche garde son propre verdict : c est la mise en commun qui
       est refusee, pas la mesure. */
    ok(P.verdictRegle(A, 'Range · too far').verdict !== 'diverge',
       'chaque marche garde son verdict a lui : ' + P.verdictRegle(A, 'Range · too far').verdict);

    /* Un seul marche a assez d observations : rien a comparer, donc rien a
       refuser — on additionne, faute de mieux, et la ligne dit sur combien de
       marches elle porte. */
    for (const sym of P.SYMBOLES) P._pose(sym, P.etatNeuf(sym));
    poseAudit(A, { 'pris': [40, 18], 'Regime · chop': [30, 20] });
    const un = P.verdictCommun('Regime · chop');
    ok(un.verdict !== 'diverge', 'un seul marche fourni : pas de divergence possible (' + un.verdict + ')');
    eq(un.marches, 1, 'et la ligne dit qu elle ne porte que sur un marche');

    /* Sous le minimum, aucun verdict — la meme regle que par marche. */
    for (const sym of P.SYMBOLES) P._pose(sym, P.etatNeuf(sym));
    poseAudit(A, { 'Regime · chop': [5, 3] });
    const jeune = P.verdictCommun('Regime · chop');
    eq(jeune.verdict, 'unknown', 'sous douze observations, aucun verdict commun');
    eq(jeune.manque, P.AUDIT_MIN_OBS - 5, 'et il dit combien il en manque');

    /* La vue porte tout ca, et « pris » n est pas une regle de refus. */
    for (const sym of P.SYMBOLES) P._pose(sym, P.etatNeuf(sym));
    poseAudit(A, { 'pris': [40, 18], 'Funding · too expensive': [30, 6] });
    poseAudit(B, { 'pris': [40, 18], 'Funding · too expensive': [32, 7] });
    const vue = P.vue(A);
    ok(vue.commun && Array.isArray(vue.commun.audit), 'la vue de chaque marche porte l audit commun');
    ok(!vue.commun.audit.some((l) => l.cle === 'pris'), 'la reference n y figure pas comme une regle');
    const ligne = vue.commun.audit.find((l) => /Funding/.test(l.cle));
    ok(ligne && ligne.marches[A] && ligne.marches[B], 'chaque ligne porte sa repartition par marche');
    eq(ligne.marches[A].n, 30, 'avec l effectif de chacun');
    eq(vue.commun.symboles.length, P.SYMBOLES.length, 'et la vue nomme les marches suivis');
    /* La borne de divergence est posee SANS mesure : elle doit au moins etre
       lisible, sinon personne ne saura contre quoi la relire. */
    eq(vue.commun.divergePoints, P.DIVERGE_POINTS, 'la borne de divergence est rendue, pas cachee');
  }

  console.log(`\nai_perp.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('  RATE ' + (e.message || e)); console.log(`ai_perp.test.js : RATES : 1/${n + 1}`); process.exit(1); });
