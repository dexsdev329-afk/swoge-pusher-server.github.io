'use strict';
/*
 * LES COUPES : INVENTAIRE (0 credit) ET OBSERVATION A 48 H, RIEN DE VENDU
 * (lot 6 de la cle 20K, 11/10/2026).
 *
 * ---- pourquoi ----
 *
 * Huit coupes (prix_ligues.COUPES) se jouent en semaine, quand nos dix-sept
 * championnats se taisent. Avant d'en vendre une seule (lot 10), il faut
 * savoir trois choses qu'aucune mesure du depot ne dit encore :
 *   - si ESPN reconnait leurs equipes (le reglement gratuit, et le second
 *     verrou de fermeture, paris.ouvert) : la Conference League avait 15 noms
 *     differents sur 36 clubs le 18/09 (EXPLOITATION 8.9) ;
 *   - si le marche les cote assez (betfair, pinnacle ou mediane d'au moins
 *     trois livres) au dernier releve d'avant le coup d'envoi ;
 *   - si leur prix BOUGE plus que celui des championnats entre deux releves
 *     (rotation, compositions) : un prix vendu a 10 % de marge qui devient
 *     battable au releve suivant.
 *
 * ---- trois etages, chacun derriere sa variable (prix_ligues.js) ----
 *
 * 1. L'INVENTAIRE, 0 credit (PARIS_COUPES_OBSERVE) : /events de chaque coupe
 *    observee a chaque import (gratuit, « This endpoint does not count against
 *    the usage quota », https://the-odds-api.com/liveapi/guides/v4/), ecrit
 *    dans $DATA_DIR/coupes_inventaire.json ; puis, sur sa propre minuterie de
 *    12 h et APRES l'ecriture du catalogue, l'appariement ESPN par
 *    `espn.releve` — le MEME code que le reglement — et, pour chaque rencontre
 *    non appariee, les noms qu'ESPN donne le meme jour : de quoi ecrire les
 *    ALIAS en les RELEVANT (scores_espn.js), jamais en les devinant. Aucune
 *    rencontre de coupe n'entre au catalogue (paris_import.importeMatchs).
 * 2. L'OBSERVATION PAYANTE (PARIS_COUPES_OBSERVE_H > 0) : la releve h2h des
 *    coupes observees, a la cadence des championnats (releveMs), seulement
 *    quand une rencontre commence dans la fenetre (classe 3, jamais
 *    prioritaire), plus une releve FORCEE entre T-45 et T-20 quand le dernier
 *    releve est anterieur a T-60 (classe 2) : sans elle, avec une cadence de
 *    2 h, le dernier prix d'avant-match tombe avant l'annonce des equipes une
 *    fois sur deux (critique du sceptique, 09/10 : phase uniforme sur 2 h).
 * 3. LA VENTE (PARIS_COUPES) : lot 10, PAS ICI. prix_ligues.coupes() est
 *    toujours vide.
 *
 * ---- ou vit la mesure, et pourquoi pas dans note() ----
 *
 * Le plan d'origine calculait la derive dans `prix_marche.note`, avant
 * l'ecriture du carnet des 17 championnats vendus, et gardait l'historique
 * dans paris_prix.json, que `lis()` rend vide sur toute erreur de lecture
 * (bloquant du sceptique). Ici :
 *   - le SUIVI d'avant-match (dernier releve d'avant le coup d'envoi, sa
 *     reference, le nombre de releves dans les 48 h, un releve apres T-60)
 *     s'abonne au crochet `apresNote` du socle, appele APRES l'ecriture du
 *     carnet, et vit dans son fichier, $DATA_DIR/coupes_suivi.json, ecrit en
 *     deux temps, jamais reecrit apres une lecture refusee (autre que ENOENT),
 *     mis de cote (jamais ecrase) s'il ne se decode pas ;
 *   - la DERIVE (porte D) se calcule HORS serveur, sur les lignes du journal
 *     des releves (lot 1), par `outils/age_prix.js --coupes`, avec la cotation
 *     de vente (cotesVendues, la meme que le chemin vendu).
 * Le serveur juge E, C et A ; l'outil ajoute D et rend le verdict complet
 * avec la MEME fonction (`porte`).
 *
 * Commentaires sans accents (convention de prix_marche.js).
 */
const fs = require('fs');
const path = require('path');
const prixLigues = require('./prix_ligues');
const pm = require('./prix_marche');
const espn = require('./scores_espn');

const V = 1;
const MIN = 60000, H = 3600000, JOUR = 86400000;
/* L'inventaire et le suivi gardent 60 jours apres le coup d'envoi : la porte
   compte cumule (E, C, A), et la plus longue attente ecrite d'avance est celle
   des coupes nationales, « pas avant decembre » (plan du 09/10). */
const GARDE_JOURS = 60;
/* La releve forcee : entre T-45 et T-20, si le dernier releve est anterieur
   a T-60. Les compositions tombent environ une heure avant (commentaire de
   paris_import.prixAvantMatch) ; 20 min avant, la releve reste avant la
   fermeture. Une rencontre passe dans 2 ou 3 tics de 10 min de la fenetre :
   le premier paie, les suivants voient un releve posterieur a T-60. */
