#!/bin/zsh
# Double-click this file in Finder to start Voice To Text (opens Terminal briefly).
# Drag it to the Dock for a shortcut. Project root is one level above this folder.

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js (e.g. https://nodejs.org) and try again."
  read -r _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

echo "Starting Voice To Text..."
npm start

echo ""
echo "App closed. Press Return to close this window."
read -r _
