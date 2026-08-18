[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',
  [string]$CommitMessage = 'Release next version',
  [string]$Target = 'x86_64-pc-windows-msvc',
  [ValidateSet('nsis', 'msi', 'msi,nsis', 'nsis,msi')]
  [string]$Bundles = 'msi,nsis' # ponytail: default to msi,nsis
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  throw 'This release script requires a 64-bit Windows runner.'
}

foreach ($command in 'node', 'npm', 'rustup') {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $command"
  }
}

$appDir = Join-Path $PSScriptRoot 'bow-rust'
Set-Location $appDir

$releaseScript = Join-Path $PSScriptRoot 'scripts\release-next.ps1'
try {
  & $releaseScript -Bump $Bump -CommitMessage $CommitMessage
} catch {
  throw "Version release failed: $($_.Exception.Message)"
}

rustup target add $Target
if ($LASTEXITCODE -ne 0) { throw 'Rust target setup failed.' }

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

npm run tauri build -- --target $Target --bundles $Bundles
if ($LASTEXITCODE -ne 0) { throw 'Tauri release build failed.' }

$bundleDir = Join-Path $appDir "src-tauri\target\$Target\release\bundle"
Write-Host "Release build complete: $bundleDir"
Get-ChildItem $bundleDir -Recurse -File | Select-Object -ExpandProperty FullName
