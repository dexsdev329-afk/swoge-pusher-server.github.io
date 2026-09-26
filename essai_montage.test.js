'use strict';
/* ============================================================================
 * L'ESSAI DE MONTAGE (essai_montage.js) — un clip restyle par xAI, une mesure
 *
 * Ce qui compte pour le proprietaire : mesurer qualite, cout reel et attente
 * d'une retouche video AVANT de batir quoi que ce soit, sans jamais garder le
 * clip de quelqu'un plus longtemps que la lecture d'xAI. L'essai verifie :
 *   1. la longueur se lit dans l'arbre des boites MP4 (mvhd v0 et v1, une boite
 *      `free` avant `moov`, une taille 64 bits, `moov` apres `mdat`, taille 0
 *      jusqu'a la fin) ; un MP4 fragmente (`mvex`) par `mehd` SEUL, meme quand
 *      `mvhd` porte une duree non nulle (celle de `moov`, pas des fragments),
 *      null sans `mehd` ; tout le reste rend null ;
 *   2. les controles dans l'ordre, chacun avec sa raison, sans rien envoyer ni
 *      ecrire : taille 413, pas un MP4 400, trop long 400 (la longueur dans la
 *      raison), sens et prompt 400, fournisseur eteint 503 ;
 *   3. un essai a la fois (429), plafond du jour qui ne compte QUE les essais
 *      reellement envoyes, et qui repart le jour UTC suivant ;
 *   4. xAI qui refuse : 502 sans la cle, clip efface, jour non entame ;
 *   5. le clip existe tant que l'essai est en cours (servi par son nom, meme
 *      pendant l'envoi) et il est EFFACE apres fini, rate, et delai depasse ;
 *   6. le cout vient des ticks, rapporte a la seconde de clip ; une ligne
 *      'sent' des qu'xAI accepte, une ligne finale par essai fini, relues apres
 *      un redemarrage ;
 *   7. etat et vue pour la seule adresse de l'essai ; fichier() refuse tout nom
 *      qui n'est pas celui d'un essai en cours ;
 *   8. un redemarrage PENDANT un essai ne l'efface ni du plafond du jour ni de la
 *      mesure : il reprend avec son request_id, compte une seule fois, et son
 *      cout reel finit au journal.
 * Aucun appel sortant : un faux fournisseur.
 * ==========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.ESSAI_MONTAGE_PAR_JOUR;
process.env.XAI_API_KEY = 'xai-SECRETKEY123456789';
const M = require('./essai_montage');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) + ']');
const dort = (ms) => new Promise((r) => setTimeout(r, ms));
async function attends(cond, ms) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > (ms || 3000)) return false; await dort(5); } return true; }

/* ---- des MP4 synthetiques, boite par boite ---- */
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x); return b; };
const boite = (type, contenu) => Buffer.concat([u32(8 + contenu.length), Buffer.from(type, 'latin1'), contenu]);
const grandeBoite = (type, contenu) => { const e = Buffer.alloc(16); e.writeUInt32BE(1, 0); e.write(type, 4, 'latin1'); e.writeBigUInt64BE(BigInt(16 + contenu.length), 8); return Buffer.concat([e, contenu]); };
const boiteJusquAuBout = (type, contenu) => Buffer.concat([u32(0), Buffer.from(type, 'latin1'), contenu]);
const FTYP = boite('ftyp', Buffer.concat([Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41')]));
/* mvhd v0 : 100 octets de contenu ; v1 : 112 (ISO/IEC 14496-12) */
const mvhd0 = (echelle, duree) => { const c = Buffer.alloc(100); c[0] = 0; c.writeUInt32BE(111, 4); c.writeUInt32BE(222, 8); c.writeUInt32BE(echelle, 12); c.writeUInt32BE(duree, 16); c.writeUInt32BE(0x00010000, 20); return boite('mvhd', c); };
const mvhd1 = (echelle, duree) => { const c = Buffer.alloc(112); c[0] = 1; c.writeBigUInt64BE(111n, 4); c.writeBigUInt64BE(222n, 12); c.writeUInt32BE(echelle, 20); c.writeBigUInt64BE(BigInt(duree), 24); return boite('mvhd', c); };
const mehd0 = (duree) => { const c = Buffer.alloc(8); c.writeUInt32BE(duree, 4); return boite('mehd', c); };
const mehd1 = (duree) => { const c = Buffer.alloc(12); c[0] = 1; c.writeBigUInt64BE(BigInt(duree), 4); return boite('mehd', c); };
const trak = boite('trak', boite('tkhd', Buffer.alloc(84)));
const moov = (...dedans) => boite('moov', Buffer.concat(dedans));
const mdat = (octets) => boite('mdat', Buffer.alloc(octets || 64, 0x42));
/* un clip de `s` secondes, echelle 1000 : ftyp, free, mdat, moov (non « faststart ») */
const clip = (s, remplissage) => Buffer.concat([FTYP, boite('free', Buffer.alloc(8)), mdat(remplissage || 256), moov(mvhd0(1000, Math.round(s * 1000)), trak)]);

const ALICE = '0x' + 'a'.repeat(40), BOB = '0x' + 'b'.repeat(40);
const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'essai-montage-'));
const urlPublique = (nom) => 'https://srv.example' + M.VIDEO_PREFIXE + nom;
const fichiers = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.mp4')); } catch (e) { return []; } };
const lignesJournal = (j) => { try { return fs.readFileSync(j, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
/* les lignes FINALES (une par essai fini) ; les lignes 'sent' marquent l'envoi */
const finales = (j) => lignesJournal(j).filter((l) => l.statut !== 'sent');
const envoyees = (j) => lignesJournal(j).filter((l) => l.statut === 'sent');

/* Le faux xAI : garde chaque envoi, rend l'etat qu'on lui pose. Pendant l'envoi,
   il « lit » le clip par son nom, comme le vrai le ferait. */
function faux(inst) {
  const f = { allume: true, jette: null, envois: [], etats: {}, luPendantEnvoi: [],
    actif: () => f.allume,
    async editeVideo(q) {
      f.envois.push(q);
      const nom = String(q.url).split('/').pop();
      const lu = f.inst && f.inst().fichier(nom);
      f.luPendantEnvoi.push(lu ? lu.octets.length : -1);
      if (f.jette) throw f.jette;
      const id = 'req-' + f.envois.length;
      f.etats[id] = { status: 'pending', progress: 30 };
      return id;
    },
    async litVideo(id) { return f.etats[id] || { status: 'pending' }; },
  };
  f.inst = inst;
  return f;
}
function instance(nom, plus) {
  const dossier = path.join(racine, nom), journal = path.join(racine, nom + '.jsonl');
  let I = null;
  const f = faux(() => I);
  I = M.cree(Object.assign({ dossier, fournisseur: f, urlPublique, journal, pollMs: 5 }, plus || {}));
  return { I, f, dossier, journal };
}

(async () => {
  console.log('-- 1. la longueur lue dans l arbre des boites --');
  eq(M.dureeMp4(clip(5)), 5, 'mvhd v0 (echelle 1000), moov apres mdat, une boite free avant');
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(mvhd1(90000, 675000), trak), mdat()])), 7.5, 'mvhd v1 (echelle 90 000, duree 64 bits)');
  eq(M.dureeMp4(Buffer.concat([FTYP, grandeBoite('mdat', Buffer.alloc(300, 1)), boite('free', Buffer.alloc(4)), moov(boite('udta', Buffer.alloc(20)), mvhd0(600, 1800))])), 3, 'une boite a taille 64 bits (size == 1) avant moov, udta avant mvhd');
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(mvhd0(1000, 4200)), boiteJusquAuBout('mdat', Buffer.alloc(500, 3))])), 4.2, 'une derniere boite de taille 0 (jusqu a la fin du fichier)');
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(mvhd0(1000, 0), boite('mvex', Buffer.concat([mehd0(6500), boite('trex', Buffer.alloc(24))])))])), 6.5, 'MP4 fragmente : mvhd a 0, la duree lue dans mvex/mehd v0');
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(mvhd1(1000, 0xFFFFFFFFFFFFFFFFn), boite('mvex', mehd1(12000)))])), 12, 'mvhd v1 « inconnue » (tous les bits a 1) : mehd v1');
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(mvhd0(1000, 0))])), null, 'duree nulle sans mehd : null (une longueur illisible ne passe pas le plafond)');
  /* ffmpeg -movflags frag_keyframe (mesure du 26/09/2026) : un clip de 12 s porte
     mvhd = 1 s (les echantillons de moov seulement), mvex/trex, pas de mehd */
  const frag = (...mvex) => Buffer.concat([FTYP, moov(mvhd0(1000, 1000), trak, boite('mvex', Buffer.concat(mvex))), boite('moof', Buffer.alloc(16)), mdat()]);
  eq(M.dureeMp4(frag(boite('trex', Buffer.alloc(24)))), null, 'fragmente, mvhd = 1 s NON nulle, mvex sans mehd : null (pas 1 s)');
  eq(M.dureeMp4(frag(mehd0(12000), boite('trex', Buffer.alloc(24)))), 12, 'fragmente, mvhd = 1 s, mehd = 12 s : 12 (mehd prime sur mvhd)');
  eq(M.dureeMp4(frag(mehd1(6500))), 6.5, 'fragmente, mehd v1 = 6,5 s : 6,5');
  eq(M.dureeMp4(frag(boite('mehd', Buffer.alloc(4)))), null, 'fragmente, mehd trop courte pour sa duree : null');
  eq(M.dureeMp4(Buffer.concat([moov(mvhd0(1000, 5000)), FTYP])), null, 'la premiere boite n est pas ftyp : null');
  eq(M.dureeMp4(Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(100), 'latin1')), null, 'une image PNG : null');
  eq(M.dureeMp4(Buffer.alloc(0)), null, 'vide : null');
  eq(M.dureeMp4('ftyp moov mvhd'), null, 'pas un Buffer : null');
  eq(M.dureeMp4(Buffer.concat([FTYP, mdat()])), null, 'pas de moov : null');
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(trak)])), null, 'pas de mvhd : null');
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(mvhd0(0, 5000))])), null, 'echelle de temps nulle : null');
  const tronque = Buffer.concat([FTYP, moov(mvhd0(1000, 5000))]);
  eq(M.dureeMp4(tronque.slice(0, tronque.length - 30)), null, 'moov tronque (sa taille depasse le fichier) : null');
  const menteuse = grandeBoite('mdat', Buffer.alloc(8)); menteuse.writeBigUInt64BE(1n << 40n, 8);
  eq(M.dureeMp4(Buffer.concat([FTYP, menteuse, moov(mvhd0(1000, 5000))])), null, 'une taille 64 bits qui depasse le fichier : null');
  const mv2 = mvhd0(1000, 5000); mv2[8] = 2;
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(mv2)])), null, 'mvhd de version 2 (inconnue) : null');
  const court = boite('mvhd', Buffer.alloc(12));
  eq(M.dureeMp4(Buffer.concat([FTYP, moov(court)])), null, 'mvhd trop court pour ses champs : null');
  const bizarre = Buffer.concat([FTYP, u32(4), Buffer.from('free')]);
  eq(M.dureeMp4(bizarre), null, 'une taille plus petite que son en-tete : null (pas de boucle sans fin)');
  eq(M.DUREE_MAX_S, 8.7, 'le plafond de longueur : 8,7 s (docs xAI)');
  eq(M.OCTETS_MAX, 25 * 1024 * 1024, 'le plafond de taille : 25 Mo');
  eq(M.PAR_JOUR, 5, 'cinq essais par jour par defaut');
  ok(/photorealistic live action/.test(M.SENS.reel) && /same shots, framing, camera motion, timing, actions and composition/.test(M.SENS.reel) && /hair, clothes and colours/.test(M.SENS.reel), 'le sens « reel » : prise reelle, memes plans, personnages fideles a leur dessin');
  ok(/2D anime/.test(M.SENS.anime) && /same shots, framing/.test(M.SENS.anime), 'le sens « anime » : memes contraintes');

  console.log('\n-- 2. les controles, dans l ordre, sans rien envoyer ni ecrire --');
  const A = instance('a');
  const refus = async (q, code, motif, m) => {
    const r = await A.I.lance(q);
    ok(!r.ok && r.code === code && motif.test(r.raison || ''), m + ' [' + r.code + ' ' + r.raison + ']');
  };
  await refus({ octets: clip(5), sens: 'reel' }, 401, /sign in/, 'sans adresse : refuse');
  await refus({ addr: ALICE, octets: Buffer.alloc(M.OCTETS_MAX + 1), sens: 'reel' }, 413, /25 MB max/, 'plus de 25 Mo : 413');
  await refus({ addr: ALICE, octets: Buffer.from('not a video at all, just some text'), sens: 'reel' }, 400, /not an MP4/, 'pas un MP4 : 400');
  await refus({ addr: ALICE, sens: 'reel' }, 400, /not an MP4/, 'aucun clip : 400');
  await refus({ addr: ALICE, octets: clip(12), sens: 'reel' }, 400, /12\.0 s long.*8\.7 s max/, 'un clip de 12 s : 400, la longueur trouvee et le maximum dans la raison');
  await refus({ addr: ALICE, octets: clip(8.701), sens: 'reel' }, 400, /8\.701 s long.*8\.7 s max/, '8,701 s : juste au-dessus, refuse, et la raison le dit au millieme');
  await refus({ addr: ALICE, octets: frag(mehd0(12000)), sens: 'reel' }, 400, /12\.0 s long.*8\.7 s max/, 'un fragmente de 12 s dont mvhd dit 1 s : 400, 12 s dans la raison');
  await refus({ addr: ALICE, octets: frag(boite('trex', Buffer.alloc(24))), sens: 'reel' }, 400, /not an MP4.*length could not be read/, 'un fragmente sans mehd : 400, sa longueur ne se lit pas');
  await refus({ addr: ALICE, octets: clip(5), sens: 'cartoon' }, 400, /reel, anime or libre/, 'un sens inconnu : 400');
  await refus({ addr: ALICE, octets: clip(5) }, 400, /reel, anime or libre/, 'aucun sens : 400');
  await refus({ addr: ALICE, octets: clip(5), sens: 'libre', prompt: ' \n\t ' }, 400, /1 to 1000/, 'libre sans texte : 400');
  await refus({ addr: ALICE, octets: clip(5), sens: 'libre', prompt: 'x'.repeat(1001) }, 400, /1 to 1000/, 'libre de 1001 caracteres : 400');
  A.f.allume = false;
  await refus({ addr: ALICE, octets: clip(5), sens: 'reel' }, 503, /not switched on/, 'fournisseur eteint : 503');
  A.f.allume = true;
  eq(A.f.envois.length, 0, 'aucun de ces refus n est parti chez xAI');
  eq(fichiers(A.dossier).length, 0, 'et aucun n a laisse de clip');
  eq(A.I.vue(ALICE).reste, 5, 'ni entame le jour');

  console.log('\n-- 3. un essai, de l envoi a la fin --');
  const octets = clip(5, 4096);
  const r1 = await A.I.lance({ addr: ALICE, octets, sens: 'reel', prompt: 'ignored for a preset' });
  ok(r1.ok && /^[0-9a-f]{24}$/.test(r1.id) && r1.status === 'pending' && r1.dureeS === 5, 'lance : un identifiant, en cours, 5 s [' + JSON.stringify(r1) + ']');
  const e0 = A.f.envois[0];
  eq(e0.api, 'grok-imagine-video', 'le modele de la spec pour /v1/videos/edits');
  ok(e0.prompt === M.SENS.reel, 'le prompt du sens « reel », pas celui du corps');
  const nom = e0.url.split('/').pop();
  ok(/^https:\/\/srv\.example\/studio\/essai-montage\/video\/[0-9a-f]{48}\.mp4$/.test(e0.url), 'une adresse publique en .mp4, nom de 48 hexa [' + e0.url + ']');
  eq(A.f.luPendantEnvoi[0], octets.length, 'le clip est deja lisible PENDANT l envoi (xAI peut le lire avant de repondre)');
  ok(fs.readFileSync(path.join(A.dossier, nom)).equals(octets), 'en cours : le clip est sur le disque, octet pour octet');
  const lu = A.I.fichier(nom);
  ok(lu && lu.type === 'video/mp4' && lu.octets.equals(octets), 'fichier() le rend, en video/mp4');
  const S0 = lignesJournal(A.journal);
  ok(S0.length === 1 && S0[0].statut === 'sent' && S0[0].id === r1.id && S0[0].rid === 'req-1' && S0[0].addr === ALICE
     && S0[0].sens === 'reel' && S0[0].dureeS === 5 && S0[0].octets === octets.length && typeof S0[0].t === 'number',
    'accepte par xAI : une ligne « sent » au journal TOUT DE SUITE, avec le request_id [' + JSON.stringify(S0) + ']');
  const r2 = await A.I.lance({ addr: ALICE, octets: clip(3), sens: 'anime' });
  ok(!r2.ok && r2.code === 429 && /one test at a time/.test(r2.raison), 'un deuxieme essai pendant le premier : 429');
  eq(A.f.envois.length, 1, 'et il n est pas parti');
  await attends(() => A.I.etat(r1.id, ALICE).progress === 30);
  const p = A.I.etat(r1.id, ALICE);
  ok(p.ok && p.status === 'pending' && p.progress === 30 && p.coutUsd === null && p.url === null, 'etat en cours : la progression lue chez xAI');
  eq(A.I.etat(r1.id, BOB).code, 404, 'un autre portefeuille ne lit pas cet essai');
  eq(A.I.vue(BOB).essais.length, 0, 'ni ne le voit dans sa liste');
  const v0 = A.I.vue(ALICE);
  ok(v0.essais.length === 1 && v0.essais[0].id === r1.id && v0.essais[0].status === 'pending' && v0.reste === 4, 'la vue : l essai en cours en tete, un de moins pour aujourd hui');
  ok(v0.parJour === 5 && v0.dureeMaxS === 8.7 && v0.octetsMax === 25 * 1024 * 1024 && v0.sens.join(',') === 'reel,anime,libre', 'la vue : les bornes et les trois sens');
  A.f.etats['req-1'] = { status: 'done', progress: 100, video: { url: 'https://vidgen.x.ai/edit-1.mp4', duration: 5.04 }, usage: { cost_in_usd_ticks: 1234567890 } };
  ok(await attends(() => A.I.etat(r1.id, ALICE).status === 'done'), 'xAI dit fini : l essai est fini');
  const d = A.I.etat(r1.id, ALICE);
  ok(!fs.existsSync(path.join(A.dossier, nom)), 'fini : le clip est EFFACE du disque');
  eq(A.I.fichier(nom), null, 'et fichier() ne le rend plus');
  eq(d.coutUsd, 0.123456789, 'le cout reel : 1 234 567 890 ticks = 0,123456789 $');
  eq(d.usdParSeconde, 0.123456789 / 5, 'rapporte a la seconde de clip');
  eq(d.url, 'https://vidgen.x.ai/edit-1.mp4', 'l adresse du resultat');
  eq(d.dureeSortieS, 5.04, 'la duree rendue par xAI, pour verifier « la sortie garde la duree »');
  ok(typeof d.secondes === 'number' && d.secondes >= 0 && d.secondes < 5, 'le temps d attente en secondes [' + d.secondes + ']');
  const J = finales(A.journal);
  eq(J.length, 1, 'une ligne finale au journal');
  eq(envoyees(A.journal).length, 1, 'plus la ligne « sent », une seule');
  const l = J[0];
  ok(l.addr === ALICE && l.sens === 'reel' && l.prompt === M.SENS.reel.slice(0, 200) && l.dureeS === 5 && l.octets === octets.length
     && l.statut === 'done' && l.coutUsd === 0.123456789 && l.usdParSeconde === 0.123456789 / 5 && l.url === 'https://vidgen.x.ai/edit-1.mp4'
     && l.erreur === null && typeof l.t === 'number' && typeof l.secondes === 'number', 'la ligne : t, addr, sens, prompt (200), dureeS, octets, statut, coutUsd, usdParSeconde, secondes, url, erreur');
  eq(A.I.MESURE.finis, 1, 'MESURE : un essai fini');
  eq(A.I.vue(ALICE).essais[0].statut, 'done', 'la vue le montre fini, depuis le journal');

  console.log('\n-- 4. rate, puis delai depasse : le clip part aussi --');
  const r3 = await A.I.lance({ addr: ALICE, octets: clip(4), sens: 'libre', prompt: 'Make it\na watercolor\u0007 painting' });
  ok(r3.ok, 'un essai libre part');
  eq(A.f.envois[1].prompt, 'Make it a watercolor painting', 'les caracteres de controle sont retires du prompt');
  const nom3 = A.f.envois[1].url.split('/').pop();
  ok(fs.existsSync(path.join(A.dossier, nom3)), 'en cours : son clip existe');
  A.f.etats['req-2'] = { status: 'failed', erreur: 'content moderation', usage: { cost_in_usd_ticks: 0 } };
  ok(await attends(() => A.I.etat(r3.id, ALICE).status === 'failed'), 'xAI dit rate : l essai est rate');
  const f3 = A.I.etat(r3.id, ALICE);
  ok(!fs.existsSync(path.join(A.dossier, nom3)), 'rate : le clip est EFFACE');
  ok(f3.statut === 'failed' && /could not edit/.test(f3.raison) && /content moderation/.test(f3.raison) && f3.url === null, 'la raison du serveur et celle d xAI [' + f3.raison + ']');
  eq(f3.coutUsd, 0, 'un cout nul reste un chiffre (0), pas un absent');
  eq(finales(A.journal)[1].statut, 'failed', 'journalise rate');

  const T = instance('t', { maxMs: 60 });
  const r4 = await T.I.lance({ addr: ALICE, octets: clip(2), sens: 'anime' });
  const nom4 = T.f.envois[0].url.split('/').pop();
  ok(r4.ok && fs.existsSync(path.join(T.dossier, nom4)), 'un essai qui ne finit jamais : son clip existe au debut');
  ok(await attends(() => T.I.etat(r4.id, ALICE).status !== 'pending'), 'le delai passe : l essai s arrete');
  const t4 = T.I.etat(r4.id, ALICE);
  ok(t4.status === 'failed' && t4.statut === 'timeout' && /took longer than/.test(t4.raison), 'rate par delai, et dit pourquoi [' + t4.raison + ']');
  ok(!fs.existsSync(path.join(T.dossier, nom4)), 'delai depasse : le clip est EFFACE');
  ok(finales(T.journal)[0].statut === 'timeout' && finales(T.journal)[0].coutUsd === null, 'journalise « timeout », cout inconnu = null');
  eq(T.I.MESURE.delais, 1, 'MESURE : un delai');

  console.log('\n-- 5. xAI refuse : 502, sans la cle, rien de compte --');
  const R = instance('r', { parJour: 2 });
  R.f.jette = new Error('xAI 400 — invalid video url (key xai-SECRETKEY123456789 rejected)');
  const r5 = await R.I.lance({ addr: ALICE, octets: clip(5), sens: 'reel' });
  ok(!r5.ok && r5.code === 502 && /^xAI refused the edit: /.test(r5.raison), '502 avec la raison d xAI [' + r5.raison + ']');
  ok(!/SECRETKEY/.test(JSON.stringify(r5)), 'la cle n apparait jamais dans la reponse');
  eq(fichiers(R.dossier).length, 0, 'le clip envoye est efface');
  eq(R.I.fichier(R.f.envois[0].url.split('/').pop()), null, 'et n est plus servi');
  eq(R.I.vue(ALICE).reste, 2, 'le jour n est pas entame');
  eq(R.I.vue(ALICE).essais.length, 0, 'aucun essai en cours ni journalise');
  eq(lignesJournal(R.journal).length, 0, 'aucune ligne au journal, pas meme « sent » : xAI n a rien accepte');
  eq(R.I.MESURE.refusXai, 1, 'MESURE : un refus d xAI');

  console.log('\n-- 6. le plafond du jour (UTC), les seuls essais envoyes --');
  let horloge = Date.UTC(2026, 8, 26, 10, 0, 0);
  const C = instance('c', { parJour: 2, maintenant: () => horloge });
  const finit = async (I, f, r) => { f.etats['req-' + f.envois.length] = { status: 'done', video: { url: 'https://vidgen.x.ai/x.mp4', duration: 3 }, usage: { cost_in_usd_ticks: 3e9 } }; await attends(() => I.etat(r.id, ALICE).status === 'done'); };
  const c1 = await C.I.lance({ addr: ALICE, octets: clip(3), sens: 'reel' }); await finit(C.I, C.f, c1);
  C.f.jette = new Error('xAI 500');
  const c2 = await C.I.lance({ addr: ALICE, octets: clip(3), sens: 'reel' });
  eq(c2.code, 502, 'un refus d xAI au milieu');
  C.f.jette = null;
  const c3 = await C.I.lance({ addr: ALICE, octets: clip(3), sens: 'reel' });
  ok(c3.ok, 'le refus n a pas compte : le deuxieme essai du jour part');
  await finit(C.I, C.f, c3);
  const c4 = await C.I.lance({ addr: ALICE, octets: clip(3), sens: 'reel' });
  ok(!c4.ok && c4.code === 429 && /2 tests per day/.test(c4.raison), 'le troisieme : 429, le plafond du jour [' + c4.raison + ']');
  eq(C.f.envois.length, 3, 'et il n est pas parti chez xAI');
  eq(C.I.vue(ALICE).reste, 0, 'plus rien aujourd hui');
  const cb = await C.I.lance({ addr: BOB, octets: clip(3), sens: 'reel' });
  ok(cb.ok, 'le plafond est par adresse : un autre proprietaire a le sien');
  horloge = Date.UTC(2026, 8, 27, 0, 0, 1);
  eq(C.I.vue(ALICE).reste, 2, 'le jour UTC suivant : le plafond repart');

  console.log('\n-- 7. apres un redemarrage : journal relu, clips orphelins effaces --');
  fs.writeFileSync(path.join(A.dossier, 'c'.repeat(48) + '.mp4'), 'reste');
  const A2 = M.cree({ dossier: A.dossier, fournisseur: A.f, urlPublique, journal: A.journal, pollMs: 5 });
  eq(fichiers(A.dossier).length, 0, 'un clip reste d un essai interrompu est efface au demarrage');
  const v2 = A2.vue(ALICE);
  ok(v2.essais.length === 2 && v2.essais[0].id === r3.id && v2.essais[1].id === r1.id, 'les essais passes, relus du journal, le plus recent d abord');
  eq(v2.reste, 3, 'et ils comptent toujours pour aujourd hui');
  eq(A2.etat(r1.id, ALICE).coutUsd, 0.123456789, 'l etat d un essai fini se relit apres redemarrage');
  eq(A2.etat(r1.id, BOB).code, 404, 'toujours pour sa seule adresse');
  eq(A2.etat('../../etc', ALICE).code, 404, 'un identifiant mal forme : 404');

  console.log('\n-- 8. fichier() : le nom d un essai en cours, rien d autre --');
  const E = instance('e');
  const re = await E.I.lance({ addr: ALICE, octets: clip(2), sens: 'reel' });
  const nomE = E.f.envois[0].url.split('/').pop();
  fs.writeFileSync(path.join(E.dossier, 'd'.repeat(48) + '.mp4'), 'pas un essai');
  fs.writeFileSync(path.join(racine, 'secret.mp4'), 'secret');
  ok(re.ok && E.I.fichier(nomE) !== null, 'le clip en cours est servi');
  for (const x of ['../secret.mp4', '..%2Fsecret.mp4', '../' + nomE, nomE + '/../x', 'd'.repeat(48) + '.mp4', 'D'.repeat(48) + '.mp4',
                   'g'.repeat(48) + '.mp4', nomE.replace('.mp4', '.mov'), nomE.slice(1), '', null, undefined]) {
    eq(E.I.fichier(x), null, 'refuse : ' + JSON.stringify(x));
  }
  E.f.etats['req-1'] = { status: 'expired' };
  await attends(() => E.I.etat(re.id, ALICE).status !== 'pending');
  eq(E.I.fichier(nomE), null, 'expire chez xAI : le clip n est plus servi');
  ok(!fs.existsSync(path.join(E.dossier, nomE)), 'ni garde');

  console.log('\n-- 9. un redemarrage PENDANT un essai : toujours compte, repris, mesure --');
  /* Le premier processus « meurt » : son faux xAI dit en cours pour toujours et
     il ne conclut jamais (delai de 15 min) ; le second a son propre faux xAI. */
  const P = instance('p', { parJour: 2 });
  const rp = await P.I.lance({ addr: ALICE, octets: clip(5), sens: 'reel' });
  ok(rp.ok, 'un essai part, puis le serveur redemarre avant sa fin');
  eq(P.I.vue(ALICE).reste, 1, 'avant le redemarrage : un de moins');
  let P2 = null;
  const f2 = faux(() => P2);
  P2 = M.cree({ dossier: P.dossier, fournisseur: f2, urlPublique, journal: P.journal, pollMs: 5, parJour: 2 });
  eq(fichiers(P.dossier).length, 0, 'au redemarrage, le clip de l essai interrompu est efface');
  eq(P2.vue(ALICE).reste, 1, 'apres : l essai envoye compte TOUJOURS dans le jour (il a ete facture)');
  const pv = P2.vue(ALICE);
  ok(pv.essais.length === 1 && pv.essais[0].id === rp.id && pv.essais[0].status === 'pending', 'la vue le montre en cours, une seule fois');
  eq(P2.etat(rp.id, ALICE).status, 'pending', 'son etat se lit toujours');
  eq(P2.etat(rp.id, BOB).code, 404, 'pour sa seule adresse');
  const rq = await P2.lance({ addr: ALICE, octets: clip(3), sens: 'anime' });
  ok(rq && !rq.ok && rq.code === 429 && /one test at a time/.test(rq.raison), 'un nouvel essai pendant l essai repris : 429 [' + JSON.stringify(rq) + ']');
  eq(f2.envois.length, 0, 'rien de renvoye chez xAI');
  eq(P2.MESURE.repris, 1, 'MESURE : un essai repris');
  f2.etats['req-1'] = { status: 'done', video: { url: 'https://vidgen.x.ai/repris.mp4', duration: 5 }, usage: { cost_in_usd_ticks: 5e9 } };
  ok(await attends(() => P2.etat(rp.id, ALICE).status === 'done'), 'le suivi a repris par le request_id : fini');
  const pd = P2.etat(rp.id, ALICE);
  ok(pd.coutUsd === 0.5 && pd.usdParSeconde === 0.1 && pd.url === 'https://vidgen.x.ai/repris.mp4', 'son cout reel est mesure : 0,5 $, 0,1 $/s');
  const PF = finales(P.journal);
  ok(PF.length === 1 && PF[0].id === rp.id && PF[0].statut === 'done' && PF[0].coutUsd === 0.5 && PF[0].repris === true,
    'une ligne finale au journal, marquee « repris » (son attente compte l arret) [' + JSON.stringify(PF) + ']');
  eq(envoyees(P.journal).length, 1, 'et une seule ligne « sent »');
  ok(P2.vue(ALICE).reste === 1 && P2.vue(ALICE).essais.length === 1, 'fini : compte une fois, liste une fois (pas « sent » + fini)');
  let P3 = null;
  const fp3 = faux(() => P3);
  P3 = M.cree({ dossier: P.dossier, fournisseur: fp3, urlPublique, journal: P.journal, pollMs: 5, parJour: 2 });
  await dort(30);
  ok(P3.vue(ALICE).reste === 1 && P3.vue(ALICE).essais.length === 1 && P3.EN_COURS.size === 0 && P3.MESURE.repris === 0,
    'un deuxieme redemarrage : l essai fini n est ni repris ni compte deux fois');
  eq(P3.etat(rp.id, ALICE).coutUsd, 0.5, 'et son cout se relit');
  const rn = await P3.lance({ addr: ALICE, octets: clip(3), sens: 'anime' });
  ok(rn.ok, 'le deuxieme essai du jour part');
  const rx = await P3.lance({ addr: ALICE, octets: clip(3), sens: 'anime' });
  ok(!rx.ok && rx.code === 429, 'et il n y en a pas de troisieme');

  /* Un essai envoye si longtemps avant le redemarrage qu'il a depasse le delai :
     interroge une fois (son cout, s'il est fini), sinon clos en « timeout ». */
  const Q = instance('q', { maxMs: 60 * 60 * 1000 });
  const rv = await Q.I.lance({ addr: ALICE, octets: clip(2), sens: 'reel' });
  ok(rv.ok, 'un essai part');
  let Q2 = null;
  const fq = faux(() => Q2);
  Q2 = M.cree({ dossier: Q.dossier, fournisseur: fq, urlPublique, journal: Q.journal, pollMs: 5, maxMs: 60 * 60 * 1000,
                maintenant: () => Date.now() + 2 * 60 * 60 * 1000 });
  ok(await attends(() => Q2.etat(rv.id, ALICE).status !== 'pending'), 'redemarre deux heures plus tard : il est conclu');
  ok(Q2.etat(rv.id, ALICE).statut === 'timeout' && finales(Q.journal).length === 1 && finales(Q.journal)[0].repris === true,
    'toujours en cours chez xAI, trop vieux : « timeout », journalise');

  fs.rmSync(racine, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
