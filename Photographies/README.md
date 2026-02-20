# Photographies

Collection de scripts shell pour le flux de travail photo:
- renommage par lot
- génération de CSV
- réduction de poids des images
- génération de previews filigranées
- création d'un catalogue PDF

## Prérequis

- macOS ou Linux avec `bash`
- [ImageMagick](https://imagemagick.org/) (`magick`, `montage`) pour les scripts d'image
- utilitaires shell standards (`find`, `sort`, `mv`, `stat`, `tail`)

## Structure

- `list_files_to_csv/`
- `make_catalogue/`
- `reduce_images_700k/`
- `rename_from_csv/`
- `rename_with_mapping/`
- `watermark_preview_diagonal/`
- `watermark_preview_protection/`

Chaque dossier contient:
- le script `.sh`
- un `README.md` dédié avec usage détaillé