const FORCEE_DE = 20 * MIN, FORCEE_A = 45 * MIN, FORCEE_SI_AVANT = 60 * MIN;
/* La fenetre de l'appariement ESPN : les rencontres jouees depuis 3 jours au
   plus (le reglement repasse 3 jours, /scores daysFrom=3) et celles des 7
   prochains jours (l'horizon de l'import). */
const ESPN_AVANT_MS = 3 * JOUR, ESPN_APRES_MS = 7 * JOUR;
const REFS_COUVERTES = new Set(['betfair', 'pinnacle', 'mediane']);

function base() { return path.dirname(pm.fichier()); }
function fichierInventaire() { return path.join(base(), 'coupes_inventaire.json'); }
function fichierSuivi() { return path.join(base(), 'coupes_suivi.json'); }

/** Les coupes suivies : observees (PARIS_COUPES_OBSERVE), plus les vendues
    (toujours vide dans ce lot). */
function suivies() { return new Set([...prixLigues.coupes(), ...prixLigues.coupesObservees()]); }

// ------------------------------------------------------------ les fichiers

const ECHECS = { inventaire: 0, suivi: 0, dernier: null };
let ditEchec = -Infinity;
function echec(quoi, e, t) {
  ECHECS[quoi] = (ECHECS[quoi] || 0) + 1;
  ECHECS.dernier = { quand: new Date(Number(t) || Date.now()).toISOString(), quoi, message: String((e && (e.code || e.message)) || e).slice(0, 160) };
  const q = Number(t) || Date.now();
  if (!(q - ditEchec < H && q >= ditEchec)) {
    ditEchec = q;
    console.log('[odds] coupes : ' + quoi + ' — ' + ECHECS.dernier.message + ' (rien de vendu ne change)');
  }
}
/** Lecture : { j, etat } ; etat = ok | absent | illisible (lecture refusee) | json (ne se decode pas) | version. */
function lisFichier(f) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch (e) {
    return { j: null, etat: e && e.code === 'ENOENT' ? 'absent' : 'illisible', erreur: String((e && (e.code || e.message)) || e) };
  }
  let j;
  try { j = JSON.parse(txt); } catch (e) { return { j: null, etat: 'json' }; }
  return j && j.v === V && j.coupes && typeof j.coupes === 'object' ? { j, etat: 'ok' } : { j: null, etat: 'version' };
}
/* ---- LE CONTENU QUI NE SE DECODE PAS EST MIS DE COTE, JAMAIS ECRASE ----
 * La regle de l'index de cloture (prix_journal.js, lot 2) : renomme
 * `<fichier>.illisible-<t>`, dit au journal de l'hote, trois gardes. Une
 * lecture REFUSEE (EIO, EMFILE, EACCES) ne dit rien du contenu : on n'ecrit
 * pas du tout, la releve suivante reessaie (plan corrige : « jamais reecrit
 * si la lecture a echoue pour une autre raison que ENOENT »). */
const ILLISIBLES_GARDES = 3;
function metDeCote(f, t) {
  const cote = f + '.illisible-' + (Number.isFinite(t) ? t : Date.now());
  try { fs.renameSync(f, cote); } catch (e) { return false; }
  console.log('[odds] coupes : ' + path.basename(f) + ' ne se decode pas, mis de cote sous ' + path.basename(cote) + ' et refait');
  try {
    const pre = path.basename(f) + '.illisible-';
    const vieux = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(pre))
      .sort((a, b) => Number(b.slice(pre.length)) - Number(a.slice(pre.length))).slice(ILLISIBLES_GARDES);
    for (const x of vieux) fs.unlinkSync(path.join(path.dirname(f), x));
  } catch (e) { /* la purge n'empeche rien */ }
  return true;
}
/** Lit, applique `maj` (qui rend vrai si le contenu a change), ecrit en deux
    temps. Rien n'est attendu entre la lecture et l'ecriture. Ne leve jamais. */
function metAJour(quoi, f, maj, t) {
  try {
    const l = lisFichier(f);
    if (l.etat === 'illisible') { echec(quoi, 'lecture refusee (' + l.erreur + ') : rien n est ecrit', t); return false; }
    if (l.etat === 'json' || l.etat === 'version') {
      if (!metDeCote(f, t)) { echec(quoi, 'contenu illisible et impossible a mettre de cote : rien n est ecrit', t); return false; }
    }
    const j = l.etat === 'ok' ? l.j : { v: V, coupes: {} };
    if (!maj(j)) return true;
    j.maj = Number(t) || Date.now();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j) + '\n');
    fs.renameSync(tmp, f);
    return true;
  } catch (e) { echec(quoi, e, t); return false; }
}

// ------------------------------------------------------------ l'inventaire

/**
 * Note la reponse /events d'une coupe (0 credit). Une entree par rencontre :
 * { dom, ext, debut, vu, espn }. `vu` = la date de la reponse qui l'a rendue
 * en dernier : seules les rencontres de la DERNIERE reponse (vu === lu)
 * declenchent une releve (une rencontre retiree du calendrier ne coute rien).
 * Rend { n, aVenir7j }.
 */
