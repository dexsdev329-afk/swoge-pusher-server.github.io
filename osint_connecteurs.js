'use strict';
/* ==================================================================
 * LES CONNECTEURS
 * ==================================================================
 * Chacun sait lire UN type d entite et rendre des faits. Aucun ne connait
 * le planificateur, le graphe, l export ni la page : c est ce qui fait
 * qu ajouter une source ne touche a rien d autre.
 *
 * Les six premiers enveloppent ce que `osint.js` savait deja faire — rien
 * n est perdu, tout devient composable. Les trois derniers sont les
 * SELECTEURS, et ils ne produisent aucune entite : le noyau refuse de les
 * declarer autrement (voir `declare`). */

const N = require('./osint_noyau');
const D = require('./osint');

const e = N.entite;
const f = N.fait;

/* ---------------------------------------------------------------- DNS */
N.declare({
  nom: 'dns', consomme: ['domaine'], produit: ['ip', 'domaine'],
  hote: null, ttl: 5 * 60 * 1000, cout: 'free', delaiMs: 8000,
  async lance(cible) {
    const d = await D.dnsDe(cible.valeur);
    const faits = [], entites = [];
    const src = 'DNS answer for ' + cible.valeur;
    for (const ip of [...d.a, ...d.aaaa]) {
      const o = e('ip', ip);
      if (!o) continue;                       /* une adresse interne ne devient pas une entite */
      entites.push(o);
      faits.push(f({ sujet: cible, predicat: 'RESOLVES TO', objet: o, source: src,
                     verifie: true, confiance: 'HIGH',
                     pourquoi: 'the domain answers this to every resolver on earth' }));
    }
    for (const mx of d.mx.slice(0, 5)) {
      const h = e('domaine', mx.hote);
      if (h) { entites.push(h); faits.push(f({ sujet: cible, predicat: 'MAIL HANDLED BY', objet: h,
                                               source: src, verifie: true, confiance: 'HIGH' })); }
    }
    if (d.hebergeurMail) faits.push(f({ sujet: cible, predicat: 'MAIL HOSTED BY', valeur: d.hebergeurMail,
                                        source: src, verifie: true, confiance: 'HIGH' }));
    for (const ns of d.ns.slice(0, 4)) faits.push(f({ sujet: cible, predicat: 'NAME SERVER',
                                                      valeur: ns, source: src, verifie: true, confiance: 'HIGH' }));
    if (d.spf) faits.push(f({ sujet: cible, predicat: 'SPF', valeur: d.spf, source: src, verifie: true, confiance: 'HIGH' }));
    /* L ABSENCE est un fait. Sans DMARC, n importe qui peut ecrire au nom
       de ce domaine — le taire laisserait croire qu on n a pas regarde. */
    faits.push(f({ sujet: cible, predicat: 'DMARC', valeur: d.dmarc || 'none published',
                   source: src, verifie: true, confiance: 'HIGH',
                   pourquoi: d.dmarc ? null : 'no DMARC record: nothing stops a third party forging mail from this domain' }));
    return { faits, entites };
  },
});

/* --------------------------------------------------------------- RDAP */
N.declare({
  nom: 'rdap', consomme: ['domaine'], produit: ['organisation'],
  hote: 'rdap.org', parMinute: 30, ttl: 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const r = await D.rdapDomaine(cible.valeur);
    if (!r.trouve) return { faits: [], entites: [] };
    const faits = [], entites = [];
    const base = { sujet: cible, source: r.source, verifie: false, confiance: 'HIGH' };
    if (r.registraire) faits.push(f(Object.assign({}, base, { predicat: 'REGISTRAR IS', valeur: r.registraire })));
    if (r.cree) faits.push(f(Object.assign({}, base, { predicat: 'REGISTERED ON', valeur: r.cree })));
    if (r.expire) faits.push(f(Object.assign({}, base, { predicat: 'EXPIRES ON', valeur: r.expire })));
    if (r.etats && r.etats.length) faits.push(f(Object.assign({}, base, { predicat: 'REGISTRY STATUS', valeur: r.etats.join(', ') })));
    if (r.titulaire) {
      const o = e('organisation', r.titulaire);
      if (o) { entites.push(o);
        faits.push(f(Object.assign({}, base, { predicat: 'REGISTRANT IS', objet: o,
          pourquoi: 'published in clear in the domain registry — the only source that establishes ownership' }))); }
    } else {
      /* « Masque » n est pas « vide ». Une absence nommee vaut mieux qu un
         champ vide qu on lirait comme « pas cherche ». */
      faits.push(f(Object.assign({}, base, { predicat: 'REGISTRANT IS', valeur: 'redacted by the registry',
        confiance: 'HIGH', pourquoi: 'withheld since the GDPR for most domains. Absence of a name is not a hidden name.' })));
    }
    return { faits, entites };
  },
});

/* ------------------------------------------- transparence des certificats */
N.declare({
  nom: 'certificats', consomme: ['domaine'], produit: ['domaine'],
  hote: 'crt.sh', parMinute: 12, ttl: 30 * 60 * 1000, cout: 'free', delaiMs: 12000,
  async lance(cible) {
    const c = await D.certsDe(cible.valeur);
    if (!c.trouve) return { faits: [], entites: [] };
    const faits = [], entites = [];
    for (const s of c.sousDomaines.slice(0, 60)) {
      const o = e('domaine', s);
      if (!o) continue;
      entites.push(o);
      /* NOT VERIFIED, et LOW : un certificat a ete emis pour ce nom, ce qui
         ne dit pas qu une machine y repond aujourd hui. */
      faits.push(f({ sujet: cible, predicat: 'CERTIFICATE ISSUED FOR', objet: o, source: c.source,
                     verifie: false, confiance: 'LOW',
                     pourquoi: 'from a public certificate log, not confirmed against the host itself' }));
    }
    for (const em of (c.emetteurs || []).slice(0, 3)) {
      faits.push(f({ sujet: cible, predicat: 'CERTIFIED BY', valeur: em.nom + ' (' + em.n + ')',
                     source: c.source, verifie: false, confiance: 'HIGH' }));
    }
    return { faits, entites };
  },
});

