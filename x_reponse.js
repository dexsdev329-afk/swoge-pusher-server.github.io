'use strict';
/*
 * ==================== LA REPONSE PREPAREE, JAMAIS ENVOYEE SANS VOUS ====================
 *
 * ---- pourquoi ce fichier existe ----
 *
 * « Tu penses qu on peut aussi tweeter sous les posts d Elon Musk et de Maye
 * Musk ? » Oui — mais pas en automatique. Les regles d automatisation de X
 * interdisent les reponses automatiques non sollicitees, et repondre a la
 * chaine sous un compte a forte audience avec un contenu promotionnel est le
 * cas d ecole du « reply spam » : c est le compte qui saute. D ou ce module :
 * l agent LIT les nouveaux posts des comptes suivis, et quand l un d eux parle
 * de chiens, de Doge, de memecoins, de sport, d Optimus, d IA…, il PREPARE une
 * reponse courte et drole avec une image de SWOGE dans le contexte, et l
 * envoie sur un Telegram PRIVE avec deux boutons : Poster, Ignorer. Rien ne
 * part sans un doigt humain — c est la ligne exacte que X trace entre un
 * compte et un bot.
 *
 * ---- pas a tous les posts ----
 *
 * « Faut pas le faire a tous les posts pour pas spam. » Trois freins :
 *  - un filtre de MOTS avant tout appel payant : un post qui ne parle de rien
 *    de tout ca n est meme pas montre au modele ;
 *  - le modele lui-meme dit si une reponse a sa place (« pertinent »), et
 *    l on ne propose rien sinon ;
 *  - un plafond par jour (`X_VEILLE_MAX_JOUR`, deux) et au plus une
 *    proposition par compte toutes les quatre heures. Deux reponses bien
 *    placees par semaine valent plus qu une sous chaque post.
 *
 * ---- ce que ca coute (grille docs.x.com, 18 septembre 2026) ----
 *
 *  - lire un post : 0,005 $ ; on ne lit que ce qui est NOUVEAU (`since_id`),
 *    donc environ un demi-dollar par jour pour un compte qui poste cinquante
 *    fois, quelques centimes pour un compte qui poste peu ;
 *  - trouver l identifiant d un compte : 0,010 $, une seule fois, garde ;
 *  - une proposition : l image (~0,22 $ en qualite high) + le texte ;
 *  - une reponse postee : 0,015 $.
 *  Avec deux comptes et deux propositions par jour : environ 20 $ par mois.
 *
 * ---- le bouton ----
 *
 * Un lien a usage unique, valable douze heures, envoye dans un chat PRIVE
 * (`X_VEILLE_CHAT`, sinon `TG_BACKUP_CHAT_ID`). Jamais dans le canal public :
 * un lien qui poste au nom du compte est une cle, et une cle ne se publie
 * pas. Sans chat prive configure, le module le dit et ne propose rien.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const xp = require('./x_post');

const API = 'https://api.x.com';

function env() {
  const e = xp.env();
  return Object.assign(e, {
    comptes: String(process.env.X_VEILLE || 'elonmusk,mayemusk').split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean),
    /* Trente minutes, decision du proprietaire le 18 septembre 2026 (« ils
       ne sont pas actifs souvent et ca coute de l argent »). Ce qui coute,
       c est le post LU (0,005 $), pas l appel : avec `since_id`, un tour sans
       nouveau post ne rend rien. Trente minutes reste dans la fenetre ou une
       reponse est vue. */
    minutes: Math.max(10, Number(process.env.X_VEILLE_MIN) || 30),
    maxJour: Math.max(0, Number(process.env.X_VEILLE_MAX_JOUR) || 3),
    chat: process.env.X_VEILLE_CHAT || cfg.TG_BACKUP_CHAT_ID || '',
    mots: String(process.env.X_VEILLE_MOTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
}
/* ---- LE CHAT DOIT ETRE PRIVE, ET ON LE VERIFIE ----
 * Le 18 septembre 2026, a la mise en service, la variable a ete remplie avec
 * le nom du canal public (« @… »), le meme que TG_CHAT_ID : les boutons —
 * des liens qui postent au nom du compte — seraient partis devant tout le
 * monde. Un chat prive Telegram a un identifiant NUMERIQUE POSITIF ; un canal
 * ou un groupe commence par « @ » ou par « -100 ». On refuse tout le reste,
 * en le disant, et surtout la valeur du canal public. */
