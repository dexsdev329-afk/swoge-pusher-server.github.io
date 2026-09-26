'use strict';
/*
 * SWOLEMIND — une demande d'image comprise avant d'etre dessinee
 * (studio_comprend.js, branche dans studio_media.images). Le scenario du
 * proprietaire, le 26 septembre 2026, rejoue tel quel :
 *   1. « cree-moi une image de swoge sur un bateau » → part AVEC l'image
 *      officielle de SWOGE, sans appel de reecriture (pas de fil) ;
 *   2. « swoge ressemble a ca, refais l'image » + une photo → la demande est
 *      reecrite AVEC le fil (le bateau revient), la photo jointe prime sur la
 *      reference ;
 *   3. « fais-le sur un bateau » → reecrite avec le fil ;
 *   4. une demande sans SWOGE et sans fil part telle quelle, sans rien couter ;
 *   5. l'argent : la reserve compte la reecriture, la facture son cout reel,
 *      jamais au-dessus ; une reecriture ou une reference ratee ne bloque rien.
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
process.env.STUDIO_MARGE = '1.5';

const C = require('./studio_comprend');
const M = require('./studio_media');
const COURS = 0.00002801;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const REF = 'data:image/jpeg;base64,' + JPEG.toString('base64');
const PHOTO = 'data:image/png;base64,' + Buffer.from('photo-du-joueur').toString('base64');

/* Un faux Claude qui garde ce qu'il recoit et rend une consigne complete. */
function faux(texte, usage) {
  const vus = [];
  return { vus, messages: { create: async (p) => { vus.push(p); return { content: [{ type: 'text', text: texte }], usage: usage || { input_tokens: 400, output_tokens: 60 } }; } } };
}
function solde() {
  const s = { reserves: [], reglements: [] };
  s.solde = { reserve: (a, w) => { s.reserves.push(BigInt(String(w))); return true; }, regle: (a, rw, fw) => { s.reglements.push({ r: BigInt(String(rw)), f: BigInt(String(fw)) }); return '0'; } };
  return s;
}
const enUsd = (w) => Number(w) / 1e18 * COURS;

