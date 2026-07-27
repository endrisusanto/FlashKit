[CmdletBinding()]
param(
  [string]$Target = 'x86_64-pc-windows-msvc',
  [ValidateSet('msi', 'nsis', 'nsis,msi')]
  [string]$Bundles = 'msi'
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  throw 'This build script requires a 64-bit Windows runner.'
}

foreach ($command in 'node', 'npm', 'rustup') {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $command"
  }
}

$nodeVersion = [version]((node --version) -replace '^v', '')
if ($nodeVersion -lt [version]'20.19.0') {
  throw "Node.js 20.19.0 or newer is required. Found: $nodeVersion"
}

$appDir = Join-Path $PSScriptRoot 'bow-rust'
Set-Location $appDir

rustup target add $Target
if ($LASTEXITCODE -ne 0) { throw 'Rust target setup failed.' }

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

npm run tauri build -- --target $Target --bundles $Bundles
if ($LASTEXITCODE -ne 0) { throw 'Tauri package build failed.' }

$bundleDir = Join-Path $appDir "src-tauri\target\$Target\release\bundle"
Write-Host "Build complete: $bundleDir"
Get-ChildItem $bundleDir -Recurse -File | Select-Object -ExpandProperty FullName
