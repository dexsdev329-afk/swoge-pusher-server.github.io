'use strict';
/* ============================================================================
 * LE REJEU LONG : CE QU IL DOIT GARANTIR POUR ETRE UNE PORTE
 *
 * `outils/perp_rejeu.js` est la porte de tout changement de regle ou de
 * geometrie de la colonie perp (27 septembre 2026). Une porte qui laisse
 * passer du bruit est pire que pas de porte : elle donne un tampon a une
 * croyance. Ce qu on verifie, sans reseau, sur des marches fabriques :
 *
 *   1. SANS CHEVAUCHEMENT : jamais deux trades a la fois sur un marche, jamais
 *      plus de 5 positions, jamais plus de 2 dans un sens — c est la colonie
 *      elle-meme qui decide, pas une entree a chaque bougie ;
 *   2. LES FRAIS REELS : 0,12 % au stop et au temps, 0,08 % a la cible ;
 *   3. AUCUNE FUITE DU FUTUR : ni dans les bougies 15 min, ni dans la bougie
 *      4 h en cours (la fuite de `perp_edge.js`, corrigee elle aussi), ni dans
 *      le financement (le dernier REGLE, jamais le suivant) ;
 *   4. LE VERDICT REFUSE DE CONCLURE quand la borne basse est ≤ 0 — et une
 *      marche aleatoire, frais payes, ne doit JAMAIS passer ;
 *   5. l erreur-type est GROUPEE PAR JOUR : des trades du meme jour qui
 *      bougent ensemble ne comptent pas comme independants ;
 *   6. le nombre de variantes essayees sur une garde se CUMULE ;
 *   7. le rejeu est deterministe et rend l environnement comme il l a trouve.
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b || JSON.stringify(a) === JSON.stringify(b), m + ' (' + JSON.stringify(a) + ')');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'perp-rejeu-essai-'));
process.env.DATA_DIR = BAC;
process.env.PERP_JOURNAL = '0';
const R = require('./outils/perp_rejeu');
const M15 = 15 * 60000, H4 = 4 * 3600000, H8 = 8 * 3600000, JOUR = 86400000;

/* Un generateur a graine : le meme marche a chaque lancement. */
function graine(s) { return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(u) { return Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()); }
/* Une marche aleatoire : AUCUN avantage a trouver, par construction. */
function marcheAleatoire(sym, t0, nb, prix, sigma, s) {
  const u = graine(s), c15 = [];
  let p = prix;
  for (let i = 0; i < nb; i++) {
    const o = p;
    p = p * Math.exp(sigma / 100 * gauss(u));
    const h = Math.max(o, p) * (1 + Math.abs(gauss(u)) * sigma / 300);
    const b = Math.min(o, p) * (1 - Math.abs(gauss(u)) * sigma / 300);
    c15.push([t0 + i * M15, o, h, b, p]);
  }
  /* Financement Bitget constant a 0,01 % toutes les 8 h, sur la derniere
     moitie ; Hyperliquid (horaire) avant — comme en vrai. */
  const finBitget = [], finHl = [];
  const milieu = t0 + Math.floor(nb / 2) * M15;
  for (let t = Math.ceil(t0 / H8) * H8; t < t0 + nb * M15; t += H8) if (t >= milieu) finBitget.push([t, 0.0001]);
  for (let t = t0; t < milieu; t += 3600000) finHl.push([t, 0.0000125]);
  return { c15, finBitget, finHl, contrat: { fundInterval: 8, maker: 0.0002, taker: 0.0006 } };
}

