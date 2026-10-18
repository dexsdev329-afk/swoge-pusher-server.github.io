'use strict';
/*
 * SWOGE STUDIO — IMAGES ET VIDÉOS : ce qui peut perdre de l'argent, mis à l'essai.
 *
 *   1. On ne facture JAMAIS sous le coût rendu par xAI, jamais plus que la
 *      réserve ; la réserve couvre les prix de liste avec marge.
 *   2. Échec du fournisseur, image refusée, vidéo ratée ou trop longue : TOUT
 *      est rendu. Solde insuffisant : aucun appel payant.
 *   3. Une image jointe mal formée ou trop lourde est refusée avant tout débit.
 *   4. Une vidéo n'est lisible que par l'adresse qui l'a payée.
 *   5. De bout en bout, sur le VRAI serveur contre un faux xAI local
 *      (`XAI_BASE_URL`) : jeton de session exigé, seule l'adresse de la
 *      session est débitée, la clé ne quitte pas l'hôte, les champs envoyés
 *      sont ceux de la spécification OpenAPI d'xAI.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/studiomedia-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801';
process.env.STUDIO_MARGE = '1.5';
process.env.STUDIO_VIDEO_POLL_MS = '200'; process.env.STUDIO_VIDEO_MAX_MS = '60000';
delete process.env.XAI_API_KEY; delete process.env.GROK_API_KEY;
/* Hermetique : jamais la vraie cle OpenAI de l'environnement de developpement. */
delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_BASE_URL; delete process.env.XAI_BASE_URL;

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const COURS = 0.00002801;
const W = (x) => ethers.utils.parseUnits(String(x), 18);

