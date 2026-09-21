'use strict';
/* ============================================================================
 * OSINT — LE NOM, L ASN, LA CVE : DE VRAIES SOURCES, ZERO FABRICATION
 *
 * On injecte des reponses REELLES capturees (Wikidata, GitHub, RIPEstat, NVD)
 * et on verifie la seule chose qui compte pour une recherche par nom :
 *
 *   1. un nom rend des CANDIDATS PUBLICS SEPARES, jamais une identite ;
 *   2. deux candidats ne sont JAMAIS fusionnes, meme homonymes ;
 *   3. chacun est marque non verifie, avec sa source et le rappel que
 *      « porter le meme nom n est pas etre la meme personne » ;
 *   4. ASN et CVE rendent des faits reels, sources, jamais inventes.
 * ==========================================================================*/
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const N = require('./osint_noyau');
const D = require('./osint');
require('./osint_connecteurs');

/* Reponses reelles, capturees. */
const WIKI = JSON.stringify({ search: [
  { id: 'Q7842', label: 'Vitalik Buterin', description: 'Russian-Canadian computer scientist', concepturi: 'http://www.wikidata.org/entity/Q7842' },
  { id: 'Q123', label: 'Vitalik Buterin', description: 'a different person, same name', concepturi: 'http://www.wikidata.org/entity/Q123' },
] });
const GH = JSON.stringify({ total_count: 2, items: [
  { login: 'realvitalik', type: 'User', html_url: 'https://github.com/realvitalik' },
  { login: 'fakevitalik', type: 'User', html_url: 'https://github.com/fakevitalik' },
] });
const RIPE = JSON.stringify({ data: { holder: 'GOOGLE - Google LLC', resource: '15169', announced: true } });
const NVD = JSON.stringify({ vulnerabilities: [{ cve: { id: 'CVE-2021-44228', published: '2021-12-10T00:00:00',
  descriptions: [{ lang: 'en', value: 'Apache Log4j2 JNDI features do not protect against attacker controlled LDAP.' }],
  metrics: { cvssMetricV31: [{ cvssData: { baseSeverity: 'CRITICAL', baseScore: 10 } }] } } }] });

function reseau(map) {
  D._reseau(async (u) => {
    const s = String(u);
    for (const [motif, corps] of map) if (s.includes(motif)) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => corps };
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  });
}

(async () => {

console.log('-- 1. un nom rend des candidats SEPARES, jamais une identite --');
{
  reseau([['wikidata.org', WIKI], ['api.github.com', GH]]);
  const r = await N.enquete('Vitalik Buterin', { seulement: ['wikidata', 'github_noms'], profondeur: 0 });
  const cands = r.faits.filter((f) => f.predicat === 'PUBLIC CANDIDATE');
  eq(cands.length, 4, 'deux candidats Wikidata + deux GitHub = quatre, SEPARES');
  eq(r.doublonsFondus, 0, 'AUCUN candidat fusionne, meme les deux « Vitalik Buterin »');
  /* Chaque candidat est une entite distincte. */
  const objets = new Set(cands.map((c) => c.objet.valeur));
  eq(objets.size, 4, 'quatre entites distinctes');
  ok(cands.every((c) => c.confiance === 'LOW' && !c.verifie), 'chacun est non verifie, en LOW');
  ok(cands.every((c) => /not the same person|does not confirm identity/i.test(c.pourquoi)),
     'et chacun rappelle que le meme nom n est pas la meme personne');
  ok(cands.every((c) => c.sources[0] && /wikidata|github/.test(c.sources[0])), 'chacun porte sa source publique');
  /* Les deux homonymes Wikidata restent DEUX candidats. */
  const wiki = cands.filter((c) => /Q7842|Q123/.test(c.objet.valeur));
  eq(wiki.length, 2, 'les deux homonymes Wikidata sont deux candidats, pas un');
}

console.log('\n-- 2. un nom sans resultat le DIT, sans rien inventer --');
{
  reseau([['wikidata.org', JSON.stringify({ search: [] })], ['api.github.com', JSON.stringify({ items: [] })]]);
  const r = await N.enquete('Zzxq Nonexistent', { seulement: ['wikidata', 'github_noms'], profondeur: 0 });
  eq(r.faits.filter((f) => f.predicat === 'PUBLIC CANDIDATE').length, 0, 'aucun candidat invente');
  ok(r.faits.some((f) => /no public entity/i.test(String(f.valeur || ''))), 'et il dit qu il n a rien trouve');
}

console.log('\n-- 3. le nom est detecte tout seul, l identite reste des candidats --');
{
  eq(N.detecte('Jean Dupont').type, 'personne', 'un nom multi-mots est reconnu comme personne');
  eq(N.detecte('johndoe').type, 'pseudo', 'un seul mot reste un pseudo (ambigu)');
  ok(N.ENTITES.personne.graine, 'personne est une graine…');
  ok(/SEPARATE public candidates/i.test(N.ENTITES.personne.quoi), '…mais qui ne rend que des candidats');
}

console.log('\n-- 4. ASN : l operateur reseau, reel --');
{
  reseau([['stat.ripe.net', RIPE]]);
  const r = await N.enquete('AS15169', { seulement: ['asn'], profondeur: 0 });
  eq(N.detecte('AS15169').type, 'asn', 'AS15169 est reconnu comme ASN');
  ok(r.faits.some((f) => f.predicat === 'OPERATED BY' && /Google/.test(f.objet.valeur)), 'l operateur est nomme (Google)');
  ok(r.faits.every((f) => f.sources[0] && /ripe/.test(f.sources[0])), 'avec sa source RIPE');
}

console.log('\n-- 5. CVE : la vulnerabilite, reelle, sourcee --');
{
  reseau([['nvd.nist.gov', NVD]]);
  const r = await N.enquete('CVE-2021-44228', { seulement: ['cve'], profondeur: 0 });
  eq(N.detecte('CVE-2021-44228').type, 'cve', 'la CVE est reconnue');
  ok(r.faits.some((f) => f.predicat === 'DESCRIPTION' && /Log4j/i.test(f.valeur)), 'la description reelle du NVD');
  ok(r.faits.some((f) => f.predicat === 'SEVERITY' && /CRITICAL/.test(f.valeur)), 'la severite CVSS');
  ok(r.faits.some((f) => f.predicat === 'PUBLISHED ON' && /2021-12-10/.test(f.valeur)), 'la date de publication');
  ok(r.faits.every((f) => /nvd.nist.gov/.test(f.sources[0])), 'toutes sourcees au NVD');
}

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
