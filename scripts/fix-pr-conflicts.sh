#!/usr/bin/env bash

set -euo pipefail

# Fix and update a PR branch by pushing local commits, ignoring .DS_Store,
# and optionally merging latest main. Run from repo root.

BRANCH="codex/add-ai-chat-and-ingestion-features"
REMOTE="origin"
BASE_BRANCH="main"

echo "==> Checking current branch"
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "$BRANCH" ]]; then
  echo " - Switching to $BRANCH"
  git checkout "$BRANCH"
fi

echo "==> Ensuring .DS_Store is ignored and untracked"
if ! grep -qx ".DS_Store" .gitignore 2>/dev/null; then
  echo ".DS_Store" >> .gitignore
  git add .gitignore
  echo " - Added .DS_Store to .gitignore"
else
  echo " - .DS_Store already in .gitignore"
fi

# Remove any tracked .DS_Store files from index (ignore if none)
git rm --cached -q .DS_Store 2>/dev/null || true

# Commit ignore change if staged
if ! git diff --cached --quiet; then
  git commit -m "chore: ignore .DS_Store"
fi

echo "==> Pushing branch to update PR head"
git push "$REMOTE" "$BRANCH"

echo "==> Fetching latest $BASE_BRANCH"
git fetch "$REMOTE" "$BASE_BRANCH":"refs/remotes/$REMOTE/$BASE_BRANCH"

echo "==> Checking if merge from $BASE_BRANCH is needed"
needs_merge=$(git rev-list --left-right --count "$BRANCH"..."$REMOTE/$BASE_BRANCH" | awk '{print $2}')
if [[ "$needs_merge" != "0" ]]; then
  echo " - Merging $REMOTE/$BASE_BRANCH into $BRANCH"
  set +e
  git merge --no-edit "$REMOTE/$BASE_BRANCH"
  merge_exit=$?
  set -e
  if [[ $merge_exit -ne 0 ]]; then
    echo "!! Merge conflicts detected. Please resolve conflicts, then run:"
    echo "   git add -A && git commit && git push $REMOTE $BRANCH"
    exit 1
  fi
  echo " - Merge successful; pushing"
  git push "$REMOTE" "$BRANCH"
else
  echo " - No merge needed; branch is up to date against $BASE_BRANCH"
fi

echo "==> Done. Refresh the PR page to verify conflicts are cleared."

