'use strict';
/*
 * LES JOURNAUX SYNTHETIQUES DU DIRECT EN JEU (lot 7, 11/10/2026).
 *
 * Fabriques en faisant tourner le VRAI module (`paris_en_jeu.planifie`, son
 * tic, son journal) contre un faux fournisseur et un faux ESPN dont on connait
 * la verite : buts et rouges de Poisson, prix de la bourse = probabilite vraie
 * (Poisson sur le temps restant, la marge de la bourse a 1 %), ESPN qui montre
 * un fait L s apres. Aucun reseau, aucun credit. La meme verite donne trois
 * journaux :
 *   'sain'     la bourse se suspend 40 s a chaque fait (last_update fige), puis
 *              rouvre au prix d'apres ; ESPN a 20 s ;
 *   'retard'   la MEME bourse vue avec 60 s de retard : le prix d'il y a 60 s,
 *              mais un last_update frais (le fournisseur la voit, elle ment) ;
 *   'figee'    une bourse qui ne bouge jamais (prix d'avant-match, last_update
 *              frais) et un ESPN lent (200 s) : la fuite grossiere, pour
 *              montrer que G1 sait rougir.
 * La porte doit dire : sain -> verte, retard -> rouge (G2), figee -> rouge (G1).
 * `horlogeS` (5 par defaut) retarde TOUT le tableau d'ESPN (etat et horloge),
 * `espnS` les faits : la relecture du 11/10/2026 a montre qu'un ESPN en retard
 * de 45 s rendait verte la bourse en retard de 60 s (T_E date en retard).
 */
const fs = require('fs');
const path = require('path');

const P1_ARRET = 120, MT = 900, P2_ARRET = 240, SUSP = 40;
const CLUBS = [['Real Madrid', 'soccer_spain_la_liga', 'esp.1'], ['Barcelona', 'soccer_spain_la_liga', 'esp.1'],
               ['Bayern Munich', 'soccer_germany_bundesliga', 'ger.1'], ['Liverpool', 'soccer_epl', 'eng.1'],
               ['Arsenal', 'soccer_epl', 'eng.1'], ['Inter Milan', 'soccer_italy_serie_a', 'ita.1']];
const ADVERSES = ['Getafe', 'Sevilla', 'Valencia', 'Osasuna', 'Wolfsburg', 'Freiburg', 'Everton', 'Fulham',
                  'Brentford', 'Burnley', 'Lecce', 'Torino', 'Cagliari', 'Girona', 'Mallorca', 'Augsburg'];

function rng(graine) { let s = graine >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function pois(l, k) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
/* la probabilite vraie du 1-N-2 : Poisson sur le temps de jeu restant */
function proba(h, a, lh, la, restS) {
  const mh = lh * restS / 5400, ma = la * restS / 5400;
  let p1 = 0, pn = 0, p2 = 0;
  for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) {
    const q = pois(mh, x) * pois(ma, y), H = h + x, A = a + y;
    if (H > A) p1 += q; else if (H === A) pn += q; else p2 += q;
  }
  const s = p1 + pn + p2;
  return [p1 / s, pn / s, p2 / s];
}
function etatA(K, t) {
  const s = (t - K) / 1000;
  if (s < 0) return { et: 'pre', pe: 0, h: 0, st: 'STATUS_SCHEDULED', jeu: 0 };
  if (s < 2700) return { et: 'in', pe: 1, h: s, st: 'STATUS_FIRST_HALF', jeu: s };
  if (s < 2700 + P1_ARRET) return { et: 'in', pe: 1, h: 2700, st: 'STATUS_FIRST_HALF', jeu: 2700 };
  if (s < 2700 + P1_ARRET + MT) return { et: 'in', pe: 1, h: 2700, st: 'STATUS_HALFTIME', jeu: 2700 };
  const s2 = s - P1_ARRET - MT;
  if (s2 < 5400) return { et: 'in', pe: 2, h: s2, st: 'STATUS_SECOND_HALF', jeu: s2 };
  if (s2 < 5400 + P2_ARRET) return { et: 'in', pe: 2, h: 5400, st: 'STATUS_SECOND_HALF', jeu: 5400 };
  return { et: 'post', pe: 2, h: 5400, st: 'STATUS_FULL_TIME', jeu: 5400, fini: true };
}
const mur = (K, g) => K + (g < 2700 ? g : g + P1_ARRET + MT) * 1000;
const FIN_S = 2700 + P1_ARRET + MT + 2700 + P2_ARRET;

