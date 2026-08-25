'use strict';
/*
 * Les cotes fabriquees.
 *
 * Ce qui doit tenir ici n'est pas « le modele a raison » — un Elo ne peut pas
 * avoir raison sur un match, et ce n'est pas ce qu'on lui demande. Ce qui doit
 * tenir, c'est que le module ne puisse jamais produire un catalogue REFUSE au
 * demarrage du serveur, ni une cote qui offre de l'argent.
 *
 * Trois choses, donc, et dans cet ordre d'importance :
 *
 *   1. LA MARGE EST TOUJOURS LA, apres arrondi. C'est le point dur : arrondir
 *      au centieme deplace la marge, et un catalogue sous le plancher empeche
 *      le serveur de demarrer. Un dimanche soir, ca ne se rattrape pas vite.
 *   2. LES BORNES SONT TENUES. Une cote hors de [1,01 ; 100] est refusee par
 *      le validateur ; sur un ecart de force enorme, la formule peut sortir
 *      des valeurs aberrantes si on ne la borne pas.
 *   3. LE SENS EST BON. Le favori paie moins que l'outsider. Ca a l'air
 *      evident et c'est exactement le genre d'inversion de signe qui se glisse
 *      dans une formule Elo sans que rien ne proteste.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paris = require('./paris');
const cotes = require('./cotes');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m} (${a} vs ${b} +-${e})`); n++; };

/* On travaille sur un fichier de forces JETABLE : ce test ne doit jamais
   toucher celui du serveur. */
const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cotes-')), 'notes.json');
cotes.chargeNotes(TMP);

// ---- une equipe inconnue vaut 1500, et deux inconnues se valent
{
  eq(cotes.note('foot', 'Equipe Jamais Vue'), 1500, 'une equipe inconnue vaut 1500');
  const p = cotes.probabilites('tennis', 'A', 'B');
  pres(p['1'], 0.5, 1e-9, 'au tennis, deux inconnus sont a 50/50 — pas d avantage du terrain');
  const f = cotes.probabilites('foot', 'A', 'B');
  ok(f['1'] > f['2'], 'au football, l avantage du terrain penche vers le domicile');
  pres(f['1'] + f['N'] + f['2'], 1, 1e-9, 'les trois probabilites somment a 1');
}

// ---- la cle ignore la casse, les espaces et les accents
{
  eq(cotes.cle('foot', 'Paris  SG'), cotes.cle('foot', 'PARIS sg'),
     'un espace en trop ne cree pas une equipe fantome');
  eq(cotes.cle('foot', 'Bayern München'), cotes.cle('foot', 'Bayern Munchen'),
     'un trema non plus');
  ok(cotes.cle('foot', 'Lyon') !== cotes.cle('tennis', 'Lyon'),
     'mais deux sports ne partagent pas leurs forces');
}

