# package.ps1
# Production packaging script for Zh-Lens Chrome Extension

$ZipName = "zh-lens-production.zip"
$FilesToInclude = @(
    "manifest.json",
    "background.js",
    "content.js",
    "styles.css",
    "dictionary\cedict.txt",
    "popup\popup.html",
    "popup\popup.css",
    "popup\popup.js",
    "icons\icon16.png",
    "icons\icon48.png",
    "icons\icon128.png"
)

# Remove old production package if it exists
if (Test-Path $ZipName) {
    Remove-Item $ZipName -Force | Out-Null
    Write-Host "Removed existing $ZipName"
}

# Create staging environment
$StageDir = "stage"
if (Test-Path $StageDir) {
    Remove-Item $StageDir -Recurse -Force | Out-Null
}
New-Item -ItemType Directory -Path $StageDir | Out-Null
Write-Host "Created staging directory: $StageDir"

# Copy runtime assets while maintaining tree structures
Write-Host "Copying files..."
foreach ($File in $FilesToInclude) {
    if (Test-Path $File) {
        $DestFile = Join-Path $StageDir $File
        $ParentDir = Split-Path $DestFile
        if (-not (Test-Path $ParentDir)) {
            New-Item -ItemType Directory -Path $ParentDir | Out-Null
        }
        Copy-Item -Path $File -Destination $DestFile -Force
        Write-Host "  + $File"
    } else {
        Write-Warning "File not found: $File"
    }
}

# Compress staging directory
Write-Host "Waiting for file locks to release..."
Start-Sleep -Seconds 3
Write-Host "Compressing extension into $ZipName..."
try {
    Compress-Archive -Path "$StageDir\*" -DestinationPath $ZipName -Force
    Write-Host "Compression completed successfully."
} catch {
    Write-Error "Failed to compress archive: $_"
    Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# Clean up staging environment
Write-Host "Cleaning up staging directory..."
Remove-Item $StageDir -Recurse -Force | Out-Null

Write-Host "--------------------------------------------------"
Write-Host "Build Succeeded! Packaged archive created at: $ZipName"
Write-Host "Size: $((Get-Item $ZipName).Length / (1024*1024) | ForEach-Object { '{0:N2}' -f $_ }) MB"
Write-Host "This ZIP archive is ready for upload to the Chrome Web Store."
Write-Host "--------------------------------------------------"