/* ------------------------------------------------------------- RDAP d IP */
N.declare({
  nom: 'reseau', consomme: ['ip'], produit: ['reseau'],
  hote: 'rdap.org', parMinute: 30, ttl: 6 * 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const r = await D.rdapIp(cible.valeur);
    if (!r.trouve) return { faits: [], entites: [] };
    const nom = r.asn || r.reseau || r.operateur;
    if (!nom) return { faits: [], entites: [] };
    const o = e('reseau', nom);
    const faits = [f({ sujet: cible, predicat: 'ANNOUNCED IN', objet: o, source: r.source,
                       verifie: false, confiance: 'HIGH' })];
    if (r.pays) faits.push(f({ sujet: cible, predicat: 'COUNTRY IS', valeur: r.pays, source: r.source,
                               verifie: false, confiance: 'MEDIUM' }));
    if (r.operateur) faits.push(f({ sujet: cible, predicat: 'OPERATED BY', valeur: r.operateur,
                                    source: r.source, verifie: false, confiance: 'HIGH' }));
    return { faits, entites: [o] };
  },
});

/* ------------------------------------------- les pages du domaine lui-meme
 * Le seul connecteur qui frappe a la porte du site vise. Il obeit a
 * robots.txt, s annonce, et un refus est NOTE, jamais reessaye deguise.
 *
 * La boucle est ici et non dans `osint.js` : un connecteur qui appellerait
 * le monolithe refarait DNS, RDAP et les certificats a chaque fois. Les
 * primitives (`recuperePage`, `mailsDe`, `personnesDe`…) sont partagees —
 * seule la boucle est propre a ce chemin. `osint()` reste en place tant que
 * la page v1 l utilise. */
N.declare({
  nom: 'pages', consomme: ['domaine'], produit: ['personne', 'email', 'telephone'],
  /* ACTIF : le seul qui frappe a la porte du site vise. Ses requetes sont
     dans les journaux d en face, horodatees. */
  mode: 'actif', parMinute: 30, ttl: 20 * 60 * 1000, cout: 'free', delaiMs: 20000,
  async lance(cible) {
    const dom = cible.valeur;
    const faits = [], entites = [];
    const robots = await D.robotsDe(dom);
    const servis = new Set();
    let n = 0;
    for (const cand of D.PAGES_CANDIDATES) {
      if (n >= D.PAGES_MAX) break;
      if (servis.has(cand.role)) continue;
      if (!D.robotsPermet(robots, cand.chemin)) {
        faits.push(f({ sujet: cible, predicat: 'PAGE SKIPPED', valeur: cand.chemin + ' — disallowed by robots.txt',
                       source: 'https://' + dom + '/robots.txt', verifie: true, confiance: 'HIGH' }));
        continue;
      }
      n++;
      const r = await D.recuperePage('https://' + dom + cand.chemin);
      if (!r.ok) {
        if (r.refus) faits.push(f({ sujet: cible, predicat: 'PAGE REFUSED',
          valeur: cand.chemin + ' — HTTP ' + r.code + ', not retried', source: r.url,
          verifie: true, confiance: 'HIGH',
          pourquoi: 'the site refused us and we did not try again in disguise' }));
        continue;
      }
      servis.add(cand.role);

      if (cand.role === 'securite') {
        const s = D.litSecurityTxt(r.corps);
        for (const c of s.contacts) {
          const m = D.mailRecevable(c, 'securite');
          if (!m) continue;
          const o = e('email', m.adresse);
          if (!o) continue;
          entites.push(o);
          faits.push(f({ sujet: cible, predicat: 'PUBLISHES CONTACT', objet: o, source: r.url,
                         verifie: true, confiance: 'HIGH',
                         pourquoi: 'published in the domain’s security.txt (RFC 9116)' }));
        }
        continue;
      }

      for (const m of D.mailsDe(r.corps, cand.role)) {
        const o = e('email', m.adresse);
        if (!o) continue;
        entites.push(o);
        const c = D.confiance(cand.role === 'legal' ? 'legal' : cand.role === 'contact' ? 'contact'
                            : cand.role === 'equipe' ? 'equipe' : 'autre');
        faits.push(f({ sujet: cible, predicat: 'PUBLISHES CONTACT', objet: o, source: r.url,
                       verifie: true, confiance: c.niveau, pourquoi: c.pourquoi, extrait: m.extrait }));
      }
      if (['legal', 'contact'].includes(cand.role)) {
        for (const t of D.telsDe(r.corps)) {
          const o = e('telephone', t);
          if (!o) continue;
          entites.push(o);
          faits.push(f({ sujet: cible, predicat: 'PUBLISHES CONTACT', objet: o, source: r.url,
                         verifie: true, confiance: cand.role === 'legal' ? 'HIGH' : 'MEDIUM',
                         pourquoi: 'a tel: link is published so that it is called' }));
        }
      }
      for (const p of D.personnesDe(r.corps, cand.role)) {
        const o = e('personne', p.complet);
        if (!o) continue;
        entites.push(o);
        const lien = D.lienAuDomaine(cand.role === 'legal' ? 'legal' : null);
        const c = D.confiance(['legal', 'securite'].includes(cand.role) ? cand.role
                            : (p.mail ? 'bloc' : cand.role));
        /* « PUBLICLY ASSOCIATED WITH DOMAIN » par defaut. Le predicat porte
           le lien : le graphe ne peut donc pas dire propriete sans preuve. */
        faits.push(f({ sujet: o, predicat: lien.lien, objet: cible, source: r.url,
                       verifie: true, confiance: c.niveau, pourquoi: lien.preuve, extrait: p.extrait }));
        faits.push(f({ sujet: o, predicat: 'ROLE IS', valeur: p.fonction, source: r.url,
                       verifie: true, confiance: c.niveau }));
        if (p.mail) {
          const om = e('email', p.mail);
          if (om) faits.push(f({ sujet: o, predicat: 'PROFESSIONAL EMAIL', objet: om, source: r.url,
                                 verifie: true, confiance: 'MEDIUM',
                                 pourquoi: 'name, role and address printed within the same window on the page' }));
        }
        for (const pr of (p.profils || [])) {
          faits.push(f({ sujet: o, predicat: pr.genre === 'pro' ? 'PUBLIC PROFESSIONAL PROFILE' : 'PUBLIC ACCOUNT',
                         valeur: pr.url, source: r.url, verifie: true, confiance: 'MEDIUM',
                         pourquoi: 'printed on this page next to this name; being printed here does not make it theirs' }));
        }
      }
    }
    return { faits, entites };
  },
});