// ---- LE POINT DUR : la marge survit a l'arrondi, sur tout l'eventail
{
  const sports = ['foot', 'tennis', 'nba'];
  let pire = 1, plusCourte = 99, cotes_ = 0, ecartes = 0;
  for (const sport of sports) {
    /* On balaie des ecarts de force de 0 a 1200 points — bien au-dela de ce
       qu'on verra jamais — dans les deux sens. Un ecart trop grand doit etre
       REFUSE, jamais cote de travers : c'est le comportement qu'on verifie. */
    for (let d = -1200; d <= 1200; d += 25) {
      cotes.poseNote(sport, 'DOM', 1500 + d / 2);
      cotes.poseNote(sport, 'EXT', 1500 - d / 2);
      const test = cotes.cotable(sport, 'DOM', 'EXT');
      if (!test.cotable) {
        assert.throws(() => cotes.cotesDe(sport, 'DOM', 'EXT'), /trop desequilibre/,
          `un match injouable doit etre refuse : ${sport} ecart ${d}`);
        ecartes++;
        continue;
      }
      const c = cotes.cotesDe(sport, 'DOM', 'EXT');
      const mg = paris.marge(c, sport);
      pire = Math.min(pire, mg);
      cotes_++;
      for (const i of paris.issues(sport)) {
        assert.ok(c[i] >= paris.COTE_MIN && c[i] <= paris.COTE_MAX,
          `cote hors bornes du validateur : ${sport} ecart ${d} issue ${i} = ${c[i]}`);
        plusCourte = Math.min(plusCourte, c[i]);
        assert.ok(Math.abs(c[i] * 100 - Math.round(c[i] * 100)) < 1e-6,
          `cote non arrondie au centieme : ${c[i]}`);
      }
      assert.ok(mg >= paris.MARGE_MIN,
        `marge sous le plancher du validateur : ${sport} ecart ${d} → ${(mg * 100).toFixed(2)} %`);
    }
  }
  n += 4;
  /* Le balayage va a +-1200 points, volontairement bien plus large qu'un vrai
     championnat : il est la pour prouver que l'extreme est REFUSE proprement,
     pas pour etre representatif. La coupure tombe la ou la cote la plus courte
     passerait sous le plancher. */
  ok(cotes_ >= 150, `${cotes_} rencontres cotees, ${ecartes} ecartees`);
  ok(ecartes > 10, 'et le balayage contient bien des cas injouables, sinon il ne prouve rien');
  ok(pire >= paris.MARGE_MIN, `la pire marge du balayage vaut ${(pire * 100).toFixed(2)} %`);
  ok(pire >= 0.03, 'et elle garde une reserve confortable au-dessus du plancher');
  /* La raison d'etre du refus : aucune cote affichee ne descend a 1,01, ou la
     marge s'effondre et ou l'on paierait plus que le juste. */
  ok(plusCourte >= cotes.COTE_PLANCHER - 1e-9,
     `la cote la plus courte du balayage vaut ${plusCourte} (plancher ${cotes.COTE_PLANCHER})`);
}

// ---- la plage REALISTE est entierement cotable
{
  /* Un championnat reel tient dans 400 points d'ecart : Man City a 1900,
     une equipe de bas de tableau a 1400. Si la coupure mordait la-dedans, on
     ecarterait des rencontres que les joueurs veulent, et c'est ca qu'il faut
     verifier — pas seulement que l'extreme est refuse. */
  let refuses = [];
  for (const sport of ['foot', 'tennis', 'nba']) {
    for (let d = -400; d <= 400; d += 20) {
      cotes.poseNote(sport, 'A', 1500 + d / 2);
      cotes.poseNote(sport, 'B', 1500 - d / 2);
      if (!cotes.cotable(sport, 'A', 'B').cotable) refuses.push(sport + ' ' + d);
    }
  }
  eq(refuses.length, 0, 'aucune rencontre a +-400 points n est ecartee : ' + refuses.join(', '));
}

// ---- un match injouable est ECARTE, pas cote de travers
{
  cotes.poseNote('tennis', 'MONSTRE', 2400);
  cotes.poseNote('tennis', 'AMATEUR', 1200);
  const t = cotes.cotable('tennis', 'MONSTRE', 'AMATEUR');
  ok(!t.cotable, `un favori a ${(t.proba * 100).toFixed(1)} % n est pas un marche`);
  eq(t.favori, '1', 'et on sait de quel cote penche le desequilibre');
  ok(t.plusCourte < cotes.COTE_PLANCHER,
     `la cote sortirait a ${t.plusCourte}, sous le plancher ${cotes.COTE_PLANCHER}`);
  assert.throws(() => cotes.cotesDe('tennis', 'MONSTRE', 'AMATEUR'),
    /trop desequilibre/, 'la cotation le refuse en le disant'); n++;
  /* Le message doit porter les DEUX chiffres : celui qu'on a vu et celui
     qu'on accepte. Sans eux, on ne sait pas de combien on est loin. */
  let msg = '';
  try { cotes.cotesDe('tennis', 'MONSTRE', 'AMATEUR'); } catch (e) { msg = e.message; }
  ok(/%/.test(msg) && /plancher/.test(msg), 'et il dit de combien : ' + msg);

  /* Le meme couple, resserre, redevient jouable. */
  cotes.poseNote('tennis', 'AMATEUR', 2050);
  ok(cotes.cotable('tennis', 'MONSTRE', 'AMATEUR').cotable,
     'resserre, le meme couple redevient cotable');
}

