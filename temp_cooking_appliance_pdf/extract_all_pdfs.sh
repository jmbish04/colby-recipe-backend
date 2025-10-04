#!/usr/bin/env bash

set -euo pipefail

# Usage: ./extract_all_pdfs.sh [directory]
# Default is current directory. Requires `pdftotext` to be installed.

dir="${1:-.}"

if ! command -v pdftotext >/dev/null 2>&1; then
  echo "Error: pdftotext not found. Install poppler (e.g., 'brew install poppler')." >&2
  exit 1
fi

shopt -s nullglob

count=0
while IFS= read -r -d '' pdf; do
  base="${pdf##*/}"
  txt="${base%.pdf}.txt"
  echo "Converting: $pdf -> $txt"
  # -enc UTF-8 for consistent encoding; -layout preserves layout better than default
  pdftotext -enc UTF-8 -layout "$pdf" "$dir/$txt"
  count=$((count+1))
done < <(find "$dir" -maxdepth 1 -type f -iname '*.pdf' -print0)

if [[ $count -eq 0 ]]; then
  echo "No PDFs found in: $dir"
else
  echo "Done. Converted $count PDF(s)."
fi

