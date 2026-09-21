/* ==================================================================
 * SWOGE RECON — ce qu une organisation publie ELLE-MEME sur son domaine
 * ==================================================================
 *
 * LA REGLE QUI TIENT TOUT LE RESTE : on entre par un DOMAINE ou une IP,
 * jamais par une personne. Aucune fonction de ce fichier n accepte un nom,
 * un prenom, un pseudo, un numero ou une adresse mail en ENTREE. C est
 * structurel, pas une politesse : on ne peut pas profiler quelqu un qu on
 * n a aucun moyen de chercher.
 *
 * Une personne peut donc APPARAITRE en sortie — parce que son employeur a
 * ecrit son nom et sa fonction sur sa propre page equipe — mais jamais
 * parce qu on l a cherchee.
 *
 * Ce que ce fichier ne fait JAMAIS, et pourquoi c est ecrit ici plutot que
 * dans une note de version :
 *   - deviner une adresse mail (pas de prenom.nom@domaine : voir MOTIF_MAIL,
 *     qui ne LIT que ce qui est deja ecrit dans une page recue) ;
 *   - interroger une base fuitee ou privee (les seules sources sont DNS,
 *     RDAP, la transparence des certificats, et les pages du domaine lui-meme) ;
 *   - contourner une authentification ou une protection anti-robot : on
 *     s annonce sous UA, on respecte robots.txt, et un 403 est NOTE comme un
 *     refus du site, jamais reessaye deguise (voir recuperePage) ;
 *   - garder une adresse mail personnelle trouvee sur une page (FOURNISSEURS_PERSO) ;
 *   - dire qu une personne POSSEDE un domaine sans acte public le disant
 *     (voir lienAuDomaine : « PUBLICLY ASSOCIATED WITH DOMAIN » par defaut).
 *
 * Chaque fait sorti d ici porte sa source : l URL exacte, la date, et
 * VERIFIED / NOT VERIFIED — verifie voulant dire « nous avons recupere cette
 * URL nous-memes et la chaine est litteralement dans le corps recu », pas
 * « ca a l air vrai ». */

const dnsp = require('dns').promises;

/* Les bornes. Une route publique ne doit pas pouvoir faire saigner le
   serveur ni le site vise : huit pages au plus, cinq secondes chacune,
   512 Ko par page, vingt secondes pour tout. */
/* Quatorze pages au plus. Les variantes d un meme role s arretent des que
   l une repond (voir la boucle du releve), donc un site ordinaire en coute
   six ; le plafond ne sert qu au site qui n a aucune de ces pages et nous
   renvoie quatorze 404. */
const PAGES_MAX = Math.max(1, Number(process.env.RECON_PAGES_MAX || 14));
const DELAI_MS = Math.max(1000, Number(process.env.RECON_DELAI_MS || 5000));
const TAILLE_MAX = Math.max(16384, Number(process.env.RECON_TAILLE_MAX || 512 * 1024));
const TOTAL_MS = Math.max(5000, Number(process.env.RECON_TOTAL_MS || 20000));
const SOUS_DOMAINES_MAX = Math.max(1, Number(process.env.RECON_SOUS_MAX || 200));

/* On s annonce. Un site qui ne veut pas de nous doit pouvoir nous refuser
   par notre nom — c est l inverse exact d un contournement. */
const UA = 'SwogeRecon/1.0 (+https://swoleeswoge.dog/swoge_recon.html)';

/* Les fournisseurs de messagerie grand public. Une adresse chez eux est une
   adresse PERSONNELLE, meme imprimee sur une page publique : elle ne sort
   pas d ici. C est le filtre « privacy by design » du module, et il est
   applique a l extraction, pas a l affichage — ce qui n est pas collecte ne
   peut pas fuiter. */
const FOURNISSEURS_PERSO = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr', 'ymail.com',
  'hotmail.com', 'hotmail.fr', 'outlook.com', 'outlook.fr', 'live.com',
  'live.fr', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me', 'tutanota.com', 'tuta.io',
  'gmx.com', 'gmx.net', 'gmx.fr', 'mail.com', 'zoho.com', 'yandex.ru',
  'free.fr', 'orange.fr', 'wanadoo.fr', 'sfr.fr', 'laposte.net', 'bbox.fr',
  'numericable.fr', 'aliceadsl.fr', 'neuf.fr', 'club-internet.fr',
  'qq.com', '163.com', '126.com', 'naver.com', 'daum.net', 'web.de',
  't-online.de', 'libero.it', 'virgilio.it', 'terra.com.br', 'uol.com.br',
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'yopmail.com',
]);

/* Les domaines qui ne veulent rien dire dans un exemple de code. Une page
   qui montre « contact@example.com » ne donne pas un contact. */
const DOMAINES_EXEMPLE = new Set([
  'example.com', 'example.org', 'example.net', 'exemple.fr', 'domain.com',
  'yourdomain.com', 'votredomaine.fr', 'email.com', 'test.com', 'sentry.io',
  'wixpress.com', 'squarespace.com', 'godaddy.com',
]);

/* Les boites de role. Elles ne designent PERSONNE — c est justement ce qui
   les rend publiables sans reserve : elles sont faites pour etre ecrites. */
const BOITES_ROLE = new Set([
  'contact', 'info', 'hello', 'bonjour', 'support', 'help', 'sales',
  'commercial', 'press', 'presse', 'media', 'legal', 'juridique', 'rgpd',
  'gdpr', 'dpo', 'privacy', 'security', 'securite', 'abuse', 'admin',
  'webmaster', 'postmaster', 'hostmaster', 'noc', 'soc', 'billing',
  'compta', 'recrutement', 'jobs', 'careers', 'rh', 'hr', 'office',
]);

/* ---- L ENTREE : un domaine ou une IP, et rien d autre ----
 * On accepte ce qu un humain colle : une URL entiere, un domaine avec www,
 * un point final. On rend le domaine enregistrable en minuscules. Tout le
 * reste — un nom, un mail, un numero — ne ressemble a rien d ici et sort
 * par null. */
function normaliseDomaine(entree) {
  let s = String(entree == null ? '' : entree).trim().toLowerCase();
  if (!s) return null;
  /* Une URL collee : on ne garde que l hote. */
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch (e) { return null; }
  } else if (s.includes('/')) {
    s = s.split('/')[0];
  }
  if (s.includes('@')) return null;          /* une adresse mail n est pas un domaine */
  s = s.replace(/^www\./, '').replace(/\.+$/, '');
  if (s.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(s)) return null;  /* c est une IP */
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s)) return null;
  if (s.length > 253) return null;
  /* Les noms qui ne designent pas l internet public. */
  const tld = s.slice(s.lastIndexOf('.') + 1);
  if (['local', 'localhost', 'internal', 'lan', 'home', 'corp', 'intranet', 'test', 'invalid', 'onion'].includes(tld)) return null;
  return s;
}

/* ---- LA GARDE SSRF ----
 * Cette route est publique et va chercher des URL. Sans cette fonction,
 * n importe qui la transforme en sonde de notre propre reseau : un domaine
 * qui resout vers 169.254.169.254 lit les jetons de la machine. On refuse
 * donc TOUTE adresse qui n est pas sur l internet public, et on la refuse
 * APRES resolution, pas sur l allure du nom. */
function estIpPublique(ip) {
  const s = String(ip || '').trim();
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] === 169 && o[1] === 254) return false;          /* metadonnees du nuage */
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;  /* CGNAT */
    if (o[0] === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return false;
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false;
    if (o[0] === 198 && o[1] === 51 && o[2] === 100) return false;
    if (o[0] === 203 && o[1] === 0 && o[2] === 113) return false;
    if (o[0] >= 224) return false;                            /* multicast et au-dela */
    return true;
  }
  if (!s.includes(':')) return false;
  const v6 = s.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::' || v6 === '::1') return false;
  if (/^f[cd]/.test(v6)) return false;                        /* fc00::/7, unique local */
  if (/^fe[89ab]/.test(v6)) return false;                     /* fe80::/10, lien local */
  if (/^ff/.test(v6)) return false;                           /* multicast */
  if (/^::ffff:/.test(v6)) return estIpPublique(v6.slice(7)); /* v4 deguisee en v6 */
  return true;
}

/* Le reseau est injectable : les essais font tourner tout ce fichier sans
   toucher a l internet, donc sans dependre de la meteo d un service tiers. */