function chatPrive(v) { return /^\d{5,20}$/.test(String(v || '')) && String(v) !== String(cfg.TG_CHAT_ID || ''); }
function manque() {
  const m = xp.manque();
  const chat = process.env.X_VEILLE_CHAT || cfg.TG_BACKUP_CHAT_ID || '';
  if (!chat) m.push('X_VEILLE_CHAT (un chat Telegram PRIVE pour les boutons)');
  else if (!chatPrive(chat)) m.push('X_VEILLE_CHAT doit etre l identifiant NUMERIQUE d un chat prive (ex. 123456789), pas un canal ni un groupe : les boutons postent au nom du compte');
  if (!cfg.TG_BOT_TOKEN) m.push('TG_BOT_TOKEN');
  return m;
}
function enabled() { return manque().length === 0; }

// ------------------------------------------------------------ les sujets

/* Les sujets qui justifient une reponse de SWOGE. Le filtre est large expres :
   c est le modele qui tranche ensuite, et il est plus fin qu une liste. */
const MOTS = [
  'dog', 'doge', 'shiba', 'shibe', 'puppy', 'pup', 'woof', 'bark',
  'memecoin', 'meme coin', 'crypto', 'bitcoin', 'token', 'blockchain',
  'sport', 'football', 'soccer', 'nfl', 'nba', 'nhl', 'mlb', 'hockey', 'tennis', 'baseball', 'basketball', 'cricket', 'game',
  'optimus', 'robot', 'humanoid', 'ai', 'xai', 'grok', 'agent', 'neural',
  'mars', 'rocket', 'moon', 'starship', 'launch',
];
function sujet(texte, extra) {
  const t = String(texte || '').toLowerCase();
  const tous = MOTS.concat(extra || []);
  return tous.filter((m) => new RegExp('(^|[^a-z])' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)', 'i').test(t));
}

// ------------------------------------------------------------ X, en lecture

async function litX(chemin, params, prendre) {
  const e = env();
  const f = prendre || fetch;
  const url = API + chemin;
  const s = xp.signeOAuth('GET', url, params, e);
  const q = Object.entries(params).map(([k, v]) => xp.enc(k) + '=' + xp.enc(v)).join('&');
  const r = await f(url + (q ? '?' + q : ''), { method: 'GET', headers: { authorization: s.entete }, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X ${chemin} : HTTP ${r.status} ${(j.detail || j.title || '').slice(0, 120)}`);
  return j;
}
async function idDe(username, prendre) {
  const j = await litX('/2/users/by/username/' + encodeURIComponent(username), {}, prendre);
  const id = j.data && j.data.id;
  if (!id) throw new Error('X : compte introuvable ' + username);
  return String(id);
}
/** Les posts d un compte plus recents que `depuis` (un identifiant), les
 *  plus recents d abord. Sans `depuis`, les dix derniers. */
async function postsDe(id, depuis, prendre) {
  const params = { max_results: '10', exclude: 'retweets,replies', 'tweet.fields': 'created_at' };
  if (depuis) params.since_id = depuis;
  const j = await litX('/2/users/' + id + '/tweets', params, prendre);
  return (j.data || []).map((p) => ({ id: String(p.id), texte: p.text || '', quand: p.created_at || null }));
}

// ------------------------------------------------------------ le journal

const FICHIER = () => path.join(cfg.DATA_DIR, 'x_reponses.json');
function litJournal() {
  try { const j = JSON.parse(fs.readFileSync(FICHIER(), 'utf8')) || {}; return { comptes: j.comptes || {}, propositions: j.propositions || {} }; }
  catch (e) { return { comptes: {}, propositions: {} }; }
}
function ecritJournal(j) { fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); fs.writeFileSync(FICHIER(), JSON.stringify(j, null, 1)); }
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
/* Les propositions du jour qui comptent pour le plafond : celles qui ont ete
   MONTREES. Une entree « non pertinent » n a rien coute et rien montre. */
function proposeesLe(j, jour) { return Object.values(j.propositions).filter((p) => !p.silencieux && p.quand && p.quand.slice(0, 10) === jour); }
/* La derniere proposition MONTREE pour ce compte : un « non pertinent » n a
   rien montre, il ne fait pas attendre quatre heures. */
function derniereDe(j, compte) {
  return Object.values(j.propositions).filter((p) => p.compte === compte && !p.silencieux).map((p) => Date.parse(p.quand || 0)).sort((a, b) => b - a)[0] || 0;
}

// ------------------------------------------------------------ le modele

const SYSTEME = `You are the voice of SWOGE ($SWOGE), a community-run memecoin with a real crypto game ecosystem, mascot: a very buff Shiba Inu. You are shown a post by a famous account. Decide whether a SHORT, witty reply from the buff dog would land well there — funny, relevant to the post, never spammy, never begging for attention, never rude, no links, no hashtags, no price talk, at most one emoji, maximum 180 characters. Mentioning $SWOGE is fine only if it fits naturally. If a reply would look like a bot pushing a coin under an unrelated post, say it is not pertinent.
Also describe, in one sentence, an image scene where the buff Shiba is placed IN the context of the post (same theme, same objects), no text in the image.
Finally rate your confidence from 0 to 10 that this reply lands well with that audience and could never be mistaken for a bot pushing a coin: 10 = a human community manager would post it without hesitation, 5 = debatable, 0 = spam.
Answer with JSON only: {"pertinent": true|false, "raison": "...", "reponse": "...", "scene": "...", "confiance": 0-10}`;

async function juge(compte, post, prendre) {
  const e = env();
  if (!e.anthropic) return { pertinent: false, raison: 'ANTHROPIC_API_KEY absente' };
  const f = prendre || fetch;
  const r = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': e.anthropic, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: e.modeleTexte, max_tokens: 300, system: SYSTEME,
      messages: [{ role: 'user', content: `Post by @${compte}:\n"""${post.texte.slice(0, 1000)}"""` }] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('modele : HTTP ' + r.status);
  const j = await r.json();
  const brut = ((j.content || []).find((b) => b.type === 'text') || {}).text || '';
  const m = brut.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('modele : reponse illisible');
  const a = JSON.parse(m[0]);
  const confiance = Number(a.confiance);
  return { pertinent: !!a.pertinent, raison: String(a.raison || '').slice(0, 200),
           reponse: nettoieReponse(a.reponse), scene: String(a.scene || '').slice(0, 400),
           confiance: isFinite(confiance) ? Math.min(10, Math.max(0, Math.round(confiance))) : null };
}
/** Une reponse propre : pas de lien, pas de dieze, 200 caracteres au plus. $SWOGE n est PAS force ici. */
function nettoieReponse(brut) {
  let t = String(brut || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/https?:\/\/\S+/gi, '').replace(/#\w+/g, '').replace(/\s{2,}/g, ' ').trim();
  if (t.length > 200) t = t.slice(0, 200).replace(/\s\S*$/, '').trim();
  return t;
}

// ------------------------------------------------------------ Telegram, avec les boutons

async function envoieProposition(p, prendre) {
  const e = env();
  const f = prendre || fetch;
  const base = e.domaine ? `https://${e.domaine}` : '';
  /* La note de Claude en tete : a 9 ou 10, on peut appuyer sans relire. */
  const note = p.confiance === null || p.confiance === undefined ? '' : `${p.confiance >= 9 ? '🟢' : p.confiance >= 7 ? '🟡' : '🔴'} Confiance de Claude : <b>${p.confiance}/10</b>\n\n`;
  const caption = note + `🐦 <b>@${p.compte}</b> vient de poster :\n<i>${echappe(p.postTexte.slice(0, 300))}</i>\n\n💬 Réponse proposée :\n<b>${echappe(p.reponse)}</b>\n\n` +
                  `Valable 12 h. Rien ne part sans le bouton.`;
  const boutons = [[{ text: '✅ Poster la réponse', url: `${base}/x/reponse/${p.jeton}/poster` },
                    { text: '🗑 Ignorer', url: `${base}/x/reponse/${p.jeton}/ignorer` }],
                   [{ text: '🔗 Voir le post', url: p.url }]];
  const r = await f(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendPhoto`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: e.chat, photo: `${base}/x/image/${p.image.replace(/\.png$/, '')}.png`, caption, parse_mode: 'HTML',
                           reply_markup: { inline_keyboard: boutons } }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error('telegram : ' + (j.description || r.status));
  return true;
}
const echappe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------ la veille

let enCours = false;
/**
 * Un tour de veille : lit les nouveaux posts des comptes suivis, propose au
 * plus ce que les freins permettent. `opts.prendre` et `opts.maintenant`
 * servent aux essais. Rend ce qui s est passe, compte par compte.
 */
async function veille(opts) {
  const o = opts || {};
  const t = o.maintenant || Date.now();
  if (!enabled()) return { etat: 'inactif', manque: manque() };
  if (enCours) return { etat: 'en cours' };
  enCours = true;
  const e = env();
  const journal = litJournal();
  const bilan = { etat: 'veille', comptes: {}, proposees: 0 };
  try {
    for (const compte of e.comptes) {
      const c = journal.comptes[compte] || {};
      const b = { lus: 0, sujets: 0, proposees: 0, sautes: [] };
      bilan.comptes[compte] = b;
      try {
        if (!c.id) { c.id = await idDe(compte, o.prendre); journal.comptes[compte] = c; ecritJournal(journal); }
        const posts = await postsDe(c.id, c.depuis, o.prendre);
        b.lus = posts.length;
        if (posts.length) { c.depuis = posts[0].id; journal.comptes[compte] = c; ecritJournal(journal); }
        for (const post of posts) {
          /* Un post de plus de six heures ne se repond plus : la reponse
             arriverait apres la vague, et au premier tour on ne remonte pas
             le passe. */
          if (post.quand && t - Date.parse(post.quand) > 6 * 3600000) { b.sautes.push(post.id + ' : trop vieux'); continue; }
          const mots = sujet(post.texte, e.mots);
          if (!mots.length) { b.sautes.push(post.id + ' : hors sujet'); continue; }
          b.sujets++;
          if (proposeesLe(journal, jourDe(t)).length >= e.maxJour) { b.sautes.push(post.id + ' : plafond du jour atteint'); continue; }
          if (t - derniereDe(journal, compte) < 4 * 3600000) { b.sautes.push(post.id + ' : moins de quatre heures depuis la derniere proposition pour ce compte'); continue; }
          if (Object.values(journal.propositions).some((p) => p.postId === post.id)) { b.sautes.push(post.id + ' : deja traite'); continue; }
          const v = await juge(compte, post, o.prendre);
          if (!v.pertinent || !v.reponse) {
            journal.propositions['nc-' + post.id] = { compte, postId: post.id, etat: 'non pertinent', raison: v.raison, quand: new Date(t).toISOString(), silencieux: true };
            ecritJournal(journal);
            b.sautes.push(post.id + ' : ' + (v.raison || 'non pertinent').slice(0, 80));
            continue;
          }
          const jeton = crypto.randomBytes(18).toString('base64url');
          const pid = 'rep-' + post.id;
          const image = 'rep_' + post.id + '.png';
          const g = await xp.genereImage(xp.promptImage({ prompt: v.scene || 'reacting to big news on a giant screen' }), o.prendre);
          fs.mkdirSync(xp.DOSSIER_IMAGES(), { recursive: true });
          fs.writeFileSync(path.join(xp.DOSSIER_IMAGES(), image), g.png);
          const p = { compte, postId: post.id, postTexte: post.texte, url: `https://x.com/${compte}/status/${post.id}`,
                      reponse: v.reponse, scene: v.scene, image, jeton, etat: 'proposee', quand: new Date(t).toISOString(),
                      expire: new Date(t + 12 * 3600000).toISOString(), mots, confiance: v.confiance };
          journal.propositions[pid] = p; ecritJournal(journal);
          await envoieProposition(p, o.prendre);
          b.proposees++; bilan.proposees++;
          console.log(`[x-veille] proposition pour @${compte} sur ${post.id} (${mots.join(', ')})`);
        }
      } catch (err) {
        b.erreur = String(err && err.message || err).slice(0, 200);
        console.error(`[x-veille] @${compte} : ${b.erreur}`);
      }
    }
    return bilan;
  } finally {
    enCours = false;
  }
}