/* ---------------------------------------------- l adresse de chaine */
N.declare({
  nom: 'chaine', consomme: ['adresse'], produit: ['jeton'],
  ttl: 5 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const r = await D.adresse(cible.valeur);
    const faits = [], entites = [];
    const src = 'launchpad registries held by this server';
    if (!r.lanceur.trouve) {
      faits.push(f({ sujet: cible, predicat: 'LAUNCHPAD RECORD', valeur: 'none of our registries knows this address',
                     source: src, verifie: true, confiance: 'HIGH',
                     pourquoi: 'not found is not clean: it means our three registries do not know it' }));
      return { faits, entites };
    }
    for (const p of r.lanceur.pads) {
      faits.push(f({ sujet: cible, predicat: 'LAUNCHED TOKENS ON', valeur: p.nom + ' × ' + p.lances,
                     source: p.nom + ' registry', verifie: true, confiance: 'HIGH' }));
    }
    for (const j of r.jetons.slice(0, 40)) {
      const o = e('jeton', j.addr);
      if (!o) continue;
      entites.push(o);
      faits.push(f({ sujet: cible, predicat: 'DEPLOYED', objet: o, source: (j.pad || 'launchpad') + ' registry',
                     verifie: true, confiance: 'HIGH', extrait: j.sym || null }));
    }
    /* LA mesure — celle que ni un explorateur ni un Maltego ne peut donner,
       parce qu elle vient de ce que cette colonie a observe elle-meme. */
    if (r.lanceur.mesure) {
      faits.push(f({ sujet: cible, predicat: 'MEASURED OUTCOME OF SIMILAR LAUNCHERS',
                     valeur: r.lanceur.bande + ' → ' + r.lanceur.mesure.moyenne + '% on '
                           + r.lanceur.mesure.n + ' observations',
                     source: 'SWOGE AI measured history', verifie: true, confiance: 'HIGH',
                     pourquoi: 'a past record is a measurement, not a prediction' }));
    }
    return { faits, entites };
  },
});

/* ==================================================================
 * LES SELECTEURS — ils repondent, ils ne se deploient pas
 * ==================================================================
 * Aucun des trois ne rend d entite : le noyau le REFUSE au chargement
 * (voir `declare`). C est ce qui fait qu un email ne peut pas ouvrir une
 * enquete par ricochet, meme si quelqu un l oublie un jour. */

/* ---- LES FUITES ----
 * Une seule source, et elle est choisie : Have I Been Pwned. C est un
 * service de notification de breches, concu POUR qu on verifie son
 * exposition, pas une base fuitee revendue.
 *
 * CE QUI NE SORT JAMAIS D ICI, ET NE RENTRE MEME PAS : un mot de passe, un
 * condensat, un jeton, une question secrete. HIBP n en rend pas — c est
 * precisement pourquoi c est la source legitime. On rend la PRESENCE, la
 * breche, sa date, et les CATEGORIES de donnees exposees, qui sont des
 * libelles (« Passwords », « Email addresses »), jamais des donnees.
 *
 * L API « Pwned Passwords » n est deliberement pas branchee : elle sert a
 * verifier un mot de passe qu on detient deja, et ce projet ne manipule
 * aucun secret. */
N.declare({
  nom: 'fuites', consomme: ['email'], produit: [],
  hote: 'haveibeenpwned.com', parMinute: 6, ttl: 6 * 60 * 60 * 1000,
  cle: 'HIBP_API_KEY', cout: '~$4/month, key required', delaiMs: 12000,
  async lance(cible, ctx) {
    const url = 'https://haveibeenpwned.com/api/v3/breachedaccount/'
              + encodeURIComponent(cible.valeur) + '?truncateResponse=false';
    const r = await D.recuperePage(url, 'application/json', {
      'hibp-api-key': (ctx.env || process.env).HIBP_API_KEY,
    });
    /* 404 = aucune breche. C est une REPONSE, pas une panne : on l ecrit. */
    if (r.code === 404) {
      return { faits: [f({ sujet: cible, predicat: 'BREACH EXPOSURE', valeur: 'not found in any known breach',
                           source: 'haveibeenpwned.com', verifie: true, confiance: 'HIGH',
                           pourquoi: 'absence from this catalogue is not proof the address was never exposed' })] };
    }
    if (!r.ok) throw new Error('HIBP HTTP ' + r.code);
    let liste = [];
    try { liste = JSON.parse(r.corps); } catch (err) { throw new Error('HIBP: unreadable answer'); }
    if (!Array.isArray(liste)) throw new Error('HIBP: unexpected answer');
    const faits = [f({ sujet: cible, predicat: 'BREACH EXPOSURE',
                       valeur: liste.length + ' known breach' + (liste.length === 1 ? '' : 'es'),
                       source: 'haveibeenpwned.com', verifie: true, confiance: 'HIGH' })];
    for (const b of liste.slice(0, 60)) {
      /* Les CATEGORIES exposees, telles que le catalogue les nomme. Pas une
         donnee : un libelle. « Passwords » dit qu il y en avait, il n en
         montre aucun, et rien ici ne va en chercher. */
      const classes = Array.isArray(b.DataClasses) ? b.DataClasses.join(', ') : '';
      faits.push(f({ sujet: cible, predicat: 'APPEARS IN BREACH',
                     valeur: (b.Title || b.Name) + ' — ' + String(b.BreachDate || '').slice(0, 10)
                           + (classes ? ' — exposed: ' + classes : ''),
                     source: 'https://haveibeenpwned.com/PwnedWebsites#' + (b.Name || ''),
                     verifie: true, confiance: b.IsVerified ? 'HIGH' : 'MEDIUM',
                     pourquoi: b.IsVerified ? 'breach verified by the catalogue'
                                            : 'breach listed but not verified by the catalogue' }));
    }
    return { faits };
  },
});

