# reduce_images_700k.sh

Réduit le poids des images JPEG d'un dossier courant vers environ `700 Ko` maximum par image.

## Prérequis

- `bash`
- ImageMagick (`magick`)

## Utilisation

Place-toi dans le dossier contenant les images puis lance:

```bash
./reduce_images_700k.sh
```

Le script crée:
- `./reduced/`

## Fonctionnement

- Traite les `.jpg` et `.jpeg` du dossier courant.
- Première compression en qualité `85`.
- Si le fichier est encore trop lourd, baisse la qualité par pas de `5` jusqu'à `40`.
- Cible: `700000` octets (environ 700 Ko).

## Sortie

- Un fichier compressé par image dans `reduced/`.
- Affichage du poids final en Ko.

## Attention

- Script calibré pour `stat -f%z` (macOS).
- Ne supprime pas les originaux.
