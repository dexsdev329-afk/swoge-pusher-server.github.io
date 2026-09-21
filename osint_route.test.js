'use strict';
/* ============================================================================
 * /osint — UNE PORTE PUBLIQUE QUI VA CHERCHER CHEZ LES AUTRES
 *
 * Les gardes de fond vivent dans `osint.js` et sont mesurees par
 * `osint.test.js`. Ce qui se joue ICI est propre a la route, et c est ce qui
 * distingue une porte publique d une fonction :
 *
 *   - elle doit refuser AVANT de consommer quoi que ce soit, et surtout
 *     avant de taper chez un tiers ;
 *   - elle doit dire OU on s est trompe, parce que « invalid input » n a
 *     jamais aide personne ;
 *   - elle ne doit pas pouvoir servir de catapulte : un releve coute une
 *     quinzaine de requetes CHEZ QUELQU UN D AUTRE, donc le debit est serre
 *     et le resultat est garde ;
 *   - et il ne doit exister AUCUNE variante de cette route qui prenne une
 *     personne.
 *
 * Le faux internet est pose AVANT que `server.js` ne soit charge : les deux
 * partagent le meme module par le cache de `require`, donc aucun essai ne
 * sort de la machine.
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-'));
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
/* Assez haut pour que les blocs qui mesurent autre chose ne butent pas
   dessus ; le bloc du debit l atteint en trois appels. */
process.env.OSINT_PAR_MIN = '3';

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