/* ---- L EXISTENCE D UN COMPTE ----
 * Une question fermee, posee aux plateformes elles-memes : « une page de
 * profil existe-t-elle a ce nom ». On lit le CODE de reponse, pas la page :
 * rien du contenu n est recupere, rien n est garde, et aucun lien n est
 * fait entre deux plateformes.
 *
 * Ce que ce connecteur NE DIT PAS, et la page doit le repeter : que ces
 * comptes appartiennent a la meme personne. Deux comptes du meme pseudo
 * sur deux sites, c est deux comptes du meme pseudo. En faire une identite
 * est exactement le saut que ce projet s interdit. */
const PLATEFORMES = [
  /* Chacune est une PAGE PUBLIQUE : on fait un GET, on lit le CODE de
     reponse, jamais le contenu. C est ce que fait un navigateur qui ouvre
     l URL — une visite. Ce qu on ne fait PAS, et qui separe ceci de
     Maigret a 6000 sites : abuser un formulaire de recuperation de mot de
     passe, contourner une protection anti-robot, ou relier deux comptes du
     meme pseudo comme s ils etaient la meme personne. Deux comptes du meme
     pseudo, c est deux comptes du meme pseudo. */
  { nom: 'GitHub', hote: 'github.com', url: (u) => 'https://github.com/' + u },
  { nom: 'GitLab', hote: 'gitlab.com', url: (u) => 'https://gitlab.com/' + u },
  { nom: 'Reddit', hote: 'reddit.com', url: (u) => 'https://www.reddit.com/user/' + u + '/about.json' },
  { nom: 'Telegram', hote: 't.me', url: (u) => 'https://t.me/' + u },
  { nom: 'Bluesky', hote: 'bsky.app', url: (u) => 'https://bsky.app/profile/' + u },
  { nom: 'Medium', hote: 'medium.com', url: (u) => 'https://medium.com/@' + u },
  { nom: 'Keybase', hote: 'keybase.io', url: (u) => 'https://keybase.io/' + u },
  { nom: 'Gravatar', hote: 'gravatar.com', url: (u) => 'https://gravatar.com/' + u },
  { nom: 'Mastodon (social)', hote: 'mastodon.social', url: (u) => 'https://mastodon.social/@' + u },
  { nom: 'Dev.to', hote: 'dev.to', url: (u) => 'https://dev.to/' + u },
  { nom: 'HackerNews', hote: 'news.ycombinator.com', url: (u) => 'https://news.ycombinator.com/user?id=' + u },
  { nom: 'npm', hote: 'npmjs.com', url: (u) => 'https://www.npmjs.com/~' + u },
  { nom: 'PyPI', hote: 'pypi.org', url: (u) => 'https://pypi.org/user/' + u + '/' },
  { nom: 'Docker Hub', hote: 'hub.docker.com', url: (u) => 'https://hub.docker.com/u/' + u },
  { nom: 'Steam', hote: 'steamcommunity.com', url: (u) => 'https://steamcommunity.com/id/' + u },
  { nom: 'Twitch', hote: 'twitch.tv', url: (u) => 'https://www.twitch.tv/' + u },
  { nom: 'SoundCloud', hote: 'soundcloud.com', url: (u) => 'https://soundcloud.com/' + u },
  { nom: 'Behance', hote: 'behance.net', url: (u) => 'https://www.behance.net/' + u },
];
N.declare({
  nom: 'comptes', consomme: ['pseudo'], produit: [],
  /* ACTIF : on interroge les plateformes directement. */
  mode: 'actif', parMinute: 20, ttl: 60 * 60 * 1000, cout: 'free', delaiMs: 15000,
  async lance(cible) {
    const faits = [];
    for (const p of PLATEFORMES) {
      await N.attendSonTour(p.hote, 20);
      const r = await D.recuperePage(p.url(cible.valeur), 'text/html');
      if (r.refus) {
        faits.push(f({ sujet: cible, predicat: 'ACCOUNT CHECK', valeur: p.nom + ' — refused the check (HTTP ' + r.code + ')',
                       source: p.url(cible.valeur), verifie: true, confiance: 'LOW',
                       pourquoi: 'the platform refused us; we did not try again in disguise' }));
        continue;
      }
      if (r.code === 404 || r.code === 410) continue;      /* pas de compte : rien a dire */
      if (!r.ok) continue;
      faits.push(f({ sujet: cible, predicat: 'ACCOUNT EXISTS ON', valeur: p.nom,
                     source: p.url(cible.valeur), verifie: true, confiance: 'MEDIUM',
                     pourquoi: 'a profile page answers at this name. It does not say who owns it, '
                             + 'and it does not link this account to any other.' }));
    }
    if (!faits.length) {
      faits.push(f({ sujet: cible, predicat: 'ACCOUNT CHECK', valeur: 'no public profile found on the platforms checked',
                     source: 'direct check of ' + PLATEFORMES.length + ' public platforms',
                     verifie: true, confiance: 'MEDIUM' }));
    }
    return { faits };
  },
});

/* ---- LE PLAN DE NUMEROTATION ----
 * Des donnees de reference publiques — l indicatif pays de l UIT — et
 * rien de plus. Determiner l operateur ou mobile/fixe demande une base
 * de portabilite payante : on ne l a pas, donc on ne le devine pas. Un
 * outil qui affiche « mobile » sans le savoir est pire qu un outil muet. */
