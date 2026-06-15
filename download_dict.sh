#!/bin/bash
# download_dict.sh
# Script to automate downloading and extraction of CC-CEDICT dictionary

Url="https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.zip"
ZipFile="cedict.zip"
DestDir="dictionary"

# Ensure destination directory exists
if [ ! -d "$DestDir" ]; then
    mkdir -p "$DestDir"
    echo "Created directory: $DestDir"
fi

echo "Downloading CC-CEDICT dictionary from $Url..."
if curl -L -o "$ZipFile" "$Url"; then
    echo "Download complete."
else
    echo "Error: Failed to download dictionary" >&2
    exit 1
fi

echo "Extracting dictionary files..."
if unzip -q -o "$ZipFile" -d "$DestDir"; then
    echo "Extraction complete."
else
    echo "Error: Failed to extract zip file" >&2
    rm -f "$ZipFile"
    exit 1
fi

echo "Cleaning up zip file..."
rm -f "$ZipFile"

# Find the extracted file (usually ends in .u8 or .txt) and rename to 'cedict.txt'
ExtractedFile=$(find "$DestDir" -maxdepth 1 -type f \( -name "*.u8" -o -name "*.txt" \) ! -name "cedict.txt" | head -n 1)
if [ -n "$ExtractedFile" ]; then
    NewPath="$DestDir/cedict.txt"
    mv -f "$ExtractedFile" "$NewPath"
    echo "Successfully renamed extracted file to $NewPath"
    echo "Dictionary setup is complete!"
else
    # Check if it was already named cedict.txt or check if any txt exists
    ExistingFile="$DestDir/cedict.txt"
    if [ -f "$ExistingFile" ]; then
        echo "Dictionary file already present at $ExistingFile"
    else
        echo "Error: Extracted text file not found." >&2
        exit 1
    fi
fi
