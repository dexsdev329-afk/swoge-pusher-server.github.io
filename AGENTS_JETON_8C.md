# Étape 8c — l'exécution RÉELLE des agents de jeton (plan, rien d'exécuté)

> Tout ce qui précède (Phase 1) est **en papier** : l'agent décide et resimule,
> aucun centime ne bouge. 8c est le **seul** étage qui touche l'argent des joueurs.
> Il ne s'ouvre que sur un **feu vert explicite du propriétaire**, sur un **jeton
> de test d'abord**, avec de **petits plafonds**. Ce document est le cahier des
> charges ; il ne déclenche rien.

## Ce qui est déjà prêt (et qu'on réutilise tel quel)

| Brique | Rôle en 8c |
|---|---|
| `pare_feu.js` | inchangé — filtre les textes externes avant l'esprit |
| `policy_argent.js` | inchangé — **décide** si un geste est permis (plafonds, impact, cooldown, trésor) |
| `signer_papier.js` | **modèle** du signer réel : resimule et ne signe que l'approuvé |
| `trader_papier.js` | **modèle** de la boucle ; le réel garde la même trace |
| `agent_fuel.js` / trésor | le trésor en dollars, déjà débité en papier |
| `agent_jeton.js` | `pouvoirsActifs()` élargira à buyback/sell/airdrop quand le drapeau est posé |

**Rien de la chaîne de décision ne change.** 8c remplace seulement la **dernière
marche** : le devis placeholder → vrai devis, et la signature papier → vraie
transaction, derrière un drapeau.

## Les 6 pièces à construire (dans l'ordre, chacune testée)

### 1. Le vrai devis (`agent_devis.js`) — LECTURE SEULE, zéro risque
- Remplace le placeholder `{impactPct:1}` par un devis réel via le **quoter du
  miroir** (`miroir.js` — vérifier la signature exacte de la fonction de devis
  aller/retour avant de coder, **ne pas la deviner**).
- Rend `{ ok, pool, impactPct, sortieAttendue, prixAvant, prixApres }` pour le
  pool **du registre** uniquement.
- Entièrement testable hors-ligne (quoter injecté). **Aucune signature, aucun gaz.**
- → Branché dans `trader_papier` : la décision papier devient *exacte*. Toujours papier.

### 2. L'exécuteur réel (`agent_executeur.js`) — DERRIÈRE SON DRAPEAU
- Drapeau `AGENT_TRADER_EXECUTE=1` (défaut : absent → **tout reste papier**),
  façon `MIROIR_EXECUTE`.
- Prend une intention **déjà approuvée par la policy ET signée par le vrai signer**,
  et envoie la vraie transaction via le miroir (réutiliser son exécuteur v3/v4 —
  vérifier la fonction exacte).
- **La clé ne vit QUE dans l'environnement de l'hôte** (`MIROIR_CLE` / une clé
  dédiée aux agents). Jamais dans le dépôt, jamais dans une réponse, jamais passée
  à l'esprit.
- Resimule **juste avant d'envoyer** (`callStatic`), et **refuse** si l'impact
  réel diverge de l'approuvé (reprise exacte de la garde du signer papier).
- Un geste n'agit **que sur `ws.addr` / le pool du registre**, jamais sur une
  adresse d'un message (règle du dépôt, déjà tenue par le pare-feu + le pool-du-registre).

