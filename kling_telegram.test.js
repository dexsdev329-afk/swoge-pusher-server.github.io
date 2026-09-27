'use strict';
/* ============================================================================
 * L'IMAGE KLING POSTEE SUR TELEGRAM A HEURE FIXE (kling_telegram.js)
 *
 * Ce qu'elle DOIT tenir : rien avant l'heure ; a l'heure, une image faite sur
 * la reference officielle, postee UNE fois avec sa legende ; un redemarrage ne
 * la rejoue pas ; plus d'une heure de retard : rien ; un echec de Kling ne
 * poste RIEN sur le canal public, il est journalise ; sans cle, on attend.
 * ==========================================================================*/
const fs = require('fs');
const KT = require('./kling_telegram');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

(async () => {
  const A = Date.parse('2026-09-27T18:00:00Z');
  const prog = [{ cle: 'p1', a: A, prompt: 'SWOGE at poker', legende: 'SWOGE at the poker table', format: '3:4', reference: 'subject' }];
  const fabrique = (o) => {
    const dossier = o.dossier || fs.mkdtempSync('/tmp/kling-tg-');
    const postes = [], journal = [], demandes = [];
    let t = o.t;
    const kt = KT.cree({ dossier, site: 'https://swoleeswoge.dog', programme: prog, maintenant: () => t,
      telegram: { notifyPhoto: (url, leg) => postes.push({ url, leg }) }, journal: (x) => journal.push(x),
      kling: { actif: () => o.actif !== false, image: async (q) => { demandes.push(q); return o.image || { ok: true, id: 'I1', url: 'https://cdn.kling.example/i.png', estimationUsd: 0.028, reference: 'subject', essais: [] }; } } });
    return { kt, dossier, postes, journal, demandes, avance: (ms) => { t += ms; } };
  };

  console.log('-- 1. a l heure, une fois --');
  {
    const f = fabrique({ t: A - 60e3 });
    ok((await f.kt.tour()) === null && f.demandes.length === 0, 'une minute avant : rien');
    f.avance(90e3);
    const r = await f.kt.tour();
    ok(r && r.ok && f.postes.length === 1 && f.postes[0].url === 'https://cdn.kling.example/i.png' && f.postes[0].leg === 'SWOGE at the poker table', 'a l heure : l image part sur Telegram avec sa legende');
    ok(f.demandes[0].image === 'https://swoleeswoge.dog/img/site/swoge_reference.jpg' && f.demandes[0].reference === 'subject', 'faite sur la reference officielle de SWOGE');
    ok(f.journal[0].statut === 'succeed' && f.journal[0].estimationUsd === 0.028, 'et journalisee avec son cout');
    f.avance(60e3); await f.kt.tour();
    ok(f.postes.length === 1, 'le passage suivant ne la reposte pas');
    const g = fabrique({ t: A + 5 * 60e3, dossier: f.dossier });
    await g.kt.tour();
    ok(g.demandes.length === 0 && g.postes.length === 0 && g.kt.etat()[0].fait.etat === 'poste', 'un redemarrage ne la rejoue pas (etat ecrit sur disque)');
  }

  console.log('\n-- 2. ce qui ne part pas --');
  {
    const tard = fabrique({ t: A + KT.RETARD_MAX_MS + 60e3 });
    await tard.kt.tour();
    ok(tard.demandes.length === 0 && tard.postes.length === 0 && tard.kt.etat()[0].fait.etat === 'manque', 'plus d une heure de retard : rien, et c est note « manque »');
    const rate = fabrique({ t: A + 1000, image: { ok: false, raison: 'Kling failed: content risk', essais: [] } });
    const r = await rate.kt.tour();
    ok(r && !r.ok && rate.postes.length === 0 && rate.journal[0].statut === 'failed' && /content risk/.test(rate.journal[0].message), 'Kling echoue : rien sur le canal public, l echec est journalise');
    await rate.kt.tour();
    ok(rate.demandes.length === 1, 'et on ne relance pas en boucle (0,028 $ par essai)');
    const sansCle = fabrique({ t: A + 1000, actif: false });
    await sansCle.kt.tour();
    ok(sansCle.demandes.length === 0 && sansCle.kt.etat()[0].fait === null, 'sans KLING_API_KEY : on attend, l envoi reste du tant qu il est dans l heure');
  }
  console.log('\n-- 3. la video de 20 h 11, faite sur l image de 20 h --');
  {
    const B = Date.parse('2026-09-27T18:11:00Z');
    const prog2 = [{ cle: 'img', a: A, prompt: 'p', legende: 'L1' }, { cle: 'vid', a: B, type: 'video', depuis: 'img', prompt: 'v', legende: 'L2', modele: 'kling-2.6', duree: 5, resolution: '720p', audio: 'off' }];
    const dossier = fs.mkdtempSync('/tmp/kling-tg-');
    const photos = [], videos = [], demandes = [];
    let t = A + 1000, imageFinie = null;
    const kt = KT.cree({ dossier, site: 'https://swoleeswoge.dog', programme: prog2, maintenant: () => t, journal: () => {},
      telegram: { notifyPhoto: (u) => photos.push(u), notifyVideo: (u, l) => videos.push({ u, l }) },
      kling: { actif: () => true, image: async () => { await new Promise((r) => { imageFinie = r; }); return { ok: true, id: 'I', url: 'https://cdn.kling.example/i.png' }; },
               video: async (q) => { demandes.push(q); return { ok: true, id: 'V', url: 'https://cdn.kling.example/v.mp4', estimationUsd: 0.21 }; } } });
    const enCoursImage = kt.tour();
    await new Promise((r) => setTimeout(r, 20));
    t = B + 1000;
    ok((await kt.tour()) === null && demandes.length === 0, 'a 20 h 11, l image encore en cours : la video attend');
    imageFinie(); await enCoursImage;
    const r = await kt.tour();
    ok(r && r.ok && demandes[0].image === 'https://cdn.kling.example/i.png' && demandes[0].modele === 'kling-2.6' && demandes[0].duree === 5,
       'l image finie, la video part DE cette image (kling-2.6, 5 s)');
    ok(videos.length === 1 && videos[0].u === 'https://cdn.kling.example/v.mp4' && videos[0].l === 'L2' && photos.length === 1, 'et elle est postee en video, une fois, apres la photo');
    const sans = KT.cree({ dossier: fs.mkdtempSync('/tmp/kling-tg-'), site: 'https://swoleeswoge.dog', programme: [prog2[1]], maintenant: () => B + 1000, journal: () => {},
      telegram: { notifyVideo: () => {} }, kling: { actif: () => true, video: async (q) => { demandes.push(q); return { ok: true, id: 'V', url: 'https://x/v.mp4' }; } } });
    await sans.tour();
    ok(demandes[1].image === 'https://swoleeswoge.dog/img/site/swoge_reference.jpg', 'sans image de 20 h, elle part de la reference officielle');
  }
  console.log('\n-- 3b. l annonce PayAI : une image cle muette, puis la video seule --');
  {
    const P = KT.PROGRAMME.filter((p) => /^payai-/.test(p.cle));
    const photos = [], videos = [], demandes = [];
    const kt = KT.cree({ dossier: fs.mkdtempSync('/tmp/kling-tg-'), site: 'https://swoleeswoge.dog', programme: P, maintenant: () => P[0].a + 1000, journal: () => {},
      telegram: { notifyPhoto: (u) => photos.push(u), notifyVideo: (u, l) => videos.push({ u, l }) },
      kling: { actif: () => true, image: async (q) => { demandes.push(q); return { ok: true, id: 'I', url: 'https://cdn.kling.example/k.png' }; },
               video: async (q) => { demandes.push(q); return { ok: true, id: 'V', url: 'https://cdn.kling.example/a.mp4' }; } } });
    await kt.tour(); await kt.tour();
    ok(P.length === 2 && photos.length === 0 && videos.length === 1 && videos[0].u === 'https://cdn.kling.example/a.mp4', 'l image cle n est PAS postee ; seule la video part sur le canal');
    ok(demandes[0].format === '9:16' && demandes[0].reference === 'subject' && demandes[1].image === 'https://cdn.kling.example/k.png'
       && demandes[1].modele === 'kling-2.6' && demandes[1].resolution === '1080p' && demandes[1].audio === 'native' && demandes[1].duree === 10,
       'verticale (9:16) sur la reference officielle ; la video part d elle, kling-2.6 1080p, son natif, 10 s');
    const l = videos[0].l;
    ok(l.length <= 1024 && /live on PayAI/.test(l) && /Base<\/b> or <b>Solana/.test(l) && /Powered by Go\+ Security/.test(l) && /swogeagentic\.html/.test(l) && !/token_verdict/.test(l),
       'la legende : sous la limite de Telegram (' + l.length + '/1024), PayAI, Base et Solana, la mention GoPlus, le lien — et rien de ce qui n est pas encore en ligne');
    ok(!/logo/i.test(P[0].prompt.replace(/no logos/, '')) && /no text, no logos/.test(P[0].prompt), 'aucun logo de tiers demande a Kling (« no text, no logos »)');
  }
  console.log('\n-- 4. la serie automatique de 20 h 30 --');
  {
    const C = Date.parse('2026-09-27T18:30:00Z');
    const json = JSON.stringify({ titre: 'SWOGE vs The Machine', episodes: [1, 2, 3, 4].map((i) => ({ titre: 'Ep' + i, image: 'SWOGE scene ' + i, mouvement: 'SWOGE moves ' + i + ', push-in', legende: 'hook ' + i })) });
    const posts = [], images = [], videos = [];
    const kt = KT.cree({ dossier: fs.mkdtempSync('/tmp/kling-tg-'), site: 'https://swoleeswoge.dog', maintenant: () => C + 1000, journal: () => {},
      programme: [{ cle: 's', a: C, type: 'serie', episodes: 4, modele: 'kling-2.6', duree: 10, resolution: '720p', audio: 'off', format: '16:9' }],
      claude: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: 'Here: ' + json }] }) } }),
      telegram: { notifyVideo: (u, l) => posts.push({ u, l }) },
      kling: { actif: () => true,
        image: async (q) => { images.push(q); return { ok: true, url: 'https://cdn/i' + images.length + '.png' }; },
        video: async (q) => { videos.push(q); return videos.length === 3 ? { ok: false, raison: 'Kling failed: risk' } : { ok: true, url: 'https://cdn/v' + videos.length + '.mp4' }; } } });
    const r = await kt.tour();
    ok(images.length === 4 && images.every((q) => q.image === 'https://swoleeswoge.dog/img/site/swoge_reference.jpg' && q.reference === 'subject' && /SWOGE, a very muscular/.test(q.prompt)),
       'quatre images cles, chacune sur la reference officielle de SWOGE');
    ok(videos.length === 4 && videos[0].image === 'https://cdn/i1.png' && videos[3].image === 'https://cdn/i4.png' && videos[0].duree === 10 && /push-in/.test(videos[0].prompt),
       'chaque video part de SON image, 10 s, avec le mouvement ecrit par Claude');
    ok(posts.length === 3 && /SWOGE vs The Machine<\/b> — Episode 1\/4: <b>Ep1/.test(posts[0].l) && /Episode 4\/4/.test(posts[2].l) && /story by Claude, pictures and video by Kling/.test(posts[0].l),
       'postes dans l ordre ; l episode 3 rate ne publie rien et n arrete pas le 4');
    ok(r && r.postes === 3 && kt.etat()[0].fait.episodes.length === 4, 'l etat garde les 4 episodes (un redemarrage n en rejoue aucun)');
    const sans = KT.cree({ dossier: fs.mkdtempSync('/tmp/kling-tg-'), site: 'https://s', maintenant: () => C + 1000, journal: () => {},
      programme: [{ cle: 's', a: C, type: 'serie', episodes: 4 }], telegram: { notifyVideo: (u, l) => posts.push({ u, l }) },
      kling: { actif: () => true, image: async () => ({ ok: false }), video: async () => ({ ok: true, url: 'https://cdn/x.mp4' }) } });
    await sans.tour();
    ok(/backup script/.test(posts[posts.length - 1].l) && /Golden Barbell/.test(posts[posts.length - 1].l), 'sans Claude : la serie de secours part quand meme, et la legende le dit');
    ok(KT.lisSerie('pas du json', 4) === null && KT.lisSerie(json, 5) === null && KT.lisSerie(json, 4).episodes.length === 4, 'un JSON illisible ou incomplet n est pas pris pour une serie');
  }
  console.log('\n-- 5. la suite : chaque episode part de la derniere image du precedent (27/09) --');
  {
    const C = Date.parse('2026-09-27T18:30:00Z');
    const images = [], videos = [], derniers = [];
    const kt = KT.cree({ dossier: fs.mkdtempSync('/tmp/kling-tg-'), site: 'https://swoleeswoge.dog', maintenant: () => C + 1000, journal: () => {},
      programme: [{ cle: 's', a: C, type: 'serie', episodes: 4, modele: 'kling-2.6', duree: 10, resolution: '720p', audio: 'off', format: '16:9' }],
      derniere: async (u) => { derniers.push(u); return u === 'https://cdn/v2.mp4' ? null : 'data:image/jpeg;base64,FIN' + derniers.length; },
      telegram: { notifyVideo: () => {} },
      kling: { actif: () => true,
        image: async (q) => { images.push(q); return { ok: true, url: 'https://cdn/i' + images.length + '.png' }; },
        video: async (q) => { videos.push(q); return { ok: true, url: 'https://cdn/v' + videos.length + '.mp4' }; } } });
    await kt.tour();
    ok(videos[0].image === 'https://cdn/i1.png' && videos[1].image === 'data:image/jpeg;base64,FIN1', 'episode 2 : sa premiere image est la DERNIERE de l episode 1');
    ok(derniers[0] === 'https://cdn/v1.mp4' && /continues directly from the first frame/.test(videos[1].prompt), 'lue sur la video de l episode 1, et le prompt le dit');
    ok(images.length === 2 && videos[2].image === 'https://cdn/i2.png', 'derniere image illisible (episode 2) : l episode 3 repart d une image cle neuve');
    ok(videos[3].image === 'data:image/jpeg;base64,FIN3', 'et l episode 4 reprend la derniere image du 3');
    ok(/CONTINUES the previous shot seamlessly/.test(require('./kling_telegram').SERIE_SECOURS ? require('fs').readFileSync(require.resolve('./kling_telegram'), 'utf8') : ''), 'Claude est prevenu que les episodes s enchainent');
  }
  const S3 = KT.PROGRAMME.find((p) => p.type === 'serie');
  ok(S3 && S3.a === Date.parse('2026-09-27T18:30:00Z') && S3.episodes === 4, 'le programme reel : la serie a 20 h 30 (Paris), 4 episodes');
  ok(KT.PROGRAMME[1] && KT.PROGRAMME[1].a === Date.parse('2026-09-27T18:11:00Z') && KT.PROGRAMME[1].depuis === KT.PROGRAMME[0].cle, 'le programme reel : la video a 20 h 11, depuis l image de 20 h');
  ok(KT.PROGRAMME[0].a === Date.parse('2026-09-27T18:00:00Z') && /reference image/.test(KT.PROGRAMME[0].prompt) && /poker/.test(KT.PROGRAMME[0].prompt),
     'le programme reel : 20 h a Paris le 27/09 (18 h UTC), SWOGE au poker, sur la reference');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
