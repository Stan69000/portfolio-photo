# rename_with_mapping.sh

Renomme automatiquement les images d'un dossier avec un préfixe numéroté, et génère un CSV de correspondance.

## Prérequis

- `bash`
- Images `.jpg`, `.jpeg` ou `.png` dans le dossier courant

## Configuration

Dans le script:
- `PREFIX="Gala2026_photo"`
- `CSV_FILE="mapping_renommage.csv"`

Modifie `PREFIX` selon ton projet avant lancement.

## Utilisation

Depuis le dossier contenant les images:

```bash
./rename_with_mapping.sh
```

## Fonctionnement

- Trie les fichiers par nom.
- Renomme en séquence:
  - `Gala2026_photo0001.jpg`
  - `Gala2026_photo0002.jpg`
  - etc.
- Écrit le mapping dans `mapping_renommage.csv`.
- Stoppe en cas de collision de nom.

## Sortie

- Fichiers renommés dans le dossier courant.
- CSV `old_filename,new_filename`.

## Attention

- Le renommage est immédiat: fais une copie si nécessaire avant exécution.
