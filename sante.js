'use strict';
/*
 * Savoir que ca va mal AVANT qu'un joueur le decouvre.
 *
 * ---- ce qui manquait ----
 *
 * `/health` repondait `ok` a tout coup. Il ne disait qu'une chose : « un
 * processus ecoute ce port ». C'est la question la moins interessante, parce
 * que les pannes qui coutent de l'argent laissent le processus vivant et
 * bavard :
 *
 *   • les ECRITURES echouent — volume plein, volume demonte. Le serveur
 *     repond, les joueurs jouent, et rien n'est sauve. Au redemarrage suivant
 *     tout le monde revient a son solde d'il y a deux heures.
 *   • la VEILLE DE CHAINE s'est arretee. Les depots ne sont plus credites.
 *     Le joueur envoie ses jetons et ne voit rien arriver.
 *   • une EXCEPTION non rattrapee. Elle etait seulement affichee dans les
 *     journaux : personne ne les lit, donc personne ne l'apprenait.
 *
 * Un moniteur qui repond `ok` a tout ca ne surveille rien.
 *
 * ---- et ce qu'aucun code d'ici ne peut faire ----
 *
 * Si le processus MEURT, il ne previendra personne : il est mort. Aucune
 * quantite de code ajoute ici ne changera ca. Il faut donc quelqu'un
 * DEHORS — et deux facons de s'y prendre, qu'on offre toutes les deux :
 *
 *   1. on se fait appeler : un service externe interroge /health toutes les
 *      minutes et alerte s'il n'obtient rien, ou un 503 ;
 *   2. on appelle : le serveur fait signe a une adresse toutes les minutes, et
 *      c'est le SILENCE qui declenche l'alerte. Cette seconde facon marche
 *      meme quand rien ne peut entrer depuis l'exterieur.
 *
 * La seconde est celle qui attrape le processus mort. Voir EXPLOITATION.md.
 */
const https = require('https');
const http = require('http');
const cfg = require('./config');

/* ------------------------------------------------------------ les signaux */

const t0 = Date.now();
let dernierEcrit = Date.now();          // derniere sauvegarde REUSSIE
let echecsEcriture = 0;                 // ratees d'affilee
let dernierBloc = 0;                    // derniere avancee de la veille de chaine
let veilleDemarree = false;
let retardBoucle = 0;                   // le pire retard vu sur la derniere minute
let incidents = [];                     // exceptions non rattrapees, recentes
let jeu = null, tg = null;
let etatPrecedent = null;               // pour n'annoncer que les CHANGEMENTS

/** Une sauvegarde s'est terminee. C'est le signal le plus important : sans
 *  ecriture, tout le reste est du sursis. */
function noteEcriture(ok) {
  if (ok) { dernierEcrit = Date.now(); echecsEcriture = 0; }
  else echecsEcriture++;
}
/** La veille de chaine a avance. */
function noteBloc() { dernierBloc = Date.now(); veilleDemarree = true; }
/** Une exception non rattrapee, ou un rejet non gere. */
function noteIncident(type, message) {
  incidents.push({ type, message: String(message || '').slice(0, 200), quand: Date.now() });
  if (incidents.length > 20) incidents = incidents.slice(-20);
}

/* -------------------------------------------------------------- le verdict */

const MIN = 60000;
/* Sans ecriture reussie depuis ce delai, on considere que ca ne s'ecrit plus.
   Genereux : la sauvegarde est au plus toutes les 1,2 s, et l'instantane
   complet toutes les 5 min. */
const ECRITURE_MAX_MS = 10 * MIN;
const CHAINE_MAX_MS = 15 * MIN;
const BOUCLE_MAX_MS = 2000;

/**
 * L'etat de sante, tel qu'il sort sur /health.
 *
 * Aucun solde, aucune adresse : cette page est publique par necessite — un
 * moniteur externe ne sait pas s'authentifier — donc elle ne porte que des
 * durees, des compteurs et des booleens.
 */
function etat() {
  const t = Date.now();
  const graves = [], remarques = [];

  const depuisEcrit = t - dernierEcrit;
  if (echecsEcriture >= 3)
    graves.push(`${echecsEcriture} sauvegardes ratees d'affilee`);
  else if (depuisEcrit > ECRITURE_MAX_MS)
    graves.push(`aucune sauvegarde reussie depuis ${Math.round(depuisEcrit / MIN)} min`);

  /* La veille de chaine ne compte que si elle est censee tourner : sans
     coffre configure, il n'y a rien a surveiller et se plaindre serait du
     bruit. */
  if (cfg.VAULT_ADDRESS && veilleDemarree && t - dernierBloc > CHAINE_MAX_MS)
    graves.push(`la veille de chaine n'a pas avance depuis ${Math.round((t - dernierBloc) / MIN)} min ` +
                `— les depots ne sont plus credites`);

  if (retardBoucle > BOUCLE_MAX_MS)
    remarques.push(`le serveur s'est bloque ${Math.round(retardBoucle)} ms d'affilee`);

  const recents = incidents.filter((x) => t - x.quand < 10 * MIN);
  if (recents.length)
    remarques.push(`${recents.length} exception(s) non rattrapee(s) en 10 min : ` +
                   recents[recents.length - 1].message);

  return {
    ok: graves.length === 0,
    depuis: Math.round((t - t0) / 1000),
    joueurs: jeu ? jeu.players.size : null,
    ecritureDepuisSec: Math.round(depuisEcrit / 1000),
    ecrituresRatees: echecsEcriture,
    chaineDepuisSec: veilleDemarree ? Math.round((t - dernierBloc) / 1000) : null,
    retardBoucleMs: Math.round(retardBoucle),
    memoireMo: Math.round(process.memoryUsage().heapUsed / 1048576),
    incidents10min: recents.length,
    graves, remarques,
  };
}