const INDICATIFS = [
  ['1', 'North America (NANP)'], ['7', 'Russia / Kazakhstan'], ['20', 'Egypt'], ['27', 'South Africa'],
  ['30', 'Greece'], ['31', 'Netherlands'], ['32', 'Belgium'], ['33', 'France'], ['34', 'Spain'],
  ['36', 'Hungary'], ['39', 'Italy'], ['40', 'Romania'], ['41', 'Switzerland'], ['43', 'Austria'],
  ['44', 'United Kingdom'], ['45', 'Denmark'], ['46', 'Sweden'], ['47', 'Norway'], ['48', 'Poland'],
  ['49', 'Germany'], ['51', 'Peru'], ['52', 'Mexico'], ['54', 'Argentina'], ['55', 'Brazil'],
  ['56', 'Chile'], ['57', 'Colombia'], ['58', 'Venezuela'], ['60', 'Malaysia'], ['61', 'Australia'],
  ['62', 'Indonesia'], ['63', 'Philippines'], ['64', 'New Zealand'], ['65', 'Singapore'],
  ['66', 'Thailand'], ['81', 'Japan'], ['82', 'South Korea'], ['84', 'Vietnam'], ['86', 'China'],
  ['90', 'Turkey'], ['91', 'India'], ['92', 'Pakistan'], ['93', 'Afghanistan'], ['94', 'Sri Lanka'],
  ['95', 'Myanmar'], ['98', 'Iran'], ['212', 'Morocco'], ['213', 'Algeria'], ['216', 'Tunisia'],
  ['218', 'Libya'], ['221', 'Senegal'], ['225', 'Ivory Coast'], ['234', 'Nigeria'], ['237', 'Cameroon'],
  ['242', 'Congo'], ['243', 'DR Congo'], ['254', 'Kenya'], ['261', 'Madagascar'], ['262', 'Reunion'],
  ['351', 'Portugal'], ['352', 'Luxembourg'], ['353', 'Ireland'], ['358', 'Finland'], ['359', 'Bulgaria'],
  ['370', 'Lithuania'], ['371', 'Latvia'], ['372', 'Estonia'], ['380', 'Ukraine'], ['385', 'Croatia'],
  ['386', 'Slovenia'], ['420', 'Czechia'], ['421', 'Slovakia'], ['852', 'Hong Kong'], ['886', 'Taiwan'],
  ['961', 'Lebanon'], ['962', 'Jordan'], ['965', 'Kuwait'], ['966', 'Saudi Arabia'], ['971', 'UAE'],
  ['972', 'Israel'], ['974', 'Qatar'], ['994', 'Azerbaijan'], ['998', 'Uzbekistan'],
].sort((a, b) => b[0].length - a[0].length);     /* le plus long d abord : 1 ne doit pas gagner sur 1XX */

/* Le TYPE de ligne et la region se lisent dans le PREFIXE du plan national,
   PAS dans une base de portabilite. La portabilite ne change que l OPERATEUR
   d un numero, jamais son type ni sa zone : un 06 reste un mobile meme apres
   dix changements d operateur. numverify rend souvent un operateur vide sur un
   numero francais pour cette raison exacte — mais le type, lui, est certain.
   Plan de numerotation ARCEP (France), `nat` = le numero national sans le +33 :
     6, 7  -> mobile
     1     -> fixe, Ile-de-France        4 -> fixe, Sud-Est
     2     -> fixe, Nord-Ouest           5 -> fixe, Sud-Ouest
     3     -> fixe, Nord-Est             9 -> VoIP / non geographique
     8     -> numero special (0800-0805 vert, sinon a tarif majore) */
function typeFR(nat) {
  if (!nat) return null;
  const d = nat[0];
  if (d === '6' || d === '7') return 'mobile';
  if (d === '1') return 'fixed line · Île-de-France (Paris region)';
  if (d === '2') return 'fixed line · North-West France';
  if (d === '3') return 'fixed line · North-East France';
  if (d === '4') return 'fixed line · South-East France';
  if (d === '5') return 'fixed line · South-West France';
  if (d === '9') return 'VoIP / non-geographic fixed';
  if (d === '8') return /^80[0-5]/.test(nat) ? 'special number · freephone (numéro vert)' : 'special-rate number (08)';
  return null;
}

N.declare({
  nom: 'numerotation', consomme: ['telephone'], produit: [],
  ttl: 24 * 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const nu = cible.valeur.replace(/^\+/, '');
    const trouve = INDICATIFS.find(([i]) => nu.startsWith(i));
    const faits = [f({ sujet: cible, predicat: 'NUMBERING PLAN',
                       valeur: trouve ? '+' + trouve[0] + ' — ' + trouve[1] : 'country code not recognised',
                       source: 'ITU-T E.164 country calling codes', verifie: true,
                       confiance: trouve ? 'HIGH' : 'LOW' })];
    /* Le type de ligne : deterministe pour la France (plan ARCEP). Ailleurs, on
       ne decode pas le plan national ici, donc on ne devine pas. */
    const nat = trouve ? nu.slice(trouve[0].length) : '';
    const type = (trouve && trouve[0] === '33') ? typeFR(nat) : null;
    if (type) {
      faits.push(f({ sujet: cible, predicat: 'LINE TYPE', valeur: type,
                     source: 'ARCEP national numbering plan (France)', verifie: true, confiance: 'HIGH' }));
    } else {
      faits.push(f({ sujet: cible, predicat: 'LINE TYPE', valeur: 'not determined',
                     source: 'ITU-T E.164 country calling codes', verifie: true, confiance: 'MEDIUM',
                     pourquoi: 'the national numbering plan for this country is not decoded here.' }));
    }
    /* L OPERATEUR, lui, demande vraiment une base de portabilite qu on n a pas.
       On ne le devine pas — et on DIT pourquoi, pour ne pas se lire comme un
       manque de travail. */
    faits.push(f({ sujet: cible, predicat: 'CARRIER', valeur: 'not determined',
                   source: 'number portability database (not queried)', verifie: true, confiance: 'HIGH',
                   pourquoi: 'a number keeps its number across carriers (portability), so the current '
                           + 'operator cannot be read from the prefix — only a paid portability database has it.' }));
    return { faits };
  },
});

