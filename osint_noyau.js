'use strict';
/* ==================================================================
 * SWOGE OSINT — LE NOYAU
 * ==================================================================
 *
 * `osint.js` marchait, mais c etait un tuyau : une fonction par source,
 * chacune rendant sa propre forme, et un peintre qui devait les connaitre
 * toutes. Ajouter une source voulait dire toucher au module, au peintre, a
 * l export et au graphe. Rien ne pouvait etre correle parce que rien
 * n avait de forme commune.
 *
 * Ce fichier pose la forme commune. Tout le reste — correlation,
 * doublons, contradictions, score, graphe, export, file de taches — en
 * decoule au lieu d etre reecrit par source.
 *
 * TROIS OBJETS, ET RIEN D AUTRE :
 *
 *   ENTITE   ce sur quoi on enquete. { type, valeur }. Normalisee une fois,
 *            a l entree, pour que « HTTPS://WWW.Acme.IO/x » et « acme.io »
 *            soient le meme noeud et pas deux.
 *
 *   FAIT     ce qu une source affirme. { sujet, predicat, objet, source,
 *            vu, confiance, connecteur }. C est un triplet : il se
 *            deduplique, se corrobore, se contredit, se dessine et
 *            s exporte sans que personne ecrive de code par source.
 *
 *   CONNECTEUR  ce qui produit des faits. Il declare ce qu il CONSOMME et
 *            ce qu il PRODUIT, son hote, son debit, sa cle. Le planificateur
 *            n a pas besoin d en savoir plus pour l appeler.
 *
 * ---- LA REGLE QUI SURVIT AU REFACTORING ----
 *
 * Une entite est soit une GRAINE — on la tape, l outil se deploie a partir
 * d elle — soit un SELECTEUR : elle apparait dans les resultats, et on peut
 * verifier sur elle des faits BORNES. Un domaine, une IP, une URL, une
 * adresse de chaine sont des graines : ce sont des machines et des comptes.
 *
 * Un email, un pseudo, un telephone sont des SELECTEURS. On peut demander
 * « cet identifiant apparait-il dans une fuite connue » ou « ce pseudo
 * existe-t-il sur cette plateforme » — des questions fermees, a reponse
 * oui/non, avec leur source. On ne peut pas demander « qui est-ce ».
 *
 * Un NOM n est ni l un ni l autre, et la raison est technique avant d etre
 * autre chose : avec les sources legitimes, une recherche par nom ne
 * renvoie rien. Ce qui la fait marcher ailleurs — courtiers de donnees,
 * bases fuitees — est exactement ce que ce projet s interdit. Un champ qui
 * ne trouve jamais rien est pire qu un champ absent : il laisse croire que
 * la personne est introuvable, au lieu de dire qu on n a pas cherche.
 */

const crypto = require('crypto');

/* ==================================================================
 * LES ENTITES
 * ================================================================== */

const osintD = require('./osint');

/* Un numero se reduit a ses chiffres et a son indicatif : « +33 6 12 34 56 78 »,
   « 0033612345678 » et « +33612345678 » sont le meme abonne. */
function normaliseTelephone(v) {
  let s = String(v == null ? '' : v).trim().replace(/[\s.\-() ]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!/^\+?\d{6,15}$/.test(s)) return null;
  return s.startsWith('+') ? s : null;   /* sans indicatif, on ne sait pas de quel pays il parle */
}

function normaliseEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  const m = s.match(/^([a-z0-9._%+-]{1,64})@([a-z0-9.-]+\.[a-z]{2,24})$/);
  return m ? s : null;
}

function normalisePseudo(v) {
  const s = String(v == null ? '' : v).trim().replace(/^@/, '');
  return /^[A-Za-z0-9._-]{2,40}$/.test(s) ? s : null;
}

function normaliseUrl(v) {
  const s = String(v == null ? '' : v).trim();
  /* « acme.io » est un DOMAINE, pas une URL. Sans cette ligne, l ordre de
     detection donnait une URL pour toute saisie, et le connecteur DNS
     n etait jamais appele : l URL doit porter un schema ou un chemin pour
     en etre une. */
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !s.includes('/')) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!osintD.normaliseDomaine(u.hostname)) return null;
    return u.origin + (u.pathname === '/' ? '' : u.pathname);
  } catch (e) { return null; }
}

function normaliseAsn(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^(?:AS)?(\d{1,10})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 4294967295 ? 'AS' + n : null;
}
function normaliseCve(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return /^CVE-\d{4}-\d{4,7}$/.test(s) ? s : null;
}

