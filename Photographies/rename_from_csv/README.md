# rename_from_csv.sh

Renomme des fichiers à partir d'un mapping CSV `ancien_nom -> nouveau_nom`.

## Prérequis

- `bash`
- Un fichier `mapping_renommage.csv` dans le dossier courant

## Format CSV attendu

Le script attend une en-tête puis 2 colonnes:

```csv
old_filename,new_filename
IMG_0001.jpg,Gala2026_photo0001.jpg
IMG_0002.jpg,Gala2026_photo0002.jpg
```

## Utilisation

Depuis le dossier contenant les fichiers à renommer:

```bash
./rename_from_csv.sh
```

## Fonctionnement

- Ignore la première ligne (en-tête).
- Supprime les guillemets éventuels autour des valeurs.
- Ignore les lignes incomplètes.
- Arrête le script en cas de conflit (`nouveau_nom` déjà existant).

## Sortie

- Renommage effectif des fichiers listés dans le CSV.
- Logs des fichiers absents et des conflits.

## Attention

- Vérifie le CSV avant exécution.
- En cas d'erreur au milieu, certains fichiers peuvent déjà être renommés.
