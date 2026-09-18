'use strict';
/*
 * ==================== LES COMMANDES DU BOT TELEGRAM ====================
 *
 * ---- pourquoi ce fichier existe ----
 *
 * « T as une commande pour que le bot affiche son numero ? » Il n y en avait
 * pas : @SwogeBot ne faisait qu ENVOYER (annonces, sauvegardes, posts X) —
 * aucun des trois services qui portent son jeton ne lisait ce qu on lui
 * ecrit. Or la veille des comptes suivis a besoin d un chat PRIVE, donc de
 * l identifiant numerique du proprietaire, et le trouver a la main (un
 * autre bot, une adresse d API) est la premiere chose qui a ete mal faite le
 * 18 septembre 2026 : le nom du canal public a la place.
 *
 * Ici, le bot lit ses messages toutes les trente secondes (`getUpdates`,
 * avec un decalage garde sur le volume pour ne pas relire) et repond a deux
 * commandes, en prive seulement :
 *   /id      → « Votre identifiant : 123456789 », a coller dans X_VEILLE_CHAT
 *   /start   → la meme chose, puisque c est le premier bouton qu on presse
 * Tout le reste est ignore, et rien n est jamais repondu dans un canal ou un
 * groupe : la commande y serait une invitation a la copier.
 *
 * ---- pourquoi ca ne gene pas les autres services ----
 *
 * Le bot n a pas de webhook (verifie le 18 septembre 2026, `getWebhookInfo`),
 * et le service des nouveaux jetons ne lit `getUpdates` qu une fois au
 * demarrage, en diagnostic, sans decalage. Deux lecteurs sans attente longue
 * ne se bloquent pas ; au pire l autre voit un message de moins dans son
 * diagnostic. Sans jeton, le module ne fait rien et le dit.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FICHIER = () => path.join(cfg.DATA_DIR, 'tg_commandes.json');
function litEtat() { try { return JSON.parse(fs.readFileSync(FICHIER(), 'utf8')) || {}; } catch (e) { return {}; } }
function ecritEtat(e) { fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); fs.writeFileSync(FICHIER(), JSON.stringify(e)); }

function enabled() { return !!cfg.TG_BOT_TOKEN; }

/** La reponse a un message, ou null si l on se tait. Pure : testable seule. */
function reponseA(m) {
  if (!m || !m.chat || m.chat.type !== 'private') return null;
  const t = String(m.text || '').trim();
  if (!/^\/(id|start)(@\w+)?$/i.test(t)) return null;
  return `Votre identifiant Telegram : ${m.chat.id}\n\nC est ce nombre qu il faut mettre dans la variable X_VEILLE_CHAT du serveur pour recevoir ici les reponses proposees, avec leurs boutons.`;
}

async function envoie(chatId, texte, prendre) {
  const f = prendre || fetch;
  await f(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texte }), signal: AbortSignal.timeout(15000),
  });
}

let enCours = false;
/** Un tour : lit ce qui est arrive depuis le dernier decalage, repond, avance. */
async function tour(opts) {
  const o = opts || {};
  if (!enabled()) return { etat: 'inactif' };
  if (enCours) return { etat: 'en cours' };
  enCours = true;
  try {
    const f = o.prendre || fetch;
    const etat = litEtat();
    const q = etat.decalage ? '?offset=' + etat.decalage : '';
    const r = await f(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/getUpdates${q}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return { etat: 'erreur', detail: String(j.description || r.status).slice(0, 100) };
    let repondus = 0;
    for (const u of j.result || []) {
      etat.decalage = u.update_id + 1;
      const rep = reponseA(u.message);
      if (rep) { await envoie(u.message.chat.id, rep, o.prendre); repondus++; }
    }
    if ((j.result || []).length) ecritEtat(etat);
    return { etat: 'lu', messages: (j.result || []).length, repondus };
  } finally {
    enCours = false;
  }
}

function planifie() {
  if (!enabled()) { console.log('[tg] commandes ETEINTES : TG_BOT_TOKEN absent'); return null; }
  console.log('[tg] commandes ARMEES : /id en prive');
  const t = () => tour().catch((e) => console.error('[tg] commandes : ' + (e.message || e)));
  const premier = setTimeout(t, 20000);
  const minuterie = setInterval(t, 30000);
  return { arrete() { clearTimeout(premier); clearInterval(minuterie); } };
}

module.exports = { enabled, reponseA, tour, planifie };
