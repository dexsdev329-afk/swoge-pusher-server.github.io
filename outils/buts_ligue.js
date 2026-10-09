'use strict';
/*
 * LE TOTAL DE BUTS DE CHAQUE CHAMPIONNAT — ecrit `paris_buts.json`.
 *
 *   node outils/buts_ligue.js            telecharge et ecrit paris_buts.json
 *   node outils/buts_ligue.js --voir     n'ecrit rien, montre la table
 *   node outils/buts_ligue.js --csv DIR  lit les CSV dans DIR (<code>_<saison>.csv, USA.csv, MEX.csv)
 *   node outils/buts_ligue.js --partiel  ecrit meme si un fichier manque (debut de saison)
 *
 * A relancer une fois par mois, puis committer paris_buts.json (~50 s).
 *
 * Source : les CSV publics de football-data.co.uk (mmz4281 pour les quatorze
 * championnats europeens, new/ pour la MLS et la Liga MX). AUCUN credit The
 * Odds API, aucune cle. La Ligue des champions n'y est pas : ses rencontres
 * prennent le niveau commun (`global`), comme tout championnat inconnu.
 *
 * La meme fonction `table` sert au banc d'essai (depuis `histo`, jour par
 * jour) : le chiffre mesure est celui que la production lit.
 *
 *   niveau a(ligue) = buts moyens - pente x d2 moyen sur les `fenetre`
 *                     derniers jours, RETRECI vers le niveau de tous les
 *                     championnats ensemble avec un poids de `k` matchs ;
 *   total(match)    = a(ligue) + pente x d2(match), d2 = (p1 - p2)^2 du
 *                     1-N-2 vendu (cotes.totalDe).
 *
 * d2 de l'historique : le 1-N-2 d'ouverture du marche (Pinnacle, a defaut la
 * bourse Betfair, a defaut la moyenne), marge retiree par la puissance
 * (cotes.probasImplicites) ; MLS et Liga MX n'ont que la cloture.
 * Commentaires sans accents (convention de cotes.js).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const JOUR = 86400000;

/* ---- LE REGLAGE, ET LA MESURE QUI L'A FIXE ----
 * Banc commun du modele de buts (08/10/2026), football-data 2018/19-2026/27,
 * decisions lues sur l'APPRENTISSAGE 2018/19-2022/23 (25 420 rencontres au
 * chemin de production), verifiees sur le TEST 2023/24-2026/27 (15 986) ;
 * log-loss du score exact a l'apprentissage, actuel (ajusteButs) 2,8858 :
 *   pente 1,44 +-0,14 but par unite de d2 (marche, centree par ligue, 25 362
 *     matchs ; 1,54 +-0,17 sur le test) — sans elle (total plat) 2,8747 et
 *     7,7 % d'issues plus/moins battables, avec 2,8669 et 4,4 % ;
 *   compressionElo 0,805 : d2 Elo / d2 marche sur ces memes matchs ;
 *   fenetre 365 jours, k = 40 matchs (k optimal attendu : variance d'un
 *     match / variance entre ligues = 2,8 / 0,28^2 ~ 36) ; 730 jours et
 *     k = 150 : 2,8675 et 4,7 % ; k = 400 : +0,0022 +-0,0009 ;
 *   poidsMarche 0,75 (chemin du marche, voir cotes.totalDe) : 1 / 0,75 / 0,5
 *     essayes, 0,75 garde, -0,0015 +-0,0009 contre 1 (9 028 matchs). */
const REGLAGE = { fenetre: 365, k: 40, pente: 1.44, compressionElo: 0.805, poidsMarche: 0.75, aDefaut: 2.70, d2Defaut: 0.10 };

/** passes : Map ligue -> [{ t, hg, ag, p }] (p = 1-N-2 du marche sans marge,
 *  ou null), ordre chronologique. Seuls les matchs anterieurs a `tFin` comptent.
 *  Rend { global: { a, buts, d2, n }, ligues: { lg: { a, aBrut, buts, d2, n, nd2 } } }. */
