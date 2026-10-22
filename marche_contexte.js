'use strict';
/* ==================================================================
 * LE CONTEXTE DE MARCHE BTC / ETH — OBSERVATION SEULE
 * ==================================================================
 *
 * Demande du proprietaire (21/10/2026) : « le marche general des cryptos,
 * surtout ETH et BTC, est important : si le marche est baissier c'est surement
 * plus complique d'avoir du volume ». On MESURE d'abord : la colonie gagne-t-elle
 * moins quand BTC baisse ? moins de lancements survivent-ils ?
 *
 * Ce module ne decide RIEN : aucune regle d'achat ni de vente ne le lit. Il
 * tient une SERIE HORAIRE des prix BTC et ETH en dollars, et repond, pour un
 * instant t quelconque (l'ouverture d'un trade du carnet, la naissance d'un
 * lancement), « ou en etait le marche » : variation sur 24 h et sur 7 jours.
 * Comme la serie remonte 90 jours au premier demarrage, elle juge
 * RETROACTIVEMENT les ~300 trades du carnet depuis le 14/09 — sans ecrire un
 * champ de plus dans les lignes : le contexte se recalcule a la volee depuis t0.
 *
 * ---- LA SOURCE : COINGECKO, UN APPEL PAR HEURE (lecture de la doc, 22/10/2026) ----
 *   - le releve : GET /coins/markets?vs_currency=usd&ids=bitcoin,ethereum
 *     (mesure sans cle le 22/10 : HTTP 200, 1 650 octets, les deux prix) ; rien
 *     d'autre dans l'URL : seul `current_price` est lu (la relecture du 22/10 a
 *     retire `price_change_percentage=24h,7d`, demande et jamais lu : 1 896 octets) ;
 *     UN appel par heure, jamais plus d'un point par heure dans la serie ;
 *   - le rattrapage, UNE fois : GET /coins/{bitcoin,ethereum}/market_chart
 *     ?vs_currency=usd&days=90 — la doc dit « 2–90 days → hourly, above 90 →
 *     daily » : 90 est le maximum horaire, ~2 160 points chacun ;
 *   - la capitalisation TOTALE (/global) n'est PAS relevee : c'est un second
 *     appel, et market_chart ne la rattrape pas (il rend la capitalisation d'une
 *     piece, pas celle du marche) — une serie qui ne couvrirait pas le carnet
 *     passe ne jugerait rien retroactivement. BTC + ETH portent l'essentiel.
 *
 * ---- LA CLE : PAR LA PORTE DE LA COLONIE, LA PLUPART DU TEMPS ----
 * La cle CoinGecko du proprietaire (COINGECKO_API_KEY, CG_CREDITS_MOIS = 100 000
 * credits/mois) est partagee avec la colonie, qui la tient A SON RYTHME : elle lit
 * par la cle tant que ses credits utilises sont sous le prorata du mois ecoule
 * (`cleDansLeBudget`, fractionnaire), sans cle au-dela — son compteur SUIT donc la
 * ligne du prorata. Mesure sur les 8 releves distincts de /ai/colonie du 15 au
 * 21/10 (_releves/) : utilises = permisAMaintenant a ±2 credits a chaque releve
 * (46 892 / 46 894 le 15/10 12:53 UTC … 67 293 / 67 293 le 21/10 20:39 UTC), et
 * la porte `dansLeBudget` OUVERTE sur 7 releves sur 8 — fermee une seule fois, le
 * 18/10 12:12 UTC (56 481 pour 56 480). La porte oscille autour de la ligne et
 * un releve horaire la trouve ouverte la plupart du temps : la serie passe par la
 * cle la plupart du temps, ~630 a 722 credits par mois (720 releves + 2 de
 * rattrapage, 7/8 a 8/8 d'entre eux) debites du MEME compteur que la colonie
 * (`debite`), soit 0,6–0,7 % du budget — huit instants, pas une part du temps : la part
 * REELLE se lit sur `compteurs.parCle` / `sansCle` de /ai/marche, a relire apres un mois.
 * Chacun repousse une lecture de la colonie
 * vers l'acces libre, qui en comptait deja 53 061 sur 120 354 au 21/10 (44 %) :
 * le budget le supporte sans marge, et le plafond du mois reste tenu par la porte
 * de la colonie (le compteur est le meme). La premiere version de ce commentaire
 * (22/10) disait « sans cle jusqu'au 1er » sur le seul releve du 18/10 :
 * c'etait faux, corrige a la relecture du 22/10 sur les huit.
 * Regle : par la cle (porte sondee par la colonie, en-tete `x-cg-pro-api-key` sur
 * pro-api.coingecko.com ou `x-cg-demo-api-key` sur api.coingecko.com) quand
 * `dansLeBudget` est vrai a l'instant du releve ; sinon SANS cle sur l'hote public
 * api.coingecko.com (limite par IP, partagee : 2 appels sur 3 refuses « Throttled »
 * depuis la machine d'essai le 22/10 ; d'ou la reprise a 5 min, trois fois au plus
 * par heure). La cle n'apparait jamais dans la vue ni dans un message d'erreur.
 *
 * ---- LES TRANCHES (CHOISIES, pas mesurees) ----
 * 24 h : < -3 %, -3..0 %, 0..3 %, > 3 % ; 7 jours : < -5 %, -5..0 %, 0..5 %,
 * > 5 %. Assez larges pour qu'une tranche ne soit pas du bruit de quelques
 * dixiemes, assez etroites pour que les quatre se remplissent sur ~300 trades.
 * A revoir sur la mesure : chaque bilan donne le n de chaque tranche.
 *
 * Stockage : DATA_DIR/marche/serie.json, { v, backfill, points: [[t, btc, eth]] }
 * (t en ms, btc arrondi au dollar, eth au centime) ; ~30 octets par point,
 * 8 760 par an : garde sans limite.
 * ================================================================== */