module.exports = { PLATEFORMES, INDICATIFS, typeFR };

/* ---- L ARCHIVE DU WEB ----
 * Wayback Machine : ce qu un domaine a montre au monde par le passe, tel
 * qu une archive publique l a garde. Purement passif — on lit l archive,
 * jamais le site. Utile quand une page de contact a ete retiree mais
 * qu elle reste dans l archive : c est de l information publique, elle a
 * juste demenage. */
N.declare({
  nom: 'archive', consomme: ['domaine'], produit: [],
  hote: 'web.archive.org', parMinute: 15, ttl: 6 * 60 * 60 * 1000, cout: 'free', delaiMs: 12000,
  async lance(cible) {
    const url = 'https://web.archive.org/cdx/search/cdx?url=' + encodeURIComponent(cible.valeur)
              + '*&output=json&fl=timestamp,original&collapse=urlkey&limit=1000';
    const r = await D.recuperePage(url, 'application/json');
    if (!r.ok) return { faits: [] };
    let lignes = [];
    try { lignes = JSON.parse(r.corps); } catch (e) { return { faits: [] }; }
    if (!Array.isArray(lignes) || lignes.length < 2) return { faits: [] };
    const corps = lignes.slice(1);            /* la premiere ligne est l en-tete */
    const dates = corps.map((l) => l[0]).filter(Boolean).sort();
    const faits = [f({ sujet: cible, predicat: 'WEB ARCHIVE',
                       valeur: corps.length + ' archived pages, from '
                             + (dates[0] || '?').slice(0, 4) + ' to ' + (dates[dates.length - 1] || '?').slice(0, 4),
                       source: 'https://web.archive.org/web/*/' + cible.valeur, verifie: true, confiance: 'MEDIUM',
                       pourquoi: 'a public archive of what this domain showed the world over time' })];
    return { faits };
  },
});

/* ==================================================================
 * LES CONNECTEURS A CLE — declares, eteints tant que la cle manque
 * ==================================================================
 * Chacun est une source professionnelle standard (SpiderFoot, BBOT et
 * OpenOSINT les integrent tous). On les DECLARE pour que la plomberie
 * existe et que la page les montre en « eteint, cle requise » : le jour ou
 * une cle est posee dans l environnement, le connecteur s allume sans
 * qu on touche au code. Un connecteur eteint qui se DIT eteint vaut mieux
 * qu une source absente qu on croit avoir. */

/* Shodan : ce qu une IP expose au monde — ports, bannieres, services. */
N.declare({
  nom: 'shodan', consomme: ['ip'], produit: [], cle: 'SHODAN_API_KEY',
  hote: 'api.shodan.io', parMinute: 30, ttl: 6 * 60 * 60 * 1000, cout: 'key required (free tier available)',
  async lance(cible, ctx) {
    const k = (ctx.env || process.env).SHODAN_API_KEY;
    const r = await D.recuperePage('https://api.shodan.io/shodan/host/' + cible.valeur + '?key=' + encodeURIComponent(k),
                                   'application/json');
    if (r.code === 404) return { faits: [f({ sujet: cible, predicat: 'EXPOSED SERVICES',
      valeur: 'nothing indexed by Shodan', source: 'shodan.io', verifie: true, confiance: 'MEDIUM' })] };
    if (!r.ok) throw new Error('Shodan HTTP ' + r.code);
    let j = {}; try { j = JSON.parse(r.corps); } catch (e) { throw new Error('Shodan: unreadable'); }
    const ports = Array.isArray(j.ports) ? j.ports : [];
    const faits = [f({ sujet: cible, predicat: 'EXPOSED SERVICES',
                       valeur: ports.length ? ports.length + ' open port(s): ' + ports.join(', ') : 'none',
                       source: 'https://www.shodan.io/host/' + cible.valeur, verifie: true, confiance: 'HIGH' })];
    if (j.org) faits.push(f({ sujet: cible, predicat: 'OPERATED BY', valeur: String(j.org),
                             source: 'shodan.io', verifie: true, confiance: 'HIGH' }));
    return { faits };
  },
});

/* AbuseIPDB : une IP a-t-elle ete signalee, et combien de fois. */
N.declare({
  nom: 'abuseipdb', consomme: ['ip'], produit: [], cle: 'ABUSEIPDB_API_KEY',
  hote: 'api.abuseipdb.com', parMinute: 20, ttl: 3 * 60 * 60 * 1000, cout: 'key required (free tier available)',
  async lance(cible, ctx) {
    const r = await D.recuperePage('https://api.abuseipdb.com/api/v2/check?ipAddress=' + cible.valeur + '&maxAgeInDays=180',
                                   'application/json', { Key: (ctx.env || process.env).ABUSEIPDB_API_KEY });
    if (!r.ok) throw new Error('AbuseIPDB HTTP ' + r.code);
    let j = {}; try { j = JSON.parse(r.corps).data || {}; } catch (e) { throw new Error('AbuseIPDB: unreadable'); }
    return { faits: [f({ sujet: cible, predicat: 'ABUSE REPORTS',
      valeur: (j.totalReports || 0) + ' report(s), ' + (j.abuseConfidenceScore || 0) + '% confidence of abuse',
      source: 'https://www.abuseipdb.com/check/' + cible.valeur, verifie: true,
      confiance: (j.abuseConfidenceScore || 0) > 50 ? 'HIGH' : 'MEDIUM' })] };
  },
});

module.exports.PLATEFORMES_N = PLATEFORMES.length;

/* ==================================================================
 * L EMAIL COMME GRAINE — vers son domaine, et sa propre exposition
 * ==================================================================
 * « jane@acme.io » ne devient pas un dossier sur Jane. Il devient : une
 * enquete sur acme.io (l organisation derriere l adresse, que n importe qui
 * pourrait taper directement), plus ce que l adresse elle-meme expose. Le
 * lien de causalite ne s inverse jamais — on ne part pas d une personne. */
const crypto = require('crypto');

/* Le pivot vers le domaine. Ecarte les fournisseurs grand public : enqueter
   sur gmail.com n a aucun sens et taperait un geant pour rien. */