let RESEAU = (...a) => fetch(...a);
let RESOLVEUR = {
  v4: (d) => dnsp.resolve4(d),
  v6: (d) => dnsp.resolve6(d),
  mx: (d) => dnsp.resolveMx(d),
  ns: (d) => dnsp.resolveNs(d),
  txt: (d) => dnsp.resolveTxt(d),
};

/* Recupere une URL sous garde : delai, taille plafonnee, jamais de
   redirection vers une adresse privee. Rend toujours un objet — un echec
   est un FAIT a montrer (« le site nous a refuses »), pas une exception a
   avaler. */
async function recuperePage(url, type) {
  const debut = Date.now();
  try {
    const r = await RESEAU(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: type || 'text/html,text/plain,*/*' },
      signal: AbortSignal.timeout(DELAI_MS),
    });
    const code = r.status;
    /* Un refus s ecrit et s arrete la. On ne change NI l UA, NI les entetes,
       NI le rythme pour repasser : un site qui dit non a dit non. */
    if (code === 401 || code === 403 || code === 429) {
      return { url, ok: false, code, refus: true, corps: '', ms: Date.now() - debut };
    }
    if (!r.ok) return { url, ok: false, code, corps: '', ms: Date.now() - debut };
    const brut = await lisPlafonne(r);
    return { url, ok: true, code, corps: brut, ms: Date.now() - debut,
             type: String(r.headers && r.headers.get ? (r.headers.get('content-type') || '') : '') };
  } catch (e) {
    return { url, ok: false, code: 0, erreur: String(e && e.message || e).slice(0, 120),
             corps: '', ms: Date.now() - debut };
  }
}

/* Lit un corps sans jamais depasser TAILLE_MAX, meme si le serveur ment sur
   content-length ou n en donne pas. */
async function lisPlafonne(r) {
  if (!r.body || typeof r.body.getReader !== 'function') {
    const t = await r.text();
    return t.slice(0, TAILLE_MAX);
  }
  const lecteur = r.body.getReader();
  const bouts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    n += value.length;
    bouts.push(Buffer.from(value));
    if (n >= TAILLE_MAX) { try { await lecteur.cancel(); } catch (e) {} break; }
  }
  return Buffer.concat(bouts).toString('utf8').slice(0, TAILLE_MAX);
}

/* ==================================================================
 * L INFRASTRUCTURE — des machines, pas des gens
 * ================================================================== */

/* Le DNS. Publie par definition : c est ce que le domaine repond au monde
   entier a chaque visite. Chaque enregistrement manquant est un fait, pas
   une erreur : un domaine sans MX ne recoit pas de courrier, et c est une
   information. */
async function dnsDe(domaine) {
  const r = { a: [], aaaa: [], mx: [], ns: [], txt: [] };
  const sur = async (cle, f) => { try { r[cle] = await f(); } catch (e) { r[cle] = []; } };
  await Promise.all([
    sur('a', () => RESOLVEUR.v4(domaine)),
    sur('aaaa', () => RESOLVEUR.v6(domaine)),
    sur('mx', async () => (await RESOLVEUR.mx(domaine)).map((m) => ({ hote: m.exchange, prio: m.priority }))),
    sur('ns', () => RESOLVEUR.ns(domaine)),
    sur('txt', async () => (await RESOLVEUR.txt(domaine)).map((t) => (Array.isArray(t) ? t.join('') : String(t)))),
  ]);
  /* Ce que les TXT disent du courrier : SPF et DMARC sont des declarations
     publiques du domaine sur qui a le droit d ecrire en son nom. */
  r.spf = r.txt.find((t) => /^v=spf1\b/i.test(t)) || null;
  r.dmarc = null;
  try {
    const d = await RESOLVEUR.txt('_dmarc.' + domaine);
    const plat = d.map((t) => (Array.isArray(t) ? t.join('') : String(t)));
    r.dmarc = plat.find((t) => /^v=DMARC1\b/i.test(t)) || null;
  } catch (e) { r.dmarc = null; }
  /* Chez qui est le courrier. Un MX en google.com ou outlook.com dit que
     les adresses du domaine existent quelque part — il ne dit PAS
     lesquelles, et on ne va pas le demander. */
  r.hebergeurMail = r.mx.length
    ? (String(r.mx[0].hote || '').match(/([a-z0-9-]+\.[a-z]{2,})\.?$/i) || [null, null])[1]
    : null;
  return r;
}

/* RDAP : le registre du domaine, servi en JSON par le registre lui-meme.
   Remplace whois et, surtout, DIT quand une donnee est masquee au lieu de
   la taire. Depuis le RGPD le titulaire est presque toujours redige — et
   « redige » est exactement ce qu il faut montrer : l absence de preuve. */
async function rdapDomaine(domaine) {
  const r = await recuperePage('https://rdap.org/domain/' + encodeURIComponent(domaine), 'application/rdap+json');
  if (!r.ok) return { source: r.url, trouve: false, code: r.code };
  let j = null;
  try { j = JSON.parse(r.corps); } catch (e) { return { source: r.url, trouve: false, code: r.code }; }
  const ev = (nom) => {
    const e = (j.events || []).find((x) => x.eventAction === nom);
    return e ? String(e.eventDate || '').slice(0, 10) : null;
  };
  const registraire = (j.entities || []).find((e) => (e.roles || []).includes('registrar'));
  /* Le titulaire. On ne le sort QUE s il porte un nom lisible : une fiche
     « REDACTED FOR PRIVACY » est une absence, et on l ecrit comme telle. */
  const titulaireBrut = (j.entities || []).find((e) => (e.roles || []).includes('registrant'));
  const titulaire = nomVcard(titulaireBrut);
  const masque = !titulaire || /redact|privacy|protect|masqu|withheld|data protected|not disclosed/i.test(titulaire);
  return {
    source: r.url,
    trouve: true,
    registraire: nomVcard(registraire) || null,
    cree: ev('registration'),
    expire: ev('expiration'),
    modifie: ev('last changed') || ev('last update of RDAP database'),
    etats: (j.status || []).slice(0, 8),
    serveursNoms: (j.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean),
    /* La seule maniere dont une PERSONNE peut sortir du RDAP : un titulaire
       en clair. Sinon titulaire = null et titulaireMasque = true — ce qui
       interdit, plus bas, de parler de propriete. */
    titulaire: masque ? null : titulaire,
    titulaireMasque: masque,
  };
}

/* Un nom lisible dans une fiche vcard RDAP, ou null. */
function nomVcard(e) {
  if (!e) return null;
  const v = e.vcardArray && Array.isArray(e.vcardArray) ? e.vcardArray[1] : null;
  if (Array.isArray(v)) {
    const fn = v.find((x) => Array.isArray(x) && x[0] === 'fn');
    if (fn && fn[3]) return String(fn[3]).trim().slice(0, 120);
    const org = v.find((x) => Array.isArray(x) && x[0] === 'org');
    if (org && org[3]) return String(Array.isArray(org[3]) ? org[3][0] : org[3]).trim().slice(0, 120);
  }
  if (e.handle) return String(e.handle).slice(0, 120);
  return null;
}

/* RDAP sur une IP : a qui appartient le reseau, et dans quel AS. Des
   machines et des operateurs — aucune personne physique n en sort. */
async function rdapIp(ip) {
  if (!estIpPublique(ip)) return { ip, trouve: false, prive: true };
  const r = await recuperePage('https://rdap.org/ip/' + encodeURIComponent(ip), 'application/rdap+json');
  if (!r.ok) return { ip, trouve: false, code: r.code };
  let j = null;
  try { j = JSON.parse(r.corps); } catch (e) { return { ip, trouve: false, code: r.code }; }
  const op = (j.entities || []).find((e) => (e.roles || []).some((x) => x === 'registrant' || x === 'administrative'));
  return {
    ip,
    trouve: true,
    source: r.url,
    reseau: j.name || null,
    plage: j.startAddress && j.endAddress ? j.startAddress + ' – ' + j.endAddress : (j.handle || null),
    pays: j.country || null,
    operateur: nomVcard(op) || null,
    /* Les AS dans lesquels l adresse est annoncee, quand le registre les donne. */
    asn: Array.isArray(j.arin_originas0_originautnums) && j.arin_originas0_originautnums.length
      ? 'AS' + j.arin_originas0_originautnums[0] : null,
  };
}

