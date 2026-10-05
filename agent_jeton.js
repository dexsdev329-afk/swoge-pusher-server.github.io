'use strict';
/* ==================================================================
 * UN AGENT PAR JETON LANCÉ — le registre « jeton → esprit »
 * ==================================================================
 *
 * Demande du propriétaire (05/10/2026), après l'étude d'AgencyPad (Solana) :
 * « prendre leur techno et l'apporter sur Robinhood Chain, sur notre
 * launchpad ». Chez AgencyPad, chaque jeton lancé reçoit un « mind » : une
 * persona, un objectif, un modèle, et le droit d'AGIR. On a déjà les deux
 * moitiés — le poster X autonome (x_post.js) et le cerveau agent borné
 * (studio_agent.js) — fondus sur UNE seule identité maison. Ce fichier est la
 * première brique du passage à N identités : il attache, à l'adresse d'un
 * jeton lancé (LaunchedInstant), la configuration de SON agent.
 *
 * ---- CE QUE CE FICHIER FAIT, ET CE QU'IL NE FAIT PAS ----
 *
 *   - Il STOCKE la config (persona, objectif, modèle, cadence, pouvoirs
 *     déclarés). Il ne poste rien, ne signe rien, ne dépense rien : c'est un
 *     registre. L'ordonnanceur (à venir) lira ce registre pour agir.
 *   - Un agent par jeton (clé = adresse du jeton). Seul le CRÉATEUR du jeton
 *     (celui qui a payé createToken, lu dans l'offre de lancement) peut
 *     l'attacher ou le modifier — revérifié par l'appelant, jamais ici sur
 *     parole d'un message.
 *   - Les POUVOIRS d'argent (buyback, trade, airdrop) peuvent être DÉCLARÉS
 *     dès maintenant, mais rien dans le produit ne les exécute tant que
 *     l'étage « trader » n'est pas posé derrière son drapeau d'exécution
 *     explicite (façon MIROIR_EXECUTE) avec signer isolé. Déclarer n'est pas
 *     activer : `pouvoirsActifs()` ne rend que 'post'/'image'/'reply' pour
 *     l'instant, quoi que le créateur ait coché.
 *   - Au plus MAX_PAR_CREATEUR agents par adresse de créateur.
 *
 * Un fichier, `DATA_DIR/agent_jeton.json`, écrit comme agentic_cles.js :
 * temporaire, fsync, rename. Un fichier illisible n'est jamais écrasé.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const MAX_PAR_CREATEUR = 20;
const OBJECTIF_MAX = 280;
const CADENCE_MIN = 5;                 /* minutes entre deux gestes autonomes */
const CADENCE_MAX = 1440;              /* une fois par jour au plus lent */
const CADENCE_DEFAUT = 60;

/* Les personas : étiquette montrée au joueur (anglais) + un brief qui guide le
   modèle. Figées ici, jamais en dur dans le peintre, comme la table ph(...). */
const PERSONAS = {
  stoic:      { label: 'Stoic',      brief: 'Calm, unshakeable, long-term. Never hypes, never panics. States facts and holds the line.' },
  analyst:    { label: 'Analyst',    brief: 'Data-first. Cites numbers, volume, liquidity, holders. Dry, precise, no promises of returns.' },
  contrarian: { label: 'Contrarian', brief: 'Questions the crowd. Points out what everyone misses. Sharp but never dishonest.' },
  hype:       { label: 'Hype',       brief: 'High energy, meme-forward, bullish on the community — never invents numbers or promises gains.' },
  builder:    { label: 'Builder',    brief: 'Ships and explains. Talks about what was built and why, like a founder shipping in public.' },
};

/* Les modèles proposés au créateur (étiquette → le cerveau fera la bascule vers
   l'ID réel via studio_agent). On garde un allow-list court et vérifiable. */
const MODELES = { claude: 'Claude', gpt: 'GPT', grok: 'Grok' };

/* Le vocabulaire des pouvoirs. 'post'/'image'/'reply' = social, sans argent.
   'buyback'/'trade'/'airdrop' = argent réel : DÉCLARABLES, inertes tant que
   l'étage trader n'est pas posé. */
