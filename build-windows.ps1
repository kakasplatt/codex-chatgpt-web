# Builds the Codex Web GPT Windows installer from source.
# Run with build-windows.cmd (double-click) or: powershell -ExecutionPolicy Bypass -File build-windows.ps1

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Launcher = Join-Path $Root "launcher"
$Artifacts = Join-Path $Launcher "artifacts"

$PackageJson = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
if ($PackageJson.packageManager -notmatch '^bun@(\d+\.\d+\.\d+)$') {
  throw "package.json must pin an exact Bun packageManager version"
}
$BunVersion = $Matches[1]
$BunBin = Join-Path $env:USERPROFILE ".bun\bin"

function Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-BunVersion {
  $Bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $Bun) { return $null }
  return (& $Bun.Source --version | Out-String).Trim()
}

function Invoke-Bun([string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & bun @Arguments
    if ($LASTEXITCODE -ne 0) { throw "bun $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

if (Test-Path -LiteralPath $BunBin) { $env:Path = "$BunBin;$env:Path" }

Step "Checking Bun $BunVersion"
$Installed = Get-BunVersion
if ($Installed -ne $BunVersion) {
  if ($Installed) { Write-Host "Found Bun $Installed; installing the required $BunVersion." }
  else { Write-Host "Bun not found; installing $BunVersion." }
  Write-Host "This replaces the Bun installed in $BunBin." -ForegroundColor Yellow
  $BunInstallScript = Invoke-RestMethod "https://bun.sh/install.ps1"
  & ([scriptblock]::Create($BunInstallScript)) -Version $BunVersion
  $env:Path = "$BunBin;$env:Path"
  $Installed = Get-BunVersion
  if ($Installed -ne $BunVersion) { throw "Expected Bun $BunVersion after install, found '$Installed'" }
}
Write-Host "Using Bun $Installed"

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