/** Le calendrier : 24 rencontres sur 16 jours, six clubs, deux qui partagent un appel. */
function calendrier(graine, n) {
  const r = rng(graine);
  const T0 = Date.UTC(2026, 9, 12, 19, 0);
  const out = [];
  for (let i = 0; i < (n || 24); i++) {
    const [club, ligue, chemin] = CLUBS[i % CLUBS.length];
    const jour = Math.floor(i / 3) * 2 + (i % 3 === 2 ? 1 : 0);
    const K = T0 + jour * 86400000;
    const adv = ADVERSES[i % ADVERSES.length];
    const dom = i % 2 === 0 ? club : adv, ext = i % 2 === 0 ? adv : club;
    const fort = 1.6 + r() * 0.8, faible = 0.5 + r() * 0.6;
    const lh = i % 2 === 0 ? fort : faible, la = i % 2 === 0 ? faible : fort;
    const faits = [];
    for (const [cote, l] of [['h', lh], ['a', la]]) {
      let g = 0;
      for (;;) { g += -Math.log(1 - r()) / (l / 5400); if (g >= 5400) break; faits.push({ type: 'b', cote, g }); }
    }
    if (r() < 0.35) faits.push({ type: 'r', cote: r() < 0.5 ? 'h' : 'a', g: 300 + r() * 4800 });
    for (const f of faits) { f.g = Math.round(f.g); f.T = mur(K, f.g); }
    faits.sort((x, y) => x.T - y.T);
    out.push({ i, id: `sim-${i}`, ev: `evsim${i}`, ligue, chemin, dom, ext, K, lh, la, faits, inverse: i % 4 === 1,
               idDom: 'T' + (100 + 2 * i), idExt: 'T' + (101 + 2 * i) });
  }
  return out;
}
function verite(m, t) {
  const e = etatA(m.K, t);
  let h = 0, a = 0, rh = 0, ra = 0;
  for (const f of m.faits) if (f.T <= t) { if (f.type === 'b') { if (f.cote === 'h') h++; else a++; } else if (f.cote === 'h') rh++; else ra++; }
  const lh = m.lh * Math.pow(0.75, rh) * Math.pow(1.2, ra), la = m.la * Math.pow(0.75, ra) * Math.pow(1.2, rh);
  return { e, h, a, p: proba(h, a, lh, la, Math.max(1, 5400 - e.jeu)) };
}
/* la bourse saine a l'instant t : suspendue SUSP s apres chaque fait (last_update fige), sinon le prix vrai */
function bourseSaine(m, t, alea) {
  for (const f of m.faits) if (t >= f.T && t < f.T + SUSP * 1000) return { p: verite(m, f.T - 1000).p, lu: f.T - 2000 };
  return { p: verite(m, t).p, lu: t - 1000 - Math.floor(alea(t) * 7000) };
}
function bourse(m, t, mode, alea) {
  if (mode === 'figee') return { p: verite(m, m.K - 60000).p, lu: t - 1000 - Math.floor(alea(t) * 7000) };
  if (mode === 'retard') {
    const b = bourseSaine(m, t - 60000, alea);
    const fige = m.faits.some((f) => t - 60000 >= f.T && t - 60000 < f.T + SUSP * 1000);
    return { p: b.p, lu: fige ? b.lu + 60000 : t - 1000 - Math.floor(alea(t) * 7000) };
  }
  return bourseSaine(m, t, alea);
}
const cote = (p) => Math.max(1.01, Math.min(100, Math.round(100 / (p * 1.01)) / 100));
function evenementOdds(m, t, mode, alea) {
  const b = bourse(m, t, mode, alea);
  const iso = new Date(b.lu).toISOString();
  const o = (c) => [{ name: m.dom, price: c[0] }, { name: 'Draw', price: c[1] }, { name: m.ext, price: c[2] }];
  const back = b.p.map(cote), lay = b.p.map((p) => Math.round((cote(p) + 0.02) * 100) / 100);
  return { id: m.ev, sport_key: m.ligue, commence_time: new Date(m.K).toISOString(), home_team: m.dom, away_team: m.ext,
           bookmakers: [{ key: 'betfair_ex_eu', title: 'Betfair', last_update: iso,
                          markets: [{ key: 'h2h', last_update: iso, outcomes: o(back) }, { key: 'h2h_lay', last_update: iso, outcomes: o(lay) }] }] };
}
/* ESPN a l'instant t : l'etat et l'horloge (H s de retard, 5 par defaut), les faits vus L s apres */
function evenementEspn(m, t, L, H) {
  const e = etatA(m.K, t - (H === undefined ? 5 : H) * 1000);
  const vus = m.faits.filter((f) => f.T <= t - L * 1000);
  const h = vus.filter((f) => f.type === 'b' && f.cote === 'h').length, a = vus.filter((f) => f.type === 'b' && f.cote === 'a').length;
  const comp = [{ homeAway: 'home', score: String(h), team: { id: m.idDom, displayName: m.dom } },
                { homeAway: 'away', score: String(a), team: { id: m.idExt, displayName: m.ext } }];
  if (m.inverse) comp.reverse();
  return { id: 'espn-' + m.i, date: new Date(m.K).toISOString(),
           status: { clock: e.h, displayClock: Math.floor(e.h / 60) + "'", period: e.pe,
                     type: { name: e.st, state: e.et, completed: !!e.fini, shortDetail: '' } },
           competitions: [{ competitors: comp,
                            details: vus.map((f) => ({ type: { text: f.type === 'b' ? 'Goal' : 'Red Card' }, clock: { value: f.g },
                                                       team: { id: f.cote === 'h' ? m.idDom : m.idExt }, scoringPlay: f.type === 'b', redCard: f.type === 'r' })) }] };
}