function noteInventaire(cle, evs, now) {
  const t = Number(now) || Date.now();
  const L = String(cle || '');
  if (!prixLigues.estCoupe(L)) return { n: 0, aVenir7j: 0 };
  let n = 0, aVenir7j = 0;
  metAJour('inventaire', fichierInventaire(), (j) => {
    const c = j.coupes[L] || (j.coupes[L] = { lu: 0, n: 0, ev: {} });
    if (!c.ev || typeof c.ev !== 'object') c.ev = {};
    for (const ev of evs || []) {
      const debut = Date.parse(ev && ev.commence_time);
      if (!ev || !ev.id || !isFinite(debut) || !ev.home_team || !ev.away_team) continue;
      const id = String(ev.id), dom = String(ev.home_team), ext = String(ev.away_team);
      const cur = c.ev[id];
      /* une autre affiche sous le meme evenement : l'appariement repart de zero */
      const garde = cur && cur.dom === dom && cur.ext === ext ? cur.espn || null : null;
      c.ev[id] = { dom, ext, debut, vu: t, espn: garde };
      n++;
      if (debut > t && debut <= t + 7 * JOUR) aVenir7j++;
    }
    c.lu = t; c.n = n;
    for (const [id, e] of Object.entries(c.ev)) if (!(Number(e.debut) >= t - GARDE_JOURS * JOUR)) delete c.ev[id];
    return true;
  }, t);
  return { n, aVenir7j };
}
/** L'inventaire tel qu'il est sur le disque ({ coupes: {} } si absent ou illisible). */
function lisInventaire() { const l = lisFichier(fichierInventaire()); return l.j || { v: V, coupes: {} }; }
/** Les rencontres de la DERNIERE reponse /events d'une coupe. */
function dernieres(c) {
  if (!c || !c.ev) return [];
  return Object.entries(c.ev).filter(([, e]) => e.vu === c.lu).map(([id, e]) => Object.assign({ id }, e));
}

/** Les coupes suivies qui ont une rencontre dans (now, now + dansMs]. */
function aVenir(now, dansMs) {
  const t = Number(now) || Date.now(), out = new Set();
  if (!(dansMs > 0)) return out;
  const inv = lisInventaire();
  for (const cle of suivies()) {
    if (dernieres(inv.coupes[cle]).some((e) => e.debut > t && e.debut <= t + dansMs)) out.add(cle);
  }
  return out;
}
/**
 * La releve forcee T-45/T-20 (classe 2) : pour chaque coupe OBSERVEE, la
 * fenetre payante ouverte (PARIS_COUPES_OBSERVE_H > 0), qui a une rencontre
 * dont le coup d'envoi tombe dans [now + 20 min ; now + 45 min] et un dernier
 * releve anterieur a T-60 de la plus tardive d'entre elles. Rend
 * [{ cle, debut, ageMin }] : `ageMin` = now - (debut - 60 min), pour que
 * rafraichitPrix saute la cle si une releve posterieure a T-60 a eu lieu
 * entre-temps (jamais deux credits pour le meme creneau).
 */
function forcees(now) {
  const t = Number(now) || Date.now(), out = [];
  if (!(prixLigues.observeCoupesMs() > 0)) return out;
  const inv = lisInventaire();
  for (const cle of prixLigues.coupesObservees()) {
    const dans = dernieres(inv.coupes[cle]).filter((e) => e.debut >= t + FORCEE_DE && e.debut <= t + FORCEE_A);
    if (!dans.length) continue;
    const debut = Math.max(...dans.map((e) => e.debut));
    if (pm.derniere(cle) < debut - FORCEE_SI_AVANT) out.push({ cle, debut, ageMin: t - (debut - FORCEE_SI_AVANT) });
  }
  return out;
}

/* Un `fetch` dont chaque URL n'est demandee qu'une fois par passe : `releve`
   et `tableau` lisent les memes journees ou les memes mois. Note les pannes
   (statut non 200, corps illisible, abandon) : une rencontre absente d'un
   tableau en panne ne se conclut pas. */
function prendreUneFois(prendre) {
  const f = prendre || fetch;
  const vus = new Map();
  const etat = { pannes: 0 };
  const lit = async (u, op) => {
    if (!vus.has(u)) {
      vus.set(u, (async () => {
        let r;
        try { r = await f(u, op); } catch (e) { etat.pannes++; return { ok: false, status: 0, erreur: e }; }
        if (!r || !r.ok) { etat.pannes++; return { ok: false, status: (r && r.status) || 0 }; }
        try { return { ok: true, status: r.status || 200, j: await r.json() }; } catch (e) { etat.pannes++; return { ok: false, status: r.status || 0, erreur: e }; }
      })());
    }
    const x = await vus.get(u);
    if (x.erreur && !x.ok && x.status === 0) throw x.erreur;
    return x.ok ? { ok: true, status: x.status, json: async () => JSON.parse(JSON.stringify(x.j)) } : { ok: false, status: x.status, json: async () => { throw new Error('statut ' + x.status); } };
  };
  lit.etat = etat;
  return lit;
}