(async () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const NB = 70 * 96;                        /* 70 jours de bougies 15 min */
  const donnees = {
    BTCUSDT: marcheAleatoire('BTCUSDT', t0, NB, 80000, 0.2, 11),
    ETHUSDT: marcheAleatoire('ETHUSDT', t0, NB, 3000, 0.25, 22),
    SOLUSDT: marcheAleatoire('SOLUSDT', t0, NB, 150, 0.35, 33),
    XRPUSDT: marcheAleatoire('XRPUSDT', t0, NB, 0.6, 0.4, 44),
    DOGEUSDT: marcheAleatoire('DOGEUSDT', t0, NB, 0.2, 0.4, 55),
  };
  const o = { debut: t0 + 12 * JOUR, fin: t0 + NB * M15, dataDir: BAC };

  console.log('-- 1. la colonie decide : aucun chevauchement --');
  const envAvant = process.env.PERP_STOP_VOL;
  const tr = await R.simule(donnees, R.GRILLE[0], o);
  ok(tr.length > 200, tr.length + ' trades sur 58 jours et 5 marches');
  let chevauche = 0, plusDeCinq = 0, plusDeDeux = 0;
  for (const sym of Object.keys(donnees)) {
    const l = tr.filter((t) => t.sym === sym).sort((a, b) => a.entree - b.entree);
    for (let i = 1; i < l.length; i++) if (l[i].entree < l[i - 1].sortie) chevauche++;
  }
  const instants = [...new Set(tr.map((t) => t.entree))];
  for (const t of instants) {
    const ouverts = tr.filter((x) => x.entree <= t && x.sortie > t);
    if (ouverts.length > 5) plusDeCinq++;
    if (ouverts.filter((x) => x.sens > 0).length > 2 || ouverts.filter((x) => x.sens < 0).length > 2) plusDeDeux++;
  }
  eq(chevauche, 0, 'jamais deux trades en meme temps sur un marche');
  eq(plusDeCinq, 0, 'jamais plus de cinq positions a la fois');
  eq(plusDeDeux, 0, 'jamais plus de deux dans le meme sens (MEME_SENS_MAX)');
  ok(tr.every((t) => (t.entree - t0) % M15 === 0), 'on n entre qu a la cloture d une bougie 15 min, au prix de cette cloture');
  ok(tr.every((t) => t.sortie > t.entree && t.minutes <= 720), 'et on sort apres, en 12 h au plus');

  console.log('\n-- 2. les frais reels, par type d ordre --');
  const mauvais = tr.filter((t) => Math.abs(t.rReel - (t.brut + t.financement - (t.pourquoi === 'target' ? 0.08 : 0.12))) > 0.0015);
  eq(mauvais.length, 0, 'net = brut + financement − 0,12 % (stop, temps) ou − 0,08 % (cible), sur chaque trade');
  const sorties = {};
  for (const t of tr) sorties[t.pourquoi] = (sorties[t.pourquoi] || 0) + 1;
  ok(sorties.stop > 0 && sorties.target > 0 && sorties.time > 0, 'les trois sorties existent : ' + JSON.stringify(sorties));
  ok(tr.some((t) => t.financement !== 0), 'le financement est compte');

  console.log('\n-- 3. aucune fuite du futur --');
  {
    const d = donnees.BTCUSDT;
    const i = 2000;
    const piege = d.c15.map((c) => c.slice());
    piege[i + 1][2] = piege[i + 1][4] * 10;        /* un pic enorme, JUSTE apres */
    piege[i + 1][4] = piege[i + 1][4] * 5;
    const h4 = R.preparer4h(piege);
    const fin = R.preparerFinancement(d);
    const m = R.marchePour('BTCUSDT', piege, i, fin, 480, h4);
    const T = piege[i][0] + M15;
    ok(m.m15.every((c) => c.t + M15 <= T), 'les bougies 15 min lues sont toutes fermees a l instant de la decision');
    ok(Math.max(...m.m15.map((c) => c.h)) < piege[i + 1][2] && Math.max(...m.h4.map((c) => c.h)) < piege[i + 1][2],
       'le pic de la bougie suivante n est vu nulle part');
    const der = m.h4[m.h4.length - 1];
    ok(der.t + H4 > T ? der.c === piege[i][4] : true, 'la bougie 4 h en cours a pour cloture le prix DU MOMENT');
    ok(m.h4.slice(0, -1).every((c) => c.t + H4 <= T), 'les autres bougies 4 h sont fermees');
    ok(m.h4.length === 60, 'soixante bougies 4 h, comme le service en lit');
    /* La fuite de perp_edge.js : corrigee de la meme facon. */
    const E = require('./perp_edge');
    const c4 = [{ t: 0, o: 1, h: 1, b: 1, c: 1 }, { t: H4, o: 2, h: 9, b: 2, c: 9 }];
    const vu = E.h4Jusqu(c4, H4 + 2 * M15, 3);
    ok(vu.length === 2 && vu[1].c === 3 && vu[1].h < 9,
       'perp_edge.js : la bougie 4 h en cours ne porte plus sa cloture finale (9), mais le prix du moment (3)');
    /* Le financement : le dernier REGLE, jamais le suivant. */
    const fb = d.finBitget;
    const k = 5, tk = fb[k][0];
    const f1 = fin.taux(tk - 1), f2 = fin.taux(tk);
    ok(f1.src === 'bitget' && f2.src === 'bitget', 'apres le debut de Bitget, le taux vient de Bitget');
    const avantBitget = fin.taux(fb[0][0] - 1);
    ok(avantBitget && avantBitget.src === 'hl' && Math.abs(avantBitget.v - 8 * 0.0000125) < 1e-12,
       'avant, Hyperliquid : la somme des 8 taux horaires de la periode close (' + avantBitget.v + ')');
    const piegeF = { finBitget: [[1000, 0.0001], [2000, 0.0009]], finHl: [] };
    const ff = R.preparerFinancement(piegeF);
    eq(ff.taux(1999).v, 0.0001, 'a 1 ms du reglement suivant, on lit encore le taux regle : pas celui qui vient');
  }

  console.log('\n-- 4. une marche aleatoire ne passe JAMAIS la porte --');
  {
    const b = R.bilan(tr, (o.fin - o.debut) / JOUR);
    const v = R.verdict(b, R.moities(tr, o.debut, o.fin));
    ok(!v.conclut, 'aucun avantage a trouver, frais payes : « ' + v.pourquoi + ' »');
    ok(b.netReel < 0, 'et le net aux frais reels est negatif, comme il doit l etre : ' + b.netReel.toFixed(3) + ' %');
    /* Et la porte s ouvre quand l avantage est reel et mesure. */
    const bons = [];
    for (let j = 0; j < 400; j++) bons.push({ entree: t0 + j * 3 * 3600000, rReel: j % 3 ? 0.9 : -0.5, brut: 0.9, r: 0.8, pourquoi: 'target' });
    const bb = R.bilan(bons, 50);
    const vb = R.verdict(bb, R.moities(bons, t0, t0 + 50 * JOUR));
    ok(vb.conclut && bb.borneBasse > 0, 'un avantage net franc, 400 trades sur 50 jours : la porte conclut (' + bb.borneBasse.toFixed(3) + ' %)');
    /* ---- UN NET POSITIF QUI NE SUFFIT PAS ----
     * Reecrit le 27/09 sur son intention. Le tirage « +0,02 % a sd 1,5 % »
     * avait en fait une moyenne de −0,030 (se 0,084) : la regle de la borne
     * basse n etait jamais essayee sur un net POSITIF, et un verdict qui
     * testait `netReel > 0`, ou Z95 = 0,5, restait vert. Ici le tirage est
     * recentre : net EXACTEMENT +0,05 %, erreur-type ~0,08 — positif, mais
     * borne basse ≤ 0. */
    const u = graine(7);
    const bruit = bons.map(() => 1.5 * gauss(u));
    const mb = bruit.reduce((a, x) => a + x, 0) / bruit.length;
    const faible = bons.map((x, i) => Object.assign({}, x, { rReel: bruit[i] - mb + 0.05 }));
    const bf = R.bilan(faible, 50);
    const vf = R.verdict(bf, R.moities(faible, t0, t0 + 50 * JOUR));
    ok(Math.abs(bf.netReel - 0.05) < 1e-9 && bf.netReel > 0 && bf.borneBasse <= 0 && !vf.conclut,
       'net +' + bf.netReel.toFixed(3) + ' % ± ' + bf.se.toFixed(3) + ' : positif, borne basse ' + bf.borneBasse.toFixed(3) + ' ≤ 0, on ne conclut pas (« ' + vf.pourquoi + ' »)');
    /* L intervalle est a 95 % : la borne est net − 1,96 × se, ni plus etroite ni plus large. */
    ok(Math.abs(bf.borneBasse - (bf.netReel - 1.959964 * bf.se)) < 1e-9 && Math.abs(bf.borneHaute - (bf.netReel + 1.959964 * bf.se)) < 1e-9,
       'borne basse = net − 1,96 × se et borne haute = net + 1,96 × se, a 1e-9');
  }

  console.log('\n-- 5. l erreur-type est groupee par jour --');
  {
    /* Dix trades par jour qui bougent ENSEMBLE : c est un pari par jour. */
    const l = [];
    for (let j = 0; j < 30; j++) for (let k = 0; k < 10; k++) l.push({ entree: t0 + j * JOUR + k * 60000, rReel: j % 2 ? 1 : -0.9, brut: 0, r: 0, pourquoi: 'stop' });
    const b = R.bilan(l, 30);
    const sd = Math.sqrt(l.reduce((a, t) => a + Math.pow(t.rReel - b.netReel, 2), 0) / (l.length - 1));
    const iid = sd / Math.sqrt(l.length);
    ok(b.se > iid * 2.5, 'groupee par jour : ' + b.se.toFixed(3) + ' contre ' + iid.toFixed(3) + ' si l on croyait 300 trades independants');
    ok(b.wilson && b.wilson[0] < b.part && b.wilson[1] > b.part, 'la part gagnante porte son intervalle de Wilson');
  }

  console.log('\n-- 6. les variantes essayees se comptent, et se cumulent --');
  {
    const oo = { cache: BAC, debutGarde: t0 + 40 * JOUR, fin: o.fin };
    const a = R.noteEssais(oo, ['service', 'x']);
    const b = R.noteEssais(oo, ['y']);
    ok(a.cumul === 2 && b.cumul === 3 && b.ceLancement === 1, 'deux puis une : 3 variantes regardees sur cette garde');
    const autre = R.noteEssais(Object.assign({}, oo, { debutGarde: t0 + 41 * JOUR }), ['z']);
    eq(autre.cumul, 1, 'une autre fenetre de garde repart de zero');
  }

  console.log('\n-- 7. deterministe, et l environnement rendu intact --');
  {
    const tr2 = await R.simule(donnees, R.GRILLE[0], o);
    ok(tr2.length === tr.length && tr2.every((t, i) => t.entree === tr[i].entree && t.rReel === tr[i].rReel),
       'deux rejeux identiques donnent les memes trades');
    const geo = await R.simule(donnees, R.GRILLE.find((g) => /3σ\/5σ/.test(g.nom)), o);
    ok(geo.length > tr.length, 'une variante change vraiment la regle : 3σ/5σ ferme plus vite, donc plus de trades (' + geo.length + ' contre ' + tr.length + ')');
    eq(process.env.PERP_STOP_VOL, envAvant, 'et PERP_STOP_VOL est rendu comme avant le rejeu');
    ok(Math.abs(Date.now() - new Date().getTime()) < 1000, 'Date.now est rendu au vrai temps');
    const muet = await R.simule(donnees, R.GRILLE.find((g) => g.muets), o);
    ok(muet.length > 0, 'Funding muet se MESURE (' + muet.length + ' trades) sans rien changer au service');
    /* ---- ET IL MESURE BIEN AUTRE CHOSE QUE LE SERVICE ----
     * 27/09 : retirer le mutisme de `note` (`if (!v) return;`) laissait cette
     * suite verte, la variante donnant exactement les 787 trades du service
     * (855 avec le mutisme). La ligne « Funding muted » du rapport est la
     * mesure qui eclaire la decision du proprietaire sur le poids de Funding :
     * elle doit differer du service. */
    const memes = muet.length === tr.length && muet.every((t, i) => t.entree === tr[i].entree && t.sym === tr[i].sym && t.sens === tr[i].sens);
    ok(!memes, 'la variante muette n est pas le service rejoue : ' + muet.length + ' trades contre ' + tr.length);
    const P = require('./ai_perp');
    const nm = P.note({ ecartEma: null, financement: 0.0001, couloir: null, carnet: null, var24: null }, -1, ['financement']);
    ok(nm.score === 50 && !(nm.dit || []).some((d) => d.agent === 'financement'),
       'note(…, [\'financement\']) : Funding se tait — score 50, aucune ligne « financement » dans dit [' + nm.score + ']');
    eq(P.note({ ecartEma: null, financement: 0.0001, couloir: null, carnet: null, var24: null }, -1).score, 60,
       'le service, lui, garde Funding entier : 0,01 % donne toujours +10 au short (decision du proprietaire)');
  }

  console.log('\n-- 8. le cache vit hors du depot --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'outils', 'perp_rejeu.js'), 'utf8');
    ok(/'data', 'perp_rejeu'/.test(src), 'le cache par defaut est data/perp_rejeu');
    const gi = fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8');
    ok(/^data\/$/m.test(gi), 'et data/ est dans .gitignore : aucun telechargement ne part au depot');
    ok(!/\/order|placeOrder|API_KEY|SECRET|privateKey/i.test(src.replace(/\* [^\n]*/g, '')), 'lecture seule : ni cle, ni ordre');
  }

  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* bac temporaire */ }
  console.log(rates ? `\nperp_rejeu.test.js : RATES : ${rates}/${n}` : `\nperp_rejeu.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('  RATE ' + (e.stack || e)); console.log(`perp_rejeu.test.js : RATES : ${rates + 1}/${n + 1}`); process.exit(1); });