// ------------------------------------------------------------ le bouton

/** Le geste du proprietaire : `poster` ou `ignorer`, par le jeton du lien. */
async function geste(jeton, action, opts) {
  const journal = litJournal();
  const cle = Object.keys(journal.propositions).find((k) => jeton && journal.propositions[k].jeton === jeton);
  if (!cle) return { etat: 'inconnu' };
  return agit(journal, cle, action, opts);
}
/** Le meme geste depuis le panneau d administration, par la cle de la
 *  proposition : la session d administrateur vaut le jeton du lien. */
async function gesteParCle(cle, action, opts) {
  const journal = litJournal();
  if (!journal.propositions[cle] || journal.propositions[cle].silencieux) return { etat: 'inconnu' };
  return agit(journal, cle, action, opts);
}
async function agit(journal, cle, action, opts) {
  const o = opts || {};
  const t = o.maintenant || Date.now();
  const p = journal.propositions[cle];
  if (p.etat !== 'proposee') return { etat: p.etat, url: p.replyUrl || null };
  if (Date.parse(p.expire) < t) { p.etat = 'expiree'; ecritJournal(journal); return { etat: 'expiree' }; }
  if (action === 'ignorer') { p.etat = 'ignoree'; p.jeton = null; ecritJournal(journal); return { etat: 'ignoree' }; }
  if (action !== 'poster') return { etat: 'inconnu' };
  try {
    const png = fs.readFileSync(path.join(xp.DOSSIER_IMAGES(), p.image));
    const mediaId = await xp.televerse(png, o.prendre);
    const id = await xp.publie(p.reponse, mediaId, o.prendre, p.postId);
    p.etat = 'postee'; p.replyId = id; p.replyUrl = `https://x.com/${env().compte}/status/${id}`; p.jeton = null; p.posteeLe = new Date(t).toISOString();
    ecritJournal(journal);
    console.log(`[x-veille] reponse postee sous @${p.compte}/${p.postId} : ${p.replyUrl}`);
    return { etat: 'postee', url: p.replyUrl };
  } catch (err) {
    p.erreur = String(err && err.message || err).slice(0, 200); ecritJournal(journal);
    return { etat: 'rate', erreur: p.erreur };
  }
}

