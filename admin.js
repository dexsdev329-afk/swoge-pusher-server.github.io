'use strict';
/*
 * Private owner dashboard (served at /admin?key=…). Shows vault pot, amount
 * owed to players, and the safe surplus, plus a one-click ownerWithdraw.
 * Access is gated by ADMIN_KEY (see server.js). Keep the URL private.
 */
const cfg = require('./config');

function page(csrf) {
  const V = cfg.VAULT_ADDRESS || '';
  const CHAIN_HEX = '0x' + Number(cfg.CHAIN_ID).toString(16);
  /* Le jeton anti-rejeu voyage DANS la page. Un site tiers ne peut pas lire
     cette page — la politique d origine le lui interdit — donc il ne peut pas
     l obtenir, et c est ce qui rend le jeton utile. */
  const TOK = String(csrf || '').replace(/[^a-f0-9]/gi, '');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SWOGE Vault — Admin</title>
<!-- Ethers vient de NOUS. Depuis un CDN, chaque ouverture envoyait a un tiers
     l adresse complete de la page dans l en-tete Referer — cle comprise, a
     l epoque ou elle y etait — et un CDN compromis executait son code sur la
     page qui signe les transactions du proprietaire. -->
<script src="/admin/ethers.js"></script>
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

  /* ============ LA COQUE ============
     Le panneau etait UN SEUL ROULEAU : quinze panneaux, quatre ecrans et demi
     sur ordinateur, sept et demi sur telephone. Pour regler un match on
     passait devant la restauration ; pour lire les comptes, devant le brulage.
     Et sur 1440 px de large, le contenu en occupait 760 — 47 % perdus pendant
     que l information manquait de place partout.

     Neuf entrees, une par moment d exploitation. La vue vit dans le #hash :
     un rafraichissement ne renvoie plus en haut de la page, et une vue se
     partage par son adresse. */
  body{max-width:none;padding:0;display:grid;grid-template-columns:216px 1fr;
       min-height:100vh;align-items:start}
  #nav{position:sticky;top:0;height:100vh;overflow-y:auto;background:#0F0C08;
       border-right:1px solid rgba(230,165,55,.18);padding:16px 0 24px;z-index:5}
  #nav .marque{padding:0 16px 14px;border-bottom:1px solid rgba(230,165,55,.12);margin-bottom:10px}
  #nav .marque b{color:#E6A537;font-size:14px;display:block}
  #nav .marque span{color:#8a7f6a;font-size:10.5px}
  #nav button{display:flex;width:100%;align-items:center;gap:9px;background:none;border:0;
       border-left:2px solid transparent;color:#c9bfa8;font:inherit;font-size:13px;
       padding:9px 16px;cursor:pointer;text-align:left}
  #nav button:hover{background:rgba(230,165,55,.06);color:#F7EEDA}
  #nav button.on{background:rgba(230,165,55,.10);color:#E6A537;border-left-color:#E6A537}
  #nav button .ic{width:17px;text-align:center;flex:0 0 auto}
  #nav button .bad{margin-left:auto;background:#E2483C;color:#fff;border-radius:9px;
       font-size:10px;padding:1px 6px;font-weight:700}
  #nav .sep{color:#6b6152;font-size:9.5px;letter-spacing:.14em;padding:14px 16px 5px;
       text-transform:uppercase}
  #nav .sortir{margin-top:14px;border-top:1px solid rgba(230,165,55,.12);padding-top:12px}
  #vue{padding:20px 22px 80px;max-width:1180px;min-width:0}
  #barre{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  #barre h1{margin:0}
  /* Trois etats, et la couleur n'est pas le seul signal : la pastille porte
     aussi un point plein, pour qui distingue mal le vert du rouge. */
  #nav #sante{display:flex;align-items:center;gap:8px;width:calc(100% - 24px);margin:0 12px 8px;
     padding:8px 11px;border-radius:9px;border:1px solid;background:rgba(255,255,255,.03);
     font:inherit;font-size:11.5px;cursor:pointer;text-align:left}
  #nav #sante .pt{width:7px;height:7px;border-radius:99px;flex:0 0 auto;background:currentColor}
  #nav #sante .tx{flex:1}
  #nav #sante.ok{color:#6FCF97;border-color:rgba(111,207,151,.35)}
  #nav #sante.moyen{color:#C9784A;border-color:rgba(201,120,74,.45)}
  #nav #sante.ko{color:#E2483C;border-color:rgba(226,72,60,.5);background:rgba(226,72,60,.08)}
  #nav #sante:hover{background:rgba(255,255,255,.07)}
  #ouvrenav{display:none}
  [data-vue]{display:none}
  [data-vue].vu{display:block}
  .vide{color:#8a7f6a;padding:24px 0;font-size:13px}
  /* Les cartes du haut n appartiennent qu a l apercu : elles etaient repetees
     au-dessus de tout, y compris au-dessus de la restauration. */
  #entete{display:none}
  #entete.vu{display:block}
  @media (max-width:900px){
    body{grid-template-columns:1fr}
    #nav{position:fixed;left:0;top:0;width:216px;transform:translateX(-100%);
         transition:transform .2s}
    #nav.ouvert{transform:none}
    #ouvrenav{display:inline-block;background:rgba(230,165,55,.12);border:1px solid rgba(230,165,55,.4);
         color:#E6A537;border-radius:8px;font:inherit;font-size:16px;padding:4px 11px;cursor:pointer}
    #vue{padding:14px 14px 70px}
  }
</style></head><body>
<nav id="nav">
  <div class="marque"><b>🐕 SWOGE</b><span>panneau d'exploitation</span></div>
  <!-- ---- L'ETAT DU SERVEUR, EN PERMANENCE ----
       /health existait, repondait, et n'etait affiche nulle part : il fallait
       connaitre l'adresse par coeur. Il devient une pastille toujours visible,
       en TETE de la barre — pas dans un onglet qu'on ouvre quand on a deja un
       doute. Cliquable : elle mene au detail. -->
  <button id="sante" type="button" class="ok"><span class="pt"></span><span class="tx">santé —</span></button>
  <div class="sep">tous les jours</div>
  <button data-go="apercu" class="on"><span class="ic">◉</span>Vue générale</button>
  <button data-go="joueurs"><span class="ic">👥</span>Joueurs</button>
  <button data-go="jeux"><span class="ic">🎲</span>Jeux &amp; paris<span class="bad" id="badAregler" style="display:none">0</span></button>
  <div class="sep">piloter</div>
  <button data-go="eco"><span class="ic">📊</span>Économie</button>
  <button data-go="collection"><span class="ic">🍎</span>Collection</button>
  <button data-go="engagement"><span class="ic">🔥</span>Engagement</button>
  <button data-go="liveops"><span class="ic">🎛️</span>Live Ops</button>
  <div class="sep">rarement</div>
  <button data-go="confiance"><span class="ic">🛡️</span>Confiance</button>
  <button data-go="sys"><span class="ic">⚙️</span>Système</button>
  <div class="sortir"><button id="sortir"><span class="ic">⏻</span>Se déconnecter</button></div>
</nav>
<main id="vue">
<div id="barre">
  <button id="ouvrenav" type="button" aria-label="Menu">☰</button>
  <h1>🐕 SWOGE Vault — Admin</h1>
</div>
<div class="muted">Private. Vault <code>${V || '(not set)'}</code></div>

<div id="entete">
<div class="cards">
  <div class="card"><span>In the vault</span><b id="pot">—</b></div>
  <div class="card"><span>Owed to players</span><b id="owed">—</b></div>
  <div class="card hl" id="surCard"><span>Safe surplus (withdrawable)</span><b id="surplus">—</b>
    <em id="surAlerte"></em></div>
</div>
<div class="sub">
  <b>Owed breakdown:</b> 💵 Balances <b id="ob">—</b> · 🔒 Staked <b id="os">—</b> · 📈 Yield <b id="oy">—</b> · 🎰 Jackpot reserve <b id="oj">—</b><br>
  <span id="maisonL" style="display:none">🏛️ <b>Held by house accounts</b> <b id="omz">—</b> <em id="omn"></em> — excluded from what is owed; these accounts cannot withdraw. <b>Without them the surplus would be <span id="omsur">—</span></b><br></span>
  👥 Players <b id="pl">—</b> · updated <span id="upd">—</span> · <a href="#" id="refresh">refresh</a>
</div>
</div><!-- /#entete -->

<div data-vue="sys" class="panel" id="autoCard">
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

<div data-vue="sys" class="panel">
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

<div data-vue="sys" class="panel" style="border-color:rgba(242,104,94,.45)">
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

<div data-vue="apercu" class="panel">
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

<div data-vue="eco" class="panel">
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

<div data-vue="joueurs" class="panel">
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