const POUVOIRS = ['post', 'image', 'reply', 'buyback', 'trade', 'airdrop'];
const POUVOIRS_SOCIAUX = ['post', 'image', 'reply'];

const estAdresse = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const bas = (a) => String(a).toLowerCase();
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);

/** Nettoie et valide une config d'agent. Rend { erreur } ou { config }. */
function valide(o) {
  o = o || {};
  if (!estAdresse(o.token)) return { erreur: 'token must be a 0x address' };
  if (!estAdresse(o.createur)) return { erreur: 'creator must be a 0x address' };
  if (o.pool != null && !estAdresse(o.pool)) return { erreur: 'pool must be a 0x address' };
  const persona = String(o.persona || '').toLowerCase();
  if (!PERSONAS[persona]) return { erreur: 'pick a persona: ' + Object.keys(PERSONAS).join(', ') };
  const modele = String(o.modele || 'claude').toLowerCase();
  if (!MODELES[modele]) return { erreur: 'pick a model: ' + Object.keys(MODELES).join(', ') };
  const objectif = String(o.objectif || '').trim().slice(0, OBJECTIF_MAX);
  let cadence = Math.round(Number(o.cadenceMin));
  if (!Number.isFinite(cadence)) cadence = CADENCE_DEFAUT;
  cadence = Math.min(CADENCE_MAX, Math.max(CADENCE_MIN, cadence));
  let pouvoirs = Array.isArray(o.pouvoirs) ? o.pouvoirs.map((p) => String(p).toLowerCase()) : ['post'];
  pouvoirs = POUVOIRS.filter((p) => pouvoirs.includes(p));   /* ordre figé, pas de doublon, pas d'inconnu */
  if (!pouvoirs.includes('post')) pouvoirs.unshift('post');  /* poster est le minimum d'un agent */
  const langue = o.langue === 'fr' ? 'fr' : 'en';            /* le texte joueur est anglais par défaut */
  return { config: { token: bas(o.token), createur: bas(o.createur), pool: o.pool ? bas(o.pool) : null,
                     persona, modele, objectif, cadenceMin: cadence, pouvoirs, langue } };
}

/** Les pouvoirs RÉELLEMENT exécutables aujourd'hui : seulement le social.
 *  L'étage trader (argent) les élargira, derrière son drapeau d'exécution. */
function pouvoirsActifs(pouvoirs) {
  return (pouvoirs || []).filter((p) => POUVOIRS_SOCIAUX.includes(p));
}

