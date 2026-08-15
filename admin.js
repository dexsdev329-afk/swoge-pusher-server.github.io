'use strict';
/*
 * Private owner dashboard (served at /admin?key=…). Shows vault pot, amount
 * owed to players, and the safe surplus, plus a one-click ownerWithdraw.
 * Access is gated by ADMIN_KEY (see server.js). Keep the URL private.
 */
const cfg = require('./config');

function page() {
  const V = cfg.VAULT_ADDRESS || '';
  const CHAIN_HEX = '0x' + Number(cfg.CHAIN_ID).toString(16);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SWOGE Vault — Admin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:'Space Mono','Courier New',monospace}
  body{background:#0B0906;color:#F7EEDA;padding:20px;max-width:760px;margin:0 auto}
  h1{font-size:20px;color:#E6A537;margin-bottom:4px}
  .muted{color:#8a7f6a;font-size:12px;margin-bottom:18px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px}
  .card{background:rgba(255,255,255,.04);border:1px solid rgba(230,165,55,.25);border-radius:14px;padding:16px}
  .card span{font-size:12px;color:#8a7f6a;display:block;margin-bottom:6px}
  .card b{font-size:26px;color:#F7EEDA}
  .card.hl{border-color:#7CFF9B;background:rgba(124,255,155,.08)}
  .card.hl b{color:#7CFF9B}
  .sub{font-size:13px;color:#c9bfa8;margin-bottom:22px;line-height:1.8}
  .sub b{color:#E6A537}
  .panel{background:rgba(255,255,255,.04);border:1px solid rgba(230,165,55,.25);border-radius:14px;padding:18px}
  .panel h2{font-size:15px;color:#E6A537;margin-bottom:12px}
  input{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(230,165,55,.4);background:rgba(21,16,10,.9);color:#F7EEDA;font-family:inherit;font-size:15px;margin-bottom:10px}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  button{font-family:inherit;font-weight:700;font-size:13px;padding:11px 16px;border:none;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,#FFB84D,#E6A537);color:#0B0906}
  button.ghost{background:rgba(21,16,10,.9);color:#F7EEDA;border:1px solid rgba(230,165,55,.4)}
  button:disabled{opacity:.5;cursor:default}
  #msg{margin-top:12px;font-size:13px;min-height:20px}
  .warn{color:#FF8A5B}.ok{color:#7CFF9B}
  a{color:#E6A537}
  .tblwrap{overflow-x:auto;border:1px solid rgba(230,165,55,.18);border-radius:12px}
  table{border-collapse:collapse;width:100%;font-size:12.5px;min-width:720px}
  th,td{padding:9px 10px;text-align:left;white-space:nowrap;border-bottom:1px solid rgba(230,165,55,.12)}
  th{color:#E6A537;font-size:11px;text-transform:uppercase;letter-spacing:.5px;cursor:pointer;user-select:none;background:rgba(230,165,55,.06)}
  th.n,td.n{text-align:right}
  tbody tr:hover{background:rgba(230,165,55,.06)}
  td.addr{font-size:11px;color:#c9bfa8}
  td.addr b{display:block;color:#F7EEDA;font-size:12.5px}
  .tg{color:#5AA9E6}
  .nodep{opacity:.55}
  .ptot{font-size:12px;color:#8a7f6a;margin-bottom:8px}
  .ptot b{color:#E6A537}
  .muted2{color:#8a7f6a;text-align:center;padding:16px}
</style></head><body>
<h1>🐕 SWOGE Vault — Admin</h1>
<div class="muted">Private. Vault <code>${V || '(not set)'}</code></div>

<div class="cards">
  <div class="card"><span>In the vault</span><b id="pot">—</b></div>
  <div class="card"><span>Owed to players</span><b id="owed">—</b></div>
  <div class="card hl" id="surCard"><span>Safe surplus (withdrawable)</span><b id="surplus">—</b>
    <em id="surAlerte"></em></div>
</div>
<div class="sub">
  <b>Owed breakdown:</b> 💵 Balances <b id="ob">—</b> · 🔒 Staked <b id="os">—</b> · 📈 Yield <b id="oy">—</b> · 🎰 Jackpot reserve <b id="oj">—</b><br>
  👥 Players <b id="pl">—</b> · updated <span id="upd">—</span> · <a href="#" id="refresh">refresh</a>
</div>

<div class="panel" id="autoCard">
  <h2>⏳ How long the vault lasts</h2>
  <div class="sub" style="margin:0 0 10px">
    The alarm above only rings once you are <b>already</b> under water &mdash; the day you
    hear it from a player who cannot withdraw. At 100&nbsp;% APR the debt does not jump,
    it <b>climbs, every second, by an amount you can compute</b>. The house edge earns
    every day in the other direction. The two curves cross on a date, and that date can
    be worked out today.
  </div>
  <div class="cards">
    <div class="card"><span>Staking costs / day</span><b id="auCout">—</b></div>
    <div class="card"><span>House earns / day</span><b id="auRev">—</b></div>
    <div class="card hl" id="auCard"><span>Runway</span><b id="auJours">—</b><em id="auNote"></em></div>
  </div>
  <div class="sub" id="auLigne" style="margin-top:10px"></div>
</div>

<div class="panel">
  <h2>💾 Off-machine backup</h2>
  <div class="sub" style="margin:0 0 10px">
    <code>state.json</code> and its <code>.bak</code> live on the <b>same volume</b>. That protects
    against a failed write, nothing else &mdash; if the volume goes, every balance goes with it.
    A daily copy is sent to your <b>private</b> Telegram channel. Take one before anything risky.
    <span id="bkEtat"></span>
  </div>
  <div class="row"><button class="ghost" id="bkGo">Back up now</button>
    <button class="ghost" id="bkDl">⬇ Download the file</button></div>
</div>

<div class="panel" style="border-color:rgba(242,104,94,.45)">
  <h2>♻️ Restore from a file</h2>
  <div class="sub" style="margin:0 0 10px">
    The day you need this, you are in the worst possible moment. So it
    <b>looks first</b>: pick a file and it tells you what is in it and what you
    would lose &mdash; nothing is replaced until you confirm.<br>
    It keeps a dated copy of today&rsquo;s state before touching anything, so a bad
    restore can be undone. Every player is disconnected and reconnects, because a
    page holding a balance from before the restore would show two different numbers.
    <b style="color:#F2685E">Tables in progress are dropped</b> &mdash; they were opened
    with balances that no longer exist.
  </div>
  <div class="row">
    <input type="file" id="rsFile" accept=".gz,.json,application/gzip,application/json">
    <button class="ghost" id="rsLook">Look at this file</button>
    <button class="ghost" id="rsGo" disabled style="border-color:rgba(242,104,94,.6);color:#F2685E">Replace everything</button>
  </div>
  <div id="rsOut" class="sub" style="margin-top:10px"></div>
</div>

<div class="panel">
  <h2>📈 Where people stop</h2>
  <div class="sub" style="margin:0 0 10px">
    Knowing what you earn does not tell you <b>where it jams</b>. These three rates do:
    traffic, wallet friction, or first deposit.
  </div>
  <!-- Ce tableau porte neuf colonnes. Sur un telephone il faisait deborder
       la PAGE ENTIERE de 369 px vers la droite — pas seulement lui-meme —
       parce qu'un tableau se dimensionne sur son contenu et pousse tout ce
       qui l'entoure. Il defile maintenant dans sa propre boite. Le
       defaut ne se voyait qu'une fois les donnees chargees : sur un panneau
       vide, il n'y avait rien a deborder. -->
  <div id="tunTable" class="sub btwrap"></div>
</div>

<div class="panel">
  <h2>📊 This month&rsquo;s books</h2>
  <div class="sub" style="margin:0 0 10px">
    A deposit is <b>not</b> a profit &mdash; you owe it back. What the house actually keeps is
    <b>stakes minus payouts</b>, less what it gives away.
    <select id="moisSel" style="margin-left:8px"></select>
  </div>
  <div class="cards" style="margin-bottom:10px">
    <div class="card"><span>Kept from play</span><b id="cRev">&mdash;</b></div>
    <div class="card"><span>Given away</span><b id="cCout">&mdash;</b></div>
    <div class="card hl" id="cResCard"><span>Month result</span><b id="cRes">&mdash;</b></div>
  </div>
  <div class="sub">
    <b>Kept:</b> 🎰 staked <b id="cMise">&mdash;</b> &middot; paid back <b id="cRendu">&mdash;</b>
    &middot; <b id="cManches">&mdash;</b> rounds &middot; edge <b id="cEdge">&mdash;</b><br>
    <b>Given:</b> 🔒 staking yield <b id="cStk">&mdash;</b> &middot; 🎁 bonuses <b id="cBon">&mdash;</b>
    &middot; 👥 referrals <b id="cPar">&mdash;</b> &middot; 🎰 jackpots <b id="cJck">&mdash;</b><br>
    <b>Balance sheet (neither gain nor loss):</b> deposits <b id="cDep">&mdash;</b>
    &middot; withdrawals <b id="cRet">&mdash;</b> &middot; 🔥 burned <b id="cBru">&mdash;</b>
  </div>
</div>

<div class="panel">
  <h2>🔎 Check a player&rsquo;s deposits</h2>
  <div class="sub" style="margin:0 0 10px">
    &laquo; I deposited and it never arrived &raquo; has two answers: the credit was lost,
    or it was played. This compares the journal with the balances and tells you which.
  </div>
  <input id="audAddr" placeholder="0x… player address">
  <div class="row">
    <button class="ghost" id="audGo">Check</button>
    <button id="audFix" disabled>Restore the missing amount</button>
  </div>
  <pre id="audOut" style="display:none;margin:10px 0 0;padding:11px;border-radius:9px;
    background:rgba(0,0,0,.35);border:1px solid var(--line);font-size:11.5px;
    line-height:1.6;white-space:pre-wrap;word-break:break-word;"></pre>
</div>

<div class="panel">
  <h2>🔥 Burn the withdrawal fee</h2>
  <div class="sub" style="margin:0 0 10px">
    1% of every withdrawal stays in the vault to be burned. It is not yours to keep &mdash;
    the players are told it leaves circulation, so it has to.<br>
    Waiting to burn: <b id="burnDu">—</b> &middot; already burned: <b id="burnFait">—</b><br>
    Burn address <code id="burnAddr">—</code>
  </div>
  <div class="row">
    <button id="burnGo" disabled>Burn it all 🔥</button>
  </div>
  <div class="sub" id="burnList" style="margin-top:10px"></div>
</div>

<div class="panel">
  <h2>🏧 Owner withdraw</h2>
  <input id="amt" type="number" inputmode="decimal" placeholder="amount in $SWOGE">
  <div class="row">
    <button class="ghost" id="max">Fill safe surplus</button>
    <button class="ghost" id="conn">Connect owner wallet</button>
    <button id="go" disabled>Withdraw →</button>
  </div>
  <div id="msg"></div>
</div>

<div class="panel" style="margin-top:14px">
  <h2>&#127942; Sports bets</h2>
  <div class="sub" style="margin:0 0 10px">
    Chaque pari porte un <b>identifiant</b>, affiche au joueur et repris ici.
    Quand quelqu'un ecrit &laquo;&nbsp;mon pari <code>b41-mfx2</code> n'a pas ete
    paye&nbsp;&raquo;, on le retrouve en une recherche &mdash; l'identifiant, le
    match, l'adresse ou le nom.<br>
    <b>&laquo;&nbsp;A regler&nbsp;&raquo;</b> = le coup d'envoi est passe et le
    match n'a pas encore de resultat. C'est la seule colonne qui demande une
    action.
  </div>
  <div class="row" style="margin-bottom:10px">
    <input id="bq" placeholder="Bet id, match id, wallet or name" style="flex:1;min-width:220px;margin-bottom:0">
    <select id="betat" style="margin-bottom:0">
      <option value="tous">All</option>
      <option value="ouvert">Open</option>
      <option value="regle">Settled</option>
    </select>
    <button class="ghost" id="bclear">Clear</button>
    <button class="ghost" id="bcsv">Export CSV</button>
  </div>
  <div class="ptot" id="btot">&mdash;</div>
  <style>
    #btbl{ width:100%; border-collapse:collapse; font-size:12px; }
    #btbl th,#btbl td{ padding:7px 8px; text-align:left; border-bottom:1px solid var(--line);
      vertical-align:top; }
    #btbl th{ color:#8DA0C4; font-weight:700; font-size:11px; text-transform:uppercase;
      letter-spacing:.6px; }
    #btbl td.n{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    /* L'identifiant se COPIE : c'est ce qu'on recolle dans un message au
       joueur, ou dans la commande de reglement. */
    #btbl code.bid{ cursor:pointer; font-size:11.5px; color:#FFD97A; }
    #btbl code.bid:hover{ text-decoration:underline; }
    .bj{ display:block; color:#B9C8E4; font-size:11.5px; line-height:1.5;
      padding-left:8px; border-left:2px solid rgba(255,197,61,.35); margin-top:3px;
      overflow-wrap:anywhere; }
    .bj .bid2{ display:block; }
    .bet{ display:inline-block; padding:1px 7px; border-radius:999px; font-size:10.5px;
      font-weight:700; text-transform:uppercase; letter-spacing:.4px;
      border:1px solid rgba(255,255,255,.14); }
    .bet.att{ color:#E7C97A; border-color:rgba(231,201,122,.4); }
    .bet.act{ color:#FF9A3D; border-color:rgba(255,154,61,.5); background:rgba(255,154,61,.12); }
    .bet.g{ color:#7CFF9B; border-color:rgba(124,255,155,.4); }
    .bet.p{ color:#F2685E; border-color:rgba(242,104,94,.4); }
    /* Sur telephone un tableau de sept colonnes ne rentre pas : il defile
       DANS sa boite plutot que de faire deborder la page entiere.
       « overflow-x:auto » NE SUFFIT PAS. Un tableau se dimensionne sur son
       contenu : « width:100% » n'est qu'un minimum pour lui, il s'elargit
       quand meme, et la boite se laisse pousser faute de contrainte. Il faut
       les trois : une largeur maximale sur la boite, « min-width:0 » pour
       qu'elle accepte d'etre plus etroite que son contenu, et une largeur
       MINIMALE sur le tableau pour qu'il assume de deborder — c'est ce
       debordement-la qui declenche le defilement. Sans ca la page entiere
       partait de 369 px a droite sur un ecran de 390. */
    .btwrap{ max-width:100%; min-width:0; overflow-x:auto; -webkit-overflow-scrolling:touch; }
    #btbl{ min-width:720px; }
    /* Le tunnel porte neuf colonnes : meme traitement. */
    #tunTable table{ min-width:640px; }
    .surtel{ display:none; }
    /* « .muted2 » porte padding:16px et text-align:center — c'est le style de
       la cellule « loading… », pas celui d'un fragment en ligne. L'utiliser
       au milieu d'une phrase decalait chaque identifiant de match de seize
       pixels et poussait la ligne hors de la carte. D'ou ces deux classes,
       faites pour vivre DANS une phrase. */
    .bmut{ color:#8a7f6a; font-size:11px; }
    .bid2{ color:#8a7f6a; font-size:10.5px; word-break:break-all; }
    .bres{ color:#E7C97A; }
    /* ---- sur telephone, des CARTES, pas un tableau ----
       Sept colonnes sur 390 px, c'est deux colonnes visibles et cinq a
       aller chercher en glissant de cote. Or ce panneau se consulte
       justement depuis un telephone, quand un joueur signale un probleme.
       Les memes lignes se replient donc en cartes : l'identifiant et
       l'etat en tete — les deux choses qu'on vient chercher — puis le
       reste avec son libelle. Le tableau des joueurs, juste en dessous,
       fait deja ca. */
    @media (max-width:720px){
      /* « #bwrap » et non « .btwrap » : la meme classe habille la boite du
         tunnel, qui elle doit RESTER defilante — ses neuf colonnes ne se
         replient pas en cartes. Deplier les deux faisait deborder la page
         de 289 px vers la droite. */
      #bwrap{ overflow-x:visible; }
      #btbl{ min-width:0; }
      #btbl thead{ display:none; }
      #btbl, #btbl tbody, #btbl tr, #btbl td{ display:block; width:auto; }
      #btbl tr{ padding:10px 11px; margin-bottom:9px; border-radius:12px;
        background:rgba(255,255,255,.04); border:1px solid var(--line); }
      #btbl td{ border:0; padding:3px 0; }
      /* Le libelle vient de l'attribut : pas de balise en plus a poser dans
         chaque cellule, et le tableau reste un tableau sur grand ecran. */
      #btbl td[data-l]:before{ content:attr(data-l) " "; color:#8DA0C4;
        font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; }
      #btbl td.n{ display:inline-block; text-align:left; margin-right:14px; }
      #btbl td.tete{ display:flex; align-items:center; justify-content:space-between;
        gap:10px; padding-bottom:6px; }
      #btbl td.vide{ display:none; }
      .surtel{ display:inline; }
    }
    /* Et la table des joueurs, juste en dessous, doit pouvoir se retrecir :
       une colonne flex refuse par defaut de passer sous sa largeur de
       contenu, et c'est elle qui repoussait la page. */
    .panel{ min-width:0; }
  </style>
  <div class="btwrap" id="bwrap">
    <table id="btbl">
      <thead><tr><th>Bet id</th><th>Player</th><th>Selections</th>
        <th class="n">Stake</th><th class="n">Odds</th><th class="n">Returns</th><th>State</th></tr></thead>
      <tbody id="bbody"><tr><td colspan="7" class="muted2">loading…</td></tr></tbody>
    </table>
  </div>
  <div class="row" style="margin-top:10px">
    <button class="ghost" id="bmore" style="display:none">Load more</button>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <h2>👥 Players</h2>
  <div class="row" style="margin-bottom:10px">
    <input id="q" placeholder="Search a wallet (0x…), a name or a Telegram id" style="flex:1;min-width:220px;margin-bottom:0">
    <button class="ghost" id="clearQ">Clear</button>
    <button class="ghost" id="csv">Export CSV</button>
  </div>
  <div class="ptot" id="ptot">—</div>
  <style>
    #ptbl tbody tr.pl{ cursor:pointer; }
    #ptbl tbody tr.pl:hover{ background:rgba(255,255,255,.05); }
    #ptbl tbody tr.pl.open{ background:rgba(230,165,55,.10); }
    tr.det td{ padding:0 !important; background:rgba(0,0,0,.28); }
    .det-in{ padding:10px 14px 14px; }
    .det-in h5{ margin:0 0 8px; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:#E7C97A; }
    .det-t{ width:100%; border-collapse:collapse; font-size:12.5px; }
    .det-t th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:#9d9d9d; }
    .det-t th, .det-t td{ padding:3px 8px; border-bottom:1px solid rgba(255,255,255,.06); }
    .det-t td.n, .det-t th.n{ text-align:right; }
    .det-t .haut{ color:#F2685E; font-weight:800; }
    .det-t .bas{ color:#7CFF9B; }
    .det-note{ margin-top:8px; font-size:11.5px; color:#9d9d9d; line-height:1.5; }
    /* Le detail par jeu a cinq colonnes chiffrees : sur un telephone il sort de
       l'ecran. Il defile DANS SA BOITE plutot que de pousser la page — un
       tableau de chiffres n'a pas de forme repliable, contrairement aux
       fiches, et le tronquer perdrait la colonne qui interesse. */
    .det-scroll{ overflow-x:auto; -webkit-overflow-scrolling:touch; margin:0 -3px; padding:0 3px; }
    .det-t{ min-width:430px; }
    .det-vide{ color:#9d9d9d; font-size:12.5px; }

    /* ---- la liste des joueurs, en FICHES et non en tableau ----
       Il y avait dix colonnes chiffrees dans un panneau de sept cents pixels :
       le tableau faisait 2457 px de large, sept colonnes sur dix etaient hors
       de l'ecran, et la fiche ouverte etait coupee en deux. Un tableau qui
       demande de faire defiler pour lire le solde d'un joueur ne se lit pas.

       Une fiche par joueur : le nom et l'adresse sur une ligne, les chiffres
       en dessous dans une grille qui se replie toute seule. Aucune largeur a
       respecter, donc rien a couper — du grand ecran au telephone. */
    .plst{ display:flex; flex-direction:column; gap:9px; }
    .pcard{ border:1px solid rgba(230,165,55,.20); border-radius:12px; overflow:hidden;
            background:rgba(255,255,255,.025); transition:border-color .15s; }
    .pcard:hover{ border-color:rgba(230,165,55,.45); }
    .pcard.open{ border-color:rgba(230,165,55,.6); background:rgba(230,165,55,.06); }
    .pcard.nodep{ opacity:.72; }
    .pc-h{ display:flex; align-items:center; gap:10px; padding:11px 13px; cursor:pointer;
           border-bottom:1px solid rgba(255,255,255,.06); }
    .card.danger{ border-color:#F2685E !important; background:rgba(242,104,94,.10) !important; }
    .card.danger b{ color:#F2685E !important; }
    .card.attention{ border-color:#E7C97A !important; }
    .card em{ display:block; margin-top:6px; font-style:normal; font-size:11px; line-height:1.5; color:#F2685E; }
    .pcav img{ width:100%; height:100%; border-radius:50%; object-fit:cover; display:block; }
    .pcav{ flex:0 0 auto; width:32px; height:32px; border-radius:50%; display:flex; overflow:hidden;
           align-items:center; justify-content:center; font-size:17px;
           background:rgba(255,255,255,.05); border:1px solid rgba(230,165,55,.3); }
    .pc-h .who{ flex:1 1 auto; min-width:0; }
    .pc-h .who b{ display:block; font-size:14px; font-weight:800; color:#f3ead6;
                  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    /* L'adresse fait quarante-deux caracteres : sans coupure elle passe SOUS le
       total et les deux se chevauchent sur telephone. Elle se tronque au bout
       plutot que de deborder — le debut suffit a reconnaitre un joueur, et
       elle reste selectionnable en entier. */
    .pc-h .who span{ display:block; font-size:11px; color:#8a7f6a; margin-top:2px;
                     font-family:'Space Mono',monospace;
                     white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    @media (max-width:560px){ .pc-h .who b{ font-size:13px; } .pc-h .tot b{ font-size:14px; } }
    .pc-h .tot{ flex:0 0 auto; text-align:right; }
    .pc-h .tot b{ display:block; font-size:16px; font-weight:800; color:#E8A33D;
                  font-variant-numeric:tabular-nums; }
    .pc-h .tot span{ font-size:10px; letter-spacing:1.1px; color:#8a7f6a; text-transform:uppercase; }
    .pc-h .fl{ flex:0 0 auto; width:22px; text-align:center; color:#8a7f6a; font-size:12px; }
    /* auto-fit : autant de colonnes que la largeur en autorise, jamais plus */
    .pc-g{ display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr));
           gap:1px; background:rgba(255,255,255,.06); }
    .pc-g div{ padding:8px 11px; background:#14100a; }
    .pc-g i{ display:block; font-style:normal; font-size:9.5px; letter-spacing:1.1px;
             text-transform:uppercase; color:#8a7f6a; margin-bottom:3px; white-space:nowrap; }
    .pc-g b{ font-size:13.5px; font-weight:800; color:#e9dfc8; font-variant-numeric:tabular-nums; }
    .pc-g b.haut{ color:#F2685E; } .pc-g b.bas{ color:#7CFF9B; }
    .pc-d{ padding:11px 13px; background:rgba(0,0,0,.3);
           border-top:1px solid rgba(230,165,55,.2); }
    .tri{ display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0 0 10px;
          font-size:11.5px; color:#8a7f6a; }
    .tri button{ padding:5px 10px; border-radius:999px; cursor:pointer; font-family:inherit;
                 font-size:11px; color:#c9bfa8; background:rgba(255,255,255,.05);
                 border:1px solid rgba(255,255,255,.1); }
    .tri button.on{ color:#14100a; background:#E8A33D; border-color:#E8A33D; font-weight:800; }
  </style>
  <div class="tri" id="tri">Sort by</div>
  <div class="plst" id="pbody"><div class="muted2">loading…</div></div>
</div>

<div class="panel" style="margin-top:14px">
  <h2>⚙️ Owner controls</h2>
  <div style="font-size:12px;color:#8a7f6a;margin-bottom:10px">Connect the owner wallet above to enable these.</div>

  <label style="font-size:13px;color:#c9bfa8">Fund the vault (adds bankroll)</label>
  <input id="fundAmt" type="number" inputmode="decimal" placeholder="amount in $SWOGE">
  <div class="row" style="margin-bottom:14px"><button id="fund" disabled>Approve + Fund →</button></div>

  <label style="font-size:13px;color:#c9bfa8">Minimum withdraw — currently <b id="curMin" style="color:#E6A537">—</b></label>
  <input id="minAmt" type="number" inputmode="decimal" placeholder="new minimum in $SWOGE">
  <div class="row" style="margin-bottom:14px"><button class="ghost" id="setMin" disabled>Set minimum</button></div>

  <label style="font-size:13px;color:#c9bfa8">Pause / resume</label>
  <div class="row"><button class="ghost" id="pauseDep" disabled>Deposits: —</button><button class="ghost" id="pauseWd" disabled>Withdrawals: —</button></div>
  <div id="cmsg" style="margin-top:12px;font-size:13px"></div>
</div>

<script>
var KEY=new URLSearchParams(location.search).get('key')||'';
var VAULT="${V}";
var TOKEN="${cfg.SWOGE_TOKEN || ''}";
var CHAIN={hex:"${CHAIN_HEX}",name:"${cfg.CHAIN_ID===4663?'Robinhood Chain':'Chain'}",rpc:"${cfg.RPC_URL}"};
var ABI=[
  "function ownerWithdraw(address to,uint256 amount)",
  "function ownerDeposit(uint256 amount)",
  "function setDepositsPaused(bool paused)",
  "function setWithdrawalsPaused(bool paused)",
  "function setMinWithdraw(uint256 v)",
  "function totalPot() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function withdrawalsPaused() view returns (bool)",
  "function minWithdraw() view returns (uint256)"
];
var ERC20=["function approve(address s,uint256 a) returns (bool)","function allowance(address o,address s) view returns (uint256)"];
var provider,signer,myAddr,surplusNum=0,burnDu=0,moisChoisi=null;
var EXPL="${cfg.EXPLORER || ''}";
function $(s){return document.querySelector(s);}
/* Le visage d'un joueur dans une fiche.
   Il y a TROIS cas et non un seul, et c'est pour ca qu'il ne s'affichait pas :
   une photo televersee (servie par le serveur a son adresse), une medaille
   peinte (un CODE, « b3 », dont l'image vit sur le site), ou rien. Ecrire le
   code tel quel donnait « b3 » en toutes lettres. */
var MEDIA="${cfg.GAME_IMAGE_BASE || ''}";
function visageDe(p){
  if(p.photo) return '<div class="pcav"><img src="/avatar/'+p.address+'?v='+Date.now()+'" alt=""></div>';
  if(/^b[0-9]{1,2}$/.test(p.visage||"")) return '<div class="pcav"><img src="'+MEDIA+'/badge-'+p.visage.slice(1)+'.webp" alt=""></div>';
  return '<div class="pcav">'+esc(p.visage||"👤")+'</div>';
}
function fmt(v){var n=parseFloat(v||"0");if(isNaN(n))return "—";return n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":n.toFixed(2);}
function msg(t,c){$("#msg").textContent=t;$("#msg").className=c||"";}

async function load(){
  try{
    var r=await fetch("/stats"+(moisChoisi?"?mois="+encodeURIComponent(moisChoisi):""),{headers:{"x-admin-key":KEY}});
    if(!r.ok){ msg("Wrong admin key or stats disabled ("+r.status+")","warn"); return; }
    var d=await r.json();
    $("#pot").textContent=fmt(d.vaultPot); $("#owed").textContent=fmt(d.owedToPlayers);
    $("#surplus").textContent=fmt(d.ownerSurplus); surplusNum=parseFloat(d.ownerSurplus||"0")||0;
    /* L ALARME. Le surplus etait un nombre parmi d autres : il fallait
       l ouvrir et le lire pour savoir que le coffre ne couvre plus ce qu on
       doit. Le jour ou ca arrive, on l apprend par un joueur furieux. */
    var pot=parseFloat(d.vaultPot||"0")||0, du=parseFloat(d.owedToPlayers||"0")||0;
    var marge = du>0 ? (pot-du)/du : 1;
    var c=$("#surCard"), a=$("#surAlerte");
    c.classList.remove("danger","attention");
    if(pot<du){ c.classList.add("danger");
      a.textContent="⚠️ LE COFFRE NE COUVRE PLUS CE QUE VOUS DEVEZ — il manque "+fmt(String(du-pot))+" $SWOGE"; }
    else if(marge<0.10){ c.classList.add("attention");
      a.textContent="marge de "+(marge*100).toFixed(1)+"% seulement — un gros retrait passerait dessous"; }
    else a.textContent="";
    /* L AUTONOMIE. Un niveau dit ou l on en est ; un rythme dit quand ca
       casse. C est le second qui laisse le temps d agir. */
    var A=d.autonomie||{};
    $("#auCout").textContent=fmt(String(A.rendementJour||0));
    $("#auRev").textContent=fmt(String(A.revenuJour||0));
    var ac=$("#auCard"), an=$("#auNote"), al=$("#auLigne");
    ac.classList.remove("danger","attention");
    if(A.surplus===null||A.surplus===undefined){
      $("#auJours").textContent="—"; an.textContent="vault balance unknown (no VAULT_ADDRESS)"; al.innerHTML="";
    } else if(A.joursRestants===null){
      $("#auJours").textContent="∞";
      an.textContent="the house earns more than staking costs — the pool pays for itself";
      al.innerHTML="Revenue covers the yield with <b>"+fmt(String(A.revenuJour-A.rendementJour))+
        " $SWOGE/day</b> to spare. Nothing is draining.";
    } else {
      var j=A.joursRestants;
      $("#auJours").textContent=j>=3650?"10y+":(j>=365?(j/365).toFixed(1)+" years":j+" days");
      if(j<60){ ac.classList.add("danger"); an.textContent="⚠️ TOP THE VAULT UP OR LOWER THE CAP"; }
      else if(j<180){ ac.classList.add("attention"); an.textContent="less than six months — plan the top-up now"; }
      else an.textContent="";
      var fin=new Date(Date.now()+j*86400000);
      al.innerHTML="Net drain <b>"+fmt(String(A.drainJour))+" $SWOGE/day</b>. The surplus of <b>"+
        fmt(String(A.surplus))+"</b> runs out around <b>"+fin.toLocaleDateString()+"</b>"+
        " if nothing changes.<br>Revenue alone could carry <b>"+fmt(String(A.stakingAutofinance))+
        " $SWOGE</b> of staking without topping the vault up"+
        (d.capaciteStaking&&d.capaciteStaking.plafond
          ? " — the cap is currently <b>"+fmt(String(d.capaciteStaking.plafond))+"</b>, and <b>"+
            fmt(String(d.capaciteStaking.occupe))+"</b> is staked."
          : ".");
    }
    $("#ob").textContent=fmt(d.owedBalances); $("#os").textContent=fmt(d.owedStaked);
    $("#oy").textContent=fmt(d.owedPending); $("#oj").textContent=fmt(d.owedJackpot);
    $("#pl").textContent=d.players;
    burnDu=parseFloat(d.aBruler||"0")||0;
    $("#burnDu").textContent=fmt(d.aBruler); $("#burnFait").textContent=fmt(d.dejaBrule);
    $("#burnAddr").textContent=d.adresseBrulage||"—";
    $("#burnGo").disabled=!(burnDu>0&&signer);
    $("#burnList").innerHTML=(d.brulages||[]).map(function(b){
      return "🔥 "+fmt(b.m)+" &middot; "+new Date(b.t).toLocaleDateString()+
             ' &middot; <a href="'+EXPL+"/tx/"+b.tx+'" target="_blank">tx ↗</a>';
    }).join("<br>")||"Nothing burned yet.";
    /* Le compte du mois. On garde le mois choisi si l utilisateur en a pris
       un : recharger toutes les vingt secondes ne doit pas le ramener de
       force sur le mois en cours. */
    var c=d.comptes||{};
    if(!$("#moisSel").options.length || $("#moisSel").options.length!==(d.moisConnus||[]).length){
      $("#moisSel").innerHTML=(d.moisConnus||[]).map(function(m){return '<option>'+m+'</option>';}).join("");
      if(moisChoisi) $("#moisSel").value=moisChoisi;
    }
    $("#cRev").textContent=fmt(String(c.revenu));
    $("#cCout").textContent=fmt(String(c.couts));
    $("#cRes").textContent=(c.resultat>=0?"+":"")+fmt(String(c.resultat));
    $("#cResCard").classList.toggle("danger", c.resultat<0);
    $("#cMise").textContent=fmt(String(c.mises)); $("#cRendu").textContent=fmt(String(c.rendus));
    $("#cManches").textContent=c.manches||0;
    $("#cEdge").textContent=c.mises>0?((c.revenu/c.mises*100).toFixed(2)+" %"):"—";
    $("#cStk").textContent=fmt(String(c.staking)); $("#cBon").textContent=fmt(String(c.bonus));
    $("#cPar").textContent=fmt(String(c.parrainage)); $("#cJck").textContent=fmt(String(c.jackpots));
    $("#cDep").textContent=fmt(String(c.depots)); $("#cRet").textContent=fmt(String(c.retraits));
    $("#cBru").textContent=fmt(String(c.brule));
    var t=(d.tunnel||[]);
    $("#tunTable").innerHTML = t.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
        '<tr style="color:#8DA0C4;text-align:right"><th style="text-align:left">day</th>'+
        '<th>pages</th><th>wallets</th><th>→</th><th>deposits</th><th>→</th>'+
        '<th>first bets</th><th>→</th><th>deposited</th></tr>'+
        t.map(function(j){ return '<tr style="text-align:right">'+
          '<td style="text-align:left">'+j.jour+'</td><td>'+j.pages+'</td><td>'+j.connexions+'</td>'+
          '<td style="color:#C9A24A">'+(j.tauxConnexion==null?"—":j.tauxConnexion+"%")+'</td>'+
          '<td>'+j.deposants+'</td>'+
          '<td style="color:#C9A24A">'+(j.tauxDepot==null?"—":j.tauxDepot+"%")+'</td>'+
          '<td>'+j.premieresMises+'</td>'+
          '<td style="color:#C9A24A">'+(j.tauxPremiereMise==null?"—":j.tauxPremiereMise+"%")+'</td>'+
          '<td>'+fmt(String(j.depose||0))+'</td></tr>'; }).join("")+'</table>'
      : "Nothing recorded yet.";
    $("#upd").textContent=new Date().toLocaleTimeString();
  }catch(e){ msg("Could not load stats: "+e.message,"warn"); }
}
load(); setInterval(load,10000);

/* ---------- Players table ---------- */
var PLAYERS=[], sortKey="wagered", sortDir=-1;
function num(v){ var n=parseFloat(v); return isNaN(n)?0:n; }
function short(ad){ return ad.slice(0,6)+"…"+ad.slice(-4); }
function drawPlayers(){
  var q=($("#q").value||"").trim().toLowerCase();
  var rows=PLAYERS.filter(function(p){
    if(!q) return true;
    return p.address.indexOf(q)>=0 || (p.name||"").toLowerCase().indexOf(q)>=0 || String(p.tgId||"")===q;
  });
  rows.sort(function(x,y){
    var a=x[sortKey], b=y[sortKey];
    if(sortKey==="name") return sortDir*String(a).localeCompare(String(b));
    return sortDir*(num(a)-num(b));
  });
  var held=0, played=0, bets=0;
  rows.forEach(function(p){ held+=num(p.total); played+=num(p.wagered); bets+=p.bets||0; });
  $("#ptot").innerHTML="Showing <b>"+rows.length+"</b> of <b>"+PLAYERS.length+"</b> players · holding <b>"+
    fmt(held)+"</b> $SWOGE · played <b>"+fmt(played)+"</b> $SWOGE over <b>"+bets+"</b> bets";
  if(!rows.length){ $("#pbody").innerHTML='<div class="muted2">no player matches</div>'; return; }
  var ouverts={};
  [].forEach.call(document.querySelectorAll(".pcard.open"),function(c){ ouverts[c.dataset.a]=1; });
  var h="";
  rows.forEach(function(p){
    /* « Net » du point de vue de la MAISON : positif = le joueur lui a coute.
       La couleur suit ce sens-la et pas l'autre, sinon on lit l'inverse de ce
       qu'on croit lire. */
    var net=num(p.net);
    h+='<div class="pcard '+(p.deposited?"":"nodep")+(ouverts[p.address]?" open":"")+'" data-a="'+esc(p.address)+'">'+
       '<div class="pc-h">'+
         visageDe(p)+
         '<div class="who"><b>'+esc(p.name)+(p.tgId?' <span class="tg">tg:'+esc(String(p.tgId))+'</span>':'')+'</b>'+
         '<span>'+esc(p.address)+'</span></div>'+
         '<div class="tot"><b>'+fmt(p.total)+'</b><span>total held</span></div>'+
         '<div class="fl">'+(ouverts[p.address]?"▾":"▸")+'</div>'+
       '</div>'+
       '<div class="pc-g">'+
         '<div><i>Balance</i><b>'+fmt(p.balance)+'</b></div>'+
         '<div><i>Staked</i><b>'+fmt(p.staked)+'</b></div>'+
         '<div><i>Yield</i><b>'+fmt(p.pending)+'</b></div>'+
         '<div><i>Deposited</i><b>'+fmt(p.depositedAmount)+'</b></div>'+
         '<div><i>Withdrawn</i><b>'+fmt(p.withdrawn)+'</b></div>'+
         '<div><i>Net vs house</i><b class="'+(net>0?"haut":"bas")+'">'+fmt(p.net)+'</b></div>'+
         '<div><i>Played</i><b>'+fmt(p.wagered)+'</b></div>'+
         '<div><i>Bets</i><b>'+(p.bets||0)+'</b></div>'+
         '<div><i>Friends</i><b>'+(p.amis||0)+'</b></div>'+
       '</div>'+
       '<div class="pc-d" data-d="'+esc(p.address)+'"'+(ouverts[p.address]?'':' style="display:none"')+'>'+
         detail(p)+'</div>'+
       '</div>';
  });
  $("#pbody").innerHTML=h;
  dessineTri();
}

/* Le tri : il etait sur les en-tetes du tableau, qui n'existe plus. Des
   pastilles disent en clair sur quoi on trie, ce qu'un en-tete cliquable ne
   disait qu'a celui qui pensait a cliquer. */
var TRIS=[["total","Total held"],["balance","Balance"],["net","Net vs house"],
          ["wagered","Played"],["bets","Bets"],["depositedAmount","Deposited"],["name","Name"]];
function dessineTri(){
  var t=$("#tri"); if(!t||t.dataset.pret) return;
  t.dataset.pret="1";
  TRIS.forEach(function(o){
    var b=document.createElement("button");
    b.type="button"; b.textContent=o[1]; b.dataset.k=o[0];
    b.onclick=function(){
      if(sortKey===o[0]) sortDir=-sortDir; else { sortKey=o[0]; sortDir=(o[0]==="name"?1:-1); }
      drawPlayers(); majTri();
    };
    t.appendChild(b);
  });
  majTri();
}
function majTri(){
  [].forEach.call(document.querySelectorAll("#tri button"),function(b){
    var actif=b.dataset.k===sortKey;
    b.classList.toggle("on",actif);
    b.textContent=(TRIS.filter(function(o){return o[0]===b.dataset.k;})[0]||["",""])[1]+
                  (actif?(sortDir<0?" ↓":" ↑"):"");
  });
}
/* Detail par jeu. Deux chiffres, et ils ne disent PAS la meme chose :
   - « gagnees » flatte : au blackjack on gagne pres d'une main sur deux et on
     perd quand meme, parce qu'une main doublee perdue coute le double ;
   - « retour » est le seul qui compte : ce qui revient divise par ce qui est
     mise. Au-dessus de 100 % sur beaucoup de manches, l'argent ne vient pas
     du jeu. Sur vingt manches, ca ne veut rien dire — d'ou le nombre affiche
     en premier. */
var NOMJEU={ bj:"Blackjack", holdem:"Casino Hold'em", three:"Three Card",
             hilo:"Hi-Lo", mines:"Mines", plinko:"Plinko",
             spin:"SWOGE Spin", spinBonus:"Spin — bonus achete", smash:"Smash" };
function pct(x){ return (100*x).toFixed(1)+"%"; }
function detail(p){
  var j=p.jeux||{}, cles=Object.keys(j);
  if(!cles.length) return '<div class="det-in"><span class="det-vide">Aucune manche enregistree pour ce joueur.</span></div>';
  cles.sort(function(a,b){ return (j[b].mise||0)-(j[a].mise||0); });
  var tot={n:0,mise:0,rendu:0,gagne:0};
  var h='<div class="det-in"><h5>'+esc(p.name)+' — detail par jeu</h5>'+
        '<div class="det-scroll"><table class="det-t"><tr><th>Jeu</th><th class="n">Manches</th>'+
        '<th class="n">Gagnees</th><th class="n">Nulles</th><th class="n">Mise</th>'+
        '<th class="n">Rendu</th><th class="n">Retour</th></tr>';
  cles.forEach(function(k){
    var g=j[k]; tot.n+=g.n; tot.mise+=g.mise; tot.rendu+=g.rendu; tot.gagne+=g.gagne;
    var ret=g.mise>0?g.rendu/g.mise:0;
    /* On ne crie qu'au-dessus de 100 % ET sur assez de manches : en dessous de
       200 coups, la variance seule depasse largement l'ecart qu'on cherche. */
    var suspect = ret>1 && g.n>=200;
    h+='<tr><td>'+esc(NOMJEU[k]||k)+'</td>'+
       '<td class="n">'+g.n+'</td>'+
       '<td class="n">'+pct(g.n?g.gagne/g.n:0)+'</td>'+
       '<td class="n">'+pct(g.n?(g.nul||0)/g.n:0)+'</td>'+
       '<td class="n">'+fmt(g.mise)+'</td>'+
       '<td class="n">'+fmt(g.rendu)+'</td>'+
       '<td class="n '+(suspect?"haut":ret<1?"bas":"")+'">'+pct(ret)+'</td></tr>';
  });
  var retTot=tot.mise>0?tot.rendu/tot.mise:0;
  h+='<tr><th>Tous jeux</th><th class="n">'+tot.n+'</th>'+
     '<th class="n">'+pct(tot.n?tot.gagne/tot.n:0)+'</th><th></th>'+
     '<th class="n">'+fmt(tot.mise)+'</th><th class="n">'+fmt(tot.rendu)+'</th>'+
     '<th class="n '+(retTot>1&&tot.n>=200?"haut":"")+'">'+pct(retTot)+'</th></tr></table></div>';
  h+='<div class="det-note">Le <b>retour</b> est le chiffre a lire : ce qui revient divise par ce qui est mise. '+
     'La maison garde 3 a 8 % selon le jeu, donc un joueur normal reste <b>sous 100 %</b>. '+
     'Au-dessus de 100 % sur plus de 200 manches, cet argent ne vient pas du jeu : il est marque en rouge. '+
     'Le pourcentage de mains gagnees, lui, flatte : on peut en gagner la moitie et perdre quand meme.</div>';
  return h+'</div>';
}
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
async function loadPlayers(){
  try{
    var r=await fetch("/players?limit=1000",{headers:{"x-admin-key":KEY}});
    if(!r.ok){ $("#pbody").innerHTML='<tr><td colspan="10" class="muted2">could not load players ('+r.status+')</td></tr>'; return; }
    var d=await r.json(); PLAYERS=d.players||[]; drawPlayers();
  }catch(e){ $("#pbody").innerHTML='<tr><td colspan="10" class="muted2">'+esc(e.message)+'</td></tr>'; }
}
loadPlayers(); setInterval(loadPlayers,15000);

/* ================= LES PARIS SPORTIFS =================
 *
 * Le filtrage se fait AU SERVEUR, contrairement au tableau des joueurs qui
 * charge tout et trie dans la page. La difference n'est pas un caprice : un
 * joueur, c'est une ligne ; un pari, c'est une ligne plus ses jambes, et le
 * nombre de paris grandit sans limite alors que le nombre de joueurs, non.
 * Tout charger finirait par prendre des secondes pour afficher cinquante
 * lignes.
 */
var BETS=[], BDEBUT=0, BENCORE=false, bTimer=null;

function betat(e){
  if(e==='a regler') return '<span class="bet act">to settle</span>';
  if(e==='en cours')  return '<span class="bet att">running</span>';
  if(e==='gagne')     return '<span class="bet g">won</span>';
  if(e==='perdu')     return '<span class="bet p">lost</span>';
  return '<span class="bet">refunded</span>';
}
var BNOM={'1':'Home','N':'Draw','2':'Away'}, BNOM2={'1':'Player 1','2':'Player 2'};
function bJambe(j){
  var nom=((j.issues||[]).length===2?BNOM2:BNOM)[j.choix]||j.choix;
  /* Le resultat tombe a cote de la selection : c'est la seule facon de voir
     d'un coup d'oeil POURQUOI un combine est perdu. */
  var res=j.resultat ? ' &middot; result <b class="bres">'+esc(((j.issues||[]).length===2?BNOM2:BNOM)[j.resultat]||j.resultat)+'</b>' : '';
  /* Le resultat descend sur la SECONDE ligne, avec l'identifiant du match.
     Sur la premiere il finissait contre le bord de la carte a 390 px, et
     « result Home » se lisait « result Ho ». */
  return '<span class="bj">'+esc(j.domicile)+' &ndash; '+esc(j.exterieur)+
         ' &middot; <b>'+esc(nom)+'</b> @ '+Number(j.cote||1).toFixed(2)+
         '<span class="bid2">'+esc(j.match)+res+'</span></span>';
}
function drawBets(){
  var b=$("#bbody");
  if(!BETS.length){ b.innerHTML='<tr><td colspan="7" class="muted2">no bet matches</td></tr>'; return; }
  b.innerHTML=BETS.map(function(p){
    var qui=p.nom ? esc(p.nom)+' <span class="bmut">'+short(p.addr)+'</span>'
                  : '<span class="bmut">'+short(p.addr)+'</span>';
    var titre=(p.jambes.length>1?p.jambes.length+'-fold':'Single');
    /* L'etat est dessine DEUX fois : dans la cellule de tete, visible
       seulement en cartes, et dans sa colonne, cachee en cartes. Deux
       markups valent mieux qu'un tableau qu'on deplace en JavaScript selon
       la largeur — celui-la se retrompe a chaque rotation de l'ecran. */
    return '<tr>'+
      '<td class="tete"><span><code class="bid" title="click to copy">'+esc(p.id)+'</code><br>'+
        '<span class="bmut">'+new Date(p.t).toLocaleString('en-GB')+'</span></span>'+
        '<span class="surtel">'+betat(p.etat)+'</span></td>'+
      '<td data-l="player">'+qui+'</td>'+
      '<td><b>'+titre+'</b>'+p.jambes.map(bJambe).join('')+'</td>'+
      '<td class="n" data-l="stake">'+fmt(p.mise)+'</td>'+
      '<td class="n" data-l="odds">'+Number(p.cote||1).toFixed(2)+'</td>'+
      '<td class="n" data-l="returns">'+fmt(p.rapport)+'</td>'+
      '<td class="vide">'+betat(p.etat)+'</td></tr>';
  }).join("");
}
async function loadBets(ajoute){
  var q=$("#bq").value.trim(), etat=$("#betat").value;
  if(!ajoute) BDEBUT=0;
  try{
    var r=await fetch("/paris/liste?limite=50&debut="+BDEBUT+"&etat="+encodeURIComponent(etat)+
                      (q?"&q="+encodeURIComponent(q):""),{headers:{"x-admin-key":KEY}});
    if(!r.ok){ $("#bbody").innerHTML='<tr><td colspan="7" class="muted2">could not load bets ('+r.status+')</td></tr>'; return; }
    var d=await r.json();
    BETS = ajoute ? BETS.concat(d.paris||[]) : (d.paris||[]);
    BDEBUT = (d.debut||0) + (d.paris||[]).length;
    BENCORE = !!d.encore;
    var s=d.resume||{};
    $("#btot").innerHTML = BETS.length+' shown of '+(d.total||0)+
      ' &middot; staked <b>'+fmt(s.mise)+'</b>'+
      ' &middot; <b>'+(s.ouverts||0)+'</b> still open, exposure <b>'+fmt(s.engage)+'</b>'+
      ' &middot; paid out <b>'+fmt(s.paye)+'</b> $SWOGE';
    $("#bmore").style.display = BENCORE ? "" : "none";
    drawBets();
  }catch(e){ $("#bbody").innerHTML='<tr><td colspan="7" class="muted2">'+esc(e.message)+'</td></tr>'; }
}
/* On attend que la frappe s'arrete : une requete par touche ferait dix
   allers-retours pour un identifiant de dix caracteres. */
$("#bq").addEventListener("input",function(){ clearTimeout(bTimer); bTimer=setTimeout(function(){ loadBets(false); },250); });
$("#betat").addEventListener("change",function(){ loadBets(false); });
$("#bclear").onclick=function(){ $("#bq").value=""; $("#betat").value="tous"; loadBets(false); };
$("#bmore").onclick=function(){ loadBets(true); };
/* L'identifiant se copie d'un clic : c'est ce qu'on recolle dans une reponse
   au joueur ou dans la commande de reglement. */
$("#bbody").addEventListener("click",function(e){
  var c=e.target.closest("code.bid"); if(!c) return;
  var t=c.textContent;
  try{ navigator.clipboard.writeText(t); }catch(err){}
  var avant=c.textContent; c.textContent="copied ✓";
  setTimeout(function(){ c.textContent=avant; },900);
});
$("#bcsv").onclick=function(){
  var lignes=[["bet id","placed","wallet","name","selections","stake","odds","returns","state"].join(",")];
  BETS.forEach(function(p){
    var sel=p.jambes.map(function(j){ return j.domicile+" v "+j.exterieur+" ["+j.choix+"] @"+j.cote; }).join(" + ");
    lignes.push([p.id,new Date(p.t).toISOString(),p.addr,p.nom||"",sel,p.mise,p.cote,p.rapport,p.etat]
      .map(function(x){ return '"'+String(x==null?"":x).replace(/"/g,'""')+'"'; }).join(","));
  });
  var blob=new Blob([lignes.join(String.fromCharCode(10))],{type:"text/csv"});
  var u=URL.createObjectURL(blob), a=document.createElement("a");
  a.href=u; a.download="swoge-bets.csv"; a.click(); URL.revokeObjectURL(u);
};
loadBets(false); setInterval(function(){ if(!$("#bq").value) loadBets(false); },20000);
/* Un clic sur la ligne ouvre son detail, et referme celui qui l'etait : deux
   panneaux ouverts noient le tableau. */
$("#pbody").addEventListener("click",function(e){
  var carte=e.target.closest(".pcard"); if(!carte) return;
  var ouvert=carte.classList.contains("open");
  [].forEach.call(document.querySelectorAll(".pcard.open"),function(x){
    x.classList.remove("open");
    var d=x.querySelector(".pc-d"); if(d) d.style.display="none";
    var f=x.querySelector(".fl"); if(f) f.textContent="▸";
  });
  if(!ouvert){
    carte.classList.add("open");
    var d=carte.querySelector(".pc-d"); if(d) d.style.display="";
    var f=carte.querySelector(".fl"); if(f) f.textContent="▾";
  }
});
$("#q").addEventListener("input",drawPlayers);
$("#clearQ").onclick=function(){ $("#q").value=""; drawPlayers(); };

$("#csv").onclick=function(){
  var cols=["address","name","balance","staked","pending","total","depositedAmount","net","wagered","bets","withdrawn","tgId","deposited"];
  var lines=[cols.join(",")];
  PLAYERS.forEach(function(p){ lines.push(cols.map(function(c){ return '"'+String(p[c]==null?"":p[c]).replace(/"/g,'""')+'"'; }).join(",")); });
  var blob=new Blob([lines.join(String.fromCharCode(10))],{type:"text/csv"});
  var u=URL.createObjectURL(blob), link=document.createElement("a");
  link.href=u; link.download="swoge-players.csv"; link.click(); URL.revokeObjectURL(u);
};
$("#refresh").onclick=function(e){e.preventDefault();load();};
$("#max").onclick=function(){ $("#amt").value=surplusNum>0?String(Math.floor(surplusNum)):"0"; };

$("#conn").onclick=async function(){
  if(!window.ethereum){ msg("No wallet found (install MetaMask / Rabby)","warn"); return; }
  try{
    await window.ethereum.request({method:"eth_requestAccounts"});
    var cid=await window.ethereum.request({method:"eth_chainId"});
    if(cid!==CHAIN.hex){
      try{ await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:CHAIN.hex}]}); }
      catch(sw){ if(sw&&sw.code===4902){ await window.ethereum.request({method:"wallet_addEthereumChain",params:[{chainId:CHAIN.hex,chainName:CHAIN.name,nativeCurrency:{name:"ETH",symbol:"ETH",decimals:18},rpcUrls:[CHAIN.rpc]}]}); } }
    }
    provider=new ethers.providers.Web3Provider(window.ethereum,"any"); signer=provider.getSigner();
    myAddr=await signer.getAddress();
    $("#conn").textContent=myAddr.slice(0,6)+"…"+myAddr.slice(-4);
    $("#go").disabled=false; msg("Wallet connected. Make sure it's the OWNER wallet.","ok");
    refreshOwnerState();
  }catch(e){ msg(String(e.message||e).slice(0,100),"warn"); }
};

function cmsg(t,c){ $("#cmsg").textContent=t; $("#cmsg").className=c||""; }
async function refreshOwnerState(){
  try{
    var c=new ethers.Contract(VAULT,ABI,provider);
    var dp=await c.depositsPaused(), wp=await c.withdrawalsPaused(), mw=await c.minWithdraw();
    $("#curMin").textContent=fmt(ethers.utils.formatUnits(mw,18));
    $("#pauseDep").textContent="Deposits: "+(dp?"PAUSED — resume":"live — pause"); $("#pauseDep").dataset.on=dp?"1":"0";
    $("#pauseWd").textContent="Withdrawals: "+(wp?"PAUSED — resume":"live — pause"); $("#pauseWd").dataset.on=wp?"1":"0";
    ["fund","setMin","pauseDep","pauseWd"].forEach(function(id){ $("#"+id).disabled=false; });
  }catch(e){ cmsg("Could not read contract state: "+(e.message||e),"warn"); }
}
async function tx(promise, okMsg){
  try{ cmsg("Confirm in your wallet…"); var t=await promise; cmsg("Sending…"); await t.wait(); cmsg("✅ "+okMsg,"ok"); refreshOwnerState(); load(); }
  catch(e){ cmsg("Failed: "+String(e.reason||e.message||e).slice(0,120),"warn"); }
}
$("#fund").onclick=async function(){
  if(!signer) return cmsg("Connect wallet first","warn");
  var v=($("#fundAmt").value||"").replace(",",".").trim(); if(!(parseFloat(v)>0)) return cmsg("Enter an amount","warn");
  if(!TOKEN) return cmsg("Token address not set on server","warn");
  try{
    var amt=ethers.utils.parseUnits(v,18);
    var tok=new ethers.Contract(TOKEN,ERC20,signer);
    var al=await tok.allowance(myAddr,VAULT);
    if(al.lt(amt)){ cmsg("Approve $SWOGE…"); var ta=await tok.approve(VAULT,ethers.constants.MaxUint256); await ta.wait(); }
    await tx(new ethers.Contract(VAULT,ABI,signer).ownerDeposit(amt), "Vault funded with "+v+" $SWOGE"); $("#fundAmt").value="";
  }catch(e){ cmsg("Failed: "+String(e.reason||e.message||e).slice(0,120),"warn"); }
};
$("#setMin").onclick=function(){
  if(!signer) return cmsg("Connect wallet first","warn");
  var v=($("#minAmt").value||"").replace(",",".").trim(); if(!(parseFloat(v)>=0)) return cmsg("Enter a value","warn");
  tx(new ethers.Contract(VAULT,ABI,signer).setMinWithdraw(ethers.utils.parseUnits(v,18)), "Min withdraw set to "+v); $("#minAmt").value="";
};
$("#pauseDep").onclick=function(){ if(!signer) return; var on=$("#pauseDep").dataset.on==="1"; tx(new ethers.Contract(VAULT,ABI,signer).setDepositsPaused(!on), on?"Deposits resumed":"Deposits paused"); };
$("#pauseWd").onclick=function(){ if(!signer) return; var on=$("#pauseWd").dataset.on==="1"; tx(new ethers.Contract(VAULT,ABI,signer).setWithdrawalsPaused(!on), on?"Withdrawals resumed":"Withdrawals paused"); };

/* Le brulage en une transaction : le coffre envoie directement a l'adresse
   morte. Passer par le portefeuille du proprietaire ferait deux transactions
   et laisserait un moment ou les jetons sont a lui — ce qui n'est plus tout a
   fait un brulage. */
var audAdr=null;
$("#bkGo").onclick=async function(){
  $("#bkEtat").textContent=" · sending…";
  try{
    var r=await fetch("/backup",{headers:{"x-admin-key":KEY}});
    var j=await r.json();
    if(j.ok){ msg("✅ Backup sent to your private channel ("+Math.round(j.octets/1024)+" KB, "+j.joueurs+" players)","ok");
      $("#bkEtat").innerHTML=' · <b style="color:#7CFF9B">last: '+new Date().toLocaleTimeString()+'</b>'; }
    else { msg("Backup NOT sent — set TG_BACKUP_CHAT_ID on the server","warn");
      $("#bkEtat").innerHTML=' · <b style="color:#F2685E">no private channel configured</b>'; }
  }catch(e){ msg("Backup failed: "+e.message,"warn"); $("#bkEtat").textContent=""; }
};

/* ---- telecharger, et remettre ----
   Le telechargement passe par un blob et non par un simple lien : la cle
   d'administration voyage dans un en-tete, pas dans l'adresse — une adresse
   se retrouve dans l'historique du navigateur, et une cle dans l'historique
   n'est plus une cle. */
$("#bkDl").onclick=async function(){
  $("#bkEtat").textContent=" · preparing…";
  try{
    var r=await fetch("/export",{headers:{"x-admin-key":KEY}});
    if(!r.ok) throw new Error("HTTP "+r.status);
    var nom=(r.headers.get("content-disposition")||"").match(/filename="([^"]+)"/);
    var b=await r.blob();
    var u=URL.createObjectURL(b), a=document.createElement("a");
    a.href=u; a.download=nom?nom[1]:"swoge-state.json.gz"; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(u); a.remove(); },1500);
    msg("✅ Downloaded "+Math.round(b.size/1024)+" KB — "+(r.headers.get("x-swoge-joueurs")||"?")+" players","ok");
    $("#bkEtat").innerHTML=' · <b style="color:#7CFF9B">downloaded '+new Date().toLocaleTimeString()+'</b>';
  }catch(e){ msg("Download failed: "+e.message,"warn"); $("#bkEtat").textContent=""; }
};

var rsVu=null;
function rsLigne(t,c){ return '<div style="color:'+(c||"#8DA0C4")+'">'+t+'</div>'; }
async function rsEnvoie(confirme){
  var f=$("#rsFile").files[0];
  if(!f){ msg("Pick a backup file first","warn"); return null; }
  var url="/import"+(confirme?"?confirm=REPLACE-ALL":"");
  var r=await fetch(url,{method:"POST",headers:{"x-admin-key":KEY,"content-type":"application/octet-stream"},body:f});
  return await r.json();
}
$("#rsLook").onclick=async function(){
  $("#rsOut").innerHTML=rsLigne("reading…");
  $("#rsGo").disabled=true; rsVu=null;
  try{
    var j=await rsEnvoie(false);
    if(!j) { $("#rsOut").innerHTML=""; return; }
    if(j.error){ $("#rsOut").innerHTML=rsLigne("✕ "+j.error,"#F2685E"); return; }
    var d=j.difference, sens=d>0?"more":"less";
    rsVu=j; $("#rsGo").disabled=false;
    $("#rsOut").innerHTML=
      rsLigne("<b style='color:#EAF2FF'>The file holds</b> "+j.fichier.joueurs+" players · "+
              fmt(j.fichier.duAuxJoueurs)+" $SWOGE owed to players")+
      rsLigne("<b style='color:#EAF2FF'>Live right now</b> "+j.actuel.joueurs+" players · "+
              fmt(j.actuel.duAuxJoueurs)+" $SWOGE owed to players")+
      rsLigne("Restoring would make the house owe <b>"+fmt(Math.abs(d))+" $SWOGE "+sens+"</b>"+
              (j.fichier.joueurs<j.actuel.joueurs
                ? " and drop <b>"+(j.actuel.joueurs-j.fichier.joueurs)+" players</b> that exist today"
                : ""), d===0?"#8DA0C4":"#FFC53D")+
      rsLigne("Nothing has been replaced. Press <b>Replace everything</b> to go through with it.","#8DA0C4");
  }catch(e){ $("#rsOut").innerHTML=rsLigne("✕ "+e.message,"#F2685E"); }
};
$("#rsGo").onclick=async function(){
  if(!rsVu){ msg("Look at the file first","warn"); return; }
  /* Les sauts de ligne s ECHAPPENT DEUX FOIS : cette page est fabriquee dans
     un litteral gabarit, donc un simple \\n serait evalue ICI et emettrait un
     vrai retour a la ligne au milieu d une chaine JavaScript de la page —
     c est-a-dire une page qui ne se charge plus du tout. */
  var q="Replace EVERY balance, stake, friendship and history with this file?\\n\\n"+
        rsVu.actuel.joueurs+" players → "+rsVu.fichier.joueurs+" players\\n"+
        fmt(rsVu.actuel.duAuxJoueurs)+" → "+fmt(rsVu.fichier.duAuxJoueurs)+" $SWOGE owed\\n\\n"+
        "Today's state is kept in a dated file first, so this can be undone.";
  if(!confirm(q)) return;
  if(prompt('Type RESTORE to go ahead.')!=="RESTORE") return;
  $("#rsOut").innerHTML=rsLigne("restoring…");
  try{
    var j=await rsEnvoie(true);
    if(!j.remplace){ $("#rsOut").innerHTML=rsLigne("✕ "+(j.error||"not replaced"),"#F2685E"); return; }
    msg("♻️ Restored — "+j.joueurs.apres+" players, "+j.sessionsFermees+" sessions closed","ok");
    $("#rsOut").innerHTML=
      rsLigne("✅ Restored: "+j.joueurs.avant+" → <b>"+j.joueurs.apres+"</b> players","#7CFF9B")+
      rsLigne("Everyone was disconnected and reconnects on their own.")+
      rsLigne("To undo: copy <code>"+j.filet+"</code> back over <code>state.json</code> and restart.","#FFC53D");
    load();
  }catch(e){ $("#rsOut").innerHTML=rsLigne("✕ "+e.message,"#F2685E"); }
};
$("#moisSel").onchange=function(){ moisChoisi=$("#moisSel").value; load(); };
$("#audGo").onclick=async function(){
  var a=($("#audAddr").value||"").trim().toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(a)){ msg("Paste a full 0x… address","warn"); return; }
  try{
    var r=await fetch("/audit?addr="+a,{headers:{"x-admin-key":KEY}});
    var d=await r.json(), m=d.mouvements||{};
    audAdr=a; $("#audFix").disabled=!(d.ecart>0);
    var l=[];
    l.push((d.ecart>0?"🔴 ":"✅ ")+d.diagnostic);
    l.push("");
    l.push("balance now        "+fmt(d.solde));
    l.push("deposits (journal) "+fmt(String(m.depots||0)));
    l.push("withdrawn          "+fmt(String(m.retraits||0)));
    l.push("sent to friends    "+fmt(String(m.envoye||0)));
    l.push("received           "+fmt(String(m.recu||0)));
    l.push("STAKED             "+fmt(String(m.stake||0))+"   ← locked, not lost");
    l.push("yield claimed      "+fmt(String(m.stakeClaim||0)));
    l.push("wagered            "+fmt(String(m.mise||0))+" over "+(m.manches||0)+" rounds");
    l.push("games result       "+fmt(String(m.resultatDesJeux||0)));
    if(m.reparations) l.push("already restored   "+fmt(String(m.reparations)));
    $("#audOut").textContent=l.join("\\n");
    $("#audOut").style.display="block";
  }catch(e){ msg("Check failed: "+e.message,"warn"); }
};
$("#audFix").onclick=async function(){
  if(!audAdr) return;
  if(!confirm("Restore the missing amount to "+audAdr+"? Only what the journal proves is credited.")) return;
  try{
    var r=await fetch("/repare?addr="+audAdr,{headers:{"x-admin-key":KEY}});
    var d=await r.json();
    if(d.error) throw new Error(d.error);
    msg("✅ Restored "+fmt(String(d.rendu))+" $SWOGE","ok");
    $("#audGo").onclick();
  }catch(e){ msg("Repair failed: "+e.message,"warn"); }
};

$("#burnGo").onclick=async function(){
  if(!signer){ msg("Connect your wallet first","warn"); return; }
  if(!(burnDu>0)){ msg("Nothing to burn","warn"); return; }
  var v=String(Math.floor(burnDu*1e6)/1e6);
  if(!confirm("Burn "+v+" $SWOGE forever? This sends them to "+$("#burnAddr").textContent+" and nobody can ever get them back.")) return;
  try{
    msg("Confirm the burn in your wallet…");
    var c=new ethers.Contract(VAULT,ABI,signer);
    var t=await c.ownerWithdraw($("#burnAddr").textContent, ethers.utils.parseUnits(v,18));
    msg("Sent, waiting for confirmation…");
    await t.wait();
    /* On ne previent le serveur QU APRES confirmation : il annonce le
       brulage au canal avec le hash, et une annonce sans transaction
       confirmee serait une promesse en l'air. */
    var r=await fetch("/burn?amount="+encodeURIComponent(v)+"&tx="+t.hash,{headers:{"x-admin-key":KEY}});
    var j=await r.json();
    if(!j.ok) throw new Error(j.error||"server refused the proof");
    msg("🔥 Burned "+v+" $SWOGE — announced on Telegram","ok");
    load();
  }catch(e){ msg("Burn failed: "+String(e.reason||e.message||e).slice(0,140),"warn"); }
};

$("#go").onclick=async function(){
  if(!signer){ msg("Connect your wallet first","warn"); return; }
  var v=($("#amt").value||"").replace(",",".").trim();
  var n=parseFloat(v); if(!(n>0)){ msg("Enter an amount","warn"); return; }
  if(n>surplusNum+0.0001){ if(!confirm("⚠️ "+n+" is MORE than the safe surplus ("+surplusNum.toFixed(2)+"). This can take player funds. Continue anyway?")) return; }
  try{
    msg("Confirm the transaction in your wallet…");
    var c=new ethers.Contract(VAULT,ABI,signer);
    var tx=await c.ownerWithdraw(myAddr, ethers.utils.parseUnits(v,18));
    msg("Sent, waiting for confirmation…");
    await tx.wait();
    msg("✅ Withdrawn "+n+" $SWOGE to your wallet","ok");
    $("#amt").value=""; load();
  }catch(e){ msg("Withdraw failed: "+String(e.reason||e.message||e).slice(0,120),"warn"); }
};
</script></body></html>`;
}

module.exports = { page };
