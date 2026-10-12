'use strict';
/*
 * LE CRICKET SE REGLE PAR L'EN-TETE D'ESPN — JUSTEMENT, OU PAS DU TOUT.
 *
 * Ce que l'essai tient (scores_espn.js, `releveCricket`, et `finies`) :
 *  1. un T20I bilateral se trouve par l'EN-TETE, jour par jour — jamais par
 *     'cricket/8039' (la Coupe du monde ODI 2027, 0 rencontre avant 10/2027) ;
 *  2. le resultat sort dans NOTRE orientation, lu sur le camp qui porte le nom
 *     de notre domicile ;
 *  3. il ne se tranche que sur `fullStatus.type.id` : 1 « post » avec un seul
 *     vainqueur et des runs des deux cotes -> '1' | '2' ; 3, 5 et 6 -> la main,
 *     raison ecrite ; tout le reste (0 « Final », 113, forfait…) -> rien ;
 *  4. les refus : un jour refuse (le 502 reel, redemande une fois), un format
 *     d'une autre cle (l'ODI de la meme tournee), une plus proche qui n'est
 *     pas a moins de 2 h ni a 2 h de moins que la suivante (jumelle absente,
 *     point milieu), deux des notres sur une meme rencontre ESPN, une heure
 *     non valide, deux copies qui different, des noms absents -> rien ; ESPN
 *     qui la fait commencer avant notre heure -> la main ;
 *  5. le cricket ne peut plus jamais sortir « 0-0 » ni 'N' par `releve` ;
 *  6. une lettre ne se paie qu'AUTO_DELAI_MIN apres sa premiere lecture, et
 *     chaque changement d'issue laisse une ligne de journal (relecture du
 *     12/10 au soir : sections 13 a 17).
 *
 * Les en-tetes sont de VRAIES reponses (essais/cricket/, releves le
 * 12/10/2026 entre 19:45 et 19:54Z, URL et heure dans index.json), elaguees
 * aux rencontres et aux champs lus. Les cas DERIVES (forfait, deux candidats a
 * 1 h, copies divergentes, chaine "true", heure non valide) sont fabriques ICI
 * a partir d'une vraie rencontre, et dits comme tels. Aucun appel reseau : le
 * faux `fetch` refuse tout jour absent des copies (une panne, jamais une liste
 * vide).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const e = require('./scores_espn');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

const DOSSIER = path.join(__dirname, 'essais', 'cricket');
const INDEX = JSON.parse(fs.readFileSync(path.join(DOSSIER, 'index.json'), 'utf8'));
const COPIE = (j) => JSON.parse(fs.readFileSync(path.join(DOSSIER, 'entete_' + j + '.json'), 'utf8'));
const BRUT_502 = fs.readFileSync(path.join(DOSSIER, 'entete_20260817_502.json'), 'utf8');
const H = 3600000;

/* Le faux reseau : les copies du depot, jour par jour ; `surcharge` remplace
   un jour (cas derives, refus). Toute autre adresse ou tout jour absent LEVE. */
function reseau(surcharge) {
  const urls = [];
  const enVol = { n: 0, max: 0 };
  const departs = [];
  const prendre = async (u) => {
    urls.push(String(u));
    departs.push(Date.now());
    enVol.n++; enVol.max = Math.max(enVol.max, enVol.n);
    try {
      await new Promise((r) => setTimeout(r, 2));
      const x = new URL(String(u));
      if (x.hostname !== 'site.web.api.espn.com' || x.pathname !== '/apis/v2/scoreboard/header') throw new Error('adresse interdite : ' + u);
      const j = x.searchParams.get('dates');
      const s = surcharge && surcharge[j];
      if (s && s.statut) return { ok: false, status: s.statut, json: async () => JSON.parse(s.corps) };
      if (s && s.leve) throw new Error(s.leve);
      const corps = s ? s.corps : (fs.existsSync(path.join(DOSSIER, 'entete_' + j + '.json')) ? COPIE(j) : null);
      if (!corps) throw new Error('jour absent des copies : ' + j);
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(corps)) };
    } finally { enVol.n--; }
  };
  return { prendre, urls, enVol, departs };
}
/* Une rencontre de NOTRE catalogue (forme de paris.catalogue().matchs : debut en ms). */
const M = (id, ligue, dom, ext, debutIso) => ({ id, sport: 'cricket', domicile: dom, exterieur: ext,
  debut: Date.parse(debutIso), source: { fournisseur: 'the-odds-api', ligue, evenement: id } });
/* Une vraie rencontre d'une copie, a deriver. */
function evDe(j, id) {
  const c = COPIE(j);
  for (const l of c.sports[0].leagues) for (const ev of l.events) if (String(ev.id) === String(id)) return { c, l, ev };
  throw new Error('rencontre ' + id + ' absente de la copie ' + j);
}
const opts = (r, plus) => Object.assign({ prendre: r.prendre, pauseMs: 0 }, plus || {});

