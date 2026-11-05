# download_ocr.ps1
# Fetches the Tesseract.js OCR runtime and the Simplified Chinese model into .\ocr
# (Windows). Requires npm. Output is git-ignored, like the CC-CEDICT dictionary.

$ErrorActionPreference = "Stop"

$TessVersion = "5.1.1"                           # tesseract.js (worker + browser bundle)
$CoreVersion = "5.1.0"                           # tesseract.js-core (WASM engine)
$LangPkgs    = @("@tesseract.js-data/chi_tra@1.0.0", "@tesseract.js-data/chi_sim@1.0.0")  # Traditional + Simplified (4.0.0 best, int)
$DestDir     = "ocr"

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("zh-lens-ocr-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

try {
    Write-Host "Installing OCR packages into a temporary folder..."
    Push-Location $Tmp
    npm init -y | Out-Null
    npm install --silent "tesseract.js@$TessVersion" "tesseract.js-core@$CoreVersion" $LangPkgs
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
    Pop-Location

    $Modules = Join-Path $Tmp "node_modules"
    New-Item -ItemType Directory -Force -Path (Join-Path $DestDir "core"), (Join-Path $DestDir "lang") | Out-Null

    Copy-Item (Join-Path $Modules "tesseract.js\dist\tesseract.min.js") $DestDir -Force
    Copy-Item (Join-Path $Modules "tesseract.js\dist\worker.min.js") $DestDir -Force
    Copy-Item (Join-Path $Modules "tesseract.js-core\tesseract-core-simd-lstm.wasm.js") (Join-Path $DestDir "core") -Force
    Copy-Item (Join-Path $Modules "tesseract.js-core\tesseract-core-lstm.wasm.js") (Join-Path $DestDir "core") -Force
    Copy-Item (Join-Path $Modules "@tesseract.js-data\chi_tra\4.0.0_best_int\chi_tra.traineddata.gz") (Join-Path $DestDir "lang") -Force
    Copy-Item (Join-Path $Modules "@tesseract.js-data\chi_sim\4.0.0_best_int\chi_sim.traineddata.gz") (Join-Path $DestDir "lang") -Force

    Write-Host "OCR assets installed into $DestDir\."
}
finally {
    if ((Get-Location).Path -eq $Tmp) { Pop-Location }
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
