#!/bin/bash

CSV_FILE="mapping_renommage.csv"

if [ ! -f "$CSV_FILE" ]; then
  echo "❌ CSV introuvable : $CSV_FILE"
  exit 1
fi

echo "📄 CSV utilisé : $CSV_FILE"
echo "📂 Dossier    : $(pwd)"
echo "--------------------------------"

# On saute l'en-tête (ligne 1)
tail -n +2 "$CSV_FILE" | while IFS=',' read -r old new; do

  # Nettoyage des guillemets éventuels
  old=$(echo "$old" | sed 's/^"//;s/"$//')
  new=$(echo "$new" | sed 's/^"//;s/"$//')

  if [ -z "$old" ] || [ -z "$new" ]; then
    continue
  fi

  if [ ! -f "$old" ]; then
    echo "⚠️  ABSENT : $old (ignoré)"
    continue
  fi

  if [ -f "$new" ]; then
    echo "❌ CONFLIT : $new existe déjà — arrêt"
    exit 1
  fi

  mv "$old" "$new"
  echo "✔ $old → $new"

done

echo "--------------------------------"
echo "✅ Renommage terminé selon le CSV"
