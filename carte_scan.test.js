'use strict';
/* ============================================================================
 * LA CARTE D UN SCAN — EN ANGLAIS, SANS CODE BRUT, SANS DOUBLON
 *
 * Audit du 26 septembre 2026 : la carte partagee (PNG, apercus de X) montrait
 * « OCTEMIT » au-dessus de « code : sans emission », et quatre lignes
 * identiques (+16,9 %, n=2395 a 2398 : le bytecode lu une fois, range sous
 * quatre traits). On mesure ici, sur les VRAIES cases du scan de LOBSTER
 * releve ce jour-la :
 *   1. chaque trait de la colonie a un nom anglais (un trait ajoute demain
 *      sans le sien fait echouer CET essai) ;
 *   2. aucun libelle francais, aucune cle brute dans les textes de la carte ;
 *   3. aucune ligne en double : ni la meme phrase, ni la meme mesure ;
 *   4. la mention GoPlus reste, et chaque chiffre garde son effectif ;
 *   5. le scan public (JSON) gagne ses liens et la phrase de chaque case,
 *      sans rien perdre ni fusionner.
 * ==========================================================================*/
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const K = require('./carte_scan');
const C = require('./ai_colonie');

/* Le scan de LOBSTER (0x254a…8dc5), releve sur le serveur en direct le 26 septembre 2026 (fixture partagee). */
const LOBSTER = require('./scan_lobster.essai');

/* Les cles et les libelles francais que la carte ne doit JAMAIS montrer. */
const CLES = Object.keys(C.TRAITS);
const FRANCAIS = Object.keys(C.MOTS).filter((k) => C.MOTS[k] !== k);
const MOTS_FR = /\b(emission|emettre|liste noire|frais|reseaux|piscine|porteurs|brule|inconnue?s?|conseiller|consulte|sortie|testee|taxe|trouve par|equilibre|acheteurs|vendeurs|pouvoirs|seule source|ne de|ca retombe|ca accelere)\b/i;
/* Une cle brute : la ligne entiere est une cle (« OCTEMIT », « SOCIAL ») ; ou une cle
   qui n'est pas un mot anglais apparait ou que ce soit (octEmit, ponsGradAge, achUniq,
   cobaye, vola…). « Social links » ou « 1 pool » sont de l'anglais, pas des cles. */
const ANGLAIS = ['age', 'social', 'pons', 'pad', 'code', 'top', 'pools', 'lp', 'liq', 'mc'];
const brute = (t) => CLES.some((k) => t.trim().toLowerCase() === k.toLowerCase()
  || (!ANGLAIS.includes(k) && new RegExp('\\b' + k + '\\b', 'i').test(t)));
const verifie = (textes, quoi) => {
  const cles = textes.filter(brute);
  const fr = textes.filter((t) => FRANCAIS.some((k) => t.includes(k) && !/^[<>0-9$ .%-]+$/.test(k) && k.length > 3) || MOTS_FR.test(t));
  ok(!cles.length, quoi + ' : aucune cle brute (OCTEMIT, ponsGradAge…)' + (cles.length ? ' — ' + JSON.stringify(cles) : ''));
  ok(!fr.length, quoi + ' : aucun libelle francais' + (fr.length ? ' — ' + JSON.stringify(fr) : ''));
};

console.log('-- 1. chaque trait de la colonie a un nom anglais --');
{
  const manquants = CLES.filter((k) => !K.NOMS_TRAITS[k]);
  ok(CLES.length > 30 && !manquants.length, CLES.length + ' traits dans la table de la colonie, chacun nomme' + (manquants.length ? ' — manque : ' + manquants.join(', ') : ''));
  eq(K.nomTrait('age×mc'), 'Pool age × Market cap', 'un trait croise : ses deux noms');
  eq(K.nomTrait('traitDeDemain'), null, 'un trait inconnu : pas de nom invente…');
  const x = K.casesEnAnglais([{ trait: 'traitDeDemain', case: 'mc <10k', n: 50, moyenne: 3 }])[0];
  eq(x.traitLabel, K.TRAIT_INCONNU, '… et sur la carte un nom generique, jamais la cle');
  eq(K.casesEnAnglais([{ trait: 'mc', case: 'un-libelle-de-demain', n: 50, moyenne: 3 }]).length, 0, 'une case que la table ne connait pas n apparait pas (mieux qu un code brut)');
}

