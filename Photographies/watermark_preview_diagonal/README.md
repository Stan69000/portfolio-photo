# watermark_preview_diagonal.sh

Ajoute un filigrane diagonal centré sur chaque image d'un dossier source, et écrit le résultat dans un dossier `*_PREVIEW`.

## Prérequis

- `bash`
- ImageMagick (`magick`)

## Utilisation

Depuis ce dossier:

```bash
./watermark_preview_diagonal.sh "/chemin/vers/mon_dossier_images"
```

Le script crée automatiquement:
- `"/chemin/vers/mon_dossier_images_PREVIEW"`

## Fonctionnement

- Lit les `.jpg`, `.jpeg`, `.png` (récursif).
- Extrait les chiffres du nom de fichier pour créer un identifiant `#0001`.
- Si aucun chiffre n'est trouvé, utilise `#XXXX`.
- Ajoute un filigrane diagonal semi-transparent avec contour.

## Sortie

- Conserve le nom de fichier d'origine.
- Affiche une progression en pourcentage.

## Attention

- Le dossier source doit exister.
- Les fichiers existants dans le dossier `*_PREVIEW` peuvent être remplacés si mêmes noms.
