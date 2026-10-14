'use strict';
/* ==================================================================
 * SMART MONEY — LA BASE (13/10/2026). sql.js 1.14.2 (SQLite en WebAssembly,
 * 0 dependance, 0 script d'installation : lu sur le registre npm le 13/10).
 * ==================================================================
 *
 * Pourquoi sql.js et pas un SQLite natif : la demande dit « base SQLite », et
 * un module natif (.node) casse un deploiement node:18-alpine (scan_public :
 * « aucune n'est un moteur de rendu / binaire natif »). sql.js tient la base EN
 * MEMOIRE ; on l'ecrit sur le volume (DATA_DIR/smart_money/base.sqlite).
 *
 * Regles :
 *  - les MONTANTS sont en TEXT (wei, unites brutes) : un INTEGER SQLite
 *    s'arrete a 2^63 - 1 ~ 9,2e18, soit 9,2 ETH ecrits en wei, et une offre
 *    de 1 milliard de jetons a 18 decimales vaut 1e27 ;
 *  - SAUVEGARDE ATOMIQUE : export() -> fichier .tmp -> rename. Une coupure au
 *    milieu laisse l'ancienne base entiere, jamais une base a moitie ecrite ;
 *  - export() de sql.js FERME et rouvre la base (doc de sql.js) : aucune
 *    requete preparee ne survit a une sauvegarde ; on prepare a chaque appel ;
 *  - MIGRATIONS par PRAGMA user_version (ecrit dans l'en-tete du fichier,
 *    garde par export()) : chaque version ajoute, ne detruit jamais.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const MIGRATIONS = [
  /* v1 — 13/10/2026 : le schema de depart */
  `CREATE TABLE IF NOT EXISTS meta (cle TEXT PRIMARY KEY, valeur TEXT);
   CREATE TABLE IF NOT EXISTS jetons (
     adresse TEXT PRIMARY KEY, symbole TEXT, nom TEXT, decimales INTEGER, offre TEXT,
     statut TEXT NOT NULL DEFAULT 'a_lire', mode TEXT, erreur TEXT,
     lancement_bloc INTEGER, lancement_t INTEGER, lancement_tx TEXT,
     piscine TEXT, version INTEGER, eth_est0 INTEGER, crochet TEXT,
     createur TEXT, role_createur TEXT, createur_verifie INTEGER, createur_bloc INTEGER, createur_tx TEXT, via TEXT, ancien TEXT,
     pic_usd REAL, pic_jour TEXT, pic_source TEXT, cap_usd REAL, cap_source TEXT,
     prix_num TEXT, prix_den TEXT, prix_bloc INTEGER,
     base_n INTEGER, base_gagnants INTEGER,
     recette TEXT, drapeaux TEXT, liquidite TEXT, profil_t INTEGER,
     vu_t INTEGER, lu_t INTEGER, source TEXT, details TEXT);
   CREATE TABLE IF NOT EXISTS acheteurs (
     jeton TEXT NOT NULL, wallet TEXT NOT NULL, rang INTEGER, bloc INTEGER, t INTEGER, minutes REAL, tot INTEGER, tx TEXT,
     entre TEXT, sorti TEXT, solde TEXT, gain TEXT, issue TEXT, cout_connu INTEGER, marques TEXT,
     PRIMARY KEY (jeton, wallet));
   CREATE INDEX IF NOT EXISTS acheteurs_wallet ON acheteurs (wallet);
   CREATE TABLE IF NOT EXISTS wallets (
     adresse TEXT PRIMARY KEY, projets INTEGER, connus INTEGER, gagnants INTEGER, gain_total TEXT, delai_moyen REAL,
     attendu REAL, ecart_type REAL, z REAL, initie INTEGER, smart INTEGER, verdict TEXT, maj_t INTEGER);
   CREATE TABLE IF NOT EXISTS createurs (
     adresse TEXT PRIMARY KEY, role TEXT, lancements INTEGER, reussites INTEGER, retraits INTEGER, lp_brulees INTEGER,
     drapeaux INTEGER, rampes INTEGER, migrations INTEGER, jetons TEXT, maj_t INTEGER);
   CREATE TABLE IF NOT EXISTS liens (a TEXT NOT NULL, b TEXT NOT NULL, type TEXT NOT NULL, detail TEXT, PRIMARY KEY (a, b, type));
   CREATE TABLE IF NOT EXISTS creations (
     pool TEXT PRIMARY KEY, jeton TEXT, version INTEGER, bloc INTEGER, t INTEGER, tx TEXT,
     createur TEXT, role TEXT, verifie INTEGER, via TEXT);
   CREATE INDEX IF NOT EXISTS creations_jeton ON creations (jeton);
   CREATE TABLE IF NOT EXISTS achats_smart (tx TEXT NOT NULL, wallet TEXT NOT NULL, jeton TEXT NOT NULL, bloc INTEGER, t INTEGER, PRIMARY KEY (tx, wallet, jeton));
   CREATE TABLE IF NOT EXISTS alertes (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, genre TEXT, cle TEXT UNIQUE, jeton TEXT, texte TEXT, envoye INTEGER);
   CREATE TABLE IF NOT EXISTS passes (id INTEGER PRIMARY KEY AUTOINCREMENT, genre TEXT, debut INTEGER, fin INTEGER, statut TEXT,
     appels INTEGER, octets INTEGER, gt INTEGER, ds INTEGER, jetons INTEGER, detail TEXT);`,
  /* v2 — 13/10/2026, revue du detecteur : la mise du 1er achat (paires
     repetees entre jetons), les frais lus (C1), le drapeau « contrat »
     (INI-14), les issues jugeables d'un wallet (C3, C6), les reussites a pic
     ou capitalisation connus et la liste des drapeaux d'un createur (P5, P9) */
  `ALTER TABLE acheteurs ADD COLUMN mise TEXT;
   ALTER TABLE acheteurs ADD COLUMN frais TEXT;
   ALTER TABLE acheteurs ADD COLUMN frais_lus INTEGER;
   ALTER TABLE acheteurs ADD COLUMN contrat INTEGER;
   ALTER TABLE wallets ADD COLUMN jugeables INTEGER;
   ALTER TABLE createurs ADD COLUMN reussites_connues INTEGER;
   ALTER TABLE createurs ADD COLUMN drapeaux_liste TEXT;`,
];

