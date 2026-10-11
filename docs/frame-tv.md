# Piloter la Frame depuis l’admin

Ouvrir https://admin.stan-bouchet.fr/sites/portfolio-photo/tv après connexion.

Sur le Mac, double-cliquer sur `Relais TV.command`. Le Mac et la TV doivent être sur le même réseau. Garder le relais ouvert pendant les commandes. La TV doit afficher une image en mode Art. Le diaporama continue sans le Mac après activation.

L’onglet TV permet d’envoyer jusqu’à 30 photos par lot, d’afficher une photo, de démarrer ou arrêter le diaporama et de supprimer une copie TV après confirmation. Le diaporama natif utilise toutes les photos personnelles présentes sur la TV. Pour les anciennes photos sans titre, utiliser « Afficher » pour les reconnaître sur la TV avant suppression.

Les doublons connus du relais sont évités grâce au registre local des identifiants TV. Ce registre et les clés privées sont dans `.processed/frame/`, ignoré par Git. Une photo transférée par un autre outil peut ne pas être reconnue comme doublon.

## Stockage

Sur la Frame 2019 testée (Art API 0.97), `get_device_info` et `tv_information` renvoient un événement d’erreur. La liste des photos expose les dimensions, la date, le cadre et les identifiants, mais pas la taille en octets. L’API REST générale ne contient aucun champ de capacité disponible. L’admin affiche donc « espace disponible inconnu », sans inventer de pourcentage.

## Relais

Le relais effectue uniquement des connexions sortantes vers l’admin et des connexions locales à la TV. Aucun port entrant du Mac ou de la box ne doit être ouvert. Son authentification utilise une clé distincte de la session admin, conservée côté serveur dans `storage/db/frame-relay.key` (0600). La TV est associée sous « Galerie Stan » ; son jeton reste sur le Mac.

Les commandes sont persistées dans SQLite côté admin. Elles expirent après dix minutes si elles n’ont pas été exécutées. Une commande interrompue n’est jamais rejouée automatiquement ; vérifier l’inventaire avant de relancer un envoi. Le résultat et l’inventaire sont renvoyés à l’admin après chaque action. Le relais actualise aussi l’inventaire périodiquement lorsqu’il est ouvert.

L’installation initiale utilise Python 3, Git et Node.js avec les dépendances du portfolio (`npm install`). Le lanceur crée l’environnement Python dans `.processed/frame/venv` et installe la version fixée dans `scripts/frame-relay-requirements.txt`. La configuration privée du relais doit déjà exister dans `.processed/frame/relay.json`.

Tests locaux : `.processed/frame/venv/bin/python tests/frame-relay.test.py`.
