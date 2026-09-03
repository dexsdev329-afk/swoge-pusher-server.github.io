'use strict';
/* L'APPEL AU MODELE
 *
 * Une grille entre, une grille sortie sort. Rien d'autre. La cle est lue dans
 * l'environnement et ne quitte jamais ce fichier : elle n'apparait ni dans le
 * code, ni dans une reponse, ni dans un message d'erreur — un service qui
 * recopie sa cle dans un log l'a publiee.
 */
const fs = require('fs');
const MODELE = process.env.GEMINI_MODEL || 'gemini-3-pro-image';
const RACINE = 'https://generativelanguage.googleapis.com/v1beta/models/';

/* ---- LA CONSIGNE ----
 * Elle exige la DISPOSITION avant le style. Sans cette exigence, le modele
 * recompose volontiers une belle image unique : les cases se melangent, les
 * personnages changent de place, et le redecoupage rend une video ou tout
 * saute d'une frame a l'autre. Le style est ce qu'on lui demande de changer ;
 * la grille est ce qu'on lui interdit de toucher. */
function consigne(n, extra) {
  return [
    'This image is a strict ' + n + '×' + n + ' grid of ' + (n * n) + ' separate video frames,',
    'read left to right, then top to bottom.',
    '',
    'Convert every cell to photorealistic live-action cinematography:',
    'real human skin, real fabric, real hair, natural lighting, shallow depth of field,',
    'physically plausible materials. Remove every trace of animation, cel shading,',
    'outlines and flat colour.',
    '',
    'ABSOLUTE REQUIREMENTS, these override style:',
    '- Return the SAME ' + n + '×' + n + ' grid, same number of cells, same order.',
    '- Each cell keeps its own framing, camera angle, composition and subject position.',
    '- Do not merge, reorder, crop, pad or reframe cells. Do not add borders.',
    '- The same character must look like the same person in every cell.',
    '- Motion continuity: consecutive cells are consecutive moments, keep them coherent.',
    extra ? '' : null,
    extra ? 'Additional style direction: ' + extra : null,
  ].filter((x) => x !== null).join('\n');
}

/* ---- L'ORDRE DES PARTS COMPTE ----
 * Les references d'abord, la consigne ensuite, la grille en dernier. Le modele
 * lit ce qu'on lui donne comme un contexte qui se referme : les visages qu'il
 * doit garder doivent etre poses AVANT l'image a transformer, sinon ils se
 * lisent comme une suggestion apres coup. */
async function stylise(grilleFichier, refs, n, extra, resolution) {
  const cle = (process.env.GEMINI_API_KEY || '').trim();
  if (!cle) throw new Error('GEMINI_API_KEY absente : le service ne peut pas appeler le modele.');

  const parts = [];
  for (const r of (refs || []).slice(0, 6)) {
    parts.push({ inline_data: { mime_type: r.mime || 'image/png',
                                data: fs.readFileSync(r.chemin).toString('base64') } });
  }
  parts.push({ text: consigne(n, extra) });
  parts.push({ inline_data: { mime_type: 'image/png',
                              data: fs.readFileSync(grilleFichier).toString('base64') } });

  const corps = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: resolution } },
  };

  const r = await fetch(RACINE + MODELE + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cle },
    body: JSON.stringify(corps),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    /* Le corps de la reponse peut contenir la requete, donc la cle. On ne
       garde que le debut du message d'erreur, jamais la reponse entiere. */
    throw new Error('modele ' + r.status + ' : ' + t.replace(cle, '[cle]').slice(0, 300));
  }
  const j = await r.json();
  const cands = (j.candidates || [])[0] || {};
  const ps = ((cands.content || {}).parts) || [];
  const img = ps.find((p) => p.inline_data || p.inlineData);
  if (!img) {
    const raison = cands.finishReason || (j.promptFeedback || {}).blockReason || 'aucune image rendue';
    throw new Error('le modele n\'a pas rendu d\'image (' + raison + ')');
  }
  const d = img.inline_data || img.inlineData;
  return Buffer.from(d.data, 'base64');
}

module.exports = { stylise, consigne, MODELE };
