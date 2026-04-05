#!/bin/bash

# =========================
# CONFIG
# =========================
SRC_DIR="$(pwd)"
OUT_DIR="_CATALOGUE"
TMP_DIR="$OUT_DIR/_TMP"
PDF_OUT="$OUT_DIR/Catalogue_Lentilly_GR.pdf"

PAGE_W=2480
PAGE_H=3508
TILE="3x3"
GEOM="+40+40"

mkdir -p "$TMP_DIR"
mkdir -p "$OUT_DIR"

echo "📂 Dossier source : $SRC_DIR"

# =========================
# LISTE DES IMAGES
# =========================
images=()
while IFS= read -r -d '' img; do
  images+=("$img")
done < <(find "$SRC_DIR" -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) -print0 | sort -z)

TOTAL=${#images[@]}

if [ "$TOTAL" -eq 0 ]; then
  echo "❌ Aucune image trouvée"
  exit 1
fi

echo "🖼️ Images trouvées : $TOTAL"
echo "----------------------------"

# =========================
# CRÉATION DES PLANCHES
# =========================
page=1
count=0
batch=()

for img in "${images[@]}"; do
  batch+=("$img")
  ((count++))

  # Progression simple
  printf "\r📄 Préparation : %d / %d" "$count" "$TOTAL"

  if [ "${#batch[@]}" -eq 9 ] || [ "$count" -eq "$TOTAL" ]; then
    montage "${batch[@]}" \
      -auto-orient \
      -resize 1800x1800 \
      -background white \
      -gravity center \
      -tile $TILE \
      -geometry $GEOM \
      -extent ${PAGE_W}x${PAGE_H} \
      "$TMP_DIR/page_$(printf "%03d" "$page").jpg"

    batch=()
    ((page++))
  fi
done

echo
echo "✅ Planches générées : $((page-1)) pages"

# =========================
# PDF FINAL
# =========================
echo "📕 Génération du PDF..."
magick "$TMP_DIR"/page_*.jpg "$PDF_OUT"

echo "----------------------------"
echo "🎉 Catalogue prêt :"
echo "$PDF_OUT"