// ---- le sens : le favori paie moins
{
  cotes.poseNote('foot', 'FORT', 1800);
  cotes.poseNote('foot', 'FAIBLE', 1300);
  const c = cotes.cotesDe('foot', 'FORT', 'FAIBLE');
  ok(c['1'] < c['2'], `le favori a domicile paie moins (${c['1']} vs ${c['2']})`);
  const inverse = cotes.cotesDe('foot', 'FAIBLE', 'FORT');
  ok(inverse['2'] < inverse['1'], 'et le sens s inverse quand on echange les equipes');
  ok(c['1'] < inverse['2'], 'le meme favori paie moins a domicile qu a l exterieur');
  ok(c['N'] > 3, `le nul entre deux equipes tres inegales est peu probable, donc cher (${c['N']})`);
}

// ---- la marge demandee est celle qui est prise
{
  cotes.poseNote('foot', 'X', 1500); cotes.poseNote('foot', 'Y', 1500);
  for (const m of [0.05, 0.08, 0.10, 0.15, 0.25]) {
    const mg = paris.marge(cotes.cotesDe('foot', 'X', 'Y', m), 'foot');
    pres(mg, m, 0.01, `marge demandee ${m} → marge prise`);
  }
  /* Une marge trop basse est REMONTEE, jamais acceptee : le validateur refuse
     sous 2 %, et un catalogue refuse empeche le serveur de demarrer. */
  const basse = paris.marge(cotes.cotesDe('foot', 'X', 'Y', 0.001), 'foot');
  ok(basse >= cotes.MARGE_PLANCHER * 0.75,
     `une marge de 0,1 % est remontee au plancher (${(basse * 100).toFixed(2)} %)`);
}

// ---- l apprentissage deplace les forces dans le bon sens
{
  cotes.poseNote('foot', 'P', 1500); cotes.poseNote('foot', 'Q', 1500);
  const avantP = cotes.note('foot', 'P');
  cotes.apprend('foot', 'P', 'Q', '1');
  ok(cotes.note('foot', 'P') > avantP, 'gagner fait monter');
  ok(cotes.note('foot', 'Q') < 1500, 'et perdre fait descendre');
  const somme = cotes.note('foot', 'P') + cotes.note('foot', 'Q');
  pres(somme, 3000, 2, 'le total est conserve, a l arrondi pres');

  /* Un favori qui gagne bouge peu ; un outsider qui gagne bouge beaucoup.
     C'est toute la raison d'etre de l'Elo. */
  cotes.poseNote('foot', 'R', 1900); cotes.poseNote('foot', 'S', 1300);
  cotes.apprend('foot', 'R', 'S', '1');
  const gainFavori = cotes.note('foot', 'R') - 1900;
  cotes.poseNote('foot', 'R', 1900); cotes.poseNote('foot', 'S', 1300);
  cotes.apprend('foot', 'S', 'R', '1');          // l outsider gagne, chez lui
  const gainOutsider = cotes.note('foot', 'S') - 1300;
  ok(gainOutsider > gainFavori * 2,
     `une victoire d outsider vaut plus (+${gainOutsider.toFixed(1)} vs +${gainFavori.toFixed(1)})`);
}

