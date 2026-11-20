# Changelog

## 2026-11-20 — Galeries privées et mesure d'audience

### Galeries privées

- Nouvelle page `/prive/`, servie depuis `prive.stan-bouchet.fr` : le client entre le code reçu avec son lien et retrouve ses photos, affichées comme le reste du site.
- Téléchargement photo par photo en JPEG, ou de toute la galerie en une archive ZIP ; l'archive se prépare en affichant son avancement, puis reste prête pour les demandes suivantes.
- Sélection : le client garde les photos qu'il veut, les commente, les note de 1 à 5 étoiles et valide son choix. Un quota peut être fixé.
- Visionneuse commune au site public et aux galeries privées : mode diaporama (une photo toutes les 5 secondes), préchargement des images voisines et correction du clignotement qui rejouait l'apparition sur la photo précédente.
- La page privée n'est pas indexée (`Disallow: /prive/` dans robots.txt), n'est pas mesurée et reste hors du vote public.

### Mesure d'audience

- Balise de mesure sur toutes les pages publiques : visiteurs, pages vues, provenance et appareils, lisibles depuis l'administration.
- Sans cookie ni donnée personnelle, sans service tiers : un visiteur est reconnu une journée au plus par une empreinte anonyme renouvelée chaque nuit.
- Pour ne pas compter ses propres visites : clé `portfolio-no-stats` dans le stockage local du navigateur.

## 2026-10-16 — Galerie installable (PWA)

- Installation de la galerie publique sur l’écran d’accueil avec une identité distincte de Studio Stan : Galerie Stan Bouchet.
- Ouverture en fenêtre dédiée ; raccourcis Instants et Séries proposés aux systèmes compatibles.
- Icônes dérivées du logo existant, dont Apple Touch et maskable ; prise en compte des zones de sécurité de l’écran.
- Aide iPhone, Android et ordinateur en pied de page ; installation native lorsque le navigateur la propose.
- Consultation en ligne : aucun cache hors connexion de la photothèque ni service worker ajouté.


## 2026-06-20

### Modifié
- `astro` : mise à jour 6.3.1 → 6.4.8 (patch sécurité)
  - Ferme la XSS réfléchie via noms de slot non échappés sur composants hydratés — GHSA-8hv8-536x-4wqp (corrigée en 6.3.3)
  - Ferme la XSS via noms d'attributs non échappés dans les spread props — GHSA-jrpj-wcv7-9fh9 (corrigée en 6.4.6)
  - Non exploitable dans ce projet : site 100 % statique, aucune directive `client:*`, aucun slot nommé, aucun spread `{...}` exposé à une entrée utilisateur
  - Rebasé par-dessus le bump Dependabot 6.4.6 (conflit résolu en conservant 6.4.8)

### Note
- Résiduel `npm audit` : advisories `esbuild` et `vite` transitives, dev-server / Windows uniquement → sans impact sur le build statique de production. Ne pas exécuter `npm audit fix --force` (downgraderait Astro).
