'use strict';
/* ============================================================================
 * SWOGE OSINT — CE QU IL REFUSE DE FAIRE COMPTE PLUS QUE CE QU IL TROUVE
 *
 * Un outil qui va chercher des informations sur une organisation se juge sur
 * ses bords, pas sur son centre. Trouver l adresse de presse d une societe
 * sur sa page presse n a aucun interet : n importe quel navigateur le fait.
 * Ce qui compte, c est qu il soit STRUCTURELLEMENT incapable de faire les
 * cinq choses qui transforment un outil de securite en outil de fichage :
 *
 *   1. ON NE PEUT PAS LE CHERCHER PAR UNE PERSONNE. L entree est un domaine.
 *      Un nom, un mail, un numero, un pseudo n y entrent pas. Ce n est pas
 *      une politesse d interface : il n existe aucun chemin de code qui
 *      prenne une personne en argument.
 *   2. IL NE FABRIQUE JAMAIS UNE ADRESSE. Pas de prenom.nom@domaine. Il lit
 *      ce qui est ecrit, ou il ne rend rien.
 *   3. IL NE COLLECTE PAS UNE ADRESSE PERSONNELLE, meme imprimee en clair.
 *   4. IL NE CONTOURNE RIEN. robots.txt obei, UA annonce, un refus est un
 *      refus — et surtout : il ne sait parler qu a trois hotes.
 *   5. IL NE CONCLUT PAS A UNE PROPRIETE. « publiquement associe a » n est
 *      pas « proprietaire de », et seul un acte public fait passer de l un
 *      a l autre.
 *
 * Et une garde qui n a rien a voir avec la vie privee mais tout avec le fait
 * que la route soit publique : une adresse qui resout vers le reseau interne
 * ne doit JAMAIS etre visitee. Sans elle, cette page devient une sonde de
 * notre propre infrastructure pour qui veut.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const R = require('./osint');

/* ---- UN FAUX INTERNET ----
 * Tout ce fichier tourne sans reseau : les essais ne doivent pas dependre de
 * la meteo de crt.sh ni de l humeur d un registre. Le faux internet garde
 * AUSSI la trace de chaque appel — c est ce qui permet de verifier a qui le
 * module parle, et combien de fois. */
const APPELS = [];
function faussenet(pages) {
  R._reseau(async (url, opts) => {
    APPELS.push({ url: String(url), ua: opts && opts.headers ? opts.headers['user-agent'] : null });
    const p = pages[String(url)];
    if (p === undefined) return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
    if (typeof p === 'number') return { ok: false, status: p, headers: { get: () => '' }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => p };
  });
}
const RESOLVEUR_MUET = { v4: async () => [], v6: async () => [], mx: async () => [], ns: async () => [], txt: async () => [] };

