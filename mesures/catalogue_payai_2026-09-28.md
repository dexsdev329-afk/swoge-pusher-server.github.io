# Le catalogue PayAI des services x402 — mesure au 28/09/2026

Pour le propriétaire de SWOGE (vendeur de 16 outils x402 inscrits au catalogue, et acheteur via SwogeAgentic).

- **Source** : `https://facilitator.payai.network/discovery/resources`, 16 pages de 500. Le champ `pagination.total` annonce 7 529 entrées et les 7 529 sont présentes. Le téléchargement date du 28/09/2026 vers 16:43 UTC. L'entrée la plus récente porte `lastUpdated` = 2026-09-28T16:41:41Z.
- **Sonde** : le 28/09/2026 à 17:07 UTC, 153 services mainnet tirés au hasard (graine 402), plus nos 16 entrées en témoin, plus les 17 points d'achat réel. Données brutes dans `mesures/catalogue_payai_2026-09-28/sonde_payai.json`.
- **Règles de la sonde** : aucun paiement. Une seule requête non payée par service : GET, ou POST avec le corps `{}` quand le catalogue dit POST. Délai de 10 s. Aucun en-tête `PAYMENT-SIGNATURE` ni `X-PAYMENT`, aucune clé, aucune donnée personnelle.
- **Scripts** (dans `mesures/catalogue_payai_2026-09-28/`) : `payai_lib.py` (normalisation et catégories), `analyse.py` (chiffres du catalogue, sortie dans `analyse_out.txt` et `stats_payai.json`), `sonde.py` (sonde de vie), `dns_hotes.py` (DNS de tous les hôtes, sortie dans `dns_hotes.json`) et `conc_listes.txt` (concurrents outil par outil).

---

## 0. L'essentiel en dix lignes

1. **Taille** : 7 529 entrées, soit 7 520 URL distinctes, 923 hôtes et 725 adresses de paiement (`payTo`). 98,7 % sont en mainnet et 99,8 % sont payées en USDC.
2. **Réseaux** : Base porte 74 % des entrées (5 559) et Solana 24 % (1 823). Le reste pèse moins de 1 %.
3. **Prix** : la médiane est de **0,01 $**, les quartiles de 0,002 $ et 0,02 $. **69 %** des entrées coûtent 0,01 $ ou moins. Seules 108 entrées dépassent 1 $.
4. **Concentration** : un seul hôte (`api.delx.ai`) publie 13,4 % du catalogue, les 10 premiers hôtes en publient **49,7 %**, et 526 hôtes n'ont qu'une entrée.
5. **Remplissage** : beaucoup d'entrées sont des instances d'une même route. Les 7 529 entrées se ramènent à 6 718 gabarits de route. Une même description est recopiée 316 fois (« ASRAI API »).
6. **Vie** : sur l'échantillon, **77 %** des services renvoient un 402 lisible (IC 95 % : 70–83 %). 13 % sont morts ou injoignables (IC 95 % : 9–19 %). Le reste répond, mais pas par un 402 exploitable.
7. **Prix affiché** : le prix du 402 correspond au catalogue dans **92 %** des cas (109 sur 118). Il est **plus cher dans 7 cas, jusqu'à 20 fois**.
8. **Nos outils** : nous sommes **seuls** sur colony_activity, swoge_economy, et sur la lecture RPC, transaction et portefeuille de Robinhood Chain. Nous sommes **dans la moyenne** sur scan_token et token_verdict. Nous sommes **chers** sur osint_lookup, web_search et can_i_sell (sur Base).
9. **Trous** : aucune vérification *provably fair*. Les cotes de bookmaker n'ont qu'une entrée, et c'est un convertisseur. Il y a 6 entrées de scores sportifs chez 2 hôtes. Les lancements de memecoins Base/Clanker comptent environ 5 entrées, contre 47 pour pump.fun. Les manches UP/DOWN n'ont aucun relevé mesuré.
10. **Achats réels** : il en existe une poignée — eSIM, dropshipping UE, numéros virtuels (sur testnet), SMS, publicité, engagement social acheté. **Bitrefill et Laso Finance sont absents** : 0 occurrence dans les 12,5 Mo du catalogue.

---

## 1. Taille

| Mesure | Valeur |
|---|---:|
| Entrées | 7 529 |
| URL distinctes (`resource`) | 7 520 (9 doublons exacts) |
| Hôtes distincts | 924 (923 sans le port) |
| Adresses `payTo` distinctes | 725 |
| x402 v2 / v1 | 6 162 (81,8 %) / 1 367 (18,2 %) |
| Type `http` / `mcp` | 7 500 / 29 |
| URL en `https` / `http` | 6 742 (89,5 %) / 787 (10,5 %) |
| Schéma `exact` / `upto` | 7 527 / 2 |
| Méthode déclarée GET / POST / HEAD / DELETE / absente | 3 907 / 3 575 / 16 / 1 / 30 |
| Une seule offre (`accepts`) par entrée | 7 529 sur 7 529 |
| Même URL inscrite sur plusieurs réseaux | 0 |
| Sans aucune description | 2 377 (31,6 %) |
| Avec schéma d'entrée « bazaar » (`extensions.bazaar.info`) | 1 843 (24,5 %) |
| Avec schéma de sortie | 5 415 (71,9 %) |

**Réseaux**

| Réseau | Entrées | Nature |
|---|---:|---|
| Base (eip155:8453 / « base ») | 5 559 | mainnet |
| Solana | 1 823 | mainnet |
| Polygon | 33 | mainnet |
| X Layer (eip155:196) | 8 | mainnet |
| Arbitrum | 3 | mainnet |
| Sei (eip155:1329) | 2 | mainnet |
| eip155:1187947933 (actif déclaré « Bridged USDC (SKALE Bridge) ») | 2 | mainnet (déclaré) |
| Avalanche, peaq | 1 + 1 | mainnet |
| Base Sepolia | 74 | **testnet** |
| Solana devnet | 17 | **testnet** |
| Polygon Amoy, X Layer testnet, Sei testnet | 2 + 1 + 1 | **testnet** |
| eip155:1952 (actif « Global Dollar ») | 2 | inconnu : réseau non identifié avec certitude |
| **Total mainnet / testnet / inconnu** | **7 432 / 95 / 2** | |

**Actifs** : 7 514 entrées sont payées en USDC.