console.log('\n-- 2. la carte de LOBSTER : en anglais, sans cle brute --');
const textes = K.textes(LOBSTER);
verifie(textes, 'la carte');
{
  const atlas = require('./police_scan.json').glyphes;
  const absents = [...new Set(textes.join('').split(''))].filter((ch) => !atlas['b' + ch] || !atlas['r' + ch]);
  ok(!absents.length, 'chaque caractere ecrit existe dans l atlas de la police (sinon un blanc au milieu du mot)' + (absents.length ? ' — ' + JSON.stringify(absents) : ''));
  ok(textes.includes('CONTRACT BYTECODE') && textes.includes('bytecode: no mint, no blacklist, no pause, no fee setter'),
     'le bytecode en une ligne, en toutes lettres : « bytecode: no mint, no blacklist, no pause, no fee setter »');
}

console.log('\n-- 3. aucune ligne en double --');
{
  const lignes = K.casesEnAnglais(LOBSTER.cases);
  const phrases = lignes.map((l) => l.label.toLowerCase());
  ok(new Set(phrases).size === phrases.length, 'la meme phrase jamais deux fois (« not from pons » x5 : une ligne)');
  const memes = lignes.filter((a, i) => lignes.some((b, j) => j > i && a.moyenne === b.moyenne && Math.abs(a.n - b.n) <= Math.max(3, 0.005 * Math.max(a.n, b.n))));
  ok(!memes.length, 'la meme mesure jamais deux fois (meme moyenne, effectifs a 0,5 % pres)' + (memes.length ? ' — ' + JSON.stringify(memes.map((l) => l.label)) : ''));
  ok(lignes.length < LOBSTER.cases.length && lignes.length >= 15, LOBSTER.cases.length + ' cases brutes, ' + lignes.length + ' lignes distinctes : rien de vrai n est perdu, seulement les repetitions');
  const surCarte = K.plan(LOBSTER).filter((o) => o.texte !== undefined && o.taille === 22).map((o) => o.texte);
  ok(surCarte.length === 5 && new Set(surCarte).size === 5, 'les cinq lignes de la carte sont cinq mesures differentes : ' + surCarte.join(' | '));
  const bc = lignes.find((l) => /^bytecode:/.test(l.label));
  ok(bc && bc.n === 2395 && bc.traitLabel === 'Contract bytecode', 'fusionnees, elles gardent la plus petite des n (2395) : chaque phrase tient sur au moins autant');
  const nonLu = lignes.find((l) => /tax unknown/.test(l.label));
  ok(nonLu && nonLu.traitLabel === K.PLUSIEURS && /code unknown/.test(nonLu.label), 'plusieurs traits sur les memes jetons : un nom qui le dit, pas celui d un seul (« ' + (nonLu && nonLu.traitLabel) + ' »)');
}

