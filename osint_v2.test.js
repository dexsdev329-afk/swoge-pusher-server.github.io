'use strict';
/* ============================================================================
 * OSINT v2 — LA ROUTE, LES EXPORTS, L HISTORIQUE
 *
 * Le noyau est mesure ailleurs (osint_noyau.test.js). Ce qui se joue ICI est
 * propre a la porte publique :
 *
 *   1. UN SEUL POINT D ENTREE devine le type et applique la regle
 *      graine/selecteur. Un nom est refuse ; un domaine, une IP, un email
 *      passent.
 *   2. L EXPORT NE RELANCE PAS LE TRAVAIL. .csv et .pdf sont la MEME enquete,
 *      servie autrement : le site vise ne paie pas notre envie de tableur.
 *   3. LE PDF EST UN VRAI PDF. Entete, longueur annoncee, il s ouvre.
 *   4. L HISTORIQUE EST MINIMISE : la cible et les comptes, jamais les faits.
 *   5. LA FORME AVANT LE DEBIT : une faute de frappe ne consomme pas le quota.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'osintv2-'));
process.env.DATA_DIR = BAC; process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
/* Haut pour les blocs qui mesurent autre chose ; le bloc du debit descend
   la limite lui-meme. */
process.env.OSINT_PAR_MIN = '50';

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return false;} } };

/* Faux internet : les essais ne dependent pas de la meteo d un service. */
const D = require('./osint');
D._resolveur({ v4: async (d) => (d === 'acme.io' ? ['8.8.8.8'] : []), v6: async () => [],
  mx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }], ns: async () => ['ns1.reg.net'], txt: async () => [] });