- 7 501 sont reconnues par l'adresse officielle du contrat ou du mint : Base, Solana, Polygon, Arbitrum, Avalanche et leurs testnets.
- 13 ne sont identifiées que par le nom déclaré « USDC » : X Layer (7), Sei (2), Polygon Amoy (2), Sei testnet (1) et peaq (1).
- Les 15 autres entrées se répartissent ainsi : un actif Solana `euro5sNH…` sans nom déclaré (6), le « Bridged USDC » de SKALE (2), le « Global Dollar » (2), le Wrapped SOL (2), un `USDC_TEST` (1), un « USD Coin » X Layer v1 (1) et « x402 Roshambo » (1).
- Seul l'USDC reconnu par son adresse est converti en dollars. Le reste a un prix « inconnu ».

**Fraîcheur** (`lastUpdated`) : 1 071 entrées ont été mises à jour depuis moins de 24 h, 1 467 depuis moins de 7 jours, 2 488 depuis moins de 30 jours et 5 751 depuis moins de 90 jours. La plus ancienne date du 2025-10-02.

**DNS** (les 923 hôtes, résolus en DNS-over-HTTPS chez Cloudflare) : 920 résolvent. 3 sont en NXDOMAIN (`3dprintedcat.com`, `api.beyourspace.es`, un projet `supabase.co`), ce qui fait **16 entrées mortes par le DNS**.

## 2. Prix

Le périmètre est l'USDC mainnet dont le contrat est connu, soit 7 410 entrées. Montant = `amount` (v2) ou `maxAmountRequired` (v1), divisé par 10⁶.

| | n | min | Q1 | médiane | Q3 | max | moyenne |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tout le catalogue | 7 410 | 0 | 0,002 | **0,01** | 0,02 | 100 | 0,214 |
| Base | 5 558 | 0 | 0,001 | 0,01 | 0,02 | 100 | 0,226 |
| Solana | 1 815 | 0,0001 | 0,005 | 0,01 | 0,03 | 50 | 0,178 |
| Polygon | 33 | 0,0001 | 0,001 | 0,005 | 0,01 | 0,01 | 0,006 |
| Médiane de chaque hôte (un point par hôte) | 871 | 0 | 0,005 | 0,01 | 0,05 | 29 | 0,305 |

| Tranche ($) | Entrées | % |
|---|---:|---:|
| = 0 | 15 | 0,2 |
| ]0 ; 0,001] | 1 712 | 23,1 |
| ]0,001 ; 0,005] | 1 553 | 21,0 |
| ]0,005 ; 0,01] | 1 846 | 24,9 |
| ]0,01 ; 0,05] | 1 292 | 17,4 |
| ]0,05 ; 0,1] | 376 | 5,1 |
| ]0,1 ; 1] | 508 | 6,9 |
| ]1 ; 10] | 93 | 1,3 |
| > 10 | 15 | 0,2 |

**Lecture** : le marché se paie au centime. **69 %** des entrées coûtent 0,01 $ ou moins, et 44 % coûtent 0,005 $ ou moins. Les prix au-dessus de 1 $ sont des commandes (dropshipping à 50,97 $), des crédits prépayés ou des vidéos.

Les prix par catégorie sont dans le tableau de la section 3.

## 3. Catégories

### Méthode

- **Texte classé** : l'URL (chemin découpé en mots, camelCase séparé) ainsi que la description, la `metadata.description`, la description de l'offre, `serviceName`, `tags` et `toolName`.
- **Score** : chaque catégorie a une liste de motifs en mots entiers. Un motif trouvé dans la description compte 2, un motif trouvé dans le chemin seul compte 1. Les mots génériques des chemins (`api`, `v1`, `x402`, `tools`, `agent`, `invoke`…) sont retirés. L'hôte ne sert qu'en dernier recours.
- **Choix** : la catégorie de plus haut score l'emporte. En cas d'égalité, c'est l'ordre de la liste qui départage : achats, paris et jeux, sécurité, on-chain, LLM, média, social, OSINT, finance, prix crypto, météo, recherche, dev.
- **Tests** : les motifs forts (echo, ping, hello world, don, pourboire, « test charge ») classent en « tests » si la description n'est pas riche par ailleurs.
- **Contrôle** : j'ai lu 140 entrées tirées au hasard (10 par catégorie, graine 99). **104 étaient bien classées (≈ 74 %)**. La précision est bonne sur image, LLM, paris et prix crypto (9 sur 10). Elle est médiocre sur on-chain, recherche web et tests (6 sur 10), à cause des centaines d'utilitaires de `api.delx.ai` qui citent des termes crypto. Les comptes ci-dessous sont donc des **ordres de grandeur à ±25 %**, pas des vérités à l'unité.
- **Non classé** : 668 entrées (8,9 %), surtout des URL sans description (`x402.aurelianflo.com`, `api.x402node.dev`, `x402.asrai.me`).

### Comptes, prix et fournisseurs

Prix en $ (USDC mainnet).