/** Ce que le serveur montre sur /x/veille : sans jeton, sans cle. */
function etat() {
  const j = litJournal();
  const e = env();
  const l = Object.entries(j.propositions).filter(([, p]) => !p.silencieux)
    .sort((a, b) => (b[1].quand || '').localeCompare(a[1].quand || '')).slice(0, 20)
    .map(([k, p]) => ({ cle: k, compte: p.compte, post: p.url, reponse: p.reponse, etat: p.etat, quand: p.quand, confiance: p.confiance === undefined ? null : p.confiance, image: '/x/image/' + p.image.replace(/\.png$/, '') + '.png', reponseUrl: p.replyUrl || null }));
  return { actif: enabled(), manque: manque(), comptes: e.comptes, toutesLes: e.minutes + ' min', maxJour: e.maxJour,
           suivis: Object.fromEntries(Object.entries(j.comptes).map(([c, v]) => [c, { id: v.id, depuis: v.depuis || null }])), propositions: l };
}

function planifie() {
  if (!enabled()) { console.log('[x-veille] ETEINTE : il manque ' + manque().join(', ')); return null; }
  const e = env();
  console.log(`[x-veille] ARMEE : @${e.comptes.join(', @')} toutes les ${e.minutes} min, ${e.maxJour} proposition(s) par jour au plus`);
  const tour = () => veille().catch((x) => console.error('[x-veille] ' + (x.message || x)));
  const premier = setTimeout(tour, 180000);
  const minuterie = setInterval(tour, e.minutes * 60000);
  return { arrete() { clearTimeout(premier); clearInterval(minuterie); } };
}

module.exports = { enabled, manque, env, MOTS, sujet, nettoieReponse, juge, veille, geste, gesteParCle, etat, planifie, litJournal };
