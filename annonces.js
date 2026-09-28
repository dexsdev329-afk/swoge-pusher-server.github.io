'use strict';
/* ==========================================================================
 * L'ANNONCE AUTOMATIQUE D'UN NOUVEL OUTIL (28 septembre 2026)
 *
 * Demande du proprietaire : « pour gagner du temps, quand il y a des mises a
 * jour importantes sur de nouveaux outils, fais un tweet avec une image bullish
 * et un texte auto qui va dans le Telegram ».
 *
 * « Important » = un OUTIL NOUVEAU : un nom que le serveur n'avait jamais offert
 * (API publique ou agent des joueurs). Un outil eteint (sans sa cle) n'est pas
 * dans la liste, donc jamais annonce. Au tout premier passage, les outils deja
 * la sont notes comme connus, sauf PREMIERE_ANNONCE (ceux du 28/09 : l'eSIM et
 * l'embauche, jamais annonces).
 *
 * Deroule :
 *   - les nouveaux outils attendent GROUPE_MS (10 min) : ceux d'un meme
 *     deploiement partent dans UN post ;
 *   - un post au plus toutes les ESPACE_MS (3 h) ;
 *   - Claude (Haiku) ecrit le tweet ET la scene de l'image, d'apres les
 *     descriptions des outils seulement ; un tweet qui promet un prix, un
 *     « 100x », une garantie ou un partenariat est refuse et remplace par un
 *     gabarit sobre (la regle du 27/09 : pas de logo ni de « × PayAI », on est
 *     liste dans un catalogue ouvert, pas partenaire) ;
 *   - Kling dessine SWOGE (la reference officielle) dans une scene haussiere,
 *     sans texte ; si Kling echoue, l'image officielle part a sa place ;
 *   - Telegram recoit l'image, le tweet, et un lien « Post this on X » qui
 *     ouvre X avec le texte deja ecrit.
 * Les outils sont notes « annonces » AVANT l'envoi : un redemarrage ne reposte
 * pas. Cout : 0,028 $ l'image Kling + ~0,002 $ de Haiku. ANNONCES=0 coupe.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

const GROUPE_MS = 10 * 60e3;
const ESPACE_MS = 3 * 3600e3;
const PREMIERE_ANNONCE = ['find_paid_services', 'hire_paid_service', 'find_esim_plans', 'propose_esim_purchase'];
const LIEN = 'https://swoleeswoge.dog/swogeagentic.html';
const TWEET_MAX = 280;
/* Ce qu'un post de SWOGE ne dit jamais : une promesse de prix, de gain ou un partenariat. */
const INTERDIT = /\b(guarantee[ds]?|risk[- ]?free|\d+\s?x\b|to the moon|moon(ing)?|price (will|going)|financial advice|partner(ship|ed)?|collab(oration)?|official .*payai|payai official)\b|×/i;
const SWOGE_MOT = 'SWOGE, the character in the reference image: a very muscular, bodybuilder-build shiba inu — keep his face, fur colours and muscular build.';
const AMBIANCE = ' Bullish, triumphant mood: glowing green candlestick charts shooting upward behind him, golden confetti, neon city lights, cinematic lighting, highly detailed, sharp focus, no text, no letters, no logos.';

const SYSTEME = 'You write launch posts for X (Twitter) for SWOGE WORLD, a crypto gaming site whose mascot is SWOGE, a very muscular shiba inu. '
  + 'Answer with JSON only, no prose, no code fence.';
