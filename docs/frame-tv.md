# Piloter la Frame depuis l’admin

Ouvrir https://admin.stan-bouchet.fr/sites/portfolio-photo/tv après connexion.

Sur le Mac, double-cliquer sur `Relais TV.command`. Le Mac et la TV doivent être sur le même réseau. Garder le relais ouvert pendant les commandes. La TV doit afficher une image en mode Art. Le diaporama autonome continue sans le Mac après activation. Le mode rapide nécessite le Mac éveillé et le relais ouvert pendant toute la lecture.

L’onglet TV permet d’envoyer jusqu’à 30 photos par lot, d’afficher une photo, de démarrer ou arrêter le diaporama et de supprimer une copie TV après confirmation. Le diaporama natif utilise toutes les photos personnelles présentes sur la TV. Pour les anciennes photos sans titre, utiliser « Afficher » pour les reconnaître sur la TV avant suppression.

Les doublons connus du relais sont évités grâce au registre local des identifiants TV. Ce registre et les clés privées sont dans `.processed/frame/`, ignoré par Git. Une photo transférée par un autre outil peut ne pas être reconnue comme doublon.

## Stockage

Sur la Frame 2019 testée (Art API 0.97), `get_device_info` et `tv_information` renvoient un événement d’erreur. La liste des photos expose les dimensions, la date, le cadre et les identifiants, mais pas la taille en octets. L’API REST générale ne contient aucun champ de capacité disponible. L’admin affiche donc « espace disponible inconnu », sans inventer de pourcentage.

## Relais

Le relais effectue uniquement des connexions sortantes vers l’admin et des connexions locales à la TV. Aucun port entrant du Mac ou de la box ne doit être ouvert. Son authentification utilise une clé distincte de la session admin, conservée côté serveur dans `storage/db/frame-relay.key` (0600). La TV est associée sous « Galerie Stan » ; son jeton reste sur le Mac.

Les commandes sont persistées dans SQLite côté admin. Elles expirent après dix minutes si elles n’ont pas été exécutées. Une commande interrompue n’est jamais rejouée automatiquement ; vérifier l’inventaire avant de relancer un envoi. Le résultat et l’inventaire sont renvoyés à l’admin après chaque action. Le relais actualise aussi l’inventaire périodiquement lorsqu’il est ouvert.

L’installation initiale utilise Python 3, Git et Node.js avec les dépendances du portfolio (`npm install`). Le lanceur crée l’environnement Python dans `.processed/frame/venv` et installe la version fixée dans `scripts/frame-relay-requirements.txt`. La configuration privée du relais doit déjà exister dans `.processed/frame/relay.json`.

Tests locaux : `.processed/frame/venv/bin/python tests/frame-relay.test.py`.

## Diaporama autonome ou rapide

Le mode autonome utilise la TV : 10, 30 ou 60 minutes par photo. Le mode rapide utilise le relais du Mac : 30 secondes, 1 minute ou 5 minutes par photo, avec au moins deux photos personnelles. En mode rapide, le choix aléatoire parcourt toutes les photos personnelles avant de recommencer, en excluant aussi les dernières photos vues sur la moitié d’un tour (26 pour 53 photos) ; l’autre choix suit l’ordre de l’inventaire TV. Le délai rapide peut varier de quelques secondes selon le réseau et les commandes en cours.

En mode rapide, garder le Mac allumé, éveillé, sur le réseau de la TV, avec le relais ouvert. La page admin peut être fermée. La dernière photo reste affichée pendant une veille ou une interruption ; le relais reprend au retour de la TV en mode Art, sans rattrapage en rafale. Il ne change pas les photos pendant le visionnage TV/HDMI. Après fermeture puis réouverture du relais, relancer le mode rapide depuis l’admin. Lancer le mode autonome remplace le mode rapide ; Arrêter coupe les deux.

Sur cette TV, afficher une autre photo arrête la rotation native. Le relais conserve maintenant la durée et relance le diaporama après Afficher. En mode rapide, Afficher redémarre le délai sur la photo choisie.

## Aperçus des photos TV

L’admin affiche les miniatures directement récupérées sur la TV, y compris celles des anciennes photos sans titre. Le relais les récupère progressivement, en donnant la priorité aux commandes et au diaporama rapide. Elles sont redimensionnées en JPEG, mises en cache dans `.processed/frame/previews/` et incluses dans l’inventaire envoyé à l’admin ; elles restent consultables lorsque la TV est hors ligne. Pour les photos reconnues, l’aperçu de la galerie peut être utilisé en attendant. Aucun changement de photo n’est nécessaire pour récupérer un aperçu.
