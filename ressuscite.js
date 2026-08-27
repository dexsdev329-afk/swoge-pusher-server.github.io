'use strict';
/*
 * REMETTRE UN PERSONNAGE SUR PIED APRES UN BUG.
 *
 * ---- pourquoi cet outil existe, et pourquoi il est a part ----
 *
 * La mort est definitive PAR CONSTRUCTION dans ce jeu : `Game.meurt` detruit
 * l'equipement, vide le sac, efface les potions bues et remet le volume a
 * zero, et rien dans le serveur ne sait defaire cela. C'est voulu — une route
 * d'admin qui rend des objets serait une route d'admin qui en FABRIQUE, et
 * elle vivrait dans le serveur pour toujours.
 *
 * Quand la mort vient d'un DEFAUT et non du jeu, il faut pourtant pouvoir
 * reparer. Cet outil le fait hors du serveur, une fois, sur le fichier, avec
 * la liste ecrite a la main par celui qui repare. Il n'est appele par rien.
 *
 * ---- LE PIEGE QU'IL EXISTE POUR EVITER ----
 *
 * Mourir ne detruit pas seulement les objets du joueur : `_recycle` fait
 * REDESCENDRE le registre des exemplaires emis (`boutiqueEmis`), pour que ce
 * qui sort du monde puisse y revenir. Une relique est plafonnee a QUATRE
 * exemplaires ; a la mort, le compteur passe de quatre a trois, et un
 * cinquieme exemplaire peut alors etre trouve par quelqu'un d'autre.
 *
 * Rendre l'objet au joueur sans remonter ce compteur emettrait donc un
 * exemplaire de plus que le plafond, EN SILENCE. Le panneau continuerait
 * d'annoncer quatre pendant qu'il en existe cinq. Cet outil remonte le
 * compteur ET refuse de depasser le plafond.
 *
 * ---- LE SERVEUR DOIT ETRE ARRETE ----
 *
 * Il garde l'etat en memoire et le reecrit toutes les cinq minutes. Ecrire le
 * fichier sous lui, c'est se faire ecraser au prochain enregistrement.
 *
 *   1. arreter le serveur
 *   2. node ressuscite.js            (a blanc : ne touche a rien, dit tout)
 *   3. node ressuscite.js --ecris    (ecrit, apres une sauvegarde datee)
 *   4. redemarrer
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const boutique = require('./boutique');
const personnages = require('./personnages');

/* ====================== CE QU'ON REMET, ET A QUI ======================
 * A REMPLIR A LA MAIN, depuis ce que le joueur a montre. Rien n'est devine :
 * un outil qui devine ce qu'un joueur portait est un outil qui invente des
 * objets. */
const ADRESSE = '';          // 0x… du joueur, OBLIGATOIRE
const SKIN    = 'brett';          // le personnage mort : andy, claude, pepe, landwolf, ogswoge, brett

/* L'equipement PORTE, par emplacement. Les identifiants viennent de
   boutique.js ; on les cherche par NOM pour que la liste reste lisible. */
const PORTE = { fruit: 'Clover Fruit', arme: 'Twin Cinders', armure: 'Cast Visage', bague: 'Emberbind' };

/* Le SAC : nom -> nombre d'exemplaires. */
const SAC = { 'Glacier Longsword': 1, 'Ashen Fruit': 2, 'Obsidian Breastplate': 1, 'Twin Cinders': 1 };

/* Les FIOLES transportees (celles du coffre n'ont pas ete perdues). */
const FIOLES = { wis: 9, vit: 12, dex: 11, spd: 9, def: 15, att: 18 };

/* Les POTIONS BUES — le gain permanent du personnage. */
const BUES = { hp: 11, mp: 16, att: 16, def: 15, spd: 16, dex: 16, vit: 15, wis: 14 };

/* ============================ L'OUTIL ============================ */
const ECRIS = process.argv.includes('--ecris');
const TOUS = [].concat(boutique.ITEMS || [], boutique.ITEMS_DROP || []);
const parNom = (n) => TOUS.find((o) => o.nom === n) || null;

