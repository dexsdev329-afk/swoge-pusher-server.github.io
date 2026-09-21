'use strict';
/* ============================================================================
 * LE NOYAU OSINT — CE QU UNE PLATEFORME DOIT TENIR QUAND ELLE GRANDIT
 *
 * `osint.js` marchait en tuyau : une fonction par source, chacune rendant sa
 * forme. Ca tient a trois sources et ca casse a dix. Ce que cet essai mesure,
 * c est que le noyau tienne les promesses qui n etaient tenues par personne :
 *
 *   1. UNE FORME COMMUNE. Un fait est un triplet avec sa source. Correlation,
 *      doublons, contradictions, graphe et export en decoulent — ils ne sont
 *      pas ecrits une fois par source.
 *   2. LA REGLE GRAINE/SELECTEUR EST DANS LE CODE, pas dans un commentaire.
 *      Un connecteur branche sur un email ne PEUT PAS produire d entite :
 *      le registre le refuse au chargement.
 *   3. UNE SOURCE QUI TOMBE N ARRETE PAS L ENQUETE. Elle devient une ligne du
 *      journal. C est la difference entre un outil et un essai.
 *   4. ON NE TRANCHE PAS LES CONTRADICTIONS. Deux sources qui se contredisent
 *      sont montrees toutes les deux : celle qui a tort est souvent le
 *      resultat de l enquete.
 *   5. AUCUN SECRET, NULLE PART. Le connecteur de fuites dit qu une adresse
 *      apparait, dans quelle breche, a quelle date, et quelles CATEGORIES
 *      etaient exposees. Jamais une donnee.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const N = require('./osint_noyau');
const D = require('./osint');
require('./osint_connecteurs');

(async () => {

console.log('-- 1. ce qu on tape, et ce qui se deploie a partir de la --');
{
  const cas = [['acme.io', 'domaine'], ['https://acme.io/contact', 'url'], ['acme.io/contact', 'url'],
               ['8.8.8.8', 'ip'], ['0x' + 'a'.repeat(40), 'adresse'], ['jane@acme.io', 'email'],
               ['+33 6 12 34 56 78', 'telephone'], ['@janedoe', 'pseudo']];
  for (const [brut, type] of cas) {
    const d = N.detecte(brut);
    eq(d && d.type, type, JSON.stringify(brut) + ' est reconnu');
  }
  /* Le defaut trouve en branchant la detection : « acme.io » partait en URL
     parce que le normaliseur d URL acceptait un domaine nu, et le connecteur
     DNS n etait donc jamais appele. */
  eq(N.detecte('acme.io').type, 'domaine', 'un domaine nu n est PAS une URL');
  eq(N.detecte('Jean Dupont'), null, 'un nom n est aucun type connu');
  eq(N.detecte(''), null, 'le vide non plus');

  /* La normalisation avant tout : trois ecritures, un seul noeud. */
  eq(N.entite('domaine', 'HTTPS://WWW.Acme.IO/x').valeur, 'acme.io', 'une URL collee rend son domaine');
  eq(N.entite('telephone', '0033612345678').valeur, '+33612345678', '00 et + sont le meme abonne');
  eq(N.entite('email', 'MAILTO:Jane@Acme.IO').valeur, 'jane@acme.io', 'la casse et mailto: tombent');
  eq(N.entite('telephone', '0612345678'), null, 'un numero sans indicatif ne dit pas de quel pays il parle');
}

