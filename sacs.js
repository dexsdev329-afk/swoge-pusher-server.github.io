'use strict';
/*
 * ==================== LES SACS AU SOL ====================
 *
 * Les regles d'un sac pose par terre, et RIEN d'autre : ni monstres, ni
 * comptes, ni reseau. Elles vivaient dans `realm.js`, ou elles etaient tres
 * bien — jusqu'au jour ou le Nexus a eu besoin d'un sol lui aussi.
 *
 * ---- pourquoi un module et pas une copie ----
 *
 * Il y avait deux facons de donner un sol au Nexus. La rapide : recopier les
 * quarante lignes. Ce qu'on aurait recopie, ce sont des PHRASES — « un sac
 * vit soixante secondes », « on ne ramasse qu'a cinquante-six unites », « un
 * sac vide disparait tout de suite », « on ne se reprend pas ce qu'on vient
 * de poser ». Deux exemplaires d'une phrase finissent toujours par ne plus
 * dire la meme chose, et celles-ci gardent des pieces achetees en argent
 * reel. Le jour ou la duree change d'un cote, un sac disparait plus tot que
 * l'autre et personne ne sait pourquoi.
 *
 * Le module ne tient AUCUN etat : on lui passe la liste de sacs et une
 * position. C'est ce qui lui permet de servir un monde de combat, un donjon et
 * un hall sans savoir lequel des trois l'appelle.
 *
 * ---- ce que le module ne fait pas ----
 *
 * Il ne verifie pas QUI a le droit. La distance, oui — elle est geometrique.
 * Le reste — le sac est-il a portee du bon joueur, ce joueur existe-t-il —
 * appartient a celui qui tient les joueurs, et c'est justement ce qu'un
 * client aurait interet a falsifier.
 */
const monde = require('./monde');

/**
 * Le sac le plus proche de ce point, dans le rayon de ramassage, ou null.
 *
 * Le PLUS PROCHE et pas le premier trouve : deux sacs qui se chevauchent
 * feraient sinon ouvrir celui du dessous une fois sur deux, selon l'ordre ou
 * ils sont tombes — c'est-a-dire au hasard, du point de vue du joueur.
 */
function sousLesPieds(sacs, x, y) {
  let choisi = null, d2mini = monde.SAC.rayon * monde.SAC.rayon;
  for (const s of sacs) {
    const dx = s.x - x, dy = s.y - y, d2 = dx * dx + dy * dy;
    if (d2 <= d2mini) { d2mini = d2; choisi = s; }
  }
  return choisi;
}

/** La forme sous laquelle une piece entre dans un sac. */
function contenuDe(objet) {
  /* ---- UN OEUF NE PORTE QUE SON ESPECE ----
   * Meme raison que la fiole juste en dessous : c'est la forme exacte sous
   * laquelle il tombe d'une creature, et le sol ne connait pas d'autre facon
   * de le porter. En tete parce qu'il est le plus rare : si un jour un objet
   * portait les deux champs, c'est l'oeuf qui doit gagner. */
  const oeuf = (objet && objet.oeuf) || null;
  if (oeuf) return { oeuf };
  const stat = (objet && objet.stat) || null;
  if (stat) {
    /* Une fiole ne porte QUE sa stat — c'est la forme exacte sous laquelle
       elle tombe d'un monstre, et le sol ne connait pas d'autre facon de la
       porter. Lui coller les champs d'une piece aurait fait une fiole que le
       ramassage aurait prise pour un objet. */
    return { stat };
  }
  const item = Number(objet && objet.item !== undefined ? objet.item : objet);
  if (!Number.isFinite(item)) return null;
  /* Le NOM et la CLE d'image entrent AVEC la piece, une fois. Les retrouver au
     moment d'envoyer l'etat les recalculerait pour chaque client, dix fois par
     seconde — et obligerait ce module a connaitre la boutique. */
  return { item, cle: (objet && objet.cle) || null,
           nom: (objet && objet.nom) || null,
           rarete: (objet && objet.rarete) || null,
           bonus: (objet && objet.bonus) || null,
           degats: (objet && objet.degats) || null,
           couleur: (objet && objet.couleur) || null,
           og: (objet && objet.og) || false };
}

/**
 * Poser un objet au sol, en (x, y).
 *
 * Il rejoint le sac sur lequel on se tient s'il y reste une place ; sinon un
 * sac nait la, avec sa minute entiere. C'est ce qui rend l'echange possible —
 * poser son epee commune, prendre celle qu'on vient de trouver — et c'est
 * aussi comment on donne quelque chose a quelqu'un : le sac est visible de
 * tous, et le premier arrive le prend.
 */
