'use strict';
/*
 * La page publique d'un joueur : swoleeswoge.dog/j/<nom>
 *
 * ---- pourquoi elle est fabriquee ICI, et pas sur le site ----
 *
 * Une adresse qu'on partage ne vaut que si elle s'affiche AVANT d'etre
 * ouverte. Quand on colle un lien dans Telegram, sur X ou dans Discord, ces
 * services vont lire la page eux-memes et n'executent aucun JavaScript : ils
 * ne lisent que les balises `og:` du document renvoye. Une page statique qui
 * remplirait son contenu apres coup produirait donc un lien nu, et un lien nu
 * ne se propage pas.
 *
 * Le site est un dossier de fichiers statiques : il ne peut pas fabriquer une
 * page par joueur. C'est donc le serveur de jeu, qui a les donnees, qui rend
 * le document.
 *
 * ---- ce qu'on y met ----
 *
 * Rien qui ne soit deja public. Le canal Telegram annonce deja les grosses
 * victoires avec le nom du gagnant ; les tables, le classement et la liste
 * d'amis montrent deja le nom et le niveau. Cette page rassemble ce qui est
 * deja dehors — elle n'ouvre rien.
 *
 * Ce qu'on n'y met jamais : le solde, le total depose, le gain net. Le solde
 * de quelqu'un ne regarde personne, et afficher combien il a depose designe
 * une cible. La construction est faite par addition dans `profilPage()` :
 * ce qui n'est pas ecrit la n'existe pas ici.
 */
const cfg = require('./config');

const ech = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const nb = (v) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

const JEUX = { plinko: 'Plinko', crash: 'Crash', bj: 'Blackjack', spin: 'SWOGE Spin',
               smash: 'SWOGE Smash', mines: 'Mines', hilo: 'Hi-Lo', holdem: "Casino Hold'em",
               three: 'Three Card', p4: 'Connect 4', pusher: 'Coin Pusher',
               poker: 'Poker', mp: 'Tic-Tac-Toe', dm: 'Checkers' };

const SITE = (cfg.GAME_IMAGE_BASE || '').replace(/\/media\/?$/, '') || 'https://swoleeswoge.dog';

/* Le meme nommage que le site : un visage vaut « b3 », l'image est
   `badge-3.webp`. Deux conventions donneraient deux images differentes pour
   le meme joueur selon la page ouverte. */
function urlVisage(p) {
  if (p.photo) return `${cfg.PUBLIC_URL.replace(/\/+$/, '')}/avatar/${p.adresse}`;
  const v = String(p.visage || 'b1');
  return `${SITE}/media/badge-${v.slice(1) || '1'}.webp`;
}

function depuisTexte(t) {
  if (!t) return null;
  const j = Math.floor((Date.now() - t) / 86400000);
  if (j < 1) return 'joined today';
  if (j < 30) return `playing for ${j} day${j === 1 ? '' : 's'}`;
  const m = Math.floor(j / 30);
  if (m < 12) return `playing for ${m} month${m === 1 ? '' : 's'}`;
  const an = Math.floor(m / 12);
  return `playing for ${an} year${an === 1 ? '' : 's'}`;
}

/**
 * @param {object} p ce que rend game.profilPage()
 * @returns {string} le document complet
 */