const ENTITES = {
  domaine: { graine: true, normalise: (v) => osintD.normaliseDomaine(v),
             quoi: 'a domain name' },
  ip: { graine: true, normalise: (v) => (osintD.estIpPublique(String(v).trim()) ? String(v).trim() : null),
        quoi: 'a public IP address' },
  url: { graine: true, normalise: normaliseUrl, quoi: 'a public web address' },
  adresse: { graine: true, normalise: (v) => osintD.normaliseAdresse(v),
             quoi: 'an on-chain address' },

  /* Les selecteurs. Ils entrent, mais ils ne se deploient pas : voir
     `CONNECTEURS` — aucun connecteur ne produit d entites a partir d eux,
     il ne produit que des FAITS fermes. */
  /* L email est une GRAINE : son domaine de messagerie est un fait public
     et evident (« jane@acme.io » -> acme.io), et enqueter sur l organisation
     derriere une adresse est legitime. Ce n est PAS profiler la personne :
     on investigue acme.io, que n importe qui pourrait taper, plus ce que
     l adresse elle-meme expose (fuites, Gravatar public). Le pivot vers un
     fournisseur grand public (gmail...) est ecarte par le connecteur. */
  email: { graine: true, normalise: normaliseEmail,
           quoi: 'an e-mail address (pivots to its domain, plus its own exposure)' },
  pseudo: { graine: false, selecteur: true, normalise: normalisePseudo,
            quoi: 'a username (account existence only)' },
  telephone: { graine: false, selecteur: true, normalise: normaliseTelephone,
               quoi: 'a phone number in +CC form (numbering plan only)' },

  /* Un numero de systeme autonome — l operateur reseau. Public. */
  asn: { graine: true, normalise: normaliseAsn, quoi: 'an autonomous system number (AS15169)' },
  /* Une reference de vulnerabilite publique. */
  cve: { graine: true, normalise: normaliseCve, quoi: 'a public vulnerability (CVE-2021-44228)' },

  /* ---- LE NOM EST UNE GRAINE, MAIS QUI NE REND QUE DES CANDIDATS ----
     Un nom ne designe PAS une personne unique : plusieurs gens le portent.
     Le connecteur d identite ne rend donc jamais « la personne John Doe » —
     il rend des CANDIDATS publics separes (une entite Wikidata, un compte
     GitHub), chacun distinct, marque non verifie, jamais fusionne avec un
     autre. Porter le meme nom n est pas etre la meme personne, et le code le
     tient : chaque candidat est une entite a part. */
  personne: { graine: true, normalise: (v) => (String(v || '').trim().replace(/\s+/g, ' ').slice(0, 120) || null),
              quoi: 'a person name — returns SEPARATE public candidates, never a single identity' },

  /* Produites par les connecteurs, jamais tapees. */
  organisation: { graine: false, normalise: (v) => (String(v || '').trim().slice(0, 160) || null),
                  quoi: 'an organisation' },
  /* Un candidat public rattache a un nom : distinct, jamais fusionne. */
  candidat: { graine: false, normalise: (v) => (String(v || '').trim().slice(0, 160) || null),
              quoi: 'a public candidate matching a name (unconfirmed)' },
  jeton: { graine: false, normalise: (v) => osintD.normaliseAdresse(v), quoi: 'a token' },
  reseau: { graine: false, normalise: (v) => (String(v || '').trim().slice(0, 80) || null), quoi: 'a network / ASN' },
  vulnerabilite: { graine: false, normalise: (v) => (String(v || '').trim().slice(0, 40) || null), quoi: 'a vulnerability' },
};

/* Ce qu on refuse en entree, avec la raison en clair. Le message est montre
   tel quel : un refus qui n explique pas se lit comme une panne. */
const REFUS_GRAINE = {
  pseudo: 'A username is a selector, not a seed: you can check where an account with that name exists, '
        + 'not who owns it.',
  telephone: 'A phone number is a selector, not a seed: you can check its numbering plan, nothing more.',
};

/* Reconnait le type d une entree sans qu on ait a le declarer. L ordre
   compte : une adresse de chaine ressemble a un pseudo, un domaine
   ressemble a un pseudo. Le plus specifique gagne. */