/* ---- LE FAUX INTERNET, POSE AVANT LE SERVEUR ---- */
const R = require('./osint');
const APPELS = [];
const PAGES = {
  'https://rdap.org/domain/acme.io': JSON.stringify({ events: [], entities: [] }),
  'https://crt.sh/?q=%25.acme.io&output=json': '[]',
  'https://acme.io/robots.txt': 404,
  'https://acme.io/': '<title>Acme</title><p>contact@acme.io</p>',
};
R._reseau(async (u) => {
  APPELS.push(String(u));
  const p = PAGES[String(u)];
  if (p === undefined) return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  if (typeof p === 'number') return { ok: false, status: p, headers: { get: () => '' }, text: async () => '' };
  return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => p };
});
R._resolveur({
  /* `interne.test` ne passe pas la normalisation ; c est `interne.io` qui
     resout vers la boucle locale — le cas qui compte. */
  v4: async (d) => (d === 'acme.io' ? ['8.8.8.8'] : d === 'interne.io' ? ['127.0.0.1'] : []),
  v6: async () => [], mx: async () => [], ns: async () => [], txt: async () => [],
});

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const lit = async (u) => {
    const r = await fetch('http://127.0.0.1:' + port + u);
    return { code: r.status, j: await r.json().catch(() => null),
             cache: r.headers.get('cache-control'), cors: r.headers.get('access-control-allow-origin') };
  };

  console.log('-- ce qui n est pas un domaine n entre pas, et ne coute pas une place --');
  {
    /* Chacune de ces entrees est une PERSONNE. Aucune ne doit passer, et
       aucune ne doit partir sur le reseau. */
    APPELS.length = 0;
    for (const mauvais of ['', 'Jean Dupont', 'jean.dupont@acme.io', '+33612345678', '0612345678',
                           '@jeandupont', '127.0.0.1', 'localhost', '../../etc/passwd', 'http://10.0.0.1/']) {
      const r = await lit('/osint?d=' + encodeURIComponent(mauvais));
      ok(r.code === 400 && r.j && r.j.erreur, '« ' + (mauvais || '(vide)').slice(0, 22) + ' » est refuse');
    }
    eq(APPELS.length, 0, 'et pas un seul appel n est parti : rien de tout cela ne touche le reseau');

    const r = await lit('/osint?d=x');
    ok(/domain/i.test(r.j.erreur), 'le refus dit ce qu on attend : « ' + r.j.erreur + ' »');
    ok(/person/i.test(r.j.erreur), 'et pourquoi une personne n y entre pas');

    /* Dix refus de forme, puis une vraie demande : elle doit passer, alors
       que la limite est a trois. Sinon deux fautes de frappe suffisent a
       bloquer quelqu un qui n a encore rien demande. */
    const apres = await lit('/osint/acme.io');
    ok(apres.code !== 429, 'dix entrees mal formees ne bloquent pas la suivante [' + apres.code + ']');
  }

  console.log('\n-- un releve sort, et il est partageable --');
  {
    const r = await lit('/osint/acme.io');
    eq(r.code, 200, 'la route rend le releve');
    eq(r.cors, '*', 'lisible depuis le site, qui vit sur un autre domaine');
    ok(/max-age=/.test(r.cache || ''), 'et il se garde : ' + r.cache);
    eq(r.j.domaine, 'acme.io', 'le domaine normalise');
    ok(r.j.contacts.some((c) => c.valeur === 'contact@acme.io'), 'le contact publie est la');
    ok(Array.isArray(r.j.limites) && r.j.limites.length >= 5, 'et ce que l outil ne fait PAS part avec');

    /* L entree est normalisee avant tout : la meme demande sous trois
       formes ne doit pas cogner trois fois chez le site. */
    const avant = APPELS.length;
    await lit('/osint?d=' + encodeURIComponent('https://WWW.ACME.IO/quoi'));
    await lit('/osint/acme.io.');
    eq(APPELS.length, avant, 'trois ecritures du meme domaine, zero requete de plus : le releve est garde');
  }

  console.log('\n-- un domaine qui pointe vers le reseau interne n est pas visite --');
  {
    /* La garde la plus importante d une route publique qui va chercher des
       URL. Sans elle, un domaine qui resout vers la boucle locale ou vers
       169.254.169.254 fait de cette page une sonde de notre propre machine. */
    APPELS.length = 0;
    const r = await lit('/osint/interne.io');
    eq(r.code, 200, 'le releve sort quand meme');
    eq(r.j.joignable, false, 'mais il dit que le domaine n est pas joignable publiquement');
    /* On regarde l HOTE, pas la chaine : « rdap.org/domain/interne.io » est
       une question posee au REGISTRE, pas une visite chez le site — et elle
       reste legitime pour un domaine qui ne resout vers rien de public. */
    const hotes = APPELS.map((u) => new URL(u).hostname);
    ok(!hotes.includes('interne.io'), 'et aucune requete n est partie VERS LUI [' + [...new Set(hotes)].join(', ') + ']');
    eq(r.j.contacts.length, 0, 'donc aucun contact n en sort');
  }

  console.log('\n-- la porte est publique, et elle est etroite --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const i = src.indexOf("path === '/osint'");
    const bloc = src.slice(i, i + 2200);
    ok(i > 0, 'la route existe');
    ok(!/authed|ADMIN_KEY/.test(bloc), 'aucune cle demandee : sinon elle ne sert a rien');
    ok(/access-control-allow-origin/.test(bloc), 'elle est lisible depuis le site');
    ok(/normaliseDomaine/.test(bloc), 'la forme est jugee par le module, pas par une regex de la route');
    ok(bloc.indexOf('normaliseDomaine') < bloc.indexOf('osintDebit'), 'et elle est jugee AVANT le debit');
    ok(/429/.test(bloc), 'le refus de debit se dit avec le bon code');
    const params = bloc.match(/searchParams[\s\S]{0,40}?get\('([^']+)'\)/g) || [];
    ok(params.length <= 1, 'un seul parametre en entree : ' + params.join(', '));
    /* ---- AUCUNE ROUTE NE CHERCHE PAR PERSONNE ----
     * « osint » etait dans cette liste d interdits : a l epoque, le mot
     * designait la recherche de quelqu un. Il designe maintenant le releve
     * d un DOMAINE, et ce n est pas son nom qui le garantit — c est
     * `normaliseDomaine`, mesure juste au-dessus, et les dix entrees qui
     * sont des personnes et que le bloc 1 voit refuser sans qu un appel
     * parte. Ce qu on interdit ici, ce sont les routes dont le NOM dit
     * qu elles prennent quelqu un. */
    ok(!/path (?:===|\.startsWith\()\s*'\/(identite|identity|personne|person|people|email|mail|telephone|phone|pseudo|handle|whois-person)/.test(src),
       'aucune route du serveur ne cherche par personne');
    /* Et la seule qui touche au module passe par la normalisation. */
    const routes = [...src.matchAll(/osint\.(\w+)\(/g)].map((m) => m[1]);
    eq([...new Set(routes)].sort().join(','), 'normaliseDomaine,osint',
       'le serveur n appelle du module que la normalisation et le releve');
  }

  console.log('\n-- le debit borne ce qu on peut infliger a un site tiers --');
  {
    /* Ce bloc epuise le quota : il est le dernier. Trois releves par minute
       et par adresse — de quoi regarder des domaines a la main, trop peu
       pour balayer une liste. Les domaines sont differents a chaque fois,
       sinon c est le cache qui repondrait et non le debit. */
    let vu429 = false, servis = 0;
    for (let i = 0; i < 8; i++) {
      const r = await lit('/osint/d' + i + '.example');
      if (r.code === 429) vu429 = true; else servis++;
    }
    ok(vu429, 'au-dela de la limite, la route refuse');
    ok(servis <= 4, 'et elle n en a servi que ' + servis + ' sur huit');
    const r = await lit('/osint/d0.example');
    eq(r.code, 200, 'mais un releve deja garde repond encore : le cache ne coute rien a personne');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