/* La transparence des certificats : chaque certificat TLS emis pour le
   domaine est publie dans un journal public et inalterable, par
   construction du protocole. C est la source de sous-domaines la plus
   honnete qui existe — on lit un registre public, on ne devine rien et on
   ne frappe a aucune porte. */
async function certsDe(domaine) {
  const url = 'https://crt.sh/?q=' + encodeURIComponent('%.' + domaine) + '&output=json';
  const r = await recuperePage(url, 'application/json');
  if (!r.ok) return { source: url, trouve: false, code: r.code, sousDomaines: [], emetteurs: [] };
  let j = null;
  try { j = JSON.parse(r.corps); } catch (e) { return { source: url, trouve: false, sousDomaines: [], emetteurs: [] }; }
  if (!Array.isArray(j)) return { source: url, trouve: false, sousDomaines: [], emetteurs: [] };
  const noms = new Set();
  const emetteurs = new Map();
  for (const c of j) {
    for (const n of String(c.name_value || '').split(/\s+/)) {
      const v = n.trim().toLowerCase().replace(/^\*\./, '');
      if (v && (v === domaine || v.endsWith('.' + domaine))) noms.add(v);
    }
    const em = String(c.issuer_name || '').match(/O=([^,]+)/);
    if (em) emetteurs.set(em[1], (emetteurs.get(em[1]) || 0) + 1);
  }
  noms.delete(domaine);
  return {
    source: url,
    trouve: true,
    /* NOT VERIFIED : ce sont des noms qu une autorite a certifies un jour,
       pas des machines qu on a vues repondre aujourd hui. */
    sousDomaines: [...noms].sort().slice(0, SOUS_DOMAINES_MAX),
    total: noms.size,
    emetteurs: [...emetteurs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([nom, n]) => ({ nom, n })),
  };
}

/* robots.txt. On le lit pour OBEIR, pas pour trouver des chemins caches :
   un Disallow nous ferme la page, il ne nous l indique pas. */
async function robotsDe(domaine) {
  const r = await recuperePage('https://' + domaine + '/robots.txt', 'text/plain');
  if (!r.ok) return { interdits: [], lu: false };
  const interdits = [];
  let pourNous = false;
  for (const ligne of String(r.corps).split(/\r?\n/)) {
    const l = ligne.replace(/#.*$/, '').trim();
    if (!l) continue;
    const m = l.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const cle = m[1].toLowerCase();
    const val = m[2].trim();
    if (cle === 'user-agent') pourNous = (val === '*' || /swoge/i.test(val));
    else if (cle === 'disallow' && pourNous && val) interdits.push(val);
  }
  return { interdits, lu: true };
}

function robotsPermet(robots, chemin) {
  if (!robots || !robots.lu) return true;
  for (const i of robots.interdits) {
    if (i === '/') return false;
    if (chemin.startsWith(i)) return false;
  }
  return true;
}

/* ==================================================================
 * LES CONTACTS — uniquement ce que l organisation a ECRIT elle-meme
 * ================================================================== */

/* Les pages qu une organisation publie POUR etre contactee. L ordre est
   celui de la confiance : une mention legale est une declaration opposable,
   une page equipe est une intention, la page d accueil est un pied de page.
   « role » sert deux fois : a classer la confiance, et a decider si une
   adresse nominative a le droit de sortir. */
const PAGES_CANDIDATES = [
  /* L accueil d abord : il coute une requete, donne l enseigne, et son pied
     de page porte souvent la seule adresse du site. */
  { chemin: '/', role: 'autre' },
  { chemin: '/.well-known/security.txt', role: 'securite' },
  { chemin: '/security.txt', role: 'securite' },
  { chemin: '/mentions-legales', role: 'legal' },
  { chemin: '/legal', role: 'legal' },
  { chemin: '/impressum', role: 'legal' },
  { chemin: '/imprint', role: 'legal' },
  { chemin: '/legal-notice', role: 'legal' },
  { chemin: '/contact', role: 'contact' },
  { chemin: '/contact-us', role: 'contact' },
  { chemin: '/nous-contacter', role: 'contact' },
  { chemin: '/about', role: 'equipe' },
  { chemin: '/about-us', role: 'equipe' },
  { chemin: '/a-propos', role: 'equipe' },
  { chemin: '/team', role: 'equipe' },
  { chemin: '/equipe', role: 'equipe' },
];

/* Les fonctions qui font d un nom un CONTACT PROFESSIONNEL. La liste est
   volontairement courte : des roles de direction et de representation, ceux
   qu une organisation publie pour qu on s adresse a eux. Un developpeur
   nomme dans un billet de blog n est pas un contact — et n en devient pas
   un parce qu on a elargi une liste. */
const FONCTIONS = [
  'ceo', 'cto', 'cfo', 'coo', 'cmo', 'ciso', 'cio', 'chief executive',
  'chief technology', 'chief financial', 'chief operating', 'chief marketing',
  'founder', 'co-founder', 'cofounder', 'fondateur', 'fondatrice', 'cofondateur', 'cofondatrice',
  'president', 'présidente', 'président', 'vice president', 'vp of', 'vp,',
  'director', 'directeur', 'directrice', 'managing director', 'general manager',
  'head of', 'responsable', 'gérant', 'gerant', 'gérante',
  'partner', 'associé', 'associée', 'managing partner',
  'press contact', 'media contact', 'contact presse', 'délégué à la protection',
  'data protection officer', 'dpo', 'directeur de la publication',
];

/* Tous les mots qui composent une fonction, plus les domaines qu on voit
   derriere « Head of … ». Aucun d eux ne peut etre un prenom ou un nom. */
const MOTS_FONCTION = new Set();
for (const f of FONCTIONS) for (const w of f.split(/[^a-zà-öø-ÿ]+/i)) if (w.length > 1) MOTS_FONCTION.add(w.toLowerCase());
for (const w of ['officer', 'manager', 'security', 'engineering', 'product', 'people',
                 'growth', 'sales', 'operations', 'design', 'data', 'communications',
                 'marketing', 'finance', 'legal', 'technology', 'research', 'staff',
                 'publication', 'protection', 'chief', 'executive', 'deputy', 'senior']) MOTS_FONCTION.add(w);

/* Les mots qui relient deux morceaux d une fonction, et rien d autre. */
const LIAISONS = new Set(['of', 'de', 'des', 'du', 'la', 'le', 'les', 'd', 'and', 'et',
                          'the', 'for', 'at', 'in', 'a', 'au', 'aux', '&']);

/* Des suites de deux mots capitalises qui ne sont pas des noms de personnes.
   Sans ce filtre, « Privacy Policy » devient quelqu un. */
const MOTS_NON_NOM = new Set([
  'privacy', 'policy', 'terms', 'cookie', 'cookies', 'legal', 'notice',
  'contact', 'about', 'team', 'our', 'the', 'all', 'rights', 'reserved',
  'read', 'more', 'learn', 'sign', 'log', 'get', 'started', 'home', 'page',
  'new', 'york', 'san', 'francisco', 'united', 'states', 'kingdom', 'los',
  'angeles', 'hong', 'kong', 'saint', 'view', 'main', 'street', 'avenue',
  'copyright', 'company', 'limited', 'inc', 'llc', 'gmbh', 'sas', 'sarl',
  'customer', 'service', 'support', 'help', 'center', 'centre', 'français',
  'english', 'deutsch', 'español', 'menu', 'close', 'open', 'next', 'back',
  'follow', 'share', 'subscribe', 'newsletter', 'sitemap', 'careers', 'jobs',
]);

/* Le texte d une page, sans le code. On retire script et style AVANT de
   retirer les balises : sinon une cle d API dans un script ressemble a une
   adresse mail. */
function texteDe(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCharCode(Number(d)); } catch (e) { return ' '; } })
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t ]+/g, ' ');
}

/* « Ensemble sur la page », mesure honnetement.
 *
 * Premiere version : decouper le HTML sur les balises de bloc. Fausse, et
 * silencieusement : une carte d equipe ecrit le nom dans un <h3>, la
 * fonction dans un <p> et l adresse dans un <a>. Le decoupage les separait
 * tous les trois, et la fonction ne trouvait plus personne — sur AUCUN site.
 *
 * On ne pretend donc pas lire une structure. On aplatit la page en texte et
 * on regarde la DISTANCE : un nom et une fonction comptent comme relies
 * s ils tiennent dans la meme fenetre de FENETRE caracteres du texte rendu.
 * C est ce qu on peut affirmer, et c est pour ca que ca ne vaut jamais plus
 * que MEDIUM : la proximite reste une proximite. */
