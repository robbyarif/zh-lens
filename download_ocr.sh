#!/bin/bash
# download_ocr.sh
# Fetches the Tesseract.js OCR runtime and the Simplified Chinese model into ./ocr
# (Linux/macOS). Requires npm. Output is git-ignored, like the CC-CEDICT dictionary.

set -euo pipefail

TESS_VERSION="5.1.1"          # tesseract.js (worker + browser bundle)
CORE_VERSION="5.1.0"          # tesseract.js-core (WASM engine), matches tesseract.js 5.x
LANG_PKGS=("@tesseract.js-data/chi_tra@1.0.0" "@tesseract.js-data/chi_sim@1.0.0")  # Traditional + Simplified traineddata (4.0.0 best, int)
DestDir="ocr"

Tmp=$(mktemp -d)
trap 'rm -rf "$Tmp"' EXIT

echo "Installing OCR packages into a temporary folder..."
(
  cd "$Tmp"
  npm init -y >/dev/null
  npm install --silent "tesseract.js@$TESS_VERSION" "tesseract.js-core@$CORE_VERSION" "${LANG_PKGS[@]}"
)

Modules="$Tmp/node_modules"
mkdir -p "$DestDir/core" "$DestDir/lang"

cp "$Modules/tesseract.js/dist/tesseract.min.js" "$DestDir/"
cp "$Modules/tesseract.js/dist/worker.min.js" "$DestDir/"
cp "$Modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js" "$DestDir/core/"
cp "$Modules/tesseract.js-core/tesseract-core-lstm.wasm.js" "$DestDir/core/"
cp "$Modules/@tesseract.js-data/chi_tra/4.0.0_best_int/chi_tra.traineddata.gz" "$DestDir/lang/"
cp "$Modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz" "$DestDir/lang/"

echo "OCR assets installed into $DestDir/."
