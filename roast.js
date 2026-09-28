'use strict';
/* ==========================================================================
 * ROAST_TOKEN — SWOGE SE MOQUE D'UN JETON, AVEC SES VRAIS CHIFFRES
 * ==========================================================================
 *
 * Demande du proprietaire, 28 septembre 2026 : « on doit envahir le marche
 * agentic, cree des outils viraux » — choix : roast_token.
 *
 * Pourquoi celui-la (classement x402scan sur 30 jours, releve du 28/09) : les
 * outils de nouveaute trouvent preneurs (cn402, divination, 80 acheteurs ;
 * Vibe Springs, meteo, 102) et une IMAGE se partage. Un roast porte la tete de
 * SWOGE et le lien du site : chaque carte postee sur X fait la pub de SWOGE.
 *
 * Ce qu'il fait :
 *   - les faits : la MEME fiche que scan_token et token_verdict (DexScreener,
 *     GoPlus, colonie), jugee par verdict_jeton ;
 *   - le texte : Claude Haiku, sous des regles strictes (les faits seuls, pas
 *     de « scam » ni de « rug » qu'aucun drapeau ne dit, personne d'insulte,
 *     aucun conseil) ; s'il ne repond pas, un gabarit tire des memes faits —
 *     l'outil rend toujours un roast vrai ;
 *   - la carte : PNG 1200×630, sans dependance (carte_png.js), le visage de
 *     SWOGE (visage_swoge.json, fait par outils/visage.js) ;
 *   - le partage : /rt/<id>, une page dont l'apercu est la carte, qui envoie
 *     les humains sur SwogeAgentic.
 * Les roasts sont gardes (ROASTS_MAX, DATA_DIR/roasts.json) : la carte et la
 * page de partage se redessinent depuis eux, sans rappeler personne.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const C = require('./carte_png');

const L = 1200, H = 630;
const ROAST_MAX = 240;              /* un tweet garde la place du lien */
const ROASTS_MAX = 3000;
const FOND = '#0a1f44', BANDE = '#12305f', BLANC = '#e8f0ff', BLEU = '#7fb0ff', PALE = '#a8c4ee', GRIS = '#6c86b2';
const COULEUR_VERDICT = { red_flags: '#ff7b72', caution: '#ffcf66', unknown: GRIS, no_red_flag_found: '#5bd99a' };
const NOTE = 'Entertainment built on real data: never a buy or sell signal.';

const SYSTEME = 'You are SWOGE, a very muscular shiba inu who roasts crypto tokens for fun. '
  + 'Write ONE roast of the token described in the JSON: 2 or 3 short punchy sentences, at most 220 characters, in English. '
  + 'Rules: use only facts from the JSON and never invent numbers, events or people. '
  + 'Never call it a scam, a rug, a honeypot or fraud unless a flag in the JSON says exactly that, and then only say what the flag says. '
  + 'No insults about people, groups or developers; no profanity; no hashtags, emojis, links or @mentions; no buy or sell advice. '
  + 'Gym, protein and leg-day jokes are welcome. Answer with the roast only.';

/* L'atlas de la carte ne sait que l'ASCII et « ° · × … » : le reste est ramene ou retire. */
function propre(s) {
  return String(s == null ? '' : s).replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').replace(/#(\w)/g, '$1')
    .replace(/[^\x20-\x7e°·×…]/g, '').replace(/\s+/g, ' ').trim();
}
const usd = (n) => (n == null || !isFinite(n) ? 'unknown' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : '$' + Math.round(n));

/** Les faits donnes au modele, et a lui seul : rien d'autre ne peut entrer dans le roast. */
function faits(adr, fiche, v) {
  const t = (v && v.token) || {};
  const m = (fiche && fiche.marche) || {};
  return { symbol: t.symbol || null, name: t.name || null, chain: t.chain || null, priceUsd: t.priceUsd ?? null,
    liquidityUsd: t.liquidityUsd ?? null, marketCapUsd: t.marketCapUsd ?? null, poolAgeDays: t.poolAgeDays ?? null,
    change24hPct: m.var24h ?? null, verdict: v ? v.verdict : 'unknown',
    flags: ((v && v.flags) || []).slice(0, 6).map((f) => f.level + ': ' + f.text) };
}

