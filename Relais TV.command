#!/bin/zsh
cd "${0:A:h}"
if [[ ! -x .processed/frame/venv/bin/python ]]; then
  python3 -m venv .processed/frame/venv || exit 1
  .processed/frame/venv/bin/pip install -r scripts/frame-relay-requirements.txt || exit 1
fi
.processed/frame/venv/bin/python scripts/frame-relay.py
read '?Appuie sur Entrée pour fermer.'
