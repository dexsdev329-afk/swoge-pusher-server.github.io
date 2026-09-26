'use strict';
/*
 * SWOLEMIND — l'historique par portefeuille (studio_histo.js), dans un
 * dossier temporaire, a horloge tenue :
 *   1. chacun son fichier : une adresse ne lit jamais celui d'une autre ;
 *   2. la plus recente gagne ; une copie plus ancienne recoit 409 et celle du
 *      serveur ;
 *   3. « ce qui a change depuis » se lit sur l'horloge du SERVEUR ;
 *   4. une suppression atteint les autres appareils (pierre tombale), puis
 *      disparait apres 30 jours ;
 *   5. les octets d'une piece jointe ne sont jamais gardes, seule la vignette ;
 *   6. les bornes : taille, nombre, rythme — et un fichier illisible n'est
 *      JAMAIS ecrase par un vide ;
 *   7. la route prend l'adresse dans la session, jamais dans le corps.
 */
const fs = require('fs'), os = require('os'), path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

const H = require('./studio_histo');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'histo-'));
let t = 1_800_000_000_000;
const h = H.cree({ dir, maintenant: () => t });
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const conv = (maj, texte, extra) => Object.assign({ titre: texte, maj, messages: [{ role: 'user', content: texte }, { role: 'assistant', content: 'answer to ' + texte }] }, extra || {});

console.log('-- 1. chacun son historique --');
eq(h.pose(A, 'c1', conv(t, 'hello from phone')).ok, true, 'A ecrit une conversation');
eq(h.depuis(B, 0).convs.length, 0, 'B n en voit rien');
ok(fs.existsSync(path.join(dir, A + '.json')) && !fs.existsSync(path.join(dir, B + '.json')), 'un fichier par adresse');
eq(h.pose('0xNOTANADDRESS', 'c1', conv(t, 'x')).code, 401, 'sans adresse de session valide : 401');

console.log('\n-- 2. la plus recente gagne --');
t += 1000;
eq(h.pose(A, 'c1', conv(t, 'edited on laptop')).ok, true, 'une copie plus recente remplace');
const vieux = h.pose(A, 'c1', conv(t - 5000, 'stale tab'));
ok(vieux.code === 409 && vieux.conv.titre === 'edited on laptop' && !('recu' in vieux.conv), 'une copie plus ancienne : 409, et la copie du serveur en retour');
const futur = h.pose(A, 'c2', conv(t + 10 * 864e5, 'clock ahead'));
ok(futur.ok && h.depuis(A, 0).convs.find((c) => c.id === 'c2').maj <= t + 5 * 60e3, 'une horloge d appareil tres en avance est ramenee : elle ne bloque pas les autres pour des jours');

console.log('\n-- 3. ce qui a change depuis, a l horloge du serveur --');
const vu = h.depuis(A, 0);
eq(vu.maintenant, t, 'la lecture rend l heure du serveur');
t += 1000;
h.pose(A, 'c3', conv(t - 99999, 'written by a device whose clock is late'));
const apres = h.depuis(A, vu.maintenant);
ok(apres.convs.length === 1 && apres.convs[0].id === 'c3', 'une conversation ecrite par un appareil en retard est QUAND MEME vue : le tri se fait a la reception');

console.log('\n-- 4. une suppression atteint les autres appareils --');
t += 1000;
const lu = h.depuis(A, 0).maintenant;
t += 1000;
eq(h.supprime(A, 'c3', t).ok, true, 'supprimer');
const tombe = h.depuis(A, lu).convs.find((c) => c.id === 'c3');
ok(tombe && tombe.supprime === true && !tombe.messages, 'les autres appareils recoivent une pierre tombale, sans le contenu');
eq(h.pose(A, 'c3', conv(t - 500, 'old copy from another tab')).code, 409, 'une vieille copie ne ressuscite pas une conversation supprimee');
t += H.TOMBE_MS + 1000;
h.pose(A, 'c4', conv(t, 'later'));
ok(!h.depuis(A, 0).convs.some((c) => c.id === 'c3'), 'la pierre tombale disparait apres 30 jours');

