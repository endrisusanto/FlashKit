param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',
  [string]$CommitMessage = 'Release next version'
)

$ErrorActionPreference = 'Stop'
$appDir = if ($env:APP_DIR) { $env:APP_DIR } else { 'bow-rust' }
$remote = if ($env:REMOTE) { $env:REMOTE } else { 'origin' }
$prefix = if ($env:PREFIX) { $env:PREFIX } else { 'v' }
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (git rev-parse --is-inside-work-tree 2>$null)) {
  throw "Not a Git repository: $repoRoot"
}

$bumpScript = Join-Path $appDir 'scripts/bump-version.mjs'
if (-not (Test-Path $bumpScript)) {
  throw "Version bump script not found: $bumpScript"
}

$branch = if ($env:BRANCH) { $env:BRANCH } else { git branch --show-current }
if (-not $branch) { $branch = 'main' }

Write-Host "[release] Repo   : $repoRoot"
Write-Host "[release] App    : $appDir"
Write-Host "[release] Remote : $remote"
Write-Host "[release] Branch : $branch"
Write-Host "[release] Bump   : $Bump"

git fetch $remote $branch --prune 2>$null
if ($LASTEXITCODE -ne 0) { git fetch $remote --prune }

$tagPattern = "$prefix[0-9]*.[0-9]*.[0-9]*"
$tags = @(
  git tag --list $tagPattern
  git ls-remote --tags --refs $remote $tagPattern 2>$null |
    ForEach-Object { ($_ -split '\s+')[-1] -replace '^refs/tags/', '' }
) | Where-Object { $_ -match "^$([regex]::Escape($prefix))(\d+)\.(\d+)\.(\d+)$" } |
  Select-Object -Unique

$latest = $tags |
  ForEach-Object {
    if ($_ -match "^$([regex]::Escape($prefix))(\d+)\.(\d+)\.(\d+)$") {
      [pscustomobject]@{ Tag = $_; Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Patch = [int]$Matches[3] }
    }
  } |
  Sort-Object Major, Minor, Patch |
  Select-Object -Last 1

if ($latest) {
  $major = $latest.Major
  $minor = $latest.Minor
  $patch = $latest.Patch
  $latestTag = $latest.Tag
} else {
  $major = 0; $minor = 0; $patch = 0
  $latestTag = "${prefix}0.0.0"
}

switch ($Bump) {
  'major' { $major++; $minor = 0; $patch = 0 }
  'minor' { $minor++; $patch = 0 }
  'patch' { $patch++ }
}

$nextVersion = "$major.$minor.$patch"
$nextTag = "$prefix$nextVersion"

git rev-parse -q --verify "refs/tags/$nextTag" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw "Tag already exists: $nextTag" }
git ls-remote --exit-code --tags --refs $remote $nextTag 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw "Remote tag already exists: $nextTag" }

Write-Host "[release] Latest tag: $latestTag"
Write-Host "[release] Next tag  : $nextTag"
Write-Host '[release] Updating app version files...'
node $bumpScript --version $nextVersion | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Version update failed' }

git add -A
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host '[release] No staged changes; tagging current HEAD.'
} else {
  git commit -m $CommitMessage
}

git tag $nextTag
Write-Host '[release] Pushing branch...'
git push $remote "HEAD:$branch"
Write-Host '[release] Pushing tag to trigger GitHub Actions release build...'
git push $remote $nextTag
Write-Host "[release] Done: $nextTag"