// ---- une cote FABRIQUEE se refait tant que le match n'a pas commence
{
  /* Sans ca, tout le calendrier reste a jamais sur les cotes du premier
     jour — celles ou toutes les equipes valaient 1500 et ou chaque match
     sortait a 2,08 / 3,61 / 2,92. C'est exactement ce qui s'est produit en
     production : les forces ont ete corrigees, les cotes ne bougeaient pas. */
  cotes.poseNote('foot', 'GROS', 1500); cotes.poseNote('foot', 'PETIT', 1500);
  const futur = { id: 'refait-1', sport: 'foot', domicile: 'GROS', exterieur: 'PETIT',
                  debut: new Date(Date.now() + 86400000).toISOString() };
  const a = cotes.habille(futur);
  ok(a.cotesGenerees, 'la premiere cote est fabriquee');
  /* ---- LES COTES VIVENT DANS LEUR MARCHE ----
   * Un match en portait UN, ecrit a plat sous `cotes`. Il en porte six, et le
   * 1-N-2 n'est que le premier. Ce qu'on ECRIT ne porte que des marches ; ce
   * qu'on RELIT accepte encore l'ancienne forme, sans quoi les catalogues
   * deja sur le volume seraient a jeter. D'ou ce lecteur, qui lit les deux. */
  const lotDe = (m) => (m.marches && m.marches[paris.MARCHE_BASE].cotes) || m.cotes;
  ok(!a.cotes, "et le fichier ecrit ne porte PLUS de cotes a plat : deux endroits"
     + " ou lire la cote du « 1 », c est un endroit de trop");

  cotes.poseNote('foot', 'GROS', 1950);        // le favori se revele
  const b = cotes.habille(a);
  ok(lotDe(b)['1'] < lotDe(a)['1'] - 0.2,
     `la cote se refait quand la force change (${lotDe(a)['1']} → ${lotDe(b)['1']})`);

  /* Une rencontre COMMENCEE ne bouge plus : les paris y sont poses a la cote
     affichee, la changer apres coup changerait ce qui a ete accepte. */
  const commence = Object.assign({}, b, { debut: new Date(Date.now() - 3600000).toISOString() });
  cotes.poseNote('foot', 'GROS', 1300);
  eq(lotDe(cotes.habille(commence))['1'], lotDe(b)['1'],
     'une rencontre commencee garde ses cotes, quoi qu il arrive aux forces');

  /* Et une cote RELEVEE A LA MAIN reste intouchable, elle. */
  const main = { id: 'refait-2', sport: 'foot', domicile: 'GROS', exterieur: 'PETIT',
                 debut: new Date(Date.now() + 86400000).toISOString(),
                 cotes: { 1: 1.9, N: 3.5, 2: 4.2 } };
  eq(lotDe(cotes.habille(main))['1'], 1.9, 'une cote relevee a la main ne se refait jamais');

  /* ---- MAIS ELLE NE PRIVE PAS LA RENCONTRE DES CINQ AUTRES MARCHES ----
   *
   * C'ETAIT LE DEFAUT. `if (deja && !cotesGenerees) return m` protegeait bien
   * le 1-N-2 releve — et rendait l'objet AVANT de construire les cinq autres.
   * Or l'import RELEVE ses cotes chez le fournisseur : `cotesGenerees` est
   * faux sur tout le calendrier reel, et les cinq nouveaux marches ne
   * seraient apparus sur RIEN. Mesure a l'epoque sur une rencontre cotee
   * 1,30 / 5,50 / 9,00 : « marches : AUCUN ».
   */
  const hMain = cotes.habille(main);
  /* Teste AVANT de lire les cles : sans cette ligne, le defaut se manifeste par
     un « Cannot convert undefined to object » a la ligne suivante — vrai, mais
     muet sur ce qui manque. */
  ok(!!hMain.marches,
     'une rencontre au 1-N-2 releve recoit bien des marches, et ne revient pas nue');
  eq(Object.keys(hMain.marches || {}).sort().join(','),
     paris.marchesDuSport('foot').slice().sort().join(','),
     'une rencontre au 1-N-2 releve porte quand meme les six marches');
  eq(hMain.cotesGenerees, false,
     'et son drapeau reste faux : la cote est recopiee, pas inventee — le'
     + ' marquer « fabrique » ferait croire le contraire le jour d une reclamation');

  /* ---- ET LES CINQ DESCENDENT DES COTES AFFICHEES, PAS DE L'ELO ----
   *
   * C'est la seconde moitie du meme defaut, et la plus chere. Sur une
   * rencontre dont le 1-N-2 vient d'un bookmaker, des marches calcules sur
   * notre Elo expriment un AUTRE avis que celui affiche juste a cote — et
   * l'ecart entre deux prix du meme evenement sur la meme page est exactement
   * l'arbitrage qu'on offre a qui sait compter.
   *
   * On le mesure sur des equipes que l'Elo NE CONNAIT PAS : il les croit
   * egales, la cote dit qu'elles ne le sont pas du tout. Si les marches
   * suivaient l'Elo, le handicap serait le meme des deux cotes.
   */
  const inconnues = { id: 'incoherent', sport: 'foot',
                      domicile: 'Inconnue-A', exterieur: 'Inconnue-B',
                      debut: new Date(Date.now() + 86400000).toISOString(),
                      cotes: { 1: 1.30, N: 5.50, 2: 9.00 } };
  const hi = cotes.habille(inconnues);
  const pi = cotes.probasImplicites(lotDe(hi), ['1', 'N', '2'], 1);
  const pe = cotes.probabilites('foot', 'Inconnue-A', 'Inconnue-B');
  ok(Math.abs(pi['1'] - pe['1']) > 0.2,
     `les cotes affichees et l Elo sont TRES loin l un de l autre :`
     + ` ${(pi['1'] * 100).toFixed(1)} % contre ${(pe['1'] * 100).toFixed(1)} %`
     + ' — sans cet ecart, l essai qui suit ne verifierait rien');
  const lam = cotes.ajusteButs(pi['1'], pi.N, pi['2']);
  const rendu = cotes.issuesDeLaGrille(cotes.grilleDesScores(lam.lh, lam.la));
  ok(Math.abs(rendu['1'] - pi['1']) < 0.01,
     `et le modele de buts reproduit les COTES : ${(pi['1'] * 100).toFixed(1)} %`
     + ` demande, ${(rendu['1'] * 100).toFixed(1)} % rendu`);
  /* Le handicap le dit tout seul : un favori a 75 % le passe souvent, un
     favori a 45 % non. Deux cotes tres differentes, donc, et c'est ce qu'on
     verifie plutot que le detail du calcul. */
  const hEgal = cotes.habille({ id: 'egal', sport: 'foot',
                                domicile: 'Inconnue-A', exterieur: 'Inconnue-B',
                                debut: new Date(Date.now() + 86400000).toISOString() });
  ok(hi.marches.hand.cotes['1'] < hEgal.marches.hand.cotes['1'] - 0.5,
     `le handicap suit la cote et non l Elo : ${hi.marches.hand.cotes['1']} sur la`
     + ` rencontre relevee, ${hEgal.marches.hand.cotes['1']} sur la meme affiche`
     + ' cotee par notre modele');

  /* ---- L ALLER-RETOUR EST EXACT ----
   * `probasImplicites` est l'inverse de la methode par puissance qui pose les
   * cotes. Une simple normalisation des inverses, elle, est biaisee : elle
   * repartit la marge a proportion egale alors qu'elle pese plus sur les
   * outsiders, et rendrait le favori trop probable. */
  const p0 = cotes.probabilites('foot', 'GROS', 'PETIT');
  const lot0 = cotes.habilleUnMarche(p0, ['1', 'N', '2'], 1, 0.10);
  const re = cotes.probasImplicites(lot0.cotes, ['1', 'N', '2'], 1);
  for (const k of ['1', 'N', '2']) {
    ok(Math.abs(re[k] - p0[k]) < 0.002,
       `aller-retour sur « ${k} » : ${(p0[k] * 100).toFixed(2)} % → ${lot0.cotes[k]}`
       + ` → ${(re[k] * 100).toFixed(2)} %`);
  }
  const sre = ['1', 'N', '2'].reduce((t, k) => t + re[k], 0);
  ok(Math.abs(sre - 1) < 1e-6, `et elles somment a un (${sre.toFixed(9)}), marge retiree`);
}