function consigne(outils) {
  return 'New tools just went live in SwogeAgentic (the SWOGE AI agent):\n'
    + outils.map((o) => '- ' + o.nom + ': ' + String(o.description || '').slice(0, 400) + (o.prixUsd ? ' (price for other AI agents: $' + o.prixUsd + ' per call)' : '')).join('\n')
    + '\n\nWrite {"tweet":"...","scene":"..."}.\n'
    + 'tweet: ONE post, at most 230 characters, English, hype and bullish about what the user can now DO, in plain words a normal person understands; '
    + 'only claim what the descriptions say; no token price talk, no "moon", no "100x", no guarantees, no financial advice, do not mention any partner or other company; '
    + 'at most 3 emojis and 2 hashtags; do not include any link (it is added after).\n'
    + 'scene: the picture, 1-2 sentences: SWOGE doing something that shows the new feature, epic and fun. No text or logos in the picture.';
}

const nettoieTweet = (t) => String(t || '').replace(/https?:\/\/\S+/g, '').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
/** Le tweet final (lien compris) ou null s'il ne respecte pas les regles. */
function valideTweet(t) {
  const x = nettoieTweet(t);
  if (!x || x.length < 20 || INTERDIT.test(x)) return null;
  const complet = x + '\n\n👉 ' + LIEN;
  return complet.length <= TWEET_MAX ? complet : null;
}
const NOMS = { find_esim_plans: 'travel eSIMs', propose_esim_purchase: 'travel eSIMs', find_paid_services: 'hiring other AI agents', hire_paid_service: 'hiring other AI agents' };
function gabarit(outils) {
  const noms = [...new Set(outils.map((o) => NOMS[o.nom] || o.nom.replace(/_/g, ' ')))];
  const liste = noms.length > 1 ? noms.slice(0, -1).join(', ') + ' and ' + noms[noms.length - 1] : noms[0];
  return valideTweet('🚀 New in SwogeAgentic: ' + liste + '. Just ask the SWOGE AI agent — it does the work for you. 💪') || ('🚀 New in SwogeAgentic\n\n👉 ' + LIEN);
}
function lisJson(txt) {
  try { const m = /\{[\s\S]*\}/.exec(String(txt || '')); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}
const echappe = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** La legende Telegram : le tweet, puis un lien qui ouvre X avec le texte deja ecrit. */
const legende = (tweet) => echappe(tweet) + '\n\n<a href="https://twitter.com/intent/tweet?text=' + encodeURIComponent(tweet) + '">𝕏 Post this on X</a>';

/**
 * deps : { outils() → [{ nom, description, prixUsd? }], kling, telegram ({ notifyPhoto }), claude() → client Anthropic | null,
 *          dossier, site, journal?(o), maintenant?, attente? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const fichier = path.join(deps.dossier, 'annonces.json');
  const journal = deps.journal || (() => {});
  let E = null;
  try { E = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch (e) { E = null; }
  const premiere = !E;
  E = Object.assign({ connus: {}, attente: {}, posts: [], dernier: 0 }, E || {});
  const ecrit = () => { try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fichier, JSON.stringify(E)); } catch (e) { /* jamais bloquant */ } };
  let enCours = false;
  let initial = premiere;

  /** Les nouveaux outils rejoignent la file ; rend la liste courante (nom → outil). */
  function releve() {
    let l;
    try { l = deps.outils() || []; } catch (e) { return null; }
    const cur = new Map(l.filter((o) => o && o.nom).map((o) => [o.nom, o]));
    const t = maintenant();
    for (const nom of cur.keys()) {
      if (E.connus[nom] || E.attente[nom]) continue;
      if (initial && !PREMIERE_ANNONCE.includes(nom)) E.connus[nom] = t;
      else E.attente[nom] = t;
    }
    /* Un outil retire avant son annonce : on ne l'annonce plus. */
    for (const nom of Object.keys(E.attente)) if (!cur.has(nom)) delete E.attente[nom];
    initial = false;
    ecrit();
    return cur;
  }

  async function ecrire(outils) {
    const client = deps.claude ? deps.claude() : null;
    if (!client) return { tweet: gabarit(outils), scene: null, secours: 'no Claude' };
    try {
      const r = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 400, system: SYSTEME, messages: [{ role: 'user', content: consigne(outils) }] });
      const j = lisJson((r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
      const tweet = j && valideTweet(j.tweet);
      const scene = j && typeof j.scene === 'string' && !INTERDIT.test(j.scene) ? j.scene.slice(0, 500) : null;
      return tweet ? { tweet, scene } : { tweet: gabarit(outils), scene, secours: 'the written post broke a rule' };
    } catch (e) { return { tweet: gabarit(outils), scene: null, secours: 'Claude failed' }; }
  }

  /** Un passage : releve, puis publie la file si elle a attendu et si le dernier post est assez vieux. */
  async function tour(o) {
    o = o || {};
    if (process.env.ANNONCES === '0' || enCours) return null;
    const cur = releve();
    if (!cur) return null;
    const t = maintenant();
    const noms = Object.keys(E.attente);
    if (!noms.length) return null;
    const plusVieux = Math.min(...noms.map((n) => E.attente[n]));
    if (!o.maintenant && (t - plusVieux < GROUPE_MS || t - E.dernier < ESPACE_MS)) return null;
    const outils = noms.map((n) => cur.get(n)).filter(Boolean);
    enCours = true;
    /* Note AVANT d'envoyer : un redemarrage pendant Kling ne reposte pas. */
    const cle = 'annonce-' + new Date(t).toISOString().slice(0, 16);
    for (const n of noms) { E.connus[n] = t; delete E.attente[n]; }
    E.dernier = t;
    const post = { cle, t, outils: noms, etat: 'lance' };
    E.posts.push(post); E.posts = E.posts.slice(-50); ecrit();
    try {
      const txt = await ecrire(outils);
      post.tweet = txt.tweet; post.secours = txt.secours || null; ecrit();
      let image = null;
      if (deps.kling && deps.kling.actif && deps.kling.actif()) {
        const r = await deps.kling.image({ prompt: SWOGE_MOT + ' ' + (txt.scene || 'He stands on a rooftop at night holding a glowing smartphone that shows the SWOGE AI agent at work, pumping his fist.') + AMBIANCE,
          image: deps.site + '/img/site/swoge_reference.jpg', reference: 'subject', format: '16:9' }, deps.attente).catch((e) => ({ ok: false, raison: String(e && e.message || e) }));
        if (r && r.ok) image = r.url; else post.imageRaison = (r && r.raison) || 'Kling failed';
      } else post.imageRaison = 'Kling is not set up';
      post.image = image || deps.site + '/img/site/swoge_reference.jpg';
      post.imageKling = !!image;
      deps.telegram.notifyPhoto(post.image, legende(post.tweet));
      post.etat = 'poste'; ecrit();
      journal({ annonce: cle, outils: noms, tweet: post.tweet, image: post.image, imageKling: post.imageKling, secours: post.secours, imageRaison: post.imageRaison || null });
      return { ok: true, cle, outils: noms, tweet: post.tweet, image: post.image };
    } catch (e) {
      post.etat = 'echec'; post.raison = String(e && e.message || e).slice(0, 200); ecrit();
      return { ok: false, raison: post.raison };
    } finally { enCours = false; }
  }

  let minuteur = null;
  function demarre(pasMs) {
    if (minuteur) return;
    minuteur = setInterval(() => { tour().catch(() => {}); }, pasMs || 60e3);
    if (minuteur.unref) minuteur.unref();
  }
  const etat = () => ({ actif: process.env.ANNONCES !== '0', attente: Object.assign({}, E.attente), connus: Object.keys(E.connus).length,
    dernier: E.dernier || null, posts: E.posts.slice(-10).reverse(), groupeMin: GROUPE_MS / 60e3, espaceH: ESPACE_MS / 3600e3 });
  return { tour, demarre, etat, releve };
}

module.exports = { cree, valideTweet, gabarit, legende, INTERDIT, PREMIERE_ANNONCE, GROUPE_MS, ESPACE_MS, LIEN, TWEET_MAX };
