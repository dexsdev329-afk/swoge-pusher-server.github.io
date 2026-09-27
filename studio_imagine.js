'use strict';
/* ==========================================================================
 * LE BOUTON MAGIQUE DE SWOLEMIND : IMAGINER UNE SCENE
 *
 * Demande du proprietaire, 27 septembre 2026 : « il faudrait un bouton magic
 * pour imaginer une scene par rapport au texte et a l'image ». Dans une serie
 * ou une pub, le joueur a deja pose ses personnages (nom, description, image)
 * ou son produit ; il a parfois commence a ecrire. Claude Haiku regarde les
 * images de reference, lit ce qui est pose, et propose UNE scene prete a
 * filmer — que le joueur relit et modifie avant de la filmer (la video, elle,
 * reste payee comme avant ; cette proposition ne declenche rien).
 *
 * Cout : Haiku a 1 $ / 5 $ par million de jetons (grille relue le 24/09, la
 * meme que studio_comprend.js). Une image de reference pese ~1 600 jetons ;
 * trois images et le texte, ~5 500 jetons d'entree et 200 de sortie, soit
 * ~0,0065 $ la proposition. Gratuit pour le joueur, borne a
 * IMAGINE_PAR_JOUR (40) par portefeuille et par jour UTC : au pire 0,26 $ par
 * joueur et par jour. Le cout reel de chaque appel est compte (MESURE).
 * ======================================================================== */
const MODELE = 'claude-haiku-4-5';
const PRIX = { entree: 1, sortie: 5 };
const SORTIE_MAX = 300;
const TEXTE_MAX = 1200;           /* comme le champ de scene de la page */
const IMAGES_MAX = 3;

const SYSTEME = [
  'You write ONE scene for a short AI video clip (6 to 10 seconds), in English.',
  'Use only the characters, product and setting you are given; look at the reference pictures to describe them accurately (fur, colours, build, outfit).',
  'Describe one clear action that fits in a few seconds, the camera, the setting and the light.',
  'If someone speaks, put at most two short spoken lines in double quotes, each attributed to a named character.',
  'If the player already wrote a draft, keep their idea and make it filmable; otherwise invent one that fits the series or the ad.',
  'If earlier scenes are given, write the NEXT scene: it continues the story right where the last one ended, with the same characters, setting and outfits.',
  'Always name the characters who appear (by their exact names), and include one cinematic camera move (push-in, tracking, orbit, crane or low angle).',
  'Answer with the scene text only: no title, no preamble, no quotes around the whole answer, under 450 characters.',
].join(' ');

function cree(deps) {
  deps = deps || {};
  const parJour = () => Math.max(1, Number(process.env.IMAGINE_PAR_JOUR) || 40);
  const jour = () => new Date(deps.maintenant ? deps.maintenant() : Date.now()).toISOString().slice(0, 10);
  const compteurs = new Map();       /* addr → { jour, n } */
  const MESURE = { appels: 0, echecs: 0, coutUsd: 0 };

  /** Ce qui est pose dans la production, en mots. */
  function decrit(prod) {
    const l = ['Production: ' + (prod.mode === 'pub' ? 'an ad' : 'a series') + ' titled "' + String(prod.titre || '').slice(0, 80) + '", format ' + (prod.format || '16:9') + '.'];
    if (prod.mode === 'pub') {
      const p = prod.produit || {};
      l.push('Product: ' + (p.nom || 'the product') + ' (picture 1).' + (p.slogan ? ' Slogan: "' + p.slogan + '".' : ''));
      if (p.presentateur) l.push('Presenter: ' + (p.presentateurNom || 'the presenter') + ' (picture 2).');
      if (p.appel) l.push('Call to action: ' + p.appel + '.');
    } else {
      (prod.personnages || []).forEach((c, i) => l.push('Character ' + (i + 1) + ': ' + (c.nom || 'unnamed') + (i < IMAGES_MAX ? ' (picture ' + (i + 1) + ')' : '') + (c.description ? ' — ' + c.description : '') + '.'));
      if (prod.style) l.push('Visual style: ' + prod.style + '.');
    }
    return l.join('\n');
  }

  /**
   * { addr, prod, texte, images: [dataURL|null…] } → { ok, texte, coutUsd } ou
   * { ok:false, code, raison } — jamais d'exception.
   */
  async function imagine(q) {
    if (!deps.client) return { ok: false, code: 503, raison: 'the scene helper is not switched on yet' };
    const j = jour(), c = compteurs.get(q.addr);
    const n = c && c.jour === j ? c.n : 0;
    if (n >= parJour()) return { ok: false, code: 429, raison: 'you used the ' + parJour() + ' scene ideas of the day — write this one yourself, or come back tomorrow' };
    const brouillon = String(q.texte || '').trim().slice(0, TEXTE_MAX);
    const contenu = [];
    for (const u of (q.images || []).slice(0, IMAGES_MAX)) {
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(String(u || ''));
      if (m) contenu.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
    const histoire = (q.histoire || []).map((x) => String(x || '').trim().slice(0, 400)).filter(Boolean).slice(-3);
    contenu.push({ type: 'text', text: decrit(q.prod || {})
      + (histoire.length ? '\n\nStory so far (oldest first):\n' + histoire.map((x, i) => 'Scene ' + (i + 1) + ': ' + x).join('\n') : '')
      + '\n\n' + (brouillon ? "Player's draft: " + brouillon : histoire.length ? 'Write the next scene.' : 'The player has not written anything yet.') });
    compteurs.set(q.addr, { jour: j, n: n + 1 });
    MESURE.appels++;
    try {
      const r = await deps.client.messages.create({ model: MODELE, max_tokens: SORTIE_MAX, system: SYSTEME, messages: [{ role: 'user', content: contenu }] });
      const texte = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
        .replace(/^["“]|["”]$/g, '').slice(0, TEXTE_MAX);
      const u = r.usage || {};
      const coutUsd = ((u.input_tokens || 0) * PRIX.entree + (u.output_tokens || 0) * PRIX.sortie) / 1e6;
      MESURE.coutUsd += coutUsd;
      if (!texte) { MESURE.echecs++; return { ok: false, code: 502, raison: 'no idea came back — try again' }; }
      return { ok: true, texte, coutUsd, restant: parJour() - n - 1 };
    } catch (e) {
      MESURE.echecs++;
      compteurs.set(q.addr, { jour: j, n });              /* un echec ne consomme pas la journee */
      return { ok: false, code: 502, raison: 'the scene helper did not answer — try again' };
    }
  }

  return { imagine, MESURE, decrit };
}

module.exports = { cree, MODELE, SYSTEME, IMAGES_MAX };