// ---- une cote deja presente n'est JAMAIS remplacee
{
  const m = { id: 'x-1', sport: 'foot', domicile: 'A', exterieur: 'B',
              debut: '2030-01-01T12:00:00Z', cotes: { 1: 1.9, N: 3.5, 2: 4.2 } };
  const lot2 = (x) => (x.marches && x.marches[paris.MARCHE_BASE].cotes) || x.cotes;
  const h = cotes.habille(m);
  eq(lot2(h)['1'], 1.9, 'une cote relevee a la main survit');
  ok(!h.cotesGenerees, 'et elle n est pas marquee comme fabriquee');

  const nu = { id: 'x-2', sport: 'foot', domicile: 'A', exterieur: 'B',
               debut: '2030-01-01T12:00:00Z' };
  const g = cotes.habille(nu);
  ok(g.cotesGenerees, 'une cote absente est fabriquee, et le dit');
  ok(lot2(g)['1'] > 1 && lot2(g).N > 1 && lot2(g)['2'] > 1, 'et les trois sont la');
  /* ---- ET LES CINQ AUTRES MARCHES AVEC ----
   * Ils ne coutent pas un credit d'API de plus : ils descendent du MEME couple
   * de moyennes de buts que le 1-N-2, ajuste pour le reproduire. */
  eq(Object.keys(g.marches).sort().join(','), '1n2,btts,dc,hand,ou25,score',
     'une rencontre de football fabriquee porte les six marches');

  /* Une cote PARTIELLE est un piege : deux issues sur trois relevees, la
     troisieme oubliee. Elle doit etre completee, pas laissee telle quelle —
     sinon le validateur jette au demarrage. */
  const bancal = { id: 'x-3', sport: 'foot', domicile: 'A', exterieur: 'B',
                   debut: '2030-01-01T12:00:00Z', cotes: { 1: 1.9, N: 3.5 } };
  const r = cotes.habille(bancal);
  ok(isFinite(Number(lot2(r)['2'])), 'une cote partielle est refaite en entier');
  ok(!r.cotes, 'et elle repart en marches, sans laisser trainer l ancienne forme');
}