(async () => {

console.log('\n-- 1. l entree est un domaine : une personne n y entre pas --');
{
  /* Le coeur de la garantie. Si l un de ces appels rendait autre chose que
     null, il existerait un moyen de chercher quelqu un. */
  const personnes = ['Jean Dupont', 'jean.dupont@acme.io', '+33 6 12 34 56 78', '0612345678',
                     '@jeandupont', 'jeandupont', 'Dupont', 'Jean', 'jean dupont acme'];
  let refuses = 0;
  for (const p of personnes) if (R.normaliseDomaine(p) === null) refuses++;
  eq(refuses, personnes.length, 'un nom, un mail, un numero, un pseudo : aucun n est une entree valable');

  /* Et l inverse : un domaine colle sous toutes ses formes doit passer. Une
     garde qui refuse tout est facile et inutile. */
  eq(R.normaliseDomaine('https://WWW.Acme.IO/contact?x=1'), 'acme.io', 'une URL collee rend son domaine');
  eq(R.normaliseDomaine('acme.io.'), 'acme.io', 'le point final tombe');
  eq(R.normaliseDomaine('  ACME.IO '), 'acme.io', 'les espaces et la casse aussi');
  eq(R.normaliseDomaine('sous.acme.io'), 'sous.acme.io', 'un sous-domaine reste un sous-domaine');

  /* Les noms qui ne designent pas l internet public. */
  for (const d of ['localhost', 'serveur.local', 'db.internal', 'x.onion', 'machine'])
    ok(R.normaliseDomaine(d) === null, 'refuse ' + d);

  /* Une IP se reconnait, elle ne se fait pas passer pour un domaine. */
  eq(R.normaliseDomaine('10.0.0.1'), null, 'une IP n est pas un domaine');

  /* La signature des fonctions publiques : aucune ne prend une personne.
     Verification STRUCTURELLE — une future main qui ajoute reconPersonne()
     fait tomber cet essai. */
  const exportes = Object.keys(R);
  const suspects = exportes.filter((k) => /personne$|parNom|parMail|parEmail|parTel|cherchePersonne|identite/i.test(k));
  eq(suspects.length, 0, 'aucune fonction exportee ne cherche par personne');
  ok(typeof R.osint === 'function' && R.osint.length === 1, 'osint prend UN argument : le domaine');
}

console.log('\n-- 2. la garde SSRF : le reseau interne n est jamais visite --');
{
  /* Cette route est publique. Sans cette garde, un domaine qui resout vers
     169.254.169.254 lit les jetons de la machine qui heberge le serveur. */
  const internes = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
                    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
                    '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1'];
  let bloques = 0;
  for (const ip of internes) if (!R.estIpPublique(ip)) bloques++;
  eq(bloques, internes.length, 'les ' + internes.length + ' familles d adresses internes sont refusees');
  /* 172.32 n est PAS prive : une garde trop large casse de vrais sites. */
  ok(R.estIpPublique('172.32.0.1'), '172.32.0.1 reste publique — la garde ne deborde pas');
  ok(R.estIpPublique('8.8.8.8') && R.estIpPublique('2606:4700::1111'), 'une vraie adresse publique passe');
  ok(!R.estIpPublique('999.1.1.1') && !R.estIpPublique('pas une ip'), 'ce qui n est pas une adresse n est pas publique');
}

console.log('\n-- 3. aucune adresse mail n est fabriquee --');
{
  /* La regle la plus facile a violer sans s en rendre compte : il suffirait
     d une ligne « local = prenom + "." + nom ». On la cherche dans le
     source, et on verifie le comportement. */
  const src = fs.readFileSync(path.join(__dirname, 'osint.js'), 'utf8');
  const fabrique = /['"`]\s*\+\s*['"`]@['"`]|@['"`]\s*\+\s*(?:domaine|dom)\b|`\$\{[^}]*\}@\$\{/;
  ok(!fabrique.test(src), 'le source ne compose jamais une adresse autour d un @');

  /* Et le comportement : une page qui ne contient aucune adresse n en rend
     aucune, meme quand elle donne un nom et un domaine — c est exactement la
     situation ou un outil de prospection en inventerait une. */
  const page = '<h3>Jane Doe</h3><p>Chief Executive Officer of acme.io</p>';
  eq(R.mailsDe(page, 'equipe').length, 0, 'un nom + un domaine ne produisent PAS une adresse');
  const p = R.personnesDe(page, 'equipe');
  eq(p.length, 1, 'la personne est trouvee');
  eq(p[0].mail, null, 'mais son adresse reste nulle : elle n est ecrite nulle part');
}

console.log('\n-- 4. une adresse personnelle n est pas collectee --');
{
  /* Filtre applique a l EXTRACTION, pas a l affichage : ce qui n est pas
     collecte ne peut pas fuiter par un oubli de gabarit plus tard. */
  for (const a of ['jane@gmail.com', 'marc@free.fr', 'x@proton.me', 'y@outlook.fr', 'z@yahoo.com', 'q@yopmail.com'])
    ok(R.mailRecevable(a, 'legal') === null, a + ' : messagerie grand public, jamais collectee');
  ok(R.mailRecevable('contact@acme.io', 'autre'), 'une boite de role du domaine passe de n importe quelle page');
  ok(R.mailRecevable('contact@example.com', 'legal') === null, 'un exemple de documentation n est pas un contact');
  ok(R.mailRecevable('logo@2x.png', 'legal') === null, 'un nom de fichier n est pas une adresse');
  ok(R.mailRecevable('a1b2c3d4e5f6a7b8@sentry.io', 'legal') === null, 'une cle de service non plus');
  ok(R.mailRecevable('noreply@acme.io', 'legal') === null, 'une boite qui ne recoit rien n est pas un contact');

  /* La distinction qui protege les gens sans vider l outil : une boite de
     role ne designe personne et sort partout ; une adresse NOMINATIVE ne
     sort que d une page faite pour etre contactee. */
  ok(R.mailRecevable('jane.doe@acme.io', 'autre') === null, 'une adresse nominative ne sort PAS d une page quelconque');
  ok(R.mailRecevable('jane.doe@acme.io', 'equipe'), 'elle sort de la page equipe, ou l organisation l a publiee');
  ok(R.mailRecevable('jane.doe@acme.io', 'legal'), 'et des mentions legales');
  eq(R.mailRecevable('presse@acme.io', 'autre').role, true, 'une boite de role se sait boite de role');
  eq(R.mailRecevable('jane.doe@acme.io', 'legal').role, false, 'une adresse nominative se sait nominative');
}

console.log('\n-- 5. qui porte le titre : la convention d ecriture, pas la distance --');
{
  const equipe = R.personnesDe('<li>Alice Martin<span>CEO</span></li><li>Bob Durand<span>CFO</span></li>', 'equipe');
  eq(equipe.length, 2, 'deux cartes collees donnent deux personnes');
  eq(equipe[0].complet + ' / ' + equipe[0].fonction, 'Alice Martin / CEO', 'le nom qui PRECEDE porte le titre');
  eq(equipe[1].complet + ' / ' + equipe[1].fonction, 'Bob Durand / CFO', 'et le titre s arrete avant le nom suivant');

  const legal = R.personnesDe('<p>Directeur de la publication : Marc Lefevre</p>', 'legal');
  eq(legal.length, 1, 'les mentions legales nomment leur directeur de publication');
  eq(legal[0].fonction, 'Directeur de la publication', 'le deux-points inverse l ordre, et le titre reste propre');

  const carte = R.personnesDe('<h3>Jane Doe</h3><p>Chief Technology Officer</p><a href="mailto:jane.doe@acme.io">jane.doe@acme.io</a>', 'equipe');
  eq(carte[0].fonction, 'Chief Technology Officer', 'un titre de trois mots n est pas coupe');
  eq(carte[0].mail, 'jane.doe@acme.io', 'l adresse imprimee A COTE est rattachee');

  /* Le faux positif qui guette tout outil de ce genre : le decor d un pied
     de page ressemble a des noms propres. */
  eq(R.personnesDe('<footer>Privacy Policy · All Rights Reserved · Head Office · New York · Hong Kong</footer>', 'legal').length,
     0, 'un pied de page decoratif ne designe personne');
  eq(R.personnesDe('<p>Chief Technology Officer</p>', 'equipe').length, 0, 'une fonction sans nom ne cree personne');
  eq(R.personnesDe('<p>Jane Doe</p>', 'equipe').length, 0, 'un nom sans fonction non plus');
  eq(R.personnesDe('<p>Tom Clark, Chief Executive Officer</p>', 'autre').length, 0,
     'et une page qui n est pas faite pour ca ne donne AUCUNE personne');
}

console.log('\n-- 5 bis. les comptes publies, et a qui ils appartiennent --');
{
  /* Ce qui rend ceci sur : on ne part JAMAIS d un compte pour trouver
     quelqu un. Il n y a pas d entree par une personne, donc pas de pistage
     par pseudo a travers les plateformes. On part d un domaine, et on lit
     ce que l organisation a elle-meme imprime a cote d un nom. */
  const pro = R.profilsDe('<a href="https://www.linkedin.com/in/jane-doe">a</a>'
    + '<a href="https://github.com/janedoe">b</a>'
    + '<a href="https://orcid.org/0000-0002-1825-0097">c</a>'
    + '<a href="https://x.com/janedoe">d</a>'
    + '<a href="https://www.instagram.com/janedoe">e</a>'
    + '<a href="https://bsky.app/profile/jane.bsky.social">f</a>'
    + '<a href="https://reddit.com/u/janedoe">g</a>');
  eq(pro.length, 7, 'annuaires professionnels ET comptes sociaux courants');
  eq(pro.filter((x) => x.genre === 'pro').length, 3, 'et chacun sait lequel il est');

  /* Seule la racine d un compte passe : le reste, ce n est pas quelqu un. */
  for (const u of ['https://github.com/acme/site', 'https://instagram.com/p/Cabc123',
                   'https://www.linkedin.com/company/acme', 'https://youtube.com/watch',
                   'https://x.com/acme/status/12345', 'https://pinterest.com/pin/create/button'])
    eq(R.profilsDe('<a href="' + u + '">x</a>').length, 0, u.slice(8, 48) + ' n est pas un compte');

  /* Les boutons de partage tiennent dans le motif d un pseudo et vivent
     dans le pied de page de la moitie du web. Sans INTERDITS, chaque site
     rendrait un « compte » qui n existe pas. */
  for (const u of ['https://x.com/share?url=x', 'https://www.facebook.com/sharer.php?u=x',
                   'https://x.com/intent/post', 'https://t.me/share/url?url=x'])
    eq(R.profilsDe('<a href="' + u + '">partager</a>').length, 0, 'bouton de partage ecarte : ' + u.slice(8, 44));

  /* A QUI. Le cas qui a fait reecrire la regle : deux cartes qui se touchent. */
  const deux = R.personnesDe('<div><h3>Jane Doe</h3><p>CTO</p>'
    + '<a href="https://www.linkedin.com/in/jane-doe">LinkedIn</a></div>'
    + '<div><h3>Bob Durand</h3><p>CFO</p></div>', 'equipe');
  eq(deux.find((p) => p.complet === 'Jane Doe').profils[0].url, 'https://www.linkedin.com/in/jane-doe',
     'le compte va a celle dont le nom precede le lien');
  eq(deux.find((p) => p.complet === 'Bob Durand').profils.length, 0,
     'et PAS a son voisin de carte, qui n a rien publie');

  eq(R.personnesDe('<li><a href="https://www.linkedin.com/in/ana-ruiz">Ana Ruiz</a> <span>Founder</span></li>', 'equipe')[0].profils[0].url,
     'https://www.linkedin.com/in/ana-ruiz', 'un nom ecrit DANS l ancre compte aussi');

  /* LE CAS QUI A COUTE LE PLUS CHER EN AJOUTANT LES RESEAUX SOCIAUX.
     `linkedin.com/company/acme` se reconnait a son URL ; le X d une societe
     s ecrit exactement comme celui d une personne. Le compte de la boite
     atterrissait sur la derniere personne nommee au-dessus du pied de page. */
  eq(R.personnesDe('<p>Ana Ruiz, Founder</p><footer><a href="https://x.com/acmecorp">us</a>'
     + '<a href="https://instagram.com/acmecorp">ig</a></footer>', 'equipe')[0].profils.length, 0,
     'les comptes d un PIED DE PAGE n appartiennent a personne');
  eq(R.personnesDe('<nav><a href="https://x.com/acmecorp">X</a></nav><p>Ana Ruiz, Founder</p>', 'equipe')[0].profils.length, 0,
     'ceux d une barre de navigation non plus');

  /* Une personne qui en publie trois en publie trois : n en montrer qu un
     serait choisir a sa place. Les annuaires professionnels d abord. */
  const trois = R.personnesDe('<li>Ana Ruiz <span>Founder</span>'
    + '<a href="https://x.com/anaruiz">x</a>'
    + '<a href="https://linkedin.com/in/ana-ruiz">li</a>'
    + '<a href="https://instagram.com/anaruiz">ig</a></li>', 'equipe')[0];
  eq(trois.profils.length, 3, 'les trois comptes sortent');
  eq(trois.profils[0].genre, 'pro', 'et le professionnel passe devant');
  eq(R.personnesDe('<p>Tom Clark, CEO</p>', 'equipe')[0].profils.length, 0,
     'quelqu un qui n en publie aucun n en recoit aucun');

  /* Le titre ne doit pas avaler ce qui traine autour du lien. */
  eq(R.personnesDe('<li>Ana Ruiz <span>Founder</span> <a href="https://github.com/acme/site">repo</a></li>', 'equipe')[0].fonction,
     'Founder', 'et la fonction s arrete au dernier mot qui en fait partie');
  eq(R.personnesDe('<p>Sophie Bernard, Head of Security</p>', 'equipe')[0].fonction,
     'Head of Security', 'les mots qui RELIENT une fonction sont gardes');
  eq(R.personnesDe('<p>Marc Petit, Directeur de la publication</p>', 'legal')[0].fonction,
     'Directeur de la publication', 'en francais aussi');
}

console.log('\n-- 6. la propriete ne se deduit pas --');
{
  eq(R.lienAuDomaine(null).lien, 'PUBLICLY ASSOCIATED WITH DOMAIN', 'par defaut : associe, pas proprietaire');
  eq(R.lienAuDomaine('equipe').lien, 'PUBLICLY ASSOCIATED WITH DOMAIN', 'une page equipe n etablit pas une propriete');
  eq(R.lienAuDomaine('contact').lien, 'PUBLICLY ASSOCIATED WITH DOMAIN', 'une page contact non plus');
  eq(R.lienAuDomaine('rdapClair').lien, 'DOMAIN OWNER', 'un titulaire en clair au registre, oui');
  eq(R.lienAuDomaine('legal').lien, 'DOMAIN OWNER', 'un directeur de publication declare, oui');
  ok(R.lienAuDomaine('equipe').preuve.includes('does not establish ownership'),
     'et le defaut DIT qu il n etablit pas la propriete');

  /* Le texte montre aux gens est en anglais. */
  const src = fs.readFileSync(path.join(__dirname, 'osint.js'), 'utf8');
  const lignes = src.split('\n').filter((l) => /lien:|preuve:/.test(l));
  ok(lignes.every((l) => !/[éèêàùôîç]/.test(l.split('//')[0])), 'les libelles du lien sont en anglais');
}

console.log('\n-- 7. la confiance vient de la NATURE de la source --');
{
  eq(R.confiance('legal').niveau, 'HIGH', 'des mentions legales engagent celui qui les publie');
  eq(R.confiance('securite').niveau, 'HIGH', 'un security.txt est pose expres pour etre lu');
  eq(R.confiance('rdapClair').niveau, 'HIGH', 'un titulaire en clair au registre est un acte');
  eq(R.confiance('contact').niveau, 'MEDIUM', 'une page contact est une intention');
  eq(R.confiance('bloc').niveau, 'MEDIUM', 'la proximite reste une proximite');
  eq(R.confiance('autre').niveau, 'LOW', 'trouve sur le site, mais pas sur une page faite pour ca');
  eq(R.confiance('tiers').niveau, 'LOW', 'un index tiers non confirme');
  for (const c of ['legal', 'securite', 'contact', 'equipe', 'bloc', 'autre', 'tiers'])
    ok(R.confiance(c).pourquoi.length > 20, c + ' : le niveau part avec sa raison en clair');
}

console.log('\n-- 8. security.txt, robots.txt : on lit pour OBEIR --');
{
  const s = R.litSecurityTxt('# commentaire\nContact: mailto:security@acme.io\nContact: https://acme.io/vdp\nExpires: 2027-01-01T00:00:00Z\nPreferred-Languages: en, fr\n');
  eq(s.contacts.length, 2, 'les deux contacts sont lus');
  eq(s.expire, '2027-01-01T00:00:00Z', 'et la date de peremption');
  eq(s.langues, 'en, fr', 'et les langues');

  const rb = { lu: true, interdits: ['/admin', '/equipe'] };
  ok(R.robotsPermet(rb, '/contact'), '/contact est permis');
  ok(!R.robotsPermet(rb, '/equipe'), '/equipe est interdit : on ne le lit pas');
  ok(!R.robotsPermet({ lu: true, interdits: ['/'] }, '/contact'), 'un Disallow: / ferme tout');
  ok(R.robotsPermet({ lu: false, interdits: [] }, '/x'), 'pas de robots.txt : rien n est interdit');
}

console.log('\n-- 9. un releve complet, contre un faux internet --');
let releve = null;
{
  APPELS.length = 0;
  R._resolveur({
    v4: async (d) => (d === 'acme.io' ? ['203.0.113.9', '8.8.8.8'] : []),
    v6: async () => [],
    mx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }],
    ns: async () => ['ns1.registrar.net', 'ns2.registrar.net'],
    txt: async (d) => (d === '_dmarc.acme.io' ? [['v=DMARC1; p=reject']] : [['v=spf1 include:_spf.google.com ~all']]),
  });
  faussenet({
    'https://rdap.org/domain/acme.io': JSON.stringify({
      events: [{ eventAction: 'registration', eventDate: '2014-03-02T00:00:00Z' },
               { eventAction: 'expiration', eventDate: '2027-03-02T00:00:00Z' }],
      status: ['client transfer prohibited'],
      nameservers: [{ ldhName: 'NS1.REGISTRAR.NET' }],
      entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Registrar SAS']]] },
                 { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY']]] }],
    }),
    'https://rdap.org/ip/8.8.8.8': JSON.stringify({ name: 'GOGL', country: 'US',
      startAddress: '8.8.8.0', endAddress: '8.8.8.255',
      entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Google LLC']]] }] }),
    'https://crt.sh/?q=%25.acme.io&output=json': JSON.stringify([
      { name_value: 'www.acme.io\nacme.io', issuer_name: 'C=US, O=Let\'s Encrypt, CN=R3' },
      { name_value: 'staging.acme.io', issuer_name: 'C=US, O=Let\'s Encrypt, CN=R3' },
      { name_value: '*.vpn.acme.io', issuer_name: 'C=US, O=DigiCert Inc' },
    ]),
    'https://acme.io/robots.txt': 'User-agent: *\nDisallow: /a-propos\n',
    'https://acme.io/.well-known/security.txt': 'Contact: mailto:security@acme.io\nExpires: 2027-01-01T00:00:00Z\n',
    'https://acme.io/mentions-legales': '<p>Directeur de la publication : Marc Lefevre</p><p>presse@acme.io</p><a href="tel:+33145678900">01 45 67 89 00</a>',
    'https://acme.io/contact': '<a href="mailto:contact@acme.io">nous ecrire</a><p>Jane Doe, Chief Technology Officer — jane.doe@acme.io <a href="https://www.linkedin.com/in/jane-doe">LinkedIn</a> <a href="https://x.com/janedoe">X</a></p><p>ecrivez-nous sur perso.truc@gmail.com</p>',
    'https://acme.io/team': 403,
    'https://acme.io/': '<title>Acme — build things</title><p>hello@acme.io</p><p>Tom Clark, Chief Executive Officer</p>',
  });
  releve = await R.osint('https://WWW.ACME.IO/quelque-chose');

  eq(releve.domaine, 'acme.io', 'le domaine est normalise avant tout');
  eq(releve.infra.dns.hebergeurMail, 'google.com', 'le courrier est chez google — le MX le dit, on ne demande rien de plus');
  eq(releve.infra.dns.dmarc, 'v=DMARC1; p=reject', 'DMARC est lu');
  ok(releve.infra.dns.spf.startsWith('v=spf1'), 'SPF aussi');
  eq(releve.infra.rdap.registraire, 'Registrar SAS', 'le registraire est nomme');
  eq(releve.infra.rdap.cree, '2014-03-02', 'et la date de creation');

  /* Le point le plus important du releve : le titulaire est MASQUE, et le
     releve le DIT au lieu de laisser un champ vide qu on lirait comme « pas
     cherche ». Une absence nommee vaut mieux qu un silence. */
  eq(releve.infra.rdap.titulaire, null, 'un titulaire redige ne devient PAS un nom');
  eq(releve.infra.titulaireMasque, true, 'et le releve dit qu il est masque');

  eq(releve.infra.certs.sousDomaines.join(','), 'staging.acme.io,vpn.acme.io,www.acme.io',
     'les sous-domaines viennent du journal public des certificats, etoile rognee');
  eq(releve.infra.reseaux[0].operateur, 'Google LLC', 'le reseau de l IP publique est identifie');

  /* 203.0.113.9 est une plage de documentation : elle ne doit pas etre
     interrogee, et elle ne doit pas non plus arreter le releve. */
  ok(!releve.infra.reseaux.some((r) => r.ip === '203.0.113.9'), 'une IP non routable n est pas interrogee');

  eq(releve.securityTxt.contacts[0], 'mailto:security@acme.io', 'le security.txt est lu');
  const mails = releve.contacts.filter((c) => c.type === 'email').map((c) => c.valeur).sort();
  eq(mails.join(','), 'contact@acme.io,hello@acme.io,jane.doe@acme.io,presse@acme.io,security@acme.io',
     'les adresses publiees sont relevees');
  ok(!mails.includes('perso.truc@gmail.com'), 'et celle chez gmail ne l est PAS, meme imprimee en clair');
  /* Et elle n entre pas non plus par la fenetre : l extrait du contact
     VOISIN la recopiait, trois lignes apres le filtre qui la refusait. */
  ok(releve.contacts.every((c) => !/gmail/.test(c.extrait)),
     'ni dans l extrait d un autre contact, qui la recopiait');
  ok(releve.personnes.every((p) => !/gmail/.test(p.extrait)), 'ni dans celui d une personne');
  /* Le caviardage ne mange pas l adresse dont l extrait parle. */
  const jd = releve.contacts.find((c) => c.valeur === 'jane.doe@acme.io');
  ok(jd.extrait.includes('jane.doe@acme.io'), 'mais l adresse dont l extrait parle y reste [' + jd.extrait + ']');

  const sec = releve.contacts.find((c) => c.valeur === 'security@acme.io');
  eq(sec.confiance, 'HIGH', 'celle du security.txt est HIGH');
  eq(releve.contacts.find((c) => c.valeur === 'presse@acme.io').confiance, 'HIGH', 'celle des mentions legales aussi');
  eq(releve.contacts.find((c) => c.valeur === 'contact@acme.io').confiance, 'MEDIUM', 'celle de la page contact est MEDIUM');
  eq(releve.contacts.find((c) => c.valeur === 'hello@acme.io').confiance, 'LOW', 'celle de l accueil est LOW');
  eq(releve.contacts.find((c) => c.valeur === 'jane.doe@acme.io').nominatif, true, 'une adresse nominative se signale');
  eq(releve.contacts.find((c) => c.valeur === 'contact@acme.io').nominatif, false, 'une boite de role aussi');
  ok(releve.contacts.every((c) => c.source && c.vu && c.verifie === true),
     'chaque contact porte son URL, sa date, et le fait qu on l ait vu nous-memes');
  ok(releve.contacts.every((c) => c.extrait), 'et l extrait ou il a ete lu — de quoi contester');

  const tel = releve.contacts.find((c) => c.type === 'phone');
  eq(tel.valeur, '+33145678900', 'le telephone vient d un lien tel:, pose POUR etre appele');

  const marc = releve.personnes.find((p) => p.complet === 'Marc Lefevre');
  eq(marc.confiance, 'HIGH', 'le directeur de publication est HIGH : c est un acte');
  eq(marc.lien, 'DOMAIN OWNER', 'et lui seul peut etre dit proprietaire');
  const jane = releve.personnes.find((p) => p.complet === 'Jane Doe');
  eq(jane.lien, 'PUBLICLY ASSOCIATED WITH DOMAIN', 'Jane est associee, pas proprietaire');
  eq(jane.confiance, 'MEDIUM', 'son adresse est collee a son nom : MEDIUM, pas plus');
  eq(jane.profils[0].url, 'https://www.linkedin.com/in/jane-doe', 'et son profil professionnel, imprime juste apres son nom');
  eq(jane.profils.map((x) => x.genre).join(','), 'pro,social', 'et son compte X, imprime a cote — le professionnel devant');
  eq(marc.profils.length, 0, 'Marc n en a pas : aucun lien n est rattache a lui');
  ok(!releve.personnes.some((p) => p.complet === 'Tom Clark'),
     'Tom Clark, nomme sur l accueil, ne devient PAS une fiche : l accueil n est pas une page de contact');

  eq(releve.organisation.nom, 'Acme — build things', 'faute de titulaire en clair, on tombe sur l enseigne');
  eq(releve.organisation.confiance, 'LOW', 'et on dit que c est une enseigne, pas une entite legale');
}

console.log('\n-- 10. il ne parle qu a trois hotes, et n insiste jamais --');
{
  /* La garantie « aucune base fuitee » n est pas une promesse : c est la
     liste, close, des hotes que le module sait joindre. */
  const hotes = [...new Set(APPELS.map((a) => new URL(a.url).hostname))].sort();
  eq(hotes.join(','), 'acme.io,crt.sh,rdap.org',
     'le domaine vise, le registre, et le journal des certificats. Rien d autre.');

  ok(APPELS.every((a) => a.ua === R.UA), 'chaque appel s annonce sous le meme nom');
  ok(R.UA.includes('http'), 'et laisse une adresse ou nous refuser');

  /* Un 403 est un refus. On ne repasse pas. */
  const surTeam = APPELS.filter((a) => a.url === 'https://acme.io/team');
  eq(surTeam.length, 1, 'la page qui nous a refuses n est demandee QU UNE fois');
  const team = releve.pages.find((p) => p.chemin === '/team');
  eq(team.refus, true, 'et le refus est note comme un fait');

  /* robots.txt : /a-propos etait interdit. Il ne doit pas avoir ete demande. */
  ok(!APPELS.some((a) => a.url.includes('/a-propos')), '/a-propos, interdit par robots.txt, n est jamais demande');
  const saute = releve.pages.find((p) => p.chemin === '/a-propos');
  eq(saute.saute, 'disallowed by robots.txt', 'et la raison du saut est ecrite');

  /* Le budget borne ce qu une route publique peut infliger a un site. */
  const surAcme = APPELS.filter((a) => new URL(a.url).hostname === 'acme.io');
  ok(surAcme.length <= R.PAGES_MAX + 1, 'au plus ' + R.PAGES_MAX + ' pages, plus robots.txt [' + surAcme.length + ']');
}

console.log('\n-- 11. le graphe : une arete sans source n existe pas --');
{
  const g = releve.graphe;
  ok(g.noeuds.length > 5 && g.aretes.length > 5, 'le graphe a de quoi etre lu [' + g.noeuds.length + ' noeuds, ' + g.aretes.length + ' aretes]');
  ok(g.aretes.every((a) => a.source), 'CHAQUE arete porte la source qui la documente');
  ok(g.aretes.every((a) => ['HIGH', 'MEDIUM', 'LOW'].includes(a.confiance)), 'et son niveau de confiance');
  const ids = new Set(g.noeuds.map((x) => x.id));
  ok(g.aretes.every((a) => ids.has(a.de) && ids.has(a.vers)), 'aucune arete ne pend dans le vide');

  /* Une personne dans un graphe d infrastructure doit sauter aux yeux comme
     une exception, pas se fondre dans les machines. */
  const humains = g.noeuds.filter((x) => x.humain);
  eq(humains.length, 2, 'les deux personnes sont marquees humain');
  ok(humains.every((x) => x.type === 'personne'), 'et elles sont les SEULES');
  ok(g.noeuds.filter((x) => x.type !== 'personne').every((x) => x.humain === false),
     'aucun noeud technique ne se fait passer pour quelqu un');

  /* L arete qui relie une personne au domaine dit le lien, pas une conclusion. */
  const aMarc = g.aretes.find((a) => a.de === 'person:Marc Lefevre');
  eq(aMarc.relation, 'DOMAIN OWNER', 'Marc est declare : l arete le dit');
  const aJane = g.aretes.find((a) => a.de === 'person:Jane Doe' && a.vers.startsWith('domain:'));
  eq(aJane.relation, 'PUBLICLY ASSOCIATED WITH DOMAIN', 'Jane ne l est pas : l arete le dit aussi');

  /* Le sous-domaine vient d un journal de certificats : il n a pas ete vu
     repondre. L arete le dit en LOW, et le noeud porte verifie=false. */
  const sub = g.noeuds.find((x) => x.type === 'sousdomaine');
  eq(sub.verifie, false, 'un sous-domaine certifie n est pas un sous-domaine VU');
  eq(g.aretes.find((a) => a.vers === sub.id).confiance, 'LOW', 'et son arete vaut LOW');

  /* Les trois calques que la page permet d eteindre. */
  eq(g.filtres.join(','), 'infrastructure,organization,contacts', 'les trois calques sont nommes');
  ok(g.noeuds.every((x) => g.filtres.includes(x.filtre)), 'chaque noeud est range dans un calque');
  ok(g.noeuds.filter((x) => x.type === 'personne').every((x) => x.filtre === 'contacts'),
     'les personnes vivent dans le calque qu on peut eteindre d un clic');
}

console.log('\n-- 12. un domaine injoignable rend un releve, pas une panne --');
{
  APPELS.length = 0;
  R._resolveur(RESOLVEUR_MUET);
  faussenet({});
  const r = await R.osint('nexistepas.example');
  eq(r.joignable, false, 'le releve DIT que le domaine ne resout pas');
  eq(r.contacts.length, 0, 'et ne pretend rien avoir trouve');
  ok(!APPELS.some((a) => new URL(a.url).hostname === 'nexistepas.example'),
     'on ne frappe pas a la porte d un domaine qui ne resout vers rien');
  ok(Array.isArray(r.limites) && r.limites.length >= 5, 'et il porte quand meme ce qu il ne fait PAS');

  /* Une entree qui n est pas un domaine s arrete avant tout reseau. */
  APPELS.length = 0;
  let jete = null;
  try { await R.osint('Jean Dupont'); } catch (e) { jete = e.message; }
  ok(jete && /domain/i.test(jete), 'une personne en entree est refusee, en clair');
  eq(APPELS.length, 0, 'et sans qu un seul appel reseau soit parti');
}

console.log('\n-- 13. ce qu il ne fait pas est ecrit, en anglais, dans le releve --');
{
  const t = R.LIMITES.join(' ');
  ok(/cannot be searched by a person/i.test(t), 'on ne peut pas le chercher par une personne');
  ok(/guessed/i.test(t) && /built from a name/i.test(t), 'aucune adresse n est devinee ni fabriquee a partir d un nom');
  ok(/leaked or private database/i.test(t), 'aucune base fuitee');
  ok(/anti-bot/i.test(t) && /bypassed/i.test(t), 'aucun contournement');
  ok(/robots\.txt is obeyed/i.test(t), 'robots.txt est obei');
  ok(/cannot look up someone/i.test(t) && /from a name or a handle/i.test(t),
     'aucun pistage par pseudo a travers les plateformes');
  ok(/PUBLICLY ASSOCIATED WITH DOMAIN/.test(t), 'et la propriete ne se deduit pas');
  ok(!/[éèêàùôîçœ]/.test(t), 'le texte montre aux gens est en anglais');
}

console.log('\n-- 14. le corps recu est plafonne --');
{
  /* Un site hostile peut repondre un flux sans fin. La lecture s arrete. */
  R._reseau(async () => ({
    ok: true, status: 200, headers: { get: () => 'text/html' },
    body: { getReader: () => { let n = 0; return {
      read: async () => (n++ > 10000 ? { done: true } : { done: false, value: new Uint8Array(64 * 1024) }),
      cancel: async () => {} }; } },
  }));
  const r = await R.recuperePage('https://acme.io/');
  ok(r.corps.length <= R.TAILLE_MAX, 'un flux sans fin est coupe a ' + R.TAILLE_MAX + ' octets [' + r.corps.length + ']');
}

console.log('\n-- 15. la forme que la page lit ne bouge pas sans qu on le sache --');
{
  /* La page et le serveur vivent dans deux depots. Renommer un champ ici est
     indolore a l essai, invisible au deploiement, et casse la page en
     silence — le genre de panne qui se decouvre par une capture d ecran
     d un joueur. On fige donc la liste des chemins que le peintre lit.
     Si l un disparait, c est ICI que ca tombe, pas chez quelqu un. */
  const CHEMINS = [
    'domaine', 'ms', 'joignable', 'limites', 'organisation.nom', 'organisation.verifie',
    'organisation.confiance', 'organisation.pourquoi', 'organisation.source',
    'infra.dns.a', 'infra.dns.aaaa', 'infra.dns.ns', 'infra.dns.spf', 'infra.dns.dmarc',
    'infra.dns.hebergeurMail', 'infra.dns.mx.0.hote', 'infra.dns.mx.0.prio',
    'infra.rdap.registraire', 'infra.rdap.cree', 'infra.rdap.expire', 'infra.rdap.etats',
    'infra.certs.sousDomaines', 'infra.certs.total', 'infra.certs.emetteurs.0.nom', 'infra.certs.emetteurs.0.n',
    'infra.reseaux.0.trouve', 'infra.reseaux.0.ip', 'infra.reseaux.0.operateur', 'infra.reseaux.0.pays',
    'contacts.0.type', 'contacts.0.valeur', 'contacts.0.nominatif', 'contacts.0.source',
    'contacts.0.vu', 'contacts.0.verifie', 'contacts.0.confiance', 'contacts.0.pourquoi', 'contacts.0.extrait',
    'personnes.0.complet', 'personnes.0.fonction', 'personnes.0.lien', 'personnes.0.preuve',
    'personnes.0.profils', 'personnes.0.verifie', 'personnes.0.confiance', 'personnes.0.pourquoi', 'personnes.0.extrait', 'personnes.0.source',
    'pages.0.chemin', 'sources.0.url', 'sources.0.ok',
    'graphe.filtres', 'graphe.noeuds.0.id', 'graphe.noeuds.0.type', 'graphe.noeuds.0.nom',
    'graphe.noeuds.0.filtre', 'graphe.noeuds.0.humain',
    'graphe.aretes.0.de', 'graphe.aretes.0.vers', 'graphe.aretes.0.relation',
    'graphe.aretes.0.source', 'graphe.aretes.0.confiance',
  ];
  const lis = (o, c) => c.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  const manquants = CHEMINS.filter((c) => lis(releve, c) === undefined);
  eq(manquants.join(', '), '', 'les ' + CHEMINS.length + ' chemins lus par swoge_osint.html sont tous servis');

  /* Et le champ le plus fragile du lot : `titulaire` vaut null quand il est
     masque. `undefined` casserait le rendu « redacted » de la page, et un
     null n est pas un undefined pour un JSON.stringify. */
  ok('titulaire' in releve.infra.rdap, 'le titulaire masque est un null EXPLICITE, pas un champ absent');
  eq(JSON.parse(JSON.stringify(releve)).infra.rdap.titulaire, null, 'et il survit au passage par JSON');
}

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