(async () => {
  const port = await libre();
  process.env.PORT = String(port);
  const M = require('./studio_media');

  /* Un faux solde : ce qui est reserve, ce qui est facture. */
  const faux = () => {
    const s = { bal: W(1000000), reserves: [], reglements: [] };
    s.solde = {
      reserve: (a, w) => { const x = ethers.BigNumber.from(String(w)); if (x.lte(0) || s.bal.lt(x)) return false; s.bal = s.bal.sub(x); s.reserves.push(x); return true; },
      regle: (a, rw, fw) => { const r = ethers.BigNumber.from(String(rw)); const f = ethers.BigNumber.from(String(fw)); s.bal = s.bal.add(r.sub(f)); s.reglements.push({ r, f }); return ethers.utils.formatUnits(s.bal, 18); },
    };
    return s;
  };
  const enUsd = (wei) => Number(ethers.utils.formatUnits(wei, 18)) * COURS;

  console.log('-- 1. une image : le cout reel de xAI, avec marge, jamais sous le cout --');
  {
    for (const m of M.IMAGE.filter((x) => x.fournisseur === 'grok')) for (const nb of M.NOMBRES) {
      const s = faux();
      const cout = m.usd * nb;                         /* le prix de liste, rendu en ticks */
      const r = await M.images({ addr: '0xa' + m.id + nb, modele: m.id, prompt: 'a buff doge', n: nb }, {
        cours: async () => COURS, solde: s.solde,
        fournisseur: { images: async () => ({ urls: Array(nb).fill('https://x/img.png'), usage: { cost_in_usd_ticks: Math.round(cout * 1e10) } }) } });
      const f = s.reglements[0];
      ok(r.ok && enUsd(f.f) >= cout * 1.5 - 1e-6, m.nom + ' ×' + nb + ' : facture ' + enUsd(f.f).toFixed(4) + ' $ ≥ cout ' + cout.toFixed(2) + ' × 1,5');
      ok(enUsd(f.r) >= enUsd(f.f), 'et la reserve couvrait la facture');
    }
  }

  console.log('\n-- 1 bis. ChatGPT Image : factures aux JETONS lus dans usage, jamais sous le cout --');
  {
    const P = M.PRIX_OPENAI[M.modeleOpenai()];
    for (const m of M.IMAGE.filter((x) => x.fournisseur === 'openai')) for (const nb of M.NOMBRES) for (const retouche of [false, true]) {
      const s = faux(); let demande = null;
      /* Un usage realiste et large : 7 000 jetons de sortie par image (la mesure du 18 septembre : 6 893). */
      const usage = { input_tokens: 60 + (retouche ? 9000 : 0), input_tokens_details: { text_tokens: 60, image_tokens: retouche ? 9000 : 0 }, output_tokens: 7000 * nb };
      const cout = (60 * P.t + (retouche ? 9000 : 0) * P.i + 7000 * nb * P.o) / 1e6;
      const r = await M.images({ addr: '0xo' + m.id + nb + retouche, fournisseur: 'openai', modele: m.id, prompt: 'a buff doge', n: nb,
        image: retouche ? 'data:image/png;base64,iVBORw0KGgo=' : undefined }, {
        cours: async () => COURS, solde: s.solde, range: (u) => '/studio/media/fichier/' + 'a'.repeat(48) + '.jpg',
        fournisseurs: { openai: { actif: () => true, images: async (o) => { demande = o; return { urls: Array(nb).fill('data:image/jpeg;base64,/9j/AAA='), usage }; } } } });
      const f = s.reglements[0];
      ok(r.ok && enUsd(f.f) >= cout * 1.5 - 1e-6 && enUsd(f.r) >= enUsd(f.f),
         'ChatGPT ' + m.nom + ' ×' + nb + (retouche ? ' retouche' : '') + ' : facture ' + enUsd(f.f).toFixed(4) + ' $ ≥ cout ' + cout.toFixed(4) + ' × 1,5, sous la reserve');
      if (nb === 1 && !retouche) ok(demande.qualite === (m.id === 'qualite' ? 'high' : 'medium'), m.nom + ' = qualite ' + demande.qualite);
      if (nb === 1 && !retouche) ok(r.urls[0].startsWith('/studio/media/fichier/'), 'les images en base64 sont rangees chez nous : la page recoit une adresse');
    }
    const r = await M.images({ addr: '0xoff', fournisseur: 'openai', prompt: 'x' }, { cours: async () => COURS, solde: faux().solde,
      fournisseurs: { openai: { actif: () => false, images: async () => ({ urls: ['u'] }) } } });
    eq(r.code, 503, 'sans cle OpenAI : 503, rien n est reserve');
  }

  console.log('\n-- 1 ter. payee d avance (x402) : hors solde, cout reel compte --');
  {
    const s = faux(); const avant = s.bal;
    const H0 = Object.assign({}, M.MESURE.horsSolde);
    const prixUsd = M.prixFixeImageUsd({ fournisseur: 'grok', modele: 'qualite', n: 2, prompt: 'a buff doge' });
    const r = await M.images({ addr: 'x402:0xpayeur', modele: 'qualite', prompt: 'a buff doge', n: 2, prixUsd }, { horsSolde: true, cours: async () => { throw new Error('ne doit pas lire le cours'); }, solde: s.solde,
      fournisseur: { images: async () => ({ urls: ['https://x/1.png', 'https://x/2.png'], usage: { cost_in_usd_ticks: Math.round(0.08 * 1e10) } }) } });
    ok(r.ok && s.bal.eq(avant) && !s.reserves.length && !s.reglements.length, 'aucun solde de jeu touche, aucun cours lu (le paiement est ailleurs)');
    const H = M.MESURE.horsSolde;
    ok(H.images - H0.images === 2 && Math.abs((H.coutUsd - H0.coutUsd) - 0.08) < 1e-9 && Math.abs((H.prixUsd - H0.prixUsd) - prixUsd) < 1e-9,
       'le cout reel (0,08 $) et le prix encaisse (' + prixUsd.toFixed(3) + ' $) sont comptes cote a cote — la base pour baisser le prix sur mesure');
    ok(prixUsd >= 0.08 * 1.5, 'et le prix fixe couvre ce cout avec la marge (jamais sous le cout)');
    const panne = await M.images({ addr: 'x402:0xp2', modele: 'rapide', prompt: 'x' }, { horsSolde: true, solde: s.solde, fournisseur: { images: async () => { throw new Error('xAI 500'); } } });
    ok(!panne.ok && panne.code === 502 && !s.reglements.length, 'en panne : 502, et toujours aucun mouvement de solde');
    ok(M.prixFixeImageUsd({ fournisseur: 'grok', modele: 'rapide', n: 1, prompt: 'SWOGE on a boat' }) > M.prixFixeImageUsd({ fournisseur: 'grok', modele: 'rapide', n: 1, prompt: 'a boat' }),
       'une demande qui nomme SWOGE coute plus (image de reference + reecriture comptees dans le prix)');
  }

  console.log('\n-- 2. tout est rendu quand rien n est livre --');
  {
    const s = faux(); const avant = s.bal;
    const r = await M.images({ addr: '0xb', modele: 'rapide', prompt: 'x', n: 2 }, { cours: async () => COURS, solde: s.solde,
      fournisseur: { images: async () => { throw new Error('xAI 500'); } } });
    ok(!r.ok && r.code === 502 && s.bal.eq(avant), 'le fournisseur echoue : 502, solde intact');
    const s2 = faux(); const avant2 = s2.bal;
    const r2 = await M.images({ addr: '0xb2', modele: 'rapide', prompt: 'x' }, { cours: async () => COURS, solde: s2.solde,
      fournisseur: { images: async () => ({ urls: [], usage: null }) } });
    ok(!r2.ok && s2.bal.eq(avant2), 'aucune image rendue (moderation) : rien n est facture');
    let appels = 0;
    const pauvre = faux(); pauvre.bal = W(1);
    const r3 = await M.images({ addr: '0xc', modele: 'qualite', prompt: 'x', n: 4 }, { cours: async () => COURS, solde: pauvre.solde,
      fournisseur: { images: async () => { appels++; return { urls: ['u'] }; } } });
    ok(r3.code === 402 && appels === 0 && Number(r3.requisSwoge) > 0, 'solde insuffisant : 402 avec le montant requis, AUCUN appel payant');
    const r4 = await M.images({ addr: '0xd', prompt: 'x', image: 'data:text/html;base64,PHNjcmlwdD4=' }, { cours: async () => COURS, solde: faux().solde, fournisseur: {} });
    ok(r4.code === 400, 'une piece jointe qui n est pas une image : refusee avant tout debit');
    const lourde = 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024);
    ok(M.imageJointe(lourde) === false, 'une image de plus de 6 Mo : refusee');
  }

  console.log('\n-- 3. sans usage : la liste, plafonnee a la reserve, et comptee --');
  {
    const s = faux(); const avant = M.MESURE.sansUsage;
    const r = await M.images({ addr: '0xe', modele: 'qualite', prompt: 'x' }, { cours: async () => COURS, solde: s.solde,
      fournisseur: { images: async () => ({ urls: ['u'], usage: null }) } });
    ok(r.ok && enUsd(s.reglements[0].f) >= 0.04 * 1.5 - 1e-6, 'facture au prix de liste avec marge');
    eq(M.MESURE.sansUsage, avant + 1, 'et le cas est compte');
    const s2 = faux(); const d0 = M.MESURE.depassements;
    await M.images({ addr: '0xf', modele: 'rapide', prompt: 'x' }, { cours: async () => COURS, solde: s2.solde,
      fournisseur: { images: async () => ({ urls: ['u'], usage: { cost_in_usd_ticks: 5 * 1e10 } }) } });
    ok(s2.reglements[0].f.eq(s2.reglements[0].r) && M.MESURE.depassements === d0 + 1, 'un cout aberrant ne depasse jamais la reserve (depassement compte)');
  }

  console.log('\n-- 4. une video : lancee, suivie, reglee — et a son proprietaire seulement --');
  {
    const s = faux(); let etat = { status: 'pending', progress: 40 };
    const deps = { cours: async () => COURS, solde: s.solde, sansBoucle: true,
      fournisseur: { lanceVideo: async (o) => { deps.demande = o; return 'rid-1'; }, litVideo: async () => etat } };
    const r = await M.lanceVideo({ addr: '0xv', modele: 'qualite', prompt: 'doge lifts', duree: 10, resolution: '720p', format: '9:16' }, deps);
    ok(r.ok && r.status === 'pending' && r.id, 'la video est lancee');
    ok(deps.demande.api === 'grok-imagine-video-1.5' && deps.demande.duree === 10 && deps.demande.resolution === '720p' && deps.demande.format === '9:16', 'avec le modele, la duree, la resolution et le format demandes');
    const job = M.JOBS.get(r.id);
    await M.avance(job, deps);
    eq(M.etatVideo(r.id, '0xv').progress, 40, 'pendant la generation, la progression est lue');
    eq(M.etatVideo(r.id, '0xautre').code, 404, 'une autre adresse ne voit pas la video');
    const r2 = await M.lanceVideo({ addr: '0xv', prompt: 'une autre' }, deps);
    eq(r2.code, 429, 'une seule video a la fois par joueur');
    etat = { status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', duration: 10 }, usage: { cost_in_usd_ticks: 0.8 * 1e10 } };
    await M.avance(job, deps);
    const e = M.etatVideo(r.id, '0xv');
    ok(e.status === 'done' && e.url === 'https://vidgen.x.ai/v.mp4', 'la video arrivee est rendue a son proprietaire');
    ok(enUsd(s.reglements[0].f) >= 0.8 * 1.5 - 1e-6 && enUsd(s.reglements[0].r) >= enUsd(s.reglements[0].f), 'facturee au cout reel × 1,5, sous la reserve');

    const s2 = faux(); const av = s2.bal;
    const d2 = { cours: async () => COURS, solde: s2.solde, sansBoucle: true,
      fournisseur: { lanceVideo: async () => 'rid-2', litVideo: async () => ({ status: 'failed', erreur: 'moderation' }) } };
    const r3 = await M.lanceVideo({ addr: '0xw', prompt: 'x' }, d2);
    await M.avance(M.JOBS.get(r3.id), d2);
    ok(M.etatVideo(r3.id, '0xw').status === 'failed' && s2.bal.eq(av), 'une video ratee : tout est rendu');
    const s3 = faux(); const av3 = s3.bal;
    const d3 = { cours: async () => COURS, solde: s3.solde, sansBoucle: true,
      fournisseur: { lanceVideo: async () => 'rid-3', litVideo: async () => ({ status: 'pending' }) } };
    const r4 = await M.lanceVideo({ addr: '0xy', prompt: 'x', maintenant: 1000 }, d3);
    await M.avance(M.JOBS.get(r4.id), d3, 1000 + 61000);
    ok(M.etatVideo(r4.id, '0xy').status === 'failed' && s3.bal.eq(av3), 'une video trop longue : tout est rendu');
    const r5 = await M.lanceVideo({ addr: '0xz' }, d3);
    eq(r5.code, 400, 'ni texte ni image : refusee avant tout debit');
  }

  console.log('\n-- 4 ter. la suite d une scene : la derniere image EN PLUS des references (27/09) --');
  {
    const JPG = 'data:image/jpeg;base64,' + Buffer.alloc(200, 7).toString('base64');
    const vus = [];
    const s = faux();
    const d = { cours: async () => COURS, solde: s.solde, sansBoucle: true, referenceOk: () => true,
      fournisseur: { lanceVideo: async (o) => { vus.push(o); return 'rid-s1'; }, litVideo: async () => ({ status: 'pending' }) } };
    const r = await M.lanceVideo({ addr: '0xs1', prompt: 'SWOGE continues', duree: 10, references: ['swoge'], voix: ['rex'], debut: JPG }, d);
    ok(r.ok && r.suite && vus[0].image === JPG && vus[0].references.length === 1 && vus[0].voix[0] === 'rex', 'la derniere image part en premiere image, AVEC les references et la voix');
    /* xAI ne dit pas si image et reference_images se combinent : s il refuse, la suite part seule, dans la meme reservation. */
    const s2 = faux(); const av = s2.bal; const vus2 = [];
    const d2 = { cours: async () => COURS, solde: s2.solde, sansBoucle: true, referenceOk: () => true,
      fournisseur: { lanceVideo: async (o) => { vus2.push(o); if (o.references) throw new Error('xAI 400: image and reference_images'); return 'rid-s2'; }, litVideo: async () => ({ status: 'pending' }) } };
    const r2 = await M.lanceVideo({ addr: '0xs2', prompt: 'SWOGE continues', duree: 10, references: ['swoge'], debut: JPG }, d2);
    ok(r2.ok && r2.suiteSeule && vus2.length === 2 && vus2[1].image === JPG && !vus2[1].references, 'refusee ensemble : relancee avec la derniere image seule');
    ok(s2.reglements.length === 0 && !s2.bal.eq(av), 'une seule reservation, rien de regle ni rendu en double pendant le relais');
    const s3 = faux(); const av3 = s3.bal;
    const d3 = { cours: async () => COURS, solde: s3.solde, sansBoucle: true, referenceOk: () => true,
      fournisseur: { lanceVideo: async () => { throw new Error('xAI down'); }, litVideo: async () => ({}) } };
    const r3 = await M.lanceVideo({ addr: '0xs3', prompt: 'x', duree: 10, references: ['swoge'], debut: JPG }, d3);
    ok(!r3.ok && r3.code === 502 && s3.bal.eq(av3), 'et si les deux echouent : rien n est debite');
    ok((await M.lanceVideo({ addr: '0xs4', prompt: 'x', image: JPG, references: ['swoge'] }, d)).code === 400, 'une image du JOUEUR avec des references reste refusee (seul le serveur pose la suite)');
  }

  console.log('\n-- 4 bis. les compteurs durables : facture contre cout REEL (26 septembre 2026) --');
  {
    const notes = [];
    const note = (e, i) => notes.push(Object.assign({ e }, i));
    const s = faux();
    const r = await M.images({ addr: '0xn1', modele: 'qualite', prompt: 'a buff doge', n: 1 }, { note, cours: async () => COURS, solde: s.solde,
      fournisseur: { images: async () => ({ urls: ['u'], usage: { cost_in_usd_ticks: Math.round(0.05 * 1e10) } }) } });
    const a = notes[0];
    ok(r.ok && a && a.e === 'image_facturee' && a.canal === 'studio' && a.qui === '0xn1' && a.usd === r.factureUsd && Math.abs(a.coutUsd - 0.05) < 1e-9 && a.sorte === 'grok/qualite',
       'une image de la page : facturee ' + (a && a.usd) + ' $ contre un cout reel de 0,05 $ lu dans usage, canal studio');
    await M.images({ addr: '0xn2', modele: 'rapide', prompt: 'x', canal: 'mcp' }, { note, cours: async () => COURS, solde: faux().solde,
      fournisseur: { images: async () => ({ urls: ['u'], usage: null }) } });
    ok(notes[1] && notes[1].coutUsd === null && notes[1].canal === 'mcp', 'sans usage : cout INCONNU (null), pas le prix de liste — la marge ne se mesure pas sur une supposition');
    const prixUsd = M.prixFixeImageUsd({ fournisseur: 'grok', modele: 'qualite', n: 1, prompt: 'x' });
    await M.images({ addr: 'x402:0xpayeur', modele: 'qualite', prompt: 'x', n: 1, prixUsd }, { note, horsSolde: true, solde: faux().solde,
      fournisseur: { images: async () => ({ urls: ['u'], usage: { cost_in_usd_ticks: Math.round(0.04 * 1e10) } }) } });
    ok(notes[2] && notes[2].canal === 'rest' && notes[2].usd === prixUsd && Math.abs(notes[2].coutUsd - 0.04) < 1e-9 && notes[2].qui === 'x402:0xpayeur', 'payee d avance (x402) : le prix encaisse contre le cout reel, au nom du payeur');
    const nAvant = notes.length;
    await M.images({ addr: '0xn3', modele: 'rapide', prompt: 'x' }, { note, cours: async () => COURS, solde: faux().solde, fournisseur: { images: async () => { throw new Error('xAI 500'); } } });
    eq(notes.length, nAvant, 'une image ratee n est pas comptee comme facturee');
    const sv = faux(); let etat = { status: 'pending' };
    const dv = { note, cours: async () => COURS, solde: sv.solde, sansBoucle: true, fournisseur: { lanceVideo: async () => 'rid-n', litVideo: async () => etat } };
    const v = await M.lanceVideo({ addr: '0xnv', prompt: 'x', duree: 6, canal: 'rest' }, dv);
    etat = { status: 'done', video: { url: 'https://vidgen.x.ai/n.mp4', duration: 6 }, usage: { cost_in_usd_ticks: 0.3 * 1e10 } };
    await M.avance(M.JOBS.get(v.id), dv);
    const vn = notes[notes.length - 1];
    ok(vn.e === 'video_facturee' && vn.canal === 'rest' && vn.qui === '0xnv' && Math.abs(vn.coutUsd - 0.3) < 1e-9 && vn.usd === M.etatVideo(v.id, '0xnv').factureUsd,
       'une video arrivee : facturee ' + vn.usd + ' $ contre 0,3 $ de cout reel, au canal de sa demande');
  }

  console.log('\n-- 4 quater. une video AU CREDIT : reserve durable, redemarrage, reglee une fois (14/10) --');
  {
    const K = require('./credits');
    const os = require('os'), path = require('path');
    const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'video-credit-'));
    let C = K.cree({ dossier: dos });
    const A = '0xc000000000000000000000000000000000000c01';
    C.ajoute(A, 5, { transaction: '0xV1' });
    let etat = { status: 'pending', progress: 10 }; const lances = [];
    const four = { lanceVideo: async (o) => { lances.push(o); return 'rid-c' + lances.length; }, litVideo: async () => etat };
    const depsC = (CC) => { const sd = CC.soldeDurable('video'); return { cours: sd.cours, solde: sd, sansBoucle: true, fournisseur: four }; };
    const micro = (usd) => Math.ceil(Math.round(usd * 1.5 * 1e12) / 1e6);    /* factureUsd, au micro-dollar superieur */
    const pire = micro(0.05 * 6 * M.RESERVE_X);
    const r = await M.lanceVideo({ addr: A, modele: 'rapide', prompt: 'doge sprints', duree: 6 }, depsC(C));
    ok(r.ok && Math.round((5 - C.soldeUsd(A)) * 1e6) === pire && C.etat().durables === 1, 'lancee au credit : le PIRE cas (liste × 3 × marge = ' + (pire / 1e6) + ' $) est reserve, durable');
    ok(C.durables()[0].info.rid === 'rid-c1' && C.durables()[0].info.id === r.id && C.durables()[0].info.addr === A, 'la reserve porte l identifiant xAI et celui de la video');
    eq(M.etatVideo(r.id, A).payeur, 'credit', 'la video dit qu elle est payee au credit');
    /* --- le redemarrage : la memoire du processus est perdue, le fichier du credit reste --- */
    M.JOBS.delete(r.id);
    C = K.cree({ dossier: dos });
    ok(Math.round((5 - C.soldeUsd(A)) * 1e6) === pire && C.MESURE.durablesGardees === 1, 'redemarrage pendant la video : la reserve n est PAS rendue');
    const b = M.reprendVideos(depsC(C), C.durables());
    ok(b.reprises === 1 && M.JOBS.has(r.id) && M.etatVideo(r.id, A).status === 'pending', 'le suivi est repris, sous le MEME identifiant (la page continue)');
    eq(M.etatVideo(r.id, '0xautre').code, 404, 'reprise, elle reste a son proprietaire seul');
    eq(M.reprendVideos(depsC(C), C.durables()).reprises, 0, 'reprise deux fois : une seule video suivie');
    etat = { status: 'done', video: { url: 'https://vidgen.x.ai/c.mp4', duration: 6 }, usage: { cost_in_usd_ticks: 0.3 * 1e10 } };
    const dR = depsC(C);
    await M.avance(M.JOBS.get(r.id), dR);
    const e = M.etatVideo(r.id, A);
    ok(e.status === 'done' && Math.round((5 - C.soldeUsd(A)) * 1e6) === micro(0.3) && C.etat().ouvertes === 0, 'arrivee : facturee au cout reel × 1,5 (0,45 $), le reste rendu, plus de reserve');
    ok(e.factureUsd === 0.45 && e.creditUsd === C.soldeUsd(A) && e.factureSwoge === undefined && e.solde === undefined, 'en dollars, jamais sous les noms $SWOGE');
    const apres = C.soldeUsd(A);
    await M.avance(M.JOBS.get(r.id), dR);
    ok(M.JOBS.get(r.id).jeton && dR.solde.regleJeton(M.JOBS.get(r.id).jeton, 0n) === null && C.soldeUsd(A) === apres, 'reglement en double impossible (suivi, ou jeton represente)');
    C = K.cree({ dossier: dos });
    ok(C.soldeUsd(A) === apres && C.MESURE.rendusAuDemarrage === 0 && C.MESURE.durablesRenduesAuDemarrage === 0, 'et un redemarrage de plus ne rend rien');

    /* Une video ratee, au credit : tout rendu. */
    const av = C.soldeUsd(A);
    etat = { status: 'pending' };
    const r2 = await M.lanceVideo({ addr: A, prompt: 'x', duree: 6 }, depsC(C));
    etat = { status: 'failed', erreur: 'moderation' };
    await M.avance(M.JOBS.get(r2.id), depsC(C));
    ok(M.etatVideo(r2.id, A).status === 'failed' && C.soldeUsd(A) === av && C.etat().ouvertes === 0 && M.etatVideo(r2.id, A).creditUsd === av, 'une video ratee au credit : tout rendu');
    /* Ratee APRES un redemarrage : rendue aussi, une fois. */
    etat = { status: 'pending' };
    M.RYTHME.clear();
    const r3 = await M.lanceVideo({ addr: A, prompt: 'x', duree: 6 }, depsC(C));
    M.JOBS.delete(r3.id); C = K.cree({ dossier: dos }); M.reprendVideos(depsC(C), C.durables());
    etat = { status: 'expired' };
    await M.avance(M.JOBS.get(r3.id), depsC(C));
    ok(C.soldeUsd(A) === av && C.etat().ouvertes === 0, 'expiree apres un redemarrage : tout rendu');
    /* Trop longue, arret compris : le temps de suivi part du DEPART de la video. */
    etat = { status: 'pending' };
    const r4 = await M.lanceVideo({ addr: A, prompt: 'x', duree: 6, maintenant: 5000 }, depsC(C));
    M.JOBS.delete(r4.id); C = K.cree({ dossier: dos }); M.reprendVideos(depsC(C), C.durables());
    eq(M.JOBS.get(r4.id).t0, 5000, 'reprise avec son heure de depart');
    await M.avance(M.JOBS.get(r4.id), depsC(C), 5000 + 61000);
    ok(M.etatVideo(r4.id, A).status === 'failed' && C.soldeUsd(A) === av && C.etat().ouvertes === 0, 'trop longue (arret compris) : tout rendu');
    /* Arret ENTRE la reserve et la reponse d'xAI : aucun identifiant xAI, rendue a la reprise. */
    const sd = C.soldeDurable('video');
    sd.reserve(A, 10n ** 18n, { genre: 'video', id: 'f'.repeat(24), addr: A });
    ok(C.soldeUsd(A) === av - 1, 'une reserve sans identifiant xAI (arret au mauvais moment)');
    C = K.cree({ dossier: dos });
    const b2 = M.reprendVideos(depsC(C), C.durables());
    ok(b2.rendues === 1 && b2.reprises === 0 && C.soldeUsd(A) === av && !M.JOBS.has('f'.repeat(24)), 'reprise : rendue entiere, rien a suivre');
    /* Credit insuffisant : 402, et AUCUN appel au fournisseur. */
    const B = '0xc000000000000000000000000000000000000c02';
    const n0 = lances.length;
    const r5 = await M.lanceVideo({ addr: B, prompt: 'x', duree: 10, modele: 'qualite' }, depsC(C));
    ok(r5.code === 402 && Number(r5.requisSwoge) > 0 && lances.length === n0 && C.etat().ouvertes === 0, 'credit insuffisant : 402, zero appel a xAI');
    /* Le fournisseur refuse le lancement : la reserve durable est rendue tout de suite. */
    const fauxLance = { cours: async () => 1, solde: C.soldeDurable('video'), sansBoucle: true, fournisseur: { lanceVideo: async () => { throw new Error('xAI 500'); }, litVideo: async () => ({}) } };
    M.RYTHME.clear();
    const r6 = await M.lanceVideo({ addr: A, prompt: 'x', duree: 6 }, fauxLance);
    ok(r6.code === 502 && C.soldeUsd(A) === av && C.etat().ouvertes === 0, 'xAI refuse le lancement : tout rendu, aucune reserve qui traine');
    /* Le $SWOGE ne change pas : la reserve passe par reserve(a, w) a deux arguments, rien de durable. */
    const sw = faux(); const vus = [];
    const r0 = sw.solde.reserve; sw.solde.reserve = function () { vus.push(arguments.length); return r0.apply(null, arguments); };
    const dS = { cours: async () => COURS, solde: sw.solde, sansBoucle: true, fournisseur: { lanceVideo: async () => 'rid-sw', litVideo: async () => ({ status: 'done', video: { url: 'https://vidgen.x.ai/s.mp4', duration: 6 }, usage: { cost_in_usd_ticks: 0.3 * 1e10 } }) } };
    const rs = await M.lanceVideo({ addr: '0xsw', prompt: 'x', duree: 6 }, dS);
    await M.avance(M.JOBS.get(rs.id), dS);
    const es = M.etatVideo(rs.id, '0xsw');
    ok(vus.length === 1 && vus[0] === 2 && M.JOBS.get(rs.id).jeton === null && es.payeur === undefined && Number(es.factureSwoge) > 0 && es.solde != null && sw.reglements.length === 1,
       'paye en $SWOGE : la meme reserve qu avant, facture et solde en $SWOGE, un reglement');
  }

  console.log('\n-- 5. de bout en bout : vrai serveur, faux xAI --');
  {
    const vus = [];
    const fauxXai = http.createServer((q, r) => {
      let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
        vus.push({ url: q.url, methode: q.method, auth: q.headers.authorization, corps: b ? JSON.parse(b) : null });
        r.writeHead(200, { 'content-type': 'application/json' });
        if (q.url === '/v1/images/generations') return r.end(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/1.png' }, { url: 'https://imgen.x.ai/2.png' }], usage: { cost_in_usd_ticks: 8e8 } }));
        if (q.url === '/v1/videos/generations') return r.end(JSON.stringify({ request_id: 'req-9' }));
        if (q.url === '/v1/videos/req-9') return r.end(JSON.stringify({ status: 'done', video: { url: 'https://vidgen.x.ai/9.mp4', duration: 6, respect_moderation: true }, usage: { cost_in_usd_ticks: 3e9 } }));
        r.end('{}');
      });
    });
    const pX = await libre(); await new Promise((r) => fauxXai.listen(pX, r));
    process.env.XAI_API_KEY = 'xai-test-local';
    /* Un faux OpenAI : generation en JSON, retouche en multipart, images en base64. */
    const vusOA = [];
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
    const fauxOA = http.createServer((q, r) => {
      const morceaux = []; q.on('data', (c) => morceaux.push(c)); q.on('end', () => {
        const brut = Buffer.concat(morceaux);
        vusOA.push({ url: q.url, type: q.headers['content-type'] || '', auth: q.headers.authorization, brut: brut.toString('latin1'),
                     corps: /json/.test(q.headers['content-type'] || '') ? JSON.parse(brut.toString('utf8')) : null });
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end(JSON.stringify({ created: 1, data: [{ b64_json: JPEG }],
          usage: { input_tokens: 50, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, output_tokens: 6000 } }));
      });
    });
    const pO = await libre(); await new Promise((r) => fauxOA.listen(pO, r));
    process.env.OPENAI_API_KEY = 'sk-openai-test-local';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + pO;
    process.env.XAI_BASE_URL = 'http://127.0.0.1:' + pX;

    const { Game } = require('./game');
    let moteur = null;
    const p0 = Game.prototype._p;
    Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
    /* Un REDEMARRAGE pendant une video payee au credit : le fichier du credit, tel que l'arret l'a
       laisse — une reserve durable (video req-9, lancee il y a 30 s) et une reserve courte. Le vrai
       demarrage doit garder la premiere, reprendre son suivi, la regler une fois ; rendre la seconde. */
    const wc = new ethers.Wallet('0x' + '5a'.repeat(32));
    const adrC = wc.address.toLowerCase();
    const VID_REPRISE = 'ab'.repeat(12);
    const pireMicro = 1350000;                                   /* 0,05 $/s × 6 s × 3 × 1,5 */
    fs.writeFileSync(require('path').join(process.env.DATA_DIR, 'credits.json'), JSON.stringify({
      soldes: { [adrC]: 5000000 - pireMicro - 100000 }, tx: {}, seq: 2,
      ouvertes: {
        r1: { addr: adrC, micro: pireMicro, durable: true, t: Date.now() - 30000,
              info: { quoi: 'video', genre: 'video', id: VID_REPRISE, addr: adrC, canal: 'studio', modele: 'rapide', duree: 6, resolution: '480p',
                      t0: Date.now() - 30000, listeUsd: 0.3, rid: 'req-9', reserveWei: String(BigInt(pireMicro) * 10n ** 12n) } },
        r2: { addr: adrC, micro: 100000 },
      } }));
    require('./server');
    await new Promise((r) => setTimeout(r, 900));
    const base = 'http://127.0.0.1:' + port;

    const cat = await (await fetch(base + '/studio/media/catalogue')).json();
    ok(cat.ouvert && cat.image.modeles.length === 2 && cat.video.modeles.length === 2, 'le catalogue est ouvert : deux modeles image, deux video');
    ok(cat.image.modeles.every((m) => m.parImageSwoge > 0) && cat.video.modeles.every((m) => m.typiqueSwoge > 0), 'chacun avec son prix en $SWOGE');
    eq((await fetch(base + '/studio/media/image', { method: 'POST', body: '{}' })).status, 401, 'sans jeton de session : 401');

    const w = ethers.Wallet.createRandom();
    const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    await new Promise((r) => s.on('open', r));
    const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
    const h = await attend('hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    const auth = await attend('auth');
    const adr = w.address.toLowerCase();
    moteur._p(adr).balance = W(200000);
    const autre = ethers.Wallet.createRandom().address.toLowerCase();
    const autreAvant = moteur.balanceStr(autre);
    const H = { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session };

    const avant = W(moteur.balanceStr(adr));
    const ri = await (await fetch(base + '/studio/media/image', { method: 'POST', headers: H,
      body: JSON.stringify({ modele: 'qualite', prompt: 'a buff doge on the moon', n: 2, format: '16:9', addr: autre }) })).json();
    ok(ri.ok && ri.urls.length === 2, 'deux images rendues');
    const gi = vus.find((v) => v.url === '/v1/images/generations');
    ok(gi && gi.corps.model === 'grok-imagine-image-2.0' && gi.corps.n === 2 && gi.corps.aspect_ratio === '16:9' && gi.corps.prompt === 'a buff doge on the moon', 'xAI recoit model, n, aspect_ratio, prompt — les champs de sa specification');
    eq(gi.auth, 'Bearer xai-test-local', 'la cle part vers xAI, depuis le serveur');
    ok(!JSON.stringify(ri).includes('xai-test-local'), 'et ne revient jamais au navigateur');
    const debit = avant.sub(W(moteur.balanceStr(adr)));
    ok(debit.eq(W(ri.factureSwoge)), 'l adresse de la SESSION est debitee exactement de la facture annoncee [' + ri.factureSwoge + ']');
    eq(moteur.balanceStr(autre), autreAvant, 'l adresse glissee dans le corps n est pas touchee');
    ok(Math.abs(Number(ri.factureUsd) - 0.08 * 1.5) < 1e-6, 'facture = cout rendu par xAI (0,08 $) × 1,5');

    const rv = await (await fetch(base + '/studio/media/video', { method: 'POST', headers: H,
      body: JSON.stringify({ modele: 'rapide', prompt: 'the doge flexes', duree: 6, resolution: '480p', format: '9:16' }) })).json();
    ok(rv.ok && rv.id, 'la video est lancee');
    const gv = vus.find((v) => v.url === '/v1/videos/generations');
    ok(gv && gv.corps.model === 'grok-imagine-video' && gv.corps.duration === 6 && gv.corps.resolution === '480p' && gv.corps.aspect_ratio === '9:16', 'xAI recoit model, duration, resolution, aspect_ratio');
    let ev = null;
    for (let i = 0; i < 40; i++) { ev = await (await fetch(base + '/studio/media/video/' + rv.id, { headers: H })).json(); if (ev.status !== 'pending') break; await new Promise((r) => setTimeout(r, 100)); }
    ok(ev.status === 'done' && ev.url === 'https://vidgen.x.ai/9.mp4', 'le serveur a suivi la video jusqu au bout, la page la lit chez nous');
    ok(Math.abs(Number(ev.factureUsd) - 0.3 * 1.5) < 1e-6, 'facturee au cout rendu par xAI (0,30 $) × 1,5 [' + ev.factureSwoge + ' $SWOGE]');
    const autreJeton = await (await fetch(base + '/studio/media/video/' + rv.id, { headers: { authorization: 'Bearer faux' } })).status;
    eq(autreJeton, 401, 'sans la bonne session : personne ne lit la video');

    /* ---- ChatGPT Image, de bout en bout ---- */
    const cat2 = await (await fetch(base + '/studio/media/catalogue')).json();
    /* « Free » (18/10) suit : allume par defaut (sans cle), STUDIO_GRATUIT=0 l eteint. */
    ok(cat2.image.fournisseurs.map((f) => f.id + ':' + f.actif).join(',') === 'grok:true,openai:true,gratuit:' + (process.env.STUDIO_GRATUIT !== '0'), 'le catalogue propose Grok Imagine ET ChatGPT Image (et Free)');
    const av2 = W(moteur.balanceStr(adr));
    const ro = await (await fetch(base + '/studio/media/image', { method: 'POST', headers: H,
      body: JSON.stringify({ fournisseur: 'openai', modele: 'qualite', prompt: 'a doge astronaut', n: 1, format: '9:16' }) })).json();
    const go = vusOA.find((v) => v.url === '/v1/images/generations');
    ok(ro.ok && go && go.corps.model === 'gpt-image-2' && go.corps.size === '1024x1536' && go.corps.quality === 'high' && go.corps.n === 1,
       'OpenAI recoit model gpt-image-2, size 1024x1536 (9:16), quality high, n — les champs de sa specification');
    eq(go.auth, 'Bearer sk-openai-test-local', 'la cle OpenAI part du serveur');
    ok(!JSON.stringify(ro).includes('sk-openai') && !JSON.stringify(ro).includes('base64'), 'la page ne recoit ni la cle, ni des megaoctets de base64');
    const img = await fetch(base + ro.urls[0]);
    ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && Buffer.from(await img.arrayBuffer()).toString('base64') === JPEG,
       'l image est rangee chez nous et servie telle quelle, en image/jpeg');
    eq((await fetch(base + '/studio/media/fichier/..%2F..%2Fstate.json')).status, 404, 'rien d autre ne sort du dossier des images');
    const cout = (50 * 5 + 6000 * 30) / 1e6;
    ok(Math.abs(Number(ro.factureUsd) - cout * 1.5) < 1e-5,   /* factureUsd est arrondie a 5 decimales */ 'facture = jetons lus dans usage × grille gpt-image-2 × 1,5 [' + ro.factureUsd + ' $]');
    ok(av2.sub(W(moteur.balanceStr(adr))).eq(W(ro.factureSwoge)), 'et la session est debitee exactement de la facture');
    const re = await (await fetch(base + '/studio/media/image', { method: 'POST', headers: H,
      body: JSON.stringify({ fournisseur: 'openai', modele: 'rapide', prompt: 'make it gold', image: 'data:image/png;base64,iVBORw0KGgo=' }) })).json();
    const eo = vusOA.find((v) => v.url === '/v1/images/edits');
    ok(re.ok && eo && /multipart\/form-data/.test(eo.type) && /name="image"; filename="photo.png"/.test(eo.brut) && /name="quality"\r\n\r\nmedium/.test(eo.brut),
       'une retouche part en multipart, la photo en fichier, qualite medium pour « Speed »');
    fauxOA.close();

    console.log('\n-- 5 bis. la video AU CREDIT, de bout en bout, a travers un redemarrage (14/10) --');
    {
      const sc = new WebSocket('ws://127.0.0.1:' + port); sc.recus = [];
      sc.on('message', (d) => { try { sc.recus.push(JSON.parse(d)); } catch (e) {} });
      await new Promise((r) => sc.on('open', r));
      const attendC = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = sc.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
      const hc = await attendC('hello');
      const mc = 'SWOGE Pusher login\nnonce: ' + hc.loginNonce;
      sc.send(JSON.stringify({ type: 'login', message: mc, signature: await wc.signMessage(mc) }));
      const HC = { 'content-type': 'application/json', authorization: 'Bearer ' + (await attendC('auth')).session };
      const credit = async () => (await (await fetch(base + '/credit', { headers: HC })).json()).balanceUsd;
      let er = null;
      for (let i = 0; i < 40; i++) { er = await (await fetch(base + '/studio/media/video/' + VID_REPRISE, { headers: HC })).json(); if (er.status !== 'pending') break; await new Promise((r) => setTimeout(r, 100)); }
      ok(er.ok && er.status === 'done' && er.url === 'https://vidgen.x.ai/9.mp4', 'apres le redemarrage, la video au credit est retrouvee sous son identifiant et suivie jusqu au bout');
      ok(er.payeur === 'credit' && er.factureUsd === 0.45 && er.factureSwoge === undefined && er.solde === undefined, 'reglee au cout reel × 1,5 (0,45 $), en dollars');
      eq(await credit(), 4.55, 'credit = 5 $ - 0,45 $ : la reserve durable reglee une fois, la courte rendue au demarrage');
      eq(er.creditUsd, 4.55, 'la video dit le credit restant');
      const nv = vus.filter((v) => v.url === '/v1/videos/generations').length;
      const rc = await (await fetch(base + '/studio/media/video', { method: 'POST', headers: HC,
        body: JSON.stringify({ modele: 'rapide', prompt: 'the doge flexes', duree: 6, resolution: '480p', payeur: 'credit', addr: adr }) })).json();
      ok(rc.ok && rc.id && rc.payeur === 'credit' && Math.abs(rc.creditUsd - (4.55 - 1.35)) < 1e-9 && rc.requisSwoge === undefined, 'payee au credit : le pire cas (1,35 $) reserve, la reponse en dollars');
      let ec = null;
      for (let i = 0; i < 40; i++) { ec = await (await fetch(base + '/studio/media/video/' + rc.id, { headers: HC })).json(); if (ec.status !== 'pending') break; await new Promise((r) => setTimeout(r, 100)); }
      ok(ec.status === 'done' && ec.factureUsd === 0.45 && (await credit()) === 4.1, 'arrivee : 0,45 $ factures, le reste rendu au credit [' + ec.factureUsd + ' $]');
      ok(vus.filter((v) => v.url === '/v1/videos/generations').length === nv + 1, 'un seul lancement chez xAI');
      /* Un credit vide : 402 en dollars, et xAI n est jamais appele. */
      const wv = ethers.Wallet.createRandom();
      const sv = new WebSocket('ws://127.0.0.1:' + port); sv.recus = [];
      sv.on('message', (d) => { try { sv.recus.push(JSON.parse(d)); } catch (e) {} });
      await new Promise((r) => sv.on('open', r));
      const attendV = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = sv.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
      const hv = await attendV('hello'); const mv = 'SWOGE Pusher login\nnonce: ' + hv.loginNonce;
      sv.send(JSON.stringify({ type: 'login', message: mv, signature: await wv.signMessage(mv) }));
      const HV = { 'content-type': 'application/json', authorization: 'Bearer ' + (await attendV('auth')).session };
      const nv2 = vus.filter((v) => v.url === '/v1/videos/generations').length;
      const r402 = await fetch(base + '/studio/media/video', { method: 'POST', headers: HV, body: JSON.stringify({ modele: 'rapide', prompt: 'x', duree: 6, payeur: 'credit' }) });
      const j402 = await r402.json();
      ok(r402.status === 402 && j402.payeur === 'credit' && j402.requisUsd === 1.35 && /dollar credit is too low/.test(j402.raison) && j402.requisSwoge === undefined && !/SWOGE/.test(j402.raison),
         'credit vide : 402, « dollar credit is too low », 1,35 $ requis — jamais en $SWOGE');
      eq(vus.filter((v) => v.url === '/v1/videos/generations').length, nv2, 'et zero appel a xAI');
      sc.close(); sv.close();
    }

    s.close(); fauxXai.close();
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
