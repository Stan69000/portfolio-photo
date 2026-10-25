# Revue d’accessibilité — 25 octobre 2026

État : corrections locales, non déployées. Revue technique partielle, sans taux de conformité RGAA.
Référence : [critères et tests officiels du RGAA 4.1.2](https://accessibilite.numerique.gouv.fr/methode/criteres-et-tests/).
Le fichier d’audit fourni porte sur l’ancienne version publique de l’accueil ; son score n’est pas extrapolé aux autres pages.

## Périmètre

Photos, recherche, liste des séries, fiche de série (Marseille), fiche photo (Hôtel de ville), Instants, Favoris/statistiques, À propos, visite guidée et exploration par humeur (Ralentir), plus les composants partagés. Les contrôles de structure s’appliquent aux 1 193 fichiers HTML du build, y compris toutes les fiches photo, toutes les séries et toutes les humeurs.

## Corrections

| Zone | Changement |
| --- | --- |
| Navigation commune | Lien d’évitement, page courante annoncée, icônes décoratives masquées, fermeture du menu mobile par Échap avec retour au bouton. |
| Visionneuse | Arrière-plan rendu inerte même lorsque la fenêtre est dans main, boucle de tabulation, fermeture Échap et retour au déclencheur ; note sélectionnée exposée via aria-pressed et annonce du libellé. |
| Photos | Boutons favoris et notation nommés, état du favori exposé et utilisable au clavier, accès aux étoiles depuis le bouton Noter, conservation du focus pendant le filtrage, compteur de résultats annoncé. |
| Recherche | Retour au champ après effacement des filtres ; retour au contrôle correspondant après retrait d’un filtre. |
| Fiche photo | Groupement des étoiles, annonce de la note et du résultat de copie du lien, noms des deux zones de navigation. |
| Favoris/statistiques | Annonce des résumés de chargement et des notes. |
| Carte | Liste HTML des lieux avec accès aux séries/photos et précision en texte ; états France/Monde annoncés ; noms de lieux vides remplacés par le titre de la photo. |
| Cartes Leaflet | Contraste du bouton de fermeture corrigé ; commandes de zoom nommées en français. |
| Contrastes | Texte des mots-clés de Photos, fermeture de la carte et libellé des notes dans la visionneuse. |

## Vérifications réalisées

- Build Astro réussi (1 193 pages).
- Onze tests existants de découverte, recherche et résolution des couvertures réussis.
- `python3 scripts/audit-accessibility.py` : aucune erreur parmi les contrôles de structure appliqués aux 1 193 pages. Résultat détaillé : `accessibility-structure.json`.
- Dans le navigateur : ouverture de la visionneuse au clavier, tabulation inverse bouclée, arrière-plan inerte sans rendre la fenêtre inerte, fermeture Échap et restitution du focus.
- Recherche sans résultat puis réinitialisation : retour au champ q et restitution des résultats.
- Favori activé puis désactivé au clavier : aria-pressed change et le focus reste sur le bouton. Accès au premier bouton étoile via Noter.
- Contrastes mesurés sur les textes à fond uni de six modèles : mots-clés et fermeture de la carte corrigés ; autres textes examinés sans anomalie relevée dans ce relevé limité. Les photographies, dégradés et tous les états de survol ne sont pas couverts par cette mesure.
- Dix modèles affichés dans une fenêtre de 320 px : aucun débordement horizontal détecté hors éléments internes de la carte et visionneuse masquée. Ce contrôle ne remplace pas le zoom navigateur à 200/400 % ni l’agrandissement du texte.

## À vérifier manuellement avant toute déclaration de conformité

- Pertinence des alternatives de chaque photographie : un titre tel que « Bourges — 004 » ne décrit pas nécessairement le contenu. Révision éditoriale avec l’auteur nécessaire ; ne pas inventer de description.
- Restitution avec VoiceOver/Safari et NVDA/Firefox : titres, annonces, notes, formulaires, carte et fenêtres modales. La présente revue a utilisé DOM, arbre d’accessibilité et clavier, sans écoute d’un lecteur d’écran.
- Étendre les essais de zoom natif à tous les parcours et navigateurs ; tester les espacements personnalisés, la présentation sans CSS, l’impression et les autres orientations. Les essais Chrome décrits ci-dessous ne couvrent pas tout le site.
- Contrastes sur photographie et pour tous les états interactifs, texte dans le logo et informations de la carte.
- Exhaustivité de la liste des lieux pour les regroupements volumineux : le modèle de carte limite ses aperçus à dix entrées par point ; les séries restent accessibles par leur lien.
- Rejouer l’audit et les parcours sur le site réellement déployé et sur ses données à jour. La copie locale de ce chat et l’autre copie de travail repérée ne sont pas au même état.

Les vérifications automatiques ci-dessus sont des tests de non-régression ciblés, pas un audit exhaustif des critères RGAA. Aucun pourcentage de conformité n’est établi.

## Complément : agrandissement et arbre d’accessibilité macOS

- Douze modèles examinés avec taille de texte racine à 200 % puis 400 % (24 variantes temporaires du build). Un débordement de la légende de la carte a été corrigé par des colonnes adaptatives et un retour à la ligne des mots longs. Aucun débordement horizontal détecté au second passage, hors internals de carte exclus du relevé. Cette simulation de taille de texte ne vaut pas un test de zoom navigateur.
- Zoom natif Chrome, indiqué par l’interface du navigateur : 200 % puis 400 % sur la recherche. Saisie, résultat vide, réinitialisation et passage au clavier vers le filtre d’année vérifiés. Les filtres passent sur une colonne sous 400 px ; le bouton flottant est masqué lorsque la fenêtre de contenu mesure au plus 420 px de haut afin d’éviter le recouvrement des contrôles.
- Visionneuse testée dans Chrome à 400 % : le contenu était trop comprimé. La fenêtre est maintenant défilable en faible hauteur, avec barre d’outils maintenue en haut. Photo affichée, commande suivante activable et fermeture Échap avec retour au déclencheur vérifiées. Zoom de Chrome remis à 100 % à la fin.
- Vérification complémentaire à 320 × 200 px : visionneuse de 200 px, contenu de 352 px, défilement vertical auto ; commande suivante utilisable et compteur passé à « Image 2 sur 3 ».
- Dans l’arbre d’accessibilité natif de Chrome sur macOS : nom de fenêtre « Visionneuse photo », commandes nommées, notes exposées avec état activé/désactivé, indicateur de progression renseigné et arrière-plan retiré de l’arbre pendant l’ouverture.
- **VoiceOver n’a pas été écouté.** L’arbre natif permet une vérification technique des rôles et noms, sans prouver la restitution vocale ni la facilité d’usage avec VoiceOver/Safari.

### Parcours d’écoute restant à effectuer

1. Activer VoiceOver dans les réglages d’accessibilité de macOS et ouvrir la version locale ou déployée correspondante dans Safari.
2. Atteindre « Aller au contenu », parcourir les titres puis les champs de recherche ; vérifier que le nom et la valeur de chaque filtre sont annoncés.
3. Faire une recherche vide puis retirer le filtre : écouter l’annonce du nombre de résultats et vérifier la position du curseur.
4. Ouvrir une photo : seule la visionneuse doit être parcourue ; vérifier ses commandes, la légende et l’indicateur de progression. Une note active doit être distinguable sans la couleur.
5. Fermer la visionneuse, confirmer le retour à la photo, puis parcourir la liste des lieux et ses liens sans utiliser la carte.

Les variantes de test sont supprimées du build final. Les corrections restent locales et ne sont pas déployées.