function table(passes, tFin, o) {
  const fenetre = o.fenetre * JOUR, k = o.k, pente = o.pente || 0;
  const out = { ligues: {} };
  const G = { s: 0, n: 0, sd: 0, nd: 0 };
  for (const [lg, L] of passes) {
    let s = 0, n = 0, sd = 0, nd = 0;
    for (let i = L.length - 1; i >= 0; i--) {
      const m = L[i];
      if (m.t >= tFin) continue;
      if (m.t < tFin - fenetre) break;
      s += m.hg + m.ag; n++;
      if (m.p) { sd += (m.p[1] - m.p[2]) ** 2; nd++; }
    }
    out.ligues[lg] = { s, n, sd, nd };
    G.s += s; G.n += n; G.sd += sd; G.nd += nd;
  }
  const aDe = (x) => (x.n ? x.s / x.n - pente * (x.nd ? x.sd / x.nd : 0) : null);
  const aG = aDe(G);
  out.global = { a: aG === null ? o.aDefaut - pente * o.d2Defaut : aG, buts: G.n ? G.s / G.n : null,
    d2: G.nd ? G.sd / G.nd : null, n: G.n };
  for (const [lg, x] of Object.entries(out.ligues)) {
    const ab = aDe(x);
    const a = ab === null ? out.global.a : (x.n * ab + k * out.global.a) / (x.n + k);
    out.ligues[lg] = { a, aBrut: ab, buts: x.n ? x.s / x.n : null, d2: x.nd ? x.sd / x.nd : null, n: x.n, nd2: x.nd };
  }
  return out;
}

/** Le biais d'ajusteButs par ligue (variante « recentre » du chemin du marche) :
 *  moyenne de (T d'ajusteButs sur le 1-N-2 du marche - buts reels), retrecie
 *  vers le biais de tous les championnats avec un poids de `k` matchs.
 *  Chaque element de `passes` porte alors `tj` (T d'ajusteButs) ou null. */
function biais(passes, tFin, o) {
  const fenetre = o.fenetre * JOUR, k = o.k;
  const out = { ligues: {} };
  let gs = 0, gn = 0;
  const brut = {};
  for (const [lg, L] of passes) {
    let s = 0, n = 0;
    for (let i = L.length - 1; i >= 0; i--) {
      const m = L[i];
      if (m.t >= tFin) continue;
      if (m.t < tFin - fenetre) break;
      if (m.tj === null || m.tj === undefined) continue;
      s += m.tj - (m.hg + m.ag); n++;
    }
    brut[lg] = { s, n }; gs += s; gn += n;
  }
  out.global = { b: gn ? gs / gn : 0.2, n: gn };
  for (const [lg, x] of Object.entries(brut))
    out.ligues[lg] = { b: x.n ? (x.s + k * out.global.b) / (x.n + k) : out.global.b, n: x.n };
  return out;
}

/** Le total d'une rencontre : niveau de la ligue + pente x d2 du 1-N-2 vendu
 *  (d2 de l'Elo ramene a l'echelle du marche par `compression`). Meme calcul
 *  que cotes.totalDe. */
function totalMatch(a, p, pente, compression) {
  const d2 = (p[1] - p[2]) ** 2 / (compression || 1);
  return a + (pente || 0) * d2;
}

/* ------------------------------------------------------------ le script */

/* cle The Odds API -> fichier football-data */
const SOURCES = {
  soccer_efl_champ: 'E1', soccer_france_ligue_two: 'F2', soccer_germany_bundesliga2: 'D2',
  soccer_spain_segunda_division: 'SP2', soccer_italy_serie_b: 'I2', soccer_netherlands_eredivisie: 'N1',
  soccer_portugal_primeira_liga: 'P1', soccer_belgium_first_div: 'B1', soccer_turkey_super_league: 'T1',
  soccer_epl: 'E0', soccer_spain_la_liga: 'SP1', soccer_italy_serie_a: 'I1', soccer_germany_bundesliga: 'D1',
  soccer_france_ligue_one: 'F1',
  soccer_usa_mls: 'new/USA', soccer_mexico_ligamx: 'new/MEX',
};

function decoupe(l) {
  const v = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') q = !q; else if (ch === ',' && !q) { v.push(cur); cur = ''; } else cur += ch;
  }
  v.push(cur);
  return v;
}
function litCsv(t) {
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  const L = t.split(/\r?\n/);
  const ent = decoupe(L[0]).map((s) => s.trim());
  const out = [];
  for (let k = 1; k < L.length; k++) {
    if (!L[k].trim()) continue;
    const v = decoupe(L[k]);
    const o = {};
    ent.forEach((h, i) => { if (h && o[h] === undefined) o[h] = (v[i] || '').trim(); });
    out.push(o);
  }
  return out;
}
const num = (x) => { const v = parseFloat(x); return isFinite(v) && v > 1 ? v : null; };
/* la premiere source complete et saine : Pinnacle, la bourse, la moyenne
   (ouverture ; MLS et Liga MX : cloture) — meme chaine que le banc */