/**
 * L'appariement ESPN de l'inventaire, 0 credit. Pour chaque coupe (par defaut
 * les suivies) qui a un tableau ESPN, les rencontres de [now - 3 j ; now + 7 j]
 * passent par `espn.releve` sous forme de pseudo-rencontres ; une rencontre
 * appariee le reste (`espn.ok` vrai ne redescend jamais : une journee qui ne
 * repond plus ne defait pas un appariement vu). Une rencontre non appariee
 * d'un tableau qui a REPONDU passe a faux, avec les noms d'ESPN du meme jour
 * (UTC) ; d'un tableau en panne, rien ne se conclut. Ne leve JAMAIS : l'import
 * et le catalogue n'en dependent pas. Rend { [cle]: { lues, appariees,
 * nonAppariees, panne } }.
 */
async function apparieEspn(o) {
  const opt = o || {};
  const t = Number(opt.maintenant) || Date.now();
  const cles = opt.cles ? [...opt.cles] : [...suivies()];
  const out = {}, poser = {};
  try {
    const inv = lisInventaire();
    for (const cle of cles) {
      const chemin = espn.CHEMINS[cle];
      const c = inv.coupes[cle];
      if (!chemin || !c || !c.ev) { out[cle] = { lues: 0, appariees: 0, nonAppariees: [], panne: !chemin ? 'pas de tableau ESPN' : null }; continue; }
      const lot = Object.entries(c.ev).filter(([, e]) => e.debut >= t - ESPN_AVANT_MS && e.debut <= t + ESPN_APRES_MS)
        .map(([id, e]) => ({ id, dom: e.dom, ext: e.ext, debut: e.debut }));
      if (!lot.length) { out[cle] = { lues: 0, appariees: 0, nonAppariees: [], panne: null }; continue; }
      const prendre = prendreUneFois(opt.prendre);
      const pseudo = lot.map((e) => ({ id: 'ev:' + e.id, sport: 'foot', domicile: e.dom, exterieur: e.ext, debut: e.debut, source: { ligue: cle } }));
      let vus = new Map(), lus = [];
      try { vus = await espn.releve(pseudo, { prendre, maintenant: t }); } catch (e) { prendre.etat.pannes++; }
      try {
        const debuts = lot.map((e) => e.debut);
        /* la MEME fenetre que `releve` : les memes URL, deja lues */
        lus = (await espn.tableau(chemin, Math.min(...debuts) - JOUR, Math.max(...debuts) + JOUR, prendre)).map(espn.lis).filter(Boolean);
      } catch (e) { prendre.etat.pannes++; }
      const panne = prendre.etat.pannes > 0;
      const parJour = new Map();
      for (const x of lus) {
        const j = new Date(x.quand).toISOString().slice(0, 10);
        if (!parJour.has(j)) parJour.set(j, new Set());
        parJour.get(j).add(x.a.nom); parJour.get(j).add(x.b.nom);
      }
      const r = { lues: lot.length, appariees: 0, nonAppariees: [], panne: panne ? 'tableau ESPN en panne (' + prendre.etat.pannes + ' requete(s)) : rien ne se conclut' : null };
      poser[cle] = {};
      for (const e of lot) {
        const ok = vus.has('ev:' + e.id);
        if (ok) { r.appariees++; poser[cle][e.id] = true; continue; }
        if (!panne) poser[cle][e.id] = false;
        const j = new Date(e.debut).toISOString().slice(0, 10);
        r.nonAppariees.push({ id: e.id, affiche: e.dom + ' v ' + e.ext, debut: new Date(e.debut).toISOString(),
                              espnMemeJour: [...(parJour.get(j) || [])].sort() });
      }
      out[cle] = r;
    }
    /* Ecrit d'un coup, sur l'inventaire RELU : un import a pu le changer
       pendant les requetes ESPN. */
    metAJour('inventaire', fichierInventaire(), (j) => {
      let change = false;
      for (const [cle, ids] of Object.entries(poser)) {
        const c = j.coupes[cle];
        if (!c || !c.ev) continue;
        for (const [id, ok] of Object.entries(ids)) {
          const e = c.ev[id];
          if (!e) continue;
          const deja = !!(e.espn && e.espn.ok);
          e.espn = { ok: deja || ok, t };
          change = true;
        }
        c.espnLu = t;
        /* un tableau en panne ne remplace pas la liste d'avant : il ne prouve rien */
        if (!out[cle].panne) c.nonAppariees = (out[cle].nonAppariees || []).slice(0, 40);
        c.espnPanne = out[cle].panne;
      }
      return change || Object.keys(poser).length > 0;
    }, t);
  } catch (e) { console.log('[odds] coupes : appariement ESPN impossible — ' + ((e && e.message) || e) + ' (le catalogue n en depend pas)'); }
  return out;
}

// ------------------------------------------------------------ le suivi d'avant-match

