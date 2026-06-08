#!/usr/bin/env bash
#
# Flowboard — one-command updater for teammates.
#
#   ./update.sh
#
# What it does:
#   1. git pull (fast-forward) the latest code
#   2. reinstall agent deps IF requirements/pyproject changed
#   3. reinstall frontend deps IF package.json changed
#   4. warn (loudly) if the Chrome extension changed and must be reloaded
#   5. remind you to restart the agent + frontend
#
# Your data is safe: storage/, *.db and node_modules are git-ignored, so
# pulling never touches your boards, generated images, or local secrets.

set -euo pipefail

cd "$(dirname "$0")"

# Colors (fall back to plain if not a TTY)
if [ -t 1 ]; then
  BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

echo -e "${BOLD}Flowboard updater${RESET}"

# Refuse to run on a dirty tree so we never clobber local edits.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo -e "${RED}✗ You have uncommitted local changes.${RESET}"
  echo "  Commit or stash them first, then re-run ./update.sh"
  echo "  (Tip: 'git stash' to set them aside, 'git stash pop' to restore.)"
  exit 1
fi

BEFORE="$(git rev-parse HEAD)"

echo "→ Pulling latest code…"
git pull --ff-only

AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo -e "${GREEN}✓ Already up to date — nothing to do.${RESET}"
  exit 0
fi

# Which files changed between the two revisions?
CHANGED="$(git diff --name-only "$BEFORE" "$AFTER")"

changed() { echo "$CHANGED" | grep -q "$1"; }

# ── Agent deps ──────────────────────────────────────────────────────────
if changed "agent/requirements.txt" || changed "agent/pyproject.toml"; then
  echo "→ Agent dependencies changed — updating…"
  if command -v uv >/dev/null 2>&1; then
    (cd agent && uv pip install --python .venv/bin/python -U -e .)
  else
    (cd agent && .venv/bin/pip install -U -e .)
  fi
else
  echo "  Agent deps unchanged — skipping."
fi

# ── Frontend deps ───────────────────────────────────────────────────────
if changed "frontend/package.json" || changed "frontend/package-lock.json"; then
  echo "→ Frontend dependencies changed — installing…"
  (cd frontend && npm install)
else
  echo "  Frontend deps unchanged — skipping."
fi

# ── Extension reload warning ────────────────────────────────────────────
if changed "extension/"; then
  echo -e "${YELLOW}${BOLD}⚠ The Chrome extension changed.${RESET}"
  echo -e "${YELLOW}  Open chrome://extensions and click ↻ Reload on Flowboard,${RESET}"
  echo -e "${YELLOW}  then refresh your labs.google/fx/tools/flow tab.${RESET}"
fi

echo
echo -e "${GREEN}✓ Update complete.${RESET}"
echo -e "${BOLD}Now restart both processes:${RESET}"
echo "  • Agent:    stop it (Ctrl+C) and run  make agent"
echo "  • Frontend: stop it (Ctrl+C) and run  make frontend"
echo "  • Then hard-refresh the browser tab (Ctrl+Shift+R)."
