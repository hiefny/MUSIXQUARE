# Fetch Pretendard font files for self-hosting.
# Output: /fonts
# Usage (PowerShell):
#   .\scripts\fetch-pretendard.ps1

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$fonts = Join-Path $root "fonts"
New-Item -ItemType Directory -Force -Path $fonts | Out-Null

Write-Host "Downloading Pretendard (v1.3.9) variable font (WOFF2)..."
Invoke-WebRequest `
  -Uri "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2/PretendardVariable.woff2" `
  -OutFile (Join-Path $fonts "PretendardVariable.woff2")

Write-Host "Downloading license..."
Invoke-WebRequest `
  -Uri "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/LICENSE.txt" `
  -OutFile (Join-Path $fonts "PRETENDARD_LICENSE.txt")

Write-Host "Done."
Write-Host "Now serve the site and verify the font loads (Network tab should show PretendardVariable.woff2)."