<div data-vue="joueurs" class="panel" style="margin-top:14px">
  <h2>&#128176; Credit a player</h2>
  <div class="sub" style="margin:0 0 10px">
    Straight to a player&rsquo;s balance &mdash; a goodwill gesture, a prize, a mistake to
    put right. Type the <b>player name</b> (or paste an address) and the amount.<br>
    <b>These tokens come from no deposit.</b> They raise what the house owes without
    adding anything to the vault, so they are capped:
    <b>${Math.floor(cfg.CREDIT_ADMIN_MAX).toLocaleString('en-GB')} $SWOGE per rolling
    ${cfg.CREDIT_ADMIN_FENETRE_H} h</b>, counted across <b>every</b> player. The envelope
    frees itself up as each send ages out &mdash; it is not a midnight reset.
  </div>
  <div id="crJauge"><div class="muted2">loading&hellip;</div></div>
  <input id="crQui" placeholder="player name, or 0x… address" autocomplete="off">
  <input id="crMontant" type="number" inputmode="numeric" min="1"
         step="1" placeholder="amount in $SWOGE">
  <input id="crNote" maxlength="120" autocomplete="off"
         placeholder="what it is for (optional — the player sees it in their history)">
  <div class="row">
    <button class="ghost" id="crMax">Fill what is left</button>
    <button id="crGo">Send →</button>
    <span id="crMsg" style="font-size:12.5px;align-self:center"></span>
  </div>
  <div id="crDerniers" style="margin-top:11px"></div>
  <style>
    /* La jauge et la barre de temps repondent a deux questions differentes :
       « combien reste-t-il » et « quand est-ce que ca revient ». Une seule
       barre pour les deux ferait croire que l'enveloppe se vide avec le
       temps, alors que c'est l'inverse — elle se REMPLIT en vieillissant. */
    .crb{ height:9px; border-radius:6px; background:rgba(255,255,255,.09);
      overflow:hidden; margin:5px 0 3px; }
    .crb i{ display:block; height:100%; border-radius:6px;
      background:linear-gradient(90deg,#7CFF9B,#E6A537); transition:width .4s; }
    .crb.plein i{ background:linear-gradient(90deg,#F2685E,#FF8A5B); }
    .crb.t i{ background:linear-gradient(90deg,#5AA9E6,#7CFF9B); }
    .crl{ font-size:11.5px; color:#8a7f6a; line-height:1.6; }
    .crl b{ color:#F7EEDA; }
    .crl .p{ color:#F2685E; }
    .crd{ font-size:11.5px; color:#8a7f6a; line-height:1.7; }
    .crd b{ color:#F7EEDA; }
  </style>
</div>

<div data-vue="sys" class="panel">
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

<div data-vue="sys" class="panel">
  <h2>🏧 Owner withdraw</h2>
  <input id="amt" type="number" inputmode="decimal" placeholder="amount in $SWOGE">
  <div class="row">
    <button class="ghost" id="max">Fill safe surplus</button>
    <button class="ghost" id="conn">Connect owner wallet</button>
    <button id="go" disabled>Withdraw →</button>
  </div>
  <div id="msg"></div>
</div>

<!-- ================= CE QUI EST JOUE =================
     C'etait /usage : une page HTML separee, referencee nulle part, qu'il
     fallait connaitre par coeur. Les chiffres n'ont pas change de source —
     memes usageJours() et usageJour() — ils ont change d'endroit. -->
<div data-vue="jeux" class="panel">
  <h2>🎲 Ce qui est joué</h2>
  <div class="sub" style="margin:0 0 10px">
    Par jeu et par jour : combien de manches, combien de joueurs, ce qui est misé et ce que la maison garde.
    Le <b>retour</b> est le RTP réellement constaté — c'est lui qu'on compare au RTP annoncé.
  </div>
  <div class="tri" id="usJours" style="margin:0 0 10px">Sur</div>
  <div id="usCorps"><div class="muted2">chargement…</div></div>
</div>

<div data-vue="jeux" class="panel" style="margin-top:14px">
  <h2>&#127916; Cinema &mdash; SWOGE FLIX</h2>
  <div class="sub" style="margin:0 0 10px">
    What plays on the screen in the Nexus cinema. Leave the title empty to take
    the show down &mdash; the screen goes back to announcing there is nothing on.
    <br><b>Only http:// and https:// addresses are accepted.</b> These end up in
    an iframe on every player's page; anything else is refused by the server.
  </div>
  <input id="cineTitre" placeholder="Title shown on the screen and in the room">
  <input id="cineAff" placeholder="Poster image URL (portrait) — optional">
  <input id="cineVf" placeholder="VF player URL">
  <input id="cineVo" placeholder="VO player URL">
  <div class="row" style="margin-top:4px">
    <button class="ghost" id="cineGo">Save the show</button>
    <span id="cineMsg" style="font-size:12px"></span>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <h2>&#128225; Fixture feed</h2>
  <div class="sub" style="margin:0 0 10px">
    Where the calendar comes from. Fixtures cost <b>no credits</b> at all
    (<code>/events</code> is free), so the button below can be pressed as often
    as you like &mdash; only scores and calibration spend quota.
  </div>
  <div id="impBody"><div class="muted2">loading&hellip;</div></div>
  <div class="row" style="margin-top:10px">
    <button class="ghost" id="impGo">Fetch fixtures now (0 credits)</button>
    <span id="impMsg" style="font-size:12px"></span>
  </div>
  <style>
    .impg{ display:grid; gap:7px; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
    .impc{ padding:9px 11px; border-radius:11px; background:rgba(255,255,255,.05);
      border:1px solid var(--line); }
    .impc span{ display:block; font-size:10.5px; color:#8a7f6a; text-transform:uppercase;
      letter-spacing:.5px; }
    .impc b{ font-size:15px; }
    .impbad{ color:#F2685E; } .impok{ color:#7CFF9B; } .impwarn{ color:#E7C97A; }
    .impl{ font-size:11.5px; color:#B9C8E4; margin-top:9px; line-height:1.6;
      overflow-wrap:anywhere; }
  </style>
</div>

<div data-vue="jeux" class="panel" style="margin-top:14px">
  <h2>&#9203; Matches waiting for a result</h2>
  <div class="sub" style="margin:0 0 10px">
    Kick-off has passed, bets are riding on it, and nothing has been decided.
    <b>While this list is not empty, players are waiting to be paid.</b><br>
    Each button shows what <b>that</b> outcome pays out. One combined total
    would tell you nothing &mdash; it is the gap between outcomes that lets you
    catch a wrong result before it pays.<br>
    <b>Settling cannot be undone.</b> Check the score, then click.
  </div>
  <div id="argBody"><div class="muted2">loading&hellip;</div></div>
  <style>
    .arg{ padding:11px 12px; margin-bottom:9px; border-radius:12px;
      background:rgba(255,154,61,.07); border:1px solid rgba(255,154,61,.3); }
    .arg.vieux{ background:rgba(242,104,94,.09); border-color:rgba(242,104,94,.45); }
    .arg h4{ margin:0 0 3px; font-size:13.5px; }
    .arg .meta{ font-size:11.5px; color:#8a7f6a; margin-bottom:9px; }
    .arg .row{ gap:7px; flex-wrap:wrap; }
    /* Chaque bouton porte SON exposition : on ne clique pas « 1 », on clique
       « Home, et ca coute 4 738 ». Le chiffre est sur le bouton, pas dans un
       tableau a cote — c'est la seule facon qu'il soit lu. */
    .arg button{ display:flex; flex-direction:column; align-items:flex-start;
      gap:2px; padding:8px 12px; min-width:104px; line-height:1.25; }
    .arg button small{ font-weight:600; opacity:.8; font-size:10.5px; }
    .arg .rmb{ background:rgba(255,255,255,.08); color:#EAF2FF;
      border:1px solid rgba(255,255,255,.18); }
    /* Hors calendrier : l'avertissement doit se voir AVANT les boutons, pas
       se deviner apres coup. */
    .arg.hors{ background:rgba(242,104,94,.09); border-color:rgba(242,104,94,.45); }
    .arg .argh{ font-size:11.5px; color:#F2685E; margin:-4px 0 9px; line-height:1.35; }
    .argok{ color:#7CFF9B; } .argko{ color:#F2685E; }
  </style>
</div>

<div data-vue="jeux" class="panel" style="margin-top:14px">
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

<div data-vue="collection" class="panel" style="margin-top:14px">
  <h2>&#127822; The fruit collection</h2>
  <div class="sub" style="margin:0 0 10px">
    What is left of the edition, and who holds it. Every number here comes from the
    global mint register &mdash; the same one that stops a chest from going over the cap.
  </div>
  <div class="row"><button class="ghost" id="btGo">Load</button>
    <span id="btResume" style="align-self:center;color:#8DA0C4;font-size:12px"></span></div>
  <div id="btOut" style="margin-top:10px"></div>
</div>

<div data-vue="joueurs" class="panel" style="margin-top:14px">
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
    /* Le bilan des paris : des cases, pas un tableau. Il n'a pas de lignes —
       c'est un seul jeu, decrit par huit chiffres — et une grille tient sur
       un telephone la ou un tableau de huit colonnes ne tient pas. */
    .det-paris{ margin-top:12px; padding-top:11px; border-top:1px solid rgba(255,255,255,.09); }
    .dp-g{ display:grid; gap:7px; grid-template-columns:repeat(auto-fit,minmax(112px,1fr)); }
    .dp-g div{ padding:7px 9px; border-radius:10px; background:rgba(255,255,255,.05);
      border:1px solid rgba(230,165,55,.22); }
    .dp-g i{ display:block; font-style:normal; font-size:10px; color:#8a7f6a;
      text-transform:uppercase; letter-spacing:.5px; margin-bottom:2px; }
    .dp-g b{ font-size:14px; }
    .dp-g .haut{ color:#F2685E; } .dp-g .bas{ color:#7CFF9B; }

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

<div data-vue="sys" class="panel" style="margin-top:14px">
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

<!-- ================= L ETAT DU SERVEUR =================
     Troisieme surface d administration rattachee : /health repondait deja
     tout ce qu il y a ici, et personne ne le lisait. -->
<div data-vue="sys" class="panel" id="santePan">
  <h2>💓 État du serveur</h2>
  <div class="sub" style="margin:0 0 12px">
    La pastille de la barre latérale lit ceci toutes les minutes. <b>503</b> quand quelque chose de grave
    se passe — c'est le code que les services de surveillance savent lire.
  </div>
  <div id="santeCorps"><div class="muted2">chargement…</div></div>
</div>

<!-- ================= LA FICHE JOUEUR =================
     Le panneau n avait qu une ligne depliable dans la table. « Je n ai pas
     recu mon gain » n avait donc pas de reponse en moins de dix minutes — le
     message le plus frequent qu un exploitant recoit, et celui que le panneau
     soutenait le moins. Tout ce qu il faut pour repondre tient ici. -->
<div data-vue="joueur" class="panel" id="fichePan">
  <h2>👤 <span id="fiNom">Joueur</span> <a href="#joueurs" style="font-size:12px;color:#8a7f6a;font-weight:400">← retour à la liste</a></h2>
  <div id="fiCorps"><div class="muted2">chargement…</div></div>
</div>

<!-- ================= ENGAGEMENT ================= -->
<div data-vue="engagement" class="panel">
  <h2>🔥 Ce qui fait revenir</h2>
  <div class="sub" style="margin:0 0 12px">Les quêtes, les séries, le coffre offert, les parrainages — et les compteurs de clics,
    qui étaient <b>collectés depuis des jours sans que personne puisse les lire</b>.</div>
  <div id="engCorps"><div class="muted2">chargement…</div></div>
</div>

<div data-vue="engagement" class="panel" style="margin-top:14px">
  <h2>👆 Où les gens appuient</h2>
  <div class="sub" style="margin:0 0 12px">Menu, barre du bas, jeux. C'est ce qui dit dans quel ordre ranger les boutons —
    par l'usage, pas par l'intuition.</div>
  <div id="tapsCorps"><div class="muted2">chargement…</div></div>
</div>

<!-- ================= CONFIANCE ================= -->
<div data-vue="confiance" class="panel">
  <h2>📜 Journal des actions admin</h2>
  <div class="sub" style="margin:0 0 12px">
    En <b>ajout seul</b>, jamais purgé, et <b>hors de state.json</b> — une restauration ne peut donc pas
    effacer la ligne qui prouve qu'elle a eu lieu.
  </div>
  <div class="row" style="margin-bottom:10px">
    <input id="alQ" placeholder="chercher une adresse, un motif, un geste…" style="flex:1">
    <select id="alAction" style="max-width:190px"><option value="">tous les gestes</option></select>
  </div>
  <div id="alCorps"><div class="muted2">chargement…</div></div>
</div>

<!-- ================= LIVE OPS ================= -->
<div data-vue="liveops" class="panel">
  <h2>🎛️ Réglages à chaud</h2>
  <div class="sub" style="margin:0 0 12px">
    Avant, changer un prix de coffre ou une récompense imposait de modifier une variable chez l'hébergeur et de
    <b>redémarrer — ce qui coupe toutes les parties en cours</b>. Ces clés-là se règlent sans rien couper.
    <b>Remettre à vide</b> restaure la valeur d'origine.<br>
    Les fondations — adresse du coffre, clé admin, chaîne, clé du signataire — ne sont pas dans cette liste et
    ne peuvent pas l'être.
  </div>
  <div id="rgMsg" class="sub" style="margin:0 0 10px"></div>
  <div id="rgCorps"><div class="muted2">chargement…</div></div>
</div>

<script>
/* ---- LA CLE A DISPARU D ICI ----
 *
 * 'KEY' etait lue dans l adresse et rejointe a chaque appel. Elle ne l est
 * plus : le cookie de session fait le travail, le navigateur le joint tout
 * seul, et aucun script — pas meme celui-ci — ne peut le lire.
 *
 * Il reste 'TOK', le jeton anti-rejeu. Il n ouvre rien a lui seul : sans le
 * cookie il ne vaut rien, et sans lui le cookie ne peut rien ECRIRE. Il faut
 * les deux, et un site tiers n a ni l un ni l autre. */
var TOK="${TOK}";
/* 'KEY' reste declaree et vide : une quinzaine d appels la mentionnent encore
   en en-tete, et un en-tete vide est simplement ignore. La retirer partout
   d un coup, c est quinze occasions d en oublier une. */
var KEY="";
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

/* ================= ECRIRE =================
 *
 * Un seul chemin pour tout ce qui change quelque chose. Il pose la methode, le
 * jeton et le corps ; le reste du fichier n a plus a y penser, donc plus a
 * l oublier. Avant, chaque geste construisait son adresse a la main — c est
 * comme ca que '?montant=' et '?addr=' se retrouvaient dans les journaux.
 */
async function post(route, corps){
  var r = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": TOK },
    body: JSON.stringify(corps || {}),
  });
  var d = null;
  try { d = await r.json(); } catch(e) { d = { error: "reponse illisible ("+r.status+")" }; }
  if (r.status === 401) { location.href = "/admin"; throw new Error("session expiree"); }
  if (!r.ok && !d.error) d.error = "echec ("+r.status+")";
  return d;
}
async function lit(route){
  var r = await fetch(route, { headers:{ "x-admin-key": KEY } });
  if (r.status === 401) { location.href = "/admin"; throw new Error("session expiree"); }
  return r.json();
}

/* ================= LA COQUE =================
 *
 * La vue vit dans le #hash : le rafraichissement ne renvoie plus en haut, et
 * une vue se partage par son adresse. Les panneaux ne sont pas detruits, ils
 * sont montres ou caches — leurs chargeurs continuent donc de tourner, et
 * revenir sur un onglet ne le laisse pas vide une seconde.
 */
var VUE = "apercu";
function vaVers(v, arg){
  VUE = v || "apercu";
  document.querySelectorAll("[data-vue]").forEach(function(e){
    e.classList.toggle("vu", e.getAttribute("data-vue") === VUE);
  });
  /* Les cartes de solvabilite n appartiennent qu a la vue generale. Repetees
     au-dessus de tout, elles poussaient le contenu utile vers le bas et
     surmontaient jusqu a la restauration. */
  $("#entete").classList.toggle("vu", VUE === "apercu");
  document.querySelectorAll("#nav button[data-go]").forEach(function(b){
    b.classList.toggle("on", b.getAttribute("data-go") === VUE ||
                            (VUE === "joueur" && b.getAttribute("data-go") === "joueurs"));
  });
  $("#nav").classList.remove("ouvert");
  window.scrollTo(0, 0);
  if (VUE === "joueur" && arg) chargeFiche(arg);
  if (VUE === "engagement") { chargeEngagement(); chargeTaps(); }
  if (VUE === "confiance") chargeJournal();
  if (VUE === "liveops") chargeReglages();
  if (VUE === "sys") peintSante();
  if (VUE === "jeux") chargeUsage();
}
function duHash(){
  var h = (location.hash || "#apercu").slice(1);
  var i = h.indexOf("/");
  return i < 0 ? { v: h, arg: null } : { v: h.slice(0, i), arg: h.slice(i + 1) };
}
window.addEventListener("hashchange", function(){ var d = duHash(); vaVers(d.v, d.arg); });
document.querySelectorAll("#nav button[data-go]").forEach(function(b){
  b.addEventListener("click", function(){ location.hash = b.getAttribute("data-go"); });
});
$("#ouvrenav").addEventListener("click", function(){ $("#nav").classList.toggle("ouvert"); });
$("#sortir").addEventListener("click", async function(){
  await fetch("/admin/logout", { method:"POST" });
  location.href = "/admin";
});
/* ---- LA PREMIERE ROUTE ----
 *
 * Sans cet appel, vaVers n etait declenche QUE par un changement de hash :
 * a l ouverture, aucun panneau ne portait la classe qui le montre et la page
 * s affichait VIDE. Le routeur marchait, il n avait simplement jamais ete
 * demarre. Trouve par la mesure — la page se chargeait sans une erreur. */
(function(){ var d = duHash(); vaVers(d.v, d.arg); })();

/* La pastille de sante. /health existait, repondait, et n etait affichee nulle
   part : il fallait connaitre l adresse par coeur. */
var SANTE = null;
async function chargeSante(){
  var e = $("#sante"), t = e.querySelector(".tx");
  try {
    var r = await fetch("/health");
    var d = await r.json();
    SANTE = d;
    /* TROIS etats, pas deux. Le serveur peut repondre « ok » tout en signalant
       des remarques — des ecritures ratees, des exceptions comptees. Les
       ranger avec « tout va bien » cache exactement ce qui prevenait avant la
       panne ; les ranger avec « panne » ferait crier au loup. */
    var n = (d.remarques || []).length;
    e.className = !d.ok ? "ko" : (n ? "moyen" : "ok");
    t.textContent = !d.ok ? "incident serveur"
                  : (n ? n + " remarque" + (n > 1 ? "s" : "") : "serveur en bonne santé");
    e.title = "Cliquer pour le détail";
  } catch(err) {
    SANTE = { ok:false, erreur:String(err.message) };
    e.className = "ko"; t.textContent = "serveur injoignable";
  }
  if (VUE === "sys") peintSante();
}
function peintSante(){
  var c = $("#santeCorps"); if (!c) return;
  var d = SANTE;
  if (!d) { c.innerHTML = '<div class="muted2">chargement…</div>'; return; }
  var duree = function(s){ if (s == null) return "—";
    if (s < 90) return Math.round(s) + " s";
    if (s < 5400) return Math.round(s/60) + " min";
    return (s/3600).toFixed(1) + " h"; };
  var h = '';
  if (d.remarques && d.remarques.length) {
    h += '<div style="border:1px solid rgba(201,120,74,.45);background:rgba(201,120,74,.08);' +
      'border-radius:8px;padding:12px 14px;margin-bottom:13px">' +
      '<div style="color:#C9784A;font-size:11px;letter-spacing:.12em;text-transform:uppercase;' +
      'margin-bottom:7px">ce qui mérite un oeil</div>' +
      d.remarques.map(function(x){ return '<div style="font-size:12.5px;color:#F7EEDA">• '+esc(String(x))+'</div>'; }).join('') +
      '</div>';
  }
  if (d.graves && d.graves.length) {
    h += '<div style="border:1px solid rgba(226,72,60,.5);background:rgba(226,72,60,.09);' +
      'border-radius:8px;padding:12px 14px;margin-bottom:13px">' +
      '<div style="color:#E2483C;font-size:11px;letter-spacing:.12em;text-transform:uppercase;' +
      'margin-bottom:7px">grave</div>' +
      d.graves.map(function(x){ return '<div style="font-size:12.5px;color:#F7EEDA">• '+esc(String(x))+'</div>'; }).join('') +
      '</div>';
  }
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">' +
    bloc('Le processus',
      ln('En marche depuis', duree(d.depuis)) +
      ln('Mémoire', (d.memoireMo != null ? d.memoireMo + ' Mo' : '—')) +
      ln('Retard de boucle', (d.retardBoucleMs != null ? d.retardBoucleMs + ' ms' : '—'),
         d.retardBoucleMs > 2000 ? '#C9784A' : '#F7EEDA')) +
    bloc('Ce qui compte',
      ln('Joueurs en mémoire', String(d.joueurs != null ? d.joueurs : '—')) +
      ln('Dernière écriture', duree(d.ecritureDepuisSec),
         d.ecritureDepuisSec > 600 ? '#E2483C' : '#F7EEDA') +
      ln('Écritures ratées', String(d.ecrituresRatees || 0),
         d.ecrituresRatees ? '#E2483C' : '#6FCF97')) +
    bloc('La chaîne',
      ln('Dernier bloc vu', duree(d.chaineDepuisSec)) +
      ln('Incidents (10 min)', String(d.incidents10min || 0),
         d.incidents10min ? '#C9784A' : '#6FCF97')) +
    '</div>';
  c.innerHTML = h;
}
chargeSante(); setInterval(chargeSante, 60000);
/* La pastille MENE quelque part. Un voyant qu'on ne peut pas interroger
   n'apprend que la moitie de ce qu'il sait. */
$("#sante").addEventListener("click", function(){ location.hash = "sys"; });

/* ================= LA FICHE JOUEUR ================= */
function ln(k,v,c){ return '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;'+
  'border-bottom:1px solid rgba(230,165,55,.08)"><span style="color:#8a7f6a;font-size:12px">'+k+
  '</span><b style="font-size:12.5px;color:'+(c||'#F7EEDA')+'">'+v+'</b></div>'; }
function bloc(t,inner){ return '<div style="background:rgba(255,255,255,.03);border:1px solid rgba(230,165,55,.12);'+
  'border-radius:8px;padding:13px 15px"><div style="color:#E6A537;font-size:11px;letter-spacing:.12em;'+
  'text-transform:uppercase;margin-bottom:8px">'+t+'</div>'+inner+'</div>'; }
function dt(ms){ if(!ms) return 'inconnu'; var d=new Date(ms); return d.toISOString().slice(0,10); }

async function chargeFiche(addr){
  var c=$("#fiCorps"); c.innerHTML='<div class="muted2">chargement…</div>';
  var f;
  try { f = await lit("/player?addr="+encodeURIComponent(addr)); }
  catch(e){ c.innerHTML='<div class="muted2">'+esc(String(e.message))+'</div>'; return; }
  if(!f || f.error){ c.innerHTML='<div class="muted2">'+esc((f&&f.error)||'introuvable')+'</div>'; return; }
  $("#fiNom").textContent=(f.name||short(f.address))+(f.maison?' 🏛️':'');
  var a=f.argent, p=f.progression, e=f.engagement;
  /* Le NET d abord, et en couleur : c est le seul chiffre qui reponde a
     « d ou vient cet argent ». Fortement positif sans mise correspondante,
     c est une entree qui ne vient pas du jeu. */
  var netN=num(a.net);
  var h='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px">';
  h+=bloc('Identité',
      ln('Adresse','<span style="font-size:10.5px">'+esc(f.address)+'</span>')+
      ln('Inscrit le', f.creeLe? dt(f.creeLe) : '<span style="color:#8a7f6a">avant que ce soit noté</span>')+
      ln('Dernier jour actif', f.dernierJour||'—')+
      ln('Telegram', f.tgId? esc(String(f.tgId)) : '—')+
      ln('Nom payé', f.nomPaye?'oui':'non'));
  h+=bloc('Argent',
      ln('Solde',fmt(a.balance))+ln('Staké',fmt(a.staked))+ln('Rendement en attente',fmt(a.pending))+
      ln('Déposé',fmt(a.deposited))+ln('Retiré',fmt(a.withdrawn))+
      ln('Joué à vie',fmt(a.wagered)+' · '+a.bets+' mises')+
      ln('<b>Net</b> (détenu + sorti − mis)',fmt(a.net), netN>0?'#E2483C':'#6FCF97'));
  h+=bloc('Progression',
      ln('Niveau',String(p.niveau&&p.niveau.n!=null?p.niveau.n:(p.niveau||'—')))+
      ln('XP totale',String(p.xp))+ln('dont gagnée',String(p.xpGagnee))+
      ln('Collection',p.collection.a+' / '+p.collection.sur)+
      ln('Familles complètes',String(p.familles.filter(function(x){return x.complete;}).length))+
      ln('Rachat instantané', p.rachatOuvert&&p.rachatOuvert.ouvert?'ouvert':
         ('verrouillé — '+fmt(String(p.rachatOuvert?p.rachatOuvert.reste:0))+' à jouer'),
         p.rachatOuvert&&p.rachatOuvert.ouvert?'#6FCF97':'#C9784A'));
  h+=bloc('Engagement',
      ln('Série',String(e.streakDay)+' jour(s)')+
      ln('Coffre du jour', e.coffreOffert&&e.coffreOffert.dispo?'à prendre':'pris ou indisponible')+
      ln('Quêtes du jour', e.quetes.filter(function(q){return q.claimed;}).length+' / '+e.quetes.length+' réclamées')+
      ln('Amis',String(e.amis))+ln('Filleuls',String(e.filleuls))+
      ln('Gains de parrainage',fmt(e.refTotal)));
  h+='</div>';

  /* Les familles, en une ligne : c est ce qu on regarde quand quelqu un dit
     « il me manque une piece ». */
  h+='<div style="margin-top:14px">'+bloc('Collection par famille',
      '<div style="display:flex;flex-wrap:wrap;gap:6px">'+p.familles.map(function(x){
        return '<span style="font-size:11px;padding:3px 9px;border-radius:99px;border:1px solid '+
          (x.complete?'#6FCF97':'rgba(255,255,255,.14)')+';color:'+(x.complete?'#6FCF97':'#c9bfa8')+'">'+
          esc(x.nom)+' '+x.a+'/'+x.sur+'</span>';
      }).join('')+'</div>')+'</div>';

  /* LE JOURNAL DU JOUEUR. Il existait dans journal.js et rien ne l affichait :
     c est pourtant lui qui repond a « je n ai pas recu mon gain ». */
  var ev=(f.journal&&f.journal.evenements)||[];
  h+='<div style="margin-top:14px">'+bloc('Son historique — '+ev.length+' ligne(s)',
      ev.length? '<div style="max-height:340px;overflow:auto;font-size:11.5px">'+ev.map(function(x){
        return '<div style="display:flex;gap:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+
          '<span style="color:#8a7f6a;flex:0 0 128px">'+esc(new Date(x.t||0).toISOString().slice(0,16).replace('T',' '))+'</span>'+
          '<span style="color:#E6A537;flex:0 0 40px">'+esc(String(x.k||'?'))+'</span>'+
          '<span style="color:#c9bfa8;flex:1;word-break:break-all">'+esc(JSON.stringify(x).slice(0,200))+'</span></div>';
      }).join('')+'</div>'
      : '<div class="muted2">rien dans son journal</div>')+'</div>';
  c.innerHTML=h;
}

/* ================= CE QUI EST JOUE ================= */
var US_JOURS = 7, US_PRET = false;
async function chargeUsage(){
  var c = $("#usCorps");
  if (!US_PRET) {
    US_PRET = true;
    var z = $("#usJours");
    [1, 7, 14, 30].forEach(function(n){
      var b = document.createElement("button");
      b.type = "button"; b.textContent = n === 1 ? "aujourd hui" : n + " jours";
      if (n === US_JOURS) b.className = "on";
      b.addEventListener("click", function(){
        US_JOURS = n;
        [].forEach.call(z.querySelectorAll("button"), function(x){ x.classList.toggle("on", x === b); });
        chargeUsage();
      });
      z.appendChild(b);
    });
  }
  try {
    var d = await lit("/usage.json?jours=" + US_JOURS);
    if (!d.jours.length) {
      c.innerHTML = '<div class="muted2">Rien encore. La mesure commence au premier tour joué après ' +
        'le déploiement — elle ne peut pas raconter le passé.</div>';
      return;
    }
    var h = '<div style="font-size:11.5px;color:#8a7f6a;margin-bottom:10px">' +
      d.joursConnus + ' jour(s) enregistré(s)</div>';
    d.jours.forEach(function(j){
      h += '<div style="margin-bottom:18px">' +
        '<div style="color:#E6A537;font-size:12px;margin-bottom:6px">' + esc(j.jour) + '</div>' +
        '<div style="overflow-x:auto"><table style="min-width:600px"><thead><tr>' +
        '<th>jeu</th><th style="text-align:right">manches</th><th style="text-align:right">joueurs</th>' +
        '<th style="text-align:right">misé</th><th style="text-align:right">retour</th>' +
        '<th style="text-align:right">net maison</th></tr></thead><tbody>';
      j.lignes.forEach(function(x){
        /* Un retour au-dessus de 100 % veut dire que le jeu a rendu plus qu il
           n a pris ce jour-la. Sur une journee c est du bruit ; sur plusieurs,
           c est une faille. La couleur le signale sans l affirmer. */
        var haut = x.retour !== null && x.retour > 100;
        h += '<tr><td><b>' + esc(x.jeu) + '</b></td>' +
          '<td class="num" style="text-align:right">' + ent(x.manches) + '</td>' +
          '<td class="num" style="text-align:right">' + ent(x.joueurs) + (x.auDela ? '+' : '') + '</td>' +
          '<td class="num" style="text-align:right">' + fmt(x.mise) + '</td>' +
          '<td class="num" style="text-align:right;color:' + (haut ? '#C9784A' : '#8a7f6a') + '">' +
            (x.retour === null ? '—' : x.retour + ' %') + '</td>' +
          '<td class="num" style="text-align:right;color:' + (x.net >= 0 ? '#6FCF97' : '#E2483C') + '">' +
            fmt(x.net) + '</td></tr>';
      });
      h += '<tr style="border-top:1px solid rgba(230,165,55,.25)"><td><b>tout</b></td>' +
        '<td class="num" style="text-align:right"><b>' + ent(j.total.manches) + '</b></td><td></td>' +
        '<td class="num" style="text-align:right"><b>' + fmt(j.total.mise) + '</b></td><td></td>' +
        '<td class="num" style="text-align:right;color:' + (j.total.net >= 0 ? '#6FCF97' : '#E2483C') +
        '"><b>' + fmt(j.total.net) + '</b></td></tr>';
      h += '</tbody></table></div></div>';
    });
    c.innerHTML = h;
  } catch(e){ c.innerHTML = '<div class="muted2">' + esc(String(e.message)) + '</div>'; }
}

/* ================= ENGAGEMENT ================= */
async function chargeEngagement(){
  var c=$("#engCorps");
  try {
    var d = await lit("/players?limit=1000");
    var l = d.players||[];
    var actifs = l.filter(function(p){return p.dernierJour;}).length;
    var avecSerie = l.filter(function(p){return p.streak>0;}).length;
    var avecColl = l.filter(function(p){return p.objets>0;}).length;
    var niv = l.map(function(p){return (p.niveau&&p.niveau.n)||0;}).sort(function(a,b){return a-b;});
    var median = niv.length? niv[Math.floor(niv.length/2)] : 0;
    c.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">'+
      bloc('Joueurs', ln('Fiches',String(l.length))+ln('Vus au moins un jour',String(actifs))+
                      ln('Avec une série en cours',String(avecSerie)))+
      bloc('Progression', ln('Niveau médian',String(median))+
                      ln('Ont au moins un fruit',String(avecColl))+
                      ln('XP médiane',String(l.length? l.map(function(p){return p.xp||0;})
                          .sort(function(a,b){return a-b;})[Math.floor(l.length/2)] : 0)))+
      '</div>';
  } catch(e){ c.innerHTML='<div class="muted2">'+esc(String(e.message))+'</div>'; }
}

/* ================= LES COMPTEURS DE CLICS =================
 *
 * Servis par /taps, calcules par tapsAdmin(), et jamais appeles par cette
 * page : la donnee etait collectee et personne ne pouvait la lire. */
async function chargeTaps(){
  var c=$("#tapsCorps");
  try {
    var d = await lit("/taps");
    var noms={menu:'Menu du profil',bar:'Barre du bas',jeu:'Jeux'};
    var h='';
    Object.keys(noms).forEach(function(f){
      var g=d[f]; if(!g||!g.lignes||!g.lignes.length) return;
      h+='<div style="margin-bottom:16px"><div style="color:#E6A537;font-size:11px;letter-spacing:.12em;'+
        'text-transform:uppercase;margin-bottom:7px">'+noms[f]+' — '+g.total.toLocaleString('en-US')+' appuis</div>';
      g.lignes.forEach(function(x){
        h+='<div style="display:flex;align-items:center;gap:9px;padding:3px 0;font-size:12px">'+
          '<span style="flex:0 0 150px;color:#c9bfa8">'+esc(x.cle)+'</span>'+
          '<span style="flex:1;background:rgba(255,255,255,.06);height:9px;border-radius:99px;overflow:hidden">'+
            '<span style="display:block;height:100%;width:'+Math.max(1,x.pct)+'%;background:#E6A537"></span></span>'+
          '<span style="flex:0 0 92px;text-align:right;color:#8a7f6a">'+x.n.toLocaleString('en-US')+' · '+x.pct+'%</span></div>';
      });
      h+='</div>';
    });
    c.innerHTML = h || '<div class="muted2">personne n a encore appuyé sur rien — les compteurs partent de zéro</div>';
  } catch(e){ c.innerHTML='<div class="muted2">'+esc(String(e.message))+'</div>'; }
}

/* ================= LE JOURNAL ADMIN ================= */
var alQ='', alAct='';
async function chargeJournal(){
  var c=$("#alCorps");
  try {
    var d = await lit("/adminlog?limite=200"+(alQ?"&q="+encodeURIComponent(alQ):"")+
                      (alAct?"&action="+encodeURIComponent(alAct):""));
    var sel=$("#alAction");
    if(sel.options.length<=1 && d.actions){
      d.actions.forEach(function(a){ var o=document.createElement('option'); o.value=a; o.textContent=a; sel.appendChild(o); });
    }
    if(!d.lignes.length){ c.innerHTML='<div class="muted2">aucune ligne'+(alQ||alAct?' pour ce filtre':' — rien n a encore été fait')+'</div>'; return; }
    c.innerHTML='<div style="font-size:11.5px;color:#8a7f6a;margin-bottom:8px">'+d.total+
      ' ligne(s) sur '+d.totalBrut+' au total</div>'+
      '<div style="overflow-x:auto"><table style="min-width:720px"><thead><tr>'+
      '<th>quand</th><th>qui</th><th>geste</th><th>cible</th><th>avant → après</th><th>motif</th></tr></thead><tbody>'+
      d.lignes.map(function(x){
        return '<tr><td style="white-space:nowrap;font-size:11px">'+
          esc(new Date(x.t).toISOString().slice(0,16).replace('T',' '))+'</td>'+
          '<td style="font-size:11px">'+esc(x.acteur||'')+'</td>'+
          '<td><b style="color:#E6A537">'+esc(x.action)+'</b></td>'+
          '<td class="addr" style="word-break:break-all">'+esc(x.cible||'—')+'</td>'+
          '<td style="font-size:11px">'+(x.avant!=null||x.apres!=null?
            esc(String(x.avant))+' → <b>'+esc(String(x.apres))+'</b>':'—')+'</td>'+
          '<td style="font-size:11px;color:#c9bfa8">'+esc(x.motif||'')+'</td></tr>';
      }).join('')+'</tbody></table></div>';
  } catch(e){ c.innerHTML='<div class="muted2">'+esc(String(e.message))+'</div>'; }
}
$("#alQ").addEventListener("input", function(){ alQ=this.value.trim(); chargeJournal(); });
$("#alAction").addEventListener("change", function(){ alAct=this.value; chargeJournal(); });

/* ================= LIVE OPS ================= */
async function chargeReglages(){
  var c=$("#rgCorps");
  try {
    var d = await lit("/reglages");
    c.innerHTML='<div style="overflow-x:auto"><table style="min-width:760px"><thead><tr>'+
      '<th>réglage</th><th>ce que ça fait</th><th style="text-align:right">en vigueur</th>'+
      '<th style="text-align:right">valeur de départ</th><th>changer</th></tr></thead><tbody>'+
      d.reglages.map(function(r){
        return '<tr'+(r.surcharge?' style="background:rgba(230,165,55,.07)"':'')+'>'+
          '<td><b style="color:'+(r.surcharge?'#E6A537':'#F7EEDA')+'">'+esc(r.cle)+'</b>'+
          (r.surcharge?'<div style="font-size:10px;color:#C9784A">surchargé</div>':'')+'</td>'+
          '<td style="font-size:11.5px;color:#8a7f6a">'+esc(r.quoi)+
            (r.min!==undefined?'<div style="font-size:10px">de '+r.min+' à '+r.max+'</div>':'')+'</td>'+
          '<td style="text-align:right"><b>'+esc(String(r.valeur))+'</b></td>'+
          '<td style="text-align:right;color:#8a7f6a">'+esc(String(r.origine))+'</td>'+
          '<td><input data-rg="'+esc(r.cle)+'" style="width:112px;padding:5px 7px;font-size:12px" '+
            'placeholder="'+(r.type==='b'?'true / false':'nouvelle')+'">'+
            (r.surcharge?' <button data-remet="'+esc(r.cle)+'" style="padding:5px 9px;font-size:11px">remettre</button>':'')+
          '</td></tr>';
      }).join('')+'</tbody></table></div>';
    c.querySelectorAll('input[data-rg]').forEach(function(i){
      i.addEventListener('keydown', function(ev){ if(ev.key==='Enter') poseReglage(i.getAttribute('data-rg'), i.value); });
    });
    c.querySelectorAll('button[data-remet]').forEach(function(b){
      b.addEventListener('click', function(){ poseReglage(b.getAttribute('data-remet'), null); });
    });
  } catch(e){ c.innerHTML='<div class="muted2">'+esc(String(e.message))+'</div>'; }
}
async function poseReglage(cle, valeur){
  /* Le motif n est pas exige pour un reglage — ce n est pas de l argent qui
     bouge — mais il est PROPOSE, parce que dans trois semaines la question ne
     sera pas « quelle valeur » mais « pourquoi ». */
  var motif = prompt('Pourquoi ce changement ? (facultatif)  '+cle+(valeur===null?' → valeur d origine':' → '+valeur)) ;
  if (motif === null) return;
  var d = await post("/reglages", { cle: cle, valeur: valeur, motif: motif });
  var m=$("#rgMsg");
  if(d.error){ m.style.color='#E2483C'; m.textContent='Refusé : '+d.error; return; }
  m.style.color='#6FCF97';
  m.textContent=cle+' : '+d.avant+' → '+d.apres+(d.remis?' (remis à l origine)':'')+' — appliqué tout de suite, sans redémarrage.';
  chargeReglages();
}

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
    /* CE QUI EST EXCLU EST ECRIT, et APRES que A existe. Pose vingt lignes
       plus haut, ce bloc lisait A avant sa declaration : var le hisse, donc
       il valait undefined, la condition etait fausse, et la ligne ne se
       serait jamais affichee — sans erreur, sans rien. */
    if(A.maisonN){
      $("#maisonL").style.display="";
      $("#omz").textContent=fmt(String(A.maison));
      $("#omn").textContent="("+A.maisonN+" account"+(A.maisonN>1?"s":"")+")";
      var sh=A.surplusHorsMaison;
      $("#omsur").textContent = sh==null ? "—" : fmt(String(sh));
      /* SI LE COFFRE NE TIENT QUE GRACE A LA MAISON, IL FAUT LE VOIR. Le
         surplus peut afficher quatre-vingts millions et le coffre etre en
         realite incapable de payer les joueurs sans cet argent-la. C'est
         exactement le genre de chose qu'on decouvre trop tard. */
      $("#maisonL").style.color = (sh!=null && sh<0) ? "#FF6B6B" : "";
      if(sh!=null && sh<0) $("#omsur").textContent =
        fmt(String(sh))+" — the vault does NOT cover players without this money";
    } else if($("#maisonL")) $("#maisonL").style.display="none";
    /* LE COUT QUI COMPTE est celui qui part vraiment. Le rendement que la
       maison se verse a elle-meme tourne en rond : l'afficher comme un cout
       donnait une autonomie de quelques jours alors que rien ne quitte le
       coffre. On montre le reel, et le brut entre parentheses s'ils different. */
    var coutReel = (A.rendementJoueurs!==undefined) ? A.rendementJoueurs : A.rendementJour;
    $("#auCout").textContent = fmt(String(coutReel||0)) +
      ((A.rendementJour && Math.abs(A.rendementJour-coutReel) > 0.01)
        ? "  (" + fmt(String(A.rendementJour)) + " incl. house staking)" : "");
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
/* fmt abrege en k et en M — juste pour des jetons. Un NOMBRE DE MANCHES ne
   s abrege pas : « 1.2k manches » cache la difference entre 1 200 et 1 249,
   et c est exactement l ecart qu on regarde quand on compare deux jours. */
function ent(v){ return Math.round(num(v)).toLocaleString('en-US'); }
function short(ad){ return ad.slice(0,6)+"…"+ad.slice(-4); }
function drawPlayers(){
  var q=($("#q").value||"").trim().toLowerCase();
  var rows=PLAYERS.filter(function(p){
    if(!q) return true;
    return p.address.indexOf(q)>=0 || (p.name||"").toLowerCase().indexOf(q)>=0 || String(p.tgId||"")===q;
  });
  rows.sort(function(x,y){
    /* Le nombre de paris n'est pas un champ de la ligne, il est dans son
       bilan : on le sort de la ou il est plutot que de recopier un compteur
       de plus dans la reponse du serveur. */
    var a=sortKey==="parisN"?((x.paris||{}).total||0):x[sortKey];
    var b=sortKey==="parisN"?((y.paris||{}).total||0):y[sortKey];
    if(sortKey==="name") return sortDir*String(a).localeCompare(String(b));
    return sortDir*(num(a)-num(b));
  });
  var held=0, played=0, bets=0, paris=0, parisMise=0;
  rows.forEach(function(p){ held+=num(p.total); played+=num(p.wagered); bets+=p.bets||0;
    if(p.paris){ paris+=p.paris.total||0; parisMise+=num(p.paris.mise); } });
  $("#ptot").innerHTML="Showing <b>"+rows.length+"</b> of <b>"+PLAYERS.length+"</b> players · holding <b>"+
    fmt(held)+"</b> $SWOGE · played <b>"+fmt(played)+"</b> $SWOGE over <b>"+bets+"</b> rounds"+
    (paris?" · <b>"+paris+"</b> sports bets for <b>"+fmt(parisMise)+"</b> $SWOGE":"");
  if(!rows.length){ $("#pbody").innerHTML='<div class="muted2">no player matches</div>'; return; }
  var ouverts={};
  [].forEach.call(document.querySelectorAll(".pcard.open"),function(c){ ouverts[c.dataset.a]=1; });
  var h="";
  rows.forEach(function(p){
    /* « Net » du point de vue de la MAISON : positif = le joueur lui a coute.
       La couleur suit ce sens-la et pas l'autre, sinon on lit l'inverse de ce
       qu'on croit lire. */
    var net=num(p.net);
    var pb=parisResume(p);
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
         '<div><i>Rounds</i><b>'+(p.bets||0)+'</b></div>'+
         /* LES PARIS SPORTIFS ONT LEURS PROPRES CASES. « Rounds » compte les
            manches de casino, qui se reglent dans la seconde ; un pari vit
            plusieurs jours et n'entre dans aucun compteur de manche tant
            qu'il n'est pas tranche. La carte affichait donc zero pour
            quelqu'un qui avait des milliers de jetons engages. */
         '<div><i>Sports bets</i><b>'+pb.n+'</b></div>'+
         '<div><i>Bet win rate</i><b>'+pb.taux+'</b></div>'+
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
          ["wagered","Played"],["bets","Rounds"],["parisN","Sports bets"],
          ["depositedAmount","Deposited"],["name","Name"]];
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
/* Le bilan des paris sportifs, tel qu'il s'affiche sur la carte.
   Le taux porte sur les paris TRANCHES, remboursements exclus : un match
   annule n'est ni gagne ni perdu, et le compter en defaite ferait baisser un
   taux sans qu'aucun pari n'ait ete perdu. Sans un seul pari tranche il n'y a
   pas de taux — « 0 % » serait faux, pas prudent. */
function parisResume(p){
  var b=p.paris;
  if(!b||!b.total) return { n:0, taux:"—", ligne:"" };
  var net=Number(b.net)||0;
  var l='<div class="det-paris"><h5>Sports bets</h5><div class="dp-g">'+
    '<div><i>Bets placed</i><b>'+b.total+'</b></div>'+
    '<div><i>Staked</i><b>'+fmt(b.mise)+'</b></div>'+
    '<div><i>Won</i><b>'+b.gagnes+'</b></div>'+
    '<div><i>Lost</i><b>'+b.perdus+'</b></div>'+
    (b.rembourses?'<div><i>Refunded</i><b>'+b.rembourses+'</b></div>':'')+
    '<div><i>Win rate</i><b>'+(b.taux==null?"—":b.taux+"%")+'</b></div>'+
    /* Le resultat est celui du JOUEUR : positif = il a gagne. La carte parle
       « net vs house » ailleurs, dans l'autre sens — d'ou le libelle explicite,
       parce que deux sens opposes sur la meme carte se lisent de travers. */
    '<div><i>Player result</i><b class="'+(net>0?"bas":net<0?"haut":"")+'">'+
      (net>0?"+":"")+fmt(net)+'</b></div>'+
    (b.ouverts?'<div><i>Still running</i><b>'+b.ouverts+' &middot; '+fmt(b.enJeu)+
      ' at stake</b></div>':'')+
    '</div>'+
    (b.plusGros?'<div class="det-note">Biggest win: <b>'+fmt(b.plusGros.rendu)+
      '</b> $SWOGE from '+fmt(b.plusGros.mise)+' @ '+Number(b.plusGros.cote||1).toFixed(2)+
      ' &middot; <code>'+esc(b.plusGros.id||"")+'</code></div>':'')+
    '</div>';
  return { n:b.total, taux:(b.taux==null?"—":b.taux+"%"), ligne:l };
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
  var pb=parisResume(p);
  /* Un joueur qui n'a fait QUE parier n'a aucune manche : le detail disait
     « aucune manche enregistree » et s'arretait la, en cachant ses paris. */
  if(!cles.length) return '<div class="det-in">'+(pb.ligne||
    '<span class="det-vide">Aucune manche ni pari enregistre pour ce joueur.</span>')+'</div>';
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
  return h+pb.ligne+'</div>';
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
  var duel = j.sport==='tennis' && (j.issues||[]).length===2;
  var nom=(duel?BNOM2:BNOM)[j.choix]||j.choix;
  /* Le resultat tombe a cote de la selection : c'est la seule facon de voir
     d'un coup d'oeil POURQUOI un combine est perdu. */
  var res=j.resultat ? ' &middot; result <b class="bres">'+esc((duel?BNOM2:BNOM)[j.resultat]||j.resultat)+'</b>' : '';
  /* Le resultat descend sur la SECONDE ligne, avec l'identifiant du match.
     Sur la premiere il finissait contre le bord de la carte a 390 px, et
     « result Home » se lisait « result Ho ». */
  /* « ? – ? » ne disait pas POURQUOI. C'est une rencontre qui a quitte le
     calendrier : le pari reste reglable depuis la liste d'attente, et c'est
     ce qu'il faut lire ici plutot que deux points d'interrogation. */
  var titre = j.horsCalendrier && j.domicile==='?'
    ? '<i>off calendar</i>' : esc(j.domicile)+' &ndash; '+esc(j.exterieur);
  return '<span class="bj">'+titre+
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

/* ============ LES RENCONTRES QUI ATTENDENT UN RESULTAT ============
 *
 * C'etait la seule chose du panneau qui demandait encore une ligne de
 * commande : vingt-deux rencontres a regler, c'etait vingt-deux « curl » a
 * taper, sur un telephone. D'ou des paris qui restent ouverts — et un pari
 * gagnant non paye est pire qu'une erreur de paiement.
 */
var ISS={'1':'Home','N':'Draw','2':'Away'}, ISS2={'1':'Player 1','2':'Player 2'};
/* Le libelle depend du SPORT : la NFL, la NBA et le cricket n'ont que deux
   issues eux aussi, mais opposent des EQUIPES. Seul le tennis oppose deux
   personnes — et c est au moment de REGLER qu il ne faut pas douter de ce
   qu on clique. */
function argNom(m,i){ return (m&&m.sport==='tennis'&&(m.issues||[]).length===2?ISS2:ISS)[i]||i; }
async function loadAregler(){
  try{
    var r=await fetch("/paris/aregler",{headers:{"x-admin-key":KEY}});
    if(!r.ok){ $("#argBody").innerHTML='<div class="muted2">could not load ('+r.status+')</div>'; return; }
    var d=await r.json(), ms=d.matchs||[];
    if(!ms.length){ $("#argBody").innerHTML='<div class="muted2">Nothing waiting — every played match is settled ✓</div>'; return; }
    $("#argBody").innerHTML=ms.map(function(m){
      var h=Math.floor(m.attendDepuisMin/60);
      /* Une rencontre qui attend depuis plus de six heures est une rencontre
         qu'on a oubliee : elle se signale d'elle-meme. */
      var vieux=m.attendDepuisMin>360?" vieux":"";
      var attente = h>=1 ? ("waiting "+h+" h "+(m.attendDepuisMin%60)+" min")
                         : ("waiting "+m.attendDepuisMin+" min");
      /* Une rencontre qui a QUITTE le calendrier se regle quand meme, mais on
         le dit : son titre peut etre « ? – ? », ses cotes ont disparu, et
         c'est l'identifiant qui porte l'information. Le cacher reviendrait a
         faire cliquer a l'aveugle. */
      var hors = m.horsCalendrier
        ? '<div class="argh">&#9888; off the calendar &mdash; this fixture is no longer in the '+
          'fixture list'+(m.sansFiche?', and the bets predate fixture snapshots':'')+
          '. Check the score against the id below, then settle it (or refund).</div>'
        : '';
      return '<div class="arg'+vieux+(m.horsCalendrier?' hors':'')+'" data-id="'+esc(m.id)+'">'+
        '<h4>'+esc(m.domicile)+' &ndash; '+esc(m.exterieur)+'</h4>'+
        '<div class="meta">'+esc(m.competition||m.sport||'off calendar')+' &middot; '+
          new Date(m.debut).toLocaleString('en-GB')+' &middot; <b>'+attente+'</b><br>'+
          m.paris+' bet(s) from '+m.joueurs+' player(s) &middot; staked '+fmt(m.mise)+
          ' &middot; <code>'+esc(m.id)+'</code></div>'+ hors+
        '<div class="row">'+
          m.issues.map(function(i){
            return '<button data-res="'+esc(i)+'">'+esc(argNom(m,i))+
                   '<small>pays '+fmt(m.expo[i]||0)+'</small></button>'; }).join('')+
          '<button class="rmb" data-res="__rembourse">Refund all<small>returns '+fmt(m.mise)+'</small></button>'+
        '</div><div class="argmsg" style="margin-top:7px;font-size:12px"></div></div>';
    }).join("");
  }catch(e){ $("#argBody").innerHTML='<div class="muted2">'+esc(e.message)+'</div>'; }
}
$("#argBody").addEventListener("click",async function(ev){
  var b=ev.target.closest("button"); if(!b) return;
  var carte=b.closest(".arg"), id=carte.getAttribute("data-id"), res=b.getAttribute("data-res");
  var titre=carte.querySelector("h4").textContent;
  var quoi = res==="__rembourse" ? "REFUND every bet on" : ("settle "+titre+" as "+b.childNodes[0].textContent+" —");
  /* Une confirmation qui NOMME la rencontre et le resultat. « Etes-vous
     sur ? » ne protege de rien : on clique oui sans lire. */
  /* Le saut de ligne doit sortir ECHAPPE : ce script vit dans un littéral de
     gabarit, ou « \n » est interprete a la construction de la page et
     produirait un vrai retour a la ligne au milieu d'une chaine — donc une
     SyntaxError, et tout le bloc mort. */
  if(!confirm(quoi+" "+titre+"\\n\\nThis pays players immediately and CANNOT be undone.")) return;
  var boutons=carte.querySelectorAll("button");
  [].forEach.call(boutons,function(x){ x.disabled=true; });
  var msg=carte.querySelector(".argmsg"); msg.textContent="settling…"; msg.className="argmsg";
  try{
    /* Le motif est EXIGE : ce geste paie des joueurs et ne s annule pas. Il
       part au journal admin avec le resultat choisi — c est ce qu on relira le
       jour ou quelqu un contestera. */
    var motif = prompt("Pourquoi ce règlement ? (obligatoire — il part au journal)\\n\\n"+titre);
    if(!motif || !motif.trim()){
      [].forEach.call(boutons,function(x){ x.disabled=false; });
      msg.textContent="annulé — un motif est obligatoire"; msg.className="argmsg"; return;
    }
    var j = await post(res==="__rembourse" ? "/paris/rembourse" : "/paris/regle",
                       { match:id, resultat:res, motif:motif.trim() });
    if(j.error){ msg.textContent="✗ "+j.error; msg.className="argmsg argko";
                 [].forEach.call(boutons,function(x){ x.disabled=false; }); return; }
    msg.className="argmsg argok";
    msg.textContent = res==="__rembourse"
      ? ("✓ refunded "+fmt(j.rendu||0)+" $SWOGE to "+(j.paris||0)+" bet(s)")
      : ("✓ "+(j.gagnants||0)+" paid, "+(j.perdus||0)+" lost, "+fmt(j.paye||0)+" $SWOGE out");
    setTimeout(function(){ loadAregler(); loadBets(false); },1400);
  }catch(e){ msg.textContent="✗ "+e.message; msg.className="argmsg argko";
             [].forEach.call(boutons,function(x){ x.disabled=false; }); }
});
loadAregler(); setInterval(loadAregler,30000);

/* ==================== CREDITER UN JOUEUR ====================
 *
 * Deux barres, et elles ne disent pas la meme chose :
 *
 *   • LA JAUGE — ce qui reste de l'enveloppe. Elle se vide a mesure qu'on
 *     envoie.
 *   • LA BARRE DE TEMPS — ou en est le plus ancien envoi de sa fenetre. Elle
 *     se remplit toute seule, et quand elle est pleine, l'enveloppe rend sa
 *     part. C'est la reponse a « quand est-ce que je peux renvoyer », qui est
 *     la seule question qu'on se pose devant un bouton grise.
 *
 * Le compte a rebours tourne EN LOCAL entre deux lectures : demander l'etat
 * au serveur chaque seconde pour afficher une minute qui descend serait
 * quinze mille requetes par nuit pour rien.
 */
var CRE=null, CRE_LU=0;
function crDuree(ms){
  if(ms<=0) return "now";
  var m=Math.ceil(ms/60000), h=Math.floor(m/60);
  return h>=1 ? (h+" h "+(m%60)+" min") : (m+" min");
}
function crRend(){
  var e=CRE; if(!e){ return; }
  /* Le temps ecoule depuis la lecture : c'est ce qui fait descendre le
     rebours sans redemander l'etat. */
  var passe=Date.now()-CRE_LU;
  var libere=Math.max(0,e.libereDansMs-passe), vide=Math.max(0,e.videDansMs-passe);
  var pct = e.max ? Math.min(100, e.utilise/e.max*100) : 0;
  var plein = e.reste<=0;
  var fenetreMs = e.fenetreH*3600000;
  var tpct = e.envois ? Math.max(0,Math.min(100,(1-libere/fenetreMs)*100)) : 0;
  $("#crJauge").innerHTML=
    '<div class="crb'+(plein?" plein":"")+'"><i style="width:'+pct.toFixed(1)+'%"></i></div>'+
    '<div class="crl"><b>'+fmt(Math.floor(e.reste))+'</b> $SWOGE left of '+fmt(e.max)+
      ' in this '+e.fenetreH+' h window &middot; '+fmt(e.utilise)+' sent in '+
      e.envois+' transfer'+(e.envois===1?'':'s')+
      (plein?' &middot; <span class="p">envelope empty &mdash; nothing can be sent yet</span>':'')+
    '</div>'+
    (e.envois
      ? '<div class="crb t"><i style="width:'+tpct.toFixed(1)+'%"></i></div>'+
        '<div class="crl">+'+fmt(e.libereMontant)+' frees up in <b>'+crDuree(libere)+'</b>'+
        ' &middot; the full '+fmt(e.max)+' is back in <b>'+crDuree(vide)+'</b></div>'
      : '');
  $("#crDerniers").innerHTML = (e.derniers&&e.derniers.length)
    ? '<div class="crd"><b>Recent sends</b><br>'+e.derniers.map(function(d){
        return new Date(d.t).toLocaleString('en-GB')+' &middot; <b>'+fmt(d.montant)+
               '</b> &rarr; '+(d.nom?esc(d.nom)+' ':'')+
               '<span class="bmut">'+short(d.addr)+'</span>'; }).join('<br>')+'</div>'
    : '';
}
async function loadCredit(){
  try{
    var r=await fetch("/credit/etat",{headers:{"x-admin-key":KEY}});
    if(!r.ok){ $("#crJauge").innerHTML='<div class="muted2">could not load ('+r.status+')</div>'; return; }
    CRE=await r.json(); CRE_LU=Date.now(); crRend();
  }catch(e){ $("#crJauge").innerHTML='<div class="muted2">'+esc(e.message)+'</div>'; }
}
function crMsg(t,ko){ var m=$("#crMsg"); m.innerHTML=t; m.className=ko?"warn":"ok"; }
$("#crMax").onclick=function(){
  if(CRE) $("#crMontant").value=Math.floor(CRE.reste);
};
$("#crGo").onclick=async function(){
  var qui=$("#crQui").value.trim();
  var montant=Math.floor(Number($("#crMontant").value));
  if(!qui) return crMsg("type a player name or paste an address",true);
  if(!(montant>0)) return crMsg("type an amount",true);
  /* Une confirmation qui NOMME le joueur et le montant, et qui dit d'ou
     vient l'argent. « Etes-vous sur ? » ne protege de rien. */
  if(!confirm("Credit "+montant+" $SWOGE to "+qui+"?\\n\\nThese tokens are backed by no deposit "+
              "and this CANNOT be undone."))return;
  $("#crGo").disabled=true; crMsg("sending…",false);
  try{
    /* Le montant ne passe plus dans l adresse : il etait dans l historique du
       navigateur et dans les journaux du serveur. Corps de requete, methode
       POST, jeton anti-rejeu. */
    var j = await post("/credit", { joueur: qui, montant: montant,
                                    note: $("#crNote").value.trim(),
                                    motif: $("#crNote").value.trim() });
    if(!j.ok){ crMsg("✗ "+esc(j.error||"refusé"),true); return; }
    crMsg("✓ "+fmt(j.montant)+" $SWOGE → "+esc(j.nom||short(j.addr))+
          " &middot; new balance "+fmt(j.solde),false);
    $("#crMontant").value=""; $("#crNote").value="";
    CRE=j.enveloppe; CRE_LU=Date.now(); crRend();
    loadPlayers();
  }catch(e){ crMsg("✗ "+esc(e.message),true); }
  finally{ $("#crGo").disabled=false; }
};
loadCredit(); setInterval(loadCredit,20000); setInterval(crRend,1000);

/* ============ D OU VIENT LE CALENDRIER ============
 *
 * « Pourquoi n'y a-t-il pas plus de matchs ? » avait trois reponses possibles
 * — pas de cle, cle invalide, ligues hors saison — qui ne se distinguaient
 * qu'en lisant les journaux de l'hebergeur. Elle se lit ici.
 */
function impRend(e){
  var d=(e.dernier||{}).matchs||null;
  var cle = e.cle ? '<b class="impok">set ✓</b>' : '<b class="impbad">MISSING</b>';
  var cartes =
    '<div class="impc"><span>API key</span>'+cle+'</div>'+
    '<div class="impc"><span>Credits left</span><b>'+(e.quota.reste)+'</b></div>'+
    '<div class="impc"><span>Today’s share</span><b>'+e.quota.partDuJour+
      '</b><span>'+e.joursRestants+' days to '+esc(e.fin)+'</span></div>'+
    '<div class="impc"><span>Auto-settle</span><b class="'+(e.auto.actif?'impok':'impwarn')+'">'+
      (e.auto.actif?'on':'OFF')+'</b><span>cap '+fmt(e.auto.plafond)+'</span></div>';

  var l='';
  if(!e.cle){
    l='<div class="impl impbad"><b>ODDS_API_KEY is not set on this server.</b><br>'+
      'Nothing is fetched, and the calendar stays exactly as it is in the repo. '+
      'Add the variable on the host and redeploy — a variable set after the '+
      'last deploy is not seen by the running process.</div>';
  } else if(!d){
    l='<div class="impl impwarn">No import has run yet since this server started. '+
      'It runs 30 s after boot, then every 12 h — or press the button.</div>';
  } else {
    var quand=new Date(d.quand).toLocaleString('en-GB');
    l='<div class="impl">Last run <b>'+quand+'</b> — '+
      (d.ecrit ? '<b class="impok">wrote '+d.rencontres+' fixture(s)</b>'
               : '<b class="impbad">wrote nothing</b>'+(d.pourquoi?' — '+esc(d.pourquoi):''))+'<br>';
    if(d.parLigue){
      l+=Object.keys(d.parLigue).map(function(k){
        var v=d.parLigue[k];
        return '<code>'+esc(k)+'</code> '+v.retenues+'/'+v.vues;
      }).join(' &middot; ')+'<br>';
    }
    if((d.echouees||[]).length){
      l+='<span class="impbad">failed: '+d.echouees.map(esc).join(', ')+'</span><br>';
      (d.erreurs||[]).slice(0,4).forEach(function(x){ l+='<span class="impbad">· '+esc(x)+'</span><br>'; });
    }
    if((d.ecartees||[]).length){
      l+='<span class="impwarn">dropped as unpriceable: '+d.ecartees.length+'</span><br>';
    }
    l+='</div>';
  }
  l+='<div class="impl">Leagues followed: '+e.ligues.map(function(x){ return '<code>'+esc(x)+'</code>'; }).join(' ')+
     '<br><span class="muted2" style="padding:0;text-align:left;display:inline">'+
     'Tennis keys are per tournament — they disappear when the tournament ends.</span></div>';
  $("#impBody").innerHTML='<div class="impg">'+cartes+'</div>'+l;
}
async function loadImport(){
  try{
    var r=await fetch("/paris/import",{headers:{"x-admin-key":KEY}});
    if(!r.ok){ $("#impBody").innerHTML='<div class="muted2">could not load ('+r.status+')</div>'; return; }
    impRend(await r.json());
  }catch(e){ $("#impBody").innerHTML='<div class="muted2">'+esc(e.message)+'</div>'; }
}
/* ================= LA SEANCE DU CINEMA =================
 *
 * Quatre champs, un bouton. Le serveur decide de ce qu'il accepte — cette page
 * ne revalide RIEN : deux regles pour la meme chose finissent par ne plus dire
 * la meme chose, et c'est celle du serveur qui compte puisqu'elle est la seule
 * qu'on ne puisse pas contourner en ouvrant la console.
 *
 * On relit ce que le serveur a RETENU et on le repose dans les champs. Sans ca,
 * une adresse refusee resterait affichee dans la case : le proprietaire
 * croirait l'avoir enregistree, traverserait le hall, et trouverait un ecran
 * eteint sans savoir pourquoi.
 */
function cineRemplit(c){
  $("#cineTitre").value = (c && c.titre) || "";
  $("#cineAff").value   = (c && c.affiche) || "";
  $("#cineVf").value    = (c && c.vf) || "";
  $("#cineVo").value    = (c && c.vo) || "";
}
$("#cineGo").onclick=async function(){
  var b=$("#cineGo"); b.disabled=true;
  $("#cineMsg").textContent="saving…"; $("#cineMsg").className="";
  try{
    var j=await post("/admin/cinema",{ titre:$("#cineTitre").value,
                                       affiche:$("#cineAff").value,
                                       vf:$("#cineVf").value, vo:$("#cineVo").value });
    if(j.error){ $("#cineMsg").textContent="✗ "+j.error; $("#cineMsg").className="impbad"; }
    else if(!j.cinema){
      cineRemplit(null);
      $("#cineMsg").textContent="✓ show taken down — the screen announces nothing is on";
      $("#cineMsg").className="impok";
    } else {
      cineRemplit(j.cinema);
      var manque=[];
      if(!j.cinema.affiche) manque.push("poster");
      if(!j.cinema.vf) manque.push("VF");
      if(!j.cinema.vo) manque.push("VO");
      $("#cineMsg").textContent = manque.length
        ? "✓ saved — refused or empty: "+manque.join(", ")
        : "✓ saved — the screen is live for everyone";
      $("#cineMsg").className = manque.length ? "impwarn" : "impok";
    }
  }catch(e){ $("#cineMsg").textContent="✗ "+e.message; $("#cineMsg").className="impbad"; }
  b.disabled=false;
};

$("#impGo").onclick=async function(){
  var b=$("#impGo"); b.disabled=true; $("#impMsg").textContent="fetching…"; $("#impMsg").className="";
  try{
    var r={ json:async function(){ return await post("/paris/import",{go:"1"}); } };
    var j=await r.json();
    if(j.error){ $("#impMsg").textContent="✗ "+j.error; $("#impMsg").className="impbad"; }
    else { $("#impMsg").textContent="✓ "+j.rencontres+" fixture(s) in the calendar";
           $("#impMsg").className="impok"; }
    if(j.etat) impRend(j.etat); else loadImport();
  }catch(e){ $("#impMsg").textContent="✗ "+e.message; $("#impMsg").className="impbad"; }
  b.disabled=false;
};
loadImport(); setInterval(loadImport,60000);
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

/* ---------------------------------------------------- la collection
 *
 * Deux niveaux : une ligne par fruit, et ses detenteurs qu'on deplie.
 * Le detail est REPLIE par defaut — trente fruits deplies feraient trois
 * cents lignes, et ce qu'on vient chercher ici c'est d'abord « combien il
 * reste », pas « qui ».
 */
async function btCharge(){
  $("#btResume").textContent="loading…";
  try{
    var r=await fetch("/boutique/etat",{headers:{"x-admin-key":KEY}});
    var d=await r.json();
    if(d.error){ $("#btResume").textContent=d.error; return; }
    btRend(d);
  }catch(e){ $("#btResume").textContent=String(e.message||e); }
}
function btRend(d){
  $("#btResume").textContent=d.sortis+" of "+d.edition+" minted \u00b7 "+
    (d.edition-d.sortis)+" left in the edition";
  var h='<table style="width:100%;border-collapse:collapse;font-size:12px">';
  h+='<tr><th style="text-align:left;padding:4px 6px">Fruit</th>'+
     '<th style="text-align:left;padding:4px 6px">Rarity</th>'+
     '<th style="text-align:right;padding:4px 6px">Minted</th>'+
     '<th style="text-align:right;padding:4px 6px">Left</th>'+
     '<th style="text-align:right;padding:4px 6px">Holders</th>'+
     '<th style="padding:4px 6px"></th></tr>';
  var coul={}; (d.parRarete||[]).forEach(function(r){ coul[r.cle]=r.couleur; });
  d.items.forEach(function(o){
    /* Le registre et la somme des inventaires DOIVENT concorder. S'ils
       divergent, la page le dit — elle ne choisit pas lequel croire. */
    var ecart = o.emis!==o.detenu
      ? ' <b style="color:#F2685E" title="register '+o.emis+' vs inventories '+o.detenu+'">\u26a0</b>' : '';
    var barre = o.plafond ? Math.round(100*o.emis/o.plafond) : 0;
    h+='<tr style="border-top:1px solid rgba(255,255,255,.07)">'+
       '<td style="padding:4px 6px">'+esc(o.nom)+ecart+'</td>'+
       '<td style="padding:4px 6px;color:'+(coul[o.rarete]||"#8DA0C4")+'">'+esc(o.rarete)+'</td>'+
       '<td style="padding:4px 6px;text-align:right">'+o.emis+' / '+o.plafond+
         '<div style="height:3px;border-radius:2px;background:rgba(255,255,255,.1);margin-top:2px">'+
         '<div style="height:3px;border-radius:2px;width:'+barre+'%;background:'+
           (coul[o.rarete]||"#8DA0C4")+'"></div></div></td>'+
       '<td style="padding:4px 6px;text-align:right;'+
         (o.reste===0?'color:#F2685E;font-weight:800':'')+'">'+o.reste+'</td>'+
       '<td style="padding:4px 6px;text-align:right">'+o.porteurs+'</td>'+
       '<td style="padding:4px 6px;text-align:right">'+
         (o.porteurs?'<button class="ghost" data-bt="'+o.id+'" style="padding:2px 8px;font-size:11px">who</button>':'')+
       '</td></tr>';
    if(o.porteurs) h+='<tr id="btd'+o.id+'" style="display:none"><td colspan="6" '+
      'style="padding:2px 6px 8px 18px;color:#8DA0C4">'+
      o.detenteurs.map(function(x){ return esc(x.nom)+' <span style="opacity:.6">'+
        short(x.addr)+'</span> \u00d7'+x.q; }).join(' &nbsp;\u00b7&nbsp; ')+
      (o.porteurs>o.detenteurs.length?' &nbsp;\u2026 and '+(o.porteurs-o.detenteurs.length)+' more':'')+
      '</td></tr>';
  });
  h+='</table>';
  $("#btOut").innerHTML=h;
  [].forEach.call($("#btOut").querySelectorAll("[data-bt]"),function(b){
    b.addEventListener("click",function(){
      var l=$("#btd"+b.dataset.bt);
      l.style.display = l.style.display==="none" ? "" : "none";
    });
  });
}
$("#btGo").addEventListener("click",btCharge);

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
    var r={ json:async function(){ return await post("/backup",{}); } };
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
async function rsEnvoie(confirme, motif){
  var f=$("#rsFile").files[0];
  if(!f){ msg("Pick a backup file first","warn"); return null; }
  /* Le corps de cette requete-ci est LE FICHIER. Le motif et le jeton passent
     donc en en-tetes — un en-tete ne va ni dans l historique ni dans les
     journaux d acces, ce qui est exactement ce qu on cherchait. */
  var url="/import"+(confirme?"?confirm=REPLACE-ALL":"");
  var h={ "content-type":"application/octet-stream", "x-admin-token":TOK };
  if(motif) h["x-admin-motif"]=motif;
  var r=await fetch(url,{method:"POST",headers:h,body:f});
  if(r.status===401){ location.href="/admin"; return null; }
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
  /* Le motif part au journal admin, qui vit HORS de state.json : c est la
     seule ligne qui survivra a ce que ce bouton s apprete a faire. */
  var motifRs = prompt("Pourquoi cette restauration ? (obligatoire)");
  if(!motifRs || !motifRs.trim()){ msg("annulé — un motif est obligatoire","warn"); return; }
  $("#rsOut").innerHTML=rsLigne("restoring…");
  try{
    var j=await rsEnvoie(true, motifRs.trim());
    if(!j){ return; }
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
    var motifR = prompt("Pourquoi cette réparation ? (obligatoire)\\n\\n"+audAdr);
    if(!motifR || !motifR.trim()){ msg("annulé — un motif est obligatoire","warn"); return; }
    var r={ json:async function(){ return await post("/repare",{ addr:audAdr, motif:motifR.trim() }); } };
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
    var r={ json:async function(){ return await post("/burn",
              { amount:v, tx:t.hash, motif:"brûlage des frais de retrait" }); } };
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
</script></main></body></html>`;
}

/**
 * LA PAGE DE CONNEXION.
 *
 * ---- pourquoi elle existe ----
 *
 * La cle arrivait dans l adresse. Elle se retrouvait donc dans l historique du
 * navigateur, dans les journaux de l hebergeur, dans ceux de chaque
 * intermediaire, et dans l en-tete `Referer` envoye a chaque ressource externe
 * de la page. Un formulaire l envoie dans un CORPS, en POST : rien de tout ca
 * ne la voit.
 *
 * ---- pourquoi une page et pas un 401 nu ----
 *
 * Une session expire au bout de douze heures. Sans cette page, la premiere
 * chose qu on voit le lendemain matin est un ecran blanc marque « 401 » — et
 * le reflexe est alors de remettre la cle dans l adresse, c est-a-dire de
 * defaire exactement ce qu on vient de reparer.
 */
function connexion() {
  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>SWOGE — connexion</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:'Space Mono','Courier New',monospace}
  body{background:#0B0906;color:#F7EEDA;min-height:100vh;display:flex;align-items:center;
       justify-content:center;padding:24px}
  main{width:100%;max-width:400px}
  h1{font-size:19px;color:#E6A537;margin-bottom:6px}
  p{color:#8a7f6a;font-size:12.5px;line-height:1.65;margin-bottom:18px}
  input{width:100%;padding:12px 13px;background:#12100B;color:#F7EEDA;font-size:14px;
        border:1px solid rgba(230,165,55,.28);border-radius:8px;margin-bottom:10px}
  input:focus{outline:2px solid #E6A537;outline-offset:1px}
  button{width:100%;padding:12px;background:rgba(230,165,55,.16);color:#E6A537;font-size:14px;
         font-weight:700;border:1px solid rgba(230,165,55,.5);border-radius:8px;cursor:pointer}
  button:hover{background:rgba(230,165,55,.24)}
  #m{margin-top:12px;font-size:12.5px;min-height:18px}
  small{display:block;margin-top:20px;color:#6b6152;font-size:11px;line-height:1.6}
</style></head><body><main>
  <h1>🐕 SWOGE — panneau d'exploitation</h1>
  <p>La clé part dans le corps de la requête, jamais dans l'adresse. Elle est échangée
     contre un cookie de session que <b>aucun script ne peut lire</b>, valable douze heures.</p>
  <form id="f" autocomplete="off">
    <input id="k" type="password" placeholder="clé admin" autofocus autocomplete="off">
    <button type="submit">Entrer</button>
  </form>
  <div id="m"></div>
  <small>Si votre marque-page contient <code>?key=…</code>, il fonctionne encore une fois et
     pose le cookie — puis la clé quitte la barre d'adresse. Mettez-le sur <code>/admin</code>
     tout court.</small>
</main>
<script>
document.getElementById("f").addEventListener("submit", async function(e){
  e.preventDefault();
  var m=document.getElementById("m");
  m.style.color="#8a7f6a"; m.textContent="vérification…";
  try{
    var r=await fetch("/admin/login",{method:"POST",headers:{"content-type":"application/json"},
                                      body:JSON.stringify({key:document.getElementById("k").value})});
    var d=await r.json();
    if(!d.ok){ m.style.color="#E2483C"; m.textContent=d.error||"refusé"; return; }
    m.style.color="#6FCF97"; m.textContent="ouverture…";
    location.href="/admin";
  }catch(err){ m.style.color="#E2483C"; m.textContent=String(err.message); }
});
</script></body></html>`;
}

module.exports = { page, connexion };