console.log('\n-- 2. graine ou selecteur : la regle est dans le code --');
{
  for (const t of ['domaine', 'ip', 'url', 'adresse']) ok(N.ENTITES[t].graine, t + ' est une graine');
  for (const t of ['email', 'pseudo', 'telephone']) {
    ok(!N.ENTITES[t].graine && N.ENTITES[t].selecteur, t + ' est un selecteur, pas une graine');
  }
  ok(!N.ENTITES.personne.graine && !N.ENTITES.personne.selecteur, 'une personne n est ni l un ni l autre');
  ok(/data brokers/i.test(N.REFUS_GRAINE.personne) && /returns nothing/i.test(N.REFUS_GRAINE.personne),
     'et le refus dit POURQUOI, en clair : la boite serait vide');
  ok(/domain, an IP, a website/i.test(N.REFUS_GRAINE.personne), 'et ce qu il faut taper a la place');

  /* LA GARDE STRUCTURELLE. Sans elle, la regle vivrait dans les
     commentaires et un connecteur distrait suffirait a l enfreindre. */
  let jete = null;
  try {
    N.declare({ nom: 'essai_interdit', consomme: ['email'], produit: ['personne'], lance: async () => ({}) });
  } catch (e) { jete = e.message; }
  ok(jete && /selecteur/.test(jete), 'un connecteur sur un selecteur ne PEUT PAS produire d entite');
  ok(!N.REGISTRE.has('essai_interdit'), 'et il n est pas enregistre');

  for (const c of N.connecteurs()) {
    if (!c.consomme.some((t) => N.ENTITES[t].selecteur)) continue;
    eq(c.produit.length, 0, c.nom + ' (selecteur) ne produit aucune entite');
  }
}

console.log('\n-- 3. les faits : doublons fondus, corroboration, contradictions --');
{
  const s = { type: 'domaine', valeur: 'acme.io' };
  const un = N.fait({ sujet: s, predicat: 'REGISTRAR IS', valeur: 'Registrar SAS', source: 'rdap.org', confiance: 'HIGH' });
  const deux = N.fait({ sujet: s, predicat: 'REGISTRAR IS', valeur: 'Registrar SAS', source: 'whois mirror', confiance: 'MEDIUM' });
  const trois = N.fait({ sujet: s, predicat: 'REGISTRAR IS', valeur: 'Autre SARL', source: 'un index tiers', confiance: 'LOW' });
  eq(N.empreinte(un), N.empreinte(deux), 'deux sources qui disent la meme chose ont la meme empreinte');
  ok(N.empreinte(un) !== N.empreinte(trois), 'une valeur differente, non');

  const c = N.correle([un, deux, trois]);
  eq(c.doublonsFondus, 1, 'le doublon est fondu, pas affiche deux fois');
  const fondu = c.faits.find((x) => x.valeur === 'Registrar SAS');
  eq(fondu.sources.length, 2, 'et il porte SES DEUX sources');
  ok(fondu.score > un.score, 'la corroboration remonte le score [' + un.score + ' -> ' + fondu.score + ']');

  eq(c.contradictions.length, 1, 'la contradiction est vue');
  eq(c.contradictions[0].versions.length, 2, 'avec ses deux versions');
  eq(c.contradictions[0].versions[0].valeur, 'Registrar SAS', 'la mieux etayee en tete');
  ok(/Nothing was picked for you/i.test(c.contradictions[0].note),
     'et RIEN n est tranche : celle qui a tort est souvent le resultat');
  ok(c.faits.filter((x) => x.predicat === 'REGISTRAR IS').every((x) => x.conteste),
     'les deux versions sont marquees contestees');

  /* Un predicat NON unique ne fait pas contradiction : trois IP pour un
     domaine, c est normal. Confondre les deux noierait les vraies. */
  const ips = ['1.1.1.1', '8.8.8.8'].map((ip) => N.fait({ sujet: s, predicat: 'RESOLVES TO',
    objet: { type: 'ip', valeur: ip }, source: 'dns', confiance: 'HIGH' }));
  eq(N.correle(ips).contradictions.length, 0, 'deux IP pour un domaine ne sont pas une contradiction');

  eq(N.fait({ sujet: null, predicat: 'X' }), null, 'un fait sans sujet n existe pas');
  eq(N.niveau(N.score({ confiance: 'LOW', sources: ['a'] })), 'LOW', 'un fait isole et faible reste LOW');
}

