# Builds the Codex Web GPT Windows installer from source.
# Run with build-windows.cmd (double-click), or from PowerShell 7: pwsh -ExecutionPolicy Bypass -File build-windows.ps1

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Launcher = Join-Path $Root "launcher"
$Artifacts = Join-Path $Launcher "artifacts"

$PackageJson = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
if ($PackageJson.packageManager -notmatch '^bun@(\d+\.\d+\.\d+)$') {
  throw "package.json must pin an exact Bun packageManager version"
}
$BunVersion = $Matches[1]
# Bun is kept inside the project (.tools\, git-ignored) so the global Bun stays untouched.
$BunAsset = "bun-windows-x64-baseline"
$BunHome = Join-Path $Root ".tools\bun-$BunVersion"
$BunExe = Join-Path $BunHome "bun.exe"

function Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Bun([string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $BunExe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "bun $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Install-ProjectBun {
  $ReleaseBase = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion"
  $Stage = Join-Path ([System.IO.Path]::GetTempPath()) "codex-chatgpt-web-bun-$BunVersion"
  $Archive = Join-Path $Stage "$BunAsset.zip"
  $Checksums = Join-Path $Stage "SHASUMS256.txt"
  $Extracted = Join-Path $Stage "extracted"

  Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $Stage | Out-Null
  try {
    Invoke-WebRequest "$ReleaseBase/$BunAsset.zip" -OutFile $Archive -UseBasicParsing
    Invoke-WebRequest "$ReleaseBase/SHASUMS256.txt" -OutFile $Checksums -UseBasicParsing

    $ExpectedLine = Get-Content -LiteralPath $Checksums | Where-Object { $_ -match "  $([regex]::Escape($BunAsset))\.zip$" }
    if (@($ExpectedLine).Count -ne 1) { throw "Bun checksums did not contain exactly one $BunAsset.zip entry" }
    $Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
    # .NET instead of Get-FileHash/Expand-Archive: those module cmdlets fail to load in Windows
    # PowerShell 5.1 when it inherits PowerShell 7's PSModulePath.
    $Sha256 = [System.Security.Cryptography.SHA256]::Create()
    $Stream = [System.IO.File]::OpenRead($Archive)
    try { $Actual = ([System.BitConverter]::ToString($Sha256.ComputeHash($Stream)) -replace "-", "").ToLowerInvariant() }
    finally { $Stream.Dispose(); $Sha256.Dispose() }
    if ($Actual -ne $Expected) { throw "Bun SHA-256 mismatch: expected $Expected, received $Actual" }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Extracted)
    $Executables = @(Get-ChildItem -LiteralPath $Extracted -Filter bun.exe -File -Recurse)
    if ($Executables.Count -ne 1) { throw "Bun archive contained $($Executables.Count) bun.exe files" }
    New-Item -ItemType Directory -Path $BunHome -Force | Out-Null
    Copy-Item -LiteralPath $Executables[0].FullName -Destination $BunExe -Force
  } finally {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Step "Checking project Bun $BunVersion"
$Installed = if (Test-Path -LiteralPath $BunExe) { (& $BunExe --version | Out-String).Trim() } else { $null }
if ($Installed -ne $BunVersion) {
  Write-Host "Downloading Bun $BunVersion into $BunHome (global Bun is not changed)."
  Install-ProjectBun
  $Installed = (& $BunExe --version | Out-String).Trim()
  if ($Installed -ne $BunVersion) { throw "Expected Bun $BunVersion, found '$Installed'" }
}
# Only this script's process sees the project Bun first on PATH.
$env:Path = "$BunHome;$env:Path"
# launcher/scripts/package.cjs runs electron-builder with "node". Without Node.js installed,
# a copy of bun.exe named node.exe runs it in Bun's Node-compatible mode.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $NodeShim = Join-Path $BunHome "node-shim"
  New-Item -ItemType Directory -Path $NodeShim -Force | Out-Null
  Copy-Item -LiteralPath $BunExe -Destination (Join-Path $NodeShim "node.exe") -Force
  $env:Path = "$NodeShim;$env:Path"
  Write-Host "Node.js not found; using Bun as node for electron-builder."
}
$env:CODEX_WEB_GPT_BUN = $BunExe
$env:CODEX_CHATGPT_WEB_BUN = $BunExe
Write-Host "Using Bun $Installed from $BunExe"

Step "Installing root dependencies"
Invoke-Bun @("install", "--frozen-lockfile") $Root

Step "Installing launcher dependencies"
Invoke-Bun @("install", "--frozen-lockfile") $Launcher

Step "Building and packaging the launcher"
Invoke-Bun @("run", "app:package") $Root

# launcher/scripts/package.cjs copies the finished installer into launcher\artifacts.
$Installer = Get-ChildItem -LiteralPath $Artifacts -Filter "*.exe" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Step "Done"
if ($Installer) {
  Write-Host "Installer: $($Installer.FullName)" -ForegroundColor Green
  Start-Process explorer.exe -ArgumentList "/select,`"$($Installer.FullName)`""
} else {
  Write-Host "Build finished; output is in $Artifacts" -ForegroundColor Green
}