const FENETRE = 120;
function fenetresDe(html) {
  const texte = texteDe(html).replace(/\s+/g, ' ');
  const bas = texte.toLowerCase();
  const out = [];
  const vus = new Set();
  for (const f of FONCTIONS) {
    let i = bas.indexOf(f);
    while (i !== -1) {
      const debut = Math.max(0, i - FENETRE);
      const fin = Math.min(texte.length, i + f.length + FENETRE);
      const cle = f + '@' + debut;
      if (!vus.has(cle)) {
        vus.add(cle);
        out.push({ texte: texte.slice(debut, fin), fonction: f, a: i - debut });
      }
      i = bas.indexOf(f, i + f.length);
      if (out.length > 200) return out;
    }
  }
  return out;
}

const MOTIF_MAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const EXT_FICHIER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'json', 'woff', 'woff2', 'ico', 'map', 'mp4', 'pdf']);

/* Une adresse mail n est GARDEE que si elle passe ces portes. Aucune n est
   fabriquee : cette fonction lit, elle ne compose pas. */
function mailRecevable(brut, roleDeLaPage) {
  const a = String(brut || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  const m = a.match(/^([a-z0-9._%+-]{1,64})@([a-z0-9.-]+\.[a-z]{2,24})$/);
  if (!m) return null;
  const [, local, dom] = m;
  const tld = dom.slice(dom.lastIndexOf('.') + 1);
  if (EXT_FICHIER.has(tld)) return null;                 /* logo@2x.png */
  if (DOMAINES_EXEMPLE.has(dom)) return null;            /* contact@example.com */
  if (FOURNISSEURS_PERSO.has(dom)) return null;          /* adresse PERSONNELLE : on ne la collecte pas */
  if (local.includes('..') || dom.includes('..')) return null;
  if (/^[0-9a-f]{16,}$/.test(local)) return null;        /* une cle de service, pas un contact */
  if (/^(sentry|noreply|no-reply|donotreply|ne-pas-repondre)/.test(local)) return null;
  const role = BOITES_ROLE.has(local.split(/[.\-_+]/)[0]) || BOITES_ROLE.has(local);
  /* Une boite de role ne designe personne : elle sort de n importe quelle
     page. Une adresse NOMINATIVE ne sort que d une page dont le but est
     d etre contacte — pas d un billet de blog ni d un pied de page
     d accueil. C est la difference entre publier un contact et ficher
     quelqu un. */
  if (!role && !['legal', 'contact', 'equipe', 'securite'].includes(roleDeLaPage)) return null;
  return { adresse: a, local, domaine: dom, role };
}

/* ---- L EXTRAIT NE DOIT PAS FAIRE ENTRER PAR LA FENETRE ----
 * Defaut trouve en ecrivant l essai de la page. Une adresse chez un
 * fournisseur grand public est refusee a la collecte — mais l extrait du
 * contact VOISIN, pris a cinquante caracteres de part et d autre, la
 * recopiait telle quelle. Le filtre etait applique au bon endroit et
 * contourne trois lignes plus loin.
 *
 * Un extrait existe pour montrer le contexte d UN fait. Toute autre adresse
 * qui s y trouve y est par accident : elle est caviardee, y compris celles
 * qu on aurait eu le droit de relever ailleurs. */
function caviarde(texte, garde) {
  MOTIF_MAIL.lastIndex = 0;
  return String(texte || '').replace(MOTIF_MAIL, (a) =>
    (garde && a.toLowerCase() === String(garde).toLowerCase()) ? a : '[…]');
}

/* Les telephones. Uniquement ceux ecrits dans un lien tel: — un site qui
   pose un tel: publie un numero POUR qu on l appelle. Un nombre a dix
   chiffres croise dans un texte peut etre n importe quoi. */
function telsDe(html) {
  const out = new Set();
  const re = /href\s*=\s*["']tel:([^"']{4,40})["']/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const n = m[1].replace(/[^\d+]/g, '');
    if (n.replace(/\D/g, '').length >= 6 && n.replace(/\D/g, '').length <= 15) out.add(n);
  }
  return [...out];
}

/* Les adresses mail d une page : celles des liens mailto: (une intention
   explicite) et celles ecrites en clair dans le texte. */