console.log('\n-- 5. jamais les octets d une piece jointe --');
{
  const apercu = 'data:image/jpeg;base64,' + 'A'.repeat(200);
  h.pose(A, 'c5', conv(t, 'with files', { messages: [{ role: 'user', content: 'look', pieces: [
    { genre: 'image', nom: 'chart.jpg', apercu, data: 'SECRET_BYTES' },
    { genre: 'pdf', nom: 'w.pdf', data: 'PDF_BYTES', apercu: 'javascript:alert(1)' }] }, { role: 'system', content: 'injected' }, { role: 'assistant', content: 'ok' }] }));
  const c5 = h.depuis(A, 0).convs.find((c) => c.id === 'c5');
  const brut = fs.readFileSync(path.join(dir, A + '.json'), 'utf8');
  ok(!/SECRET_BYTES|PDF_BYTES/.test(brut), 'les octets des fichiers ne sont jamais ecrits sur le disque');
  ok(c5.messages[0].pieces[0].apercu === apercu && c5.messages[0].pieces[1].apercu === undefined, 'la vignette JPEG voyage ; une « vignette » javascript: est retiree');
  eq(c5.messages.map((m) => m.role).join(','), 'user,assistant', 'un role inconnu (system) est retire');
}

console.log('\n-- 6. les bornes --');
{
  const long = conv(t, 'huge', { messages: [{ role: 'user', content: 'x'.repeat(H.CONV_MAX_OCTETS) }] });
  eq(h.pose(A, 'big', long).code, 413, 'une conversation trop longue : 413, le reste est intact');
  eq(h.pose(A, '../../etc/passwd', conv(t, 'x')).code, 400, 'un identifiant de conversation hors forme : 400');
  const C = '0x' + 'c'.repeat(40);
  const h2 = H.cree({ dir, maintenant: () => t });
  for (let i = 0; i < H.MAX_CONVS + 5; i++) { t += 1; h2.pose(C, 'k' + i, conv(t, 'chat ' + i)); }
  const vivantes = h2.depuis(C, 0).convs.filter((c) => !c.supprime);
  ok(vivantes.length === H.MAX_CONVS && !vivantes.some((c) => c.id === 'k0'), 'au-dela de ' + H.MAX_CONVS + ' conversations, les plus anciennes partent [' + vivantes.length + ']');
  let refus = 0; const D = '0x' + 'd'.repeat(40);
  for (let i = 0; i < H.ECRITURES_PAR_MINUTE + 3; i++) if (h2.pose(D, 'r', conv(t + i, 'r')).code === 429) refus++;
  eq(refus, 3, 'au-dela de ' + H.ECRITURES_PAR_MINUTE + ' ecritures par minute : 429');

  fs.writeFileSync(path.join(dir, B + '.json'), '{"convs": {"x": tronque');
  let jete = false; try { h.pose(B, 'n', conv(t, 'new')); } catch (e) { jete = true; }
  ok(jete && /tronque/.test(fs.readFileSync(path.join(dir, B + '.json'), 'utf8')), 'un fichier illisible n est JAMAIS ecrase par un historique vide : on refuse');
}

console.log('\n-- 7. la route prend l adresse dans la session --');
{
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf("path === '/studio/histo'"), bloc = src.slice(i, src.indexOf("path === '/studio/chat' ||", i));
  ok(/sessionJoueur\.lire\(game\.sessionSecret, jeton\)/.test(bloc) && !/c\.addr|corps\.addr|q\.addr|\.adresse/.test(bloc), 'l adresse vient de la session signee, jamais du corps');
  ok(/503/.test(bloc) && /jamais ecrase/.test(bloc), 'un fichier illisible rend 503, jamais un vide');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