const CHAINE = [[['PSH', 'PSD', 'PSA'], 1.08], [['BFEH', 'BFED', 'BFEA'], 1.06], [['AvgH', 'AvgD', 'AvgA'], 1.30],
  [['BbAvH', 'BbAvD', 'BbAvA'], 1.30], [['PSCH', 'PSCD', 'PSCA'], 1.08], [['BFECH', 'BFECD', 'BFECA'], 1.06],
  [['AvgCH', 'AvgCD', 'AvgCA'], 1.30]];
function marcheDe(r, cotes) {
  const iss = ['1', 'N', '2'];
  for (const [cols, haut] of CHAINE) {
    const c = {};
    if (!cols.every((k, i) => (c[iss[i]] = num(r[k])))) continue;
    const s = 1 / c[1] + 1 / c.N + 1 / c[2];
    if (s < 1 || s > haut) continue;
    const p = cotes.probasImplicites(c, iss, 1);
    if (p && iss.every((i) => p[i] > 0 && p[i] < 1)) return p;
  }
  return null;
}
function matchsDe(lignes, cotes) {
  const out = [];
  for (const r of lignes) {
    const md = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(r.Date || '');
    const hg = Number(r.FTHG !== undefined ? r.FTHG : r.HG), ag = Number(r.FTAG !== undefined ? r.FTAG : r.AG);
    if (!md || !Number.isInteger(hg) || !Number.isInteger(ag) || (r.FTHG === '' || r.HG === '')) continue;
    const an = md[3].length === 2 ? 2000 + Number(md[3]) : Number(md[3]);
    const [hh, mi] = (r.Time || '15:00').split(':').map(Number);
    out.push({ t: Date.UTC(an, Number(md[2]) - 1, Number(md[1]), hh || 0, mi || 0), hg, ag, p: marcheDe(r, cotes) });
  }
  return out.sort((a, b) => a.t - b.t);
}
function telechargeHttps(url) {
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'User-Agent': 'swoge-buts-ligue' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return ok(telechargeHttps(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) { res.resume(); return ko(new Error(`${url} : HTTP ${res.statusCode}`)); }
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => { t += d; }); res.on('end', () => ok(t));
    }).on('error', ko);
  });
}
/* les deux saisons qui couvrent les 365 derniers jours (saison europeenne : juillet) */
function saisons(maintenant) {
  const d = new Date(maintenant), a = d.getUTCFullYear() % 100, juillet = d.getUTCMonth() >= 6;
  const deb = juillet ? a : a - 1;
  const code = (x) => String((x + 100) % 100).padStart(2, '0') + String((x + 101) % 100).padStart(2, '0');
  return [code(deb - 1), code(deb)];
}

/** Calcule la table et l'ecrit. Tout est injectable pour l'essai :
 *  o.telecharge(url) -> texte, o.maintenant, o.csv (dossier local), o.voir,
 *  o.partiel, o.fichier, o.cotes.
 *  ---- UN TELECHARGEMENT RATE, ET RIEN N'EST ECRIT ----
 *  Une table ecrite malgre un fichier manquant serait datee du jour avec un
 *  championnat prive de sa saison en cours : l'air frais, le chiffre vieux
 *  (relecture du 09/10/2026). Le script s'arrete sans rien ecrire, sauf
 *  --partiel (debut de saison, quand football-data n'a pas encore ouvert le
 *  fichier de la nouvelle) ; la table dit alors ce qui manquait (`partiel`).
 *  L'ecriture passe par un fichier temporaire renomme : jamais a moitie. */
