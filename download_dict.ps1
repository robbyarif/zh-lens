# download_dict.ps1
# Script to automate downloading and extraction of CC-CEDICT dictionary

$Url = "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.zip"
$ZipFile = "cedict.zip"
$DestDir = "dictionary"

# Ensure destination directory exists
if (-not (Test-Path $DestDir)) {
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    Write-Host "Created directory: $DestDir"
}

Write-Host "Downloading CC-CEDICT dictionary from $Url..."
try {
    # Set SecurityProtocol to TLS 1.2 to avoid download failures
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $ZipFile -ErrorAction Stop
    Write-Host "Download complete."
} catch {
    Write-Error "Failed to download dictionary: $_"
    exit 1
}

Write-Host "Extracting dictionary files..."
try {
    Expand-Archive -Path $ZipFile -DestinationPath $DestDir -Force
    Write-Host "Extraction complete."
} catch {
    Write-Error "Failed to extract zip file: $_"
    Remove-Item -Path $ZipFile -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "Cleaning up zip file..."
Remove-Item -Path $ZipFile -ErrorAction SilentlyContinue

# Find the extracted file (usually ends in .u8 or .txt) and rename to 'cedict.txt'
$ExtractedFile = Get-ChildItem -Path $DestDir | Where-Object { $_.Extension -in ".u8", ".txt" } | Where-Object { $_.Name -ne "cedict.txt" } | Select-Object -First 1
if ($ExtractedFile) {
    $NewPath = Join-Path $DestDir "cedict.txt"
    Rename-Item -Path $ExtractedFile.FullName -NewName "cedict.txt" -Force
    Write-Host "Successfully renamed extracted file to $NewPath"
    Write-Host "Dictionary setup is complete!"
} else {
    # Check if it was already named cedict.txt or check if any txt exists
    $ExistingFile = Join-Path $DestDir "cedict.txt"
    if (Test-Path $ExistingFile) {
        Write-Host "Dictionary file already present at $ExistingFile"
    } else {
        Write-Error "Error: Extracted text file not found."
        exit 1
    }
}