const fs = require('fs');
const path = require('path');

const HEURE_MS = 3600e3;
const JOUR_MS = 86400e3;
/* Un instant est « couvert » si la serie a un point a moins de 2 h. CHOISI : la
   serie est horaire et un trade de la colonie dure 20–120 min ; au-dela de 2 h on
   ne sait pas, et on le dit (null) plutot que d'inventer. */
const TOLERANCE_MS = 2 * HEURE_MS;
const JOURS_BACKFILL = 90;          /* le maximum horaire de market_chart (doc : « 2–90 days → hourly ») */
/* CHOISI : premier releve 60 s apres le demarrage. La colonie lance un tour tout de suite et sonde sa
   porte CoinGecko a sa premiere lecture GeckoTerminal (sondeCoingecko est paresseuse) ; a 60 s le
   premier releve trouve une porte decidee au lieu de partir sans cle a coup sur, et il ne s'ajoute
   pas a la rafale d'appels du demarrage. */
const PREMIER_MS = 60e3;
const REPRISE_MS = 5 * 60e3;        /* un releve refuse (429 partage) est repris 5 min plus tard */
/* CHOISI : trois reprises au plus dans l'heure — un refus par IP partagee dure quelques minutes, pas
   une heure ; au-dela on attend la cadence suivante plutot que d'insister sur un hote qui refuse. */
const REPRISES_MAX = 3;
/* CHOISI : 20 s par appel — large pour un releve horaire qui peut attendre, court devant les 5 min de
   la reprise ; au-dela c'est un refus comme un autre : note, compte, repris. */
const DELAI_MS = 20000;
/* CHOISI : 1,5 s entre les deux market_chart du rattrapage — l'hote public compte par IP (~30 appels
   par minute partages, EXPLOITATION § COINGECKO_API_KEY) et deux appels colles juste apres le releve
   de l'heure sont la rafale qu'il refuse ; 1,5 s les espace sans retarder le rattrapage de facon visible. */
