'use strict';
/* ==========================================================================
 * UNE ALERTE TELEGRAM PRIVEE QUAND UNE DE NOS API N'A PLUS BEAUCOUP DE CREDIT
 *
 * Demande du proprietaire, 9 octobre 2026 : « des notifs Telegram quand une
 * de nos API n'a plus beaucoup de jetons, par le bot ». Inventaire du meme
 * jour (lecture du depot et de la documentation officielle de chaque
 * fournisseur, aucun appel) : une vingtaine de fournisseurs payants ; UN seul
 * donne son solde reel a chaque reponse (The Odds API, en-tetes
 * x-requests-remaining / x-requests-used), Venice le donne en en-tete
 * (x-venice-balance-usd, « before the request was processed ») ; pour tous les
 * autres, la clé ordinaire ne lit aucun solde — on ne le sait qu'au moment ou
 * l'appel ECHOUE, et aujourd'hui l'echec finit en « the AI provider failed —
 * you were not charged » pour le joueur, sans que personne ne soit prevenu.
 *
 * Deux sortes de signaux, donc :
 *  - MESURES (Odds, Venice) : un niveau calcule sur le solde lu — ok, bas,
 *    vide — et le retour a la normale se dit aussi ;
 *  - ECHECS (Anthropic, OpenAI, xAI, OpenRouter, DeepSeek, Mistral,
 *    Perplexity, Kling, facilitateurs x402) : l'erreur est CLASSEE sur ce que
 *    la documentation du fournisseur ecrit pour un credit epuise ou une cle
 *    refusee (`classe`) ; rien d'autre ne declenche d'alerte.
 *
 * ---- JAMAIS DANS LE CANAL PUBLIC ----
 * Toutes les alertes d'exploitation partaient par `tg.notify`, c'est-a-dire
 * dans TG_CHAT_ID, le canal PUBLIC des annonces de gains. Celle-ci passe par
 * `tg.notifyPrive` : TG_BACKUP_CHAT_ID seulement, verifie non public aupres de
 * Telegram, sans repli. Sans canal prive, rien ne part (et le carnet du bot le
 * dit, route /tg/journal).
 *
 * ---- NI SPAM NI SILENCE ----
 * Une alerte part si RIEN d'aussi grave n'a ete annonce pour ce fournisseur
 * dans les 24 h : un credit vide qui dure se rappelle une fois par jour, une
 * aggravation (bas -> vide) part tout de suite. Un appel reussi raccourcit ce
 * silence a une heure. Le retour a la normale se dit pour les soldes MESURES
 * (Odds, Venice), avec une marge pour en sortir (pas de paire ⚠️/✅ chaque
 * jour au bord du seuil) ; un EVENEMENT (echec, cle refusee) ne touche jamais
 * au niveau mesure. L'envoi est confirme par Telegram, sinon le marquage est
 * annule. Au plus MAX_HEURE messages par heure, tous fournisseurs confondus.
 * L'etat vit sur le volume (DATA_DIR/alerte_solde.json) : un redeploiement —
 * il y en a une centaine par mois — ne repete rien.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

const JOUR_MS = 86400000;
const MAX_HEURE = 10;
const GRAVITE = { ok: 0, bas: 1, vide: 2, cle: 2 };

/* Ce que le proprietaire lit : le nom, ce qui casse, ou recharger — seulement
   les adresses que la documentation donne elle-meme (aucune devinee). */