N.declare({
  nom: 'courriel', consomme: ['email'], produit: ['domaine'],
  ttl: 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const dom = cible.valeur.split('@')[1];
    if (!dom) return { faits: [] };
    if (D.FOURNISSEURS_PERSO.has(dom)) {
      return { faits: [f({ sujet: cible, predicat: 'MAILBOX PROVIDER', valeur: dom,
        source: 'the address itself', verifie: true, confiance: 'HIGH',
        pourquoi: 'a consumer mailbox: its domain is the provider, not an organisation to investigate' })] };
    }
    const o = e('domaine', dom);
    if (!o) return { faits: [] };
    return {
      entites: [o],
      faits: [f({ sujet: cible, predicat: 'EMAIL DOMAIN', objet: o, source: 'the address itself',
        verifie: true, confiance: 'HIGH',
        pourquoi: 'the domain of the address is public on its face; the organisation behind it is investigated' })],
    };
  },
});

/* Gravatar : un profil PUBLIC que la personne a elle-meme cree et rattache a
   son adresse, servi par hash md5 de l email. Aucune authentification, aucune
   ruse : on lit ce que le titulaire a choisi de publier. Produit des faits,
   jamais d entite. */
N.declare({
  nom: 'gravatar', consomme: ['email'], produit: [],
  hote: 'gravatar.com', parMinute: 30, ttl: 6 * 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const md5 = crypto.createHash('md5').update(cible.valeur.trim().toLowerCase()).digest('hex');
    const r = await D.recuperePage('https://gravatar.com/' + md5 + '.json', 'application/json');
    if (r.code === 404) {
      return { faits: [f({ sujet: cible, predicat: 'GRAVATAR', valeur: 'no public Gravatar profile',
        source: 'gravatar.com', verifie: true, confiance: 'MEDIUM' })] };
    }
    if (!r.ok) return { faits: [] };
    let j = null;
    try { j = JSON.parse(r.corps).entry[0]; } catch (err) { return { faits: [] }; }
    const faits = [f({ sujet: cible, predicat: 'GRAVATAR',
      valeur: 'public profile' + (j.displayName ? ' (' + j.displayName + ')' : ''),
      source: 'https://gravatar.com/' + md5, verifie: true, confiance: 'HIGH',
      pourquoi: 'a profile the account holder created and attached to this address themselves' })];
    /* Les comptes que le titulaire a LUI-MEME listes sur son Gravatar : c est
       lui qui les a publies la, pas nous qui les avons relies. */
    for (const a of (j.accounts || []).slice(0, 20)) {
      if (!a.url) continue;
      faits.push(f({ sujet: cible, predicat: 'LINKED ACCOUNT', valeur: (a.shortname || a.name || '') + ' ' + a.url,
        source: 'https://gravatar.com/' + md5, verifie: true, confiance: 'MEDIUM',
        pourquoi: 'listed by the account holder on their own Gravatar profile' }));
    }
    return { faits };
  },
});

/* Le telephone : le plan de numerotation est public et gratuit ; l operateur
   et mobile/fixe demandent une base payante. On la DECLARE, eteinte tant que
   la cle manque — extensible, honnete, jamais un « mobile » invente. */
N.declare({
  nom: 'numverify', consomme: ['telephone'], produit: [], cle: 'NUMVERIFY_API_KEY',
  hote: 'apilayer.net', parMinute: 20, ttl: 24 * 60 * 60 * 1000, cout: 'key required (free tier available)',
  async lance(cible, ctx) {
    const url = 'http://apilayer.net/api/validate?access_key=' + encodeURIComponent((ctx.env || process.env).NUMVERIFY_API_KEY)
              + '&number=' + encodeURIComponent(cible.valeur);
    const r = await D.recuperePage(url, 'application/json');
    if (!r.ok) throw new Error('numverify HTTP ' + r.code);
    let j = {}; try { j = JSON.parse(r.corps); } catch (e) { throw new Error('numverify: unreadable'); }
    if (!j.valid) return { faits: [f({ sujet: cible, predicat: 'CARRIER', valeur: 'number not valid per numverify',
      source: 'numverify', verifie: true, confiance: 'MEDIUM' })] };
    const faits = [];
    if (j.carrier) faits.push(f({ sujet: cible, predicat: 'CARRIER', valeur: String(j.carrier),
      source: 'numverify', verifie: true, confiance: 'HIGH' }));
    if (j.line_type) faits.push(f({ sujet: cible, predicat: 'LINE TYPE', valeur: String(j.line_type),
      source: 'numverify', verifie: true, confiance: 'HIGH' }));
    if (j.location) faits.push(f({ sujet: cible, predicat: 'REGION', valeur: String(j.location),
      source: 'numverify', verifie: true, confiance: 'MEDIUM' }));
    return { faits };
  },
});

/* ==================================================================
 * LE NOM — DES CANDIDATS PUBLICS, JAMAIS UNE IDENTITE
 * ==================================================================
 * « Jean Dupont » ne devient pas un dossier sur une personne. Il devient une
 * liste de CANDIDATS publics distincts : une entite Wikidata (personne
 * notable), un compte GitHub au nom cherche. Chacun est une entite a part,
 * marquee non verifiee, JAMAIS fusionnee avec une autre — porter le meme nom
 * n est pas etre la meme personne, et c est la regle centrale de ce module.
 *
 * On ne fabrique rien : si Wikidata et GitHub ne rendent rien, on le dit.
 * Aucune base fuitee, aucun courtier de donnees, aucune deduction d identite. */

/* Wikidata : le graphe de connaissances public. Ses candidats sont des
   personnes/organisations notables, avec une description et une URL. */
