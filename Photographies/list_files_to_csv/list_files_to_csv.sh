#!/bin/bash

OUT_CSV="index_files.csv"

echo "filename,basename,extension" > "$OUT_CSV"

find . -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) | sort | while read -r file; do
  filename=$(basename "$file")
  basename="${filename%.*}"
  extension="${filename##*.}"
  extension=$(echo "$extension" | tr '[:upper:]' '[:lower:]')

  echo "\"$filename\",\"$basename\",\"$extension\"" >> "$OUT_CSV"
done

echo "✅ CSV généré : $OUT_CSV"
