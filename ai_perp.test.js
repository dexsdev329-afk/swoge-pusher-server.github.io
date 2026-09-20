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
    const S2 = neuf();
    P.noteOmbre(x0, 1, null, null, {});
    S2.ombres[0].t = Date.now() - 400 * 60000;            /* la fenetre des 4 h est passee */
    P.regleLesOmbres({ [SYM]: x1 });
    ok(!S2.audit['pris'], 'et une ombre relue hors de la fenetre ne remplit rien : un jalon rate reste vide');
  }

  console.log('\n-- 4. les deux sens, chacun sa ligne, jugee contre ce qu on prend --');
  {
    const S = neuf();
    /* Une regle qui ecarte des perdants protege ; une qui ecarte des gagnants coute. */
    for (let i = 0; i < 20; i++) P.noteAudit('pris', i < 8 ? 3 : -2);          /* 40 % de gagnantes */
    for (let i = 0; i < 20; i++) P.noteAudit('regime · storm', -3);            /* 0 % */
    for (let i = 0; i < 20; i++) P.noteAudit('tendance · long against a deep downtrend', 4); /* 100 % */
    const ref = P.reference();
    eq(ref.partGagnantes, 40, 'la reference est ce qu on PREND : ' + ref.partGagnantes + ' % de gagnantes sur ' + ref.n);
    eq(P.verdictRegle('regime · storm').verdict, 'protects',
       'une regle qui n ecarte que des perdants protege');
    eq(P.verdictRegle('tendance · long against a deep downtrend').verdict, 'costs',
       'une regle qui n ecarte que des gagnants coute — et il faut la relire');
    P.noteAudit('jamais vue', 1);
    eq(P.verdictRegle('jamais vue').verdict, 'unknown', 'et sous le minimum, on ne conclut pas');
    eq(P.verdictRegle('jamais vue').manque, P.AUDIT_MIN_OBS - 1, 'en disant combien il manque');
    ok(P.auditDesRefus().every((l) => l.n >= 3), 'le tableau ecarte ce qui a moins de trois observations');
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
   * Ce n etait pas une panne mais une contradiction : la NOTE est
   * contrariante (financement, couloir, journee : 28 points sur 48 poussent
   * contre le mouvement), le VETO suit la tendance. Quand le fond monte, le
   * short est le cote que la note aime et que le veto interdit ; le long est
   * celui que le veto autorise et que la note deteste. L intersection est
   * vide — dans l etat de marche le plus frequent.
   *
   * Et pire : `reference()` exige douze « pris » pour exister. Sans rien de
   * pris, aucune regle ne peut JAMAIS etre jugee. Meme roue a cliquet que la
   * colonie de jetons le 12 septembre, meme reponse : une soupape.
   * ==================================================================== */
  console.log('\n-- 11. la soupape de famine --');
  {
    /* L etat bloque, reproduit : un FOND marque (pente des bougies de quatre
       heures) avec une volatilite COURTE calme, donc aucun refus de securite.
       Le seuil du mur de tendance a deja bouge une fois — 4 % le 19
       septembre, 8 % le 20, parce que l audit disait qu il coutait — donc la
       pente est CHOISIE pour le depasser, quel qu il soit : un essai qui
       recopie un seuil se casse a chaque mesure. */
    neuf();
    const S = P.etat();
    let haut = null, fondVu = 0;
    for (let p4 = 0.2; p4 <= 4 && !haut; p4 += 0.15) {
      const m = marche({ prix: 80000, pente: 0.03, pente4: p4, bruit: 0.12 });
      const x = P.mesures(m);
      if (x.fond > P.FOND_MUR * 1.15) { haut = m; fondVu = x.fond; }
    }
    ok(!!haut, 'un fond de ' + fondVu.toFixed(1) + ' % depasse le mur de ' + P.FOND_MUR + ' %');
    ok(P.mesures(haut).vol15 < 0.6, 'sans declencher le refus de tempete, qui est un refus de SECURITE');
    let r = await P.tour({ marches: { BTCUSDT: haut } });
    const short = r.verdicts.find((v) => v.sens < 0);
    const long = r.verdicts.find((v) => v.sens > 0);
    ok(short && /uptrend/.test(short.refus || ''), 'le short est refuse par l avis de tendance : « ' + (short && short.refus) + ' »');
    ok(long && long.refus, 'et le long ne passe pas non plus : « ' + (long && long.refus) + ' »');
    eq(r.ouvert, 0, 'donc rien ne s ouvre — c est le blocage');
    eq(S.disette, 1, 'la disette se compte');

    /* Les tours passent. Le premier a deja compte : il en reste
       FAMINE_TOURS - 2 avant celui qui ouvre la soupape. */
    for (let i = 2; i <= P.FAMINE_TOURS - 1; i++) r = await P.tour({ marches: { BTCUSDT: haut } });
    eq(S.disette, P.FAMINE_TOURS - 1, 'la disette monte, et rien ne s est ouvert avant l heure');
    eq(S.positions.length, 0, 'la soupape ne s ouvre pas une seconde trop tot');
    r = await P.tour({ marches: { BTCUSDT: haut } });
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
    ok((S.compteurs.plafondPositions || 0) + (S.compteurs.dejaSurCeMarche || 0) > 0,
       'et les deux raisons de ne rien faire sont comptees SEPAREMENT : plafond '
       + (S.compteurs.plafondPositions || 0) + ', marche deja tenu ' + (S.compteurs.dejaSurCeMarche || 0));

    /* Chaque position garde son marche, et se surveille au prix du sien. */
    const avant = S.positions.length;
    const p0 = S.positions[0];
    const contre = p0.prix0 * (1 - p0.sens * 0.05);
    P.surveille({ [p0.sym]: { prix: contre } });
    eq(S.positions.length, avant - 1, 'un stop ne ferme que la position de SON marche');
    eq(S.carnet[0].sym, p0.sym, 'et le carnet dit lequel : ' + S.carnet[0].sym);
  }

  console.log(`\nai_perp.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('  RATE ' + (e.message || e)); console.log(`ai_perp.test.js : RATES : 1/${n + 1}`); process.exit(1); });
