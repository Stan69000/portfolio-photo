# Changelog

## 2026-06-20

### Modifié
- `astro` : mise à jour 6.3.1 → 6.4.8 (patch sécurité)
  - Ferme la XSS réfléchie via noms de slot non échappés sur composants hydratés — GHSA-8hv8-536x-4wqp (corrigée en 6.3.3)
  - Ferme la XSS via noms d'attributs non échappés dans les spread props — GHSA-jrpj-wcv7-9fh9 (corrigée en 6.4.6)
  - Non exploitable dans ce projet : site 100 % statique, aucune directive `client:*`, aucun slot nommé, aucun spread `{...}` exposé à une entrée utilisateur
  - Rebasé par-dessus le bump Dependabot 6.4.6 (conflit résolu en conservant 6.4.8)

### Note
- Résiduel `npm audit` : advisories `esbuild` et `vite` transitives, dev-server / Windows uniquement → sans impact sur le build statique de production. Ne pas exécuter `npm audit fix --force` (downgraderait Astro).
