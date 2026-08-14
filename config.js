'use strict';
// Central config. Everything overridable via environment variables so the same
// code runs locally (defaults) and on Railway (env vars).
// env() trims whitespace/newlines — pasting a key/address with a trailing
// line break into Railway is a classic footgun, so we scrub it here.
var env = function (name, def) { var v = process.env[name]; return (v === undefined ? def : String(v).trim()); };

module.exports = {
  PORT: parseInt(env('PORT', '8080'), 10),

  // Where the persistent game state (balances etc.) is written. On Railway,
  // mount a VOLUME at this path so it survives redeploys/restarts.
  DATA_DIR: env('DATA_DIR', './data'),
  SAVE_MS: parseInt(env('SAVE_MS', '10000'), 10),

  // Password for the private /admin dashboard + /stats (?key=…). Empty = open
  // (fine for local dev; ALWAYS set it in production).
  ADMIN_KEY: env('ADMIN_KEY', ''),

  // ---- Chain ----
  RPC_URL: env('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: parseInt(env('CHAIN_ID', '4663'), 10),
  SWOGE_TOKEN: env('SWOGE_TOKEN', '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817'),
  VAULT_ADDRESS: env('VAULT_ADDRESS', ''), // set after deploying SwogePusherVault
  // One-time recovery: on the FIRST run (no saved state), scan Deposit events
  // from this block instead of the chain tip, so deposits made before
  // persistence existed are re-credited. Set it once to the Vault's deploy
  // block, then leave it — seenTx dedupes and the contract caps withdrawals.
  SCAN_FROM_BLOCK: parseInt(env('SCAN_FROM_BLOCK', '0'), 10),
  // Backend signer key = the `signer` set in the Vault. Authorizes withdrawals.
  // NEVER commit a real key. Set SIGNER_PRIVATE_KEY on Railway.
  SIGNER_PRIVATE_KEY: env('SIGNER_PRIVATE_KEY', ''),
  DEPOSIT_POLL_MS: parseInt(env('DEPOSIT_POLL_MS', '6000'), 10),

  // ---- Economy ----
  DECIMALS: 18,
  DROP_COST: env('DROP_COST', '1'),         // $SWOGE per coin dropped
  /* Le minimum de retrait. Le coffre a le sien, en dur dans le contrat : ce
     nombre-ci ne peut qu'etre PLUS HAUT, jamais plus bas — un serveur plus
     souple que la chaine signerait des bons que la chaine refuserait. */
  MIN_WITHDRAW: env('MIN_WITHDRAW', '10000'),
  /* ---- le frais de retrait ----
   *
   * Il ne rembourse rien : le joueur paie lui-meme le gaz en presentant son
   * bon au coffre, un retrait ne coute donc rien a la maison. C'est de la
   * marge, et il faut l'assumer comme telle — d'ou la regle qui suit.
   *
   * IL EST BRULE. C'est tout le raisonnement : un pour cent qui part dans la
   * poche de la maison est une taxe, et se raconte comme telle. Le meme un
   * pour cent retire de la circulation est une REDUCTION D'OFFRE, dont
   * profitent tous les porteurs — celui qui retire compris. Pour un memecoin,
   * ce n'est plus un prelevement, c'est un argument.
   *
   * Techniquement le montant reste dans le coffre — il n'est verse a
   * personne — et le tableau de bord le compte a part : c'est le chiffre a
   * bruler. La promesse ne vaut que si le brulage a lieu ; ne pas le faire
   * reviendrait a prendre l'argent tout en disant le contraire.
   */
  WITHDRAW_FEE_BPS: parseInt(env('WITHDRAW_FEE_BPS', '100'), 10),   // 100 = 1 %
  /* L'adresse ou l'on brule. Rien ne peut en ressortir : personne n'a la cle,
     et c'est ce qui fait la difference entre « brule » et « mis de cote ». */
  BURN_ADDRESS: env('BURN_ADDRESS', '0x000000000000000000000000000000000000dEaD'),

  /* ---- la preuve d'equite ----
   *
   * Chaque manche est tiree par HMAC(graine du serveur, graine du joueur:numero).
   * Le joueur recoit d'avance l'EMPREINTE de la graine du serveur : elle
   * l'engage, puisqu'on ne peut plus changer la graine sans changer
   * l'empreinte.
   *
   * Mais une empreinte qu'on n'ouvre JAMAIS ne prouve rien. Tant que la graine
   * n'est pas revelee, le joueur ne peut recalculer aucune manche — il n'a
   * qu'une promesse. La graine tourne donc regulierement, et la PRECEDENTE est
   * publiee : chacun peut alors verifier que son empreinte correspond, et
   * refaire le calcul de chaque manche jouee sous elle.
   *
   * Pourquoi pas plus souvent : chaque rotation coupe la verification en
   * tranches et multiplie les graines a garder. Pourquoi pas plus rarement :
   * plus la periode est longue, plus le joueur attend avant de pouvoir
   * verifier ce qu'il a joue. Une semaine est le compromis d'usage.
   */
  FAIRNESS_ROTATE_HOURS: parseFloat(env('FAIRNESS_ROTATE_HOURS', '168')),
  FAIRNESS_GARDE: parseInt(env('FAIRNESS_GARDE', '104'), 10),   // deux ans de graines
  // L'adresse publique du serveur, pour que l'annonce de rotation porte un
  // lien cliquable vers les graines.
  PUBLIC_URL: env('PUBLIC_URL', 'https://web-production-220a3.up.railway.app'),

  /* ---- la sauvegarde hors machine ----
   *
   * state.json et son .bak vivent sur LE MEME volume. Cela protege d'une
   * ecriture ratee, de rien d'autre : si le volume disparait — demonte par
   * erreur au redeploiement, service supprime, incident chez l'hebergeur —
   * tous les soldes partent avec, et il n'y a rien pour reconstruire.
   *
   * Une archive quotidienne part donc sur un canal Telegram PRIVE. Elle
   * contient les adresses et les soldes de tous les joueurs : elle n'a rien a
   * faire dans le canal public des annonces. D'ou une variable separee — sans
   * elle on n'envoie rien du tout, plutot que de risquer une fuite qui ne se
   * rattrape pas.
   */
  TG_BACKUP_CHAT_ID: env('TG_BACKUP_CHAT_ID', ''),
  BACKUP_HEURES: parseFloat(env('BACKUP_HEURES', '24')),
  VOUCHER_TTL_SEC: parseInt(env('VOUCHER_TTL_SEC', '3600'), 10),

  // ---- Progressive jackpot ----
  // A slice of each drop (RAKE_PCT % of DROP_COST, taken from the house edge)
  // grows a shared pot. Every drop has a 1-in-ODDS provably-fair chance to win
  // the whole pot, which then resets to SEED. Average pot at win ≈ SEED +
  // rake×ODDS (defaults ≈ 100k, up to 1M+ on a long dry streak).
  JACKPOT_SEED: env('JACKPOT_SEED', '10000'),
  JACKPOT_RAKE_PCT: parseFloat(env('JACKPOT_RAKE_PCT', '3')),   // % of each drop → pot
  JACKPOT_ODDS: parseInt(env('JACKPOT_ODDS', '3000000'), 10),   // 1-in-N per drop
  LEADERBOARD_SIZE: parseInt(env('LEADERBOARD_SIZE', '10'), 10),

  /* ---- les cent niveaux ----
   *
   * L'experience, c'est le VOLUME MISE — et rien d'autre. Trois raisons :
   *
   *  1. il est deja compte, sur chaque fiche, depuis le premier jour. Le jour
   *     du deploiement, chacun a deja son vrai niveau, gagne pour de bon. Pas
   *     de « ca commence aujourd'hui », qui aurait puni les anciens ;
   *  2. il ne se triche pas : chaque point coute l'avantage de la maison.
   *     Farmer un niveau, c'est payer le casino ;
   *  3. il ne depend pas de la chance. Un classement au gain monte et descend
   *     sans qu'on ait rien change a sa facon de jouer.
   *
   * volume cumule pour le niveau n = 50 x n^4
   *   niveau  10 :         500 000
   *   niveau  34 :      66 816 800
   *   niveau  50 :     312 500 000
   *   niveau 100 :   5 000 000 000  — cinq fois l'offre totale en volume
   *                                   cumule, par un seul joueur.
   *
   * ---- pourquoi la puissance et non la base ----
   *
   * La courbe a ete durcie d'un facteur DIX au sommet : un joueur atteignait
   * le niveau 34 pour 11,5 millions de volume, ce qui rendait le haut de
   * l'echelle atteignable trop vite.
   *
   * Deux facons de multiplier par dix. Multiplier la BASE (50 -> 500) durcit
   * tout uniformement, y compris les dix premiers niveaux — ceux qui servent a
   * accrocher un joueur qui vient d'arriver. Monter la PUISSANCE (3,5 -> 4)
   * donne exactement le meme sommet, 5 milliards, mais laisse le debut
   * accessible : le niveau 10 passe de 158 000 a 500 000 et non a 1,58 million.
   * La difficulte monte donc progressivement, ce qui est la forme qu'on veut.
   *
   * Le niveau ne redescend JAMAIS — pas meme quand cette courbe change. Voir
   * NIVEAU_ACQUIS ci-dessous : sans lui, durcir la courbe retrograderait tout
   * le monde, ce qui est exactement la punition que le systeme evite.
   */
  NIVEAU_BASE: parseFloat(env('NIVEAU_BASE', '50')),
  NIVEAU_PUISSANCE: parseFloat(env('NIVEAU_PUISSANCE', '4')),
  NIVEAU_MAX: parseInt(env('NIVEAU_MAX', '100'), 10),
  /* Un niveau atteint est ACQUIS. Le joueur garde le plus haut niveau qu'il
     ait jamais eu, et progresse ensuite sur la courbe en vigueur.
     Mettre a 0 pour recalculer tout le monde sur la courbe courante — ce qui
     RETROGRADE les joueurs existants. A n'utiliser qu'en connaissance de
     cause, et jamais sans le dire aux joueurs. */
  NIVEAU_ACQUIS: env('NIVEAU_ACQUIS', '1') !== '0',
  /* La puissance en vigueur AVANT le durcissement. Elle ne sert qu'une fois,
     a la premiere lecture d'une fiche qui n'a pas encore de niveau acquis :
     elle permet de retrouver le niveau que le joueur avait vraiment atteint.
     Sans elle, la migration figerait tout le monde a son niveau NOUVEAU, donc
     retrograde — le contraire du but. */
  NIVEAU_PUISSANCE_AVANT: parseFloat(env('NIVEAU_PUISSANCE_AVANT', '3.5')),

  /* ---- le prix du classement ----
   *
   * Une part du REVENU du mois, partagee entre les dix premiers au volume.
   * Une part du revenu et non un montant fixe : ainsi le prix ne peut jamais
   * couter plus que ce que le mois a rapporte — il s'auto-finance par
   * construction, et un mois creux ne se paie pas au prix d'un mois plein.
   *
   * La repartition decroit vite. Un partage plat ne fait courir personne ;
   * un premier prix qui vaut le tiers de la cagnotte, si.
   */
  PRIX_CLASSEMENT_BPS: parseInt(env('PRIX_CLASSEMENT_BPS', '100'), 10),   // 1 % du revenu
  PRIX_PARTS: env('PRIX_PARTS', '30,20,13,10,8,6,5,4,2.5,1.5')
    .split(',').map(function (x) { return parseFloat(x.trim()) || 0; }),

  // ---- Daily quests ----
  // Anti-Sybil: total rewards (50) < house edge on the wagering required to
  // finish them (~300 drops → ~60 edge), AND claiming needs a real deposit.
  // So farming with throwaway wallets costs more than it pays.
  QUESTS: [
    { id: 'daily',   label: 'Daily bonus',      metric: 'free',  target: 0,   reward: parseInt(env('Q_DAILY',  '5'),  10) },
    { id: 'drop100', label: 'Drop 100 coins',   metric: 'drops', target: 100, reward: parseInt(env('Q_DROP100', '10'), 10) },
    { id: 'win3',    label: 'Win 3 prizes',     metric: 'wins',  target: 3,   reward: parseInt(env('Q_WIN3',    '15'), 10) },
  ],
  QUEST_REQUIRE_DEPOSIT: env('QUEST_REQUIRE_DEPOSIT', '1') === '1',

  /* ---- Les missions du jour, jeu par jeu ----
   *
   * Les quetes globales se remplissaient toutes seules : un joueur de Plinko
   * finissait « lachez 300 pieces » sans jamais avoir ouvert autre chose. Une
   * mission NOMME un jeu, et le jeu change chaque jour — c'est de la
   * distribution gratuite vers tout le catalogue, sans une ligne de contenu
   * nouveau. Elles remplacent la quete « 300 pieces », elles ne s'ajoutent
   * pas : ce qui est distribue chaque jour reste du meme ordre.
   *
   * Le compteur est la MISE du jour sur ce jeu, pas le nombre de manches. Un
   * nombre de manches se remplirait a la mise minimum, et la recompense
   * passerait alors devant l'avantage de la maison — c'est-a-dire qu'on
   * paierait quelqu'un pour ne rien risquer. Sur MISSION_MISE misees,
   * l'avantage le plus faible du catalogue (le blackjack, 2,6 %) rend deja
   * plusieurs fois MISSION_GAIN.
   *
   * La rotation est calculee, pas tiree : tout le monde voit les memes jeux le
   * meme jour, et le pas (MISSIONS_PAR_JOUR) etant premier avec la longueur du
   * catalogue, chaque jeu revient a intervalle regulier.
   */
  MISSION_CATALOGUE: [
    ['plinko', 'Plinko',         'plinko.html'],
    ['mines',  'Mines',          'swoge_casino.html?game=mines'],
    ['crash',  'Crash',          'crash.html'],
    ['bj',     'Blackjack',      'swoge_blackjack.html'],
    ['hilo',   'Hi-Lo',          'swoge_casino.html?game=hilo'],
    ['spin',   'SWOGE Spin',     'swoge_spin.html'],
    ['smash',  'SWOGE Smash',    'swoge_smash.html'],
    ['holdem', "Casino Hold'em", 'swoge_casino.html?game=holdem'],
    ['three',  'Three Card',     'swoge_casino.html?game=three'],
    ['pusher', 'Coin Pusher',    'swoge_pusher_live.html'],
    ['poker',  'Poker',          'swoge_poker.html'],
    ['p4',     'Connect 4',      'connect4.html'],
    ['mp',     'Tic-Tac-Toe',    'morpion.html'],
    ['dm',     'Checkers',       'dames.html'],
  ],
  /* ---- Ce qu'on peut se dire a la table ----
   *
   * Une liste FERMEE, et rien d'autre. Le texte libre demanderait une equipe
   * de moderation que le projet n'a pas, et il suffit d'un seul message pour
   * qu'une table devienne un endroit ou l'on ne revient pas. Ici c'est un
   * IDENTIFIANT qui traverse le reseau, jamais une phrase : le serveur n'a
   * donc rien a filtrer, et il n'existe aucune facon d'ecrire quoi que ce
   * soit qui ne figure pas ci-dessous.
   *
   * Le choix des phrases n'est pas neutre : aucune ne doit pouvoir servir a
   * narguer. « A toi de jouer » renseigne, « depeche-toi » harcele — la
   * premiere est ici, la seconde n'y sera jamais.
   */
  PHRASES: [
    ['hi',      '👋', 'Hi!'],
    ['gl',      '🤝', 'Good luck'],
    ['nice',    '🔥', 'Nice move'],
    ['wow',     '😮', 'Wow'],
    ['close',   '😬', 'That was close'],
    ['think',   '🤔', 'Thinking...'],
    ['turn',    '⏳', 'Your turn'],
    ['oops',    '😅', 'Oops'],
    ['lucky',   '🍀', 'Lucky!'],
    ['ty',      '🙏', 'Thanks'],
    ['gg',      '👏', 'Good game'],
    ['rematch', '⚔️', 'Rematch?'],
  ],
  /* Meme toute faite, une phrase repetee vingt fois harcele. On espace, et on
     plafonne : passe le plafond, la table redevient silencieuse pour celui qui
     l'a atteint, sans rien changer a la partie. */
  PHRASE_PAUSE_MS: parseInt(env('PHRASE_PAUSE_MS', '3000'), 10),
  PHRASE_MAX: parseInt(env('PHRASE_MAX', '15'), 10),

  MISSIONS_PAR_JOUR: parseInt(env('MISSIONS_PAR_JOUR', '3'), 10),
  MISSION_MISE: parseFloat(env('MISSION_MISE', '2000')),   // a miser sur le jeu du jour
  MISSION_GAIN: parseFloat(env('MISSION_GAIN', '12')),     // ce qu'elle rapporte

  // ---- New-player welcome bonus (wager-locked) ----
  // A brand-new player gets WELCOME_BONUS $SWOGE to try the game. Once they've
  // actually WAGERED at least once (skin in the game — stops throwaway farming),
  // they can claim an extra WELCOME_CLAIM reward, one time.
  WELCOME_BONUS: parseFloat(env('WELCOME_BONUS', '1')),   // demo credit granted on first login
  WELCOME_CLAIM: parseFloat(env('WELCOME_CLAIM', '5')),   // extra reward, unlocked after wagering

  // ---- 7-day consecutive login streak ----
  // One claim per UTC day; a skipped day resets the streak to day 1. Reward
  // escalates J1→J7, then wraps back to J1. Comma-separated wei-free amounts.
  STREAK_REWARDS: env('STREAK_REWARDS', '1,2,3,5,7,10,15')
    .split(',').map(function (x) { return parseFloat(x.trim()) || 0; }),

  // ---- Rewarded video ads (Adsgram) ----
  // Adsgram calls REWARD_URL (server-to-server) when a user finishes a video.
  // We credit AD_REWARD $SWOGE, capped at AD_DAILY_CAP/day with a cooldown so a
  // single user can't spam. ADSGRAM_KEY guards the endpoint (must be non-empty
  // in production, else the endpoint is disabled).
  AD_REWARD: parseFloat(env('AD_REWARD', '10')),               // $SWOGE per finished video
  AD_DAILY_CAP: parseInt(env('AD_DAILY_CAP', '5'), 10),        // max rewarded videos / day / player
  AD_COOLDOWN_SEC: parseInt(env('AD_COOLDOWN_SEC', '30'), 10), // min seconds between two rewards
  ADSGRAM_KEY: env('ADSGRAM_KEY', ''),                         // shared secret in the Reward URL
  ADSGRAM_BLOCK_ID: env('ADSGRAM_BLOCK_ID', '41851'),          // Adsgram UnitID (sent to the client)

  // ---- Staking (yield on staked $SWOGE, claimable anytime) ----
  // Paid FROM the vault — fund it (ownerDeposit) or it drains. 100% APR is a
  // BIG liability (you owe double after a year), so keep the vault funded.
  STAKE_APR_BPS: parseInt(env('STAKE_APR_BPS', '10000'), 10),        // 10000 = 100% APR
  STAKE_LOCK_DAYS: parseInt(env('STAKE_LOCK_DAYS', '365'), 10),      // soft-lock length
  STAKE_EARLY_PENALTY_BPS: parseInt(env('STAKE_EARLY_PENALTY_BPS', '5000'), 10), // 5000 = lose 50% of principal if you exit before the lock ends

  /* ---- LE PLAFOND DE STAKING ----
   *
   * A 100 % l'an, chaque jeton depose engage la maison a en rendre DEUX au
   * bout d'un an. Sans plafond, cette dette n'a aucune borne : il suffit qu'un
   * gros porteur arrive avec cinquante millions pour que le coffre doive
   * cinquante millions de plus l'annee suivante, et personne ne s'en apercoit
   * le jour ou ca arrive — on s'en apercoit douze mois plus tard.
   *
   * Le plafond met une borne CONNUE D'AVANCE a cette dette. Vingt pour cent de
   * l'offre = 200 millions au maximum en staking, donc 200 millions de
   * rendement maximum sur l'annee. C'est un chiffre qu'on peut regarder en
   * face et budgeter.
   *
   * Il ne bloque personne definitivement : quand un joueur sort ou qu'un
   * verrou arrive a terme, la place se libere et le suivant entre. C'est
   * exactement ce que fait une salle pleine.
   */
  TOKEN_SUPPLY: parseFloat(env('TOKEN_SUPPLY', '1000000000')),       // l offre totale, verifiee sur la chaine
  STAKE_CAP_BPS: parseInt(env('STAKE_CAP_BPS', '2000'), 10),         // 2000 = 20 % de l offre, tous joueurs confondus

  // ---- Telegram notifications (deposits / big wins / stakes) ----
  // Accepts either TG_* or the TELEGRAM_* names your other bots already use.
  TG_BOT_TOKEN: env('TG_BOT_TOKEN', '') || env('TELEGRAM_BOT_TOKEN', ''),   // BotFather token
  TG_CHAT_ID: env('TG_CHAT_ID', '') || env('TELEGRAM_CHAT_ID', ''),         // channel/group id (e.g. -100123…) or @channel
  EXPLORER: env('EXPLORER', 'https://robinhoodchain.blockscout.com'),
  NOTIFY_DEPOSIT_MIN: parseFloat(env('NOTIFY_DEPOSIT_MIN', '0')),  // notify deposits ≥ this
  DEPOSIT_IMAGE: env('DEPOSIT_IMAGE', 'https://i.ibb.co/jkCkzPpM/Chat-GPT-Image-5-ao-t-2026-15-41-22.png'), // image shown on deposit notifs ('' = none)
  STAKE_IMAGE: env('STAKE_IMAGE', 'https://i.ibb.co/4gKk59sQ/Chat-GPT-Image-5-ao-t-2026-15-53-47.png'),     // image shown on stake notifs ('' = none)
  NOTIFY_WIN_MIN: parseInt(env('NOTIFY_WIN_MIN', '500'), 10),      // notify single-coin wins ≥ this
  /* Ou vivent les vignettes des jeux, pour les annonces de gain. Telegram va
     CHERCHER l'image lui-meme : l'adresse doit donc etre publique, et c'est
     le site qui les sert — les memes que sur la page des jeux, extraites une
     fois dans media/. Vider la variable rend les annonces en texte seul. */
  GAME_IMAGE_BASE: env('GAME_IMAGE_BASE', 'https://swoleeswoge.dog/media'),
  /* Un nouveau joueur dans le canal. C'est la notification la plus utile de
     toutes pour un canal qui veut voir la communaute grandir, et la seule qui
     n'existait pas. */
  NOTIFY_NEW_PLAYER: env('NOTIFY_NEW_PLAYER', '1') === '1',
  NEW_PLAYER_IMAGE: env('NEW_PLAYER_IMAGE', ''),
  NOTIFY_STAKE_MIN: parseFloat(env('NOTIFY_STAKE_MIN', '100')),    // notify stakes ≥ this

  // ---- Provably-fair prize table (weighted tiers) ----
  // [value, weight] out of PRIZE_TOTAL (10,000,000). A weighted table (instead
  // of a flat array) lets us express very rare big lots cleanly AND keep the
  // exact same provably-fair HMAC selection.
  //
  // Design: ~47.5% of coins show a WIN (lots of small ones = good feel), a
  // ladder up to a 1-in-10M "gros lot". Average value ≈ 1.043 $SWOGE/drop.
  // Real RTP = avg × collection-rate(≈0.77 on this table) ≈ 80%.
  PRIZES: [
    [0,      5246000],  // 52.46%  miss
    [1,      2900000],  // 29.0%
    [2,      1240000],  // 12.4%
    [5,       480000],  // 4.80%
    [10,       95000],  // 0.95%
    [25,       28000],  // 0.28%
    [50,        7500],  // 0.075%
    [100,       2600],  // 0.026%   (~1 in 3,846)
    [250,        700],  // ~1 in 14,286
    [500,        160],  // ~1 in 62,500
    [1000,        35],  // ~1 in 285,714
    [5000,         4],  // ~1 in 2,500,000
    [50000,        1],  // ~1 in 10,000,000  ← the "gros lot"
  ],
  PRIZE_TOTAL: 10000000,

  // ---- SWOGE Smash (spin game) — provably-fair, RTP = 50% ----
  // 1 spin costs SPIN_COST $SWOGE and pays (multiplier × SPIN_COST).
  // [multiplier, weight] out of SPIN_TOTAL. Σ(weight·mult)/SPIN_TOTAL must equal
  // the target RTP. Here Σ = 5,000,000 / 10,000,000 = 0.50 exactly (RTP 50%).
  SPIN_COST: env('SPIN_COST', '1'),
  SPIN_PRIZES: [
    [0,    8576000],  // 85.76%  smash → nothing
    [1,     900000],  //  9.00%  money back
    [2,     300000],  //  3.00%
    [5,     100000],  //  1.00%
    [10,    100000],  //  1.00%
    [50,     20000],  //  0.20%
    [250,     4000],  //  0.04%  jackpot shard
  ],
  SPIN_TOTAL: 10000000,

  // Mise variable au Smash : payout = multiplicateur x mise (max 250x).
  // Exposition maximale = SMASH_MAX_BET x 250.
  SMASH_MIN_BET: parseInt(env('SMASH_MIN_BET', '1'), 10),
  SMASH_MAX_BET: parseInt(env('SMASH_MAX_BET', '1000'), 10),

  // ---- SWOGE Blackjack ----
  BJ_MAX_BET: parseInt(env('BJ_MAX_BET', '100000'), 10),  // max $SWOGE per hand
  BJ_MIN_BET: parseInt(env('BJ_MIN_BET', '1'), 10),

  // ---- SWOGE Casino (jeux contre la banque) ----
  // Ici la MAISON joue son argent : contrairement au poker ou l'on prend une
  // commission sans risque, une session courte peut couter cher malgre les
  // 2,4 % d'avantage. Le plafond est donc volontairement bas.
  // Commission de la maison sur le GAIN NET (jamais sur les mises rendues :
  // une egalite rend exactement la mise). 1350 bps = 13,5 % du gain, ce qui
  // amene le retour joueur a 92 % — 8 % pour la maison. C'est deja bien
  // au-dessus des 2-3 % d'un vrai casino, mais assez bas pour qu'un joueur
  // reste. Reperes mesures : 0 -> 97,6 % · 1350 -> 92 % · 2000 -> 89 %
  // · 4200 -> 80 %. Une seule valeur a changer.
  CASINO_WIN_FEE_BPS: parseInt(env('CASINO_WIN_FEE_BPS', '1350'), 10),
  // ---- Hi-Lo ----
  // Avantage de la maison PAR PAS, applique sur le multiplicateur. Sur un jeu a
  // chaine c'est le seul reglage qui donne le meme taux de retour au joueur
  // prudent et au casse-cou. Reperes mesures sur 400 000 parties :
  //   300 bps -> 96,7 % a un pas, 89,9 % a trois, 84,0 % a cinq
  //     0 bps -> 99,7 % (le jeu est alors equitable, la maison ne gagne rien)
  HILO_EDGE_BPS: parseInt(env('HILO_EDGE_BPS', '300'), 10),

  // ---- Mines ----
  // Avantage de la maison preleve UNE SEULE FOIS, sur le multiplicateur final.
  // Volontairement different du Hi-Lo : la, chaque pas est un pari qu'on decide
  // de prendre en connaissant sa cote ; ici on s'engage sur une grille, et
  // prelever a chaque case donnerait 0,97^20 = 54 % de retour a qui va au bout,
  // sans que rien ne l'annonce au moment de miser. Preleve une fois, le taux
  // vaut (1 - avantage) qu'on ouvre une case ou vingt, avec une bombe ou
  // vingt-quatre. Reperes mesures : 300 bps -> 97 % · 0 bps -> 100 %.
  MINES_EDGE_BPS: parseInt(env('MINES_EDGE_BPS', '300'), 10),
  // Nombre de bombes par defaut sur la grille de 25 cases.
  MINES_DEFAUT: parseInt(env('MINES_DEFAUT', '3'), 10),
  // Les paliers proposes. La liste est ENVOYEE au navigateur avec le bareme
  // correspondant : changer les paliers ici suffit, aucune page a regenerer.
  MINES_CHOIX: (env('MINES_CHOIX', '1,3,5,10,24').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x >= 1 && x <= 24)),

  // ---- Plinko ----
  // Avantage de la maison preleve sur le multiplicateur, comme au Mines : une
  // bille est un coup unique, il n'y a pas de chaine sur laquelle prelever.
  // Les tables sont ENGENDREES a partir de cette valeur (voir plinko.js), pas
  // recopiees : changer le chiffre suffit, tout se remet a l'echelle.
  // Reperes mesures : 300 bps -> 96,8 a 97,0 % selon la table · 0 -> ~100 %.
  PLINKO_EDGE_BPS: parseInt(env('PLINKO_EDGE_BPS', '300'), 10),
  PLINKO_RANGEES: parseInt(env('PLINKO_RANGEES', '12'), 10),   // plateau par defaut
  PLINKO_RISQUE: env('PLINKO_RISQUE', 'medium'),

  // ---- Crash ----
  // L'avantage n'est PAS preleve sur les gains : c'est la probabilite que la
  // manche crashe a 1.00x. Consequence a connaitre avant de toucher au chiffre :
  // le retour est le meme quelle que soit la cible visee (voir crash.js), donc
  // 300 bps = 97,00 % exactement, a 1.01x comme a 10 000x.
  CRASH_EDGE_BPS: parseInt(env('CRASH_EDGE_BPS', '300'), 10),
  // Plafond du multiplicateur. La maison doit pouvoir payer ce qu'elle affiche :
  // 10 000x sur la mise maximale, c'est le vrai risque a couvrir.
  CRASH_PLAFOND: parseFloat(env('CRASH_PLAFOND', '10000')),
  // Vitesse de la courbe, par milliseconde : multi(t) = e^(vitesse x t).
  // Reperes : 10 s -> 1,82x · 30 s -> 6,05x · 60 s -> 36,6x.
  CRASH_VITESSE: parseFloat(env('CRASH_VITESSE', '0.00006')),
  CRASH_ATTENTE_MS: parseInt(env('CRASH_ATTENTE_MS', '7000'), 10),  // fenetre de mises
  CRASH_APRES_MS: parseInt(env('CRASH_APRES_MS', '4000'), 10),      // temps d'arret apres le crash
  /* Le sel est PUBLIC et doit etre fixe une fois pour toutes : il prouve que la
     chaine n'a pas ete tiree mille fois pour garder la pire. Publiez-le (un hash
     de bloc a venir fait un excellent sel). Le changer invalide la verification
     de tout l'historique deja joue. */
  CRASH_SEL: env('CRASH_SEL', 'swoge-crash-v1'),
  /* Longueur de la chaine, en manches. A ~15 s la manche, 50 000 tiennent une
     semaine et demie. Quand elle est epuisee, le serveur en tire une nouvelle et
     publie un nouvel engagement. */
  CRASH_CHAINE: parseInt(env('CRASH_CHAINE', '50000'), 10),
  /* La graine de la chaine. Laissee vide, elle est tiree au hasard au premier
     demarrage puis conservee dans l'etat — la chaine survit aux redeploiements.
     Ne JAMAIS la publier avant que la chaine soit epuisee : elle donne toutes
     les manches a venir. */
  CRASH_GRAINE: env('CRASH_GRAINE', ''),

  // ---- Connect 4, un contre un ----
  // La commission est prise sur LE POT ENTIER (les deux mises), pas sur le seul
  // benefice : c'est ce qui est annonce au joueur, et 5 % du pot vaut le double
  // de 5 % du gain.
  P4_RAKE_BPS: parseInt(env('P4_RAKE_BPS', '500'), 10),        // 500 = 5 %
  P4_MIN: parseInt(env('P4_MIN', '10'), 10),
  P4_MAX: parseInt(env('P4_MAX', '10000000'), 10),
  // Les paliers proposes a la creation. Le joueur peut saisir n'importe quel
  // montant entre le minimum et le maximum ; ceux-ci ne sont que des raccourcis.
  P4_MISES: (env('P4_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  /* Delai par coup. Sans lui, un joueur qui ferme son onglet gelerait la mise
     de l'autre pour toujours — l'argent est bloque tant que la partie n'est pas
     finie. Passe ce delai, celui qui devait jouer perd. */
  P4_COUP_MS: parseInt(env('P4_COUP_MS', '45000'), 10),
  /* Duree de vie d'une table qui n'a jamais trouve d'adversaire. Au-dela, la
     mise est rendue a celui qui l'a posee. */
  P4_ATTENTE_MS: parseInt(env('P4_ATTENTE_MS', '600000'), 10),
  /* Duree de vie d'une demande de revanche. Bien plus courte : elle s'adresse
     a quelqu'un qui vient de finir la partie et qui est encore la, et elle
     immobilise la mise du demandeur en attendant la reponse. */
  P4_REVANCHE_MS: parseInt(env('P4_REVANCHE_MS', '90000'), 10),
  // Commission aussi sur les parties nulles ? Non par defaut : personne n'a
  // gagne, il n'y a rien a partager.
  P4_RAKE_SUR_NUL: env('P4_RAKE_SUR_NUL', '0') === '1',

  /* ---- Morpion, un contre un ----
   * Le morpion est NUL a jeu parfait : deux joueurs attentifs font partie
   * nulle a tous les coups. La commission sur la nulle reste donc a zero —
   * faire payer une egalite que les deux peuvent forcer, et le jeu ne se
   * joue pas deux fois. La pendule est courte : on voit le coup en une
   * seconde, et quarante-cinq secondes devant trois cases sont une eternite.
   */
  MP_RAKE_BPS: parseInt(env('MP_RAKE_BPS', '500'), 10),
  MP_MIN: parseInt(env('MP_MIN', '10'), 10),
  MP_MAX: parseInt(env('MP_MAX', '10000000'), 10),
  MP_MISES: (env('MP_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  MP_COUP_MS: parseInt(env('MP_COUP_MS', '20000'), 10),
  MP_ATTENTE_MS: parseInt(env('MP_ATTENTE_MS', '600000'), 10),
  MP_REVANCHE_MS: parseInt(env('MP_REVANCHE_MS', '90000'), 10),
  MP_RAKE_SUR_NUL: env('MP_RAKE_SUR_NUL', '0') === '1',

  /* ---- Dames, un contre un ----
   * Une partie de dames dure plus longtemps qu'un Connect 4 et demande plus
   * de reflexion par coup : la pendule est donc plus large. Le reste est
   * identique — meme commission, meme chemin d'argent.
   */
  DM_RAKE_BPS: parseInt(env('DM_RAKE_BPS', '500'), 10),
  DM_MIN: parseInt(env('DM_MIN', '10'), 10),
  DM_MAX: parseInt(env('DM_MAX', '10000000'), 10),
  DM_MISES: (env('DM_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  DM_COUP_MS: parseInt(env('DM_COUP_MS', '60000'), 10),
  DM_ATTENTE_MS: parseInt(env('DM_ATTENTE_MS', '600000'), 10),
  DM_REVANCHE_MS: parseInt(env('DM_REVANCHE_MS', '90000'), 10),
  DM_RAKE_SUR_NUL: env('DM_RAKE_SUR_NUL', '0') === '1',

  /* ---- virements entre joueurs ----
     Le depot prealable n'est pas une formalite : sans lui, ouvrir dix
     portefeuilles jetables, ramasser dix bonus de bienvenue et tout rassembler
     sur un onzieme ne couterait rien. */
  /* La photo de profil televersee s'affiche chez les AUTRES joueurs. On la
     reserve donc a ceux qui ont depose au moins une fois : ca donne un compte
     a qui parler si l'image pose probleme, et ca decourage le jetable. */
  AVATAR_REQUIRE_DEPOSIT: env('AVATAR_REQUIRE_DEPOSIT', '1') === '1',
  TRANSFER_MIN: parseFloat(env('TRANSFER_MIN', '10000')),
  /* ---- LE PRIX D'UN NOM ----
   *
   * Un nom public est UNIQUE sur toute la plateforme : le prendre, c'est le
   * retirer a tous les autres, pour toujours. Gratuit, cette rarete se fait
   * ramasser par le premier qui passe — cent comptes jetables prennent cent
   * bons noms en une soiree, et plus personne ne peut s'appeler comme il veut.
   *
   * Mille jetons, BRULES. Pas encaisses : bruler evite qu'un prix sur
   * l'identite ressemble a un peage, et lie la rareté des noms a la rareté du
   * jeton. C'est le sink le plus honnete du catalogue — le joueur paie pour
   * quelque chose qu'il voulait, et on ne lui promet rien en retour.
   *
   * Ce qui reste GRATUIT, et doit le rester :
   *   • le nom par defaut (les six premiers caracteres de l'adresse) ;
   *   • reposer EXACTEMENT le nom qu'on possede deja — sinon un joueur paierait
   *     pour changer sa photo, ce qu'il ne comprendrait pas ;
   *   • les noms deja choisis avant l'entree en vigueur du prix.
   */
  NAME_PRICE: parseFloat(env('NAME_PRICE', '1000')),
  TRANSFER_REQUIRE_DEPOSIT: env('TRANSFER_REQUIRE_DEPOSIT', '1') === '1',

  /* ---- le parrainage ----
   *
   * Le parrain touche une part du REVENU que son filleul rapporte a la
   * maison. Ni un pourcentage des depots, ni un pourcentage du volume : le
   * revenu reel. C'est ce qui rend le systeme etanche sans aucun garde-fou —
   * pour se verser dix pour cent de ses propres pertes, il faut d'abord en
   * perdre cent.
   *
   * Le revenu d'une manche vaut :
   *   • contre la banque : la mise moins ce qui a ete rendu. Signe : une
   *     manche gagnee par le filleul compte NEGATIVEMENT ;
   *   • en un-contre-un (Connect 4, dames, morpion, poker) : une fraction de
   *     la mise. Ce que la maison prend vraiment y est plus gros, mais deux
   *     comptes complices peuvent fabriquer du volume a volonte — on n'en
   *     compte donc qu'une petite part, et la complicite reste perdante.
   */
  REFERRAL_BPS: parseInt(env('REFERRAL_BPS', '1000'), 10),        // 10 % du revenu — le palier de depart
  /* ---- LA PART MONTE PAR PALIER DE NIVEAU ----
   *
   * Un point par palier, de 10 % a Bronze jusqu'a 20 % a SWOLE. Deux points
   * d'un coup sur le dernier : le palier qui demande cinq cents millions de
   * volume ne peut pas valoir la meme marche que les autres.
   *
   * C'est le SEUL avantage chiffre du systeme de niveaux, et le seul qu'on
   * puisse accorder sans risque : ce n'est pas un montant, c'est une PART DU
   * REVENU REEL du filleul. Doubler la part ne peut donc jamais couter plus
   * que ce que le filleul a rapporte — au pire la maison garde 80 % au lieu
   * de 90 % de quelque chose qu'elle a deja encaisse. Un bonus fixe, lui,
   * aurait pu couter plus que ce qu'il rapporte.
   *
   *   Bronze 10 · Silver 11 · Gold 12 · Platinum 13 · Diamond 14
   *   Master 15 · Champion 16 · Legend 17 · Mythic 18 · SWOLE 20
   */
  REFERRAL_PALIER_BPS: String(env('REFERRAL_PALIER_BPS',
    '1000,1100,1200,1300,1400,1500,1600,1700,1800,2000'))
    .split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0),
  /* Le DELAI avant qu'un gain de parrainage soit encaissable.
   *
   * Sans lui, une part est versee des la manche perdue par le filleul — et si
   * le filleul reprend tout le lendemain, la maison a paye sur un revenu
   * qu'elle n'a plus. Avec le delai, le gain reste en attente pendant sept
   * jours et REDESCEND si le filleul se refait dans l'intervalle. Ce qui est
   * mur, en revanche, ne se reprend jamais.
   *
   * Sept jours parce que c'est l'ordre de grandeur d'une serie : au-dela, ce
   * qui reste est du revenu que la maison a vraiment garde. */
  REFERRAL_HOLD_DAYS: parseFloat(env('REFERRAL_HOLD_DAYS', '7')),
  REFERRAL_PVP_BPS: parseInt(env('REFERRAL_PVP_BPS', '100'), 10), // 1 % de la mise en 1v1
  /* Ce que touche le FILLEUL en arrivant par un lien. Personne ne partage un
   * lien qui ne donne rien a l'ami.
   *
   * ---- pourquoi deux verrous, et pas un cadeau tout simple ----
   *
   * Un cadeau verse au premier depot, quel qu'en soit le montant, se recolte
   * a la chaine : cent portefeuilles jetables, un jeton depose avec chacun,
   * cent cadeaux. Le depot est reel mais derisoire, et l'operation est
   * rentable. Deux verrous, donc :
   *
   *  1. un depot MINIMUM. Il faut engager vingt fois le cadeau pour l'avoir,
   *     et cet argent-la est reellement immobilise sur la chaine ;
   *  2. une MISE A ATTEINDRE avant que le cadeau puisse ressortir. C'est le
   *     seul verrou qui coute vraiment quelque chose au recolteur : pour
   *     retirer, il doit d'abord jouer, et jouer coute l'avantage de la
   *     maison. Sans lui, le premier verrou ne fait que deplacer le prix
   *     d'entree.
   */
  REFERRAL_WELCOME: env('REFERRAL_WELCOME', '500'),
  REFERRAL_WELCOME_MIN: parseFloat(env('REFERRAL_WELCOME_MIN', '10000')),
  /* La sortie de secours, en multiples du cadeau. Le verrou principal n'est
     PAS un volume a miser — il se contournerait par le jeu le moins cher :
     miser au blackjack, dont l'avantage maison est d'un demi pour cent, ne
     coute presque rien. Le verrou principal est que LA MAISON AIT GAGNE le
     montant du cadeau sur ce joueur.
     Ce volume-ci ne sert qu'au joueur honnete et chanceux, qui gagne et ne
     debloquerait jamais : a deux cents fois le cadeau mise, le compte est
     largement rentable meme au jeu le moins cher. */
  REFERRAL_WELCOME_ROLLOVER: parseFloat(env('REFERRAL_WELCOME_ROLLOVER', '200')),

  // ---- Sessions ----
  // Duree pendant laquelle une signature vaut connexion. Passe ce delai, le
  // joueur resigne une fois. Trente jours est le compromis habituel : assez
  // long pour qu'on ne le remarque pas, assez court pour qu'un jeton vole
  // finisse par mourir.
  SESSION_TTL_SEC: parseInt(env('SESSION_TTL_SEC', String(30 * 86400)), 10),
  // Secret qui signe les jetons. Laisse vide, il est engendre au premier
  // demarrage et conserve avec l'etat — les sessions survivent donc aux
  // redeploiements. Le changer deconnecte TOUT LE MONDE d'un coup : c'est le
  // bouton d'urgence si un jeton fuite.
  SESSION_SECRET: env('SESSION_SECRET', ''),

  CASINO_MIN_BET: parseInt(env('CASINO_MIN_BET', '10'), 10),
  // Plafond volontairement bas : ici c'est l'argent de la maison qui est en
  // jeu, et au Hold'em suivre engage 3x l'Ante, soit 30 000 sur une main.
  CASINO_MAX_BET: parseInt(env('CASINO_MAX_BET', '10000'), 10),

  // ---- SWOGE Poker (Texas Hold'em, 6 max, pas de bot) ----
  // Une table ne distribue jamais tant qu'un deuxieme joueur reel n'est pas
  // assis. Une minute par decision, exclusion apres 5 mains sans action.
  POKER_ACTION_MS: parseInt(env('POKER_ACTION_MS', '60000'), 10),
  POKER_IDLE_HANDS: parseInt(env('POKER_IDLE_HANDS', '5'), 10),
  POKER_BETWEEN_HANDS_MS: parseInt(env('POKER_BETWEEN_HANDS_MS', '6000'), 10),
  POKER_RAKE_BPS: parseInt(env('POKER_RAKE_BPS', '500'), 10),   // 5 %, seulement si le flop est vu
  // La cave par defaut vaut 20 a 200 grosses blindes : c'est ce qui rend le
  // poker jouable. Une cave enorme sur de petites blindes ne sert a rien —
  // a 10 M sur du 250/500 on serait a 20 000 blindes de profondeur, et plus
  // aucune mise ne peserait vraiment sur la main. L'echelle monte donc avec les blindes.
  POKER_TABLES: [
    { id: 'micro', name: 'Doge Micro', smallBlind: 5,      bigBlind: 10,
      minBuyIn: 200,       maxBuyIn: 2000 },
    { id: 'low',   name: 'Wolf Low',   smallBlind: 250,    bigBlind: 500,
      minBuyIn: 10000,     maxBuyIn: 100000 },
    { id: 'high',  name: 'Bull High',  smallBlind: 12500,  bigBlind: 25000,
      minBuyIn: 500000,    maxBuyIn: 10000000 },
  ],

  // ---- SWOGE Spin (Volcano slot) ----
  // Allowed bets; each spin costs `bet` $SWOGE, payout = base × bet (RTP ~70%).
  VOLCANO_BETS: [10, 20, 50, 100, 500, 1000, 10000, 100000],
  VOLCANO_BONUS_COST_MULT: 33,   // "Buy Bonus" costs bet × this (tuned so the bought feature is ~70% RTP, matching the base game, after the fuller-board rebalance)

  // ---- Physics / table (server units) ----
  TABLE: {
    width: 11,         // X extent of the shelf
    depth: 13,         // Z extent — SHORTER so coins actually reach the front
    frontEdgeZ: 4.5,   // coins pushed beyond this Z fall off the front = WIN
    pusherTravel: 7.5, // long stroke: retracts fully to the back wall, pushes near the front
    pusherSpeed: 1.7,  // faster, stronger stroke (user: too slow / not pushing hard enough)
    coinRadius: 0.7,
    coinThickness: 0.35,
    dropY: 6,
    stepHz: 60,       // physics steps per second
    maxCoins: 220,    // hard cap — keeps the server sim fast = smoother playback
  },
  BROADCAST_HZ: parseInt(env('BROADCAST_HZ', '30'), 10), // 30 snapshots/sec = smoother
};