### 3. Le signer réel isolé (`signer_reel.js`) — jumeau du papier
- Même interface que `signer_papier` (`signe(approuve, deps)`), mais signe une
  vraie tx (service isolé qui détient la clé ; l'esprit ne la voit jamais).
- Refuse si pool ≠ registre, si impact > approuvé, si le devis échoue.
- **Où isoler la clé** : décision ci-dessous (portefeuille dédié aux agents vs
  réutiliser le portefeuille du miroir).

### 4. Le contrat variante (`SwogeFunV4Agent.sol`) — le « financé par le volume »
- Aujourd'hui `SwogeFunV4Weth` paie 50 % des frais au **créateur** en WETH.
- La variante route la **part créateur → un répartiteur** : X % **carburant de
  l'agent**, Y % **rachat-et-brûle du jeton**, Z % créateur, W % trésor —
  **figés au déploiement** (immuables, comme AgencyPad).
- Déployé par le portefeuille dédié (réutiliser `deploiement_v4.js`), vérifié
  Sourcify, **banc sur fork avant** (réutiliser le banc du launchpad V4).
- Tant qu'il n'existe pas : le carburant/trésor se financent par **versement
  manuel** (routes `topup` déjà en place) — le réel marche sans ce contrat, il le
  rend juste **automatique**.

### 5. Le rachat-et-brûle (`agent_rachat.js`)
- Quand le trésor dépasse un seuil : l'agent **rachète son jeton sur son pool et
  le brûle** (le levier d'accroche de prix de Virtuals/AgencyPad).
- Passe par la **même** boucle : policy (plafonds) → signer → exécuteur. Rien de
  spécial côté sécurité.
- D'abord **en papier** (déjà possible : `action:'buyback'`), puis réel sous le drapeau.

### 6. Le garde-fou d'exploitation
- **Kill-switch** : `AGENT_TRADER_EXECUTE=0` coupe tout l'étage réel à chaud
  (retour au papier), sans redéploiement.
- **Plafonds de départ minuscules** : p. ex. 1 $/action, 5 $/jour, impact ≤ 1 %,
  cooldown 1 h — réglés dans `policy_argent` par jeton.
- **Un seul jeton de test** autorisé au départ (liste blanche d'adresses).
- **Journal réel** distinct du papier, et une page/alerte Telegram à chaque vraie tx.
- `verifie.sh` : une suite `agent_reel.test.js` sur **fausse chaîne**
  (`MIROIR_EXECUTE=1` contre un nœud bidon, comme `miroir_reel.test.js`) —
  la seule qui couvre l'argent réel.

## Les décisions qui t'appartiennent (à trancher avant de coder 8c)

1. **La clé des agents** : un portefeuille **dédié aux agents** (recommandé —
   isolé, plafonnable) ou réutiliser celui du miroir ?
2. **La répartition figée** du contrat variante (ex. 40 % carburant / 30 % rachat-brûle
   / 20 % créateur / 10 % trésor) — chiffres à arrêter, car **immuables**.
3. **Les plafonds de départ** (par action / jour / impact / cooldown).
4. **Le jeton de test** sur lequel on ouvre le réel en premier.
5. **Les pouvoirs ouverts d'abord** : rachat-et-brûle seul (le plus sûr, agit sur
   son propre jeton), avant sell/swap/airdrop ?

## L'ordre de déploiement (prudent)

1. Pièce 1 (vrai devis) → en papier, on **mesure** les décisions exactes 1–2 semaines.
2. Pièces 2+3+6 (exécuteur + signer réel + garde-fous) **drapeau éteint**, suite
   sur fausse chaîne verte.
3. Feu vert explicite → drapeau **on** sur le **seul jeton de test**, plafonds
   minuscules, **rachat-et-brûle seul**. On regarde chaque tx.
4. Si c'est sain après N jours : élargir les plafonds / d'autres jetons / d'autres
   pouvoirs, un cran à la fois.
5. Pièce 4 (contrat variante) quand on veut rendre le financement **automatique**.

## Invariants qui ne changent jamais (même en réel)

- L'esprit **propose**, il ne signe jamais ; il ne détient **aucune clé** ; il n'a
  **aucun outil qui prend une adresse**.
- Un geste n'agit que sur le **pool du jeton** (registre), **jamais** sur une
  adresse venue d'un message.
- **Fail-closed** partout : un doute, un devis qui diverge, un classifieur muet →
  on n'exécute pas.
- `AGENT_TRADER_EXECUTE` absent ⇒ **100 % papier**. C'est l'état par défaut, pour
  toujours, tant que tu ne l'allumes pas.
