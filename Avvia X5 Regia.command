#!/bin/zsh
# Doppio clic per avviare X5 Regia (macOS, Apple Silicon)
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "Serve ffmpeg: brew install ffmpeg"; read; exit 1; }
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip -q install -r requirements.txt
(sleep 1.5; open http://localhost:8360) &
exec .venv/bin/python server.py