/* --------------------------------------------------- prevenir, sans saouler */

/* On n'annonce que les CHANGEMENTS. Repeter « ca va mal » toutes les minutes
   apprend a ignorer les messages, et le jour ou il en arrive un vrai, il se
   perd dans la file. */
function surveille() {
  const e = etat();
  const maintenant = e.ok ? 'ok' : 'casse';
  if (etatPrecedent === null) { etatPrecedent = maintenant; return; }
  if (maintenant === etatPrecedent) return;
  etatPrecedent = maintenant;
  if (!tg) return;
  if (maintenant === 'casse')
    tg.notify('🔴 <b>SWOGE : le serveur va mal</b>\n' + e.graves.map((x) => '• ' + x).join('\n') +
              '\n\nVoir EXPLOITATION.md pour la marche a suivre.');
  else
    tg.notify('🟢 <b>SWOGE : c\'est revenu</b> — le serveur repond de nouveau normalement.');
}

/* ------------------------------------------------------- le signe de vie */

/*
 * On appelle une adresse a intervalle regulier. C'est le SILENCE qui alerte,
 * et c'est la seule facon d'etre prevenu quand le processus est mort — un
 * processus mort ne peut rien envoyer, et c'est exactement ce qu'on veut
 * detecter.
 *
 * La convention est celle de healthchecks.io, que Better Stack et Cronitor
 * comprennent aussi : on appelle l'adresse quand tout va bien, et la meme
 * suivie de `/fail` quand ca ne va pas. Le service alerte des qu'un signe de
 * vie manque a l'appel, ou des qu'un echec est annonce.
 */
function signeDeVie() {
  const base = cfg.MONITEUR_URL;
  if (!base) return;
  const e = etat();
  const url = e.ok ? base : base.replace(/\/+$/, '') + '/fail';
  try {
    const client = url.startsWith('https:') ? https : http;
    const r = client.get(url, { timeout: 8000 }, (rep) => rep.resume());
    r.on('timeout', () => r.destroy());
    /* Un signe de vie qui echoue ne doit PAS faire tomber le serveur : c'est
       le comble d'une surveillance. On l'ignore, le prochain repartira. */
    r.on('error', () => {});
  } catch (e2) { /* idem */ }
}

/* ---------------------------------------------------------------- demarrage */

let minuteries = [];
/**
 * @param {object} o { jeu, tg }
 */
function demarre(o) {
  jeu = o && o.jeu; tg = o && o.tg;

  /* Le retard de la boucle : on demande a etre reveille toutes les 500 ms et
     on regarde de combien on est en retard. C'est la mesure de « le serveur
     ne repond a personne », vue de l'interieur. */
  let attendu = Date.now() + 500;
  minuteries.push(setInterval(() => {
    const retard = Date.now() - attendu;
    if (retard > retardBoucle) retardBoucle = retard;
    attendu = Date.now() + 500;
  }, 500));
  /* La pire valeur s'oublie au bout d'une minute, sinon un unique a-coup au
     demarrage resterait affiche pour toujours. */
  minuteries.push(setInterval(() => { retardBoucle = 0; }, MIN));

  minuteries.push(setInterval(surveille, 30000));
  const pas = Math.max(20, parseInt(cfg.MONITEUR_SEC, 10) || 60) * 1000;
  if (cfg.MONITEUR_URL) {
    signeDeVie();
    minuteries.push(setInterval(signeDeVie, pas));
    console.log(`[sante] signe de vie toutes les ${pas / 1000} s vers ${cfg.MONITEUR_URL.slice(0, 40)}…`);
  } else {
    console.warn('[sante] MONITEUR_URL absent : si le processus meurt, PERSONNE ne sera prevenu.\n' +
                 '        Voir EXPLOITATION.md — cinq minutes a mettre en place, gratuit.');
  }
  for (const m of minuteries) if (m.unref) m.unref();
}
function arrete() { for (const m of minuteries) clearInterval(m); minuteries = []; }

module.exports = { demarre, arrete, etat, noteEcriture, noteBloc, noteIncident };