// ---- un catalogue entier passe le validateur du serveur
{
  const equipes = ['Lyon', 'Monaco', 'Lille', 'Rennes', 'Nice', 'Lens'];
  equipes.forEach((e, i) => cotes.poseNote('foot', e, 1350 + i * 90));
  const brut = {
    sports: [{ cle: 'foot', nom: 'Football', actif: true },
             { cle: 'tennis', nom: 'Tennis', actif: true }],
    matchs: [],
  };
  for (let i = 0; i < equipes.length; i += 2) {
    brut.matchs.push({ id: 'gen-foot-' + i, sport: 'foot', competition: 'Ligue 1',
      domicile: equipes[i], exterieur: equipes[i + 1],
      debut: new Date(Date.now() + (i + 1) * 86400000).toISOString() });
  }
  brut.matchs.push({ id: 'gen-tennis-1', sport: 'tennis', competition: 'ATP',
    domicile: 'Alcaraz', exterieur: 'Sinner',
    debut: new Date(Date.now() + 86400000).toISOString() });

  const pret = cotes.habilleCatalogue(brut);
  eq(pret.matchs.length, 4, 'les quatre rencontres sont habillees');
  ok(pret.matchs.every((m) => m.cotesGenerees), 'toutes leurs cotes sont fabriquees');

  /* La preuve qui compte : on le fait relire par le VALIDATEUR du serveur,
     celui-la meme qui tourne au demarrage. */
  const v = paris.valide(pret);
  eq(v.matchs.length, 4, 'et le validateur du serveur les accepte');
  ok(v.matchs.every((m) => m.marge >= paris.MARGE_MIN), 'avec une marge suffisante partout');
  eq(v.matchs.find((m) => m.sport === 'tennis').issues.length, 2,
     'le tennis garde ses deux issues');
}

// ---- le fichier des forces se relit tel qu il a ete ecrit
{
  cotes.poseNote('foot', 'Sauvegarde FC', 1777);
  cotes.sauveNotes(TMP);
  cotes.chargeNotes(TMP);
  eq(cotes.note('foot', 'Sauvegarde FC'), 1777, 'une force ecrite se relit');
  eq(cotes.note('foot', 'sauvegarde  fc'), 1777, 'meme ecrite autrement');
}

console.log(`cotes.test.js : ${n} verifications OK`);
