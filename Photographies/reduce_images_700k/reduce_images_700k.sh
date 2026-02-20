#!/bin/bash

SRC_DIR="."
OUT_DIR="reduced"
TARGET_SIZE=700000   # ~700 Ko en octets

mkdir -p "$OUT_DIR"

echo "📂 Dossier source : $(pwd)"
echo "📁 Dossier réduit : $OUT_DIR"
echo "🎯 Cible          : ~700 Ko"
echo "--------------------------------"

count=0

find "$SRC_DIR" -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" \) | while read -r img; do
  filename=$(basename "$img")

  # Évite de retraiter les images déjà réduites
  if [[ "$img" == ./$OUT_DIR/* ]]; then
    continue
  fi

  out="$OUT_DIR/$filename"

  # Première passe (qualité élevée)
  magick "$img" -strip -quality 85 "$out"

  size=$(stat -f%z "$out")

  # Boucle d’ajustement si trop lourd
  quality=80
  while [ "$size" -gt "$TARGET_SIZE" ] && [ "$quality" -ge 40 ]; do
    magick "$img" -strip -quality "$quality" "$out"
    size=$(stat -f%z "$out")
    quality=$((quality - 5))
  done

  final_kb=$((size / 1024))
  echo "✔ $filename → ${final_kb} Ko"

  count=$((count + 1))
done

echo "--------------------------------"
echo "✅ $count image(s) réduite(s) dans ./$OUT_DIR/"