/**
 * L'abonne du crochet `apresNote` (le carnet est deja ecrit). Pour une coupe
 * seulement, chaque rencontre de la reponse dont le coup d'envoi est APRES la
 * releve : { debut, ref (betfair | pinnacle | mediane | aucun), t, n48 (releves
 * dans les 48 h d'avant), apresT60, livres }. Une releve posterieure au coup
 * d'envoi (/odds rend aussi les matchs en cours, « upcoming and live games »,
 * guide v4) n'ecrase JAMAIS le dernier prix d'avant-match. Une rencontre
 * suivie, a venir, absente d'une reponse non vide : son marche est retire
 * (`retire`, non couverte), la regle du carnet.
 */
function noteSuivi(fait) {
  const L = String((fait && fait.ligue) || '');
  if (!prixLigues.estCoupe(L)) return false;
  const t = Number(fait.t) || Date.now();
  const refs = Array.isArray(fait.refs) ? fait.refs : [];
  return metAJour('suivi', fichierSuivi(), (j) => {
    const c = j.coupes[L] || (j.coupes[L] = {});
    let change = false;
    const vus = new Set();
    for (const r of refs) {
      const debut = Number(r && r.debut) || 0;
      if (!r || !r.id || !(debut > t)) continue;
      const id = String(r.id);
      vus.add(id);
      const cur = c[id] || { n48: 0, apresT60: false };
      c[id] = { debut, ref: r.ref || 'aucun', t, livres: Number(r.livres) || 0,
                n48: (Number(cur.n48) || 0) + (debut - t <= 48 * H ? 1 : 0),
                apresT60: !!cur.apresT60 || debut - t <= FORCEE_SI_AVANT };
      change = true;
    }
    if (refs.length) {
      for (const [id, e] of Object.entries(c)) {
        if (vus.has(id) || !(e.debut > t) || e.ref === 'retire') continue;
        Object.assign(e, { ref: 'retire', t, n48: (Number(e.n48) || 0) + (e.debut - t <= 48 * H ? 1 : 0) });
        change = true;
      }
    }
    for (const [id, e] of Object.entries(c)) if (!(Number(e.debut) >= t - GARDE_JOURS * JOUR)) { delete c[id]; change = true; }
    return change;
  }, t);
}
function lisSuivi() { const l = lisFichier(fichierSuivi()); return l.j || { v: V, coupes: {} }; }
let DESABONNE = null;
/** Branche le suivi sur `prix_marche.apresNote`, une seule fois. */
function branche() {
  if (!DESABONNE) {
    const d = pm.apresNote(function suiviDesCoupes(fait) { noteSuivi(fait); });
    DESABONNE = () => { d(); DESABONNE = null; };
  }
  return DESABONNE;
}

// ------------------------------------------------------------ la mesure et la porte

/** E, C, A d'une coupe, sur le suivi et l'inventaire. */
function mesure(cle, now, inv, suivi) {
  const t = Number(now) || Date.now();
  const s = ((suivi || lisSuivi()).coupes || {})[cle] || {};
  const c = ((inv || lisInventaire()).coupes || {})[cle] || null;
  const jouees = Object.entries(s).filter(([, e]) => e.debut <= t && Number(e.n48) >= 1);
  const ages = jouees.map(([, e]) => e.debut - e.t).sort((a, b) => a - b);
  const out = { E: jouees.length, C: 0, A: 0, apresT60: 0, parRef: {}, ageDernierMedianMin: ages.length ? Math.round(ages[Math.floor(ages.length / 2)] / MIN) : null,
                aVenir7j: 0, aVenir48h: 0, inventaireLu: c && c.lu ? new Date(c.lu).toISOString() : null };
  for (const [id, e] of jouees) {
    out.parRef[e.ref] = (out.parRef[e.ref] || 0) + 1;
    if (REFS_COUVERTES.has(e.ref)) out.C++;
    if (e.apresT60) out.apresT60++;
    const x = c && c.ev && c.ev[id];
    if (x && x.espn && x.espn.ok === true) out.A++;
  }
  for (const e of dernieres(c)) {
    if (e.debut > t && e.debut <= t + 7 * JOUR) out.aVenir7j++;
    if (e.debut > t && e.debut <= t + 48 * H) out.aVenir48h++;
  }
  return out;
}