async function principal(o) {
  const cotes = o.cotes || require(path.join(__dirname, '..', 'cotes.js'));
  const telecharge = o.telecharge || telechargeHttps;
  const maintenant = o.maintenant || Date.now();
  const passes = new Map(), infos = {}, rates = [];
  const lis = async (code, nomLocal, url) => {
    let lignes;
    try { lignes = litCsv(o.csv ? fs.readFileSync(path.join(o.csv, nomLocal), 'utf8') : await telecharge(url)); }
    catch (e) { rates.push(`${code} : ${e.message}`); return []; }
    /* Un 200 qui n'est pas un CSV de football-data (page d'erreur, fichier
       vide) se lisait comme une saison sans match : la table s'ecrivait sans
       « partiel » (relecture du 09/10). C'est un rate. */
    if (!lignes.length || !('Date' in lignes[0])) { rates.push(`${code} : pas un CSV de football-data (${lignes.length} ligne(s))`); return []; }
    return lignes;
  };
  for (const [cle, code] of Object.entries(SOURCES)) {
    const lignes = [];
    if (code.startsWith('new/')) lignes.push(...await lis(code, code.slice(4) + '.csv', `https://www.football-data.co.uk/${code}.csv`));
    else for (const s of saisons(maintenant))
      lignes.push(...await lis(`${code} ${s}`, `${code}_${s}.csv`, `https://www.football-data.co.uk/mmz4281/${s}/${code}.csv`));
    const L = matchsDe(lignes, cotes);
    passes.set(cle, L);
    infos[cle] = { fd: code, jusqua: L.length ? new Date(L[L.length - 1].t).toISOString().slice(0, 10) : null };
  }
  if (rates.length && !o.partiel) {
    throw new Error(`[buts] ${rates.length} fichier(s) illisible(s), paris_buts.json n'est PAS ecrit : ${rates.join(' ; ')}`
      + ' — relancer plus tard, ou --partiel si la nouvelle saison n\'est pas encore publiee');
  }
  const tab = table(passes, maintenant, REGLAGE);
  /* le biais d'ajusteButs, pour le chemin du marche : son total tire du nul
     du marche, moins ce qu'il surestime en moyenne dans ce championnat */
  const memo = new Map();             // ajusteButs est une fonction pure du 1-N-2 : ~7 ms par appel
  const tjDe = (p) => { const k = p[1] + '|' + p.N; if (!memo.has(k)) memo.set(k, cotes.ajusteButs(p[1], p.N, p[2]).total); return memo.get(k); };
  for (const L of passes.values())
    for (const m of L) m.tj = (m.p && m.t >= maintenant - REGLAGE.fenetre * JOUR) ? tjDe(m.p) : null;
  const bi = biais(passes, maintenant, REGLAGE);
  const sortie = {
    calcule: new Date(maintenant).toISOString().slice(0, 10),
    jusqua: null,
    source: 'football-data.co.uk (mmz4281, new/USA, new/MEX) — outils/buts_ligue.js',
    fenetre: REGLAGE.fenetre, k: REGLAGE.k, pente: REGLAGE.pente, compressionElo: REGLAGE.compressionElo,
    poidsMarche: REGLAGE.poidsMarche,
    global: { a: +tab.global.a.toFixed(4), b: +bi.global.b.toFixed(4), buts: tab.global.buts && +tab.global.buts.toFixed(4), n: tab.global.n },
    ligues: {},
  };
  if (rates.length) sortie.partiel = rates;
  for (const [cle, x] of Object.entries(tab.ligues)) {
    /* moins de cent matchs dans la fenetre : la ligue n'est pas ecrite ; ses
       rencontres prennent alors le niveau commun (`global`), comme un
       championnat inconnu — pas un chiffre tire de trois journees */
    if (x.n < 100) { console.error(`[buts] ${cle} : ${x.n} matchs, ligue non ecrite (niveau commun)`); continue; }
    const y = bi.ligues[cle];
    sortie.ligues[cle] = Object.assign({ a: +x.a.toFixed(4), b: +y.b.toFixed(4), buts: +x.buts.toFixed(4),
      d2: x.d2 === null ? null : +x.d2.toFixed(4), n: x.n, nb: y.n }, infos[cle]);
  }
  sortie.jusqua = Object.values(sortie.ligues).map((x) => x.jusqua).filter(Boolean).sort().pop() || null;
  const texte = JSON.stringify(sortie, null, 1) + '\n';
  if (o.voir) { process.stdout.write(texte); return sortie; }
  const f = o.fichier || path.join(__dirname, '..', 'paris_buts.json');
  fs.writeFileSync(f + '.tmp', texte);
  fs.renameSync(f + '.tmp', f);
  console.log(`[buts] ${path.basename(f)} : ${Object.keys(sortie.ligues).length} championnats, global a = ${sortie.global.a}, donnees jusqu'au ${sortie.jusqua}`);
  return sortie;
}

module.exports = { table, biais, totalMatch, REGLAGE, SOURCES, matchsDe, litCsv, saisons, principal, JOUR };
if (require.main === module) {
  const arg = process.argv.slice(2), iCsv = arg.indexOf('--csv');
  principal({ voir: arg.includes('--voir'), partiel: arg.includes('--partiel'), csv: iCsv >= 0 ? arg[iCsv + 1] : null })
    .catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
