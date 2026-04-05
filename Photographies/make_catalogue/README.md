# make_catalogue.sh

Crée un catalogue PDF en planches (grille 3x3) à partir des images du dossier courant.

## Prérequis

- `bash`
- ImageMagick (`magick`, `montage`)

## Utilisation

Depuis le dossier contenant les images:

```bash
./make_catalogue.sh
```

Le script crée:
- `_CATALOGUE/`
- `_CATALOGUE/_TMP/`
- `_CATALOGUE/Catalogue_Lentilly_GR.pdf`

## Fonctionnement

- Récupère les `.jpg`, `.jpeg`, `.png` triées par nom.
- Crée des pages JPG A4 portrait en grille `3x3`.
- Assemble toutes les pages en un PDF final.

## Paramètres clés (dans le script)

- `TILE="3x3"`
- `PAGE_W=2480` et `PAGE_H=3508`
- `GEOM="+40+40"`

## Attention

- Les dossiers `_CATALOGUE/` et `_TMP/` sont réutilisés.
- Selon le volume d'images, le traitement peut être long.
