# watermark_preview_protection.sh

Génère des previews filigranées "protection vente" dans un dossier `*_PREVIEW`.

## Prérequis

- `bash`
- ImageMagick (`magick`)

## Utilisation

Depuis ce dossier:

```bash
./watermark_preview_protection.sh "/chemin/vers/mon_dossier_images"
```

Le script crée:
- `"/chemin/vers/mon_dossier_images_PREVIEW"`

## Fonctionnement

- Traite les `.jpg`, `.jpeg`, `.png` (récursif).
- Numéro de watermark:
  - chiffres extraits du nom de fichier, formatés sur 4 caractères, ou
  - hash court si aucun chiffre (fallback).
- Ajoute le texte diagonal `LENTILLY GR  #XXXX`.

## Sortie

- Un fichier preview par image, avec le même nom.
- Logs `PREVIEW <fichier> -> #num`.

## Attention

- Le script suppose que le dossier source est valide.
- Sur Linux, la commande `md5` peut ne pas exister (remplacer par `md5sum` si besoin).
