# list_files_to_csv.sh

Génère un index CSV des images du dossier courant.

## Prérequis

- `bash`
- Images `.jpg`, `.jpeg` ou `.png` dans le dossier courant

## Utilisation

Depuis le dossier contenant les images:

```bash
./list_files_to_csv.sh
```

## Sortie

Le script génère `index_files.csv` avec les colonnes:
- `filename`
- `basename`
- `extension`

Exemple:

```csv
filename,basename,extension
"IMG_0001.JPG","IMG_0001","jpg"
```

## Attention

- Le script écrase `index_files.csv` à chaque exécution.
