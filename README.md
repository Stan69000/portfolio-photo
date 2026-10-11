# Stan Bouchet — Photography Portfolio

Personal photography portfolio built with [Astro](https://astro.build/).

## About

This repository contains the **source code** of the portfolio site (Astro components, YAML metadata, configuration). Photographs are hosted externally and are not stored in this repository.

Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique des modifications.

## Photo License

All photographs published on [stan-bouchet.eu](https://stan-bouchet.eu) are the exclusive property of Stan Bouchet and are protected under:

**Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International (CC BY-NC-ND 4.0)**

You are free to share the material with proper attribution.
You may not use the material for commercial purposes or modify it.

https://creativecommons.org/licenses/by-nc-nd/4.0/

## Code License

The source code in this repository may be reused freely with attribution.

## Instants — publication mobile

La rubrique `/instants/` affiche les photos de type `instant`, par date de publication.
Dans l’administration, `/instants` permet l’import depuis Safari : sélection de
photos JPEG/PNG/WebP/TIFF, commentaire facultatif commun à la sélection, lieu GPS
issu de chaque fichier ou lieu choisi manuellement. La localisation est masquée
par défaut. Si l’iPhone conserve un fichier HEIC non compatible, l’exporter en JPEG.
La page peut être ajoutée à l’écran d’accueil depuis le menu Partager de Safari.

« Publier » transfère les images, enregistre les nouvelles photos et déclenche le
workflow GitHub existant vers O2Switch. La page vérifie ensuite la présence des
nouvelles fiches publiques pendant cinq minutes. Une absence de confirmation
invite à consulter le site ou GitHub Actions. Les modifications déjà en attente
bloquent cette publication rapide ; l’enregistrement en brouillon reste possible.
Les brouillons se modifient et se publient avec les outils habituels de l’administration.

Pour activer la fonctionnalité en production : déployer ces sources sur `main`
pour le site public, puis mettre à jour et redémarrer le service d’administration
avec cette version de `admin-server.js`. Le déploiement statique du site ne
redémarre pas le service d’administration. Vérifier ensuite un import JPEG depuis
un iPhone connecté, avec un lieu approximatif, et la confirmation de mise en ligne.

## Stockage kDrive

L’administration propose un stockage kDrive optionnel pour les originaux et les
versions du site, avec classement par série et date. Voir [la configuration et la
migration kDrive](docs/kdrive.md). La connexion et le relais web doivent être
configurés avant le basculement des images existantes.
