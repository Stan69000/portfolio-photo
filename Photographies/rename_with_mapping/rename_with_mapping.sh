#!/bin/bash

# ==========================
# CONFIG
# ==========================
PREFIX="Gala2026_photo"
CSV_FILE="mapping_renommage.csv"

# ==========================
# LISTE DES FICHIERS
# ==========================
files=()
while IFS= read -r -d '' file; do
  files+=("$file")
done < <(find . -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) -print0 | sort -z)

TOTAL=${#files[@]}

if [ "$TOTAL" -eq 0 ]; then
  echo "❌ Aucun fichier image trouvé"
  exit 1
fi

echo "📸 Fichiers détectés : $TOTAL"
echo "Préfixe : $PREFIX"
echo "---------------------------"

# ==========================
# CSV HEADER
# ==========================
echo "old_filename,new_filename" > "$CSV_FILE"

# ==========================
# RENOMMAGE
# ==========================
i=1
for file in "${files[@]}"; do
  old_name=$(basename "$file")
  ext="${old_name##*.}"

  new_name=$(printf "%s%04d.%s" "$PREFIX" "$i" "$ext")

  # Sécurité : ne pas écraser
  if [ -e "$new_name" ]; then
    echo "❌ Conflit : $new_name existe déjà"
    exit 1
  fi

  mv "$file" "$new_name"

  echo "\"$old_name\",\"$new_name\"" >> "$CSV_FILE"
  echo "✔ $old_name → $new_name"

  i=$((i+1))
done

echo "---------------------------"
echo "✅ Renommage terminé"
echo "📑 Mapping CSV : $CSV_FILE"
