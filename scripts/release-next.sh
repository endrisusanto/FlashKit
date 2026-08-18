#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/release-next.sh [patch|minor|major] [commit message]

Examples:
  scripts/release-next.sh
  scripts/release-next.sh patch "Fix slow ADB scan and download modal"
  BRANCH=main REMOTE=origin scripts/release-next.sh minor "Prepare next release"

Environment:
  APP_DIR  App directory that contains package.json. Defaults to bow-rust.
  BRANCH   Branch to push. Defaults to current branch, or main if detached.
  REMOTE   Git remote to push. Defaults to origin.
  PREFIX   Tag prefix. Defaults to v.

This script calculates the next semantic version from the latest tag, updates
the app version files, stages all repo changes, commits them if needed, creates
the next tag, pushes the branch, then pushes the tag to trigger the GitHub
Actions release workflow.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BUMP="${1:-patch}"
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "ERROR: bump must be one of: patch, minor, major" >&2
  usage >&2
  exit 1
fi

DEFAULT_MESSAGE="Release next version"
COMMIT_MESSAGE="${2:-$DEFAULT_MESSAGE}"
APP_DIR="${APP_DIR:-bow-rust}"
REMOTE="${REMOTE:-origin}"
PREFIX="${PREFIX:-v}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $REPO_ROOT is not a git repository" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/scripts/bump-version.mjs" ]]; then
  echo "ERROR: version bump script not found: $APP_DIR/scripts/bump-version.mjs" >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current || true)"
BRANCH="${BRANCH:-${CURRENT_BRANCH:-main}}"

echo "[release] Repo   : $REPO_ROOT"
echo "[release] App    : $APP_DIR"
echo "[release] Remote : $REMOTE"
echo "[release] Branch : $BRANCH"
echo "[release] Bump   : $BUMP"

git fetch "$REMOTE" "$BRANCH" --prune >/dev/null 2>&1 || git fetch "$REMOTE" --prune

LOCAL_TAGS="$(git tag --list "${PREFIX}[0-9]*.[0-9]*.[0-9]*" || true)"
REMOTE_TAGS="$(git ls-remote --tags --refs "$REMOTE" "${PREFIX}[0-9]*.[0-9]*.[0-9]*" \
  | awk '{print $2}' \
  | sed 's#refs/tags/##' || true)"
LATEST_TAG="$(printf '%s\n%s\n' "$LOCAL_TAGS" "$REMOTE_TAGS" \
  | sed '/^$/d' \
  | sort -V \
  | tail -n 1 || true)"
if [[ -z "$LATEST_TAG" ]]; then
  LATEST_TAG="${PREFIX}0.0.0"
fi

VERSION="${LATEST_TAG#"$PREFIX"}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

case "$BUMP" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEXT_VERSION="${MAJOR}.${MINOR}.${PATCH}"
NEXT_TAG="${PREFIX}${NEXT_VERSION}"

if git rev-parse -q --verify "refs/tags/$NEXT_TAG" >/dev/null; then
  echo "ERROR: tag already exists: $NEXT_TAG" >&2
  exit 1
fi

if git ls-remote --exit-code --tags --refs "$REMOTE" "$NEXT_TAG" >/dev/null 2>&1; then
  echo "ERROR: remote tag already exists: $NEXT_TAG" >&2
  exit 1
fi

echo "[release] Latest tag: $LATEST_TAG"
echo "[release] Next tag  : $NEXT_TAG"

echo "[release] Updating app version files..."
node "$APP_DIR/scripts/bump-version.mjs" --version "$NEXT_VERSION" >/dev/null

git add -A

if git diff --cached --quiet; then
  echo "[release] No staged changes; tagging current HEAD."
else
  git commit -m "$COMMIT_MESSAGE"
fi

git tag "$NEXT_TAG"

echo "[release] Pushing branch..."
git push "$REMOTE" "HEAD:$BRANCH"

echo "[release] Pushing tag to trigger GitHub Actions (Latest Release + MSI)..."
git push "$REMOTE" "$NEXT_TAG"

echo "[release] Done: $NEXT_TAG (GitHub Actions will publish as Latest Release with MSI & DEB assets)"
