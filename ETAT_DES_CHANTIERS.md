# État des chantiers — 13/10/2026

Sauvegarde demandée par le propriétaire. Rien de ce qui suit n'est en ligne : chaque
branche `claude/sauvegarde-*` est un instantané du travail en cours, ni relu en entier ni
fusionné dans `main`. GitHub Pages et Railway servent `main`.

## Déjà en ligne (main)

- Serveur `75ccd90` : paper hand (durée de tenue + phrase), piscines détaillées et reste
  à acheter côté ETH, cricket réglé par l'en-tête ESPN, SWOGE World lots 1-4, œuf prisme
  « RELIC EGG » et rang de l'œuf dans la couleur du sac.
- Site `7fd94e1` : SWOGE World lots 1-4, en-tête du sac d'œuf, 44 icônes d'objets
  refaites (39 au premier passage, 5 au second ; 6,33 $ dépensés sur 15 $).

## En cours

| chantier | branches de sauvegarde | où il en est | suite |
|---|---|---|---|
| Smart money (lecture seule) | serveur `claude/sauvegarde-smart-money-serveur`, site `claude/sauvegarde-smart-money-page` | construit et commité ; passe réelle sur la chaîne en cours | contrôle contre le rapport des devs (0x84b8…c1 et 3 autres), revue, captures au propriétaire, puis main |
| Page Studio blanche (`studio.html`) | site `claude/sauvegarde-studio-page` | construite, premier tour de revue fait, corrections en cours | second tour de revue, captures, puis main |
| Sprites iso (idle/marche/attaque) + Sprite Lab | serveur `claude/sauvegarde-sprites-serveur`, site `claude/sauvegarde-sprites-page` | construits, relecture presque finie ; l'essai réel n'a rien dépensé | corrections ; puis feu vert du propriétaire pour mettre `/studio/planches` en ligne et lancer l'essai à 10 $ sur skeleton, rodeur, pirate (xAI n'est que sur Railway) |
| Paper hand : heure d'entrée UTC + tx + wallet d'origine | serveur `claude/sauvegarde-paper-hand-entree` | construit et commité | revue adversariale, 3 vraies annonces au propriétaire, puis main (schéma 4 : reconstruction ~3 min sans annonce) |
| Tirs par type d'arme | (pas encore de branche) | relevé en cours | conception, construction, revue, captures + vidéo au propriétaire |

## Décisions du propriétaire à retenir

- Rachat des trouvailles : inchangé. « #N of M » republiable : laissé tel quel.
- Fioles de vie et de mana : laissées comme elles sont.
- Studio : nouvelle page `studio.html` (`swoge_studio.html` renvoie toujours vers SwoleMind),
  Kling 3.0 sans prix, aucune promesse d'étiquette « AI-generated ».
- Smart money : tranches eth_getLogs adaptatives ; alertes sur le canal privé seulement.
- Maquette Launchpad : ne rien dire du lien entre l'acheteur le plus actif et le
  propriétaire du coffre SwogeBet.
- Sprites : notre propre service (pas AutoSprite), vue isométrique 2.5D, idle + marche + attaque.
- Icônes encore originales : jambieres_use (netteté 1,587 < 1,59 après encodage) et
  ring_etoile_rouge (refusée par un juge, jurait avec sa panoplie).