function main() {
  if (!ADRESSE || !SKIN) {
    console.error('Renseigne ADRESSE et SKIN en tete du fichier.'); process.exit(2);
  }
  const FICHIER = path.join(cfg.DATA_DIR, 'state.json');
  if (!fs.existsSync(FICHIER)) { console.error('state.json introuvable dans ' + cfg.DATA_DIR); process.exit(2); }
  const etat = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));

  const cle = String(ADRESSE).toLowerCase();
  const j = (etat.players || []).find((x) => String(x.addr || '').toLowerCase() === cle);
  if (!j) { console.error('joueur introuvable : ' + ADRESSE); process.exit(2); }
  j.persos = j.persos || {};
  const c = j.persos[SKIN] || (j.persos[SKIN] = { w: '0', ef: null, ea: null, ar: null, ba: null, xc: 0, sup: {} });

  /* ---- 1. LE PLAFOND D'ABORD, AVANT TOUTE ECRITURE ----
     On additionne ce qu'on veut rendre et ce qui est deja emis, et on refuse
     en bloc si un seul objet depasse. Rendre la moitie d'un equipement serait
     pire que ne rien rendre : le joueur ne saurait pas ce qui lui manque. */
  const emis = etat.boutiqueEmis || (etat.boutiqueEmis = {});
  const veut = {};
  for (const nom of Object.values(PORTE)) { const o = parNom(nom); if (o) veut[o.id] = (veut[o.id] || 0) + 1; }
  for (const [nom, q] of Object.entries(SAC)) { const o = parNom(nom); if (o) veut[o.id] = (veut[o.id] || 0) + q; }

  const manquants = [].concat(Object.values(PORTE), Object.keys(SAC)).filter((n) => !parNom(n));
  if (manquants.length) { console.error('objets inconnus : ' + manquants.join(', ')); process.exit(2); }

  let refus = 0;
  console.log('\n-- ce qui serait rendu, et ce que le monde en compte --');
  for (const [id, q] of Object.entries(veut)) {
    const o = boutique.item(Number(id));
    const r = boutique.rarete(o.rarete);
    const plafond = r ? r.plafond : Infinity;
    const avant = emis[id] || 0, apres = avant + q;
    const trop = apres > plafond;
    if (trop) refus++;
    console.log(`  ${String(o.nom).padEnd(22)} x${q}  emis ${avant} -> ${apres} / plafond ${plafond}` + (trop ? '   REFUS : depasse le plafond' : ''));
  }
  if (refus) {
    console.error(`\n${refus} objet(s) feraient depasser le plafond. Quelqu'un d'autre a probablement`);
    console.error("trouve l'exemplaire libere par la mort. Rien n'a ete ecrit.");
    process.exit(1);
  }

  /* ---- 2. L'ECRITURE ---- */
  j.objets = j.objets || {}; j.sac = j.sac || {}; j.sacFioles = j.sacFioles || {};
  for (const [id, q] of Object.entries(veut)) {
    j.objets[id] = (j.objets[id] || 0) + q;
    emis[id] = (emis[id] || 0) + q;      // on REMONTE ce que la mort avait fait descendre
  }
  const CHAMPS = { fruit: 'ef', arme: 'ea', armure: 'ar', bague: 'ba' };
  for (const [genre, nom] of Object.entries(PORTE)) c[CHAMPS[genre]] = parNom(nom).id;
  for (const [nom, q] of Object.entries(SAC)) { const o = parNom(nom); j.sac[o.id] = (j.sac[o.id] || 0) + q; }
  for (const [s, q] of Object.entries(FIOLES)) j.sacFioles[s] = (j.sacFioles[s] || 0) + q;

  /* Les potions bues sont bornees par ce que la NAISSANCE du skin permet :
     `supMaxDe` le dit, et le depasser donnerait un personnage impossible. */
  const base = personnages.BASE[SKIN];
  if (!base) { console.error('skin inconnu : ' + SKIN); process.exit(2); }
  c.sup = c.sup || {};
  console.log('\n-- les potions bues, bornees par le plafond du skin --');
  for (const [s, q] of Object.entries(BUES)) {
    const mx = personnages.supMaxDe(s, base[s]);
    const pose = Math.min(q, mx);
    if (pose !== q) console.log(`  ${s.toUpperCase().padEnd(4)} ${q} demande -> ${pose} (plafond de ${SKIN})`);
    else console.log(`  ${s.toUpperCase().padEnd(4)} ${pose}`);
    c.sup[s] = pose;
  }
  j.sacCases = null;   // la grille se recalcule depuis le contenu

  console.log(`\n-- resume --\n  joueur ${ADRESSE}\n  personnage ${SKIN}` +
              `\n  ${Object.values(veut).reduce((a, b) => a + b, 0)} objet(s) rendus, equipement repose, sac et fioles remis`);
  console.log('  NIVEAU NON TOUCHE : il vient du volume mise (`w`), pas d\'un champ a soi.');
  console.log('  Le remettre demande de decider quel volume rendre — c\'est un choix, pas une reparation.');

  if (!ECRIS) { console.log('\nA BLANC : rien n\'a ete ecrit. Relance avec --ecris pour appliquer.\n'); return; }
  const copie = `${path.join(cfg.DATA_DIR, 'state.json')}.avant-ressuscite-${Date.now()}`;
  fs.copyFileSync(path.join(cfg.DATA_DIR, 'state.json'), copie);
  fs.writeFileSync(path.join(cfg.DATA_DIR, 'state.json'), JSON.stringify(etat));
  console.log(`\nECRIT. Sauvegarde de l'ancien fichier : ${copie}`);
  console.log('Redemarre le serveur.\n');
}
main();
