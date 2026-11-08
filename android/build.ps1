<#
  Builds MarkNotes for Android: the web UI (src\web) and the APK, signed with keystore\marknotes-release.jks.

    .\build.ps1        → MarkNotes-Android-<version>.apk next to this script

  Needs: Node.js 18+, JDK 17+, the Android SDK (local.properties: sdk.dir). Gradle runs offline once its cache is filled.
  Keep keystore\ and keystore.properties: an update installs over the app only when signed with the same key.
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$web = Join-Path (Split-Path $here -Parent) 'src\web'

Write-Host '== Web UI ==' -ForegroundColor Cyan
Push-Location $web
try {
    if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund }
    node build.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
} finally { Pop-Location }

Write-Host '== APK ==' -ForegroundColor Cyan
Push-Location $here
try {
    & .\gradlew.bat --offline :app:assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Gradle build failed' }
} finally { Pop-Location }

$gradle = Get-Content (Join-Path $here 'app\build.gradle') -Raw
$version = [regex]::Match($gradle, 'versionName\s+"([^"]+)"').Groups[1].Value
$apk = Join-Path $here "MarkNotes-Android-$version.apk"
Copy-Item (Join-Path $here 'app\build\outputs\apk\release\app-release.apk') $apk -Force
Write-Host "APK: $apk" -ForegroundColor Green
