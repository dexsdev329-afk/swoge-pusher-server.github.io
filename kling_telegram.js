'use strict';
/* ==========================================================================
 * UNE IMAGE KLING POSTEE SUR TELEGRAM, A HEURE FIXE, UNE SEULE FOIS
 *
 * Demande du proprietaire, 27 septembre 2026 : « j'ai pris le plan video et
 * image, cree une requete pour qu'a 20 h il poste dans le Telegram une image
 * Kling de SWOGE au poker, pour voir le resultat ».
 *
 * C'est un ESSAI : on veut voir ce que Kling rend a partir du personnage
 * officiel (img/site/swoge_reference.jpg, la meme reference que SwoleMind),
 * donc chaque envoi du programme part une fois et une seule :
 *   - l'envoi fait est ecrit dans DATA_DIR (kling_telegram.json) AVANT de
 *     poster, et un redemarrage ne le rejoue pas ;
 *   - un serveur qui demarre plus d'une heure apres l'heure prevue ne poste
 *     pas en retard (un « 20 h » publie a 23 h n'est plus le meme essai) ;
 *   - si Kling echoue, RIEN ne part sur le canal public : l'echec est journalise
 *     (kling_essais.jsonl) et lisible dans /studio/kling, pas annonce aux joueurs.
 * Cout : 0,028 $ l'image (Kling Image 3.0, grille officielle), sur le compte
 * Kling du proprietaire.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

/* 20 h a Paris le 27/09/2026 = 18 h UTC (heure d'ete, UTC+2). */
const PROGRAMME = [
  { cle: 'poker-2026-09-27', a: Date.parse('2026-09-27T18:00:00Z'),
    prompt: 'SWOGE, the character in the reference image: a very muscular, bodybuilder-build shiba inu — keep his face, fur colours and muscular build. '
      + 'He sits at a high-stakes poker table in a luxurious neon-lit casino at night, calmly revealing a royal flush of spades, '
      + 'tall stacks of gold chips in front of him, other players in shadow, green felt, warm cinematic lighting, confident smirk, highly detailed, sharp focus.',
    legende: '🃏 <b>SWOGE at the poker table</b>\nFirst picture made with <b>Kling AI</b> from the official SWOGE character.\n\n♠️ Play live: https://swoleeswoge.dog/swoge_poker.html',
    format: '3:4', reference: 'subject' },
  /* « Vu que tu auras l'image test, le modele video, et poste une video aussi
     a 20 h 11. » La video part de l'image de 20 h (premiere image) ; si
     l'image a echoue, de la reference officielle. Kling 2.6, 5 s, 720p sans
     son : 0,21 $ (grille officielle, kling.js). */
  { cle: 'poker-video-2026-09-27', a: Date.parse('2026-09-27T18:11:00Z'), type: 'video', depuis: 'poker-2026-09-27',
    prompt: 'SWOGE, the very muscular shiba inu, sits at the poker table, slowly pushes all his gold chips to the center, '
      + 'then turns his cards over to reveal a royal flush and grins; the casino lights flicker, other players gasp, cinematic slow camera push-in.',
    legende: '🎬 <b>SWOGE goes all-in</b>\nFirst video made with <b>Kling AI</b>, from the picture posted at 20:00.\n\n♠️ Play live: https://swoleeswoge.dog/swoge_poker.html',
    modele: 'kling-2.6', duree: 5, resolution: '720p', audio: 'off' },
  /* « Fais 4 videos programmees pour 20 h 30, episodes 1 2 3 4 : tu as toutes
     les API, essaie de creer une serie entierement avec l'IA, inventee, avec le
     personnage de SWOGE, en automatique, juste pour le test. » (27/09)
     Claude ecrit la serie (4 episodes : image cle, mouvement, legende) ; Kling
     Image dessine chaque image cle sur la reference officielle ; Kling Video
     l'anime (kling-2.6, 10 s, 720p sans son) ; chaque episode part sur
     Telegram des qu'il est pret, dans l'ordre. Cout : 4 × (0,028 + 0,42) =
     1,79 $ sur le compte Kling, ~0,01 $ de Claude. */
  { cle: 'serie-2026-09-27', a: Date.parse('2026-09-27T18:30:00Z'), type: 'serie', episodes: 4,
    modele: 'kling-2.6', duree: 10, resolution: '720p', audio: 'off', format: '16:9' },
  /* « Fais une video qui arrive sur le canal Telegram pour annoncer qu'on a des
     agents AI x402 sur PayAI ; essaie de la rendre virale, avec un bon texte. »
     (27/09, 23 h 12 a Paris). Fait mesure le meme soir : nos 6 outils sont dans
     le catalogue public de PayAI (/discovery/resources, 6 971 services), payables
     en USDC sur Base et Solana. Le logo de PayAI n'est PAS repris : leur marque
     dans notre pub laisserait croire a un partenariat, alors qu'on est liste
     dans un catalogue ouvert. L'image cle (verticale, pour le telephone) n'est
     pas postee ; la video part d'elle, avec le son natif de Kling (une replique
     de SWOGE). Cout : 0,028 $ + 10 s × 0,14 $ = 1,43 $ sur le compte Kling. */
  { cle: 'payai-image-2026-09-27', a: Date.parse('2026-09-27T21:20:00Z'), muet: true, format: '9:16', reference: 'subject',
    prompt: 'SWOGE, the character in the reference image: a very muscular, bodybuilder-build shiba inu — keep his face, fur colours and muscular build. '
      + 'He stands in a futuristic neon trading command center at night, wearing a sleek black hoodie, surrounded by floating holographic screens of green crypto charts; '
      + 'three small glowing robot drones hover around him, each carrying a shining blue coin. Vertical cinematic shot, dramatic rim lighting, highly detailed, sharp focus, no text, no logos.' },
  { cle: 'payai-video-2026-09-27', a: Date.parse('2026-09-27T21:20:00Z'), type: 'video', depuis: 'payai-image-2026-09-27',
    prompt: 'SWOGE, the muscular shiba inu, looks straight into the camera with a confident smirk and says: "My AI agents are live. Any AI can hire them." '
      + 'The small robot drones zip around him and drop glowing blue coins into his open palm; the holographic charts spike upward. '
      + 'Slow cinematic push-in on his face, neon light flickers, deep bass hit at the end.',
    legende: '🤖 <b>SWOGE AI agents are now live on PayAI</b>\n\n'
      + 'Our x402 tools are listed in PayAI\'s public catalog of agent services. Any AI agent can hire them and pay per call in USDC on <b>Base</b> or <b>Solana</b> — no account, no API key.\n\n'
      + '🔎 <b>scan_token</b> — market + contract checks (Powered by Go+ Security)\n'
      + '🚪 <b>can_i_sell</b> — can you exit a Robinhood Chain token?\n'
      + '🧠 <b>colony_activity</b> · <b>new_launches</b> · <b>swoge_economy</b> — live data from the SWOGE AI colony\n\n'
      + '💸 From $0.02 a call\n👉 https://swoleeswoge.dog/swogeagentic.html',
    modele: 'kling-2.6', duree: 10, resolution: '1080p', audio: 'native' },
  /* « Le post avec la video a fait 250 vues meme si le produit n'est pas bien
     mis en avant ; refais-en un dans le Telegram avec les nouvelles
     informations, une image de qualite animee 6 secondes, sans voix, juste du
     son, et SWOGE qui tient le logo de PayAI. » (28/09, 09 h 30 a Paris)
     Les chiffres de la legende sont relus EN DIRECT le 28/09 a 07:30 UTC :
     /.well-known/x402 sert 16 outils, 15 sont au catalogue PayAI ; les 402
     disent token_verdict 0,01 $ (Base, Solana), robinhood_* 0,005 $ sur Base,
     et chaque outil se paie aussi en USDG ou en $SWOGE sur Robinhood Chain.
     Le LOGO : Kling Image ne prend qu'UNE image de reference (le personnage),
     il ne peut donc pas recevoir le logo de PayAI en image. Le proprietaire a
     envoye le logo (28/09, 09 h 35 a Paris) : il est DECRIT dans la consigne —
     trois couches en losange arrondies, empilees, en degrade de bleu, au-dessus
     du mot « PayAI » en bleu roi, sur fond blanc. On dit un fait (on est au
     catalogue), sans « × » ni « partner » qui feraient croire a un partenariat.
     Heure decalee a 08:15 UTC : le deploiement qui porte la consigne doit etre
     en ligne bien avant (un redeploiement pendant l'attente perd la video). Video : kling-3.0-turbo, la seule a 6 s ; son
     natif impose par le modele, donc la consigne dit « aucune voix, musique et
     bruitages seulement ». Cout : 0,028 $ + 6 s × 0,14 $ = 0,87 $. */
  { cle: 'agents15-image-2026-09-28', a: Date.parse('2026-09-28T08:15:00Z'), muet: true, format: '9:16', reference: 'subject',
    prompt: 'SWOGE, the character in the reference image: a very muscular, bodybuilder-build shiba inu — keep his face, fur colours and muscular build. '
      + 'He stands on a futuristic neon stage at night and proudly holds up, with both hands in front of his chest, a large glossy white square sign showing the PayAI logo: '
      + 'three stacked rounded diamond-shaped layers in a light-to-royal-blue gradient at the top, and below them the word "PayAI" in bold rounded royal-blue letters. '
      + 'Behind him, a wall of holographic screens with green crypto charts, and a swarm of small friendly robot agents flying toward him carrying glowing blue coins. '
      + 'Vertical cinematic shot, dramatic rim lighting, premium 3D render quality, highly detailed, sharp focus. The only text in the image is "PayAI" on the sign; the sign is sharp, flat and fully readable.' },
  { cle: 'agents15-video-2026-09-28', a: Date.parse('2026-09-28T08:15:00Z'), type: 'video', depuis: 'agents15-image-2026-09-28',
    prompt: 'SWOGE, the muscular shiba inu, lifts the white PayAI logo sign higher, keeping the logo readable and unchanged, and flexes with a confident grin; the small robot agents swoop in and drop glowing blue coins around him, '
      + 'the holographic charts spike upward. Slow cinematic push-in. No dialogue and no voice at all: only an energetic electronic beat, whooshes and coin sound effects.',
    legende: '🤖 <b>SWOGE AI: 15 tools live on PayAI</b>\n\n'
      + 'Any AI agent can hire SWOGE AI and pay per call with x402: USDC on <b>Base</b> or <b>Solana</b>, or USDG / $SWOGE on <b>Robinhood Chain</b>. No account, no API key.\n\n'
      + '🆕 <b>token_verdict</b> — a fast verdict on any token for $0.01\n'
      + '🧠 <b>chat_completion</b> — 10 AI models, OpenAI format, pay per call\n'
      + '⛓️ <b>robinhood_token · wallet · tx · rpc</b> — Robinhood Chain data, decoded\n'
      + '🔎 <b>scan_token</b> — market + contract checks (Powered by Go+ Security)\n'
      + '🚪 <b>can_i_sell</b> — can you exit before you buy?\n'
      + '🕵️ <b>wallet_intel</b> · <b>osint_lookup</b> · <b>web_search</b>\n'
      + '📊 <b>colony_activity</b> · <b>new_launches</b> · <b>swoge_economy</b> — live from the SWOGE AI colony\n'
      + '🤝 <b>ask_agent</b> — a research agent that chains the tools\n\n'
      + '💸 From $0.005 a call\n👉 https://swoleeswoge.dog/swogeagentic.html',
    modele: 'kling-3.0-turbo', duree: 6, resolution: '1080p', audio: 'native' },
];
const RETARD_MAX_MS = 60 * 60e3;