/**
 * Fait tourner le vrai module sur le calendrier. Rend { dossier, appels }.
 * `enJeu` : le module (deja requis), `donnees` : le DATA_DIR de ce journal.
 */
async function simule(enJeu, donnees, mode, opts) {
  const o = Object.assign({ graine: 7, espnS: mode === 'figee' ? 200 : 20, horlogeS: 5 }, opts || {});
  process.env.DATA_DIR = donnees;
  fs.mkdirSync(donnees, { recursive: true });
  enJeu.recharge();
  const cal = o.calendrier || calendrier(o.graine);
  /* `coupEnvoiS` : le vrai coup d'envoi a lieu X s APRES l'heure du catalogue (un retard courant) */
  const avance = (Number(o.coupEnvoiS) || 0) * 1000;
  const catalogue = cal.map((m) => ({ id: m.id, sport: 'foot', competition: 'x', domicile: m.dom, exterieur: m.ext, debut: m.K - avance,
                                      source: { fournisseur: 'the-odds-api', ligue: m.ligue, evenement: m.ev }, ferme: null, suspendu: false }));
  const parEv = new Map(cal.map((m) => [m.ev, m]));
  const alea = (t) => { const x = Math.sin(t / 997 + o.graine) * 10000; return x - Math.floor(x); };
  let maintenant = 0;
  const appels = [];
  const appel = async (chemin, params, cout, quoi, prio, info) => {
    const ligue = /\/sports\/([^/]+)\/odds/.exec(chemin)[1];
    const ids = String(params.eventIds || '').split(',');
    appels.push({ t: maintenant, ligue, ids, params: Object.assign({}, params), classe: info && info.classe });
    const evs = [];
    for (const id of ids) {
      const m = parEv.get(id);
      if (!m || m.ligue !== ligue) continue;
      if (maintenant < m.K - 3600000 || maintenant > m.K + FIN_S * 1000) continue;
      evs.push(evenementOdds(m, maintenant, mode, alea));
    }
    Object.assign(info, { dernier: evs.length ? 1 : 0, cout: evs.length ? 1 : 0, reste: 19000, utilise: 1000, statut: 200, code: null });
    return evs;
  };
  const fetchEspn = async (u) => {
    const x = /sports\/soccer\/([^/]+)\/scoreboard\?dates=(\d{8})/.exec(String(u));
    const evs = cal.filter((m) => m.chemin === x[1] && new Date(m.K).toISOString().slice(0, 10).replace(/-/g, '') === x[2])
      .map((m) => evenementEspn(m, maintenant, o.espnS, o.horlogeS));
    return { ok: true, status: 200, json: async () => ({ events: evs }) };
  };
  const p = enJeu.planifie({ cle: true, appel, catalogue: () => catalogue, fetchEspn, minuteries: false, horloge: () => maintenant,
                             estRegle: () => false, quota: () => ({ depense: 0, part: 100000, reserve: 80 }) });
  const departs = [...new Set(cal.map((m) => m.K))].sort((a, b) => a - b);
  for (const K of departs) {
    for (let t = K - 150000; t <= K + (FIN_S + 300) * 1000; t += 5000) { maintenant = t; await p.tic(t); }
  }
  p.arrete();
  return { dossier: enJeu.dossierJournal(), appels, calendrier: cal };
}
function lignesDe(enJeu, dossier) {
  const out = [];
  for (const f of fs.readdirSync(dossier).filter((x) => /\.jsonl$/.test(x)).sort()) for (const l of enJeu.lisLignes(fs.readFileSync(path.join(dossier, f), 'utf8'))) out.push(l);
  return out;
}

module.exports = { simule, lignesDe, calendrier, etatA, verite, proba, evenementOdds, evenementEspn, FIN_S };