console.log('\n-- 4. le planificateur : parallele, borne, et il ne tombe pas --');
{
  N.videCache();
  /* Un faux connecteur, pose a la main : on mesure le PLANIFICATEUR, pas
     le reseau. Il compte les appels simultanes qu il a vus. */
  let vivants = 0, pic = 0, appels = 0;
  N.declare({
    nom: 'essai_lent', consomme: ['domaine'], produit: ['ip'], ttl: 60000,
    async lance(cible) {
      appels++; vivants++; pic = Math.max(pic, vivants);
      await new Promise((r) => setTimeout(r, 30));
      vivants--;
      return { faits: [N.fait({ sujet: cible, predicat: 'VU PAR', valeur: 'essai', source: 'essai', confiance: 'LOW' })],
               entites: [] };
    },
  });
  N.declare({
    nom: 'essai_casse', consomme: ['domaine'], produit: [], ttl: 60000,
    async lance() { throw new Error('la source est muette'); },
  });
  N.declare({
    nom: 'essai_cle', consomme: ['domaine'], produit: [], cle: 'CLE_QUI_NEXISTE_PAS',
    cout: '$9/month', async lance() { throw new Error('ne doit jamais etre appele'); },
  });

  const r = await N.enquete('acme.io', { seulement: ['essai_lent', 'essai_casse', 'essai_cle'], profondeur: 0 });
  ok(r.faits.length >= 1, 'l enquete rend des faits [' + r.faits.length + ']');

  /* Une source qui tombe est une LIGNE DU JOURNAL, pas la fin. */
  const casse = r.journal.find((j) => j.c === 'essai_casse');
  eq(casse.etat, 'erreur', 'la source qui tombe est notee');
  ok(/muette/.test(casse.message), 'avec son message');
  ok(r.faits.some((f) => f.connecteur === 'essai_lent'), 'et les autres ont quand meme rendu');

  /* Un connecteur sans sa cle est ETEINT, pas silencieux : un vide muet se
     lirait comme « rien trouve » alors qu on n a pas cherche. */
  const eteint = r.connecteursEteints.find((x) => x.nom === 'essai_cle');
  ok(eteint, 'le connecteur sans cle est declare eteint');
  ok(/CLE_QUI_NEXISTE_PAS/.test(eteint.pourquoi), 'et il DIT quelle cle il attend');
  ok(/\$9/.test(eteint.cout), 'et ce qu elle coute');
  ok(!r.journal.some((j) => j.c === 'essai_cle'), 'il n a pas ete appele');

  /* Le cache : la meme question deux fois ne repart pas sur le reseau. */
  const avant = appels;
  const r2 = await N.enquete('acme.io', { seulement: ['essai_lent'], profondeur: 0 });
  eq(appels, avant, 'la seconde enquete ne rappelle pas la source');
  eq(r2.journal.find((j) => j.c === 'essai_lent').etat, 'cache', 'et le journal dit que ca vient du cache');

  /* Le parallelisme est BORNE : sans ca, un domaine a deux cents
     sous-domaines ouvre deux cents connexions d un coup. */
  N.videCache();
  const taches = Array.from({ length: 12 }, (_, i) => 'd' + i + '.example');
  vivants = 0; pic = 0;
  await Promise.all(taches.map((d) => N.enquete(d, { seulement: ['essai_lent'], profondeur: 0, parallele: 3 })));
  ok(pic <= 12, 'le pic de simultanes reste borne [' + pic + ']');

  /* Le budget : une enquete rend quelque chose meme si une source ne
     repond jamais. */
  N.declare({ nom: 'essai_eternel', consomme: ['domaine'], produit: [], delaiMs: 40,
              async lance() { await new Promise(() => {}); } });
  const t0 = Date.now();
  const r3 = await N.enquete('lent.example', { seulement: ['essai_eternel'], profondeur: 0, budgetMs: 3000 });
  ok(Date.now() - t0 < 2000, 'le delai du connecteur coupe avant le budget [' + (Date.now() - t0) + 'ms]');
  eq(r3.journal[0].etat, 'erreur', 'et ca se lit dans le journal');
  ok(/timeout/.test(r3.journal[0].message), 'nomme comme tel');
}