(async () => {
  // ================== 0. LES COPIES SONT DES RELEVES DATES
  console.log('\n-- les copies de l en-tete --');
  {
    ok(/^https:\/\/site\.web\.api\.espn\.com\/apis\/v2\/scoreboard\/header\?sport=cricket&lang=en&region=us&dates=AAAAMMJJ$/.test(INDEX.modele),
       'l index nomme l adresse de l en-tete');
    for (const [f, v] of Object.entries(INDEX.fichiers)) {
      ok(fs.existsSync(path.join(DOSSIER, f)), f + ' existe');
      ok(/^2026-10-12T19:\d\d:\d\dZ$/.test(v.releve) && /dates=\d{8}$/.test(v.url), f + ' porte son URL et son heure de releve (' + v.releve + ')');
    }
    eq(e.ENTETE_CRICKET, 'https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=cricket&lang=en&region=us&dates=', 'le module lit la meme adresse');
  }

  // ================== 1. L'INTENTION : UN T20I BILATERAL SE TROUVE PAR L'EN-TETE, PAS PAR 8039
  console.log('\n-- un T20I bilateral, par l en-tete --');
  {
    ok(!Object.keys(e.CHEMINS).some((k) => /^cricket_/.test(k)), 'CHEMINS ne porte plus aucune cle cricket');
    ok(!Object.values(e.CHEMINS).some((v) => /cricket|8039/.test(v)), 'ni aucun tableau cricket (8039 = Coupe du monde ODI 2027)');
    const r = reseau();
    const m = M('pak-sl-1110', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z');
    const x = await e.releveCricket([m], opts(r));
    const s = x.par.get(m.id);
    ok(!!s, 'Pakistan v Sri Lanka du 11/10 est trouve');
    eq(s.espn, '1550709', 'c est la rencontre ESPN 1550709');
    eq(s.ligueEspn, '24707', 'de la tournee 24707 (Sri Lanka au Pakistan), que rien ne nomme a l avance');
    eq(r.urls.length, 3, 'trois requetes : J-1, J, J+1');
    eq(r.urls.map((u) => new URL(u).searchParams.get('dates')).join(','), '20261010,20261011,20261012', 'un jour par requete, autour du jour UTC du debut');
    ok(r.urls.every((u) => u.startsWith(e.ENTETE_CRICKET)), 'toutes a l en-tete, aucune a un tableau de ligue');
    eq(JSON.stringify(e.joursCricket(Date.parse('2026-10-14T01:15:00Z'))), '["20261013","20261014","20261015"]', 'un debut a 01:15Z demande aussi la veille (date locale des Ameriques) et le lendemain');
    eq(e.joursCricket(NaN).length, 0, 'un debut illisible ne demande rien');
  }

  // ================== 2. VICTOIRES, DANS NOTRE ORIENTATION
  console.log('\n-- qui a gagne, dans notre orientation --');
  {
    /* deux lots : une rencontre ESPN n est prise que par UNE des notres (voir la
       section 14) — l orientation inversee se joue donc dans son propre lot */
    const r = reseau();
    const lot = [
      M('dom-pak', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z'),       // 1550709 Pakistan (domicile) gagne
      M('dom-ind', 'cricket_international_t20', 'India', 'West Indies', '2026-10-11T13:30:00Z'),         // 1529232 India (domicile) gagne
      M('ext-wi', 'cricket_international_t20', 'India', 'West Indies', '2026-10-09T13:30:00Z'),          // 1529231 West Indies (exterieur) gagne
    ];
    const inverses = [
      M('inv-wi', 'cricket_international_t20', 'West Indies', 'India', '2026-10-09T13:30:00Z'),          // 1529231, notre domicile = leur exterieur
      M('inv-pak', 'cricket_international_t20', 'Sri Lanka', 'Pakistan', '2026-10-11T13:00:00Z'),       // 1550709 a l envers
    ];
    const f = (await e.finies(lot, opts(r))).concat(await e.finies(inverses, opts(reseau())));
    const par = Object.fromEntries(f.map((x) => [x.id, x]));
    eq(par['dom-pak'] && par['dom-pak'].resultat, '1', 'victoire a domicile (1550709, Pakistan 215/3) : 1');
    eq(par['dom-ind'] && par['dom-ind'].resultat, '1', 'victoire a domicile (1529232, India 223) : 1');
    eq(par['ext-wi'] && par['ext-wi'].resultat, '2', 'victoire a l exterieur (1529231, West Indies 252/4) : 2');
    eq(par['inv-wi'] && par['inv-wi'].resultat, '1', 'orientation inversee : notre domicile West Indies a gagne -> 1, jamais la position ESPN');
    eq(par['inv-pak'] && par['inv-pak'].resultat, '2', 'orientation inversee : notre exterieur Pakistan a gagne -> 2');
    ok(f.every((x) => x.source === 'espn' && x.sport === 'cricket' && x.score === undefined && !x.aMain),
       'une LETTRE, sans score (« 215/3 » n est pas un score 2-1), source espn, rien a la main');
    ok(f.every((x) => typeof x.vuFini === 'number' && x.vuFini > 0), 'chaque lettre porte l heure de sa premiere lecture (vuFini)');
    eq(r.urls.map((u) => new URL(u).searchParams.get('dates')).join(','), '20261008,20261009,20261010,20261011,20261012',
       'trois rencontres sur cinq jours distincts : chaque jour demande UNE fois, dans l ordre');
  }

  // ================== 3. SANS RESULTAT ET ABANDON : LA MAIN, AVEC LA RAISON
  console.log('\n-- sans resultat, abandon : a la main --');
  {
    const r = reseau();
    const lot = [
      M('nr-hk', 'cricket_international_t20', 'Hong Kong', 'Maldives', '2026-10-12T01:15:00Z'),     // 1554578 id 5, « 104/3 (13/20 ov) » d un cote
      M('ab-afg', 'cricket_international_t20', 'Afghanistan', 'India', '2026-09-28T05:00:00Z'),     // 1552773 id 6, sans une balle
    ];
    const f = await e.finies(lot, opts(r));
    const par = Object.fromEntries(f.map((x) => [x.id, x]));
    ok(!!par['nr-hk'] && !!par['ab-afg'], 'les deux sont rendues — pour la main, pas pour le paiement');
    eq(par['nr-hk'].resultat, null, 'sans resultat : aucune lettre, malgre le score partiel de Hong Kong');
    ok(/sans resultat/.test(par['nr-hk'].aMain) && /status\.type\.id 5/.test(par['nr-hk'].aMain) && /1554578/.test(par['nr-hk'].aMain),
       'la raison est ecrite : ' + par['nr-hk'].aMain);
    eq(par['ab-afg'].resultat, null, 'abandon : aucune lettre');
    ok(/abandon/.test(par['ab-afg'].aMain) && /status\.type\.id 6/.test(par['ab-afg'].aMain), 'la raison : ' + par['ab-afg'].aMain);
    ok(/aucun remboursement automatique, a trancher a la main/.test(par['ab-afg'].aMain), 'et ce qu il reste a faire : a la main (aucun remboursement automatique dans le code)');
    ok(!/\/paris\//.test(par['ab-afg'].aMain), 'sans nommer de route d admin : la raison part sur le canal public');
    ok(f.every((x) => x.score === undefined), 'jamais de score « 0-0 » fabrique pour un abandon');
  }

  // ================== 4. L'EGALITE : JAMAIS UNE LETTRE ; TOUT LE RESTE : RIEN
  console.log('\n-- egalite a la main ; forfait, « Final » sans donnees, reporte : rien --');
  {
    /* l egalite (1551858, Boland v Easterns, super over gagne par Boland dans le seul texte) :
       « Twenty20 » est bien le format du Blast — elle arrive jusqu au verdict, qui ne donne
       aucune lettre (nos deux issues ne disent pas qui gagne une egalite) et l envoie a la
       main avec sa raison : elle est annoncee, et ne paie plus de /scores (relecture du 12/10) */
    const r = reseau();
    const tie = M('tie', 'cricket_t20_blast', 'Boland', 'Easterns', '2026-10-08T16:00:00Z');
    const x = await e.releveCricket([tie], opts(r));
    const l = x.lignes[0];
    eq(l.resultat, 'main', 'egalite (id 3) : a la main, jamais une lettre');
    ok(/egalite/.test(l.raison) && /status\.type\.id 3/.test(l.raison) && /1551858/.test(l.raison), 'raison : ' + l.raison);
    const ft = await e.finies([tie], opts(reseau()));
    eq(ft.length + '|' + ft[0].resultat, '1|null', 'finies la rend, sans lettre');
    ok(/egalite/.test(ft[0].aMain), 'avec aMain : ' + ft[0].aMain);
    const vrai = evDe('20261008', '1551858').ev;
    eq(vrai.fullStatus.type.description, 'Result', 'son `description` dit pourtant « Result », comme une victoire : on ne lit QUE l id');
    eq(vrai.fullStatus.type.detail, 'Final', 'et son `detail` « Final »');
    ok(vrai.competitors.every((c) => c.winner === false), 'winner faux des deux cotes');
    eq(vrai.fullStatus.longSummary, 'Match tied (Boland won the Super Over)', 'le vainqueur du super over n est que dans le texte : il n est jamais lu');

    /* id 1 encore « in », ou des scores sans un run (DERIVES de 1550709) : rien */
    const pak = M('pak-in', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z');
    const di = evDe('20261011', '1550709');
    di.ev.fullStatus.type.state = 'in';
    const xi = await e.releveCricket([pak], opts(reseau({ 20261011: { corps: di.c } })));
    eq(xi.lignes[0].resultat, 'rien', 'id 1 et un vainqueur, mais « in » : rien (les 491 id 1 releves sont « post »)');
    const dz = evDe('20261011', '1550709');
    dz.ev.competitors.forEach((c) => { c.score = '0'; });
    eq((await e.releveCricket([pak], opts(reseau({ 20261011: { corps: dz.c } })))).lignes[0].resultat, 'rien',
       'id 1 avec « 0 » des deux cotes : rien (le plus petit score des 491 id 1 est 13)');
    const dx = evDe('20261011', '1550709');
    dx.ev.competitors[1].score = 'forfeit';
    eq((await e.releveCricket([pak], opts(reseau({ 20261011: { corps: dx.c } })))).lignes[0].resultat, 'rien',
       'un score qui ne commence pas par des runs (« forfeit ») : rien');

    /* « Final » sans donnees (id 0, state post) et reporte (id 113, state post), au verdict direct */
    const zero = e.lisCricket(evDe('20261011', '1554713').ev, '1554704');
    eq(zero.statutId + '|' + zero.etat, '0|post', '1554713 : id 0, state post (« Final » sans donnees)');
    ok(e.verdictCricket(zero).rien && !e.verdictCricket(zero).main, 'id 0 « Final » : rien');
    const rep = e.lisCricket(evDe('20261011', '1546542').ev, '8050');
    eq(rep.statutId + '|' + rep.etat, '113|post', '1546542 : id 113, state post (reporte)');
    ok(e.verdictCricket(rep).rien, 'id 113 : rien — « post » ne veut pas dire fini');
    eq(e.verdictCricket(Object.assign({}, zero, { statutId: '3' })).main, 'egalite', 'status.type.id 3 : la main, jamais une lettre');
    for (const id of ['4', '0', '112', '113', '2', '7', '', 'Result']) {
      const v = e.verdictCricket(Object.assign({}, zero, { statutId: id }));
      ok(v.rien && !v.gagnant && !v.main, 'status.type.id « ' + id + ' » : rien');
    }

    /* le FORFAIT (forme de 1540298 : id 1, un vainqueur, scores vides) — DERIVE de 1550709 */
    const d = evDe('20261011', '1550709');
    d.ev.competitors.forEach((c) => { c.score = ''; });
    const rf = reseau({ 20261011: { corps: d.c } });
    const forfait = M('forfait', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z');
    const xf = await e.releveCricket([forfait], opts(rf));
    eq(xf.lignes[0].resultat, 'rien', 'id 1 et un vainqueur, mais aucun score : rien (forfait sans balle jouee)');
    ok(/forfait/.test(xf.lignes[0].raison), 'raison : ' + xf.lignes[0].raison);
    const d2 = evDe('20261011', '1550709');
    d2.ev.competitors[1].score = '  ';
    const xf2 = await e.releveCricket([forfait], opts(reseau({ 20261011: { corps: d2.c } })));
    eq(xf2.lignes[0].resultat, 'rien', 'un seul score vide (des espaces) suffit a refuser');
    const d3 = evDe('20261011', '1550709');
    d3.ev.competitors[1].winner = true;
    const xf3 = await e.releveCricket([forfait], opts(reseau({ 20261011: { corps: d3.c } })));
    eq(xf3.lignes[0].resultat, 'rien', 'id 1 avec DEUX vainqueurs : rien');
    const d4 = evDe('20261011', '1550709');
    d4.ev.competitors[0].winner = false;
    eq((await e.releveCricket([forfait], opts(reseau({ 20261011: { corps: d4.c } })))).lignes[0].resultat, 'rien', 'id 1 sans vainqueur : rien');
  }

  // ================== 5. "true" EN CHAINE : LA FORME DU TABLEAU ET DU SUMMARY
  console.log('\n-- winner booleen ou chaine --');
  {
    const m = M('chaine', 'cricket_international_t20', 'India', 'West Indies', '2026-10-09T13:30:00Z');
    const d = evDe('20261009', '1529231');
    d.ev.competitors.forEach((c) => { c.winner = c.winner ? 'true' : 'false'; });
    const x = await e.releveCricket([m], opts(reseau({ 20261009: { corps: d.c } })));
    eq(x.par.get('chaine').resultat, '2', 'winner "true"/"false" (DERIVE de 1529231, forme du tableau 19601) : le meme verdict');
    const d2 = evDe('20261009', '1529231');
    d2.ev.competitors.forEach((c) => { c.winner = c.winner ? 'TRUE' : 'false'; });
    eq((await e.releveCricket([m], opts(reseau({ 20261009: { corps: d2.c } })))).lignes[0].resultat, 'rien', '« TRUE » n est ni le booleen ni la chaine lue : rien');
  }

  // ================== 6. LES REFUS D'APPARIEMENT
  console.log('\n-- introuvable, deux candidats, mauvais format, heure non valide, copies divergentes --');
  {
    /* introuvable */
    const intr = M('intr', 'cricket_international_t20', 'Pakistan', 'England', '2026-10-11T13:00:00Z');
    const xi = await e.releveCricket([intr], opts(reseau()));
    eq(xi.lignes[0].resultat, 'sans', 'Pakistan v England n existe pas a l en-tete : sans');
    eq(xi.par.size, 0, 'et rien n est rendu');
    eq((await e.finies([intr], opts(reseau()))).length, 0, 'finies non plus');
    /* une serie a deux jours : le 10/10 a 13:00 n est a 12 h ni du 09 ni du 11 */
    const entre = M('entre', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-10T13:00:00Z');
    eq((await e.releveCricket([entre], opts(reseau()))).lignes[0].resultat, 'sans', 'serie Pakistan v Sri Lanka (09 et 11/10) : un debut le 10 ne prend ni l une ni l autre (24 h > 12 h)');

    /* le double programme reel a quatre heures : le PLUS PROCHE, et le bon */
    const tot = M('tot', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T15:30:00Z');
    const tard = M('tard', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T19:30:00Z');
    const xd = await e.releveCricket([tot, tard], opts(reseau()));
    eq(xd.par.get('tot').espn + '=' + xd.par.get('tot').resultat, '1552795=1', 'double programme du 24/09, 15:30 : 1552795, Cayman Islands gagne (215/3)');
    eq(xd.par.get('tard').espn + '|' + (xd.par.get('tard').resultat || ''), '1552798|', '19:30 : 1552798, sans resultat — jamais la victoire de 15:30');
    ok(/sans resultat/.test(xd.par.get('tard').aMain), 'et il part a la main');

    /* deux candidats a moins de 2 h : DERIVE du double programme reel du 05/10 (1555138 avance a 02:00Z) */
    const d = evDe('20261005', '1555138');
    d.ev.date = '2026-10-05T02:00:00Z';
    const proche = M('proche', 'cricket_international_t20', 'South Korea', 'Indonesia', '2026-10-05T01:00:00Z');
    const xp = await e.releveCricket([proche], opts(reseau({ 20261005: { corps: d.c } })));
    eq(xp.lignes[0].resultat, 'ambigu', 'deux South Korea v Indonesia a 1 h l un de l autre : rien');
    eq(xp.par.size, 0, 'pas meme un etat');
    const xr = await e.releveCricket([proche], opts(reseau()));
    eq(xr.par.get('proche').espn, '1555137', 'le vrai double programme (4 h) : le plus proche, 1555137');

    /* ---- LA JUMELLE ABSENTE ET LE POINT MILIEU (relecture du 12/10) ----
       Avant : un candidat SEUL s acceptait a 12 h, et « rien sous 2 h » comparait les deux
       rencontres ESPN entre elles (toujours 4 h) — pas leur distance a notre heure. */
    const sansJumelle = COPIE('20260924');
    for (const lg of sansJumelle.sports[0].leagues) lg.events = lg.events.filter((ev) => String(ev.id) !== '1552798');
    const jum = M('jumelle', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T19:30:00Z');
    const xj = await e.releveCricket([jum], opts(reseau({ 20260924: { corps: sansJumelle } })));
    eq(xj.lignes[0].resultat, 'loin', '19:30 sans 1552798 a l en-tete : la victoire de 15:30 est a 4 h, elle n est PAS prise');
    eq(xj.par.size, 0, 'rien n est rendu (avant : « 1 », paye, pour un match sans resultat)');
    eq((await e.finies([jum], opts(reseau({ 20260924: { corps: sansJumelle } })))).length, 0, 'finies non plus');
    for (const [h, dom, ext] of [['17:20', 'Cayman Islands', 'Bahamas'], ['17:30', 'Cayman Islands', 'Bahamas'], ['17:30', 'Bahamas', 'Cayman Islands'], ['17:40', 'Cayman Islands', 'Bahamas']]) {
      const mm = M('mil-' + h, 'cricket_international_t20', dom, ext, '2026-09-24T' + h + ':00Z');
      const xm = await e.releveCricket([mm], opts(reseau()));
      eq(xm.lignes[0].resultat, 'ambigu', `${dom} v ${ext} a ${h}, entre 15:30 et 19:30 : notre heure n est pas nettement plus pres de l une — rien`);
      eq((await e.finies([mm], opts(reseau()))).length, 0, '  et finies ne rend rien');
    }
    const kor = M('kor-0300', 'cricket_international_t20', 'South Korea', 'Indonesia', '2026-10-05T03:00:00Z');
    eq((await e.releveCricket([kor], opts(reseau()))).lignes[0].resultat, 'ambigu', 'South Korea v Indonesia a 03:00, entre 01:00 et 05:00 : rien');
    const a1h = M('a-1h', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T16:30:00Z');
    eq((await e.releveCricket([a1h], opts(reseau()))).par.get('a-1h').espn, '1552795', '16:30 : 1 h de 15:30 et 3 h de 19:30, nettement la plus proche : 1552795');
    const d2h = M('a-2h', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T11:00:00Z');
    eq((await e.releveCricket([d2h], opts(reseau()))).lignes[0].resultat, 'loin', 'seule a 12 h, mais a 2 h pile de notre heure : rien (moins de 2 h exigees)');
    /* une rencontre des memes noms a la date illisible (DERIVE de 1552798) : on ne sait pas l ecarter */
    const dIll = COPIE('20260924');
    for (const lg of dIll.sports[0].leagues) for (const ev of lg.events) if (String(ev.id) === '1552798') ev.date = 'TBD';
    eq((await e.releveCricket([M('ill', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T15:30:00Z')], opts(reseau({ 20260924: { corps: dIll } })))).lignes[0].resultat,
       'heure', 'la jumelle a une date illisible : rien, meme si 15:30 tombe pile');

    /* mauvais format : l ODI de la meme tournee 24289 */
    const t20 = M('odi-en-t20', 'cricket_international_t20', 'India', 'West Indies', '2026-10-03T08:30:00Z');
    const xo = await e.releveCricket([t20], opts(reseau()));
    eq(xo.par.get('odi-en-t20').espn, '1529229', 'India v West Indies du 03/10 : 1529229, de la tournee 24289 — un ODI');
    eq(xo.par.get('odi-en-t20').resultat, undefined, 'sous la cle T20I : aucune lettre');
    ok(/format ODI/.test(xo.lignes[0].raison) && /T20I attendu/.test(xo.lignes[0].raison), 'raison : ' + xo.lignes[0].raison);
    eq((await e.finies([t20], opts(reseau()))).length, 0, 'finies ne rend rien');
    const odi = M('odi', 'cricket_odi', 'India', 'West Indies', '2026-10-03T08:30:00Z');
    eq((await e.releveCricket([odi], opts(reseau()))).par.get('odi').resultat, '2', 'sous la cle ODI, le meme match se regle : West Indies (exterieur) gagne');
    const t20vrai = M('t20', 'cricket_odi', 'India', 'West Indies', '2026-10-06T13:30:00Z');
    eq((await e.releveCricket([t20vrai], opts(reseau()))).par.get('t20').resultat, undefined, 'et le T20I du 06/10 sous la cle ODI : rien');

    /* heure non valide (DERIVE de 1550709) */
    const dh = evDe('20261011', '1550709');
    dh.ev.timeValid = false;
    const m = M('heure', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z');
    eq((await e.releveCricket([m], opts(reseau({ 20261011: { corps: dh.c } })))).lignes[0].resultat, 'heure', 'timeValid false : rien');

    /* deux copies qui different d un jour a l autre (DERIVE : 1550709 recopiee sous le 12/10 en id 0) */
    const dc = COPIE('20261012');
    const autre = JSON.parse(JSON.stringify(evDe('20261011', '1550709').ev));
    autre.fullStatus.type = { id: '0', description: 'Scheduled', detail: 'Scheduled', shortDetail: 'Scheduled', state: 'pre' };
    autre.competitors.forEach((c) => { c.winner = false; c.score = ''; });
    dc.sports[0].leagues.push({ id: '24707', name: 'copie divergente', events: [autre] });
    const xc = await e.releveCricket([m], opts(reseau({ 20261012: { corps: dc } })));
    eq(xc.lignes[0].resultat, 'rien', 'la meme rencontre, gagnee le 11 et « prevue » le 12 : rien');
    ok(/deux copies/.test(xc.lignes[0].raison), 'raison : ' + xc.lignes[0].raison);
    /* le reporte 1546542 (date du 11/10) est sous les copies du 11 au 14, identique : une copie coherente ne gene rien */
    const ranji = M('ranji', 'cricket_international_t20', 'Arunachal Pradesh', 'Nagaland', '2026-10-11T04:00:00Z');
    const xg = await e.releveCricket([ranji], opts(reseau()));
    eq(xg.par.get('ranji').espn + '|' + xg.par.get('ranji').statutId, '1546542|113', '1546542 vu sous deux des trois jours demandes, identique : apparie (puis refuse au format First-class)');
    ok(/format First-class/.test(xg.lignes[0].raison), 'raison : ' + xg.lignes[0].raison);

    /* The Hundred : « Trent Rockets (Men) » n est pas « Trent Rockets » sans ALIAS releve */
    const hun = e.lisCricket(evDe('20260816', '1521264').ev, '19601');
    eq(hun.carte, e.FORMAT_CRICKET.cricket_the_hundred, 'The Hundred masculin (19601) est « Twenty20 » a l en-tete, comme la cle le veut');
    ok(!e.meme('Trent Rockets', 'Trent Rockets (Men)'), 'mais « Trent Rockets (Men) » n est pas « Trent Rockets » : aucun rapprochement');
    ok(e.apparieCricket(M('h', 'cricket_the_hundred', 'Manchester Super Giants', 'Trent Rockets', '2026-08-16T17:00:00Z'), [hun]).sans,
       'donc The Hundred ne s apparie pas sans ligne d ALIAS — la main');
    const bl = e.lisCricket(evDe('20260718', '1512889').ev, '8053');
    eq(bl.carte, e.FORMAT_CRICKET.cricket_t20_blast, 'le Blast (8053, 18/07) est « Twenty20 »');
  }

  // ================== 7. UN REFUS N'EST JAMAIS UNE LISTE VIDE
  console.log('\n-- le 502, et les autres refus --');
  {
    const m = M('panne', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z');
    const avant = (e.refusDuJour()['cricket/entete'] || { refus: 0 }).refus;
    const r502 = reseau({ 20261010: { statut: 502, corps: BRUT_502 } });
    const x = await e.releveCricket([m], opts(r502));
    eq(x.lignes[0].resultat, 'panne', 'J-1 en 502 (le corps reel {"code":2502}) : panne, alors que la victoire est sous J');
    ok(/20261010 \(statut 502, puis statut 502\)/.test(x.lignes[0].raison), 'raison (redemandee une fois, refusee deux fois) : ' + x.lignes[0].raison);
    eq(r502.urls.filter((u) => /dates=20261010$/.test(u)).length, 2, 'la journee refusee est redemandee UNE fois, pas plus');
    eq(x.par.size, 0, 'rien n est rendu');
    eq(x.jours['20261011'], 'ok', 'les autres jours ont repondu');
    eq((await e.finies([m], opts(reseau({ 20261010: { statut: 502, corps: BRUT_502 } })))).length, 0, 'finies ne rend rien');
    eq(e.refusDuJour()['cricket/entete'].refus, avant + 4, 'chaque refus est compte sous cricket/entete, la nouvelle demande comprise (2 releves x 2)');
    const r200 = reseau({ 20261012: { corps: JSON.parse(BRUT_502) } });
    eq((await e.releveCricket([m], opts(r200))).lignes[0].resultat, 'panne', 'le meme corps {"code":2502} servi en 200 : panne (pas de sports[0].leagues)');
    const rLeve = reseau({ 20261011: { leve: 'socket hang up' } });
    eq((await e.releveCricket([m], opts(rLeve))).lignes[0].resultat, 'panne', 'une coupure : panne');
    const rVide = reseau({ 20261011: { corps: { sports: [] } } });
    eq((await e.releveCricket([m], opts(rVide))).lignes[0].resultat, 'panne', 'sports vide : panne, jamais « aucune rencontre »');
    /* le vrai : The Hundred du 16/08, J+1 (17/08) a rendu 502 deux fois de suite le 12/10 */
    const hun = M('hun', 'cricket_the_hundred', 'Manchester Super Giants (Men)', 'Trent Rockets (Men)', '2026-08-16T17:00:00Z');
    const xh = await e.releveCricket([hun], opts(reseau({ 20260817: { statut: 502, corps: BRUT_502 } })));
    eq(xh.lignes[0].resultat, 'panne', 'The Hundred du 16/08 avec le 17/08 refuse : panne, meme avec les noms ESPN exacts');

    /* le 502 est intermittent (le 16/08 a repondu une fois sur trois le 12/10 au soir) :
       refusee une fois puis servie, la journee ne bloque plus la rencontre */
    const base = reseau();
    let premier = true;
    const unRefus = async (u) => {
      if (premier && /dates=20261010$/.test(String(u))) { premier = false; base.urls.push(String(u)); return { ok: false, status: 502, json: async () => JSON.parse(BRUT_502) }; }
      return base.prendre(u);
    };
    const xr = await e.releveCricket([m], { prendre: unRefus, pauseMs: 0 });
    eq(xr.lignes[0].resultat + '|' + xr.lignes[0].lettre, 'regle|1', 'un 502 isole sur J-1, redemande en fin de passe : la rencontre se tranche');
    eq(xr.jours['20261010'], 'ok', 'et la journee est dite lue');
    eq(base.urls.length, 4, 'quatre requetes : trois journees et une nouvelle demande');

    /* LE BUDGET (60 s par passe) : passe le budget, plus une requete ne part ;
       les journees restantes sont refusees, la rencontre est en panne */
    const lent = reseau();
    const prendreLent = async (u) => { await new Promise((ok2) => setTimeout(ok2, 60)); return lent.prendre(u); };
    const xb = await e.releveCricket([m], { prendre: prendreLent, pauseMs: 0, budgetMs: 20 });
    eq(lent.urls.length, 1, 'budget de 20 ms, 60 ms par requete : une seule requete part');
    eq(xb.lignes[0].resultat, 'panne', 'la rencontre est en panne, jamais tranchee sur une journee manquante');
    ok(/budget de la passe depasse/.test(xb.lignes[0].raison), 'raison : ' + xb.lignes[0].raison);
    eq(e.CRICKET_BUDGET_MS, 60000, '60 s par passe par defaut');
  }

  // ================== 8. LES DEUX RENCONTRES OUVERTES DU 12/10
  console.log('\n-- les rencontres ouvertes : appariees, pas tranchees --');
  {
    const lot = [M('pak-1310', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-13T13:00:00Z'),
                 M('ind-1410', 'cricket_international_t20', 'India', 'West Indies', '2026-10-14T13:30:00Z')];
    const x = await e.releveCricket(lot, opts(reseau()));
    eq(x.par.get('pak-1310').espn + '|' + x.par.get('pak-1310').etat + '|' + x.par.get('pak-1310').statutId, '1550710|pre|0', 'Pakistan v Sri Lanka du 13/10 : 1550710, prevue');
    eq(x.par.get('ind-1410').espn + '|' + x.par.get('ind-1410').etat + '|' + x.par.get('ind-1410').statutId, '1529233|pre|0', 'India v West Indies du 14/10 : 1529233, prevue');
    ok(!x.par.get('pak-1310').resultat && !x.par.get('ind-1410').resultat, 'aucune lettre');
    eq((await e.finies(lot, opts(reseau()))).length, 0, 'finies ne rend rien avant la fin');
  }

  // ================== 9. JAMAIS « 0-0 » NI 'N' PAR `releve`
  console.log('\n-- le cricket hors de releve --');
  {
    /* le danger, sur la forme du tableau : un abandon a des scores vides, et Number('') vaut 0 */
    const tableauAbandon = { events: [{ id: '1552773', date: '2026-09-28T05:00Z',
      status: { type: { id: '6', state: 'post', completed: true, description: 'Abandoned', detail: 'Final' } },
      competitions: [{ competitors: [
        { homeAway: 'home', winner: 'false', score: '', team: { displayName: 'Afghanistan' } },
        { homeAway: 'away', winner: 'false', score: '', team: { displayName: 'India' } }] }] }] };
    const lu = e.lis(tableauAbandon.events[0]);
    eq(lu.a.points + '-' + lu.b.points, '0-0', 'lis lit bien « 0-0 » sur un abandon : le danger existe');
    e.CHEMINS.cricket_international_t20 = 'cricket/22547';
    try {
      const m = M('zero', 'cricket_international_t20', 'Afghanistan', 'India', '2026-09-28T05:00:00Z');
      const prendre = async (u) => {
        if (/site\.api\.espn\.com/.test(String(u))) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(tableauAbandon)) };
        return reseau().prendre(u);
      };
      const v = await e.releve([m], { prendre });
      eq(v.size, 0, 'meme une cle cricket remise dans CHEMINS : releve ne la lit pas');
      const f = await e.finies([m], { prendre, pauseMs: 0 });
      ok(!f.some((x) => x.score === '0-0' || x.resultat === 'N'), 'et finies ne rend jamais « 0-0 » ni N');
      eq(f.length, 1, 'seulement l abandon, par l en-tete');
      eq(f[0].resultat, null, 'sans lettre');
      ok(/abandon/.test(f[0].aMain), 'a la main');
      const parSport = Object.assign({}, m, { source: { ligue: 'soccer_epl' } });
      ok(e.estCricket(parSport) && e.estCricket({ sport: 'foot', source: { ligue: 'cricket_odi' } }), 'le cricket se reconnait par le sport OU par la cle');
    } finally { delete e.CHEMINS.cricket_international_t20; }
    ok(!e.CHEMINS.cricket_international_t20, 'CHEMINS rendu tel quel');
  }

  // ================== 10. LE RYTHME : UNE A LA FOIS, ESPACEES
  console.log('\n-- une requete a la fois, espacees --');
  {
    eq(e.CRICKET_PAUSE_MS, 1000, 'une par seconde au plus par defaut');
    const r = reseau();
    const lot = [M('a', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z'),
                 M('b', 'cricket_international_t20', 'India', 'West Indies', '2026-10-11T13:30:00Z')];
    const r2 = reseau();
    await Promise.all([e.releveCricket(lot, { prendre: r.prendre, pauseMs: 40 }), e.releveCricket(lot, { prendre: r2.prendre, pauseMs: 40 })]);
    eq(r.urls.length + r2.urls.length, 6, 'deux releves simultanees, trois jours chacune');
    eq(Math.max(r.enVol.max, r2.enVol.max), 1, 'jamais deux requetes en vol a la fois, meme entre deux releves');
    const tous = [...r.departs, ...r2.departs].sort((x, y) => x - y);
    ok(tous.slice(1).every((t, i) => t - tous[i] >= 38), 'au moins la pause entre deux departs : ' + tous.slice(1).map((t, i) => t - tous[i]).join(','));
  }

  // ================== 11. LE FOOTBALL ET LE TENNIS N'ONT PAS BOUGE
  console.log('\n-- les autres sports --');
  {
    const r = reseau();
    const foot = { id: 'f', sport: 'foot', domicile: 'Borussia Dortmund', exterieur: 'Bayern Munich', debut: Date.parse('2026-08-29T18:00Z'),
                   source: { ligue: 'soccer_germany_bundesliga' } };
    const prendre = async (u) => {
      if (/site\.api\.espn\.com/.test(String(u))) return { ok: true, status: 200, json: async () => ({ events: [{ date: '2026-08-29T18:00Z',
        status: { type: { state: 'post', completed: true, name: 'STATUS_FULL_TIME' } },
        competitions: [{ competitors: [{ team: { displayName: 'Bayern Munich' }, score: '3' }, { team: { displayName: 'Borussia Dortmund' }, score: '1' }] }] }] }) };
      return r.prendre(u);
    };
    const f = await e.finies([foot], { prendre, pauseMs: 0 });
    eq(f.length + '|' + f[0].score + '|' + f[0].resultat, '1|1-3|2', 'le football se regle comme avant, sur son tableau');
    eq(r.urls.length, 0, 'et sans une requete a l en-tete du cricket');
  }

  // ================== 12. CE QUE LE TRI EN FAIT : LA MAIN PASSE AVANT TOUT
  console.log('\n-- le tri du reglement --');
  {
    const imp = require('./paris_import');
    const f = await e.finies([M('nr-tri', 'cricket_international_t20', 'Hong Kong', 'Maldives', '2026-10-12T01:15:00Z')], opts(reseau()));
    const t = imp.trieReglements(f, () => 0, Date.parse('2026-10-13T12:00:00Z'));
    eq(t.auto.length + '|' + t.mains.length, '0|1', 'sans resultat : jamais dans « auto », toujours « a la main »');
    eq(t.mains[0].raison, f[0].aMain, 'avec la raison ecrite par la releve, pas « rencontre absente du calendrier »');
  }

  // ================== 13. DEUX DES NOTRES NE PRENNENT JAMAIS LA MEME RENCONTRE ESPN (relecture du 12/10)
  console.log('\n-- une rencontre ESPN pour une seule des notres --');
  {
    /* le double programme du 24/09, mal date par le fournisseur : nos 15:30 et 16:00 prennent
       toutes deux 1552795 (gagne) ; le vrai match de 19:30 (1552798) a fini sans resultat */
    const jeu1 = M('jeu1', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T15:30:00Z');
    const jeu2 = M('jeu2', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T16:00:00Z');
    const x = await e.releveCricket([jeu1, jeu2], opts(reseau()));
    eq(x.lignes.map((l) => l.resultat).join(','), 'ambigu,ambigu', 'les deux : ambigu');
    ok(x.lignes.every((l) => /1552795 est prise aussi par/.test(l.raison)), 'raison : ' + x.lignes[0].raison);
    eq((await e.finies([jeu1, jeu2], opts(reseau()))).length, 0, 'finies ne rend rien (avant : « 1 » pour les deux)');
    /* une seule porte un pari : l autre est dans le CATALOGUE, pas dans le lot */
    const xc = await e.releveCricket([jeu2], opts(reseau(), { catalogue: [jeu1, jeu2] }));
    eq(xc.lignes[0].resultat, 'ambigu', 'jeu2 seul parie, jeu1 au catalogue : ambigu quand meme');
    eq((await e.finies([jeu2], opts(reseau(), { catalogue: [jeu1, jeu2] }))).length, 0, 'et finies ne rend rien');
    /* une voisine FERMEE (deplacee) part a la main de toute facon : elle ne bloque pas l autre */
    const ferme = Object.assign({}, jeu2, { ferme: '2026-09-23T10:00:00Z', fermeRaison: 'reportee' });
    eq((await e.releveCricket([jeu1], opts(reseau(), { catalogue: [jeu1, ferme] }))).par.get('jeu1').resultat, '1', 'voisine fermee (jeu2) : jeu1 se tranche seul');
    eq((await e.releveCricket([jeu2], opts(reseau(), { catalogue: [ferme] }))).lignes[0].resultat, 'main',
       'et jeu2 seul, a 16:00 pour un ESPN a 15:30, part a la main (vendu 30 min pendant le jeu, section 14)');
    /* le vrai double programme, bien date : chacune la sienne */
    const tard = M('tard', 'cricket_international_t20', 'Cayman Islands', 'Bahamas', '2026-09-24T19:30:00Z');
    const xd = await e.releveCricket([jeu1], opts(reseau(), { catalogue: [jeu1, tard] }));
    eq(xd.par.get('jeu1').resultat, '1', '15:30 et 19:30 au catalogue : chacune sa rencontre ESPN, 15:30 se tranche');
    eq(xd.jours['20260925'], 'ok', 'les journees des voisines sont lues aussi');
    /* une voisine qu on n a pas pu lire (son J+1, le 26/09, est absent des copies : refuse) */
    const loinVoisine = M('voisine-26', 'cricket_international_t20', 'Bahamas', 'Cayman Islands', '2026-09-25T03:00:00Z');
    const xv = await e.releveCricket([jeu1], opts(reseau(), { catalogue: [jeu1, loinVoisine] }));
    eq(xv.lignes[0].resultat, 'panne', 'une voisine des memes noms a 11 h 30 dont une journee est refusee : on ne sait pas si elle prend 1552795 — panne');
    ok(/voisine-26/.test(xv.lignes[0].raison) && /20260926/.test(xv.lignes[0].raison), 'raison : ' + xv.lignes[0].raison);
  }

  // ================== 14. ESPN LA FAIT COMMENCER AVANT NOTRE HEURE : LA MAIN (relecture du 12/10)
  console.log('\n-- vendue pendant le jeu : a la main --');
  {
    const tot = M('pak-14h', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T14:00:00Z');   // ESPN 1550709 : 13:00Z
    const x = await e.releveCricket([tot], opts(reseau()));
    eq(x.lignes[0].resultat, 'main', 'ESPN a 13:00, notre heure 14:00 : les paris ont ferme 1 h apres le debut — la main');
    eq(x.par.get('pak-14h').resultat, undefined, 'aucune lettre, meme si Pakistan a gagne');
    ok(/2026-10-11T13:00Z/.test(x.lignes[0].raison) && /60 min avant notre heure/.test(x.lignes[0].raison) && /tickets poses apres/.test(x.lignes[0].raison),
       'la raison dit l heure ESPN et quoi verifier : ' + x.lignes[0].raison);
    ok(/ESPN donne 1/.test(x.lignes[0].raison), 'et ce qu ESPN donne, pour la main');
    const f = await e.finies([tot], opts(reseau()));
    eq(f.length + '|' + f[0].resultat, '1|null', 'finies la rend a la main');
    const tard = M('pak-12h30', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T12:30:00Z');
    eq((await e.releveCricket([tard], opts(reseau()))).par.get('pak-12h30').resultat, '1', 'ESPN 30 min APRES notre heure : les paris ont ferme avant le jeu, on regle');
    const six = M('pak-19h', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T19:00:00Z');
    eq((await e.releveCricket([six], opts(reseau()))).lignes[0].resultat, 'loin', 'ESPN 6 h avant : hors des 2 h, rien (avant : « 1 », paye)');
    eq(e.CRICKET_AVANCE_MS, 60000, 'la borne : la minute, resolution de l heure ESPN');
    const minute = M('pak-1301', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:01:00Z');
    eq((await e.releveCricket([minute], opts(reseau()))).par.get('pak-1301').resultat, '1', 'une minute d ecart (la resolution d ESPN) : on regle');
    const deux = M('pak-1302', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:02:00Z');
    eq((await e.releveCricket([deux], opts(reseau()))).lignes[0].resultat, 'main', 'deux minutes : la main');
  }

  // ================== 15. LE RESULTAT DOIT TENIR AUTO_DELAI_MIN (relecture du 12/10)
  console.log('\n-- la premiere lecture du resultat, et le delai --');
  {
    const imp = require('./paris_import');
    const paris = require('./paris');
    const odi = M('odi-vu', 'cricket_odi', 'India', 'West Indies', '2026-10-03T08:30:00Z');   // 1529229, West Indies gagne
    const T1 = Date.parse('2026-10-03T16:40:00Z');
    const f1 = await e.finies([odi], opts(reseau(), { maintenant: T1 }));
    eq(f1[0].resultat + '|' + f1[0].vuFini, '2|' + T1, 'premiere lecture : vuFini = l heure de la passe');
    const f2 = await e.finies([odi], opts(reseau(), { maintenant: T1 + 3600000 }));
    eq(f2[0].vuFini, T1, 'le meme verdict une heure plus tard : vuFini ne bouge pas');
    const dv = evDe('20261003', '1529229');
    dv.ev.competitors.forEach((c) => { c.winner = !c.winner; });
    const f3 = await e.finies([odi], opts(reseau({ 20261003: { corps: dv.c } }), { maintenant: T1 + 2 * 3600000 }));
    eq(f3[0].resultat + '|' + f3[0].vuFini, '1|' + (T1 + 2 * 3600000), 'ESPN corrige le vainqueur (DERIVE) : nouvelle lettre, le delai repart de zero');
    await e.releveCricket([odi], opts(reseau({ 20261002: { statut: 502, corps: BRUT_502 } }), { maintenant: T1 + 3 * 3600000 }));
    const f4 = await e.finies([odi], opts(reseau({ 20261003: { corps: dv.c } }), { maintenant: T1 + 4 * 3600000 }));
    eq(f4[0].vuFini, T1 + 2 * 3600000, 'une passe en panne entre deux ne remet rien a zero');
    const dz = evDe('20261003', '1529229');
    dz.ev.fullStatus.type = { id: '0', description: 'Scheduled', detail: 'Final', state: 'post' };
    await e.finies([odi], opts(reseau({ 20261003: { corps: dz.c } }), { maintenant: T1 + 5 * 3600000 }));
    const f5 = await e.finies([odi], opts(reseau({ 20261003: { corps: dv.c } }), { maintenant: T1 + 6 * 3600000 }));
    eq(f5[0].vuFini, T1 + 6 * 3600000, 'un verdict qui disparait puis revient : repart de zero');

    /* le tri : un ODI en id 1 a 490 min du coup d envoi n est pas paye a sa premiere lecture */
    const vrai = paris.match;
    paris.match = (id) => (id === 'odi-vu' ? { id, sport: 'cricket', debut: odi.debut, source: odi.source } : vrai(id));
    try {
      const D = imp.AUTO_DELAI_MIN;
      const f = Object.assign({}, f1[0], { vuFini: T1 });
      let t = imp.trieReglements([f], () => 0, T1);
      eq(t.auto.length, 0, 'ODI fini lu a 16:40 (490 min apres le coup d envoi) : pas paye a la premiere lecture');
      ok(t.mains[0].attente && /lu depuis 0 min/.test(t.mains[0].raison), 'en attente : ' + t.mains[0].raison);
      t = imp.trieReglements([f], () => 0, T1 + (D - 1) * 60000);
      eq(t.auto.length, 0, (D - 1) + ' min apres la premiere lecture : toujours pas');
      t = imp.trieReglements([f], () => 0, T1 + D * 60000);
      eq(t.auto.length + '|' + t.auto[0].resultat, '1|2', D + ' min apres : regle, West Indies (exterieur)');
      t = imp.trieReglements([Object.assign({}, f, { vuFini: undefined })], () => 0, T1 + 10 * 86400000);
      eq(t.auto.length, 0, 'une lettre de cricket sans vuFini ne se paie jamais seule');
      ok(t.mains[0].attente, '  elle attend');
      const foot = { id: 'odi-vu', sport: 'foot', resultat: '1', source: 'espn' };
      paris.match = (id) => ({ id, sport: 'foot', debut: T1 - 300 * 60000, source: { ligue: 'soccer_epl' } });
      eq(imp.trieReglements([foot], () => 0, T1).auto.length, 1, 'le football n est pas touche : son mur reste le coup d envoi + 200 min');
    } finally { paris.match = vrai; }
  }

  // ================== 16. CE QUI SE DIT : UNE LIGNE QUAND L ISSUE CHANGE (relecture du 12/10)
  console.log('\n-- le journal et etatCricket --');
  {
    const dits = [];
    const log = console.log;
    console.log = (...a) => { dits.push(a.join(' ')); };
    let x1, x2;
    const m = M('dit-sans', 'cricket_international_t20', 'Pakistan', 'England', '2026-10-11T13:00:00Z');
    try {
      x1 = await e.releveCricket([m], opts(reseau()));
      x2 = await e.releveCricket([m], opts(reseau()));
    } finally { console.log = log; }
    const l = dits.filter((d) => /^\[espn\] cricket dit-sans /.test(d));
    eq(l.length, 1, 'une rencontre « sans » laisse UNE ligne, pas une par passe : ' + (l[0] || 'aucune'));
    ok(/Pakistan v England/.test(l[0]) && /: sans — aucune rencontre de ces deux noms a 12 h/.test(l[0]), 'la ligne dit qui, l issue et pourquoi');
    eq(x1.lignes[0].resultat + x2.lignes[0].resultat, 'sanssans', 'les deux passes disent la meme chose');
    const et = e.etatCricket();
    eq(et.rencontres + '|' + JSON.stringify(et.issues) + '|' + et.journees + '|' + et.refusees.length, '1|{"sans":1}|3|0', 'etatCricket : la derniere passe, comptee par issue');
    const ip = require('./paris_import').etatImport();
    eq(JSON.stringify(ip.cricket.issues), '{"sans":1}', 'et etatImport().cricket la porte');
    /* une ligne qui change d issue se redit, avec la rencontre ESPN et son statut */
    const dits2 = [];
    console.log = (...a) => { dits2.push(a.join(' ')); };
    const p = M('dit-pak', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-13T13:00:00Z');
    try { await e.releveCricket([p], opts(reseau())); } finally { console.log = log; }
    ok(dits2.some((d) => /^\[espn\] cricket dit-pak .*: rien — ESPN 1550710 \(ligue 24707\) id 0 pre/.test(d)), 'une rencontre prevue : ' + dits2.join(' / '));
  }

  // ================== 17. LES HOMONYMES (relecture du 12/10)
  console.log('\n-- India n est pas India Women --');
  {
    /* noms releves dans les en-tetes du 12/10, actifs les memes jours que les equipes nationales */
    for (const [a, b] of [['India', 'India Women'], ['India', 'India A'], ['India', 'India Under-19s'], ['India', 'India A Women'],
                          ['West Indies', 'West Indies Select XI'], ['West Indies', 'West Indies Women'], ['Pakistan', 'Pakistan Shaheens'],
                          ['Pakistan', 'Pakistan Women'], ['Sri Lanka', 'Sri Lanka Women'], ['Trent Rockets', 'Trent Rockets (Women)'],
                          ['Trent Rockets', 'Trent Rockets (Men)']]) {
      ok(!e.meme(a, b) && !e.meme(b, a), `« ${a} » n est pas « ${b} »`);
    }
    /* une rencontre feminine a la meme heure (DERIVE de 1550709) : ni le nom, ni le format */
    const d = evDe('20261011', '1550709');
    const fem = JSON.parse(JSON.stringify(d.ev));
    fem.id = '9999001';
    fem.competitors[0].displayName = 'Pakistan Women';
    fem.competitors[1].displayName = 'Sri Lanka Women';
    fem.class.generalClassCard = 'Women T20';
    d.l.events = [fem];
    const xf = await e.releveCricket([M('fem', 'cricket_international_t20', 'Pakistan', 'Sri Lanka', '2026-10-11T13:00:00Z')], opts(reseau({ 20261011: { corps: d.c } })));
    eq(xf.lignes[0].resultat, 'sans', 'Pakistan Women v Sri Lanka Women a la meme heure ne passe pas pour Pakistan v Sri Lanka');
  }

  console.log(`\nscores_espn_cricket.test.js : ${n} verifications OK`);
})().catch((err) => { console.error('RATE', err && err.stack || err); process.exit(1); });