(async () => {
  console.log('-- 0. les pieces --');
  ok(C.parleDeSwoge('crée moi une image de SWOGE sur un bateaux', []) && C.parleDeSwoge('fait le sur un bateaux', ['une image de swoge']) && !C.parleDeSwoge('a cat', ['a dog']),
     'SWOGE est reconnu dans la demande, ou dans le fil auquel elle renvoie');
  ok(!C.parleDeSwoge('swogeworld logo', []), 'mais pas au milieu d un autre mot');
  const ctx = C.contexteDe(Array(10).fill('x'.repeat(900)).concat([42, '', '  ']));
  ok(ctx.length === C.CONTEXTE_MAX && ctx.every((s) => s.length === 400), 'le fil est borne : ' + C.CONTEXTE_MAX + ' demandes de 400 caracteres au plus, rien d autre qu un texte');
  C._oublie();
  eq(await C.referenceSwoge({ lit: async () => Buffer.from('<html>not an image</html>'), site: 'https://s' }), null, 'une « reference » qui n est pas un JPEG est refusee');
  let lu = null;
  eq(await C.referenceSwoge({ lit: async (u) => { lu = u; return JPEG; }, site: 'https://s/' }), REF, 'la reference officielle est lue sur le site…');
  eq(lu, 'https://s/img/site/swoge_reference.jpg', '…a son adresse');
  eq(await C.referenceSwoge({ lit: async () => { throw new Error('down'); } }), REF, 'gardee une heure : une panne du site ne l efface pas');

  const deps = (cl, extra) => Object.assign({ cours: async () => COURS, reference: async () => REF, comprend: { deps: { client: cl } } }, extra || {});
  const four = () => { const f = { demandes: [] }; f.images = async (o) => { f.demandes.push(o); return { urls: ['https://x/img.png'], usage: { cost_in_usd_ticks: 0.07 * 1e10 } }; }; return f; };

  console.log('\n-- 1. « cree-moi une image de swoge sur un bateau » --');
  {
    const cl = faux('unused'), f = four(), s = solde();
    const r = await M.images({ addr: '0x1', modele: 'qualite', prompt: 'crée moi une image de swoge sur un bateaux' }, Object.assign(deps(cl), { solde: s.solde, fournisseur: f }));
    ok(r.ok && f.demandes[0].image === REF, 'SWOGE nomme, rien de joint : l image officielle part comme reference');
    ok(/swoge sur un bateaux/.test(f.demandes[0].prompt) && /reference image: a muscular shiba inu in a red suit with a red silk scarf/.test(f.demandes[0].prompt),
       'la demande garde ses mots et dit au generateur de garder le personnage de la reference');
    ok(cl.vus.length === 0 && r.reference === 'swoge', 'pas de fil : aucun appel de reecriture, et la reponse dit quelle reference a servi');
  }

  console.log('\n-- 2. « swoge ressemble a ca, refais l image » + une photo --');
  {
    const cl = faux('SWOGE, the muscular shiba from the reference photo, standing on the deck of a boat at sea'), f = four(), s = solde();
    const r = await M.images({ addr: '0x2', modele: 'qualite', prompt: 'swoge resemble a ca refait l image', image: PHOTO, contexte: ['crée moi une image de swoge sur un bateaux'] },
      Object.assign(deps(cl), { solde: s.solde, fournisseur: f }));
    const envoye = cl.vus[0].messages[0].content;
    ok(/1\. crée moi une image de swoge sur un bateaux/.test(envoye) && /Latest request: swoge resemble a ca refait l image/.test(envoye) && /a photo the user attached/.test(envoye),
       'la reecriture recoit le fil, la derniere demande, et sait qu une photo est jointe');
    ok(cl.vus[0].model === 'claude-haiku-4-5' && cl.vus[0].max_tokens === C.SORTIE_MAX, 'avec le modele le moins cher, sortie bornee');
    ok(/on the deck of a boat/.test(f.demandes[0].prompt), 'le bateau REVIENT : l image est demandee avec ce qui avait ete dit avant');
    ok(f.demandes[0].image === PHOTO && r.reference === 'jointe', 'la photo du joueur prime sur la reference officielle');
    ok(/boat/.test(r.compris), 'la page recoit la demande telle qu elle a ete comprise, pour la montrer');
    const cout = 0.07 + (400 * 1 + 60 * 5) / 1e6;
    ok(Math.abs(r.factureUsd - cout * 1.5) < 1e-5, 'facture = (image + reecriture reelle) × 1,5 [' + r.factureUsd + ']');
    ok(s.reglements[0].f <= s.reglements[0].r, 'sous la reserve');
  }

  console.log('\n-- 3. « fais-le sur un bateau », sans photo --');
  {
    const cl = faux('SWOGE on a boat, sunny sea'), f = four(), s = solde();
    const r = await M.images({ addr: '0x3', modele: 'qualite', prompt: 'fait le sur un bateaux', contexte: ['crée moi une image de swoge', 'swoge resemble a ca'] },
      Object.assign(deps(cl), { solde: s.solde, fournisseur: f }));
    ok(r.ok && f.demandes[0].image === REF && /SWOGE on a boat/.test(f.demandes[0].prompt) && /yes — the official SWOGE character/.test(cl.vus[0].messages[0].content),
       'SWOGE vient du fil : la reference officielle part, et la reecriture le sait');
  }

  console.log('\n-- 4. une demande ordinaire --');
  {
    const cl = faux('x'), f = four(), s = solde();
    const r = await M.images({ addr: '0x4', modele: 'qualite', prompt: 'a red car in the rain' }, Object.assign(deps(cl), { solde: s.solde, fournisseur: f }));
    ok(r.ok && cl.vus.length === 0 && f.demandes[0].prompt === 'a red car in the rain' && !f.demandes[0].image && r.compris === null && r.reference === null,
       'ni SWOGE ni fil : la demande part telle quelle, sans reference, sans cout de plus');
    const s0 = solde();
    await M.images({ addr: '0x4b', modele: 'qualite', prompt: 'a red car in the rain' }, Object.assign(deps(cl), { solde: s0.solde, fournisseur: four() }));
    const s1 = solde();
    await M.images({ addr: '0x4c', modele: 'qualite', prompt: 'a red car in the rain', contexte: ['a blue car'] }, Object.assign(deps(faux('a red car in the rain')), { solde: s1.solde, fournisseur: four() }));
    ok(Math.abs(enUsd(s1.reserves[0]) - enUsd(s0.reserves[0]) - C.RESERVE_USD * 1.5) < 1e-6, 'avec un fil, la reserve compte la reecriture (' + C.RESERVE_USD.toFixed(4) + ' $ × 1,5)');
  }

  console.log('\n-- 5. ce qui rate ne bloque rien --');
  {
    const casse = { messages: { create: async () => { throw new Error('529 overloaded'); } } }, f = four(), s = solde();
    const r = await M.images({ addr: '0x5', modele: 'qualite', prompt: 'a cat on a boat', contexte: ['a cat'] }, Object.assign(deps(casse), { solde: s.solde, fournisseur: f }));
    ok(r.ok && f.demandes[0].prompt === 'a cat on a boat' && Math.abs(r.factureUsd - 0.07 * 1.5) < 1e-5, 'la reecriture en panne : la demande d origine part, rien de plus facture');
    const f2 = four();
    const r2 = await M.images({ addr: '0x6', modele: 'qualite', prompt: 'swoge flexing' }, Object.assign(deps(faux('x')), { solde: solde().solde, fournisseur: f2, reference: async () => null }));
    ok(r2.ok && !f2.demandes[0].image && r2.reference === null, 'pas de reference disponible : l image se fait quand meme, sans');
    const f3 = four();
    await M.images({ addr: '0x7', modele: 'qualite', prompt: 'swoge flexing', contexte: ['x'] }, { cours: async () => COURS, solde: solde().solde, fournisseur: f3 });
    ok(f3.demandes[0].prompt === 'swoge flexing', 'sans Claude branche (cle absente) : la demande part telle quelle');
    /* Le pire cas de la reecriture tient dans sa reserve. */
    const pire = ((250 + Math.ceil((C.CONTEXTE_MAX + 1) * 400 / 2)) * 1 + C.SORTIE_MAX * 5) / 1e6;
    ok(pire <= C.RESERVE_USD + 1e-12, 'la reserve de la reecriture couvre son pire cas (' + C.RESERVE_USD.toFixed(4) + ' $)');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