N.declare({
  nom: 'wikidata', consomme: ['personne'], produit: ['candidat'],
  hote: 'www.wikidata.org', parMinute: 30, ttl: 24 * 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const url = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search='
              + encodeURIComponent(cible.valeur) + '&language=en&format=json&limit=7&type=item';
    const r = await D.recuperePage(url, 'application/json');
    if (!r.ok) return { faits: [] };
    let j = null; try { j = JSON.parse(r.corps); } catch (e) { return { faits: [] }; }
    const faits = [], entites = [];
    for (const it of (j.search || [])) {
      /* Chaque candidat est DISTINCT — cle sur l identifiant Wikidata, pas
         sur le nom. Deux « John Doe » sont deux entites, pas une. */
      const o = e('candidat', it.label + ' — ' + (it.id || ''));
      if (!o) continue;
      entites.push(o);
      const src = it.concepturi || ('https://www.wikidata.org/wiki/' + it.id);
      faits.push(f({ sujet: cible, predicat: 'PUBLIC CANDIDATE', objet: o, source: src,
        verifie: false, confiance: 'LOW',
        pourquoi: 'a public Wikidata entity sharing this name. Same name is not the same person — unverified.',
        extrait: it.description || '' }));
      if (it.description) faits.push(f({ sujet: o, predicat: 'DESCRIBED AS', valeur: it.description,
        source: src, verifie: false, confiance: 'LOW' }));
    }
    if (!faits.length) faits.push(f({ sujet: cible, predicat: 'WIKIDATA', valeur: 'no public entity of this name',
      source: 'wikidata.org', verifie: true, confiance: 'MEDIUM' }));
    return { faits, entites };
  },
});

/* GitHub : les comptes publics dont le NOM affiche correspond. On lit le
   compte, jamais son contenu prive. Un homonyme n est pas la personne. */
N.declare({
  nom: 'github_noms', consomme: ['personne'], produit: ['candidat'],
  hote: 'api.github.com', parMinute: 10, ttl: 6 * 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const url = 'https://api.github.com/search/users?q=' + encodeURIComponent(cible.valeur + ' in:name')
              + '&per_page=5';
    const r = await D.recuperePage(url, 'application/vnd.github+json');
    if (!r.ok) return { faits: [] };
    let j = null; try { j = JSON.parse(r.corps); } catch (e) { return { faits: [] }; }
    const faits = [], entites = [];
    for (const it of (j.items || []).slice(0, 5)) {
      if (it.type !== 'User') continue;
      const o = e('candidat', '@' + it.login + ' (GitHub)');
      if (!o) continue;
      entites.push(o);
      faits.push(f({ sujet: cible, predicat: 'PUBLIC CANDIDATE', objet: o, source: it.html_url,
        verifie: false, confiance: 'LOW',
        pourquoi: 'a GitHub account whose profile name matches. Matching a name does not confirm identity — unverified.' }));
    }
    return { faits, entites };
  },
});

/* ==================================================================
 * ASN — l operateur reseau, via RIPEstat (public)
 * ================================================================== */
N.declare({
  nom: 'asn', consomme: ['asn'], produit: ['reseau'],
  hote: 'stat.ripe.net', parMinute: 20, ttl: 24 * 60 * 60 * 1000, cout: 'free',
  async lance(cible) {
    const num = cible.valeur.replace(/^AS/, '');
    const r = await D.recuperePage('https://stat.ripe.net/data/as-overview/data.json?resource=' + num, 'application/json');
    if (!r.ok) return { faits: [] };
    let j = null; try { j = JSON.parse(r.corps); } catch (e) { return { faits: [] }; }
    const d = j.data || {};
    const faits = [], entites = [];
    if (d.holder) {
      const o = e('reseau', d.holder);
      entites.push(o);
      faits.push(f({ sujet: cible, predicat: 'OPERATED BY', objet: o,
        source: 'https://stat.ripe.net/AS' + num, verifie: false, confiance: 'HIGH' }));
    }
    faits.push(f({ sujet: cible, predicat: 'ANNOUNCED', valeur: d.announced ? 'announced in the routing table' : 'not currently announced',
      source: 'https://stat.ripe.net/AS' + num, verifie: false, confiance: 'MEDIUM' }));
    /* Les prefixes annonces : point de pivot vers l infrastructure. */
    return { faits, entites };
  },
});

/* ==================================================================
 * CVE — une vulnerabilite publique, via le NVD (public)
 * ================================================================== */
N.declare({
  nom: 'cve', consomme: ['cve'], produit: [],
  hote: 'services.nvd.nist.gov', parMinute: 5, ttl: 24 * 60 * 60 * 1000, cout: 'free', delaiMs: 12000,
  async lance(cible) {
    const r = await D.recuperePage('https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=' + cible.valeur, 'application/json');
    if (!r.ok) return { faits: [] };
    let j = null; try { j = JSON.parse(r.corps); } catch (e) { return { faits: [] }; }
    const v = j.vulnerabilities && j.vulnerabilities[0] && j.vulnerabilities[0].cve;
    if (!v) return { faits: [f({ sujet: cible, predicat: 'CVE', valeur: 'not found in the NVD',
      source: 'nvd.nist.gov', verifie: true, confiance: 'MEDIUM' })] };
    const src = 'https://nvd.nist.gov/vuln/detail/' + cible.valeur;
    const desc = (v.descriptions || []).find((x) => x.lang === 'en');
    const faits = [];
    if (desc) faits.push(f({ sujet: cible, predicat: 'DESCRIPTION', valeur: String(desc.value).slice(0, 240),
      source: src, verifie: true, confiance: 'HIGH' }));
    if (v.published) faits.push(f({ sujet: cible, predicat: 'PUBLISHED ON', valeur: String(v.published).slice(0, 10),
      source: src, verifie: true, confiance: 'HIGH' }));
    /* La severite CVSS, si le NVD la donne. */
    const m = v.metrics || {};
    const cvss = (m.cvssMetricV31 || m.cvssMetricV30 || m.cvssMetricV2 || [])[0];
    if (cvss && cvss.cvssData) faits.push(f({ sujet: cible, predicat: 'SEVERITY',
      valeur: (cvss.cvssData.baseSeverity || '') + ' (' + cvss.cvssData.baseScore + ')',
      source: src, verifie: true, confiance: 'HIGH' }));
    return { faits };
  },
});