| Catégorie | Entrées | % | Hôtes | Min | Q1 | Médiane | Q3 | Max | Fournisseurs principaux (entrées) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Outils dev / utilitaires / calcul | 1 848 | 24,5 | 192 | 0 | 0,001 | 0,001 | 0,005 | 29 | api.delx.ai (786), www.cloudworldmodel.ai (285), agent402.tools (135) |
| Prix / marché crypto / DeFi / trading | 1 269 | 16,9 | 221 | 0 | 0,005 | 0,01 | 0,02 | 100 | x402.asrai.me (268), api.x402node.dev (125), payai.agentstools.dev (59) |
| Recherche web / scraping / actualités / documents | 859 | 11,4 | 179 | 0,0001 | 0,008 | 0,01 | 0,015 | 5 | intel.rallylive.ca (248), changelog-state-api.replit.app (63), payai.agentstools.dev (50) |
| Données on-chain (portefeuilles, tx, RPC, contrats) | 786 | 10,4 | 204 | 0,0001 | 0,002 | 0,01 | 0,05 | 100 | api.delx.ai (91), api.x402node.dev (56), mpp.hyreagent.fun (55) |
| Non classé | 668 | 8,9 | 232 | 0 | 0,005 | 0,01 | 0,064 | 100 | x402.aurelianflo.com (74), api.x402node.dev (52), x402.asrai.me (43) |
| Analyse de jeton / sécurité / risque | 404 | 5,4 | 131 | 0 | 0,01 | **0,02** | 0,1 | 3 | mpp.hyreagent.fun (77), payai.agentstools.dev (64), base-agent-preflight.bytoken2023 (15) |
| Finance traditionnelle (actions, FX, macro, entreprises) | 365 | 4,8 | 89 | 0,001 | 0,005 | 0,01 | 0,02 | 10 | api.x402node.dev (117), payai.agentstools.dev (48), agent402.tools (27) |
| OSINT / infra internet (DNS, WHOIS, IP, e-mail) | 280 | 3,7 | 68 | 0 | 0,002 | 0,01 | 0,01 | 1 | intel.rallylive.ca (95), api.delx.ai (48), payai.agentstools.dev (16) |
| LLM / chat / texte généré | 227 | 3,0 | 92 | 0 | 0,005 | 0,01 | 0,05 | 5 | gpt55.558686.xyz (58), x402factory.ai (12), intel.rallylive.ca (10) |
| Météo / géo / transport / logistique | 211 | 2,8 | 52 | 0 | 0,005 | 0,01 | 0,015 | 2,5 | api.x402node.dev (21), intel.rallylive.ca (16), data.intel.rallylive.ca (15) |
| Tests / démos / echo / dons | 172 | 2,3 | 74 | 0 | 0,003 | 0,01 | 0,5 | 5 | aoe-tip-seller.magicalcifer.workers.dev (39), api.agnichub.xyz (21), api.delx.ai (11) |
| Réseaux sociaux | 163 | 2,2 | 42 | 0 | 0,007 | 0,01 | 0,05 | 5 | wurkapi.fun (26), x402-x.madnodes.xyz (16), x-data-gateway.annushka1190 (11) |
| Image / vidéo / audio | 157 | 2,1 | 53 | 0,001 | 0,005 | 0,01 | 0,03 | 1,8 | x402.aurelianflo.com (19), api.delx.ai (15), api.x402node.dev (12) |
| Paris, marchés de prédiction, sport, jeux, divination | 110 | 1,5 | 35 | 0,001 | 0,005 | 0,01 | 0,02 | 5 | payai.agentstools.dev (13), sol.blockrun.ai (13), api.cn402.com (13) |
| Commerce / achats réels | 10 | 0,1 | 7 | 0,008 | 0,2 | 0,25 | 0,6 | 50,97 | voir la section 8 : la liste exhaustive a été faite à la main |

### Exemples (prix catalogue)