/** Une valeur JS -> une valeur SQLite : BigInt en TEXT, objets en JSON. */
function versSql(v) {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return v;
}

let SQLP = null;
function moteur() {
  if (!SQLP) SQLP = require('sql.js')();
  return SQLP;
}

/**
 * ouvre(fichier) -> base. `fichier` null = en memoire seulement (essais).
 * Une base illisible n'est jamais ecrasee : elle est mise de cote
 * (.illisible-<horodatage>) et une neuve est creee.
 */
async function ouvre(fichier, o) {
  const SQL = await moteur();
  let db = null, miseDeCote = null;
  if (fichier && fs.existsSync(fichier)) {
    try { db = new SQL.Database(fs.readFileSync(fichier)); db.exec('SELECT count(*) FROM sqlite_master'); }
    catch (e) {
      if (db) try { db.close(); } catch (x) { /* rien */ }
      db = null;
      miseDeCote = fichier + '.illisible-' + ((o && o.horloge) ? o.horloge() : Date.now());
      fs.renameSync(fichier, miseDeCote);
    }
  }
  if (!db) db = new SQL.Database();
  const versionAvant = db.exec('PRAGMA user_version')[0].values[0][0];
  for (let v = versionAvant; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  let sale = versionAvant !== MIGRATIONS.length;

  function tous(sql, params) {
    const st = db.prepare(sql);
    try {
      if (params) st.bind(params.map(versSql));
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally { st.free(); }
  }
  const un = (sql, params) => tous(sql, params)[0] || null;
  function ecris(sql, params) {
    db.run(sql, params ? params.map(versSql) : undefined);
    sale = true;
    return db.getRowsModified();
  }
  /** Plusieurs ecritures en une transaction (tout ou rien). */
  function transaction(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); sale = true; return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  /** Insere ou remplace une ligne a partir d'un objet { colonne: valeur }. */
  function pose(table, objet) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('table douteuse');
    const cols = Object.keys(objet).filter((k) => /^[a-z_0-9]+$/.test(k));
    return ecris(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => objet[k]));
  }
  /** Sauvegarde atomique ; rend vrai si un fichier a ete ecrit. */
  function sauve() {
    if (!fichier || !sale) return false;
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, fichier);
    sale = false;
    return true;
  }
  const meta = (cle, valeur) => {
    if (valeur === undefined) { const r = un('SELECT valeur FROM meta WHERE cle = ?', [cle]); return r ? JSON.parse(r.valeur) : null; }
    ecris('INSERT OR REPLACE INTO meta (cle, valeur) VALUES (?, ?)', [cle, JSON.stringify(valeur, (k, x) => (typeof x === 'bigint' ? x.toString() : x))]);
    return valeur;
  };
  return {
    tous, un, ecris, transaction, pose, sauve, meta,
    version: () => db.exec('PRAGMA user_version')[0].values[0][0],
    miseDeCote, versionAvant,
    ferme() { try { sauve(); } finally { db.close(); } },
    get sale() { return sale; },
  };
}

module.exports = { ouvre, MIGRATIONS, versSql };