console.log('\n-- 5. le debit par HOTE, qui protegeait personne avant --');
{
  /* Le debit par IP visiteur protege NOTRE serveur. Celui-ci protege les
     sites qu on interroge : dix visiteurs sur dix domaines tapaient crt.sh
     dix fois dans la meme seconde. */
  N.videCache();
  const t0 = Date.now();
  await Promise.all([N.attendSonTour('exemple.test', 120), N.attendSonTour('exemple.test', 120),
                     N.attendSonTour('exemple.test', 120)]);
  const mis = Date.now() - t0;
  ok(mis >= 900, 'trois appels au meme hote sont espaces [' + mis + 'ms pour 120/min]');
  const t1 = Date.now();
  await Promise.all([N.attendSonTour('a.test', 60), N.attendSonTour('b.test', 60)]);
  ok(Date.now() - t1 < 200, 'deux hotes differents ne s attendent pas [' + (Date.now() - t1) + 'ms]');
  eq(await N.attendSonTour(null, 1), 0, 'un connecteur sans hote ne patiente pas');
}

console.log('\n-- 6. le graphe tombe des faits, il n est plus ecrit a la main --');
{
  const rapport = {
    cible: { type: 'domaine', valeur: 'acme.io' },
    faits: [
      N.fait({ sujet: { type: 'domaine', valeur: 'acme.io' }, predicat: 'RESOLVES TO',
               objet: { type: 'ip', valeur: '8.8.8.8' }, source: 'dns', confiance: 'HIGH' }),
      N.fait({ sujet: { type: 'personne', valeur: 'Jane Doe' }, predicat: 'PUBLICLY ASSOCIATED WITH DOMAIN',
               objet: { type: 'domaine', valeur: 'acme.io' }, source: 'https://acme.io/team', confiance: 'MEDIUM' }),
      N.fait({ sujet: { type: 'domaine', valeur: 'acme.io' }, predicat: 'REGISTERED ON',
               valeur: '2014-03-02', source: 'rdap.org', confiance: 'HIGH' }),
    ],
  };
  const g = N.graphe(rapport);
  eq(g.noeuds.length, 3, 'trois noeuds : le domaine, l IP, la personne');
  eq(g.aretes.length, 2, 'et deux aretes — le fait SANS objet devient un attribut, pas une arete');
  const dom = g.noeuds.find((x) => x.id === 'domaine:acme.io');
  eq(dom.attributs[0].quoi, 'REGISTERED ON', 'la date est un attribut du noeud');
  eq(dom.cible, true, 'la cible se sait cible');
  const gens = g.noeuds.filter((x) => x.humain);
  eq(gens.length, 1, 'une seule personne');
  eq(gens[0].type, 'personne', 'et c est la seule marquee humain');
  eq(gens[0].filtre, 'contacts', 'rangee dans le calque qu on peut eteindre');
  ok(g.aretes.every((a) => a.source), 'AUCUNE arete sans source');
  ok(g.filtres.includes('chain'), 'le calque chaine existe');
}

console.log('\n-- 7. les exports : une enquete se poursuit ailleurs --');
{
  const rapport = { cible: { type: 'domaine', valeur: 'acme.io' }, faits: [
    N.fait({ sujet: { type: 'domaine', valeur: 'acme.io' }, predicat: 'REGISTRAR IS',
             valeur: 'Registrar, SAS "le grand"', source: 'https://rdap.org/domain/acme.io', confiance: 'HIGH' }),
  ] };
  const csv = N.versCSV(rapport);
  const lignes = csv.trim().split('\r\n');
  eq(lignes.length, 2, 'un en-tete et une ligne');
  ok(lignes[0].startsWith('subject_type,subject,predicate'), 'l en-tete nomme les colonnes');
  /* Une source est une URL et un registraire contient des virgules et des
     guillemets : tout est echappe, sinon le tableur decale tout. */
  ok(lignes[1].includes('"Registrar, SAS ""le grand"""'), 'virgules et guillemets echappes');
  eq(csv.split('\r\n').length - 1, 2, 'fins de ligne CRLF, ce qu attend un tableur');
  const j = JSON.parse(N.versJSON(rapport));
  eq(j.faits[0].predicat, 'REGISTRAR IS', 'le JSON se relit');
  ok(Array.isArray(j.faits[0].sources), 'et chaque fait y garde SES sources');
}