/** Le roast sans modele : des memes faits, toujours vrai. Le choix depend de l'adresse, pas du hasard. */
function gabarit(adr, f) {
  const sym = '$' + (f.symbol || 'TOKEN');
  const k = parseInt(String(adr).slice(2, 6), 16) || 0;
  if (f.liquidityUsd == null && f.marketCapUsd == null) return sym + '? No pool I can find. Even my shadow shows up more often, and it skips leg day.';
  const rouges = f.flags.filter((x) => /^red:/.test(x));
  if (rouges.length) return sym + ' walked in with ' + rouges.length + ' red flag' + (rouges.length > 1 ? 's' : '') + ': ' + rouges[0].slice(5) + '. I spot heavy weights, not this.';
  if (f.liquidityUsd != null && f.liquidityUsd < 13000) return [sym + ' runs on ' + usd(f.liquidityUsd) + ' of liquidity. My protein tub is deeper than this pool.',
    sym + ': ' + usd(f.liquidityUsd) + ' pool, ' + usd(f.marketCapUsd) + ' cap. That is not a chart, that is a warm-up set.'][k % 2];
  return [sym + ': ' + usd(f.marketCapUsd) + ' cap, ' + usd(f.liquidityUsd) + ' pool, verdict ' + String(f.verdict).replace(/_/g, ' ') + '. Decent form. Now add some real volume.',
    sym + ' at ' + usd(f.marketCapUsd) + '. Respectable. I still bench more than its daily volume.'][k % 2];
}

