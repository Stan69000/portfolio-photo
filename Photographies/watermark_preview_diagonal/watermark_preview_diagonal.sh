#!/bin/bash

# ===============================
# 🔒 Sécurité ImageMagick (ANTI BUGS)
# ===============================
export MAGICK_MEMORY_LIMIT=256MiB
export MAGICK_MAP_LIMIT=512MiB
export MAGICK_DISK_LIMIT=1GiB
export MAGICK_THREAD_LIMIT=1

# ===============================
# 📂 Dossiers
# ===============================
SRC_DIR="$1"
OUT_DIR="${SRC_DIR}_PREVIEW"

if [ -z "$SRC_DIR" ] || [ ! -d "$SRC_DIR" ]; then
  echo "❌ Dossier source invalide"
  echo "Usage : ./watermark_preview_diagonal.sh NOM_DOSSIER"
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Source  : $SRC_DIR"
echo "Preview : $OUT_DIR"
echo "--------------------------------"

# ===============================
# 📸 Comptage des images
# ===============================
TOTAL=$(find "$SRC_DIR" -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) | wc -l | tr -d ' ')
COUNT=0

if [ "$TOTAL" -eq 0 ]; then
  echo "❌ Aucune image trouvée"
  exit 1
fi

# ===============================
# 🔁 Traitement image par image
# ===============================
find "$SRC_DIR" -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) | while read -r img; do

  COUNT=$((COUNT + 1))
  filename=$(basename "$img")
  name="${filename%.*}"

  # 🔢 Extraction du numéro depuis le nom du fichier
  digits=$(echo "$name" | tr -cd '0-9')
  if [ -n "$digits" ]; then
    num=$(printf "%04d" "$digits")
  else
    num="XXXX"
  fi

  # 🖼️ ImageMagick — MODE PROPRE
  magick "$img" \
    -auto-orient \
    -strip \
    -write mpr:base +delete \
    mpr:base \
    -gravity center \
    -fill "rgba(245,245,245,0.45)" \
    -stroke black -strokewidth 3 \
    -pointsize 250 \
    -annotate 45 " #$num" \
    "$OUT_DIR/$filename"

  # 📊 Progression
  PERCENT=$((COUNT * 100 / TOTAL))
  printf "\r⏳ %3d%% (%d/%d)" "$PERCENT" "$COUNT" "$TOTAL"

  # 🧹 Mini pause pour libération mémoire
  sleep 0.02

done

echo
echo "--------------------------------"
echo "✅ Filigranes PREVIEW générés"
echo "📁 Résultat : $OUT_DIR"