const PAUSE_BACKFILL_MS = 1500;
/* CHOISI : la vue garde les 5 dernieres erreurs — un refus repris trois fois dans l'heure fait quatre
   lignes, il en reste une pour la precedente ; jamais une liste qui grossit sans fin. */
const ERREURS_MAX = 5;

const HOTE_PUBLIC = 'https://api.coingecko.com/api/v3';
const HOTE_PRO = 'https://pro-api.coingecko.com/api/v3';
const ENTETE = { pro: 'x-cg-pro-api-key', demo: 'x-cg-demo-api-key' };

const TRANCHES = { '24h': [-3, 0, 3], '7d': [-5, 0, 5] };
const AXES = ['btc24h', 'btc7d', 'eth24h', 'eth7d'];
const SANS = 'no market data';
const fini = (x) => typeof x === 'number' && isFinite(x);
const heure = (t) => Math.floor(t / HEURE_MS);

/** L'etiquette d'une variation sur un axe ('btc24h', 'eth7d'…), ou null si la valeur manque. */
function trancheDe(axe, v) {
  const m = /^(btc|eth)(24h|7d)$/.exec(String(axe));
  if (!m || !fini(v)) return null;
  const [a, b, c] = TRANCHES[m[2]], nom = m[1] + ' ' + m[2];
  return v < a ? nom + ' < ' + a + '%' : v < b ? nom + ' ' + a + '..' + b + '%' : v < c ? nom + ' ' + b + '..' + c + '%' : nom + ' > ' + c + '%';
}
/** Les quatre etiquettes d'un axe, dans l'ordre des bornes. */
function libelles(axe) {
  const m = /^(btc|eth)(24h|7d)$/.exec(String(axe));
  if (!m) return [];
  const [a, b, c] = TRANCHES[m[2]];
  return [trancheDe(axe, a - 1), trancheDe(axe, a), trancheDe(axe, b), trancheDe(axe, c)];
}
/** Le regime d'un contexte : une etiquette par axe (null la ou la serie ne couvre pas). */
function regimeDe(ctx) {
  if (!ctx) return null;
  const r = {};
  for (const a of AXES) r[a] = trancheDe(a, ctx[a]);
  return r;
}

/**
 * deps = { dossier (DATA_DIR), prendre (fetch), horloge () -> ms, dors (ms) -> Promise, env,
 *          cle: { valeur() -> string, porte() -> 'pro'|'demo'|'libre'|null, dansLeBudget() -> bool, debite() } }
 * `cle` est le cablage de la colonie (ai_colonie.js) : sans lui, tout passe sans cle.
 */