console.log('\n-- 4. la mention GoPlus, l effectif, jamais de verdict --');
{
  const d = Object.assign({}, LOBSTER, { faits: [{ quoi: 'the contract can mint more tokens', source: 'GoPlus' }, { quoi: 'transfers can be paused', source: 'bytecode' },
    { quoi: 'the contract can mint more tokens', source: 'GoPlus' }] });
  const t = K.textes(d);
  ok(t.includes('Powered by Go+ Security'), 'un fait lu chez GoPlus porte « Powered by Go+ Security » (licence GoPlus)');
  ok(t.includes('read from the bytecode') && !t.includes('bytecode'), 'un fait lu dans le bytecode le dit en mots, pas par sa source brute');
  eq(t.filter((x) => /can mint more tokens/.test(x)).length, 1, 'un fait en double ne s ecrit qu une fois');
  ok(t.filter((x) => /^n=\d+$/.test(x)).length === 5, 'chaque chiffre avec son effectif (n=…)');
  ok(!t.some((x) => /\b(safe|rug|scam)\b/i.test(x)) && t.some((x) => /never a buy signal/.test(x)), 'aucun verdict ; « never a buy signal »');
  const png = K.dessine(d);
  ok(png.slice(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630, 'et la carte se dessine : un PNG 1200×630');
  const vide = K.textes({ jeton: { adr: '0x' + '1'.repeat(40), sym: 'X' }, cases: [], faits: [], mesureSur: {} });
  ok(vide.includes('Not enough measured on tokens like this one yet.'), 'sans case mesuree : elle le dit');
}

console.log('\n-- 5. le scan public (JSON) : les liens, et la phrase de chaque case --');
{
  const u = { api: 'https://api.example', site: 'https://site.example' };
  const r = K.avecLiens(LOBSTER, u);
  const a = LOBSTER.jeton.adr;
  eq(JSON.stringify(r.links), JSON.stringify({ card: u.api + '/scan/carte/' + a + '.png', share: u.api + '/s/' + a, page: u.site + '/swoge_scan.html?t=' + a }),
     'les liens : l image de la carte, la page de partage (og:image), la page du site');
  ok(r.cases.length === LOBSTER.cases.length && r.cases.every((c, i) => c.trait === LOBSTER.cases[i].trait && c.case === LOBSTER.cases[i].case && c.n === LOBSTER.cases[i].n),
     'rien n est retire ni fusionne dans le JSON (la page montre tout), les cles brutes restent');
  ok(r.cases.every((c) => c.label && c.traitLabel), 'chaque case gagne sa phrase anglaise et le nom de son trait');
  verifie(r.cases.map((c) => c.label).concat(r.cases.map((c) => c.traitLabel)), 'les phrases du JSON');
  ok(LOBSTER.cases[0].label === undefined && !LOBSTER.links && !LOBSTER.lines, 'le scan d origine n est pas modifie (il est en cache)');
  /* `lines` : ce que la page dessine sur SA carte et dans sa liste — les memes
     lignes que la carte du serveur (la page dessinait `cases` brutes : OCTEMIT,
     « code : sans emission », quatre lignes a +16,9 %). */
  const surCarte = K.plan(LOBSTER).filter((o) => o.texte !== undefined && o.taille === 22).map((o) => o.texte);
  eq(r.lines.slice(0, 5).map((l) => l.label).join(' | '), surCarte.join(' | '), 'lines : les 5 premieres = les 5 lignes de la carte du serveur, dans le meme ordre');
  ok(r.lines.length === K.casesEnAnglais(LOBSTER.cases).length && r.lines.length < LOBSTER.cases.length, 'lines : une ligne par mesure (' + LOBSTER.cases.length + ' cases → ' + r.lines.length + ' lignes)');
  ok(r.lines.every((l) => l.label && l.traitLabel && l.n > 0 && typeof l.moyenne === 'number' && !('trait' in l) && !('case' in l)), 'lines : phrase, nom du trait, effectif, moyenne — aucune cle brute');
  verifie(r.lines.map((l) => l.label).concat(r.lines.map((l) => l.traitLabel)), 'les lignes que la page montre');
  eq(r.lines.filter((l) => /^bytecode:/.test(l.label)).length, 1, 'le bytecode : une seule ligne');
}

console.log(rates ? `\ncarte_scan.test.js : RATES : ${rates}/${n}` : `\ncarte_scan.test.js : ${n} verifications OK`);
process.exit(rates ? 1 : 0);