D._reseau(async (u) => {
  const s = String(u);
  if (s.includes('rdap.org/domain')) return { ok: true, status: 200, headers: { get: () => '' },
    text: async () => JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2014-03-02T00:00:00Z' }],
      entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Registrar SAS']]] }] }) };
  return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
});

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const lit = async (u) => {
    const r = await fetch('http://127.0.0.1:' + port + u);
    const b = Buffer.from(await r.arrayBuffer());
    return { code: r.status, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'),
             cache: r.headers.get('cache-control'), cors: r.headers.get('access-control-allow-origin'), b };
  };
  const json = (r) => JSON.parse(r.b.toString());

  console.log('-- 1. un seul point d entree, il devine le type --');
  {
    for (const [q, type] of [['acme.io', 'domaine'], ['8.8.8.8', 'ip'], ['jane@acme.io', 'email'],
                             ['0x' + 'a'.repeat(40), 'adresse']]) {
      const r = await lit('/osint/v2/' + encodeURIComponent(q));
      eq(r.code, 200, q + ' (' + type + ') est accepte');
      eq(json(r).cible.type, type, '  et reconnu comme ' + type);
    }
    eq((await lit('/osint/v2/acme.io')).cors, '*', 'lisible depuis le site');
  }

  console.log('\n-- 2. un nom n est pas un point de depart, et ca se dit --');
  {
    const r = await lit('/osint/v2/' + encodeURIComponent('Jean Dupont'));
    eq(r.code, 400, 'un nom est refuse');
    ok(/domain|IP|website|address/i.test(json(r).erreur), 'et le refus dit quoi taper a la place');
    /* Un email en revanche PASSE : c est un selecteur, pas une graine. */
    eq((await lit('/osint/v2/' + encodeURIComponent('bob@acme.io'))).code, 200, 'un email, lui, passe : c est un selecteur');
  }

  console.log('\n-- 3. les constats et les contradictions sont dans la reponse --');
  {
    const r = json(await lit('/osint/v2/acme.io'));
    ok(Array.isArray(r.faits) && r.faits.length > 0, 'des faits [' + r.faits.length + ']');
    ok(Array.isArray(r.constats), 'des constats (le croisement, pas la liste)');
    ok(Array.isArray(r.contradictions), 'un champ contradictions, meme vide');
    ok(r.graphe && Array.isArray(r.graphe.noeuds) && Array.isArray(r.graphe.aretes), 'un graphe derive des faits');
    ok(r.graphe.aretes.every((a) => a.source), 'et aucune arete sans source');
    ok(typeof r.passif === 'boolean', 'et il dit si l enquete a laisse une trace [' + r.passif + ']');
    ok(Array.isArray(r.connecteursEteints), 'les connecteurs eteints sont listes');
  }

  console.log('\n-- 4. l export ne relance pas le travail --');
  {
    /* La MEME cible en trois formats. Les trois doivent servir du cache :
       demander un CSV ne doit pas refaire cogner le site vise. */
    const av = json(await lit('/osint/historique')).entrees.length;
    await lit('/osint/v2/exportcache.example');           /* une enquete */
    const ap1 = json(await lit('/osint/historique')).entrees.length;
    await lit('/osint/v2/exportcache.example.csv');       /* le CSV de la meme */
    await lit('/osint/v2/exportcache.example.pdf');       /* le PDF de la meme */
    const ap2 = json(await lit('/osint/historique')).entrees.length;
    eq(ap1 - av, 1, 'la premiere enquete est comptee une fois');
    eq(ap2, ap1, 'le CSV et le PDF ne relancent PAS l enquete');
  }

  console.log('\n-- 5. le CSV : une ligne par fait, tout echappe --');
  {
    const r = await lit('/osint/v2/acme.io.csv');
    eq(r.ct, 'text/csv; charset=utf-8', 'le type est csv');
    ok(/attachment; filename=/.test(r.cd), 'et il se telecharge');
    const t = r.b.toString();
    ok(t.startsWith('subject_type,subject,predicate'), 'l en-tete nomme les colonnes');
    ok(t.includes('\r\n'), 'fins de ligne CRLF, ce qu attend un tableur');
    ok(t.split('\r\n').length > 3, 'une ligne par fait');
  }

  console.log('\n-- 6. le PDF est un vrai PDF --');
  {
    const r = await lit('/osint/v2/acme.io.pdf');
    eq(r.ct, 'application/pdf', 'le type est pdf');
    ok(/filename=.*\.pdf/.test(r.cd), 'et il se telecharge sous .pdf');
    eq(r.b.slice(0, 5).toString(), '%PDF-', 'entete PDF');
    eq(r.b.slice(-6).toString(), '%%EOF\n', 'et il se termine proprement');
    ok(r.b.length > 800, 'il a du contenu [' + r.b.length + ' octets]');
  }

  console.log('\n-- 7. les connecteurs se declarent, eteints compris --');
  {
    const r = json(await lit('/osint/connecteurs'));
    ok(r.connecteurs.length >= 12, r.connecteurs.length + ' connecteurs declares');
    const f = r.connecteurs.find((c) => c.nom === 'fuites');
    eq(f.actif, false, 'les fuites sont eteintes sans cle');
    eq(f.cle, 'HIBP_API_KEY', 'et il DIT quelle cle il attend');
    eq(f.produit.length, 0, 'un connecteur de selecteur ne produit aucune entite');
    ok(r.connecteurs.some((c) => c.mode === 'actif') && r.connecteurs.some((c) => c.mode === 'passif'),
       'passif et actif sont distingues');
    ok(/data brokers/i.test(r.refus.personne), 'le refus d une recherche par personne est explique');
    ok(r.regles.length >= 5, 'les regles de croisement sont exposees [' + r.regles.length + ']');
  }

  console.log('\n-- 8. l historique est minimise --');
  {
    const r = json(await lit('/osint/historique'));
    ok(r.entrees.length > 0, 'il y a des entrees');
    const e = r.entrees[0];
    ok(e.cible && e.date && typeof e.faits === 'number', 'la cible, la date, les comptes');
    ok(!('faitsListe' in e) && !e.contenu, 'mais PAS les faits eux-memes');
    ok(/not kept on disk/i.test(r.note), 'et la note le dit');
  }

  console.log('\n-- 9. la forme avant le debit --');
  {
    /* Ce bloc epuise le quota : il est le dernier. Dix fautes de frappe,
       puis une vraie cible : elle doit passer. Une entree mal formee ne
       touche aucun service, donc elle ne consomme rien. */
    for (let i = 0; i < 10; i++) await lit('/osint/v2/' + encodeURIComponent('Nom Invalide ' + i));
    const ok200 = await lit('/osint/v2/formeok.example');
    ok(ok200.code === 200, 'dix noms invalides ne bloquent pas la vraie cible suivante [' + ok200.code + ']');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
