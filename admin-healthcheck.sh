#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-check}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$MODE" != "check" && "$MODE" != "fix" ]]; then
  echo "Usage: bash admin-healthcheck.sh [check|fix]"
  exit 1
fi

echo "== Admin Healthcheck ($MODE) =="
echo "App dir: $APP_DIR"

cd "$APP_DIR"

echo
echo "[1/8] Node runtime"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node introuvable dans le PATH."
  echo "Astuce O2Switch: source /home/<user>/nodevenv/admin/20/bin/activate"
  exit 1
fi
node -v
npm -v

echo
echo "[2/8] package.json JSON valide"
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'));console.log('OK package.json')"

echo
echo "[3/8] dépendances critiques"
node -e "import('busboy').then(()=>console.log('OK busboy')).catch(e=>{console.error('ERR busboy:',e.message);process.exit(1);})"
node -e "import('sharp').then(()=>console.log('OK sharp')).catch(e=>{console.error('ERR sharp:',e.message);process.exit(1);})"

echo
echo "[4/8] syntaxe admin-server.js"
node --check admin-server.js
echo "OK syntaxe"

echo
echo "[5/8] état git"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git branch --show-current || true
  if git ls-files -u | grep -q .; then
    echo "ERROR: conflits git non résolus détectés."
    git ls-files -u
    exit 1
  fi
  GIT_STATUS="$(git status --short || true)"
  if [[ -n "$GIT_STATUS" ]]; then
    echo "WARN: arbre git non clean:"
    echo "$GIT_STATUS"
  else
    echo "OK git clean"
  fi
else
  echo "WARN: dossier non git"
fi

echo
echo "[6/8] dossier tmp Passenger"
if [[ ! -d tmp ]]; then
  if [[ "$MODE" == "fix" ]]; then
    mkdir -p tmp
    echo "FIX: tmp créé"
  else
    echo "WARN: dossier tmp absent"
  fi
else
  echo "OK tmp présent"
fi

echo
echo "[7/8] audit dépendances (prod)"
npm audit --omit=dev || true

if [[ "$MODE" == "fix" ]]; then
  echo
  echo "[8/8] mode fix: npm install + restart Passenger"
  npm install
  mkdir -p tmp
  touch tmp/restart.txt
  echo "OK: npm install terminé, restart Passenger déclenché (tmp/restart.txt)"
else
  echo
  echo "[8/8] mode check: aucune modification appliquée"
fi

echo
echo "Terminé."