/** Le texte du modele, nettoye et borne ; null s'il ne sert a rien. */
function nettoie(t) {
  let s = propre(String(t || '').replace(/^["']|["']$/g, ''));
  if (s.length < 20) return null;
  if (s.length > ROAST_MAX) { s = s.slice(0, ROAST_MAX); const i = s.lastIndexOf('. '); s = i > 80 ? s.slice(0, i + 1) : s.replace(/\s+\S*$/, '') + '…'; }
  return s;
}

/* ------------------------------------------------------------------ la carte */
let VISAGE = null;
function visage() {
  if (VISAGE) return VISAGE;
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'visage_swoge.json'), 'utf8'));
  VISAGE = { l: j.l, h: j.h, rgb: zlib.inflateSync(Buffer.from(j.rgb, 'base64')) };
  return VISAGE;
}
/** Colle le visage dans un disque de rayon l/2, cercle d'anneau bleu. */
function colleVisage(t, x0, y0) {
  const V = visage(), r = V.l / 2, cx = x0 + r, cy = y0 + r;
  const [br, bg, bb] = C.couleur(BLEU);
  for (let y = -6; y < V.h + 6; y++) for (let x = -6; x < V.l + 6; x++) {
    const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
    const X = x0 + x, Y = y0 + y;
    if (X < 0 || Y < 0 || X >= t.l || Y >= t.h) continue;
    const o = (Y * t.l + X) * 4;
    if (d <= r && x >= 0 && y >= 0 && x < V.l && y < V.h) {
      const p = (y * V.l + x) * 3, a = Math.min(1, r - d);
      t.px[o] = Math.round(t.px[o] * (1 - a) + V.rgb[p] * a); t.px[o + 1] = Math.round(t.px[o + 1] * (1 - a) + V.rgb[p + 1] * a);
      t.px[o + 2] = Math.round(t.px[o + 2] * (1 - a) + V.rgb[p + 2] * a); t.px[o + 3] = 255;
    } else if (d > r && d <= r + 5) { t.px[o] = br; t.px[o + 1] = bg; t.px[o + 2] = bb; t.px[o + 3] = 255; }
  }
  return { cx, cy };
}
/** Coupe un texte en lignes qui tiennent dans `max` pixels. */
function lignes(s, taille, max) {
  const out = [];
  let cur = '';
  for (const w of String(s).split(' ')) {
    const essai = cur ? cur + ' ' + w : w;
    if (C.largeur(essai, taille, false) <= max || !cur) cur = essai; else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out;
}
/** Ce que la carte ecrit, dans l'ordre (l'essai lit les textes, `dessine` les peint). */
function plan(r) {
  const ops = [];
  const rect = (x, y, l, h, c) => ops.push({ rect: [x, y, l, h, c] });
  const txt = (texte, x, y, taille, c, o) => ops.push({ texte: propre(texte), x, y, taille, c, o: o || {} });
  rect(0, 0, L, 96, BANDE);
  txt('SWOGE ROASTS', 56, 58, 24, BLEU, { gras: true });
  txt('$' + String(r.symbol || 'TOKEN').slice(0, 16), L - 56, 62, 36, BLANC, { gras: true, al: 'd' });
  const X = 360, MAX = L - X - 56;
  let taille = 36, ls = lignes(r.roast, taille, MAX);
  while (ls.length > 5 && taille > 26) { taille -= 2; ls = lignes(r.roast, taille, MAX); }
  ls = ls.slice(0, 6);
  let y = 150 + Math.max(0, (5 - ls.length) * taille * 0.6);
  for (const l of ls) { txt(l, X, y + taille, taille, BLANC, { gras: true }); y += Math.round(taille * 1.35); }
  const f = r.facts || {};
  const stats = ['Pool ' + usd(f.liquidityUsd), 'Cap ' + usd(f.marketCapUsd)];
  if (f.change24hPct != null) stats.push('24h ' + (f.change24hPct > 0 ? '+' : '') + f.change24hPct + '%');
  txt(stats.join('  ·  '), X, H - 104, 20, PALE);
  txt('Verdict: ' + String(r.verdict || 'unknown').replace(/_/g, ' ').toUpperCase(), L - 56, H - 104, 20, COULEUR_VERDICT[r.verdict] || GRIS, { gras: true, al: 'd' });
  rect(0, H - 64, L, 64, BANDE);
  txt('Roasted by SWOGE AI with real data · entertainment, not financial advice', 56, H - 24, 16, PALE);
  txt('swoleeswoge.dog', L - 56, H - 24, 18, BLEU, { gras: true, al: 'd' });
  return ops;
}
const textes = (r) => plan(r).filter((o) => o.texte !== undefined).map((o) => o.texte);
function dessine(r) {
  const t = C.toile(L, H, FOND);
  colleVisage(t, 56, 150);
  for (const o of plan(r)) { if (o.rect) C.rect(t, ...o.rect); else C.texte(t, o.texte, o.x, o.y, o.taille, o.c, o.o); }
  return C.png(t);
}

/* ------------------------------------------------------------------ l'outil */
/**
 * deps : { fiche(adr) → fiche studio_jeton, juge(fiche) → verdict_jeton.juge,
 *          redige({ systeme, texte }) → { texte, usage, coutUsd? } (optionnel),
 *          api, site (URL), dossier (DATA_DIR), maintenant? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const fichier = deps.dossier ? path.join(deps.dossier, 'roasts.json') : null;
  const MESURE = { roasts: 0, parModele: 0, parGabarit: 0, echecsModele: 0, coutUsd: 0 };
  let garde = new Map();
  try { if (fichier) for (const x of JSON.parse(fs.readFileSync(fichier, 'utf8'))) garde.set(x.id, x); } catch (e) { /* premier demarrage */ }
  const ecrit = () => { if (!fichier) return; try { fs.writeFileSync(fichier + '.tmp', JSON.stringify([...garde.values()])); fs.renameSync(fichier + '.tmp', fichier); } catch (e) { /* jamais bloquant */ } };
  const liens = (id) => ({ card: deps.api + '/roast/' + id + '.png', share: deps.api + '/rt/' + id });

  async function roast(adresse) {
    const adr = String(adresse || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(adr)) return { erreur: 'address must be 0x followed by 40 hex characters' };
    const fiche = await deps.fiche(adr);
    const v = deps.juge(fiche);
    const f = faits(adr, fiche, v);
    let texte = null, auteur = 'template';
    if (deps.redige) {
      try {
        const r = await deps.redige({ systeme: SYSTEME, texte: JSON.stringify(f) });
        texte = nettoie(r && r.texte);
        if (r && r.coutUsd) MESURE.coutUsd += r.coutUsd;
        if (texte) auteur = 'SWOGE AI (Claude Haiku)'; else MESURE.echecsModele++;
      } catch (e) { MESURE.echecsModele++; }
    }
    if (!texte) texte = nettoie(gabarit(adr, f)) || gabarit(adr, f);
    if (auteur === 'template') MESURE.parGabarit++; else MESURE.parModele++;
    MESURE.roasts++;
    const id = crypto.randomBytes(6).toString('hex');
    const r = { id, t: maintenant(), address: adr, symbol: f.symbol, chain: f.chain, roast: texte, verdict: f.verdict, writer: auteur, facts: f };
    garde.set(id, r);
    if (garde.size > ROASTS_MAX) garde = new Map([...garde].slice(-ROASTS_MAX));
    ecrit();
    const donnees = { token: { address: adr, symbol: f.symbol, chain: f.chain }, roast: texte, verdict: f.verdict, writer: auteur, facts: f, links: liens(id), note: NOTE };
    return { donnees, texte: 'SWOGE roasts $' + (f.symbol || 'TOKEN') + ': ' + texte + '\n\nShareable card (PNG): ' + donnees.links.card
      + ' — share page (link preview on X, Telegram, Discord): ' + donnees.links.share + '\n' + NOTE };
  }
  const lit = (id) => (/^[0-9a-f]{12}$/.test(String(id)) ? garde.get(String(id)) || null : null);
  return { roast, lit, carte: (id) => { const r = lit(id); return r ? dessine(r) : null; }, MESURE };
}

module.exports = { cree, faits, gabarit, nettoie, propre, plan, textes, dessine, lignes, SYSTEME, NOTE, L, H, ROAST_MAX, ROASTS_MAX };