const ORDRE_DETECTION = ['cve', 'asn', 'adresse', 'email', 'ip', 'url', 'domaine', 'telephone', 'pseudo'];
function detecte(brut) {
  const s = String(brut == null ? '' : brut).trim();
  if (!s) return null;
  for (const type of ORDRE_DETECTION) {
    const v = ENTITES[type].normalise(s);
    if (v) return { type, valeur: v };
  }
  /* Dernier recours : un texte de PLUSIEURS mots de lettres, sans @ ni
     chiffres, est un NOM. « Jean Dupont » -> personne. Un seul mot est
     ambigu (prenom ou pseudo) : il est deja parti en pseudo plus haut, on
     ne le reprend pas ici. */
  if (/\s/.test(s) && /^[\p{L}][\p{L}'’.\- ]{1,80}$/u.test(s) && s.split(/\s+/).length >= 2 && s.split(/\s+/).length <= 5) {
    const v = ENTITES.personne.normalise(s);
    if (v) return { type: 'personne', valeur: v };
  }
  return null;
}

function entite(type, valeur) {
  const d = ENTITES[type];
  if (!d) return null;
  const v = d.normalise(valeur);
  return v === null || v === undefined ? null : { type, valeur: v };
}
const cleEntite = (e) => e.type + ':' + e.valeur;

/* ==================================================================
 * LES FAITS
 * ==================================================================
 * Un triplet sujet-predicat-objet, plus d ou il vient. C est tout, et
 * c est ce qui permet a la correlation, aux doublons, aux contradictions,
 * au graphe et a l export d etre ecrits UNE fois au lieu d une fois par
 * source. */

/* Les predicats « uniques » : un sujet ne peut en avoir qu un objet. Deux
 * reponses differentes sur un predicat unique, c est une CONTRADICTION —
 * et une contradiction est une information, pas une panne. Un domaine qui
 * resout vers trois IP n a rien d anormal ; un domaine dont deux sources
 * donnent deux registraires differents, si. */
const PREDICATS_UNIQUES = new Set([
  'REGISTERED ON', 'EXPIRES ON', 'REGISTRAR IS', 'REGISTRANT IS',
  'MAIL HOSTED BY', 'COUNTRY IS', 'NUMBERING PLAN',
]);

/* Le score. Les trois niveaux restent — ils sont montres aux gens — mais
 * ils portent maintenant un nombre, parce qu un tri, un seuil et une
 * moyenne ne se font pas sur des mots.
 *
 * Le nombre vient de TROIS choses, et d aucune impression :
 *   la nature de la source (un acte vaut plus qu un index tiers),
 *   le fait qu on ait VU la donnee soi-meme,
 *   et le nombre de sources INDEPENDANTES qui disent la meme chose. */
const SOCLE = { HIGH: 80, MEDIUM: 55, LOW: 30 };
function score(fait) {
  let n = SOCLE[fait.confiance] || SOCLE.LOW;
  if (fait.verifie) n += 8;
  /* La corroboration : chaque source independante de plus ajoute, en
     rendements decroissants — trois sources ne valent pas trois fois une. */
  const k = Math.max(1, (fait.sources || []).length);
  n += Math.round(12 * (1 - 1 / k));
  return Math.max(1, Math.min(99, n));
}
function niveau(n) { return n >= 75 ? 'HIGH' : n >= 50 ? 'MEDIUM' : 'LOW'; }

function fait(o) {
  const sujet = o.sujet, objet = o.objet;
  if (!sujet || !sujet.type || sujet.valeur == null) return null;
  const f = {
    sujet,
    predicat: String(o.predicat || '').toUpperCase(),
    objet: objet && objet.valeur != null ? objet : null,
    /* `valeur` porte ce qui n est pas une entite : une date, un drapeau,
       un texte. Un fait n a pas besoin d inventer une entite pour dire
       qu un domaine a ete cree en 2014. */
    valeur: o.valeur === undefined ? null : o.valeur,
    connecteur: o.connecteur || null,
    sources: o.source ? [o.source] : (o.sources || []),
    vu: o.vu || new Date().toISOString().slice(0, 10),
    verifie: !!o.verifie,
    confiance: SOCLE[o.confiance] ? o.confiance : 'LOW',
    pourquoi: o.pourquoi || null,
    extrait: o.extrait ? String(o.extrait).slice(0, 200) : null,
  };
  f.score = score(f);
  f.confiance = niveau(f.score);
  return f;
}

/* L empreinte d un fait : ce qui fait que deux faits sont LE MEME fait.
   La source n en fait pas partie — c est tout l interet : deux sources qui
   disent la meme chose se fondent en un fait corrobore, au lieu de
   remplir la page deux fois. */
function empreinte(f) {
  return crypto.createHash('sha1')
    .update([cleEntite(f.sujet), f.predicat,
             f.objet ? cleEntite(f.objet) : '', String(f.valeur == null ? '' : f.valeur)].join('\u0000'))
    .digest('hex').slice(0, 16);
}

/* ==================================================================
 * LA CORRELATION — doublons, corroboration, contradictions
 * ================================================================== */
function correle(faits) {
  const parEmpreinte = new Map();
  for (const f of faits) {
    if (!f) continue;
    const e = empreinte(f);
    const d = parEmpreinte.get(e);
    if (!d) { parEmpreinte.set(e, Object.assign({ empreinte: e }, f)); continue; }
    /* Meme fait, autre source : on fusionne. La source la plus forte
       impose son socle, et la corroboration remonte le score. */
    for (const s of f.sources) if (!d.sources.includes(s)) d.sources.push(s);
    if (SOCLE[f.confiance] > SOCLE[d.confiance]) { d.confiance = f.confiance; d.pourquoi = f.pourquoi; }
    d.verifie = d.verifie || f.verifie;
    if (!d.extrait && f.extrait) d.extrait = f.extrait;
    d.connecteurs = [...new Set([...(d.connecteurs || [d.connecteur]), f.connecteur].filter(Boolean))];
    d.score = score(d);
    d.confiance = niveau(d.score);
  }
  const uniques = [...parEmpreinte.values()];

  /* Les contradictions. On ne les tranche PAS : on les montre. Choisir a
     la place de l enqueteur, c est exactement ce qu un outil d enquete ne
     doit pas faire — et la source qui a tort est souvent l information. */
  const parCle = new Map();
  for (const f of uniques) {
    if (!PREDICATS_UNIQUES.has(f.predicat)) continue;
    const c = cleEntite(f.sujet) + '|' + f.predicat;
    if (!parCle.has(c)) parCle.set(c, []);
    parCle.get(c).push(f);
  }
  const contradictions = [];
  for (const [c, liste] of parCle) {
    if (liste.length < 2) continue;
    for (const f of liste) f.conteste = true;
    contradictions.push({
      sujet: liste[0].sujet, predicat: liste[0].predicat,
      versions: liste.map((f) => ({
        valeur: f.objet ? f.objet.valeur : f.valeur,
        sources: f.sources, confiance: f.confiance, score: f.score,
      })).sort((a, b) => b.score - a.score),
      note: 'Sources disagree. Nothing was picked for you — the one that is wrong is often the finding.',
    });
  }
  uniques.sort((a, b) => b.score - a.score);
  return { faits: uniques, contradictions,
           doublonsFondus: faits.filter(Boolean).length - uniques.length };
}

/* ==================================================================
 * LES CONNECTEURS
 * ==================================================================
 * Un connecteur declare ce qu il consomme, ce qu il produit, l hote qu il
 * interroge, son debit et la cle dont il a besoin. Le planificateur n a
 * pas besoin d en savoir plus : ajouter une source ne touche ni au
 * planificateur, ni au peintre, ni a l export.
 *
 * `produit` sert aussi de garde : un connecteur qui consomme un SELECTEUR
 * ne peut produire aucune entite, seulement des faits. C est ce qui
 * empeche un email d ouvrir une enquete par ricochet. La declaration est
 * verifiee au chargement, pas laissee a la bonne volonte. */

const REGISTRE = new Map();

function declare(c) {
  for (const champ of ['nom', 'consomme', 'lance']) {
    if (!c[champ]) throw new Error('connecteur sans ' + champ);
  }
  if (REGISTRE.has(c.nom)) throw new Error('connecteur en double : ' + c.nom);
  for (const t of c.consomme) if (!ENTITES[t]) throw new Error(c.nom + ' consomme un type inconnu : ' + t);
  for (const t of (c.produit || [])) if (!ENTITES[t]) throw new Error(c.nom + ' produit un type inconnu : ' + t);
  /* LA GARDE STRUCTURELLE : un connecteur branche sur un selecteur ne
     rend aucune entite. Sans elle, il suffirait d un connecteur distrait
     pour qu un email se deploie en enquete — la regle serait dans les
     commentaires et nulle part dans le code. */
  const surSelecteur = c.consomme.some((t) => ENTITES[t].selecteur);
  if (surSelecteur && (c.produit || []).length) {
    throw new Error(c.nom + ' consomme un selecteur : il ne peut produire aucune entite, seulement des faits');
  }
  REGISTRE.set(c.nom, Object.assign({
    produit: [], hote: null, parMinute: 60, ttl: 5 * 60 * 1000, cle: null,
    cout: 'free', delaiMs: 8000, mode: 'passif',
  }, c));
  return REGISTRE.get(c.nom);
}
const connecteurs = () => [...REGISTRE.values()];
function connecteursPour(type) { return connecteurs().filter((c) => c.consomme.includes(type)); }
/* Un connecteur qui a besoin d une cle absente n est pas une panne : il
   est ETEINT, et le rapport le dit. Un vide silencieux se lirait comme
   « rien trouve » alors qu on n a pas cherche. */
function actif(c, env) {
  if (!c.cle) return true;
  return !!(env || process.env)[c.cle];
}

/* ==================================================================
 * LE DEBIT PAR HOTE — un seau a jetons
 * ==================================================================
 * Le debit par IP visiteur existait deja ; il protege NOTRE serveur. Celui
 * -ci protege les sites qu on interroge, ce qui n est pas la meme chose et
 * n etait nulle part : dix visiteurs sur dix domaines differents tapaient
 * crt.sh dix fois en une seconde. */
const SEAUX = new Map();
function attendSonTour(hote, parMinute) {
  if (!hote) return Promise.resolve(0);
  const now = Date.now();
  const intervalle = 60000 / Math.max(1, parMinute);
  const libre = Math.max(now, SEAUX.get(hote) || 0);
  SEAUX.set(hote, libre + intervalle);
  const attente = libre - now;
  return attente <= 0 ? Promise.resolve(0)
    : new Promise((r) => setTimeout(() => r(attente), attente));
}

/* ==================================================================
 * LE CACHE
 * ==================================================================
 * Par (connecteur, entite), pas par requete entiere : deux enquetes sur
 * deux domaines du meme hebergeur partagent la reponse RDAP de l IP. Le
 * cache d avant, pose sur le domaine entier, ne partageait rien. */
const CACHE = new Map();
function cleCache(c, e) { return c.nom + '|' + cleEntite(e); }
function duCache(c, e) {
  const v = CACHE.get(cleCache(c, e));
  if (!v) return null;
  if (Date.now() - v.t > c.ttl) { CACHE.delete(cleCache(c, e)); return null; }
  return v;
}
function auCache(c, e, r) {
  CACHE.set(cleCache(c, e), { t: Date.now(), r });
  if (CACHE.size > 2000) {
    const now = Date.now();
    for (const [k, v] of CACHE) if (now - v.t > 30 * 60 * 1000) CACHE.delete(k);
  }
}
function videCache() { CACHE.clear(); SEAUX.clear(); }

/* ==================================================================
 * LE PLANIFICATEUR — file, parallelisme, budget, journal
 * ==================================================================
 * Il part d une graine, appelle tous les connecteurs qui savent la lire,
 * recolte leurs faits et leurs entites, et recommence sur les entites
 * nouvelles jusqu a la profondeur demandee.
 *
 * Quatre gardes, et chacune a sa raison :
 *   - PARALLELISME borne : sinon une enquete sur un domaine a deux cents
 *     sous-domaines ouvre deux cents connexions d un coup ;
 *   - BUDGET DE TEMPS global : une enquete doit rendre quelque chose meme
 *     si une source met trois minutes a ne pas repondre ;
 *   - DELAI par connecteur : un connecteur lent ne retient pas les autres ;
 *   - ERREUR ISOLEE : un connecteur qui tombe est un FAIT du rapport, pas
 *     la fin de l enquete. C est la difference entre un outil et un essai. */

const PARALLELE = Math.max(1, Number(process.env.OSINT_PARALLELE || 6));
const BUDGET_MS = Math.max(3000, Number(process.env.OSINT_BUDGET_MS || 25000));
const PROFONDEUR = Math.max(1, Number(process.env.OSINT_PROFONDEUR || 2));
const ENTITES_MAX = Math.max(10, Number(process.env.OSINT_ENTITES_MAX || 300));

async function enquete(brut, o) {
  const opt = Object.assign({ profondeur: PROFONDEUR, parallele: PARALLELE,
                              budgetMs: BUDGET_MS, env: process.env, seulement: null,
                              /* Mode passif : on ne touche PAS la cible. Elle ne voit
                                 jamais nos requetes. Standard en reconnaissance, et il
                                 faut pouvoir dire a quelqu un si sa recherche laisse une
                                 trace horodatee dans les journaux d en face. */
                              passifSeulement: false }, o || {});
  const t0 = Date.now();

  /* L entree. Un type devine, puis la garde graine/selecteur — et le
     refus DIT pourquoi, avec ce qu il faut taper a la place. */
  const g = typeof brut === 'object' && brut && brut.type ? entite(brut.type, brut.valeur) : detecte(brut);
  if (!g) {
    const e = new Error('Not a recognised target. Paste a domain, an IP, a website address, '
                      + 'an on-chain address, or an e-mail / username to check its exposure.');
    e.code = 'entree';
    throw e;
  }
  const d = ENTITES[g.type];
  if (!d.graine && !d.selecteur) {
    const e = new Error(REFUS_GRAINE[g.type] || 'This is not a starting point.');
    e.code = 'graine';
    throw e;
  }

  const vues = new Map([[cleEntite(g), { entite: g, profondeur: 0 }]]);
  const faits = [];
  const journal = [];
  const eteints = [];
  const ecartes = [];
  let file = [{ entite: g, profondeur: 0 }];

  for (let p = 0; p <= opt.profondeur && file.length; p++) {
    const suivante = [];
    /* Chaque (entite, connecteur) est une tache. On les fabrique toutes,
       puis on les fait passer PARALLELE par PARALLELE. */
    const taches = [];
    for (const { entite: e, profondeur } of file) {
      for (const c of connecteursPour(e.type)) {
        if (opt.seulement && !opt.seulement.includes(c.nom)) continue;
        if (opt.passifSeulement && mode(c) === 'actif') {
          if (!ecartes.some((x) => x.nom === c.nom)) {
            ecartes.push({ nom: c.nom, pourquoi: 'active: it would touch the target itself' });
          }
          continue;
        }
        if (!actif(c, opt.env)) {
          if (!eteints.some((x) => x.nom === c.nom)) {
            eteints.push({ nom: c.nom, pourquoi: 'needs ' + c.cle, cout: c.cout });
          }
          continue;
        }
        taches.push({ c, e, profondeur });
      }
    }
    await enFile(taches, opt.parallele, async ({ c, e, profondeur }) => {
      if (Date.now() - t0 > opt.budgetMs) { journal.push({ c: c.nom, e: cleEntite(e), etat: 'budget' }); return; }
      const t1 = Date.now();
      const garde = duCache(c, e);
      let r = garde ? garde.r : null;
      let dHote = 0;
      if (!garde) {
        try {
          dHote = await attendSonTour(c.hote, c.parMinute);
          r = await Promise.race([
            c.lance(e, { env: opt.env, entite, fait, budget: opt.budgetMs - (Date.now() - t0) }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after ' + c.delaiMs + 'ms')), c.delaiMs)),
          ]);
          auCache(c, e, r);
        } catch (err) {
          /* L erreur est un FAIT du rapport : une source muette n est pas
             une source qui dit « rien ». */
          journal.push({ c: c.nom, e: cleEntite(e), etat: 'erreur',
                         ms: Date.now() - t1, message: String(err && err.message || err).slice(0, 160) });
          return;
        }
      }
      journal.push({ c: c.nom, e: cleEntite(e), etat: garde ? 'cache' : 'ok',
                     ms: Date.now() - t1, attenteHote: dHote || 0,
                     faits: (r && r.faits ? r.faits.length : 0) });
      /* L ordre compte : `fait()` pose `connecteur: null` quand le
         connecteur ne s est pas nomme lui-meme, et un Object.assign qui
         met le defaut EN PREMIER se fait ecraser par ce null. Le nom du
         connecteur vient donc apres, et seulement s il manque. */
      for (const f of (r && r.faits) || []) {
        if (f) faits.push(Object.assign({}, f, { connecteur: f.connecteur || c.nom }));
      }
      for (const ne of (r && r.entites) || []) {
        if (!ne) continue;
        const k = cleEntite(ne);
        if (vues.has(k) || vues.size >= ENTITES_MAX) continue;
        vues.set(k, { entite: ne, profondeur: profondeur + 1 });
        suivante.push({ entite: ne, profondeur: profondeur + 1 });
      }
    });
    file = suivante;
  }

  const c = correle(faits);
  return {
    cible: g,
    date: new Date().toISOString().slice(0, 10),
    ms: Date.now() - t0,
    faits: c.faits,
    contradictions: c.contradictions,
    doublonsFondus: c.doublonsFondus,
    entites: [...vues.values()].map((x) => Object.assign({}, x.entite, { profondeur: x.profondeur })),
    /* Le journal EST le monitoring : combien de temps chaque source a pris,
       laquelle a servi du cache, laquelle est tombee et pourquoi. */
    journal,
    connecteursEteints: eteints,
    connecteursEcartes: ecartes,
    /* Ce que le croisement des faits DIT — la couche qui separe une liste
       de faits d un resultat d enquete. Chaque constat porte ses pieces. */
    constats: constats(c.faits),
    /* Est-ce que cette enquete a laisse une trace chez la cible. */
    passif: !c.faits.some((f) => {
      const cc = REGISTRE.get(f.connecteur);
      return cc && mode(cc) === 'actif';
    }),
    budgetAtteint: Date.now() - t0 >= opt.budgetMs,
    /* Les limites voyagent dans CHAQUE rapport, pas seulement dans le PDF :
       un rapport JSON qui circule sans ses bords finit lu comme une preuve.
       LIMITES_RAPPORT est defini plus bas — une const lue a l appel, pas au
       chargement, donc l ordre ne pose pas de probleme. */
    limites: LIMITES_RAPPORT,
  };
}

/* Une file a largeur bornee. Pas de dependance : une boucle de `n`
   ouvriers qui se servent dans le meme tableau. */
async function enFile(taches, largeur, travail) {
  let i = 0;
  const ouvrier = async () => { while (i < taches.length) { const t = taches[i++]; await travail(t); } };
  await Promise.all(Array.from({ length: Math.min(largeur, Math.max(1, taches.length)) }, ouvrier));
}

/* ==================================================================
 * LE GRAPHE — derive des faits, plus ecrit a la main
 * ==================================================================
 * Avant, le graphe etait construit source par source : chaque nouvelle
 * source demandait son bout de code dans le peintre. Maintenant il tombe
 * des faits : un fait dont l objet est une entite EST une arete, un fait
 * dont l objet est une valeur est un attribut du noeud. Ajouter une source
 * ne touche plus au graphe. */

const CALQUE = {
  domaine: 'infrastructure', ip: 'infrastructure', reseau: 'infrastructure', url: 'infrastructure',
  vulnerabilite: 'infrastructure',
  organisation: 'organization',
  /* Un candidat public rattache a un nom est une personne (non confirmee) :
     il vit dans le meme calque que les contacts, et se dessine en humain. */
  personne: 'contacts', candidat: 'contacts', email: 'contacts', telephone: 'contacts', pseudo: 'contacts',
  adresse: 'chain', jeton: 'chain',
};

function graphe(rapport) {
  const noeuds = new Map();
  const nd = (e) => {
    const k = cleEntite(e);
    if (!noeuds.has(k)) {
      noeuds.set(k, { id: k, type: e.type, nom: String(e.valeur),
                      filtre: CALQUE[e.type] || 'infrastructure',
                      /* Une personne — ou un candidat public rattache a un
                         nom — se dessine autrement qu une machine. C est la
                         seule propriete que le peintre lit pour changer de
                         forme, et elle est calculee ici. */
                      humain: e.type === 'personne' || e.type === 'candidat',
                      attributs: [] });
    }
    return noeuds.get(k);
  };
  nd(rapport.cible).cible = true;
  const aretes = [];
  for (const f of rapport.faits) {
    const s = nd(f.sujet);
    if (f.objet) {
      nd(f.objet);
      aretes.push({ de: cleEntite(f.sujet), vers: cleEntite(f.objet), relation: f.predicat,
                    source: f.sources[0] || null, sources: f.sources,
                    confiance: f.confiance, score: f.score, conteste: !!f.conteste });
    } else if (f.valeur !== null) {
      s.attributs.push({ quoi: f.predicat, valeur: f.valeur, confiance: f.confiance,
                         sources: f.sources, conteste: !!f.conteste });
    }
  }
  /* Une arete sans source n existe pas : la regle tenait deja, elle est
     maintenant impossible a violer puisqu un fait sans source ne passe pas. */
  return { noeuds: [...noeuds.values()], aretes: aretes.filter((a) => a.source),
           filtres: ['infrastructure', 'organization', 'contacts', 'chain'] };
}

/* ==================================================================
 * LES EXPORTS
 * ==================================================================
 * Un rapport qu on ne peut pas sortir de l onglet ne sert a rien dans une
 * enquete : elle se poursuit dans un tableur, un ticket, un dossier. */

function versJSON(rapport) { return JSON.stringify(rapport, null, 1); }

/* CSV : une ligne par fait, avec ses sources. Le separateur est la
   virgule et TOUT est echappe — une source est une URL, et une URL
   contient des virgules. */
function versCSV(rapport) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const lignes = [['subject_type', 'subject', 'predicate', 'object_type', 'object', 'value',
                   'confidence', 'score', 'verified', 'disputed', 'first_seen', 'connector', 'sources'].join(',')];
  for (const f of rapport.faits) {
    lignes.push([q(f.sujet.type), q(f.sujet.valeur), q(f.predicat),
                 q(f.objet ? f.objet.type : ''), q(f.objet ? f.objet.valeur : ''),
                 q(f.valeur), q(f.confiance), f.score, f.verifie ? 'yes' : 'no',
                 f.conteste ? 'yes' : 'no', q(f.vu), q(f.connecteur), q((f.sources || []).join(' | '))].join(','));
  }
  return lignes.join('\r\n') + '\r\n';
}

module.exports = {
  ENTITES, REFUS_GRAINE, ORDRE_DETECTION, detecte, entite, cleEntite,
  normaliseEmail, normalisePseudo, normaliseTelephone, normaliseUrl,
  fait, empreinte, correle, score, niveau, SOCLE, PREDICATS_UNIQUES,
  declare, connecteurs, connecteursPour, actif, REGISTRE,
  attendSonTour, duCache, auCache, videCache, CACHE,
  enquete, enFile, graphe, versJSON, versCSV, CALQUE,
  PARALLELE, BUDGET_MS, PROFONDEUR, ENTITES_MAX,
};

/* ==================================================================
 * PASSIF OU ACTIF — repris de BBOT, et ca manquait
 * ==================================================================
 * Un connecteur PASSIF lit des index tiers : DNS, registre, journaux de
 * certificats. La cible ne nous voit jamais. Un connecteur ACTIF frappe a
 * sa porte : elle a nos requetes dans ses journaux, avec notre horodatage.
 *
 * La distinction est standard en reconnaissance professionnelle et elle
 * n existait nulle part ici. Elle compte pour deux raisons : on n enquete
 * pas toujours sur quelqu un qu on veut prevenir, et surtout on doit
 * POUVOIR DIRE a l utilisateur si sa recherche laisse une trace. Un outil
 * qui ne le dit pas fait prendre un risque sans le nommer. */
function mode(c) { return c.mode === 'actif' ? 'actif' : 'passif'; }

/* ==================================================================
 * LES REGLES DE CORRELATION — reprises de SpiderFoot
 * ==================================================================
 * Une liste de faits n est pas un resultat. Ce qui fait un resultat, c est
 * le CROISEMENT : « pas de DMARC » est anodin, « pas de DMARC ET un MX qui
 * recoit » veut dire que n importe qui peut ecrire au nom de ce domaine.
 *
 * Chaque regle dit ce qu elle a vu, pourquoi ca compte, et sur quels faits
 * elle s appuie — jamais un verdict sans ses pieces. */
/* Les gravites, cote interne et cote montre. */
const GRAVITES = { haute: 'HIGH', moyenne: 'MEDIUM', basse: 'LOW', info: 'NOTE' };

const REGLES = [
  {
    nom: 'mail-usurpable', gravite: 'haute',
    quand(ix) {
      const mx = ix.parPredicat('MAIL HANDLED BY').length || ix.parPredicat('MAIL HOSTED BY').length;
      const d = ix.parPredicat('DMARC')[0];
      if (!mx || !d || (d.valeur && d.valeur !== 'none published')) return null;
      return { dit: 'This domain receives mail but publishes no DMARC policy. Anyone can send mail '
                  + 'in its name and receiving servers have nothing to check it against.',
               pieces: [d] };
    },
  },
  {
    nom: 'domaine-jeune-titulaire-masque', gravite: 'moyenne',
    quand(ix) {
      const cree = ix.parPredicat('REGISTERED ON')[0];
      const tit = ix.parPredicat('REGISTRANT IS')[0];
      if (!cree || !tit || !/redacted/i.test(String(tit.valeur || ''))) return null;
      const jours = (Date.now() - Date.parse(cree.valeur)) / 86400000;
      if (!(jours >= 0 && jours < 90)) return null;
      return { dit: 'Registered ' + Math.round(jours) + ' days ago, with the registrant withheld. '
                  + 'Both are ordinary on their own — most domains redact since the GDPR — '
                  + 'and this is a reason to look further, not a conclusion.',
               pieces: [cree, tit] };
    },
  },
  {
    nom: 'expire-bientot', gravite: 'moyenne',
    quand(ix) {
      const e = ix.parPredicat('EXPIRES ON')[0];
      if (!e) return null;
      const jours = (Date.parse(e.valeur) - Date.now()) / 86400000;
      if (!(jours >= 0 && jours < 30)) return null;
      return { dit: 'The registration expires in ' + Math.round(jours) + ' days. An expiring domain '
                  + 'can be picked up by someone else, mail and all.', pieces: [e] };
    },
  },
  {
    nom: 'surface-non-verifiee', gravite: 'basse',
    quand(ix) {
      const subs = ix.parPredicat('CERTIFICATE ISSUED FOR');
      if (subs.length < 10) return null;
      return { dit: subs.length + ' names appear in public certificate logs for this domain. '
                  + 'A certificate was issued for each — it does not mean a machine answers there today. '
                  + 'They are the places to look, not findings.', pieces: subs.slice(0, 3) };
    },
  },
  {
    nom: 'adresse-nominative-publiee', gravite: 'basse',
    quand(ix) {
      const noms = ix.faits.filter((f) => f.predicat === 'PUBLISHES CONTACT'
        && f.objet && f.objet.type === 'email' && /^[a-z]+[._-][a-z]+@/.test(f.objet.valeur));
      if (!noms.length) return null;
      return { dit: noms.length + ' named mailbox' + (noms.length === 1 ? ' is' : 'es are')
                  + ' published on this organisation’s own pages. That is their choice to make, '
                  + 'and worth knowing if you are the one who published them.', pieces: noms.slice(0, 3) };
    },
  },
  {
    nom: 'nomme-nest-pas-proprietaire', gravite: 'info',
    quand(ix) {
      const a = ix.parPredicat('PUBLICLY ASSOCIATED WITH DOMAIN');
      if (!a.length) return null;
      return { dit: a.length + ' person' + (a.length === 1 ? ' is' : 's are') + ' named by this organisation '
                  + 'on its own pages. Being named is not owning: only a registry entry in clear or a legal '
                  + 'notice establishes that, and neither is present here.', pieces: a.slice(0, 3) };
    },
  },
  {
    nom: 'lanceur-recidiviste', gravite: 'haute',
    quand(ix) {
      const m = ix.parPredicat('MEASURED OUTCOME OF SIMILAR LAUNCHERS')[0];
      if (!m || !/4\+/.test(String(m.valeur))) return null;
      return { dit: 'This address is a repeat launcher, and repeat launchers measure worse, not better: '
                  + m.valeur + '. That is a measurement of what happened, not a prediction.', pieces: [m] };
    },
  },
];

function index(faits) {
  const parP = new Map();
  for (const f of faits) {
    if (!parP.has(f.predicat)) parP.set(f.predicat, []);
    parP.get(f.predicat).push(f);
  }
  return { faits, parPredicat: (p) => parP.get(p) || [] };
}

function constats(faits) {
  const ix = index(faits);
  const out = [];
  for (const r of REGLES) {
    let v = null;
    try { v = r.quand(ix); } catch (e) { v = null; }
    if (!v) continue;
    out.push({ regle: r.nom, gravite: r.gravite,
               /* Le nom interne reste en francais comme tout le code ; le
                  LIBELLE montre aux gens est en anglais, comme tout ce qui
                  sort de l outil. */
               etiquette: GRAVITES[r.gravite] || 'NOTE',
               dit: v.dit,
               pieces: v.pieces.map((f) => ({ predicat: f.predicat,
                 valeur: f.valeur || (f.objet && f.objet.valeur), sources: f.sources })) });
  }
  const ordre = { haute: 0, moyenne: 1, basse: 2, info: 3 };
  return out.sort((a, b) => ordre[a.gravite] - ordre[b.gravite]);
}

module.exports.mode = mode;
module.exports.REGLES = REGLES;
module.exports.GRAVITES = GRAVITES;
module.exports.constats = constats;
module.exports.index = index;

/* Le rapport PDF. L ordre n est pas decoratif : les CONSTATS d abord —
   c est ce qu on vient chercher — puis les contradictions, puis les faits,
   puis les sources et les limites. Un rapport qui commence par trois pages
   d enregistrements DNS n est jamais lu jusqu aux constats. */
function versPDF(rapport) {
  const pdf = require('./osint_pdf');
  const L = [];
  const gris = (t, ta) => L.push({ texte: t, taille: ta || 8, gris: 0.45 });
  const titre = (t) => { L.push({ texte: t, taille: 12, gras: true, avant: 14 }); L.push({ trait: true }); };

  gris(rapport.cible.type.toUpperCase() + '  ' + rapport.cible.valeur + '   ·   ' + rapport.date
     + '   ·   ' + (rapport.ms / 1000).toFixed(1) + 's'
     + '   ·   ' + (rapport.passif ? 'passive: the target was never touched'
                                        : 'active: the target saw our requests'), 9);

  titre('FINDINGS');
  if (!(rapport.constats || []).length) {
    gris('Nothing crossed. That is a result, not an absence of work — see the facts below.', 9.5);
  }
  for (const c of rapport.constats || []) {
    L.push({ texte: '[' + (c.etiquette || 'NOTE') + ']  ' + c.dit, taille: 9.5, avant: 6 });
    for (const p of c.pieces) gris('   ' + p.predicat + ': ' + p.valeur + '   — ' + (p.sources || []).join(', '));
  }

  if ((rapport.contradictions || []).length) {
    titre('SOURCES DISAGREE');
    for (const k of rapport.contradictions) {
      L.push({ texte: k.sujet.valeur + ' — ' + k.predicat, taille: 9.5, gras: true, avant: 6 });
      for (const v of k.versions) gris('   ' + v.valeur + '   (' + v.confiance + ', ' + v.score + ')   — ' + v.sources.join(', '));
      gris('   ' + k.note);
    }
  }

  titre('FACTS');
  for (const f of rapport.faits) {
    L.push({ texte: f.sujet.valeur + '  —  ' + f.predicat + '  —  '
                  + (f.objet ? f.objet.valeur : f.valeur)
                  + '   [' + f.confiance + ' ' + f.score + (f.conteste ? ', disputed' : '') + ']', taille: 9 });
    gris('   ' + (f.sources || []).join(', ') + (f.pourquoi ? '   — ' + f.pourquoi : ''));
  }

  titre('WHAT WAS NOT DONE');
  for (const e of rapport.connecteursEteints || []) gris('off: ' + e.nom + ' — ' + e.pourquoi + (e.cout ? ' (' + e.cout + ')' : ''), 9);
  for (const e of rapport.connecteursEcartes || []) gris('skipped: ' + e.nom + ' — ' + e.pourquoi, 9);
  for (const l of LIMITES_RAPPORT) L.push({ texte: '• ' + l, taille: 8.5 });

  return pdf.pdf('SWOGE OSINT — ' + rapport.cible.valeur, L);
}

/* Ce que la suite ne fait pas, dans CHAQUE rapport. Un rapport qui sort de
   l outil et circule sans ses limites finit par etre lu comme une preuve. */
const LIMITES_RAPPORT = [
  'A person’s name returns SEPARATE public candidates (Wikidata, GitHub) — never a confirmed identity. Same name is not the same person, and nothing is merged.',
  'E-mail addresses, usernames and phone numbers are selectors: closed questions about them, never an expansion into a person.',
  'No leaked or private database is queried. No login, paywall or anti-bot protection is bypassed. robots.txt is obeyed.',
  'No password, hash or secret is ever fetched, stored or shown — breach checks report presence and data categories only.',
  'Being named on a page is not owning a domain. Sources that disagree are both shown; nothing is picked for you.',
  'Every number carries how many observations it rests on. A past record is a measurement, not a prediction.',
];

/* ==================================================================
 * L HISTORIQUE — minimise par construction
 * ==================================================================
 * On garde la CIBLE, la date, les comptes. Pas les faits : ils vivent
 * dans le cache le temps de leur TTL, et une enquete sur une personne
 * nommee par une organisation n a pas a rester dans un journal sur le
 * disque parce que quelqu un a tape un domaine une fois. */
const HISTORIQUE = [];
const HISTO_MAX = Math.max(10, Number(process.env.OSINT_HISTO_MAX || 200));
function noteHistorique(r) {
  HISTORIQUE.unshift({
    cible: r.cible, date: r.date, t: Date.now(), ms: r.ms,
    faits: r.faits.length, constats: (r.constats || []).length,
    contradictions: (r.contradictions || []).length,
    entites: r.entites ? r.entites.length : 0,
    passif: !!r.passif,
  });
  if (HISTORIQUE.length > HISTO_MAX) HISTORIQUE.length = HISTO_MAX;
  return HISTORIQUE[0];
}
const historique = (n) => HISTORIQUE.slice(0, Math.max(1, Math.min(HISTO_MAX, n || 50)));

module.exports.versPDF = versPDF;
module.exports.LIMITES_RAPPORT = LIMITES_RAPPORT;
module.exports.noteHistorique = noteHistorique;
module.exports.historique = historique;
module.exports.HISTORIQUE = HISTORIQUE;