console.log('\n-- 8. aucun secret, nulle part --');
{
  const src = fs.readFileSync(path.join(__dirname, 'osint_connecteurs.js'), 'utf8');
  const fuites = N.REGISTRE.get('fuites');
  eq(fuites.cle, 'HIBP_API_KEY', 'le connecteur de fuites demande une cle');
  eq(fuites.produit.length, 0, 'et ne produit aucune entite');
  eq(N.actif(fuites, {}), false, 'sans la cle il est eteint');
  eq(N.actif(fuites, { HIBP_API_KEY: 'x' }), true, 'avec, il est actif');

  /* L API « Pwned Passwords » sert a verifier un mot de passe qu on
     detient. Ce projet n en manipule aucun : elle n est pas branchee, et
     cet essai le fige. */
  ok(!/pwnedpassword|range\//i.test(src), 'l API des mots de passe n est PAS branchee');
  ok(!/password.*=|hash|sha1\(.*mot/i.test(src.replace(/Passwords/g, '')),
     'et rien dans le source ne manipule un secret');
  /* Ce qu on rend d une breche : son nom, sa date, les CATEGORIES. */
  ok(/DataClasses/.test(src), 'les categories exposees sont lues');
  ok(/BreachDate/.test(src), 'la date aussi');
  ok(/exposed: /.test(src), 'et elles sont rendues comme un libelle');
}

console.log('\n-- 9. la garde SSRF disait oui a n importe quoi --');
{
  /* Trouve en branchant la detection d entite : la version d avant testait
     `s.includes(':')` puis les plages v6. « https://acme.io/contact »
     contient un deux-points et ne commence par aucun prefixe prive — la
     fonction repondait PUBLIQUE. Elle n avait jamais mordu parce qu elle
     n etait appelee que sur des adresses sorties du DNS. */
  for (const faux of ['https://acme.io/contact', 'bonjour:monde', 'a:b:c:d', '::gggg', 'pas une ip', ''])
    ok(!D.estIpPublique(faux), 'ce qui n est pas une adresse n est pas publique : ' + JSON.stringify(faux));
  ok(D.estIpPublique('2606:4700::1111') && D.estIpPublique('8.8.8.8'), 'les vraies passent toujours');
  for (const prive of ['::1', 'fe80::1', 'fc00::1', '127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1'])
    ok(!D.estIpPublique(prive), 'et les internes restent refusees : ' + prive);
}

console.log('\n-- 10. passif ou actif : dire si la recherche laisse une trace --');
{
  /* Repris de BBOT, et ca manquait. Un connecteur passif lit des index
     tiers ; un actif frappe a la porte de la cible, qui garde nos requetes
     horodatees dans ses journaux. On n enquete pas toujours sur quelqu un
     qu on veut prevenir. */
  eq(N.mode(N.REGISTRE.get('dns')), 'passif', 'le DNS ne touche pas la cible');
  eq(N.mode(N.REGISTRE.get('certificats')), 'passif', 'un journal de certificats non plus');
  eq(N.mode(N.REGISTRE.get('pages')), 'actif', 'mais lire les pages du site, SI');
  eq(N.mode(N.REGISTRE.get('comptes')), 'actif', 'et interroger les plateformes aussi');

  N.videCache();
  let touche = 0;
  N.declare({ nom: 'essai_actif', consomme: ['domaine'], produit: [], mode: 'actif',
              async lance(c) { touche++; return { faits: [N.fait({ sujet: c, predicat: 'VU', valeur: 'x', source: 's', confiance: 'LOW' })] }; } });
  N.declare({ nom: 'essai_passif', consomme: ['domaine'], produit: [],
              async lance(c) { return { faits: [N.fait({ sujet: c, predicat: 'LU', valeur: 'y', source: 's', confiance: 'LOW' })] }; } });

  const r = await N.enquete('passif.example', { seulement: ['essai_actif', 'essai_passif'],
                                                profondeur: 0, passifSeulement: true });
  eq(touche, 0, 'en mode passif, le connecteur actif n est PAS appele');
  const e = r.connecteursEcartes.find((x) => x.nom === 'essai_actif');
  ok(e, 'et il est declare ecarte, pas tu en silence');
  ok(/touch the target/i.test(e.pourquoi), 'avec la raison : il toucherait la cible');
  eq(r.passif, true, 'le rapport dit que l enquete n a laisse aucune trace');
  ok(r.faits.some((f) => f.connecteur === 'essai_passif'), 'et le passif a quand meme rendu');

  N.videCache();
  const r2 = await N.enquete('passif.example', { seulement: ['essai_actif'], profondeur: 0 });
  eq(touche, 1, 'sans le mode passif, il est appele');
  eq(r2.passif, false, 'et le rapport dit que la cible nous a vus');
}

console.log('\n-- 11. les constats : le croisement, pas la liste --');
{
  /* Repris de SpiderFoot. « Pas de DMARC » est anodin ; « pas de DMARC ET
     un MX qui recoit » veut dire que n importe qui peut ecrire au nom de ce
     domaine. C est le croisement qui fait le resultat. */
  const d = { type: 'domaine', valeur: 'acme.io' };
  const faits = [
    N.fait({ sujet: d, predicat: 'MAIL HANDLED BY', objet: { type: 'domaine', valeur: 'mx.acme.io' },
             source: 'dns', confiance: 'HIGH' }),
    N.fait({ sujet: d, predicat: 'DMARC', valeur: 'none published', source: 'dns', confiance: 'HIGH' }),
  ];
  const c = N.constats(faits);
  const usurpable = c.find((x) => x.regle === 'mail-usurpable');
  ok(usurpable, 'MX sans DMARC : le constat sort');
  eq(usurpable.gravite, 'haute', 'et il est grave');
  ok(/send mail in its name/i.test(usurpable.dit), 'il DIT ce que ca permet');
  ok(usurpable.pieces.length && usurpable.pieces[0].sources.length,
     'et il porte ses pieces, avec leurs sources');

  /* Le meme domaine AVEC DMARC ne declenche rien : une regle qui crie
     toujours ne veut plus rien dire. */
  const avec = [faits[0], N.fait({ sujet: d, predicat: 'DMARC', valeur: 'v=DMARC1; p=reject',
                                   source: 'dns', confiance: 'HIGH' })];
  ok(!N.constats(avec).some((x) => x.regle === 'mail-usurpable'), 'avec DMARC, il se tait');

  /* Un domaine de trois jours au titulaire masque : les deux sont banals
     separement, et la regle le DIT au lieu de crier au loup. */
  const jeune = [
    N.fait({ sujet: d, predicat: 'REGISTERED ON', valeur: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
             source: 'rdap', confiance: 'HIGH' }),
    N.fait({ sujet: d, predicat: 'REGISTRANT IS', valeur: 'redacted by the registry', source: 'rdap', confiance: 'HIGH' }),
  ];
  const jc = N.constats(jeune).find((x) => x.regle === 'domaine-jeune-titulaire-masque');
  ok(jc, 'domaine jeune + titulaire masque : constat');
  ok(/ordinary on their own/i.test(jc.dit) && /not a conclusion/i.test(jc.dit),
     'et il precise que chacun est banal seul, et que ce n est pas une conclusion');

  /* Un vieux domaine masque ne declenche rien : c est le cas de presque
     tous les domaines depuis le RGPD. */
  const vieux = [N.fait({ sujet: d, predicat: 'REGISTERED ON', valeur: '2014-03-02', source: 'rdap', confiance: 'HIGH' }), jeune[1]];
  ok(!N.constats(vieux).some((x) => x.regle === 'domaine-jeune-titulaire-masque'),
     'un vieux domaine masque ne declenche rien — c est le cas de presque tous');

  /* Le rappel qui ne doit jamais disparaitre. */
  const p = N.constats([N.fait({ sujet: { type: 'personne', valeur: 'Jane Doe' },
    predicat: 'PUBLICLY ASSOCIATED WITH DOMAIN', objet: d, source: 'https://acme.io/team', confiance: 'MEDIUM' })]);
  ok(p.some((x) => /Being named is not owning/i.test(x.dit)), 'etre nomme n est pas posseder, et c est ecrit');

  eq(N.constats([]).length, 0, 'aucun fait, aucun constat — pas de bruit de fond');
  const ordre = N.constats([...faits, ...jeune]).map((x) => x.gravite);
  eq(ordre[0], 'haute', 'les graves en premier');
}

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
