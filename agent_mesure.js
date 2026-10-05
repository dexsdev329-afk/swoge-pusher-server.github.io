'use strict';
/* ==================================================================
 * LA MESURE D'UN AGENT — « apprendre ce qui marche » (impressions/likes)
 * ==================================================================
 *
 * Amélioration de l'agent (05/10/2026, dernier levier). On lit les metriques
 * publiques des posts X de l'agent (impressions, likes, retweets, replies) et on
 * en tire un RESUME : combien d'engagement, quel post a le mieux marche, et —
 * quand il y a ASSEZ d'observations — quel format (texte / image / video) porte.
 *
 * Convention de la maison : on ne conclut pas sous un seuil. Un « meilleur post »
 * sur deux posts n'est que du hasard ; on exige ASSEZ (seuil) avant de dire « ce
 * format marche mieux ». Pur et deterministe : les metriques sont passees, pas lues
 * (le serveur les recupere via agent_x). Rien n'invente un chiffre.
 * ================================================================== */

const r2 = (x) => Math.round(Number(x) * 100) / 100;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

const ASSEZ = 5;          /* on ne compare pas les formats sous 5 posts mesures */
const ASSEZ_FORMAT = 3;   /* ni un format sous 3 posts de ce format */

/* L'engagement brut d'un post : likes + retweets + replies + quotes + bookmarks. */
function engagements(m) {
  m = m || {};
  return num(m.like_count) + num(m.retweet_count) + num(m.reply_count) + num(m.quote_count) + num(m.bookmark_count);
}
/* Le score d'un post : taux d'engagement si on a les impressions, sinon l'engagement brut.
   (Les impressions ne sont visibles que pour l'auteur ; parfois 0/absentes.) */
function score(m) {
  const e = engagements(m), imp = num(m && m.impression_count);
  return imp > 0 ? e / imp : e;
}

/**
 * resume(posts) : agrege les posts MESURES. posts = [{ texte, media?, metrics, quand? }].
 * Rend { n, assez, impressions, likes, engagements, tauxMoyenPct, meilleur, parMedia }.
 * `assez` dit si on a de quoi conclure ; parMedia n'est rempli que pour les formats « assez ».
 */
function resume(posts) {
  const mesures = (posts || []).filter((p) => p && p.metrics);
  const n = mesures.length;
  let impressions = 0, likes = 0, eng = 0;
  let meilleur = null, meilleurScore = -1;
  const groupes = {};   /* media -> { n, eng, imp, score } */
  for (const p of mesures) {
    const m = p.metrics;
    impressions += num(m.impression_count); likes += num(m.like_count); eng += engagements(m);
    const s = score(m);
    if (s > meilleurScore) { meilleurScore = s; meilleur = { texte: p.texte || '', media: p.media || 'none', likes: num(m.like_count), impressions: num(m.impression_count), engagements: engagements(m), quand: p.quand || null }; }
    const g = groupes[p.media || 'none'] || (groupes[p.media || 'none'] = { n: 0, eng: 0, imp: 0, somScore: 0 });
    g.n++; g.eng += engagements(m); g.imp += num(m.impression_count); g.somScore += s;
  }
  const parMedia = {};
  for (const k of Object.keys(groupes)) {
    const g = groupes[k];
    if (g.n >= ASSEZ_FORMAT) parMedia[k] = { n: g.n, engMoyen: r2(g.eng / g.n), scoreMoyen: r2(g.somScore / g.n) };
  }
  const tauxMoyenPct = impressions > 0 ? r2((eng / impressions) * 100) : null;
  return { n, assez: n >= ASSEZ, impressions, likes, engagements: eng, tauxMoyenPct,
    meilleur: n >= 1 ? meilleur : null, parMedia };
}

/** Une ligne factuelle pour la mémoire de l'agent (« ce qui marche »), ou null si pas assez. */
function phrase(res) {
  if (!res || !res.assez || !res.meilleur) return null;
  const m = res.meilleur;
  const perf = m.impressions > 0 ? (m.impressions + ' impressions, ' + m.likes + ' likes') : (m.engagements + ' engagements');
  return 'your best post so far (' + perf + ') was: "' + String(m.texte).slice(0, 120) + '" — keep what works, do not repeat it';
}

module.exports = { resume, phrase, score, engagements, ASSEZ, ASSEZ_FORMAT };