function depose(sacs, x, y, addr, objet, nouvelId) {
  const c = contenuDe(objet);
  if (!c) return null;
  let s = sousLesPieds(sacs, x, y);
  if (s && s.contenu.length >= monde.SAC.cases) return { refuse: true, raison: 'sac-plein' };
  if (!s) {
    /* Le BRUN n'est pas un choix esthetique : un objet depose ne doit pas
       ressembler a un butin rare, sinon on traverserait la carte pour une epee
       commune que quelqu'un a jetee. Le bleu est celui des fioles, partout. */
    /* ---- ET LE BLANC POUR UN OEUF ----
     * Meme raison, un cran plus haut : le brun dit « quelqu'un a jete ca », et
     * un oeuf jete au sol dans une couleur de rebut se serait fait ignorer par
     * tout le monde. Le blanc est celui des reliques — la seule couleur pour
     * laquelle on traverse la carte. */
    s = { id: nouvelId(), x, y, sac: c.oeuf ? 'blanc' : c.stat ? 'bleu' : 'brun',
          reste: monde.SAC.duree, contenu: [] };
    sacs.push(s);
    while (sacs.length > monde.SAC.plafond) sacs.shift();
  }
  s.contenu.push(c);
  /* ---- LE SAC REPART POUR UNE MINUTE ----
   * Un sac tombe d'un monstre a soixante secondes a vivre. Poser SA PROPRE
   * piece dedans sans remettre le compteur a zero, c'est la confier a un sac
   * qui peut n'avoir que trois secondes devant lui — le temps d'hesiter, et
   * elle a disparu. Ni dans le sac, ni par terre : detruite, sans un mot.
   * La minute compte a partir du DERNIER geste. */
  s.reste = monde.SAC.duree;
  /* ---- ON NE SE REPREND PAS CE QU'ON VIENT DE POSER ----
   * Le ramassage automatique vide un sac des qu'on marche dessus. Poser une
   * piece a ses pieds la lui redonnait donc dans le meme dixieme de seconde :
   * jeter quelque chose devenait impossible sans courir en meme temps. */
  s.pose = addr || null;
  return { id: s.id, sac: s.sac, place: s.contenu.length - 1,
           item: c.item === undefined ? null : c.item, stat: c.stat || null,
           oeuf: c.oeuf || null };
}

/**
 * Prendre UNE place d'un sac.
 *
 * `accepte` laisse l'appelant refuser SANS que la place se vide : une potion
 * prise a son plafond serait bue pour rien. Ce module ne sait pas ce qu'est un
 * plafond de potion — il se contente de poser la question.
 */
function prend(sacs, s, place, accepte) {
  if (!s) return null;
  const k = Math.max(0, Math.floor(Number(place) || 0));
  const objet = s.contenu[k];
  if (!objet) return null;
  if (typeof accepte === 'function') {
    const verdict = accepte(objet, s);
    if (verdict !== true) {
      return { refuse: true, raison: verdict || 'refuse', sac: s.sac,
               id: s.id, place: k, ...objet };
    }
  }
  s.contenu.splice(k, 1);
  /* Un sac vide disparait tout de suite : le laisser jusqu'a la fin de sa
     minute donnerait un sac qu'on rouvre pour rien, encore et encore. */
  if (!s.contenu.length) {
    const i = sacs.indexOf(s);
    if (i >= 0) sacs.splice(i, 1);
  }
  return { sac: s.sac, id: s.id, place: k, vide: !s.contenu.length, ...objet };
}

/**
 * Vieillir les sacs de `dt` secondes, et rendre ce qui est parti avec eux.
 *
 * ---- CE QUI N'A PAS ETE RAMASSE REVIENT AU POOL ----
 * Une piece a plafond d'emission est COMPTEE des qu'elle tombe : sans ca, deux
 * joueurs pourraient ramasser la derniere relique. Mais un sac qui finit sa
 * minute sans que personne n'y touche aurait alors retire cette piece du monde
 * pour toujours. On rend donc ce qui part ; c'est l'appelant qui tient le
 * registre.
 */
function vieillit(sacs, dt) {
  const perdus = [];
  for (let i = sacs.length - 1; i >= 0; i--) {
    sacs[i].reste -= dt;
    if (sacs[i].reste > 0) continue;
    for (const o of sacs[i].contenu) if (o.item) perdus.push({ item: o.item, nom: o.nom });
    sacs.splice(i, 1);
  }
  return perdus;
}

/**
 * Oublier le poseur des sacs dont il s'est ecarte.
 *
 * `ou(addr)` rend sa position, ou null s'il n'est plus la. On l'oublie ICI
 * plutot qu'a l'entree du ramassage : « qui a pose » est un fait du monde, pas
 * une question de qui regarde.
 */
function oubliePoseurs(sacs, ou) {
  for (const s of sacs) {
    if (!s.pose) continue;
    const p = ou(s.pose);
    if (!p) { s.pose = null; continue; }
    const dx = p.x - s.x, dy = p.y - s.y;
    if (dx * dx + dy * dy > monde.SAC.rayon * monde.SAC.rayon) s.pose = null;
  }
}

/**
 * La vue reseau d'un sac. Les clefs sont courtes parce que cet objet part dix
 * fois par seconde a chaque client — et elle est ECRITE UNE FOIS pour que le
 * hall et le monde de combat envoient exactement la meme chose : la page n'a
 * qu'une facon de lire un sac, quel que soit l'endroit ou elle le voit.
 */
function vue(s) {
  return {
    i: s.id, x: Math.round(s.x), y: Math.round(s.y), s: s.sac,
    c: s.contenu.map((o) => (o.oeuf ? { oe: o.oeuf }
                          : o.stat ? { st: o.stat }
                          : o.potion ? { po: o.potion }
                          : { it: o.item, cl: o.cle, nm: o.nom, ra: o.rarete,
                              bo: o.bonus || undefined, dg: o.degats || undefined,
                              co: o.couleur || undefined, og: o.og || undefined })),
    r: Number(s.reste.toFixed(1)),
  };
}

module.exports = { sousLesPieds, contenuDe, depose, prend, vieillit, oubliePoseurs, vue };
