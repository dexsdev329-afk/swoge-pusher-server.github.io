'use strict';
/* ==========================================================================
 * LANCER UN JETON DEPUIS TELEGRAM (03/10/2026)
 * ==========================================================================
 *
 * Demande du proprietaire : « via Telegram, lancer un jeton ». Le modele copie est
 * Bankr / Clanker (on decrit le jeton dans un message, il nait) — sauf sur un point,
 * et il n'est pas negociable : Bankr GARDE les portefeuilles de ses utilisateurs.
 * Ici le bot ne signe rien et ne voit aucune cle. Il repond par un lien vers
 * launchpad.html, pool, nom et symbole deja remplis ; c'est le portefeuille du
 * joueur qui envoie createToken, exactement comme depuis le site ou l'agent.
 *
 *   /launch Moon Dog MDOG eth    → pool ETH (WETH), frais 0,0001 ETH
 *   /launch Moon Dog $MDOG       → pool $SWOGE (par defaut), 10 000 $SWOGE brules
 *
 * L'offre passe par lancement_v4.propose : les MEMES refus que l'agent et la page
 * (actions tokenisees copiees, grands tickers, « SWOGE », liens douteux).
 *
 * Apres le lancement, la page renvoie le hash de la transaction (POST
 * /launchpad/v4/lance). Le bot n'annonce RIEN sur la foi de la page : il relit le
 * recu sur la chaine, exige l'evenement LaunchedInstant du launchpad de l'offre, et
 * que le jeton cree porte le nom et le symbole demandes. Alors seulement il poste le
 * kit du createur dans le chat d'ou venait la commande — une fois.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

const ATTENTE_MS = 2 * 3600e3;          // une offre attend son lancement deux heures (l'offre signee, elle, vit 15 min : la page en redemande une)
const PAR_CHAT_MIN = 3;                 // trois offres par minute et par chat : un groupe ne devient pas une machine a liens
const GARDE = 300;                      // offres en attente gardees au plus
const POOLS = { eth: 'eth', weth: 'eth', swoge: 'swoge' };

/** « /launch Moon Dog MDOG eth » → { name, symbol, pool } ; null si ce n'est pas la commande ; { erreur } si mal formee. */
function lisCommande(texte) {
  const t = String(texte || '').trim();
  const m = /^\/launch(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t);
  if (!m) return null;
  const mots = String(m[1] || '').split(/\s+/).filter(Boolean);
  let pool = 'swoge';
  if (mots.length && POOLS[mots[mots.length - 1].toLowerCase()]) pool = POOLS[mots.pop().toLowerCase()];
  if (mots.length < 2) return { erreur: 'usage' };
  const symbol = mots.pop().replace(/^\$/, '');
  return { name: mots.join(' '), symbol, pool };
}

const USAGE = 'Launch a token on Robinhood Chain:\n'
  + '/launch <name> <SYMBOL> [eth|swoge]\n'
  + 'e.g. /launch Moon Dog MDOG eth\n\n'
  + 'eth: paired with ETH, fee 0.0001 ETH. swoge (default): paired with $SWOGE, fee 10,000 $SWOGE, burned.\n'
  + 'You sign in your own wallet: the bot never holds keys.';

