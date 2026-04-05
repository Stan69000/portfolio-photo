#!/bin/bash

SRC_DIR="$1"
PREVIEW_DIR="${SRC_DIR}_PREVIEW"

mkdir -p "$PREVIEW_DIR"

echo "Source : $SRC_DIR"
echo "Preview (vente) : $PREVIEW_DIR"
echo "--------------------------------"

find "$SRC_DIR" -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) | while read img; do

  filename=$(basename "$img")
  name="${filename%.*}"

  # 🔢 Numéro basé sur le nom du fichier
  digits=$(echo "$name" | tr -cd '0-9')
  if [ -n "$digits" ]; then
      num=$(printf "%04d" "$digits")
  else
      num=$(echo -n "$name" | md5 | cut -c1-4)
  fi

  # ==========================
  # PREVIEW — FILIGRANE PROTECTION
  # ==========================
  magick "$img" \
    -gravity center \
    -fill "rgba(245,245,245,0.55)" \
    -stroke black -strokewidth 8 \
    -pointsize 420 \
    -annotate 45 "MON FILIGRANE ICI  #$num" \
    "$PREVIEW_DIR/$filename"

  echo "✔ PREVIEW $filename -> #$num"

done

echo "--------------------------------"
echo "Filigranes de protection terminés."