/* ---- LA PORTE, ECRITE D'AVANCE (EXPLOITATION 8.11, plan corrige du 09/10) ----
 * Par COUPE ; la famille (europeennes, nationales) ne sert que de repere.
 * TOUS les criteres doivent tenir, sinon « pas encore » : un critere non
 * atteint fait glisser la date, jamais le seuil.
 *   E  au moins 8 rencontres jouees, chacune avec au moins un releve dans les
 *      48 h d'avant le coup d'envoi (plan du 09/10) ;
 *   C  au moins 90 % de ces rencontres avec une reference (betfair, pinnacle,
 *      mediane d'au moins 3 livres) au DERNIER releve d'avant le coup d'envoi.
 *      Repere : 138/138 sur les onze championnats, 0 « aucun » (8.8quinquies) ;
 *   A  au moins 95 % de ces rencontres appariees par espn.releve (reglement
 *      gratuit, second verrou de fermeture). Fenetre : cumulee, sur E ;
 *   D  la derive (outils/age_prix.js --coupes), pour CHAQUE tranche
 *      (moins de 3 h, 3-48 h, nouveau releve apres T-60) et CHAQUE marche
 *      (1-N-2, double chance) : comptee PAR RENCONTRE (au moins une issue
 *      battable sur une paire de meme reference), borne haute de Wilson a
 *      95 % sous 2 %, ET part au plus celle des championnats sur les MEMES
 *      jours + 1 point, la reference portant sur au moins 30 rencontres
 *      (sous 30, l'intervalle par rencontre ne tient pas : AFFICHE_MIN de
 *      l'outil). Le sceptique (Poisson, 09/10) : 200 issues ne distinguent
 *      pas 1 % de 3 % — d'ou la borne, et non la part.
 *      CONSEQUENCE CALCULEE, pas une decision : sans AUCUNE rencontre
 *      battable, la borne de Wilson passe sous 2 % a 189 rencontres
 *      (`nMinD`), dans chaque tranche et chaque marche. La saison 2025-26 de
 *      l'Europa League en comptait 189 (plan, mesure ESPN) ;
 *   date  au plus tot le 06/11/2026 pour UEL et UECL (deux journees
 *      observees, 22/10 et 05/11, si l'observation demarre le 13/10) ; le
 *      01/12/2026 pour les coupes nationales (« pas avant decembre »). */
const PORTE = Object.freeze({
  eMin: 8, cMin: 0.90, aMin: 0.95,
  dHaut: 0.02, dMarge: 0.01, dRefMin: 30, z: 1.959964,
  tranches: Object.freeze(['moins3h', 'de3a48h', 'apresT60']), marches: Object.freeze(['1n2', 'dc']),
  auPlusTot: Object.freeze({ europeennes: '2026-11-06', nationales: '2026-12-01' }),
});
/** La borne haute de Wilson (a 95 %, z = 1,96) d'une part k/n. 1 sans echantillon. */
function wilsonHaut(k, n, z) {
  const Z = z === undefined ? PORTE.z : z;
  if (!(n > 0)) return 1;
  const p = Math.min(1, Math.max(0, k / n)), z2 = Z * Z;
  const centre = p + z2 / (2 * n), marge = Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return Math.min(1, (centre + marge) / (1 + z2 / n));
}
/** Le plus petit nombre de rencontres, toutes sans issue battable, qui passe la borne. */
function nMinD() { let n = 1; while (wilsonHaut(0, n) >= PORTE.dHaut && n < 100000) n++; return n; }
const N_MIN_D = nMinD();
function famille(cle) { return prixLigues.COUPES_EUROPEENNES.includes(cle) ? 'europeennes' : 'nationales'; }
const pct = (x) => (x === null || x === undefined ? 'n/a' : (Math.round(x * 1000) / 10) + ' %');

/**
 * Le verdict d'une coupe. `m` : { E, C, A } (mesure) ; `d` : la derive de
 * l'outil, { [tranche]: { [marche]: { n, k, nRef, kRef } } }, ou null quand
 * elle n'est pas mesuree (le serveur) — D ne tient alors pas. Rend
 * { cle, famille, criteres, verdict ('OUVERTE' | 'pas encore'), pourquoi }.
 */
function porte(cle, m, d, now) {
  const P = PORTE;
  const t = Number(now) || Date.now();
  const E = Number(m && m.E) || 0, C = Number(m && m.C) || 0, A = Number(m && m.A) || 0;
  const fam = famille(cle);
  const crit = {};
  crit.E = { valeur: E, seuil: P.eMin, tient: E >= P.eMin };
  /* comparaisons ENTIERES : 9/10 et 19/20 ne doivent pas tomber d'un cheveu de virgule */
  crit.C = E >= P.eMin ? { valeur: C + '/' + E, part: C / E, seuil: P.cMin, tient: C * 100 >= E * Math.round(P.cMin * 100) }
                       : { valeur: C + '/' + E, part: E ? C / E : null, seuil: P.cMin, tient: false, pourquoi: 'sous E : pas de conclusion' };
  crit.A = E >= P.eMin ? { valeur: A + '/' + E, part: A / E, seuil: P.aMin, tient: A * 100 >= E * Math.round(P.aMin * 100) }
                       : { valeur: A + '/' + E, part: E ? A / E : null, seuil: P.aMin, tient: false, pourquoi: 'sous E : pas de conclusion' };
  if (!d) crit.D = { tient: false, pourquoi: 'mesuree hors serveur : node outils/age_prix.js --coupes (journal des releves)' };
  else {
    const cellules = {};
    let tout = true;
    for (const tr of P.tranches) {
      for (const mk of P.marches) {
        const x = (d[tr] && d[tr][mk]) || { n: 0, k: 0, nRef: 0, kRef: 0 };
        const haut = wilsonHaut(x.k, x.n);
        const part = x.n ? x.k / x.n : null, partRef = x.nRef ? x.kRef / x.nRef : null;
        let etat;
        if (x.nRef < P.dRefMin) etat = 'reference insuffisante (' + x.nRef + '/' + P.dRefMin + ' rencontres de championnat les memes jours)';
        else if (haut >= P.dHaut) etat = part !== null && part > P.dHaut ? 'non : part ' + pct(part) + ' au-dessus de ' + pct(P.dHaut)
          : 'echantillon : borne haute ' + pct(haut) + ' sur ' + x.n + ' rencontre(s), il en faut au moins ' + N_MIN_D + ' sans issue battable';
        else if (part > partRef + P.dMarge) etat = 'non : ' + pct(part) + ' contre ' + pct(partRef) + ' + 1 point aux championnats';
        else etat = 'tient';
        cellules[tr + '|' + mk] = { n: x.n, k: x.k, part, borneHaute: haut, nRef: x.nRef, kRef: x.kRef, partRef, etat };
        if (etat !== 'tient') tout = false;
      }
    }
    crit.D = { tient: tout, cellules };
  }
  const date = P.auPlusTot[fam];
  crit.date = { auPlusTot: date, tient: new Date(t).toISOString().slice(0, 10) >= date };
  const pourquoi = Object.entries(crit).filter(([, x]) => !x.tient).map(([k, x]) => k + (x.pourquoi ? ' (' + x.pourquoi + ')'
    : k === 'date' ? ' (au plus tot le ' + x.auPlusTot + ')' : k === 'D' ? '' : ' (' + x.valeur + ', seuil ' + (x.seuil < 1 ? pct(x.seuil) : x.seuil) + ')'));
  return { cle, famille: fam, criteres: crit, verdict: pourquoi.length ? 'pas encore' : 'OUVERTE', pourquoi };
}