- **Outils dev** : `api.delx.ai/…/roman-to-int` (0,001 $), `intel.rallylive.ca/data/json-to-csv` (0,01 $), `relay402.georgespring…/security-npm-risk` (0,015 $).
- **Prix crypto** : `x402.asrai.me/api/signal/{paire}/1D` (indicateurs techniques, 0,05 $), `earn-pulse…/fng` (Fear & Greed, 0,005 $), `x402.santyvv.com/api/crypto/token-price-historical`.
- **Recherche web** : `payai.agentstools.dev/search` (0,003 $), `aws-bedrock.grok.me/api/v1/search` (Tavily, 0,005 $), `stableenrich.dev/api/exa/search` (0,01 $).
- **On-chain** : `api.nansen.ai/api/v1/tgm/pnl-leaderboard` (0,05 $), `mpp.hyreagent.fun/traders/token-whales` (0,03 $), `x402.santyvv.com/api/chain/transaction` (0,02 $).
- **Sécurité jeton** : `api.x402risk.com/v1/token-check` (Base, 0,01 $), `mpp.hyreagent.fun/trenches/token/{mint}/verdict` (Solana, 0,15 $), `trust-check.gm-tools…/v1/token` (Base, simulation d'achat et de vente, 0,003 $).
- **Finance** : `api.x402node.dev/stock/quote/{ticker}`, `payai.agentstools.dev/holdings/security` (0,06 $), `cabrini.ai/v1/company` (0,005 $).
- **OSINT** : `intel.rallylive.ca/whois` (0,01 $), `domain-intelligence.nordman-tehau…/rdap` (0,001 $), `49112-…splox.app/dns` (0,0005 $).
- **LLM** : `openrelay…/v1/chat/completions` (0,001 $), `gpt55.558686.xyz/v1/chat/completions/gpt-5.5` (0,091 $), `padelmaps.org/api/x402-uncensored/chat` (0,05 $).
- **Météo / géo** : `intel.rallylive.ca/data/forecast`, `payai.agentstools.dev/geocode` (0,002 $), `aviationapis.com/metar`.
- **Social** : `x402.twit.sh/tweets/search` (0,006 $), `x-data-gateway…/users/followers` (0,008 $), `wurkapi.fun/solana/xraid/large` (engagement acheté, 5 $).
- **Image / vidéo / audio** : `fal.x402.paysponge.com/fal-ai/flux/schnell` (0,01 $), `www.trezalabs.com/api/x402/music` (0,06 $), `api.render402.xyz/v1/generate` (vidéo, 0,023 $).
- **Paris / jeux** : `sol.blockrun.ai/api/v1/pm/kalshi/markets` (0,0075 $), `payai.agentstools.dev/sports/scores` (0,005 $), `api.cn402.com/fengshui/…` (divination).
- **Tests / dons** : `aoe-tip-seller…/tip?to=0x…` (39 entrées de pourboire), `volkov…/pay/ping` (0,001 $), `api.agnichub.xyz/…` (« Pay with base », 21 entrées).

## 4. Qualité : ce qui répond vraiment

### Échantillon

- **Tirage** : 153 services mainnet, hors nos entrées, tirés dans une population de 7 416.
- **Stratification** : par catégorie, 5 services au minimum par catégorie, le reste au prorata de la taille (graine 402).
- **Couverture** : 85 hôtes distincts. 80 GET et 73 POST `{}`.
- **Délais** : médiane de 0,82 s, 90ᵉ centile de 1,36 s parmi les 402.

### Résultats par catégorie

Colonnes : **402 OK** = 402 avec `accepts` décodé, dans l'en-tête `payment-required` (base64 JSON) ou dans le corps JSON. **402 sans offre** = 402 sans `accepts`. **4xx refus** = 400, 405 ou 422, c'est-à-dire un service vivant qui refuse la requête vide. **4xx mort** = 404 ou 410.

| Catégorie | n | 402 OK | 402 sans offre | 200 gratuit | 4xx refus | 4xx mort | Délai > 10 s | Injoignable | % 402 OK |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Outils dev | 24 | 21 | 1 | 0 | 0 | 2 | 0 | 0 | 88 % |
| Prix crypto | 18 | 15 | 1 | 1 | 1 | 0 | 0 | 0 | 83 % |
| Recherche web | 14 | 12 | 0 | 0 | 0 | 1 | 0 | 1 | 86 % |
| On-chain | 13 | 10 | 1 | 0 | 0 | 2 | 0 | 0 | 77 % |
| Non classé | 12 | 5 | 0 | 0 | 2 | 5 | 0 | 0 | 42 % |
| Finance | 9 | 8 | 0 | 0 | 0 | 1 | 0 | 0 | 89 % |
| Sécurité jeton | 9 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | 100 % |
| OSINT | 8 | 7 | 0 | 0 | 1 | 0 | 0 | 0 | 88 % |
| Image / vidéo / audio | 7 | 5 | 1 | 0 | 0 | 1 | 0 | 0 | 71 % |
| LLM | 7 | 4 | 0 | 0 | 1 | 2 | 0 | 0 | 57 % |
| Météo / géo | 7 | 5 | 0 | 1 | 1 | 0 | 0 | 0 | 71 % |
| Social | 7 | 3 | 2 | 0 | 0 | 0 | 2 | 0 | 43 % |
| Tests / dons | 7 | 5 | 0 | 0 | 0 | 2 | 0 | 0 | 71 % |
| Paris / jeux | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 100 % |
| Achats réels | 5 | 3 | 0 | 0 | 1 | 1 | 0 | 0 | 60 % |
| **Total** | **153** | **118** | **6** | **2** | **7** | **17** | **2** | **1** | **77 %** |

**Intervalles de confiance à 95 %** (méthode de Wilson) :

- 402 lisible : 118 sur 153 = 77 % (IC 70–83 %).
- Service qui répond (402, 200 ou refus de la requête vide) : 133 sur 153 = 87 % (IC 81–91 %).
- Mort ou injoignable (404/410, 5xx, délai, connexion) : 20 sur 153 = 13 % (IC 9–19 %).
- Aucun DNS mort dans l'échantillon. Sur tout le catalogue, 16 entrées sur 7 529 (section 1).

**Par catégorie, n va de 5 à 24** : ces taux ne départagent pas les catégories entre elles, sauf « non classé » (42 %) et « social » (43 %), nettement sous la moyenne. Les entrées sans description meurent plus souvent.

**La fraîcheur prédit la vie** :

- Âge médian du `lastUpdated` : **31 jours** pour les services qui renvoient un 402 lisible, **93 jours** pour les autres.
- Mis à jour depuis moins de 90 jours : 99 sur 115 en 402 lisible (86 %). Au-delà de 90 jours : 19 sur 38 (50 %).
- Pour SwogeAgentic, un filtre `lastUpdated` de moins de 90 jours écarterait la moitié des morts.

**Prix du 402 contre prix du catalogue** (118 402 lisibles, même réseau et même actif) :

| Résultat | n |
|---|---:|
| Identique | 109 (92 %) |
| 402 **plus cher** | 7 : ×3,7 (trezalabs short 0,87 → 3,22 $), ×20 (nichospt 0,0005 → 0,01 $), ×5 (market2000 0,05 → 0,25 $), ×5 (asrai superalsat 0,001 → 0,005 $), ×6 et ×14 (defi-intel-agent-gateway 0,0025 → 0,015 / 0,035 $), ×20 (bykaranteli 0,005 → 0,1 $) |
| 402 moins cher | 2 (asrai 0,05 → 0,005 $) |

**Adresse de paiement** : dans **11 cas sur 118**, l'adresse du 402 diffère de celle du catalogue (asrai, madeonsol, wouldpayagain, merchant.payai, heurist, aoe-tip-seller).

**Conséquence pour SwogeAgentic** : le plafond `maxAppelUsd` doit s'appliquer au montant **lu dans le 402**, jamais au prix du catalogue. Idéalement, il faut aussi refuser quand l'adresse du 402 diffère de celle du catalogue. Je n'ai pas relu `embauche.js` pour vérifier ce qu'il fait aujourd'hui.

**Format** : 108 des 118 402 lisibles portent l'offre dans l'en-tête v2 `payment-required`. 10 la portent dans le corps v1. 41 proposent un seul réseau, 77 en proposent 2 ou plus.

**Nos 16 entrées (témoin)** : 16 sur 16 renvoient un 402 lisible, avec la même adresse de paiement. Le prix est identique 15 fois. `chat_completion` affiche 0,005 $ au catalogue et 0,007642 $ au 402 : c'est normal, le prix est variable et calculé sur la requête.

## 5. Concentration

| Rang | Hôte | Entrées | % | Cumul |
|---:|---|---:|---:|---:|
| 1 | api.delx.ai | 1 012 | 13,4 | 13,4 |
| 2 | api.x402node.dev | 492 | 6,5 | 20,0 |
| 3 | intel.rallylive.ca | 490 | 6,5 | 26,5 |
| 4 | payai.agentstools.dev | 362 | 4,8 | 31,3 |
| 5 | x402.asrai.me | 318 | 4,2 | 35,5 |
| 6 | www.cloudworldmodel.ai | 311 | 4,1 | 39,6 |
| 7 | agent402.tools | 265 | 3,5 | 43,2 |
| 8 | mpp.hyreagent.fun | 180 | 2,4 | 45,6 |
| 9 | x402.aurelianflo.com | 178 | 2,4 | 47,9 |
| 10 | gpt55.558686.xyz | 132 | 1,8 | **49,7** |

- **Répartition des hôtes** : 10 hôtes publient 100 entrées ou plus, 55 en publient 20 ou plus, 103 en publient 10 ou plus. 526 hôtes, soit 57 %, n'ont qu'**une** entrée.
- **Indice HHI** sur les hôtes : 364, peu concentré au sens antitrust. Mais la moitié du catalogue vient de 10 publieurs.
- **Adresses de paiement** : les cinq premières encaissent pour 973, 544, 533, 361 et 309 entrées.

**Remplissage** : des entrées qui sont des instances, pas des services.

- `www.cloudworldmodel.ai` publie une entrée **par simulation** : `simulations/{uuid}/step-hybrid` 124 fois, `inject-traffic` 87 fois, `inject-failure` 62 fois.
- `mpp.hyreagent.fun/trenches/token/{mint}/verdict` apparaît 52 fois, une par jeton.
- `x402.asrai.me/api/{indicateur}/{paire}/{période}` décline 15 à 16 paires par indicateur.
- `aoe-tip-seller…/tip?to=0x…` apparaît 39 fois, une par destinataire.
- Au total, 7 529 entrées se ramènent à **6 718 gabarits de route** une fois les identifiants remplacés.

**Doublons de description** :

- 5 152 entrées ont une description, et on n'en compte que **4 167 distinctes**.
- 154 descriptions sont répétées et couvrent 1 139 entrées. « ASRAI API » apparaît 316 fois, « Inject traffic into a running simulation… » 76 fois, « Full AI verdict on a Solana token… » 53 fois.
- 71 descriptions identiques reviennent **sur plusieurs hôtes**. Ce sont des déploiements multiples du même code : 4 URL de preview Vercel pour « Claude inference », 4 hôtes Brandfetch staging et dev, 4 démos de dons, 4 hôtes « Exa Search » de merit-systems.

## 6. Nos outils face au marché

Méthode :

- Les concurrents sont repérés par mots-clés propres à chaque outil, sur le catalogue mainnet sans nos entrées.
- Sont exclus les utilitaires hors ligne (« local utility », « without network », « shape check »), qui ne lisent pas le monde.
- « Gabarits » = routes distinctes, pour ne pas compter 60 fois le même verdict par jeton.
- Notre prix est **celui du catalogue**. Toutes nos entrées sont inscrites sur **Solana**, sauf `ask_agent`, inscrit sur Base. Ce prix inclut le coût de règlement, avec un minimum de 0,02 $ sur la plupart des outils.
- La liste brute, triée par prix, est dans `mesures/catalogue_payai_2026-09-28/conc_listes.txt`.

| Notre outil | Notre prix | Concurrents : entrées / hôtes / gabarits | Prix concurrents (min / médiane par gabarit) | Entrées moins chères que nous | Concurrents les plus proches | Position |
|---|---:|---|---|---:|---|---|
| scan_token | 0,02 | 195 / 60 / 127 | 0,001 / 0,02 | 59 (30 %) | defi-intel evm-rugcheck 0,0025 ; trust-check.gm-tools (Base, simule achat et vente) 0,003 ; yieldprobe security 0,003 ; x402risk token-check 0,01 ; mesh.heurist GoPlus 0,01 ; token.lonestaroracle 0,15 | **Dans la médiane.** 5 à 8 concurrents EVM à 0,01 $ ou moins. Personne n'ajoute la mesure de la colonie par trait. |
| token_verdict | 0,01 | 86 / 15 / 27 | 0,002 / 0,04 | 1 | agentfx (pump.fun) 0,002 ; presign-guard 0,01 ; aiworker trade/gate 0,05 ; hyreagent verdict 0,15 | **Parmi les moins chers.** Seul un concurrent Solana est en dessous. |
| can_i_sell | 0,022 | 34 / 22 / 32 | 0,001 / 0,02 | 16 (47 %) | trust-check.gm-tools 0,003 (Base) ; x402risk pretrade-check 0,02 (Base) ; bentcrypto exit-simulation 0,03 ; **chiefofstaff /rh/check 0,01 (Robinhood Chain)** | **Plus cher.** Sur Robinhood Chain, un seul concurrent déclaré, deux fois moins cher, mais qui ne dit pas simuler la vente. |
| roast_token | 0,02 | 2 / 2 / 2 | 0,02 / 0,035 | 0 | anchor-x402 /v1/roast 0,05 (n'importe quelle cible) ; accelerometer « safe, a joke or a rug » 0,02 (Solana) | **Quasi seul** sur le roast fondé sur des données EVM. |
| wallet_intel | 0,022 | 88 / 18 / 29 | 0,001 / 0,01 | 18 (20 %) | origin-mcp basescan_deployer_history 0,002 ; madeonsol deployer-hunter 0,01 (Solana) ; ragradar deployer 0,01 ; hyreagent wallet-intel 0,05–0,12 | **Au-dessus de la médiane.** Sur les déployeurs EVM, 2 à 3 concurrents seulement. |
| osint_lookup | 0,022 | 135 / 26 / 135 | 0,0005 / 0,01 | 129 (96 %) | splox DNS 0,0005 ; nordman RDAP 0,001 ; rallylive (54 routes à 0,01) ; payai.agentstools domain/trust 0,02 | **Parmi les plus chers.** Notre seul argument est le tout-en-un « findings first ». |
| web_search | 0,02 | 32 / 16 / 32 (hors 21 faux positifs delx) | 0,001 / 0,011 | 20 (63 %), et 9 au même prix | payai.agentstools /search 0,003 ; Tavily (aws-bedrock.grok.me) 0,005 ; citable SERP 0,008 ; Exa 0,01 ; **Perplexity chez paysponge 0,01** | **2 à 7 fois plus cher.** La même source (Perplexity) se vend 0,01 $ ailleurs. |
| chat_completion | 0,005 (variable) | 35 / 19 / 35 | 0,00006 / 0,003 | 19 (54 %) | openrelay 0,001 ; mapleai 0,0016 ; gpt55 0,003 à 0,52 selon le modèle ; paysponge OpenRouter 0,01 | **Dans la moyenne.** L'argument est l'accès aux modèles de pointe sans clé. |
| ask_agent | 0,541 (Base) | 13 / 10 / 13 | 0,001 / 0,015 | 11 | payforapi research/deep 0,05 ; syraa x-search 0,15 | **Le plus cher.** L'offre n'est pas comparable (agent complet). |
| robinhood_token / _wallet / _tx / _rpc | 0,006 | 23 / 10 / 23 (tout ce qui parle de Robinhood Chain) | 0,001 / 0,01 | 6 | percall.kimi.pro 0,002–0,01 (cours, pools v4, actions tokenisées) ; robinhoodradar 0,005–0,01 (7 flux) ; loopholetape Pons V2 0,01–0,02 ; chiefofstaff rh/check 0,01 | **Seuls sur le RPC, le décodage de transaction et les soldes de portefeuille** de Robinhood Chain. **Battus sur la fiche jeton** (percall 0,002 $). |
| new_launches | 0,02 | 7 hors RHC ; sur RHC, 3 hôtes | 0,0016 / 0,05 | 3 (+ RHC) | sur RHC : percall dex/new 0,005 ; robinhoodradar newpools / newcoins 0,005–0,01 ; loopholetape rhc/launches 0,01 | **Plus cher que 3 flux RHC.** Seuls à dire *pourquoi* la colonie a acheté ou non. |
| colony_activity | 0,02 | 0 concurrent direct (5 faux amis) | — | — | aucun relevé public de trading papier | **Seul.** |
| swoge_economy | 0,02 | 0 concurrent direct (9 fiches de supply ou d'unlock d'autres jetons) | — | — | — | **Seul par construction.** |
| generate_image | **absent du catalogue** (x402 : 0,192 $ ; coût réel ≤ 0,70 $) | 23 / 15 | 0,001 / 0,03 | — | fal flux-schnell 0,01 ; delx 0,01 ; fal flux-pro 0,04 | Au prix x402 actuel, **plus cher que les 23**. |
| generate_video | **absent du catalogue** (coût réel ≤ 3,6 $) | 14 / 8 | 0,01 / 0,29 | — | render402 0,023 ; fal minimax 0,07 ; trezalabs 0,42 ; clawhunter 0,60 | Plafond **4 fois au-dessus du concurrent le plus cher** (0,87 $). |

**Lecture** :

1. **Plancher de prix** : 10 de nos 16 entrées coûtent 0,02 $ ou plus au catalogue. Elles sont donc au-dessus de 69 % du marché, qui coûte 0,01 $ ou moins. Le plancher de 0,02 $, qui couvre le coût de règlement, nous sort du prix courant sur les outils de commodité (OSINT, recherche web).
2. **Réseau d'inscription** : nos outils ne sont inscrits au catalogue que sur Solana, alors que 74 % du catalogue est sur Base. Aucune URL du catalogue n'est inscrite sur deux réseaux (0 sur 7 520). Je n'ai pas vérifié si un agent qui filtre sur Base nous voit quand même : **à vérifier**. D'après `/agentic/x402`, `bazaar.success` vaut 0 côté CDP.

## 7. Les trous

Chaque besoin est compté par mots-clés sur le catalogue mainnet, hors utilitaires hors ligne et hors nos entrées.

| Besoin d'un agent crypto ou d'un joueur | Entrées | Hôtes | Prix min | Prix médian | Qui |
|---|---:|---:|---:|---:|---|
| Vérification *provably fair* d'un tirage de casino | **0** | 0 | — | — | personne |
| Objets de jeux vidéo / skins (Steam, CS2) | 0 | 0 | — | — | personne |
| Échecs / moteur de jeu | 0 | 0 | — | — | personne |
| Cotes sportives de bookmaker | **1** | 1 | 0,001 | 0,001 | delx (un convertisseur de cote en probabilité : pas de cotes) |
| Esports | 1 | 1 | 0,005 | 0,005 | payai.agentstools |
| NFT floor | 1 | 1 | 0,01 | 0,01 | payai.agentstools |
| Lancements de memecoins Base / Clanker / Zora | 2 (≈ 5 avec les scanners EVM génériques) | 2 | 0,0067 | 0,25 | clanker-banker, capminal ; lonestaroracle launches 0,05 ; hyreagent bags 0,08 |
| Hasard vérifiable (RNG / VRF) | 3 | 3 | 0,001 | 0,01 | anchor-x402 /v1/roll, x402-random |
| Lancer un jeton | 4 | 4 | 0,0067 | 0,03 | |
| **Scores sportifs en direct** | **6** | **2** | 0,001 | 0,005 | payai.agentstools /sports (5), predge (attestation) |
| Actions tokenisées | 6 | 2 | 0,001 | 0,01 | accelerometer (st0x), percall (Robinhood Chain) |
| Devis de swap | 6 | 6 | 0,001 | 0,01 | |
| **Manches UP/DOWN (type PancakeSwap Prediction)** | **7** | 2 | 0,003 | 0,003 | delx (estimations de probabilité, sans relevé) |
| Telegram / canaux crypto | 8 | 6 | 0,001 | 0,006 | |
| Airdrops | 11 | 7 | 0,005 | 0,05 | |
| Robinhood Chain (toute donnée) | 23 | 10 | 0,001 | 0,01 | robinhoodradar, percall, loopholetape |
| Test de revente / honeypot | 28 | 19 | 0,001 | 0,03 | surtout sur Base |
| Gaz multi-chaînes | 38 | 24 | 0,001 | 0,005 | encombré |
| PnL de portefeuille | 44 | 17 | 0,0001 | 0,02 | encombré |
| Confiance ou vie d'un service x402 | 44 | 17 | 0,001 | 0,005 | encombré |
| Alertes / webhooks | 44 | 24 | 0,001 | 0,01 | |
| Memecoins Solana (pump.fun) | 47 | 13 | 0,001 | 0,01 | encombré |
| Perps Hyperliquid / funding | 50 | 18 | 0,0001 | 0,0065 | encombré |
| Solde multi-chaînes | 56 | 31 | 0,0001 | 0,01 | encombré |
| Historique du déployeur | 70, dont 62 chez hyreagent (Solana) | 8 | 0,002 | 0,15 | sur EVM : 2 à 3 routes |
| Marchés de prédiction (Polymarket / Kalshi) | 82 | 23 | 0,001 | 0,0075 | encombré |

### Les 5 meilleures opportunités, classées

Critères : besoin évident, peu couvert, **peu cher pour nous** parce que le code existe déjà dans le dépôt du serveur, et un terrain où SWOGE peut être le plus simple à utiliser.

1. **Scores sportifs et cotes en un appel** (`live_scores`, `match_odds`).
   - *Marché* : 6 entrées de scores chez 2 hôtes, et **aucune** cote de bookmaker.
   - *Chez nous* : `scores_espn.js` lit ESPN sans clé ni quota. `cotes.js` fabrique déjà des cotes, et SwogeBet les utilise.
   - *Coût marginal* : quasi nul.
   - *Prix visé* : 0,002 à 0,005 $, sous la médiane.
   - *Pour les joueurs* : c'est le même contenu que SwogeBet. L'outil sert aussi de vitrine.
2. **Lancements de memecoins sur Base (Clanker, Zora) avec l'historique du déployeur.**
   - *Marché* : environ 5 entrées pour Base, contre 47 pour pump.fun, alors que Base porte 74 % du catalogue. Les déployeurs EVM n'ont que 2 à 3 routes.
   - *Chez nous* : `new_launches` et `wallet_intel` font déjà ce travail sur les lanceurs de Robinhood Chain. Il s'agit d'étendre l'indexeur aux fabriques Base.
   - *Coût* : modéré, ce sont des lectures de journaux Base.
   - *Terrain à prendre* : la place est vide et c'est là que sont les acheteurs.
3. **Vérification *provably fair* et hasard signé** (`verify_fair_roll`, `fair_random`).
   - *Marché* : 0 et 3 entrées.
   - *Chez nous* : `casino.js` tire déjà ses cartes par HMAC-SHA256 (serverSeed / clientSeed / nonce).
   - *Offre* : vérifier un tirage (le nôtre, et tout casino qui publie ce schéma, à confirmer schéma par schéma), et fournir un aléa à engagement et révélation pour les jeux entre agents.
   - *Coût* : du calcul pur. Prix visé 0,001 $.
   - *Limite* : la demande est inconnue. C'est le seul outil du marché sur ce sujet, et il est parfaitement dans l'identité d'un site de jeux.
4. **Devenir LA référence Robinhood Chain.**
   - *Marché* : 23 entrées chez 10 hôtes. Nous y sommes seuls sur le RPC, les transactions et les portefeuilles, mais battus sur la fiche jeton (percall à 0,002 $) et sur les lancements (3 flux à 0,005–0,01 $). Les actions tokenisées n'ont que 6 entrées chez 2 hôtes.
   - *Actions* : baisser `robinhood_token` et `new_launches` à 0,005 $ ou moins. Porter `can_i_sell` à 0,01 $ : la seule vraie simulation de sortie sur RHC. Ajouter un outil actions tokenisées (cours on-chain contre oracle), à construire : `lectures_rh.js` fournit déjà le nœud et les lectures décodées, mais il ne traite pas les actions tokenisées.
   - *Concurrent absent* : OneSource, que `lectures_rh.js` cite comme vendeur RPC sur Robinhood Chain via x402scan, **n'a aucune entrée au catalogue PayAI**.
   - *Inscription* : s'assurer que ces outils sont aussi inscrits sur Base.
5. **Manches UP/DOWN avec relevé mesuré** (`prediction_round`).
   - *Marché* : 7 entrées, toutes des estimations de probabilité sans historique.
   - *Chez nous* : le bot `predict_serveur.js` tient un relevé papier persistant des manches BNB de PancakeSwap.
   - *Offre* : l'outil rend la manche en cours, la décision du bot et **son relevé** (n manches, taux de réussite), et refuse de conclure sous un seuil d'observations, selon la convention du dépôt.
   - *Coût* : nul. Personne d'autre ne vend un relevé.

Hors classement, deux constats :

- **Prix des outils de commodité** : osint_lookup et web_search sont 2 à 20 fois au-dessus du prix courant. Soit on les baisse vers 0,005–0,01 $ (si le coût de règlement le permet), soit on les laisse comme outils de confort, sans espérer de volume.
- **Image et vidéo** : ce n'est pas un créneau pour nous. À nos coûts réels, nous serions les plus chers du marché.

## 8. Achats réels : liste exhaustive

Méthode :

- Balayage large par mots-clés sur tout le texte de chaque entrée : eSIM, carte cadeau, numéro, SMS, colis, livraison, impression, courrier, recharge, commande, domaine, hôtel, voucher, etc.
- Plus de 1 100 correspondances brutes, **toutes lues à la main**, hors `api.delx.ai` qui ne vend que des utilitaires.
- Chaque point d'achat retenu a reçu **une requête non payée** (sous-bloc `achats_reels_exhaustif` de `sonde_payai.json`).

| Service | Ce qui est vendu | Réseau (catalogue) | Prix catalogue | Ce qu'il faut fournir | Réponse à la sonde | Risque |
|---|---|---|---:|---|---|---|
| `vamoschips.com/api/v1/x402/orders` (CHIPS) | **eSIM** de données en voyage (profil livré environ 20 min après règlement) | Base | 0,600121 $ (le forfait « albania-100mb-7days ») | un `planSlug`, `acceptTerms: true`, `Idempotency-Key`. Aucune donnée personnelle dans le schéma. | 402 lisible, mais « offre indicative » **proposée seulement sur Solana** (0,600061 $) : le réseau du catalogue manque dans le 402 | faible. Livraison différée, pas de remboursement annoncé. |
| `shop.blocklabs.nl/api/order` (+ `/search`, `/product`, `/shipping-options`, `/taxonomies` à 0,001 $) | **Dropshipping** de produits physiques, **livraison UE seulement** | Base | 50,966109 $ (prix calculé par commande) | **nom, prénom, adresse, code postal, ville, pays, e-mail, téléphone**. Le portefeuille payeur doit être déployé (pas de compte contrefactuel). | `/order` : 400 « shippingAddress is required ». `/search` : 402 identique au catalogue. | **élevé** : données personnelles complètes, bien physique, revente possible, fraude au détournement de livraison |
| `api.voipstore.xyz/agent/v1/orders` (+ `/topup` à 5 $, `/orders/:id` à 0,001 $) | **Numéro virtuel** pour recevoir un SMS de vérification | **Base Sepolia (testnet)** | 0,25 $ | `service_id`, `country_id`, `X-Quote-Id`, `Idempotency-Key` | 405. L'URL `http://` redirige vers `https://`, et la redirection a transformé le POST en GET : ce n'est pas un vrai refus. | **élevé** : sert à contourner les vérifications par SMS (création de comptes en masse). Pas en mainnet. |
| `api.paysponge.com/v1/numbers` (AgentPhone) | Numéro de téléphone pour agent | Solana | 0,01 $ | `agentId`, `country`, `areaCode` | **404 « Service not found »** : mort | moyen |
| `api.paysponge.com/text` (Textbelt) | **Envoi de SMS** vers un vrai numéro | Solana | 0,02 $ | numéro du destinataire et texte (corps non décrit) | **404 « Service not found »** : mort | élevé : spam, données d'un tiers |
| `api.growvib.com/v1/agent/orders` | **Abonnés, vues, likes** sur Instagram, TikTok, YouTube, Telegram, X, Twitch, Spotify | Base (+ Solana dans le 402) | 1 $ (minimum ; prix réel selon la commande) | `link` du compte ou du post, `quantity`, `service_id` | 402 lisible, identique | **élevé** : contraire aux conditions des plateformes, réputation |
| `wurkapi.fun/solana/xraid/*` (26 entrées) | **« X Raid »** : likes, reposts et commentaires humains sur un post X, à 0,025 $ l'unité | Solana | 0,95 à 5 $ | l'URL du post X | 402 lisibles. `medium` affiche 2,5 $ au catalogue et **2 $ au 402**. | **élevé** : engagement acheté, contraire aux conditions de X |
| `wouldpayagain.com/api/ads/book*` (4 entrées) | **Encart publicitaire** dans une newsletter | Base | 0,2 à 0,6 $ | `reservation_code` obtenu avant (gratuit) | `/api/ads/book` : **410, route retirée**. Deux autres routes répondaient 402 dans l'échantillon, avec une **adresse de paiement différente** du catalogue. | moyen : payer une route retirée = paiement non honoré |
| `payai.agentstools.dev/humanverify/create` | **Jugement humain** sur une question subjective (travail humain rémunéré) | Solana | 0,2 $ | la question, les libellés, la récompense | 402 lisible, identique | faible. Le service refuse lui-même l'astroturfing, les captchas et les données personnelles. |
| `2captcha.x402.paysponge.com/createTask` | **Résolution de captcha** par des humains | Base | 0,01 $ | la tâche captcha | 402 lisible, identique | **élevé** : contournement anti-robot |
| `locationlists.com/mcp` | **Fichiers** d'adresses d'entreprises US (achat par ligne ou du fichier) | Base | 0,3 $ | filtres | 200 (description libre sur GET) | faible (données publiques d'entreprises) |
| `x402.freeq.one/mcp` | Serveur MCP de 30 outils dont **« gift card purchase »** selon sa description | Base | 0,005 $ (le 402 affiche **0,001 $**) | appel JSON-RPC `tools/call`. L'outil carte cadeau n'est pas décrit au catalogue. | 402 lisible | **inconnu** : aucune route dédiée, rien vérifiable sans payer |
| `merchant.payai.network/api/v1/keys/vend` | Clé API et crédits du facilitateur PayAI | Solana | 1 $ (montant choisi) | `keyName`, **`recoveryEmail`** | 402 lisible, identique | faible. Il faut un e-mail. |

Écartés parce que ce ne sont pas des achats réels :

- recharges de crédits numériques (codenut, yiduochan, jatevo, quicknode, compute3, hypercli, sqlguard) ;
- ventes de jetons (x420.dev, basetomcat, « 888 x402人生代币 ») ;
- recherches sur Amazon ou TikTok Shop, qui sont des données et pas des achats ;
- suivi de colis (FedEx, USPS, DHL, Poste russe), qui est de l'information ;
- `engedi…/api/hotels`, qui est une recherche (400 : paramètres manquants).

**Données personnelles, sans achat réel mais à surveiller** : Apollo `people/match` et `mixed_people` (0,02–0,03 $), Nyne `person/enrichment`, FullEnrich `people-search` (0,15 $), PDL `people-enrich` (0,28 $, « emails, phone »), payforapi `people-enrich`, verifik `usa/vehicle`. SwogeAgentic ne doit **jamais** y envoyer une donnée de joueur.

**Bitrefill et Laso Finance : confirmé, absents.** Aucune occurrence de « bitrefill » ni de « laso » dans tout le fichier du catalogue (12,5 Mo de JSON brut : URL, descriptions, métadonnées, schémas, adresses). Il n'existe au catalogue aucune route dédiée aux cartes cadeaux. La seule mention est dans la description du serveur MCP de freeq.one.

**Pour SwogeAgentic**, une liste de refus mesurée :

- **Engagement acheté** (wurkapi xraid, growvib) et **captchas** (2captcha) : risque de réputation et de conditions d'utilisation.
- **Envoi de SMS** et **numéros virtuels** : abus possible.
- **Commandes physiques** : elles exigent une adresse personnelle.
- **Enrichissement de personnes** : données personnelles.
- **Tout 402 dont le montant ou l'adresse diffère du catalogue** : 7 et 11 cas sur 118 dans l'échantillon.

## 9. Limites

- **Catégories** : classement par mots-clés, précision contrôlée d'environ 74 % (104 sur 140). Les comptes par catégorie sont des ordres de grandeur. L'ordre de départage favorise les catégories étroites.
- **Échantillon** : n = 153. Par catégorie, n va de 5 à 24, ce qui donne des intervalles larges. La stratification est par catégorie et pas par hôte, donc un gros publieur peut peser plusieurs tirages.
- **Une seule requête sans paramètres** :
  - Un 400 ou 422 veut dire « vivant mais refuse le corps vide », pas « cassé ».
  - Un 402 ne prouve pas que le service **livre** après paiement. Ce point n'est pas mesuré, puisqu'on ne paie pas.
  - Les URL en `http://` qui redirigent peuvent changer un POST en GET (vu sur voipstore).
- **Proxy** : la sortie passe par un proxy HTTPS. « Injoignable » = le proxy n'a pas pu ouvrir la connexion alors que le DNS résout.
- **Prix** :
  - Un prix n'est converti en dollars que pour l'USDC dont l'adresse est connue (7 410 entrées). Le reste est « inconnu ».
  - Les prix variables (`upto`, LLM au jeton) sont pris au montant affiché.
  - Nos prix sont les prix d'inscription au catalogue (Solana, coût de règlement inclus), pas le prix en $SWOGE de `/agentic/tools` : scan_token vaut 0,01 $ en $SWOGE et 0,02 $ en USDC.
- **Concurrence** : repérée par mots-clés. Il peut manquer des concurrents sans description, et quelques faux amis subsistent (listes brutes dans `conc_listes.txt`).
- **Instantané** : le catalogue bouge vite (1 071 entrées mises à jour dans les dernières 24 h). Les chiffres valent pour le 28/09/2026.
- **Non vérifié** :
  - si un agent qui filtre sur Base voit nos entrées inscrites sur Solana ;
  - ce que fait `embauche.js` du prix du 402 ;
  - que l'outil carte cadeau de freeq.one existe réellement.