/* ---- LA SERIE ECRITE PAR CLAUDE ----
 * Un JSON strict ; s'il ne vient pas (cle absente, panne, JSON illisible), une
 * serie de secours ecrite ici part quand meme : le test mesure la chaine
 * image → video → Telegram, et le dit dans la legende. */
const SWOGE_MOT = 'SWOGE, a very muscular, bodybuilder-build shiba inu (keep his face, fur colours and build from the reference picture)';
const SERIE_SYSTEME = 'You write tiny animated web series. Answer with JSON only, no prose, no code fence.';
function consigneSerie(n) {
  return 'Invent an original ' + n + '-episode micro-series starring ' + SWOGE_MOT + '. Fun, epic, a clear story arc with a twist in episode ' + Math.max(2, n - 1)
    + ' and a payoff in episode ' + n + '. Each episode is ONE 10-second shot, and each one CONTINUES the previous shot seamlessly: the next episode starts on the last frame of the one before, so SWOGE keeps the same outfit and the action flows from place to place without jumps. Return exactly: '
    + '{"titre":"series title","episodes":[{"titre":"episode title","image":"the key frame: who, where, what, the light, 1-2 sentences","mouvement":"what moves in 10 seconds and ONE cinematic camera move (push-in, tracking, orbit, crane or low angle), 1-2 sentences","legende":"one short hook line for Telegram"}]} '
    + 'with ' + n + ' episodes. Always name SWOGE in image and mouvement. English.';
}
const SERIE_SECOURS = { titre: 'SWOGE: The Golden Barbell', secours: true, episodes: [
  { titre: 'The Map', image: 'SWOGE finds an old treasure map in a neon-lit gym at night, holding it up under a single spotlight.', mouvement: 'SWOGE unfolds the map and grins; slow push-in on his face as the map glows.', legende: 'It starts with a map.' },
  { titre: 'The Jungle Gym', image: 'SWOGE runs through a jungle full of ancient stone weights and vines at golden hour.', mouvement: 'SWOGE leaps over a fallen stone column; tracking shot at his height.', legende: 'The jungle tests every muscle.' },
  { titre: 'The Trap', image: 'SWOGE in a torch-lit temple, a giant stone door closing behind him.', mouvement: 'SWOGE holds the closing stone door up with both arms; low-angle shot, dust falling.', legende: 'Twist: the temple fights back.' },
  { titre: 'The Golden Barbell', image: 'SWOGE lifts a glowing golden barbell over his head in the temple treasure room.', mouvement: 'SWOGE lifts the golden barbell and roars; crane shot rising as gold light fills the room.', legende: 'Legend unlocked.' },
] };
function lisSerie(txt, n) {
  try {
    const m = /\{[\s\S]*\}/.exec(String(txt || '')); if (!m) return null;
    const j = JSON.parse(m[0]);
    const eps = (Array.isArray(j.episodes) ? j.episodes : []).slice(0, n).map((e) => ({
      titre: String(e.titre || '').slice(0, 60), image: String(e.image || '').slice(0, 600),
      mouvement: String(e.mouvement || '').slice(0, 600), legende: String(e.legende || '').slice(0, 140) }));
    if (eps.length < n || eps.some((e) => !e.image || !e.mouvement)) return null;
    return { titre: String(j.titre || 'SWOGE').slice(0, 80), episodes: eps };
  } catch (e) { return null; }
}
const echappe = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * deps : { kling (kling.js), telegram ({ notifyPhoto }), dossier, site, journal(o),
 *          maintenant?, programme? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const programme = deps.programme || PROGRAMME;
  const fichier = path.join(deps.dossier, 'kling_telegram.json');
  const journal = deps.journal || (() => {});
  let faits = {};
  try { faits = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch (e) { faits = {}; }
  let enCours = false;

  const ecrit = () => { try { fs.writeFileSync(fichier, JSON.stringify(faits)); } catch (e) { /* jamais bloquant */ } };

  /** Un passage : poste ce qui est du, rend ce qui a ete fait (pour les essais). */
  async function tour() {
    if (enCours) return null;
    const t = maintenant();
    const du = programme.find((p) => !faits[p.cle] && t >= p.a && t - p.a <= RETARD_MAX_MS);
    /* Trop tard : on le note comme manque, une fois, sans rien poster. */
    for (const p of programme) if (!faits[p.cle] && t - p.a > RETARD_MAX_MS) { faits[p.cle] = { etat: 'manque', t }; ecrit(); journal({ programme: p.cle, statut: 'manque' }); }
    if (!du) return null;
    if (!deps.kling.actif()) return null;          // sans cle, on attend : l'essai reste du tant qu'il est dans l'heure
    /* La video attend que son image soit finie (ou tombee) ; elle ne part pas sur une image en cours. */
    const source = du.depuis ? faits[du.depuis] : null;
    if (du.depuis && source && source.etat === 'lance') return null;
    if (du.type === 'video') return video(du, t, source);
    if (du.type === 'serie') return serie(du, t);
    enCours = true;
    faits[du.cle] = { etat: 'lance', t }; ecrit();  // ecrit AVANT : un redemarrage pendant l'attente ne relance pas
    try {
      const r = await deps.kling.image({ prompt: du.prompt, image: deps.site + '/img/site/swoge_reference.jpg', reference: du.reference, format: du.format }, deps.attente);
      if (!r.ok) {
        faits[du.cle] = { etat: 'echec', t, raison: r.raison }; ecrit();
        journal({ programme: du.cle, type: 'image', statut: 'failed', message: r.raison, essais: r.essais });
        return { cle: du.cle, ok: false, raison: r.raison };
      }
      /* `muet` : l'image n'est que la premiere image d'une video (l'annonce PayAI
         du 27/09 : une video seule sur le canal, pas une photo puis une video). */
      if (!du.muet) deps.telegram.notifyPhoto(r.url, du.legende);
      faits[du.cle] = { etat: 'poste', t, id: r.id, url: r.url, reference: r.reference, muet: !!du.muet }; ecrit();
      journal({ programme: du.cle, type: 'image', id: r.id, statut: 'succeed', url: r.url, reference: r.reference, estimationUsd: r.estimationUsd, essais: r.essais });
      return { cle: du.cle, ok: true, url: r.url };
    } finally { enCours = false; }
  }

  async function video(du, t, source) {
    enCours = true;
    faits[du.cle] = { etat: 'lance', t }; ecrit();
    try {
      const image = source && source.etat === 'poste' && source.url ? source.url : deps.site + '/img/site/swoge_reference.jpg';
      const r = await deps.kling.video({ prompt: du.prompt, image, modele: du.modele, duree: du.duree, resolution: du.resolution, audio: du.audio }, deps.attente);
      if (!r.ok) {
        faits[du.cle] = { etat: 'echec', t, raison: r.raison }; ecrit();
        journal({ programme: du.cle, type: 'video', statut: 'failed', message: r.raison });
        return { cle: du.cle, ok: false, raison: r.raison };
      }
      (deps.telegram.notifyVideo || deps.telegram.notifyPhoto)(r.url, du.legende);
      faits[du.cle] = { etat: 'poste', t, id: r.id, url: r.url, depuisImage: image }; ecrit();
      journal({ programme: du.cle, type: 'video', id: r.id, statut: 'succeeded', url: r.url, estimationUsd: r.estimationUsd, depuisImage: image });
      return { cle: du.cle, ok: true, url: r.url };
    } finally { enCours = false; }
  }

  async function ecritSerie(n) {
    const client = deps.claude ? deps.claude() : null;
    if (!client) return SERIE_SECOURS;
    try {
      const r = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 1500, system: SERIE_SYSTEME,
        messages: [{ role: 'user', content: consigneSerie(n) }] });
      const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return lisSerie(txt, n) || SERIE_SECOURS;
    } catch (e) { return SERIE_SECOURS; }
  }

  /* La serie : ecrite, puis chaque episode image → video → Telegram, dans l'ordre.
     L'etat est ecrit a chaque episode : un redemarrage n'en rejoue aucun. */
  async function serie(du, t) {
    enCours = true;
    faits[du.cle] = { etat: 'lance', t, episodes: [] }; ecrit();
    try {
      const s = await ecritSerie(du.episodes);
      faits[du.cle].titre = s.titre; faits[du.cle].secours = !!s.secours; ecrit();
      journal({ programme: du.cle, type: 'serie', titre: s.titre, secours: !!s.secours, episodes: s.episodes.map((e) => e.titre) });
      let postes = 0, precedente = null;
      for (let i = 0; i < s.episodes.length; i++) {
        const e = s.episodes[i], nom = 'Episode ' + (i + 1) + '/' + s.episodes.length;
        /* ---- LA SUITE : la derniere image de l'episode precedent ----
           « La seule facon de faire une suite, c'est la derniere seconde de
           l'image » (27/09). A partir de l'episode 2, la premiere image est
           la derniere de la video d'avant ; sans elle (ffmpeg absent, video
           expiree, episode rate), une image cle neuve comme avant. */
        const suite = precedente && deps.derniere ? await deps.derniere(precedente) : null;
        const im = suite ? { ok: true, url: null, suite: true }
          : await deps.kling.image({ prompt: e.image + ' ' + SWOGE_MOT + '. Cinematic, detailed, film lighting.', image: deps.site + '/img/site/swoge_reference.jpg', reference: 'subject', format: du.format }, deps.attente);
        const depart = suite || (im.ok && im.url ? im.url : deps.site + '/img/site/swoge_reference.jpg');
        const v = await deps.kling.video({ prompt: e.mouvement + (suite ? ' This shot continues directly from the first frame: same place, same outfit, same light, then the action moves on.' : '') + ' Keep SWOGE exactly as in the first frame.',
          image: depart, modele: du.modele, duree: du.duree, resolution: du.resolution, audio: du.audio }, deps.attente);
        precedente = v.ok ? v.url : null;
        const ep = { n: i + 1, titre: e.titre, suite: !!suite, image: im.ok ? im.url : null, video: v.ok ? v.url : null, raison: v.ok ? null : v.raison };
        faits[du.cle].episodes.push(ep); ecrit();
        journal({ programme: du.cle, type: 'episode', n: i + 1, titre: e.titre, statut: v.ok ? 'succeeded' : 'failed', url: v.url || null, image: ep.image, message: v.ok ? null : v.raison });
        if (!v.ok) continue;                         /* un episode rate ne publie rien ; les suivants continuent */
        postes++;
        (deps.telegram.notifyVideo || deps.telegram.notifyPhoto)(v.url,
          '📺 <b>' + echappe(s.titre) + '</b> — ' + nom + ': <b>' + echappe(e.titre) + '</b>\n' + echappe(e.legende)
          + '\n\n<i>Made automatically: story by Claude' + (s.secours ? ' (backup script)' : '') + ', pictures and video by Kling AI.</i>');
      }
      faits[du.cle].etat = postes ? 'poste' : 'echec'; faits[du.cle].postes = postes; ecrit();
      return { cle: du.cle, ok: postes > 0, postes, titre: s.titre };
    } finally { enCours = false; }
  }

  let minuteur = null;
  function demarre(pasMs) {
    if (minuteur) return;
    minuteur = setInterval(() => { tour().catch(() => {}); }, pasMs || 30e3);
    if (minuteur.unref) minuteur.unref();
    tour().catch(() => {});
  }
  const etat = () => programme.map((p) => ({ cle: p.cle, a: p.a, fait: faits[p.cle] || null }));

  return { tour, demarre, etat };
}

module.exports = { cree, PROGRAMME, RETARD_MAX_MS, lisSerie, SERIE_SECOURS };