function rend(p) {
  const url = `${cfg.PUBLIC_URL.replace(/\/+$/, '')}/j/${encodeURIComponent(p.nom)}`;
  /* L'image de l'apercu : la photo du joueur s'il en a une, sinon le cadre de
     son palier. Un apercu sans image passe presque inapercu dans un fil. */
  const image = p.photo ? `${cfg.PUBLIC_URL.replace(/\/+$/, '')}/avatar/${p.adresse}`
                        : `${SITE}/media/cadre-${p.palierNo}.webp`;
  const titre = `${p.nom} — level ${p.niveau} ${p.palier} on $SWOGE`;
  const bouts = [];
  if (p.manches) bouts.push(`${nb(p.manches)} rounds played`);
  if (p.duels.joues) bouts.push(`${p.duels.gagnes}/${p.duels.joues} duels won`);
  if (p.record) bouts.push(`biggest win ${nb(p.record.gain)} $SWOGE`);
  const desc = bouts.length ? bouts.join(' · ') : 'Just getting started on $SWOGE.';

  const pct = p.prochain && p.prochain > p.seuil
    ? Math.max(0, Math.min(100, ((p.volume - p.seuil) / (p.prochain - p.seuil)) * 100)) : 100;

  const rivaux = p.duels.rivaux.map((r) => `
      <a class="riv" href="/j/${encodeURIComponent(r.nom)}">
        <b>${ech(r.nom)}</b><i>lvl ${r.niveau}</i>
        <span class="sc"><em class="v">${r.v}</em>–<em class="d">${r.d}</em>${r.n ? '–' + r.n : ''}</span>
      </a>`).join('');

  const favoris = p.favoris.map((f) => `
      <div class="fav"><b>${ech(JEUX[f.jeu] || f.jeu)}</b><span>${nb(f.n)} rounds</span></div>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ech(titre)}</title>
<meta name="description" content="${ech(desc)}">
<link rel="canonical" href="${ech(url)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="$SWOGE">
<meta property="og:title" content="${ech(titre)}">
<meta property="og:description" content="${ech(desc)}">
<meta property="og:url" content="${ech(url)}">
<meta property="og:image" content="${ech(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ech(titre)}">
<meta name="twitter:description" content="${ech(desc)}">
<meta name="twitter:image" content="${ech(image)}">
<style>
 *{box-sizing:border-box}
 body{margin:0;padding:22px 14px 48px;background:#070C16;color:#EAF2FF;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;
      display:flex;flex-direction:column;align-items:center;}
 a{color:inherit;text-decoration:none}
 .carte{width:100%;max-width:520px}
 .tete{display:flex;align-items:center;gap:15px;margin-bottom:18px}
 /* Le disque est porte par le BLOC, pas par l'image : si le media ne charge
    pas — l'autre domaine est lent, ou coupe — il reste un rond propre au lieu
    d'une icone d'image cassee. */
 .cadre{position:relative;flex:0 0 auto;width:88px;height:88px;border-radius:50%;
        background:rgba(255,255,255,.06)}
 .cadre img.ph{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;
               background:rgba(255,255,255,.06)}
 .cadre img.cd{position:absolute;left:-24%;top:-24%;width:148%;height:148%;
               pointer-events:none}
 .nom{min-width:0}
 .nom h1{margin:0;font-size:21px;font-weight:800;overflow:hidden;text-overflow:ellipsis}
 .nom .lv{display:inline-block;margin-top:5px;padding:2px 9px;border-radius:999px;
          font-size:11px;font-weight:900;border:1px solid rgba(255,197,61,.5);color:#FFD97A;
          background:rgba(255,197,61,.09)}
 .nom .ds{display:block;margin-top:4px;font-size:11px;color:#8DA0C4}
 .barre{height:7px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden;margin:4px 0 20px}
 .barre i{display:block;height:100%;background:linear-gradient(90deg,#FFE08A,#FFC53D)}
 .chif{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:20px}
 .chif div{padding:12px 8px;border-radius:12px;text-align:center;
           background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09)}
 .chif b{display:block;font-size:19px;font-weight:800;color:#FFD97A}
 .chif span{font-size:10px;letter-spacing:.7px;text-transform:uppercase;color:#8DA0C4}
 h2{margin:22px 0 9px;font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:#8DA0C4}
 .rec{padding:13px 14px;border-radius:12px;
      background:linear-gradient(180deg,rgba(255,197,61,.13),rgba(255,197,61,.05));
      border:1px solid rgba(255,197,61,.35)}
 .rec b{font-size:19px;color:#FFD97A}
 .rec span{display:block;font-size:11.5px;color:#8DA0C4;margin-top:2px}
 .fav,.riv{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:7px;
           border-radius:11px;background:rgba(255,255,255,.045);
           border:1px solid rgba(255,255,255,.09)}
 .fav b,.riv b{flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .fav span{font-size:11px;color:#8DA0C4}
 .riv i{font-style:normal;font-size:10.5px;color:#8DA0C4}
 .riv .sc{font-size:13px;font-weight:800}
 .riv .v{font-style:normal;color:#7CE3A0}
 .riv .d{font-style:normal;color:#F2685E}
 .pied{margin-top:26px;text-align:center}
 .pied a{display:inline-block;padding:11px 20px;border-radius:11px;font-weight:800;font-size:13px;
         color:#07101F;background:linear-gradient(180deg,#FFE08A,#FFC53D)}
 .pied p{font-size:11px;color:#5C6B85;margin-top:14px}
</style></head><body>
<div class="carte">
  <div class="tete">
    <div class="cadre">
      <img class="ph" alt="" src="${ech(urlVisage(p))}" onerror="this.remove()">
      ${p.niveau > 0 ? `<img class="cd" alt="" src="${SITE}/media/cadre-${p.palierNo}.webp" onerror="this.remove()">` : ''}
    </div>
    <div class="nom">
      <h1>${ech(p.nom)}</h1>
      <span class="lv">LEVEL ${p.niveau} · ${ech(p.palier)}</span>
      ${p.depuis ? `<span class="ds">${ech(depuisTexte(p.depuis))}</span>` : ''}
    </div>
  </div>
  <div class="barre"><i style="width:${pct.toFixed(1)}%"></i></div>

  <div class="chif">
    <div><b>${nb(p.manches)}</b><span>rounds</span></div>
    <div><b>${p.duels.joues ? p.duels.gagnes + '/' + p.duels.joues : '—'}</b><span>duels won</span></div>
    <div><b>${nb(p.amis)}</b><span>friends</span></div>
  </div>

  ${p.record ? `<h2>Biggest win</h2>
  <div class="rec"><b>${nb(p.record.gain)} $SWOGE</b>
    <span>${ech(JEUX[p.record.jeu] || p.record.jeu)}${p.record.multi ? ` · ${p.record.multi}×` : ''}</span>
  </div>` : ''}

  ${favoris ? `<h2>Most played</h2>${favoris}` : ''}
  ${rivaux ? `<h2>Rivalries</h2>${rivaux}` : ''}

  <div class="pied">
    <a href="${SITE}/games.html">Play $SWOGE</a>
    <p>Public profile. Balances are never shown here.</p>
  </div>
</div>
</body></html>`;
}

/** La page « ce joueur n'existe pas », qui doit rester une vraie page. */
function absent(nom) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>No such player on $SWOGE</title>
<meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
justify-content:center;gap:14px;background:#070C16;color:#8DA0C4;text-align:center;padding:20px;
font-family:ui-monospace,Menlo,monospace}a{color:#FFD97A}</style></head><body>
<h1 style="color:#EAF2FF;font-size:19px;margin:0">Nobody plays under that name</h1>
<p style="margin:0">“${ech(nom)}” has no public profile on $SWOGE.</p>
<p style="margin:0"><a href="${SITE}/games.html">See the games →</a></p>
</body></html>`;
}

module.exports = { rend, absent };
