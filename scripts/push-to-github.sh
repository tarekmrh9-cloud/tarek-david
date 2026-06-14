#!/bin/bash
# DAVID V1 — GitHub Auto-Push Script
# Usage: GITHUB_TOKEN=ghp_xxx bash scripts/push-to-github.sh "commit message"

REPO="castrolmocro/DAVID-FINAL"
MSG="${1:-🚀 Auto-update: $(date '+%Y-%m-%d %H:%M')}"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌ GITHUB_TOKEN not set. Usage: GITHUB_TOKEN=ghp_xxx bash scripts/push-to-github.sh"
  exit 1
fi

git config user.email "david@djamel.bot"
git config user.name "DAVID V1"
git remote set-url origin "https://${GITHUB_TOKEN}@github.com/${REPO}.git"
git add -A
git commit -m "$MSG" --allow-empty
git push origin main --force
echo "✅ Pushed to github.com/${REPO}"
