# Changelog

## 2026-10-18 — Relais TV The Frame

- Version locale du relais synchronisée : modes natif et rapide, reprise après Afficher, aperçus TV mis en cache.
- Mode rapide : toutes les photos passent avant le tour suivant ; les dernières photos vues sur la moitié d’un tour restent exclues des tirages suivants (26 pour 53 photos). Historique conservé pendant une sortie du mode Art ou une interruption réseau, tant que le relais reste ouvert.
- Démarrage rapide : ne renvoie plus un ordre d’arrêt à une rotation native déjà arrêtée.
- Usage Mac fermé : mode autonome de la TV, réglé à 10 minutes par photo dans l’ordre sur les 53 photos présentes. Réglage confirmé après arrêt du relais ; reprise après Netflix ou extinction non encore testée.
- Validation : 16 tests du relais réussis, dont trois tours sans répétitions rapprochées et reprise après interruption.

## 2026-06-20

### Modifié
- `astro` : mise à jour 6.3.1 → 6.4.8 (patch sécurité)
  - Ferme la XSS réfléchie via noms de slot non échappés sur composants hydratés — GHSA-8hv8-536x-4wqp (corrigée en 6.3.3)
  - Ferme la XSS via noms d'attributs non échappés dans les spread props — GHSA-jrpj-wcv7-9fh9 (corrigée en 6.4.6)
  - Non exploitable dans ce projet : site 100 % statique, aucune directive `client:*`, aucun slot nommé, aucun spread `{...}` exposé à une entrée utilisateur
  - Rebasé par-dessus le bump Dependabot 6.4.6 (conflit résolu en conservant 6.4.8)

### Note
- Résiduel `npm audit` : advisories `esbuild` et `vite` transitives, dev-server / Windows uniquement → sans impact sur le build statique de production. Ne pas exécuter `npm audit fix --force` (downgraderait Astro).
