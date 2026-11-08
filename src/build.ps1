<#
  Builds MarkNotes.

    .\build.ps1                 build the app into src\publish
    .\build.ps1 -Installer      also build installer\MarkNotes-Setup-<version>.exe
    .\build.ps1 -Deploy         also copy the build into the folder above src (a portable copy)
    .\build.ps1 -Public         a build to share with others: without the Spine model player (the Spine Runtimes
                                may be passed on only by Spine Editor licensees); with -Installer, the setup goes
                                to release\ instead of installer\

  Needs: Node.js 18+, .NET 8 SDK. Inno Setup is fetched from NuGet when -Installer is used.
#>
param(
    [switch]$Installer,
    [switch]$Deploy,
    [switch]$Public
)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$root = Split-Path $src -Parent
$publish = Join-Path $src 'publish'

Write-Host '== Web UI ==' -ForegroundColor Cyan
Push-Location (Join-Path $src 'web')
try {
    if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund }
    $webArgs = @('build.mjs')
    if ($Public) { $webArgs += '--no-spine' }
    node @webArgs
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
} finally { Pop-Location }

Write-Host '== Native host ==' -ForegroundColor Cyan
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
dotnet publish (Join-Path $src 'host\MarkNotes.csproj') -c Release -r win-x64 --self-contained false -p:PublishReadyToRun=true -o $publish
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }
Copy-Item (Join-Path $src 'web\dist') (Join-Path $publish 'web') -Recurse
Get-ChildItem $publish -Filter *.xml | Remove-Item -Force
Get-ChildItem $publish -Filter *.pdb | Remove-Item -Force
Write-Host "App built in $publish" -ForegroundColor Green

if ($Installer) {
    Write-Host '== Installer ==' -ForegroundColor Cyan
    $tools = Join-Path $src 'tools\innosetup'
    $iscc = Join-Path $tools 'tools\ISCC.exe'
    if (-not (Test-Path $iscc)) {
        New-Item -ItemType Directory -Force $tools | Out-Null
        $pkg = Join-Path $tools 'innosetup.zip'
        Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/tools.innosetup/6.7.3/tools.innosetup.6.7.3.nupkg' -OutFile $pkg
        Expand-Archive $pkg -DestinationPath $tools -Force
        Remove-Item $pkg
    }
    $isccArgs = @("/DSourceDir=$publish")
    if ($Public) { $isccArgs += "/O$(Join-Path $root 'release')" }
    & $iscc @isccArgs (Join-Path $src 'installer\MarkNotes.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
}

if ($Deploy) {
    Write-Host '== Deploy ==' -ForegroundColor Cyan
    if (Get-Process MarkNotes -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$root\*" }) {
        throw "Close MarkNotes first (it is running from $root)."
    }
    foreach ($old in 'web', 'runtimes', 'icons') {
        $p = Join-Path $root $old
        if (Test-Path $p) { Remove-Item $p -Recurse -Force }
    }
    Copy-Item (Join-Path $publish '*') $root -Recurse -Force
    Write-Host "Deployed to $root" -ForegroundColor Green
}
