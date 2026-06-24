#!/bin/bash
# package.sh
# Production packaging script for Zh-Lens Chrome Extension

ZipName="zh-lens-production.zip"
FilesToInclude=(
    "manifest.json"
    "background.js"
    "content.js"
    "styles.css"
    "dictionary/cedict.txt"
    "popup/popup.html"
    "popup/popup.css"
    "popup/popup.js"
    "icons/icon16.png"
    "icons/icon48.png"
    "icons/icon128.png"
)

# Remove old production package if it exists
if [ -f "$ZipName" ]; then
    rm -f "$ZipName"
    echo "Removed existing $ZipName"
fi

# Create staging environment
StageDir="stage"
if [ -d "$StageDir" ]; then
    rm -rf "$StageDir"
fi
mkdir -p "$StageDir"
echo "Created staging directory: $StageDir"

# Copy runtime assets while maintaining tree structures
echo "Copying files..."
for File in "${FilesToInclude[@]}"; do
    if [ -e "$File" ]; then
        DestFile="$StageDir/$File"
        ParentDir=$(dirname "$DestFile")
        if [ ! -d "$ParentDir" ]; then
            mkdir -p "$ParentDir"
        fi
        cp -f "$File" "$DestFile"
        echo "  + $File"
    else
        echo "Warning: File not found: $File" >&2
    fi
done

# Compress staging directory
echo "Waiting for file locks to release..."
sleep 3
echo "Compressing extension into $ZipName..."
if zip -r "$ZipName" "$StageDir"/* > /dev/null 2>&1; then
    echo "Compression completed successfully."
else
    echo "Error: Failed to compress archive" >&2
    rm -rf "$StageDir"
    exit 1
fi

# Clean up staging environment
echo "Cleaning up staging directory..."
rm -rf "$StageDir"

echo "--------------------------------------------------"
echo "Build Succeeded! Packaged archive created at: $ZipName"
FileSize=$(du -h "$ZipName" | cut -f1)
echo "Size: $FileSize"
echo "This ZIP archive is ready for upload to the Chrome Web Store."
echo "--------------------------------------------------"