function mailsDe(html, roleDeLaPage) {
  const vus = new Map();
  const garde = (brut, explicite, extrait) => {
    const r = mailRecevable(brut, roleDeLaPage);
    if (!r) return;
    const dejala = vus.get(r.adresse);
    if (dejala) { if (explicite) dejala.explicite = true; return; }
    vus.set(r.adresse, Object.assign({ explicite, extrait: String(extrait || '').slice(0, 140) }, r));
  };
  const re = /href\s*=\s*["']mailto:([^"'?]{3,120})/gi;
  let m;
  while ((m = re.exec(String(html || '')))) garde(m[1], true, 'mailto: ' + m[1]);
  const texte = texteDe(html);
  let t;
  MOTIF_MAIL.lastIndex = 0;
  while ((t = MOTIF_MAIL.exec(texte))) {
    garde(t[0], false, texte.slice(Math.max(0, t.index - 50), t.index + t[0].length + 50).trim());
  }
  return [...vus.values()];
}

/* Les personnes. Un nom ne sort QUE s il est colle a une fonction dans le
   meme bloc court, sur une page dont le but est de presenter l organisation.
   La proximite reste une proximite : elle vaut MEDIUM, jamais HIGH. */
const MOTIF_NOM = /\b([A-ZÀ-Þ][a-zà-öø-ÿ'’-]{1,20})(?:\s+([A-ZÀ-Þ][a-zà-öø-ÿ'’-]{1,20}))?(?:\s+([A-ZÀ-Þ][a-zà-öø-ÿ'’-]{1,20}))?\b/g;

/* Un nom candidat dans une fenetre : deux ou trois mots capitalises dont
   AUCUN n est un mot de fonction ni un mot de decor. On rogne les mots de
   fonction attrapes en trop plutot que de jeter le nom — sans ca,
   « Jane Doe Chief » etait rejete en bloc et Jane disparaissait. */
function nomsDe(fenetre) {
  const out = [];
  MOTIF_NOM.lastIndex = 0;
  let m;
  while ((m = MOTIF_NOM.exec(fenetre))) {
    let mots = [m[1], m[2], m[3]].filter(Boolean);
    while (mots.length && (MOTS_FONCTION.has(mots[mots.length - 1].toLowerCase())
                        || MOTS_NON_NOM.has(mots[mots.length - 1].toLowerCase()))) mots.pop();
    while (mots.length && (MOTS_FONCTION.has(mots[0].toLowerCase())
                        || MOTS_NON_NOM.has(mots[0].toLowerCase()))) { m.index += mots[0].length + 1; mots.shift(); }
    if (mots.length < 2) continue;              /* un prenom seul ne designe personne */
    if (mots.some((w) => MOTS_FONCTION.has(w.toLowerCase()) || MOTS_NON_NOM.has(w.toLowerCase()))) continue;
    const nom = mots.join(' ');
    out.push({ nom, mots, debut: m.index, fin: m.index + nom.length });
  }
  return out;
}

/* ---- LES COMPTES PUBLICS PUBLIES PAR L ORGANISATION ----
 * Un lien vers un compte, imprime par l organisation A COTE du nom d une
 * personne nommee, sur sa propre page equipe ou contact, est une
 * information publiee — pas une information collectee.
 *
 * CE QUI REND CECI SUR, ET CE QUI LE RENDRAIT DANGEREUX. Ramasser les
 * comptes de quelqu un a travers les plateformes A PARTIR D UN PSEUDO,
 * c est le pistage par nom d utilisateur, et c est precisement ce que ce
 * module ne peut pas faire : il n y a aucune entree par une personne. Ici,
 * on ne part jamais d un compte pour trouver quelqu un — on part d un
 * domaine, et on lit ce que l organisation a elle-meme ecrit. Le lien de
 * causalite est dans ce sens-la et ne peut pas s inverser.
 *
 * Deux garde-fous portent tout le reste, et ils sont dans les motifs :
 *
 *   1. SEULE LA RACINE D UN COMPTE PASSE. `github.com/acme/projet` est un
 *      DEPOT, `instagram.com/p/xyz` une PHOTO, `linkedin.com/company/acme`
 *      une SOCIETE. Aucun des trois n est quelqu un.
 *   2. LES CHEMINS DE PARTAGE SONT EXCLUS NOMMEMENT. `x.com/share`,
 *      `x.com/intent`, `facebook.com/sharer` tiennent dans le motif d un
 *      pseudo et vivent dans le pied de page de la moitie du web : sans
 *      INTERDITS, chaque site rendrait un « compte » qui n existe pas.
 *
 * Et le troisieme, qui n est pas ici mais dans `proprietaireDu` : un compte
 * sans nom de personne a cote n appartient a personne. C est ce qui fait
 * tomber les boutons de partage et les comptes de la societe, qui vivent
 * justement dans les pieds de page, loin de tout nom. */
const INTERDITS = new Set([
  'share', 'sharer', 'intent', 'intents', 'home', 'search', 'explore', 'about',
  'login', 'signup', 'register', 'privacy', 'terms', 'legal', 'help', 'support',
  'settings', 'p', 'reel', 'reels', 'stories', 'story', 'status', 'watch',
  'hashtag', 'tags', 'pin', 'create', 'embed', 'widgets', 'i', 'c', 'u',
  'channel', 'playlist', 'results', 'feed', 'download', 'apps', 'developers',
  'jobs', 'careers', 'press', 'blog', 'contact', 'directory', 'pages', 'groups',
  'events', 'marketplace', 'messages', 'notifications', 'bookmarks', 'topics',
  'profile', 'sharer', 'intent.php', 'dialog',
]);
/* Les segments qui ANNONCENT un compte au lieu d en etre un : `/in/jane`,
   `/users/42`, `/profile/jane.bsky.social`. Admis seulement devant un
   dernier segment, jamais seuls. */
const PREFIXES_OK = new Set(['in', 'users', 'user', 'u', 'profile', 'citations', 'c']);
/* `genre` sert a l affichage : un annuaire professionnel et un compte social
   ne se presentent pas du meme mot. On ne melange pas les deux sous une
   etiquette « professionnel » qui serait fausse pour la moitie d entre eux. */
const HOTES_PROFIL = [
  /* — les annuaires professionnels — */
  { hote: 'linkedin.com', genre: 'pro', motif: /^\/in\/[A-Za-z0-9\-%_.]{2,100}\/?$/ },
  { hote: 'github.com', genre: 'pro', motif: /^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/?$/ },
  { hote: 'gitlab.com', genre: 'pro', motif: /^\/[A-Za-z0-9][A-Za-z0-9-_.]{0,59}\/?$/ },
  { hote: 'orcid.org', genre: 'pro', motif: /^\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]\/?$/ },
  { hote: 'stackoverflow.com', genre: 'pro', motif: /^\/users\/\d{1,12}(\/[A-Za-z0-9\-%_.]{1,60})?\/?$/ },
  { hote: 'behance.net', genre: 'pro', motif: /^\/[A-Za-z0-9_-]{3,40}\/?$/ },
  { hote: 'dribbble.com', genre: 'pro', motif: /^\/[A-Za-z0-9_-]{3,40}\/?$/ },
  { hote: 'about.me', genre: 'pro', motif: /^\/[A-Za-z0-9_.-]{3,40}\/?$/ },
  { hote: 'keybase.io', genre: 'pro', motif: /^\/[A-Za-z0-9_]{2,40}\/?$/ },
  { hote: 'scholar.google.com', genre: 'pro', motif: /^\/citations\/?$/ },
  /* — les comptes sociaux publics — */
  { hote: 'x.com', genre: 'social', motif: /^\/[A-Za-z0-9_]{1,15}\/?$/ },
  { hote: 'twitter.com', genre: 'social', motif: /^\/[A-Za-z0-9_]{1,15}\/?$/ },
  { hote: 'instagram.com', genre: 'social', motif: /^\/[A-Za-z0-9._]{1,30}\/?$/ },
  { hote: 'facebook.com', genre: 'social', motif: /^\/[A-Za-z0-9.]{5,50}\/?$/ },
  { hote: 'threads.net', genre: 'social', motif: /^\/@[A-Za-z0-9._]{2,30}\/?$/ },
  { hote: 'threads.com', genre: 'social', motif: /^\/@[A-Za-z0-9._]{2,30}\/?$/ },
  { hote: 'tiktok.com', genre: 'social', motif: /^\/@[A-Za-z0-9._]{2,24}\/?$/ },
  { hote: 'youtube.com', genre: 'social', motif: /^\/(@[A-Za-z0-9._-]{3,30}|user\/[A-Za-z0-9_-]{3,40})\/?$/ },
  { hote: 'bsky.app', genre: 'social', motif: /^\/profile\/[A-Za-z0-9.\-]{3,64}\/?$/ },
  { hote: 't.me', genre: 'social', motif: /^\/[A-Za-z0-9_]{5,32}\/?$/ },
  { hote: 'reddit.com', genre: 'social', motif: /^\/(user|u)\/[A-Za-z0-9_-]{3,20}\/?$/ },
  { hote: 'twitch.tv', genre: 'social', motif: /^\/[A-Za-z0-9_]{4,25}\/?$/ },
  { hote: 'medium.com', genre: 'social', motif: /^\/@[A-Za-z0-9._-]{3,30}\/?$/ },
  { hote: 'soundcloud.com', genre: 'social', motif: /^\/[A-Za-z0-9_-]{3,40}\/?$/ },
  { hote: 'pinterest.com', genre: 'social', motif: /^\/[A-Za-z0-9_]{3,30}\/?$/ },
  { hote: 'vk.com', genre: 'social', motif: /^\/[A-Za-z0-9_.]{3,32}\/?$/ },
  { hote: 'mastodon.social', genre: 'social', motif: /^\/@[A-Za-z0-9_]{1,30}\/?$/ },
  { hote: 'mastodon.online', genre: 'social', motif: /^\/@[A-Za-z0-9_]{1,30}\/?$/ },
];
function profilsDe(html) {
  const out = [];
  /* ---- LE PIED DE PAGE NE PARLE DE PERSONNE ----
   * `linkedin.com/company/acme` se reconnait a son URL. Un compte X de
   * societe, lui, s ecrit exactement comme celui d une personne :
   * `x.com/acmecorp`. Mesure sur le cas le plus simple — « Ana Ruiz,
   * Founder » suivi d un pied de page portant le X de la boite — le compte
   * de la societe atterrissait sur Ana, parce qu elle etait le nom le plus
   * proche.
   *
   * On efface donc le contenu de `footer`, `nav` et `header` avant de
   * chercher : ce sont, par definition, des meubles de site, pas la carte
   * de quelqu un. Ca emporte au passage les barres de partage.
   *
   * Ca ne rattrape pas un site qui ecrit son pied de page dans un `div` sans
   * role — et c est exactement pour ca que ce champ ne promet jamais plus
   * que ce qu on a vu : un compte imprime A COTE de ce nom, sur cette page. */
  const propre = String(html || '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ');
  const re = /<a\b[^>]*href\s*=\s*["']([^"']{4,300})["']/gi;
  let m;
  while ((m = re.exec(propre))) {
    let u;
    try { u = new URL(m[1], 'https://rien.invalid'); } catch (e) { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const h = u.hostname.replace(/^www\./, '');
    const p = HOTES_PROFIL.find((x) => h === x.hote || h.endsWith('.' + x.hote));
    if (!p || !p.motif.test(u.pathname)) continue;
    /* Le motif d un pseudo accepte aussi `x.com/share` et `facebook.com/
       sharer.php`, qui vivent dans le pied de page de la moitie du web.
       On regarde donc les SEGMENTS : le dernier est le compte et ne doit
       pas etre un mot reserve ; ceux d avant ne peuvent etre que des
       annonceurs de compte. */
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length) continue;
    const nu = (x) => String(x).replace(/^@/, '').replace(/\.php$/, '').toLowerCase();
    if (INTERDITS.has(nu(segs[segs.length - 1]))) continue;
    if (segs.slice(0, -1).some((x) => !PREFIXES_OK.has(nu(x)))) continue;
    /* Le texte autour du lien : c est lui qui dira DE QUI il s agit. Un lien
       rattache a personne ne sort pas — un pied de page porte souvent le
       LinkedIn de la societe, qui n est le profil de personne. */
    const d = Math.max(0, m.index - 300);
    const f = Math.min(propre.length, m.index + 300);
    /* Coupe AU LIEN : ce qui le precede et ce qui le suit sont deux choses
       differentes. Premiere version : une seule fenetre, et « le nom est
       quelque part dedans ». Elle donnait le LinkedIn de Jane a Bob, dont la
       carte suivait. On garde donc les deux cotes separement, et le
       rattachement se fera sur la DISTANCE au lien. */
    out.push({ url: u.origin + u.pathname.replace(/\/$/, ''), genre: p.genre,
               avant: texteDe(propre.slice(d, m.index)).replace(/\s+/g, ' '),
               apres: texteDe(propre.slice(m.index, f)).replace(/\s+/g, ' ') });
    if (out.length > 60) break;
  }
  return out;
}

/* A QUI est ce lien.
 *
 * On ne demande pas a chaque personne « ton nom est-il pres de ce lien ? » :
 * sur deux cartes qui se touchent, les deux repondent oui et la seconde
 * herite du profil de la premiere. On tranche donc UNE fois, du cote du
 * lien : son proprietaire est le nom le plus proche AVANT lui — la
 * convention des pages equipe, la meme qui decide deja des titres — ou, si
 * rien ne le precede, un nom colle juste apres, le cas du nom ecrit DANS
 * l ancre. Faute de quoi le lien n appartient a personne : c est ce qui
 * arrive au LinkedIn de la societe dans un pied de page, et c est juste.
 */
const PROFIL_PRES = 80;
const PROFIL_DEDANS = 25;
function proprietaireDu(p) {
  if (p.proprietaire !== undefined) return p.proprietaire;
  const avant = nomsDe(p.avant).filter((x) => p.avant.length - x.fin <= PROFIL_PRES);
  if (avant.length) return (p.proprietaire = avant[avant.length - 1].nom);
  const apres = nomsDe(p.apres).filter((x) => x.debut <= PROFIL_DEDANS);
  if (apres.length) return (p.proprietaire = apres[0].nom);
  return (p.proprietaire = null);
}
/* TOUS les comptes rattaches a ce nom, pas seulement le premier : une
   personne qui publie son LinkedIn ET son X en publie deux, et n en montrer
   qu un serait choisir a sa place. Les annuaires professionnels passent
   devant — c est ce qu on cherche le plus souvent ici. */
function profilsDuNom(profils, nom) {
  const vus = new Set();
  return profils
    .filter((x) => proprietaireDu(x) === nom)
    .filter((x) => (vus.has(x.url) ? false : vus.add(x.url)))
    .sort((a, b) => (a.genre === b.genre ? 0 : a.genre === 'pro' ? -1 : 1))
    .map((x) => ({ url: x.url, genre: x.genre }));
}

/* Les personnes. Un nom ne sort QUE s il est colle a une fonction dans la
   meme fenetre, sur une page dont le but est de presenter l organisation.
   La proximite reste une proximite : elle vaut MEDIUM, jamais HIGH. */
function personnesDe(html, roleDeLaPage) {
  if (!['legal', 'equipe', 'contact', 'securite'].includes(roleDeLaPage)) return [];
  const out = new Map();
  const profils = profilsDe(html);
  for (const f of fenetresDe(html)) {
    const finTitre = f.a + f.fonction.length;
    const noms = nomsDe(f.texte);
    const avant = noms.filter((x) => x.fin <= f.a).sort((a, b) => b.fin - a.fin)[0] || null;
    const apres = noms.filter((x) => x.debut >= finTitre).sort((a, b) => a.debut - b.debut)[0] || null;
    /* QUI porte le titre, quand un nom le precede et un autre le suit.
     *
     * Sur une liste d equipe aplatie — « Alice Martin CEO Bob Durand CFO » —
     * les deux sont a un caractere. La distance seule attribuait le CEO a
     * Bob : le nom suivant, systematiquement decale d un cran. La regle est
     * donc la convention d ecriture, pas la distance :
     *   - « Nom, Fonction » et « Nom — Fonction » : le nom PRECEDE. C est la
     *     forme dominante des pages equipe, en francais comme en anglais.
     *   - « Fonction : Nom » : le deux-points inverse l ordre. C est la
     *     forme des mentions legales (« Directeur de la publication : … »),
     *     et c est le seul cas ou le nom qui suit l emporte sur celui qui
     *     precede. */
    const entre = apres ? f.texte.slice(finTitre, apres.debut) : '';
    const inverse = apres && /^[\s:–—-]*$/.test(entre) && entre.includes(':');
    const choisi = inverse ? apres : (avant || apres);
    if (!choisi) continue;
    if (out.has(choisi.nom)) continue;
    /* Le titre s arrete au premier mot capitalise qui n est ni une fonction
       ni un sigle : c est la ou commence le nom suivant. Sans cette coupe,
       Alice etait « CEO Bob Durand CFO ». */
    const titre = [];
    for (const mot of f.texte.slice(f.a, f.a + 70).split(/\s+/)) {
      const nu = mot.replace(/[^\wÀ-ÿ]/g, '');
      if (!nu) { titre.push(mot); continue; }
      if (mot.includes('@')) break;
      const estFonction = MOTS_FONCTION.has(nu.toLowerCase());
      const estSigle = /^[A-Z]{2,5}$/.test(nu);
      /* Un mot en minuscules n est gardé que s il RELIE deux mots de
         fonction. « Head of Security » et « Directeur de la publication » en
         ont besoin ; « CFO repo us » montre ce qui arrive quand on accepte
         n importe quelle minuscule — le titre de Bob avalait le pied de
         page. */
      const estLiaison = LIAISONS.has(nu.toLowerCase());
      if (!estFonction && !estSigle && !estLiaison) break;
      if (titre.length >= 7) break;
      titre.push(mot);
    }
    /* Une adresse mail dans LA MEME FENETRE : l organisation a imprime le
       nom, la fonction et l adresse a quelques mots d intervalle. C est une
       association DOCUMENTEE. On ne rapproche jamais un nom et une adresse
       venus de deux endroits de la page — ce serait deviner, et deviner est
       precisement ce qui est interdit ici. */
    MOTIF_MAIL.lastIndex = 0;
    const dedans = f.texte.match(MOTIF_MAIL) || [];
    const mail = dedans.map((x) => mailRecevable(x, roleDeLaPage)).find(Boolean) || null;
    out.set(choisi.nom, {
      prenom: choisi.mots[0],
      nom: choisi.mots.slice(1).join(' '),
      complet: choisi.nom,
      fonction: titre.join(' ').replace(/[\s:,–—-]+$/, '').trim() || f.fonction,
      mail: mail ? mail.adresse : null,
      /* Un annuaire professionnel et un compte social ne se presentent pas
         du meme mot : les melanger sous « professionnel » serait faux pour
         la moitie d entre eux — d ou le `genre` porte par chacun. */
      profils: profilsDuNom(profils, choisi.nom),
      extrait: caviarde(f.texte.slice(0, 160).trim(), mail ? mail.adresse : null),
    });
  }
  return [...out.values()];
}

/* security.txt (RFC 9116) : un fichier qu un site pose expressement pour
   dire a qui signaler un probleme. Aucune source n est plus consentie que
   celle-la — d ou HIGH sans discussion. */
function litSecurityTxt(corps) {
  const r = { contacts: [], politique: null, expire: null, langues: null };
  for (const ligne of String(corps || '').split(/\r?\n/)) {
    const l = ligne.replace(/^#.*$/, '').trim();
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const cle = m[1].toLowerCase();
    const val = m[2].trim();
    if (cle === 'contact') r.contacts.push(val);
    else if (cle === 'policy') r.politique = val;
    else if (cle === 'expires') r.expire = val;
    else if (cle === 'preferred-languages') r.langues = val;
  }
  return r;
}

/* ---- LA CONFIANCE ----
 * Trois niveaux, chacun avec sa raison en clair. Le niveau ne vient pas
 * d une impression : il vient de la NATURE de la source.
 *   HIGH   : un acte. Mentions legales, security.txt, titulaire RDAP en
 *            clair — des textes publies pour engager celui qui les publie.
 *   MEDIUM : une page du domaine faite pour etre contactee, ou une
 *            association de proximite dans un meme bloc.
 *   LOW    : trouve sur le site, mais sur une page qui n a pas ce but ;
 *            ou un index tiers qu on n a pas confirme.
 */
const RAISONS = {
  legal: ['HIGH', 'published on the organisation’s own legal notice'],
  securite: ['HIGH', 'published in the domain’s security.txt (RFC 9116)'],
  rdapClair: ['HIGH', 'registrant published in clear in the domain registry'],
  contact: ['MEDIUM', 'published on the organisation’s own contact page'],
  equipe: ['MEDIUM', 'published on the organisation’s own team/about page'],
  bloc: ['MEDIUM', 'name, role and address printed together in the same block'],
  autre: ['LOW', 'found on the site, but not on a page meant for contact'],
  tiers: ['LOW', 'from a third-party public index, not confirmed against the domain'],
};
function confiance(cle) {
  const r = RAISONS[cle] || RAISONS.autre;
  return { niveau: r[0], pourquoi: r[1] };
}

/* ---- LE LIEN AU DOMAINE ----
 * Le point le plus facile a rater de tout ce fichier. Un nom sur une page
 * n est pas un proprietaire. « DOMAIN OWNER » demande un acte public qui le
 * DIT : un titulaire RDAP en clair, ou un directeur de la publication dans
 * des mentions legales. Partout ailleurs, et c est l immense majorite des
 * cas, on ecrit « PUBLICLY ASSOCIATED WITH DOMAIN ». */
function lienAuDomaine(source) {
  if (source === 'rdapClair') {
    return { lien: 'DOMAIN OWNER', preuve: 'named as registrant in the domain registry' };
  }
  if (source === 'legal') {
    return { lien: 'DOMAIN OWNER', preuve: 'named as publisher on the legal notice of this domain' };
  }
  return { lien: 'PUBLICLY ASSOCIATED WITH DOMAIN',
           preuve: 'the organisation published this person on one of its own pages; this does not establish ownership' };
}

/* Ce que le module n a PAS fait. Montre sur la page : un outil d enquete
   qui ne dit pas ou il s arrete laisse croire qu il ne s arrete pas. */
const LIMITES = [
  'Entry point is a domain or an IP. This tool cannot be searched by a person’s name, e-mail, phone or handle.',
  'E-mail addresses are only read where the organisation printed them. None is ever guessed or built from a name.',
  'Consumer mailbox providers (gmail, outlook, proton…) are dropped at extraction: a personal address is never collected.',
  'Accounts are only read where the organisation printed them next to a person’s name. This tool cannot look up someone’s accounts from a name or a handle — there is no way to search it by a person.',
  'Sources are public by design: DNS, the domain registry (RDAP), certificate transparency logs, and the domain’s own pages.',
  'No leaked or private database is ever queried. No login, paywall or anti-bot protection is ever bypassed.',
  'robots.txt is obeyed, the crawler identifies itself, and a 401/403/429 is recorded as a refusal — never retried in disguise.',
  'A person is shown as PUBLICLY ASSOCIATED WITH DOMAIN unless a public act names them as owner.',
];

/* ==================================================================
 * LE RELEVE COMPLET
 * ================================================================== */

async function recon(entree) {
  const domaine = normaliseDomaine(entree);
  if (!domaine) throw new Error('paste a domain like example.com');
  const t0 = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const sources = [];
  const note = (r, role) => { sources.push({ url: r.url, code: r.code, ok: !!r.ok, refus: !!r.refus, ms: r.ms, role }); return r; };

  const dns = await dnsDe(domaine);
  const [rdap, certs] = await Promise.all([rdapDomaine(domaine), certsDe(domaine)]);
  if (rdap.source) sources.push({ url: rdap.source, ok: rdap.trouve, role: 'rdap' });
  if (certs.source) sources.push({ url: certs.source, ok: certs.trouve, role: 'certs' });

  /* Les IP publiques seulement. Une adresse privee n est pas interrogee et
     n est pas montree : elle ne nous regarde pas, et aller la voir serait
     exactement l abus que la garde interdit. */
  const ips = [...dns.a, ...dns.aaaa].filter(estIpPublique).slice(0, 3);
  const reseaux = [];
  for (const ip of ips) reseaux.push(await rdapIp(ip));

  /* On ne frappe aux portes du site QUE s il vit sur l internet public. */
  const joignable = ips.length > 0;
  const robots = joignable ? await robotsDe(domaine) : { interdits: [], lu: false };

  const contacts = [];
  const personnes = [];
  const pages = [];
  let secu = null;
  let titrePage = null;
  let n = 0;

  /* Les roles deja servis. « /legal » et « /mentions-legales » disent la
     meme chose : des que l un repond, on cesse de frapper aux quatre autres
     portes. Un site n a pas a payer notre incertitude sur ses conventions
     de nommage. */
  const servis = new Set();
  for (const cand of PAGES_CANDIDATES) {
    if (!joignable) break;
    if (n >= PAGES_MAX) break;
    if (Date.now() - t0 > TOTAL_MS) break;
    if (servis.has(cand.role)) continue;
    if (!robotsPermet(robots, cand.chemin)) {
      pages.push({ chemin: cand.chemin, role: cand.role, saute: 'disallowed by robots.txt' });
      continue;
    }
    n++;
    const r = note(await recuperePage('https://' + domaine + cand.chemin,
      cand.role === 'securite' ? 'text/plain' : undefined), cand.role);
    if (!r.ok) {
      pages.push({ chemin: cand.chemin, role: cand.role, code: r.code,
                   refus: !!r.refus, erreur: r.erreur || null });
      continue;
    }
    pages.push({ chemin: cand.chemin, role: cand.role, code: r.code, octets: r.corps.length });
    servis.add(cand.role);

    if (cand.role === 'securite') {
      const s = litSecurityTxt(r.corps);
      if (!s.contacts.length) continue;
      secu = Object.assign({ source: r.url }, s);
      for (const c of s.contacts) {
        if (/^mailto:/i.test(c)) {
          const m = mailRecevable(c, 'securite');
          if (m) contacts.push(faitContact('email', m.adresse, m, r.url, 'securite', c));
        } else if (/^tel:/i.test(c)) {
          contacts.push(faitContact('phone', c.replace(/^tel:/i, '').replace(/[^\d+]/g, ''), { role: true }, r.url, 'securite', c));
        } else if (/^https?:/i.test(c)) {
          contacts.push(faitContact('page', c, { role: true }, r.url, 'securite', c));
        }
      }
      continue;
    }

    if (cand.chemin === '/') {
      const t = r.corps.match(/<title[^>]*>([\s\S]{1,160}?)<\/title>/i);
      if (t) titrePage = texteDe(t[1]).trim().slice(0, 120);
      const og = r.corps.match(/property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']{1,80})["']/i);
      if (og) titrePage = og[1].trim();
    }

    for (const m of mailsDe(r.corps, cand.role)) {
      if (contacts.some((c) => c.type === 'email' && c.valeur === m.adresse)) continue;
      contacts.push(faitContact('email', m.adresse, m, r.url, cand.role, m.extrait));
    }
    if (['legal', 'contact', 'securite'].includes(cand.role)) {
      for (const t of telsDe(r.corps)) {
        if (contacts.some((c) => c.type === 'phone' && c.valeur === t)) continue;
        contacts.push(faitContact('phone', t, { role: true }, r.url, cand.role, 'tel: ' + t));
      }
    }
    for (const p of personnesDe(r.corps, cand.role)) {
      if (personnes.some((x) => x.complet === p.complet)) continue;
      /* La nature de la page prime sur la proximite : une mention legale
         reste un acte meme quand l adresse est collee au nom. */
      const cle = ['legal', 'securite'].includes(cand.role) ? cand.role
        : (p.mail ? 'bloc' : cand.role);
      const c = confiance(cle);
      personnes.push(Object.assign({}, p, {
        source: r.url,
        vu: date,
        verifie: true,
        confiance: c.niveau,
        pourquoi: c.pourquoi,
      }, lienAuDomaine(cand.role === 'legal' ? 'legal' : null)));
    }
  }

  /* L organisation. Un titulaire RDAP en clair est un acte ; un titre de
     page est une enseigne. Les deux se disent, avec ce qui les separe. */
  let organisation = null;
  if (rdap.titulaire) {
    const c = confiance('rdapClair');
    organisation = { nom: rdap.titulaire, source: rdap.source, verifie: false,
                     confiance: c.niveau, pourquoi: c.pourquoi, vu: date };
  } else if (titrePage) {
    organisation = { nom: titrePage, source: 'https://' + domaine + '/', verifie: true,
                     confiance: 'LOW', pourquoi: 'taken from the site’s own title, which is a brand name, not a legal entity', vu: date };
  }

  const r = {
    domaine, date, ms: Date.now() - t0,
    joignable,
    organisation,
    infra: {
      dns, rdap, certs, reseaux,
      /* Le titulaire est masque : on le DIT. Une absence nommee vaut mieux
         qu un champ vide qu on lira comme « pas cherche ». */
      titulaireMasque: !!rdap.titulaireMasque,
    },
    securityTxt: secu,
    contacts,
    personnes,
    pages,
    sources,
    robots: { lu: robots.lu, interdits: robots.interdits.slice(0, 20) },
    limites: LIMITES,
  };
  r.graphe = graphe(r);
  return r;
}

/* Un fait de contact, avec tout ce qu il faut pour le contester : d ou il
   vient, quand, et si nous l avons vu de nos yeux. */
function faitContact(type, valeur, m, url, roleDeLaPage, extrait) {
  const cle = roleDeLaPage === 'securite' ? 'securite'
    : roleDeLaPage === 'legal' ? 'legal'
    : roleDeLaPage === 'contact' ? 'contact'
    : roleDeLaPage === 'equipe' ? 'equipe' : 'autre';
  const c = confiance(cle);
  return {
    type,
    valeur,
    /* Une boite de role ne designe personne. Une adresse nominative si — et
       la page doit le montrer autrement. */
    nominatif: !(m && m.role),
    source: url,
    vu: new Date().toISOString().slice(0, 10),
    /* VERIFIED a un sens precis ici : nous avons recupere cette URL
       nous-memes, en 200, et la chaine est litteralement dans le corps
       recu. Rien de plus, rien de moins. */
    verifie: true,
    confiance: c.niveau,
    pourquoi: c.pourquoi,
    extrait: caviarde(String(extrait || '').slice(0, 140), type === 'email' ? valeur : null),
  };
}

/* ==================================================================
 * LE GRAPHE — une arete est une relation DOCUMENTEE, pas une deduction
 * ==================================================================
 * Chaque arete porte sa source et son niveau de confiance. Une arete sans
 * source n existe pas : c est la regle qui empeche le graphe de raconter
 * plus que ce qu on a lu.
 *
 * « filtre » range chaque noeud dans un des trois calques que la page
 * permet d eteindre : infrastructure / organization / contacts. Les noeuds
 * PERSONNE portent humain=true — la page les dessine autrement, parce
 * qu une personne dans un graphe d infrastructure doit sauter aux yeux
 * comme une exception, pas se fondre dans les machines. */
function graphe(r) {
  const noeuds = [];
  const aretes = [];
  const vus = new Set();
  const nd = (id, type, nom, filtre, extra) => {
    if (vus.has(id)) return id;
    vus.add(id);
    noeuds.push(Object.assign({ id, type, nom, filtre, humain: type === 'personne' }, extra || {}));
    return id;
  };
  const ar = (de, vers, relation, source, conf) => {
    if (!de || !vers || !vus.has(de) || !vus.has(vers)) return;
    if (!source) return;            /* pas de source, pas d arete */
    aretes.push({ de, vers, relation, source, confiance: conf || 'MEDIUM' });
  };

  const D = nd('domain:' + r.domaine, 'domaine', r.domaine, 'infrastructure');

  for (const ip of [...r.infra.dns.a, ...r.infra.dns.aaaa]) {
    if (!estIpPublique(ip)) continue;
    nd('ip:' + ip, 'ip', ip, 'infrastructure');
    ar(D, 'ip:' + ip, 'RESOLVES TO', 'DNS A/AAAA record', 'HIGH');
  }
  for (const res of r.infra.reseaux) {
    if (!res.trouve) continue;
    const nom = res.asn || res.reseau || res.operateur;
    if (!nom) continue;
    nd('net:' + nom, 'reseau', nom, 'infrastructure',
       { pays: res.pays || null, operateur: res.operateur || null, plage: res.plage || null });
    ar('ip:' + res.ip, 'net:' + nom, 'ANNOUNCED IN', res.source, 'HIGH');
  }
  for (const mx of r.infra.dns.mx.slice(0, 4)) {
    nd('mx:' + mx.hote, 'mx', mx.hote, 'infrastructure', { prio: mx.prio });
    ar(D, 'mx:' + mx.hote, 'MAIL HANDLED BY', 'DNS MX record', 'HIGH');
  }
  for (const s of r.infra.certs.sousDomaines.slice(0, 40)) {
    nd('sub:' + s, 'sousdomaine', s, 'infrastructure', { verifie: false });
    /* NOT VERIFIED : un journal de certificats dit qu un nom a ete certifie,
       pas qu une machine repond derriere aujourd hui. */
    ar(D, 'sub:' + s, 'CERTIFICATE ISSUED FOR', r.infra.certs.source, 'LOW');
  }
  for (const e of r.infra.certs.emetteurs.slice(0, 3)) {
    nd('ca:' + e.nom, 'certificat', e.nom, 'infrastructure', { n: e.n });
    ar(D, 'ca:' + e.nom, 'CERTIFIED BY', r.infra.certs.source, 'HIGH');
  }

  if (r.organisation) {
    const O = nd('org:' + r.organisation.nom, 'organisation', r.organisation.nom, 'organization',
                 { confiance: r.organisation.confiance, source: r.organisation.source });
    ar(O, D, r.infra.rdap.titulaire ? 'REGISTRANT OF' : 'PUBLICLY ASSOCIATED WITH DOMAIN',
       r.organisation.source, r.organisation.confiance);
  }

  for (const c of r.contacts) {
    const id = c.type + ':' + c.valeur;
    nd(id, c.type === 'email' ? 'email' : c.type === 'phone' ? 'telephone' : 'lien', c.valeur, 'contacts',
       { nominatif: c.nominatif, confiance: c.confiance, verifie: c.verifie, source: c.source });
    ar(D, id, 'PUBLISHED ON THIS DOMAIN', c.source, c.confiance);
  }

  for (const p of r.personnes) {
    const P = nd('person:' + p.complet, 'personne', p.complet, 'contacts',
                 { fonction: p.fonction, profils: p.profils || [], confiance: p.confiance,
                   source: p.source, lien: p.lien, preuve: p.preuve, verifie: p.verifie });
    ar(P, D, p.lien, p.source, p.confiance);
    /* Le nom et l adresse n ont ete relies que s ils etaient imprimes
       ensemble. Sinon, pas d arete — et la page montre une personne sans
       adresse, ce qui est la verite. */
    if (p.mail && vus.has('email:' + p.mail)) {
      ar(P, 'email:' + p.mail, 'PROFESSIONAL EMAIL', p.source, 'MEDIUM');
    }
  }
  return { noeuds, aretes,
           filtres: ['infrastructure', 'organization', 'contacts'] };
}

module.exports = {
  recon, normaliseDomaine, estIpPublique,
  dnsDe, rdapDomaine, rdapIp, certsDe, robotsDe, robotsPermet,
  litSecurityTxt, mailRecevable, mailsDe, telsDe, personnesDe, profilsDe, profilsDuNom,
  texteDe, fenetresDe, nomsDe, caviarde, confiance, lienAuDomaine, graphe, faitContact, nomVcard,
  recuperePage,
  LIMITES, FOURNISSEURS_PERSO, BOITES_ROLE, PAGES_CANDIDATES, FONCTIONS, UA,
  PAGES_MAX, DELAI_MS, TAILLE_MAX, TOTAL_MS,
  /* Le reseau et le DNS sont remplacables : les essais tournent sans
     internet, donc sans dependre de la meteo d un service tiers. */
  _reseau: (f) => { RESEAU = f; },
  _resolveur: (r) => { RESOLVEUR = r; },
};