function cree(opts) {
  const fichier = (opts && opts.fichier) || path.join(require('./config').DATA_DIR, 'agent_jeton.json');
  const maintenant = (opts && opts.maintenant) || (() => Date.now());
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { agents: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.agents !== 'object') throw new Error('agent_jeton illisible');
    E = { agents: j.agents };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  const vue = (a) => a && ({ token: a.token, pool: a.pool, createur: a.createur, persona: a.persona,
    personaLabel: PERSONAS[a.persona] && PERSONAS[a.persona].label, modele: a.modele, modeleLabel: MODELES[a.modele],
    objectif: a.objectif, cadenceMin: a.cadenceMin, pouvoirs: a.pouvoirs.slice(), pouvoirsActifs: pouvoirsActifs(a.pouvoirs),
    langue: a.langue, actif: !!a.actif, cree: a.cree, maj: a.maj || a.cree, dernierGeste: a.dernierGeste || null });

  /** Attache (ou met à jour) l'agent d'un jeton. Seul le créateur du jeton le peut :
   *  l'appelant a DÉJÀ vérifié que `createur` est bien la session signée.
   *  Rend { ok, agent } ou { ok:false, code, raison }. */
  function attache(o) {
    o = o || {};
    if (!estAdresse(o.token)) return { ok: false, code: 400, raison: 'token must be a 0x address' };
    if (!estAdresse(o.createur)) return { ok: false, code: 400, raison: 'creator must be a 0x address' };
    const S = charge();
    const existant = S.agents[bas(o.token)];
    if (existant && existant.createur !== bas(o.createur)) return { ok: false, code: 403, raison: 'this token already has an agent, owned by its creator' };
    /* Mise à jour : les champs non fournis GARDENT leur valeur actuelle — modifier la
       persona ne doit pas remettre la cadence au défaut. On valide le résultat fusionné. */
    const defini = {};
    for (const k of ['pool', 'persona', 'modele', 'objectif', 'cadenceMin', 'pouvoirs', 'langue']) if (o[k] !== undefined) defini[k] = o[k];
    const base = existant
      ? Object.assign({ token: existant.token, createur: existant.createur, pool: existant.pool, persona: existant.persona,
                        modele: existant.modele, objectif: existant.objectif, cadenceMin: existant.cadenceMin,
                        pouvoirs: existant.pouvoirs, langue: existant.langue }, defini)
      : Object.assign({ token: o.token, createur: o.createur }, defini);
    const v = valide(base);
    if (v.erreur) return { ok: false, code: 400, raison: v.erreur };
    const c = v.config;
    if (!existant) {
      const miens = Object.values(S.agents).filter((a) => a.createur === c.createur).length;
      if (miens >= MAX_PAR_CREATEUR) return { ok: false, code: 409, raison: 'at most ' + MAX_PAR_CREATEUR + ' agents per creator' };
    }
    const t = maintenant();
    S.agents[c.token] = Object.assign({}, existant, c, {
      actif: true, cree: existant ? existant.cree : t, maj: t,
      dernierGeste: existant ? existant.dernierGeste || null : null });
    sauve();
    return { ok: true, agent: vue(S.agents[c.token]) };
  }

  /** Le créateur met son agent en pause / le réactive (ne le supprime pas). */
  function bascule(token, createur, actif) {
    const S = charge();
    const a = S.agents[bas(token)];
    if (!a) return { ok: false, code: 404, raison: 'no agent for this token' };
    if (a.createur !== bas(createur)) return { ok: false, code: 403, raison: 'only the token creator can change its agent' };
    a.actif = !!actif; a.maj = maintenant(); sauve();
    return { ok: true, agent: vue(a) };
  }

  /** Marque l'heure du dernier geste (posé par l'ordonnanceur après un post). */
  function noteGeste(token, quoi, t) {
    const S = charge();
    const a = S.agents[bas(token)];
    if (!a) return { ok: false };
    a.dernierGeste = { quoi: String(quoi || 'post').slice(0, 24), quand: t || maintenant() };
    a.maj = maintenant(); sauve();
    return { ok: true, agent: vue(a) };
  }

  /** L'agent d'un jeton, ou null. */
  function parJeton(token) { return estAdresse(token) ? (vue(charge().agents[bas(token)]) || null) : null; }

  /** Les agents d'un créateur, du plus récent au plus ancien. */
  function parCreateur(createur) {
    return Object.values(charge().agents).filter((a) => a.createur === bas(createur)).map(vue).sort((x, y) => y.cree - x.cree);
  }

  /** Les agents ACTIFS dont le prochain geste est dû (pour l'ordonnanceur).
   *  Dû si jamais agi, ou si cadenceMin s'est écoulée depuis le dernier geste. */
  function dus(t) {
    const now = t || maintenant();
    return Object.values(charge().agents).filter((a) => {
      if (!a.actif) return false;
      const dernier = a.dernierGeste && a.dernierGeste.quand;
      return !dernier || (now - dernier) >= a.cadenceMin * 60000;
    }).map(vue);
  }

  function compte() { return Object.keys(charge().agents).length; }

  return { attache, bascule, noteGeste, parJeton, parCreateur, dus, compte, vue };
}

module.exports = { cree, valide, pouvoirsActifs, PERSONAS, MODELES, POUVOIRS, POUVOIRS_SOCIAUX,
                   MAX_PAR_CREATEUR, OBJECTIF_MAX, CADENCE_MIN, CADENCE_MAX, CADENCE_DEFAUT };