/**
 * deps : { propose(e) → {ok, offre|raison} (lancement_v4), site (URL du site),
 *          lis: { recu(hash) → recu|null, jeton(adr) → {name, symbol} },
 *          envoie(chatId, texte), dossier, maintenant? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const FICHIER = deps.dossier ? path.join(deps.dossier, 'tg_lancements.json') : null;
  const MESURE = { offres: 0, refus: 0, annonces: 0, rejets: 0 };
  let attente = {};
  try { if (FICHIER) attente = JSON.parse(fs.readFileSync(FICHIER, 'utf8')) || {}; } catch (e) { attente = {}; }
  const ecrit = () => { if (!FICHIER) return; try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(FICHIER, JSON.stringify(attente)); } catch (e) { /* le disque plein ne fait pas tomber le bot */ } };
  const debits = new Map();

  function purge() {
    const t = maintenant();
    for (const [k, v] of Object.entries(attente)) if (t > v.limite) delete attente[k];
    const ids = Object.keys(attente);
    if (ids.length > GARDE) ids.sort((a, b) => attente[a].t - attente[b].t).slice(0, ids.length - GARDE).forEach((k) => delete attente[k]);
  }

  /** La reponse au message `m`, ou null si ce n'est pas /launch. */
  async function commande(m) {
    if (!m || !m.chat) return null;
    const c = lisCommande(m.text);
    if (!c) return null;
    if (c.erreur) return USAGE;
    const t = maintenant(), d = debits.get(m.chat.id) || [];
    const recents = d.filter((x) => t - x < 60e3);
    if (recents.length >= PAR_CHAT_MIN) return 'Too many launch requests here - wait a minute.';
    recents.push(t); debits.set(m.chat.id, recents);
    if (debits.size > 2000) debits.clear();
    const r = await deps.propose({ pool: c.pool, name: c.name, symbol: c.symbol });
    if (!r || !r.ok) { MESURE.refus++; return 'Not launched: ' + String((r && r.raison) || 'the launch could not be prepared right now'); }
    const o = r.offre;
    MESURE.offres++;
    purge();
    attente[o.id] = { chat: m.chat.id, name: o.name, symbol: o.symbol, pool: o.pool, launchpad: String(o.launchpad).toLowerCase(), t, limite: t + ATTENTE_MS };
    ecrit();
    const lien = String(deps.site).replace(/\/$/, '') + '/launchpad.html?' + new URLSearchParams({ pool: o.pool, name: o.name, symbol: o.symbol, tg: o.id }).toString();
    return '🚀 $' + o.symbol + ' (' + o.name + ') is ready to launch on Robinhood Chain.\n'
      + (o.pool === 'eth' ? 'Pool: ETH (WETH). Fee: 0.0001 ETH.' : 'Pool: $SWOGE. Fee: 10,000 $SWOGE, burned.') + '\n'
      + '1,000,000,000 supply, all in the pool. Liquidity locked forever. No owner, no mint, no tax. You get 50% of the trading fees.\n\n'
      + 'Sign it with your own wallet (SWOGE never holds keys):\n' + lien + '\n\n'
      + 'The bot posts the contract here once the launch is confirmed on-chain.';
  }

  /** La page dit « lance » : on le relit sur la chaine avant d'annoncer quoi que ce soit. */
  async function annonce(q) {
    const id = String((q && q.tg) || ''), tx = String((q && q.tx) || '');
    if (!/^[0-9a-f]{16}$/.test(id) || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return { ok: false, raison: 'bad request' };
    purge();
    const a = attente[id];
    if (!a) return { ok: false, raison: 'no pending Telegram launch with this id' };
    const recu = await deps.lis.recu(tx);
    if (!recu) return { ok: false, raison: 'transaction not confirmed yet' };
    const l = deps.lis.lancementDe(recu, a.launchpad);
    if (!l) { MESURE.rejets++; return { ok: false, raison: 'no launch from the expected launchpad in this transaction' }; }
    const j = await deps.lis.jeton(l.token);
    if (!j || String(j.symbol) !== a.symbol || String(j.name) !== a.name) { MESURE.rejets++; return { ok: false, raison: 'the launched token does not match the Telegram request' }; }
    delete attente[id]; ecrit();
    MESURE.annonces++;
    const dex = 'https://dexscreener.com/robinhood/' + String(l.pool).toLowerCase();
    await deps.envoie(a.chat, '🎉 $' + a.symbol + ' (' + a.name + ') is live on Robinhood Chain\n'
      + 'CA: ' + l.token + '\n'
      + 'Chart: ' + dex + '\n'
      + 'Explorer: https://robinhoodchain.blockscout.com/token/' + l.token + '\n'
      + 'Security: https://gopluslabs.io/token-security/4663/' + l.token + '\n'
      + 'Liquidity locked forever · no owner · no tax · launched with ' + String(deps.site).replace(/^https?:\/\//, '').replace(/\/$/, ''));
    return { ok: true, token: l.token };
  }

  return { commande, annonce, MESURE, enAttente: () => Object.keys(attente).length };
}

module.exports = { cree, lisCommande, USAGE, ATTENTE_MS };