const FOURNISSEURS = {
  odds: { nom: 'The Odds API', casse: 'les 17 championnats au prix du marché passent suspendus (36 h sans prix)', ou: 'https://dash.the-odds-api.com/' },
  anthropic: { nom: 'Anthropic (Claude)', casse: 'les modèles Claude du chat, SwogeAgentic et les outils x402 échouent (joueurs remboursés)' },
  openai: { nom: 'OpenAI', casse: 'les modèles GPT du chat et les images OpenAI échouent (joueurs remboursés)' },
  xai: { nom: 'xAI (Grok)', casse: 'le chat Grok, les images Grok et toutes les vidéos échouent (joueurs remboursés)' },
  openrouter: { nom: 'OpenRouter', casse: 'le modèle Dolphin échoue (joueurs remboursés)' },
  venice: { nom: 'Venice', casse: 'le modèle Venice Uncensored échoue (joueurs remboursés)', ou: 'https://venice.ai' },
  deepseek: { nom: 'DeepSeek', casse: 'les modèles DeepSeek échouent (joueurs remboursés)' },
  mistral: { nom: 'Mistral', casse: 'le modèle Mistral Large échoue (joueurs remboursés)' },
  perplexity: { nom: 'Perplexity', casse: 'les réponses partent sans recherche web, en silence' },
  kling: { nom: 'Kling', casse: 'les vidéos Kling (annonces) s’arrêtent' },
  cdp: { nom: 'Coinbase CDP (facilitateur x402 Base)', casse: 'les agents ne peuvent plus payer sur Base (pause d’une heure, renouvelée)', ou: 'https://portal.cdp.coinbase.com' },
  payai: { nom: 'PayAI (facilitateur x402 second)', casse: 'le second facilitateur x402 est en pause' },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---- CE QUE LA DOCUMENTATION APPELLE « CREDIT EPUISE » (relevee le 09/10/2026) ----
 * Anthropic  : « Your credit balance is too low to access the Anthropic API »
 *              (statut non documente) ; 429 error_code enforced_spend_limit_reached ;
 *              400 « You have reached your specified API usage limits » ;
 *              402 billing_error (probleme de paiement).
 *              platform.claude.com/docs/en/api/errors, /rate-limits,
 *              /about-claude/api-credits-for-subscribers
 * OpenAI     : 429 error.code credit_balance_exhausted (type insufficient_quota),
 *              organization_spend_limit_exceeded, project_spend_limit_exceeded,
 *              organization_usage_limit_exceeded.
 *              developers.openai.com/api/docs/guides/error-codes
 * OpenRouter : 402 « insufficient credits ».  openrouter.ai/docs/api-reference/limits
 * DeepSeek   : 402 « Insufficient Balance ».  api-docs.deepseek.com/quick_start/error_codes
 * Mistral    : 402 « Payment Required ».      docs.mistral.ai (first-api-request)
 * Venice     : 402 INSUFFICIENT_BALANCE.      docs.venice.ai/api-reference/api-spec
 * xAI        : « rejected once your prepaid credits are depleted », statut NON
 *              documente : 402, ou un message qui parle de credit / solde.
 * Perplexity : 401 = cle invalide OU compte sans credit (indistinguables,
 *              docs.perplexity.ai/docs/resources/faq).
 * Kling      : code metier 1102 (pack epuise), 1101 (compte en impaye).
 *              kling.ai/document-api/api/get-started/error-codes.md
 * Partout    : 401 = cle refusee. Les 429 de DEBIT (rate limit) ne sont PAS un
 *              credit epuise. Relecture du 09/10 : un mot isole (« billing »
 *              dans un lien d'aide, « balance ») classait un 429 de debit en
 *              « credit epuise » : seules des PHRASES de credit comptent. */
const PHRASES_CREDIT = /insufficient[_ ](credits?|balance|funds|quota)|credit balance|prepaid credits?|out of credits?|(credits?|balance) (is |are |has been |have been )?(exhausted|depleted|too low)|exceeded your current quota|spend(ing)?[_ ]limit|usage limits?/i;
const CODES_OPENAI = new Set(['credit_balance_exhausted', 'insufficient_quota', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']);

/** Les champs utiles d'une erreur, quelle que soit sa forme (SDK Anthropic,
 *  studio_compat, kling, fetch). Jamais d'en-tete, jamais de cle. */
function lisErreur(e) {
  const x = e || {};
  const corps = (x.error && x.error.error) || x.error || {};
  const status = Number(x.status || x.statut || x.statusCode) || null;
  const code = String((corps.details && corps.details.error_code) || corps.code || x.code || '').trim() || null;
  const type = String(corps.type || x.type || '').trim() || null;
  const message = masque(String(corps.message || x.message || '')).slice(0, 300);
  return { status, code, type, message };
}
/* Un fournisseur peut recopier un morceau de cle dans son message (« Incorrect
   API key provided: sk-proj-AB12***wxYZ ») : on masque tout ce qui y ressemble
   avant que le texte ne parte (relecture du 09/10). */
function masque(t) {
  return String(t || '')
    .replace(/\b(sk|xai|pplx|sk-or|sk-ant|sk-proj|rk|pk)[-_][\w*-]{6,}/gi, '«clé masquée»')
    .replace(/bearer\s+\S+/gi, 'Bearer «masqué»')
    .replace(/(api[_-]?key=)[^&\s]+/gi, '$1«masqué»')
    .replace(/\b[a-f0-9]{32,}\b/gi, '«masqué»');
}

/** 'vide' | 'cle' | null — rien n'est devine : seulement les signaux documentes. */
function classe(fournisseur, info) {
  const i = info || {};
  const st = Number(i.status) || null, code = String(i.code || ''), msg = String(i.message || '');
  const f = String(fournisseur || '');
  if (f === 'anthropic') {
    if (/credit balance is too low/i.test(msg)) return 'vide';
    if (code === 'enforced_spend_limit_reached') return 'vide';
    if (/you have reached your (specified )?(workspace )?api usage limits/i.test(msg)) return 'vide';
    if (st === 402) return 'vide';
    if (st === 401) return 'cle';
    return null;
  }
  if (f === 'openai') {
    if (CODES_OPENAI.has(code) || i.type === 'insufficient_quota') return 'vide';
    if (st === 401) return 'cle';
    if (st === 429 && /exceeded your current quota/i.test(msg)) return 'vide';
    return null;
  }
  if (f === 'kling') {
    if (code === '1102' || code === '1101') return 'vide';
    return st === 401 ? 'cle' : null;
  }
  if (f === 'perplexity') return st === 401 ? 'cle' : null;
  /* openrouter, deepseek, mistral, venice, xai, cdp, payai */
  if (st === 402) return 'vide';
  if (st === 401) return 'cle';
  if ((st === 400 || st === 403 || st === 429) && PHRASES_CREDIT.test(msg)) return 'vide';
  return null;
}

/* ---- THE ODDS API : LE NIVEAU, SUR LE SOLDE LU ----
 * forfait = utilise + reste (en-tetes du fournisseur, pas de chiffre ecrit a
 * la main). Bas sous ODDS_PCT_BAS (20 %) OU si, au rythme mesure sur les
 * echantillons des trois derniers jours, le solde n'atteint pas la fin du
 * mois (remise a zero le 1er : the-odds-api.com/manage/faqs.html) ; vide sous
 * 5 %. Le rythme se mesure sur nos propres releves de `utilise`, pas sur la
 * moyenne depuis le 1er (le forfait 20K a ete pris le 09/10 : la moyenne du
 * mois sous-estimait la depense de moitie). */
const ODDS_PCT_VIDE = 0.05;
function pctBas() {
  const v = Number(process.env.ALERTE_SOLDE_ODDS_PCT);
  return isFinite(v) && v > 0 && v < 100 ? v / 100 : 0.20;
}
function finDuMoisMs(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
/* `avant` : le dernier niveau MESURE. Pour en sortir, il faut une marge
   (relecture du 09/10 : sans elle, une depense en rafales faisait traverser le
   seuil chaque jour — une paire ⚠️/✅ quotidienne) : 5 points au-dessus du
   seuil et un besoin projete sous 80 % du reste. */
function niveauOdds(q, echantillons, t, avant) {
  if (!q || q.reste === null || q.reste === undefined || q.reste === '') return null;
  const reste = Number(q.reste), utilise = q.utilise === null || q.utilise === undefined ? NaN : Number(q.utilise);
  if (!isFinite(reste)) return null;
  const forfait = isFinite(utilise) && utilise >= 0 ? utilise + reste : null;
  const pct = forfait ? reste / forfait : null;
  /* le rythme : pente de `utilise` sur 3 jours au plus, 6 h au moins */
  let parJour = null;
  const ech = (echantillons || []).filter((e) => t - e.t <= 3 * JOUR_MS);
  if (ech.length >= 2) {
    const a = ech[0], b = ech[ech.length - 1];
    if (b.t - a.t >= 6 * 3600000 && b.utilise >= a.utilise) parJour = (b.utilise - a.utilise) / ((b.t - a.t) / JOUR_MS);
  }
  const jours = Math.max(0, (finDuMoisMs(t) - t) / JOUR_MS);
  const besoin = parJour !== null ? parJour * jours : null;
  let niveau = 'ok';
  if (reste <= 0 || (pct !== null && pct <= ODDS_PCT_VIDE)) niveau = 'vide';
  else if ((pct !== null && pct <= pctBas()) || (besoin !== null && besoin > reste)) niveau = 'bas';
  if (niveau === 'ok' && (avant === 'bas' || avant === 'vide')
      && !((pct === null || pct > pctBas() + 0.05) && (besoin === null || besoin < 0.8 * reste))) niveau = 'bas';
  const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
  const lignes = [`${fmt(reste)} crédits restants${forfait ? ` sur ${fmt(forfait)} (${Math.round(pct * 100)} %)` : ''}.`];
  if (parJour !== null) {
    const fin = parJour > 0 ? new Date(t + reste / parJour * JOUR_MS) : null;
    lignes.push(`Rythme mesuré : ≈ ${fmt(parJour)} par jour${fin && fin.getTime() < finDuMoisMs(t)
      ? ` — épuisés vers le ${String(fin.getUTCDate()).padStart(2, '0')}/${String(fin.getUTCMonth() + 1).padStart(2, '0')}, avant la remise à zéro du 1er` : ' — tient jusqu’à la remise à zéro du 1er'}.`);
  }
  return { niveau, texte: lignes.join('\n'), reste, forfait, parJour };
}

/* ---- VENICE : l'en-tete x-venice-balance-usd, lu sur chaque reponse ---- */
function niveauVenice(usd, avant) {
  /* pas d'en-tete = rien : Number(null) vaut 0, et 0 se lirait « vide » */
  if (usd === null || usd === undefined || String(usd).trim() === '') return null;
  const v = Number(usd);
  if (!isFinite(v)) return null;
  const bas = Number(process.env.ALERTE_SOLDE_VENICE_USD) || 5;
  let niveau = v <= 0.5 ? 'vide' : v < bas ? 'bas' : 'ok';
  /* meme marge que The Odds API : 20 % au-dessus du seuil pour en sortir */
  if (niveau === 'ok' && (avant === 'bas' || avant === 'vide') && v < bas * 1.2) niveau = 'bas';
  return { niveau, texte: `Solde : ${v.toFixed(2)} $ (avant le dernier appel).` };
}

/**
 * deps = { notifyPrive(texte HTML) → Promise<bool>, dossier, maintenant() }
 * Sans `notifyPrive`, tout est compte mais rien ne part.
 */
function cree(deps) {
  const d = deps || {};
  const maintenant = () => (d.maintenant ? d.maintenant() : Date.now());
  const fichier = d.dossier ? path.join(d.dossier, 'alerte_solde.json') : null;
  let etat = { fournisseurs: {}, heure: [], odds: [] };
  if (fichier) {
    try { const j = JSON.parse(fs.readFileSync(fichier, 'utf8')); if (j && typeof j === 'object') etat = Object.assign(etat, j); }
    catch (e) { /* premier demarrage, ou fichier illisible : on repart a vide */ }
  }
  const MESURE = { envoyees: 0, rates: 0, tues: 0, classees: 0, ignorees: 0 };
  function sauve() {
    if (!fichier) return;
    try { const tmp = fichier + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(etat)); fs.renameSync(tmp, fichier); }
    catch (e) { console.warn('[solde] etat non ecrit : ' + (e.message || e)); }
  }

  /* ---- L'ENVOI EST CONFIRME (relecture du 09/10) ----
   * `notifyPrive` rend une promesse : vrai si Telegram a pris le message. Le
   * marquage (fenetre de 24 h, message unique) est pose tout de suite — deux
   * pannes dans la meme milliseconde ne partent pas deux fois — puis ANNULE si
   * l'envoi echoue : un canal mal regle ou un Telegram muet ne doit pas
   * consommer 24 h de silence, ni le message « armees » pour toujours. */
  function envoie(texte, marque, annule) {
    const t = maintenant();
    etat.heure = (etat.heure || []).filter((x) => t - x < 3600000);
    if (etat.heure.length >= MAX_HEURE) { MESURE.tues++; return false; }
    etat.heure.push(t);
    if (marque) marque();
    let p;
    try { p = d.notifyPrive ? Promise.resolve(d.notifyPrive(texte)) : Promise.resolve(false); } catch (e) { p = Promise.resolve(false); }
    p.then((ok) => {
      if (ok) MESURE.envoyees++;
      else { MESURE.rates++; if (annule) { annule(); sauve(); } }
    }, () => { MESURE.rates++; if (annule) { annule(); sauve(); } });
    return true;
  }

  const etatDe = (f) => etat.fournisseurs[f] || (etat.fournisseurs[f] = { mesure: 'ok', envois: {} });
  /** Le plus grave niveau annonce dans les 24 h. */
  function graviteRecente(s, t) {
    let g = 0;
    for (const [n, x] of Object.entries(s.envois || {})) if (t - Number(x) < JOUR_MS) g = Math.max(g, GRAVITE[n] || 0);
    return g;
  }
  function message(F, niveau, detail) {
    const quoi = { bas: 'crédit bas', vide: 'crédit épuisé', cle: 'clé refusée' }[niveau];
    return [`${niveau === 'bas' ? '⚠️' : '🛑'} <b>${esc(F.nom)}</b> — ${quoi}`,
      esc(detail || ''), `Effet : ${esc(F.casse)}.`, F.ou ? `Recharger : ${esc(F.ou)}` : '']
      .filter(Boolean).join('\n');
  }

  /**
   * Un niveau grave (bas | vide | cle). Part si RIEN d'aussi grave n'a ete
   * annonce dans les 24 h : un credit vide qui dure se rappelle une fois par
   * jour, une aggravation (bas -> vide) part tout de suite, un « bas » apres un
   * « vide » du jour ne dit rien de neuf. Rend vrai si un message part.
   */
  function grave(fournisseur, niveau, detail) {
    const F = FOURNISSEURS[fournisseur];
    if (!F || !(GRAVITE[niveau] > 0)) return false;
    const t = maintenant();
    const s = etatDe(fournisseur);
    if (graviteRecente(s, t) >= GRAVITE[niveau]) { sauve(); return false; }
    const precedent = s.envois[niveau];
    const parti = envoie(message(F, niveau, detail),
      () => { s.envois[niveau] = t; },
      () => { if (s.envois[niveau] === t) { if (precedent === undefined) delete s.envois[niveau]; else s.envois[niveau] = precedent; } });
    sauve();
    return parti;
  }

  /**
   * Un EVENEMENT (echec classe, releve refusee, cle refusee) : il ne touche
   * jamais au niveau MESURE. Relecture du 09/10 : partages, un 401 de The Odds
   * API puis la lecture du compteur (fige, donc « ok ») envoyaient « revenu a
   * la normale » toutes les 30 min, en alternance avec « cle refusee ».
   */
  function signale(fournisseur, niveau, detail) {
    if (niveau === 'ok') return false;
    return grave(fournisseur, niveau, detail);
  }

  /**
   * Un niveau MESURE (solde lu) : bas/vide suivent la regle des 24 h ; le
   * retour a ok apres bas/vide se dit une fois et rouvre la fenetre (une
   * nouvelle panne dans la journee repart tout de suite).
   */
  function mesure(fournisseur, niveau, texte) {
    const F = FOURNISSEURS[fournisseur];
    if (!F || !(niveau in GRAVITE) || niveau === 'cle') return false;
    const s = etatDe(fournisseur);
    const avant = s.mesure || 'ok';
    s.mesure = niveau;
    if (niveau !== 'ok') return grave(fournisseur, niveau, texte);
    if (avant === 'ok') { sauve(); return false; }
    const garde = { bas: s.envois.bas, vide: s.envois.vide };
    const parti = envoie(`✅ <b>${esc(F.nom)}</b> — revenu à la normale.\n${esc(texte || '')}`.trim(),
      () => { delete s.envois.bas; delete s.envois.vide; },
      () => { s.mesure = avant; if (garde.bas !== undefined) s.envois.bas = garde.bas; if (garde.vide !== undefined) s.envois.vide = garde.vide; });
    if (!parti) s.mesure = avant;      /* plafond horaire : on retentera */
    sauve();
    return parti;
  }

  /**
   * Un appel REUSSI chez un fournisseur suivi par ses echecs. Il n'envoie rien,
   * mais raccourcit le silence : une nouvelle panne se redit au plus tot une
   * heure apres ce succes, au lieu d'attendre la fin des 24 h (relecture du
   * 09/10 : un compte recharge un peu a 10:30 puis de nouveau vide a 20:00
   * restait muet jusqu'au lendemain). N'ecrit le volume que si quelque chose
   * change — il est appele a chaque reponse du chat.
   */
  function succes(fournisseur) {
    const s = etat.fournisseurs[fournisseur];
    if (!s || !s.envois) return false;
    const t = maintenant();
    let change = false;
    for (const [n, x] of Object.entries(s.envois)) {
      const borne = t - JOUR_MS + 3600000;
      if (t - Number(x) < JOUR_MS && Number(x) > borne) { s.envois[n] = borne; change = true; }
    }
    if (change) sauve();
    return change;
  }

  /** Un echec d'appel : classe sur la documentation, alerte si credit/cle. */
  function erreur(fournisseur, e) {
    const info = lisErreur(e);
    const niveau = classe(fournisseur, info);
    if (!niveau) { MESURE.ignorees++; return false; }
    MESURE.classees++;
    /* une cle refusee : statut et code seulement — le message pourrait en
       recopier un morceau */
    const detail = [info.status ? 'HTTP ' + info.status : null, info.code,
      niveau !== 'cle' && info.message ? '« ' + info.message.slice(0, 160) + ' »' : null]
      .filter(Boolean).join(' — ') + (fournisseur === 'perplexity' ? '\n(Perplexity ne distingue pas une clé invalide d’un compte sans crédit.)' : '');
    return signale(fournisseur, niveau, detail);
  }

  /** The Odds API : le compteur deja tenu par paris_import (en-tetes lus). */
  function odds(q) {
    const t = maintenant();
    if (q && q.utilise !== null && q.utilise !== undefined && isFinite(Number(q.utilise)) && isFinite(Number(q.reste))) {
      const u = Number(q.utilise), forfait = u + Number(q.reste);
      etat.odds = (etat.odds || []).filter((e) => t - e.t <= 3 * JOUR_MS);
      const der = etat.odds[etat.odds.length - 1];
      /* un autre forfait (cle changee, remise a zero du 1er, offre changee) :
         le compteur recule OU le total change — les echantillons repartent */
      const neuf = der && (u < der.utilise || (der.forfait && der.forfait !== forfait));
      if (neuf) etat.odds = [];
      if (!der || neuf || t - der.t >= 25 * 60000) etat.odds.push({ t, utilise: u, forfait });
    }
    const s = etatDe('odds');
    const n = niveauOdds(q, etat.odds, t, s.mesure);
    if (!n) return null;
    return Object.assign(n, { parti: mesure('odds', n.niveau, n.texte) });
  }

  /** Un evenement ponctuel de The Odds API (releve de prix refusee, cle). */
  function oddsEvenement(sorte, detail) {
    if (sorte === 'refus') return signale('odds', 'bas', 'Une relève de PRIX a été refusée par le garde-fou du quota : ' + String(detail || '').slice(0, 200));
    if (sorte === 'cle') return signale('odds', 'cle', String(detail || '').slice(0, 200));
    if (sorte === 'vide') return signale('odds', 'vide', String(detail || '').slice(0, 200));
    return false;
  }

  function venice(usd) {
    const s = etatDe('venice');
    const n = niveauVenice(usd, s.mesure);
    if (!n) return null;
    return Object.assign(n, { parti: mesure('venice', n.niveau, n.texte) });
  }

  /* Une seule fois dans la vie du volume : de quoi VOIR que le canal prive
     recoit (sinon le premier message serait celui d'une vraie panne). Annule
     si Telegram ne l'a pas pris : on retentera au prochain demarrage. */
  function bonjour(texte) {
    if (etat.bonjour) return false;
    const parti = envoie(texte, () => { etat.bonjour = maintenant(); }, () => { delete etat.bonjour; });
    sauve();
    return parti;
  }

  function etatPublic() {
    return { fournisseurs: JSON.parse(JSON.stringify(etat.fournisseurs)), messagesDerniereHeure: (etat.heure || []).length, MESURE: Object.assign({}, MESURE) };
  }
  return { signale, mesure, succes, erreur, odds, oddsEvenement, venice, bonjour, etat: etatPublic, MESURE };
}

/* ---- LE MODULE PARTAGE ----
 * Les points d'echec sont disperses (studio_chat, studio_compat, studio_media,
 * kling, x402, paris_import) : ils appellent tous ce module, qui ne fait RIEN
 * tant que server.js ne l'a pas `configure` — les essais et la ligne de
 * commande n'envoient jamais d'alerte. */
let ACTIF = null;
function configure(deps) { ACTIF = cree(deps); return ACTIF; }
function reinitialise() { ACTIF = null; }
const sur = (nom) => (...a) => { try { return ACTIF ? ACTIF[nom](...a) : false; } catch (e) { return false; } };

module.exports = {
  cree, configure, reinitialise, classe, lisErreur, masque, niveauOdds, niveauVenice, FOURNISSEURS, MAX_HEURE,
  erreur: sur('erreur'), succes: sur('succes'), odds: sur('odds'), oddsEvenement: sur('oddsEvenement'), venice: sur('venice'), signale: sur('signale'), bonjour: sur('bonjour'),
  etat: () => (ACTIF ? ACTIF.etat() : null),
};