/* ---- LES DOUBLONS (mineur du sceptique) ----
 * The Odds API range parfois un match de coupe sous une cle de championnat
 * (commentaire de paris_import, rencontres conservees). La meme affiche sous
 * une cle de coupe ET une cle de championnat, memes equipes (noms
 * normalises, sans rapprochement flou) a 36 h pres : deux identifiants
 * doubleraient le plafond d'engagement, et la copie « championnat », reglee
 * sans aMain (prolongationPossible faux), paierait un score apres
 * prolongation. Signalee ici, rien n'est decide. */
function doublons(matchsCatalogue, now, inv) {
  const t = Number(now) || Date.now(), out = [];
  const I = inv || lisInventaire();
  const champ = (matchsCatalogue || []).filter((m) => m && m.source && m.source.ligue && !prixLigues.estCoupe(m.source.ligue));
  for (const cle of Object.keys(I.coupes || {})) {
    for (const e of dernieres(I.coupes[cle])) {
      if (!(e.debut > t - 36 * H)) continue;
      const d = espn.normalise(e.dom), x = espn.normalise(e.ext);
      for (const m of champ) {
        const md = typeof m.debut === 'number' ? m.debut : Date.parse(m.debut);
        if (Math.abs(md - e.debut) > 36 * H) continue;
        if (espn.normalise(m.domicile) === d && espn.normalise(m.exterieur) === x)
          out.push({ coupe: cle, evenement: e.id, championnat: m.source.ligue, id: m.id, affiche: e.dom + ' v ' + e.ext });
      }
    }
  }
  return out;
}

/** L'etat des coupes pour etatImport().coupes. `o.paysDe` (paris_import) : les
    noms sans drapeau, et ceux qui ne le tiennent que de la ligue ; `o.matchs` :
    le catalogue, pour les doublons. */
function etat(now, o) {
  const t = Number(now) || Date.now();
  const opt = o || {};
  const inv = lisInventaire(), suivi = lisSuivi();
  const out = {
    vendues: [...prixLigues.coupes()], venteConstruite: prixLigues.VENTE_COUPES_CONSTRUITE,
    demandeesALaVente: [...prixLigues.coupesDemandees()],
    observees: [...prixLigues.coupesObservees()], fenetreH: prixLigues.observeCoupesH(),
    ignorees: prixLigues.clesIgnorees(),
    porteSeuils: { eMin: PORTE.eMin, cMin: PORTE.cMin, aMin: PORTE.aMin, dHaut: PORTE.dHaut, dMarge: PORTE.dMarge, dRefMin: PORTE.dRefMin,
                   nMinD: N_MIN_D, auPlusTot: PORTE.auPlusTot },
    parCoupe: {}, familles: {}, doublons: [], fichiers: { inventaire: lisFichier(fichierInventaire()).etat, suivi: lisFichier(fichierSuivi()).etat },
    echecs: Object.assign({}, ECHECS),
  };
  const cles = new Set([...suivies(), ...Object.keys(inv.coupes || {}), ...Object.keys(suivi.coupes || {})]);
  for (const cle of cles) {
    if (!prixLigues.estCoupe(cle)) continue;
    const m = mesure(cle, t, inv, suivi);
    const c = inv.coupes[cle] || {};
    /* Deux listes, disjointes (relecture du 11/10/2026) :
       - sansDrapeau : aucun drapeau, meme par la ligue (Europa League et
         Conference League, qui n'ont pas de pays de ligue) ;
       - drapeauParLaLigue : absents de paris_pays.json, qui prennent le pays
         de la coupe par PAYS_LIGUE. C'est la que tombent les clubs etrangers
         d'une coupe nationale (gallois en FA Cup et en EFL Cup, FC Andorra en
         Copa del Rey) : sans elle, `paysDe(nom, cle)` les drapeaute en silence
         et la liste « sans drapeau » ne les montre jamais. A lire a l'oeil :
         seul un nom etranger appelle une ligne de paris_pays.json. */
    const sansDrapeau = new Set(), parLaLigue = new Set();
    if (typeof opt.paysDe === 'function') {
      for (const e of dernieres(c)) {
        for (const nom of [e.dom, e.ext]) {
          try {
            if (!opt.paysDe(nom, cle)) sansDrapeau.add(nom);
            else if (!opt.paysDe(nom)) parLaLigue.add(nom);
          } catch (x) { /* jamais bloquant */ }
        }
      }
    }
    out.parCoupe[cle] = { suivie: suivies().has(cle), famille: famille(cle), mesure: m,
                          espn: { lu: c.espnLu ? new Date(c.espnLu).toISOString() : null, panne: c.espnPanne || null, nonAppariees: c.nonAppariees || [] },
                          sansDrapeau: [...sansDrapeau].sort().slice(0, 60), drapeauParLaLigue: [...parLaLigue].sort().slice(0, 60),
                          porte: porte(cle, m, null, t) };
    const f = out.familles[famille(cle)] || (out.familles[famille(cle)] = { E: 0, C: 0, A: 0 });
    f.E += m.E; f.C += m.C; f.A += m.A;
  }
  try { out.doublons = doublons(opt.matchs, t, inv); } catch (e) { out.doublons = []; }
  return out;
}