function cree(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const D = path.join(d.dossier || './data', 'marche');
  const FICHIER = path.join(D, 'serie.json');
  const maintenant = d.horloge || Date.now;
  const prendre = d.prendre || fetch;
  const dors = d.dors || ((ms) => new Promise((r) => setTimeout(r, ms)));
  /* les minuteries sont injectables (deps.setTimeout, setInterval, clearTimeout, clearInterval) pour que
     l'essai joue la reprise a 5 min sans attendre ; repli sur les globales */
  const tempo = { setTimeout: d.setTimeout || setTimeout, setInterval: d.setInterval || setInterval,
                  clearTimeout: d.clearTimeout || clearTimeout, clearInterval: d.clearInterval || clearInterval };
  const eteint = String(env.MARCHE_CONTEXTE == null ? '' : env.MARCHE_CONTEXTE).trim() === '0';
  /* la serie, triee par t, un point par heure */
  let P = [];
  let backfill = { fait: false, t: null, points: 0, essais: 0, derniereErreur: null };
  const C = { releves: 0, reussites: 0, erreurs: 0, doublonsHeure: 0, parCle: 0, sansCle: 0, pointsAjoutes: 0 };
  const erreurs = [];
  let dernier = null;       /* { t, etat, statut } */
  let enCours = false;
  let minuteries = [];
  let reprises = { heure: null, n: 0 };

  /* ---- la cle ne sort jamais d'ici ---- */
  const cleValeur = () => { try { return d.cle && d.cle.valeur ? String(d.cle.valeur() || '').trim() : ''; } catch (e) { return ''; } };
  const masque = (s) => { let t = String(s == null ? '' : s); const k = cleValeur(); if (k) t = t.split(k).join('<key>'); return t.slice(0, 120); };
  const noteErreur = (quoi, e) => {
    C.erreurs++;
    const txt = masque(quoi + ': ' + ((e && e.message) || e));
    erreurs.push({ t: maintenant(), txt }); if (erreurs.length > ERREURS_MAX) erreurs.shift();
    return txt;
  };
  /** La porte du moment : { base, entetes, parCle }. Par la cle seulement si la colonie l'a
   *  sondee ET est en avance sur son budget du mois ; sinon l'hote public, sans cle. */
  function porte() {
    const k = cleValeur();
    let p = null, dans = false;
    try { p = d.cle && d.cle.porte ? d.cle.porte() : null; dans = !!(d.cle && d.cle.dansLeBudget && d.cle.dansLeBudget()); } catch (e) { p = null; }
    if (k && (p === 'pro' || p === 'demo') && dans) return { base: p === 'pro' ? HOTE_PRO : HOTE_PUBLIC, entetes: { accept: 'application/json', [ENTETE[p]]: k }, parCle: true, nom: p };
    return { base: HOTE_PUBLIC, entetes: { accept: 'application/json' }, parCle: false, nom: 'keyless' };
  }
  async function lis(chemin) {
    const po = porte();
    const r = await prendre(po.base + chemin, { headers: po.entetes, signal: AbortSignal.timeout(DELAI_MS) });
    if (!r || !r.ok) { const e = new Error('HTTP ' + (r ? r.status : '?')); e.statut = r ? r.status : null; throw e; }
    const j = await r.json();
    if (po.parCle) { C.parCle++; try { if (d.cle && d.cle.debite) d.cle.debite(); } catch (e) { /* rien */ } } else C.sansCle++;
    return j;
  }

  /* ---- la serie ---- */
  function charge() {
    try {
      const j = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
      P = (Array.isArray(j.points) ? j.points : []).filter((x) => Array.isArray(x) && fini(x[0]) && fini(x[1]) && fini(x[2])).sort((a, b) => a[0] - b[0]);
      if (j.backfill && typeof j.backfill === 'object') backfill = Object.assign(backfill, j.backfill);
    } catch (e) { /* premier demarrage */ }
  }
  function sauve() {
    try {
      fs.mkdirSync(D, { recursive: true });
      fs.writeFileSync(FICHIER + '.tmp', JSON.stringify({ v: 1, backfill, points: P }));
      fs.renameSync(FICHIER + '.tmp', FICHIER);
    } catch (e) { noteErreur('write', e); }
  }
  /** L'indice du dernier point a t' <= t (ou -1). */
  function avant(t) {
    let lo = 0, hi = P.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (P[m][0] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  /** Ajoute un point si son heure est libre. Rend true s'il est entre. */
  function ajoute(t, btc, eth) {
    if (!fini(t) || !fini(btc) || !fini(eth) || btc <= 0 || eth <= 0) return false;
    const i = avant(t);
    if ((i >= 0 && heure(P[i][0]) === heure(t)) || (i + 1 < P.length && heure(P[i + 1][0]) === heure(t))) { C.doublonsHeure++; return false; }
    P.splice(i + 1, 0, [Math.round(t), Math.round(btc), Math.round(eth * 100) / 100]);
    C.pointsAjoutes++;
    return true;
  }
  /** Le point qui dit le prix a t : le dernier a t' <= t s'il a moins de 2 h, sinon le premier apres
   *  s'il est a moins de 2 h, sinon null. */
  function pointA(t) {
    if (!fini(t) || !P.length) return null;
    const i = avant(t);
    if (i >= 0 && t - P[i][0] <= TOLERANCE_MS) return P[i];
    if (i + 1 < P.length && P[i + 1][0] - t <= TOLERANCE_MS) return P[i + 1];
    return null;
  }
  const pct = (a, b) => (fini(a) && fini(b) && a > 0 && b > 0 ? Math.round((a / b - 1) * 10000) / 100 : null);
  /** PUR : le contexte a l'instant t, ou null si la serie ne couvre pas t. Les references sont
   *  ancrees sur l'INSTANT DU POINT RETENU (p.t - 24 h, p.t - 7 j), pas sur t : le point retenu peut
   *  etre a 2 h de t, et une reference cherchee a t - 24 h cumulait DEUX tolerances — une
   *  « variation 24 h » de 20 a 28 h selon le trou de la serie (relecture du 22/10 : serie
   *  [T-26h:100, T-24h:110, T:99], contexteA(T-2h) retenait T et comparait a T-26h → -1 % au lieu
   *  de -10 %). Ancree sur p, la reference garde sa seule tolerance de ±2 h : 22 a 26 h quand le
   *  point a p.t - 24 h manque (TOLERANCE_MS, choisi). Un axe dont la reference manque est null,
   *  jamais invente. */
  function contexteA(t) {
    const p = pointA(t);
    if (!p) return null;
    const p24 = pointA(p[0] - JOUR_MS), p7 = pointA(p[0] - 7 * JOUR_MS);
    return { t: p[0], btc: p[1], eth: p[2],
      btc24h: pct(p[1], p24 && p24[1]), btc7d: pct(p[1], p7 && p7[1]),
      eth24h: pct(p[2], p24 && p24[2]), eth7d: pct(p[2], p7 && p7[2]) };
  }

  /* ---- les lectures ---- */
  /** Le releve de l'heure : un appel, un point. */
  async function releveCourant() {
    const j = await lis('/coins/markets?vs_currency=usd&ids=bitcoin,ethereum');
    if (!Array.isArray(j)) throw new Error('unexpected body');
    const prix = (id) => { const x = j.find((c) => c && c.id === id); return x ? Number(x.current_price) : NaN; };
    const btc = prix('bitcoin'), eth = prix('ethereum');
    if (!fini(btc) || !fini(eth)) throw new Error('missing price');
    return ajoute(maintenant(), btc, eth);
  }
  /** Le rattrapage, une fois : 90 jours horaires de BTC puis d'ETH, fusionnes par heure ; les deux
   *  ou rien (un point sans l'une des deux pieces ne servirait pas). */
  async function rattrape() {
    backfill.essais++;
    const serie = async (id) => {
      const j = await lis('/coins/' + id + '/market_chart?vs_currency=usd&days=' + JOURS_BACKFILL);
      const l = j && Array.isArray(j.prices) ? j.prices : null;
      if (!l || !l.length) throw new Error(id + ': no prices');
      const parHeure = new Map();
      for (const x of l) if (Array.isArray(x) && fini(Number(x[0])) && fini(Number(x[1])) && Number(x[1]) > 0) { const h = heure(Number(x[0])); if (!parHeure.has(h)) parHeure.set(h, [Number(x[0]), Number(x[1])]); }
      return parHeure;
    };
    const btc = await serie('bitcoin');
    await dors(PAUSE_BACKFILL_MS);
    const eth = await serie('ethereum');
    let n = 0;
    for (const [h, [t, v]] of btc) { const e = eth.get(h); if (e && ajoute(t, v, e[1])) n++; }
    backfill = { fait: true, t: maintenant(), points: n, essais: backfill.essais, derniereErreur: null };
    return n;
  }
  /** Un releve complet : le point de l'heure, puis le rattrapage s'il n'a jamais reussi. */
  async function releve() {
    /* etat ∈ read | error | busy | off : servi tel quel par /ai/marche, route publique, donc en anglais */
    if (eteint) return { etat: 'off' };
    if (enCours) return { etat: 'busy' };
    enCours = true;
    const t = maintenant();
    C.releves++;
    let r = { etat: 'read', t, point: false, backfill: null };
    try {
      try { r.point = await releveCourant(); C.reussites++; }
      catch (e) { r = { etat: 'error', t, statut: e.statut || null, erreur: noteErreur('fetch', e) }; }
      if (!backfill.fait) {
        try { r.backfill = await rattrape(); }
        catch (e) { backfill.derniereErreur = noteErreur('backfill', e); r.backfill = null; }
      }
      sauve();
      dernier = { t, etat: r.etat, statut: r.statut || null };
      return r;
    } finally { enCours = false; }
  }

  function planifie() {
    if (eteint) { console.log('[marche] ETEINT : MARCHE_CONTEXTE=0 (la serie sur le disque sert encore le contexte passe)'); return null; }
    console.log('[marche] ARME : BTC/ETH horaires par CoinGecko (observation seule, aucune decision), premier releve dans ' + Math.round(PREMIER_MS / 1000) + ' s, rattrapage ' + (backfill.fait ? 'deja fait (' + backfill.points + ' points)' : JOURS_BACKFILL + ' j au premier releve'));
    const f = () => releve().then((r) => {
      if (r && r.etat === 'error') {
        /* repris 5 min plus tard, trois fois par heure au plus : l'hote public refuse par IP partagee */
        const h = heure(maintenant());
        if (reprises.heure !== h) reprises = { heure: h, n: 0 };
        if (reprises.n < REPRISES_MAX) {
          reprises.n++;
          /* le handle quitte `minuteries` quand il tire : garde, trois par heure feraient ~26 000 entrees mortes par an */
          const x = tempo.setTimeout(() => { minuteries = minuteries.filter((m) => m[1] !== x); return f(); }, REPRISE_MS);
          if (x && x.unref) x.unref(); minuteries.push(['t', x]);
        }
      }
    }).catch(() => {});
    const premier = tempo.setTimeout(f, PREMIER_MS); if (premier && premier.unref) premier.unref();
    const minuterie = tempo.setInterval(f, HEURE_MS); if (minuterie && minuterie.unref) minuterie.unref();
    minuteries.push(['t', premier], ['i', minuterie]);
    return { arrete };
  }
  function arrete() { for (const [k, x] of minuteries) (k === 't' ? tempo.clearTimeout : tempo.clearInterval)(x); minuteries = []; }

  /** La vue : la serie, le dernier releve, le rattrapage, les compteurs, les erreurs (jamais la cle),
   *  et le contexte COURANT avec son regime. */
  function vue() {
    const now = maintenant();
    const c = contexteA(now);
    const p0 = P[0] || null, p1 = P[P.length - 1] || null;
    return {
      actif: !eteint, source: 'CoinGecko /coins/markets hourly, /coins/{id}/market_chart days=90 once',
      porte: porte().nom, points: P.length,
      premier: p0 ? p0[0] : null, dernierPoint: p1 ? { t: p1[0], btc: p1[1], eth: p1[2] } : null,
      dernierReleve: dernier, backfill, compteurs: Object.assign({}, C), erreurs: erreurs.slice(),
      tranches: TRANCHES, tolerance: TOLERANCE_MS,
      courant: c ? Object.assign({}, c, { regime: regimeDe(c) }) : null,
    };
  }

  charge();
  return { contexteA, regimeDe, trancheDe, libelles, releve, planifie, arrete, vue, _points: () => P };
}

module.exports = { cree, regimeDe, trancheDe, libelles, TRANCHES, AXES, SANS, TOLERANCE_MS, HEURE_MS, JOURS_BACKFILL, PREMIER_MS, REPRISE_MS, REPRISES_MAX, HOTE_PUBLIC, HOTE_PRO };