/** Les lignes du journal de l'hote : l'inventaire (apres un import), la porte (une fois par jour). */
function lignesInventaire(now, o) {
  const t = Number(now) || Date.now();
  const inv = lisInventaire(), out = [];
  for (const cle of suivies()) {
    const c = inv.coupes[cle] || {};
    const m = mesure(cle, t, inv, lisSuivi());
    const na = (c.nonAppariees || []).slice(0, 5).map((x) => '« ' + x.affiche + ' » ' + x.debut.slice(0, 10) + ' (ESPN meme jour : ' + (x.espnMemeJour.slice(0, 6).join(', ') || 'rien') + ')');
    out.push(`[odds] coupe inventaire ${cle} : ${m.aVenir7j} a venir (7 j), ${m.aVenir48h} sous 48 h` +
      (c.espnLu ? `, ESPN : ${(c.nonAppariees || []).length} non appariee(s)` + (c.espnPanne ? ' — ' + c.espnPanne : '') + (na.length ? ' : ' + na.join(' ; ') : '') : ', ESPN pas encore lu'));
  }
  const dbl = (o && o.matchs) ? doublons(o.matchs, t, inv) : [];
  for (const x of dbl.slice(0, 10)) out.push(`[odds] coupe DOUBLON ${x.coupe} « ${x.affiche} » aussi sous ${x.championnat} (${x.id}) : deux identifiants pour une rencontre`);
  return out;
}
function lignesPorte(now) {
  const t = Number(now) || Date.now(), out = [];
  const inv = lisInventaire(), suivi = lisSuivi();
  for (const cle of suivies()) {
    const m = mesure(cle, t, inv, suivi), p = porte(cle, m, null, t), k = p.criteres;
    out.push(`[odds] porte coupe ${cle} : E ${m.E}/${PORTE.eMin} · C ${k.C.valeur} · A ${k.A.valeur} · D hors serveur (outils/age_prix.js --coupes)` +
      ` · au plus tot ${k.date.auPlusTot} → ${p.verdict}`);
  }
  return out;
}
/** La ligne du demarrage, toujours ecrite (paris_import.planifie). */
function ligneDemarrage() {
  const obs = [...prixLigues.coupesObservees()], h = prixLigues.observeCoupesH();
  const dem = [...prixLigues.coupesDemandees()];
  return `[odds] coupes : vendues ${prixLigues.coupes().size}` + (dem.length && !prixLigues.VENTE_COUPES_CONSTRUITE ? ` (PARIS_COUPES ignoree : vente pas construite, lot 10)` : '') +
    `, observees ${obs.length}${obs.length ? ' (' + obs.join(', ') + ')' : ''}, ` +
    (obs.length && h > 0 ? `releve d observation a moins de ${h} h (classe 3) et forcee T-45/T-20 (classe 2)` : obs.length ? 'inventaire seul (0 credit)' : 'rien (0 credit)');
}

module.exports = { V, GARDE_JOURS, FORCEE_DE, FORCEE_A, FORCEE_SI_AVANT, ESPN_AVANT_MS, ESPN_APRES_MS, PORTE, N_MIN_D,
                   fichierInventaire, fichierSuivi, suivies, lisFichier, lisInventaire, lisSuivi, noteInventaire, dernieres, aVenir, forcees,
                   prendreUneFois, apparieEspn, noteSuivi, branche, mesure, wilsonHaut, nMinD, famille, porte, doublons, etat,
                   lignesInventaire, lignesPorte, ligneDemarrage };
